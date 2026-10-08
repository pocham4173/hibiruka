import {test} from 'node:test';
import assert from 'node:assert/strict';
import {acceptInvite, lineUserFromToken, LIFF_CHANNEL} from '../line-worker/accept.mjs';
const U1='U'+'1'.repeat(32), U2='U'+'2'.repeat(32), NOW=Date.parse('2026-10-08T10:00:00Z');
function memoryDb(data){
  const col=c=>(data[c]??={});
  const ref=(c,id)=>({id,path:c+'/'+id,get:async()=>({exists:id in col(c),data:()=>col(c)[id]})});
  return {data,collection:c=>({doc:id=>ref(c,id)}),
    runTransaction:async fn=>{const w=[];const r=await fn({get:x=>x.get(),update:(x,v)=>w.push([x,v])});for(const [x,v] of w){const [c,id]=x.path.split('/');Object.assign(col(c)[id],v);}return r;}};
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
