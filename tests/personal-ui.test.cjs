const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require(process.env.HIBIRUKA_JSDOM_PATH || 'jsdom');
const html=fs.readFileSync('index/index/index.html','utf8');
function app({url='?start=1',legacy=false,linked=false,returning=false,invite=false, delayed=false}={}){
 const dom=new JSDOM(html,{url:'https://example.test/index/'+url,runScripts:'outside-only'}),w=dom.window,d=w.document;
 const data=new Map(),calls=[],queries=[],errors=[];let serial=0;
 if(legacy)data.set('members/A',{pinHash:'test'});
 if(returning)data.set('personalConfig/A',{ownerName:'Alice'});
 if(invite)data.set('personalFriends/token',{ownerUid:'sender',from:'Sender',name:'A',status:'pending'});
 const snap=path=>({id:path.split('/').pop(),exists:data.has(path),data:()=>data.get(path),ref:ref(path)});
 const ref=path=>({path,id:path.split('/').pop(),get:async()=>{if(db.denyMissing && !data.has(path)){const error=new Error("Missing owner");error.code="permission-denied";throw error;}return snap(path);},set:async(x,opt)=>{calls.push(['set',path]);data.set(path,opt?.merge?{...data.get(path),...x}:x);},update:async(x)=>{calls.push(['update',path]);data.set(path,{...data.get(path),...x});},delete:async()=>data.delete(path),onSnapshot:cb=>{cb(snap(path));return()=>{};}});
 const query=(name,filters=[])=>({
  doc:id=>ref(name+'/'+(id||'new'+(++serial))),
  where:(...filter)=>query(name,[...filters,filter]),orderBy:()=>query(name,filters),
  add:async x=>{const r=ref(name+'/new'+(++serial));await r.set(x);return r;},
  get:async()=>{queries.push({name,filters});const docs=[...data.keys()].filter(p=>p.startsWith(name+'/')&&filters.every(([k,op,v])=>data.get(p)[k]===v)).map(snap);return{docs,forEach:f=>docs.forEach(f)};},
  onSnapshot:(options,success,error)=>{const cb=typeof options==="function"?options:success;queries.push({name,filters});if(name.endsWith("Events")||name==="events"){db.recordsCallback=cb;db.recordsError=error;if(delayed)return()=>{};}cb({docs:[],metadata:{fromCache:false}});return()=>{};}
 });
 const db={collection:name=>query(name),batch:()=>{const writes=[];return{set:(r,x)=>writes.push(()=>r.set(x)),update:(r,x)=>writes.push(()=>r.update(x)),delete:r=>writes.push(()=>r.delete()),commit:async()=>{if(db.failCommit){db.failCommit=false;throw new Error("test offline");}for(const write of writes)await write();if(db.failAcknowledgement){db.failAcknowledgement=false;throw new Error("test response lost");}}}},runTransaction:async fn=>fn({get:r=>r.get(),set:(r,x,opt)=>r.set(x,opt),update:(r,x)=>r.update(x)})};
 const user={uid:'A',isAnonymous:!linked,...(linked?{email:'a@example.test'}:{}),linkWithCredential:async c=>{user.email=c.email;user.isAnonymous=false;calls.push(['link',user.uid]);}};
 const auth={currentUser:user,signInWithEmailAndPassword:async()=>{calls.push(['signin']);},setPersistence:async()=>{},signInAnonymously:async()=>{calls.push(['anonymous']);return{user};}};
 const authFn=()=>auth;authFn.Auth={Persistence:{LOCAL:'local'}};authFn.EmailAuthProvider={credential:(email,password)=>({email,password})};
 const firestore=()=>db;firestore.FieldValue={serverTimestamp:()=>1,arrayUnion:x=>[x],arrayRemove:()=>[],increment:x=>x};
 w.firebase={initializeApp:()=>{},auth:authFn,firestore};w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};w.console.error=(...args)=>errors.push(args);w.liff={init:async()=>{},isLoggedIn:()=>true,getProfile:async()=>({userId:'U'+'a'.repeat(32),displayName:'A'}),isInClient:()=>false};
 const script=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(Boolean).pop();
 w.testNavigate=url=>calls.push(['navigate',url]);
 w.eval(script.slice(0,script.indexOf('/* ---------- 入口 ---------- */')).replaceAll('location.assign(', 'globalThis.testNavigate(')+'\nconst qs=new URLSearchParams(location.search);globalThis.h={addPhotos,setShrink:fn=>shrink=fn,get draftId(){return draftRecordId},editRecord,setEvents:value=>events=value,setPhotos:value=>form.photos=value,startLogin,entryParams,startOwner,startInvite,saveRecord,createInvite,prepareSelfLine,setupAccount,recordCollection,appRef,get personal(){return personalMode}};');
 return{w,d,data,calls,queries,db,errors,close:()=>{w.close();assert.equal(errors.length,0,errors.map(String).join(' '));}};
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
 const b=app();try{await b.w.h.startOwner();b.d.getElementById('accountEmail').value='a@example.test';b.d.getElementById('accountPassword').value='long-password';await b.d.getElementById('accountForm').onsubmit({preventDefault(){}});assert(b.calls.some(c=>c[0]==='link'&&c[1]==='A'));assert(b.data.has('personalConfig/A'));}finally{b.close();}
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

