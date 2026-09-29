const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require(process.env.HIBIRUKA_JSDOM_PATH || 'jsdom');
const html=fs.readFileSync('index/index/index.html','utf8');
function app({url='?start=1',legacy=false,linked=false,returning=false,invite=false}={}){
 const dom=new JSDOM(html,{url:'https://example.test/index/'+url,runScripts:'outside-only'}),w=dom.window,d=w.document;
 const data=new Map(),calls=[],queries=[],errors=[];let serial=0;
 if(legacy)data.set('members/A',{pinHash:'test'});
 if(returning)data.set('personalConfig/A',{ownerName:'Alice'});
 if(invite)data.set('personalFriends/token',{ownerUid:'sender',from:'Sender',name:'A',status:'pending'});
 const snap=path=>({id:path.split('/').pop(),exists:data.has(path),data:()=>data.get(path),ref:ref(path)});
 const ref=path=>({path,id:path.split('/').pop(),get:async()=>snap(path),set:async(x,opt)=>{calls.push(['set',path]);data.set(path,opt?.merge?{...data.get(path),...x}:x);},update:async(x)=>{calls.push(['update',path]);data.set(path,{...data.get(path),...x});},delete:async()=>data.delete(path),onSnapshot:cb=>{cb(snap(path));return()=>{};}});
 const query=(name,filters=[])=>({
  doc:id=>ref(name+'/'+(id||'new'+(++serial))),
  where:(...filter)=>query(name,[...filters,filter]),orderBy:()=>query(name,filters),
  add:async x=>{const r=ref(name+'/new'+(++serial));await r.set(x);return r;},
  get:async()=>{queries.push({name,filters});const docs=[...data.keys()].filter(p=>p.startsWith(name+'/')&&filters.every(([k,op,v])=>data.get(p)[k]===v)).map(snap);return{docs,forEach:f=>docs.forEach(f)};},
  onSnapshot:cb=>{queries.push({name,filters});cb({docs:[]});return()=>{};}
 });
 const db={collection:name=>query(name),batch:()=>({set:(r,x)=>r.set(x),delete:r=>r.delete(),commit:async()=>{}}),runTransaction:async fn=>fn({get:r=>r.get(),set:(r,x,opt)=>r.set(x,opt),update:(r,x)=>r.update(x)})};
 const user={uid:'A',isAnonymous:!linked,...(linked?{email:'a@example.test'}:{}),linkWithCredential:async c=>{user.email=c.email;user.isAnonymous=false;calls.push(['link',user.uid]);}};
 const auth={currentUser:user,setPersistence:async()=>{},signInAnonymously:async()=>{calls.push(['anonymous']);return{user};}};
 const authFn=()=>auth;authFn.Auth={Persistence:{LOCAL:'local'}};authFn.EmailAuthProvider={credential:(email,password)=>({email,password})};
 const firestore=()=>db;firestore.FieldValue={serverTimestamp:()=>1,arrayUnion:x=>[x],arrayRemove:()=>[],increment:x=>x};
 w.firebase={initializeApp:()=>{},auth:authFn,firestore};w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};w.console.error=(...args)=>errors.push(args);w.liff={init:async()=>{},isLoggedIn:()=>true,getProfile:async()=>({userId:'U'+'a'.repeat(32),displayName:'A'}),isInClient:()=>false};
 const script=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(Boolean).pop();
 w.eval(script.slice(0,script.indexOf('/* ---------- 入口 ---------- */'))+'\nconst qs=new URLSearchParams(location.search);globalThis.h={entryParams,startOwner,startInvite,saveRecord,createInvite,prepareSelfLine,setupAccount,recordCollection,appRef,get personal(){return personalMode}};');
 return{w,d,data,calls,queries,close:()=>{w.close();assert.equal(errors.length,0,errors.map(String).join(' '));}};
}
test('new user gets a private profile and all list queries are owner-filtered',async()=>{
 const a=app();try{await a.w.h.startOwner();assert(a.w.h.personal);assert(a.data.has('personalConfig/A'));assert(!a.data.has('members/A'));for(const q of a.queries.filter(q=>['personalEvents','personalFriends'].includes(q.name)))assert.equal(JSON.stringify(q.filters),JSON.stringify([['ownerUid','==','A']]));assert(a.d.getElementById('legacyTransfer').classList.contains('hidden'));}finally{a.close();}
});
test('new user saves memories and invitations only to personal collections with an owner ID',async()=>{
 const a=app();try{await a.w.h.startOwner();a.d.querySelector('#catPills [data-cat]').click();a.d.getElementById('fKind').value='memory';a.d.getElementById('fDate').value='2020-01-01';a.d.getElementById('fTitle').value='Private memory';await a.w.h.saveRecord();const entry=[...a.data].find(([k])=>k.startsWith('personalEvents/'));assert(entry);assert.equal(entry[1].ownerUid,'A');assert(![...a.data.keys()].some(k=>k.startsWith('events/')));a.d.getElementById('inviteName').value='Friend';await a.w.h.createInvite();assert([...a.data].some(([k,v])=>k.startsWith('personalFriends/')&&v.ownerUid==='A'));assert(a.d.getElementById('copyLinkBtn').dataset.url.includes('scope=personal'));await a.w.h.prepareSelfLine();assert(a.d.getElementById('selfLineLink').href.includes('scope=personal'));}finally{a.close();}
});
test('legacy owner keeps existing workspace even if start link is opened',async()=>{
 const a=app({legacy:true});try{await a.w.h.startOwner();assert(!a.w.h.personal);assert(!a.data.has('personalConfig/A'));assert(a.queries.some(q=>q.name==='events'));assert(!a.queries.some(q=>q.name==='personalEvents'));}finally{a.close();}
});
test('returning email user stays signed in; linking anonymous account preserves UID and records',async()=>{
 const a=app({returning:true,linked:true});try{await a.w.h.startOwner();assert(a.w.h.personal);assert(!a.calls.some(c=>c[0]==='anonymous'));assert(a.d.getElementById('accountForm').classList.contains('hidden'));}finally{a.close();}
 const b=app();try{await b.w.h.startOwner();b.d.getElementById('accountEmail').value='a@example.test';b.d.getElementById('accountPassword').value='long-password';b.d.getElementById('accountPasswordAgain').value='long-password';await b.d.getElementById('accountForm').onsubmit({preventDefault(){}});assert(b.calls.some(c=>c[0]==='link'&&c[1]==='A'));assert(b.data.has('personalConfig/A'));}finally{b.close();}
});
test('personal invite acceptance preserves current account and records acceptance identity',async()=>{
 const a=app({url:'?invite=token&scope=personal',invite:true,linked:true});try{await a.w.h.startInvite();await a.d.getElementById('invAcceptBtn').onclick();const f=a.data.get('personalFriends/token');assert.equal(f.status,'joined');assert.equal(f.acceptedBy,'A');assert.equal(f.ownerUid,'sender');assert(!a.calls.some(c=>c[0]==='anonymous'));}finally{a.close();}
});

test('first record guidance opens the chosen form and can be dismissed without losing data',async()=>{
 const a=app();try{await a.w.h.startOwner();assert(!a.d.getElementById('firstRecordGuide').classList.contains('hidden'));a.d.getElementById('firstMemory').click();assert.equal(a.d.getElementById('fKind').value,'memory');assert(!a.d.getElementById('tab-rec').classList.contains('hidden'));a.d.getElementById('skipFirstRecord').click();assert(a.d.getElementById('firstRecordGuide').classList.contains('hidden'));assert(a.data.has('personalConfig/A'));}finally{a.close();}
});
test('LIFF menu destinations are separated from invitations and explicit parameters win',()=>{
 const a=app();try{const p=a.w.h.entryParams('?liff.state='+encodeURIComponent('/?tab=list&view=mem'));assert.equal(p.get('view'),'mem');assert.equal(p.has('invite'),false);const q=a.w.h.entryParams('?view=cal&liff.state='+encodeURIComponent('/?view=mem&invite=t&scope=personal&redirect=https://evil.test'));assert.equal(q.get('view'),'cal');assert.equal(q.get('invite'),'t');assert.equal(q.has('redirect'),false);}finally{a.close();}
});
