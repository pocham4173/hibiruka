/* Business views share the owner's calendar. No shared events or notifications. */
globalThis.createBusinessCalendar=function(hooks){
  const C=HibirukaCalendar,$=id=>document.getElementById(id),esc=hooks.esc;
  let mode=false,busy=false,epoch=0,editing='',selected='',settingsDirty=false;
  $('businessSummary').innerHTML=`<div class="business-heading"><div><span class="business-eyebrow">WORK & LIFE</span><h2>仕事と休み</h2></div><button type="button" class="chip" id="businessSettingsToggle">仕事の設定</button></div><div class="business-stats" id="businessStats"></div><p class="note" id="businessPeriod"></p><button type="button" class="btn sub" id="businessNext">次の休みを見る</button><p class="note" id="businessCertainty"></p>
  <details id="businessSettings"><summary>期間・班・色の設定</summary><form id="businessSettingsForm">
  <div class="business-fields"><label>年度の開始日<input type="date" id="businessYear" required></label><label>有給の集計開始日<input type="date" id="businessLeaveYear" required></label><label>自分の班<select id="businessTeam"></select></label></div>
  <details><summary>会社カレンダーの確定期間</summary><p class="note">この範囲は、休日・出勤日をすべて確認済みとして集計します。未定なら空欄のままで使えます。</p><div class="business-fields"><label>いつから<input type="date" id="businessConfirmedFrom"></label><label>いつまで<input type="date" id="businessConfirmedThrough"></label></div></details>
  <details><summary>休日の名前と色を変える</summary><div id="businessLabels"></div><p class="note">使う項目にチェック。班は追加1〜8も使えます。</p></details>
  <button class="btn small" type="submit">設定を保存</button></form><button type="button" class="btn small sub" id="businessImport">会社カレンダーを写真・手入力で登録</button></details>`;
  $('businessEditor').innerHTML=`<div class="business-edit-tabs" role="group" aria-label="登録する内容"><button type="button" class="chip" data-btab="personal" aria-pressed="true">自分の休み</button><button type="button" class="chip" data-btab="entry" aria-pressed="false">仕事の予定</button><button type="button" class="chip" data-btab="company" aria-pressed="false">会社の休日</button></div>
  <form id="businessPersonalForm" class="business-edit-form"><p class="note" id="businessOriginal"></p><div class="business-fields"><label>種類<select id="businessPersonalCategory"><option value="off">休み</option><option value="paid">有給</option><option value="work">出勤に変更</option></select></label><label>時間帯<select id="businessPart"><option value="full">終日</option><option value="am">午前</option><option value="pm">午後</option></select></label></div><label>名前（自由に変更できます）<input id="businessPersonalTitle" maxlength="40" placeholder="例：夏季休暇・通院のための休み" list="businessHolidayNames"></label><datalist id="businessHolidayNames"><option value="夏季休暇"><option value="振替休日"><option value="特別休暇"><option value="通院"></datalist><div class="btnrow"><button class="btn" type="submit">この日の変更を保存</button><button class="btn sub" id="businessRestore" type="button">変更を戻す</button></div></form>
  <form id="businessEntryForm" class="business-edit-form hidden"><div class="business-fields"><label>種類<select id="businessEntryType"><option value="appointment">予定</option><option value="deadline">締切・提出物</option><option value="shift">勤務・シフト</option><option value="memo">仕事メモ</option></select></label><label>時間（任意）<input type="time" id="businessEntryTime"></label></div><label>項目・名前<input id="businessEntryTitle" required maxlength="40" placeholder="健康診断・研修・希望休の提出など" list="businessNames"></label><datalist id="businessNames"><option value="健康診断"><option value="研修"><option value="会議"><option value="出張"><option value="希望休の提出"><option value="交通費精算"><option value="早番"><option value="遅番"><option value="夜勤"><option value="在宅勤務"></datalist><label>メモ<input id="businessEntryMemo" maxlength="500" placeholder="場所・持ち物・確認すること"></label><div class="business-fields"><label>繰り返し<select id="businessRepeat"><option value="none">この日だけ</option><option value="weekly">毎週</option><option value="monthly">毎月（同じ日がなければ月末）</option></select></label><label id="businessRepeatCountLabel" class="hidden">回数（今回を含む）<input type="number" id="businessRepeatCount" min="1" max="24" value="4"></label></div><p class="note" id="businessRepeatNote">勤務の予定を入れても、休日の印は変わりません。</p><div class="btnrow"><button class="btn" type="submit" id="businessEntrySave">予定を保存</button><button type="button" class="btn sub hidden" id="businessEntryCancel">編集をやめる</button></div></form>
  <div id="businessCompanyForm" class="business-edit-form hidden"><p class="note">会社カレンダーの印を変更します。自分の有給・半休は「自分の休み」から。</p><div class="calendar-quick-grid" id="businessCompanyButtons"></div></div><p id="businessStatus" class="note" role="status" aria-live="polite"></p>`;
  const dateLabel=d=>d?d.replaceAll('-','/'):'';
  const typeNames={appointment:'予定',deadline:'締切',memo:'メモ',shift:'勤務'};
  const config=()=>hooks.config();
  const business=()=>C.cleanBusiness(config().business);
  function status(text){$('businessStatus').textContent=text;$('businessGlobalStatus').textContent=text;}
  function lock(){for(const node of document.querySelectorAll('#businessEditor button,#businessEditor input,#businessEditor select,#businessSettings button,#businessSettings input,#businessSettings select,#businessAgenda button'))node.disabled=busy||!hooks.ready();}
  async function save(action,message){
    if(busy||!hooks.ready())return false;
    const generation=epoch;busy=true;lock();status('保存しています…');
    try{await action();if(epoch!==generation)return false;status(message);hooks.toast(message);return true;}
    catch(e){if(epoch===generation)status(e?.message||'保存できませんでした。通信を確認してもう一度お試しください');return false;}
    finally{if(epoch===generation){busy=false;render();lock();}}
  }
  function setMode(value){mode=value;hooks.mode(value);render();}
  $('businessModeOn').onclick=()=>setMode(true);$('businessModeOff').onclick=()=>setMode(false);
  $('businessOpenDay').onclick=()=>{setMode(true);$('businessEditor').scrollIntoView?.({block:'nearest',behavior:'smooth'});};
  function tab(name){
    for(const key of ['personal','entry','company']) $('business'+key[0].toUpperCase()+key.slice(1)+'Form').classList.toggle('hidden',name!==key);
    document.querySelectorAll('[data-btab]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.btab===name)));
  }
  document.querySelectorAll('[data-btab]').forEach(el=>el.onclick=()=>tab(el.dataset.btab));
  function fillPersonal(){const p=business().personal[hooks.selected()];$('businessPersonalCategory').value=p?.category||'off';$('businessPart').value=p?.part||'full';$('businessPersonalTitle').value=p?.title||'';personalCategory();}
  function personalCategory(){$('businessPart').disabled=busy||$('businessPersonalCategory').value==='work';if($('businessPersonalCategory').value==='work')$('businessPart').value='full';}
  $('businessPersonalCategory').onchange=()=>{if(['','休み','有給','出勤'].includes($('businessPersonalTitle').value))$('businessPersonalTitle').value={off:'休み',paid:'有給',work:'出勤'}[$('businessPersonalCategory').value];personalCategory();};
  $('businessPersonalForm').onsubmit=async e=>{
    e.preventDefault();const date=hooks.selected();if(!C.validDate(date))return;
    const category=$('businessPersonalCategory').value,part=$('businessPart').value;
    const title=$('businessPersonalTitle').value.trim()||{off:'休み',paid:'有給',work:'出勤'}[category];
    await save(()=>hooks.save({personal:{[date]:{title,category,part}}}),dateLabel(date)+'の変更を保存しました');
  };
  $('businessRestore').onclick=async()=>{const date=hooks.selected();if(await save(()=>hooks.save({personal:{[date]:null}}),'会社カレンダーの状態に戻しました'))fillPersonal();};
  function resetEntry(){editing='';$('businessEntryForm').reset();$('businessRepeat').disabled=false;$('businessRepeatCountLabel').classList.add('hidden');$('businessEntryCancel').classList.add('hidden');$('businessEntrySave').textContent='予定を保存';$('businessRepeatNote').textContent='勤務の予定を入れても、休日の印は変わりません。';}
  $('businessEntryCancel').onclick=resetEntry;
  $('businessRepeat').onchange=()=>$('businessRepeatCountLabel').classList.toggle('hidden',$('businessRepeat').value==='none');
  $('businessEntryForm').onsubmit=async e=>{
    e.preventDefault();const date=hooks.selected(),title=$('businessEntryTitle').value.trim();if(!title){status('名前を入力してください');return;}
    try{
      const dates=C.repeatDates(date,editing?'none':$('businessRepeat').value,Number($('businessRepeatCount').value));
      const entries={},seed='e'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,9);
      dates.forEach((d,i)=>entries[editing||seed+'_'+i]={date:d,title,type:$('businessEntryType').value,time:$('businessEntryTime').value,memo:$('businessEntryMemo').value,done:editing?business().entries[editing]?.done===true:false});
      if(await save(()=>hooks.save({entries}),dates.length+'件を保存しました'))resetEntry();
    }catch(e){status(e.message);}
  };
  function fillSettings(){
    const c=config(),b=business(),year=hooks.month().slice(0,4);
    $('businessYear').value=C.yearRange(hooks.month(),b.yearStart).from;$('businessLeaveYear').value=C.yearRange(hooks.month(),b.leaveStart).from;
    $('businessConfirmedFrom').value=b.confirmedFrom;$('businessConfirmedThrough').value=b.confirmedThrough;
    $('businessTeam').innerHTML='<option value="">班なし・未選択</option>'+C.kinds.filter(k=>!['all','off','work'].includes(k)).map(k=>`<option value="${k}">${esc(C.companyStyle(c,k).name)}</option>`).join('');$('businessTeam').value=c.team;
    $('businessLabels').innerHTML=C.kinds.map(k=>{const x=C.companyStyle(c,k),enabled=b.labels[k]?x.enabled:!k.startsWith('C')&&(k!=='A'&&k!=='B'||Object.values(c.days).includes(k));return `<div class="business-label-row" data-label="${k}"><label><input type="checkbox" ${enabled?'checked':''} aria-label="${k}を使う">${k.startsWith('C')?'追加'+k.slice(1):k==='off'?'休み':k==='work'?'出勤':k}</label><input type="text" value="${esc(x.name)}" maxlength="16" aria-label="${k}の名前"><input type="color" value="${x.color}" aria-label="${k}の色"></div>`;}).join('');
    settingsDirty=false;
  }
  $('businessSettingsToggle').onclick=()=>{if(!$('businessSettings').open)fillSettings();$('businessSettings').open=!$('businessSettings').open;};
  $('businessSettings').querySelector('summary').onclick=()=>{if(!$('businessSettings').open)fillSettings();};
  $('businessSettingsForm').oninput=()=>settingsDirty=true;
  $('businessSettingsForm').onsubmit=async e=>{
    e.preventDefault();const labels={};
    $('businessLabels').querySelectorAll('[data-label]').forEach(row=>{const [enabled,name,color]=row.querySelectorAll('input');labels[row.dataset.label]={name:name.value.trim(),color:color.value,enabled:enabled.checked};});
    const patch={yearStart:$('businessYear').value.slice(5),leaveStart:$('businessLeaveYear').value.slice(5),confirmedFrom:$('businessConfirmedFrom').value,confirmedThrough:$('businessConfirmedThrough').value,labels};
    if(await save(()=>hooks.save(patch,{team:$('businessTeam').value}),'仕事の設定を保存しました')){settingsDirty=false;$('businessSettings').open=false;}
  };
  $('businessImport').onclick=()=>hooks.import();
  $('businessNext').onclick=()=>{const s=C.summary(config(),hooks.month(),hooks.today());if(s.next)hooks.select(s.next);};
  function render(){
    const c=config(),b=business(),date=hooks.selected();
    $('businessModeOn').setAttribute('aria-pressed',String(mode));$('businessModeOff').setAttribute('aria-pressed',String(!mode));
    $('tab-list').classList.toggle('business-mode',mode);
    $('businessSummary').classList.toggle('hidden',!mode);$('businessEditor').classList.toggle('hidden',!mode);$('businessAgenda').classList.toggle('hidden',!mode);$('businessOpenDay').classList.toggle('hidden',mode);
    $('calAll').textContent=mode?'今月の仕事をすべて見る':'これからの予定をすべて見る';
    if(!mode)return;
    const s=C.summary(c,hooks.month(),hooks.today()),next=s.next?(s.next===hooks.today()?'今日':dateLabel(s.next)):'未登録';
    $('businessStats').innerHTML=`<div><span>次の休み</span><strong>${next}</strong><small>${s.next&&s.end>s.next?Math.round((Date.parse(s.end)-Date.parse(s.next))/86400000)+1+'連休':'登録済みの休みから'}</small></div><div><span>会社の休日</span><strong>${s.needsTeam?'—':s.company}<small>日</small></strong><small>${s.needsTeam?'班を選ぶと集計できます':s.complete?'年間休日':'登録済み・未確定あり'}</small></div><div><span>有給（登録分）</span><strong>${s.paidTaken}<small>日取得</small></strong><small>これから ${s.paidPlanned}日予定</small></div>`;
    $('businessPeriod').textContent='会社の年度：'+dateLabel(s.range.from)+'〜'+dateLabel(s.range.to)+' ／ 有給：'+dateLabel(s.leave.from)+'〜'+dateLabel(s.leave.to);
    $('businessCertainty').textContent=s.needsTeam?'「仕事の設定」で自分の班を選んでください。会社の印はすべての班を表示します。':s.complete?'会社の休日と有給は別々に集計しています。':'未定の日や祝日から会社の休みを推測しません。確定期間は「仕事の設定」で登録できます。';
    $('businessNext').disabled=!s.next;
    if(selected!==date){selected=date;fillPersonal();resetEntry();status('');}
    const original=c.days[date];$('businessOriginal').textContent='会社の印：'+(original?C.companyStyle(c,original).name:'未登録')+' ／ 自分の変更は元の印を残して保存します。';
    $('businessRestore').classList.toggle('hidden',!b.personal[date]);
    const active=C.kinds.filter(k=>{const x=C.companyStyle(c,k);return x.enabled&&(b.labels[k]||['all','off','work'].includes(k)||Object.values(c.days).includes(k));});
    $('businessCompanyButtons').innerHTML=active.map(k=>`<button type="button" data-company="${k}" aria-pressed="${original===k}" style="background:${C.companyStyle(c,k).color};color:${C.companyStyle(c,k).textColor}">${esc(C.companyStyle(c,k).name)}</button>`).join('')+'<button type="button" data-company="">会社の印を消す</button>';
    $('businessCompanyButtons').querySelectorAll('[data-company]').forEach(button=>button.onclick=async()=>{const target=hooks.selected(),kind=button.dataset.company;await save(()=>hooks.company({[target]:kind}),'会社の印を保存しました');});
    const rows=Object.entries(b.entries).filter(([,v])=>date?v.date===date:v.date.startsWith(hooks.month().slice(0,7))||v.type==='deadline'&&!v.done&&v.date<hooks.today()).sort(([,a],[,b])=>(a.date+a.time).localeCompare(b.date+b.time));
    $('businessAgenda').innerHTML='<h3>'+(date?dateLabel(date)+'の仕事':Number(hooks.month().slice(5,7))+'月の仕事・未完了の締切')+'</h3>'+(rows.length?rows.map(([id,v])=>`<article class="business-agenda-row ${v.done?'is-done':''}"><div><small>${dateLabel(v.date)} ${esc(v.time)} · ${typeNames[v.type]}${v.type==='deadline'&&!v.done&&v.date<hooks.today()?' · 期限超過':''}</small><b>${esc(v.title)}</b>${v.memo?`<p>${esc(v.memo)}</p>`:''}</div><div class="business-row-actions">${v.type==='deadline'?`<button type="button" class="chip" data-complete="${id}" aria-pressed="${v.done}">${v.done?'完了済み':'完了にする'}</button>`:''}<button type="button" class="chip" data-edit-business="${id}">編集</button><button type="button" class="chip" data-delete-business="${id}">削除</button></div></article>`).join(''):'<p class="note">日付を押して、仕事の予定や締切を追加できます。</p>');
    $('businessAgenda').querySelectorAll('[data-complete]').forEach(el=>el.onclick=async()=>{const id=el.dataset.complete;await save(()=>hooks.complete(id),'締切の状態を保存しました');});
    $('businessAgenda').querySelectorAll('[data-edit-business]').forEach(el=>el.onclick=()=>{const id=el.dataset.editBusiness,v=business().entries[id];if(!v)return;hooks.select(v.date);editing=id;tab('entry');$('businessEntryType').value=v.type;$('businessEntryTime').value=v.time;$('businessEntryTitle').value=v.title;$('businessEntryMemo').value=v.memo;$('businessRepeat').value='none';$('businessRepeat').disabled=true;$('businessEntryCancel').classList.remove('hidden');$('businessEntrySave').textContent='この1件を更新';$('businessRepeatNote').textContent='繰り返しで登録した予定も、この1件だけを変更します。';$('businessEditor').scrollIntoView?.({block:'nearest',behavior:'smooth'});});
    $('businessAgenda').querySelectorAll('[data-delete-business]').forEach(el=>el.onclick=async()=>{const id=el.dataset.deleteBusiness;if(!confirm('この仕事の予定1件を削除しますか？'))return;await save(()=>hooks.save({entries:{[id]:null}}),'予定を削除しました');if(editing===id)resetEntry();});
    lock();personalCategory();if(editing)$('businessRepeat').disabled=true;
  }
  return {render,leave(){mode=false;render();},openSettings(){setMode(true);fillSettings();$('businessSettings').open=true;$('businessSummary').scrollIntoView?.({block:'start',behavior:'smooth'});},open(date){setMode(true);if(date)hooks.select(date);},reset(){epoch++;busy=false;mode=false;editing='';selected='';settingsDirty=false;$('businessSettings').open=false;status('');resetEntry();},get active(){return mode;}};
};
