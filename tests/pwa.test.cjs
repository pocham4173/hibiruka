const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {JSDOM}=require(process.env.HIBIRUKA_JSDOM_PATH||'jsdom');
function installer(){
 const dom=new JSDOM('<button data-install>追加</button><div id="app" class="hidden"></div>',{url:'https://example.test/hibiruka/index/index/?invite=private',runScripts:'outside-only'}),w=dom.window;
 Object.defineProperty(w.navigator,'userAgent',{value:'Mozilla Android Chrome/130.0'});w.matchMedia=()=>({matches:false});w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.eval(fs.readFileSync('index/index/install.js','utf8'));return dom;
}
test('Android Chrome fallback has visible steps, no Chrome loop, and native prompt is consumed once',async()=>{
 const dom=installer(),w=dom.window,d=w.document;try{
 d.querySelector('[data-install]').click();assert(d.getElementById('installFallback').open);assert(d.getElementById('installChrome').hidden);
 let calls=0;const e=new w.Event('beforeinstallprompt');e.prompt=async()=>{calls++;};e.userChoice=Promise.resolve({outcome:'accepted'});w.dispatchEvent(e);
 d.querySelector('[data-install]').click();await new Promise(r=>setImmediate(r));assert.equal(calls,1);
 w.dispatchEvent(new w.Event('appinstalled'));assert(d.querySelector('[data-install]').disabled);assert(!d.getElementById('installChrome').href.includes('private'));
 }finally{w.close();}
});
test('offline fallback caches only public assets and leaves external and private API requests alone',async()=>{
 const handlers={},stored=new Map();let list;
 const cache={addAll:async urls=>{list=urls;for(const u of urls)stored.set(u,new Response('offline'));},match:async key=>stored.get(typeof key==='string'?key:key.url)};
 const ctx={URL,Response,fetch:async()=>{throw Error('offline');},caches:{open:async()=>cache,keys:async()=>['unrelated-app','hibiruka-public-old'],delete:async k=>{assert.equal(k,'hibiruka-public-old');}},self:{registration:{scope:'https://example.test/hibiruka/index/index/'},location:{origin:'https://example.test'},skipWaiting:async()=>{},clients:{claim:async()=>{}},addEventListener:(type,fn)=>handlers[type]=fn}};
 vm.runInNewContext(fs.readFileSync('index/index/sw.js','utf8'),ctx);
 await new Promise((resolve,reject)=>handlers.install({waitUntil:p=>p.then(resolve,reject)}));assert.equal(list.length,3);assert(!list.some(x=>x.includes('index.html')));
 await new Promise((resolve,reject)=>handlers.activate({waitUntil:p=>p.then(resolve,reject)}));
 let response;handlers.fetch({request:{method:'GET',mode:'navigate',url:'https://example.test/hibiruka/index/index/?invite=private'},respondWith:p=>response=p});assert.equal(await (await response).text(),'offline');
 for(const url of ['https://firestore.googleapis.com/private','https://example.test/private.json'])handlers.fetch({request:{method:'GET',mode:'cors',url},respondWith:()=>assert.fail('must not intercept API requests')});
});
