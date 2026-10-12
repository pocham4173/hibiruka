/* Pure calendar data helpers. No network, records, or account state. */
(function(root) {
  'use strict';
  const kinds = ['A','B','all','off','work'];
  const labels = {A:'A休',B:'B休',all:'全休',off:'休',work:'出勤'};
  function validDate(s) {
    if (typeof s !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s+'T00:00:00Z');
    return Number.isFinite(+d) && d.toISOString().slice(0,10) === s;
  }
  function cleanConfig(raw) {
    const days = {};
    if (raw?.days && typeof raw.days === 'object' && !Array.isArray(raw.days))
      for (const [day,kind] of Object.entries(raw.days).slice(0,1200))
        if (validDate(day) && kinds.includes(kind)) days[day]=kind;
    return {version:1,configured:raw?.configured===true,team:['A','B'].includes(raw?.team)?raw.team:'',showRokuyo:raw?.showRokuyo!==false,days};
  }
  function mergeConfig(current, patch, settings) {
    const next = cleanConfig(current);
    for (const [day,kind] of Object.entries(patch)) {
      if (!validDate(day) || (kind!=='' && !kinds.includes(kind))) throw Error('日付か休日の種類を確認してください');
      if (kind) next.days[day]=kind; else delete next.days[day];
    }
    if (Object.keys(next.days).length>1200) throw Error('休日は合計1,200日まで登録できます');
    return cleanConfig({...next,...settings,days:next.days,configured:true});
  }
  function dayInfo(date, config, data) {
    const c=cleanConfig(config), kind=c.days[date] || '';
    const digit=data?.rokuyo?.[date.slice(0,7)]?.[Number(date.slice(8))-1];
    const rokuyo=digit===undefined?'':['先勝','友引','先負','仏滅','大安','赤口'][Number(digit)];
    return {holiday:data?.holidays?.[date]||'',rokuyo:c.showRokuyo?rokuyo:'',kind,label:labels[kind]||'',
      off:kind==='all'||kind==='off'||(!!c.team&&kind===c.team)};
  }
  // Explicit correction requested for the three old image-reading mistakes.
  // Do not infer holidays after the paper calendar's confirmed end date.
  function unconfirmedCompanyPatch(config) {
    const patch={}, days=cleanConfig(config).days;
    for(const [date,kind] of Object.entries({'2027-03-23':'A','2027-03-27':'B','2027-03-30':'A'}))
      if(days[date]===kind) patch[date]='';
    return patch;
  }
  // Transcribed from the supplied Sekine Store paper calendar. Only boxed dates;
  // the printed but unmarked dates outside this work year are not inferred.
  function verifiedCompanyCalendar() {
    const rows=[];
    for(const line of `2026-03|28|21|22,29
2026-04|11,25|4,18,29|5,12,19,26
2026-05|9,23|16,30|2,3,4,5,6,10,17,24,31
2026-06|6,20|13,27|7,14,21,28
2026-07|4,18,20|11,25|5,12,19,26
2026-08|1,29|8,22|2,9,12,13,14,15,16,23,30
2026-09|12,22,23,26|5,19,21|6,13,20,27
2026-10|10,24|3,12,17,31|4,11,18,25
2026-11|3,7,21,23|14,28|1,8,15,22,29
2026-12|5,19|12,26|6,13,20,27,30,31
2027-01|16,30|9,11,23|1,2,3,4,5,10,17,24,31
2027-02|11,13,27|6,20,23|7,14,21,28
2027-03|13|6,20|7,14`.split('\n')) {
      const [month,...groups]=line.split('|');
      groups.forEach((days,i)=>days.split(',').filter(Boolean).forEach(day=>rows.push({date:month+'-'+day.padStart(2,'0'),kind:['A','B','all'][i]})));
    }
    return {from:'2026-03-21',to:'2027-03-20',rows:rows.sort((a,b)=>a.date.localeCompare(b.date))};
  }
  const api={verifiedCompanyCalendar,unconfirmedCompanyPatch,validDate,cleanConfig,mergeConfig,dayInfo,kinds,labels};
  root.HibirukaCalendar=api;
  if(typeof module!=='undefined') module.exports=api;
})(globalThis);
