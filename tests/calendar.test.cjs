const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../index/index/calendar-core.js');
require('../index/index/calendar-data.js');
const data=globalThis.HibirukaCalendarData;
test('official holiday names include Sports Day, substitute and citizens holidays',()=>{
  assert.equal(C.dayInfo('2026-10-12',{},data).holiday,'スポーツの日');
  assert.equal(C.dayInfo('2026-09-22',{},data).holiday,'休日');
  assert.equal(C.dayInfo('2027-03-22',{},data).holiday,'休日');
  assert.equal(C.dayInfo('2021-07-23',{},data).holiday,'スポーツの日');
  assert.equal(C.dayInfo('2021-10-11',{},data).holiday,'');
});
test('Japanese lunar calendar fixtures and leap month boundaries; no invented out-of-range rokuyo',()=>{
  assert.equal(C.dayInfo('2021-01-01',{},data).rokuyo,'仏滅');
  assert.equal(C.dayInfo('2021-01-02',{},data).rokuyo,'大安');
  assert.equal(C.dayInfo('2025-07-25',{},data).rokuyo,'赤口');
  assert.equal(C.dayInfo('2033-01-01',{},data).rokuyo,'');
  assert.equal(C.dayInfo('2026-10-12',{showRokuyo:false},data).rokuyo,'');
});
test('my group only, all off, work and national holidays are independent',()=>{
  const a=C.cleanConfig({team:'A',days:{'2026-10-10':'A','2026-10-12':'B','2026-10-11':'all','2026-10-18':'work'}});
  assert(C.dayInfo('2026-10-10',a,data).off);
  assert(!C.dayInfo('2026-10-12',a,data).off);
  assert(C.dayInfo('2026-10-11',a,data).off);
  assert(!C.dayInfo('2026-10-18',a,data).off);
  assert(C.dayInfo('2026-10-12',{...a,team:'B'},data).off);
});
test('year rollover import is additive, invalid dates rejected, removal only touches the selected date',()=>{
  const current={team:'A',days:{'2026-10-10':'A','2027-01-09':'B'}};
  const next=C.mergeConfig(current,{'2027-01-16':'A'},{team:'B'});
  assert.equal(next.days['2026-10-10'],'A');assert.equal(next.days['2027-01-09'],'B');
  assert.equal(C.mergeConfig(next,{'2026-10-10':''},{}).days['2026-10-10'],undefined);
  assert.equal(current.days['2026-10-10'],'A');
  assert.throws(()=>C.mergeConfig(next,{'2027-02-29':'all'},{}));
  assert.throws(()=>C.mergeConfig(next,{'2026-10-10':'<script>'},{}));
});
