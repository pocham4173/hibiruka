const {test}=require('node:test');
const assert=require('node:assert/strict');
const P=require('../index/index/calendar-photo.js');
const grid=require('./fixtures/calendar-grid.cjs');
const parse=(blocks)=>P.parseGrid({months:blocks},2026);
test('photo grid validates Sunday/Monday starts, year rollover, leap month and preserves every mark including pink',()=>{
 for(const start of [0,1]){
  const months=parse([grid(2026,10,{10:'A',24:'A',3:'B',12:'B',17:'B',31:'B',4:'all',11:'all',18:'all',25:'all'},start),grid(2027,2,{},start)]);
  assert.equal(months[0].days[9].kind,'A');assert.equal(months[0].days[11].kind,'B');assert.equal(months[0].days.filter(d=>d.kind==='all').length,4);assert.equal(months[1].days.length,28);
 }
 const padded=grid();padded.rows.push(Array(7).fill(null));assert.equal(parse([padded])[0].days.length,31);
 assert.equal(P.parseGrid({months:[grid(2028,2)]},2028)[0].days.length,29);
});
test('wrong weekdays, shifted dates, duplicates, missing days, partial months and invented years cannot produce a draft',()=>{
 for(const mutate of [b=>b.weekdays.reverse(),b=>b.rows[1][6]='12:A',b=>b.rows[2][1]='10:A',b=>b.rows[2][1]=null,b=>b.rows.pop(),b=>b.complete=false,b=>b.year=2027,b=>b.rows[0][0]='27',b=>b.rows[1][6]='10:admin']){
  const block=grid();mutate(block);assert.throws(()=>parse([block]));
 }
 assert.throws(()=>parse([grid(),grid()]));assert.throws(()=>parse([]));
});
test('reimport clears the reported shifted marks only in the confirmed month and allows a confirmed empty month',()=>{
 const old={'2026-10-03':'B','2026-10-12':'A','2026-10-13':'B','2026-10-19':'A','2026-10-20':'B','2026-10-26':'A','2026-10-27':'B','2026-11-07':'A'};
 const draft=parse([grid(2026,10,{10:'A',24:'A',3:'B',12:'B',17:'B',31:'B',4:'all',11:'all',18:'all',25:'all'}),grid(2026,11,{})]);
 const patch=P.replacementChanges(old,draft,['2026-10'],old);
 assert.equal(patch['2026-10-12'],'B');for(const d of [13,19,20,26,27])assert.equal(patch[`2026-10-${d}`],'');
 assert.equal(patch['2026-11-07'],undefined);
 assert.equal(P.replacementChanges(old,draft,['2026-11'],old)['2026-11-07'],'');
});
test('unknown marks, incomplete client data, unapproved months and concurrent edits block replacement',()=>{
 const months=parse([grid(2026,10,{10:'unknown'})]);
 assert.throws(()=>P.replacementChanges({},months,['2026-10'],{}),/要確認/);
 assert.throws(()=>P.replacementChanges({},months,[],{}));
 assert.throws(()=>P.replacementChanges({},months,['2026-11'],{}));
 assert.throws(()=>P.validateDraft([{month:'2026-10',days:[{date:'2026-10-10',kind:'A'}]}]));
 const valid=parse([grid()]);
 assert.throws(()=>P.replacementChanges({'2026-10-12':'off'},valid,['2026-10'],{}),/確認中/);
 assert.throws(()=>P.replacementChanges({},valid,['2026-10'],{'2026-10-12':'off'}),/確認中/);
 assert.doesNotThrow(()=>P.replacementChanges({'2026-11-12':'off'},valid,['2026-10'],{}));
});
