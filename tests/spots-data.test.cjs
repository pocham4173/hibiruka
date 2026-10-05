const {test} = require('node:test');
const assert = require('node:assert/strict');
const {rows, kinds} = require('../scripts/spots-data.cjs');
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
