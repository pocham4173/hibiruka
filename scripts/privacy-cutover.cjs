'use strict';
// The only production writes are to the three named config documents below
// and the Firestore rules release. Existing records and LINE reservations are never written.
const fs=require('node:fs'),crypto=require('node:crypto');
const {parseServiceAccount}=require('./service-account.cjs');
const {confirmedOwner}=require('./privacy-owner-match.cjs');
const {privateRules}=require('./legacy-private-rules.cjs');
const PLAN='/tmp/hibiruka-private-plan.json',RULES='/tmp/hibiruka-combined.rules';
const collections=['events','photos','friends','pets'];
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const version=s=>s.updateTime?`${s.updateTime.seconds}:${s.updateTime.nanoseconds}`:null;
const requireTrue=value=>{if(!value)throw Error('Cutover precondition failed');};
async function recordVersions(db){
 const result={};
 for(const name of collections){
  const snapshot=await db.collection(name).select().limit(5001).get();
  requireTrue(snapshot.size<=5000);
  result[name]=Object.fromEntries(snapshot.docs.map(d=>[d.id,version(d)]));
 }
 return result;
}
function unchanged(before,after){
 return collections.every(c=>Object.entries(before[c]).every(([id,v])=>after[c][id]===v));
}
async function waitWorker(admin,expectedVersion){
 requireTrue(expectedVersion);
 const deadline=Date.now()+10*60000;
 let previous=0,healthy=0;
 while(Date.now()<deadline){
  const h=(await admin.firestore().doc('schedulerStatus/cloudflare').get()).data(),at=h?.checkedAt?.toMillis?.()||0;
  if(h?.version===expectedVersion&&h.enabled===true&&Date.now()-at<180000){
   requireTrue(h.ok===true);
   if(at>previous){previous=at;healthy++;}
   if(healthy>=2){console.log('PRIVACY_WORKER_READY: matching worker passed two enabled scheduled checks.');return;}
  }
  await new Promise(resolve=>setTimeout(resolve,15000));
 }
 throw Error('Worker verification timed out');
}
async function prepare(admin,account){
 const db=admin.firestore(),{uid,owners}=await confirmedOwner(db,account);
 const [lock,members,rules]=await Promise.all([db.doc('config/legacyPrivacy').get(),db.collection('members').count().get(),admin.securityRules().getFirestoreRuleset()]);
 requireTrue(!lock.exists&&members.data().count===0&&rules.source.length===1);
 await admin.auth().getUser(uid); // Do not create an account if the selector is stale.
 const source=rules.source[0].content,target=privateRules(source);
 requireTrue(!/match\s+\/config\/legacyPrivacyBackup\s*\{/.test(source));
 fs.writeFileSync(RULES,target,{mode:0o600});
 fs.writeFileSync(PLAN,JSON.stringify({uid,ownersVersion:version(owners),rulesName:rules.name,sourceHash:hash(source),targetHash:hash(target),preparedAt:Date.now()}),{mode:0o600});
 console.log('PRIVACY_CUTOVER_PREPARED: existing account and current rules checked; no writes.');
}
async function apply(admin,account,expectedVersion){
 const db=admin.firestore(),plan=JSON.parse(fs.readFileSync(PLAN,'utf8')),source=fs.readFileSync(RULES,'utf8');
 requireTrue(Date.now()-plan.preparedAt<20*60000&&hash(source)===plan.targetHash);
 const [{uid,owners},rules,members,heartbeat]=await Promise.all([
  confirmedOwner(db,account),admin.securityRules().getFirestoreRuleset(),db.collection('members').count().get(),db.doc('schedulerStatus/cloudflare').get()
 ]);
 requireTrue(uid===plan.uid&&version(owners)===plan.ownersVersion&&members.data().count===0);
 requireTrue(rules.name===plan.rulesName&&rules.source.length===1&&hash(rules.source[0].content)===plan.sourceHash);
 const h=heartbeat.data();
 requireTrue(expectedVersion&&h?.version===expectedVersion&&h.ok===true&&h.enabled===true&&Date.now()-h.checkedAt.toMillis()<180000);
 plan.records=await recordVersions(db);
 fs.writeFileSync(PLAN,JSON.stringify(plan),{mode:0o600});
 await db.runTransaction(async tx=>{
  const ownRef=db.doc('config/owners'),lockRef=db.doc('config/legacyPrivacy'),backupRef=db.doc('config/legacyPrivacyBackup');
  const [current,lock,backup]=await Promise.all([tx.get(ownRef),tx.get(lockRef),tx.get(backupRef)]);
  requireTrue(version(current)===plan.ownersVersion&&!lock.exists&&!backup.exists);
  tx.create(backupRef,{owners:current.data(),rulesSource:rules.source[0].content,rulesName:rules.name,createdAt:admin.firestore.FieldValue.serverTimestamp()});
  tx.create(lockRef,{version:1,ownerUid:uid,activated:false,workerVersion:expectedVersion,createdAt:admin.firestore.FieldValue.serverTimestamp()});
 });
 // Do not roll back to broad shared permissions on failure. The confirmed owner
 // retains access through the previous owners list while the server gate is already private.
 const latest=await admin.securityRules().getFirestoreRuleset();
 requireTrue(latest.name===plan.rulesName);
 await admin.securityRules().releaseFirestoreRulesetFromSource(source);
 console.log('PRIVACY_RULES_APPLIED: record collections and reservations unchanged; verification pending.');
}
async function verify(admin,account){
 const db=admin.firestore(),plan=JSON.parse(fs.readFileSync(PLAN,'utf8'));
 const {uid}=await confirmedOwner(db,account);
 requireTrue(uid===plan.uid);
 const rules=await admin.securityRules().getFirestoreRuleset();
 requireTrue(rules.source.length===1&&hash(rules.source[0].content)===plan.targetHash);
 const lock=await db.doc('config/legacyPrivacy').get();
 requireTrue(lock.exists&&lock.data().ownerUid===uid&&lock.data().version===1);
 const key=fs.readFileSync('index/index/index.html','utf8').match(/apiKey:\s*"([^"]+)"/)[1];
 const outsider='privacy-qa-'+crypto.randomUUID();let outsiderCreated=false;
 const authenticate=async id=>{
  const token=await admin.auth().createCustomToken(id);
  const response=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key='+key,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,returnSecureToken:true}),signal:AbortSignal.timeout(15000)});
  requireTrue(response.ok);return (await response.json()).idToken;
 };
 const base='https://firestore.googleapis.com/v1/projects/hibiruka-f66fb/databases/(default)/documents';
 const count=async(token,name)=>fetch(base+':runAggregationQuery',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({structuredAggregationQuery:{structuredQuery:{from:[{collectionId:name}]},aggregations:[{alias:'total',count:{}}]}}),signal:AbortSignal.timeout(15000)});
 try{
  await admin.auth().createUser({uid:outsider});outsiderCreated=true;
  const ownerToken=await authenticate(uid),otherToken=await authenticate(outsider);
  let passed=false;
  for(let attempt=0;attempt<18&&!passed;attempt++){
   passed=true;
   for(const name of collections){
    const [a,b]=await Promise.all([count(ownerToken,name),count(otherToken,name)]);
    if(a.status!==200||b.status!==403)passed=false;
    await a.arrayBuffer();await b.arrayBuffer();
   }
   if(!passed)await new Promise(resolve=>setTimeout(resolve,5000));
  }
  requireTrue(passed&&unchanged(plan.records,await recordVersions(db)));
  // Backups must remain inaccessible to both user accounts.
  for(const token of [ownerToken,otherToken]){
   const r=await fetch(base+'/config/legacyPrivacyBackup',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});
   requireTrue(r.status===403);await r.arrayBuffer();
  }
  await db.runTransaction(async tx=>{
   const ownRef=db.doc('config/owners'),lockRef=db.doc('config/legacyPrivacy');
   const [current,privacy]=await Promise.all([tx.get(ownRef),tx.get(lockRef)]);
   requireTrue(version(current)===plan.ownersVersion&&privacy.data()?.ownerUid===uid&&privacy.data()?.version===1);
   tx.set(ownRef,{...current.data(),uids:[uid],privacyVersion:1});
   tx.update(lockRef,{activated:true,verifiedAt:admin.firestore.FieldValue.serverTimestamp()});
  });
  console.log('PRIVACY_VERIFIED: owner reads all original collections; other account denied; existing record IDs and versions preserved.');
 }finally{
  if(outsiderCreated)await admin.auth().deleteUser(outsider);
 }
 console.log('PRIVACY_QA_ACCOUNT_REMOVED: no LINE messages or user-record writes performed.');
}
if(require.main===module)(async()=>{
 const admin=require('firebase-admin'),account=parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
 requireTrue(account.project_id==='hibiruka-f66fb');
 admin.initializeApp({credential:admin.credential.cert(account)});
 try{
  if(process.argv[2]==='wait-worker')await waitWorker(admin,process.env.GITHUB_SHA);
  else if(process.argv[2]==='prepare')await prepare(admin,account);
  else if(process.argv[2]==='apply')await apply(admin,account,process.env.GITHUB_SHA);
  else if(process.argv[2]==='verify')await verify(admin,account);
  else throw Error('Unknown cutover action');
 }finally{await admin.app().delete();}
})().catch(()=>{console.error('Privacy cutover stopped; do not reopen shared permissions. No private details logged.');process.exitCode=1;});
module.exports={unchanged,recordVersions,waitWorker,prepare,apply,verify};
