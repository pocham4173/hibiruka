// Explicitly invoked production verification; creates and removes only temporary QA data.
const fs=require('node:fs'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const admin=require('firebase-admin');
const firebase=require('firebase/compat/app');require('firebase/compat/auth');
const {parseServiceAccount}=require('./service-account.cjs');
const account=parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
if(account.project_id!=='hibiruka-f66fb')throw Error('Wrong project');
admin.initializeApp({credential:admin.credential.cert(account)});
const key=fs.readFileSync('index/index/index.html','utf8').match(/apiKey:\s*"([^"]+)"/)[1];
const base='https://firestore.googleapis.com/v1/projects/hibiruka-f66fb/databases/(default)/documents';
const users=[], paths=[];
const s=stringValue=>({stringValue});
async function auth(method,data){const r=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${key}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});if(!r.ok){const error=await r.json();throw Error(`Auth ${method}: ${r.status} ${String(error.error?.message||'unknown').replace(/[^A-Z_ :0-9]/g,'').slice(0,120)}`);}return r.json();}
async function request(user,path,method='GET',body){return fetch(base+path,{method,headers:{Authorization:`Bearer ${user.idToken}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
(async()=>{try{
 for(let i=0;i<2;i++){const client=firebase.initializeApp({apiKey:key,projectId:account.project_id},'qa'+i);const result=await client.auth().signInAnonymously();users.push({localId:result.user.uid,idToken:await result.user.getIdToken(),client,user:result.user});}
 const [a,b]=users, event='qa-'+crypto.randomUUID();
 for(const u of users){const p='personalConfig/'+u.localId;paths.push(p);let r;for(let i=0;i<6;i++){r=await request(u,'/'+p,'PATCH',{fields:{ownerName:s('Temporary verification'),version:{integerValue:'1'}}});if(r.ok)break;if(r.status!==403)break;await new Promise(resolve=>setTimeout(resolve,15000));}assert.equal(r.status,200,'own profile creation');}
 const p='personalEvents/'+event;paths.push(p);
 let r=await request(a,':commit','POST',{writes:[{update:{name:base.replace('https://firestore.googleapis.com/v1/','')+'/'+p,fields:{ownerUid:s(a.localId),title:s('Temporary verification'),type:s('memory'),nextSendAt:{nullValue:null}}},updateTransforms:[{fieldPath:'createdAt',setToServerValue:'REQUEST_TIME'}]}]});assert.equal(r.status,200,'own event creation');
 assert.equal((await request(a,'/'+p)).status,200,'own event read');
 assert.equal((await request(b,'/'+p)).status,403,'other account read denied');
 assert.equal((await request(b,'/personalConfig/'+a.localId)).status,403,'other profile read denied');
 assert.equal((await request(b,'/'+p,'PATCH',{fields:{ownerUid:s(b.localId)}})).status,403,'other account overwrite denied');
 const query={structuredQuery:{from:[{collectionId:'personalEvents'}],where:{fieldFilter:{field:{fieldPath:'ownerUid'},op:'EQUAL',value:s(a.localId)}}}};
 assert.equal((await request(a,':runQuery','POST',query)).status,200,'own list');
 assert.equal((await request(b,':runQuery','POST',query)).status,403,'other account list denied');
 const password=crypto.randomBytes(24).toString('hex'),email=`hibiruka-qa-${crypto.randomUUID()}@example.com`;
 const linked=await a.user.linkWithCredential(firebase.auth.EmailAuthProvider.credential(email,password));assert.equal(linked.user.uid,a.localId,'link retains records identity');
 await a.client.auth().signOut();const login=await a.client.auth().signInWithEmailAndPassword(email,password);const restored={localId:login.user.uid,idToken:await login.user.getIdToken()};assert.equal(restored.localId,a.localId,'email recovery retains identity');
 assert.equal((await request(restored,'/'+p)).status,200,'restored account reads own event');
 console.log('PASS: production account isolation, own record storage, email linking and recovery. No LINE messages sent.');
 }finally{let failures=0;for(const p of paths){try{await admin.firestore().doc(p).delete();}catch{failures++;}}for(const u of users){try{await admin.auth().deleteUser(u.localId);await u.client.delete();}catch{failures++;}}if(failures)throw Error(`QA cleanup failures: ${failures}`);console.log('Temporary QA records and accounts removed.');}
})().catch(e=>{console.error('Production verification failed:',e.message);process.exitCode=1;});
