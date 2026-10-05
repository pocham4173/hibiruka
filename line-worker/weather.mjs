// 天気予報：気象庁ホームページの天気予報データ（政府標準利用規約・出典を表示すれば商用利用も可）
// 位置 → いちばん近い予報地点（アメダス）→ その府県予報区の予報（3日予報＋週間予報、最大7日）
const ORIGINS = ['https://pocham4173.github.io'];
const JMA = 'https://www.jma.go.jp/bosai';
export const URLS = {
  area: JMA + '/forecast/const/forecast_area.json',
  amedas: JMA + '/amedas/const/amedastable.json',
  forecast: office => `${JMA}/forecast/data/forecast/${office}.json`,
};
const cors = origin => ORIGINS.includes(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'origin' } : {};
const json = (body, status, origin) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors(origin) } });
const num = v => (v === '' || v == null) ? NaN : Number(v);
const deg = v => Array.isArray(v) ? Number(v[0]) + Number(v[1] || 0) / 60 : Number(v);
const day = s => String(s || '').slice(0, 10);

// 気象庁の天気コード（100番台＝晴れ、200番台＝くもり、300番台＝雨、400番台＝雪）→ アプリで使う天気の種類
//   0 晴れ / 1 晴れ時々くもり / 2 晴れ時々雨 / 5 晴れ時々雪 / 3 くもり / 4 くもり時々雨 / 6 くもり時々雪 / 61 雨 / 71 雪 / 95 雷雨
const SNOWY = new Set([104, 105, 106, 107, 115, 116, 117, 118, 124, 160, 170, 181, 204, 205, 206, 207, 215, 216, 217, 218, 228, 229, 230, 250, 260, 270, 281]);
export function kindCode(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return NaN;
  if (c >= 100 && c < 200) return [100, 123, 124, 130, 131].includes(c) ? 0 : [101, 110, 111, 132].includes(c) ? 1 : SNOWY.has(c) ? 5 : 2;
  if (c >= 200 && c < 300) return [200, 209, 231].includes(c) ? 3 : SNOWY.has(c) ? 6 : 4;
  if (c >= 300 && c < 400) return c === 350 ? 95 : 61;
  if (c >= 400 && c < 500) return 71;
  return NaN;
}

// 予報地点の一覧：[府県予報区, 一次細分区域, アメダス番号, 緯度, 経度]
export function buildPoints(areaJson, amedasJson) {
  const out = [];
  for (const [office, list] of Object.entries(areaJson || {})) {
    for (const a of Array.isArray(list) ? list : []) {
      for (const code of [].concat(a?.amedas || [])) {
        const st = amedasJson?.[code]; if (!st) continue;
        const lat = deg(st.lat), lng = deg(st.lon);
        if (Number.isFinite(lat) && Number.isFinite(lng)) out.push([office, String(a.class10 || ''), String(code), lat, lng]);
      }
    }
  }
  return out;
}
const dist2 = (p, lat, lng) => { const dy = p[3] - lat, dx = (p[4] - lng) * Math.cos(lat * Math.PI / 180); return dx * dx + dy * dy; };
export function nearest(points, lat, lng) {
  let best = null, bd = Infinity;
  for (const p of points) { const d = dist2(p, lat, lng); if (d < bd) { bd = d; best = p; } }
  // 日本の外（いちばん近い地点まで約1.5度以上）は予報なし
  return best && bd < 2.25 ? best : null;
}

