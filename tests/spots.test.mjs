import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createSign} from 'node:crypto';
import {handleSpots, buildQuery, shopOut} from '../line-worker/spots.mjs';
import {resetKeyCache} from '../line-worker/ai.mjs';

const NOW = Date.parse('2026-10-05T03:00:00Z'), ORIGIN = 'https://pocham4173.github.io';
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'k1', alg: 'RS256'};
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = () => { const sec = Math.floor(NOW / 1000); const body = b64({alg: 'RS256', kid: 'k1'}) + '.' + b64({aud: 'hibiruka-f66fb', iss: 'https://securetoken.google.com/hibiruka-f66fb', sub: 'alice', iat: sec - 5, exp: sec + 3000}); return body + '.' + createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url'); };
const shop = {id: 'J001', name: 'ソラノカフェ', lat: 36.401, lng: 138.251, address: '長野県上田市中央1-1', genre: {name: 'カフェ・スイーツ', catch: '手作りケーキ'}, budget: {name: '～1000円'}, open: '月～日: 10:00～18:00', urls: {pc: 'https://www.hotpepper.jp/strJ001/'}, photo: {mobile: {l: 'https://imgfp.hotp.jp/a.jpg'}}};
function setup(reply = {results: {shop: [shop, {name: 'no coords'}]}}) {
  const calls = [];
  const fetcher = async (url) => { calls.push(url); if (url.includes('googleapis')) return new Response(JSON.stringify({keys: [jwk]})); return new Response(JSON.stringify(reply)); };
  return {calls, deps: {fetcher, now: () => NOW}};
}
const req = (body, o = {}) => new Request('https://w/spots/search', {method: 'POST', headers: {origin: o.origin || ORIGIN, authorization: 'Bearer ' + (o.token || token())}, body: JSON.stringify(body)});
const env = {HOTPEPPER_API_KEY: 'hp-key'};

test('queries: near me by genre, lunch, or a keyword like 上田駅 ランチ', () => {
  let q = buildQuery({kind: 'cafe', lat: 36.4, lng: 138.25}, 'K');
  assert.equal(q.get('genre'), 'G014'); assert.equal(q.get('lat'), '36.40000'); assert.equal(q.get('range'), '5'); assert.equal(q.get('key'), 'K');
  q = buildQuery({kind: 'lunch', lat: 36.4, lng: 138.25, range: 3}, 'K'); assert.equal(q.get('lunch'), '1'); assert.equal(q.get('range'), '3'); assert.equal(q.has('genre'), false);
  q = buildQuery({keyword: '上田駅 ランチ'}, 'K'); assert.equal(q.get('keyword'), '上田駅 ランチ'); assert.equal(q.has('lat'), false);
  q = buildQuery({kind: 'sushi', keyword: '上田'}, 'K'); assert.equal(q.get('keyword'), '上田 寿司'); assert.equal(q.get('genre'), 'G004');
  assert.equal(buildQuery({kind: 'cafe'}, 'K'), null, 'needs a place or a keyword');
  q = buildQuery({kind: 'dog', lat: 36.4, lng: 138.25}, 'K'); assert.equal(q.get('pet'), '1'); assert.equal(q.has('genre'), false);
});
test('shops are trimmed to safe fields; links and photos must be https', () => {
  const s = shopOut(shop); assert.equal(s.id, 'hp:J001'); assert.equal(s.photo, 'https://imgfp.hotp.jp/a.jpg'); assert.equal(s.url, 'https://www.hotpepper.jp/strJ001/'); assert.equal(s.budget, '～1000円');
  assert.equal(shopOut({...shop, urls: {pc: 'javascript:alert(1)'}, photo: {mobile: {l: 'http://x'}}}).url, '');
  assert.equal(shopOut({name: 'x'}), null);
});
test('search: signed-in app only, key stays in the Worker, errors are short', async () => {
  resetKeyCache(); let s = setup();
  const res = await handleSpots(req({kind: 'cafe', lat: 36.4, lng: 138.25}), env, s.deps);
  assert.equal(res.status, 200); const out = await res.json(); assert.equal(out.shops.length, 1); assert.equal(out.shops[0].name, 'ソラノカフェ'); assert.doesNotMatch(JSON.stringify(out), /hp-key/);
  assert.match(s.calls.find(u => u.includes('hotpepper')), /key=hp-key/);
  assert.equal((await handleSpots(req({kind: 'cafe', lat: 1, lng: 1}, {token: 'bad'}), env, s.deps)).status, 401);
  assert.equal((await handleSpots(req({kind: 'cafe', lat: 1, lng: 1}, {origin: 'https://evil.example'}), env, s.deps)).status, 403);
  assert.equal((await handleSpots(req({kind: 'cafe', lat: 1, lng: 1}), {}, s.deps)).status, 503);
  assert.equal((await handleSpots(req({kind: 'cafe'}), env, s.deps)).status, 400);
  resetKeyCache(); s = setup({results: {error: [{code: 2000, message: 'bad key'}]}});
  assert.equal((await handleSpots(req({keyword: 'カフェ'}), env, s.deps)).status, 502);
});
