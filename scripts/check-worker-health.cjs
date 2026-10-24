// 定期送信役の動作記録だけを読む。利用者の予定・写真・LINE送信には触れない。
const fs = require('node:fs');
function heartbeatProblem(value, now = Date.now()) {
  if (!value) return '動作記録がありません';
  const at = value.checkedAt?.toMillis?.() ?? (value.checkedAt instanceof Date ? +value.checkedAt : NaN);
  if (!Number.isFinite(at) || at > now + 60000) return '動作記録の時刻を確認できません';
  if (now - at > 15 * 60000) return '動作記録が15分以上更新されていません';
  if (value.ok !== true) return '定期処理が失敗しています';
  if (value.enabled !== true) return '定期送信が停止しています';
  if (value.lineOk === false) return 'LINEへの接続を確認できません';
  return '';
}
async function main() {
  const admin = require('firebase-admin');
  const { parseServiceAccount } = require('./service-account.cjs');
  const account = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (account.project_id !== 'hibiruka-f66fb') throw Error('Wrong project');
  admin.initializeApp({ credential: admin.credential.cert(account) });
  try {
    const value = (await admin.firestore().doc('schedulerStatus/cloudflare').get()).data();
    const problem = heartbeatProblem(value);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `healthy=${!problem}\nreason=${problem || '定期送信は動作しています'}\n`);
    console.log(problem || '定期送信は動作しています');
  } finally { await admin.app().delete(); }
}
module.exports = { heartbeatProblem };
if (require.main === module) main().catch(() => { console.error('動作記録を読み取れませんでした。接続と権限を確認してください。'); process.exitCode = 1; });
