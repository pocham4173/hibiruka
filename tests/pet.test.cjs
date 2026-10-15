const {test}=require('node:test');const assert=require('node:assert/strict');const P=require('../index/index/pet-core.js');
test('pet elapsed days are calendar days, handle leap days and reject unknown or impossible dates',()=>{
 assert.equal(P.days('2020-02-28','2020-03-01'),2);assert.equal(P.days('2020-02-29','2020-02-29'),0);assert.equal(P.days('2020-02-29','2021-03-01'),366);
 for(const d of ['','2021-02-29','2026-13-01','2026-04-31','tomorrow'])assert.equal(P.days(d,'2026-10-15'),null);
 assert.equal(P.days('2026-10-16','2026-10-15'),null);assert.equal(P.age('2020-09-30','2026-10-15'),'6歳0か月');
});
test('pet profiles accept unknown/estimated dates but refuse reversed and future dates',()=>{
 assert.equal(P.profile({name:'test',birthdayEstimated:true},'2026-10-15').birthday,'');
 assert.throws(()=>P.profile({name:'test',birthday:'2026-10-16'},'2026-10-15'));
 assert.throws(()=>P.profile({name:'test',birthday:'2020-02-29',welcome:'2020-02-28'},'2026-10-15'));
 assert.throws(()=>P.profile({name:'test',photo:'javascript:alert(1)'},'2026-10-15'));
});
test('pet weight belongs to exactly one dog, while memories support multiple dogs and unassigned',()=>{
 assert.deepEqual(P.fields(['a','b','a'],'思い出',''),{petIds:['a','b'],petCareType:'思い出',petWeightKg:null});assert.equal(P.fields([],'思い出','').petCareType,'');
 for(const ids of [[],['a','b']])assert.throws(()=>P.fields(ids,'体重',3.8));for(const w of ['',0,-1,'bad',201])assert.throws(()=>P.fields(['a'],'体重',w));assert.equal(P.fields(['a'],'体重','3.8').petWeightKg,3.8);
});

test('pet durations include full years and months for both milestones',()=>{
 assert.equal(P.duration('2020-09-30','2026-10-15'),'6年0か月');
 assert.equal(P.duration('2020-01-25','2026-10-15'),'6年8か月');
 assert.equal(P.duration('2020-02-29','2020-02-29'),'0年0か月');
 assert.equal(P.duration('2020-02-29','2021-02-28'),'0年11か月');
 assert.equal(P.duration('2020-02-29','2021-03-01'),'1年0か月');
 assert.equal(P.duration('2020-01-31','2020-03-01'),'0年1か月');
 for(const from of ['', '2021-02-29', '2026-10-16'])assert.equal(P.duration(from,'2026-10-15'),'');
});
