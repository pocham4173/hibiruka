/* Purchase schedules use existing owner-scoped events. No store-account access. */
(function(root){
'use strict';
function date(value){
  if(typeof value!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(value))return null;
  const d=new Date(value+'T00:00:00Z');
  return Number.isFinite(+d)&&d.toISOString().slice(0,10)===value?d:null;
}
function url(value){
  const s=String(value||'').trim();if(!s)return '';
  if(s.length>4096)throw Error('商品リンクが長すぎます');
  let u;try{u=new URL(s);}catch{throw Error('商品ページのリンクを入れてください');}
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error('http または https の商品リンクを入れてください');
  return u.href;
}
function shared(text){
  const s=String(text||'').slice(0,10000).trim();
  const found=s.match(/https?:\/\/[^\s<>"「」]+/i);
  if(!found)return null;
  try{return {url:url(found[0]),title:s.replace(found[0],'').trim().slice(0,120)};}catch{return null;}
}
function fields(input,previous){
  const title=String(input.title||'').trim(),d=String(input.date||'');
  if(!title||title.length>120)throw Error('商品名を120文字以内で入れてください');
  if(!date(d))throw Error('正しい日付を入れてください（2000〜2099年）');
  const status=input.status||'active';
  if(!['active','paused','received'].includes(status))throw Error('記録の状態を選び直してください');
  const every=Number(input.every),unit=input.unit||'month',recurring=input.recurring===true;
  if(recurring&&(!Number.isInteger(every)||every<1||every>365||!['day','week','month'].includes(unit)))throw Error('繰り返し間隔を1〜365の整数で入れてください');
  const deadline=String(input.deadline||'');
  if(deadline&&(!date(deadline)||deadline>d))throw Error('変更期限はお届け日以前の日付にしてください');
  const amount=input.amount===''||input.amount==null?null:Number(input.amount);
  if(amount!==null&&(!Number.isFinite(amount)||amount<0||amount>100000000||!Number.isInteger(amount)))throw Error('金額は0以上の整数で入れてください');
  const memo=String(input.memo||'').trim();if(memo.length>2000)throw Error('メモは2000文字以内で入れてください');
  const sameDate=previous?.date===d;
  return {title,date:d,memo,kind:status==='received'?'memory':'plan',purchase:{
    version:1,url:url(input.url),status,recurring,every:recurring?every:1,unit:recurring?unit:'month',
    anchorDay:sameDate?(previous.purchase?.anchorDay||Number(d.slice(8))):Number(d.slice(8)),
    amount,deadline,revision:(previous?.purchase?.revision||0)+1
  }};
}
function nextDate(e){
  const p=e.purchase,d=date(e.date);if(!d||!p?.recurring)throw Error('繰り返し設定を確認してください');
  if(!Number.isInteger(p.every)||p.every<1||p.every>365)throw Error('繰り返し間隔を確認してください');
  if(p.unit==='month'){
    const anchor=p.anchorDay||d.getUTCDate();
    if(!Number.isInteger(anchor)||anchor<1||anchor>31)throw Error('日付を確認してください');
    d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+p.every);
    const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
    d.setUTCDate(Math.min(anchor,last));
  }else if(['day','week'].includes(p.unit))d.setUTCDate(d.getUTCDate()+p.every*(p.unit==='week'?7:1));
  else throw Error('繰り返し単位を確認してください');
  const result=d.toISOString().slice(0,10);if(!date(result))throw Error('次回予定が2099年を超えます');return result;
}
function pending(e){return Boolean(e.nextSendAt||(e.sends||[]).some(s=>s.status==='wait'||s.status==='sending'));}
function guard(e,before){
  if(!e?.purchase||!before||e.purchase.revision!==before.purchase?.revision||e.date!==before.date||e.kind!==before.kind)throw Error('別の画面で変更されました。開き直してください');
  if(pending(e))throw Error('先に「記録・通知を見る」でお知らせ予約を取り消し、取り消し完了後にもう一度お試しください');
}
function received(e,today){
  if(e.purchase.status!=='active')throw Error('この購入はすでに更新されています');
  const p=e.purchase;
  // A new delivery is a separate event: never carry recipients, sends or deadlines forward.
  const next=p.recurring?{cat:e.cat,kind:'plan',title:e.title,memo:e.memo||'',date:nextDate(e),time:'',place:'',who:[],thumbs:[],link:'',fav:false,
    purchase:{...p,status:'active',deadline:'',revision:1},sends:[],nextSendAt:null}:null;
  return {patch:{kind:'memory',purchase:{...p,status:'received',receivedOn:today,revision:p.revision+1}},next};
}
function label(p){return p?.recurring?`${p.every}${{day:'日',week:'週間',month:'か月'}[p.unit]||''}ごと`:'今回だけ';}
const api={date,url,shared,fields,nextDate,pending,guard,received,label};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.HibirukaPurchase=api;
})(typeof globalThis!=='undefined'?globalThis:this);
