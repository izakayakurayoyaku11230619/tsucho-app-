import { getApiKey } from './settings.js';

// 通帳PDF・画像のAI Vision解析。Google Gemini API(無料枠あり)を使用する。
// このアプリはNode.js/ビルド環境を持たないバニラJSのため、公式SDKではなく
// ブラウザから直接Generative Language APIをfetchしている。
// これはAPIキーがブラウザのネットワークタブに露出することを意味する。
// 個人がローカルPCで自分専用に使うツールという前提でのみ許容できる方式であり、
// 本番・複数ユーザー向けデプロイでは絶対に使わないこと(その場合は必ずサーバー経由でキーを秘匿する)。
//
// 無料枠には「1分あたりのリクエスト数」等の制限がある。制限に達した場合は
// analyzeBankStatementDocumentが分かりやすいエラーメッセージ付きで例外を投げるので、
// 呼び出し側(tsucho.js)でそのままファイルカードのエラー表示に使う。
const MODEL = 'gemini-3.6-flash';
const API_URL = (apiKey) => `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

const TXN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    date: { type: 'STRING', description: '取引日(YYYY-MM-DD形式。和暦表記なら西暦に変換)' },
    description: { type: 'STRING', description: '摘要・取引内容(通帳に印字された文字列をできるだけそのまま)' },
    withdrawal: { type: 'NUMBER', description: '出金額(円)。出金でなければ0' },
    deposit: { type: 'NUMBER', description: '入金額(円)。入金でなければ0' },
    balance: { type: 'NUMBER', description: '差引残高(円)。記載がなければ0' },
  },
  required: ['date', 'description', 'withdrawal', 'deposit', 'balance'],
};

const RESULT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    bankName: { type: 'STRING', description: '通帳・明細に印字されている金融機関名・支店名・口座種別(例: 三井住友銀行 渋谷支店 普通)。不明なら空文字' },
    accountHolder: { type: 'STRING', description: '通帳の表紙に印字されている口座名義(個人名または会社名)。表紙が含まれていない・不明なら空文字' },
    accountNumber: { type: 'STRING', description: '通帳の表紙に印字されている口座番号・記号番号(ハイフン等の記号込みでそのまま)。表紙が含まれていない・不明なら空文字' },
    transactions: { type: 'ARRAY', items: TXN_SCHEMA },
  },
  required: ['bankName', 'accountHolder', 'accountNumber', 'transactions'],
};

const PROMPT = `この画像またはPDFは銀行通帳・銀行取引明細のスキャンです。PDFは複数ページあることがあり、通帳の表紙(金融機関名・支店名・口座種別・口座番号・名義が印字されたページ)が先頭に含まれていることがあります。

記載されている取引を1件ずつ、取引日・摘要(印字されている文字列をできるだけそのまま)・出金額・入金額・差引残高を抽出し、transactions配列に入れてください。出金額と入金額はどちらか一方が0になります。金額はカンマなしの数値にしてください。日付はYYYY-MM-DD形式にしてください(和暦の場合は西暦に変換してください)。繰越行・合計行など、個別の取引そのものでない行は無視してください。

表紙が含まれている場合は、そこに印字されている金融機関名・支店名・口座種別をbankNameに(例: 三井住友銀行 渋谷支店 普通)、口座名義をaccountHolderに、口座番号・記号番号をaccountNumberに、それぞれできるだけそのまま入れてください。表紙が含まれていない・読み取れない項目は空文字にしてください(推測で埋めないでください)。`;

function dataUrlToBase64(dataUrl) {
  const idx = dataUrl.indexOf(',');
  return { mediaType: dataUrl.slice(5, dataUrl.indexOf(';')), data: dataUrl.slice(idx + 1) };
}

/**
 * @param {string} fileDataUrl data:image/...;base64,... または data:application/pdf;base64,... 形式
 * @returns {Promise<{bankName:string, accountHolder:string, accountNumber:string, transactions:Array<{date:string, description:string, withdrawal:number, deposit:number, balance:number}>}|null>}
 * @throws {Error} APIエラー・レート制限・応答形式不正など、ユーザーに表示すべき理由がある場合
 */
export async function analyzeBankStatementDocument(fileDataUrl) {
  const apiKey = getApiKey();
  const isImage = fileDataUrl?.startsWith('data:image');
  const isPdf = fileDataUrl?.startsWith('data:application/pdf');
  if (!apiKey || !fileDataUrl || (!isImage && !isPdf)) return null;

  const { mediaType, data } = dataUrlToBase64(fileDataUrl);
  const fileBlock = { inline_data: { mime_type: isPdf ? 'application/pdf' : mediaType, data } };

  const body = {
    contents: [{
      parts: [
        fileBlock,
        { text: PROMPT },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESULT_SCHEMA,
    },
  };

  let res;
  try {
    res = await fetch(API_URL(apiKey), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error('tsucho-app: 通帳解析リクエストに失敗しました', e);
    throw new Error('通帳解析のリクエストに失敗しました(ネットワークエラー)。');
  }

  if (!res.ok) {
    const errJson = await res.json().catch(() => null);
    const errText = errJson?.error?.message || `HTTP ${res.status}`;
    console.error(`tsucho-app: 通帳解析APIエラー (${res.status})`, errText);
    if (res.status === 429) {
      throw new Error('Gemini無料枠のリクエスト制限に達しました。少し時間をおいてから「取り込む(再試行)」を押してください。');
    }
    if (res.status === 400 || res.status === 403) {
      throw new Error(`APIキーが正しくないか、権限がありません(${errText})。APIキー設定をご確認ください。`);
    }
    throw new Error(`通帳解析APIエラー: ${errText}`);
  }

  const json = await res.json();
  const candidate = json.candidates?.[0];
  if (candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'PROHIBITED_CONTENT') {
    throw new Error('AIがこの画像の解析を拒否しました。');
  }
  const text = candidate?.content?.parts?.map((p) => p.text || '').join('');
  if (!text) throw new Error('通帳解析結果が空でした。もう一度お試しください。');

  try {
    return JSON.parse(text);
  } catch (e) {
    console.error('tsucho-app: 通帳解析結果のJSON解析に失敗しました', e, text);
    throw new Error('通帳解析結果の形式が不正でした。もう一度お試しください。');
  }
}
