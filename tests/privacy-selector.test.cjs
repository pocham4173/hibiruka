const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {decryptSelector}=require('../scripts/privacy-owner-match.cjs');
test('encrypted selector accepts only the intended key, project and unexpired payload',()=>{
 const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 const account={project_id:'hibiruka-f66fb',private_key:privateKey};
 const seal=payload=>({algorithm:'RSA-OAEP-SHA256',ciphertext:crypto.publicEncrypt({key:publicKey,oaepHash:'sha256'},Buffer.from(JSON.stringify(payload))).toString('base64')});
 const data={version:1,supportNumber:'ABCD-EFGH',expiresAt:'2030-01-01T00:00:00Z'},sealed=seal(data),now=Date.parse('2026-10-17');
 assert.equal(decryptSelector(account,sealed,now),'ABCD-EFGH');
 assert(!JSON.stringify(sealed).includes('ABCD-EFGH'));
 assert.throws(()=>decryptSelector({...account,project_id:'wrong'},sealed,now));
 assert.throws(()=>decryptSelector(account,sealed,Date.parse('2030-01-02')));
 assert.throws(()=>decryptSelector(account,seal({...data,expiresAt:'invalid'}),now));
 assert.throws(()=>decryptSelector(account,seal({...data,version:2}),now));
 assert.throws(()=>decryptSelector(account,{...sealed,ciphertext:'invalid'},now));
 const other=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 assert.throws(()=>decryptSelector({...account,private_key:other.privateKey},sealed,now));
});
