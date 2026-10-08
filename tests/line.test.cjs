const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {generateKeyPairSync} = require('node:crypto');
const {parseServiceAccount} = require('../scripts/service-account.cjs');
const {retryKey,buildText} = require('../scripts/send-line.cjs');
const account = {type:'service_account',project_id:'hibiruka-f66fb',client_email:'test@example.invalid',private_key:generateKeyPairSync('rsa',{modulusLength:1024}).privateKey.export({type:'pkcs8',format:'pem'})};
const json = JSON.stringify(account);

test('normal, missing outer braces, fenced, encoded and base64 JSON; invalid input never leaks', () => {
  for(const value of [json,json.slice(1,-1),json.slice(1),json.slice(0,-1),'```json\n'+json+'\n```',JSON.stringify(json),Buffer.from(json).toString('base64')]) {
    assert.equal(parseServiceAccount(value).project_id,'hibiruka-f66fb');
  }
  for(const value of ['private-supersecret','{"type":"service_account"}',json.replace('BEGIN PRIVATE KEY','BROKEN SECRET')]) {
    assert.throws(()=>parseServiceAccount(value), error => !error.message.includes(value) && error.message.startsWith('FIREBASE_SERVICE_ACCOUNT'));
  }
});

test('retry key is stable for a reservation and different for another', () => {
  assert.equal(retryKey('event','send'),retryKey('event','send'));
  assert.notEqual(retryKey('event','send'),retryKey('event','other'));
  assert.match(retryKey('event','send'),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(buildText({date:'2026-09-28',title:'予定',memo:'a'.repeat(6000)},'テスト').length<=5000);
});

function fixture({lineMessage='',validate=false,status=200,accepted=false,expired=false,revoked=false,recovery=false,personal=false,foreign=false,quotaLeft=Infinity,usedThisMonth=0}={}) {
  const records={config:{app:{selfFriendId:'self'}},events:{event:{date:expired?'2020-01-01':'2099-01-01',time:'12:00',kind:'plan',title:'テストの予定',sends:[{id:'send',friendIds:['self'],at:'2020-01-01T10:00',status:'wait'}],nextSendAt:'2020-01-01T10:00'}},friends:{self:{status:revoked?'pending':'joined',lineUserId:'U'+'a'.repeat(32)},other:{status:'joined',lineUserId:'U'+'b'.repeat(32)}}};
  records.personalEvents={}; records.personalFriends={}; records.lineUsage={}; records.lineQuota={};
  const month=new Date(Date.now()+9*3600000).toISOString().slice(0,7).replace('-','');if(usedThisMonth)records.lineUsage[month+'_owner-A']={ownerUid:'owner-A',count:usedThisMonth};
  if(personal){records.personalEvents.event={...records.events.event,ownerUid:'owner-A'};records.events={};records.personalFriends.self={...records.friends.self,ownerUid:foreign?'owner-B':'owner-A'};}
  const clone=x=>structuredClone(x), calls=[];
  const ref=(collection,id)=>({id,collection,parent:{id:collection},get:async()=>snap(collection,id),set:async v=>{records[collection][id]=clone(v);}});
  const snap=(c,id)=>({id,ref:ref(c,id),exists:!!records[c][id],data:()=>clone(records[c][id])});
  const db = {
    collection: c => ({
      doc: id => ref(c,id),
      limit: () => ({get:async()=>({docs:Object.keys(records[c]).slice(0,1).map(id=>snap(c,id))})}),
      where: () => ({get:async()=>({docs:Object.keys(records[c]).map(id=>snap(c,id))})})
    }),
    runTransaction: async fn => fn({
      get:r=>Promise.resolve(snap(r.collection,r.id)),
      update:(r,data)=>Object.assign(records[r.collection][r.id],clone(data)),
      set:(r,data)=>{records[r.collection][r.id]=clone(data);}
    })
  };
  const exports={};
  const context={exports,module:{exports},require:name=>name==='firebase-admin'?{initializeApp:()=>{},credential:{cert:x=>x},firestore:()=>db}:name==='./service-account.cjs'?{parseServiceAccount}:require(name),Date,AbortSignal,console:{log:()=>{},error:()=>{}},process:{env:{FIREBASE_SERVICE_ACCOUNT:json,LINE_CHANNEL_ACCESS_TOKEN:'fake-test-token',VALIDATE_ONLY:String(validate),...(recovery?{RECOVER_SELF_AT:'2020-01-01T10:00'}:{})}},fetch:async(url,options)=>{
    if(/\/message\/quota/.test(url))return url.endsWith('/consumption')?{ok:true,json:async()=>({totalUsage:Number.isFinite(quotaLeft)?200-quotaLeft:0})}:{ok:true,json:async()=>(Number.isFinite(quotaLeft)?{type:'limited',value:200}:{type:'none'})};
    calls.push({url,options});return url.endsWith('/info')?{ok:true,json:async()=>({basicId:'@626hnkgo'})}:{ok:status===200,status,json:async()=>({message:lineMessage}),headers:new Headers(accepted?{'x-line-accepted-request-id':'accepted'}:{})};
  }};
  vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../scripts/line-engine.cjs'),'utf8'),context);
  const engine=context.module.exports, originalRequire=context.require;context.require=name=>name==='./line-engine.cjs'?engine:originalRequire(name);
  vm.runInContext(fs.readFileSync(require.resolve('../scripts/send-line.cjs'),'utf8'),context);
  return {main:context.module.exports.main,records,calls,db,engine};
}

test('validation uses real credential checks without sending or changing records',async()=>{
  const f=fixture({validate:true});const before=JSON.stringify(f.records);await f.main();
  assert.equal(f.calls.length,1);assert.ok(f.calls[0].url.endsWith('/info'));assert.equal(JSON.stringify(f.records),before);
});
test('only selected self recipient receives the scheduled payload, completed jobs never replay',async()=>{
  const f=fixture();await f.main();
  assert.deepEqual(JSON.parse(f.calls[1].options.body).to,['U'+'a'.repeat(32)]);
  assert.equal(f.records.events.event.sends[0].status,'sent');
  await f.main();assert.equal(f.calls.filter(x=>x.url.endsWith('/multicast')).length,1);
});
test('revoked and expired recipients are not sent messages',async()=>{
  for(const args of [{revoked:true},{expired:true}]) {const f=fixture(args);await f.main();assert.equal(f.calls.length,1);assert.equal(f.records.events.event.sends[0].status,'fail');}
});
test('temporary error keeps reservation; accepted retry conflict is completed',async()=>{
  const f=fixture({status:503});await f.main();assert.equal(f.records.events.event.sends[0].status,'wait');
  const g=fixture({status:409,accepted:true});await g.main();assert.equal(g.records.events.event.sends[0].status,'sent');
});
test('monthly free allowance used up: the plan is marked with a clear message and not retried; other 429s retry',async()=>{
  const f=fixture({status:429,lineMessage:'You have reached your monthly limit.'});await f.main();
  const s=f.records.events.event.sends[0];assert.equal(s.status,'fail');assert.match(s.error,/今月のLINE無料送信の枠/);
  const g=fixture({status:429,lineMessage:'Too Many Requests'});await g.main();assert.equal(g.records.events.event.sends[0].status,'wait');
});
test('LINE allowance is managed by the server: whole account, per person, refunds and partial success',async()=>{
  // 公式アカウント全体の残りが足りない → LINEに送らず理由を残す
  let f=fixture({quotaLeft:0});await f.main();
  assert.equal(f.calls.filter(x=>x.url.endsWith('/multicast')).length,0);assert.equal(f.records.events.event.sends[0].status,'fail');assert.match(f.records.events.event.sends[0].error,/全体の今月/);
  assert.equal(f.records.lineQuota.current.left,0,'画面用に全体の残りを控える');
  // 1人30通：送る前に予約。使い切っていれば送らない
  f=fixture({personal:true,usedThisMonth:30});await f.engine.runSender({db:f.db,token:'t'});
  assert.equal(f.calls.filter(x=>x.url.endsWith('/multicast')).length,0);assert.match(f.records.personalEvents.event.sends[0].error,/1人30通/);
  f=fixture({personal:true,usedThisMonth:3});await f.engine.runSender({db:f.db,token:'t'});
  const u=Object.values(f.records.lineUsage)[0];assert.equal(u.count,4,'送った1通を数える');assert.equal(f.records.personalEvents.event.sends[0].reserved,1);
  // 一時的な失敗→再送では数え直さない、最後に失敗したら戻す
  f=fixture({personal:true,status:500});await f.engine.runSender({db:f.db,token:'t'});
  assert.equal(Object.values(f.records.lineUsage)[0].count,1);const s0=f.records.personalEvents.event.sends[0];assert.equal(s0.status,'wait');
  s0.leaseUntil=0;s0.attempts=5;await f.engine.runSender({db:f.db,token:'t'});
  assert.equal(f.records.personalEvents.event.sends[0].status,'fail');assert.equal(Object.values(f.records.lineUsage)[0].count,0,'送れなかった分は戻す');
  // LINEは届いたがアプリ通知が失敗 → 送信済みでも、アプリ通知の失敗を書き添える
  f=fixture({personal:true});f.records.personalEvents.event.sends[0].friendIds=['push:self','self'];
  await f.engine.runSender({db:f.db,token:'t',push:async()=>0});
  const p=f.records.personalEvents.event.sends[0];assert.equal(p.status,'sent');assert.equal(p.pushResult,'fail');assert.match(p.error,/アプリの通知/);
  // アプリ通知は届いたがLINEが失敗 → 失敗、アプリ通知は届いたと分かる
  f=fixture({personal:true,status:400});f.records.personalEvents.event.sends[0].friendIds=['push:self','self'];
  await f.engine.runSender({db:f.db,token:'t',push:async()=>1});
  assert.equal(f.records.personalEvents.event.sends[0].status,'fail');assert.equal(f.records.personalEvents.event.sends[0].pushResult,'ok');
});
test('app notification: push:self goes to the owner devices without LINE; mixed sends use both; failure is explained',async()=>{
  let f=fixture({personal:true});f.records.personalEvents.event.sends[0].friendIds=['push:self'];f.records.personalEvents.event.sends[0].note='傘を忘れずに';
  const got=[];await f.engine.runSender({db:f.db,token:'t',push:async(uid,msg)=>{got.push([uid,msg]);return 1;}});
  assert.equal(got.length,1);assert.equal(got[0][0],'owner-A');assert.match(got[0][1].title,/テストの予定/);assert.match(got[0][1].body,/💬 傘を忘れずに/);assert.doesNotMatch(got[0][1].body,/ヒビルカより|予定のお知らせ/);
  assert.equal(f.calls.filter(x=>x.url.endsWith('/multicast')).length,0,'no LINE message used');assert.equal(f.records.personalEvents.event.sends[0].status,'sent');
  f=fixture({personal:true});f.records.personalEvents.event.sends[0].friendIds=['push:self'];
  await f.engine.runSender({db:f.db,token:'t',push:async()=>0});assert.equal(f.records.personalEvents.event.sends[0].status,'fail');assert.match(f.records.personalEvents.event.sends[0].error,/アプリの通知/);
  f=fixture({personal:true});f.records.personalEvents.event.sends[0].friendIds=['push:self','self'];let n=0;
  await f.engine.runSender({db:f.db,token:'t',push:async()=>{n++;return 1;}});assert.equal(n,1);assert.equal(f.calls.filter(x=>x.url.endsWith('/multicast')).length,1);assert.equal(f.records.personalEvents.event.sends[0].status,'sent');
  f=fixture({personal:true});f.records.personalEvents.event.sends[0].friendIds=['push:self'];
  await f.engine.runSender({db:f.db,token:'t'});assert.equal(f.records.personalEvents.event.sends[0].status,'wait','a sender without push leaves it for the one that can');
});
test('all app scripts parse and install manifest is scoped to the GitHub app',()=>{
  const html=fs.readFileSync('index/index/index.html','utf8');
  for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) if(m[1].trim())new vm.Script(m[1]);
  const manifest=JSON.parse(fs.readFileSync('index/index/manifest.webmanifest','utf8'));
  assert.equal(manifest.start_url,'./');assert.equal(manifest.scope,'./');
  for(const icon of manifest.icons)assert.ok(fs.existsSync('index/index/'+icon.src));
  new vm.Script(fs.readFileSync('index/index/install.js','utf8'));
});

