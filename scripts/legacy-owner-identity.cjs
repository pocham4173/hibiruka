'use strict';
// Pure preparation helper: no network, database writes or console output.
// A support number locates an account; it is NOT an authentication credential.
// Only an operator with separate authorization may use the returned UID.
const {createHash}=require('node:crypto');
function inquiryNumber(uid) {
  if(typeof uid!=='string'||!uid||uid.includes('/'))throw Error('Invalid account identifier');
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes=createHash('sha256').update('hibiruka:'+uid).digest();
  const text=Array.from(bytes.subarray(0,8),b=>alphabet[b&31]).join('');
  return text.slice(0,4)+'-'+text.slice(4);
}
function selectConfirmedOwner(ownerUids, number) {
  if(!Array.isArray(ownerUids)||!ownerUids.length)throw Error('Owner confirmation required');
  if(typeof number!=='string'||!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(number))throw Error('Support number required');
  // Do not choose the most recent writer, first account or a LINE recipient.
  const candidates=[...new Set(ownerUids)];
  const matches=candidates.filter(uid=>inquiryNumber(uid)===number);
  if(matches.length!==1)throw Error('Owner confirmation is not unique');
  return matches[0];
}
module.exports={inquiryNumber,selectConfirmedOwner};
