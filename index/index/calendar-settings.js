/* Calendar setup: drafts stay in memory until the user explicitly saves. */
globalThis.createCalendarSettings = function(hooks) {
  const $=id=>document.getElementById(id), C=globalThis.HibirukaCalendar;
  let replaceMonth='', generation=0, busy=false, image='', pdf=null, pdfTask=null, controller=null;
  const message=text=>{$('calendarStatus').textContent=text;};
  function invalidate(){replaceMonth='';generation++;controller?.abort();controller=null;image='';pdfTask?.destroy().catch(()=>{});pdfTask=null;pdf=null;$('calendarPreview').removeAttribute('src');$('calendarFile').value='';}
  function close(){if(busy&&$('calendarSave').disabled)return;invalidate();$('calendarSheet').classList.add('hidden');}
  function setBusy(value){busy=value;for(const id of ['calendarRead','calendarSave','calendarManualSave','calendarFile','calendarPdfPage','calendarClose','calendarVerified'])$(id).disabled=value;}
  function open(date) {
    if(!hooks.canEdit()){hooks.toast('休日設定を読み込んでいます。少し待ってから開いてください');return;}
    invalidate();setBusy(false);$('calendarSource').classList.remove('hidden');
    const config=hooks.getConfig();
    $('calendarTeam').value=config.team;$('calendarRokuyo').checked=config.showRokuyo;
    $('calendarDate').value=C.validDate(date)?date:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date());
    $('calendarKind').value=config.days[$('calendarDate').value]||'';
    $('calendarYear').value=$('calendarDate').value.slice(0,4);
    $('calendarReview').classList.add('hidden');$('calendarRows').replaceChildren();
    $('calendarImport').classList.add('hidden');$('calendarManual').classList.add('hidden');
    $('calendarPdfBox').classList.add('hidden');$('calendarConfirm').checked=false;
    $('calendarSave').textContent='表示設定を保存';
    $('calendarCorrection').open=false;message('');$('calendarSheet').classList.remove('hidden');
    if(C.validDate(date))$('calendarManual').classList.remove('hidden');
  }
  const settings=()=>({team:$('calendarTeam').value,showRokuyo:$('calendarRokuyo').checked});
  async function save(patch) {
    if(busy)return;
    setBusy(true);message('保存しています…');
    try {await hooks.save(patch,settings(),replaceMonth);setBusy(false);close();hooks.toast('カレンダーを保存しました');}
    catch(e){message(e?.message||'保存できませんでした。通信を確認して、もう一度お試しください');setBusy(false);}
  }
  function toJpeg(source,width,height) {
    const scale=Math.min(1,2400/Math.max(width,height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(source,0,0,canvas.width,canvas.height);
    const result=canvas.toDataURL('image/jpeg',.9);
    if(result.length>2700000)throw Error('画像が大きいため、数か月ずつに分けて添付してください');
    return result;
  }
  async function renderPdf() {
    const g=generation, doc=pdf;
    if(!doc)return;
    const page=await doc.getPage(Number($('calendarPdfPage').value));
    if(g!==generation)return;
    const natural=page.getViewport({scale:1}),vp=page.getViewport({scale:Math.min(2,2400/Math.max(natural.width,natural.height))});
    const canvas=document.createElement('canvas');canvas.width=Math.ceil(vp.width);canvas.height=Math.ceil(vp.height);
    await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
    if(g!==generation)return;
    image=toJpeg(canvas,canvas.width,canvas.height);$('calendarPreview').src=image;
  }
  $('calendarClose').onclick=close;
  $('calendarSheet').onclick=e=>{if(e.target===$('calendarSheet'))close();};
  $('calendarChooseImport').onclick=()=>{$('calendarSource').classList.remove('hidden');$('calendarImport').classList.remove('hidden');$('calendarManual').classList.add('hidden');};
  $('calendarChooseManual').onclick=()=>{$('calendarManual').classList.remove('hidden');$('calendarImport').classList.add('hidden');};
  $('calendarDate').onchange=()=>{$('calendarKind').value=hooks.getConfig().days[$('calendarDate').value]||'';};
  $('calendarManualSave').onclick=()=>{
    replaceMonth='';
    const date=$('calendarDate').value;
    if(!C.validDate(date)){message('日付を選んでください');return;}
    save({[date]:$('calendarKind').value});
  };
  $('calendarFile').onchange=async()=>{
    const file=$('calendarFile').files[0];if(!file)return;
    invalidate();const g=generation;setBusy(true);message('添付を開いています…');$('calendarReview').classList.add('hidden');$('calendarRows').replaceChildren();$('calendarConfirm').checked=false;$('calendarPdfBox').classList.add('hidden');
    try {
      if(file.size>20*1024*1024)throw Error('20MB以下の写真・PDFを選んでください');
      if(file.type==='application/pdf'||/\.pdf$/i.test(file.name)) {
        const pdfBase='https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/';
        const lib=await import(pdfBase+'legacy/build/pdf.mjs');
        lib.GlobalWorkerOptions.workerSrc=pdfBase+'legacy/build/pdf.worker.mjs';
        const bytes=new Uint8Array(await file.arrayBuffer());
        const task=lib.getDocument({data:bytes,isEvalSupported:false,cMapUrl:pdfBase+'cmaps/',cMapPacked:true,standardFontDataUrl:pdfBase+'standard_fonts/',wasmUrl:pdfBase+'wasm/'});
        pdfTask=task;
        const loaded=await task.promise;
        if(g!==generation){task.destroy().catch(()=>{});return;}pdf=loaded;
        $('calendarPdfPage').replaceChildren(...Array.from({length:pdf.numPages},(_,i)=>new Option(`${i+1}ページ`,String(i+1))));$('calendarPdfBox').classList.remove('hidden');
        await renderPdf();
      } else {
        const url=URL.createObjectURL(file);
        try {const img=new Image();img.src=url;await img.decode();if(g!==generation)return;image=toJpeg(img,img.naturalWidth,img.naturalHeight);$('calendarPreview').src=image;}
        finally{URL.revokeObjectURL(url);}
      }
      if(g===generation)message('画像と年を確認して「休日を読み取る」を押してください。');
    }catch(e){if(g===generation)message(e.message||'開けませんでした。写真を撮り直してお試しください');}
    finally{if(g===generation)setBusy(false);}
  };
  $('calendarPdfPage').onchange=async()=>{
    image='';$('calendarReview').classList.add('hidden');$('calendarRows').replaceChildren();$('calendarConfirm').checked=false;setBusy(true);
    try{await renderPdf();message('このページの休日を読み取れます。各ページを確認・保存してから次のページを取り込んでください。');}
    catch{message('このページを開けませんでした');}finally{setBusy(false);}
  };
  $('calendarRead').onclick=async()=>{
    if(busy)return;
    if(!image){message('先にカレンダーの写真・PDFを選んでください');return;}
    replaceMonth='';
    const year=Number($('calendarYear').value);
    if(!Number.isInteger(year)||year<2000||year>2098){message('カレンダーに書かれた年を確認してください');return;}
    const g=generation;controller=new AbortController();const timer=setTimeout(()=>controller?.abort(),90000);
    setBusy(true);message('休日を読み取っています…');$('calendarReview').classList.add('hidden');$('calendarRows').replaceChildren();
    try {
      const token=await hooks.token();
      const response=await fetch(hooks.endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({year,image}),signal:controller.signal});
      const result=await response.json();
      if(!response.ok)throw Error(({limit:'今日の読み取り回数を使い切りました。手入力は引き続き使えます。',busy:'読み取りが混み合っています。時間をおいてお試しください。',auth:'ログインを確認して、もう一度お試しください。',unreadable:'読み取れませんでした。年と凡例を含めて、数か月ずつ鮮明に撮り直すか、手入力してください。'})[result.error]||'読み取りを利用できません。時間をおいて再度お試しください。手入力も使えます。');
      if(g!==generation)return;
      if(!Array.isArray(result.days)||!result.days.length||result.days.length>550)throw Error('休日を読み取れませんでした');
      for(const row of result.days) {
        if(!C.validDate(row.date)||![year,year+1].includes(+row.date.slice(0,4))||![...C.kinds,'unknown'].includes(row.kind))throw Error('読み取り結果を確認できませんでした');
      }
      renderRows(result.days);$('calendarReview').classList.remove('hidden');$('calendarConfirm').checked=false;$('calendarSave').textContent='確認した休日を保存';
      message(`${result.days.length}日を読み取りました。まだ保存していません。写真と比べて、抜け・間違いを確認してください。`);
    }catch(e){if(g===generation)message(e.name==='AbortError'?'時間がかかっているため中止しました。数か月ずつ撮り直すか、手入力してください。':e.message);}
    finally{clearTimeout(timer);if(g===generation)setBusy(false);}
  };
  function renderRows(rows) {
    const box=$('calendarRows');box.replaceChildren();
    for(const row of rows) {
      const line=document.createElement('div');line.className='calendar-review-row';
      const include=document.createElement('input');include.type='checkbox';include.checked=true;include.setAttribute('aria-label',row.date+'を取り込む');
      const date=document.createElement('input');date.type='date';date.value=row.date;date.setAttribute('aria-label','取り込む日付');
      const kind=document.createElement('select');kind.setAttribute('aria-label',row.date+'の休日の種類');
      kind.add(new Option('要確認','unknown'));for(const k of C.kinds)kind.add(new Option(C.labels[k],k));kind.value=row.kind;
      const weekday=document.createElement('small');weekday.textContent=['日','月','火','水','木','金','土'][new Date(row.date+'T12:00:00').getDay()]+'曜日';
      line.append(include,date,kind);line.append(weekday);box.append(line);
      for(const el of [include,date,kind])el.onchange=()=>{$('calendarConfirm').checked=false;weekday.textContent=C.validDate(date.value)?['日','月','火','水','木','金','土'][new Date(date.value+'T12:00:00').getDay()]+'曜日':'';};
    }
  }
  $('calendarVerified').onclick=()=>{
    if(busy)return;
    invalidate();
    const verified=C.verifiedCompanyCalendar();
    replaceMonth={from:verified.from,to:verified.to,correctUnconfirmed:true};
    renderRows(verified.rows);$('calendarSource').classList.add('hidden');
    $('calendarImport').classList.remove('hidden');$('calendarReview').classList.remove('hidden');$('calendarManual').classList.add('hidden');
    $('calendarConfirm').checked=false;$('calendarSave').textContent='このカレンダーを保存';
    message('2026年3月21日〜2027年3月20日の休日の印を、写真の'+verified.rows.length+'日へ入れ替えます。3月21日以降は未定です。以前の誤読で残った3月23日・27日・30日のA休・B休も消します。予定・記録はそのままです。');
    $('calendarReview').scrollIntoView?.({block:'start',behavior:'smooth'});
  };
  $('calendarCorrectionRead').onclick=()=>{
    if(busy)return;
    const text=$('calendarCorrectionText').value.trim();
    const match=text.match(/^(20\d{2}-(?:0[1-9]|1[0-2])) A:([\d,]*) B:([\d,]*) 全休:([\d,]*)$/);
    if(!match){message('修正データを省略せず、そのまま貼り付けてください');return;}
    const rows=[],seen=new Set();
    for(const [i,kind] of ['A','B','all'].entries())for(const n of match[i+2].split(',').filter(Boolean)){
      const date=match[1]+'-'+n.padStart(2,'0');
      if(!C.validDate(date)||seen.has(date)){message('日付が不正、または重複しています');return;}
      seen.add(date);rows.push({date,kind});
    }
    if(!rows.length){message('休日の日付がありません');return;}
    invalidate();replaceMonth=match[1];
    renderRows(rows.sort((a,b)=>a.date.localeCompare(b.date)));
    $('calendarImport').classList.remove('hidden');$('calendarReview').classList.remove('hidden');$('calendarManual').classList.add('hidden');
    $('calendarConfirm').checked=false;$('calendarSave').textContent=replaceMonth+'の休日を入れ替えて保存';
    message(replaceMonth+'の既存の休日設定を消して、この'+rows.length+'日へ入れ替えます。他の月・予定・思い出は変わりません。');
  };
  $('calendarSave').onclick=()=>{
    const patch={};
    if(!$('calendarReview').classList.contains('hidden')) {
      if(!$('calendarConfirm').checked){message('写真と読み取り結果を確認して、確認済みにチェックしてください');return;}
      for(const line of $('calendarRows').children) {
        const [include,date,kind]=line.children;if(!include.checked)continue;
        if(!C.validDate(date.value)||!C.kinds.includes(kind.value)||(replaceMonth&&(typeof replaceMonth==='string'?!date.value.startsWith(replaceMonth+'-'):date.value<replaceMonth.from||date.value>replaceMonth.to))){message('日付や「要確認」の種類を直すか、その行のチェックを外してください');return;}
        if(Object.hasOwn(patch,date.value)){message('同じ日付が重複しています。どちらかのチェックを外してください');return;}
        patch[date.value]=kind.value;
      }
      if(!Object.keys(patch).length){message('取り込む日を1日以上選んでください');return;}
    }
    save(patch);
  };
  $('calendarConfirm').onchange=()=>{if($('calendarConfirm').checked)message('確認した休日を保存できます。');};
  return {open,close,reset(){invalidate();setBusy(false);$('calendarSheet').classList.add('hidden');}};
};
