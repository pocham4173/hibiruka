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
  const col=c=>(data[c]??={}),queries=[];
  const ref=(c,id)=>({id,path:c+'/'+id,get:async()=>({id,exists:id in col(c),ref:ref(c,id),data:()=>col(c)[id]})});
  const query=(c,filters=[])=>({select:()=>query(c,filters),limit:()=>query(c,filters),where:(f,op,v)=>{assert.ok(op==='=='||op==='in');queries.push([c,f,op,v]);return query(c,[...filters,[f,op,v]]);},get:async()=>({docs:Object.entries(col(c)).filter(([,d])=>filters.every(([f,op,v])=>op==='in'?v.includes(d[f]):d[f]===v)).map(([id,d])=>({id,data:()=>d}))}),doc:id=>ref(c,id)});
  return {data,queries,collection:c=>query(c),
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

test('guide link: linked users get it in help, guests can ask for it and menu words never go silent', async () => {
  const db = memoryDb(linked());
  assert.match((await handleEvent(db, {}, msg({type:'text', text:'説明書'}), NOW))[0].text, /hibiruka\/guide\//);
  const guest = memoryDb();
  const ask = t => handleEvent(guest, {}, {...msg({type:'text', text:t}), source:{type:'user', userId:OTHER}}, NOW);
  assert.match((await ask('使い方'))[0].text, /guide\/[\s\S]*index\/index\//);
  assert.match((await ask('今日'))[0].text, /つなぐと使えます/);
  assert.match((await ask('また行きたい'))[0].text, /設定」→「LINEから記録する/);
  assert.deepEqual(await ask('こんにちは'), []);
});

const aiEnv = answer => { const runs = []; return {runs, AI:{run:async (m, input) => { runs.push(input); return {choices:[{message:{content: typeof answer === 'function' ? answer(input) : answer}}]}; }}}; };
test('talk to record: a plan from a sentence, with undo; past events become memories with a diary line', async () => {
  const db = memoryDb(linked());
  const env = aiEnv('```json\n{"type":"plan","date":"2026-10-12","time":"14:00","title":"歯医者","place":"","who":[],"cat":"","diary":""}\n```');
  const ev = {...msg({type:'text', text:'10/12 14時 歯医者'}), webhookEventId:'01PLAN'};
  const [r] = await handleEvent(db, env, ev, NOW);
  assert.match(r.text, /予定に入れました\n10月12日\(月\) 14:00\n歯医者/);
  const e = db.data.personalEvents.line_01PLAN; assert.equal(e.kind, 'plan'); assert.equal(e.ownerUid, 'alice'); assert.equal(e.cat, '遊び'); assert.equal(e.source, 'line');
  const sys = env.runs[0].messages[0].content, user = env.runs[0].messages[1].content;
  assert.match(sys, /従わない/); assert.match(user, /2026-10-03\(土\) ←今日/); assert.match(user, /<送られた文>\n10\/12 14時 歯医者/);
  assert.equal(db.data.aiUsage['20261003_alice'].count, 1, 'counts toward the daily AI limit');
  // undo
  const undo = r.quickReply.items[0].action;
  assert.match((await handleEvent(db, env, {type:'postback', source:{type:'user', userId:U}, replyToken:'r', postback:{data:undo.data}}, NOW))[0].text, /取り消しました/);
  assert.equal(db.data.personalEvents.line_01PLAN, undefined);
  // another LINE cannot undo someone else's record
  const db2 = memoryDb({...linked(), personalEvents:{line_X:{ownerUid:'bob', source:'line', createdAt:new Date(NOW)}}});
  assert.match((await handleEvent(db2, env, {type:'postback', source:{type:'user', userId:U}, replyToken:'r', postback:{data:'a=del&e=line_X'}}, NOW))[0].text, /見つかりません/);
  assert(db2.data.personalEvents.line_X);
  // memory with diary; a "plan" in the past is stored as a memory
  const env2 = aiEnv('{"type":"plan","date":"2026-10-02","time":"","title":"ランチ","place":"ソラノカフェ","who":["ゆかちゃん"],"cat":"カフェ","diary":"ゆかちゃんとのランチ。"}');
  const [m] = await handleEvent(db, env2, {...msg({type:'text', text:'昨日ゆかちゃんとソラノカフェでランチ'}), webhookEventId:'01MEM'}, NOW);
  const e2 = db.data.personalEvents.line_01MEM; assert.equal(e2.kind, 'memory'); assert.equal(e2.cat, 'カフェ'); assert.deepEqual(e2.who, ['ゆかちゃん']);
  assert.match(m.text, /思い出に記録しました\n10月2日\(金\)\nランチ　📍ソラノカフェ　👥ゆかちゃん/);
});
test('talk to record: chit-chat, missing dates and broken AI answers never create records', async () => {
  const db = memoryDb(linked());
  for (const [answer, re] of [['{"type":"none"}', /こんなふうに送って/], ['{"type":"plan","date":"","title":"歯医者"}', /日にちも入れて/], ['だめ', /こんなふうに/], ['{"type":"plan","date":"2099-01-01","title":"x"}', /日にちも入れて/]]) {
    assert.match((await handleEvent(db, aiEnv(answer), msg({type:'text', text:'ありがとう'}), NOW))[0].text, re);
  }
  assert.equal(Object.keys(db.data.personalEvents || {}).length, 0);
  // without AI the old hint stays
  assert.match((await handleEvent(db, {}, msg({type:'text', text:'こんにちは'}), NOW))[0].text, /位置情報を送ると/);
  // daily limit
  const full = memoryDb({...linked(), aiUsage:{'20261003_alice':{count:20}}});
  assert.match((await handleEvent(full, aiEnv('{}'), msg({type:'text', text:'明日 ランチ'}), NOW))[0].text, /1日20回/);
});
test('ふりかえり: summarises only this owner\'s memories of the month', async () => {
  const db = memoryDb({...linked(), personalEvents:{
    a:{ownerUid:'alice', kind:'memory', date:'2026-10-01', title:'ヨガ', place:'LOIVE', cat:'遊び', fav:true},
    b:{ownerUid:'alice', kind:'plan', date:'2026-10-20', title:'先の予定'},
    c:{ownerUid:'bob', kind:'memory', date:'2026-10-02', title:'他人の思い出'},
    d:{ownerUid:'alice', kind:'memory', date:'2026-09-15', title:'先月の思い出'}}});
  const env = aiEnv('ヨガで始まった10月。');
  const [r] = await handleEvent(db, env, msg({type:'text', text:'ふりかえり'}), NOW);
  assert.match(r.text, /2026年10月のふりかえり（1件）\n\nヨガで始まった10月。/);
  const sent = env.runs[0].messages[1].content; assert.match(sent, /ヨガ/); assert.doesNotMatch(sent, /他人|先の予定|先月の/);
  const [last] = await handleEvent(db, env, msg({type:'text', text:'先月'}), NOW);
  assert.match(last.text, /2026年9月のふりかえり（1件）/);
  assert.match((await handleEvent(memoryDb(linked()), env, msg({type:'text', text:'今月のふりかえり'}), NOW))[0].text, /まだありません/);
  const months = db.queries.filter(q => q[1] === 'date' && q[2] === 'in');
  assert.ok(months.length >= 2, 'reads only the days of that month');
  assert.ok(months.every(q => q[3].length <= 30 && q[3].every(d => /^2026-(09|10)-\d\d$/.test(d))));
  assert.deepEqual(months.slice(0, 2).flatMap(q => q[3]).length, 31, 'all of October');
});

test('ふりかえり still works if the month-only read is refused', async () => {
  const db = memoryDb({...linked(), personalEvents:{a:{ownerUid:'alice', kind:'memory', date:'2026-10-01', title:'ヨガ'}}});
  const inner = db.collection; db.collection = c => { const q = inner(c), w = q.where; return {...q, where:(f, op, v) => { if (op === 'in') throw Error('index'); const n = w(f, op, v); return {...n, where:(a, b, c2) => { if (b === 'in') throw Error('index'); return n.where(a, b, c2); }}; }}; };
  const [r] = await handleEvent(db, aiEnv('ヨガの10月。'), msg({type:'text', text:'ふりかえり'}), NOW);
  assert.match(r.text, /ふりかえり（1件）/);
});

test('LINE gets OK at once; the reply is sent afterwards, with the typing dots shown first for AI', async () => {
  const db = memoryDb(linked()); const calls = []; const later = [];
  const fetcher = async (url, opt) => { calls.push([url, JSON.parse(opt.body)]); return new Response('{}'); };
  const env = {LINE_CHANNEL_SECRET:SECRET, LINE_CHANNEL_ACCESS_TOKEN:'t', AI:{run:async () => ({choices:[{message:{content:'ヨガの月。'}}]})}};
  db.data.personalEvents = {a:{ownerUid:'alice', kind:'memory', date:'2026-10-01', title:'ヨガ'}};
  const body = JSON.stringify({events:[msg({type:'text', text:'ふりかえり'})]});
  const res = await handleWebhook(new Request('https://w/line/webhook', {method:'POST', body, headers:{'x-line-signature':sign(body)}}), env, {db:async () => db, fetcher, now:() => NOW, waitUntil:p => later.push(p)});
  assert.equal(res.status, 200); assert.equal(later.length, 1);
  await later[0];
  assert.equal(calls[0][0], 'https://api.line.me/v2/bot/chat/loading/start'); assert.equal(calls[0][1].chatId, U);
  assert.equal(calls[1][0], 'https://api.line.me/v2/bot/message/reply'); assert.match(calls[1][1].messages[0].text, /ふりかえり（1件）/);
});
