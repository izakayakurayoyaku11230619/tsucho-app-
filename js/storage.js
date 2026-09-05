// 通帳明細(TsuchoTxn)本体・決済口座リスト・通帳残高確認は、すべてFirebase Firestoreに保存する
// (iPhoneで取り込んだデータがパソコンでもそのまま見えるように、1つの共有データベースにする)。
// 読み書きの窓口(getTsuchoRecords等)は今まで通り完全に同期のまま(メモリ内キャッシュを返すだけ)に
// することで、storage.js以外のファイルは無改修で動く。実際のFirestoreへの書き込みは裏で非同期に行う。
import {
  collection, doc, getDocs, getDoc, setDoc, writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { db } from './firebaseClient.js';

const KNOWN_ACCOUNTS_DOC = doc(db, 'meta', 'knownAccounts');
const VERIFIED_BALANCES_DOC = doc(db, 'meta', 'verifiedBalances');
const RECORDS_COLLECTION = collection(db, 'records');

/**
 * @typedef {Object} TsuchoTxn 通帳仕分けで確定させた1明細行
 * @property {string} id
 * @property {string} sourceFileName 取り込み元のファイル名(拡張子付き。Excel書き出し時のファイル名の元にもなる)
 * @property {string} date "YYYY-MM-DD"
 * @property {'入金'|'出金'} direction
 * @property {string} accountLabel 勘定科目(自由記述。TSUCHO_CATEGORY_OPTIONSのlabelが基本)
 * @property {string} bankAccountName 決済口座(通帳の銀行・支店・種別)
 * @property {string} counterparty 取引先(摘要)
 * @property {string} memo 品目・備考
 * @property {string} taxCategory 税区分
 * @property {number} amount
 * @property {number} createdAt
 */

// ---------------------------------------------------------------------------
// Firestore: 明細(TsuchoTxn)本体の永続化(records コレクション、1明細=1ドキュメント)
// ---------------------------------------------------------------------------
let recordsCache = null;
let persistedIds = new Set(); // 直近でFirestoreに書き込み済みのドキュメントID(次回保存時の削除差分の計算用)

// Firestoreのバッチ書き込みは1回あたり最大500件までなので、それより少なく分割して送る。
const BATCH_CHUNK_SIZE = 400;
async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += BATCH_CHUNK_SIZE) {
    const batch = writeBatch(db);
    for (const op of ops.slice(i, i + BATCH_CHUNK_SIZE)) {
      if (op.type === 'set') batch.set(op.ref, op.data);
      else batch.delete(op.ref);
    }
    await batch.commit();
  }
}

/**
 * アプリ起動時に一度だけ呼ぶ(ログイン確認が済んでから)。Firestoreの内容をメモリキャッシュへ読み込む。
 * これが終わるまでgetTsuchoRecords()は空配列を返す。
 */
export async function initTsuchoStorage() {
  try {
    const [recordsSnap, knownSnap, verifiedSnap] = await Promise.all([
      getDocs(RECORDS_COLLECTION),
      getDoc(KNOWN_ACCOUNTS_DOC),
      getDoc(VERIFIED_BALANCES_DOC),
    ]);
    recordsCache = recordsSnap.docs.map((d) => d.data());
    persistedIds = new Set(recordsSnap.docs.map((d) => d.id));
    knownAccountsCache = knownSnap.exists() ? (knownSnap.data().list || []) : [];
    verifiedBalancesCache = verifiedSnap.exists() ? (verifiedSnap.data().data || {}) : {};
  } catch (e) {
    console.error('tsucho-app: データの読み込みに失敗しました', e);
    recordsCache = [];
    knownAccountsCache = [];
    verifiedBalancesCache = {};
    alert('データの読み込みに失敗しました。通信環境をご確認のうえ、タブを開き直してください。');
  }
}

export function getTsuchoRecords() {
  return recordsCache ?? [];
}

// 1件ずつ保存が連続で呼ばれると、そのたびにFirestoreへ書き込むと非常に遅くなる。
// 画面用のキャッシュは常に即時更新しつつ、実際のFirestoreへの書き込みだけ少し待ってまとめる。
let recordsWriteTimer = null;
function persistRecordsDebounced() {
  clearTimeout(recordsWriteTimer);
  recordsWriteTimer = setTimeout(() => {
    persistRecordsNow().catch((e) => {
      console.error('tsucho-app: Firestoreへの保存に失敗しました(records)', e);
      alert(`保存に失敗しました(records): ${e?.code || ''} ${e?.message || e}`);
    });
  }, 400);
}

