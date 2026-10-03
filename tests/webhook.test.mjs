import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {verifySignature,handleWebhook,handleEvent,linkCodeFrom,resolveOwner} from '../line-worker/webhook.mjs';
import {firestore} from '../line-worker/firestore.mjs';
import worker from '../line-worker/index.mjs';

const SECRET='test-channel-secret';
const U='U'+'a'.repeat(32), OTHER='U'+'b'.repeat(32);
const sign=body=>createHmac('sha256',SECRET).update(body).digest('base64');
const NOW=Date.parse('2026-10-03T03:00:00Z'); // 12:00 JST

// In-memory stand-in with the same small interface the webhook uses.
function memoryDb(seed={}){
  const data=JSON.parse(JSON.stringify(seed),(k,v)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T.*Z$/.test(v)?new Date(v):v);
  const col=c=>(data[c]??={});
  const ref=(c,id)=>({id,path:c+'/'+id,get:async()=>({id,exists:id in col(c),ref:ref(c,id),data:()=>col(c)[id]})});
  const query=(c,filters=[])=>({where:(f,op,v)=>{assert.equal(op,'==');return query(c,[...filters,[f,v]]);},get:async()=>({docs:Object.entries(col(c)).filter(([,d])=>filters.every(([f,v])=>d[f]===v)).map(([id,d])=>({id,data:()=>d}))}),doc:id=>ref(c,id)});
  return {data,collection:c=>query(c),
    create:async(r,v)=>{const [c,id]=r.path.split('/');if(id in col(c)){const e=Error('exists');e.status=409;throw e;}col(c)[id]=v;},
    set:async(r,v)=>{const [c,id]=r.path.split('/');col(c)[id]=v;},
    patch:async(r,v)=>{const [c,id]=r.path.split('/');Object.assign(col(c)[id],v);},
    remove:async r=>{const [c,id]=r.path.split('/');delete col(c)[id];},
    commit:async ops=>{for(const o of ops){const [c,id]=o.ref.path.split('/');if(o.remove)delete col(c)[id];else col(c)[id]=o.value;}}};
}
const personalSeed=()=>({personalConfig:{alice:{ownerName:'A',cats:[{name:'遊び'},{name:'食事'},{name:'カフェ',label:'喫茶'}]}},lineLinkCodes:{ABCDEFGH23:{ownerUid:'alice',scope:'personal',expiresAt:new Date(NOW+300000)}}});
const linked=()=>({...personalSeed(),lineLinkCodes:{},lineAccounts:{[U]:{ownerUid:'alice',scope:'personal'}},lineLinks:{alice:{lineUserId:U}}});
const msg=(message,extra={})=>({type:'message',source:{type:'user',userId:U},replyToken:'r',webhookEventId:'01EVENTID',message,...extra});

