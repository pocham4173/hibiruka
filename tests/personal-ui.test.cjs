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
 const user={uid:'A',getIdToken:async()=>'id-token-A',isAnonymous:!linked,...(linked?{email:'a@example.test'}:{}),linkWithCredential:async c=>{user.email=c.email;user.isAnonymous=false;calls.push(['link',user.uid]);}};
 const auth={currentUser:user,signInWithEmailAndPassword:async()=>{calls.push(['signin']);},setPersistence:async()=>{},signInAnonymously:async()=>{calls.push(['anonymous']);return{user};}};
 const authFn=()=>auth;authFn.Auth={Persistence:{LOCAL:'local'}};authFn.EmailAuthProvider={credential:(email,password)=>({email,password})};
 const firestore=()=>db;firestore.FieldValue={delete:()=>'__delete__',serverTimestamp:()=>1,arrayUnion:x=>[x],arrayRemove:()=>[],increment:x=>x};
 w.firebase={initializeApp:()=>{},auth:authFn,firestore};w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};w.console.error=(...args)=>errors.push(args);w.liff={init:async()=>{},isLoggedIn:()=>true,getProfile:async()=>({userId:'U'+'a'.repeat(32),displayName:'A'}),isInClient:()=>false};
 const script=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(Boolean).pop();
 w.testNavigate=url=>calls.push(['navigate',url]);
 w.eval(script.slice(0,script.indexOf('/* ---------- 入口 ---------- */')).replaceAll('location.assign(', 'globalThis.testNavigate(')+'\nconst qs=new URLSearchParams(location.search);globalThis.h={addPhotos,setShrink:fn=>shrink=fn,get draftId(){return draftRecordId},editRecord,setEvents:value=>events=value,setFriends:(value,self)=>{friends=value;selfFriendId=self;},setPhotos:value=>form.photos=value,startLogin,entryParams,startOwner,startInvite,saveRecord,createInvite,prepareSelfLine,setupAccount,recordCollection,appRef,get personal(){return personalMode}};');
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
test('Instagram button builds feed and story images and opens the share sheet with the file',async()=>{
 const a=app();try{await a.w.h.startOwner();const {w,d}=a;
  const ctx=new Proxy({},{get:(t,k)=>k==='measureText'?(s=>({width:[...s].length*40})):(k in t?t[k]:()=>{}),set:(t,k,v)=>{t[k]=v;return true;}});
  w.HTMLCanvasElement.prototype.getContext=()=>ctx;
  const sizes=[];w.HTMLCanvasElement.prototype.toBlob=function(cb){sizes.push(`${this.width}x${this.height}`);cb(new w.Blob(['x'],{type:'image/jpeg'}));};
  w.URL.createObjectURL=()=>'blob:test';w.URL.revokeObjectURL=()=>{};
  const shared=[];Object.defineProperty(w.navigator,'canShare',{value:()=>true,configurable:true});Object.defineProperty(w.navigator,'share',{value:async x=>{shared.push(x);},configurable:true});
  d.getElementById('fPlace').value='日本、〒386-0013 長野県上田市中央東1-1';
  d.getElementById('fInsta').click();
  const settle=()=>new Promise(r=>setTimeout(r,20));await settle();
  assert(!d.getElementById('instaSheet').classList.contains('hidden'));
  assert(!d.getElementById('instaShare').disabled);
  await d.getElementById('instaShare').onclick();
  assert.equal(shared.length,1);assert.equal(shared[0].files[0].type,'image/jpeg');assert.match(shared[0].files[0].name,/feed\.jpg$/);assert.equal(shared[0].text,undefined,'only the image is shared so Instagram appears');
  assert.equal(sizes.at(-1),'1080x1080');
  d.querySelector('[data-insta="story"]').click();await settle();
  await d.getElementById('instaShare').onclick();
  assert.match(shared[1].files[0].name,/story\.jpg$/);assert.equal(sizes.at(-1),'1080x1920');
  assert(d.getElementById('instaTextBox').classList.contains('hidden'));
  d.querySelector('[data-insta="x"]').click();await settle();
  assert(!d.getElementById('instaTextBox').classList.contains('hidden'));assert.match(d.getElementById('instaShare').textContent,/X/);
  assert.equal(d.getElementById('instaText').value,'📍長野県上田市中央東1-1\n'+(()=>{const t=new Date();return `${t.getMonth()+1}/${t.getDate()}`})()+d.getElementById('instaText').value.split('\n')[1].replace(/^\d+\/\d+/,'')+'\n#ヒビルカ');
  d.getElementById('instaText').value='今日のヨガ #ヒビルカ';
  await d.getElementById('instaShare').onclick();
  assert.equal(shared[2].text,'今日のヨガ #ヒビルカ');assert.match(shared[2].files[0].name,/x\.jpg$/);
  d.getElementById('instaClose').click();assert(d.getElementById('instaSheet').classList.contains('hidden'));
 }finally{a.close();}
});

