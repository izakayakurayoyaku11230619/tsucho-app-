// 銀行が出す「明細データ」xlsx(列: 日付/摘要/出金額/入金額/残高)を読み込むための、
// 外部ライブラリ不使用のミニマムxlsxパーサー。xlsxはZIPコンテナなので、
// ブラウザ標準のDecompressionStream(deflate-raw)で展開し、DOMParserでシートXMLを読む。

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** ZIP中央ディレクトリを読み、指定したファイル名のテキストを取り出す */
async function readZipEntries(arrayBuffer, wantedNames) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  let eocdOffset = -1;
  const searchStart = Math.max(0, bytes.length - 22 - 65536);
  for (let i = bytes.length - 22; i >= searchStart; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('xlsxファイルの形式が正しくありません(ZIP終端が見つかりません)');

  const cdCount = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const results = {};
  let offset = cdOffset;
  const decoder = new TextDecoder('utf-8');

  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const compMethod = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const fnLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const fileName = decoder.decode(bytes.subarray(offset + 46, offset + 46 + fnLen));

    if (wantedNames.includes(fileName)) {
      if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
        throw new Error('xlsxファイルの形式が正しくありません(ローカルヘッダー不正)');
      }
      const lhFnLen = view.getUint16(localHeaderOffset + 26, true);
      const lhExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + lhFnLen + lhExtraLen;
      const compData = bytes.subarray(dataStart, dataStart + compSize);
      const raw = compMethod === 0 ? compData : await inflateRaw(compData);
      results[fileName] = decoder.decode(raw);
    }
    offset += 46 + fnLen + extraLen + commentLen;
  }
  return results;
}

function colLetterOf(cellRef) {
  return cellRef.match(/^[A-Z]+/)[0];
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return Array.from(doc.getElementsByTagNameNS(NS, 'si')).map((si) => {
    const texts = Array.from(si.getElementsByTagNameNS(NS, 't'));
    return texts.map((t) => t.textContent).join('');
  });
}

/** シートXMLを [{colLetter: value, ...}, ...] の行配列に変換する */
function parseSheetRows(xml, sharedStrings) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const rows = Array.from(doc.getElementsByTagNameNS(NS, 'row'));
  return rows.map((row) => {
    const cellsByCol = {};
    for (const c of Array.from(row.getElementsByTagNameNS(NS, 'c'))) {
      const ref = c.getAttribute('r');
      if (!ref) continue;
      const col = colLetterOf(ref);
      const type = c.getAttribute('t');
      let value = '';
      if (type === 's') {
        const vEl = c.getElementsByTagNameNS(NS, 'v')[0];
        const idx = Number(vEl?.textContent);
        value = sharedStrings[idx] ?? '';
      } else if (type === 'inlineStr') {
        const tEl = c.getElementsByTagNameNS(NS, 't')[0];
        value = tEl?.textContent ?? '';
      } else {
        const vEl = c.getElementsByTagNameNS(NS, 'v')[0];
        value = vEl?.textContent ?? '';
      }
      cellsByCol[col] = value;
    }
    return cellsByCol;
  });
}

/**
 * 令和などの和暦2桁年("07-10-01"のような形式)を西暦に変換する。
 * このアプリで対応する通帳・明細は令和(2019年〜)のみを想定しているため、
 * 和暦年+2018を西暦年とする(令和1年=2019年)。
 */
function reiwaToSeireki(era2digit) {
  const year = Number(era2digit) + 2018;
  return year >= 2019 && year <= 2099 ? year : null;
}

