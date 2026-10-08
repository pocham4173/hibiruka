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
    commit:async ops=>{for(const o of ops){const [c,id]=o.ref.path.split('/');if(o.remove)delete col(c)[id];else col(c)[id]=o.value;}},
    runTransaction:async fn=>{const w=[];const r=await fn({get:x=>x.get(),set:(x,v)=>w.push([x,v]),update:(x,v)=>w.push([x,v])});for(const [x,v] of w){const [c,id]=x.path.split('/');col(c)[id]=v;}return r;}};
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
  const intro=await handleEvent(db,{},msg({type:'text',text:'また行きたい'}),NOW);
  assert.match(intro[0].altText,/おすすめ機能/);assert.equal(intro[1].quickReply.items[0].action.text,'わたしの行きたい場所');assert.doesNotMatch(JSON.stringify(intro),/朝カフェ/);
  const fav=await handleEvent(db,{},msg({type:'text',text:'わたしの行きたい場所'}),NOW);
  assert.equal(fav[0].type,'flex');assert.match(fav[1].text,/朝カフェ/);assert.doesNotMatch(JSON.stringify(fav),/他人/);assert.doesNotMatch(JSON.stringify(fav),/他人/);
});
test('今日 also shows the coming plans with how many days are left',async()=>{
  const db=memoryDb({...linked(),personalEvents:{
    a:{ownerUid:'alice',date:'2026-10-03',time:'18:00',title:'夕食'},
    b:{ownerUid:'alice',kind:'plan',date:'2026-10-04',time:'10:00',title:'歯医者'},
    c:{ownerUid:'alice',kind:'plan',date:'2026-10-10',title:'松本旅行',place:'松本城'},
    d:{ownerUid:'alice',kind:'memory',date:'2026-10-05',title:'思い出は出さない'},
    e:{ownerUid:'bob',kind:'plan',date:'2026-10-05',title:'他人'},
    f:{ownerUid:'alice',kind:'plan',date:'2026-12-01',title:'先すぎる'}}});
  const [r]=await handleEvent(db,{},msg({type:'text',text:'今日'}),NOW);
  assert.match(r.text,/📅 今日の予定・記録\n18:00 夕食/);
  assert.match(r.text,/🎉 これからの予定\n明日｜10月4日\(日\) 10:00 歯医者\nあと7日｜10月10日\(土\) 松本旅行（松本城）/);
  assert.doesNotMatch(r.text,/思い出は出さない|他人|先すぎる/);
});
test('また行きたい shows the wish list and ♥ places as cards with map and app buttons, and a guide card',async()=>{
  const db=memoryDb({...linked(),personalEvents:{
    w:{ownerUid:'alice',kind:'wish',status:'wished',place:'森のカフェ',genre:'カフェ',lat:36.4,lng:138.25,imageUrl:'https://img.example/a.jpg'},
    v:{ownerUid:'alice',kind:'wish',status:'visited',place:'行った所'},
    f:{ownerUid:'alice',fav:true,place:'上田城跡公園',cat:'遊び'}}});
  const [intro]=await handleEvent(db,{},msg({type:'text',text:'また行きたい'}),NOW);
  const [flex,list]=await handleEvent(db,{},msg({type:'text',text:'行きたいリスト'}),NOW);
  assert.equal(intro.contents.contents.length,3);assert.match(intro.contents.contents[0].hero.url,/guide\/img\/line-wish-1\.jpg$/);assert.match(JSON.stringify(intro),/おでかけコース/);
  for(const c of intro.contents.contents)assert.ok(c.footer.contents[0].action.label.length<=20);
  const cards=flex.contents.contents;assert.equal(cards.length,3);
  assert.equal(cards[0].hero.url,'https://img.example/a.jpg');assert.match(JSON.stringify(cards[0]),/📌 行きたいリスト.*森のカフェ/);
  assert.equal(cards[0].footer.contents[0].action.uri,'https://www.google.com/maps/search/?api=1&query=36.400000,138.250000');
  assert.match(JSON.stringify(cards[1]),/♥ また行きたい.*上田城跡公園/);assert.match(cards[2].footer.contents[0].action.uri,/guide\/#wish$/);
  assert.doesNotMatch(list.text,/行った所/);
  for(const c of cards)for(const b of c.footer.contents)assert.ok(b.action.label.length<=20,b.action.label);
});
test('ふりかえり of past months: words become months, and buttons offer the months before',async()=>{
  const {monthsAgoFrom}=await import('../line-worker/webhook.mjs');
  const n=Date.parse('2026-10-06T01:00:00Z');
  assert.equal(monthsAgoFrom('ふりかえり',n),0);assert.equal(monthsAgoFrom('先月',n),1);assert.equal(monthsAgoFrom('先々月のふりかえり',n),2);
  assert.equal(monthsAgoFrom('3か月前のふりかえり',n),3);assert.equal(monthsAgoFrom('8月のふりかえり',n),2);assert.equal(monthsAgoFrom('12月のふりかえり',n),10,'a later month means last year');
  assert.equal(monthsAgoFrom('2025年12月',n),10);assert.equal(monthsAgoFrom('去年の8月',n),14);
  assert.equal(monthsAgoFrom('8月',n),null,'just a month name is not a request');assert.equal(monthsAgoFrom('昨日ランチ行った',n),null);
  const db=memoryDb({...linked(),personalEvents:{a:{ownerUid:'alice',kind:'memory',date:'2026-08-15',title:'花火'}}});
  const env=aiEnv('花火がきれいだった8月。');
  const [r]=await handleEvent(db,env,msg({type:'text',text:'8月のふりかえり'}),NOW);
  assert.match(r.text,/2026年8月のふりかえり（1件）/);assert.deepEqual(r.quickReply.items.map(i=>i.action.label),['3か月前','4か月前','5か月前']);
  const [none]=await handleEvent(db,env,msg({type:'text',text:'先月のふりかえり'}),NOW);assert.match(none.text,/まだありません/);assert.ok(none.quickReply);
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
  const start=(await handleEvent(db,{},msg({type:'text',text:'お問い合わせ'}),NOW))[0];
  assert.match(start.text,/よくある質問/);assert.match(start.text,/個別のお返事はしていません/);
  assert.ok(start.quickReply.items.some(i=>i.action.data==='a=inq&c=bug'));
});
test('inquiry: pick a kind, send one message, it is saved without the LINE id; 3 a day',async()=>{
  const db=memoryDb(linked());
  const pb=c=>({type:'postback',source:{type:'user',userId:U},replyToken:'r',postback:{data:'a=inq&c='+c}});
  assert.match((await handleEvent(db,{},pb('bug'),NOW))[0].text,/どの画面で/);
  const done=(await handleEvent(db,{},msg({type:'text',text:'今日の予定が出ません'}),NOW))[0].text;
  assert.match(done,/受け付けました/);
  const [q]=Object.values(db.data.inquiries);
  assert.equal(q.kind,'bug');assert.equal(q.text,'今日の予定が出ません');assert.match(q.no,/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(JSON.stringify(q).includes(U),false,'LINEのIDは保存しない');
  // 本番（fetcher あり）では同じ内容をGoogleフォームにも届ける
  const posted=[];const ff=async(u,o)=>{posted.push([u,o.body]);return new Response('');};
  await handleEvent(db,{},pb('ad'),NOW,ff);await handleEvent(db,{},msg({type:'text',text:'PRの表示について'}),NOW,ff);
  assert.equal(posted.length,1);assert.match(posted[0][0],/formResponse$/);
  const body=new URLSearchParams(posted[0][1]);assert.equal(body.get('entry.624595342'),'広告（PR）について');assert.equal(body.get('entry.1167455955'),'PRの表示について');
  assert.equal(body.get('entry.1032165107'),'LINEから');assert.equal(body.get('entry.757516540'),'確認しました');assert.match(body.get('entry.1123677430'),/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  // 次の文はふつうの記録・返事に戻る
  assert.equal(await (async()=>{const r=await handleEvent(db,{},msg({type:'text',text:'使い方'}),NOW);return /このトークでできること/.test(r[0].text);})(),true);
  // やめる
  await handleEvent(db,{},pb('idea'),NOW);
  assert.match((await handleEvent(db,{},msg({type:'text',text:'やめる'}),NOW))[0].text,/やめました/);
  await handleEvent(db,{},pb('idea'),NOW);await handleEvent(db,{},msg({type:'text',text:'2つ目'}),NOW);
  assert.match((await handleEvent(db,{},pb('idea'),NOW))[0].text,/1日3回まで/);
  // 15分たったら待つのをやめる
  const db2=memoryDb();await handleEvent(db2,{},pb('how'),NOW);
  assert.deepEqual(await handleEvent(db2,{},msg({type:'text',text:'こんにちは'}),NOW+16*60000),[]);
  assert.equal(db2.data.inquiries,undefined);
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
    d:{ownerUid:'alice', kind:'memory', date:'2026-09-15', title:'先月の思い出'},
    e:{ownerUid:'alice', kind:'plan', date:'2026-10-02', title:'行ったか分からない予定'},
    f:{ownerUid:'alice', kind:'plan', date:'2026-10-02', title:'行った予定', outcome:'done'},
    g:{ownerUid:'alice', kind:'plan', date:'2026-10-02', title:'中止した予定', outcome:'cancelled'}}});
  const env = aiEnv('ヨガで始まった10月。');
  const [r] = await handleEvent(db, env, msg({type:'text', text:'ふりかえり'}), NOW);
  assert.match(r.text, /2026年10月のふりかえり（2件）\n\nヨガで始まった10月。/);
  const sent = env.runs[0].messages[1].content; assert.match(sent, /ヨガ/); assert.match(sent, /行った予定/); assert.doesNotMatch(sent, /他人|先の予定|先月の|分からない|中止/);
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

test('また行きたい with nothing saved still shows the recommended features and how to start', async () => {
  const [intro, t] = await handleEvent(memoryDb(linked()), {}, msg({type:'text', text:'また行きたい'}), NOW);
  assert.equal(intro.type, 'flex'); assert.equal(intro.contents.contents.length, 3); assert.match(t.text, /下のボタン/);
  const [none] = await handleEvent(memoryDb(linked()), {}, msg({type:'text', text:'わたしの行きたい場所'}), NOW);
  assert.match(none.text, /ここ行きたい/);
});
