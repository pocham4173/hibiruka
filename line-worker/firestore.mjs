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
  // 1回の実行で外部へ出せる通信は、Cloudflare Workers の無料プランで50回まで。
  // Firestore はそのうち38回まで（残りは Google 認証・LINE・アプリ通知の送り先に使う）。
  // 最後の1回は heartbeat（動作の記録）のために取っておき、ふつうの通信は37回で止める。
  const LIMIT=38, KEEP=1;
  let requests=0;
  async function call(path,body,{reserved=false}={}){
    if(requests>=(reserved?LIMIT:LIMIT-KEEP)){const e=Error('Firestore request budget reached; retry next minute');e.code='BUDGET';throw e;}
    requests++;
    const r=await fetcher('https://firestore.googleapis.com/v1/'+root+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+accessToken,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    if(r.status===404 && !body)return null;
    if(!r.ok){const detail=await r.json().catch(()=>({}));const e=Error('Firestore HTTP '+r.status);e.status=r.status;e.code=detail.error?.status;throw e;}
    return r.json();
  }
  function ref(c,id){if(!/^[A-Za-z]+$/.test(c)||!id||id.includes('/'))throw Error('Invalid document path');return {id,parent:{id:c},path:c+'/'+id,get:async()=>snapshot(await call('/'+c+'/'+encodeURIComponent(id)),c,id)};}
  function snapshot(doc,c,id){return {id:id||doc.name.split('/').pop(),exists:!!doc,ref:ref(c,id||doc.name.split('/').pop()),updateTime:doc?.updateTime,data:()=>data(doc?.fields)};}
  const ops={'<=':'LESS_THAN_OR_EQUAL','==':'EQUAL','in':'IN'};
  // select(): only these fields come back (keeps big photo strings out of the Worker's CPU budget)
  // orderBy('__name__')・startAfter(id)：IDの順に、前回の続きから読む（見回り用。複合インデックスはいらない）
  function collection(c,filters=[],n=limit,only=null,byName=false,after=null){return {
    doc:id=>ref(c,id),limit:size=>collection(c,filters,Math.min(size,limit),only,byName,after),
    select:(...names)=>collection(c,filters,n,names,byName,after),
    where:(field,op,value)=>{if(!ops[op])throw Error('Unsupported query');return collection(c,[...filters,{fieldFilter:{field:{fieldPath:field},op:ops[op],value:encode(value)}}],n,only,byName,after);},
    orderBy:field=>{if(field!=='__name__')throw Error('Unsupported order');return collection(c,filters,n,only,true,after);},
    startAfter:id=>{if(!byName||typeof id!=='string'||!id||id.includes('/'))throw Error('Unsupported cursor');return collection(c,filters,n,only,byName,id);},
    get:async()=>{
      const where=filters.length>1?{compositeFilter:{op:'AND',filters}}:filters[0];
      const select=only?{select:{fields:only.map(f=>({fieldPath:f}))}}:{};
      const order=byName?{orderBy:[{field:{fieldPath:'__name__'},direction:'ASCENDING'}]}:{};
      const cursor=after?{startAt:{values:[{referenceValue:root+'/'+c+'/'+after}],before:false}}:{};
      return {docs:(await call(':runQuery',{structuredQuery:{from:[{collectionId:c}],limit:n,...select,...(where?{where}:{}),...order,...cursor}})||[]).filter(x=>x.document).map(x=>snapshot(x.document,c))};
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
      for(let attempt=0;attempt<5;attempt++){
        if(attempt)await new Promise(r=>setTimeout(r,20+Math.random()*80*attempt)); // ぶつかったら少し待ってやり直す
        const reads=new Map(),writes=[];
        const result=await callback({get:async r=>{const s=await r.get();reads.set(r.path,s);return s;},update:(r,value)=>{
          const old=reads.get(r.path);if(!old?.exists||!old.updateTime)throw Error('Read before update required');
          writes.push({update:{name:root+'/'+r.path,fields:fields(value)},updateMask:{fieldPaths:Object.keys(value)},currentDocument:{updateTime:old.updateTime}});
        },set:(r,value)=>{
          // 丸ごと書く（なければ作る）。読んだときと変わっていたらやり直し
          const old=reads.get(r.path);if(!old)throw Error('Read before set required');
          writes.push({update:{name:root+'/'+r.path,fields:fields(value)},currentDocument:old.exists&&old.updateTime?{updateTime:old.updateTime}:{exists:false}});
        }});
        if(!writes.length)return result;
        try{await call(':commit',{writes});return result;}catch(e){if((![409,412].includes(e.status)&&!['ABORTED','FAILED_PRECONDITION','ALREADY_EXISTS'].includes(e.code))||attempt===4)throw e;}
      }
    },
    heartbeat:async value=>call(':commit',{writes:[{update:{name:root+'/schedulerStatus/cloudflare',fields:fields(value)}}]},{reserved:true}),
    // 送信処理が、残りの通信回数を見て「この回に送れる件数」を決めるため
    budget:{limit:LIMIT-KEEP,used:()=>requests,left:()=>Math.max(0,LIMIT-KEEP-requests)},
    // Webhook helpers. create() fails when the document already exists (LINE redelivery).
    create:async(r,value)=>write([{update:{name:root+'/'+r.path,fields:fields(value)},currentDocument:{exists:false}}]),
    set:async(r,value)=>write([{update:{name:root+'/'+r.path,fields:fields(value)}}]),
    patch:async(r,value)=>write([{update:{name:root+'/'+r.path,fields:fields(value)},updateMask:{fieldPaths:Object.keys(value)},currentDocument:{exists:true}}]),
    remove:async r=>write([{delete:root+'/'+r.path}]),
    commit:async ops=>write(ops.map(o=>o.remove?{delete:root+'/'+o.ref.path}:{update:{name:root+'/'+o.ref.path,fields:fields(o.value)}}))
  };
}
