// FirebaseコンソールでWebアプリを登録した時に発行される設定値。
// この値自体は公開されても問題ない(いわばアプリの住所のようなもの)。
// 実際のアクセス制御はFirebase Authenticationのログインと、Firestoreのセキュリティルールで行う。
export const firebaseConfig = {
  apiKey: 'AIzaSyD9pNYjVfvs6Kjng2KUiC-k31yG2792rMg',
  authDomain: 'tsucho-app-1a559.firebaseapp.com',
  projectId: 'tsucho-app-1a559',
  storageBucket: 'tsucho-app-1a559.firebasestorage.app',
  messagingSenderId: '505344379174',
  appId: '1:505344379174:web:0db8e2781d826d8f0fd9e7',
};

// ログイン用の固定メールアドレス(Firebase Authenticationにユーザーを1人だけ登録している)。
// 実際の「合言葉」はパスワードの方で、ログイン画面ではパスワードだけ入力してもらう。
export const AUTH_EMAIL = 'izakayakura@icloud.com';
