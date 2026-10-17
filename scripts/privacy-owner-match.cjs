'use strict';
// User-authorized encrypted selector. All matching happens inside the runner.
// Read only; never log the decrypted support number or candidate identifiers.
const fs=require('node:fs'),crypto=require('node:crypto');
const {parseServiceAccount}=require('./service-account.cjs');
const {selectConfirmedOwner}=require('./legacy-owner-identity.cjs');
function decryptSelector(account,sealed,now=Date.now()) {
 if(account.project_id!=='hibiruka-f66fb'||sealed.algorithm!=='RSA-OAEP-SHA256')throw Error('Invalid selector');
 const target=JSON.parse(crypto.privateDecrypt({key:account.private_key,oaepHash:'sha256'},Buffer.from(sealed.ciphertext,'base64')).toString());
 if(target.version!==1||!Number.isFinite(Date.parse(target.expiresAt))||Date.parse(target.expiresAt)<=now)throw Error('Expired selector');
 return target.supportNumber;
}
async function confirmedOwner(db,account) {
 const number=decryptSelector(account,JSON.parse(fs.readFileSync('scripts/privacy-target.sealed.json','utf8')));
 const owners=await db.doc('config/owners').get();
 return {uid:selectConfirmedOwner(owners.exists?owners.data().uids:null,number),owners};
}
if(require.main===module)(async()=>{
 const admin=require('firebase-admin');
 const account=parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
 if(account.project_id!=='hibiruka-f66fb')throw Error('Wrong project');
 admin.initializeApp({credential:admin.credential.cert(account)});
 await confirmedOwner(admin.firestore(),account);
 console.log('PRIVACY_OWNER_MATCH_OK: exactly one existing owner matched; no writes.');
 await admin.app().delete();
})().catch(()=>{console.error('Private owner matching stopped safely; no details logged.');process.exitCode=1;});
module.exports={decryptSelector,confirmedOwner};
