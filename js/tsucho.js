// 通帳仕分けアプリ本体: 銀行の通帳スキャンPDF・画像・明細CSV/xlsxを取り込み、
// ユーザー指定の固有仕分けルール(tsuchoRules.js)で自動分類したうえで、
// 取り込んだファイルごとに1つのfreee取込用Excel(元のファイル名.xlsx)を作成する。
// 「保存」した明細はTsuchoTxnとしてlocalStorageに残り、下部の銀行別・口座別一覧で管理できる。
import {
  uid, getTsuchoRecords, upsertTsuchoRecords, deleteTsuchoRecordsBySource, deleteTsuchoRecordsByIds,
  getKnownAccounts, addKnownAccount, findKnownAccountByNumber, setAccountEntityType, setAccountKind,
  listBankAccountNamesInRecords, mergeBankAccountNames, findDuplicateGroups, listSourceFilesInRecords, listAccountSummaries,
  getVerifiedBalance, setVerifiedBalance, reassignSourceFileAccount, shiftSourceFileDateYears,
} from './storage.js';
import { getApiKey, setApiKey, hasApiKey } from './settings.js';
import { isBankStatementXlsx, parseBankStatementXlsx } from './xlsxReader.js';
import { analyzeBankStatementDocument } from './tsuchoAnalyzer.js';
import { classifyTsuchoTxn, TSUCHO_CATEGORY_OPTIONS, TSUCHO_TAX_OPTIONS, defaultTaxForCategory } from './tsuchoRules.js';
import { downloadXlsx } from './xlsxWriter.js';

const EXPORT_HEADERS = ['発生日', '取引区分（入金/出金）', '勘定科目', '決済口座', '取引先（摘要）', '品目・備考', '税区分', '金額'];
const NO_BANK_LABEL = '(口座・カード未設定)';

const currency = (n) => `¥${Math.round(n).toLocaleString('ja-JP')}`;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function baseNameOf(fileName) {
  return String(fileName || '').replace(/\.[^./\\]+$/, '');
}

function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function toIsoDateLoose(raw) {
  const m = String(raw || '').trim().match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (!m) return '';
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** 銀行が出す明細CSV(列名の並び・表記ゆれは銀行ごとに異なる)をベストエフォートで解析する。対応できない形式ならnullを返す。 */
function parseCsvBankStatement(text) {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  if (!lines.length) return null;
  const header = splitCsvLine(lines[0]);
  const findIdx = (names) => header.findIndex((h) => names.includes(h));
  const dateIdx = findIdx(['日付', '取引日', '年月日', 'お取引日']);
  const descIdx = findIdx(['摘要', '内容', '取引内容', 'お取引内容', '摘要内容']);
  const withdrawIdx = findIdx(['出金額', '出金', 'お引出し', '支払金額', 'お支払金額']);
  const depositIdx = findIdx(['入金額', '入金', 'お預入れ', '受入金額', 'お預り金額']);
  const balanceIdx = findIdx(['残高', '差引残高']);
  if (dateIdx === -1 || (withdrawIdx === -1 && depositIdx === -1)) return null;

  const toNum = (s) => Number(String(s ?? '0').replace(/[,¥\s]/g, '')) || 0;
  const results = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const date = toIsoDateLoose(cells[dateIdx]);
    const withdrawal = withdrawIdx >= 0 ? toNum(cells[withdrawIdx]) : 0;
    const deposit = depositIdx >= 0 ? toNum(cells[depositIdx]) : 0;
    if (!date || (!withdrawal && !deposit)) continue;
    results.push({
      date,
      description: descIdx >= 0 ? cells[descIdx] : '',
      withdrawal,
      deposit,
      balance: balanceIdx >= 0 ? toNum(cells[balanceIdx]) : 0,
    });
  }
  return results;
}

function rawTxnToRow(sourceFileName, bankAccountName, raw) {
  const isDeposit = (raw.deposit || 0) > 0;
  const amount = isDeposit ? raw.deposit : raw.withdrawal;
  const rule = classifyTsuchoTxn(raw.description, raw.withdrawal || 0, raw.deposit || 0);
  return {
    id: uid('trow'),
    sourceFileName,
    date: raw.date || '',
    direction: isDeposit ? '入金' : '出金',
    accountLabel: rule.accountLabel,
    bankAccountName: bankAccountName || '',
    counterparty: raw.description || '',
    memo: rule.memo || '',
    taxCategory: rule.taxCategory,
    amount: Math.round(amount || 0),
    balance: Math.round(raw.balance || 0),
    needsReview: !!rule.needsReview,
    needsSplit: !!rule.needsSplit,
  };
}

