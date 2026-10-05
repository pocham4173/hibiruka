// 📱 アプリからの通知（Web Push）。LINEの無料通数を使わずに、ホーム画面のヒビルカへお知らせを届ける。
// 暗号化は RFC 8291（aes128gcm）、送り主の証明は VAPID（RFC 8292）。どちらも Workers の WebCrypto だけで行う（無料）。
import { verifyIdToken } from './ai.mjs';
const ORIGINS = ['https://pocham4173.github.io'];
const enc = new TextEncoder();
export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
const cors = origin => ORIGINS.includes(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '86400', vary: 'origin' } : {};
const json = (body, status, origin) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors(origin) } });

// VAPID の鍵：最初に1回だけ作って、サーバー専用の serverKeys/vapid に保存（アプリからは読めない）
let vapidCache = null;
export async function vapidKeys(db) {
  if (vapidCache) return vapidCache;
  const ref = db.collection('serverKeys').doc('vapid');
  let snap = await ref.get();
  if (!snap.exists) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicKey = b64u(await crypto.subtle.exportKey('raw', pair.publicKey));
    const privateJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
    try { await db.create(ref, { publicKey, privateJwk, createdAt: new Date() }); } catch {}
    snap = await ref.get(); // 同時に作られたときは、先に保存された方を使う
  }
  const v = snap.data();
  vapidCache = { publicKey: v.publicKey, key: await crypto.subtle.importKey('jwk', JSON.parse(v.privateJwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  return vapidCache;
}
export function resetVapid() { vapidCache = null; }

async function vapidHeader(endpoint, vapid, now) {
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: 'mailto:okm.co@icloud.com' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.key, enc.encode(head + '.' + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}
const hkdf = async (salt, ikm, info, bytes) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bytes * 8));
// RFC 8291：受け取る端末の公開鍵（p256dh）と auth で中身を暗号化
export async function encryptPayload(text, p256dh, auth) {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const ua = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, eph.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, cat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(enc.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return cat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

const subId = async endpoint => b64u(await crypto.subtle.digest('SHA-256', enc.encode(endpoint))).slice(0, 40);
const okEndpoint = u => { try { const x = new URL(u); return x.protocol === 'https:' && u.length < 800; } catch { return false; } };

// その人の端末すべてに送る。届いた端末の数を返す。もう使えない端末（404/410）は消す。
export async function pushToOwner(db, uid, message, { fetcher = fetch, now = Date.now } = {}) {
  const subs = (await db.collection('pushSubs').where('ownerUid', '==', uid).limit(5).get()).docs;
  if (!subs.length) return 0;
  const vapid = await vapidKeys(db), text = JSON.stringify(message).slice(0, 3000);
  let ok = 0;
  for (const d of subs) {
    const s = d.data();
    try {
      const r = await fetcher(s.endpoint, { method: 'POST', headers: { TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: await vapidHeader(s.endpoint, vapid, now()) }, body: await encryptPayload(text, s.p256dh, s.auth), signal: AbortSignal.timeout(10000) });
      if (r.ok) ok++;
      else if (r.status === 404 || r.status === 410) await db.remove(d.ref).catch(() => {});
    } catch {}
  }
  return ok;
}

export async function handlePush(request, env, { db, fetcher = fetch, now = Date.now } = {}) {
  const origin = request.headers.get('origin') || '', path = new URL(request.url).pathname;
  if (request.method === 'OPTIONS') return new Response(null, { status: ORIGINS.includes(origin) ? 204 : 403, headers: cors(origin) });
  if (!ORIGINS.includes(origin)) return json({ error: 'origin' }, 403, origin);
  const store = await db();
  if (path === '/push/key') return json({ key: (await vapidKeys(store)).publicKey }, 200, origin);
  const uid = await verifyIdToken((request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), { fetcher, now: now() }).catch(() => null);
  if (!uid) return json({ error: 'auth' }, 401, origin);
  let body; try { body = JSON.parse((await request.text()).slice(0, 4000)); } catch { return json({ error: 'input' }, 400, origin); }
  const sub = body?.subscription || {}, endpoint = String(sub.endpoint || '');
  if (path === '/push/subscribe') {
    if (!okEndpoint(endpoint)) return json({ error: 'input' }, 400, origin);
    const ref = store.collection('pushSubs').doc(await subId(endpoint));
    if (body.action === 'remove') { const s = await ref.get(); if (s.exists && s.data().ownerUid === uid) await store.remove(ref); return json({ ok: true }, 200, origin); }
    const p256dh = String(sub.keys?.p256dh || ''), auth = String(sub.keys?.auth || '');
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,30}$/.test(auth)) return json({ error: 'input' }, 400, origin);
    await store.set(ref, { ownerUid: uid, endpoint, p256dh, auth, createdAt: new Date(now()) });
    return json({ ok: true }, 200, origin);
  }
  if (path === '/push/test') {
    const n = await pushToOwner(store, uid, { title: '🔔 ヒビルカ', body: '通知のテストです。予定のお知らせはこのように届きます。', url: './' }, { fetcher, now });
    return json({ sent: n }, n ? 200 : 404, origin);
  }
  return json({ error: 'not_found' }, 404, origin);
}
