const fs = require('node:fs');
const crypto = require('node:crypto');
const admin = require('firebase-admin');
const {parseServiceAccount} = require('./service-account.cjs');
(async()=>{
  const account=parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
  if(account.project_id!=='hibiruka-f66fb') throw Error('Wrong project');
  admin.initializeApp({credential:admin.credential.cert(account)});
  const api=admin.securityRules();
  if(process.argv[2]==='prepare') {
    const current=await api.getFirestoreRuleset();
    if(current.source.length!==1)throw Error('Multiple rule files; stop');
    const base=current.source[0].content;
    if(!base.includes('function isOwner()') || /match\s+\/\{\w+=\*\*\}/.test(base))throw Error('Unexpected legacy rules; stop');
    let clean=base.replace(/\s*\/\/ HIBIRUKA_PERSONAL_V1_BEGIN[\s\S]*?\/\/ HIBIRUKA_PERSONAL_V1_END\s*/, '\n');
    clean=require('./registration-rules.cjs').replaceFriendRules(clean,fs.readFileSync('security/legacy-friends.rules','utf8'));
    if(!/\}\s*\}\s*$/.test(clean))throw Error('Unexpected rule structure');
    const source=clean.replace(/\}\s*\}\s*$/,()=>fs.readFileSync('security/personal.rules','utf8')+'\n  }\n}\n');
    fs.writeFileSync('/tmp/hibiruka-combined.rules',source);
    fs.writeFileSync('/tmp/hibiruka-rules-base.json',JSON.stringify({name:current.name,sha:crypto.createHash('sha256').update(base).digest('hex')}));
    console.log('Prepared server-verified registration rules; record rules preserved.');
  } else if(process.argv[2]==='deploy') {
    const previous=JSON.parse(fs.readFileSync('/tmp/hibiruka-rules-base.json'));
    const current=await api.getFirestoreRuleset();
    if(current.name!==previous.name)throw Error('Rules changed during testing; stop');
    const result=await api.releaseFirestoreRulesetFromSource(fs.readFileSync('/tmp/hibiruka-combined.rules','utf8'));
    console.log('Personal rules deployed; previous release remains in Firebase rules history.');
    fs.writeFileSync('/tmp/hibiruka-deployed-rules.json',JSON.stringify({previous:previous.name,current:result.name}));
  }else throw Error('Unknown action');
})().catch(e=>{console.error('Rules operation failed:',e.code || e.message);process.exitCode=1;});
