const {test,before,after}=require('node:test');
const {initializeTestEnvironment,assertSucceeds,assertFails}=require('@firebase/rules-unit-testing');
const {doc,setDoc,getDoc,getDocs,collection,query,where,updateDoc,deleteDoc,serverTimestamp}=require('firebase/firestore');
const fs=require('node:fs');let env,A,B,C;
before(async()=>{
 env=await initializeTestEnvironment({projectId:'demo-hibiruka-isolation',firestore:{rules:fs.readFileSync('/tmp/hibiruka-combined.rules','utf8')}});
 A=env.authenticatedContext('confirmed-owner').firestore();B=env.authenticatedContext('former-owner').firestore();C=env.authenticatedContext('new-user').firestore();
 await env.withSecurityRulesDisabled(async context=>{
  const db=context.firestore();
  await setDoc(doc(db,'config/legacyPrivacy'),{version:1,ownerUid:'confirmed-owner'});
  await setDoc(doc(db,'config/owners'),{uids:['confirmed-owner','former-owner']});
  await setDoc(doc(db,'config/secret'),{pinHash:'fixture-pin'});
  await setDoc(doc(db,'members/former-owner'),{pinHash:'fixture-pin'});
  for(const c of ['events','photos','pets','friends'])await setDoc(doc(db,c+'/existing'),{title:'unchanged-fixture',status:'joined'});
 });
});
after(async()=>{await env?.cleanup();});
test('confirmed owner keeps access to existing unowned records without migration',async()=>{
 for(const c of ['events','photos','pets','friends']){
  await assertSucceeds(getDoc(doc(A,c+'/existing')));
  await assertSucceeds(getDocs(collection(A,c)));
 }
 await assertSucceeds(updateDoc(doc(A,'events/existing'),{title:'owner-edit'}));
});
test('former owner, old PIN member and new account cannot read or alter records',async()=>{
 for(const db of [B,C])for(const c of ['events','photos','pets','friends']){
  await assertFails(getDoc(doc(db,c+'/existing')));
  await assertFails(getDocs(collection(db,c)));
  await assertFails(updateDoc(doc(db,c+'/existing'),{title:'forbidden'}));
  await assertFails(deleteDoc(doc(db,c+'/existing')));
 }
});
test('old PIN and owner documents cannot grant access again',async()=>{
 for(const [db,uid] of [[A,'confirmed-owner'],[B,'former-owner'],[C,'new-user']]){
  await assertFails(setDoc(doc(db,'members/'+uid),{pinHash:'fixture-pin'}));
  await assertFails(setDoc(doc(db,'config/owners'),{uids:[uid]}));
  await assertFails(setDoc(doc(db,'config/legacyPrivacy'),{ownerUid:uid,version:1}));
 }
 await assertSucceeds(getDoc(doc(A,'config/legacyPrivacy')));
 await assertFails(getDoc(doc(B,'config/legacyPrivacy')));
 await assertFails(getDoc(doc(C,'config/legacyPrivacy')));
 for(const db of [A,B,C]){
  await assertFails(getDoc(doc(db,'config/legacyPrivacyBackup')));
  await assertFails(setDoc(doc(db,'config/legacyPrivacyBackup'),{fake:true}));
 }
});
test('personal records remain scoped to their owner',async()=>{
 await assertSucceeds(setDoc(doc(C,'personalConfig/new-user'),{ownerName:'fixture'}));
 await assertSucceeds(setDoc(doc(C,'personalEvents/new-event'),{ownerUid:'new-user',createdAt:serverTimestamp(),sends:[],nextSendAt:null}));
 await assertSucceeds(getDocs(query(collection(C,'personalEvents'),where('ownerUid','==','new-user'))));
 await assertFails(getDoc(doc(A,'personalEvents/new-event')));
 await assertFails(getDoc(doc(B,'personalEvents/new-event')));
});
test('legacy LINE links require the confirmed owner even if old membership remains',async()=>{
 for(const [db,uid] of [[B,'former-owner'],[C,'new-user']])await assertFails(setDoc(doc(db,'lineLinkCodes/ABCDEFGH23'),{ownerUid:uid,scope:'legacy',createdAt:serverTimestamp(),expiresAt:new Date(Date.now()+60000)}));
 await assertSucceeds(setDoc(doc(A,'lineLinkCodes/ABCDEFGH23'),{ownerUid:'confirmed-owner',scope:'legacy',createdAt:serverTimestamp(),expiresAt:new Date(Date.now()+60000)}));
});
