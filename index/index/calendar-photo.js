/* Shared, deterministic checks for photographed calendar grids. No AI or account access. */
(function(root){
  'use strict';
  const kinds=['','A','B','all','off','work','unknown'];
  const weekdays=['日','月','火','水','木','金','土'];
  const monthKey=(year,month)=>`${year}-${String(month).padStart(2,'0')}`;
  const dateKey=(month,day)=>`${month}-${String(day).padStart(2,'0')}`;
  function monthLength(month){
    if(typeof month!=='string'||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))throw Error('month');
    const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m,0)).getUTCDate();
  }
  function validateDraft(months,year){
    if(!Array.isArray(months)||!months.length||months.length>13)throw Error('months');
    const seen=new Set();
    return months.map(item=>{
      const month=item?.month,n=monthLength(month);
      if(seen.has(month)||(year!==undefined&&![year,year+1].includes(Number(month.slice(0,4)))))throw Error('month');
      seen.add(month);
      if(!Array.isArray(item.days)||item.days.length!==n)throw Error('incomplete');
      const days=item.days.map((row,i)=>{
        if(row?.date!==dateKey(month,i+1)||!kinds.includes(row.kind))throw Error('day');
        return {date:row.date,kind:row.kind};
      });
      return {month,days};
    }).sort((a,b)=>a.month.localeCompare(b.month));
  }
  function parseGrid(value,year){
    if(!Array.isArray(value?.months)||!value.months.length||value.months.length>13)throw Error('months');
    const months=value.months.map(block=>{
      if(!Number.isInteger(block?.year)||![year,year+1].includes(block.year)||!Number.isInteger(block.month)||block.month<1||block.month>12)throw Error('month');
      const month=monthKey(block.year,block.month),n=monthLength(month);
      const headers=block.weekdays,start=weekdays.indexOf(headers?.[0]);
      if(!Array.isArray(headers)||headers.length!==7||start<0||headers.some((h,i)=>h!==weekdays[(start+i)%7]))throw Error('weekdays');
      const offset=(new Date(Date.UTC(block.year,block.month-1,1)).getUTCDay()-start+7)%7;
      if(block.complete!==true||!Array.isArray(block.rows)||block.rows.length<Math.ceil((offset+n)/7)||block.rows.length>6||block.rows.some(row=>!Array.isArray(row)||row.length!==7))throw Error('incomplete');
      const days=[];
      block.rows.flat().forEach((cell,i)=>{
        const expected=i-offset+1;
        if(expected<1||expected>n){if(cell!==null&&cell!=='')throw Error('layout');return;}
        if(typeof cell!=='string')throw Error('layout');
        const match=cell.match(/^([1-9]|[12]\d|3[01])(?::(A|B|all|off|work|unknown))?$/);
        if(!match||Number(match[1])!==expected)throw Error('layout');
        days.push({date:dateKey(month,expected),kind:match[2]||''});
      });
      return {month,days};
    });
    return validateDraft(months,year);
  }
  function snapshot(days,months){
    const set=new Set(months),result={};
    for(const [date,kind] of Object.entries(days||{}))if(set.has(date.slice(0,7)))result[date]=kind;
    return result;
  }
  function replacementChanges(current,months,approved,expected){
    const draft=validateDraft(months);
    if(!Array.isArray(approved)||!approved.length||new Set(approved).size!==approved.length||approved.some(m=>!draft.some(d=>d.month===m)))throw Error('写真と比べて、保存する月を確認してください');
    if(!expected||typeof expected!=='object')throw Error('確認画面を開き直してください');
    const before=snapshot(expected,approved),now=snapshot(current,approved);
    if(Object.keys(before).length!==Object.keys(now).length||Object.keys(before).some(d=>before[d]!==now[d]))throw Error('確認中に休日が変更されました。閉じてから写真を読み取り直してください');
    const patch={};
    for(const block of draft)if(approved.includes(block.month))for(const row of block.days){
      if(row.kind==='unknown')throw Error('「要確認」の日を直してから保存してください');
      patch[row.date]=row.kind;
    }
    return patch;
  }
  const api={validateDraft,parseGrid,snapshot,replacementChanges,monthLength,kinds,weekdays};
  root.HibirukaPhotoCalendar=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
