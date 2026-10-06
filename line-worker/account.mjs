// アカウントの削除と、問い合わせ番号。
// 削除は本人（ログイン中の本人の証明つき）だけ。サーバー専用の記録（LINEのつながり・通知先）もここで一緒に消す。
import { verifyIdToken, cors } from './ai.mjs';
const ORIGINS = ['https://pocham4173.github.io'];
const json = (body, status, origin) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors(origin) } });

// 問い合わせ番号：中身（ID）が分からない短い番号。アプリとLINEで同じ番号になる
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export async function inquiryNo(uid) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hibiruka:' + uid)));
  const s = Array.from(h.slice(0, 8), b => ABC[b & 31]).join('');
  return s.slice(0, 4) + '-' + s.slice(4);
}

// 持ち主が ownerUid の文書を、まとめて消す（1回で消しきれないときは more を返す）
const OWNED = ['personalPhotos', 'personalEvents', 'personalFriends', 'lineLinkCodes', 'pushSubs'];
export async function deleteAccountData(db, uid) {
  let deleted = 0;
  for (const c of OWNED) {
    for (let round = 0; round < 4; round++) {
      const docs = (await db.collection(c).where('ownerUid', '==', uid).select('ownerUid').limit(300).get()).docs;
      if (!docs.length) break;
      await db.commit(docs.map(d => ({ ref: d.ref, remove: true })));
      deleted += docs.length;
      if (docs.length < 300) break;
      if (round === 3) return { deleted, more: true };
    }
  }
  // LINEのつながり（サーバー専用の lineAccounts も、本人のものだけ）
  const link = await db.collection('lineLinks').doc(uid).get();
  const lineUserId = link.exists ? link.data().lineUserId : '';
  const ops = [{ ref: db.collection('lineLinks').doc(uid), remove: true }, { ref: db.collection('personalConfig').doc(uid), remove: true }];
  if (typeof lineUserId === 'string' && /^U[0-9a-f]{32}$/i.test(lineUserId)) {
    const acc = await db.collection('lineAccounts').doc(lineUserId).get();
    if (acc.exists && acc.data().ownerUid === uid) ops.push({ ref: acc.ref, remove: true });
  }
  await db.commit(ops);
  return { deleted: deleted + ops.length, more: false };
}

export async function handleAccount(request, env, { db, fetcher = fetch, now = Date.now } = {}) {
  const origin = request.headers.get('origin') || '';
  if (request.method === 'OPTIONS') return new Response(null, { status: ORIGINS.includes(origin) ? 204 : 403, headers: cors(origin) });
  if (!ORIGINS.includes(origin)) return json({ error: 'origin' }, 403, origin);
  if (new URL(request.url).pathname !== '/account/delete' || request.method !== 'POST') return json({ error: 'not_found' }, 404, origin);
  const uid = await verifyIdToken((request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), { fetcher, now: now() }).catch(() => null);
  if (!uid) return json({ error: 'auth' }, 401, origin);
  let body; try { body = JSON.parse((await request.text()).slice(0, 500)); } catch { return json({ error: 'input' }, 400, origin); }
  if (body?.confirm !== '削除') return json({ error: 'confirm' }, 400, origin);
  const store = await db();
  // 以前からの共有の記録（暗証番号の方式）は、この方法では消さない
  if ((await store.collection('members').doc(uid).get()).exists) return json({ error: 'legacy' }, 409, origin);
  return json(await deleteAccountData(store, uid), 200, origin);
}
