'use strict';
// READ ONLY. Only prepare live-rule tests. No account lookup or record access.
const fs=require('node:fs'),admin=require('firebase-admin');
const {parseServiceAccount}=require('./service-account.cjs');
const {privateRules}=require('./legacy-private-rules.cjs');
(async()=>{
 const account=parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
 if(account.project_id!=='hibiruka-f66fb')throw Error('project');
 admin.initializeApp({credential:admin.credential.cert(account)});
 const rules=await admin.securityRules().getFirestoreRuleset();
 if(rules.source.length!==1)throw Error('state');
 const source=rules.source[0].content,result=privateRules(source);
 fs.writeFileSync('/tmp/hibiruka-combined.rules',result,{mode:0o600});
 console.log('PRIVACY_RULES_PREPARED: no accounts or records accessed; no deployment.');
 await admin.app().delete();
})().catch(()=>{console.error('Privacy preflight stopped safely; no account or record details logged.');process.exitCode=1;});
