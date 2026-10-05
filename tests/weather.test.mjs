import {test} from 'node:test';
import assert from 'node:assert/strict';
import {kindCode, buildPoints, nearest, pick, forecastFor, handleWeather, resetWeatherCache, URLS} from '../line-worker/weather.mjs';

const AREA = {'200000': [{class10: '200010', amedas: ['48156'], class20: '2020100'}, {class10: '200020', amedas: ['48331', '48361'], class20: '2020300'}],
  '130000': [{class10: '130010', amedas: ['44132'], class20: '1310100'}]};
const AMEDAS = {'48156': {lat: [36, 39.6], lon: [138, 11.6], kjName: '長野'}, '48331': {lat: [36, 24.0], lon: [138, 15.0], kjName: '上田'},
  '48361': {lat: [36, 14.6], lon: [137, 58.2], kjName: '松本'}, '44132': {lat: [35, 41.5], lon: [139, 45.0], kjName: '東京'}};
const T = d => `2026-10-${d}T00:00:00+09:00`;
const NAGANO = [
  {timeSeries: [
    {timeDefines: ['2026-10-06T05:00:00+09:00', T('07'), T('08')], areas: [{area: {code: '200010'}, weatherCodes: ['100', '300', '200']}, {area: {code: '200020'}, weatherCodes: ['101', '313', '204']}]},
    {timeDefines: ['2026-10-06T06:00:00+09:00', '2026-10-06T12:00:00+09:00', '2026-10-06T18:00:00+09:00', T('07'), '2026-10-07T06:00:00+09:00', '2026-10-07T12:00:00+09:00', '2026-10-07T18:00:00+09:00'],
      areas: [{area: {code: '200010'}, pops: ['0', '10', '0', '30', '60', '70', '40']}, {area: {code: '200020'}, pops: ['10', '20', '10', '40', '80', '90', '50']}]},
    {timeDefines: ['2026-10-06T09:00:00+09:00', '2026-10-06T00:00:00+09:00', T('07'), '2026-10-07T09:00:00+09:00'],
      areas: [{area: {code: '48156'}, temps: ['22', '22', '12', '18']}, {area: {code: '48331'}, temps: ['24', '24', '13', '19']}]},
  ]},
  {timeSeries: [
    {timeDefines: [T('06'), T('07'), T('08'), T('09'), T('10'), T('11'), T('12')], areas: [{area: {code: '200010'}, weatherCodes: ['100', '300', '200', '101', '400', '201', '100'], pops: ['', '70', '30', '20', '80', '30', '10']},
      {area: {code: '200020'}, weatherCodes: ['101', '313', '204', '100', '302', '211', '110'], pops: ['', '90', '40', '10', '70', '20', '0']}]},
    {timeDefines: [T('06'), T('07'), T('08'), T('09'), T('10'), T('11'), T('12')], areas: [{area: {code: '48156'}, tempsMin: ['', '12', '10', '9', '8', '7', '9'], tempsMax: ['', '18', '20', '22', '15', '19', '21']},
      {area: {code: '48361'}, tempsMin: ['', '13', '11', '10', '9', '8', '10'], tempsMax: ['', '19', '21', '23', '16', '20', '22']}]},
  ]},
];

test('JMA weather codes become the app weather kinds', () => {
  assert.equal(kindCode('100'), 0); assert.equal(kindCode('101'), 1); assert.equal(kindCode('103'), 2); assert.equal(kindCode('105'), 5);
  assert.equal(kindCode('200'), 3); assert.equal(kindCode('202'), 4); assert.equal(kindCode('204'), 6);
  assert.equal(kindCode('300'), 61); assert.equal(kindCode('350'), 95); assert.equal(kindCode('400'), 71); assert.ok(Number.isNaN(kindCode('')));
});

