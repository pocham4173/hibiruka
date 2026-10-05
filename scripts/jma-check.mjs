// 本物の気象庁データで天気の読み取りを確かめる（デプロイのときに実行。結果は注釈に出る）
import {forecastFor, URLS, buildPoints} from '../line-worker/weather.mjs';
const places = [['上田', 36.40, 138.25], ['軽井沢', 36.34, 138.63], ['東京', 35.68, 139.76], ['札幌', 43.06, 141.35], ['那覇', 26.21, 127.68]];
const day = k => new Date(Date.now() + 9 * 3600000 + k * 86400000).toISOString().slice(0, 10);
let bad = 0;
try {
  const [a, m] = await Promise.all([URLS.area, URLS.amedas].map(u => fetch(u).then(r => r.json())));
  console.log(`::notice::JMA points ${buildPoints(a, m).length} (offices ${Object.keys(a).length}, amedas ${Object.keys(m).length})`);
  for (let k = 0; k <= 6; k++) {
    const res = await forecastFor(places.map(([, lat, lng]) => ({lat, lng})), day(k));
    const line = places.map(([n], i) => `${n}:${res[i] ? `${res[i].code}/${res[i].max ?? '-'}/${res[i].min ?? '-'}/${res[i].rain ?? '-'}` : 'null'}`).join(' ');
    console.log(`::notice::${day(k)} ${line}`);
    if (res.filter(Boolean).length < places.length) bad++;
  }
  const raw = await fetch(URLS.forecast('200000')).then(r => r.json());
  console.log('::notice::nagano shape ' + JSON.stringify(raw.map(x => (x.timeSeries || []).map(t => [t.timeDefines?.length, (t.areas || []).map(a => a.area?.code + ':' + Object.keys(a).join('|'))]))).slice(0, 900));
} catch (e) { console.log('::warning::JMA check failed: ' + e.message); process.exitCode = 1; }
if (bad) { console.log(`::warning::JMA check: ${bad} day(s) with missing places`); process.exitCode = 1; }
