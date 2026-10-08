// LINEの送信先（招待・自分のLINE登録）の承認を、サーバーで確定する。
// ブラウザから届くLINE IDは信用しない。LIFFのアクセストークンをLINEに問い合わせ、
// ヒビルカのLIFF（チャネル）で発行された本物のトークンかを確かめてから、その本人のLINE IDを保存する。
import { verifyIdToken, cors } from './ai.mjs';
const ORIGINS = ['https://pocham4173.github.io'];
export const LIFF_CHANNEL = '2011755874'; // LIFF ID「2011755874-…」のチャネル
export const INVITE_DAYS = 30; // 作成（または送り直し）から30日で期限切れ
const json = (body, status, origin) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors(origin) } });
const ms = v => v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN;

// LINEのアクセストークンを確かめて、本人のLINE IDと表示名を返す（にせもの・期限切れ・別アプリのものは null）
export async function lineUserFromToken(token, fetcher = fetch) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 400) return null;
  const v = await fetcher('https://api.line.me/oauth2/v2.1/verify?access_token=' + encodeURIComponent(token), { signal: AbortSignal.timeout(8000) });
  if (!v.ok) return null;
  const info = await v.json().catch(() => ({}));
  if (String(info.client_id) !== LIFF_CHANNEL || !(Number(info.expires_in) > 0)) return null;
  const p = await fetcher('https://api.line.me/v2/profile', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) });
  if (!p.ok) return null;
  const prof = await p.json().catch(() => ({}));
  if (!/^U[0-9a-f]{32}$/i.test(prof.userId || '')) return null;
  return { userId: prof.userId, name: String(prof.displayName || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 40) };
}

// 招待を承認済みにする。同じ人がもう一度開いたときはそのままOK、別のLINEで使い回すことはできない。
export async function acceptInvite(db, { scope, invite, uid, line, now = Date.now() }) {
  const ref = db.collection(scope === 'personal' ? 'personalFriends' : 'friends').doc(invite);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { error: 'missing' };
    const f = snap.data();
    if (f.status === 'joined') return f.lineUserId === line.userId ? { ok: true, again: true } : { error: 'used' };
    if (f.status !== 'pending') return { error: 'missing' };
    const born = Math.max(ms(f.createdAt) || 0, ms(f.sentAt) || 0);
    if (!born || now - born > INVITE_DAYS * 86400000) return { error: 'expired' };
    tx.update(ref, { status: 'joined', lineUserId: line.userId, lineName: line.name, joinedAt: new Date(now), ...(scope === 'personal' ? { acceptedBy: uid } : {}) });
    return { ok: true, self: f.name === '自分' };
  });
}

export async function handleAccept(request, env, { db, fetcher = fetch, now = Date.now } = {}) {
  const origin = request.headers.get('origin') || '';
  if (request.method === 'OPTIONS') return new Response(null, { status: ORIGINS.includes(origin) ? 204 : 403, headers: cors(origin) });
  if (!ORIGINS.includes(origin)) return json({ error: 'origin' }, 403, origin);
  const uid = await verifyIdToken((request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), { fetcher, now: now() }).catch(() => null);
  if (!uid) return json({ error: 'auth' }, 401, origin);
  let body; try { body = JSON.parse((await request.text()).slice(0, 2000)); } catch { return json({ error: 'input' }, 400, origin); }
  const invite = String(body?.invite || ''), scope = body?.scope === 'personal' ? 'personal' : 'legacy';
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(invite)) return json({ error: 'input' }, 400, origin);
  const line = await lineUserFromToken(body?.lineToken, fetcher).catch(() => null);
  if (!line) return json({ error: 'line' }, 401, origin);
  const r = await acceptInvite(await db(), { scope, invite, uid, line, now: now() });
  return json(r, r.ok ? 200 : r.error === 'missing' ? 404 : 409, origin);
}
