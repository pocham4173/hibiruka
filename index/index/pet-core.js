(function(root){
'use strict';
const types=['思い出','体重','薬','ワクチン','通院','トリミング'];
function day(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(s||''))return null;const n=Date.parse(s+'T00:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===s?n:null;}
function days(from,to){const a=day(from),b=day(to);return a===null||b===null||a>b?null:Math.round((b-a)/86400000);}
function age(from,to){if(days(from,to)===null)return '';const a=from.split('-').map(Number),b=to.split('-').map(Number);let months=(b[0]-a[0])*12+b[1]-a[1]-(b[2]<a[2]?1:0);return `${Math.floor(months/12)}歳${months%12}か月`;}
function profile(p,today){const n={name:String(p.name||'').trim(),breed:String(p.breed||'').trim(),sex:p.sex||'',birthday:p.birthday||'',welcome:p.welcome||'',birthdayEstimated:!!p.birthdayEstimated,welcomeEstimated:!!p.welcomeEstimated,photo:p.photo||''};
if(!n.name||n.name.length>40||n.breed.length>60)throw Error('名前を40文字以内で入れてください');
if(!['','男の子','女の子','不明'].includes(n.sex))throw Error('性別を選んでください');
for(const k of ['birthday','welcome'])if(n[k]&&days(n[k],today)===null)throw Error('誕生日・お迎え日は、今日までの正しい日付にしてください');
if(n.birthday&&n.welcome&&n.birthday>n.welcome)throw Error('お迎え日は誕生日以降にしてください');
if(n.photo&&(!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(n.photo)||n.photo.length>100000))throw Error('写真を選び直してください');return n;}
function fields(ids,type,weight){ids=[...new Set(ids||[])];if(ids.length>20||ids.some(x=>typeof x!=='string'||!x||x.length>128))throw Error('うちの子を選び直してください');
if(!types.includes(type))throw Error('記録の種類を選んでください');
const w=weight===''||weight==null?null:Number(weight);if(type==='体重'&&(!ids.length||ids.length!==1||!Number.isFinite(w)||w<=0||w>200))throw Error('体重は1匹ずつ、0より大きい200kg以下の数値で入れてください');
if(type!=='思い出'&&!ids.length)throw Error('どの子の記録か選んでください');return {petIds:ids,petCareType:ids.length?type:'',petWeightKg:type==='体重'?w:null};}
const api={types,day,days,age,profile,fields};if(typeof module!=='undefined')module.exports=api;root.HibirukaPet=api;
})(typeof window!=='undefined'?window:globalThis);
