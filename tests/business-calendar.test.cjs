const {test}=require('node:test');const assert=require('node:assert/strict');
const C=require('../index/index/calendar-core.js');
test('business: personal half leave and work overrides retain company marks through edits and re-import',()=>{
 const original=C.cleanConfig({team:'B',days:{'2027-03-20':'B'}});
 let c=C.businessPatch(original,{personal:{'2027-03-20':{title:'有給',category:'paid',part:'am'}}});
 assert.equal(c.days['2027-03-20'],'B');assert.equal(C.personalInfo('2027-03-20',c).amount,.5);
 c=C.mergeConfig(c,{'2027-03-20':'all'},{});assert.equal(c.business.personal['2027-03-20'].part,'am');
 c=C.businessPatch(c,{personal:{'2027-03-20':null}});assert.equal(C.personalInfo('2027-03-20',c),null);assert.equal(c.days['2027-03-20'],'all');
 assert.equal(original.business,undefined);
});
test('business: fiscal year, own group, partial coverage and separate half-day paid leave totals',()=>{
 let c=C.cleanConfig({team:'A',days:{'2026-03-20':'all','2026-03-21':'A','2026-03-22':'B','2027-03-20':'all','2027-03-21':'A'}});
 c=C.businessPatch(c,{yearStart:'03-21',leaveStart:'04-01',confirmedFrom:'2026-03-21',confirmedThrough:'2027-03-20',personal:{'2026-04-02':{title:'有給',category:'paid',part:'am'},'2026-12-01':{title:'有給',category:'paid',part:'full'},'2026-03-22':{title:'前年分',category:'paid',part:'full'}}});
 const s=C.summary(c,'2026-10-01','2026-10-13');assert.deepEqual(s.range,{from:'2026-03-21',to:'2027-03-20'});assert.equal(s.company,2);assert.equal(s.paidTaken,.5);assert.equal(s.paidPlanned,1);assert(s.complete);
 assert(!C.summary(c,'2027-04-01','2027-04-01').complete);
 assert(C.summary({...c,team:''},'2026-10-01','2026-10-13').needsTeam);
 assert.deepEqual(C.yearRange('2027-02-28','02-29'),{from:'2027-02-28',to:'2028-02-28'});
});
test('business: next break uses only registered full days and respects personal work changes',()=>{
 let c=C.cleanConfig({team:'A',days:{'2026-10-13':'A','2026-10-14':'all','2026-10-15':'all','2026-10-16':'B'}});
 c=C.businessPatch(c,{personal:{'2026-10-13':{category:'work',part:'full',title:'出勤'},'2026-10-16':{category:'off',part:'am',title:'半休'}}});
 const s=C.summary(c,'2026-10-01','2026-10-13');assert.equal(s.next,'2026-10-14');assert.equal(s.end,'2026-10-15');
 assert.equal(C.summary(c,'2026-10-01','2026-10-16').next,'');
});
test('business: monthly recurrence clamps month end, weekly crosses years, bounded and invalid dates rejected',()=>{
 assert.deepEqual(C.repeatDates('2026-01-31','monthly',3),['2026-01-31','2026-02-28','2026-03-31']);
 assert.deepEqual(C.repeatDates('2026-12-28','weekly',2),['2026-12-28','2027-01-04']);
 assert.throws(()=>C.repeatDates('2026-02-30','weekly',4));assert.throws(()=>C.repeatDates('2026-10-13','weekly',25));assert.throws(()=>C.repeatDates('2099-12-31','weekly',2));
});
test('business: patching one entry preserves concurrent entries and limits oversized storage',()=>{
 const c=C.businessPatch(C.cleanConfig({}),{entries:{a:{date:'2026-10-13',type:'deadline',title:'書類'},b:{date:'2026-10-14',type:'appointment',title:'健康診断'}}});
 const next=C.businessPatch(c,{entries:{a:{...c.business.entries.a,done:true}}});assert.equal(next.business.entries.b.title,'健康診断');assert(next.business.entries.a.done);
 assert.equal(C.businessPatch(next,{entries:{a:null}}).business.entries.b.title,'健康診断');
 assert.throws(()=>C.businessPatch(c,{entries:{bad:{date:'invalid',title:'invalid',type:'memo'}}}));
 assert.throws(()=>C.businessPatch(c,{entries:Object.fromEntries(Array.from({length:501},(_,i)=>['e'+i,{date:'2026-10-13',title:'memo',type:'memo'}]))}));
 const labels=C.businessPatch(c,{labels:{A:{name:'第1班',color:'red;position:fixed'}}});assert.equal(C.companyStyle(labels,'A').color,'#edf0f5');assert.equal(C.companyStyle(labels,'A').name,'第1班');
});
