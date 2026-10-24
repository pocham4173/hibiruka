/* Pure calendar data helpers. No network, records, or account state. */
(function(root) {
  'use strict';
  const kinds = ['A','B','all','off','work','C1','C2','C3','C4','C5','C6','C7','C8'];
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
    return {version:1,configured:raw?.configured===true,team:['A','B',...kinds.filter(k=>k.startsWith('C'))].includes(raw?.team)?raw.team:'',showRokuyo:raw?.showRokuyo!==false,days,...(raw?.business?{business:cleanBusiness(raw.business)}:{})};
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
  // Transcribed from the supplied paper calendar. Only boxed dates;
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
  const text=(s,n=40)=>typeof s==='string'?s.trim().slice(0,n):'';
  const parts=['full','am','pm'];
  function cleanBusiness(raw={}) {
    const b={version:1,yearStart:validDate('2000-'+raw.yearStart)?raw.yearStart:'01-01',
      leaveStart:validDate('2000-'+raw.leaveStart)?raw.leaveStart:'01-01',
      confirmedFrom:validDate(raw.confirmedFrom)?raw.confirmedFrom:'',confirmedThrough:validDate(raw.confirmedThrough)?raw.confirmedThrough:'',
      labels:{},personal:{},entries:{}};
    for(const [key,v] of Object.entries(raw.labels||{})) if(kinds.includes(key)&&v&&typeof v==='object')
      b.labels[key]={name:text(v.name,16),color:/^#[0-9a-f]{6}$/i.test(v.color)?v.color:'#edf0f5',enabled:v.enabled!==false};
    for(const [date,v] of Object.entries(raw.personal||{}).slice(0,1200)) if(validDate(date)&&v&&['off','paid','work'].includes(v.category)&&parts.includes(v.part))
      b.personal[date]={title:text(v.title)||({off:'休み',paid:'有給',work:'出勤'})[v.category],category:v.category,part:v.category==='work'?'full':v.part};
    for(const [id,v] of Object.entries(raw.entries||{}).slice(0,500)) if(/^[a-zA-Z0-9_-]{1,80}$/.test(id)&&v&&validDate(v.date)&&['appointment','deadline','memo','shift'].includes(v.type)&&text(v.title))
      b.entries[id]={date:v.date,title:text(v.title),type:v.type,time:/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v.time)?v.time:'',memo:text(v.memo,500),done:v.done===true};
    return b;
  }
  function businessPatch(config,patch) {
    const b=cleanBusiness(config.business);
    for(const key of ['yearStart','leaveStart','confirmedFrom','confirmedThrough']) if(Object.hasOwn(patch,key)) b[key]=patch[key];
    for(const key of ['labels','personal','entries']) for(const [id,value] of Object.entries(patch[key]||{})) {
      if(value===null) delete b[key][id]; else b[key][id]=value;
    }
    if(Object.keys(b.personal).length>1200||Object.keys(b.entries).length>500) throw Error('登録上限に達しました。不要な仕事の予定を整理してください');
    if(!validDate('2000-'+b.yearStart)||!validDate('2000-'+b.leaveStart)) throw Error('集計の開始日を確認してください');
    if((b.confirmedFrom||b.confirmedThrough)&&(!validDate(b.confirmedFrom)||!validDate(b.confirmedThrough)||b.confirmedFrom>b.confirmedThrough)) throw Error('会社カレンダーの確定期間を確認してください');
    const cleaned=cleanBusiness(b);
    for(const key of ['personal','entries']) for(const [id,v] of Object.entries(patch[key]||{})) if(v!==null&&!cleaned[key][id]) throw Error('日付・名前・種類を確認してください');
    return {...cleanConfig(config),business:cleaned};
  }
  function companyStyle(config,kind) {
    const def={A:['A休','#e2efd3'],B:['B休','#dceef9'],all:['全休','#f5dbe5'],off:['休','#eee3f8'],work:['出勤','#edf0f5']};
    const custom=config.business?.labels?.[kind];
    const color=custom?.color||def[kind]?.[1]||'#e2efd3';
    const rgb=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
    const luminance=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
    return {name:custom?.name||def[kind]?.[0]||kind,color,textColor:luminance>.35?'#202c45':'#ffffff',enabled:custom?.enabled!==false};
  }
  function personalInfo(date,config) {
    const p=config.business?.personal?.[date];
    if(!p) return null;
    return {...p,label:p.title+(p.part==='am'?'・午前':p.part==='pm'?'・午後':''),amount:p.category==='work'?0:p.part==='full'?1:.5};
  }
  function addDays(date,n) {const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
  function yearRange(date,start='01-01') {
    const anchor=year=>{let s=year+'-'+start;if(!validDate(s)&&start==='02-29')s=year+'-02-28';return s;};
    let year=Number(date.slice(0,4));if(date<anchor(year))year--;
    return {from:anchor(year),to:addDays(anchor(year+1),-1)};
  }
  function summary(config,date,today) {
    const b=cleanBusiness(config.business),range=yearRange(date,b.yearStart),leave=yearRange(date,b.leaveStart);
    let company=0,paidTaken=0,paidPlanned=0;
    const mine=d=>['all','off'].includes(config.days[d])||!!config.team&&config.days[d]===config.team;
    for(const [d] of Object.entries(config.days)) if(d>=range.from&&d<=range.to&&mine(d))company++;
    for(const [d,p] of Object.entries(b.personal)) if(d>=leave.from&&d<=leave.to&&p.category==='paid') {
      const amount=p.part==='full'?1:.5;if(d<=today)paidTaken+=amount;else paidPlanned+=amount;
    }
    const fullOff=d=>{const p=b.personal[d];return p?p.category!=='work'&&p.part==='full':mine(d);};
    let next='',end='';for(let i=0;i<366;i++){const d=addDays(today,i);if(fullOff(d)){next=d;end=d;for(let j=1;j<366-i&&fullOff(addDays(d,j));j++)end=addDays(d,j);break;}}
    const groups=Object.values(config.days).some(k=>!['all','off','work'].includes(k));
    return {range,leave,company,paidTaken,paidPlanned,next,end,needsTeam:groups&&!config.team,
      complete:!!b.confirmedFrom&&b.confirmedFrom<=range.from&&b.confirmedThrough>=range.to};
  }
  function repeatDates(date,repeat,count) {
    if(!validDate(date)||!['none','weekly','monthly'].includes(repeat)||!Number.isInteger(count)||count<1||count>24)throw Error('繰り返しは1〜24回で指定してください');
    const dates=[date];
    for(let i=1;i<(repeat==='none'?1:count);i++) {
      if(repeat==='weekly')dates.push(addDays(date,7*i));
      else {const d=new Date(date+'T00:00:00Z'),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+i);const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));dates.push(d.toISOString().slice(0,10));}
    }
    if(dates.some(d=>!validDate(d)))throw Error('2099年までの日付を選んでください');
    return dates;
  }
  const api={cleanBusiness,businessPatch,companyStyle,personalInfo,yearRange,summary,repeatDates,addDays,verifiedCompanyCalendar,unconfirmedCompanyPatch,validDate,cleanConfig,mergeConfig,dayInfo,kinds,labels};
  root.HibirukaCalendar=api;
  if(typeof module!=='undefined') module.exports=api;
})(globalThis);
