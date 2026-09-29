import engine from '../scripts/line-engine.cjs';
import {firestore} from './firestore.mjs';
let cached;
const base64url=bytes=>Buffer.from(bytes).toString('base64url');
export async function googleToken(secret,fetcher=fetch){
  const sa=JSON.parse(secret);
  if(sa.project_id!=='hibiruka-f66fb'||!sa.client_email?.endsWith('@hibiruka-f66fb.iam.gserviceaccount.com'))throw Error('Wrong Firebase project');
  if(cached?.secret===secret && cached.expires>Date.now()+60000)return cached.token;
  const pem=sa.private_key.replace(/-----[^-]+-----|\s/g,'');
  const key=await crypto.subtle.importKey('pkcs8',Buffer.from(pem,'base64'),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const now=Math.floor(Date.now()/1000);
  const body=base64url(JSON.stringify({alg:'RS256',typ:'JWT'}))+'.'+base64url(JSON.stringify({iss:sa.client_email,scope:'https://www.googleapis.com/auth/datastore',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(body));
  const r=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:body+'.'+base64url(signature)}),signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('Firebase authentication HTTP '+r.status);
  const result=await r.json();if(!result.access_token)throw Error('Missing access token');
  cached={secret,token:result.access_token,expires:Date.now()+result.expires_in*1000};return cached.token;
}
export async function tick(env,controller){
  let db;
  const enabled=env.SENDING_ENABLED==='true';
  try{
    const token=await googleToken(env.FIREBASE_SERVICE_ACCOUNT);
    db=firestore(token);
    const result=await engine.runSender({db,token:env.LINE_CHANNEL_ACCESS_TOKEN,validateOnly:!enabled,maxSends:2});
    await db.heartbeat({checkedAt:new Date(),scheduledAt:new Date(controller.scheduledTime),enabled,ok:true,version:env.WORKER_VERSION||'unknown',sent:result?.sent||0,failed:result?.failed||0});
  }catch{
    // Never log credentials, names, message bodies, or Firebase response bodies.
    console.error('Hibiruka scheduler failed; check credentials, service status and limits.');
    if(db)await db.heartbeat({checkedAt:new Date(),enabled,ok:false,version:env.WORKER_VERSION||'unknown'}).catch(()=>{});
    throw Error('Hibiruka scheduled run failed');
  }
}
export default {
  scheduled(controller,env,ctx){ctx.waitUntil(tick(env,controller));},
  // There is deliberately no public HTTP send endpoint.
  fetch(){return new Response('Not found',{status:404});}
};
