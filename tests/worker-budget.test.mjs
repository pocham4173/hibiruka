// 1回の実行で使える Firestore の通信回数（アダプタの上限38回）を、見回り＋送信2件で使い切らないかの隔離テスト。
// 本番の Worker の入口（tick）・本物の REST アダプタを使い、Firestore・LINE・Google認証の通信先だけを偽物にする。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createECDH, randomBytes} from 'node:crypto';
import {encode, decode} from '../line-worker/firestore.mjs';
import {tick} from '../line-worker/index.mjs';
const root = 'projects/hibiruka-f66fb/databases/(default)/documents';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {status, headers});
const sa = JSON.stringify({project_id: 'hibiruka-f66fb', client_email: 'qa@hibiruka-f66fb.iam.gserviceaccount.com', private_key: generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey.export({type: 'pkcs8', format: 'pem'})});
const RealDate = Date;
const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
const P256DH = ecdh.getPublicKey().toString('base64url'), AUTH = randomBytes(16).toString('base64url');
function freeze(ms) {
  globalThis.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(ms.t); } static now() { return ms.t; } };
}
function world({lineStatus = () => 200, conflicts = 0, burn = 0} = {}) {
  const docs = new Map(); let clock = 0;
  const stats = {fs: 0, multicast: 0, pushes: 0, budgetErrors: 0};
  const put = (path, value) => docs.set(path, {fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)])), updateTime: `t${++clock}`});
  const get = path => { const d = docs.get(path); return d && Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, decode(v)])); };
  const asDoc = (path, d) => ({name: `${root}/${path}`, fields: d.fields, updateTime: d.updateTime});
  const match = (d, f) => {
    if (!f) return true;
    if (f.compositeFilter) return f.compositeFilter.filters.every(x => match(d, x));
    const {field, op, value} = f.fieldFilter, have = d.fields[field.fieldPath] ? decode(d.fields[field.fieldPath]) : undefined, want = decode(value);
    return op === 'EQUAL' ? have === want : op === 'LESS_THAN_OR_EQUAL' ? have != null && have <= want : false;
  };
  async function fetcher(url, options = {}) {
    url = String(url);
    if (url === 'https://oauth2.googleapis.com/token') return json({access_token: 'test', expires_in: 3600});
    if (url.startsWith('https://api.line.me')) {
      if (url.endsWith('/info')) return json({basicId: '@626hnkgo'});
      if (url.endsWith('/quota')) return json({type: 'limited', value: 200});
      if (url.endsWith('/consumption')) return json({totalUsage: 0});
      if (url.endsWith('/multicast')) { stats.multicast++; const s = lineStatus(); return json({}, s, s === 409 ? {'x-line-accepted-request-id': 'acc'} : {}); }
    }
    if (url.startsWith('https://push.example/')) { stats.pushes++; return new Response('', {status: 201}); }
    if (!url.startsWith('https://firestore.googleapis.com/v1/')) throw Error('unexpected host ' + url);
    stats.fs++;
    const rest = url.slice(('https://firestore.googleapis.com/v1/' + root).length);
    const body = options.body ? JSON.parse(options.body) : null;
    if (burn > 0 && rest === '/burn/x') { burn--; return json({error: {status: 'NOT_FOUND'}}, 404); }
    if (!body) { const path = decodeURIComponent(rest.slice(1)); const d = docs.get(path); return d ? json(asDoc(path, d)) : json({error: {status: 'NOT_FOUND'}}, 404); }
    if (rest === ':runQuery') {
      const q = body.structuredQuery, c = q.from[0].collectionId;
      let rows = [...docs].filter(([p, d]) => p.split('/')[0] === c && p.split('/').length === 2 && match(d, q.where)).sort(([a], [b]) => a < b ? -1 : 1);
      const after = q.startAt?.values?.[0]?.referenceValue; if (after) rows = rows.filter(([p]) => `${root}/${p}` > after);
      return json(rows.slice(0, q.limit).map(([p, d]) => ({document: asDoc(p, d)})));
    }
    if (rest === ':batchGet') return json(body.documents.map(n => { const p = n.slice(root.length + 1), d = docs.get(p); return d ? {found: asDoc(p, d)} : {missing: n}; }));
    if (rest === ':commit') {
      // LINEに送ったあとの結果の保存（予定の行を「送信済み」にする書き込み）を、指定回数だけ「競合」で失敗させる
      if (conflicts > 0 && stats.multicast > 0 && body.writes.some(w => (w.update?.name || '').includes('/personalEvents/') && JSON.stringify(w.update.fields).includes('"sent"'))) { conflicts--; stats.conflictsHit = (stats.conflictsHit || 0) + 1; return json({error: {status: 'FAILED_PRECONDITION'}}, 400); }
      for (const w of body.writes) {
        const p = (w.update?.name || w.delete).slice(root.length + 1), cur = docs.get(p), pre = w.currentDocument;
        if (pre?.exists === false && cur) return json({error: {status: 'ALREADY_EXISTS'}}, 409);
        if (pre?.exists === true && !cur) return json({error: {status: 'NOT_FOUND'}}, 404);
        if (pre?.updateTime && cur?.updateTime !== pre.updateTime) return json({error: {status: 'FAILED_PRECONDITION'}}, 400);
      }
      for (const w of body.writes) {
        if (w.delete) { docs.delete(w.delete.slice(root.length + 1)); continue; }
        const p = w.update.name.slice(root.length + 1), cur = docs.get(p);
        docs.set(p, {fields: w.updateMask && cur ? {...cur.fields, ...w.update.fields} : w.update.fields, updateTime: `t${++clock}`});
      }
      return json({});
    }
    throw Error('unexpected Firestore call ' + rest);
  }
  return {put, get, fetcher, stats};
}
// 削除済み予定の確保済み台帳2件（返却できる）＋送信時刻を迎えた予定2件（LINE 1人ずつ。push=true ならアプリ通知も）
function seed(w, {month, now, push = false}) {
  const old = now - 3600000;
  w.put(`lineUsage/${month}_owner-A`, {ownerUid: 'owner-A', month, count: 2});
  w.put(`lineQuota/hold_${month}`, {month, count: 2, sent: 0});
  w.put('personalFriends/f1', {ownerUid: 'owner-A', status: 'joined', lineUserId: 'U' + 'a'.repeat(32)});
  w.put('pushSubs/s1', {ownerUid: 'owner-A', endpoint: 'https://push.example/1', p256dh: P256DH, auth: AUTH});
  for (const i of [1, 2]) {
    w.put(`sendLedger/old${i}`, {v: 2, coll: 'personalEvents', eventId: `gone${i}`, sendId: `g${i}`, ownerUid: 'owner-A', month, holds: [{month, count: 1}], lineState: 'held', lineCount: 1, lineUnsure: false, lineInflight: false, tries: [{ms: old, month, result: 'clear'}], pushState: 'off', attempts: 1, leaseUntil: 0, updatedMs: old});
    w.put(`personalEvents/e${i}`, {ownerUid: 'owner-A', date: '2099-01-01', time: '12:00', kind: 'plan', title: `予定${i}`, sends: [{id: `send-000${i}`, at: '2026-10-10T11:00', status: 'wait', friendIds: push ? ['push:self', 'f1'] : ['f1']}], nextSendAt: '2026-10-10T11:00'});
  }
}
async function runTick(w) {
  const realFetch = globalThis.fetch; globalThis.fetch = w.fetcher;
  let error = null;
  try { await tick({FIREBASE_SERVICE_ACCOUNT: sa, LINE_CHANNEL_ACCESS_TOKEN: 'x', SENDING_ENABLED: 'true', WORKER_VERSION: 'test'}, {scheduledTime: Date.now()}); }
  catch (e) { error = e; } finally { globalThis.fetch = realFetch; }
  return error;
}
const sends = w => [1, 2].map(i => w.get(`personalEvents/e${i}`).sends[0]);

