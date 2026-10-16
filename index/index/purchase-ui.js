(function(root){
'use strict';
function create(h){
const C=root.HibirukaPurchase,$=id=>document.getElementById(id),esc=h.esc;
let original=null,draftId='',busy=false,sharedDraft=null;
const draftKey='hibiruka-purchase-share';
try{const saved=JSON.parse(sessionStorage.getItem(draftKey));if(saved&&Date.now()-saved.at<1800000)sharedDraft=C.shared(saved.url);}catch{}
const panel=document.createElement('section');panel.id='tab-purchase';panel.className='wrap hidden';
panel.innerHTML=`<button type="button" class="btn sub" id="purchaseBack" style="margin-top:16px">‹ 予定・記録へ</button>
<div class="card"><h2>🛍️ 買い物・定期購入</h2><p class="note">次のお届け日をカレンダーへ。購入先の注文・解約は購入先で手続きしてください。</p>
<p class="note">Amazon・楽天などの商品リンクを貼り付けて登録できます。事前の設定はいりません。</p>
<p class="note" id="purchaseScope"></p><button type="button" class="btn" id="purchaseNew">＋ 商品を登録</button>
<form id="purchaseForm" class="hidden" style="margin-top:20px">
<h3 id="purchaseHeading">商品を登録</h3>
<label class="lbl" for="purchaseUrl">商品リンク（任意）</label><input id="purchaseUrl" type="url" maxlength="4096" placeholder="Amazonなどの商品リンクを貼り付け">
<p class="note">コピーしたリンクを、この欄に貼り付けます。リンクがなくても、商品名と日付だけで登録できます。</p>
<label class="lbl" for="purchaseTitle">商品名</label><input id="purchaseTitle" required maxlength="120" placeholder="例：いつものドッグフード">
<label class="lbl" for="purchaseStatus">状態</label><select id="purchaseStatus"><option value="active">お届け予定</option><option value="received">購入済み・受け取り済み</option><option value="paused">予定の管理を停止中</option></select>
<label class="lbl" for="purchaseDate" id="purchaseDateLabel">次のお届け予定日</label><input id="purchaseDate" type="date" min="2000-01-01" max="2099-12-31" required>
<label class="lbl" style="display:flex;align-items:center;gap:10px"><input id="purchaseRecurring" type="checkbox" style="width:24px;height:24px">定期購入</label>
<div id="purchaseInterval" class="hidden"><div class="row2"><div><label class="lbl" for="purchaseEvery">間隔</label><input id="purchaseEvery" type="number" inputmode="numeric" min="1" max="365" step="1" value="1"></div><div><label class="lbl" for="purchaseUnit">単位</label><select id="purchaseUnit"><option value="week">週間ごと</option><option value="month" selected>か月ごと</option><option value="day">日ごと</option></select></div></div><p class="note">「受け取った・次回へ」で次の予定を作ります。未来の予定は1回分だけ表示します。</p></div>
<details id="purchaseMore"><summary>金額・変更期限・メモ（任意）</summary><label class="lbl" for="purchaseAmount">1回の金額（円・見込み）</label><input id="purchaseAmount" type="number" min="0" max="100000000" step="1" inputmode="numeric"><label class="lbl" for="purchaseDeadline">変更・キャンセル期限</label><input id="purchaseDeadline" type="date" min="2000-01-01" max="2099-12-31"><label class="lbl" for="purchaseMemo">メモ</label><textarea id="purchaseMemo" maxlength="2000"></textarea></details>
<p class="note">通知は保存後に「お知らせを予約」から各回ごとに設定できます。登録だけでは通知されません。</p>
<button class="btn" id="purchaseSave" style="margin-top:16px">保存する</button><button type="button" class="btn ghost" id="purchaseCancel">やめる</button></form>
<p id="purchaseMessage" role="status" aria-live="polite" style="white-space:pre-wrap"></p>
<h3>登録した買い物</h3><div id="purchaseList"></div>
<details style="margin-top:24px"><summary>商品リンクの貼り付け方</summary><ol class="note"><li>Amazon・楽天などで、商品のページのリンクをコピーします。</li><li>この画面の「＋ 商品を登録」を押し、「商品リンク」の欄に貼り付けます。</li><li>商品名と日付を入力して「保存する」を押します。</li></ol><p class="note">商品名・金額は自分で入力します。写真・価格・購入履歴は自動取得しません。</p></details></div>`;
$('tab-set').parentNode.appendChild(panel);
$('heroPlus').insertAdjacentHTML('afterend','<button type="button" class="btn sub" id="purchaseOpen" style="margin-top:12px">🛍️ 買い物・定期購入</button>');
const message=s=>$('purchaseMessage').textContent=s;
function stateForm(){
 $('purchaseInterval').classList.toggle('hidden',!$('purchaseRecurring').checked);
 const done=$('purchaseStatus').value==='received';$('purchaseDateLabel').textContent=done?'購入日・お届け日':'次のお届け予定日';
 $('purchaseRecurring').disabled=done;
 if(done){$('purchaseRecurring').checked=false;$('purchaseInterval').classList.add('hidden');}
}
function edit(e=null,share=null){
 if(busy)return;
 original=e?JSON.parse(JSON.stringify(e)):null;draftId=e?.id||h.newId();
 const p=e?.purchase||{};
 $('purchaseForm').classList.remove('hidden');$('purchaseHeading').textContent=e?'買い物を直す':'商品を登録';
 $('purchaseTitle').value=e?.title||share?.title||'';$('purchaseUrl').value=p.url||share?.url||'';
 $('purchaseDate').value=e?.date||h.today();$('purchaseStatus').value=p.status||'active';
 $('purchaseRecurring').checked=!!p.recurring;$('purchaseEvery').value=p.every||1;$('purchaseUnit').value=p.unit||'month';
 $('purchaseAmount').value=p.amount??'';$('purchaseDeadline').value=p.deadline||'';$('purchaseMemo').value=e?.memo||'';
 $('purchaseMore').open=!!(p.amount!=null||p.deadline||e?.memo);stateForm();message('');
 $('purchaseTitle').focus();
}
function open(e){if(busy)return;h.closeSheets();h.show();render();if(e)edit(e);}
function closeEditor(){if(busy)return;$('purchaseForm').classList.add('hidden');original=null;draftId='';}
async function run(fn){
 if(busy)return;busy=true;
 const controls=[...panel.querySelectorAll('input,select,textarea,button')].filter(x=>!x.disabled);controls.forEach(x=>x.disabled=true);message('保存しています…');
 try{await fn();}catch(e){message(e.message||'保存できませんでした。通信を確認してください');}
 finally{busy=false;controls.forEach(x=>x.disabled=false);stateForm();render();}
}
$('purchaseForm').onsubmit=event=>{event.preventDefault();let data;
 try{data=C.fields({title:$('purchaseTitle').value,url:$('purchaseUrl').value,date:$('purchaseDate').value,status:$('purchaseStatus').value,recurring:$('purchaseRecurring').checked,every:$('purchaseEvery').value,unit:$('purchaseUnit').value,amount:$('purchaseAmount').value,deadline:$('purchaseDeadline').value,memo:$('purchaseMemo').value},original);
 if(data.purchase.status==='received'&&data.date>h.today())throw Error('購入済みの記録は今日までの日付にしてください');
 if(original?.purchase.status==='received'&&data.purchase.status!=='received')throw Error('受け取り済みの記録はそのまま残し、新しい商品として登録してください');
 }catch(e){message(e.message);return;}
 run(async()=>{await h.save(draftId,data,original);$('purchaseForm').classList.add('hidden');original=null;draftId='';message('保存しました。お届け予定はカレンダーで確認できます。');});
};
$('purchaseOpen').onclick=()=>open();$('purchaseBack').onclick=()=>{if(!busy)h.back();};$('purchaseNew').onclick=()=>edit();$('purchaseCancel').onclick=closeEditor;
$('purchaseRecurring').onchange=stateForm;$('purchaseStatus').onchange=stateForm;
function render(){
 $('purchaseScope').textContent=h.personal()?'自分の記録に保存します。':'以前の共有モードです。この買い物も同じ共有範囲の人に見えます。';
 const records=h.events().filter(e=>e.purchase),active=records.filter(e=>e.purchase.status!=='received').sort((a,b)=>(a.purchase.status==='paused')-(b.purchase.status==='paused')||a.date.localeCompare(b.date));
 const history=records.filter(e=>e.purchase.status==='received').sort((a,b)=>b.date.localeCompare(a.date));
 function row(e){const p=e.purchase,link=C.shared(p.url)?.url||'',active=p.status==='active';return `<div style="border-top:1px solid var(--line);padding:16px 0"><strong>${esc(e.title)}</strong><p class="note">${esc(e.date)}・${p.status==='paused'?'管理停止中':p.status==='received'?'購入済み・受け取り済み':e.date<h.today()?'お届け予定日を過ぎています':'お届け予定'}・${esc(C.label(p))}${p.amount==null?'':'・'+esc(p.amount.toLocaleString('ja-JP'))+'円（見込み）'}${p.deadline?'<br>変更期限：'+esc(p.deadline):''}</p>
 ${link?`<a class="btn sub" href="${esc(link)}" target="_blank" rel="noopener noreferrer">購入先を開く</a>`:''}
 <div class="btnrow"><button type="button" class="btn small sub" data-purchase-edit="${esc(e.id)}">直す</button><button type="button" class="btn small sub" data-purchase-detail="${esc(e.id)}">記録・通知を見る</button></div>
 ${active?`<button type="button" class="btn sub" data-purchase-received="${esc(e.id)}">${p.recurring?'受け取った・次回へ':'受け取った'}</button><button type="button" class="btn ghost" data-purchase-pause="${esc(e.id)}">予定の管理を停止</button>`:p.status==='paused'?`<button type="button" class="btn sub" data-purchase-resume="${esc(e.id)}">日付を確認して再開</button>`:''}
 ${active&&e.date>=h.today()?`<button type="button" class="btn sub" data-purchase-send="${esc(e.id)}">お知らせを予約</button>`:''}</div>`;}
 $('purchaseList').innerHTML=(active.length?active.map(row).join(''):h.ready()?'<p class="note">お届け予定はまだありません。</p>':'<p class="note">記録を確認中です。通信を確認してください。</p>')+(history.length?`<details><summary>購入済み・受け取り済み（${history.length}件）</summary>${history.map(row).join('')}</details>`:'');
 const find=b=>h.events().find(e=>e.id===Object.values(b.dataset)[0]);
 for(const b of $('purchaseList').querySelectorAll('button')){b.disabled=busy;b.onclick=()=>{
  const e=find(b);if(!e||busy)return;
  if(b.hasAttribute('data-purchase-edit'))edit(e);
  else if(b.hasAttribute('data-purchase-detail'))h.detail(e.id);
  else if(b.hasAttribute('data-purchase-send'))h.send(e.id,e);
  else if(b.hasAttribute('data-purchase-resume')){edit(e);$('purchaseStatus').value='active';stateForm();message('次のお届け日を確認して保存してください。');}
  else if(b.hasAttribute('data-purchase-pause')){
   if(!confirm('ヒビルカで予定の管理を停止します。購入先の定期購入は解約されません。停止しますか？'))return;
   run(async()=>{await h.pause(e);message('予定の管理を停止しました。購入先での変更・解約は別途手続きしてください。');});
  }else if(b.hasAttribute('data-purchase-received')){
   let next='';try{if(e.purchase.recurring)next=C.nextDate(e);}catch(error){message(error.message);return;}
   if(!confirm(next?`受け取り済みとして残し、次回 ${next} の予定を作りますか？ 次回の変更期限・通知は改めて設定してください。`:'受け取り済みとして記録しますか？'))return;
   run(async()=>{await h.receive(e);message(next?`受け取り済みの記録と、次回 ${next} の予定を保存しました。次回の通知は「お知らせを予約」から設定してください。`:'受け取り済みとして保存しました。');});
  }
 };}
}
function capture(){
 const u=new URL(location.href),hp=new URLSearchParams(u.hash.slice(1));
 const raw=hp.get('purchase')||[u.searchParams.get('share_url'),u.searchParams.get('share_text')].filter(Boolean).join(' ');
 if(raw){sharedDraft=C.shared(raw);if(sharedDraft&&u.searchParams.get('share_title'))sharedDraft.title=u.searchParams.get('share_title').slice(0,120);
  if(sharedDraft){try{sessionStorage.setItem(draftKey,JSON.stringify({url:sharedDraft.url,at:Date.now()}));}catch{}}
  if(hp.has('purchase'))u.hash='';for(const k of ['share_url','share_text','share_title'])u.searchParams.delete(k);historyReplace(u);
 }
}
function historyReplace(u){history.replaceState(null,'',u.pathname+u.search+u.hash);}
function accept(){if(!sharedDraft)return;open();edit(null,sharedDraft);sharedDraft=null;try{sessionStorage.removeItem(draftKey);}catch{}message('商品リンクを受け取りました。商品名と日付を確認して保存してください。');}
capture();window.addEventListener('hashchange',()=>{capture();if(h.signedIn())accept();});
return {open,edit,render,accept,reset(){closeEditor();message('');},summary(e){const p=e.purchase;if(!p)return '';return `<p class="note">🛍️ ${esc(C.label(p))}・${p.status==='paused'?'管理停止中':p.status==='received'?'受け取り済み':'お届け予定'}${p.deadline?'・変更期限 '+esc(p.deadline):''}</p>`;}};
}
root.HibirukaPurchaseUI={create};
})(globalThis);
