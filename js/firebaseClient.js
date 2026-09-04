// Firebase(Authentication + Firestore)の初期化と、ログインゲートをまとめたモジュール。
// CDN経由のモジュール版SDKを使う(npm/ビルド環境を持たないこのアプリの方針に合わせるため)。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, setPersistence, browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { firebaseConfig, AUTH_EMAIL } from './firebaseConfig.js';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

/**
 * ログイン済みになるまで待つ。ログインしていなければ、合言葉(パスワード)入力画面を出す。
 * @returns {Promise<void>} ログインが確認できたら解決する
 */
export function requireLogin() {
  return new Promise((resolve) => {
    setPersistence(auth, browserLocalPersistence).catch(() => {});

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#f5f6f8;z-index:1000;';
    overlay.innerHTML = `
      <form id="tsucho-login-form" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;width:280px;box-shadow:0 4px 16px rgba(0,0,0,0.08)">
        <h1 style="font-size:16px;margin:0 0 16px;text-align:center">通帳仕分けアプリ</h1>
        <label style="display:block;font-size:13px;color:#555;margin-bottom:6px">合言葉</label>
        <input type="password" id="tsucho-login-password" autocomplete="current-password" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:16px;margin-bottom:12px">
        <div id="tsucho-login-error" style="color:#dc2626;font-size:13px;margin-bottom:8px;min-height:1em"></div>
        <button type="submit" style="width:100%;padding:10px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:15px;font-weight:700;cursor:pointer">入る</button>
      </form>
    `;
    document.body.appendChild(overlay);

    const form = overlay.querySelector('#tsucho-login-form');
    const passwordInput = overlay.querySelector('#tsucho-login-password');
    const errorEl = overlay.querySelector('#tsucho-login-error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.textContent = '';
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await signInWithEmailAndPassword(auth, AUTH_EMAIL, passwordInput.value);
      } catch (err) {
        errorEl.textContent = '合言葉が違います。';
        submitBtn.disabled = false;
      }
    });

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        unsubscribe();
        overlay.remove();
        resolve();
      }
    });
  });
}

export function logout() {
  return signOut(auth);
}
