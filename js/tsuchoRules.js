// 通帳仕分け(freee取込用Excel作成)専用の勘定科目・税区分の選択肢と、
// ユーザー指定の固有仕分けルール(最優先ルール5件 + 基本ルール)を実装する自動分類エンジン。

/** 勘定科目の選択肢。ユーザー指定の最優先ルールで使うものを先頭に並べる。税区分は選択時のデフォルト値。 */
export const TSUCHO_CATEGORY_OPTIONS = [
  { label: '口座振替', defaultTax: '対象外' },
  { label: '不動産所得', defaultTax: '非課税(住宅)' },
  { label: '借入金', defaultTax: '対象外' },
  { label: '支払利息', defaultTax: '非課税' },
  { label: '支払手数料', defaultTax: '課対仕入10%' },
  { label: '水道光熱費', defaultTax: '課対仕入10%' },
  { label: '通信費', defaultTax: '課対仕入10%' },
  { label: '事業主借', defaultTax: '対象外' },
  { label: '事業主貸', defaultTax: '対象外' },
  { label: '仕入高', defaultTax: '課対仕入10%' },
  { label: '売上高', defaultTax: '課税売上10%' },
  { label: '雑収入', defaultTax: '対象外' },
  { label: '消耗品費', defaultTax: '課対仕入10%' },
  { label: '旅費交通費', defaultTax: '課対仕入10%' },
  { label: 'ガソリン代', defaultTax: '課対仕入10%' },
  { label: '保険料', defaultTax: '対象外' },
  { label: '人件費', defaultTax: '対象外' },
  { label: '雑費', defaultTax: '課対仕入10%' },
  { label: '未分類', defaultTax: '要確認' },
];

export const TSUCHO_TAX_OPTIONS = [
  '対象外', '非課税', '非課税(住宅)', '課税売上10%', '課税売上8%', '課対仕入10%', '課対仕入8%', '要確認',
];

export function defaultTaxForCategory(accountLabel) {
  return TSUCHO_CATEGORY_OPTIONS.find((c) => c.label === accountLabel)?.defaultTax ?? '要確認';
}

/**
 * 通帳明細1件を分類する。
 * @param {string} description 摘要
 * @param {number} withdrawal 出金額(0なら出金でない)
 * @param {number} deposit 入金額(0なら入金でない)
 * @returns {{accountLabel:string, taxCategory:string, memo:string, ruleId:string, needsReview?:boolean, needsSplit?:boolean}}
 */
export function classifyTsuchoTxn(description, withdrawal, deposit) {
  const d = String(description || '');
  const isDeposit = deposit > 0;
  const isWithdrawal = withdrawal > 0;

  // --- 最優先ルール(ユーザー指定) ---

  // 1. ATM入出金・IB(インターネットバンキング)振替 ⇒ 口座振替・資金移動
  if (/ATM|ＡＴＭ|IB振替|ＩＢ振替|インターネットバンキング|ｲﾝﾀｰﾈｯﾄﾊﾞﾝｷﾝｸﾞ/.test(d)) {
    return { accountLabel: '口座振替', taxCategory: '対象外', memo: '資金移動', ruleId: 'atm_ib' };
  }

  // 2. カ）ケント(株式会社ケント) ⇒ 口座振替・資金移動
  if (/ケント/.test(d)) {
    return { accountLabel: '口座振替', taxCategory: '対象外', memo: '資金移動', ruleId: 'kent' };
  }

  // 3. スルガ勧業(入金) ⇒ 不動産所得
  if (/スルガ勧業/.test(d) && isDeposit) {
    return {
      accountLabel: '不動産所得',
      taxCategory: '非課税(住宅)',
      memo: '要確認: 事業用テナント等の入金なら税区分を「課税売上10%」に変更してください',
      ruleId: 'suruga_kangyo',
      needsReview: true,
    };
  }

  // 4. 日本政策金融公庫(出金) ⇒ ローン返済(元金・利息の内訳は要分割)
  if (/日本政策金融公庫/.test(d) && isWithdrawal) {
    return {
      accountLabel: '借入金',
      taxCategory: '対象外',
      memo: '日本政策金融公庫 ローン返済(元金/利息の内訳を確認し、必要なら🔀で行を分割してください)',
      ruleId: 'jfc_loan',
      needsSplit: true,
    };
  }

  // 5. オリエント・オリコ(出金) ⇒ 自動車ローン返済(元金・利息の内訳は要分割)
  if (/オリエント|オリコ/.test(d) && isWithdrawal) {
    return {
      accountLabel: '借入金',
      taxCategory: '対象外',
      memo: '自動車ローン返済(元金/利息の内訳を確認し、必要なら🔀で行を分割してください)',
      ruleId: 'orient_auto_loan',
      needsSplit: true,
    };
  }

  // --- その他の基本仕分けルール ---

  // クレジットカード引き落とし ⇒ 口座振替(経費二重計上防止)
  if (/クレジットカード|カード引落|カードお支払|ｶｰﾄﾞ.*(引落|支払)/.test(d) && isWithdrawal) {
    return { accountLabel: '口座振替', taxCategory: '対象外', memo: '経費二重計上防止', ruleId: 'credit_card' };
  }

  // 振込手数料
  if (/振込手数料|手数料/.test(d)) {
    return { accountLabel: '支払手数料', taxCategory: '課対仕入10%', memo: '', ruleId: 'fee' };
  }

  // 電気・水道料金
  if (/電気|東京電力|関西電力|中部電力|東北電力|九州電力|でんき|TEPCO|水道|水道局|上下水道/.test(d)) {
    return { accountLabel: '水道光熱費', taxCategory: '課対仕入10%', memo: '', ruleId: 'utilities' };
  }

  // 通信費(電話・プロバイダ等)
  if (/ドコモ|ＮＴＴ|NTT|ソフトバンク|ｿﾌﾄﾊﾞﾝｸ|^au$|auでんき|プロバイダ|通信|電話代|携帯電話/.test(d)) {
    return { accountLabel: '通信費', taxCategory: '課対仕入10%', memo: '', ruleId: 'comm' };
  }

  // 預金利息(個人事業主) ⇒ 事業主借
  if (/利息/.test(d) && isDeposit) {
    return { accountLabel: '事業主借', taxCategory: '対象外', memo: '預金利息', ruleId: 'interest_income' };
  }

  // どのルールにも一致しない場合は未分類(生活費・個人税金の引き出し等は、ここから手動で「事業主貸」に変更してください)
  return { accountLabel: '未分類', taxCategory: '要確認', memo: '', ruleId: 'uncategorized' };
}
