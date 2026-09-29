const admin = require('firebase-admin');
const {parseServiceAccount} = require('./service-account.cjs');
(async()=>{
 const a=parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
 if(a.project_id!=='hibiruka-f66fb')throw new Error('Wrong project');
 admin.initializeApp({credential:admin.credential.cert(a)});
 try{
  const rules=await admin.securityRules().getFirestoreRuleset();
  console.log('RULES_BEGIN');
  for(const f of rules.source) console.log(f.content.replace(/(['"])[^'"]{0,80}@[^'"]*\1/g,'"<redacted>"').replace(/(['"])\d{6}\1/g,'"<redacted-pin>"'));
  console.log('RULES_END');
 }catch(e){console.log('RULES_READ_ERROR',e.code||'unknown');}
 try{
  const tok=await admin.app().options.credential.getAccessToken();
  const r=await fetch('https://identitytoolkit.googleapis.com/admin/v2/projects/hibiruka-f66fb/config',{headers:{Authorization:'Bearer '+tok.access_token}});
  const c=await r.json();console.log('AUTH_CONFIG',JSON.stringify({status:r.status,anonymous:c.signIn?.anonymous?.enabled,email:c.signIn?.email?.enabled,emailPasswordRequired:c.signIn?.email?.passwordRequired}));
 }catch(e){console.log('AUTH_CONFIG_ERROR');}
})().catch(()=>{console.error('Diagnostic failed');process.exitCode=1;});
