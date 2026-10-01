const fs=require('node:fs');
function replaceFriendRules(source,replacement){
 const matches=[...source.matchAll(/match\s+\/friends\/\{\w+\}\s*\{/g)];
 if(matches.length!==1)throw Error('Expected exactly one legacy friends rule block');
 const match=matches[0],start=match.index,open=start+match[0].length-1;
 let depth=0,quote=null,lineComment=false,blockComment=false;
 for(let i=open;i<source.length;i++){
  const c=source[i],next=source[i+1];
  if(lineComment){if(c==='\n')lineComment=false;continue;}
  if(blockComment){if(c==='*'&&next==='/'){blockComment=false;i++;}continue;}
  if(quote){if(c==='\\'){i++;continue;}if(c===quote)quote=null;continue;}
  if(c==='/'&&next==='/'){lineComment=true;i++;continue;}
  if(c==='/'&&next==='*'){blockComment=true;i++;continue;}
  if(c==='"'||c==="'"){quote=c;continue;}
  if(c==='{')depth++;
  if(c==='}'&&--depth===0)return source.slice(0,start)+replacement.trim()+source.slice(i+1);
 }
 throw Error('Unbalanced legacy friends rule block');
}
module.exports={replaceFriendRules};
