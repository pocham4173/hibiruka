const {test,before,after}=require('node:test');
const {initializeTestEnvironment,assertSucceeds,assertFails}=require('@firebase/rules-unit-testing');
const {doc,setDoc,getDoc,getDocs,collection,query,where,updateDoc,serverTimestamp,deleteDoc,writeBatch}=require('firebase/firestore');
const fs=require('node:fs');let env,A,B;
before(async()=>{env=await initializeTestEnvironment({projectId:'demo-hibiruka-isolation',firestore:{rules:fs.readFileSync('/tmp/hibiruka-combined.rules','utf8')}});A=env.authenticatedContext('person-A').firestore();B=env.authenticatedContext('person-B').firestore();});
after(async()=>{await env?.cleanup();});
test('two users can create and read their own profiles; cannot access another',async()=>{
 await assertSucceeds(setDoc(doc(A,'personalConfig/person-A'),{ownerName:'A'}));
 await assertSucceeds(setDoc(doc(B,'personalConfig/person-B'),{ownerName:'B'}));
 await assertFails(getDoc(doc(B,'personalConfig/person-A')));await assertFails(updateDoc(doc(B,'personalConfig/person-A'),{ownerName:'changed'}));
});
test('events are owner scoped including list, writes, delete and ownership changes',async()=>{
 await assertSucceeds(setDoc(doc(A,'personalEvents/a'),{ownerUid:'person-A',createdAt:serverTimestamp(),date:'2099-01-01'}));
 await assertSucceeds(getDocs(query(collection(A,'personalEvents'),where('ownerUid','==','person-A'))));
 await assertFails(getDocs(collection(B,'personalEvents')));await assertFails(getDoc(doc(B,'personalEvents/a')));
 await assertFails(updateDoc(doc(B,'personalEvents/a'),{date:'2000-01-01'}));await assertFails(deleteDoc(doc(B,'personalEvents/a')));
 await assertFails(updateDoc(doc(A,'personalEvents/a'),{ownerUid:'person-B'}));
 await assertFails(setDoc(doc(B,'personalEvents/forged'),{ownerUid:'person-A',createdAt:serverTimestamp()}));
});
test('photos cannot reference or overwrite another user event or photo',async()=>{
 await assertSucceeds(setDoc(doc(A,'personalPhotos/p'),{ownerUid:'person-A',eventId:'a',data:'photo'}));
 await assertFails(getDoc(doc(B,'personalPhotos/p')));await assertFails(setDoc(doc(B,'personalPhotos/p'),{ownerUid:'person-B',eventId:'a',data:'stolen'}));
 await assertFails(setDoc(doc(B,'personalPhotos/other'),{ownerUid:'person-B',eventId:'a',data:'stolen'}));
});
test('invitation capability allows only pending acceptance, no ownership change or replay',async()=>{
 const ref=doc(A,'personalFriends/token');await assertSucceeds(setDoc(ref,{ownerUid:'person-A',name:'friend',from:'A',status:'pending',createdAt:serverTimestamp()}));
 await assertSucceeds(getDoc(doc(B,'personalFriends/token')));await assertFails(getDocs(collection(B,'personalFriends')));
 await assertFails(updateDoc(ref,{status:'joined',lineUserId:'U'+'a'.repeat(32)}));
 await assertFails(updateDoc(doc(B,'personalFriends/token'),{ownerUid:'person-B'}));
 await assertSucceeds(updateDoc(doc(B,'personalFriends/token'),{status:'joined',lineUserId:'U'+'b'.repeat(32),lineName:'B',joinedAt:serverTimestamp(),acceptedBy:'person-B'}));
 await assertFails(updateDoc(doc(B,'personalFriends/token'),{lineUserId:'U'+'c'.repeat(32)}));
 const C=env.authenticatedContext('person-C').firestore();await assertFails(getDoc(doc(C,'personalFriends/token')));
 await assertSucceeds(updateDoc(ref,{name:'renamed'}));await assertFails(deleteDoc(doc(B,'personalFriends/token')));
});
test('new users cannot enter legacy records or install a legacy membership',async()=>{
 await env.withSecurityRulesDisabled(async c=>{const d=c.firestore();await setDoc(doc(d,'config/secret'),{pinHash:'legacy-secret'});await setDoc(doc(d,'events/legacy'),{title:'private'});});
 await assertFails(getDoc(doc(A,'events/legacy')));await assertFails(setDoc(doc(A,'members/person-A'),{pinHash:'wrong'}));
});

test('one batch creates a private event with four photos and rejects partial or foreign ownership',async()=>{
 const b=writeBatch(A);
 b.set(doc(A,'personalEvents/atomic'),{ownerUid:'person-A',createdAt:serverTimestamp(),thumbs:['1','2','3','4'],kind:'memory'});
 for(let i=0;i<4;i++)b.set(doc(A,'personalPhotos/atomic_'+i),{ownerUid:'person-A',eventId:'atomic',i,data:'full-'+i});
 await assertSucceeds(b.commit());
 for(let i=0;i<4;i++)await assertSucceeds(getDoc(doc(A,'personalPhotos/atomic_'+i)));
 await assertFails(getDoc(doc(B,'personalPhotos/atomic_0')));
 const bad=writeBatch(A);
 bad.set(doc(A,'personalEvents/rejected'),{ownerUid:'person-A',createdAt:serverTimestamp()});
 bad.set(doc(A,'personalPhotos/rejected_0'),{ownerUid:'person-B',eventId:'rejected',data:'bad'});
 await assertFails(bad.commit());
 await env.withSecurityRulesDisabled(async c=>{
   const event=await getDoc(doc(c.firestore(),'personalEvents/rejected'));
   require('node:assert/strict').equal(event.exists(),false);
 });
 await assertFails(setDoc(doc(A,'personalPhotos/orphan'),{ownerUid:'person-A',eventId:'missing',data:'orphan'}));
});
test('legacy owner can atomically create an event and its four photos with existing rules',async()=>{
 await env.withSecurityRulesDisabled(async c=>{
   await setDoc(doc(c.firestore(),'config/secret'),{pinHash:'legacy-atomic-secret'});
   await setDoc(doc(c.firestore(),'members/legacy-owner'),{pinHash:'legacy-atomic-secret'});
 });
 const L=env.authenticatedContext('legacy-owner').firestore(),b=writeBatch(L);
 b.set(doc(L,'events/atomic-legacy'),{createdAt:serverTimestamp(),kind:'memory',date:'2020-01-01',thumbs:['1','2','3','4']});
 for(let i=0;i<4;i++)b.set(doc(L,'photos/atomic-legacy_'+i),{eventId:'atomic-legacy',i,data:'full-'+i});
 await assertSucceeds(b.commit());
 await assertFails(getDoc(doc(B,'photos/atomic-legacy_0')));
});
