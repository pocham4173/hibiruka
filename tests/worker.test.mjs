import {test} from 'node:test';
import assert from 'node:assert/strict';
import {firestore,encode,decode} from '../line-worker/firestore.mjs';
import worker,{googleToken} from '../line-worker/index.mjs';
import {generateKeyPairSync} from 'node:crypto';
const response=(data,status=200)=>new Response(JSON.stringify(data),{status});
const root='projects/hibiruka-f66fb/databases/(default)/documents';
test('Firestore codec preserves reservation fields and timestamps',()=>{
 const record={sends:[{id:'a',at:'2026-09-29T18:00',status:'wait',leaseUntil:123,attempts:2,friendIds:['a']}],nextSendAt:null,checkedAt:new Date('2026-09-29T00:00:00Z')};
 assert.deepEqual(decode(encode(record)),record);
});
test('concurrent update is re-read before claiming; terminal reservation is not overwritten',async()=>{
 let reads=0,commits=0;
 const db=firestore('fake',async(url,opt)=>{
  if(url.endsWith(':commit')){commits++;const write=JSON.parse(opt.body).writes[0];assert.equal(write.currentDocument.updateTime,'old');return response({error:{status:'FAILED_PRECONDITION'}},400);}
  reads++;return response({name:root+'/events/e',updateTime:reads===1?'old':'new',fields:{status:{stringValue:reads===1?'wait':'sent'}}});
 });
 const ref=db.collection('events').doc('e');
 const result=await db.runTransaction(async tx=>{const s=await tx.get(ref);if(s.data().status!=='wait')return 'skip';tx.update(ref,{status:'claimed'});return 'claim';});
 assert.equal(result,'skip');assert.equal(commits,1);assert.equal(reads,2);
});
test('batch recipients preserve requested order and missing entries',async()=>{
 const db=firestore('fake',async()=>response([{missing:root+'/friends/b'},{found:{name:root+'/friends/a',updateTime:'t',fields:{status:{stringValue:'joined'}}}}]));
 const [a,b]=await db.getAll(db.collection('friends').doc('a'),db.collection('friends').doc('b'));
 assert.equal(a.data().status,'joined');assert.equal(b.exists,false);
});
test('queries are bounded and HTTP requests can never trigger sends',async()=>{
 let limit;
 const db=firestore('fake',async(u,o)=>{limit=JSON.parse(o.body).structuredQuery.limit;return response([]);});
 await db.collection('personalEvents').where('nextSendAt','<=','2026').get();assert.equal(limit,4);
 for(const method of ['GET','POST'])assert.equal((await worker.fetch(new Request('https://example.test/send',{method}))).status,404);
});
test('OAuth targets only the fixed Google token endpoint and caches a valid token',async()=>{
 const sa={project_id:'hibiruka-f66fb',client_email:'qa@hibiruka-f66fb.iam.gserviceaccount.com',private_key:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'})};
 let calls=0;const fetcher=async(url,options)=>{calls++;assert.equal(url,'https://oauth2.googleapis.com/token');const assertion=options.body.get('assertion');const claims=JSON.parse(Buffer.from(assertion.split('.')[1],'base64url'));assert.equal(claims.scope,'https://www.googleapis.com/auth/datastore');return response({access_token:'test',expires_in:3600});};
 assert.equal(await googleToken(JSON.stringify(sa),fetcher),'test');assert.equal(await googleToken(JSON.stringify(sa),fetcher),'test');assert.equal(calls,1);
 await assert.rejects(()=>googleToken(JSON.stringify({...sa,project_id:'other'}),fetcher));
});
test('sweep cursor query: ordered by document name and continues after the last ID (no composite index needed)',async()=>{
 let body;const db=firestore('fake',async(u,o)=>{body=JSON.parse(o.body);return response([]);});
 await db.collection('sendLedger').where('lineState','==','held').orderBy('__name__').startAfter('L02').limit(2).get();
 const q=body.structuredQuery;
 assert.deepEqual(q.orderBy,[{field:{fieldPath:'__name__'},direction:'ASCENDING'}]);
 assert.equal(q.startAt.before,false);assert.match(q.startAt.values[0].referenceValue,/\/documents\/sendLedger\/L02$/);
 assert.equal(q.where.fieldFilter.field.fieldPath,'lineState');assert.equal(q.limit,2);
 assert.throws(()=>db.collection('sendLedger').orderBy('updatedMs'));assert.throws(()=>db.collection('sendLedger').startAfter('x'));
});