test('registration supports password managers and one password entry without storing credentials',async()=>{
 const a=app();try{await a.w.h.startOwner();const d=a.d;assert.equal(d.getElementById('accountPasswordAgain'),null);assert.equal(d.getElementById('accountForm').method,'post');assert.equal(d.getElementById('accountPassword').autocomplete,'new-password');assert(d.getElementById('accountEmail').name);
 const toggle=d.querySelector('[data-password="accountPassword"]');toggle.click();assert.equal(d.getElementById('accountPassword').type,'text');toggle.click();assert.equal(d.getElementById('accountPassword').type,'password');
 d.getElementById('accountEmail').value='a@example.test';d.getElementById('accountPassword').value='long-password';await d.getElementById('accountForm').onsubmit({preventDefault(){}});assert(a.calls.some(c=>c[0]==='link'));assert(a.calls.some(c=>c[0]==='navigate'&&c[1]==='./?tab=set&account=saved'));assert.equal(d.getElementById('accountPassword').value,'long-password');assert(!JSON.stringify([...a.data]).includes('long-password'));assert(!JSON.stringify(a.w.localStorage).includes('long-password'));
 }finally{a.close();}
});
test('login is an autofill-compatible form with an accessible password toggle',()=>{
 const a=app({url:'?signin=1'});try{a.w.h.startLogin();const d=a.d;assert.equal(d.getElementById('loginForm').method,'post');assert.equal(d.getElementById('loginEmail').autocomplete,'username');assert.equal(d.getElementById('loginPassword').autocomplete,'current-password');assert.equal(d.getElementById('loginEmail').getAttribute('autocapitalize'),'none');d.querySelector('[data-password="loginPassword"]').click();assert.equal(d.getElementById('loginPassword').type,'text');}finally{a.close();}
});

test('successful login navigates without clearing the submitted password',async()=>{
 const a=app({url:'?signin=1'});try{a.w.h.startLogin();a.d.getElementById('loginEmail').value='a@example.test';a.d.getElementById('loginPassword').value='long-password';await a.d.getElementById('loginForm').onsubmit({preventDefault(){}});assert(a.calls.some(c=>c[0]==='signin'));assert(a.calls.some(c=>c[0]==='navigate'&&c[1]==='./'));assert.equal(a.d.getElementById('loginPassword').value,'long-password');}finally{a.close();}
});

test('welcome never asks for a new PIN; restoration appears only through the explicit legacy link',async()=>{
 const a=app({url:''});try{await a.w.h.startOwner();assert(!a.d.getElementById('pairView').classList.contains('hidden'));assert(a.d.getElementById('pinDetails').classList.contains('hidden'));assert.equal(a.d.getElementById('pinInput2'),null);assert(!a.calls.some(c=>c[0]==='set'));}finally{a.close();}
 const b=app({url:'?legacy=1'});try{await b.w.h.startOwner();assert(!b.d.getElementById('pinDetails').classList.contains('hidden'));assert(b.d.getElementById('pinDetails').open);assert.equal(b.d.getElementById('pinTitle').textContent,'以前の番号で復元する');assert(!b.calls.some(c=>c[0]==='set'));}finally{b.close();}
});

