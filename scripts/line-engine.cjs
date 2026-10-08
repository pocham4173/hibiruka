const { createHash } = require('node:crypto');
const nowJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16);
const sendList = value => Array.isArray(value) ? value.filter(x => x && typeof x === 'object') : [];
const validSend = x => typeof x.id === 'string' && !!x.id && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(x.at || '') && Array.isArray(x.friendIds);
const nextSendAt = sends => sendList(sends).filter(x => x.status === 'wait' && validSend(x)).map(x => x.at).sort()[0] || null;
const PUSH_SELF = 'push:self';
// 無料で続けるための、1人あたりの月のLINE通数（1人に送ると1通）
const PER_USER_MONTHLY = 30;
const monthKey = () => nowJst().slice(0, 7).replace('-', '');
const usageRef = (db, uid) => db.collection('lineUsage').doc(`${monthKey()}_${String(uid).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`);
// 公式アカウント全体の今月の残り（LINEに聞く。無料プランの上限を超えて送らないため）
async function accountQuota(token) {
  const [q, c] = await Promise.all([lineRequest('/v2/bot/message/quota', token), lineRequest('/v2/bot/message/quota/consumption', token)]);
  if (!q.ok || !c.ok) return null;
  const quota = await q.json(), used = Number((await c.json()).totalUsage) || 0;
  const limit = quota.type === 'limited' ? Number(quota.value) || 0 : Infinity;
  return { limit, used, left: limit - used };
}
// 画面に「全体の残り」を出すための控え（だれでも読めるのは数だけ）
async function saveQuota(db, q) {
  const ref = db.collection('lineQuota').doc('current'), value = { limit: Number.isFinite(q.limit) ? q.limit : -1, used: q.used, left: Number.isFinite(q.left) ? q.left : -1, month: monthKey(), checkedAt: new Date() };
  if (typeof db.set === 'function') await db.set(ref, value); else await ref.set(value);
}
// 予約していた通数を戻す（送れなかったとき）
async function refund(db, uid, n) {
  if (!uid || !(n > 0)) return;
  const ref = usageRef(db, uid);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    tx.set(ref, { ...snap.data(), count: Math.max(0, (Number(snap.data().count) || 0) - n), updatedAt: new Date() });
  });
}
function retryKey(eventId, sendId) {
  const h = createHash('sha256').update(JSON.stringify([eventId, sendId])).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
function buildText(ev, from, note) {
  const [y,m,d] = ev.date.split('-').map(Number);
  const day = '日月火水木金土'[new Date(Date.UTC(y,m-1,d)).getUTCDay()];
  const lines = [`🔔 ${from || 'ヒビルカ'}さんから予定のお知らせ`, '', `📅 ${m}月${d}日(${day})${ev.time ? ' ' + ev.time : ''}`, `✏️ ${ev.title || ev.cat || '予定'}`];
  if (ev.place) lines.push(`📍 ${ev.place}`);
  if (ev.memo) lines.push(`📝 ${ev.memo}`);
  const words = typeof note === 'string' ? note.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\n{2,}/g, '\n').trim() : '';
  if (words) lines.push('', `💬 ${[...words].slice(0, 100).join('')}`);
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
async function runSender({db, token, validateOnly=false, recoveryAt, maxSends=Infinity, push=null}) {
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
  let sent = 0, failed = 0, processed = 0, quota;
  // 30分ごとに、全体の残りを画面用に控える（送信がなくても「残り」が分かるように。LINEへの問い合わせは無料）
  if (!recoveryAt && new Date().getUTCMinutes() % 30 === 0) { quota = await accountQuota(token).catch(() => null); if (quota) await saveQuota(db, quota).catch(() => {}); else quota = undefined; }
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
      // 送る相手（LINE）を先に確かめて、何通使うかを決める
      const ids0 = [...new Set(candidate.friendIds || [])].filter(id => typeof id === 'string' && id && id !== PUSH_SELF && !id.includes('/'));
      const refs0 = ids0.map(id => db.collection(isPersonal ? 'personalFriends' : 'friends').doc(id));
      const recipients = !refs0.length ? [] : db.getAll ? await db.getAll(...refs0) : await Promise.all(refs0.map(ref=>ref.get()));
      const userIds = [...new Set(recipients.filter(d => d.exists).map(d => d.data()).filter(f => (!isPersonal || (typeof doc.data().ownerUid === 'string' && f.ownerUid === doc.data().ownerUid)) && f.status === 'joined' && /^U[0-9a-f]{32}$/i.test(f.lineUserId || '')).map(f => f.lineUserId))];
      const need = userIds.length;
      // 公式アカウント全体の残りが足りないときは、送らずに理由を残す（無料プランなので請求はされない）
      if (need && !candidate.reserved) {
        if (quota === undefined) { quota = await accountQuota(token).catch(() => null); if (quota) await saveQuota(db, quota).catch(() => {}); }
        if (quota && quota.left < need) {
          await updateSend(db,doc.ref,candidate.id,{status:'fail',leaseUntil:0,error:'ヒビルカ全体の今月のLINE無料送信の枠がなくなったため送れませんでした。来月1日からまた送れます。「📱 アプリ通知」なら今も届きます。'});
          failed++; continue;
        }
      }
      const uRef = isPersonal && need && typeof doc.data().ownerUid === 'string' ? usageRef(db, doc.data().ownerUid) : null;
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
        // 1人あたりの月の通数：送る前に予約する（同時に動いても二重に数えない。再送では数え直さない）
        if (uRef && !item.reserved) {
          const u = await tx.get(uRef), used = u.exists ? Number(u.data().count) || 0 : 0;
          if (used + need > PER_USER_MONTHLY) {
            item.status = 'fail'; item.error = `今月のLINE送信（1人${PER_USER_MONTHLY}通まで）を使い切ったため送れませんでした。来月1日からまた送れます。「📱 アプリ通知」なら今も届きます。`;
            tx.update(doc.ref,{sends,nextSendAt:nextSendAt(sends)});
            return null;
          }
          tx.set(uRef, { ownerUid: ev.ownerUid, month: monthKey(), count: used + need, updatedAt: new Date() });
          item.reserved = need;
        }
        item.leaseUntil = Date.now() + 180000;
        item.attempts = (item.attempts || 0) + 1;
        tx.update(doc.ref,{sends});
        return {ev,item};
      });
      if (!claimed) continue;
      processed++;
      const {ev,item} = claimed;
      // 'push:self' = 自分の端末へのアプリ通知（LINEの通数を使わない）
      const wantPush = (item.friendIds || []).includes(PUSH_SELF) && isPersonal;
      const ids = ids0;
      const pushFail = 'アプリの通知を届けられませんでした。設定で「この端末に通知」をオンにし直してください。';
      // アプリ通知は1回だけ（LINEの再送のたびに何度も鳴らさない）。結果は pushResult に残す
      let pushResult = item.pushResult || '';
      if (wantPush && !pushResult) {
        if (typeof push !== 'function') { if (!ids.length) { await updateSend(db,doc.ref,item.id,{leaseUntil:0}); continue; } }
        else {
          const pushed = await push(ev.ownerUid, {title:`🔔 ${ev.title || '予定'}`, body:buildText(ev,'',item.note).replace(/^🔔[^\n]*\n+/, '').replace(/\n+ヒビルカより$/, '').slice(0, 300), url:'./?tab=list', tag:`plan-${doc.id}`}).catch(() => 0);
          pushResult = pushed ? 'ok' : 'fail';
          if (ids.length) await updateSend(db,doc.ref,item.id,{pushResult});
        }
      }
      if (wantPush && !ids.length) {
        await updateSend(db,doc.ref,item.id,pushResult === 'ok' ? {status:'sent',pushResult,sentAt:nowJst(),leaseUntil:0,error:''} : {status:'fail',pushResult,leaseUntil:0,error:pushFail});
        pushResult === 'ok' ? sent++ : failed++; continue;
      }
      // 片方だけ成功したときに、全部「送信済み」に見せないための書き添え
      const withPush = (u) => wantPush ? {...u, pushResult, ...(pushResult === 'fail' && u.status === 'sent' ? {error: pushFail} : {})} : u;
      const failWith = async (u) => { await updateSend(db,doc.ref,item.id,withPush(u)); if (u.status === 'fail') await refund(db, isPersonal ? ev.ownerUid : '', item.reserved).catch(() => {}); };
      if (!userIds.length || userIds.length > 500) {
        await failWith({status:'fail',leaseUntil:0,error:'送れる相手がいません。LINE登録を確認してください。'}); failed++; continue;
      }
      const check = await doc.ref.get();
      if (!check.exists || !sendList(check.data().sends).some(s => s.id === item.id && s.status === 'wait' && recoveryMatches(check.data(), s))) continue;
      try {
        const response = await lineRequest('/v2/bot/message/multicast',token,{
          method:'POST', headers:{'X-Line-Retry-Key':retryKey(isPersonal ? `personal:${ev.ownerUid}:${doc.id}` : doc.id,item.id)},
          body:JSON.stringify({to:userIds,messages:[{type:'text',text:buildText(ev,item.from,item.note)}]})
        });
        if (response.ok || (response.status === 409 && response.headers.has('x-line-accepted-request-id'))) {
          await updateSend(db,doc.ref,item.id,withPush({status:'sent',sentAt:nowJst(),leaseUntil:0,error:''})); sent++;
          if (quota) quota.left -= need;
        } else {
          const reason = response.status === 429 ? await Promise.resolve().then(() => response.json()).then(j => String(j?.message || ''), () => '') : '';
          if (/monthly limit/i.test(reason)) {
            // The free plan's monthly allowance is used up: nothing is charged, and retrying cannot help until next month.
            if (quota) quota.left = 0;
            await failWith({status:'fail',leaseUntil:0,error:'ヒビルカ全体の今月のLINE無料送信の枠がなくなったため送れませんでした。来月1日からまた送れます。「📱 アプリ通知」なら今も届きます。'}); failed++; continue;
          }
          const temporary = response.status === 429 || response.status >= 500;
          await failWith({status:temporary && item.attempts < 5 ? 'wait':'fail',leaseUntil:0,error:`LINEが送信を受け付けませんでした（${response.status}）。登録・ブロック・配信上限を確認してください。`});
          failed++;
        }
      } catch {
        await failWith({status:item.attempts < 5 ? 'wait':'fail',leaseUntil:0,error:'LINEとの通信を確認できませんでした。'}); failed++;
      }
    }
  }
  console.log(`完了：LINE受付 ${sent}件 / 未完了 ${failed}件`);
  return {sent,failed};
}
module.exports = { retryKey, nextSendAt, buildText, updateSend, runSender, PER_USER_MONTHLY };