test('recovery only retries the verified self and exact reservation; never other recipients', async()=>{
  const f=fixture({recovery:true});
  f.records.events.event.sends.push({id:'other',friendIds:['other'],at:'2020-01-01T10:00',status:'wait'});
  f.records.events.event.sends.push({id:'later',friendIds:['self'],at:'2020-01-02T10:00',status:'wait'});
  await f.main();
  assert.equal(f.records.events.event.sends[0].status,'sent');
  assert.equal(f.records.events.event.sends[1].status,'wait');
  assert.equal(f.records.events.event.sends[2].status,'wait');
  const g=fixture({recovery:true});g.records.friends.self.status='pending';
  await assert.rejects(g.main());assert.equal(g.calls.length,1);
});

test('personal reminders resolve only that owner’s approved friends and isolate retry keys',async()=>{
  const personal=fixture({personal:true});await personal.main();assert.equal(personal.records.personalEvents.event.sends[0].status,'sent');
  const legacy=fixture();await legacy.main();assert.notEqual(personal.calls[1].options.headers['X-Line-Retry-Key'],legacy.calls[1].options.headers['X-Line-Retry-Key']);
  const foreign=fixture({personal:true,foreign:true});await foreign.main();assert.equal(foreign.calls.length,1);assert.equal(foreign.records.personalEvents.event.sends[0].status,'fail');
});