test('signature: only LINE-signed bodies are accepted',async()=>{
  assert.equal(await verifySignature(SECRET,'{"a":1}',sign('{"a":1}')),true);
  assert.equal(await verifySignature(SECRET,'{"a":2}',sign('{"a":1}')),false);
  assert.equal(await verifySignature(SECRET,'x',''),false);
  assert.equal(await verifySignature('', 'x', sign('x')),false);
  const env={LINE_CHANNEL_SECRET:SECRET,LINE_CHANNEL_ACCESS_TOKEN:'t'};
  let opened=false;const db=async()=>{opened=true;return memoryDb();};
  const bad=await handleWebhook(new Request('https://w/line/webhook',{method:'POST',body:'{"events":[]}',headers:{'x-line-signature':'AAAA'}}),env,{db});
  assert.equal(bad.status,401);assert.equal(opened,false,'Firestore is not touched before verification');
  const ok=await handleWebhook(new Request('https://w/line/webhook',{method:'POST',body:'{"events":[]}',headers:{'x-line-signature':sign('{"events":[]}')}}),env,{db});
  assert.equal(ok.status,200);
  assert.equal((await handleWebhook(new Request('https://w/line/webhook',{method:'POST',body:'{}'}),{},{db})).status,503);
});
test('worker routes only POST /line/webhook; other paths stay 404',async()=>{
  for(const [method,path] of [['GET','/line/webhook'],['POST','/send'],['GET','/']])assert.equal((await worker.fetch(new Request('https://w'+path,{method}),{})).status,404);
});
test('link code: one-time, expiring, verified owner; replaces a previous LINE',async()=>{
  assert.equal(linkCodeFrom('ヒビルカ連携 ABCDEFGH23'),'ABCDEFGH23');
  assert.equal(linkCodeFrom('abcdefgh23'),'ABCDEFGH23');
  assert.equal(linkCodeFrom('今日は ABCDEFGH23 です'),null);
  const db=memoryDb({...personalSeed(),lineLinks:{alice:{lineUserId:OTHER}},lineAccounts:{[OTHER]:{ownerUid:'alice',scope:'personal'}}});
  const [r]=await handleEvent(db,{},msg({type:'text',text:'ヒビルカ連携 ABCDEFGH23'}),NOW);
  assert.match(r.text,/つながりました/);
  assert.deepEqual(await resolveOwner(db,U),{uid:'alice',scope:'personal'});
  assert.equal(db.data.lineAccounts[OTHER],undefined,'old LINE detached');
  assert.equal(db.data.lineLinkCodes.ABCDEFGH23,undefined,'code consumed');
  const [again]=await handleEvent(db,{},msg({type:'text',text:'ヒビルカ連携 ABCDEFGH23'}),NOW);
  assert.match(again.text,/見つかりません/);
  const expired=memoryDb({...personalSeed(),lineLinkCodes:{ABCDEFGH23:{ownerUid:'alice',scope:'personal',expiresAt:new Date(NOW-1)}}});
  assert.match((await handleEvent(expired,{},msg({type:'text',text:'ABCDEFGH23'}),NOW))[0].text,/期限/);
  assert.equal(await resolveOwner(expired,U),null);
  const missingOwner=memoryDb({lineLinkCodes:{ABCDEFGH23:{ownerUid:'ghost',scope:'personal',expiresAt:new Date(NOW+1000)}}});
  assert.match((await handleEvent(missingOwner,{},msg({type:'text',text:'ABCDEFGH23'}),NOW))[0].text,/つなげませんでした/);
});
test('unlinking in the app stops the LINE from writing',async()=>{
  const db=memoryDb(linked());delete db.data.lineLinks.alice;
  assert.equal(await resolveOwner(db,U),null);
  const [r]=await handleEvent(db,{},msg({type:'location',title:'カフェ',address:'上田市',latitude:36.4,longitude:138.2}),NOW);
  assert.match(r.text,/つなぐと/);assert.equal(Object.keys(db.data.personalEvents||{}).length,0);
});
test('location creates one private memory today; redelivery is not duplicated; category via postback',async()=>{
  const db=memoryDb(linked());
  const ev=msg({type:'location',title:'ソラノカフェ',address:'長野県上田市1-2',latitude:36.4,longitude:138.25});
  const [r]=await handleEvent(db,{},ev,NOW);
  await handleEvent(db,{},ev,NOW);
  const records=Object.entries(db.data.personalEvents);
  assert.equal(records.length,1);
  const [id,e]=records[0];
  assert.equal(e.ownerUid,'alice');assert.equal(e.date,'2026-10-03');assert.equal(e.time,'12:00');assert.equal(e.kind,'memory');
  assert.equal(e.place,'ソラノカフェ');assert.equal(e.memo,'長野県上田市1-2');assert.equal(e.cat,'遊び');assert.deepEqual(e.sends,[]);assert.equal(e.nextSendAt,null);
  assert.equal(r.quickReply.items.length,3);assert.equal(r.quickReply.items[2].action.label,'喫茶');
  const post={type:'postback',source:{type:'user',userId:U},replyToken:'r',postback:{data:r.quickReply.items[2].action.data}};
  assert.match((await handleEvent(db,{},post,NOW))[0].text,/喫茶/);
  assert.equal(db.data.personalEvents[id].cat,'カフェ');
});
test('another LINE cannot change someone else\'s record by postback',async()=>{
  const db=memoryDb({...linked(),personalConfig:{...linked().personalConfig,bob:{cats:[{name:'x'}]}},lineAccounts:{[U]:{ownerUid:'alice',scope:'personal'},[OTHER]:{ownerUid:'bob',scope:'personal'}},lineLinks:{alice:{lineUserId:U},bob:{lineUserId:OTHER}},personalEvents:{e1:{ownerUid:'alice',cat:'遊び'}}});
  const [r]=await handleEvent(db,{},{type:'postback',source:{type:'user',userId:OTHER},replyToken:'r',postback:{data:'a=cat&e=e1&c=0'}},NOW);
  assert.match(r.text,/見つかりません/);assert.equal(db.data.personalEvents.e1.cat,'遊び');
});
test('today and favorites list only the owner\'s records',async()=>{
  const db=memoryDb({...linked(),personalEvents:{a:{ownerUid:'alice',date:'2026-10-03',time:'18:00',title:'夕食',place:'駅前'},b:{ownerUid:'bob',date:'2026-10-03',title:'他人'},c:{ownerUid:'alice',date:'2026-10-03',time:'09:00',place:'朝カフェ',fav:true}}});
  const [today]=await handleEvent(db,{},msg({type:'text',text:'今日'}),NOW);
  assert.match(today.text,/09:00 朝カフェ\n18:00 夕食（駅前）/);assert.doesNotMatch(today.text,/他人/);
  assert.match((await handleEvent(db,{},msg({type:'text',text:'また行きたい'}),NOW))[0].text,/朝カフェ/);
});
test('legacy owner records go to the legacy collection',async()=>{
  const db=memoryDb({members:{rie:{pinHash:'x'}},lineLinkCodes:{ABCDEFGH23:{ownerUid:'rie',scope:'legacy',expiresAt:new Date(NOW+1000)}}});
  await handleEvent(db,{},msg({type:'text',text:'ABCDEFGH23'}),NOW);
  await handleEvent(db,{},msg({type:'location',address:'上田城跡公園',latitude:36.4,longitude:138.2}),NOW);
  const [e]=Object.values(db.data.events);assert.equal(e.place,'上田城跡公園');assert.equal(e.ownerUid,undefined);
});
test('LINE addresses drop the country and postal code for the place name',async()=>{
  const db=memoryDb(linked());
  await handleEvent(db,{},msg({type:'location',address:'日本、〒386-0013 長野県上田市中央東１１−１５',latitude:36.4,longitude:138.2}),NOW);
  const [e]=Object.values(db.data.personalEvents);
  assert.equal(e.place,'長野県上田市中央東１１−１５');assert.match(e.memo,/〒386-0013/);
});
test('strangers: plain text is ignored, contact gets an answer',async()=>{
  const db=memoryDb();
  assert.deepEqual(await handleEvent(db,{},msg({type:'text',text:'こんにちは'}),NOW),[]);
  assert.match((await handleEvent(db,{},msg({type:'text',text:'お問い合わせ'}),NOW))[0].text,/そのまま送って/);
});
test('end-to-end: signed webhook replies via the reply API only',async()=>{
  const db=memoryDb(linked());const calls=[];
  const fetcher=async(url,opt)=>{calls.push([url,JSON.parse(opt.body)]);return new Response('{}');};
  const body=JSON.stringify({events:[msg({type:'text',text:'使い方'})]});
  const res=await handleWebhook(new Request('https://w/line/webhook',{method:'POST',body,headers:{'x-line-signature':sign(body)}}),{LINE_CHANNEL_SECRET:SECRET,LINE_CHANNEL_ACCESS_TOKEN:'t'},{db:async()=>db,fetcher,now:()=>NOW});
  assert.equal(res.status,200);assert.equal(calls.length,1);assert.equal(calls[0][0],'https://api.line.me/v2/bot/message/reply');assert.equal(calls[0][1].replyToken,'r');
});
test('REST adapter: equality queries are combined and create refuses existing documents',async()=>{
  const bodies=[];const db=firestore('t',async(u,o)=>{bodies.push(JSON.parse(o.body));return new Response('[]');},20);
  await db.collection('personalEvents').where('ownerUid','==','a').where('date','==','2026-10-03').get();
  assert.equal(bodies[0].structuredQuery.where.compositeFilter.filters.length,2);assert.equal(bodies[0].structuredQuery.limit,20);
  await db.create(db.collection('personalEvents').doc('x'),{a:1});
  assert.deepEqual(bodies[1].writes[0].currentDocument,{exists:false});
});
