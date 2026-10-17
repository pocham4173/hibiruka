'use strict';
// READ ONLY. Only aggregate counts leave this process.
// No account lookup, account labels, UIDs, emails, rule source, record body or photographs are logged.
const admin = require('firebase-admin');
const {parseServiceAccount} = require('./service-account.cjs');
(async()=>{
 const account=parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
 if(account.project_id!=='hibiruka-f66fb')throw Error('wrong-project');
 admin.initializeApp({credential:admin.credential.cert(account)});
 const db=admin.firestore();
 const [owners,members]=await Promise.all([db.doc('config/owners').get(),db.collection('members').count().get()]);
 const configured=owners.exists&&Array.isArray(owners.data().uids)?new Set(owners.data().uids).size:0;
 console.log('PRIVACY_AGGREGATE',JSON.stringify({configuredOwnerCount:configured,registeredLegacyAccountCount:members.data().count}));
 for(const name of ['events','photos','friends','pets']){
  const q=await db.collection(name).select('ownerUid').limit(5001).get();
  if(q.size>5000)throw Error('size-limit');
  const unique=new Set();let missingOwner=0;
  for(const doc of q.docs){const uid=doc.data().ownerUid;if(typeof uid==='string'&&uid)unique.add(uid);else missingOwner++;}
  console.log('PRIVACY_AGGREGATE',JSON.stringify({collection:name,total:q.size,missingOwner,distinctOwnerCount:unique.size}));
 }
 await admin.app().delete();
})().catch(()=>{console.error('Aggregate read-only check failed; no details logged.');process.exitCode=1;});