// The independent scheduler and the GitHub fallback use the same leases.
test('an existing sender lease blocks a concurrent runner until expiration',async()=>{
 const f=fixture();f.records.events.event.sends[0].leaseUntil=Date.now()+180000;
 await f.main();assert.equal(f.calls.length,1);
 f.records.events.event.sends[0].leaseUntil=Date.now()-1;
 await f.main();assert.equal(f.calls.filter(x=>x.url.endsWith('/multicast')).length,1);
});

test('malformed reservations cannot stop a different owner’s valid notification',async()=>{
 const f=fixture({personal:true});
 f.records.events.bad={date:'2099-01-01',kind:'plan',sends:{broken:true},nextSendAt:'2000-01-01T00:00'};
 f.records.events.badItems={date:'2099-01-01',kind:'plan',sends:[null,{id:'broken',status:'wait',at:'bad',friendIds:{}}],nextSendAt:'2000-01-01T00:00'};
 await f.main();
 assert.equal(f.records.events.bad.nextSendAt,null);
 assert.equal(f.records.events.badItems.nextSendAt,null);
 assert.equal(f.records.personalEvents.event.sends[0].status,'sent');
});
test('a short scheduler delay does not discard an at-event reminder',async()=>{
 const f=fixture();const jst=new Date(Date.now()+9*3600000-2*60000).toISOString().slice(0,16);
 f.records.events.event.date=jst.slice(0,10);f.records.events.event.time=jst.slice(11);
 f.records.events.event.sends[0].at=jst;
 await f.main();assert.equal(f.records.events.event.sends[0].status,'sent');
});

test('an optional one-line message from the sender is added before the sign-off, cleaned and clipped', () => {
  const text = buildText({date:'2026-10-06',time:'09:00',title:'遊び',place:'信州医療センター'},'川村理絵','  楽しみにしてるね！\u0007\n\n\n10分前に着くよ ');
  assert.match(text, /📍 信州医療センター\n\n💬 楽しみにしてるね！\n10分前に着くよ\n\nヒビルカより$/);
  assert.doesNotMatch(buildText({date:'2026-10-06',title:'遊び'},'理絵'), /💬/);
  assert.doesNotMatch(buildText({date:'2026-10-06',title:'遊び'},'理絵','   '), /💬/);
  assert.equal(buildText({date:'2026-10-06',title:'遊び'},'理絵','あ'.repeat(300)).match(/💬 (あ+)/)[1].length, 100);
});
