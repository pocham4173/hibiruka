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
    const name = t['name:ja'] || t.name || (t.leisure === 'dog_park' ? 'ドッグラン' : '');
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const id = `${e.type[0]}${e.id}`;
    if (seen.has(id)) continue; seen.add(id);
    const genre = GENRE[t.natural === 'hot_spring' ? 'hot_spring' : t.amenity] || GENRE[t.leisure] || GENRE[t.tourism] || '';
    const web = /^https?:\/\//.test(t.website || '') ? t.website.slice(0, 120) : '';
    for (const k of kinds(t)) out.push([k, id, name.slice(0, 60), r5(lat), r5(lng), genre, addr(t).slice(0, 40), (t.opening_hours || '').slice(0, 50), web]);
  }
  return out;
}
// GitHub の画面に理由が出るように（::warning:: / ::error::）
const note = (level, msg) => console.log(`::${level}::${String(msg).replace(/[\r\n]+/g, ' ').slice(0, 300)}`);
async function fetchPart(part) {
  let last;
  for (const url of MIRRORS) {
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query(part)), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'hibiruka-spots/1.0 (github.com/pocham4173/hibiruka)' }, signal: AbortSignal.timeout(240000) });
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
  const list = rows(await fetchAll());
  const counts = list.reduce((c, r) => (c[r[0]] = (c[r[0]] || 0) + 1, c), {});
  if ((counts.p || 0) < 100) throw Error('Too few parks (' + (counts.p || 0) + '); keeping the old file');
  const body = { area: '長野県', updated: new Date().toISOString().slice(0, 10), source: 'OpenStreetMap', fields: ['kind', 'id', 'name', 'lat', 'lng', 'genre', 'address', 'hours', 'website'], rows: list };
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/spots-nagano.json', JSON.stringify(body));
  console.log('spots', counts, 'bytes', fs.statSync('data/spots-nagano.json').size);
})().catch(e => { note('error', e.message); process.exitCode = 1; });
module.exports = { rows, kinds };
