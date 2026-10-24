const {test}=require('node:test');
const assert=require('node:assert/strict');
const {heartbeatProblem}=require('../scripts/check-worker-health.cjs');
const {start}=require('../index/index/app-check.js');
const {smokeAppCheck}=require('../scripts/smoke-app-check.cjs');
test('diagnostic App Check caches concurrent requests, renews expiry, and hides credential errors',async()=>{
 let clock=1000,calls=0;const admin={appCheck:()=>({createToken:async(appId,options)=>{assert.equal(appId,'1:781222934569:web:fec15f161c7ac2afad4438');assert.equal(options.ttlMillis,1800000);calls++;return {token:'qa-'+calls,ttlMillis:1800000}}})};
 const check=smokeAppCheck(admin,{enabled:true,now:()=>clock});
 const headers=await Promise.all([check.headers(),check.headers()]);assert.equal(calls,1);assert.equal(headers[0]['X-Firebase-AppCheck'],'qa-1');
 clock+=1800000;assert.equal((await check.headers())['X-Firebase-AppCheck'],'qa-2');
 const broken=smokeAppCheck({appCheck:()=>({createToken:async()=>{throw Error('secret-token')}})},{enabled:true});
 await assert.rejects(()=>broken.headers(),e=>e.message.includes('App Check')&&!e.message.includes('secret-token'));
 const disabled=smokeAppCheck(admin,{enabled:false});assert.deepEqual(await disabled.headers(),{});disabled.activate({appCheck:()=>{throw Error('must not activate')}});
});
test('diagnostic App Check supplies a token through the actual Node compatibility SDK',async()=>{
 const firebase=require('firebase/compat/app');require('firebase/compat/app-check');
 const client=firebase.initializeApp({apiKey:'test',appId:'1:123:web:abc',projectId:'demo'},'app-check-test');
 try {
  const check=smokeAppCheck({appCheck:()=>({createToken:async()=>({token:'test-token',ttlMillis:1800000})})},{enabled:true});
  check.activate(client);assert.equal((await client.appCheck().getToken()).token,'test-token');
 } finally {await client.delete()}
});
test('daily monitor distinguishes a fresh sender, stale or missing heartbeat, and failed inspection',()=>{
 const now=Date.now(),ok={checkedAt:new Date(now-60000),ok:true,enabled:true,lineOk:true};
 assert.equal(heartbeatProblem(ok,now),'');
 for(const h of [null,{}, {...ok,checkedAt:new Date(now-16*60000)}, {...ok,checkedAt:new Date(now+120000)}, {...ok,ok:false},{...ok,enabled:false},{...ok,lineOk:false}])assert(heartbeatProblem(h,now));
});
test('App Check starts Enterprise with token refresh only when a real site key is configured',()=>{
 const calls=[];const appCheck=()=>({activate:(...args)=>calls.push(args)});
 appCheck.ReCaptchaEnterpriseProvider=class{constructor(key){this.key=key;}};
 assert.equal(start({appCheck},{siteKey:''}),'not-configured');assert.equal(calls.length,0);
 assert.equal(start({appCheck},{siteKey:'site-key'}),'started');assert.equal(calls[0][0].key,'site-key');assert.equal(calls[0][1],true);
 assert.equal(start({},{siteKey:'site-key'}),'unavailable');
 assert.equal(start({appCheck:()=>{throw Error('offline')}},{siteKey:'site-key'}),'unavailable');
});
