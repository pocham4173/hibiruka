const {test} = require('node:test');
const assert = require('node:assert/strict');
const {rows, kinds, keepRicher, michiRows} = require('../scripts/spots-data.cjs');
test('places are sorted into parks, hot springs and dog-friendly spots with compact rows', () => {
  assert.deepEqual(kinds({leisure: 'park'}), ['p']);
  assert.deepEqual(kinds({amenity: 'public_bath', name: '別所温泉 大湯'}), ['o']);
  assert.deepEqual(kinds({leisure: 'dog_park'}), ['d']);
  assert.deepEqual(kinds({tourism: 'viewpoint', dog: 'yes'}), ['p', 'd']);
  const r = rows([
    {type: 'node', id: 1, lat: 36.3612345, lon: 138.1823456, tags: {name: '別所温泉 大湯', amenity: 'public_bath', 'addr:city': '上田市', opening_hours: '06:00-22:00', website: 'https://example.jp'}},
    {type: 'way', id: 2, center: {lat: 36.4, lon: 138.24}, tags: {name: '上田城跡公園', leisure: 'park'}},
    {type: 'way', id: 2, center: {lat: 36.4, lon: 138.24}, tags: {name: '上田城跡公園', leisure: 'park'}},
    {type: 'node', id: 3, lat: 36.4, lon: 138.2, tags: {leisure: 'dog_park'}},
    {type: 'node', id: 4, lat: 36.4, lon: 138.2, tags: {leisure: 'park'}},
    {type: 'node', id: 5, tags: {name: 'no place', leisure: 'park'}},
  ]);
  assert.deepEqual(r[0], ['o', 'n1', '別所温泉 大湯', 36.36123, 138.18235, '温泉・銭湯', '上田市', '06:00-22:00', 'https://example.jp']);
  assert.deepEqual(r.map(x => x[0] + ':' + x[2]), ['o:別所温泉 大湯', 'p:上田城跡公園', 'd:ドッグラン'], 'duplicates, unnamed parks and missing positions are skipped');
});
test('closed places are dropped, near duplicates merged, and ; becomes ・', () => {
  const r = rows([
    {type: 'node', id: 1, lat: 36.4, lon: 138.2, tags: {name: 'ひな詩の湯（閉業）', amenity: 'public_bath'}},
    {type: 'node', id: 2, lat: 36.4001, lon: 138.2001, tags: {leisure: 'dog_park'}},
    {type: 'node', id: 3, lat: 36.4002, lon: 138.2002, tags: {leisure: 'dog_park'}},
    {type: 'node', id: 4, lat: 36.5, lon: 138.3, tags: {name: '真田温泉健康ランド;ふれあいさなだ館', amenity: 'public_bath'}},
  ]);
  assert.deepEqual(r.map(x => x[2]), ['ドッグラン', '真田温泉健康ランド・ふれあいさなだ館']);
});

test('a kind that shrank a lot keeps last week\'s places', () => {
  const old = [...Array(10)].map((_, i) => ['p', 'o' + i]).concat([['o', 'x']]);
  const fresh = [['p', 'n1'], ['o', 'y'], ['d', 'z']];
  const warned = [];
  const out = keepRicher(fresh, old, k => warned.push(k));
  assert.equal(out.filter(r => r[0] === 'p').length, 10); assert.deepEqual(warned, ['p']);
  assert.deepEqual(out.filter(r => r[0] !== 'p'), [['o', 'y'], ['d', 'z']]);
});

test('道の駅 rows: one per name, closed ones skipped', () => {
  const r = michiRows([
    {type: 'node', id: 1, lat: 36.36, lon: 138.36, tags: {name: '道の駅 雷電くるみの里', 'addr:city': '東御市'}},
    {type: 'way', id: 2, center: {lat: 36.3601, lon: 138.3601}, tags: {name: '道の駅 雷電くるみの里'}},
    {type: 'node', id: 3, lat: 36, lon: 138, tags: {name: '道の駅 むかし（閉館）'}},
    {type: 'node', id: 4, lat: 36, lon: 138, tags: {name: 'ただの駐車場'}},
  ]);
  assert.deepEqual(r, [['n1', '道の駅 雷電くるみの里', 36.36, 138.36, '東御市', '', '']]);
});
