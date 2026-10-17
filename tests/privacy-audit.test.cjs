'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const code=fs.readFileSync('scripts/privacy-audit.cjs','utf8');
async function run({wrong=false,fail=false}={}){
 const logs=[],calls=[];let closed=false;
 const privateUid='private-owner-DO-NOT-LOG',privateError='private@example.test private-record-title';
 const db={
  doc:path=>({get:async()=>{calls.push(['get',path]);if(fail)throw Error(privateError);return {exists:true,data:()=>({uids:[privateUid]})};}}),
  collection:name=>({
   count:()=>({get:async()=>({data:()=>({count:2})})}),
   select:(...fields)=>{calls.push(['select',name,fields]);return {limit:n=>({get:async()=>({size:2,docs:[{data:()=>({ownerUid:privateUid})},{data:()=>({})}]})})};}
  })
 };
 const processStub={env:{FIREBASE_SERVICE_ACCOUNT:'secret-not-logged'},exitCode:0};
 const admin={initializeApp:()=>calls.push(['initialize']),credential:{cert:()=>({})},firestore:()=>db,app:()=>({delete:async()=>{closed=true;}})};
 const context={require:name=>name==='firebase-admin'?admin:{parseServiceAccount:()=>({project_id:wrong?'wrong-project':'hibiruka-f66fb'})},process:processStub,console:{log:(...a)=>logs.push(a.join(' ')),error:(...a)=>logs.push(a.join(' '))},Set,Error,JSON};
 await vm.runInNewContext(code,context);
 return {logs,calls,closed,processStub,privateUid,privateError};
}
test('privacy audit emits only aggregate counts, never identifiers, content or credentials',async()=>{
 const r=await run(),text=r.logs.join('\n');
 assert(r.closed);assert.equal(r.processStub.exitCode,0);
 assert.equal(r.logs.length,5);
 assert(!text.includes(r.privateUid));assert(!text.includes(r.privateError));assert(!text.includes('secret-not-logged'));
 for(const call of r.calls.filter(x=>x[0]==='select'))assert.deepEqual(Array.from(call[2]),['ownerUid']);
 const output=JSON.parse(r.logs[1].slice('PRIVACY_AGGREGATE '.length));
 assert.deepEqual(output,{collection:'events',total:2,missingOwner:1,distinctOwnerCount:1});
});
test('privacy audit suppresses sensitive error messages',async()=>{
 const r=await run({fail:true});
 assert.equal(r.processStub.exitCode,1);
 assert.equal(r.logs.join('\n'),'Aggregate read-only check failed; no details logged.');
});
test('privacy audit refuses the wrong project before any database access',async()=>{
 const r=await run({wrong:true});
 assert.equal(r.processStub.exitCode,1);assert.equal(r.calls.length,0);
});
