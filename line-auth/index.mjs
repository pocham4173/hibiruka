import {googleToken} from '../line-worker/index.mjs';
import {firestore} from '../line-worker/firestore.mjs';
const PROJECT='hibiruka-f66fb';
const ORIGIN='https://pocham4173.github.io';
class Rejection extends Error { constructor(status,code){super(code);this.status=status;this.code=code;} }
const reject=(status,code)=>{throw new Rejection(status,code);};
async function jsonResponse(fetcher,url,options){
 const response=await fetcher(url,{...options,signal:AbortSignal.timeout(12000)});
 if(!response.ok)reject(response.status===429?429:response.status>=500?503:401,'identity_unavailable');
 return response.json();
}
export async function verifyFirebase(idToken,apiKey,fetcher=fetch){
 // Claims are not trusted until Google has validated this exact token below.
 let claims;
 try{claims=JSON.parse(Buffer.from(idToken.split('.')[1],'base64url').toString());}catch{reject(401,'invalid_identity');}
 const now=Date.now()/1000;
 if(claims.aud!==PROJECT||claims.iss!==`https://securetoken.google.com/${PROJECT}`||typeof claims.sub!=='string'||!claims.sub||claims.sub.length>128||!Number.isFinite(claims.exp)||claims.exp<=now||!Number.isFinite(claims.iat)||claims.iat>now+60||!Number.isFinite(claims.auth_time)||claims.auth_time>now+60)reject(401,'invalid_identity');
 const data=await jsonResponse(fetcher,'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='+encodeURIComponent(apiKey),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken})});
 const user=data.users?.[0];
 if(!user||user.localId!==claims.sub||user.disabled||Number(user.validSince||0)>claims.auth_time)reject(401,'invalid_identity');
 return user.localId;
}
export async function verifyLine(accessToken,channelId,fetcher=fetch){
 const token=await jsonResponse(fetcher,'https://api.line.me/oauth2/v2.1/verify?access_token='+encodeURIComponent(accessToken),{});
 if(String(token.client_id)!==channelId||!Number.isFinite(token.expires_in)||token.expires_in<=0||!String(token.scope||'').split(' ').includes('profile'))reject(401,'invalid_line_identity');
 const profile=await jsonResponse(fetcher,'https://api.line.me/v2/profile',{headers:{Authorization:'Bearer '+accessToken}});
 if(!/^U[0-9a-f]{32}$/i.test(profile.userId||'')||typeof profile.displayName!=='string')reject(401,'invalid_line_identity');
 return {userId:profile.userId,displayName:profile.displayName.slice(0,200)};
}
export async function acceptInvitation(db,scope,invitationId,uid,profile){
 const ref=db.collection(scope==='personal'?'personalFriends':'friends').doc(invitationId);
 await db.runTransaction(async tx=>{
  const snapshot=await tx.get(ref);
  if(!snapshot.exists)reject(404,'invitation_unavailable');
  const invitation=snapshot.data();
  if(invitation.status==='joined'){
   if(invitation.lineUserId===profile.userId&&invitation.acceptedBy===uid)return;
   reject(409,'invitation_unavailable');
  }
  if(invitation.status!=='pending'||(scope==='personal'&&typeof invitation.ownerUid!=='string'))reject(409,'invitation_unavailable');
  tx.update(ref,{status:'joined',lineUserId:profile.userId,lineName:profile.displayName,acceptedBy:uid,joinedAt:new Date(),lineVerifiedAt:new Date(),verificationVersion:1});
 });
}
async function readBody(request){
 if(!request.body)reject(400,'invalid_request');
 const reader=request.body.getReader(),parts=[];let length=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>16384){await reader.cancel();reject(413,'request_too_large');}parts.push(value);}}finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(parts).toString());}catch{reject(400,'invalid_request');}
}
export function createHandler(deps={}){
 return async function handle(request,env){
  const headers={'Cache-Control':'no-store','Content-Type':'application/json','Vary':'Origin'};
  const reply=(status,data)=>new Response(JSON.stringify(data),{status,headers});
  if(request.headers.get('Origin')!==ORIGIN)return reply(403,{error:'origin_denied'});
  headers['Access-Control-Allow-Origin']=ORIGIN;
  if(new URL(request.url).pathname!=='/v1/invitations/accept')return reply(404,{error:'not_found'});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Authorization,Content-Type','Access-Control-Max-Age':'600'}});
  if(request.method!=='POST')return reply(405,{error:'method_not_allowed'});
  try{
   if(!/^\d{8,16}$/.test(env.LINE_LOGIN_CHANNEL_ID||'')||!env.FIREBASE_API_KEY||!env.FIREBASE_SERVICE_ACCOUNT)reject(503,'registration_unavailable');
   if(!(request.headers.get('Content-Type')||'').toLowerCase().startsWith('application/json'))reject(415,'invalid_request');
   const match=/^Bearer ([^\s]+)$/.exec(request.headers.get('Authorization')||'');
   if(!match||match[1].length>10000)reject(401,'invalid_identity');
   const body=await readBody(request);
   if(!body||!['personal','legacy'].includes(body.scope)||!/^[A-Za-z0-9_-]{16,128}$/.test(body.invitationId||'')||typeof body.lineAccessToken!=='string'||!body.lineAccessToken||body.lineAccessToken.length>6000||Object.keys(body).some(k=>!['scope','invitationId','lineAccessToken'].includes(k)))reject(400,'invalid_request');
   const uid=await (deps.verifyFirebase||verifyFirebase)(match[1],env.FIREBASE_API_KEY);
   const profile=await (deps.verifyLine||verifyLine)(body.lineAccessToken,env.LINE_LOGIN_CHANNEL_ID);
   const db=deps.db||firestore(await googleToken(env.FIREBASE_SERVICE_ACCOUNT));
   await acceptInvitation(db,body.scope,body.invitationId,uid,profile);
   return reply(200,{ok:true});
  }catch(error){return reply(error instanceof Rejection?error.status:503,{error:error instanceof Rejection?error.code:'registration_unavailable'});}
 };
}
export default {fetch:createHandler()};