for (const push of [false, true]) test(`REVIEW combined sweep and two sends budget（${push ? 'LINE＋アプリ通知' : 'LINEだけ'}）：通信回数の上限内で、送ったものの結果とheartbeatを必ず保存する`, async () => {
  const clock = {t: RealDate.parse('2026-10-10T12:02:00+09:00')}; freeze(clock);
  try {
    const w = world(), month = '202610';
    seed(w, {month, now: clock.t, push});
    const before = w.stats.fs;
    const err = await runTick(w);
    assert.equal(err, null, '実行はエラーにならない');
    assert.ok(w.stats.fs - before <= 38, `Firestoreの通信は38回まで（${w.stats.fs - before}回）`);
    const hb = w.get('schedulerStatus/cloudflare'); assert.ok(hb && hb.ok === true, 'heartbeat を保存できる');
    // 送ったものは、結果まで保存されている（受け付け後に保存できない送信を始めない）
    const s = sends(w), lineSaved = s.filter(x => x.lineResult === 'sent');
    assert.equal(w.stats.multicast, lineSaved.length, 'LINEに送った件数＝結果を保存できた件数（受け付け後に保存できない送信をしない）');
    assert.ok(lineSaved.length >= 1, '少なくとも1件は送る');
    for (const x of s) if (x.lineResult !== 'sent') { assert.equal(x.status, 'wait'); assert.ok(!x.lineResult && !x.pushResult, '次の回に回した予約は手つかず'); }
    if (push) assert.equal(w.stats.pushes, lineSaved.length, 'アプリ通知も送ったものだけ');
    // 次の回（1分後・新しい実行）で残りを送る。見回りの対象も、やがて返す
    for (let n = 0; n < 8; n++) { clock.t += 60000; assert.equal(await runTick(w), null); }
    assert.deepEqual(sends(w).map(x => x.status), ['sent', 'sent']);
    assert.equal(w.stats.multicast, 2, '同じ予約に2回送らない');
    assert.equal(w.get(`lineUsage/${month}_owner-A`).count, 2, '送った2通だけ数える（返却対象の2通は返した）');
    assert.equal(w.get('sendLedger/old1').lineState, 'returned'); assert.equal(w.get('sendLedger/old2').lineState, 'returned');
    if (push) assert.equal(w.stats.pushes, 2, 'アプリ通知も1回ずつ');
  } finally { globalThis.Date = RealDate; }
});

