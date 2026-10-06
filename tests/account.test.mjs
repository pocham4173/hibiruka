import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deleteAccountData, inquiryNo} from '../line-worker/account.mjs';
import {toForm} from '../line-worker/inquiry.mjs';
const U='U'+'a'.repeat(32);
function memoryDb(data){
  const col=c=>(data[c]??={});
  const ref=(c,id)=>({id,path:c+'/'+id,get:async()=>({id,exists:id in col(c),ref:ref(c,id),data:()=>col(c)[id]})});
  const q=(c,f=[])=>({select:()=>q(c,f),limit:()=>q(c,f),where:(k,op,v)=>q(c,[...f,[k,v]]),doc:id=>ref(c,id),
    get:async()=>({docs:Object.entries(col(c)).filter(([,d])=>f.every(([k,v])=>d[k]===v)).map(([id])=>({id,ref:ref(c,id)}))})});
  return {data,collection:c=>q(c),commit:async ops=>{for(const o of ops){const [c,id]=o.ref.path.split('/');if(o.remove)delete col(c)[id];else col(c)[id]=o.value;}}};
}
test('delete: only my records and my LINE link go; others stay', async () => {
  const db=memoryDb({
    personalEvents:{e1:{ownerUid:'me'},e2:{ownerUid:'you'}}, personalPhotos:{p1:{ownerUid:'me'}},
    personalFriends:{f1:{ownerUid:'me'},f2:{ownerUid:'you',lineUserId:U}}, pushSubs:{s1:{ownerUid:'me'}},
    personalConfig:{me:{},you:{}}, lineLinks:{me:{lineUserId:U}}, lineAccounts:{[U]:{ownerUid:'me'}}, lineLinkCodes:{}
  });
  const r=await deleteAccountData(db,'me');
  assert.equal(r.more,false);
  assert.deepEqual(Object.keys(db.data.personalEvents),['e2']);
  assert.deepEqual(Object.keys(db.data.personalFriends),['f2']);
  assert.deepEqual(Object.keys(db.data.personalPhotos),[]);assert.deepEqual(Object.keys(db.data.pushSubs),[]);
  assert.deepEqual(Object.keys(db.data.personalConfig),['you']);
  assert.equal(db.data.lineLinks.me,undefined);assert.equal(db.data.lineAccounts[U],undefined);
});
test('inquiry number is short, stable, and does not show the id', async () => {
  const a=await inquiryNo('abc123'); assert.match(a,/^[A-Z2-9]{4}-[A-Z2-9]{4}$/); assert.equal(a,await inquiryNo('abc123')); assert.notEqual(a,await inquiryNo('abc124'));
});
test('google form: only a real form URL, only entry.N fields', async () => {
  const calls=[];const f=async(u,o)=>{calls.push([u,o.body]);return new Response('');};
  assert.equal(await toForm({text:'x'},f,{url:'https://evil.example/formResponse',entry:{text:'entry.1'}}),false);
  assert.equal(await toForm({text:'あ',kind:'k'},f,{url:'https://docs.google.com/forms/d/e/1FAIpQ/formResponse',entry:{text:'entry.12',kind:'bad'}}),true);
  assert.equal(calls.length,1);assert.equal(calls[0][1],'entry.12=%E3%81%82');
});
