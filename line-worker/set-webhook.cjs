// Points the LINE channel's Webhook URL at this Worker, then asks LINE to test it.
// Runs in the deploy workflow only when LINE_CHANNEL_SECRET exists (otherwise the
// webhook would answer 503). The "use webhook" switch itself stays in LINE's console.
const fs=require('node:fs');
(async()=>{
 if(!process.env.LINE_CHANNEL_SECRET){console.log('LINE_CHANNEL_SECRET is not set; Webhook URL left unchanged.');return;}
 const {CLOUDFLARE_API_TOKEN:cf,CLOUDFLARE_ACCOUNT_ID:acct,LINE_CHANNEL_ACCESS_TOKEN:line}=process.env;
 if(!cf||!acct||!line)throw Error('Cloudflare or LINE connection is missing');
 const name=JSON.parse(fs.readFileSync('line-worker/wrangler.jsonc','utf8')).name;
 const sub=await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/workers/subdomain`,{headers:{authorization:'Bearer '+cf}}).then(r=>r.json());
 if(!sub?.result?.subdomain)throw Error('workers.dev subdomain not found');
 const endpoint=`https://${name}.${sub.result.subdomain}.workers.dev/line/webhook`;
 const call=(path,method,body)=>fetch('https://api.line.me/v2/bot/channel/webhook/'+path,{method,headers:{authorization:'Bearer '+line,'content-type':'application/json'},body:body&&JSON.stringify(body)});
 const put=await call('endpoint','PUT',{endpoint});
 if(!put.ok)throw Error('LINE refused the Webhook URL: '+put.status);
 const test=await call('test','POST',{endpoint}).then(r=>r.json()).catch(()=>({}));
 const state=await call('endpoint','GET').then(r=>r.json()).catch(()=>({}));
 console.log('Webhook URL:',endpoint);
 console.log('LINE test:',test.success?'OK':'failed '+(test.statusCode??'')+' '+(test.reason??''));
 console.log('Use webhook switch:',state.active?'ON':'OFF — turn it on in LINE Official Account Manager → 応答設定');
 if(!test.success)process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1;});
