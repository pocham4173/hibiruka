// Explicit release verification. Only new temporary accounts/documents are touched.
const fs=require('node:fs'),assert=require('node:assert/strict');
const admin=require('firebase-admin');const firebase=require('firebase/compat/app');require('firebase/compat/auth');require('firebase/compat/firestore');require('firebase/compat/app-check');
const {parseServiceAccount}=require('./service-account.cjs');const C=require('../index/index/calendar-core.js');
const account=parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);if(account.project_id!=='hibiruka-f66fb')throw Error('Wrong project');
admin.initializeApp({credential:admin.credential.cert(account)});
const check=require('./smoke-app-check.cjs').smokeAppCheck(admin);
const apiKey=fs.readFileSync('index/index/index.html','utf8').match(/apiKey:\s*"([^"]+)"/)[1];const clients=[],users=[];
(async()=>{try{
 for(let i=0;i<2;i++){const client=firebase.initializeApp({apiKey,projectId:account.project_id,appId:check.appId},'businessQA'+i);check.activate(client);clients.push(client);users.push((await client.auth().signInAnonymously()).user);}
 const [a,b]=clients,uid=users[0].uid,ref=a.firestore().doc('personalConfig/'+uid);
 const calendar=C.businessPatch(C.cleanConfig({team:'A',days:{'2027-03-20':'B'}}),{yearStart:'03-21',personal:{'2027-03-20':{title:'Temporary half day',category:'paid',part:'am'}}});
 for(let attempt=0;;attempt++){try{await ref.set({ownerName:'Temporary business QA',calendar});break;}catch(e){if(e.code!=='permission-denied'||attempt>=7)throw e;await new Promise(r=>setTimeout(r,15000));}}
 assert.equal((await ref.get({source:'server'})).data().calendar.business.personal['2027-03-20'].part,'am');
 await assert.rejects(()=>b.firestore().doc('personalConfig/'+uid).get({source:'server'}),e=>e.code==='permission-denied');
 const {business,...old}=calendar;await assert.rejects(()=>ref.update({calendar:old}),e=>e.code==='permission-denied');
 await ref.update({calendar:C.businessPatch(calendar,{personal:{'2027-03-20':null}})});
 assert.equal((await ref.get({source:'server'})).data().calendar.days['2027-03-20'],'B');
 console.log('PASS: business save/read/restore, owner isolation and old-client preservation. No messages sent.');
 }finally{let failures=0;for(const user of users){try{await admin.firestore().doc('personalConfig/'+user.uid).delete();await admin.auth().deleteUser(user.uid);}catch{failures++;}}for(const c of clients)await c.delete();if(failures)throw Error('Temporary business QA cleanup failed');console.log('Temporary business QA accounts and documents removed.');}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
