// Run only by the manually invoked GitHub workflow. Secrets travel via stdin,
// never command arguments or repository files. This does not enable paid plans.
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const {parseServiceAccount}=require('../scripts/service-account.cjs');
(async()=>{
 if(!process.env.CLOUDFLARE_API_TOKEN||!process.env.CLOUDFLARE_ACCOUNT_ID)throw Error('Cloudflare connection is missing');
 const account=parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
 if(account.project_id!=='hibiruka-f66fb')throw Error('Wrong project');
 const enable=process.env.ENABLE_SENDING==='true';
 // An active version must first be checked by a real cron invocation in verify mode.
 if(enable){
  const admin=require('../scripts/node_modules/firebase-admin');
  admin.initializeApp({credential:admin.credential.cert(account)});
  const s=await admin.firestore().doc('schedulerStatus/cloudflare').get(),v=s.data();
  if(!v?.ok||v.enabled||v.version!==process.env.GITHUB_SHA||Date.now()-v.checkedAt.toMillis()>180000)throw Error('Run verify mode first, then confirm a recent successful cron heartbeat for this version');
 }
 const config=JSON.parse(fs.readFileSync('line-worker/wrangler.jsonc','utf8'));
 config.vars={SENDING_ENABLED:'false',WORKER_VERSION:process.env.GITHUB_SHA};
 const path='line-worker/.deploy.json';
 const run=(args,input)=>{const r=spawnSync('line-worker/node_modules/.bin/wrangler',args,{input,stdio:input?['pipe','inherit','inherit']:'inherit',env:process.env});if(r.status!==0)throw Error('Worker deployment failed');};
 try{
  fs.writeFileSync(path,JSON.stringify(config));
  run(['deploy','--config',path]);
  const secrets={FIREBASE_SERVICE_ACCOUNT:JSON.stringify(account),LINE_CHANNEL_ACCESS_TOKEN:process.env.LINE_CHANNEL_ACCESS_TOKEN};
  // Optional: enables the signed LINE webhook. Without it the webhook answers 503 and sending is unaffected.
  if(process.env.LINE_CHANNEL_SECRET)secrets.LINE_CHANNEL_SECRET=process.env.LINE_CHANNEL_SECRET.trim();
  // Optional: enables 「✨ AIで文章を作成」. Without it the AI writer answers 503 and nothing else changes.
  if(process.env.ANTHROPIC_API_KEY)secrets.ANTHROPIC_API_KEY=process.env.ANTHROPIC_API_KEY.trim();
  run(['secret','bulk','--config',path],JSON.stringify(secrets));
  if(enable){config.vars.SENDING_ENABLED='true';fs.writeFileSync(path,JSON.stringify(config));run(['deploy','--config',path]);}
  console.log(enable?'Scheduled sender enabled. Verify heartbeat and the next authorized reservation.':'Verify-only cron deployed. No LINE messages will be sent. Wait for a successful cron heartbeat before activation.');
 }finally{fs.rmSync(path,{force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
