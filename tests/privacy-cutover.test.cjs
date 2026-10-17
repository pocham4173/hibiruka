'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(require.resolve('../scripts/privacy-cutover.cjs'),'utf8');
function fixture(){
 const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
 const plan={uid:'fixture-owner',ownersVersion:'10:0',rulesName:'old-rule',sourceHash:digest('old'),targetHash:digest('private'),preparedAt:Date.now(),records:Object.fromEntries(['events','photos','friends','pets'].map(c=>[c,{retained:'20:0'}]))};
 const files={'/tmp/hibiruka-private-plan.json':JSON.stringify(plan),'/tmp/hibiruka-combined.rules':'private','index/index/index.html':'apiKey: "fixture-key"'};
 const docs=new Map([['config/owners',{uids:['fixture-owner','old-browser'],preserved:'yes'}],['schedulerStatus/cloudflare',{version:'tested-commit',ok:true,enabled:true,checkedAt:{toMillis:()=>Date.now()}}]]);
 const writes=[],releases=[],users=[],logs=[];let outsiderStatus=403,backupStatus=403;let rules={name:'old-rule',source:[{content:'old'}]},memberCount=0;
 const ref=path=>({path,get:async()=>snapshot(path)});
 const snapshot=path=>({exists:docs.has(path),data:()=>docs.get(path),updateTime:{seconds:10,nanoseconds:0}});
 const db={doc:ref,collection:name=>({count:()=>({get:async()=>({data:()=>({count:memberCount})})}),select:()=>({limit:()=>({get:async()=>({size:1,docs:[{id:'retained',updateTime:{seconds:20,nanoseconds:0},data:()=>{throw Error('Record body must not be read');}}]})})})}),runTransaction:async fn=>{
  const pending=[];
  const result=await fn({get:r=>r.get(),create:(r,v)=>{assert(!docs.has(r.path));pending.push([r.path,v]);},set:(r,v)=>pending.push([r.path,v]),update:(r,v)=>pending.push([r.path,{...docs.get(r.path),...v}])});
  for(const [path,value]of pending){writes.push(path);docs.set(path,value);}return result;
 }};
 const firestore=()=>db;firestore.FieldValue={serverTimestamp:()=>({fixtureTimestamp:true})};
 const admin={firestore,securityRules:()=>({getFirestoreRuleset:async()=>rules,releaseFirestoreRulesetFromSource:async s=>{releases.push(s);rules={name:'new-rule',source:[{content:s}]};}}),auth:()=>({getUser:async()=>({}),createUser:async({uid})=>users.push(uid),deleteUser:async uid=>users.splice(users.indexOf(uid),1),createCustomToken:async uid=>'token-'+uid})};
 const sandbox={module:{exports:{}},Buffer,console:{log:x=>logs.push(x)},process:{},AbortSignal,setTimeout:fn=>{fn();},fetch:async(url,args)=>{
  if(url.includes('identitytoolkit'))return {ok:true,json:async()=>({idToken:JSON.parse(args.body).token})};
  const owner=args.headers.Authorization.includes('fixture-owner');
  return {status:url.includes('legacyPrivacyBackup')?backupStatus:owner?200:outsiderStatus,arrayBuffer:async()=>new ArrayBuffer(0)};
 },require:name=>{
  if(name==='node:fs')return {readFileSync:p=>files[p],writeFileSync:(p,s)=>{files[p]=s;}};
  if(name==='node:crypto')return crypto;
  if(name==='./service-account.cjs')return {};
  if(name==='./privacy-owner-match.cjs')return {confirmedOwner:async()=>({uid:'fixture-owner',owners:snapshot('config/owners')})};
  if(name==='./legacy-private-rules.cjs')return {privateRules:()=> 'private'};
  throw Error('Unexpected import');
 }};
 vm.runInNewContext(source,sandbox);
 return {api:sandbox.module.exports,admin,docs,writes,releases,users,logs,plan,files,outsiderStatus:v=>outsiderStatus=v,backupStatus:v=>backupStatus=v,memberCount:v=>memberCount=v,rules:v=>rules=v};
}
test('cutover preserves record collections and activates only after owner/outsider checks',async()=>{
 const f=fixture();await f.api.apply(f.admin,{},'tested-commit');
 assert.deepEqual(f.writes,['config/legacyPrivacyBackup','config/legacyPrivacy']);
 assert.equal(f.docs.get('config/legacyPrivacy').activated,false);
 assert.deepEqual(f.releases,['private']);
 await f.api.verify(f.admin,{});
 assert.equal(f.docs.get('config/legacyPrivacy').activated,true);
 assert.deepEqual(Array.from(f.docs.get('config/owners').uids),['fixture-owner']);
 assert.equal(f.docs.get('config/owners').preserved,'yes');
 assert.equal(f.docs.get('config/legacyPrivacyBackup').owners.uids.length,2);
 assert.deepEqual(f.users,[]);
 assert(f.writes.every(p=>['config/owners','config/legacyPrivacy','config/legacyPrivacyBackup'].includes(p)));
 assert(!f.logs.join('').includes('fixture-owner'));
});
test('stale rules, memberships, unverified worker or altered plan stop before writes',async()=>{
 for(const mutate of [f=>f.rules({name:'changed',source:[{content:'old'}]}),f=>f.memberCount(1),f=>f.docs.get('schedulerStatus/cloudflare').enabled=false,f=>f.files['/tmp/hibiruka-combined.rules']='unreviewed']){
  const f=fixture();mutate(f);await assert.rejects(()=>f.api.apply(f.admin,{},'tested-commit'));
  assert.deepEqual(f.writes,[]);assert.deepEqual(f.releases,[]);
 }
});
test('existing privacy lock or backup cannot be overwritten by another cutover',async()=>{
 for(const path of ['config/legacyPrivacy','config/legacyPrivacyBackup']){
  const f=fixture();f.docs.set(path,{existing:true});await assert.rejects(()=>f.api.apply(f.admin,{},'tested-commit'));
  assert.deepEqual(f.writes,[]);assert.deepEqual(f.releases,[]);
 }
});
test('retention check detects deletion or changes and permits additional records',()=>{
 const f=fixture(),before=f.plan.records,after=structuredClone(before);
 after.events.new='new';assert(f.api.unchanged(before,after));
 after.photos.retained='changed';assert(!f.api.unchanged(before,after));
 delete after.photos.retained;assert(!f.api.unchanged(before,after));
});

test('failed outsider or backup denial never activates the UI and always removes the test account',async()=>{
 for(const mutate of [f=>f.outsiderStatus(200),f=>f.backupStatus(200)]){
  const f=fixture();await f.api.apply(f.admin,{},'tested-commit');mutate(f);
  await assert.rejects(()=>f.api.verify(f.admin,{}));
  assert.equal(f.docs.get('config/legacyPrivacy').activated,false);
  assert.equal(f.docs.get('config/owners').uids.length,2);
  assert.deepEqual(f.users,[]);
  assert(!f.logs.some(s=>s.startsWith('PRIVACY_VERIFIED')));
 }
});
