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

function fixture({onSend=null,lineMessage='',validate=false,status=200,accepted=false,expired=false,revoked=false,recovery=false,personal=false,foreign=false,quotaLeft=Infinity,usedThisMonth=0}={}) {
  const records={config:{app:{selfFriendId:'self'}},events:{event:{date:expired?'2020-01-01':'2099-01-01',time:'12:00',kind:'plan',title:'テストの予定',sends:[{id:'send',friendIds:['self'],at:'2020-01-01T10:00',status:'wait'}],nextSendAt:'2020-01-01T10:00'}},friends:{self:{status:revoked?'pending':'joined',lineUserId:'U'+'a'.repeat(32)},other:{status:'joined',lineUserId:'U'+'b'.repeat(32)}}};
  records.personalEvents={}; records.personalFriends={}; records.lineUsage={}; records.lineQuota={}; records.sendLedger={};
  const month=new Date(Date.now()+9*3600000).toISOString().slice(0,7).replace('-','');if(usedThisMonth)records.lineUsage[month+'_owner-A']={ownerUid:'owner-A',count:usedThisMonth};
  if(personal){records.personalEvents.event={...records.events.event,ownerUid:'owner-A'};records.events={};records.personalFriends.self={...records.friends.self,ownerUid:foreign?'owner-B':'owner-A'};}
  const clone=x=>x===undefined?undefined:structuredClone(x), calls=[], versions=new Map();
  const col=c=>(records[c] ||= {});
  const ver=(c,id)=>versions.get(c+'/'+id)||0, bump=(c,id)=>versions.set(c+'/'+id,ver(c,id)+1);
  const ref=(collection,id)=>({id,collection,parent:{id:collection},get:async()=>snap(collection,id),set:async v=>{col(collection)[id]=clone(v);bump(collection,id);}});
  const snap=(c,id)=>({id,ref:ref(c,id),exists:!!col(c)[id],data:()=>clone(col(c)[id])});
  const query=(c,filters=[],n=Infinity)=>({
    where:(field,op,value)=>query(c,[...filters,[field,op,value]],n), limit:k=>query(c,filters,Math.min(n,k)),
    get:async()=>({docs:Object.keys(col(c)).filter(id=>filters.every(([f,op,v])=>{const x=col(c)[id][f];return op==='=='?x===v:op==='<='?(x!=null&&x<=v):op==='!='?x!==v:true;})).slice(0,n).map(id=>snap(c,id))})
  });
  // 本物に近いトランザクション：読んだ文書が途中で書き換わっていたら、全部やり直す（同時実行の検査用）
  const db = {
    collection: c => ({doc: id => ref(c,id), ...query(c)}),
    runTransaction: async fn => {
      for(let attempt=0;attempt<20;attempt++){
        const read=new Map(), writes=[];
        const out=await fn({
          get:async r=>{read.set(r.collection+'/'+r.id,ver(r.collection,r.id));await new Promise(res=>setImmediate(res));return snap(r.collection,r.id);},
          update:(r,data)=>writes.push(()=>{Object.assign(col(r.collection)[r.id],clone(data));bump(r.collection,r.id);}),
          set:(r,data)=>writes.push(()=>{col(r.collection)[r.id]=clone(data);bump(r.collection,r.id);})
        });
        if([...read].every(([k,v])=>(versions.get(k)||0)===v)){writes.forEach(w=>w());return out;}
      }
      throw Error('transaction contention');
    }
  };
  // LINEの返事：数字なら毎回同じ、配列なら順番に（最後の値を繰り返す）
  const statuses=Array.isArray(status)?status:[status]; let multicasts=0;
  const exports={};
  const context={exports,module:{exports},require:name=>name==='firebase-admin'?{initializeApp:()=>{},credential:{cert:x=>x},firestore:()=>db}:name==='./service-account.cjs'?{parseServiceAccount}:require(name),Date,AbortSignal,console:{log:()=>{},error:()=>{}},process:{env:{FIREBASE_SERVICE_ACCOUNT:json,LINE_CHANNEL_ACCESS_TOKEN:'fake-test-token',VALIDATE_ONLY:String(validate),...(recovery?{RECOVER_SELF_AT:'2020-01-01T10:00'}:{})}},fetch:async(url,options)=>{
    if(/\/message\/quota/.test(url))return url.endsWith('/consumption')?{ok:true,json:async()=>({totalUsage:Number.isFinite(quotaLeft)?200-quotaLeft:0})}:{ok:true,json:async()=>(Number.isFinite(quotaLeft)?{type:'limited',value:200}:{type:'none'})};
    calls.push({url,options});
    if(url.endsWith('/info'))return {ok:true,json:async()=>({basicId:'@626hnkgo'})};
    const st=statuses[Math.min(multicasts++,statuses.length-1)];
    if(onSend)await onSend(records);
    if(st==='network')throw new TypeError('fetch failed');
    return {ok:st===200,status:st,json:async()=>({message:lineMessage}),headers:new Headers(accepted||st===409?{'x-line-accepted-request-id':'accepted'}:{})};
  }};
  vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../scripts/line-engine.cjs'),'utf8'),context);
  const engine=context.module.exports, originalRequire=context.require;context.require=name=>name==='./line-engine.cjs'?engine:originalRequire(name);
  vm.runInContext(fs.readFileSync(require.resolve('../scripts/send-line.cjs'),'utf8'),context);
  const ledger=()=>Object.values(records.sendLedger)[0];
  const usage=()=>Object.values(records.lineUsage)[0]?.count;
  const hold=()=>records.lineQuota['hold_'+month]?.count||0;
  const multicastCount=()=>calls.filter(x=>x.url.endsWith('/multicast')).length;
  const expireLease=()=>{for(const l of Object.values(records.sendLedger))l.leaseUntil=0;};
  return {main:context.module.exports.main,records,calls,db,engine,ledger,usage,hold,multicastCount,expireLease,month};
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
  assert.equal(f.multicastCount(),0);assert.equal(f.records.events.event.sends[0].status,'fail');assert.match(f.records.events.event.sends[0].error,/全体の今月/);
  assert.equal(f.records.lineQuota.current.left,0,'画面用に全体の残りを控える');
  // 1人30通：送る前に確保。使い切っていれば送らない
  f=fixture({personal:true,usedThisMonth:30});await f.engine.runSender({db:f.db,token:'t'});
  assert.equal(f.multicastCount(),0);assert.match(f.records.personalEvents.event.sends[0].error,/1人30通/);
  f=fixture({personal:true,usedThisMonth:3});await f.engine.runSender({db:f.db,token:'t'});
  assert.equal(f.usage(),4,'送った1通を数える');assert.equal(f.ledger().lineCount,1);assert.equal(f.ledger().lineState,'sent');
  assert.equal('reserved' in f.records.personalEvents.event.sends[0],false,'確保数は利用者の行に置かない');assert.equal(f.hold(),0,'確定したら予約枠から外す');
  // はっきり断られた一時エラー（429）→ 再送では数え直さない、最後まで送れなければ戻す
  f=fixture({personal:true,status:429,lineMessage:'Too Many Requests'});
  for(let i=0;i<5;i++){await f.engine.runSender({db:f.db,token:'t'});f.expireLease();}
  assert.equal(f.multicastCount(),5);assert.equal(f.records.personalEvents.event.sends[0].status,'fail');assert.equal(f.usage(),0,'送れなかった分は戻す');assert.equal(f.hold(),0);
  // 送れたか分からない失敗（500・通信断）が最後まで続いた → 個人の数は戻さない（予約枠だけ外す）
  f=fixture({personal:true,status:500});
  for(let i=0;i<5;i++){await f.engine.runSender({db:f.db,token:'t'});f.expireLease();}
  assert.equal(f.usage(),1,'結果が分からない分は返さない');assert.equal(f.hold(),0);assert.equal(f.records.personalEvents.event.sends[0].lineResult,'unknown');
  assert.match(f.records.personalEvents.event.sends[0].error,/分かりません/);
  // LINEは送れたがアプリ通知が失敗 → 「一部」とし、アプリ通知の失敗を書き添える
  f=fixture({personal:true});f.records.personalEvents.event.sends[0].friendIds=['push:self','self'];
  for(let i=0;i<3;i++){await f.engine.runSender({db:f.db,token:'t',push:async()=>0});f.expireLease();}
  let p=f.records.personalEvents.event.sends[0];assert.equal(p.status,'partial');assert.equal(p.lineResult,'sent');assert.equal(p.pushResult,'fail');assert.match(p.error,/アプリ通知を送れません/);
  assert.equal(f.multicastCount(),1,'アプリ通知の再試行でLINEは重ねて送らない');
  // アプリ通知は送信処理成功・LINEは断られた → 「一部」、どちらか分かる
  f=fixture({personal:true,status:400});f.records.personalEvents.event.sends[0].friendIds=['push:self','self'];
  await f.engine.runSender({db:f.db,token:'t',push:async()=>1});
  p=f.records.personalEvents.event.sends[0];assert.equal(p.status,'partial');assert.equal(p.pushResult,'ok');assert.equal(p.lineResult,'rejected');assert.equal(f.usage(),0,'断られたLINEの分は戻す');
});
test('app notification: push:self goes to the owner devices without LINE; mixed sends use both; failure is explained',async()=>{
  let f=fixture({personal:true});f.records.personalEvents.event.sends[0].friendIds=['push:self'];f.records.personalEvents.event.sends[0].note='傘を忘れずに';
  const got=[];await f.engine.runSender({db:f.db,token:'t',push:async(uid,msg)=>{got.push([uid,msg]);return 1;}});
  assert.equal(got.length,1);assert.equal(got[0][0],'owner-A');assert.match(got[0][1].title,/テストの予定/);assert.match(got[0][1].body,/💬 傘を忘れずに/);assert.doesNotMatch(got[0][1].body,/ヒビルカより|予定のお知らせ/);
  assert.equal(f.multicastCount(),0,'no LINE message used');assert.equal(f.records.personalEvents.event.sends[0].status,'sent');assert.equal(f.usage(),undefined,'アプリ通知は通数を使わない');
  f=fixture({personal:true});f.records.personalEvents.event.sends[0].friendIds=['push:self'];
  for(let i=0;i<4;i++){await f.engine.runSender({db:f.db,token:'t',push:async()=>0});f.expireLease();}
  assert.equal(f.records.personalEvents.event.sends[0].status,'fail');assert.match(f.records.personalEvents.event.sends[0].error,/アプリ通知/);assert.equal(f.ledger().pushTries,3,'3回まで');
  f=fixture({personal:true});f.records.personalEvents.event.sends[0].friendIds=['push:self','self'];let n=0;
  await f.engine.runSender({db:f.db,token:'t',push:async()=>{n++;return 1;}});assert.equal(n,1);assert.equal(f.multicastCount(),1);assert.equal(f.records.personalEvents.event.sends[0].status,'sent');
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

// The independent scheduler and the GitHub fallback use the same leases (now kept in the server-only ledger).
test('an existing sender lease blocks a concurrent runner until expiration; a forged lease on the row is ignored',async()=>{
 const f=fixture({status:503});
 f.records.events.event.sends[0].leaseUntil=Date.now()+180000; // 利用者側の値は信用しない
 await f.main();assert.equal(f.multicastCount(),1,'行のロックの値では止まらない');
 f.ledger().leaseUntil=Date.now()+180000; // 別の実行が処理中
 await f.main();assert.equal(f.multicastCount(),1,'台帳のロック中は送らない');
 f.expireLease();await f.main();assert.equal(f.multicastCount(),2);
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

/* ===== 2026-10-09 再レビュー：通知の内部管理情報・手段ごとの独立・通数の返却 ===== */
const P='owner-A';
const ev=f=>f.records.personalEvents.event, item=f=>ev(f).sends[0];
const run=(f,opts={})=>f.engine.runSender({db:f.db,token:'t',...opts});
const twoEvents=(f,coll='personalEvents')=>{f.records[coll].event2=structuredClone(f.records[coll].event);f.records[coll].event2.sends[0].id='send2';};

test('① client-written reservation fields are never trusted for counting or limits',async()=>{
  // 「確保済み」と偽っても、上限を使い切っていれば送らない
  let f=fixture({personal:true,usedThisMonth:30});Object.assign(item(f),{reserved:5,attempts:1,leaseUntil:0,lineResult:'sent'});
  await run(f);assert.equal(f.multicastCount(),0);assert.match(item(f).error,/1人30通/);
  // 偽った確保数があっても、実際の人数で数える
  f=fixture({personal:true,usedThisMonth:3});Object.assign(item(f),{reserved:1});
  await run(f);assert.equal(f.usage(),4);assert.equal('reserved' in item(f),false,'古い印は行から消える');
  // 送信済みの行を「待ち」に戻しても、台帳が送信済みなので重ねて送らない・数え直さない
  f.records.personalEvents.event.sends[0]={...item(f),status:'wait',lineResult:''};f.records.personalEvents.event.nextSendAt=item(f).at;
  await run(f);assert.equal(f.multicastCount(),1);assert.equal(f.usage(),4);assert.equal(item(f).status,'sent');
});
test('① the same reservation run twice at once is sent and counted once',async()=>{
  const f=fixture({personal:true,usedThisMonth:3});
  await Promise.all([run(f),run(f),run(f)]);
  assert.equal(f.multicastCount(),1);assert.equal(f.usage(),4);assert.equal(f.hold(),0);assert.equal(item(f).status,'sent');
});
test('① per-person and whole-account limits hold under concurrent runs',async()=>{
  // 1人あと1通：別々の予定2件を同時に処理しても、1通だけ
  let f=fixture({personal:true,usedThisMonth:29});twoEvents(f);
  await Promise.all([run(f),run(f)]);
  assert.equal(f.multicastCount(),1);assert.equal(f.usage(),30);
  const states=[ev(f).sends[0],f.records.personalEvents.event2.sends[0]].map(s=>s.lineResult).sort();assert.deepEqual(states,['quota_user','sent']);
  // 全体あと1通：アプリ内の予約枠で、同時に2通確保しない
  f=fixture({quotaLeft:1});twoEvents(f,'events');
  await Promise.all([f.main(),f.main()]);
  assert.equal(f.multicastCount(),1);
  const all=[f.records.events.event.sends[0],f.records.events.event2.sends[0]].map(s=>s.lineResult).sort();assert.deepEqual(all,['quota_all','sent']);
});

test('② whole-account LINE allowance gone: the app notification still goes out and each result is shown',async()=>{
  const f=fixture({personal:true,quotaLeft:0});item(f).friendIds=['push:self','self'];let pushes=0;
  await run(f,{push:async()=>{pushes++;return 1;}});
  assert.equal(pushes,1);assert.equal(f.multicastCount(),0);
  assert.equal(item(f).status,'partial');assert.equal(item(f).pushResult,'ok');assert.equal(item(f).lineResult,'quota_all');assert.match(item(f).lineError,/全体/);
  assert.equal(f.usage(),undefined,'送らなかったLINEは数えない');
});
test('② personal LINE allowance gone: the app notification still goes out',async()=>{
  const f=fixture({personal:true,usedThisMonth:30});item(f).friendIds=['push:self','self'];let pushes=0;
  await run(f,{push:async()=>{pushes++;return 1;}});
  assert.equal(pushes,1);assert.equal(f.multicastCount(),0);assert.equal(item(f).status,'partial');assert.equal(item(f).lineResult,'quota_user');assert.equal(f.usage(),30);
});
test('② retries never resend a channel that already succeeded',async()=>{
  // アプリ通知は成功、LINEは一時エラー→次の回で成功：アプリ通知は1回だけ
  let f=fixture({personal:true,status:[503,200]});item(f).friendIds=['push:self','self'];let pushes=0;const push=async()=>{pushes++;return 1;};
  await run(f,{push});assert.equal(item(f).status,'wait');assert.equal(item(f).pushResult,'ok');assert.equal(item(f).lineResult,'retry');
  f.expireLease();await run(f,{push});
  assert.equal(pushes,1);assert.equal(f.multicastCount(),2);assert.equal(item(f).status,'sent');assert.equal(f.usage(),1,'再送で数え直さない');
  // LINEは成功、アプリ通知は失敗→再試行してもLINEは重ねない
  f=fixture({personal:true});item(f).friendIds=['push:self','self'];let n=0;
  await run(f,{push:async()=>++n>1?1:0});f.expireLease();await run(f,{push:async()=>++n>1?1:0});
  assert.equal(f.multicastCount(),1);assert.equal(item(f).status,'sent');assert.equal(item(f).pushResult,'ok');
  // 途中で止まった（アプリ通知を送ったか不明）→ 重ねて鳴らさず「確認できません」と出す
  f=fixture({personal:true});item(f).friendIds=['push:self'];
  await f.db.runTransaction(async tx=>{const r=f.db.collection('sendLedger').doc(f.engine.ledgerId('personalEvents','event','send'));await tx.get(r);tx.set(r,{v:1,coll:'personalEvents',eventId:'event',sendId:'send',ownerUid:P,month:'',lineState:'off',pushState:'todo',pushTries:0,pushInflight:true,attempts:1,leaseUntil:0,updatedMs:Date.now()});});
  let again=0;await run(f,{push:async()=>{again++;return 1;}});
  assert.equal(again,0);assert.equal(item(f).pushResult,'unknown');assert.match(item(f).error,/確認できません/);assert.doesNotMatch(item(f).error,/届きました/);
});

test('③ cancelling after a temporary refusal returns the count to the person and the app hold',async()=>{
  const f=fixture({personal:true,usedThisMonth:5,status:429,lineMessage:'Too Many Requests'});
  await run(f);assert.equal(f.usage(),6);assert.equal(f.hold(),1);assert.equal(item(f).status,'wait');
  ev(f).sendCancels=['send'];f.expireLease();await run(f);
  assert.equal(item(f).status,'cancelled');assert.equal(f.usage(),5);assert.equal(f.hold(),0);assert.equal(f.multicastCount(),1,'取り消し後は送らない');
  // 返却の再実行：二重に返さない・負にならない
  f.expireLease();await run(f);await f.engine.sweepHeld(f.db);assert.equal(f.usage(),5);assert.equal(f.hold(),0);
});
test('③ an unclear failure (5xx/network) is not refunded on cancel; only the app hold is released',async()=>{
  const f=fixture({personal:true,usedThisMonth:5,status:'network'});
  await run(f);assert.equal(f.usage(),6);
  ev(f).sendCancels=['send'];f.expireLease();await run(f);
  assert.equal(item(f).status,'cancelled');assert.equal(f.usage(),6,'届いたかもしれない分は返さない');assert.equal(f.hold(),0);assert.match(item(f).error,/分かりません/);
});
test('③ expiry after a temporary refusal returns the count',async()=>{
  const f=fixture({personal:true,usedThisMonth:5,status:429,lineMessage:'busy'});
  await run(f);assert.equal(f.usage(),6);
  ev(f).date='2020-01-01';f.expireLease();await run(f);
  assert.equal(item(f).status,'fail');assert.match(item(f).error,/日時を過ぎた/);assert.equal(f.usage(),5);assert.equal(f.hold(),0);
});
test('③ cancel during sending: what LINE accepted stays counted and is shown as sent',async()=>{
  const f=fixture({personal:true,usedThisMonth:5,onSend:records=>{records.personalEvents.event.sendCancels=['send'];}});
  item(f).friendIds=['self','push:self'];
  await run(f);// アプリ通知の送り手がいない実行：LINEだけ送る
  assert.equal(f.multicastCount(),1);assert.equal(item(f).lineResult,'sent');assert.equal(f.usage(),6);assert.equal(item(f).status,'partial');
  assert.equal(f.ledger().pushState,'skipped','取り消し後はアプリ通知を送らない');
});
test('③ deleting the plan after a temporary refusal: the patrol returns the count once',async()=>{
  const f=fixture({personal:true,usedThisMonth:5,status:429,lineMessage:'busy'});
  await run(f);assert.equal(f.usage(),6);
  delete f.records.personalEvents.event;
  f.ledger().updatedMs=Date.now()-11*60000;
  await f.engine.sweepHeld(f.db);await f.engine.sweepHeld(f.db);
  assert.equal(f.usage(),5);assert.equal(f.hold(),0);assert.equal(f.ledger().lineState,'returned');
});
test('③ a reservation made last month is returned to last month, not this month',async()=>{
  const f=fixture({personal:true,status:429,lineMessage:'busy'});
  await run(f);
  const prev='202001',l=f.ledger();l.month=prev;
  f.records.lineUsage[prev+'_'+P]={ownerUid:P,month:prev,count:7};f.records.lineQuota['hold_'+prev]={month:prev,count:1};
  const cur=f.month+'_'+P;f.records.lineUsage[cur]={ownerUid:P,month:f.month,count:2};f.records.lineQuota['hold_'+f.month]={month:f.month,count:0};
  ev(f).sendCancels=['send'];f.expireLease();await run(f);
  assert.equal(f.records.lineUsage[prev+'_'+P].count,6);assert.equal(f.records.lineQuota['hold_'+prev].count,0);
  assert.equal(f.records.lineUsage[cur].count,2,'今月の数は変えない');
});
