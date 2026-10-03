/* Tokens are sent only to this app's registration API and are never stored. */
window.registerVerifiedLine = async function({auth,liff,invitationId,scope}) {
  const lineAccessToken=liff.getAccessToken();
  if(!auth.currentUser||!lineAccessToken)throw new Error('本人確認のため、LINEから招待を開き直してください。');
  const response=await fetch('https://hibiruka-auth.okm-co.workers.dev/v1/invitations/accept',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await auth.currentUser.getIdToken()},
    body:JSON.stringify({invitationId,scope,lineAccessToken}),signal:AbortSignal.timeout(20000)
  });
  if(!response.ok)throw new Error('登録できませんでした。時間をおいて、LINEから開き直してください。');
  const result=await response.json();if(result.ok!==true)throw new Error('登録結果を確認できませんでした。');
};
