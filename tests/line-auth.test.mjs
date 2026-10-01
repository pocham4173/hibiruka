import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyFirebase,verifyLine,acceptInvitation,createHandler} from '../line-auth/index.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {replaceFriendRules}=require('../scripts/registration-rules.cjs');
const response=(data,status=200)=>new Response(JSON.stringify(data),{status});
const now=Math.floor(Date.now()/1000),project='hibiruka-f66fb';
const claims={aud:project,iss:`https://securetoken.google.com/${project}`,sub:'person-A',exp:now+3600,iat:now,auth_time:now};
const token=c=>'header.'+Buffer.from(JSON.stringify(c)).toString('base64url')+'.signature';
const profile={userId:'U'+'a'.repeat(32),displayName:'Verified name'};
const env={LINE_LOGIN_CHANNEL_ID:'1234567890',FIREBASE_API_KEY:'test-key',FIREBASE_SERVICE_ACCOUNT:'test-secret'};
function dbFixture(initial={status:'pending',ownerUid:'sender',name:'Recipient'}){
 let record=structuredClone(initial),writes=0;
 return {get record(){return record;},get writes(){return writes;},db:{collection:name=>({doc:id=>({name,id})}),runTransaction:async fn=>fn({get:async ref=>({exists:!!record,data:()=>structuredClone(record)}),update:(ref,data)=>{writes++;record={...record,...data};}})}};
}
const request=(body={},headers={})=>new Request('https://example.test/v1/invitations/accept',{method:'POST',headers:{Origin:'https://pocham4173.github.io','Content-Type':'application/json',Authorization:'Bearer firebase-token',...headers},body:JSON.stringify({scope:'personal',invitationId:'abcdefghijklmnopqrst',lineAccessToken:'line-token',...body})});
test('Firebase identity is checked by Google and bound to the exact project and UID',async()=>{
 let calls=0;const fetcher=async (url,opt)=>{calls++;assert(url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup?'));assert.equal(JSON.parse(opt.body).idToken,token(claims));return response({users:[{localId:'person-A',validSince:String(now-1)}]});};
 assert.equal(await verifyFirebase(token(claims),'test-key',fetcher),'person-A');assert.equal(calls,1);
 for(const altered of [{...claims,aud:'other'},{...claims,iss:'https://evil.test'},{...claims,exp:now-1},{...claims,auth_time:now+600}])await assert.rejects(verifyFirebase(token(altered),'test-key',fetcher));
 assert.equal(calls,1);
 for(const user of [{localId:'other'},{localId:'person-A',disabled:true},{localId:'person-A',validSince:String(now+1)}])await assert.rejects(verifyFirebase(token(claims),'test-key',async()=>response({users:[user]})));
 await assert.rejects(verifyFirebase(token(claims),'test-key',async()=>response({error:'invalid signature'},400)));
});
test('LINE token must belong to the configured channel, be live, and grant profile access',async()=>{
 const calls=[];const fetcher=async(url,opt)=>{calls.push(url);if(url.includes('/verify?'))return response({client_id:'1234567890',expires_in:300,scope:'profile openid'});assert.equal(opt.headers.Authorization,'Bearer line-token');return response(profile);};
 assert.deepEqual(await verifyLine('line-token','1234567890',fetcher),profile);assert.equal(calls.length,2);
 for(const data of [{client_id:'other',expires_in:300,scope:'profile'},{client_id:'1234567890',expires_in:0,scope:'profile'},{client_id:'1234567890',expires_in:300,scope:'openid'}])await assert.rejects(verifyLine('line-token','1234567890',async()=>response(data)));
});
test('only server-returned LINE identity is saved; replay is idempotent and cannot replace it',async()=>{
 const f=dbFixture();await acceptInvitation(f.db,'personal','token','person-A',profile);
 assert.equal(f.record.lineUserId,profile.userId);assert.equal(f.record.lineName,profile.displayName);assert.equal(f.record.ownerUid,'sender');assert.equal(f.record.verificationVersion,1);
 await acceptInvitation(f.db,'personal','token','person-A',profile);assert.equal(f.writes,1);
 await assert.rejects(acceptInvitation(f.db,'personal','token','person-B',{...profile,userId:'U'+'b'.repeat(32)}));assert.equal(f.writes,1);
 for(const value of [null,{status:'cancelled'},{status:'pending'}])await assert.rejects(acceptInvitation(dbFixture(value).db,'personal','token','person-A',profile));
});
test('endpoint requires both identities and rejects client-supplied names, IDs and paths',async()=>{
 const f=dbFixture();let authCalls=0;const handler=createHandler({db:f.db,verifyFirebase:async()=>{authCalls++;return 'person-A';},verifyLine:async()=>profile});
 assert.equal((await handler(request(),env)).status,200);assert.equal(f.writes,1);
 for(const body of [{lineUserId:'forged'},{lineName:'forged'},{scope:'events'},{invitationId:'../../other'}])assert.equal((await handler(request(body),env)).status,400);
 assert.equal(authCalls,1);
 assert.equal((await handler(request({}, {Authorization:''}),env)).status,401);
 assert.equal((await handler(request({}, {Origin:'https://evil.test'}),env)).status,403);
 assert.equal((await handler(request(),{...env,LINE_LOGIN_CHANNEL_ID:''})).status,503);
 assert.equal((await handler(request({lineAccessToken:'a'.repeat(20000)}),env)).status,413);
});
test('failed verification never writes and error responses do not reveal tokens or records',async()=>{
 const f=dbFixture(),handler=createHandler({db:f.db,verifyFirebase:async()=>{throw Error('secret-token-and-private-data');}});
 const result=await handler(request(),env);assert.equal(result.status,503);assert(!String(await result.text()).includes('secret'));assert.equal(f.writes,0);
});
test('preflight is scoped to the registration route; there is no public send route',async()=>{
 const handler=createHandler();
 const preflight=await handler(new Request('https://example.test/v1/invitations/accept',{method:'OPTIONS',headers:{Origin:'https://pocham4173.github.io'}}),env);
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'https://pocham4173.github.io');
 assert.equal((await handler(new Request('https://example.test/send',{headers:{Origin:'https://pocham4173.github.io'}}),env)).status,404);
});
test('client sends tokens to the fixed server without sending getProfile data or storing them',async()=>{
 const window={},calls=[];vm.runInNewContext(readFileSync('index/index/line-registration.js','utf8'),{window,AbortSignal,fetch:async(url,options)=>{calls.push({url,options});return response({ok:true});}});
 await window.registerVerifiedLine({auth:{currentUser:{getIdToken:async()=>'firebase-token'}},liff:{getAccessToken:()=> 'line-token',getProfile:()=>{throw Error('must not trust profile');}},invitationId:'token',scope:'personal'});
 assert.equal(calls[0].url,'https://hibiruka-auth.okm-co.workers.dev/v1/invitations/accept');assert.equal(calls[0].options.headers.Authorization,'Bearer firebase-token');assert.deepEqual(JSON.parse(calls[0].options.body),{scope:'personal',invitationId:'token',lineAccessToken:'line-token'});
});
test('rule migration changes exactly the legacy friends block and refuses ambiguous sources',()=>{
 const source='before match /friends/{id} { allow update: if x; /* } */ } after';
 assert.equal(replaceFriendRules(source,'NEW'),'before NEW after');
 assert.throws(()=>replaceFriendRules('no matching block','NEW'));
 assert.throws(()=>replaceFriendRules(source+source,'NEW'));
 assert.throws(()=>replaceFriendRules('match /friends/{id} {','NEW'));
});
