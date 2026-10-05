// 長野県の「公園・お出かけ」「温泉」「わんこOK」を OpenStreetMap からまとめて data/spots-nagano.json にする。
// GitHub Actions で週1回動かす。アプリはこのファイルを読むだけなので、押した瞬間に出せる。
const fs = require('node:fs');
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
// 県全体を1回で取ると重いので、種類ごとに分けて取る
const PARTS = [
  'nwr["leisure"="park"]["name"](area.a);',
  'nwr["tourism"~"^(attraction|museum|viewpoint|zoo|aquarium|theme_park|gallery)$"]["name"](area.a);',
  'nwr["amenity"="public_bath"]["name"](area.a);nwr["leisure"~"^(spa|sauna)$"]["name"](area.a);nwr["natural"="hot_spring"]["name"](area.a);',
  'nwr["leisure"="dog_park"](area.a);nwr["dog"~"^(yes|leashed)$"]["name"](area.a);',
];
const query = part => `[out:json][timeout:180];area["ISO3166-2"="JP-20"]["admin_level"="4"]->.a;(${part});out center tags;`;
// 道の駅は全国（約1,200か所）
const MICHI_QUERY = `[out:json][timeout:300];area["ISO3166-1"="JP"]["admin_level"="2"]->.a;(nwr["name"~"^道の駅"](area.a););out center tags;`;
const GENRE = { park: '公園', attraction: '観光スポット', museum: '博物館・美術館', viewpoint: '景色のいい場所', zoo: '動物園', aquarium: '水族館', theme_park: 'テーマパーク', gallery: 'ギャラリー',
  public_bath: '温泉・銭湯', spa: 'スパ', sauna: 'サウナ', hot_spring: '温泉', dog_park: 'ドッグラン' };
