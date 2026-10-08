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
test('LINE inquiry goes to the real form with plain option text', async () => {
  const {FORM, KINDS}=await import('../line-worker/inquiry.mjs');
  assert.match(FORM.url,/^https:\/\/docs\.google\.com\/forms\/d\/e\/[\w-]+\/formResponse$/);
  for(const v of Object.values(FORM.entry))assert.match(v,/^entry\.\d+$/);
  assert.deepEqual(Object.values(KINDS).map(k=>k.replace(/^\S+\s/,'')),['不具合（うまく動かない）','使い方がわからない','ご意見・ほしい機能','広告（PR）について','その他']);
});
test('firestore transaction set: creates only if still missing, updates only if unchanged', async () => {
  const {firestore}=await import('../line-worker/firestore.mjs');
  const bodies=[];let exists=false;
  const f=async(url,opt)=>{if(opt?.body){bodies.push(JSON.parse(opt.body));return new Response('{}');}return exists?new Response(JSON.stringify({name:'x/lineUsage/a',fields:{count:{integerValue:'2'}},updateTime:'2026-10-08T00:00:00Z'})):new Response('',{status:404});};
  const db=firestore('t',f,4);const ref=db.collection('lineUsage').doc('a');
  await db.runTransaction(async tx=>{await tx.get(ref);tx.set(ref,{count:1});});
  assert.deepEqual(bodies[0].writes[0].currentDocument,{exists:false});
  exists=true;await db.runTransaction(async tx=>{const s=await tx.get(ref);tx.set(ref,{count:s.data().count+1});});
  assert.deepEqual(bodies[1].writes[0].currentDocument,{updateTime:'2026-10-08T00:00:00Z'});assert.equal(bodies[1].writes[0].update.fields.count.integerValue,'3');
});
test('AI quota under 25 requests at once: every allowed request is counted, never more than the daily limit', async () => {
  const {firestore}=await import('../line-worker/firestore.mjs');
  const {takeQuota,PER_USER_DAILY}=await import('../line-worker/ai.mjs');
  // 本物の Firestore REST に近い偽物：読むと updateTime、書くときに前提条件（存在しない／同じ updateTime）を確かめる
  const store=new Map();let clock=0;const wait=()=>new Promise(r=>setTimeout(r,Math.random()*15));
  const fetcher=async(url,opt)=>{
    await wait();
    const path=decodeURIComponent(url.split('/documents/')[1]||'');
    if(!opt?.body){const d=store.get(path);return d?new Response(JSON.stringify({name:'x/'+path,fields:d.fields,updateTime:d.t})):new Response('',{status:404});}
    const {writes}=JSON.parse(opt.body);
    for(const w of writes){const p=w.update.name.split('/documents/')[1],d=store.get(p),pre=w.currentDocument||{};
      if(pre.exists===false&&d)return new Response(JSON.stringify({error:{status:'ALREADY_EXISTS'}}),{status:409});
      if(pre.updateTime&&(!d||d.t!==pre.updateTime))return new Response(JSON.stringify({error:{status:'FAILED_PRECONDITION'}}),{status:400});}
    for(const w of writes){const p=w.update.name.split('/documents/')[1];store.set(p,{fields:w.update.fields,t:'t'+(++clock)});}
    return new Response('{}');
  };
  const db=firestore('tok',fetcher,4);const NOW=Date.parse('2026-10-08T03:00:00Z');
  const results=await Promise.all(Array.from({length:25},()=>takeQuota(firestore('tok',fetcher,4),'alice',NOW)));
  const ok=results.filter(r=>r.ok).length;
  const mine=[...store.entries()].find(([k])=>k.startsWith('aiUsage/')&&k.endsWith('_alice'));
  const counted=mine?Number(mine[1].fields.count.integerValue):0;
  assert.equal(counted,ok,'許可した数＝数えた数');assert.ok(ok<=PER_USER_DAILY);assert.ok(ok>=1);
  console.log('# parallel ok', ok, 'counted', counted);void db;
});