async function persistRecordsNow() {
  const snapshot = recordsCache;
  const currentIds = new Set(snapshot.map((r) => r.id));
  const ops = snapshot.map((r) => ({ type: 'set', ref: doc(RECORDS_COLLECTION, r.id), data: r }));
  for (const oldId of persistedIds) {
    if (!currentIds.has(oldId)) ops.push({ type: 'delete', ref: doc(RECORDS_COLLECTION, oldId) });
  }
  await commitInChunks(ops);
  persistedIds = currentIds;
}

export function saveTsuchoRecords(records) {
  recordsCache = records;
  persistRecordsDebounced();
  return true;
}

/** デバウンス中の書き込みを即座に確定させる。タブを閉じる直前に呼ぶ。 */
export function flushPendingWrites() {
  if (recordsWriteTimer) {
    clearTimeout(recordsWriteTimer);
    recordsWriteTimer = null;
    persistRecordsNow().catch((e) => console.error('tsucho-app: 保存の確定に失敗しました(records)', e));
  }
}

// ---------------------------------------------------------------------------
// Firestore: 決済口座リスト・通帳残高確認(小さいデータなので1ドキュメントにまとめて保存)
// ---------------------------------------------------------------------------
let knownAccountsCache = [];
let verifiedBalancesCache = {};

function saveKnownAccountsNow(list) {
  knownAccountsCache = list;
  setDoc(KNOWN_ACCOUNTS_DOC, { list }).catch((e) => {
    console.error('tsucho-app: 保存に失敗しました(known-accounts)', e);
    alert(`保存に失敗しました(known-accounts): ${e?.code || ''} ${e?.message || e}`);
  });
}

function saveVerifiedBalancesNow(data) {
  verifiedBalancesCache = data;
  setDoc(VERIFIED_BALANCES_DOC, { data }).catch((e) => {
    console.error('tsucho-app: 保存に失敗しました(verified-balances)', e);
    alert(`保存に失敗しました(verified-balances): ${e?.code || ''} ${e?.message || e}`);
  });
}

/** 同じsourceFileNameの既存レコードを入れ替えて保存する(同じファイルを再度「保存」した場合の重複防止)。 */
export function upsertTsuchoRecords(newRecords) {
  const sourceFileNames = new Set(newRecords.map((r) => r.sourceFileName));
  const kept = getTsuchoRecords().filter((r) => !sourceFileNames.has(r.sourceFileName));
  return saveTsuchoRecords([...kept, ...newRecords]);
}

export function deleteTsuchoRecordsBySource(sourceFileName) {
  saveTsuchoRecords(getTsuchoRecords().filter((r) => r.sourceFileName !== sourceFileName));
}

/**
 * 取込元ファイル1つ分の明細だけを対象に、日付の「年」だけをまとめてずらす
 * (AIが和暦→西暦の変換を誤り、例えば令和6年を「2024年」ではなく「2006年」と
 * 読んでしまった場合の修正用。金額・残高・摘要など日付以外は一切変更しない)。
 * @param {string} sourceFileName
 * @param {number} yearsOffset 例: 18 なら各行の日付の年に+18する
 * @returns {number} 書き換えた件数
 */
export function shiftSourceFileDateYears(sourceFileName, yearsOffset) {
  if (!sourceFileName || !yearsOffset) return 0;
  const records = getTsuchoRecords();
  let changed = 0;
  const next = records.map((r) => {
    if (r.sourceFileName !== sourceFileName || !r.date) return r;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.date);
    if (!m) return r;
    const newYear = Number(m[1]) + yearsOffset;
    changed += 1;
    return { ...r, date: `${newYear}-${m[2]}-${m[3]}` };
  });
  if (changed > 0) saveTsuchoRecords(next);
  return changed;
}

/**
 * 取込元ファイル1つ分の明細だけを、まとめて別の決済口座に付け替える。
 * (アップロード時に決済口座の選択を間違えたまま保存してしまった場合の修正用。
 * ファイルを消して取り込み直さなくても直せる。)
 * @returns {number} 書き換えた件数
 */
export function reassignSourceFileAccount(sourceFileName, newAccountName) {
  const trimmedNew = String(newAccountName || '').trim();
  if (!sourceFileName || !trimmedNew) return 0;
  const records = getTsuchoRecords();
  let changed = 0;
  const next = records.map((r) => {
    if (r.sourceFileName !== sourceFileName || r.bankAccountName === trimmedNew) return r;
    changed += 1;
    return { ...r, bankAccountName: trimmedNew };
  });
  if (changed > 0) saveTsuchoRecords(next);
  return changed;
}

