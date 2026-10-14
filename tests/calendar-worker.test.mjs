import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createSign} from 'node:crypto';
import {handleAi, verifyIdToken, resetKeyCache, userMessage, SYSTEM_PROMPT, PROMPTS, PER_USER_DAILY, MODEL} from '../line-worker/ai.mjs';
import {handleCalendar, parseCalendar, MAX_BODY} from '../line-worker/calendar.mjs';

import grid from './fixtures/calendar-grid.cjs';
const NOW = Date.parse('2026-10-04T08:00:00Z'); // 17:00 JST
const ORIGIN = 'https://pocham4173.github.io';
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'k1', alg: 'RS256', use: 'sig'};
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(claims = {}, kid = 'k1', key = privateKey) {
  const sec = Math.floor(NOW / 1000);
  const body = b64({alg: 'RS256', kid, typ: 'JWT'}) + '.' + b64({aud: 'hibiruka-f66fb', iss: 'https://securetoken.google.com/hibiruka-f66fb', sub: 'alice', iat: sec - 10, exp: sec + 3000, ...claims});
  return body + '.' + createSign('RSA-SHA256').update(body).sign(key).toString('base64url');
}
function memoryDb() {
  const data = {};
  const ref = (c, id) => ({path: c + '/' + id, get: async () => ({exists: (c + '/' + id) in data, data: () => data[c + '/' + id]})});
  return {data, collection: c => ({doc: id => ref(c, id)}), commit: async ops => { for (const o of ops) data[o.ref.path] = o.value; },
    runTransaction: async fn => { const w = []; const r = await fn({get: x => x.get(), set: (x, v) => w.push([x, v]), update: (x, v) => w.push([x, v])}); for (const [x, v] of w) data[x.path] = v; return r; }};
}
function setup({fail = null, aiText = 'ゆっくり呼吸をして、肩が軽くなった一日。'} = {}) {
  const calls = [], runs = [];
  const fetcher = async (url, opt) => {
    calls.push([url, opt]);
    return new Response(JSON.stringify({keys: [jwk]}), {headers: {'cache-control': 'public, max-age=20000'}});
  };
  const AI = {run: async (model, input) => { runs.push([model, input]); if (fail) throw Error(fail); return {choices: [{message: {role: 'assistant', content: aiText}}]}; }};
  const db = memoryDb();
  return {calls, runs, db, fetcher, env: {AI, FIREBASE_SERVICE_ACCOUNT: '{}'}, deps: {db: async () => db, fetcher, now: () => NOW}};
}
const req = (body, {token = idToken(), origin = ORIGIN, method = 'POST'} = {}) => new Request('https://w/ai/memory-text', {method, headers: {origin, authorization: 'Bearer ' + token, 'content-type': 'application/json'}, ...(method === 'POST' ? {body: JSON.stringify(body)} : {})});
const record = {title: 'ベーシックヨガ', date: '2026-10-04', place: 'LOIVE 上田店', cat: 'ヨガ', memo: '久しぶりで体がかたかった'};
const calendar={formatVersion:2,year:2026,image:'data:image/jpeg;base64,/9j/AA=='};
test('calendar requires signed-in owner, allowed origin and a bounded image',async()=>{
 resetKeyCache();const s=setup();
 assert.equal((await handleCalendar(req(calendar,{token:'bad'}),s.env,s.deps)).status,401);
 assert.equal((await handleCalendar(req(calendar,{origin:'https://evil.test'}),s.env,s.deps)).status,403);
 assert.equal((await handleCalendar(req({...calendar,image:'https://private.test/image'}),s.env,s.deps)).status,400);
 assert.equal((await handleCalendar(req({...calendar,year:2026.5}),s.env,s.deps)).status,400);
 assert.equal((await handleCalendar(req({...calendar,image:'x'.repeat(MAX_BODY)}),s.env,s.deps)).status,400);
 assert.equal(s.runs.length,0);
});
test('one vision call, shared quota plus 4/day cap; only a review draft is returned',async()=>{
 resetKeyCache();const s=setup({aiText:JSON.stringify({months:[grid(2026,10,{10:'A'}),grid(2027,1,{9:'B'})]})});
 for(let i=0;i<4;i++) {
   const res=await handleCalendar(req(calendar),s.env,s.deps);assert.equal(res.status,200);
   const data=await res.json();assert.equal(data.reviewRequired,true);assert.equal(data.days.length,2);assert.equal(data.formatVersion,2);assert.equal(data.months[0].days.length,31);
 }
 assert.equal((await handleCalendar(req(calendar),s.env,s.deps)).status,429);
 assert.equal(s.runs.length,4);
 assert.equal(s.runs[0][0],MODEL);
 assert.equal(s.runs[0][1].messages[1].content[1].image_url.url,calendar.image);
 assert.equal(s.db.data['aiUsage/20261004_alice'].count,4);
 assert(Object.keys(s.db.data).every(k=>k.startsWith('aiUsage/')||k.startsWith('calendarUsage/')),'never save photos, profiles or events');
});
test('hallucinated dates, truncated JSON, wrong year and unknown labels fail closed',async()=>{
 for(const days of [[{date:'2027-02-29',kind:'all'}],[{date:'2028-01-01',kind:'all'}],[{date:'2026-10-10',kind:'admin'}],[]])
   assert.throws(()=>parseCalendar(JSON.stringify({days}),2026));
 assert.throws(()=>parseCalendar('{"days":[',2026));
 assert.throws(()=>parseCalendar('{"days":[{"date":"2026-10-10","kind":"A"}]}',2026),'unverified legacy output is rejected');
 resetKeyCache();const s=setup({aiText:'{"days":[]}'});
 assert.equal((await handleCalendar(req(calendar),s.env,s.deps)).status,422);
});
test('vision errors never fall back to a text-only model',async()=>{
 resetKeyCache();const s=setup({fail:'unavailable'});
 assert.equal((await handleCalendar(req(calendar),s.env,s.deps)).status,503);
 assert.equal(s.runs.length,1);
});

test('old clients cannot append photo imports and are rejected before using AI quota',async()=>{
 resetKeyCache();const s=setup();const {formatVersion,...old}=calendar;
 const r=await handleCalendar(req(old),s.env,s.deps);
 assert.equal(r.status,426);assert.equal((await r.json()).error,'update_required');assert.equal(s.runs.length,0);assert.equal(Object.keys(s.db.data).length,0);
});
test('shifted image columns return no saveable draft',async()=>{
 resetKeyCache();const block=grid();block.rows[1][6]='12:A';
 const s=setup({aiText:JSON.stringify({months:[block]})});
 const r=await handleCalendar(req(calendar),s.env,s.deps);assert.equal(r.status,422);
 const result=await r.json();assert.equal(result.error,'unreadable');assert.equal(result.days,undefined);
});
