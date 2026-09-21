// Firebase(Authentication + Firestore)の初期化をまとめたモジュール。
// CDN経由のモジュール版SDKを使う(npm/ビルド環境を持たないこのアプリの方針に合わせるため)。
// 合言葉(パスワード)入力は廃止し、匿名ログイン(Anonymous Auth)を自動で行う方式にした。
// Firestoreのセキュリティルールは「ログイン済み(request.auth != null)なら読み書き可」の
// ままなので、匿名ログインでも通る。合言葉を都度入力する手間が無くなる代わりに、
// このURLを知っている人なら誰でもデータを読み書きできる状態になる点に注意。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously, signOut,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { firebaseConfig } from './firebaseConfig.js';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

/**
 * ログイン済みになるまで待つ。未ログインなら自動的に匿名ログインする(画面表示や入力は無し)。
 * @returns {Promise<void>} ログインが確認できたら解決する
 */
export function requireLogin() {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        unsubscribe();
        resolve();
      }
    });
    signInAnonymously(auth).catch((err) => {
      console.error('tsucho-app: 自動ログインに失敗しました', err);
    });
  });
}

export function logout() {
  return signOut(auth);
}
