'use strict';
// Export only the public encryption key. No private key, credential fields,
// account identifier, user data or error details leave this process.
const {createPublicKey}=require('node:crypto');
const {parseServiceAccount}=require('./service-account.cjs');
try {
  const account=parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
  if(account.project_id!=='hibiruka-f66fb')throw Error('wrong-project');
  const key=createPublicKey(account.private_key).export({type:'spki',format:'der'});
  console.log('PRIVACY_PUBLIC_ENCRYPTION_KEY '+key.toString('base64'));
} catch {console.error('Public encryption key preparation failed.');process.exitCode=1;}
