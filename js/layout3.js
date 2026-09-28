// 全アプリ共通の3列デザインの枠組み。通帳仕分けの画面そのもの(tsucho.js)には手を入れず、
// 左メニューから既存のボタン(上の横並びツールバー。CSSで隠してある)を押す形で画面を切り替える。
import { getTsuchoRecords, getKnownAccounts } from './storage.js';

const ICONS = {
  top: '<path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  import: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  dup: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>',
  balance: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="m5 7-3 7a4 4 0 0 0 6 0z"/><path d="m19 7-3 7a4 4 0 0 0 6 0z"/>',
  files: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  rename: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  report: '<path d="M3 3v18h18"/><path d="M7 15v-4M12 15V7M17 15v-6"/>',
};

// view: そのボタンを押すと表示される画面(トップ/取り込み/明細一覧)。見出しと選択中の印に使う
const NAV = [
  { key: 'top', label: 'トップ', btn: 'tsucho-tab-top', view: 'top', icon: 'top' },
  { key: 'import', label: 'データ取り込み', btn: 'tsucho-tab-import', view: 'import', icon: 'import' },
  { key: 'list', label: '明細一覧', btn: 'tsucho-tab-list', view: 'list', icon: 'list' },
  { sep: 'チェック・管理' },
  { key: 'dup', label: '重複チェック', btn: 'tsucho-check-duplicates', view: 'list', icon: 'dup' },
  { key: 'balance', label: '残高チェック', btn: 'tsucho-check-balance-top', view: 'list', icon: 'balance' },
  { key: 'files', label: '口座・取込ファイル一覧', btn: 'tsucho-show-file-history', view: 'list', icon: 'files' },
  { key: 'rename', label: '口座名の変更・統合', btn: 'tsucho-show-account-manage-top', view: 'import', icon: 'rename' },
  { key: 'report', label: '資産レポート(PowerPoint)', btn: 'tsucho-export-pptx', icon: 'report' },
];
const VIEW_TITLE = { top: 'トップ', import: 'データ取り込み', list: '明細一覧' };

