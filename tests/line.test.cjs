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

function fixture({validate=false,status=200,accepted=false,expired=false,revoked=false,recovery=false,personal=false,foreign=false}={}) {
  const records={config:{app:{selfFriendId:'self'}},events:{event:{date:expired?'2020-01-01':'2099-01-01',time:'12:00',kind:'plan',title:'テストの予定',sends:[{id:'send',friendIds:['self'],at:'2020-01-01T10:00',status:'wait'}],nextSendAt:'2020-01-01T10:00'}},friends:{self:{status:revoked?'pending':'joined',lineUserId:'U'+'a'.repeat(32)},other:{status:'joined',lineUserId:'U'+'b'.repeat(32)}}};
  records.personalEvents={}; records.personalFriends={};
  if(personal){records.personalEvents.event={...records.events.event,ownerUid:'owner-A'};records.events={};records.personalFriends.self={...records.friends.self,ownerUid:foreign?'owner-B':'owner-A'};}
  const clone=x=>structuredClone(x), calls=[];
  const ref=(collection,id)=>({id,collection,parent:{id:collection},get:async()=>snap(collection,id)});
  const snap=(c,id)=>({id,ref:ref(c,id),exists:!!records[c][id],data:()=>clone(records[c][id])});
  const db = {
    collection: c => ({
      doc: id => ref(c,id),
      limit: () => ({get:async()=>({docs:Object.keys(records[c]).slice(0,1).map(id=>snap(c,id))})}),
      where: () => ({get:async()=>({docs:Object.keys(records[c]).map(id=>snap(c,id))})})
    }),
    runTransaction: async fn => fn({
      get:r=>Promise.resolve(snap(r.collection,r.id)),
      update:(r,data)=>Object.assign(records[r.collection][r.id],clone(data))
    })
  };
  const exports={};
  const context={exports,module:{exports},require:name=>name==='firebase-admin'?{initializeApp:()=>{},credential:{cert:x=>x},firestore:()=>db}:name==='./service-account.cjs'?{parseServiceAccount}:require(name),Date,AbortSignal,console:{log:()=>{},error:()=>{}},process:{env:{FIREBASE_SERVICE_ACCOUNT:json,LINE_CHANNEL_ACCESS_TOKEN:'fake-test-token',VALIDATE_ONLY:String(validate),...(recovery?{RECOVER_SELF_AT:'2020-01-01T10:00'}:{})}},fetch:async(url,options)=>{
    calls.push({url,options});return url.endsWith('/info')?{ok:true,json:async()=>({basicId:'@626hnkgo'})}:{ok:status===200,status,headers:new Headers(accepted?{'x-line-accepted-request-id':'accepted'}:{})};
  }};
  vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../scripts/line-engine.cjs'),'utf8'),context);
  const engine=context.module.exports, originalRequire=context.require;context.require=name=>name==='./line-engine.cjs'?engine:originalRequire(name);
  vm.runInContext(fs.readFileSync(require.resolve('../scripts/send-line.cjs'),'utf8'),context);
  return {main:context.module.exports.main,records,calls};
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