export function deleteTsuchoRecordsByIds(ids) {
  const idSet = new Set(ids);
  saveTsuchoRecords(getTsuchoRecords().filter((r) => !idSet.has(r.id)));
}

/**
 * 保存済み明細(TsuchoTxn)全体を対象に、日付・金額・区分・摘要が完全一致するグループを探す
 * (残高が両方読み取れている場合は残高も一致条件に含める。tsucho.jsのfindDuplicateInSavedと同じ考え方)。
 * 2件以上あるグループだけを返す = 重複の可能性がある明細。
 * @returns {Array<{records: TsuchoTxn[]}>}
 */
export function findDuplicateGroups() {
  const records = getTsuchoRecords();
  const byKey = {};
  for (const r of records) {
    const key = [r.date, r.amount, r.direction, r.counterparty, r.balance || ''].join('|');
    (byKey[key] ??= []).push(r);
  }
  return Object.values(byKey)
    .filter((group) => group.length > 1)
    .sort((a, b) => (b[0].date || '').localeCompare(a[0].date || ''))
    .map((records2) => ({ records: records2 }));
}

/**
 * @typedef {Object} KnownAccount よく使う口座(決済口座欄のフル文字列)のクイック選択ボタン用リストの1件
 * @property {string} name 決済口座のフル文字列(例: "静岡銀行 法人")
 * @property {string} accountNumber 通帳表紙から読み取った口座番号(分かれば)。次回以降の自動判定に使う
 * @property {'法人'|'個人'|''} entityType 法人/個人の明示的な区分。口座名に「法人」「個人」の文字が含まれない
 *   口座(例: "静岡銀行 274支店 普通")でも法人・個人別に集計できるよう、手動で設定する。未設定なら''
 * @property {'借入金'|''} accountKind 口座の種類。'借入金'なら、通帳の「残高」が預金ではなく
 *   まだ返済していない借入残高であることを示す(口座一覧などで色・マイナス表示に使う)。未設定なら''
 */

/** @returns {KnownAccount[]} */
export function getKnownAccounts() {
  // 旧バージョンでは文字列の配列だったため、後方互換のため変換して返す。
  return knownAccountsCache.map((a) => (typeof a === 'string' ? { name: a, accountNumber: '', entityType: '', accountKind: '' } : { entityType: '', accountKind: '', ...a }));
}

/** 口座の法人/個人区分を明示的に設定する(口座名に「法人」「個人」の文字が無い場合の分類用)。まだ口座ボタンとして登録されていない名前でも新規登録する。 */
export function setAccountEntityType(name, entityType) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return;
  const known = getKnownAccounts();
  const idx = known.findIndex((a) => a.name === trimmedName);
  if (idx >= 0) known[idx].entityType = entityType;
  else known.push({ name: trimmedName, accountNumber: '', entityType, accountKind: '' });
  saveKnownAccountsNow(known);
}

/** 口座の種類(借入金口座かどうか)を設定する。まだ口座ボタンとして登録されていない名前でも新規登録する。 */
export function setAccountKind(name, accountKind) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return;
  const known = getKnownAccounts();
  const idx = known.findIndex((a) => a.name === trimmedName);
  if (idx >= 0) known[idx].accountKind = accountKind;
  else known.push({ name: trimmedName, accountNumber: '', entityType: '', accountKind });
  saveKnownAccountsNow(known);
}

/**
 * 新しい口座名を登録する(既にあれば何もしない。ただしaccountNumberが新しく分かった場合は追記する)。
 * ファイルカードで口座名を入力するたび、また表紙から口座番号が読み取れたときに自動登録される。
 */
export function addKnownAccount(name, accountNumber = '') {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return;
  const trimmedNumber = String(accountNumber || '').trim();
  const known = getKnownAccounts();
  const idx = known.findIndex((a) => a.name === trimmedName);
  if (idx >= 0) {
    if (trimmedNumber && !known[idx].accountNumber) known[idx].accountNumber = trimmedNumber;
    saveKnownAccountsNow(known);
    return;
  }
  saveKnownAccountsNow([...known, { name: trimmedName, accountNumber: trimmedNumber }]);
}

export function removeKnownAccount(name) {
  saveKnownAccountsNow(getKnownAccounts().filter((a) => a.name !== name));
}

