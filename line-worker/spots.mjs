// 探す：ホットペッパーグルメ（無料のWebサービス）でお店を探す。
// キーはWorkerの中だけに置き、アプリ（公開ページ）には出さない。使えるのはヒビルカの利用者だけ。
// キーは GitHub Secrets の HOTPEPPER_API_KEY（2026-10-05 登録）から配置のたびに渡す。
import { verifyIdToken, cors } from './ai.mjs';
const ORIGINS = ['https://pocham4173.github.io'];
const API = 'https://webservice.recruit.co.jp/hotpepper/gourmet/v1/';
// ジャンル（ホットペッパーのジャンルコード）
export const FILTERS = ['parking', 'private_room', 'child', 'non_smoking', 'free_food', 'free_drink', 'card', 'coupon'];
export const BUDGETS = ['B009', 'B010', 'B011', 'B001', 'B002', 'B003', 'B008', 'B004', 'B005', 'B006', 'B012', 'B013', 'B014'];
export const GENRES = { cafe: 'G014', sweets: 'G014', ramen: 'G013', yakiniku: 'G008', izakaya: 'G001', sushi: 'G004', lunch: '', dog: '', coupon: '' };
const json = (body, status, origin) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors(origin) } });
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const num = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) ? Number(v) : NaN;

export function buildQuery(body, key) {
  const count = Math.min(100, Math.max(1, Math.round(num(body.count)) || 30));
  const p = new URLSearchParams({ key, format: 'json', count: String(count) });
  const kind = GENRES[body.kind] !== undefined ? body.kind : '';
  const keyword = clean(body.keyword, 40);
  const lat = num(body.lat), lng = num(body.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    p.set('lat', lat.toFixed(5)); p.set('lng', lng.toFixed(5));
    p.set('range', String(Math.min(5, Math.max(1, Math.round(num(body.range)) || 5))));
    p.set('order', '4');
  }
  if (!p.has('lat') && !keyword) return null;
  if (GENRES[kind]) p.set('genre', GENRES[kind]);
  if (kind === 'lunch') p.set('lunch', '1');
  if (kind === 'dog') p.set('pet', '1'); // ペット可のお店だけ
  // こだわり条件（ホットペッパーの絞り込み）と予算（夜の平均予算のコード、2つまで）
  for (const f of Array.isArray(body.filters) ? body.filters : []) if (FILTERS.includes(f)) f === 'coupon' ? p.set('ktai_coupon', '0') : p.set(f, '1');
  if (kind === 'coupon') p.set('ktai_coupon', '0'); // ホットペッパー: 0 = 携帯クーポンあり
  for (const b of (Array.isArray(body.budget) ? body.budget : []).filter(b => BUDGETS.includes(b)).slice(0, 2)) p.append('budget', b);
  if (kind === 'sweets') p.set('keyword', [keyword, 'スイーツ'].filter(Boolean).join(' '));
  else if (kind === 'sushi') p.set('keyword', [keyword, '寿司'].filter(Boolean).join(' '));
  else if (keyword) p.set('keyword', keyword);
  return p;
}
export function shopOut(s) {
  const lat = num(s.lat), lng = num(s.lng);
  if (!s?.name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const url = s.urls?.pc && /^https:\/\//.test(s.urls.pc) ? s.urls.pc : '';
  const photo = s.photo?.mobile?.l || s.photo?.pc?.l || '';
  const couponUrl = [s.coupon_urls?.sp, s.coupon_urls?.pc].find(u => typeof u === 'string' && /^https:\/\//.test(u)) || '';
  return {
    id: 'hp:' + clean(s.id, 20), name: clean(s.name, 60), genre: clean(s.genre?.name, 30), catch: clean(s.genre?.catch || s.catch, 60),
    budget: clean(s.budget?.name, 30), address: clean(s.address, 80), access: clean(s.mobile_access || s.access, 60), hours: clean(s.open, 80),
    lat, lng, url, photo: /^https:\/\//.test(photo) ? photo : '',
    coupon: String(s.ktai_coupon) === '0', couponUrl: clean(couponUrl, 300),
  };
}
export async function handleSpots(request, env, { fetcher = fetch, now = Date.now } = {}) {
  const origin = request.headers.get('origin') || '';
  if (request.method === 'OPTIONS') return new Response(null, { status: ORIGINS.includes(origin) ? 204 : 403, headers: cors(origin) });
  if (!ORIGINS.includes(origin)) return json({ error: 'origin' }, 403, origin);
  if (!env.HOTPEPPER_API_KEY) return json({ error: 'not_configured' }, 503, origin);
  const uid = await verifyIdToken((request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), { fetcher, now: now() }).catch(() => null);
  if (!uid) return json({ error: 'auth' }, 401, origin);
  let body;
  try { body = JSON.parse((await request.text()).slice(0, 2000)); } catch { return json({ error: 'input' }, 400, origin); }
  const q = buildQuery(body || {}, env.HOTPEPPER_API_KEY);
  if (!q) return json({ error: 'input' }, 400, origin);
  let r;
  try { r = await fetcher(API + '?' + q.toString(), { signal: AbortSignal.timeout(10000) }); } catch { return json({ error: 'upstream' }, 502, origin); }
  if (!r.ok) { console.error('Hotpepper HTTP ' + r.status); return json({ error: 'upstream' }, 502, origin); }
  const data = await r.json().catch(() => ({}));
  if (data.results?.error) { console.error('Hotpepper error ' + String(data.results.error?.[0]?.code || '')); return json({ error: 'upstream' }, 502, origin); }
  const shops = (data.results?.shop || []).map(shopOut).filter(Boolean);
  return json({ shops, credit: 'ホットペッパーグルメ Webサービス' }, 200, origin);
}