// Minimal JPEG with EXIF date and GPS (little-endian TIFF) for the photo-place test.
function exifJpeg({date='2026:09:20 12:34:56',lat=[36,24,5.4],lng=[138,15,0]}={}){
 const b=[];const u16=v=>b.push(v&255,v>>8&255),u32=v=>{u16(v&65535);u16(v>>>16);};
 const tiff=[];const T={u16:v=>tiff.push(v&255,v>>8&255),u32:v=>{T.u16(v&65535);T.u16(v>>>16);}};
 // header
 tiff.push(0x49,0x49);T.u16(42);T.u32(8);
 // IFD0 @8: 2 entries -> 2+24+4=30 bytes -> next at 38
 T.u16(2);T.u16(0x8769);T.u16(4);T.u32(1);T.u32(38);T.u16(0x8825);T.u16(4);T.u32(1);T.u32(56);T.u32(0);
 // Exif IFD @38: 1 entry -> 18 bytes -> data at 56? need ascii at 56+? put ascii after GPS
 T.u16(1);T.u16(0x9003);T.u16(2);T.u32(20);T.u32(200);T.u32(0);
 // GPS IFD @56: 4 entries -> 2+48+4=54 -> rationals at 110
 T.u16(4);T.u16(1);T.u16(2);T.u32(2);tiff.push(78,0,0,0);T.u16(2);T.u16(5);T.u32(3);T.u32(110);T.u16(3);T.u16(2);T.u32(2);tiff.push(69,0,0,0);T.u16(4);T.u16(5);T.u32(3);T.u32(134);T.u32(0);
 const rat=a=>a.forEach(x=>{T.u32(Math.round(x*100));T.u32(100);});rat(lat);rat(lng);
 while(tiff.length<200)tiff.push(0);for(const ch of date)tiff.push(ch.charCodeAt(0));tiff.push(0);
 const app1=[0x45,0x78,0x69,0x66,0,0,...tiff];
 return new Uint8Array([0xFF,0xD8,0xFF,0xE1,(app1.length+2)>>8,(app1.length+2)&255,...app1,0xFF,0xD9]);
}
test('a photo with location fills the date and place, and the coordinates are saved',async()=>{
 const a=app();try{const {w,d}=a;await w.h.startOwner();
  const urls=[];w.fetch=async url=>{urls.push(url);return{ok:true,json:async()=>({name:'ソラノカフェ',category:'amenity',display_name:'ソラノカフェ, 中央, 上田市, 長野県, 386-0012, 日本'})};};
  w.h.setShrink(async()=>'img');
  d.querySelector('#catPills [data-cat]').click();
  const bytes=exifJpeg();const file=new w.Blob([bytes],{type:'image/jpeg'});
  await w.h.addPhotos({target:{files:[file],value:'x'}});
  for(let i=0;i<5;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(d.getElementById('fDate').value,'2026-09-20');assert.equal(d.getElementById('fTime').value,'12:34');assert.equal(d.getElementById('fKind').value,'memory');
  assert.equal(d.getElementById('fPlace').value,'ソラノカフェ');assert.match(urls[0],/lat=36\.401500&?|lat=36\.4015&/);
  assert.match(d.getElementById('fMapLink').href,/query=36\.4015,138\.25/);
  await w.h.saveRecord();
  const [,e]=[...a.data].find(([k])=>k.startsWith('personalEvents/'));assert.equal(e.lat,36.4015);assert.equal(e.lng,138.25);
 }finally{a.close();}
 // Editing the place by hand drops the photo coordinates; a typed date is never overwritten.
 const b=app();try{const {w,d}=b;await w.h.startOwner();w.fetch=async()=>({ok:true,json:async()=>({name:'X',category:'shop',display_name:'X, 日本'})});w.h.setShrink(async()=>'img');
  d.querySelector('#catPills [data-cat]').click();d.getElementById('fDate').value='2026-01-02';d.getElementById('fDate').oninput();
  await w.h.addPhotos({target:{files:[new w.Blob([exifJpeg()])],value:'x'}});for(let i=0;i<5;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(d.getElementById('fDate').value,'2026-01-02');assert.equal(d.getElementById('fPlace').value,'X');
  d.getElementById('fPlace').value='自分で書いた場所';d.getElementById('fPlace').oninput();
  await w.h.saveRecord();const [,e]=[...b.data].find(([k])=>k.startsWith('personalEvents/'));assert.equal(e.lat,undefined);assert.equal(e.place,'自分で書いた場所');
 }finally{b.close();}
});

test('place names fall back from a shop name to city and town, never just the prefecture',async()=>{
 const a=app();try{const P=a.w.eval('placeFromReverse');
  assert.equal(P({name:'ルシメリ',category:'amenity',display_name:'ルシメリ, 1, 桜木町, 大宮区, さいたま市, 埼玉県, 330-0854, 日本'}),'ルシメリ');
  assert.equal(P({name:'',category:'building',display_name:'1-2, 桜木町, 大宮区, さいたま市, 埼玉県, 330-0854, 日本'}),'さいたま市大宮区桜木町');
  assert.equal(P({name:'国道18号',category:'highway',display_name:'国道18号, 中央東, 上田市, 長野県, 386-0013, 日本'}),'上田市中央東');
  assert.equal(P({category:'place',display_name:'小川町, 比企郡, 埼玉県, 日本'}),'小川町');
  assert.equal(P({category:'boundary',display_name:'埼玉県, 日本'}),'埼玉県');
 }finally{a.close();}
});

test('AI writer sends the record with the sign-in token and lets the user insert or undo the text',async()=>{
 const a=app();try{const {w,d}=a;await w.h.startOwner();
  const sent=[];let reply={status:200,body:{text:'久しぶりのヨガで、肩が軽くなった一日。',left:9}};
  w.fetch=async(url,opt)=>{sent.push([url,opt]);return{ok:reply.status===200,status:reply.status,json:async()=>reply.body};};
  d.getElementById('aiWrite').click();await new Promise(r=>setTimeout(r,5));
  assert.equal(sent.length,0,'nothing to write about yet');
  d.querySelector('#catPills [data-cat]').click();d.getElementById('fTitle').value='ベーシックヨガ';d.getElementById('fMemo').value='体がかたかった';
  d.getElementById('aiWrite').click();assert.equal(d.getElementById('aiWrite').disabled,true);await new Promise(r=>setTimeout(r,5));
  assert.equal(sent[0][0],'https://hibiruka-line.okm-co.workers.dev/ai/memory-text');assert.equal(sent[0][1].headers.Authorization,'Bearer id-token-A');
  const body=JSON.parse(sent[0][1].body);assert.equal(body.title,'ベーシックヨガ');assert.equal(body.memo,'体がかたかった');assert.match(body.date,/^\d{4}-\d{2}-\d{2}$/);
  assert(!d.getElementById('aiBox').classList.contains('hidden'));assert.match(d.getElementById('aiNote').textContent,/あと9回/);
  assert.equal(d.getElementById('aiWrite').disabled,false);
  d.getElementById('aiUse').click();assert.equal(d.getElementById('fMemo').value,'久しぶりのヨガで、肩が軽くなった一日。');
  d.getElementById('aiUndo').click();assert.equal(d.getElementById('fMemo').value,'体がかたかった');assert(d.getElementById('aiBox').classList.contains('hidden'));
  reply={status:429,body:{error:'limit',left:0}};d.getElementById('aiWrite').click();await new Promise(r=>setTimeout(r,5));
  assert(d.getElementById('aiBox').classList.contains('hidden'));assert.match(d.getElementById('toast').textContent,/1日20回/);
 }finally{a.close();}
});

test('AI extras: style chips, title ideas, SNS caption in the share sheet and a month look-back',async()=>{
 const a=app();try{const {w,d}=a;await w.h.startOwner();
  const sent=[];w.fetch=async(url,opt)=>{const b=JSON.parse(opt.body);sent.push(b);
   const body=b.mode==='title'?{titles:['久しぶりのヨガ','体ほぐしの夕方','かたい体と再会した日'],left:18}:b.mode==='month'?{text:'ヨガに通った月。',left:17}:{text:'['+b.mode+'] の文章',left:19};
   return{ok:true,status:200,json:async()=>body};};
  const settle=()=>new Promise(r=>setTimeout(r,10));
  d.querySelector('#catPills [data-cat]').click();d.getElementById('fPlace').value='LOIVE 上田店';d.getElementById('fMemo').value='体がかたかった';
  d.getElementById('aiTitle').click();await settle();
  assert.equal(sent.at(-1).mode,'title');const chips=d.querySelectorAll('#aiTitles [data-title]');assert.equal(chips.length,3);
  chips[1].click();assert.equal(d.getElementById('fTitle').value,'体ほぐしの夕方');assert(d.getElementById('aiTitles').classList.contains('hidden'));
  d.getElementById('aiWrite').click();await settle();assert.equal(sent.at(-1).mode,'diary');assert.equal(d.getElementById('aiText').textContent,'[diary] の文章');
  d.querySelector('[data-ai-mode="short"]').click();await settle();assert.equal(sent.at(-1).mode,'short');
  assert.equal(d.querySelector('[data-ai-mode="short"]').getAttribute('aria-pressed'),'true');
  d.getElementById('aiAgain').click();await settle();assert.equal(sent.at(-1).mode,'short','again keeps the chosen style');
  d.querySelector('[data-ai-mode="sns"]').click();await settle();assert.equal(d.getElementById('aiText').textContent,'[sns] の文章');
  // share sheet caption (canvas stubbed)
  w.HTMLCanvasElement.prototype.getContext=()=>new Proxy({},{get:(t,k)=>k==='measureText'?(s=>({width:[...s].length*40})):(k in t?t[k]:()=>{}),set:(t,k,v)=>{t[k]=v;return true;}});
  w.HTMLCanvasElement.prototype.toBlob=function(cb){cb(new w.Blob(['x'],{type:'image/jpeg'}));};w.URL.createObjectURL=()=>'blob:x';w.URL.revokeObjectURL=()=>{};
  d.getElementById('fInsta').click();await settle();d.querySelector('[data-insta="x"]').click();await settle();
  d.getElementById('instaAi').click();await settle();
  assert.equal(sent.at(-1).mode,'sns');assert.equal(sent.at(-1).memo,'体がかたかった');assert.equal(d.getElementById('instaText').value,'[sns] の文章');
  d.getElementById('instaClose').click();
  // month look-back uses only past memories of that month
  const t=new Date(),ym=`${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}`;
  w.h.setEvents([{id:'1',date:ym+'-01',title:'ヨガ',cat:'遊び',kind:'memory',fav:true},{id:'2',date:'1999-01-01',title:'昔',kind:'memory'}]);
  d.getElementById('monthThis').click();await settle();
  const m=sent.at(-1);assert.equal(m.mode,'month');assert.equal(m.records.length,1);assert.equal(m.records[0].fav,true);assert.match(m.month,/^\d{4}年\d{1,2}月$/);
  assert.equal(d.getElementById('monthText').textContent,'ヨガに通った月。');
  w.h.setEvents([]);d.getElementById('monthLast').click();await settle();assert.equal(sent.at(-1),m,'no request when the month is empty');
 }finally{a.close();}
});

test('find spots: nearby category search, save to the wish list, plan it, and wishes stay out of the calendar and album',async()=>{
 const a=app();try{const {w,d,data}=a;await w.h.startOwner();
  Object.defineProperty(w.navigator,'geolocation',{value:{getCurrentPosition:(ok)=>ok({coords:{latitude:36.40,longitude:138.25}})},configurable:true});
  const urls=[];w.fetch=async(url,opt)=>{urls.push([url,opt?.body||'']);
   if(url.includes('overpass'))return{ok:true,json:async()=>({elements:[
     {type:'node',id:1,lat:36.401,lon:138.251,tags:{name:'ソラノカフェ',amenity:'cafe','addr:city':'上田市',opening_hours:'Mo-Su 10:00-18:00'}},
     {type:'way',id:2,center:{lat:36.43,lon:138.27},tags:{name:'遠いカフェ',amenity:'cafe'}},
     {type:'node',id:3,lat:36.4,lon:138.25,tags:{amenity:'cafe'}},
     ...Array.from({length:5},(_,i)=>({type:'node',id:10+i,lat:36.41+i/100,lon:138.25,tags:{name:'カフェ'+i,amenity:'cafe'}}))]})};
   if(url.includes('nominatim'))return{ok:true,json:async()=>[{osm_type:'node',osm_id:9,lat:'36.39',lon:'138.24',name:'上田城跡公園',type:'park',category:'leisure',address:{city:'上田市',suburb:'二の丸'}}]};
   return{ok:false,status:404,json:async()=>({})};};
  const settle=()=>new Promise(r=>setTimeout(r,15));
  d.querySelector('.maintabs [data-tab="find"]').click();assert(!d.getElementById('tab-find').classList.contains('hidden'));
  d.querySelector('[data-find="cafe"]').click();await settle();await settle();
  const ov=urls.find(([u])=>u.includes('overpass'));assert(urls.some(([u,b])=>u.includes('overpass')&&/around:2500,36\.4000,138\.2500/.test(decodeURIComponent(b))));assert(urls.some(([u,b])=>u.includes('overpass')&&/nwr\["amenity"="cafe"\]\(around:10000,36\.4000,138\.2500\)/.test(decodeURIComponent(b))));
  const cards=d.querySelectorAll('#findResults .spot');assert.equal(cards.length,7,'unnamed places are skipped');
  assert.match(cards[0].textContent,/ソラノカフェ/);assert.match(cards[0].textContent,/カフェ/);assert.match(cards[0].textContent,/上田市/);
  // save a wish
  cards[0].querySelector('[data-wish]').click();await settle();
  const [wid,wish]=[...data].find(([k,v])=>k.startsWith('personalEvents/')&&v.kind==='wish');
  assert.equal(wish.ownerUid,'A');assert.equal(wish.status,'wished');assert.equal(wish.placeId,'osm:node/1');assert.equal(wish.place,'ソラノカフェ');assert.equal(wish.cat,'カフェ');assert.equal(wish.lat,36.401);
  // wishes are listed separately and never appear among records
  db_snapshot:{const docs=[...data].filter(([k])=>k.startsWith('personalEvents/')).map(([k,v])=>({id:k.split('/')[1],data:()=>v}));a.db.recordsCallback({docs,metadata:{fromCache:false}});}
  assert.match(d.getElementById('wishList').textContent,/行きたい.*ソラノカフェ/s);assert.equal(d.getElementById('wishCount').textContent,'1件');
  w.eval('selectView("mem");renderList()');assert.doesNotMatch(d.getElementById('listBox').textContent,/ソラノカフェ/);
  // plan from the wish list
  d.querySelector('#wishList [data-wplan]').click();
  assert(!d.getElementById('tab-rec').classList.contains('hidden'));assert.equal(d.getElementById('fPlace').value,'ソラノカフェ');assert.equal(d.getElementById('fKind').value,'plan');
  const t=new Date();t.setDate(t.getDate()+3);d.getElementById('fDate').value=`${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
  await w.h.saveRecord();await settle();
  const plan=[...data].find(([k,v])=>k.startsWith('personalEvents/')&&v.kind==='plan');assert(plan);assert.equal(plan[1].lat,36.401);
  const after=data.get(wid);assert.equal(after.status,'scheduled');assert.equal(after.planId,plan[0].split('/')[1]);
  // free words with a place name search around that place
  d.querySelector('.maintabs [data-tab="find"]').click();d.getElementById('findQ').value='上田城 ラーメン';d.getElementById('findForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();await settle();
  assert(urls.some(([u])=>u.includes('nominatim')&&decodeURIComponent(u).includes('q=上田城')),'place part is looked up');
  assert.match(decodeURIComponent(urls.filter(([u])=>u.includes('overpass')).at(-1)[1]),/cuisine"~"ramen\|noodle/);
 }finally{a.close();}
});

test('find spots: food searches use Hotpepper (photo, budget, credit) and fall back to the map when it is not set up',async()=>{
 const a=app();try{const {w,d,data}=a;await w.h.startOwner();
  Object.defineProperty(w.navigator,'geolocation',{value:{getCurrentPosition:(ok)=>ok({coords:{latitude:36.40,longitude:138.25}})},configurable:true});
  const sent=[];let hp=true;
  w.fetch=async(url,opt)=>{
   if(url.includes('/spots/search')){sent.push(JSON.parse(opt.body));assert.equal(opt.headers.Authorization,'Bearer id-token-A');
    if(!hp)return{ok:false,status:503,json:async()=>({error:'not_configured'})};
    return{ok:true,status:200,json:async()=>({shops:[{id:'hp:J1',name:'ソラノカフェ',genre:'カフェ・スイーツ',catch:'手作りケーキ',budget:'～1000円',address:'上田市中央',access:'上田駅から徒歩5分',hours:'10:00～18:00',lat:36.401,lng:138.251,url:'https://www.hotpepper.jp/strJ1/',photo:'https://imgfp.hotp.jp/a.jpg'}]})};}
   if(url.includes('overpass'))return{ok:true,json:async()=>({elements:[{type:'node',id:1,lat:36.401,lon:138.251,tags:{name:'地図のカフェ',amenity:'cafe'}}]})};
   return{ok:true,json:async()=>[]};};
  const settle=()=>new Promise(r=>setTimeout(r,20));
  d.querySelector('.maintabs [data-tab="find"]').click();
  d.querySelector('[data-find="cafe"]').click();await settle();await settle();
  assert.deepEqual(sent[0],{kind:'cafe',lat:36.4,lng:138.25,range:5});
  const card=d.querySelector('#findResults .spot');assert(card.classList.contains('has-photo'));assert.match(card.textContent,/ソラノカフェ.*～1000円.*手作りケーキ.*徒歩5分/s);
  assert.match(d.getElementById('findResults').textContent,/Powered by ホットペッパーグルメ Webサービス/);
  assert.match(card.querySelector('a[href^="https://www.hotpepper.jp"]').textContent,/ホットペッパーで見る/);
  card.querySelector('[data-wish]').click();await settle();
  const wish=[...data.values()].find(v=>v.kind==='wish');assert.equal(wish.imageUrl,'https://imgfp.hotp.jp/a.jpg');assert.equal(wish.placeId,'hp:J1');
  // area + genre goes to Hotpepper as a keyword search
  d.getElementById('findQ').value='上田駅 ランチ';d.getElementById('findForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();await settle();
  assert.deepEqual(sent.at(-1),{kind:'lunch',keyword:'上田駅'});
  // when the key is not set up, the map is used and Hotpepper is not asked again
  hp=false;d.querySelector('[data-find="ramen"]').click();await settle();await settle();
  assert.match(d.getElementById('findResults').textContent,/地図のカフェ/);const n=sent.length;
  d.querySelector('[data-find="cafe"]').click();await settle();await settle();assert.equal(sent.length,n);
 }finally{a.close();}
});
test('find spots: Nagano parks and hot springs come from the weekly data; dog runs and dog-friendly shops are separate',async()=>{
 const a=app();try{const {w,d}=a;await w.h.startOwner();
  Object.defineProperty(w.navigator,'geolocation',{value:{getCurrentPosition:(ok)=>ok({coords:{latitude:36.40,longitude:138.25}})},configurable:true});
  const calls=[];
  w.fetch=async(url,opt)=>{calls.push(String(url));
   if(String(url).includes('spots-nagano'))return{ok:true,json:async()=>({rows:[
     ['o','n1','別所温泉 大湯',36.361,138.182,'温泉・銭湯','上田市','06:00-22:00',''],
     ['o','n2','遠くの温泉',35.5,137.9,'温泉','','',''],
     ['p','w3','上田城跡公園',36.402,138.244,'公園','上田市','',''],
     ['d','n4','ドッグラン',36.41,138.26,'ドッグラン','','','']]})};
   if(String(url).includes('/spots/search')){const b=JSON.parse(opt.body);return{ok:true,status:200,json:async()=>({shops:b.kind==='dog'?[{id:'hp:P1',name:'わんこカフェ',genre:'カフェ',lat:36.401,lng:138.251,url:'https://www.hotpepper.jp/strP1/',photo:''}]:[]})};}
   if(String(url).includes('overpass'))throw new Error('should not be needed');
   return{ok:true,json:async()=>[]};};
  const settle=()=>new Promise(r=>setTimeout(r,20));
  d.querySelector('.maintabs [data-tab="find"]').click();
  d.querySelector('[data-find="onsen"]').click();await settle();await settle();
  let names=[...d.querySelectorAll('#findResults .spot h3')].map(x=>x.textContent);
  assert.deepEqual(names,['別所温泉 大湯'],'only hot springs within 40km');
  assert(!calls.some(u=>u.includes('overpass')));
  d.querySelector('[data-find="dog"]').click();await settle();await settle();
  names=[...d.querySelectorAll('#findResults .spot h3')].map(x=>x.textContent);
  assert.deepEqual(names,['ドッグラン'],'ドッグラン only shows dog runs');
  d.querySelector('[data-find="dogfood"]').click();await settle();await settle();
  names=[...d.querySelectorAll('#findResults .spot h3')].map(x=>x.textContent);
  assert.deepEqual(names,['わんこカフェ'],'わんこと入れるお店 asks Hotpepper for pet-friendly shops');
  assert.match(d.getElementById('findResults').textContent,/Powered by ホットペッパー/);
 }finally{a.close();}
});
test('find spots: the range switch searches 1km, 3km or the whole city and repeats the last search',async()=>{
 const a=app();try{const {w,d}=a;await w.h.startOwner();
  Object.defineProperty(w.navigator,'geolocation',{value:{getCurrentPosition:(ok)=>ok({coords:{latitude:36.40,longitude:138.25}})},configurable:true});
  const sent=[];
  w.fetch=async(url,opt)=>{url=String(url);
   if(url.includes('/spots/search')){sent.push(JSON.parse(opt.body));return{ok:true,status:200,json:async()=>({shops:[{id:'hp:1',name:'焼肉 はなこ',genre:'焼肉',lat:36.45,lng:138.3,url:'',photo:''}]})};}
   if(url.includes('nominatim')&&url.includes('reverse'))return{ok:true,json:async()=>({address:{city:'上田市'}})};
   return{ok:true,json:async()=>[]};};
  const settle=()=>new Promise(r=>setTimeout(r,20));
  d.querySelector('.maintabs [data-tab="find"]').click();
  d.querySelector('[data-find="yakiniku"]').click();await settle();await settle();
  assert.deepEqual(sent.at(-1),{kind:'yakiniku',lat:36.4,lng:138.25,range:5});
  d.querySelector('[data-range="3"]').click();await settle();await settle();
  assert.deepEqual(sent.at(-1),{kind:'yakiniku',lat:36.4,lng:138.25,range:3});
  d.querySelector('[data-range="city"]').click();await settle();await settle();
  assert.deepEqual(sent.at(-1),{kind:'yakiniku',keyword:'上田市',count:100});
  assert.match(d.getElementById('findNote').textContent,/^上田市で1件見つかりました（近い順）/);
  assert(d.querySelector('[data-range="city"]').classList.contains('on-range'));
 }finally{a.close();}
});
test('find extras: conditions and budget go to Hotpepper, my own records match first, weather suggests places',async()=>{
 const a=app();try{const {w,d}=a;await w.h.startOwner();
  Object.defineProperty(w.navigator,'geolocation',{value:{getCurrentPosition:(ok)=>ok({coords:{latitude:36.40,longitude:138.25}})},configurable:true});
  const sent=[];let weather={daily:{weather_code:[63],temperature_2m_max:[18.4],precipitation_probability_max:[80]}};
  w.fetch=async(url,opt)=>{url=String(url);
   if(url.includes('open-meteo'))return{ok:true,json:async()=>weather};
   if(url.includes('/spots/search')){sent.push(JSON.parse(opt.body));return{ok:true,status:200,json:async()=>({shops:[{id:'hp:1',name:'中華 はなこ',genre:'中華',lat:36.401,lng:138.251,url:'',photo:''}]})};}
   if(url.includes('spots-nagano'))return{ok:true,json:async()=>({rows:[['p','n1','上田市立博物館',36.401,138.244,'博物館・美術館','','',''],['p','n2','常田公園',36.402,138.25,'公園','','',''],['o','n3','千古温泉',36.42,138.2,'温泉','','','']]})};
   return{ok:true,json:async()=>[]};};
  const settle=()=>new Promise(r=>setTimeout(r,25));
  w.h.setEvents([{id:'m1',kind:'memory',date:'2026-09-01',title:'ラーメン',place:'中華 はなこ',memo:'餃子がおいしい',cat:'食事'}]);
  d.querySelector('.maintabs [data-tab="find"]').click();await settle();
  // weather: rainy day suggests indoor places
  const wb=d.getElementById('findWeather');assert(!wb.classList.contains('hidden'));assert.match(wb.textContent,/上田駅あたりの今日の天気.*雨.*最高18℃.*雨80%/s);assert(wb.querySelector('#wxHere'),'offers to use the current location');assert(wb.classList.contains('rain'));
  wb.querySelector('[data-wfind="indoor"]').click();await settle();await settle();
  assert.deepEqual([...d.querySelectorAll('#findResults .spot h3')].map(x=>x.textContent),['上田市立博物館'],'indoor = museums only');
  // conditions and budget
  d.querySelector('[data-filter="parking"]').click();d.querySelector('[data-filter="private_room"]').click();d.querySelector('[data-budget="B011,B001"]').click();
  d.getElementById('findQ').value='餃子';d.getElementById('findForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();await settle();
  const b=sent.at(-1);assert.deepEqual(b.filters,['parking','private_room']);assert.deepEqual(b.budget,['B011','B001']);
  // my own record appears first, and opens the detail
  const mine=d.querySelector('#findResults .mine');assert(mine);assert.match(mine.textContent,/自分の記録から（1件）.*ラーメン/s);
  mine.querySelector('[data-mine]').click();assert(!d.getElementById('detailSheet').classList.contains('hidden'));
  // budget toggles off
  d.querySelector('[data-budget="B011,B001"]').click();assert(!d.querySelector('[data-budget="B011,B001"]').classList.contains('on-opt'));
  for(let i=0;i<6;i++)await settle();
 }finally{a.close();}
});

test('道の駅 come from the nationwide list; spot cards and plan details show the weather where you are going',async()=>{
 const a=app();try{const {w,d}=a;await w.h.startOwner();
  Object.defineProperty(w.navigator,'geolocation',{value:{getCurrentPosition:(ok)=>ok({coords:{latitude:36.40,longitude:138.25}})},configurable:true});
  const wx=[];
  w.fetch=async(url)=>{url=String(url);
   if(url.includes('michinoeki'))return{ok:true,json:async()=>({rows:[['n1','道の駅 雷電くるみの里',36.36,138.36,'東御市','',''],['n2','道の駅 遠すぎ',43.0,141.3,'札幌市','','']]})};
   if(url.includes('open-meteo')){wx.push(url);const n=new URL(url).searchParams.get('latitude').split(',').length;const one={daily:{weather_code:[0],temperature_2m_max:[24.2],temperature_2m_min:[11],precipitation_probability_max:[0]}};return{ok:true,json:async()=>n>1?Array(n).fill(one):one};}
   return{ok:true,json:async()=>[]};};
  const settle=()=>new Promise(r=>setTimeout(r,25));
  d.querySelector('.maintabs [data-tab="find"]').click();await settle();
  d.querySelector('[data-find="michi"]').click();for(let i=0;i<4;i++)await settle();
  const cards=[...d.querySelectorAll('#findResults .spot')];assert.equal(cards.length,1);assert.match(cards[0].textContent,/道の駅 雷電くるみの里/);
  assert.match(cards[0].querySelector('.wx').textContent,/今日 ☀️ 晴れ 24℃ 雨0%/);
  // the weather card now says it is for the current location
  assert.match(d.getElementById('findWeather').textContent,/現在地の今日の天気/);
  // plan detail: forecast for that place and day
  const t=new Date();t.setDate(t.getDate()+3);const day=`${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
  w.h.setEvents([{id:'p1',kind:'plan',date:day,title:'ドライブ',place:'道の駅 雷電くるみの里',lat:36.36,lng:138.36,cat:'旅行'}]);
  w.eval('openDetail("p1")');await settle();
  assert(wx.some(u=>u.includes('start_date='+day)));
  assert.match(d.getElementById('dWeather').textContent,/道の駅 雷電くるみの里の天気予報：☀️ 晴れ 24℃ 雨0%（最低11℃）/);
 }finally{a.close();}
});
test('search place: here by default, or a named place that moves the search, weather and distances',async()=>{
 const a=app();try{const {w,d}=a;await w.h.startOwner();
  let geo=0;Object.defineProperty(w.navigator,'geolocation',{value:{getCurrentPosition:(ok)=>{geo++;ok({coords:{latitude:36.40,longitude:138.25}});}},configurable:true});
  const sent=[],wx=[];
  w.fetch=async(url,opt)=>{url=String(url);
   if(url.includes('nominatim')&&url.includes('search'))return{ok:true,json:async()=>[{lat:'36.3428',lon:'138.6353',name:'軽井沢駅'}]};
   if(url.includes('open-meteo')){wx.push(url);return{ok:true,json:async()=>({daily:{weather_code:[3],temperature_2m_max:[17],precipitation_probability_max:[20]}})};}
   if(url.includes('/spots/search')){sent.push(JSON.parse(opt.body));return{ok:true,status:200,json:async()=>({shops:[{id:'hp:1',name:'森のカフェ',genre:'カフェ',lat:36.345,lng:138.636,url:'',photo:''}]})};}
   return{ok:true,json:async()=>[]};};
  const settle=()=>new Promise(r=>setTimeout(r,25));
  d.querySelector('.maintabs [data-tab="find"]').click();await settle();
  d.getElementById('wherePick').click();assert(!d.getElementById('findPlaceForm').classList.contains('hidden'));
  d.getElementById('findPlaceQ').value='軽井沢駅';d.getElementById('findPlaceForm').dispatchEvent(new w.Event('submit',{cancelable:true}));for(let i=0;i<3;i++)await settle();
  assert.equal(d.getElementById('wherePick').textContent,'🗺 軽井沢駅');assert(d.getElementById('wherePick').classList.contains('on-where'));
  assert.match(d.getElementById('findWeather').textContent,/軽井沢駅あたりの今日の天気/);assert.match(wx.at(-1),/latitude=36\.343/);
  d.querySelector('[data-find="cafe"]').click();for(let i=0;i<3;i++)await settle();
  assert.deepEqual(sent.at(-1),{kind:'cafe',lat:36.3428,lng:138.6353,range:5});assert.equal(geo,0,'no location needed for a named place');
  assert.match(d.getElementById('findNote').textContent,/^軽井沢駅のまわりで1件/);assert.match(d.querySelector('#findResults .spot').textContent,/📍(2\d0|3\d0)m/);
  // back to here: re-runs the last search around the current location
  d.querySelector('[data-where="here"]').click();for(let i=0;i<4;i++)await settle();
  assert.deepEqual(sent.at(-1),{kind:'cafe',lat:36.4,lng:138.25,range:5});assert.equal(geo,1);
 }finally{a.close();}
});

test('plan sending: an optional ひとこと is counted, saved with the reservation and shown in the plan',async()=>{
 const a=app();try{await a.w.h.startOwner();const d=a.d,id='personalEvents/p1',plan={id:'p1',date:'2099-10-06',time:'09:00',title:'遊び',place:'信州医療センター'};
 a.data.set(id,{...plan});a.w.h.setEvents([plan]);
 a.w.h.setFriends([{id:'self',status:'joined',lineUserId:'U1'},{id:'f2',name:'純子さん',status:'joined',lineUserId:'U2'}],'self');
 a.w.openSend('p1');assert.equal(d.getElementById('sNote').value,'');assert.equal(d.getElementById('sNote').maxLength,100);
 d.querySelector('#sWho [data-id="f2"]').click();
 d.getElementById('sNote').value='  楽しみにしてるね！ ';d.getElementById('sNote').oninput();assert.equal(d.getElementById('sNoteCount').textContent,'12/100');
 await a.w.addSend(true);const sent=a.data.get(id).sends[0];
 assert.equal(sent.note,'楽しみにしてるね！');assert.equal(sent.friendIds.join(),'f2');
 assert.match(a.w.sendRows({id:'p1',sends:[sent]}),/💬 楽しみにしてるね！/);
 a.w.openSend('p1');assert.equal(d.getElementById('sNote').value,'','a new send starts empty');
 d.querySelector('#sWho [data-id="self"]').click();await a.w.addSend(true);assert.equal('note' in a.data.get(id).sends[1],false);
 }finally{a.close();}
});