function toIsoDate(raw) {
  const s = String(raw).trim();
  const full = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (full) {
    const [, y, mo, d] = full;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // 銀行のオンラインバンキングからの明細ダウンロードでよくある和暦表記。
  // 例: "07-10-01"(静岡中央銀行、ゼロ埋め2桁) / "7- 6-13"・"D 7- 6-13"(富士宮信用金庫、
  // 1桁の年+空白埋め、先頭に取引種別の1文字+空白が付くことがある)。
  // "**-**-**"(繰越行など)はここでマッチせず、素通りしてnullを返す。
  const era = s.match(/^(?:[A-Za-z]\s+)?(\d{1,2})-\s*(\d{1,2})-\s*(\d{1,2})$/);
  if (era) {
    const [, ey, mo, d] = era;
    const seireki = reiwaToSeireki(ey);
    if (seireki) return `${seireki}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return '';
}

/** ヘッダーの表記ゆれ吸収用: 半角・全角の空白をすべて取り除く。「摘　要」のような全角スペース入りの見出しに対応。 */
function normalizeHeaderText(s) {
  return String(s ?? '').replace(/[\s　]/g, '');
}

// このアプリが受け付ける列名と、実際にxlsxで使われがちな表記ゆれの対応表(比較前にnormalizeHeaderTextで
// 空白を除去するので、「摘要」と書けば「摘　要」のような全角スペース入り表記にもマッチする)。
// 静岡中央銀行・富士宮信用金庫など、ネットバンキングの明細ダウンロードは「年月日/お支払金額/お預り金額/差引残高」
// のような独自の列名を使うことが多いため、そうした表記もまとめて認識できるようにする。
const HEADER_ALIASES = {
  date: ['日付', '年月日', '取引日'],
  description: ['摘要', '取引内容', 'お取引内容'],
  withdrawal: ['出金額', '支払い金額', 'お支払い金額', 'お支払金額'],
  deposit: ['入金額', '預り金額', 'お預り金額', 'お預かり金額'],
  balance: ['残高', '差引残高', '差引き残高', '差引残高（円）'],
};
const NORMALIZED_HEADER_ALIASES = Object.fromEntries(
  Object.entries(HEADER_ALIASES).map(([role, aliases]) => [role, aliases.map(normalizeHeaderText)]),
);

/**
 * シート内を数行スキャンして、出金額・入金額に相当する列を含むヘッダー行を探す。
 * 静岡中央銀行・富士宮信用金庫の明細ダウンロードのように、先頭数行が銀行名・口座情報などの
 * メタ情報で、本当のヘッダーがもっと下の行にあるケースに対応するため。
 * @returns {{rowIndex:number, colToRole:Object}|null}
 */
function findHeaderRow(rows) {
  const maxScan = Math.min(rows.length, 15);
  for (let i = 0; i < maxScan; i++) {
    const row = rows[i];
    const colToRole = {};
    for (const [col, value] of Object.entries(row)) {
      const header = normalizeHeaderText(value);
      for (const [role, aliases] of Object.entries(NORMALIZED_HEADER_ALIASES)) {
        if (aliases.includes(header)) colToRole[col] = role;
      }
    }
    const roles = new Set(Object.values(colToRole));
    if (roles.has('withdrawal') && roles.has('deposit')) {
      return { rowIndex: i, colToRole };
    }
  }
  return null;
}

/**
 * 銀行通帳形式のxlsx(列: 日付/摘要/出金額/入金額/残高。表記ゆれ含む)かどうかを判定する。
 * @returns {Promise<boolean>}
 */
export async function isBankStatementXlsx(arrayBuffer) {
  const files = await readZipEntries(arrayBuffer, ['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml']);
  const sheetXml = files['xl/worksheets/sheet1.xml'];
  if (!sheetXml) return false;
  const sharedStrings = parseSharedStrings(files['xl/sharedStrings.xml']);
  const rows = parseSheetRows(sheetXml, sharedStrings);
  return findHeaderRow(rows) !== null;
}

/**
 * 銀行通帳のxlsx(列: 日付/摘要/出金額/入金額/残高。表記ゆれ含む)を解析する。
 * @returns {Promise<Array<{date:string, description:string, withdrawal:number, deposit:number, balance:number}>>}
 */
export async function parseBankStatementXlsx(arrayBuffer) {
  const files = await readZipEntries(arrayBuffer, ['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml']);
  const sheetXml = files['xl/worksheets/sheet1.xml'];
  if (!sheetXml) throw new Error('xlsx内にシートが見つかりませんでした');

  const sharedStrings = parseSharedStrings(files['xl/sharedStrings.xml']);
  const rows = parseSheetRows(sheetXml, sharedStrings);
  if (rows.length < 2) return [];

  const header = findHeaderRow(rows);
  if (!header) return [];
  const { rowIndex, colToRole } = header;

  const results = [];
  for (const row of rows.slice(rowIndex + 1)) {
    const byRole = {};
    for (const [col, value] of Object.entries(row)) {
      const role = colToRole[col];
      if (role) byRole[role] = value;
    }
    const date = toIsoDate(byRole.date || '');
    const description = String(byRole.description || '').trim();
    const withdrawal = Number(String(byRole.withdrawal ?? '0').replace(/,/g, '')) || 0;
    const deposit = Number(String(byRole.deposit ?? '0').replace(/,/g, '')) || 0;
    const balance = Number(String(byRole.balance ?? '0').replace(/,/g, '')) || 0;
    if (!withdrawal && !deposit) continue; // 繰越行・合計行などを除外
    results.push({ date, description, withdrawal, deposit, balance });
  }
  return results;
}
