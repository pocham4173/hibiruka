const { createHash } = require('node:crypto');
const { parseServiceAccount } = require('./service-account.cjs');
const nowJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16);
const nextSendAt = sends => sends.filter(x => x.status === 'wait').map(x => x.at).sort()[0] || null;
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
    const sends = (current.data().sends || []).map(s => s.id === id && s.status === 'wait' ? {...s, ...update} : s);
    tx.update(ref, { sends, nextSendAt:nextSendAt(sends) });
  });
}
async function main() {
  const account = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (account.project_id !== 'hibiruka-f66fb') throw new Error('Firebaseの接続情報がヒビルカ用ではありません。Secretsを確認してください。');
  const token = (process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim();
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKENが未設定です。');
  const admin = require('firebase-admin');
  admin.initializeApp({credential:admin.credential.cert(account)});
  const db = admin.firestore();
  const botResponse = await lineRequest('/v2/bot/info', token);
  if (!botResponse.ok) throw new Error(`LINE接続情報を確認できません（HTTP ${botResponse.status}）。`);
  const bot = await botResponse.json();
  if (bot.basicId !== '@626hnkgo') throw new Error('LINE接続情報がヒビルカの公式アカウント用ではありません。');
  await Promise.all([db.collection('friends').limit(1).get(), db.collection('events').limit(1).get()]);
  if (process.env.VALIDATE_ONLY === 'true') {
    console.log('接続確認OK：Firebase・ヒビルカLINE。メッセージは送信していません。');
    return;
  }
  const now = nowJst();
  const snapshot = await db.collection('events').where('nextSendAt','<=',now).get();
  let sent = 0, failed = 0;
  for (const doc of snapshot.docs) {
    for (const candidate of doc.data().sends || []) {
      if (candidate.status !== 'wait' || candidate.at > now) continue;
      const claimed = await db.runTransaction(async tx => {
        const fresh = await tx.get(doc.ref);
        if (!fresh.exists) return null;
        const ev = fresh.data(), sends = ev.sends || [];
        const item = sends.find(s => s.id === candidate.id);
        if (!item || item.status !== 'wait' || item.at > now || (item.leaseUntil || 0) > Date.now()) return null;
        const deadline = `${ev.date}T${ev.time || '23:59'}`;
        if (ev.kind === 'memory' || deadline < now) {
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
      const {ev,item} = claimed;
      const ids = [...new Set(item.friendIds || [])].filter(id => typeof id === 'string' && id && !id.includes('/'));
      const recipients = await Promise.all(ids.map(id => db.collection('friends').doc(id).get()));
      const userIds = [...new Set(recipients.filter(d => d.exists).map(d => d.data()).filter(f => f.status === 'joined' && /^U[0-9a-f]{32}$/i.test(f.lineUserId || '')).map(f => f.lineUserId))];
      if (!userIds.length || userIds.length > 500) {
        await updateSend(db,doc.ref,item.id,{status:'fail',error:'送れる相手がいません。LINE登録を確認してください。'}); failed++; continue;
      }
      const check = await doc.ref.get();
      if (!check.exists || !check.data().sends?.some(s => s.id === item.id && s.status === 'wait')) continue;
      try {
        const response = await lineRequest('/v2/bot/message/multicast',token,{
          method:'POST', headers:{'X-Line-Retry-Key':retryKey(doc.id,item.id)},
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
}
if (require.main === module) main().catch(error => {
  const message = String(error.message || '');
  console.error(/^(FIREBASE_SERVICE_ACCOUNT|Firebaseの接続情報|LINE_CHANNEL_ACCESS_TOKEN|LINE接続情報)/.test(message) ? message : '自動送信を完了できませんでした。Firebaseの権限・接続設定を確認してください。秘密情報は表示しません。');
  process.exitCode = 1;
});
module.exports = { retryKey, nextSendAt, buildText, updateSend, main };