test('photo commit failure preserves full images and retry uses the same record ID',async()=>{
 const a=app();try{
 await a.w.h.startOwner();a.db.denyMissing=true;a.d.querySelector('#catPills [data-cat]').click();
 a.d.getElementById('fKind').value='memory';a.d.getElementById('fDate').value='2020-01-01';a.d.getElementById('fTitle').value='Memory';
 a.w.h.setPhotos([{thumb:'small',full:'original-full'}]);a.db.failCommit=true;
 await a.w.h.saveRecord();assert.equal(a.errors.length,1);a.errors.length=0;
 const id='personalEvents/'+a.w.h.draftId;
 assert.equal([...a.data.keys()].filter(k=>k.startsWith('personalEvents/')||k.startsWith('personalPhotos/')).length,0);
 await a.w.h.saveRecord();assert.equal([...a.data.keys()].filter(k=>k.startsWith('personalEvents/')).length,1);
 assert.equal(a.data.get(id).thumbs[0],'small');assert.equal(a.data.get(id.replace('personalEvents/','personalPhotos/')+'_0').data,'original-full');
 }finally{a.close();}
});
test('missing original photo stops editing instead of overwriting it with a thumbnail',async()=>{
 const a=app();try{
 await a.w.h.startOwner();const event={id:'old',ownerUid:'A',cat:'遊び',date:'2020-01-01',kind:'memory',title:'Old',thumbs:['small']};
 a.data.set('personalEvents/old',event);a.w.h.setEvents([event]);await a.w.h.editRecord('old');
 assert(a.d.getElementById('tab-rec').classList.contains('hidden'));
 assert.equal(a.data.get('personalEvents/old').thumbs[0],'small');assert(!a.data.has('personalPhotos/old_0'));
 }finally{a.close();}
});

test('lost acknowledgement retries one complete record without resetting notifications',async()=>{
 const a=app();try{
 await a.w.h.startOwner();a.db.denyMissing=true;a.d.querySelector('#catPills [data-cat]').click();
 a.d.getElementById('fKind').value='memory';a.d.getElementById('fDate').value='2020-01-01';a.d.getElementById('fTitle').value='Memory';
 a.w.h.setPhotos([{thumb:'small',full:'original-full'}]);a.db.failAcknowledgement=true;
 await a.w.h.saveRecord();assert.equal(a.errors.length,1);a.errors.length=0;
 const id='personalEvents/'+a.w.h.draftId;const saved=a.data.get(id);assert.equal(saved.thumbs[0],'small');
 saved.createdAt=123;saved.sends=[{id:'existing',status:'sent'}];saved.nextSendAt='2099-01-01T00:00';
 await a.w.h.saveRecord();assert.equal([...a.data.keys()].filter(k=>k.startsWith('personalEvents/')).length,1);
 assert.equal(a.data.get(id).createdAt,123);assert.equal(a.data.get(id).sends[0].id,'existing');assert.equal(a.data.get(id).nextSendAt,'2099-01-01T00:00');
 }finally{a.close();}
});
test('failed edit leaves original photos and record untouched',async()=>{
 const a=app();try{
 await a.w.h.startOwner();const event={id:'old',ownerUid:'A',cat:'遊び',date:'2020-01-01',kind:'memory',title:'Old',thumbs:['small'],createdAt:123};
 a.data.set('personalEvents/old',event);a.data.set('personalPhotos/old_0',{ownerUid:'A',eventId:'old',i:0,data:'original'});
 a.w.h.setEvents([event]);await a.w.h.editRecord('old');a.d.getElementById('fTitle').value='Changed';a.w.h.setPhotos([]);a.db.failCommit=true;
 await a.w.h.saveRecord();assert.equal(a.errors.length,1);a.errors.length=0;
 assert.equal(a.data.get('personalEvents/old').title,'Old');assert.equal(a.data.get('personalPhotos/old_0').data,'original');
 await a.w.h.saveRecord();assert.equal(a.data.get('personalEvents/old').title,'Changed');assert(!a.data.has('personalPhotos/old_0'));
 }finally{a.close();}
});
test('saving waits until selected photos finish preparing',async()=>{
 const a=app();try{
 await a.w.h.startOwner();a.d.querySelector('#catPills [data-cat]').click();a.d.getElementById('fKind').value='memory';a.d.getElementById('fDate').value='2020-01-01';a.d.getElementById('fTitle').value='Memory';
 let finish;a.w.h.setShrink(()=>new Promise(resolve=>{finish=resolve;}));
 const preparing=a.w.h.addPhotos({target:{files:['photo'],value:'selected'}});
 await a.w.h.saveRecord();assert(![...a.data.keys()].some(k=>k.startsWith('personalEvents/')));
 finish('thumb');await new Promise(resolve=>setImmediate(resolve));finish('full');await preparing;
 await a.w.h.saveRecord();const photo=[...a.data.values()].find(v=>v.data==='full');assert(photo);
 }finally{a.close();}
});

