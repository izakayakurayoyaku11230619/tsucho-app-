// 「資産状況レポート」PowerPoint(.pptx)をブラウザ内で生成する。
// index.htmlでCDNから読み込んだ window.PptxGenJS(pptxgenjsのブラウザ版バンドル)を使う。
// ビルド不要の構成を保つため、npm経由ではなくCDN読み込みのグローバルを直接使う。
import { listAccountSummaries, getRealEstateData } from './storage.js';

const NO_BANK_LABEL = '(口座・カード未設定)';
const BANK_SUFFIX_PATTERN = /(銀行|信用金庫|信金|信用組合|農業協同組合|漁業協同組合|ろうきん|労働金庫)/;
function bankNameOf(fullLabel) {
  const s = String(fullLabel || '').trim();
  if (!s) return NO_BANK_LABEL;
  const bySpace = s.split(/[ 　]+/)[0];
  if (bySpace !== s) return bySpace;
  const suffixMatch = s.match(BANK_SUFFIX_PATTERN);
  if (suffixMatch) return s.slice(0, suffixMatch.index + suffixMatch[0].length);
  return s;
}

const yen = (n) => `¥${Math.round(n || 0).toLocaleString('en-US')}`;
const pct = (n, total) => (total ? `${Math.round((n / total) * 1000) / 10}%` : '0%');

function groupSum(list, keyField, valField) {
  const map = {};
  for (const item of list) map[item[keyField]] = (map[item[keyField]] || 0) + item[valField];
  return Object.entries(map)
    .map(([k, v]) => ({ [keyField]: k, total: v }))
    .sort((a, b) => b.total - a.total);
}

// ---- Palette ("Midnight Executive" — navy dominant, ice-blue secondary, gold accent) ----
const NAVY = '1E2761';
const NAVY_DARK = '141B47';
const ICE = 'CADCFC';
const ICE_SOFT = 'EEF3FE';
const WHITE = 'FFFFFF';
const GOLD = 'C9A227';
const TEXT_DARK = '1C1E27';
const TEXT_MUTED = '6B7280';
const C_BALANCE = '2563EB';
const C_LOAN = 'C0392B';
const C_ASSET = '1F8A5F';
const C_TAX = 'B8860B';
const HEAD = 'Cambria';
const BODY = 'Calibri';

