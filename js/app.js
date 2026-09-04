import { initTsucho } from './tsucho.js';
import { exportBackup, importBackup } from './backup.js';
import { initTsuchoStorage, flushPendingWrites, getTsuchoRecords, restoreLegacyData } from './storage.js';
import { requireLogin } from './firebaseClient.js';
import { readLegacyData } from './legacyData.js';

// 起動が終わるまで、空っぽの画面が一瞬見えてしまうのを防ぐための軽い読み込み表示。
const bootOverlay = document.createElement('div');
bootOverlay.textContent = '読み込み中…';
bootOverlay.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#f5f6f8;font-size:15px;color:#6b7280;z-index:999;';
document.body.appendChild(bootOverlay);

window.addEventListener('beforeunload', () => {
  flushPendingWrites();
});

async function boot() {
  // ログイン(合言葉)が確認できるまで、この先には進めない。
  await requireLogin();
  // Firestore(共有データベース)から通帳明細を読み込む。
  await initTsuchoStorage();

  const tsuchoApi = initTsucho(document.getElementById('view-tsucho'), document.getElementById('account-sidebar'));

  // Firestoreへの切り替え前に、このブラウザにIndexedDB/localStorageで保存されていた旧データが
  // 残っていて、かつクラウド側がそれより少ない(未移行、または途中で失敗した移行)場合に移行を提案する。
  {
    const legacy = await readLegacyData();
    if (legacy.records.length > getTsuchoRecords().length) {
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;background:#fff7ed;border:1px solid #fb923c;border-radius:10px;padding:14px 16px;z-index:500;box-shadow:0 4px 16px rgba(0,0,0,0.1)';
      banner.innerHTML = `
        <p style="margin:0 0 10px;font-size:14px">このパソコンに残っている古いデータ(${legacy.records.length}件)の方が、クラウド上のデータ(${getTsuchoRecords().length}件)より多いです。クラウド側をこのパソコンの内容で上書きしますか？</p>
        <button type="button" class="btn btn-primary btn-sm" id="tsucho-migrate-legacy-btn">☁️ 移行する(上書き)</button>
        <button type="button" class="btn btn-ghost btn-sm" id="tsucho-migrate-legacy-dismiss">あとで</button>
      `;
      document.body.appendChild(banner);
      banner.querySelector('#tsucho-migrate-legacy-dismiss').addEventListener('click', () => banner.remove());
      banner.querySelector('#tsucho-migrate-legacy-btn').addEventListener('click', () => {
        restoreLegacyData(legacy);
        banner.remove();
        alert(`移行しました(明細${legacy.records.length}件)。`);
        tsuchoApi.render();
      });
    }
  }

  document.getElementById('btn-export-backup').addEventListener('click', () => {
    exportBackup();
  });

  const backupFileInput = document.getElementById('backup-file-input');
  document.getElementById('btn-import-backup').addEventListener('click', () => backupFileInput.click());
  backupFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm('現在の通帳仕分けデータを、選択したバックアップファイルの内容で上書きします。よろしいですか？')) return;
    try {
      const result = await importBackup(file);
      alert(`復元しました(${result.count}件)`);
      tsuchoApi.render();
    } catch (err) {
      alert(`復元に失敗しました: ${err.message}`);
    }
  });
}

boot().finally(() => {
  bootOverlay.remove();
});
