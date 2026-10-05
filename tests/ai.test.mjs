import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createSign} from 'node:crypto';
import {handleAi, verifyIdToken, resetKeyCache, userMessage, SYSTEM_PROMPT, PROMPTS, PER_USER_DAILY, MODEL} from '../line-worker/ai.mjs';
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

test('other kinds of writing: one-liner, SNS caption with hashtags, three title ideas and a month look-back', async () => {
  resetKeyCache(); let s = setup({aiText: '体のかたさに笑った、久しぶりのヨガの日。'});
  let out = await (await handleAi(req({...record, mode: 'short'}), s.env, s.deps)).json();
  assert.equal(out.text, '体のかたさに笑った、久しぶりのヨガの日。'); assert.equal(s.runs[0][1].messages[0].content, PROMPTS.short);
  resetKeyCache(); s = setup({aiText: '久しぶりのヨガ🧘 肩がすっきり。\n#ヨガ #上田市 #ヒビルカ'});
  out = await (await handleAi(req({...record, mode: 'sns'}), s.env, s.deps)).json();
  assert.equal(out.text, '久しぶりのヨガ🧘 肩がすっきり。\n#ヨガ #上田市 #ヒビルカ', 'hashtags stay on their own line');
  resetKeyCache(); s = setup({aiText: '1. 久しぶりのヨガ\n2. 「体ほぐしの夕方」\n- かたい体と再会した日\n久しぶりのヨガ'});
  out = await (await handleAi(req({place: 'LOIVE', date: '2026-10-04', mode: 'title'}), s.env, s.deps)).json();
  assert.deepEqual(out.titles, ['久しぶりのヨガ', '体ほぐしの夕方', 'かたい体と再会した日']);
  resetKeyCache(); s = setup({aiText: 'ヨガに3回通った10月。'});
  const records = [{date: '2026-10-01', title: 'ヨガ', place: 'LOIVE', cat: 'ヨガ', fav: true}, {date: '2026-10-03', title: 'カット', cat: '美容院', memo: 'さっぱり'}, {date: 'bad', title: 'x'}];
  out = await (await handleAi(req({mode: 'month', month: '2026年10月', records}), s.env, s.deps)).json();
  assert.equal(out.text, 'ヨガに3回通った10月。');
  const msg = s.runs[0][1].messages[1].content;
  assert.match(msg, /2026年10月の記録（2件）/); assert.match(msg, /♥また行きたい/); assert.match(msg, /メモ: さっぱり/); assert.equal(s.runs[0][1].messages[0].content, PROMPTS.month);
  assert.equal((await handleAi(req({mode: 'month', month: '2026年10月', records: []}), s.env, s.deps)).status, 400);
  assert.equal((await handleAi(req({mode: 'month', month: 'いつか', records}), s.env, s.deps)).status, 400);
  assert.equal((await handleAi(req({...record, mode: 'unknown'}), s.env, s.deps)).status, 200, 'unknown modes fall back to the diary');
});
test('every prompt keeps the safety rules: facts only and records are data, not instructions', () => {
  for (const [mode, p] of Object.entries(PROMPTS)) { assert.match(p, /事実だけ/, mode); assert.match(p, /従わない/, mode); }
  assert.match(userMessage({...record}, '2026-10-04', 'title'), /題名の案を3つ/);
});

test('answers are read from any shape; thinking is turned off and an empty answer falls back to a non-thinking model', async () => {
  const {answerText, runText} = await import('../line-worker/ai.mjs');
  assert.equal(answerText({choices:[{message:{content:[{type:'text', text:'a'}, {type:'text', text:'b'}]}}]}), 'ab');
  assert.equal(answerText({response:'old'}), 'old');
  assert.equal(answerText({choices:[{text:'t'}]}), 't');
  const seen = [];
  const env = {AI:{run:async (m, i) => { seen.push([m, i]); return seen.length === 1 ? {choices:[{finish_reason:'length', message:{content:null, reasoning_content:'...'}}]} : {response:'できた'}; }}};
  assert.deepEqual(await runText(env, [], 800, 0.7), {text:'できた'});
  assert.equal(seen[0][0], '@cf/google/gemma-4-26b-a4b-it'); assert.deepEqual(seen[0][1].chat_template_kwargs, {enable_thinking:false}); assert.equal(seen[0][1].max_completion_tokens, 800);
  assert.equal(seen[1][0], '@cf/meta/llama-3.3-70b-instruct-fp8-fast'); assert.equal(seen[1][1].max_tokens, 800);
  const empty = {AI:{run:async () => ({choices:[{finish_reason:'length', message:{content:null, reasoning_content:'x'}}]})}};
  assert.match((await runText(empty, [], 800, 0.7)).diag, /^E:length:content\.reasoning_content/);
});