test('a place goes to the nearest forecast point; far outside Japan has none', () => {
  const pts = buildPoints(AREA, AMEDAS);
  assert.equal(pts.length, 4);
  assert.deepEqual(nearest(pts, 36.40, 138.25).slice(0, 3), ['200000', '200020', '48331'], '上田');
  assert.deepEqual(nearest(pts, 35.68, 139.76).slice(0, 3), ['130000', '130010', '44132'], '東京');
  assert.equal(nearest(pts, 48.85, 2.35), null, 'Paris');
});

test('today and tomorrow come from the 3-day forecast, later days from the weekly one', () => {
  const ueda = ['200000', '200020', '48331', 36.4, 138.25];
  assert.deepEqual(pick(NAGANO, ueda, '2026-10-06'), {code: 1, max: 24, rain: 20}, 'today: morning low already passed');
  assert.deepEqual(pick(NAGANO, ueda, '2026-10-07'), {code: 61, max: 19, min: 13, rain: 90});
  assert.deepEqual(pick(NAGANO, ueda, '2026-10-08'), {code: 6, max: 21, min: 11, rain: 40}, 'day 3: code from 3-day, temps from the weekly point of that area');
  assert.deepEqual(pick(NAGANO, ueda, '2026-10-10'), {code: 61, max: 16, min: 9, rain: 70});
  assert.equal(pick(NAGANO, ueda, '2026-10-20'), null, 'beyond the forecast');
  const north = ['200000', '200010', '48156', 36.66, 138.19];
  assert.deepEqual(pick(NAGANO, north, '2026-10-09'), {code: 1, max: 22, min: 9, rain: 20});
});

function fakeFetch(calls) {
  return async url => { calls.push(url);
    const body = url === URLS.area ? AREA : url === URLS.amedas ? AMEDAS : url === URLS.forecast('200000') ? NAGANO : null;
    return body ? new Response(JSON.stringify(body)) : new Response('no', {status: 404}); };
}
const NOW = Date.parse('2026-10-06T00:00:00Z'); // 09:00 JST
const req = (body, origin = 'https://pocham4173.github.io') => new Request('https://w/weather', {method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: JSON.stringify(body)});

test('the weather endpoint answers several places at once and reads each office once', async () => {
  resetWeatherCache(); const calls = [];
  const res = await handleWeather(req({points: [{lat: 36.40, lng: 138.25}, {lat: 36.41, lng: 138.26}, {lat: 35.68, lng: 139.76}], date: '2026-10-07'}), {}, {fetcher: fakeFetch(calls), now: () => NOW});
  assert.equal(res.status, 200); assert.equal(res.headers.get('access-control-allow-origin'), 'https://pocham4173.github.io');
  const {results} = await res.json();
  assert.deepEqual(results[0], {code: 61, max: 19, min: 13, rain: 90}); assert.deepEqual(results[1], results[0]);
  assert.equal(results[2], null, 'Tokyo forecast missing → null, not an error');
  assert.equal(calls.filter(u => u === URLS.forecast('200000')).length, 1);
  await forecastFor([{lat: 36.4, lng: 138.25}], '2026-10-06', {fetcher: fakeFetch(calls), now: () => NOW});
  assert.equal(calls.filter(u => u === URLS.amedas).length, 1, 'point list is kept for a day');
});

test('the weather endpoint refuses other sites, bad points and past days', async () => {
  resetWeatherCache(); const deps = {fetcher: fakeFetch([]), now: () => NOW};
  assert.equal((await handleWeather(req({points: [{lat: 36.4, lng: 138.2}]}, 'https://evil.example'), {}, deps)).status, 403);
  assert.equal((await handleWeather(req({points: []}), {}, deps)).status, 400);
  assert.equal((await handleWeather(req({points: [{lat: 'x', lng: 1}]}), {}, deps)).status, 400);
  assert.equal((await handleWeather(req({points: [{lat: 36.4, lng: 138.2}], date: '2026-10-01'}), {}, deps)).status, 400);
  const busy = await handleWeather(req({points: [{lat: 36.4, lng: 138.2}]}), {}, {fetcher: async () => new Response('', {status: 503}), now: () => NOW});
  assert.equal(busy.status, 502);
});
