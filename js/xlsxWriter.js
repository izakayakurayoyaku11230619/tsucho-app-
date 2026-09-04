// 外部ライブラリ不使用のミニマムxlsxライター(xlsxReader.jsの読み取り側と対になる書き込み側)。
// xlsxはZIPコンテナなので、圧縮せず格納(STOREDメソッド)でZIPを自前組み立てする。
// STOREDでもExcel/freeeは問題なく開ける(ZIP仕様上、圧縮方法0=無圧縮は正式にサポートされている)。

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {Array<{name:string, content:string}>} files */
function buildZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = encoder.encode(file.content);
    const crc = crc32(dataBytes);
    const localHeaderOffset = offset;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true); // 圧縮方法: 0=格納(無圧縮)
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x21, true); // MS-DOS日付: 1980-01-01固定(xlsxの妥当性には無関係)
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, dataBytes);
    offset += local.length + dataBytes.length;

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, localHeaderOffset, true);
    central.set(nameBytes, 46);
    centralChunks.push(central);
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of centralChunks) {
    chunks.push(c);
    centralSize += c.length;
    offset += c.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);
  chunks.push(eocd);

  return new Blob(chunks, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function escapeXml(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function colName(idx0) {
  let idx = idx0 + 1;
  let s = '';
  while (idx > 0) {
    const rem = (idx - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    idx = Math.floor((idx - 1) / 26);
  }
  return s;
}

function cellXml(colIdx, rowIdx, value) {
  const ref = `${colName(colIdx)}${rowIdx}`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function buildSheetXml(headers, rows) {
  const allRows = [headers, ...rows];
  const rowsXml = allRows
    .map((row, ri) => `<row r="${ri + 1}">${row.map((v, ci) => cellXml(ci, ri + 1, v)).join('')}</row>`)
    .join('');
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const lastCol = colName(colCount - 1);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS}"><dimension ref="A1:${lastCol}${allRows.length}"/><sheetData>${rowsXml}</sheetData></worksheet>`;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`;

/**
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 * @returns {Blob}
 */
export function createXlsxBlob(headers, rows) {
  const sheetXml = buildSheetXml(headers, rows);
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES_XML },
    { name: '_rels/.rels', content: RELS_XML },
    { name: 'xl/workbook.xml', content: WORKBOOK_XML },
    { name: 'xl/_rels/workbook.xml.rels', content: WORKBOOK_RELS_XML },
    { name: 'xl/styles.xml', content: STYLES_XML },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
  ]);
}

/**
 * @param {string} filename
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 */
export function downloadXlsx(filename, headers, rows) {
  const blob = createXlsxBlob(headers, rows);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