export function initLayout3() {
  const layout = document.getElementById('l3-layout');
  const nav = document.getElementById('l3-nav');
  const body = document.getElementById('l3-main-body');
  const click = (id) => document.getElementById(id)?.click();

  // ブラウザに古いindex.html(口座一覧が右の列にある版)が残っていたときも、左メニューの下へ移す
  if (!document.querySelector('.l3-accounts')) {
    const list = document.getElementById('account-sidebar');
    const box = document.createElement('div');
    box.className = 'l3-accounts';
    box.innerHTML = '<div class="l3-accounts-head">口座<span>押すとその口座の明細へ</span></div>';
    nav.after(box);
    if (list) box.appendChild(list);
    document.querySelector('.l3-right:not(#l3-summary)')?.remove();
  }
  let lastKey = 'top';

  nav.innerHTML = NAV.map((n) => (n.sep
    ? `<div class="l3-nav-sep l3-label">${n.sep}</div>`
    : `<button type="button" class="l3-nav-item" data-key="${n.key}" title="${n.label}">
        <svg class="l3-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n.icon]}</svg>
        <span class="l3-label">${n.label}</span></button>`)).join('');

  const views = {
    top: document.getElementById('tsucho-view-top'),
    import: document.getElementById('tsucho-view-import'),
    list: document.getElementById('tsucho-view-list'),
  };
  const visibleView = () => Object.keys(views).find((k) => views[k] && !views[k].classList.contains('hidden')) || 'top';

  /** 見出しと左メニューの選択中の印を、いま表示されている画面に合わせる */
  function syncActive() {
    const v = visibleView();
    const last = NAV.find((n) => n.key === lastKey);
    const key = last && last.view === v ? lastKey : v;
    nav.querySelectorAll('.l3-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.key === key));
    document.getElementById('l3-title').textContent = VIEW_TITLE[v];
  }
  // 口座を押したときなど、tsucho.js の中から画面が切り替わる場合にも追従する
  const mo = new MutationObserver(syncActive);
  Object.values(views).forEach((el) => el && mo.observe(el, { attributes: true, attributeFilter: ['class'] }));

  nav.addEventListener('click', (e) => {
    const b = e.target.closest('[data-key]');
    if (!b) return;
    const n = NAV.find((x) => x.key === b.dataset.key);
    if (n.view) lastKey = n.key;
    click(n.btn);
    if (n.key === 'top' || n.key === 'import' || n.key === 'list') body.scrollTop = 0;
    layout.classList.remove('drawer-open');
    syncActive();
  });

  // 設定・バックアップ(オレンジ)は小さなメニューを開く
  const setBtn = document.getElementById('l3-settings-btn');
  const setMenu = document.getElementById('l3-settings-menu');
  const closeMenu = () => { setMenu.hidden = true; setBtn.setAttribute('aria-expanded', 'false'); };
  setBtn.addEventListener('click', () => {
    setMenu.hidden = !setMenu.hidden;
    setBtn.setAttribute('aria-expanded', String(!setMenu.hidden));
  });
  setMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-l3-click]');
    if (!b) return;
    closeMenu();
    layout.classList.remove('drawer-open');
    if (b.dataset.l3Tab) { lastKey = 'import'; click(b.dataset.l3Tab); }
    // APIキー設定は開閉式なので、すでに開いているときは押さずにそこまで送るだけにする
    if (b.dataset.l3Click === 'tsucho-toggle-settings') {
      const panel = document.getElementById('tsucho-settings-panel');
      if (panel && !panel.classList.contains('hidden')) { panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    }
    click(b.dataset.l3Click);
  });
  document.addEventListener('click', (e) => {
    if (!setMenu.hidden && !setMenu.contains(e.target) && !setBtn.contains(e.target)) closeMenu();
  });

  // 折りたたみ(PC)・ドロワー(スマホ)
  try { if (localStorage.getItem('tsucho:l3collapsed') === '1') layout.classList.add('collapsed'); } catch { /* 保存できない環境 */ }
  document.getElementById('l3-menu-btn').addEventListener('click', () => {
    if (window.matchMedia('(max-width:767px)').matches) { layout.classList.toggle('drawer-open'); return; }
    layout.classList.toggle('collapsed');
    try { localStorage.setItem('tsucho:l3collapsed', layout.classList.contains('collapsed') ? '1' : '0'); } catch { /* 同上 */ }
  });
  document.getElementById('l3-scrim').addEventListener('click', () => layout.classList.remove('drawer-open'));

  // 「選択中の口座」などの表示(もとはツールバーの右端)を、中央の見出しの横に写す
  const fileLabel = document.getElementById('tsucho-current-file-label');
  const note = document.getElementById('l3-head-note');
  const copyNote = () => { note.textContent = fileLabel?.textContent || ''; };
  if (fileLabel) new MutationObserver(copyNote).observe(fileLabel, { childList: true, characterData: true, subtree: true });
  copyNote();

  // 左下: 件数のまとめ
  const foot = document.getElementById('l3-foot');
  const updateFoot = () => {
    const recs = getTsuchoRecords();
    const latest = recs.reduce((m, r) => (r.date > m ? r.date : m), '');
    foot.textContent = `明細${recs.length.toLocaleString()}件・口座${getKnownAccounts().length}${latest ? `・最新 ${latest}` : ''}`;
  };
  updateFoot();
  setInterval(updateFoot, 5000);

  // 右の列: トップの上段にある合計のカードを、描き直されるたびに右の列へ移す。
  // (カードを押したときの動きは tsucho.js がカードに付けたものがそのまま使える)
  let right = document.getElementById('l3-summary');
  if (!right) {
    right = document.createElement('aside');
    right.className = 'l3-right';
    right.id = 'l3-summary';
    layout.appendChild(right);
  }
  const dash = document.getElementById('tsucho-top-dashboard');
  const moveSummary = () => {
    const grid = dash && dash.querySelector('.summary-grid');
    if (!grid) return;
    right.innerHTML = '<div class="l3-right-head">合計（押すと真ん中に内訳）</div>';
    right.appendChild(grid);
  };
  if (dash) new MutationObserver(moveSummary).observe(dash, { childList: true });
  moveSummary();
  // 別の画面を開いているときにカードを押したら、トップに切り替えて内訳を見せる
  right.addEventListener('click', (e) => {
    if (!e.target.closest('[data-toggle-section]')) return;
    if (views.top && views.top.classList.contains('hidden')) { lastKey = 'top'; click('tsucho-tab-top'); }
  }, true);

  syncActive();
}
