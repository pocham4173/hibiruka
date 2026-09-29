const { parseServiceAccount } = require('./service-account.cjs');
const engine = require('./line-engine.cjs');
async function main() {
  const account = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (account.project_id !== 'hibiruka-f66fb') throw new Error('Firebaseの接続情報がヒビルカ用ではありません。Secretsを確認してください。');
  const token = (process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim();
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKENが未設定です。');
  const admin = require('firebase-admin');
  admin.initializeApp({credential:admin.credential.cert(account)});
  const db = admin.firestore();
  return engine.runSender({db,token,validateOnly:process.env.VALIDATE_ONLY==='true',recoveryAt:process.env.RECOVER_SELF_AT});
}
if (require.main === module) main().catch(error => {
  const message = String(error.message || '');
  console.error(/^(FIREBASE_SERVICE_ACCOUNT|Firebaseの接続情報|LINE_CHANNEL_ACCESS_TOKEN|LINE接続情報)/.test(message) ? message : '自動送信を完了できませんでした。Firebaseの権限・接続設定を確認してください。秘密情報は表示しません。');
  process.exitCode = 1;
});
module.exports = {...engine,main};
