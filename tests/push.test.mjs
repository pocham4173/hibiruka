import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createECDH, hkdfSync, createDecipheriv, createPublicKey, verify, randomBytes, generateKeyPairSync, createSign} from 'node:crypto';
import {encryptPayload, b64u, unb64u, handlePush, pushToOwner, resetVapid, vapidKeys} from '../line-worker/push.mjs';
import {resetKeyCache} from '../line-worker/ai.mjs';

// 受け取る側（ブラウザ）の役：RFC 8291 で復号する
function receiver() {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const auth = randomBytes(16);
  return {p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth), decrypt(body) {
    const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), cipher = body.subarray(21 + idlen);
    const shared = ecdh.computeSecret(asPublic);
    const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(cipher.subarray(cipher.length - 16));
    const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
    assert.equal(plain[plain.length - 1], 2, 'last record delimiter'); return plain.subarray(0, -1).toString();
  }};
}
test('the message is encrypted so only that device can read it (RFC 8291)', async () => {
  const r = receiver();
  const body = await encryptPayload('{"title":"🔔 松本旅行","body":"明日です"}', r.p256dh, r.auth);
  assert.equal(body.readUInt32BE ? body.readUInt32BE(16) : new DataView(body.buffer).getUint32(16), 4096);
  assert.equal(r.decrypt(Buffer.from(body)), '{"title":"🔔 松本旅行","body":"明日です"}');
});

function memDb() {
  const data = {};
  const ref = (c, id) => ({id, path: c + '/' + id, parent: {id: c}, get: async () => ({exists: (c + '/' + id) in data, data: () => data[c + '/' + id], ref: ref(c, id)})});
  const q = (c, f = []) => ({where: (k, op, v) => q(c, [...f, [k, v]]), limit: () => q(c, f), get: async () => ({docs: Object.keys(data).filter(p => p.startsWith(c + '/') && f.every(([k, v]) => data[p][k] === v)).map(p => ({id: p.split('/')[1], ref: ref(c, p.split('/')[1]), data: () => data[p]}))})});
  return {data, collection: c => ({doc: id => ref(c, id), where: (k, op, v) => q(c, [[k, v]])}),
    create: async (r, v) => { if (r.path in data) throw Error('exists'); data[r.path] = v; }, set: async (r, v) => { data[r.path] = v; }, remove: async r => { delete data[r.path]; }};
}
const NOW = Date.parse('2026-10-06T00:00:00Z');
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'k1', alg: 'RS256'};
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (sub = 'alice') => { const s = Math.floor(NOW / 1000); const body = b64({alg: 'RS256', kid: 'k1'}) + '.' + b64({aud: 'hibiruka-f66fb', iss: 'https://securetoken.google.com/hibiruka-f66fb', sub, iat: s - 5, exp: s + 3000}); return body + '.' + createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url'); };
const req = (path, body, {tok = token(), method = 'POST'} = {}) => new Request('https://w' + path, {method, headers: {origin: 'https://pocham4173.github.io', authorization: 'Bearer ' + tok}, ...(body ? {body: JSON.stringify(body)} : {})});

test('subscribe, then a test notification reaches the device with a valid VAPID signature; gone devices are removed', async () => {
  resetVapid(); resetKeyCache(); const db = memDb(), r = receiver(), sent = [];
  const fetcher = async (url, opt) => {
    if (url.includes('googleapis')) return new Response(JSON.stringify({keys: [jwk]}));
    sent.push([url, opt]); return new Response('', {status: url.includes('gone') ? 410 : 201});
  };
  const deps = {db: async () => db, fetcher, now: () => NOW};
  const key = await (await handlePush(req('/push/key', null, {method: 'GET'}), {}, deps)).json();
  assert.equal(unb64u(key.key).length, 65); assert.ok(db.data['serverKeys/vapid'].privateJwk, 'kept on the server only');
  const sub = {endpoint: 'https://push.services.example/push/abc', keys: {p256dh: r.p256dh, auth: r.auth}};
  assert.equal((await handlePush(req('/push/subscribe', {subscription: sub}), {}, deps)).status, 200);
  assert.equal((await handlePush(req('/push/subscribe', {subscription: {...sub, endpoint: 'http://x'}}), {}, deps)).status, 400);
  assert.equal((await handlePush(req('/push/subscribe', {subscription: sub}, {tok: 'bad'}), {}, deps)).status, 401);
  const out = await (await handlePush(req('/push/test', {}), {}, deps)).json();
  assert.equal(out.sent, 1);
  const [url, opt] = sent[0]; assert.equal(url, sub.endpoint); assert.equal(opt.headers['Content-Encoding'], 'aes128gcm');
  assert.match(r.decrypt(Buffer.from(opt.body)), /通知のテスト/);
  const m = opt.headers.Authorization.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/); assert.ok(m);
  assert.equal(JSON.parse(Buffer.from(m[2], 'base64url')).aud, 'https://push.services.example');
  const pub = createPublicKey({key: {kty: 'EC', crv: 'P-256', x: b64u(unb64u(m[4]).slice(1, 33)), y: b64u(unb64u(m[4]).slice(33))}, format: 'jwk'});
  assert.ok(verify('sha256', Buffer.from(m[1] + '.' + m[2]), {key: pub, dsaEncoding: 'ieee-p1363'}, Buffer.from(m[3], 'base64url')), 'VAPID signature');
  // a device that is gone is removed
  await db.set(db.collection('pushSubs').doc('gone'), {ownerUid: 'alice', endpoint: 'https://gone.example/p', p256dh: r.p256dh, auth: r.auth});
  assert.equal(await pushToOwner(db, 'alice', {title: 't'}, {fetcher, now: () => NOW}), 1); assert.equal('pushSubs/gone' in db.data, false);
  // someone else cannot remove my device
  await handlePush(req('/push/subscribe', {subscription: sub, action: 'remove'}, {tok: token('bob')}), {}, deps);
  assert.equal(Object.keys(db.data).filter(k => k.startsWith('pushSubs/')).length, 1);
  await handlePush(req('/push/subscribe', {subscription: sub, action: 'remove'}), {}, deps);
  assert.equal(Object.keys(db.data).filter(k => k.startsWith('pushSubs/')).length, 0);
});