test('残りの通信回数が足りなければ、LINEもアプリ通知も始めず、次の回に回す（heartbeat は保存する）',async()=>{
  const clock={t:RealDate.parse('2026-10-10T12:03:00+09:00')};freeze(clock);
  try{
    const w=world();seed(w,{month:'202610',now:clock.t,push:true});
    // 外から別の通信で回数を使ってしまった状態を作る：アダプタを直接使って30回分読む
    const {firestore}=await import('../line-worker/firestore.mjs');const engine=(await import('node:module')).createRequire(import.meta.url)('../scripts/line-engine.cjs');
    const realFetch=globalThis.fetch;globalThis.fetch=w.fetcher;
    try{
      const db=firestore('test',w.fetcher,4);for(let i=0;i<30;i++)await db.collection('lineQuota').doc('current').get();
      const r=await engine.runSender({db,token:'x',maxSends:2,push:async()=>1});
      assert.equal(w.stats.multicast,0,'結果を保存できないLINE送信は始めない');assert.deepEqual(sends(w).map(x=>x.status),['wait','wait']);
      assert.ok(sends(w).every(x=>!x.lineResult&&!x.pushResult),'予約には手をつけない');
      await db.heartbeat({ok:true,checkedAt:new Date()});assert.equal(w.get('schedulerStatus/cloudflare').ok,true,'heartbeat の1回は取ってある');
      assert.ok(db.budget.used()<=38);
    }finally{globalThis.fetch=realFetch;}
  }finally{globalThis.Date=RealDate;}
});
test('送ったあとの結果の保存で競合（やり直し）が起きても、通信回数の見積もりの中で保存できる／やり直しが続いても実行は壊れず、次の回に回復する',async()=>{
  const clock={t:RealDate.parse('2026-10-10T12:03:00+09:00')};freeze(clock);
  try{
    // 競合1回：見積もり（やり直し1回分）の中で保存できる
    let w=world({conflicts:1});seed(w,{month:'202610',now:clock.t});
    assert.equal(await runTick(w),null);
    const saved=sends(w).filter(x=>x.lineResult==='sent').length;assert.equal(w.stats.multicast,saved,'送ったものは保存できた');assert.equal(w.stats.conflictsHit,1,'競合が実際に起きた');
    assert.ok(w.get('schedulerStatus/cloudflare').ok);
    // 競合が何度も続く：通信回数が尽きても実行はエラーにならず heartbeat は残る。次の回に同じ再送キーで確かめて回復（二重に数えない）
    w=world({conflicts:10,lineStatus:(()=>{let n=0;return()=>++n===1?200:409;})()});seed(w,{month:'202610',now:clock.t});
    assert.equal(await runTick(w),null,'実行はエラーにならない');assert.ok(w.get('schedulerStatus/cloudflare').ok,'heartbeat は保存');assert.ok(w.stats.conflictsHit>=2,'やり直しが続いた');
    for(let n=0;n<8;n++){clock.t+=60000;assert.equal(await runTick(w),null);}
    assert.deepEqual(sends(w).map(x=>x.status),['sent','sent']);assert.equal(w.get('lineUsage/202610_owner-A').count,2,'二重に数えない');
  }finally{globalThis.Date=RealDate;}
});
