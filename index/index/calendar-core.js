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
  const api={validDate,cleanConfig,mergeConfig,dayInfo,kinds,labels};
  root.HibirukaCalendar=api;
  if(typeof module!=='undefined') module.exports=api;
})(globalThis);
