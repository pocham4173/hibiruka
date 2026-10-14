const {test}=require('node:test');
const assert=require('node:assert/strict');
const P=require('../index/index/calendar-photo.js');
const grid=require('./fixtures/calendar-grid.cjs');
// Entirely invented dates and marks: no company calendar or user image data.
const stacked=()=>({year:2028,month:1,complete:true,weekdays:['日','月','火','水','木','金','土'],rows:[
 [null,null,null,null,null,null,'1'],
 ['2','3','4','5','6','7','8'],
 ['9','10','11','12','13','14','15'],
 ['16','17','18','19','20','21','22'],
 [['23:A','30:B'],['24:all','31:work'],'25','26','27','28','29']
]});
const parse=blocks=>P.parseGrid({months:blocks},2028);
test('stacked week-six dates keep independent marks and weekday columns',()=>{
 const [month]=parse([stacked()]);
 assert.equal(month.days.length,31);
 for(const [kind,dates] of Object.entries({A:[23],B:[30],all:[24],work:[31]}))
  assert.deepEqual(month.days.filter(d=>d.kind===kind).map(d=>Number(d.date.slice(-2))),dates);
 const blank=stacked();blank.rows[4][1][1]='31';assert.equal(parse([blank])[0].days[30].kind,'');
 const monday=grid(2028,10,{},1),last=monday.rows.pop();
 last.forEach((cell,i)=>{if(cell)monday.rows[4][i]=[monday.rows[4][i],cell];});
 assert.equal(parse([monday])[0].days[30].date,'2028-10-31');
});
test('fifteen and twenty-four months are accepted; missing or shifted stacked dates are rejected',()=>{
 for(const n of [15,24]){
  const months=Array.from({length:n},(_,i)=>grid(2028+Math.floor(i/12),i%12+1,{}));months[0]=stacked();
  assert.equal(parse(months).length,n);
 }
 for(const mutate of [b=>b.rows[4][0]='23:A',b=>b.rows[4][0]=['23:A','29:B'],b=>b.rows[4][1]=['24:all','30:work'],b=>b.rows[3][0]=['16','23:A']]){
  const block=stacked();mutate(block);assert.throws(()=>parse([block]));
 }
 const normal=grid(2028,2,{});normal.rows[3][0]=['20','27:A'];assert.throws(()=>parse([normal]));
});