/**
 * 口座名を変更する(統合)。AIの読み取り違い等で同じ口座が別名で登録されてしまった場合に使う。
 * newNameが既存の別口座と同じ場合は1つに統合され(口座番号は空の側が埋まる)、
 * 保存済み明細(TsuchoTxn)のbankAccountNameも一括で書き換える。
 * @returns {number} bankAccountNameを書き換えた保存済み明細の件数
 */
export function renameKnownAccount(oldName, newName) {
  const trimmedOld = String(oldName || '').trim();
  const trimmedNew = String(newName || '').trim();
  if (!trimmedOld || !trimmedNew || trimmedOld === trimmedNew) return 0;

  const known = getKnownAccounts();
  const oldEntry = known.find((a) => a.name === trimmedOld);
  const existingTarget = known.find((a) => a.name === trimmedNew);
  let nextKnown;
  if (existingTarget) {
    // 統合: 既存の別口座に合わせる。口座番号はどちらか設定されている方を残す。
    if (!existingTarget.accountNumber && oldEntry?.accountNumber) existingTarget.accountNumber = oldEntry.accountNumber;
    nextKnown = known.filter((a) => a.name !== trimmedOld);
  } else {
    // 単純な名前変更。
    nextKnown = known.map((a) => (a.name === trimmedOld ? { ...a, name: trimmedNew } : a));
  }
  saveKnownAccountsNow(nextKnown);

  const records = getTsuchoRecords();
  let changed = 0;
  const nextRecords = records.map((r) => {
    if (r.bankAccountName !== trimmedOld) return r;
    changed += 1;
    return { ...r, bankAccountName: trimmedNew };
  });
  if (changed > 0) saveTsuchoRecords(nextRecords);
  return changed;
}

/**
 * 保存済み明細(TsuchoTxn)に実際に登場する決済口座名を、件数・合計金額つきで集計する。
 * 「口座を管理」で見えていない(known-accountsに登録されないまま保存された)口座名も
 * ここなら全部拾えるので、一括統合の元データにする。
 * @returns {Array<{name:string, count:number, total:number}>} 件数の多い順
 */
export function listBankAccountNamesInRecords() {
  const byName = {};
  for (const r of getTsuchoRecords()) {
    const key = r.bankAccountName || '(口座未設定)';
    if (!byName[key]) byName[key] = { name: key, count: 0, total: 0 };
    byName[key].count += 1;
    byName[key].total += r.amount || 0;
  }
  return Object.values(byName).sort((a, b) => b.count - a.count);
}

/**
 * 保存済み明細(TsuchoTxn)を決済口座ごとに集計する(口座一覧の表示用)。
 * 残高は、その口座の中で日付が一番新しい行の残高(残高が入っている行に限る)を使う
 * ("スキャン後の口座残高" = 一番新しく読み取れた残高。これが実際の通帳の残高と合っているかで
 * ちゃんと保存されているかの目安になる)。
 * @returns {Array<{name:string, count:number, total:number, firstDate:string, lastDate:string, latestBalance:number, latestBalanceDate:string, accountNumber:string}>} 件数の多い順
 */
