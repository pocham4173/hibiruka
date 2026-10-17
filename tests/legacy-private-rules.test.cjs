'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {privateRules}=require('../scripts/legacy-private-rules.cjs');
const base=`rules_version = '2';service cloud.firestore {match /databases/{database}/documents {
function isOwner() { return request.auth != null && exists(/databases/$(database)/documents/members/$(request.auth.uid)); }
match /members/{uid} {allow read,write:if request.auth!=null;}
match /config/owners {allow read,write:if isOwner();}
match /events/{id} {allow read,write:if isOwner();}
match /personalEvents/{id} {allow read:if request.auth.uid == resource.data.ownerUid;}
}}`;
test('private policy removes membership and owner self-escalation while preserving record policies',()=>{
 const s=privateRules(base);
 assert.match(s,/legacyPrivacy\)\.data.ownerUid == request.auth.uid/);
 assert.doesNotMatch(s,/allow read,write:if request.auth!=null/);
 assert.match(s,/match \/members\/\{uid\} \{ allow get:/);
 assert.ok(s.includes('match /events/{id} {allow read,write:if isOwner();}'));
 assert.ok(s.includes('match /personalEvents/{id} {allow read:if request.auth.uid == resource.data.ownerUid;}'));
 assert.throws(()=>privateRules(s),/already exists/);
});
test('overlaps, duplicates and missing policies are rejected',()=>{
 for(const fragment of ['match /{doc=**} {allow read:if true;}','match /config/{key} {allow read:if true;}',
 'match /{collection}/{doc} {allow read:if true;}','match /members/{x} {allow write:if true;}']){
  assert.throws(()=>privateRules(base.replace(/}}$/,fragment+'}}')));
 }
 assert.throws(()=>privateRules(base.replace('function isOwner()','function other()')));
 assert.throws(()=>privateRules(base.replace('match /config/owners','match /config/other')));
});
test('quoted braces and comments cannot terminate a replacement block',()=>{
 const s=base.replace('return request.auth',"// } misleading brace\n let marker = '}'; return request.auth");
 assert.ok(privateRules(s).includes('match /events/{id} {allow read,write:if isOwner();}'));
});