function categoryOptionsHtml(current) {
  const labels = TSUCHO_CATEGORY_OPTIONS.map((c) => c.label);
  if (!labels.includes(current)) labels.unshift(current || '未分類');
  return labels.map((l) => `<option value="${escapeAttr(l)}" ${l === current ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('');
}

function taxOptionsHtml(current) {
  const opts = TSUCHO_TAX_OPTIONS.includes(current) ? TSUCHO_TAX_OPTIONS : [current, ...TSUCHO_TAX_OPTIONS];
  return opts.map((t) => `<option value="${escapeAttr(t)}" ${t === current ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
}

function rowToExportArray(r) {
  return [r.date, r.direction, r.accountLabel, r.bankAccountName, r.counterparty, r.memo, r.taxCategory, r.amount];
}

/** 銀行名(先頭の1語)を「決済口座」欄のフル文字列(例: "三井住友銀行 渋谷支店 普通")から取り出す。 */
/** 金融機関名の末尾に付く語。スペース無しで「銀行法人」のように続けて書かれていても、この直後で区切る。 */
const BANK_SUFFIX_PATTERN = /(銀行|信用金庫|信金|信用組合|農業協同組合|漁業協同組合|ろうきん|労働金庫)/;

function bankNameOf(fullLabel) {
  const s = String(fullLabel || '').trim();
  if (!s) return NO_BANK_LABEL;
  const bySpace = s.split(/[ 　]+/)[0];
  if (bySpace !== s) return bySpace; // スペースがあれば従来通りそこで区切る
  const suffixMatch = s.match(BANK_SUFFIX_PATTERN);
  if (suffixMatch) return s.slice(0, suffixMatch.index + suffixMatch[0].length);
  return s;
}

/** サイドバーの口座ボタンに表示するラベル。銀行名の部分は見出しに出ているので、口座名からは省いて表示する。 */
function accountLabelWithinGroup(fullName, groupName) {
  const rest = fullName.startsWith(groupName) ? fullName.slice(groupName.length).trim() : fullName;
  return rest || fullName;
}

const NO_ENTITY_LABEL = 'その他';

/**
 * 銀行をまたいだ区分(法人/個人)を判定する。まず口座に明示的に設定されたentityTypeを優先し、
 * 未設定の場合だけ口座名に「法人」「個人」の文字が含まれるかで判定する
 * (「静岡銀行 274支店 普通」のように名前だけでは分からない口座のため)。
 */
function entityTypeOf(fullLabel) {
  const known = getKnownAccounts().find((a) => a.name === fullLabel);
  if (known?.entityType) return known.entityType;
  const s = String(fullLabel || '');
  if (s.includes('法人')) return '法人';
  if (s.includes('個人')) return '個人';
  return NO_ENTITY_LABEL;
}

/**
 * 通帳を再スキャンした際などに、日付・金額・区分・摘要が完全一致する明細が
 * 既に保存済み(getTsuchoRecords())にないか調べる。あれば二重取込の可能性が高い。
 *
 * 残高が両方とも読み取れている場合は、残高まで一致しないと重複とはみなさない
 * (同じ日付・同じ金額・同じ摘要の取引が、たまたま複数回あることもあり得るが、
 *  通帳の残高はその時点の口座の状態を表す一意な値なので、残高まで一致するなら
 *  「本当に同じ通帳の同じ行を読み込んだ」と高い確度で判断できる。逆に残高がずれて
 *  いるなら、内容が似ているだけの別の取引とみなし、誤って重複扱いしない)。
 */
function findDuplicateInSaved(row, savedRecords) {
  const candidates = savedRecords.filter((saved) => (
    saved.date === row.date
    && saved.amount === row.amount
    && saved.direction === row.direction
    && saved.counterparty === row.counterparty
  ));
  if (candidates.length === 0) return null;
  if (row.balance) {
    return candidates.find((saved) => saved.balance === row.balance) || null;
  }
  return candidates[0];
}

/**
 * 同じファイル内の行を日付順(≒通帳に印字されている順)に見て、
 * 「前の行の残高 ± 今回の金額 = 今回の残高」になっているかを検証する。
 * 合わない箇所は、AIの読み取りミス・行の重複・抜けなどの可能性があるため、
 * needsBalanceCheckフラグを立てて画面上で警告する。
 */
function flagBalanceMismatches(rows) {
  let prevBalance = null;
  let prevRow = null;
  for (const row of rows) {
    if (!row.balance) { prevBalance = null; prevRow = null; continue; }
    if (prevBalance !== null) {
      const expected = row.direction === '入金' ? prevBalance + row.amount : prevBalance - row.amount;
      if (expected !== row.balance) {
        row.needsBalanceCheck = true;
        row.balanceCheckExpected = expected;
        row.balanceCheckPrevRow = prevRow;
      }
    }
    prevBalance = row.balance;
    prevRow = row;
  }
}

function gapsFromFlaggedRows(rows) {
  return rows
    .filter((r) => r.needsBalanceCheck)
    .map((r) => ({
      afterDate: r.balanceCheckPrevRow.date,
      afterCounterparty: r.balanceCheckPrevRow.counterparty,
      beforeDate: r.date,
      beforeCounterparty: r.counterparty,
      expected: r.balanceCheckExpected,
      actual: r.balance,
      diff: r.balance - r.balanceCheckExpected,
    }));
}

/**
 * 保存済みのファイル1件分の明細を日付順に見て、残高のつながりが崩れている箇所を探す。
 * 崩れている箇所は「その前後の間で、読み取れていない取引がある可能性が高い」場所を示す。
 * @returns {Array<{afterDate:string, afterCounterparty:string, beforeDate:string, beforeCounterparty:string, expected:number, actual:number, diff:number}>}
 */
/**
 * 日付順の比較関数。Firestoreはコレクションを保存順どおりに返してくれないため、
 * 同じ日付の行が複数あるとき用に、取込時に記録したseq(ファイル内の本来の行順)を
 * 次点の判定材料にする(seqが無い古いデータはidで代用。完全ではないが、少なくとも
 * 毎回同じ順序になり、読み込むたびに結果が変わることは防げる)。
 */
function compareByDateThenSeq(a, b) {
  const byDate = (a.date || '').localeCompare(b.date || '');
  if (byDate !== 0) return byDate;
  const aSeq = a.seq ?? null;
  const bSeq = b.seq ?? null;
  if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function checkBalanceContinuityForFile(sourceFileName) {
  const rows = getTsuchoRecords()
    .filter((r) => r.sourceFileName === sourceFileName)
    .map((r) => ({ ...r }))
    .sort(compareByDateThenSeq);
  flagBalanceMismatches(rows);
  return gapsFromFlaggedRows(rows);
}

/**
 * 保存済みの明細**全体**を口座ごとにまとめ、日付順に見て残高のつながりが崩れている箇所を探す。
 * ファイル単位のチェックと違い、複数のファイルにまたがる口座でも、ファイルの境目をまたいで
 * 正しくチェックできる(例: 1月分.pdfの最後の残高と2月分.pdfの最初の残高がつながっているか)。
 * @returns {Array<{accountName:string, gaps: Array}>} 崩れている箇所がある口座だけを返す
 */
function checkBalanceContinuityAllAccounts() {
  const byAccount = {};
  for (const r of getTsuchoRecords()) {
    const key = r.bankAccountName || NO_BANK_LABEL;
    (byAccount[key] ??= []).push({ ...r });
  }
  const results = [];
  for (const [accountName, rows] of Object.entries(byAccount)) {
    rows.sort(compareByDateThenSeq);
    flagBalanceMismatches(rows);
    const gaps = gapsFromFlaggedRows(rows);
    if (gaps.length) results.push({ accountName, gaps });
  }
  return results;
}

export function initTsucho(root, sidebarRoot) {
  const state = {
    files: [], // { id, fileName, bankAccountName, status: 'pending'|'done'|'error', rows: [], saved: boolean, errorMessage }
    groupMode: 'bank', // 明細一覧のグループ分け方法: 'bank'(銀行別) | 'entity'(法人・個人別)
    selectedBankGroup: null, // groupMode='bank'なら銀行名、'entity'なら「法人」「個人」「その他」
    selectedAccount: null, // 決済口座のフル文字列(支店・種別まで)。nullならselectedBankGroup内の全口座
    activeAccount: null, // クイック選択中の口座。以降アップロードするファイルの決済口座に自動で入る
    expandedBankGroups: new Set(), // サイドバーで開いている(口座一覧を表示中の)銀行グループ名
    sidebarEntityFilter: null, // サイドバーの口座一覧の絞り込み: null(すべて) | '法人' | '個人'
    from: '',
    to: '',
  };

  sidebarRoot.innerHTML = `
    <div class="tab-group">
      <span class="tab-group-label">口座を選んでからアップロード</span>
      <div style="display:flex;gap:6px;padding:0 16px 8px">
        <button type="button" class="btn btn-secondary btn-sm" id="tsucho-sidebar-filter-corp" style="flex:1">🏢 法人</button>
        <button type="button" class="btn btn-secondary btn-sm" id="tsucho-sidebar-filter-personal" style="flex:1">🏢 個人</button>
      </div>
      <div id="tsucho-account-buttons"></div>
    </div>
    <div class="tab-group" style="padding:0 16px">
      <input type="text" id="tsucho-new-account-input" placeholder="口座名を追加" style="margin-bottom:6px">
      <button type="button" class="btn btn-primary" id="tsucho-add-account" style="width:100%">＋ 口座を追加</button>
    </div>
    <div class="tab-group" style="padding:0 16px">
      <button type="button" class="btn btn-primary" id="tsucho-toggle-account-manage" style="width:100%">⚙️ 口座を管理(統合)</button>
    </div>
  `;

  root.innerHTML = `
    <div class="tsucho-top-toolbar">
      <button type="button" class="btn btn-primary" id="tsucho-tab-top">🏠 トップ</button>
      <button type="button" class="btn btn-secondary" id="tsucho-tab-import">📥 データ取り込み</button>
      <button type="button" class="btn btn-secondary" id="tsucho-tab-list">📚 明細一覧</button>
      <button type="button" class="btn btn-secondary" id="tsucho-check-duplicates">🔍 現在重複しているかチェック</button>
      <button type="button" class="btn btn-secondary" id="tsucho-check-balance-top">🔍 残高チェック</button>
      <button type="button" class="btn btn-secondary" id="tsucho-show-file-history">📁 取込ファイル一覧</button>
      <button type="button" class="btn btn-secondary" id="tsucho-show-account-manage-top">✏️ 口座名を変更</button>
      <span id="tsucho-current-file-label" style="font-size:14px;color:var(--color-text-muted)"></span>
    </div>

    <div id="tsucho-view-top">
    <div class="panel">
      <div class="panel-header">
        <h2>🏠 トップ</h2>
      </div>
      <p class="empty-hint" style="padding-top:0">保存済みの明細から自動集計した、現時点の合計です。今後ここに必要な情報を追加していきます。</p>
      <div id="tsucho-top-dashboard"></div>
    </div>
    </div>

    <div id="tsucho-view-import" class="hidden">
    <div class="panel">
      <div class="panel-header">
        <h2>🏦 通帳仕分け(freee取込用Excel作成)</h2>
        <button type="button" class="btn btn-ghost" id="tsucho-toggle-settings">⚙️ APIキー設定 <span id="tsucho-api-key-status" class="api-key-status"></span></button>
      </div>
      <div id="tsucho-settings-panel" class="settings-panel hidden">
        <label class="field">
          <span>Google Gemini APIキー (通帳PDF/画像の読み取りに使用。無料枠あり)</span>
          <input type="password" id="tsucho-api-key-input" placeholder="AIza...">
        </label>
        <p class="settings-hint"><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> でGoogleアカウントでログインし、「Create API key」で発行できます(無料枠あり。詳しい取得手順は下のヘルプもご覧ください)。</p>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="tsucho-clear-key">削除</button>
          <div class="spacer"></div>
          <button type="button" class="btn btn-primary" id="tsucho-save-key">保存</button>
        </div>
      </div>

      <p class="empty-hint" style="padding-top:0">左のサイドバーの口座をクリックすると、①次にアップロードするファイルの決済口座として自動で入り、②その口座の保存済み明細一覧(下部)にもジャンプします。通帳の表紙もスキャンすれば、口座番号から次回以降は自動で判定されます。通帳のスキャンPDF・写真画像、または銀行の明細CSV/xlsxをアップロードすると、指定の仕分けルールで自動分類します。内容を確認・編集してから、取り込んだファイルごとに1つのExcel(元のファイル名.xlsx、8列: 発生日/取引区分/勘定科目/決済口座/取引先/品目・備考/税区分/金額)として保存できます。</p>

      <div class="dropzone" id="tsucho-dropzone">
        <p>通帳PDF・画像・明細CSV/xlsxをドラッグ&ドロップ</p>
        <p class="dropzone-sub">または <button type="button" class="btn btn-secondary" id="tsucho-pick-file">ファイルを選択</button></p>
        <p class="dropzone-sub">CSV/xlsxはAPIキー不要で直接取り込めます。PDF・画像の読み取りにはAPIキーが必要です</p>
        <input type="file" id="tsucho-file-input" accept="image/*,application/pdf,.xlsx,.csv" multiple hidden>
      </div>

      <div id="tsucho-file-list"></div>
    </div>

    <div class="panel hidden" style="margin-top:16px" id="tsucho-account-manage-panel">
      <div class="panel-header">
        <h2>⚙️ 口座名の統合</h2>
      </div>
      <p class="empty-hint" style="padding-top:0">保存済みの明細に実際に登場する決済口座名を、件数の多い順に一覧表示します。AIの読み取り違いなどで同じ口座が別名になっているものにチェックを付け、下の欄に正しい名前を入力して「統合する」を押すと、まとめて1つの名前に書き換わります。</p>
      <div id="tsucho-account-manage-list"></div>
      <div class="field-row" style="max-width:480px;margin-top:12px;align-items:flex-end">
        <label class="field">
          <span>統合後の正しい口座名</span>
          <input type="text" id="tsucho-merge-target-input" placeholder="例: 静岡銀行 274支店 普通">
        </label>
        <button type="button" class="btn btn-primary" id="tsucho-merge-accounts">選択した項目を統合する</button>
      </div>
    </div>
    </div>

    <div id="tsucho-view-list" class="hidden">
    <div class="panel hidden" id="tsucho-duplicate-check-panel">
      <div class="panel-header">
        <h2>🔍 重複チェック結果</h2>
      </div>
      <div id="tsucho-duplicate-check-result"></div>
    </div>

    <div class="panel hidden" id="tsucho-balance-check-panel">
      <div class="panel-header">
        <h2>🔍 残高チェック結果</h2>
      </div>
      <p class="empty-hint" style="padding-top:0">保存済みの明細を口座ごとに日付順で見て、「前の残高 ± 今回の金額 = 今回の残高」になっているか確認します。崩れている箇所は、読み取れていない取引がある可能性が高い場所です(ファイルをまたいでチェックします)。</p>
      <div id="tsucho-balance-check-result"></div>
    </div>

    <div class="panel hidden" id="tsucho-file-history-panel">
      <div class="panel-header">
        <h2>🏦 口座一覧</h2>
      </div>
      <p class="empty-hint" style="padding-top:0">保存済みの明細から口座ごとに集計しています。「残高」はその口座の中で一番新しい日付の残高です(実際の通帳の残高と照合すれば、正しく保存できているか確認できます)。</p>
      <div id="tsucho-account-summary-result"></div>

      <div class="panel-header" style="margin-top:24px">
        <h2>📁 取込ファイル一覧</h2>
      </div>
      <p class="empty-hint" style="padding-top:0">これまでに「💾 一覧に保存」したファイルの一覧です(取込待ちのまま保存していないファイルは含まれません)。</p>
      <div id="tsucho-file-history-result"></div>
    </div>

    <div class="panel" style="margin-top:16px">
      <div class="panel-header">
        <h2>📚 明細一覧</h2>
        <div style="display:flex;gap:6px">
          <button type="button" class="btn btn-primary btn-sm" id="tsucho-group-mode-bank">🏦 銀行別</button>
          <button type="button" class="btn btn-secondary btn-sm" id="tsucho-group-mode-entity">🏢 法人・個人別</button>
        </div>
      </div>
      <p class="empty-hint" style="padding-top:0">読み込んだファイルは、決済口座欄の内容から自動でまとめて表示されます(「💾 一覧に保存」する前は「未保存」表示)。「法人・個人別」に切り替えると、口座名に「法人」「個人」を含むものを銀行をまたいでまとめて見られます。</p>
      <div class="bank-summary-layout">
        <div class="bank-summary-list" id="tsucho-bank-list"></div>
        <div class="bank-summary-detail">
          <div class="field-row" style="gap:8px;align-items:flex-end;flex-wrap:wrap">
            <label class="field" style="flex:0 0 auto"><span>開始日</span><input type="date" id="tsucho-from"></label>
            <label class="field" style="flex:0 0 auto"><span>終了日</span><input type="date" id="tsucho-to"></label>
            <button type="button" class="btn btn-primary" id="tsucho-export-bank">⇩ この銀行の明細をExcelで保存</button>
          </div>
          <div id="tsucho-bank-summary"></div>
          <div id="tsucho-bank-sources"></div>
          <div id="tsucho-bank-table"></div>
        </div>
      </div>
    </div>
    </div>
  `;

  // --- タブ切り替え(トップ / データ取り込み / 明細一覧) ---
  const tabTopBtn = root.querySelector('#tsucho-tab-top');
  const tabImportBtn = root.querySelector('#tsucho-tab-import');
  const tabListBtn = root.querySelector('#tsucho-tab-list');
  const viewTop = root.querySelector('#tsucho-view-top');
  const viewImport = root.querySelector('#tsucho-view-import');
  const viewList = root.querySelector('#tsucho-view-list');
  const currentFileLabelEl = root.querySelector('#tsucho-current-file-label');

  function setTsuchoTab(tab) {
    viewTop.classList.toggle('hidden', tab !== 'top');
    viewImport.classList.toggle('hidden', tab !== 'import');
    viewList.classList.toggle('hidden', tab !== 'list');
    tabTopBtn.className = `btn ${tab === 'top' ? 'btn-primary' : 'btn-secondary'}`;
    tabImportBtn.className = `btn ${tab === 'import' ? 'btn-primary' : 'btn-secondary'}`;
    tabListBtn.className = `btn ${tab === 'list' ? 'btn-primary' : 'btn-secondary'}`;
    if (tab === 'top') renderTopDashboard();
  }
  tabTopBtn.addEventListener('click', () => setTsuchoTab('top'));
  tabImportBtn.addEventListener('click', () => setTsuchoTab('import'));
  tabListBtn.addEventListener('click', () => setTsuchoTab('list'));

  // --- トップ画面(口座残高合計・ローン残高合計。今後ここに必要な情報を追加していく) ---
  const topDashboardEl = root.querySelector('#tsucho-top-dashboard');

  function renderTopDashboard() {
    const accounts = listAccountSummaries();
    if (!accounts.length) {
      topDashboardEl.innerHTML = '<p class="empty-hint">まだ保存済みの明細がありません。</p>';
      return;
    }
    const loanAccounts = accounts.filter((a) => a.accountKind === '借入金');
    const normalAccounts = accounts.filter((a) => a.accountKind !== '借入金');
    const totalBalance = normalAccounts.reduce((sum, a) => sum + (a.latestBalance || 0), 0);
    const totalLoan = loanAccounts.reduce((sum, a) => sum + (a.latestBalance || 0), 0);

    const accountRow = (a) => {
      const isLoan = a.accountKind === '借入金';
      return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--color-border)">
        <span>${escapeHtml(a.name)}</span>
        <span style="font-weight:700${isLoan ? ';color:var(--color-danger)' : ''}">${a.latestBalance ? `${isLoan ? '－' : ''}${currency(a.latestBalance)}` : '<span class="empty-hint">(残高不明)</span>'}</span>
      </div>`;
    };

    topDashboardEl.innerHTML = `
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px">
        <div class="summary-card" style="flex:1;min-width:220px">
          <div class="summary-card-label">💰 口座残高合計</div>
          <div class="summary-card-value">${currency(totalBalance)}</div>
          <div class="summary-card-sub">${normalAccounts.length}口座の合計(借入金口座を除く)</div>
        </div>
        <div class="summary-card" style="flex:1;min-width:220px">
          <div class="summary-card-label">💳 ローン残高合計</div>
          <div class="summary-card-value danger">－${currency(totalLoan)}</div>
          <div class="summary-card-sub">${loanAccounts.length}口座の合計</div>
        </div>
      </div>
      ${normalAccounts.length ? `<h3 style="margin:16px 0 4px">💰 口座残高</h3>${normalAccounts.map(accountRow).join('')}` : ''}
      ${loanAccounts.length ? `<h3 style="margin:16px 0 4px">💳 ローン残高</h3>${loanAccounts.map(accountRow).join('')}` : ''}
    `;
  }

  // --- 重複チェック(保存済みデータ全体を対象に、日付・金額・区分・摘要・残高が完全一致するものを探す) ---
  const duplicateCheckPanel = root.querySelector('#tsucho-duplicate-check-panel');
  const duplicateCheckResultEl = root.querySelector('#tsucho-duplicate-check-result');

  function renderDuplicateCheck() {
    const groups = findDuplicateGroups();
    if (!groups.length) {
      duplicateCheckResultEl.innerHTML = '<p class="empty-hint" style="padding-top:0">重複は見つかりませんでした。</p>';
      return;
    }
    duplicateCheckResultEl.innerHTML = `
      <p class="duplicate-warning" style="padding-top:0">${groups.length}件のグループで重複の可能性があります(日付・金額・区分・摘要・残高が完全一致)。</p>
      <button type="button" class="btn btn-primary" id="tsucho-delete-all-duplicates" style="margin-bottom:12px">🗑 すべてのグループをまとめて削除(各グループ1件だけ残す)</button>
      ${groups.map((g, gi) => `
        <div style="border:1px solid var(--color-border);border-radius:8px;padding:10px 12px;margin-bottom:10px">
          <p style="margin:0 0 6px;font-size:13px"><b>${g.records[0].date} ${g.records[0].direction} ${escapeHtml(g.records[0].counterparty) || '(摘要なし)'} ${currency(g.records[0].amount)}</b>(${g.records.length}件が完全一致)</p>
          <table class="data-table">
            <thead><tr><th style="width:32px"></th><th>決済口座</th><th>取込元ファイル</th><th>勘定科目</th></tr></thead>
            <tbody>${g.records.map((r, ri) => `
              <tr>
                <td><input type="checkbox" data-dup-record-id="${r.id}" ${ri > 0 ? 'checked' : ''}></td>
                <td>${escapeHtml(r.bankAccountName)}</td>
                <td>${escapeHtml(r.sourceFileName)}</td>
                <td>${escapeHtml(r.accountLabel)}</td>
              </tr>`).join('')}</tbody>
          </table>
          <button type="button" class="btn btn-secondary btn-sm" data-delete-dup-group="${gi}" style="margin-top:6px">チェックした行を削除</button>
        </div>`).join('')}
    `;

    duplicateCheckResultEl.querySelectorAll('[data-delete-dup-group]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const group = groups[Number(btn.dataset.deleteDupGroup)];
        const checkedIds = group.records
          .map((r) => r.id)
          .filter((id) => duplicateCheckResultEl.querySelector(`[data-dup-record-id="${id}"]`).checked);
        if (!checkedIds.length) { alert('削除する行にチェックを付けてください(通常は1件だけ残し、他をチェックします)。'); return; }
        if (checkedIds.length === group.records.length) { alert('全件を削除すると明細自体が無くなってしまいます。少なくとも1件は残してください。'); return; }
        if (!confirm(`${checkedIds.length}件を削除します。よろしいですか？`)) return;
        deleteTsuchoRecordsByIds(checkedIds);
        renderDuplicateCheck();
        renderAccountButtons();
        renderBankPanel();
        renderAccountSummary();
        renderFileHistory();
      });
    });

    root.querySelector('#tsucho-delete-all-duplicates').addEventListener('click', () => {
      // 表示中のチェック状態をそのまま使う(デフォルトは各グループ2件目以降にチェック=1件だけ残す)。
      const allChecked = Array.from(duplicateCheckResultEl.querySelectorAll('[data-dup-record-id]:checked')).map((el) => el.dataset.dupRecordId);
      if (!allChecked.length) { alert('削除する行がありません。'); return; }
      if (!confirm(`${groups.length}件のグループから、合計${allChecked.length}件をまとめて削除します。よろしいですか？`)) return;
      deleteTsuchoRecordsByIds(allChecked);
      renderDuplicateCheck();
      renderAccountButtons();
      renderBankPanel();
      renderAccountSummary();
      renderFileHistory();
    });
  }

  root.querySelector('#tsucho-check-duplicates').addEventListener('click', () => {
    setTsuchoTab('list');
    duplicateCheckPanel.classList.remove('hidden');
    renderDuplicateCheck();
    duplicateCheckPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // --- 残高チェック(口座ごとに、ファイルをまたいで全体をチェックする) ---
  const balanceCheckPanel = root.querySelector('#tsucho-balance-check-panel');
  const balanceCheckResultEl = root.querySelector('#tsucho-balance-check-result');

  function renderBalanceCheckAll() {
    const results = checkBalanceContinuityAllAccounts();
    balanceCheckResultEl.innerHTML = results.length
      ? results.map((r) => `
          <div style="border:1px solid var(--color-border);border-radius:8px;padding:10px 12px;margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
              <p style="margin:0 0 6px;font-size:13px"><b>${escapeHtml(r.accountName)}</b> — ${r.gaps.length}箇所</p>
              <button type="button" class="btn btn-primary btn-sm" data-rescan-account="${escapeAttr(r.accountName)}">📥 この口座を再スキャンして取り込む</button>
            </div>
            <div class="duplicate-warning">${r.gaps.map((g) => `・${g.afterDate}「${escapeHtml(g.afterCounterparty)}」の後 〜 ${g.beforeDate}「${escapeHtml(g.beforeCounterparty)}」の間: 本来 ${currency(g.expected)} のはずが ${currency(g.actual)}(差額 ${g.diff > 0 ? '+' : ''}${currency(g.diff)})`).join('<br>')}</div>
          </div>`).join('')
      : '<p class="empty-hint">✅ すべての口座で、残高のつながりに問題は見つかりませんでした。</p>';

    balanceCheckResultEl.querySelectorAll('[data-rescan-account]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.rescanAccount;
        state.activeAccount = name;
        renderAccountButtons();
        setTsuchoTab('import');
        dropzone.scrollIntoView({ behavior: 'smooth', block: 'center' });
        dropzone.classList.add('drag-active');
        setTimeout(() => dropzone.classList.remove('drag-active'), 1200);
      });
    });
  }

  root.querySelector('#tsucho-check-balance-top').addEventListener('click', () => {
    setTsuchoTab('list');
    balanceCheckPanel.classList.remove('hidden');
    renderBalanceCheckAll();
    balanceCheckPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // --- 口座一覧(保存済み明細を口座ごとに集計。最新残高で保存できているか確認できる) ---
  const accountSummaryResultEl = root.querySelector('#tsucho-account-summary-result');

  function renderAccountSummary() {
    const accounts = listAccountSummaries();
    accountSummaryResultEl.innerHTML = accounts.length
      ? `<table class="data-table">
          <thead><tr><th>口座名</th><th>口座番号</th><th>件数</th><th>合計金額</th><th>期間</th><th>残高(最新)</th><th>通帳残高確認</th></tr></thead>
          <tbody>${accounts.map((a) => {
            const isLoan = a.accountKind === '借入金';
            const verified = getVerifiedBalance(a.name);
            return `
            <tr ${isLoan ? 'style="background:#fef2f2"' : ''}>
              <td>${escapeHtml(a.name)}${isLoan ? ' <span class="badge" style="background:#fde2e2;color:var(--color-danger)">💳借入金口座</span>' : ''}</td>
              <td>${escapeHtml(a.accountNumber)}</td>
              <td>${a.count}件</td>
              <td>${currency(a.total)}</td>
              <td style="white-space:nowrap">${a.firstDate}${a.firstDate !== a.lastDate ? ` 〜 ${a.lastDate}` : ''}</td>
              <td style="font-weight:700${isLoan ? `;color:var(--color-danger)` : ''}">${a.latestBalance ? `${isLoan ? '－' : ''}${currency(a.latestBalance)}<span class="empty-hint" style="font-weight:400"> (${a.latestBalanceDate}時点)</span>` : '<span class="empty-hint">(残高不明)</span>'}</td>
              <td style="white-space:nowrap">
                <input type="number" class="tsucho-verify-balance-input" data-verify-account="${escapeAttr(a.name)}" placeholder="実際の残高" value="${verified ? verified.balance : ''}" style="width:110px">
                <button type="button" class="btn btn-secondary btn-sm" data-verify-account-btn="${escapeAttr(a.name)}">確認</button>
                <div data-verify-account-result="${escapeAttr(a.name)}" style="margin-top:4px">${verifiedBalanceResultHtml(a, verified)}</div>
              </td>
            </tr>`;
          }).join('')}</tbody>
        </table>`
      : '<p class="empty-hint">まだ保存済みの明細がありません。</p>';

    accountSummaryResultEl.querySelectorAll('[data-verify-account-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.verifyAccountBtn;
        const input = accountSummaryResultEl.querySelector(`.tsucho-verify-balance-input[data-verify-account="${CSS.escape(name)}"]`);
        const value = input.value.trim();
        if (value === '') { alert('実際の通帳残高を入力してください。'); return; }
        setVerifiedBalance(name, Number(value));
        const account = accounts.find((a) => a.name === name);
        const resultEl = accountSummaryResultEl.querySelector(`[data-verify-account-result="${CSS.escape(name)}"]`);
        resultEl.innerHTML = verifiedBalanceResultHtml(account, getVerifiedBalance(name));
      });
    });

    renderTopDashboard();
  }

  /** 「通帳残高確認」欄: ユーザーが入力した実際の残高と、アプリが自動集計した最新残高を比べた結果のHTML。 */
  function verifiedBalanceResultHtml(account, verified) {
    if (!verified) return '<span class="empty-hint">未確認</span>';
    const isLoan = account.accountKind === '借入金';
    const appBalance = isLoan ? -account.latestBalance : account.latestBalance;
    const diff = verified.balance - appBalance;
    const checkedDate = new Date(verified.checkedAt).toLocaleDateString('ja-JP');
    if (diff === 0) return `<span style="color:var(--color-success,#16a34a)">✅一致</span><span class="empty-hint">(${checkedDate}確認)</span>`;
    return `<span style="color:var(--color-danger);font-weight:700">⚠差額 ${diff > 0 ? '+' : ''}${currency(diff)}</span><span class="empty-hint">(${checkedDate}確認)</span>`;
  }

  // --- 取込ファイル一覧(これまでに「一覧に保存」したファイルの履歴) ---
  const fileHistoryPanel = root.querySelector('#tsucho-file-history-panel');
  const fileHistoryResultEl = root.querySelector('#tsucho-file-history-result');

  function renderFileHistory() {
    const files = listSourceFilesInRecords();
    const knownAccountNames = getKnownAccounts().map((a) => a.name);
    fileHistoryResultEl.innerHTML = files.length
      ? `<table class="data-table">
          <thead><tr><th>ファイル名</th><th>件数</th><th>合計金額</th><th>期間</th><th>決済口座</th><th></th></tr></thead>
          <tbody>${files.map((f) => {
            const accountOptions = Array.from(new Set([...knownAccountNames, ...f.bankAccountNames]));
            return `
            <tr>
              <td>${escapeHtml(f.sourceFileName)}</td>
              <td>${f.count}件</td>
              <td>${currency(f.total)}</td>
              <td style="white-space:nowrap">${f.firstDate}${f.firstDate !== f.lastDate ? ` 〜 ${f.lastDate}` : ''}</td>
              <td style="white-space:nowrap">
                ${f.bankAccountNames.map((n) => escapeHtml(n)).join(' / ')}
                <select data-reassign-file-account="${escapeAttr(f.sourceFileName)}" style="font-size:12px;margin-left:4px">
                  <option value="">口座を付け替え...</option>
                  ${accountOptions.map((n) => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`).join('')}
                </select>
              </td>
              <td style="white-space:nowrap">
                <button type="button" class="btn btn-secondary btn-sm" data-check-balance-file="${escapeAttr(f.sourceFileName)}">🔍残高チェック</button>
                <button type="button" class="btn btn-secondary btn-sm" data-redownload-file="${escapeAttr(f.sourceFileName)}">⇩ Excel</button>
                <button type="button" class="btn btn-ghost btn-sm" data-delete-file="${escapeAttr(f.sourceFileName)}">🗑削除</button>
                <span style="white-space:nowrap;display:inline-block;margin-top:4px">
                  日付を<input type="number" class="tsucho-shift-years-input" data-shift-years-file="${escapeAttr(f.sourceFileName)}" value="18" style="width:48px">年ずらす
                  <button type="button" class="btn btn-secondary btn-sm" data-shift-years-btn="${escapeAttr(f.sourceFileName)}">実行</button>
                </span>
              </td>
            </tr>
            <tr class="tsucho-balance-check-row hidden" data-balance-check-result-for="${escapeAttr(f.sourceFileName)}"><td colspan="6"></td></tr>`;
          }).join('')}</tbody>
        </table>`
      : '<p class="empty-hint">まだ保存済みのファイルがありません。</p>';

    fileHistoryResultEl.querySelectorAll('[data-reassign-file-account]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const sourceFileName = sel.dataset.reassignFileAccount;
        const newAccountName = sel.value;
        if (!newAccountName) return;
        if (!confirm(`「${sourceFileName}」の明細すべての決済口座を「${newAccountName}」に付け替えます。よろしいですか？`)) { sel.value = ''; return; }
        reassignSourceFileAccount(sourceFileName, newAccountName);
        renderFileHistory();
        renderAccountSummary();
        renderAccountButtons();
        renderBankPanel();
      });
    });

    fileHistoryResultEl.querySelectorAll('[data-shift-years-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sourceFileName = btn.dataset.shiftYearsBtn;
        const input = fileHistoryResultEl.querySelector(`.tsucho-shift-years-input[data-shift-years-file="${CSS.escape(sourceFileName)}"]`);
        const yearsOffset = Number(input.value);
        if (!yearsOffset) { alert('ずらす年数を入力してください(マイナスも可)。'); return; }
        if (!confirm(`「${sourceFileName}」の明細すべての日付の「年」を${yearsOffset > 0 ? '+' : ''}${yearsOffset}年ずらします。金額・残高・摘要は変更しません。よろしいですか？`)) return;
        const changed = shiftSourceFileDateYears(sourceFileName, yearsOffset);
        alert(`${changed}件の日付を修正しました。`);
        renderFileHistory();
        renderAccountSummary();
        renderBankPanel();
      });
    });

    fileHistoryResultEl.querySelectorAll('[data-check-balance-file]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.checkBalanceFile;
        const resultRow = fileHistoryResultEl.querySelector(`[data-balance-check-result-for="${CSS.escape(name)}"]`);
        const cell = resultRow.querySelector('td');
        const gaps = checkBalanceContinuityForFile(name);
        cell.innerHTML = gaps.length
          ? `<div class="duplicate-warning">⚠ ${gaps.length}箇所、残高のつながりが崩れています(この間に読み取れていない取引がある可能性があります):<br>${
              gaps.map((g) => `・${g.afterDate}「${escapeHtml(g.afterCounterparty)}」の後 〜 ${g.beforeDate}「${escapeHtml(g.beforeCounterparty)}」の間: 本来 ${currency(g.expected)} のはずが ${currency(g.actual)}(差額 ${g.diff > 0 ? '+' : ''}${currency(g.diff)})`).join('<br>')
            }</div>`
          : '<span class="empty-hint">✅ 残高のつながりに問題は見つかりませんでした。</span>';
        resultRow.classList.remove('hidden');
      });
    });
    fileHistoryResultEl.querySelectorAll('[data-redownload-file]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.redownloadFile;
        const rows = getTsuchoRecords().filter((r) => r.sourceFileName === name);
        downloadXlsx(`${baseNameOf(name)}.xlsx`, EXPORT_HEADERS, rows.map(rowToExportArray));
      });
    });
    fileHistoryResultEl.querySelectorAll('[data-delete-file]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.deleteFile;
        if (!confirm(`「${name}」から保存した明細をすべて削除します。よろしいですか？`)) return;
        deleteTsuchoRecordsBySource(name);
        const fileEntry = state.files.find((x) => x.fileName === name);
        if (fileEntry) fileEntry.saved = false;
        renderFileHistory();
        renderAccountSummary();
        renderFileList();
        renderAccountButtons();
        renderBankPanel();
      });
    });
  }

  root.querySelector('#tsucho-show-file-history').addEventListener('click', () => {
    setTsuchoTab('list');
    fileHistoryPanel.classList.remove('hidden');
    renderAccountSummary();
    renderFileHistory();
    fileHistoryPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // --- APIキー設定 ---
  const settingsToggle = root.querySelector('#tsucho-toggle-settings');
  const settingsPanel = root.querySelector('#tsucho-settings-panel');
  const apiKeyStatus = root.querySelector('#tsucho-api-key-status');
  const apiKeyInput = root.querySelector('#tsucho-api-key-input');

  function renderApiKeyStatus() {
    apiKeyStatus.textContent = hasApiKey() ? '(設定済み)' : '(未設定)';
  }
  renderApiKeyStatus();

  settingsToggle.addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
    if (!settingsPanel.classList.contains('hidden')) apiKeyInput.value = getApiKey();
  });
  root.querySelector('#tsucho-save-key').addEventListener('click', () => {
    setApiKey(apiKeyInput.value.trim());
    renderApiKeyStatus();
    settingsPanel.classList.add('hidden');
  });
  root.querySelector('#tsucho-clear-key').addEventListener('click', () => {
    setApiKey('');
    apiKeyInput.value = '';
    renderApiKeyStatus();
  });

  // --- アップロード ---
  const dropzone = root.querySelector('#tsucho-dropzone');
  const fileInput = root.querySelector('#tsucho-file-input');
  const fileListEl = root.querySelector('#tsucho-file-list');

  root.querySelector('#tsucho-pick-file').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag-active'); }));
  ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag-active'); }));
  dropzone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));

  // --- よく使う口座のクイック選択ボタン(サイドバー) ---
  const accountButtonsEl = sidebarRoot.querySelector('#tsucho-account-buttons');
  const newAccountInput = sidebarRoot.querySelector('#tsucho-new-account-input');
  const sidebarFilterCorpBtn = sidebarRoot.querySelector('#tsucho-sidebar-filter-corp');
  const sidebarFilterPersonalBtn = sidebarRoot.querySelector('#tsucho-sidebar-filter-personal');

  function setSidebarEntityFilter(type) {
    state.sidebarEntityFilter = state.sidebarEntityFilter === type ? null : type;
    sidebarFilterCorpBtn.className = `btn btn-sm ${state.sidebarEntityFilter === '法人' ? 'btn-primary' : 'btn-secondary'}`;
    sidebarFilterPersonalBtn.className = `btn btn-sm ${state.sidebarEntityFilter === '個人' ? 'btn-primary' : 'btn-secondary'}`;
    sidebarFilterCorpBtn.style.flex = '1';
    sidebarFilterPersonalBtn.style.flex = '1';
    renderAccountButtons();
  }
  sidebarFilterCorpBtn.addEventListener('click', () => setSidebarEntityFilter('法人'));
  sidebarFilterPersonalBtn.addEventListener('click', () => setSidebarEntityFilter('個人'));

  function renderAccountButtons() {
    const allAccounts = getKnownAccounts();
    if (!allAccounts.length) {
      accountButtonsEl.innerHTML = '<p class="empty-hint" style="padding:6px 16px">まだ口座がありません。下の欄から追加するか、ファイルカードで決済口座を入力すると自動で登録されます。</p>';
      return;
    }
    const accounts = state.sidebarEntityFilter
      ? allAccounts.filter((a) => entityTypeOf(a.name) === state.sidebarEntityFilter)
      : allAccounts;
    if (!accounts.length) {
      accountButtonsEl.innerHTML = `<p class="empty-hint" style="padding:6px 16px">「${escapeHtml(state.sidebarEntityFilter)}」を含む口座がありません。</p>`;
      return;
    }

    const byGroup = {};
    for (const a of accounts) {
      const key = bankNameOf(a.name);
      (byGroup[key] ??= []).push(a);
    }

    // 選択(クリックで口座を選ぶ)専用の一覧。誤って消してしまわないよう、削除ボタンはここには置かない
    // (削除は下の「⚙️ 口座を管理」から明示的に行う)。
    // 口座が1つしかない銀行、または法人/個人で絞り込み中は、開閉の意味が無いので常に展開した状態で表示する。
    accountButtonsEl.innerHTML = Object.entries(byGroup).map(([bank, list]) => {
      const expanded = list.length === 1 || !!state.sidebarEntityFilter || state.expandedBankGroups.has(bank);
      return `
      <div class="account-group">
        <button type="button" class="account-group-label" data-toggle-group="${escapeAttr(bank)}" style="display:flex;align-items:center;gap:4px;width:100%;background:none;border:none;cursor:pointer;text-align:left">
          <span>${list.length > 1 ? (expanded ? '▼' : '▶') : ''}</span>
          <span>🏦 ${escapeHtml(bank)}</span>
          <span style="color:var(--color-text-muted);font-weight:400">(${list.length}件)</span>
        </button>
        ${expanded ? list.map((a) => `
          <button type="button" class="account-btn ${a.name === state.activeAccount ? 'active' : ''}" data-select-account="${escapeAttr(a.name)}" title="${escapeAttr(a.name)}${a.accountNumber ? ` (口座番号: ${a.accountNumber})` : ''}">${escapeHtml(accountLabelWithinGroup(a.name, bank))}${a.accountNumber ? ' 🔗' : ''}</button>`).join('') : ''}
      </div>`;
    }).join('');

    accountButtonsEl.querySelectorAll('[data-toggle-group]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bank = btn.dataset.toggleGroup;
        if (state.expandedBankGroups.has(bank)) state.expandedBankGroups.delete(bank);
        else state.expandedBankGroups.add(bank);
        renderAccountButtons();
      });
    });

    accountButtonsEl.querySelectorAll('[data-select-account]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.selectAccount;
        state.activeAccount = state.activeAccount === name ? null : name;
        renderAccountButtons();
        // 選んだ口座の明細一覧を下のパネルにも表示して、そのままスクロールで見られるようにする。
        state.selectedBankGroup = bankNameOf(name);
        state.selectedAccount = name;
        renderBankPanel();
        setTsuchoTab('list');
      });
    });
  }

  sidebarRoot.querySelector('#tsucho-add-account').addEventListener('click', () => {
    const name = newAccountInput.value.trim();
    if (!name) return;
    addKnownAccount(name);
    newAccountInput.value = '';
    renderAccountButtons();
    renderAccountManagement();
  });
  newAccountInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sidebarRoot.querySelector('#tsucho-add-account').click();
  });

  // --- 口座名の統合(保存済み明細に実際に登場する決済口座名をまとめて洗い出し、チェックした分を一括統合する) ---
  const accountManageToggle = sidebarRoot.querySelector('#tsucho-toggle-account-manage');
  const accountManagePanel = root.querySelector('#tsucho-account-manage-panel');
  const accountManageListEl = root.querySelector('#tsucho-account-manage-list');
  const mergeTargetInput = root.querySelector('#tsucho-merge-target-input');

  function renderAccountManagement() {
    const knownAccounts = getKnownAccounts();
    const namesInRecords = listBankAccountNamesInRecords();
    // 明細が1件も無い、追加したばかりの口座もここに出す(法人/個人・種別を先に設定できるように)。
    const namesInRecordsSet = new Set(namesInRecords.map((n) => n.name));
    const emptyKnownAccounts = knownAccounts
      .filter((a) => !namesInRecordsSet.has(a.name))
      .map((a) => ({ name: a.name, count: 0, total: 0 }));
    const names = [...namesInRecords, ...emptyKnownAccounts];
    const entityTypeSelect = (name) => `
      <select data-set-entity-type="${escapeAttr(name)}" style="font-size:12px">
        <option value="" ${!entityTypeOf(name) || entityTypeOf(name) === NO_ENTITY_LABEL ? 'selected' : ''}>未設定</option>
        <option value="法人" ${entityTypeOf(name) === '法人' ? 'selected' : ''}>法人</option>
        <option value="個人" ${entityTypeOf(name) === '個人' ? 'selected' : ''}>個人</option>
      </select>`;
    const kindSelect = (name) => {
      const kind = knownAccounts.find((a) => a.name === name)?.accountKind || '';
      return `
      <select data-set-account-kind="${escapeAttr(name)}" style="font-size:12px">
        <option value="" ${kind === '' ? 'selected' : ''}>通常</option>
        <option value="借入金" ${kind === '借入金' ? 'selected' : ''}>💳借入金</option>
      </select>`;
    };
    accountManageListEl.innerHTML = names.length
      ? `<p class="empty-hint" style="padding:0 0 6px">口座名に「法人」「個人」の文字が無い口座(例: 静岡銀行 274支店 普通)も、右のプルダウンで手動で区分を設定できます(「🏢 法人・個人別」表示に使われます)。ローンなど借入の口座は「種別」を「💳借入金」にすると、口座一覧で残高がマイナス表示になります。</p>
        <table class="data-table"><thead><tr><th style="width:32px"></th><th>決済口座名</th><th>件数</th><th>合計</th><th>法人/個人</th><th>種別</th><th></th></tr></thead><tbody>${
          names.map((n) => `
            <tr>
              <td><input type="checkbox" data-merge-check="${escapeAttr(n.name)}"></td>
              <td>${escapeHtml(n.name)}</td>
              <td>${n.count}件</td>
              <td>${currency(n.total)}</td>
              <td>${entityTypeSelect(n.name)}</td>
              <td>${kindSelect(n.name)}</td>
              <td><button type="button" class="btn btn-ghost btn-sm" data-rename-account="${escapeAttr(n.name)}">✏️名前変更</button></td>
            </tr>`).join('')
        }</tbody></table>`
      : '<p class="empty-hint">まだ保存済みの明細がありません。</p>';

    accountManageListEl.querySelectorAll('[data-set-entity-type]').forEach((sel) => {
      sel.addEventListener('change', () => {
        setAccountEntityType(sel.dataset.setEntityType, sel.value);
        renderAccountButtons();
        renderBankPanel();
      });
    });

    accountManageListEl.querySelectorAll('[data-set-account-kind]').forEach((sel) => {
      sel.addEventListener('change', () => {
        setAccountKind(sel.dataset.setAccountKind, sel.value);
        renderAccountSummary();
        renderBankPanel();
      });
    });

    accountManageListEl.querySelectorAll('[data-rename-account]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const oldName = btn.dataset.renameAccount;
        const otherNames = names.map((n) => n.name).filter((n) => n !== oldName);
        const hint = otherNames.length ? `\n(既存の口座名と同じにすると、1つに統合されます: ${otherNames.join(' / ')})` : '';
        const newName = prompt(`「${oldName}」の新しい口座名を入力してください。${hint}`, oldName);
        if (newName === null) return; // キャンセル
        const trimmed = newName.trim();
        if (!trimmed || trimmed === oldName) return;
        const changedCount = mergeBankAccountNames([oldName], trimmed);
        state.files.forEach((f) => {
          if (f.bankAccountName === oldName) f.bankAccountName = trimmed;
          f.rows?.forEach((r) => { if (r.bankAccountName === oldName) r.bankAccountName = trimmed; });
        });
        if (state.activeAccount === oldName) state.activeAccount = trimmed;
        alert(`「${oldName}」→「${trimmed}」に変更しました。保存済み明細 ${changedCount}件のbankAccountNameを書き換えました。`);
        renderAccountButtons();
        renderAccountManagement();
        renderFileList();
        renderBankPanel();
        renderAccountSummary();
        renderFileHistory();
      });
    });
  }

  function openAccountManagePanel() {
    setTsuchoTab('import');
    accountManagePanel.classList.remove('hidden');
    renderAccountManagement();
    accountManagePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  accountManageToggle.addEventListener('click', openAccountManagePanel);
  root.querySelector('#tsucho-show-account-manage-top').addEventListener('click', openAccountManagePanel);

  root.querySelector('#tsucho-merge-accounts').addEventListener('click', () => {
    const checked = Array.from(accountManageListEl.querySelectorAll('[data-merge-check]:checked')).map((el) => el.dataset.mergeCheck);
    const targetName = mergeTargetInput.value.trim();
    if (!targetName) { alert('統合後の正しい口座名を入力してください。'); return; }
    if (checked.length === 0) { alert('統合したい口座名に、左のチェックボックスを付けてください。'); return; }
    if (!confirm(`選択した${checked.length}件(${checked.join(' / ')})を「${targetName}」に統合します。保存済み明細のbankAccountNameが書き換わります。よろしいですか？`)) return;

    const changedCount = mergeBankAccountNames(checked, targetName);
    // 開いたままのファイルカード(下書き)の決済口座欄も合わせて書き換える。
    const checkedSet = new Set(checked);
    state.files.forEach((f) => {
      if (checkedSet.has(f.bankAccountName)) f.bankAccountName = targetName;
      f.rows?.forEach((r) => { if (checkedSet.has(r.bankAccountName)) r.bankAccountName = targetName; });
    });
    if (checkedSet.has(state.activeAccount)) state.activeAccount = targetName;
    alert(`「${targetName}」に統合しました。保存済み明細 ${changedCount}件のbankAccountNameを書き換えました。`);
    mergeTargetInput.value = '';
    renderAccountButtons();
    renderAccountManagement();
    renderFileList();
    renderBankPanel();
    renderAccountSummary();
    renderFileHistory();
  });

  // ファイルを追加しただけでは自動処理せず「queued(取込待ち)」状態にする。
  // APIキー未設定のまま自動で失敗して分かりにくい、という声を受けて、
  // 明示的に「📥 取り込む」ボタンを押したタイミングで初めて解析を始める。
  function handleFiles(fileList) {
    const files = Array.from(fileList);
    if (!files.length) return;
    for (const file of files) {
      const entry = { id: uid('tf'), fileName: file.name, file, bankAccountName: state.activeAccount || '', status: 'queued', rows: [], saved: false, errorMessage: '' };
      state.files.unshift(entry);
    }
    renderFileList();
  }

  function importFile(entry) {
    entry.status = 'pending';
    renderFileList();
    processFile(entry.file, entry);
  }

  async function processFile(file, entry) {
    try {
      const lower = file.name.toLowerCase();
      let rawTxns = null;
      let bankName = '';
      let accountHolder = '';
      let accountNumber = '';

      if (lower.endsWith('.xlsx')) {
        const buf = await file.arrayBuffer();
        if (!(await isBankStatementXlsx(buf))) {
          throw new Error('xlsxの列(日付/摘要/出金額/入金額/残高)が見つかりませんでした。銀行の明細エクスポート形式をご確認ください。');
        }
        rawTxns = await parseBankStatementXlsx(buf);
      } else if (lower.endsWith('.csv')) {
        const text = await file.text();
        rawTxns = parseCsvBankStatement(text);
        if (!rawTxns) throw new Error('CSVの列(日付・出金額・入金額など)を認識できませんでした。');
      } else if (/\.(pdf|png|jpe?g|gif|webp|heic)$/i.test(file.name) || file.type.startsWith('image/') || file.type === 'application/pdf') {
        if (!hasApiKey()) throw new Error('PDF/画像の読み取りにはAPIキーが必要です。右上の「⚙️ APIキー設定」から設定してください。');
        const dataUrl = await fileToDataUrl(file);
        const result = await analyzeBankStatementDocument(dataUrl);
        if (!result) throw new Error('通帳の読み取りに失敗しました。画像が鮮明か、APIキーが正しいかご確認ください。');
        rawTxns = result.transactions || [];
        bankName = result.bankName || '';
        accountHolder = result.accountHolder || '';
        accountNumber = result.accountNumber || '';
      } else {
        throw new Error('対応していないファイル形式です(PDF・画像・xlsx・csvのみ対応)。');
      }

      // 決済口座の決定は次の優先順位: ①クイック選択ボタンで既に指定済み(最優先・明示的な指定)
      // ②表紙から読み取った口座番号が既知の口座と完全一致 ③銀行名/名義が既知の口座名に部分一致
      // ④AIが読み取った金融機関名をそのまま使う(要確認)
      let matchedKnownAccount = false;
      if (!entry.bankAccountName && accountNumber) {
        const byNumber = findKnownAccountByNumber(accountNumber);
        if (byNumber) { entry.bankAccountName = byNumber.name; matchedKnownAccount = true; }
      }
      if (!entry.bankAccountName && bankName) {
        const detectedText = `${bankName} ${accountHolder}`.trim();
        const known = getKnownAccounts().find((a) => detectedText.includes(a.name) || a.name.includes(bankName));
        if (known) { entry.bankAccountName = known.name; matchedKnownAccount = true; }
      }
      if (entry.bankAccountName) matchedKnownAccount = true; // クイック選択ボタンで既に指定済みだった場合
      entry.bankAccountName = entry.bankAccountName || bankName;
      // 既知の口座に一致した場合だけ、読み取れた口座番号をその口座に紐付ける(次回以降の自動判定用)。
      // 一致しなかった場合、AIの読み取り文字列(OCR不良で文字化けすることがある)をそのまま
      // 新しい口座ボタンとして登録してしまうと一覧が汚れるため、ここでは登録しない
      // (この回の決済口座欄には反映されるので、手動で確認・修正してから使ってください)。
      if (accountNumber && entry.bankAccountName && matchedKnownAccount) addKnownAccount(entry.bankAccountName, accountNumber);
      // 表紙から読み取れなかった場合は、既知の口座に登録済みの番号があればそれを表示用に使う。
      entry.accountNumber = accountNumber || getKnownAccounts().find((a) => a.name === entry.bankAccountName)?.accountNumber || '';

      const savedRecords = getTsuchoRecords();
      entry.rows = (rawTxns || []).map((t) => {
        const row = rawTxnToRow(entry.fileName, entry.bankAccountName, t);
        const dup = findDuplicateInSaved(row, savedRecords);
        row.possibleDuplicate = !!dup;
        row.duplicateOf = dup;
        return row;
      });
      flagBalanceMismatches(entry.rows);
      entry.status = 'done';
    } catch (e) {
      entry.status = 'error';
      entry.errorMessage = e.message || String(e);
    }
    renderAccountButtons();
    renderFileList();
    renderBankPanel();
  }

  function renderFileList() {
    const importable = state.files.filter((f) => f.status === 'queued' || f.status === 'error');
    fileListEl.innerHTML = `
      ${importable.length > 1 ? `<button type="button" class="btn btn-primary" id="tsucho-import-all" style="margin-bottom:12px">📥 ${importable.length}件まとめて取り込む</button>` : ''}
      ${state.files.map(fileCardHtml).join('')}
    `;
    const importAllBtn = fileListEl.querySelector('#tsucho-import-all');
    if (importAllBtn) importAllBtn.addEventListener('click', () => importable.forEach(importFile));

    // タブボタンの横に、今読み込んでいる(直近でドラッグ&ドロップした)ファイル名を表示する。
    if (!state.files.length) {
      currentFileLabelEl.textContent = '';
    } else if (state.files.length === 1) {
      currentFileLabelEl.textContent = `📄 ${state.files[0].fileName}`;
    } else {
      currentFileLabelEl.textContent = `📄 ${state.files[0].fileName} 他${state.files.length - 1}件`;
    }
  }

  function fileCardHtml(f) {
    if (f.status === 'queued') {
      return `<div class="panel" style="margin-top:12px" data-file-id="${f.id}">
        <div class="panel-header">
          <h2>${escapeHtml(f.fileName)} <span class="badge badge-status">取込待ち</span></h2>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button type="button" class="btn btn-primary" data-action="import" style="font-size:16px;padding:12px 22px">📥 取り込む</button>
            <button type="button" class="btn btn-ghost" data-action="remove" style="font-size:16px;padding:12px 22px">🗑 削除</button>
          </div>
        </div>
      </div>`;
    }
    if (f.status === 'pending') {
      return `<div class="panel" style="margin-top:12px" data-file-id="${f.id}">
        <div class="panel-header"><h2>${escapeHtml(f.fileName)}</h2><span class="badge badge-status">⏳ 解析中…</span></div>
      </div>`;
    }
    if (f.status === 'error') {
      return `<div class="panel" style="margin-top:12px" data-file-id="${f.id}">
        <div class="panel-header">
          <h2>${escapeHtml(f.fileName)}</h2>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button type="button" class="btn btn-primary" data-action="import" style="font-size:16px;padding:12px 22px">📥 取り込む(再試行)</button>
            <button type="button" class="btn btn-ghost" data-action="remove" style="font-size:16px;padding:12px 22px">🗑 削除</button>
          </div>
        </div>
        <p class="duplicate-warning">⚠ ${escapeHtml(f.errorMessage)}</p>
      </div>`;
    }
    const totalIn = f.rows.filter((r) => r.direction === '入金').reduce((s, r) => s + r.amount, 0);
    const totalOut = f.rows.filter((r) => r.direction === '出金').reduce((s, r) => s + r.amount, 0);
    return `<div class="panel" style="margin-top:12px" data-file-id="${f.id}">
      <div class="panel-header">
        <h2>${escapeHtml(f.fileName)}${f.saved ? ' <span class="badge badge-status status-matched">保存済み</span>' : ''}</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn btn-secondary btn-sm" data-action="add-row">＋行追加</button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="save">💾 一覧に保存</button>
          <button type="button" class="btn btn-primary btn-sm" data-action="download">⇩ Excelを保存(${escapeHtml(baseNameOf(f.fileName))}.xlsx)</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="remove">🗑削除</button>
        </div>
      </div>
      <div class="field-row" style="align-items:flex-end">
        <label class="field" style="flex:1">
          <span>決済口座(通帳の銀行・支店・種別)</span>
          <input type="text" data-field="bankAccountName" value="${escapeAttr(f.bankAccountName)}" placeholder="例: 三井住友銀行 渋谷支店 普通" style="font-size:20px;padding:12px 14px">
        </label>
        <div style="flex:1">
          <span style="display:block;color:var(--color-text-muted);font-size:13px;margin-bottom:4px">口座番号</span>
          <div style="font-size:28px;font-weight:700;letter-spacing:0.03em">${f.accountNumber ? escapeHtml(f.accountNumber) : '<span class="empty-hint" style="font-size:16px;font-weight:400">(未検出)</span>'}</div>
        </div>
      </div>
      <p class="empty-hint">入金合計 ${currency(totalIn)} ／ 出金合計 ${currency(totalOut)} ／ ${f.rows.length}件</p>
      <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr><th>発生日</th><th>区分</th><th>勘定科目</th><th>取引先(摘要)</th><th>品目・備考</th><th>税区分</th><th>金額</th><th>残高</th><th></th></tr></thead>
        <tbody>${f.rows.map(rowHtml).join('')}</tbody>
      </table>
      </div>
    </div>`;
  }

  function rowHtml(r) {
    const mainRow = `<tr data-row-id="${r.id}" class="${r.needsReview || r.needsSplit || r.possibleDuplicate || r.needsBalanceCheck ? 'tsucho-row-flag' : ''}">
      <td>${r.possibleDuplicate ? '<div class="badge badge-status" style="margin-bottom:4px">⚠重複?</div>' : ''}<input type="date" data-field="date" value="${r.date}" style="width:130px"></td>
      <td><select data-field="direction"><option value="入金" ${r.direction === '入金' ? 'selected' : ''}>入金</option><option value="出金" ${r.direction === '出金' ? 'selected' : ''}>出金</option></select></td>
      <td><select data-field="accountLabel">${categoryOptionsHtml(r.accountLabel)}</select></td>
      <td><input type="text" data-field="counterparty" value="${escapeAttr(r.counterparty)}" style="width:150px"></td>
      <td><input type="text" data-field="memo" value="${escapeAttr(r.memo)}" style="width:150px"></td>
      <td><select data-field="taxCategory">${taxOptionsHtml(r.taxCategory)}</select></td>
      <td><input type="number" data-field="amount" value="${r.amount}" style="width:90px"></td>
      <td style="color:var(--color-text-muted);white-space:nowrap">${r.needsBalanceCheck ? '<div class="badge badge-status" style="margin-bottom:4px" title="前の行の残高±今回の金額と一致しません。読み取りミスや行の重複・抜けの可能性があります">⚠残高不一致</div>' : ''}${r.balance ? currency(r.balance) : ''}</td>
      <td style="white-space:nowrap">
        <button type="button" class="btn btn-ghost btn-sm" data-row-action="split" title="元金/利息などに分割">🔀</button>
        <button type="button" class="btn btn-ghost btn-sm" data-row-action="delete" title="この行を削除">🗑</button>
      </td>
    </tr>`;
    // 重複候補の行には、実際に一致した保存済みデータを直下に並べて表示し、その場で比較できるようにする。
    const dup = r.duplicateOf;
    const compareRow = dup ? `<tr class="tsucho-dup-compare">
      <td colspan="9">🔁 保存済みの「<b>${escapeHtml(dup.sourceFileName)}</b>」に同じ内容が既にあります: ${dup.date} ${dup.direction} ${escapeHtml(dup.accountLabel)} 「${escapeHtml(dup.counterparty)}」 ${currency(dup.amount)}</td>
    </tr>` : '';
    return mainRow + compareRow;
  }

  fileListEl.addEventListener('click', (e) => {
    const fileCard = e.target.closest('[data-file-id]');
    if (!fileCard) return;
    const f = state.files.find((x) => x.id === fileCard.dataset.fileId);
    if (!f) return;

    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'import') {
      importFile(f);
      return;
    }
    if (action === 'remove') {
      if (f.saved && !confirm(`「${f.fileName}」を取り込み一覧から削除します。保存済みの明細(下部の銀行別一覧)も削除されます。よろしいですか？`)) return;
      if (f.saved) deleteTsuchoRecordsBySource(f.fileName);
      state.files = state.files.filter((x) => x.id !== f.id);
      renderFileList();
      renderBankPanel();
      renderAccountSummary();
      renderFileHistory();
      renderAccountButtons();
      return;
    }
    if (action === 'add-row') {
      f.rows.push({
        id: uid('trow'), sourceFileName: f.fileName, date: '', direction: '出金', accountLabel: '未分類',
        bankAccountName: f.bankAccountName, counterparty: '', memo: '', taxCategory: '要確認', amount: 0,
      });
      renderFileList();
      renderBankPanel();
      return;
    }
    if (action === 'save') {
      if (!f.rows.length) { alert('保存する明細がありません。'); return; }
      const invalidRow = f.rows.find((r) => !r.date);
      if (invalidRow) { alert('発生日が空欄の行があります。すべての行に日付を入力してください。'); return; }
      const dupCount = f.rows.filter((r) => r.possibleDuplicate).length;
      if (dupCount > 0 && !confirm(`${dupCount}件、既に保存済みの明細と日付・金額・区分・摘要が一致する行があります(表を再スキャンした場合など、二重取込の可能性があります)。⚠マークの行を確認のうえ、それでも保存しますか？`)) return;
      // seq: 通帳・明細ファイル内での本来の行順(0始まり)。Firestoreはコレクションを日付順・保存順どおりに
      // 返してくれない(ドキュメントの並び順は保証されない)ため、同じ日付の行が複数あるとき
      // (例: 積立式振替・約定利息・延滞利息が同日に何行も続く場合)に本来の順序へ並べ直すために使う。
      const records = f.rows.map((r, idx) => ({ ...r, bankAccountName: f.bankAccountName, createdAt: Date.now(), seq: idx }));
      upsertTsuchoRecords(records);
      f.saved = true;
      renderFileList();
      renderBankPanel();
      return;
    }
    if (action === 'download') {
      if (!f.rows.length) { alert('保存する明細がありません。'); return; }
      downloadXlsx(`${baseNameOf(f.fileName)}.xlsx`, EXPORT_HEADERS, f.rows.map(rowToExportArray));
      return;
    }

    const rowEl = e.target.closest('tr[data-row-id]');
    if (!rowEl) return;
    const rowAction = e.target.closest('[data-row-action]')?.dataset.rowAction;
    if (!rowAction) return;
    const idx = f.rows.findIndex((r) => r.id === rowEl.dataset.rowId);
    if (idx === -1) return;
    if (rowAction === 'delete') {
      f.rows.splice(idx, 1);
      renderFileList();
      renderBankPanel();
    } else if (rowAction === 'split') {
      const original = f.rows[idx];
      const isLoan = original.accountLabel === '借入金';
      const newLabel = isLoan ? '支払利息' : '未分類';
      const split = {
        id: uid('trow'), sourceFileName: f.fileName, date: original.date, direction: original.direction,
        accountLabel: newLabel, bankAccountName: original.bankAccountName, counterparty: original.counterparty,
        memo: isLoan ? '' : original.memo, taxCategory: defaultTaxForCategory(newLabel), amount: 0,
      };
      f.rows.splice(idx + 1, 0, split);
      renderFileList();
      renderBankPanel();
    }
  });

  fileListEl.addEventListener('change', (e) => {
    const fileCard = e.target.closest('[data-file-id]');
    if (!fileCard) return;
    const f = state.files.find((x) => x.id === fileCard.dataset.fileId);
    if (!f) return;

    if (e.target.dataset.field === 'bankAccountName') {
      f.bankAccountName = e.target.value;
      f.rows.forEach((r) => { r.bankAccountName = e.target.value; });
      addKnownAccount(e.target.value);
      renderAccountButtons();
      renderBankPanel();
      return;
    }
    const rowEl = e.target.closest('tr[data-row-id]');
    if (!rowEl) return;
    const row = f.rows.find((r) => r.id === rowEl.dataset.rowId);
    if (!row) return;
    const field = e.target.dataset.field;
    if (!field) return;
    if (field === 'amount') row.amount = Math.round(Number(e.target.value) || 0);
    else row[field] = e.target.value;
    if (field === 'accountLabel') {
      row.taxCategory = defaultTaxForCategory(e.target.value);
      renderFileList();
    }
    renderBankPanel();
  });

  // --- 明細一覧(銀行別・口座別) ---
  const bankListEl = root.querySelector('#tsucho-bank-list');
  const bankSummaryEl = root.querySelector('#tsucho-bank-summary');
  const bankSourcesEl = root.querySelector('#tsucho-bank-sources');
  const bankTableEl = root.querySelector('#tsucho-bank-table');
  const bankFromInput = root.querySelector('#tsucho-from');
  const bankToInput = root.querySelector('#tsucho-to');
  const groupModeBankBtn = root.querySelector('#tsucho-group-mode-bank');
  const groupModeEntityBtn = root.querySelector('#tsucho-group-mode-entity');

  function setGroupMode(mode) {
    state.groupMode = mode;
    state.selectedBankGroup = null;
    state.selectedAccount = null;
    groupModeBankBtn.className = `btn btn-sm ${mode === 'bank' ? 'btn-primary' : 'btn-secondary'}`;
    groupModeEntityBtn.className = `btn btn-sm ${mode === 'entity' ? 'btn-primary' : 'btn-secondary'}`;
    renderBankPanel();
  }
  groupModeBankBtn.addEventListener('click', () => setGroupMode('bank'));
  groupModeEntityBtn.addEventListener('click', () => setGroupMode('entity'));

  /** 保存済み(TsuchoTxn)＋まだ「一覧に保存」していないファイルカードの明細(下書き)を合わせて返す。 */
  function allBankRows() {
    const saved = getTsuchoRecords();
    const draft = state.files
      .filter((f) => f.status === 'done' && !f.saved)
      .flatMap((f) => f.rows.map((r) => ({ ...r, bankAccountName: f.bankAccountName, sourceFileName: f.fileName, draft: true })));
    return [...saved, ...draft];
  }

  /** state.groupModeに応じて、決済口座名から「大分類」(銀行名 or 法人/個人)を求める。 */
  function primaryGroupKeyOf(bankAccountName) {
    if (state.groupMode === 'entity') return entityTypeOf(bankAccountName);
    return bankNameOf(bankAccountName) || NO_BANK_LABEL;
  }

  function listBankGroups() {
    const byGroup = {};
    for (const r of allBankRows()) {
      const key = primaryGroupKeyOf(r.bankAccountName);
      if (!byGroup[key]) byGroup[key] = { name: key, count: 0, total: 0 };
      byGroup[key].count += 1;
      byGroup[key].total += r.amount;
    }
    return Object.values(byGroup).sort((a, b) => b.total - a.total);
  }

  /** 選択中の大分類(銀行 or 法人/個人)の中にある、口座(決済口座欄のフル文字列)ごとの内訳。1件しかない場合は空配列を返す(一覧が冗長にならないよう省略)。 */
  function listAccountsInGroup(groupName) {
    const byAccount = {};
    for (const r of allBankRows()) {
      if (primaryGroupKeyOf(r.bankAccountName) !== groupName) continue;
      const key = r.bankAccountName || NO_BANK_LABEL;
      if (!byAccount[key]) byAccount[key] = { name: key, count: 0, total: 0 };
      byAccount[key].count += 1;
      byAccount[key].total += r.amount;
    }
    const accounts = Object.values(byAccount).sort((a, b) => b.total - a.total);
    return accounts.length > 1 ? accounts : [];
  }

  function filteredBankRecords() {
    if (!state.selectedBankGroup) return [];
    return allBankRows()
      .filter((r) => primaryGroupKeyOf(r.bankAccountName) === state.selectedBankGroup)
      .filter((r) => !state.selectedAccount || (r.bankAccountName || NO_BANK_LABEL) === state.selectedAccount)
      .filter((r) => !state.from || r.date >= state.from)
      .filter((r) => !state.to || r.date <= state.to)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  function renderBankPanel() {
    const groups = listBankGroups();
    if (state.selectedBankGroup && !groups.some((g) => g.name === state.selectedBankGroup)) {
      state.selectedBankGroup = null;
      state.selectedAccount = null;
    }

    bankListEl.innerHTML = groups.length
      ? groups.map((g) => {
          const accounts = state.selectedBankGroup === g.name ? listAccountsInGroup(g.name) : [];
          const groupActive = g.name === state.selectedBankGroup && !state.selectedAccount;
          const accountsHtml = accounts.map((a) => `
            <div class="bank-list-row bank-list-row-sub ${a.name === state.selectedAccount ? 'active' : ''}" data-bank-group="${escapeAttr(g.name)}" data-account="${escapeAttr(a.name)}">
              <div class="bank-list-name" title="${escapeAttr(a.name)}">↳ ${escapeHtml(accountLabelWithinGroup(a.name, g.name))}</div>
              <div class="bank-list-sub">${a.count}件 ・ ${currency(a.total)}</div>
            </div>`).join('');
          return `
            <div class="bank-list-row ${groupActive ? 'active' : ''}" data-bank-group="${escapeAttr(g.name)}">
              <div class="bank-list-name">${state.groupMode === 'entity' ? '🏢' : '🏦'} ${escapeHtml(g.name)}</div>
              <div class="bank-list-sub">${g.count}件 ・ ${currency(g.total)}${accounts.length ? ` ・ ${accounts.length}口座` : ''}</div>
            </div>${accountsHtml}`;
        }).join('')
      : '<p class="empty-hint">まだ明細がありません。</p>';

    bankListEl.querySelectorAll('[data-bank-group]').forEach((rowEl) => {
      rowEl.addEventListener('click', () => {
        state.selectedBankGroup = rowEl.dataset.bankGroup;
        state.selectedAccount = rowEl.dataset.account || null;
        renderBankPanel();
      });
    });

    if (!state.selectedBankGroup) {
      bankSummaryEl.innerHTML = '';
      bankSourcesEl.innerHTML = '';
      bankTableEl.innerHTML = '<p class="empty-hint">左から銀行(必要なら口座)を選んでください。</p>';
      return;
    }

    const rows = filteredBankRecords();
    const income = rows.filter((r) => r.direction === '入金').reduce((s, r) => s + r.amount, 0);
    const expense = rows.filter((r) => r.direction === '出金').reduce((s, r) => s + r.amount, 0);
    const titleLabel = state.selectedAccount || `${state.selectedBankGroup}(全口座合計)`;
    let accountNumber = '';
    let isLoanAccount = false;
    if (state.selectedAccount) {
      const match = getKnownAccounts().find((a) => a.name === state.selectedAccount);
      accountNumber = match?.accountNumber || '';
      isLoanAccount = match?.accountKind === '借入金';
    } else if (state.selectedBankGroup) {
      // 「全口座合計」表示でも、その大分類の中身が実質1口座しかなければ、その口座番号を表示する。
      const matches = getKnownAccounts().filter((a) => primaryGroupKeyOf(a.name) === state.selectedBankGroup);
      if (matches.length === 1) { accountNumber = matches[0].accountNumber; isLoanAccount = matches[0].accountKind === '借入金'; }
    }
    // rowsは日付が新しい順なので、先頭から見て最初に残高が入っている行が「スキャンした中で一番新しい残高」。
    const latestBalanceRow = rows.find((r) => r.balance);
    bankSummaryEl.innerHTML = `
      <div class="summary-grid" style="margin-top:12px">
        <div class="summary-card">
          <div class="summary-card-label">${escapeHtml(titleLabel)}${isLoanAccount ? ' <span class="badge" style="background:#fde2e2;color:var(--color-danger)">💳借入金口座</span>' : ''}</div>
          <div style="display:flex;gap:32px;flex-wrap:wrap;margin:10px 0">
            ${accountNumber ? `<div><div class="summary-card-value small" style="margin-bottom:2px">口座番号</div><div style="font-size:32px;font-weight:700;letter-spacing:0.03em">${escapeHtml(accountNumber)}</div></div>` : ''}
            ${latestBalanceRow ? `<div><div class="summary-card-value small" style="margin-bottom:2px">残高(${latestBalanceRow.date}時点)</div><div style="font-size:32px;font-weight:700${isLoanAccount ? ';color:var(--color-danger)' : ''}">${isLoanAccount ? '－' : ''}${currency(latestBalanceRow.balance)}</div></div>` : ''}
          </div>
          <div class="summary-card-value small">件数 <b>${rows.length}件</b></div>
          <div class="summary-card-value small">入金 <b>${currency(income)}</b></div>
          <div class="summary-card-value small">出金 <b>${currency(expense)}</b></div>
        </div>
      </div>
    `;

    const sources = [...new Set(rows.map((r) => r.sourceFileName))];
    bankSourcesEl.innerHTML = sources.length
      ? `<p class="empty-hint" style="padding-top:8px">取込元: ${sources.map((s) => {
          const isDraft = rows.some((r) => r.sourceFileName === s && r.draft);
          return `<span class="badge badge-status">${escapeHtml(s)}${isDraft ? ' (未保存)' : ''} <a href="#" data-delete-source="${escapeAttr(s)}" title="この取込元の明細を削除" style="margin-left:4px">✕</a></span>`;
        }).join(' ')}</p>`
      : '';
    bankSourcesEl.querySelectorAll('[data-delete-source]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const sourceName = a.dataset.deleteSource;
        if (!confirm(`「${sourceName}」の明細をすべて削除します。よろしいですか？`)) return;
        deleteTsuchoRecordsBySource(sourceName);
        state.files = state.files.filter((x) => x.fileName !== sourceName);
        renderFileList();
        renderBankPanel();
        renderAccountSummary();
        renderFileHistory();
        renderAccountButtons();
      });
    });

    bankTableEl.innerHTML = rows.length
      ? `<table class="data-table">
          <thead><tr><th>発生日</th><th>区分</th><th>勘定科目</th><th>取引先(摘要)</th><th>備考</th><th>税区分</th><th>出金</th><th>入金</th><th>残高</th><th>取込元ファイル</th><th>状態</th></tr></thead>
          <tbody>${rows.map((r) => `
            <tr>
              <td>${r.date}</td>
              <td>${r.direction}</td>
              <td>${escapeHtml(r.accountLabel)}</td>
              <td>${escapeHtml(r.counterparty) || '<span class="empty-hint">(摘要なし)</span>'}</td>
              <td>${escapeHtml(r.memo)}</td>
              <td>${escapeHtml(r.taxCategory)}</td>
              <td>${r.direction === '出金' ? currency(r.amount) : ''}</td>
              <td>${r.direction === '入金' ? currency(r.amount) : ''}</td>
              <td style="color:var(--color-text-muted)">${r.balance ? currency(r.balance) : ''}</td>
              <td style="color:var(--color-text-muted);white-space:nowrap">${escapeHtml(r.sourceFileName)}</td>
              <td>${r.draft ? '<span class="badge badge-status status-unprocessed">未保存</span>' : '<span class="badge badge-status status-matched">保存済み</span>'}</td>
            </tr>`).join('')}</tbody>
        </table>`
      : '<p class="empty-hint">この期間の明細はありません。</p>';
  }

  bankFromInput.addEventListener('change', () => { state.from = bankFromInput.value; renderBankPanel(); });
  bankToInput.addEventListener('change', () => { state.to = bankToInput.value; renderBankPanel(); });

  root.querySelector('#tsucho-export-bank').addEventListener('click', () => {
    if (!state.selectedBankGroup) { alert('先に左から銀行(必要なら口座)を選んでください。'); return; }
    const rows = filteredBankRecords();
    if (!rows.length) { alert('保存する明細がありません。'); return; }
    const period = state.from || state.to ? `_${state.from || '-'}_${state.to || '-'}` : '';
    const label = state.selectedAccount || state.selectedBankGroup;
    downloadXlsx(`${label}${period}.xlsx`, EXPORT_HEADERS, rows.map(rowToExportArray));
  });

  function renderAll() {
    renderAccountButtons();
    renderFileList();
    renderBankPanel();
    renderTopDashboard();
    renderAccountSummary();
    renderFileHistory();
  }

  renderAll();
  return { render: renderAll };
}
