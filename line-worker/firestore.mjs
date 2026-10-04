// Small REST adapter: update-time preconditions protect the same reservation leases
// used by the GitHub sender. No Firebase Admin SDK is bundled into the Worker.
export function encode(value) {
  if(value===null)return {nullValue:null};
  if(value instanceof Date)return {timestampValue:value.toISOString()};
  if(Array.isArray(value))return {arrayValue:{values:value.map(encode)}};
  if(typeof value==='string')return {stringValue:value};
  if(typeof value==='boolean')return {booleanValue:value};
  if(typeof value==='number'&&Number.isFinite(value))return Number.isInteger(value)?{integerValue:String(value)}:{doubleValue:value};
  if(value && typeof value==='object')return {mapValue:{fields:fields(value)}};
  throw Error('Unsupported Firestore value');
}
export const fields=value=>Object.fromEntries(Object.entries(value).map(([k,v])=>[k,encode(v)]));
export function decode(v){
  if('nullValue' in v)return null;
  if('stringValue' in v)return v.stringValue;
  if('booleanValue' in v)return v.booleanValue;
  if('integerValue' in v)return Number(v.integerValue);
  if('doubleValue' in v)return v.doubleValue;
  if('timestampValue' in v)return new Date(v.timestampValue);
  if('arrayValue' in v)return (v.arrayValue.values||[]).map(decode);
  if('mapValue' in v)return data(v.mapValue.fields);
  throw Error('Unsupported Firestore type');
}
const data=f=>Object.fromEntries(Object.entries(f||{}).map(([k,v])=>[k,decode(v)]));
export function firestore(accessToken, fetcher=fetch, limit=4){
  const root='projects/hibiruka-f66fb/databases/(default)/documents';
  let requests=0;
  async function call(path,body){
    if(++requests>38)throw Error('Firestore request budget reached; retry next minute');
    const r=await fetcher('https://firestore.googleapis.com/v1/'+root+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+accessToken,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    if(r.status===404 && !body)return null;
    if(!r.ok){const detail=await r.json().catch(()=>({}));const e=Error('Firestore HTTP '+r.status);e.status=r.status;e.code=detail.error?.status;throw e;}
    return r.json();
  }
  function ref(c,id){if(!/^[A-Za-z]+$/.test(c)||!id||id.includes('/'))throw Error('Invalid document path');return {id,parent:{id:c},path:c+'/'+id,get:async()=>snapshot(await call('/'+c+'/'+encodeURIComponent(id)),c,id)};}
  function snapshot(doc,c,id){return {id:id||doc.name.split('/').pop(),exists:!!doc,ref:ref(c,id||doc.name.split('/').pop()),updateTime:doc?.updateTime,data:()=>data(doc?.fields)};}
  const ops={'<=':'LESS_THAN_OR_EQUAL','==':'EQUAL'};
  // select(): only these fields come back (keeps big photo strings out of the Worker's CPU budget)
  function collection(c,filters=[],n=limit,only=null){return {
    doc:id=>ref(c,id),limit:size=>collection(c,filters,Math.min(size,limit),only),
    select:(...names)=>collection(c,filters,n,names),
    where:(field,op,value)=>{if(!ops[op])throw Error('Unsupported query');return collection(c,[...filters,{fieldFilter:{field:{fieldPath:field},op:ops[op],value:encode(value)}}],n,only);},
    get:async()=>{
      const where=filters.length>1?{compositeFilter:{op:'AND',filters}}:filters[0];
      const select=only?{select:{fields:only.map(f=>({fieldPath:f}))}}:{};
      return {docs:(await call(':runQuery',{structuredQuery:{from:[{collectionId:c}],limit:n,...select,...(where?{where}:{})}})||[]).filter(x=>x.document).map(x=>snapshot(x.document,c))};
    }
  };}
  const write=list=>call(':commit',{writes:list});
  return {
    collection,
    getAll:async(...refs)=>{
      const rows=await call(':batchGet',{documents:refs.map(r=>root+'/'+r.path)});
      const byName=new Map(rows.map(r=>[r.found?.name||r.missing,r.found]));
      return refs.map(r=>snapshot(byName.get(root+'/'+r.path),r.parent.id,r.id));
    },
    runTransaction:async callback=>{
      for(let attempt=0;attempt<3;attempt++){
        const reads=new Map(),writes=[];
        const result=await callback({get:async r=>{const s=await r.get();reads.set(r.path,s);return s;},update:(r,value)=>{
          const old=reads.get(r.path);if(!old?.exists||!old.updateTime)throw Error('Read before update required');
          writes.push({update:{name:root+'/'+r.path,fields:fields(value)},updateMask:{fieldPaths:Object.keys(value)},currentDocument:{updateTime:old.updateTime}});
        }});
        if(!writes.length)return result;
        try{await call(':commit',{writes});return result;}catch(e){if((![409,412].includes(e.status)&&!['ABORTED','FAILED_PRECONDITION'].includes(e.code))||attempt===2)throw e;}
      }
    },
    heartbeat:async value=>call(':commit',{writes:[{update:{name:root+'/schedulerStatus/cloudflare',fields:fields(value)}}]}),
    // Webhook helpers. create() fails when the document already exists (LINE redelivery).
    create:async(r,value)=>write([{update:{name:root+'/'+r.path,fields:fields(value)},currentDocument:{exists:false}}]),
    set:async(r,value)=>write([{update:{name:root+'/'+r.path,fields:fields(value)}}]),
    patch:async(r,value)=>write([{update:{name:root+'/'+r.path,fields:fields(value)},updateMask:{fieldPaths:Object.keys(value)},currentDocument:{exists:true}}]),
    remove:async r=>write([{delete:root+'/'+r.path}]),
    commit:async ops=>write(ops.map(o=>o.remove?{delete:root+'/'+o.ref.path}:{update:{name:root+'/'+o.ref.path,fields:fields(o.value)}}))
  };
}
