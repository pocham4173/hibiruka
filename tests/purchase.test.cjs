const {test}=require('node:test');const assert=require('node:assert/strict');
const C=require('../index/index/purchase-core.js');
const item=(date='2027-01-31',extra={})=>({...C.fields({title:'フード',date,recurring:true,every:1,unit:'month',...extra}),sends:[],nextSendAt:null});
test('monthly dates clamp to month end and retain the original 31st across February',()=>{
 const jan=item();const feb=C.received(jan,'2027-01-31').next;assert.equal(feb.date,'2027-02-28');assert.equal(C.nextDate(feb),'2027-03-31');
 assert.equal(C.nextDate(item('2028-01-31')),'2028-02-29');assert.equal(C.nextDate(item('2026-12-31')),'2027-01-31');
 assert.equal(C.nextDate(item('2026-12-25',{every:2,unit:'week'})),'2027-01-08');
 assert.equal(C.nextDate(item('2026-12-31',{every:2,unit:'day'})),'2027-01-02');
 assert.throws(()=>C.nextDate(item('2099-12-31')));
});
test('editing the delivery date resets its recurrence anchor; unrelated edits preserve it',()=>{
 const feb=C.received(item(),'2027-01-31').next;
 const form={title:'フード',date:feb.date,recurring:true,every:1,unit:'month'};
 const edited=C.fields(form,feb);assert.equal(C.nextDate(edited),'2027-03-31');
 assert.equal(C.nextDate(C.fields({...form,date:'2027-02-20'},feb)),'2027-03-20');
});
test('received purchase keeps history but never copies notification recipients, deadlines or results to next delivery',()=>{
 const e=item('2027-01-31',{deadline:'2027-01-20'});e.sends=[{status:'sent',friendIds:['someone']}];
 const {patch,next}=C.received(e,'2027-01-30');assert.equal(patch.kind,'memory');assert.equal(patch.purchase.status,'received');
 assert.deepEqual(next.sends,[]);assert.deepEqual(next.who,[]);assert.equal(next.nextSendAt,null);assert.equal(next.purchase.deadline,'');
 assert.equal(C.received(item('2027-01-31',{recurring:false}),'2027-01-31').next,null);
 assert.throws(()=>C.received({...e,...patch},'2027-01-31'));
});
test('pending and cancellation-in-progress notifications block edits; stale changes are rejected',()=>{
 const e=item();C.guard(e,e);
 for(const status of ['wait','sending'])assert.throws(()=>C.guard({...e,sends:[{status}],sendCancels:['x']},e));
 assert.throws(()=>C.guard({...e,nextSendAt:'2027-01-30T09:00'},e));
 C.guard({...e,sends:[{status:'cancelled'}]},e);
 assert.throws(()=>C.guard({...e,purchase:{...e.purchase,revision:2}},e));
});
test('URLs cannot execute script or carry credentials, and invalid dates and repeat intervals fail',()=>{
 for(const link of ['javascript:alert(1)','data:text/html,x','file:///tmp/a','https://user:pass@example.com'])assert.throws(()=>C.url(link));
 assert.equal(C.shared('いつものフード https://amzn.asia/d/test').url,'https://amzn.asia/d/test');
 assert.equal(C.shared('javascript:alert(1)'),null);
 for(const date of ['2027-02-29','2026-13-01','2026-04-31'])assert.throws(()=>item(date));
 for(const every of [0,-1,1.5,366,NaN])assert.throws(()=>item('2026-10-16',{every}));
 assert.throws(()=>item('2026-10-16',{deadline:'2026-10-17'}));
 assert.throws(()=>item('2026-10-16',{amount:-1}));
});