export function listAccountSummaries() {
  const byName = {};
  const latestTieBreakKey = {}; // 同じ日付の行が複数あるとき、どちらを「最新」とみなすかの判定用
  for (const r of getTsuchoRecords()) {
    const key = r.bankAccountName || '(口座未設定)';
    if (!byName[key]) byName[key] = { name: key, count: 0, total: 0, firstDate: r.date, lastDate: r.date, latestBalance: 0, latestBalanceDate: '' };
    const entry = byName[key];
    entry.count += 1;
    entry.total += r.amount || 0;
    if (r.date && (!entry.firstDate || r.date < entry.firstDate)) entry.firstDate = r.date;
    if (r.date && (!entry.lastDate || r.date > entry.lastDate)) entry.lastDate = r.date;
    if (r.balance && r.date) {
      // Firestoreはコレクションを保存順どおりに返してくれないため、同じ日付の行が複数あるときは
      // 取込時に記録したseq(ファイル内の本来の行順)で決める(無い古いデータはidで代用)。
      const tieBreakKey = `${String(r.seq ?? '').padStart(10, '0')}_${r.id || ''}`;
      if (!entry.latestBalanceDate || r.date > entry.latestBalanceDate
        || (r.date === entry.latestBalanceDate && tieBreakKey >= (latestTieBreakKey[key] || ''))) {
        entry.latestBalance = r.balance;
        entry.latestBalanceDate = r.date;
        latestTieBreakKey[key] = tieBreakKey;
      }
    }
  }
  const knownByName = {};
  for (const a of getKnownAccounts()) knownByName[a.name] = a;
  return Object.values(byName)
    .map((e) => ({ ...e, accountNumber: knownByName[e.name]?.accountNumber || '', accountKind: knownByName[e.name]?.accountKind || '' }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 保存済み明細(TsuchoTxn)を取込元ファイルごとに集計する(取り込んだファイルの一覧・履歴用)。
 * @returns {Array<{sourceFileName:string, count:number, total:number, bankAccountNames:string[], firstDate:string, lastDate:string, savedAt:number}>} 保存日時が新しい順
 */
export function listSourceFilesInRecords() {
  const byFile = {};
  for (const r of getTsuchoRecords()) {
    const key = r.sourceFileName || '(不明)';
    if (!byFile[key]) byFile[key] = { sourceFileName: key, count: 0, total: 0, bankAccountNames: new Set(), firstDate: r.date, lastDate: r.date, savedAt: r.createdAt || 0 };
    const entry = byFile[key];
    entry.count += 1;
    entry.total += r.amount || 0;
    if (r.bankAccountName) entry.bankAccountNames.add(r.bankAccountName);
    if (r.date && (!entry.firstDate || r.date < entry.firstDate)) entry.firstDate = r.date;
    if (r.date && (!entry.lastDate || r.date > entry.lastDate)) entry.lastDate = r.date;
    if ((r.createdAt || 0) > entry.savedAt) entry.savedAt = r.createdAt || 0;
  }
  return Object.values(byFile)
    .map((e) => ({ ...e, bankAccountNames: Array.from(e.bankAccountNames) }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * 複数の決済口座名(oldNames)をまとめて1つ(newName)に統合する。
 * 保存済み明細のbankAccountNameを一括書き換え、known-accountsも整理する
 * (統合先が既存の口座ならそちらへ寄せ、口座番号は空いていれば埋める)。
 * @param {string[]} oldNames
 * @param {string} newName
 * @returns {number} bankAccountNameを書き換えた保存済み明細の件数
 */
export function mergeBankAccountNames(oldNames, newName) {
  const trimmedNew = String(newName || '').trim();
  const targets = new Set((oldNames || []).map((n) => String(n || '').trim()).filter((n) => n && n !== trimmedNew));
  if (!trimmedNew || targets.size === 0) return 0;

  const records = getTsuchoRecords();
  let changed = 0;
  const nextRecords = records.map((r) => {
    if (!targets.has(r.bankAccountName)) return r;
    changed += 1;
    return { ...r, bankAccountName: trimmedNew };
  });
  if (changed > 0) saveTsuchoRecords(nextRecords);

  const known = getKnownAccounts();
  const existingTarget = known.find((a) => a.name === trimmedNew);
  const mergedNumber = existingTarget?.accountNumber || known.find((a) => targets.has(a.name) && a.accountNumber)?.accountNumber || '';
  let nextKnown = known.filter((a) => !targets.has(a.name));
  if (mergedNumber) {
    if (existingTarget) existingTarget.accountNumber = mergedNumber;
    else nextKnown = [...nextKnown, { name: trimmedNew, accountNumber: mergedNumber }];
  } else if (!existingTarget) {
    nextKnown = [...nextKnown, { name: trimmedNew, accountNumber: '' }];
  }
  saveKnownAccountsNow(nextKnown);

  return changed;
}

/** 口座番号から一致する既知の口座を探す(表紙が読み取れた場合の自動判定用)。 */
export function findKnownAccountByNumber(accountNumber) {
  const trimmed = String(accountNumber || '').trim();
  if (!trimmed) return null;
  return getKnownAccounts().find((a) => a.accountNumber && a.accountNumber === trimmed) || null;
}

/**
 * 「通帳残高確認」: ユーザーが実物の通帳(紙・アプリ)を見て入力した「本当の最新残高」を口座ごとに保存する。
 * アプリが自動集計した最新残高(listAccountSummariesのlatestBalance)とズレていないか、
 * 実物と突き合わせて確認するための機能。
 * @returns {{balance:number, checkedAt:number}|null}
 */
export function getVerifiedBalance(accountName) {
  return verifiedBalancesCache[accountName] || null;
}

export function setVerifiedBalance(accountName, balance) {
  const trimmedName = String(accountName || '').trim();
  if (!trimmedName) return;
  const all = { ...verifiedBalancesCache };
  all[trimmedName] = { balance: Number(balance) || 0, checkedAt: Date.now() };
  saveVerifiedBalancesNow(all);
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
