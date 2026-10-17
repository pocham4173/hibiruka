'use strict';
// Rewrite the existing rules without replacing unrelated collections.
// Unexpected overlapping paths stop preparation instead of widening access.
function mask(source) {
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g,
    s=>s.replace(/[^\n]/g,' '));
}
function endOfBlock(s,start) {
  let depth=0;
  for(let i=start;i<s.length;i++){
    if(s[i]==='{')depth++;
    if(s[i]==='}'&&--depth===0)return i+1;
  }
  throw Error('Unbalanced rules');
}
function privateRules(source) {
  if(typeof source!=='string')throw Error('Missing rules');
  const text=mask(source), changes=[];
  const owners=[...text.matchAll(/function\s+isOwner\s*\(\s*\)\s*\{/g)];
  if(owners.length!==1)throw Error('Unexpected owner policy');
  const fn=owners[0];
  changes.push([fn.index,endOfBlock(text,fn.index+fn[0].lastIndexOf('{')),`function isOwner() {
      return request.auth != null
        && exists(/databases/$(database)/documents/config/legacyPrivacy)
        && get(/databases/$(database)/documents/config/legacyPrivacy).data.version == 1
        && get(/databases/$(database)/documents/config/legacyPrivacy).data.ownerUid == request.auth.uid;
    }`]);
  const matches=[...text.matchAll(/match\s+(\S+)\s*\{/g)];
  let memberCount=0,ownerCount=0;
  for(const m of matches){
    const path=m[1];
    if(path==='/databases/{database}/documents')continue;
    if(path.includes('**')||/^\/\{/.test(path)||/^\/config\/\{/.test(path))throw Error('Overlapping rules require review');
    if(path==='/config/legacyPrivacy')throw Error('Privacy policy already exists');
    let replacement;
    if(/^\/members\/\{\w+\}$/.test(path)){
      memberCount++;
      const uid=path.match(/\{(\w+)\}/)[1];
      replacement=`match ${path} { allow get: if request.auth != null && request.auth.uid == ${uid}; }`;
    }else if(path==='/config/owners'){
      ownerCount++;
      replacement=`match /config/owners { allow get: if request.auth != null; }
    match /config/legacyPrivacy { allow get: if request.auth != null && resource.data.ownerUid == request.auth.uid; }`;
    }else if(path.startsWith('/members/')||path.startsWith('/config/owners/')||path.startsWith('/config/legacyPrivacy/'))throw Error('Unexpected nested policy');
    if(replacement)changes.push([m.index,endOfBlock(text,m.index+m[0].lastIndexOf('{')),replacement]);
  }
  if(memberCount!==1||ownerCount!==1)throw Error('Missing legacy policy');
  let result=source;
  for(const [a,b,value] of changes.sort((a,b)=>b[0]-a[0]))result=result.slice(0,a)+value+result.slice(b);
  return result;
}
module.exports={privateRules};
