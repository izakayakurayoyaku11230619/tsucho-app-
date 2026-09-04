// Firestoreへの切り替え前(IndexedDB/localStorage時代)にこのブラウザへ保存されていたデータを、
// アプリの現在のコードとは無関係に直接読み出す(1回限りの移行用)。
const IDB_NAME = 'tsucho-app-db';
const IDB_STORE = 'kv';
const KNOWN_ACCOUNTS_KEY = 'tsucho-app:known-accounts';
const VERIFIED_BALANCES_KEY = 'tsucho-app:verified-balances';

function readLegacyRecords() {
  return new Promise((resolve) => {
    const req = indexedDB.open(IDB_NAME);
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains(IDB_STORE)) { idb.close(); resolve([]); return; }
      const tx = idb.transaction(IDB_STORE, 'readonly');
      const getReq = tx.objectStore(IDB_STORE).get('records');
      getReq.onsuccess = () => { idb.close(); resolve(getReq.result || []); };
      getReq.onerror = () => { idb.close(); resolve([]); };
    };
  });
}

function readLocalStorageJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** @returns {Promise<{records: object[], knownAccounts: object[], verifiedBalances: object}>} */
export async function readLegacyData() {
  const records = await readLegacyRecords();
  const knownAccounts = readLocalStorageJson(KNOWN_ACCOUNTS_KEY, []);
  const verifiedBalances = readLocalStorageJson(VERIFIED_BALANCES_KEY, {});
  return { records, knownAccounts, verifiedBalances };
}