export async function generateAssetReportPptx() {
  const PptxGenJSCtor = window.PptxGenJS;
  if (!PptxGenJSCtor) throw new Error('PowerPoint生成ライブラリの読み込みに失敗しました。通信環境をご確認のうえ、ページを再読み込みしてください。');

  const accounts = listAccountSummaries();
  const realEstate = getRealEstateData();

  const normalAccounts = accounts.filter((a) => a.accountKind !== '借入金');
  const loanAccountsRaw = accounts.filter((a) => a.accountKind === '借入金');
  const totalBalance = normalAccounts.reduce((sum, a) => sum + (a.latestBalance || 0), 0);
  const totalLoan = loanAccountsRaw.reduce((sum, a) => sum + (a.latestBalance || 0), 0);

  const balanceAccounts = normalAccounts
    .map((a) => ({ bank: bankNameOf(a.name), name: a.name, balance: a.latestBalance || 0 }))
    .sort((a, b) => b.balance - a.balance);
  const balanceByBank = groupSum(balanceAccounts, 'bank', 'balance');

  const loanAccounts = loanAccountsRaw
    .map((a) => {
      const bank = bankNameOf(a.name);
      const shortName = a.name.startsWith(bank) ? (a.name.slice(bank.length).trim() || a.name) : a.name;
      return {
        lender: bank, name: shortName, balance: a.latestBalance || 0,
        next: a.nextBalanceDate ? `${a.nextBalanceDate} → ${yen(a.nextBalance)}` : '未定',
      };
    })
    .sort((a, b) => b.balance - a.balance);
  const loanByLender = groupSum(loanAccounts, 'lender', 'balance');

  const realEstateOwners = (realEstate?.owners || []).map((o) => ({
    label: o.label, land: o.landAssessed || 0, building: o.buildingAssessed || 0,
    total: (o.landAssessed || 0) + (o.buildingAssessed || 0),
  }));
  const totalRealEstate = realEstateOwners.reduce((sum, o) => sum + o.total, 0);
  const totalLandAssessed = realEstateOwners.reduce((sum, o) => sum + o.land, 0);
  const totalBuildingAssessed = realEstateOwners.reduce((sum, o) => sum + o.building, 0);

  const landAreaMap = {};
  for (const o of realEstate?.owners || []) {
    for (const p of o.properties || []) {
      if (p.category !== '土地') continue;
      const m = String(p.location || '').match(/^(\D+)/);
      const area = m ? m[1] : (p.location || '(不明)');
      if (!landAreaMap[area]) landAreaMap[area] = { area, parcels: 0, value: 0, tax: 0 };
      landAreaMap[area].parcels += 1;
      landAreaMap[area].value += p.value || 0;
      landAreaMap[area].tax += p.propertyTaxAmount || 0;
    }
  }
  const landByArea = Object.values(landAreaMap).sort((a, b) => b.value - a.value);

  const taxOwners = (realEstate?.owners || []).map((o) => ({
    label: o.label, propertyTax: o.propertyTax || 0, cityTax: o.cityPlanningTax || 0, total: o.taxTotal || 0,
  }));
  const totalTax = taxOwners.reduce((sum, o) => sum + o.total, 0);
  const taxSchedule = realEstate?.taxSchedule || [];

  const totalAssets = totalBalance + totalRealEstate;
  const netWorth = totalAssets - totalLoan;
  const today = new Date();
  const asOf = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日時点`;
  const fiscalYear = realEstate?.year || '';

  const pres = new PptxGenJSCtor();
  pres.layout = 'LAYOUT_WIDE';
  const PW = 13.333;
  const PH = 7.5;
  let pageNo = 0;

  function iconCircle(slide, { x, y, d = 0.62, color, emoji }) {
    slide.addShape(pres.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color }, line: { type: 'none' } });
    slide.addText(emoji, {
      x, y, w: d, h: d, isTextBox: true, margin: 0, align: 'center', valign: 'middle', fontFace: BODY, fontSize: d * 26, color: WHITE,
    });
  }
  function sectionHeader(slide, { emoji, color, title, sub }) {
    iconCircle(slide, { x: 0.6, y: 0.55, d: 0.62, color, emoji });
    slide.addText(title, {
      x: 1.4, y: 0.48, w: 9.5, h: 0.5, isTextBox: true, margin: 0, fontFace: HEAD, fontSize: 26, bold: true, color: NAVY, align: 'left', valign: 'middle',
    });
    if (sub) {
      slide.addText(sub, {
        x: 1.4, y: 0.98, w: 9.5, h: 0.32, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 12, color: TEXT_MUTED, align: 'left', valign: 'middle',
      });
    }
  }
  function statCard(slide, { x, y, w, h, label, value, sub, accent = NAVY, bg = ICE_SOFT, valueSize = 30 }) {
    slide.addShape(pres.ShapeType.roundRect, {
      x, y, w, h, rectRadius: 0.08, fill: { color: bg }, line: { type: 'none' },
      shadow: { type: 'outer', color: '1E2761', opacity: 0.12, blur: 8, offset: 2, angle: 90 },
    });
    slide.addText(label, { x: x + 0.28, y: y + 0.2, w: w - 0.56, h: 0.32, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 13, color: TEXT_MUTED, align: 'left' });
    slide.addText(value, {
      x: x + 0.28, y: y + 0.52, w: w - 0.56, h: h - (sub ? 1.0 : 0.75), isTextBox: true, margin: 0, fontFace: HEAD, fontSize: valueSize, bold: true, color: accent, align: 'left', valign: 'top',
    });
    if (sub) slide.addText(sub, { x: x + 0.28, y: y + h - 0.42, w: w - 0.56, h: 0.32, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 11, color: TEXT_MUTED, align: 'left' });
  }
  function footer(slide) {
    pageNo += 1;
    slide.addText('資産状況レポート', {
      x: 0.6, y: PH - 0.42, w: 8, h: 0.3, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 9, color: TEXT_MUTED, align: 'left',
    });
    slide.addText(String(pageNo), {
      x: PW - 1.1, y: PH - 0.42, w: 0.5, h: 0.3, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 9, color: TEXT_MUTED, align: 'right',
    });
  }

  // Slide 1 — Title
  {
    const s = pres.addSlide();
    s.background = { color: NAVY };
    s.addShape(pres.ShapeType.ellipse, { x: 10.4, y: -2.2, w: 6.5, h: 6.5, fill: { color: NAVY_DARK }, line: { type: 'none' } });
    s.addShape(pres.ShapeType.ellipse, { x: -2.4, y: 4.6, w: 5.0, h: 5.0, fill: { color: NAVY_DARK }, line: { type: 'none' } });
    s.addText('資産状況レポート', { x: 0.9, y: 2.55, w: 11.5, h: 1.1, isTextBox: true, margin: 0, fontFace: HEAD, fontSize: 46, bold: true, color: WHITE, align: 'left' });
    s.addText([fiscalYear, asOf].filter(Boolean).join('  ／  '), { x: 0.95, y: 3.62, w: 10, h: 0.5, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 17, color: ICE, align: 'left' });
    s.addText('💰 口座　　💳 ローン　　🏠 資産　　🧾 固定資産税', { x: 0.95, y: 6.85, w: 8, h: 0.35, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 12, color: ICE });
  }

  // Slide 2 — 純資産サマリー
  {
    const s = pres.addSlide();
    s.background = { color: WHITE };
    sectionHeader(s, { emoji: '💎', color: GOLD, title: '純資産サマリー', sub: `${asOf}の全体像` });
    statCard(s, { x: 0.6, y: 1.55, w: 3.85, h: 1.85, label: '総資産　(口座残高＋不動産)', value: yen(totalAssets), accent: NAVY, valueSize: 26 });
    statCard(s, { x: 4.65, y: 1.55, w: 3.85, h: 1.85, label: '総負債　(ローン残高)', value: `－${yen(totalLoan)}`, accent: C_LOAN, valueSize: 26 });
    statCard(s, { x: 8.7, y: 1.55, w: 4.03, h: 1.85, label: '純資産', value: yen(netWorth), accent: GOLD, bg: 'FBF3DD', valueSize: 28 });

    s.addText('総資産 と 総負債 の比較', { x: 0.6, y: 3.65, w: 6, h: 0.35, isTextBox: true, margin: 0, fontFace: HEAD, fontSize: 15, bold: true, color: NAVY });
    s.addChart(pres.ChartType.bar, [{ name: '金額', labels: ['総資産', '総負債'], values: [totalAssets, totalLoan] }], {
      x: 0.6, y: 4.05, w: 6.1, h: 3.05, barDir: 'bar', barGapWidthPct: 45, chartColors: [NAVY],
      valAxisHidden: true, catAxisLabelColor: TEXT_DARK, catAxisLabelFontSize: 13, catAxisLabelFontFace: BODY,
      catGridLine: { style: 'none' }, valGridLine: { style: 'none' }, showLegend: false,
      showValue: true, dataLabelPosition: 'outEnd', dataLabelFontSize: 12, dataLabelColor: TEXT_DARK, dataLabelFontFace: BODY,
      dataLabelFormatCode: '¥#,##0', showTitle: false, chartArea: { fill: { color: WHITE } },
    });

    s.addShape(pres.ShapeType.roundRect, { x: 7.0, y: 3.65, w: 5.73, h: 3.45, rectRadius: 0.08, fill: { color: ICE_SOFT }, line: { type: 'none' } });
    s.addText('資産の内訳', { x: 7.3, y: 3.85, w: 5, h: 0.35, isTextBox: true, margin: 0, fontFace: HEAD, fontSize: 15, bold: true, color: NAVY });
    let cy = 4.35;
    for (const [label, val] of [['💰 口座残高', totalBalance], ['🏠 資産(土地・家屋)', totalRealEstate]]) {
      s.addText(label, { x: 7.3, y: cy, w: 2.6, h: 0.4, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 13, color: TEXT_DARK, valign: 'middle' });
      s.addText(yen(val), { x: 9.7, y: cy, w: 1.9, h: 0.4, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 13, bold: true, color: NAVY, align: 'right', valign: 'middle' });
      s.addText(pct(val, totalAssets), { x: 11.55, y: cy, w: 1.0, h: 0.4, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 11, color: TEXT_MUTED, align: 'right', valign: 'middle' });
      cy += 0.52;
    }
    s.addText('負債の内訳', { x: 7.3, y: cy + 0.15, w: 5, h: 0.35, isTextBox: true, margin: 0, fontFace: HEAD, fontSize: 15, bold: true, color: NAVY });
    cy += 0.62;
    for (const b of loanByLender.slice(0, 4)) {
      s.addText(`🏦 ${b.lender}`, { x: 7.3, y: cy, w: 3.0, h: 0.36, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 12.5, color: TEXT_DARK, valign: 'middle' });
      s.addText(`－${yen(b.total)}`, { x: 10.3, y: cy, w: 2.25, h: 0.36, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 12.5, bold: true, color: C_LOAN, align: 'right', valign: 'middle' });
      cy += 0.44;
    }
    footer(s);
  }

  // Slide 3 — 口座残高
  if (normalAccounts.length) {
    const s = pres.addSlide();
    s.background = { color: WHITE };
    sectionHeader(s, { emoji: '💰', color: C_BALANCE, title: '口座残高', sub: `合計 ${yen(totalBalance)}（借入金口座を除く・${normalAccounts.length}口座）` });
    s.addChart(pres.ChartType.doughnut, [{ name: '銀行別残高', labels: balanceByBank.map((b) => b.bank), values: balanceByBank.map((b) => b.total) }], {
      x: 0.5, y: 1.55, w: 5.6, h: 4.4, chartColors: [C_BALANCE, '6EA8FE', 'B7D0FF', '9DBEEF', '4B8CF0'],
      showLegend: true, legendPos: 'b', legendFontSize: 11, legendFontFace: BODY, legendColor: TEXT_DARK,
      showTitle: false, showValue: false, showPercent: true, dataLabelColor: WHITE, dataLabelFontSize: 12, dataLabelFontFace: BODY, dataLabelPosition: 'ctr',
      holeSize: 55, chartArea: { fill: { color: WHITE } },
    });
    const rows = [[
      { text: '決済口座', options: { bold: true, color: WHITE, fill: { color: NAVY }, fontFace: BODY, fontSize: 12 } },
      { text: '銀行', options: { bold: true, color: WHITE, fill: { color: NAVY }, fontFace: BODY, fontSize: 12 } },
      { text: '残高', options: { bold: true, color: WHITE, fill: { color: NAVY }, fontFace: BODY, fontSize: 12, align: 'right' } },
    ]];
    balanceAccounts.forEach((a, i) => {
      const bg = i % 2 === 0 ? WHITE : ICE_SOFT;
      rows.push([
        { text: a.name.startsWith(a.bank) ? (a.name.slice(a.bank.length).trim() || a.name) : a.name, options: { color: TEXT_DARK, fill: { color: bg }, fontFace: BODY, fontSize: 11.5 } },
        { text: a.bank, options: { color: TEXT_MUTED, fill: { color: bg }, fontFace: BODY, fontSize: 11.5 } },
        { text: yen(a.balance), options: { color: TEXT_DARK, fill: { color: bg }, fontFace: BODY, fontSize: 11.5, align: 'right', bold: true } },
      ]);
    });
    s.addTable(rows, { x: 6.5, y: 1.55, w: 6.23, h: 4.4, colW: [3.1, 1.9, 1.23], border: { type: 'solid', color: 'E2E4E9', pt: 0.5 }, autoPage: false, valign: 'middle', margin: [3, 6, 3, 6] });
    footer(s);
  }

  // Slide 4 — ローン残高
  if (loanAccounts.length) {
    const s = pres.addSlide();
    s.background = { color: WHITE };
    sectionHeader(s, { emoji: '💳', color: C_LOAN, title: 'ローン残高（借入金）', sub: `合計 －${yen(totalLoan)}（${loanAccounts.length}口座）` });
    s.addChart(pres.ChartType.bar, [{ name: '残高', labels: loanAccounts.map((l) => l.name), values: loanAccounts.map((l) => l.balance) }], {
      x: 0.5, y: 1.55, w: 7.1, h: 4.55, barDir: 'bar', barGapWidthPct: 35, chartColors: [C_LOAN],
      valAxisHidden: true, catAxisLabelColor: TEXT_DARK, catAxisLabelFontSize: 10.5, catAxisLabelFontFace: BODY,
      catGridLine: { style: 'none' }, valGridLine: { style: 'none' }, showLegend: false, showTitle: false,
      showValue: true, dataLabelPosition: 'outEnd', dataLabelFontSize: 10.5, dataLabelColor: TEXT_DARK, dataLabelFontFace: BODY,
      dataLabelFormatCode: '¥#,##0', chartArea: { fill: { color: WHITE } },
    });
    s.addShape(pres.ShapeType.roundRect, { x: 7.9, y: 1.55, w: 4.83, h: 4.55, rectRadius: 0.08, fill: { color: ICE_SOFT }, line: { type: 'none' } });
    s.addText('次回返済予定（上位3件）', { x: 8.2, y: 1.75, w: 4.3, h: 0.35, isTextBox: true, margin: 0, fontFace: HEAD, fontSize: 14, bold: true, color: NAVY });
    let ly = 2.25;
    for (const l of loanAccounts.slice(0, 3)) {
      s.addText(`${l.lender} ${l.name}`, { x: 8.2, y: ly, w: 4.3, h: 0.3, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 11.5, bold: true, color: TEXT_DARK });
      s.addText(`次回 ${l.next}`, { x: 8.2, y: ly + 0.3, w: 4.3, h: 0.3, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 11, color: C_LOAN });
      ly += 0.78;
    }
    s.addText('貸主別 合計', { x: 8.2, y: ly + 0.1, w: 4.3, h: 0.32, isTextBox: true, margin: 0, fontFace: HEAD, fontSize: 14, bold: true, color: NAVY });
    ly += 0.55;
    for (const b of loanByLender) {
      s.addText(b.lender, { x: 8.2, y: ly, w: 2.7, h: 0.32, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 11.5, color: TEXT_DARK, valign: 'middle' });
      s.addText(`－${yen(b.total)}`, { x: 10.7, y: ly, w: 1.9, h: 0.32, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 11.5, bold: true, color: C_LOAN, align: 'right', valign: 'middle' });
      ly += 0.4;
    }
    footer(s);
  }

  // Slide 5 — 資産(土地・家屋)
  if (realEstateOwners.length) {
    const s = pres.addSlide();
    s.background = { color: WHITE };
    sectionHeader(s, { emoji: '🏠', color: C_ASSET, title: '資産（土地・家屋）', sub: `${fiscalYear} 課税標準額ベース合計 ${yen(totalRealEstate)}` });
    realEstateOwners.forEach((o, i) => {
      const x = 0.6 + i * 6.13;
      statCard(s, { x, y: 1.55, w: 5.9, h: 1.7, label: o.label, value: yen(o.total), accent: C_ASSET, valueSize: 25 });
      s.addText(`土地 ${yen(o.land)}　＋　家屋 ${yen(o.building)}`, { x: x + 0.28, y: 2.75, w: 5.4, h: 0.3, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 11, color: TEXT_MUTED });
    });
    s.addText('土地・家屋 構成比（課税標準額ベース）', { x: 0.6, y: 3.55, w: 6, h: 0.35, isTextBox: true, margin: 0, fontFace: HEAD, fontSize: 15, bold: true, color: NAVY });
    s.addChart(pres.ChartType.doughnut, [{ name: '構成', labels: ['土地', '家屋'], values: [totalLandAssessed, totalBuildingAssessed] }], {
      x: 0.6, y: 3.9, w: 5.6, h: 3.2, chartColors: [C_ASSET, '8FCBAE'],
      showLegend: true, legendPos: 'b', legendFontSize: 11, legendFontFace: BODY, legendColor: TEXT_DARK,
      showTitle: false, showPercent: true, dataLabelColor: WHITE, dataLabelFontSize: 12, dataLabelFontFace: BODY, dataLabelPosition: 'ctr',
      holeSize: 55, chartArea: { fill: { color: WHITE } },
    });
    s.addShape(pres.ShapeType.roundRect, { x: 6.9, y: 3.55, w: 5.83, h: 3.55, rectRadius: 0.08, fill: { color: ICE_SOFT }, line: { type: 'none' } });
    s.addText('所有物件の概要', { x: 7.2, y: 3.75, w: 5.3, h: 0.35, isTextBox: true, margin: 0, fontFace: HEAD, fontSize: 14, bold: true, color: NAVY });
    const summaryLines = realEstateOwners.map((o) => {
      const owner = (realEstate.owners || []).find((x) => x.label === o.label);
      const land = (owner?.properties || []).filter((p) => p.category === '土地').length;
      const bld = (owner?.properties || []).filter((p) => p.category === '家屋').length;
      return `${o.label.split('：')[0]}：土地 ${land}筆・家屋 ${bld}棟（計${land + bld}件）`;
    });
    summaryLines.push(`所在エリア：${landByArea.map((a) => a.area).join('・')}`);
    s.addText(summaryLines.map((t, i) => ({ text: t, options: { breakLine: i < summaryLines.length - 1, bullet: true, color: TEXT_DARK } })), {
      x: 7.2, y: 4.25, w: 5.3, h: 2.7, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 12.5, valign: 'top', paraSpaceAfter: 10, lineSpacingMultiple: 1.25,
    });
    footer(s);
  }

  // Slide 6 — 土地の地区別内訳
  if (landByArea.length) {
    const s = pres.addSlide();
    s.background = { color: WHITE };
    sectionHeader(s, { emoji: '🌍', color: C_ASSET, title: '土地の地区別内訳', sub: '評価額の大きい順（固定資産税相当額あわせて表示）' });
    s.addChart(pres.ChartType.bar, [{ name: '評価額', labels: landByArea.map((a) => a.area), values: landByArea.map((a) => a.value) }], {
      x: 0.5, y: 1.55, w: 6.6, h: 4.55, barDir: 'bar', barGapWidthPct: 35, chartColors: [C_ASSET],
      valAxisHidden: true, catAxisLabelColor: TEXT_DARK, catAxisLabelFontSize: 11, catAxisLabelFontFace: BODY,
      catGridLine: { style: 'none' }, valGridLine: { style: 'none' }, showLegend: false, showTitle: false,
      showValue: true, dataLabelPosition: 'outEnd', dataLabelFontSize: 10.5, dataLabelColor: TEXT_DARK, dataLabelFontFace: BODY,
      dataLabelFormatCode: '¥#,##0', chartArea: { fill: { color: WHITE } },
    });
    const rows2 = [[
      { text: '地区', options: { bold: true, color: WHITE, fill: { color: NAVY }, fontFace: BODY, fontSize: 11.5 } },
      { text: '筆数', options: { bold: true, color: WHITE, fill: { color: NAVY }, fontFace: BODY, fontSize: 11.5, align: 'right' } },
      { text: '評価額', options: { bold: true, color: WHITE, fill: { color: NAVY }, fontFace: BODY, fontSize: 11.5, align: 'right' } },
      { text: '固定資産税相当額', options: { bold: true, color: WHITE, fill: { color: NAVY }, fontFace: BODY, fontSize: 11.5, align: 'right' } },
    ]];
    landByArea.forEach((a, i) => {
      const bg = i % 2 === 0 ? WHITE : ICE_SOFT;
      rows2.push([
        { text: a.area, options: { color: TEXT_DARK, fill: { color: bg }, fontFace: BODY, fontSize: 11 } },
        { text: `${a.parcels}筆`, options: { color: TEXT_MUTED, fill: { color: bg }, fontFace: BODY, fontSize: 11, align: 'right' } },
        { text: yen(a.value), options: { color: TEXT_DARK, fill: { color: bg }, fontFace: BODY, fontSize: 11, align: 'right', bold: true } },
        { text: yen(a.tax), options: { color: C_TAX, fill: { color: bg }, fontFace: BODY, fontSize: 11, align: 'right' } },
      ]);
    });
    s.addTable(rows2, { x: 7.35, y: 1.55, w: 5.38, h: 4.55, colW: [1.65, 0.75, 1.55, 1.43], border: { type: 'solid', color: 'E2E4E9', pt: 0.5 }, autoPage: false, valign: 'middle', margin: [3, 5, 3, 5] });
    footer(s);
  }

  // Slide 7 — 固定資産税・都市計画税
  if (taxOwners.length) {
    const s = pres.addSlide();
    s.background = { color: WHITE };
    sectionHeader(s, { emoji: '🧾', color: C_TAX, title: '固定資産税・都市計画税', sub: `${fiscalYear} 年税額合計 ${yen(totalTax)}` });
    taxOwners.forEach((o, i) => {
      const x = 0.6 + i * 6.13;
      statCard(s, { x, y: 1.55, w: 5.9, h: 1.55, label: o.label, value: yen(o.total), accent: C_TAX, valueSize: 24 });
      s.addText(`固定資産税 ${yen(o.propertyTax)}　＋　都市計画税 ${yen(o.cityTax)}`, { x: x + 0.28, y: 2.6, w: 5.4, h: 0.3, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 11, color: TEXT_MUTED });
    });
    if (taxSchedule.length) {
      s.addText('期別納付予定（口座振替）', { x: 0.6, y: 3.45, w: 6, h: 0.35, isTextBox: true, margin: 0, fontFace: HEAD, fontSize: 15, bold: true, color: NAVY });
      const stepW = PW / taxSchedule.length - 0.25 / taxSchedule.length;
      const stepFull = (PW - 0.6) / taxSchedule.length;
      const stepY = 4.0;
      taxSchedule.forEach((t, i) => {
        const x = 0.6 + i * stepFull;
        s.addShape(pres.ShapeType.roundRect, { x, y: stepY, w: stepFull - 0.25, h: 2.15, rectRadius: 0.08, fill: { color: i === 0 ? 'FBF3DD' : ICE_SOFT }, line: { type: 'none' } });
        iconCircle(s, { x: x + 0.22, y: stepY + 0.22, d: 0.46, color: i === 0 ? GOLD : C_TAX, emoji: '📅' });
        s.addText(t.period, { x: x + 0.8, y: stepY + 0.22, w: stepFull - 1.0, h: 0.46, isTextBox: true, margin: 0, valign: 'middle', fontFace: HEAD, fontSize: 15, bold: true, color: NAVY });
        s.addText(t.dueDate, { x: x + 0.22, y: stepY + 0.82, w: stepFull - 0.6, h: 0.3, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 11.5, color: TEXT_MUTED });
        s.addText([
          { text: `個人 ${yen(t.personal)}`, options: { breakLine: true } },
          { text: `法人 ${yen(t.corporate)}`, options: {} },
        ], { x: x + 0.22, y: stepY + 1.18, w: stepFull - 0.6, h: 0.85, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 12, color: TEXT_DARK, paraSpaceAfter: 4 });
      });
    }
    footer(s);
  }

  // Closing
  {
    const s = pres.addSlide();
    s.background = { color: NAVY };
    s.addShape(pres.ShapeType.ellipse, { x: -2.6, y: -2.4, w: 6.2, h: 6.2, fill: { color: NAVY_DARK }, line: { type: 'none' } });
    s.addShape(pres.ShapeType.ellipse, { x: 10.8, y: 4.2, w: 5.4, h: 5.4, fill: { color: NAVY_DARK }, line: { type: 'none' } });
    iconCircle(s, { x: 5.9, y: 2.35, d: 0.85, color: GOLD, emoji: '💎' });
    s.addText('ご確認ありがとうございました', { x: 1.2, y: 3.45, w: 11, h: 0.7, isTextBox: true, margin: 0, fontFace: HEAD, fontSize: 28, bold: true, color: WHITE, align: 'center' });
    s.addText(`純資産　${yen(netWorth)}　（${asOf}）`, { x: 1.2, y: 4.2, w: 11, h: 0.5, isTextBox: true, margin: 0, fontFace: BODY, fontSize: 16, color: ICE, align: 'center' });
  }

  const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  await pres.writeFile({ fileName: `資産状況レポート_${dateStr}.pptx` });
}
