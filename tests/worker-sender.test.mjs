// 本番のWorkerと同じ「小さなFirestore REST アダプタ」で送信処理を動かす隔離テスト。
// Firestore・LINEは偽物（このファイルの中だけ）。本番には何も送らない。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {firestore, encode, decode} from '../line-worker/firestore.mjs';
const require = createRequire(import.meta.url);
const engine = require('../scripts/line-engine.cjs');
const root = 'projects/hibiruka-f66fb/databases/(default)/documents';
const json = (data, status = 200) => new Response(JSON.stringify(data), {status});

function fakeWorld({quotaLeft = 200, lineStatus = 200} = {}) {
  const docs = new Map(); let clock = 0, firestoreCalls = 0, multicasts = 0;
  const put = (path, value) => docs.set(path, {fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)])), updateTime: `t${++clock}`});
  const get = path => { const d = docs.get(path); return d && {...Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, decode(v)]))}; };
  const asDoc = (path, d) => ({name: `${root}/${path}`, fields: d.fields, updateTime: d.updateTime});
  const match = (d, f) => {
    if (!f) return true;
    if (f.compositeFilter) return f.compositeFilter.filters.every(x => match(d, x));
    const {field, op, value} = f.fieldFilter, have = d.fields[field.fieldPath] ? decode(d.fields[field.fieldPath]) : undefined, want = decode(value);
    return op === 'EQUAL' ? have === want : op === 'LESS_THAN_OR_EQUAL' ? have != null && have <= want : false;
  };
  async function fetcher(url, options = {}) {
    if (url.startsWith('https://api.line.me')) {
      if (url.endsWith('/info')) return json({basicId: '@626hnkgo'});
      if (url.endsWith('/quota')) return json({type: 'limited', value: 200});
      if (url.endsWith('/consumption')) return json({totalUsage: 200 - quotaLeft});
      if (url.endsWith('/multicast')) { multicasts++; return json({}, lineStatus); }
    }
    if (!url.startsWith('https://firestore.googleapis.com/v1/')) throw Error('unexpected host ' + url);
    firestoreCalls++;
    const rest = url.slice(('https://firestore.googleapis.com/v1/' + root).length);
    const body = options.body ? JSON.parse(options.body) : null;
    if (!body) { const path = decodeURIComponent(rest.slice(1)); const d = docs.get(path); return d ? json(asDoc(path, d)) : json({error: {status: 'NOT_FOUND'}}, 404); }
    if (rest === ':runQuery') {
      const q = body.structuredQuery, c = q.from[0].collectionId;
      const rows = [...docs].filter(([p, d]) => p.split('/')[0] === c && match(d, q.where)).slice(0, q.limit);
      return json(rows.map(([p, d]) => ({document: asDoc(p, d)})));
    }
    if (rest === ':batchGet') return json(body.documents.map(n => { const p = n.slice(root.length + 1), d = docs.get(p); return d ? {found: asDoc(p, d)} : {missing: n}; }));
    if (rest === ':commit') {
      for (const w of body.writes) {
        const p = (w.update?.name || w.delete).slice(root.length + 1), cur = docs.get(p), pre = w.currentDocument;
        if (pre?.exists === false && cur) return json({error: {status: 'ALREADY_EXISTS'}}, 409);
        if (pre?.exists === true && !cur) return json({error: {status: 'NOT_FOUND'}}, 404);
        if (pre?.updateTime && cur?.updateTime !== pre.updateTime) return json({error: {status: 'FAILED_PRECONDITION'}}, 400);
      }
      for (const w of body.writes) {
        if (w.delete) { docs.delete(w.delete.slice(root.length + 1)); continue; }
        const p = w.update.name.slice(root.length + 1), cur = docs.get(p);
        const fields = w.updateMask && cur ? {...cur.fields, ...w.update.fields} : w.update.fields;
        docs.set(p, {fields, updateTime: `t${++clock}`});
      }
      return json({});
    }
    throw Error('unexpected Firestore call ' + rest);
  }
  return {put, get, fetcher, calls: () => firestoreCalls, multicasts: () => multicasts};
}
function seed(w, {usage = 0, friends = ['push:self', 'f1']} = {}) {
  const month = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7).replace('-', '');
  w.put('personalEvents/e1', {ownerUid: 'owner-A', date: '2099-01-01', time: '12:00', kind: 'plan', title: '予定', sends: [{id: 'send-0001', at: '2020-01-01T10:00', status: 'wait', friendIds: friends}], nextSendAt: '2020-01-01T10:00'});
  w.put('personalFriends/f1', {ownerUid: 'owner-A', status: 'joined', lineUserId: 'U' + 'a'.repeat(32)});
  if (usage) w.put(`lineUsage/${month}_owner-A`, {ownerUid: 'owner-A', month, count: usage});
  return month;
}
async function withFetch(fetcher, fn) { const old = globalThis.fetch; globalThis.fetch = fetcher; try { return await fn(); } finally { globalThis.fetch = old; } }

test('Worker adapter: LINE allowance gone, the app notification is still sent; results per channel', async () => {
  const w = fakeWorld({quotaLeft: 0}); seed(w);
  let pushes = 0;
  await withFetch(w.fetcher, () => engine.runSender({db: firestore('t', w.fetcher, 4), token: 'x', maxSends: 2, push: async () => { pushes++; return 1; }}));
  const s = w.get('personalEvents/e1').sends[0];
  assert.equal(pushes, 1); assert.equal(w.multicasts(), 0);
  assert.equal(s.status, 'partial'); assert.equal(s.pushResult, 'ok'); assert.equal(s.lineResult, 'quota_all');
  assert.ok(w.calls() <= 38, 'Firestore request budget per run');
});
test('Worker adapter: send, count once, and never resend on the next run', async () => {
  const w = fakeWorld(); const month = seed(w, {usage: 3});
  const db = () => firestore('t', w.fetcher, 4);
  await withFetch(w.fetcher, () => engine.runSender({db: db(), token: 'x', maxSends: 2, push: async () => 1}));
  await withFetch(w.fetcher, () => engine.runSender({db: db(), token: 'x', maxSends: 2, push: async () => 1}));
  assert.equal(w.multicasts(), 1); assert.equal(w.get(`lineUsage/${month}_owner-A`).count, 4);
  assert.equal(w.get(`lineQuota/hold_${month}`).count, 0); assert.equal(w.get('personalEvents/e1').sends[0].status, 'sent');
});
test('Worker adapter: cancel after a temporary refusal returns the count', async () => {
  const w = fakeWorld({lineStatus: 429}); const month = seed(w, {usage: 3, friends: ['f1']});
  const db = () => firestore('t', w.fetcher, 4);
  await withFetch(w.fetcher, () => engine.runSender({db: db(), token: 'x', maxSends: 2}));
  assert.equal(w.get(`lineUsage/${month}_owner-A`).count, 4);
  const ev = w.get('personalEvents/e1'); w.put('personalEvents/e1', {...ev, sendCancels: ['send-0001']});
  await withFetch(w.fetcher, () => engine.runSender({db: db(), token: 'x', maxSends: 2}));
  assert.equal(w.get(`lineUsage/${month}_owner-A`).count, 3); assert.equal(w.get('personalEvents/e1').sends[0].status, 'cancelled');
});
