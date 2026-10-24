import {test} from 'node:test';
import assert from 'node:assert/strict';
import {acceptInvite, lineUserFromToken, LIFF_CHANNEL, INVITES_PER_DAY, INVITES_PER_MONTH} from '../line-worker/accept.mjs';
const U1='U'+'1'.repeat(32), U2='U'+'2'.repeat(32), NOW=Date.parse('2026-10-08T10:00:00Z');
function memoryDb(data){
  const col=c=>(data[c]??={});
  const ref=(c,id)=>({id,path:c+'/'+id,get:async()=>({exists:id in col(c),data:()=>col(c)[id]})});
  return {data,collection:c=>({doc:id=>ref(c,id)}),
    runTransaction:async fn=>{const w=[];const r=await fn({get:x=>x.get(),update:(x,v)=>w.push([x,v]),set:(x,v)=>w.push([x,v])});for(const [x,v] of w){const [c,id]=x.path.split('/');col(c)[id]={...col(c)[id],...v};}return r;}};
}
const line=(id=U1)=>({userId:id,name:'たろう'});
test('accept: pending invite becomes joined with the LINE id checked by the server', async () => {
  const db=memoryDb({personalFriends:{inv1:{ownerUid:'A',status:'pending',createdAt:new Date(NOW-86400000)}}});
  assert.deepEqual(await acceptInvite(db,{scope:'personal',invite:'inv1',uid:'B',line:line(),now:NOW}),{ok:true,self:false});
  const f=db.data.personalFriends.inv1;assert.equal(f.status,'joined');assert.equal(f.lineUserId,U1);assert.equal(f.acceptedBy,'B');
  // 同じ人がもう一度：OK、別のLINEで使い回し：だめ
  assert.equal((await acceptInvite(db,{scope:'personal',invite:'inv1',uid:'B',line:line(),now:NOW})).again,true);
  assert.equal((await acceptInvite(db,{scope:'personal',invite:'inv1',uid:'C',line:line(U2),now:NOW})).error,'used');
  assert.equal(db.data.personalFriends.inv1.lineUserId,U1,'差し替えられない');
});
test('accept: expired after 30 days (sending again renews), missing invites refused', async () => {
  const old=new Date(NOW-31*86400000);
  const db=memoryDb({personalFriends:{a:{status:'pending',createdAt:old},b:{status:'pending',createdAt:old,sentAt:new Date(NOW-86400000)}}});
  assert.equal((await acceptInvite(db,{scope:'personal',invite:'a',uid:'B',line:line(),now:NOW})).error,'expired');
  assert.equal((await acceptInvite(db,{scope:'personal',invite:'b',uid:'B',line:line(),now:NOW})).ok,true);
  assert.equal((await acceptInvite(db,{scope:'personal',invite:'zz',uid:'B',line:line(),now:NOW})).error,'missing');
});
test('accept: legacy invites (own LINE registration) use the legacy collection without acceptedBy', async () => {
  const db=memoryDb({friends:{me:{name:'自分',status:'pending',createdAt:new Date(NOW)}}});
  assert.deepEqual(await acceptInvite(db,{scope:'legacy',invite:'me',uid:'X',line:line(),now:NOW}),{ok:true,self:true});
  assert.equal(db.data.friends.me.acceptedBy,undefined);
});
test('LINE token: only a real token from the Hibiruka LIFF channel gives a LINE id', async () => {
  const mk=(verify,profile)=>async url=>url.includes('/verify')?new Response(JSON.stringify(verify),{status:verify?200:400}):new Response(JSON.stringify(profile));
  const tok='x'.repeat(40);
  assert.deepEqual(await lineUserFromToken(tok,mk({client_id:LIFF_CHANNEL,expires_in:100},{userId:U1,displayName:'たろう'})),{userId:U1,name:'たろう'});
  assert.equal(await lineUserFromToken(tok,mk({client_id:'999',expires_in:100},{userId:U1})),null,'別のアプリのトークン');
  assert.equal(await lineUserFromToken(tok,mk({client_id:LIFF_CHANNEL,expires_in:0},{userId:U1})),null,'期限切れ');
  assert.equal(await lineUserFromToken(tok,mk(null,{userId:U1})),null,'にせもの');
  assert.equal(await lineUserFromToken('short',mk({client_id:LIFF_CHANNEL,expires_in:9},{userId:U1})),null);
});

