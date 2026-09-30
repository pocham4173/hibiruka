// Read-only rollout verification. Do not print records, credentials or recipients.
const admin = require('firebase-admin');
const {parseServiceAccount} = require('./service-account.cjs');
const {readFileSync} = require('node:fs');
async function main() {
  const legacy = readFileSync('.github/workflows/notify.yml','utf8');
  if (/schedule:/.test(legacy) || !legacy.includes("VALIDATE_ONLY: 'true'")) throw Error('Legacy sender must remain stopped');
  const account = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
  if(account.project_id !== 'hibiruka-f66fb') throw Error('Wrong project');
  admin.initializeApp({credential:admin.credential.cert(account)});
  try {
    const enabled = process.env.EXPECT_ENABLED === 'true';
    const deadline = Date.now() + 5 * 60000;
    let last = 0, count = 0;
    while(Date.now() < deadline) {
      const value = (await admin.firestore().doc('schedulerStatus/cloudflare').get()).data();
      const at = value?.checkedAt?.toMillis?.() || 0;
      if(value?.version === process.env.GITHUB_SHA && value.enabled === enabled && Date.now()-at < 180000) {
        if(!value.ok) throw Error('Scheduler heartbeat reports failure');
        if(at > last) {
          last = at; count++;
          console.log(JSON.stringify({enabled,checkedAt:new Date(at).toISOString(),sent:value.sent||0,failed:value.failed||0}));
        }
        if(count >= 2) return;
      }
      await new Promise(resolve=>setTimeout(resolve,15000));
    }
    throw Error('Scheduler heartbeat timed out');
  } finally { await admin.app().delete(); }
}
main().catch(()=>{console.error('Scheduler rollout verification failed; inspect deployment and heartbeat.');process.exitCode=1;});
