// Deployment smoke test: only a synthetic image and temporary QA accounts/data.
// Never prints credentials or accesses a real user's records. Sends no LINE messages.
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {parseServiceAccount}=require('./service-account.cjs');
const account=parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
if(account.project_id!=='hibiruka-f66fb')throw Error('Wrong project');
admin.initializeApp({credential:admin.credential.cert(account)});
const key=fs.readFileSync('index/index/index.html','utf8').match(/apiKey:\s*"([^"]+)"/)[1];
const base='https://firestore.googleapis.com/v1/projects/hibiruka-f66fb/databases/(default)/documents/';
const users=[];
async function makeUser(){
 const uid='calendar-qa-'+crypto.randomUUID();await admin.auth().createUser({uid});users.push(uid);
 const token=await admin.auth().createCustomToken(uid);
 const r=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key='+key,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,returnSecureToken:true}),signal:AbortSignal.timeout(15000)});
 assert.equal(r.status,200,'temporary account sign in');const result=await r.json();return {uid,token:result.idToken};
}
(async()=>{try{
 const [a,b]=[await makeUser(),await makeUser()];
 const {fields}=await import('../line-worker/firestore.mjs');
 const calendar={version:1,configured:true,team:'A',showRokuyo:true,days:{'2026-10-10':'A'}};
 const write=async user=>fetch(base+'personalConfig/'+a.uid,{method:'PATCH',headers:{authorization:'Bearer '+user.token,'content-type':'application/json'},body:JSON.stringify({fields:fields({ownerName:'Temporary calendar verification',calendar})}),signal:AbortSignal.timeout(15000)});
 let result;
 for(let n=0;n<6;n++){result=await write(a);if(result.status!==403)break;await new Promise(r=>setTimeout(r,10000));}
 assert.equal(result.status,200,'owner can save calendar');
 const read=await fetch(base+'personalConfig/'+a.uid,{headers:{authorization:'Bearer '+a.token},signal:AbortSignal.timeout(15000)});
 assert.equal(read.status,200,'owner can reload calendar');
 assert.equal((await read.json()).fields.calendar.mapValue.fields.team.stringValue,'A');
 assert.equal((await write(b)).status,403,'another account cannot overwrite calendar');
 const fixture=JSON.parse(fs.readFileSync('tests/fixtures/calendar-vision.json','utf8'));
 const res=await fetch('https://hibiruka-line.okm-co.workers.dev/ai/calendar',{method:'POST',headers:{origin:'https://pocham4173.github.io',authorization:'Bearer '+a.token,'content-type':'application/json'},body:JSON.stringify({year:2026,image:fixture.image}),signal:AbortSignal.timeout(90000)});
 const body=await res.json();
 assert.equal(res.status,200,'vision endpoint: '+(body.error||'unexpected status'));
 assert.equal(body.reviewRequired,true);
 const actual=body.days.map(x=>({date:x.date,kind:x.kind}));
 console.log('Synthetic calendar recognition:',JSON.stringify(actual));
 assert.deepEqual(actual,fixture.expected,'recognize all three marks without inferring other Sundays');
 console.log('PASS: real image recognition, owner calendar save/reload and cross-account denial.');
 }finally{
  let failed=0;const day=new Date(Date.now()+9*3600e3).toISOString().slice(0,10).replaceAll('-','');
  for(const uid of users){
   for(const path of ['personalConfig/'+uid,'calendarUsage/'+day+'_'+uid,'aiUsage/'+day+'_'+uid])try{await admin.firestore().doc(path).delete();}catch{failed++;}
   try{await admin.auth().deleteUser(uid);}catch{failed++;}
  }
  if(failed)throw Error('Temporary QA cleanup failed: '+failed);
  console.log('Temporary QA accounts and personal test data removed; global AI usage counters retained.');
 }
})().catch(e=>{console.error('Calendar production check failed:',e.message);process.exitCode=1;});
