// Explicit deployment only, after the LINE Login channel ID has been confirmed.
const fs=require('node:fs');const {spawnSync}=require('node:child_process');
const {parseServiceAccount}=require('../scripts/service-account.cjs');
const configPath='line-auth/.deploy.json';
try{
 const channel=process.env.LINE_LOGIN_CHANNEL_ID;
 if(!/^\d{8,16}$/.test(channel||''))throw Error('Confirmed LINE Login channel ID is required');
 if(!process.env.CLOUDFLARE_API_TOKEN||!process.env.CLOUDFLARE_ACCOUNT_ID)throw Error('Cloudflare configuration is missing');
 const account=parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
 if(account.project_id!=='hibiruka-f66fb')throw Error('Wrong project');
 const apiKey=fs.readFileSync('index/index/index.html','utf8').match(/apiKey:\s*"([^"]+)"/)?.[1];
 if(!apiKey)throw Error('Firebase configuration is missing');
 const config=JSON.parse(fs.readFileSync('line-auth/wrangler.jsonc','utf8'));
 config.vars={LINE_LOGIN_CHANNEL_ID:channel,FIREBASE_API_KEY:apiKey};
 fs.writeFileSync(configPath,JSON.stringify(config));
 const run=(args,input)=>{const r=spawnSync('line-worker/node_modules/.bin/wrangler',args,{input,stdio:input?['pipe','inherit','inherit']:'inherit',env:process.env});if(r.status!==0)throw Error('Registration API deployment failed');};
 run(['deploy','--config',configPath]);
 run(['secret','bulk','--config',configPath],JSON.stringify({FIREBASE_SERVICE_ACCOUNT:JSON.stringify(account)}));
 console.log('Registration API deployed. Sender configuration has not been changed.');
}catch(error){console.error(error.message);process.exitCode=1;}finally{fs.rmSync(configPath,{force:true});}