// 1つの府県予報区のデータから、ある日の天気を取り出す
export function pick(data, point, date) {
  if (!Array.isArray(data) || !point) return null;
  const [, class10, amedas, lat, lng] = point;
  const short = data[0]?.timeSeries || [], week = data[1]?.timeSeries || [];
  let code = NaN, rain = NaN, max = NaN, min = NaN;
  // 3日予報（今日・明日・あさって）
  const ws = short[0];
  if (ws) {
    const area = ws.areas?.find(a => a.area?.code === class10) || ws.areas?.[0];
    const i = (ws.timeDefines || []).findIndex(t => day(t) === date);
    if (area && i >= 0) code = kindCode(area.weatherCodes?.[i]);
  }
  const ps = short[1];
  if (ps) {
    const area = ps.areas?.find(a => a.area?.code === class10) || ps.areas?.[0];
    const vals = (ps.timeDefines || []).map((t, i) => day(t) === date ? num(area?.pops?.[i]) : NaN).filter(Number.isFinite);
    if (vals.length) rain = Math.max(...vals);
  }
  const ts = short[2];
  if (ts) {
    const area = ts.areas?.find(a => a.area?.code === amedas) || ts.areas?.[0];
    (ts.timeDefines || []).forEach((t, i) => { if (day(t) !== date) return; const v = num(area?.temps?.[i]); if (!Number.isFinite(v)) return; if (String(t).slice(11, 13) === '09') max = v; else if (String(t).slice(11, 13) === '00') min = v; });
    if (min === max && date === day(ts.timeDefines?.[0])) min = NaN; // 今日の朝の最低気温はもう過ぎて、最高気温が入っている
  }
  // 週間予報（4日目以降と、3日予報にない値）
  const ww = week[0], wt = week[1];
  if (ww) {
    const i = (ww.timeDefines || []).findIndex(t => day(t) === date);
    if (i >= 0) {
      const tempAreas = wt?.areas || [];
      let k = ww.areas?.findIndex(a => a.area?.code === class10) ?? -1;
      if (k < 0) k = tempAreas.findIndex(a => a.area?.code === amedas);
      if (k < 0) k = 0;
      const area = ww.areas?.[k] || ww.areas?.[0];
      if (!Number.isFinite(code)) code = kindCode(area?.weatherCodes?.[i]);
      if (!Number.isFinite(rain)) rain = num(area?.pops?.[i]);
      const tj = (wt?.timeDefines || []).findIndex(t => day(t) === date);
      const ta = tempAreas.find(a => a.area?.code === amedas) || tempAreas[k] || tempAreas[0];
      if (tj >= 0 && ta) {
        if (!Number.isFinite(max)) max = num(ta.tempsMax?.[tj]);
        if (!Number.isFinite(min)) min = num(ta.tempsMin?.[tj]);
      }
    }
  }
  if (!Number.isFinite(code)) return null;
  return { code, ...(Number.isFinite(max) ? { max } : {}), ...(Number.isFinite(min) ? { min } : {}), ...(Number.isFinite(rain) ? { rain } : {}) };
}

let pointsCache = null;
async function getJson(fetcher, url, ttl) {
  const r = await fetcher(url, { cf: { cacheTtl: ttl, cacheEverything: true }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw Error('jma ' + r.status);
  return r.json();
}
export function resetWeatherCache() { pointsCache = null; }
export async function forecastFor(list, date, { fetcher = fetch, now = Date.now } = {}) {
  if (!pointsCache || pointsCache.at < now() - 86400000) {
    const [area, amedas] = await Promise.all([getJson(fetcher, URLS.area, 86400), getJson(fetcher, URLS.amedas, 86400)]);
    pointsCache = { at: now(), points: buildPoints(area, amedas) };
  }
  const near = list.map(p => nearest(pointsCache.points, p.lat, p.lng));
  const offices = [...new Set(near.filter(Boolean).map(p => p[0]))].slice(0, 8);
  const data = Object.fromEntries(await Promise.all(offices.map(o => getJson(fetcher, URLS.forecast(o), 1800).then(d => [o, d], () => [o, null]))));
  return near.map(p => p && data[p[0]] ? pick(data[p[0]], p, date) : null);
}

const jstToday = now => new Date(now + 9 * 3600000).toISOString().slice(0, 10);
export async function handleWeather(request, env, { fetcher = fetch, now = Date.now } = {}) {
  const origin = request.headers.get('origin') || '';
  if (request.method === 'OPTIONS') return new Response(null, { status: ORIGINS.includes(origin) ? 204 : 403, headers: cors(origin) });
  if (!ORIGINS.includes(origin)) return json({ error: 'origin' }, 403, origin);
  const body = await request.json().catch(() => null);
  const pts = (Array.isArray(body?.points) ? body.points : []).slice(0, 25).map(p => ({ lat: Number(p?.lat), lng: Number(p?.lng) }));
  if (!pts.length || pts.some(p => !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180)) return json({ error: 'points' }, 400, origin);
  const today = jstToday(now());
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body?.date || '') ? body.date : today;
  if (date < today) return json({ error: 'date' }, 400, origin);
  try { return json({ results: await forecastFor(pts, date, { fetcher, now }) }, 200, origin); }
  catch { return json({ error: 'busy' }, 502, origin); }
}
