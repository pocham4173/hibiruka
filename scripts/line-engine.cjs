const { createHash } = require('node:crypto');
const nowJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16);
const sendList = value => Array.isArray(value) ? value.filter(x => x && typeof x === 'object') : [];
const validSend = x => typeof x.id === 'string' && !!x.id && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(x.at || '') && Array.isArray(x.friendIds);
const nextSendAt = sends => sendList(sends).filter(x => x.status === 'wait' && validSend(x)).map(x => x.at).sort()[0] || null;
function retryKey(eventId, sendId) {
  const h = createHash('sha256').update(JSON.stringify([eventId, sendId])).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
function buildText(ev, from) {
  const [y,m,d] = ev.date.split('-').map(Number);
  const day = '日月火水木金土'[new Date(Date.UTC(y,m-1,d)).getUTCDay()];
  const lines = [`🔔 ${from || 'ヒビルカ'}さんから予定のお知らせ`, '', `📅 ${m}月${d}日(${day})${ev.time ? ' ' + ev.time : ''}`, `✏️ ${ev.title || ev.cat || '予定'}`];
  if (ev.place) lines.push(`📍 ${ev.place}`);
  if (ev.memo) lines.push(`📝 ${ev.memo}`);
  lines.push('', 'ヒビルカより');
  return lines.join('\n').slice(0, 5000);
}
async function lineRequest(path, token, options = {}) {
  return fetch('https://api.line.me' + path, {
    ...options, headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}`, ...options.headers },
    signal:AbortSignal.timeout(15000)
  });
}
async function updateSend(db, ref, id, update) {
  await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (!current.exists) return;
    const sends = sendList(current.data().sends).map(s => s.id === id && s.status === 'wait' ? {...s, ...update} : s);
    tx.update(ref, { sends, nextSendAt:nextSendAt(sends) });
  });
}
async function runSender({db, token, validateOnly=false, recoveryAt, maxSends=Infinity}) {
  const botResponse = await lineRequest('/v2/bot/info', token);
  if (!botResponse.ok) throw new Error(`LINE接続情報を確認できません（HTTP ${botResponse.status}）。`);
  const bot = await botResponse.json();
  if (bot.basicId !== '@626hnkgo') throw new Error('LINE接続情報がヒビルカの公式アカウント用ではありません。');
  await Promise.all([db.collection('friends').limit(1).get(), db.collection('events').limit(1).get()]);
  if (validateOnly) {
    console.log('接続確認OK：Firebase・ヒビルカLINE。メッセージは送信していません。');
    return;
  }
  let selfId = null;
  if (recoveryAt) {
    const config = await db.collection('config').doc('app').get();
    selfId = config.data()?.selfFriendId;
    if (!selfId || typeof selfId !== 'string' || selfId.includes('/')) throw new Error('LINE接続情報：自分の登録を確認できません。');
    const self = await db.collection('friends').doc(selfId).get();
    if (!self.exists || self.data().status !== 'joined' || !/^U[0-9a-f]{32}$/i.test(self.data().lineUserId || '')) throw new Error('LINE接続情報：自分のLINE登録を確認できません。');
  }
  const recoveryMatches = (ev, item) => !recoveryAt || (item.at === recoveryAt && item.friendIds?.length === 1 && item.friendIds[0] === selfId);
  const now = nowJst();
  const legacy = await db.collection('events').where('nextSendAt','<=',now).get();
  const personal = recoveryAt ? {docs:[]} : await db.collection('personalEvents').where('nextSendAt','<=',now).get();
  const snapshot = {docs:[...legacy.docs,...personal.docs].sort((a,b) => String(a.data().nextSendAt || '').localeCompare(String(b.data().nextSendAt || '')))};
  if (recoveryAt && snapshot.docs.flatMap(doc => sendList(doc.data().sends).filter(item => item.status === 'wait' && recoveryMatches(doc.data(), item))).length > 1) throw new Error('LINE接続情報：該当する自分宛ての予約が複数あるため停止しました。');
  let sent = 0, failed = 0, processed = 0;
  for (const doc of snapshot.docs) {
    const isPersonal = doc.ref.parent?.id === "personalEvents";
    if (!Array.isArray(doc.data().sends) || sendList(doc.data().sends).length !== doc.data().sends.length || sendList(doc.data().sends).some(s => s.status === 'wait' && !validSend(s))) {
      await db.runTransaction(async tx => {
        const current = await tx.get(doc.ref);
        if (!current.exists) return;
        const raw = current.data().sends;
        const sends = sendList(raw).map(s => s.status === 'wait' && !validSend(s) ? {...s, status:'fail', error:'通知の予約データを確認してください。'} : s);
        tx.update(doc.ref, {sends, nextSendAt:nextSendAt(sends), schedulerError:'通知の予約データに不備がありました。'});
      });
      failed++;
    }
    for (const candidate of sendList(doc.data().sends)) {
      if (!validSend(candidate) || candidate.status !== 'wait' || candidate.at > now || !recoveryMatches(doc.data(), candidate)) continue;
      if (processed >= maxSends) return {sent,failed};
      const claimed = await db.runTransaction(async tx => {
        const fresh = await tx.get(doc.ref);
        if (!fresh.exists) return null;
        const ev = fresh.data(), sends = sendList(ev.sends);
        const item = sends.find(s => s.id === candidate.id);
        if (!item || !validSend(item) || !recoveryMatches(ev, item) || item.status !== 'wait' || item.at > now || (item.leaseUntil || 0) > Date.now()) return null;
        const deadline = `${ev.date}T${ev.time || '23:59'}`;
        const deadlineMs = Date.parse(deadline + ':00+09:00');
        if (ev.kind === 'memory' || !Number.isFinite(deadlineMs) || deadlineMs + 15 * 60000 < Date.now()) {
          item.status = 'fail'; item.error = '予定の日時を過ぎたため送信しませんでした。';
          tx.update(doc.ref,{sends,nextSendAt:nextSendAt(sends)});
          return null;
        }
        item.leaseUntil = Date.now() + 180000;
        item.attempts = (item.attempts || 0) + 1;
        tx.update(doc.ref,{sends});
        return {ev,item};
      });
      if (!claimed) continue;
      processed++;
      const {ev,item} = claimed;
      const ids = [...new Set(item.friendIds || [])].filter(id => typeof id === 'string' && id && !id.includes('/'));
      const refs = ids.map(id => db.collection(isPersonal ? 'personalFriends' : 'friends').doc(id));
      const recipients = !refs.length ? [] : db.getAll ? await db.getAll(...refs) : await Promise.all(refs.map(ref=>ref.get()));
      const userIds = [...new Set(recipients.filter(d => d.exists).map(d => d.data()).filter(f => (!isPersonal || (typeof ev.ownerUid === 'string' && f.ownerUid === ev.ownerUid)) && f.status === 'joined' && /^U[0-9a-f]{32}$/i.test(f.lineUserId || '')).map(f => f.lineUserId))];
      if (!userIds.length || userIds.length > 500) {
        await updateSend(db,doc.ref,item.id,{status:'fail',error:'送れる相手がいません。LINE登録を確認してください。'}); failed++; continue;
      }
      const check = await doc.ref.get();
      if (!check.exists || !sendList(check.data().sends).some(s => s.id === item.id && s.status === 'wait' && recoveryMatches(check.data(), s))) continue;
      try {
        const response = await lineRequest('/v2/bot/message/multicast',token,{
          method:'POST', headers:{'X-Line-Retry-Key':retryKey(isPersonal ? `personal:${ev.ownerUid}:${doc.id}` : doc.id,item.id)},
          body:JSON.stringify({to:userIds,messages:[{type:'text',text:buildText(ev,item.from)}]})
        });
        if (response.ok || (response.status === 409 && response.headers.has('x-line-accepted-request-id'))) {
          await updateSend(db,doc.ref,item.id,{status:'sent',sentAt:nowJst(),leaseUntil:0,error:''}); sent++;
        } else {
          const temporary = response.status === 429 || response.status >= 500;
          await updateSend(db,doc.ref,item.id,{status:temporary && item.attempts < 5 ? 'wait':'fail',leaseUntil:0,error:`LINEが送信を受け付けませんでした（${response.status}）。登録・ブロック・配信上限を確認してください。`});
          failed++;
        }
      } catch {
        await updateSend(db,doc.ref,item.id,{status:item.attempts < 5 ? 'wait':'fail',leaseUntil:0,error:'LINEとの通信を確認できませんでした。'}); failed++;
      }
    }
  }
  console.log(`完了：LINE受付 ${sent}件 / 未完了 ${failed}件`);
  return {sent,failed};
}
module.exports = { retryKey, nextSendAt, buildText, updateSend, runSender };
