'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
const {inquiryNumber,selectConfirmedOwner}=require('../scripts/legacy-owner-identity.cjs');
test('support number matches the browser algorithm without exposing account contents',async()=>{
  const uid='fixture-owner-A',abc='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes=new Uint8Array(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode('hibiruka:'+uid)));
  const s=Array.from(bytes.slice(0,8),b=>abc[b&31]).join('');
  assert.equal(inquiryNumber(uid),s.slice(0,4)+'-'+s.slice(4));
});
test('only an explicitly confirmed existing owner is selected; input is unchanged',()=>{
  const uids=['fixture-owner-B','fixture-owner-A','fixture-owner-C'];
  const before=[...uids];
  assert.equal(selectConfirmedOwner(uids,inquiryNumber('fixture-owner-A')),'fixture-owner-A');
  assert.deepEqual(uids,before);
  assert.throws(()=>selectConfirmedOwner(uids,inquiryNumber('fixture-stranger')),/not unique/);
  assert.throws(()=>selectConfirmedOwner(uids,''),/required/);
});
test('invalid owner lists fail closed without including identifiers in errors',()=>{
  for(const candidates of [null,[],['private/invalid'],['valid',null]]) {
    assert.throws(()=>selectConfirmedOwner(candidates,inquiryNumber('valid')),e=>!e.message.includes('private'));
  }
  assert.equal(selectConfirmedOwner(['valid','valid'],inquiryNumber('valid')),'valid');
});
