/* A local, editable preview. Nothing is saved until approved months are submitted. */
globalThis.createPhotoCalendarReview=function({element,getConfig,onChange}){
  const P=globalThis.HibirukaPhotoCalendar,doc=element.ownerDocument;
  let months=[],expected={},approved=new Set(),index=0,selected='',source='',locked=false;
  const node=(tag,text)=>{const el=doc.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  const title=m=>`${Number(m.slice(0,4))}年${Number(m.slice(5))}月`;
  const label=kind=>kind==='unknown'?'要確認':kind?globalThis.HibirukaCalendar.companyStyle(getConfig(),kind).name:'印なし';
  function button(text,fn){const el=node('button',text);el.type='button';el.onclick=fn;el.disabled=locked;return el;}
  function render(){
    const oldPhoto=element.querySelector('.photo-review-source'),zoomed=oldPhoto?.classList.contains('zoomed'),scrollX=oldPhoto?.scrollLeft||0,scrollY=oldPhoto?.scrollTop||0;
    element.replaceChildren();element.classList.toggle('hidden',!months.length);if(!months.length)return;
    const block=months[index],month=block.month;
    const photo=node('div');photo.className='photo-review-source'+(zoomed?' zoomed':'');
    const img=node('img');img.src=source;img.alt='添付した元のカレンダー。下の読み取り結果と見比べてください。';photo.append(img);
    const zoom=button(zoomed?'写真を戻す':'写真を拡大',()=>{const large=photo.classList.toggle('zoomed');zoom.textContent=large?'写真を戻す':'写真を拡大';});zoom.className='btn sub';
    element.append(node('h3','写真とカレンダーを見比べる'),photo,zoom);photo.scrollLeft=scrollX;photo.scrollTop=scrollY;
    const nav=node('div');nav.className='photo-review-nav';
    const prev=button('前の月',()=>{index--;selected='';render();});prev.disabled=locked||index===0;
    const next=button('次の月',()=>{index++;selected='';render();});next.disabled=locked||index===months.length-1;
    nav.append(prev,node('strong',title(month)),next);element.append(nav);
    const grid=node('div');grid.className='photo-review-grid';
    P.weekdays.forEach(w=>{const h=node('span',w);h.className='photo-weekday';grid.append(h);});
    const [year,m]=month.split('-').map(Number),offset=new Date(Date.UTC(year,m-1,1)).getUTCDay();
    for(let i=0;i<offset;i++)grid.append(node('span'));
    block.days.forEach(row=>{
      const b=button('',()=>{selected=row.date;render();element.querySelector('.photo-review-editor select')?.focus({preventScroll:true});});
      b.dataset.date=row.date;b.setAttribute('aria-label',`${title(month)}${Number(row.date.slice(8))}日 ${label(row.kind)}`);b.setAttribute('aria-pressed',String(row.date===selected));
      b.append(node('b',String(Number(row.date.slice(8)))),node('small',row.kind?label(row.kind):''));
      if(row.kind==='unknown')b.classList.add('photo-unknown');
      else if(row.kind){const style=globalThis.HibirukaCalendar.companyStyle(getConfig(),row.kind);b.style.background=style.color;b.style.color=style.textColor;}
      grid.append(b);
    });element.append(grid);
    const help=node('p','日付を押すと、休日の印を直せます。');help.className='note';element.append(help);
    const row=block.days.find(r=>r.date===selected);
    if(row){
      const editor=node('label',`${title(month)}${Number(selected.slice(8))}日の印`);editor.className='photo-review-editor';
      const select=node('select');select.disabled=locked;
      P.kinds.forEach(k=>{const o=node('option',label(k));o.value=k;select.append(o);});select.value=row.kind;
      select.onchange=()=>{row.kind=select.value;approved.delete(month);render();onChange(approved.size);};editor.append(select);element.append(editor);
    }
    const removed=block.days.filter(r=>expected[r.date]&&!r.kind),changed=block.days.filter(r=>(expected[r.date]||'')!==r.kind),unknown=block.days.filter(r=>r.kind==='unknown');
    const counts=node('p',`休日などの印 ${block.days.filter(r=>r.kind&&r.kind!=='unknown').length}日 ／ 要確認 ${unknown.length}日`);counts.className='photo-review-counts';element.append(counts);
    const diff=node('p',`保存すると、この月の会社の印を入れ替えます（変更 ${changed.length}日）。`+(removed.length?`消える印：${removed.map(r=>Number(r.date.slice(8))+'日').join('・')}。`:''));diff.className='note';element.append(diff);
    const confirm=node('label');confirm.className='photo-month-confirm';
    const check=node('input');check.type='checkbox';check.dataset.month=month;check.checked=approved.has(month);check.disabled=locked||unknown.length>0;
    check.onchange=()=>{check.checked?approved.add(month):approved.delete(month);onChange(approved.size);};
    confirm.append(check,doc.createTextNode(' この月の日付・A/B・全体休み・抜けを写真と確認した'));element.append(confirm);
    if(unknown.length)element.append(node('p','「要確認」の日を押して、印を直してください。'));
    const summary=node('p',`読み取れた ${months.length}か月のうち、チェックした月だけを保存します。写真にあっても、ここに出ていない月は取り込まれません。予定・思い出・自分の有給や半休は変わりません。`);summary.className='note';element.append(summary);
  }
  return {
    open(draft,image){months=P.validateDraft(draft);expected=P.snapshot(getConfig().days,months.map(m=>m.month));approved=new Set();index=0;selected='';source=image;locked=false;render();onChange(0);},
    clear(){months=[];expected={};approved.clear();selected='';source='';element.replaceChildren();element.classList.add('hidden');},
    lock(value){locked=value;for(const el of element.querySelectorAll('button,select,input'))el.disabled=value;if(!value)render();},
    submission(){
      const selectedMonths=[...approved];
      const patch=P.replacementChanges(expected,months,selectedMonths,expected);
      return {patch,options:{photoMonths:months.filter(m=>approved.has(m.month)).map(m=>({month:m.month,days:m.days.map(r=>({...r}))})),expectedDays:{...expected}}};
    },
    get active(){return months.length>0;}
  };
};