test('accept: one LINE shares daily/monthly limits across app users and both scopes; repeat approvals do not count', async () => {
  const db=memoryDb({personalFriends:{},friends:{}});
  const accept=async(i,now=NOW,scope='personal',user=U1)=>{
    const col=scope==='personal'?'personalFriends':'friends';
    db.data[col]['invite'+i]={status:'pending',createdAt:new Date(now)};
    return acceptInvite(db,{scope,invite:'invite'+i,uid:'new-user-'+i,line:line(user),now});
  };
  for(let day=0;day<4;day++)for(let i=0;i<INVITES_PER_DAY;i++)assert.equal((await accept(day*10+i,NOW+day*86400000,i%2?'legacy':'personal')).ok,true);
  assert.equal((await accept(99,NOW+4*86400000)).error,'limit','monthly limit survives the next day');
  assert.equal((await accept(100,NOW+4*86400000,'personal',U2)).ok,true,'another LINE has its own allowance');
  assert.equal((await accept(101,Date.parse('2026-11-01T00:00:00Z'))).ok,true,'month resets');
  const quota=Object.values(db.data.lineInviteLimits).find(x=>x.month==='2026-11');
  assert.equal(quota.monthly,1);
  assert.equal((await acceptInvite(db,{scope:'personal',invite:'invite101',uid:'other-auth',line:line(),now:Date.parse('2026-11-01T00:00:00Z')})).again,true);
  assert.equal(quota.monthly,1);
  assert.equal(INVITES_PER_MONTH,20);
});
test('accept: the sixth daily approval fails without modifying the pending invite', async () => {
  const db=memoryDb({personalFriends:{}});
  for(let i=0;i<6;i++){
    db.data.personalFriends['daily'+i]={status:'pending',createdAt:new Date(NOW)};
    const r=await acceptInvite(db,{scope:'personal',invite:'daily'+i,uid:'user'+i,line:line(),now:NOW});
    assert.equal(i<5?r.ok:r.error,i<5?true:'limit');
  }
  assert.equal(db.data.personalFriends.daily5.status,'pending');
  assert.equal(Object.values(db.data.lineInviteLimits)[0].daily,5);
});

test('accept: simultaneous requests cannot cross the cap with the production REST transaction adapter',async()=>{
 const {firestore,fields}=await import('../line-worker/firestore.mjs');
 const {createHash}=await import('node:crypto');
 const qid=createHash('sha256').update('invite:'+U1).digest('hex');
 const store=new Map(),root='projects/hibiruka-f66fb/databases/(default)/documents';let clock=0;
 const put=(path,data)=>store.set(path,{fields:fields(data),t:'v'+(++clock)});
 put('lineInviteLimits/'+qid,{day:'2026-10-08',month:'2026-10',daily:4,monthly:4});
 for(const id of ['race1','race2'])put('personalFriends/'+id,{ownerUid:'owner',status:'pending',createdAt:new Date(NOW)});
 const fetcher=async(url,opt)=>{
  const path=decodeURIComponent(url.split('/documents/')[1]||'');
  if(!opt?.body){const d=store.get(path);return d?new Response(JSON.stringify({name:root+'/'+path,fields:d.fields,updateTime:d.t})):new Response('',{status:404});}
  const {writes}=JSON.parse(opt.body);
  for(const w of writes){const p=w.update.name.split('/documents/')[1],d=store.get(p),pre=w.currentDocument;
   if((pre.exists===false&&d)||(pre.updateTime&&pre.updateTime!==d?.t))return new Response(JSON.stringify({error:{status:'FAILED_PRECONDITION'}}),{status:409});}
  for(const w of writes){const p=w.update.name.split('/documents/')[1],old=store.get(p);store.set(p,{fields:w.updateMask?{...old.fields,...w.update.fields}:w.update.fields,t:'v'+(++clock)});}
  return new Response('{}');
 };
 const results=await Promise.all(['race1','race2'].map((invite,i)=>acceptInvite(firestore('fake',fetcher),{scope:'personal',invite,uid:'anonymous'+i,line:line(),now:NOW})));
 assert.equal(results.filter(x=>x.ok).length,1);assert.equal(results.filter(x=>x.error==='limit').length,1);
 assert.equal(store.get('lineInviteLimits/'+qid).fields.daily.integerValue,'5');
 assert.equal(['race1','race2'].filter(id=>store.get('personalFriends/'+id).fields.status.stringValue==='joined').length,1);
});
