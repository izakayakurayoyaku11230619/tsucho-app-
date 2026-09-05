import { initTsucho } from './tsucho.js';
import { exportBackup, importBackup } from './backup.js';
import { initTsuchoStorage, flushPendingWrites } from './storage.js';
import { requireLogin } from './firebaseClient.js';

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