test('loading and empty offline cache never claim that records are missing; server result resolves loading',async()=>{
 const a=app({returning:true,delayed:true});try{
 await a.w.h.startOwner();const box=a.d.getElementById('listBox');
 assert.match(box.textContent,/読み込み中/);assert.equal(a.d.getElementById('listCount').textContent,'');
 assert(a.d.getElementById('firstRecordGuide').classList.contains('hidden'));
 a.db.recordsCallback({docs:[],metadata:{fromCache:true}});assert.match(box.textContent,/確認中/);assert.doesNotMatch(box.textContent,/ありません/);
 a.db.recordsCallback({docs:[],metadata:{fromCache:false}});assert.equal(a.d.getElementById('listCount').textContent,'0件');
 }finally{a.close();}
});
test('read failure offers retry, preserves previously loaded records and recovers',async()=>{
 const a=app({returning:true,delayed:true});try{
 await a.w.h.startOwner();const box=a.d.getElementById('listBox');
 a.db.recordsError({code:'unavailable'});assert.match(box.textContent,/読み込めません/);assert.doesNotMatch(box.textContent,/ありません/);
 box.querySelector('[data-retry-records]').click();assert.match(box.textContent,/読み込み中/);
 const snapshot={docs:[{id:'kept',data:()=>({title:'大切な予定',date:'2099-01-01',time:'09:00',kind:'plan'})}],metadata:{fromCache:false}};
 a.db.recordsCallback(snapshot);assert.match(box.textContent,/大切な予定/);
 a.db.recordsError({code:'permission-denied'});assert.match(box.textContent,/大切な予定/);assert.match(box.textContent,/読み込めません/);
 box.querySelector('[data-retry-records]').click();a.db.recordsCallback(snapshot);assert.match(box.textContent,/大切な予定/);assert.doesNotMatch(box.textContent,/読み込めません/);
 }finally{a.close();}
});

test('category rename preserves records, photos and selected filter in personal and legacy workspaces',async()=>{
 for(const legacy of [false,true]){
 const a=app({legacy});try{
 a.w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};a.w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 await a.w.h.startOwner();
 const path=legacy?'events/old':'personalEvents/old';
 const event={id:'old',cat:'遊び',date:'2020-01-01',kind:'memory',title:'大切な写真',thumbs:['photo'],reminders:[{status:'pending'}]};
 a.data.set(path,event);a.w.h.setEvents([event]);
 a.d.getElementById('catEditBtn2').click();a.d.querySelector('[data-rename-cat="0"]').click();
 a.d.getElementById('catRenameName').value='ぽむ🐶';
 await a.d.getElementById('catRenameForm').onsubmit({preventDefault(){}});
 assert.equal(a.d.getElementById('catRename').open,false);
 assert.deepEqual(a.data.get(path),event);
 assert.equal(a.calls.filter(c=>c[0]==='update'&&c[1]===path).length,0);
 assert(a.d.querySelector('#catPills [data-cat="遊び"]').textContent.includes('ぽむ🐶'));
 const filter=a.d.querySelector('[data-f="遊び"]');assert(filter.textContent.includes('ぽむ🐶'));filter.click();
 a.d.querySelector('[data-view="mem"]').click();assert(a.d.getElementById('listBox').textContent.includes('大切な写真'));assert(a.d.getElementById('listBox').textContent.includes('ぽむ🐶'));
 a.d.getElementById('catEditBtn2').click();a.d.querySelector('[data-rename-cat="0"]').click();assert.equal(a.d.getElementById('catRenameName').value,'ぽむ🐶');
 a.d.getElementById('catRenameName').value='食事';await a.d.getElementById('catRenameForm').onsubmit({preventDefault(){}});assert(a.d.getElementById('catRenameError').textContent.includes('同じ名前'));assert(a.d.getElementById('catRename').open);
 }finally{a.close();}
 }
});

test('LINE record linking creates a short-lived own code and opens a prefilled LINE chat',async()=>{
 const a=app();try{await a.w.h.startOwner();const d=a.d;assert(!d.getElementById('lineRecordBtn').classList.contains('hidden'));
 await d.getElementById('lineRecordBtn').onclick();
 const [path,code]=[...a.data].find(([k])=>k.startsWith('lineLinkCodes/'));
 assert.match(path,/^lineLinkCodes\/[A-HJ-NP-Z2-9]{10}$/);assert.equal(code.ownerUid,'A');assert.equal(code.scope,'personal');
 const left=code.expiresAt.getTime()-Date.now();assert(left>8*60000&&left<=9*60000);
 const href=d.getElementById('lineRecordOpen').href;assert(href.startsWith('https://line.me/R/oaMessage/%40626hnkgo/?'));assert(decodeURIComponent(href).endsWith('ヒビルカ連携 '+path.split('/')[1]));
 assert(!d.getElementById('lineRecordCodeBox').classList.contains('hidden'));}finally{a.close();}
 const b=app({legacy:true});try{await b.w.h.startOwner();await b.d.getElementById('lineRecordBtn').onclick();assert.equal([...b.data].find(([k])=>k.startsWith('lineLinkCodes/'))[1].scope,'legacy');}finally{b.close();}
});