const r5 = n => Math.round(n * 1e5) / 1e5;
const addr = t => [t['addr:city'], t['addr:quarter'] || t['addr:suburb'], t['addr:neighbourhood']].filter(Boolean).join('');
// 1つの場所が、どの種類（p=公園・お出かけ, o=温泉, d=わんこ）に入るか
function kinds(t) {
  const k = [];
  if (t.leisure === 'park' || /^(attraction|museum|viewpoint|zoo|aquarium|theme_park|gallery)$/.test(t.tourism || '')) k.push('p');
  if (t.amenity === 'public_bath' || /^(spa|sauna)$/.test(t.leisure || '') || t.natural === 'hot_spring') k.push('o');
  if (t.leisure === 'dog_park' || /^(yes|leashed)$/.test(t.dog || '')) k.push('d');
  return [...new Set(k)];
}
function rows(elements) {
  const out = [], seen = new Set();
  for (const e of elements || []) {
    const t = e.tags || {}, lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
    const name = String(t['name:ja'] || t.name || (t.leisure === 'dog_park' ? 'ドッグラン' : '')).replace(/\s*;\s*/g, '・');
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (/閉業|閉店|廃業|閉館|休業中/.test(name) || t['disused:amenity'] || t.disused === 'yes') continue; // もう無い場所は出さない
    const id = `${e.type[0]}${e.id}`;
    if (seen.has(id)) continue; seen.add(id);
    // 同じ名前でほぼ同じ場所（約100m以内）は1つにまとめる
    const near = `${name}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
    if (seen.has(near)) continue; seen.add(near);
    const genre = GENRE[t.natural === 'hot_spring' ? 'hot_spring' : t.amenity] || GENRE[t.leisure] || GENRE[t.tourism] || '';
    const web = /^https?:\/\//.test(t.website || '') ? t.website.slice(0, 120) : '';
    for (const k of kinds(t)) out.push([k, id, name.slice(0, 60), r5(lat), r5(lng), genre, addr(t).slice(0, 40), (t.opening_hours || '').slice(0, 50), web]);
  }
  return out;
}
// GitHub の画面に理由が出るように（::warning:: / ::error::）
const note = (level, msg) => console.log(`::${level}::${String(msg).replace(/[\r\n]+/g, ' ').slice(0, 300)}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
async function fetchPart(part, q = query(part)) {
  let last;
  // 地図サーバーが混んでいるときは、少し待って最大3回までやり直す
  for (let round = 0; round < 3; round++) {
    if (round) { note('warning', `busy; retrying in ${round * 60}s`); await wait(round * 60000); }
    try { return await fetchOnce(q); } catch (e) { last = e; }
  }
  throw last;
}
async function fetchOnce(q) {
  let last;
  for (const url of MIRRORS) {
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'hibiruka-spots/1.0 (github.com/pocham4173/hibiruka)' }, signal: AbortSignal.timeout(240000) });
      const text = await r.text();
      if (!r.ok) throw Error(`${new URL(url).host} HTTP ${r.status}: ${text.slice(0, 120)}`);
      const j = JSON.parse(text);
      if (j.remark) note('warning', `${new URL(url).host} remark: ${j.remark}`);
      if (!Array.isArray(j.elements)) throw Error(`${new URL(url).host} no elements`);
      return j.elements;
    } catch (e) { last = e; note('warning', e.message); }
  }
  throw last;
}
async function fetchAll() {
  const all = [];
  for (const part of PARTS) { const els = await fetchPart(part); console.log('part', part.slice(0, 40), els.length); all.push(...els); }
  return all;
}
if (require.main === module) (async () => {
  let list = rows(await fetchAll());
  // サーバーによって返ってくる量がちがうことがあるので、種類ごとに前回より大きく減ったら前回の分を使う
  let old = [];
  try { old = JSON.parse(fs.readFileSync('data/spots-nagano.json', 'utf8')).rows || []; } catch {}
  list = keepRicher(list, old, k => note('warning', `kind ${k}: fewer places than last time; keeping the previous data`));
  const counts = list.reduce((c, r) => (c[r[0]] = (c[r[0]] || 0) + 1, c), {});
  if ((counts.p || 0) < 100) throw Error('Too few parks (' + (counts.p || 0) + '); keeping the old file');
  const body = { area: '長野県', updated: new Date().toISOString().slice(0, 10), source: 'OpenStreetMap', fields: ['kind', 'id', 'name', 'lat', 'lng', 'genre', 'address', 'hours', 'website'], rows: list };
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/spots-nagano.json', JSON.stringify(body));
  console.log('spots', counts, 'bytes', fs.statSync('data/spots-nagano.json').size);
  // 道の駅（全国）。失敗したり少なすぎたりしたら、前のファイルのまま
  try {
    const michi = michiRows(await fetchPart('', MICHI_QUERY));
    let oldCount = 0; try { oldCount = (JSON.parse(fs.readFileSync('data/michinoeki.json', 'utf8')).rows || []).length; } catch {}
    if (michi.length < 500 || michi.length < oldCount * 0.85) note('warning', `michi: only ${michi.length} (before ${oldCount}); keeping the previous file`);
    else { fs.writeFileSync('data/michinoeki.json', JSON.stringify({ area: '全国', updated: new Date().toISOString().slice(0, 10), source: 'OpenStreetMap', fields: ['id', 'name', 'lat', 'lng', 'city', 'hours', 'website'], rows: michi })); console.log('michi', michi.length); }
  } catch (e) { note('warning', 'michi: ' + e.message); }
})().catch(e => { note('error', e.message); process.exitCode = 1; });
function keepRicher(list, old, warn = () => {}) {
  const count = (rs, k) => rs.filter(r => r[0] === k).length;
  return ['p', 'o', 'd'].flatMap(k => {
    const n = count(list, k), o = count(old, k);
    if (o && n < o * 0.85) { warn(k); return old.filter(r => r[0] === k); }
    return list.filter(r => r[0] === k);
  });
}
// 道の駅：[id, 名前, 緯度, 経度, 住所, 営業時間, ウェブ]。同じ名前は1つに（店・駐車場などが別々に登録されていることがある）
function michiRows(elements) {
  const out = [], seen = new Set();
  for (const e of elements || []) {
    const t = e.tags || {}, lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
    const name = String(t['name:ja'] || t.name || '').trim();
    if (!/^道の駅/.test(name) || !Number.isFinite(lat) || !Number.isFinite(lng) || /閉業|閉館|廃止/.test(name)) continue;
    const key = name.replace(/\s+/g, '');
    if (seen.has(key)) continue; seen.add(key);
    const city = [t['addr:province'], t['addr:city']].filter(Boolean).join('');
    out.push([`${e.type[0]}${e.id}`, name.slice(0, 60), r5(lat), r5(lng), city.slice(0, 30), (t.opening_hours || '').slice(0, 50), /^https?:\/\//.test(t.website || '') ? t.website.slice(0, 120) : '']);
  }
  return out;
}
module.exports = { rows, kinds, keepRicher, michiRows };
