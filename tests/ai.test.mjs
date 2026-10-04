import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createSign} from 'node:crypto';
import {handleAi, verifyIdToken, resetKeyCache, userMessage, SYSTEM_PROMPT, PER_USER_DAILY, MODEL} from '../line-worker/ai.mjs';
import worker from '../line-worker/index.mjs';

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
  return {data, collection: c => ({doc: id => ref(c, id)}), commit: async ops => { for (const o of ops) data[o.ref.path] = o.value; }};
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

test('ID tokens: only this project, valid signature and unexpired tokens give a user', async () => {
  resetKeyCache(); const {fetcher} = setup();
  assert.equal(await verifyIdToken(idToken(), {fetcher, now: NOW}), 'alice');
  assert.equal(await verifyIdToken(idToken({aud: 'other-project'}), {fetcher, now: NOW}), null);
  assert.equal(await verifyIdToken(idToken({iss: 'https://securetoken.google.com/other'}), {fetcher, now: NOW}), null);
  assert.equal(await verifyIdToken(idToken({exp: Math.floor(NOW / 1000) - 1}), {fetcher, now: NOW}), null);
  assert.equal(await verifyIdToken(idToken({}, 'unknown'), {fetcher, now: NOW}), null);
  const other = generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey;
  assert.equal(await verifyIdToken(idToken({}, 'k1', other), {fetcher, now: NOW}), null, 'forged signature');
  assert.equal(await verifyIdToken('not.a.token', {fetcher, now: NOW}), null);
});

test('writes a diary line with the free Workers AI model and the record fenced as data', async () => {
  resetKeyCache(); const {calls, runs, db, deps, env} = setup();
  const res = await handleAi(req(record), env, deps);
  assert.equal(res.status, 200); assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const out = await res.json(); assert.equal(out.text, 'ゆっくり呼吸をして、肩が軽くなった一日。'); assert.equal(out.left, PER_USER_DAILY - 1);
  assert.equal(calls.length, 1, 'only Google keys are fetched; no paid API is called');
  const [model, sent] = runs[0]; assert.equal(model, MODEL); assert.equal(sent.messages[0].role, 'system'); assert.equal(sent.messages[0].content, SYSTEM_PROMPT);
  assert.match(sent.messages[1].content, /<記録>[\s\S]*題名=ベーシックヨガ[\s\S]*メモ=久しぶりで体がかたかった[\s\S]*<\/記録>/);
  assert.equal(db.data['aiUsage/20261004_alice'].count, 1); assert.equal(db.data['aiUsage/20261004_total'].count, 1);
});

test('future dates are marked as plans; empty records and bad dates are refused', async () => {
  assert.match(userMessage({...record, date: '2026-10-10'}, '2026-10-04'), /これからの予定/);
  assert.doesNotMatch(userMessage(record, '2026-10-04'), /これからの予定/);
  resetKeyCache(); const {deps, env} = setup();
  assert.equal((await handleAi(req({date: '2026-10-04'}), env, deps)).status, 400);
  assert.equal((await handleAi(req({...record, date: 'tomorrow'}), env, deps)).status, 400);
});

test('daily limits per person, sign-in, origin and missing key are enforced before calling Claude', async () => {
  resetKeyCache(); const {runs, deps, env} = setup();
  for (let i = 0; i < PER_USER_DAILY; i++) assert.equal((await handleAi(req(record), env, deps)).status, 200);
  const limited = await handleAi(req(record), env, deps); assert.equal(limited.status, 429); assert.equal((await limited.json()).error, 'limit');
  assert.equal(runs.length, PER_USER_DAILY);
  assert.equal((await handleAi(req(record, {token: 'bad'}), env, deps)).status, 401);
  assert.equal((await handleAi(req(record, {origin: 'https://evil.example'}), env, deps)).status, 403);
  assert.equal((await handleAi(req(record), {FIREBASE_SERVICE_ACCOUNT: '{}'}, deps)).status, 503, 'no AI binding');
  const pre = await handleAi(req(null, {method: 'OPTIONS'}), env, deps);
  assert.equal(pre.status, 204); assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
});

test('AI errors become a short failure (used-up free allowance says busy); quotes and thinking are removed', async () => {
  resetKeyCache(); let s = setup({fail: '4006: you have used up your daily free allocation of 10,000 neurons'});
  const busy = await handleAi(req(record), s.env, s.deps); assert.equal(busy.status, 502); assert.equal((await busy.json()).error, 'busy');
  resetKeyCache(); s = setup({fail: 'network'}); assert.equal((await (await handleAi(req(record), s.env, s.deps)).json()).error, 'ai');
  resetKeyCache(); s = setup({aiText: '<think>考え中</think>「楽しい一日。」'});
  assert.equal((await (await handleAi(req(record), s.env, s.deps)).json()).text, '楽しい一日。');
});

test('worker routes the AI writer and still hides everything else', async () => {
  const res = await worker.fetch(new Request('https://w/ai/memory-text', {method: 'POST', headers: {origin: ORIGIN}, body: '{}'}), {});
  assert.equal(res.status, 503);
  assert.equal((await worker.fetch(new Request('https://w/ai/memory-text', {method: 'GET'}), {})).status, 404);
});
