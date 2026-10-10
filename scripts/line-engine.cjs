const { createHash, randomUUID } = require('node:crypto');
const nowJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16);
const sendList = value => Array.isArray(value) ? value.filter(x => x && typeof x === 'object') : [];
const validSend = x => typeof x.id === 'string' && !!x.id && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(x.at || '') && Array.isArray(x.friendIds);
const nextSendAt = sends => sendList(sends).filter(x => x.status === 'wait' && validSend(x)).map(x => x.at).sort()[0] || null;
const cancelsOf = ev => new Set(Array.isArray(ev?.sendCancels) ? ev.sendCancels.filter(x => typeof x === 'string') : []);
const PUSH_SELF = 'push:self';
// 無料で続けるための、1人あたりの月のLINE通数（1人に送ると1通）
const PER_USER_MONTHLY = 30;
const LEASE_MS = 180000;
const MAX_LINE_ATTEMPTS = 5;
const MAX_PUSH_TRIES = 3;
const monthKey = () => nowJst().slice(0, 7).replace('-', '');
/* 月の境目（日本時間）。LINEが受け付けた時刻が翌月になると、確保した月と実際に使った月がずれる。
   境目の前3分〜後1分はLINEの送信要求を出さない（アプリ通知はそのまま送る）。 */
const EDGE_BEFORE_MS = 3 * 60000, EDGE_AFTER_MS = 60000;
function nearMonthEdge(ms = Date.now()) {
  const j = new Date(ms + 9 * 3600000), y = j.getUTCFullYear(), m = j.getUTCMonth();
  const start = Date.UTC(y, m, 1) - 9 * 3600000, next = Date.UTC(y, m + 1, 1) - 9 * 3600000;
  return next - ms < EDGE_BEFORE_MS || ms - start < EDGE_AFTER_MS;
}
const cleanUid = uid => String(uid).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
const usageRef = (db, uid, month = monthKey()) => db.collection('lineUsage').doc(`${month}_${cleanUid(uid)}`);
// アプリ内の「予約枠」：通数を確保したが、まだLINEの実使用量に反映されていない分（送信確定・返却で減らす）
const holdRef = (db, month) => db.collection('lineQuota').doc(`hold_${month}`);
// 送信台帳：1つの予約（予定×お知らせ）につき1件。サーバーだけが読み書きする（利用者のルールでは触れない）
const LEDGER = 'sendLedger';
const ledgerId = (coll, eventId, sendId) => createHash('sha256').update(JSON.stringify([coll, eventId, sendId])).digest('hex').slice(0, 40);

const TEXT = {
  quota_all: 'ヒビルカ全体の今月のLINE無料送信の枠がなくなったため、LINEは送れませんでした。来月1日からまた送れます。',
  quota_user: `今月のLINE送信（1人${PER_USER_MONTHLY}通まで）を使い切ったため、LINEは送れませんでした。来月1日からまた送れます。`,
  limit: 'ヒビルカ全体の今月のLINE無料送信の枠がなくなったため、LINEは送れませんでした。来月1日からまた送れます。',
  nobody: '送れる相手がいません。LINE登録を確認してください。',
  rejected: 'LINEが送信を受け付けませんでした。登録・ブロックを確認してください。',
  busy: 'LINEが混み合っていて送れませんでした。',
  unknown: 'LINEとの通信を確認できず、届いたかどうか分かりません。重ねて送らないよう、再送はしていません。',
  expired: '予定の日時を過ぎたため、送っていないお知らせは送りませんでした。',
  cancelled: '取り消しました。',
  pushFail: 'アプリ通知を送れませんでした。設定で「この端末で通知を受け取る」をやり直してください。',
  pushUnknown: 'アプリ通知の送信結果を確認できませんでした。重ねて送らないよう、再送はしていません。',
  changed: '送り先のLINE登録が変わったため、このお知らせはLINEでは送りませんでした。必要なら、もう一度予約してください。',
  legacy: '送信の仕組みを更新したため、このお知らせはLINEでは送りませんでした。必要なら、もう一度予約してください。',
  waiting: 'LINEの状態を確認できないため、LINEはあとで送ります。',
  edge: '月の変わり目のため、LINEは少しあとで送ります。'
};

// 公式アカウント全体の今月の残り（LINEに聞く。無料プランの上限を超えて送らないため）
// 分からないとき（通信の失敗・おかしな返事）は null。null は「残りあり」ではなく「分からない」として、LINEを送らずに待つ
async function accountQuota(token) {
  const [q, c] = await Promise.all([lineRequest('/v2/bot/message/quota', token), lineRequest('/v2/bot/message/quota/consumption', token)]);
  if (!q.ok || !c.ok) return null;
  const quota = await q.json(), usage = await c.json();
  const used = typeof usage?.totalUsage === 'number' ? usage.totalUsage : Number.NaN;
  const limit = quota?.type === 'limited' && typeof quota.value === 'number' ? quota.value : quota?.type === 'none' ? Infinity : Number.NaN;
  if (!Number.isFinite(used) || used < 0 || Number.isNaN(limit) || limit < 0) return null;
  return { limit, used, left: limit - used };
}
// 画面に「全体の残り」を出すための控え（だれでも読めるのは数だけ）。アプリ内の予約枠は引いて見せる
async function saveQuota(db, q, held = 0) {
  const ref = db.collection('lineQuota').doc('current');
  const left = Number.isFinite(q.left) ? Math.max(0, q.left - held) : -1;
  const value = { limit: Number.isFinite(q.limit) ? q.limit : -1, used: q.used, left, month: monthKey(), checkedAt: new Date() };
  if (typeof db.set === 'function') await db.set(ref, value); else await ref.set(value);
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
// 互換用（古い呼び出し）：待ち状態の行だけを書き換える
async function updateSend(db, ref, id, update) {
  await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (!current.exists) return;
    const sends = sendList(current.data().sends).map(s => s.id === id && s.status === 'wait' ? {...s, ...update} : s);
    tx.update(ref, { sends, nextSendAt:nextSendAt(sends) });
  });
}

/* ---------- 台帳（通数・処理中の印・手段ごとの結果） ---------- */
// LINEの再送キーは、最初のリクエストから24時間だけ有効。結果が分からないものは、この期限の少し前までしか確かめない
const KEY_TTL_MS = 24 * 3600000, KEY_MARGIN_MS = 10 * 60000;
function newLedger({coll, eventId, sendId, ownerUid, item, isPersonal}) {
  const wantLine = (item.friendIds || []).some(id => id !== PUSH_SELF);
  const wantPush = isPersonal && (item.friendIds || []).includes(PUSH_SELF);
  return {
    v: 2, coll, eventId, sendId, ownerUid: typeof ownerUid === 'string' ? ownerUid : '',
    month: '', holds: [], lineState: wantLine ? 'todo' : 'off', lineReason: '', lineCount: 0, lineFriends: [], lineUnsure: false, lineInflight: false,
    // 初回の送信で固定する本文と宛先（再送でも同じもの）。LINEを閉じたら消す
    linePayload: null, firstSentMs: null, tries: [],
    // 以前の版で「アプリ通知は送信済み」になっていたものは、重ねて鳴らさない（偽っても本人の通知が止まるだけ）
    pushState: wantPush ? (item.pushResult === 'ok' ? 'ok' : 'todo') : 'off', pushTries: 0, pushInflight: false,
    attempts: 0, leaseUntil: 0, leaseToken: '', createdMs: Date.now(), updatedMs: Date.now()
  };
}
const linePending = l => l.lineState === 'todo' || l.lineState === 'held';
const pushPending = l => l.pushState === 'todo' || (l.pushState === 'fail' && l.pushTries < MAX_PUSH_TRIES);
const triesOf = l => Array.isArray(l.tries) ? l.tries.filter(t => t && typeof t === 'object') : [];
// 受け付けられたかもしれない送信が、これまでに1回でもあったか
const everUnsure = l => !!l.lineUnsure || !!l.lineInflight || triesOf(l).some(t => t.result === 'unsure' || t.result === 'inflight');
// 同じ再送キーで、まだ確かめてよいか（受け付けられた可能性がないなら、期限は関係ない）
function keyUsable(l, now = Date.now()) {
  if (!everUnsure(l)) return true;
  if (l.keyWindowUnknown || !Number.isFinite(l.firstSentMs)) return false; // 初回の時刻が分からない：推測で再送しない
  return now < l.firstSentMs + KEY_TTL_MS - KEY_MARGIN_MS;
}
/* 確保の記録（holds）：どの月の枠から何通確保したか。月をまたいだ再確認では、今月分を「仮」に足す。
   - refund（返す）：個人の数と予約枠を減らす（受け付けられていないと確定した分）
   - confirm（使った）：個人の数は残し、予約枠から「確定」へ移す（受け付けられた分・受け付けられたかもしれない分） */
function holdsOf(l) {
  if (Array.isArray(l.holds)) return l.holds.map(h => ({...h}));
  // PR #99 で作った台帳（holds がない）：月と数から読み替える
  return l.lineState === 'held' && l.lineCount ? [{ month: l.month || monthKey(), count: l.lineCount }] : [];
}
const addDelta = (d, month, key, n) => { if (!n) return; d[month] ||= { usage: 0, hold: 0, sent: 0 }; d[month][key] += n; };
const refundHold = (d, h) => { addDelta(d, h.month, 'usage', -h.count); addDelta(d, h.month, 'hold', -h.count); };
const confirmHold = (d, h) => { addDelta(d, h.month, 'hold', -h.count); addDelta(d, h.month, 'sent', h.count); };
// LINEを閉じる。送れたか分からない分は返さない（安全側）
function closeLine(l, reason, d) {
  if (l.lineState === 'todo') { l.lineState = 'blocked'; l.lineReason = reason; }
  else if (l.lineState === 'held') {
    const holds = holdsOf(l);
    if (everUnsure(l)) { holds.forEach(h => confirmHold(d, h)); l.lineState = 'unknown'; l.lineReason = reason === 'cancelled' || reason === 'expired' ? reason : 'unknown'; }
    else { holds.forEach(h => refundHold(d, h)); l.lineState = 'returned'; l.lineReason = reason; }
    l.holds = [];
  }
  l.lineInflight = false; l.linePayload = null;
}
/* 受け付けられた。
   200（今回受け付け）：今回の月の分だけ使う。前の試行は受け付けられていなかった（受け付け済みなら409になる）。
   409（前に受け付け済み）：結果が分からなかった試行のどれか。月が1つに決まればその月、決まらなければ候補の月を全部使ったことにする（少なく数えない） */
function acceptLine(l, d, now, month) {
  const holds = holdsOf(l);
  let used;
  if (now) used = new Set([month]);
  else {
    const cand = new Set(triesOf(l).filter(t => t.result === 'unsure').map(t => t.month));
    used = cand.size ? cand : new Set(holds.map(h => h.month)); // 記録がない（以前の台帳）：全部使ったことにする
  }
  holds.forEach(h => (used.has(h.month) ? confirmHold : refundHold)(d, h));
  l.month = [...used].sort().pop() || l.month; l.acceptedMonths = [...used].sort();
  l.lineState = 'sent'; l.lineUnsure = false; l.lineInflight = false; l.lineReason = ''; l.holds = []; l.linePayload = null;
}
function closePush(l) {
  if (l.pushInflight) { l.pushState = 'unknown'; l.pushInflight = false; }
  if (l.pushState === 'todo') l.pushState = 'skipped';
}
// 台帳の内容を、利用者に見せる行（sends[]）へ写す。内部の印（予約数・ロック・回数・本文・宛先）は行に残さない
function mirror(item, l, closedReason) {
  const { reserved, leaseUntil, attempts, ...rest } = item;
  const out = { ...rest };
  const lineWanted = l.lineState !== 'off', pushWanted = l.pushState !== 'off';
  const pending = !closedReason && ((lineWanted && linePending(l)) || (pushWanted && pushPending(l)));
  const waiting = l.lineState === 'todo' && ['quota_check', 'line_down', 'month_edge'].includes(l.lineReason);
  out.lineResult = !lineWanted ? '' : l.lineState === 'sent' ? 'sent' : l.lineState === 'unknown' ? 'unknown'
    : ['returned', 'blocked'].includes(l.lineState) ? (l.lineReason || 'fail') : (l.attempts > 0 && l.lineState === 'held') || waiting ? 'retry' : '';
  out.pushResult = !pushWanted ? '' : l.pushState === 'ok' ? 'ok' : l.pushState === 'unknown' ? 'unknown' : l.pushState === 'fail' ? 'fail'
    : l.pushState === 'skipped' && closedReason ? closedReason : '';
  if (closedReason === 'cancelled') out.cancelDone = true; // サーバーが取り消しを確かめた印（画面の「確認中」を終える）
  const ok = (lineWanted && l.lineState === 'sent' ? 1 : 0) + (pushWanted && l.pushState === 'ok' ? 1 : 0);
  const wanted = (lineWanted ? 1 : 0) + (pushWanted ? 1 : 0);
  if (pending) out.status = 'wait';
  else if (closedReason === 'cancelled' && ok === 0) out.status = 'cancelled';
  else out.status = ok === wanted ? 'sent' : ok > 0 ? 'partial' : 'fail';
  const lineText = { quota_all: TEXT.quota_all, quota_user: TEXT.quota_user, limit: TEXT.limit, nobody: TEXT.nobody, rejected: TEXT.rejected, busy: TEXT.busy, unknown: TEXT.unknown, expired: TEXT.expired, cancelled: TEXT.cancelled, changed: TEXT.changed, legacy: TEXT.legacy }[out.lineResult] || '';
  const pushText = out.pushResult === 'fail' && !pushPending(l) ? TEXT.pushFail : out.pushResult === 'unknown' ? TEXT.pushUnknown : '';
  out.lineError = ['sent', 'retry', 'cancelled'].includes(out.lineResult) ? (waiting ? (l.lineReason === 'month_edge' ? TEXT.edge : TEXT.waiting) : '') : lineText;
  out.pushError = pushText;
  if (l.lineState === 'unknown') out.lineError = TEXT.unknown;
  out.error = out.status === 'cancelled' ? [TEXT.cancelled, out.lineError, out.pushError].filter(Boolean).join('\n')
    : [out.lineError, out.pushError].filter(Boolean).join('\n') || (closedReason === 'expired' && out.status !== 'sent' ? TEXT.expired : '');
  if (ok && !out.sentAt) out.sentAt = nowJst();
  return out;
}
// 個人の数・予約枠を月ごとに読む（トランザクションでは、書く前に全部読む）
async function readCounters(tx, db, l, d, isPersonal, extraMonths = []) {
  const out = {};
  for (const month of new Set([...Object.keys(d), ...extraMonths])) {
    const c = out[month] = { month };
    if (isPersonal && l.ownerUid) { c.uRef = usageRef(db, l.ownerUid, month); c.u = await tx.get(c.uRef); }
    c.hRef = holdRef(db, month); c.h = await tx.get(c.hRef);
  }
  return out;
}
const countOf = (snap, key = 'count') => snap?.exists ? Number(snap.data()[key]) || 0 : 0;
function writeCounters(tx, l, d, cs) {
  for (const [month, x] of Object.entries(d)) {
    const c = cs[month]; if (!c) continue;
    if (c.uRef && x.usage && (x.usage > 0 || c.u.exists)) tx.set(c.uRef, { ownerUid: l.ownerUid, month, count: Math.max(0, countOf(c.u) + x.usage), updatedAt: new Date() });
    if ((x.hold || x.sent) && (x.hold > 0 || x.sent > 0 || c.h.exists)) tx.set(c.hRef, { month, count: Math.max(0, countOf(c.h) + x.hold), sent: Math.max(0, countOf(c.h, 'sent') + x.sent), updatedAt: new Date() });
  }
}
function writeItem(tx, ref, ev, id, next) {
  const sends = sendList(ev.sends).map(s => s.id === id ? next : s);
  tx.update(ref, { sends, nextSendAt: nextSendAt(sends) });
}
function deadlinePassed(ev) {
  const deadlineMs = Date.parse(`${ev.date}T${ev.time || '23:59'}:00+09:00`);
  return ev.kind === 'memory' || !Number.isFinite(deadlineMs) || deadlineMs + 15 * 60000 < Date.now();
}
// 今月の枠で n 通を確保できるか（分からなければ 'quota_check'）。できるなら d に足す
function reserveIn(d, cs, month, n, quota, isPersonal) {
  if (!quota || quota.month !== month) return 'quota_check'; // 前の月に取った残りは使わない
  const c = cs[month], held = countOf(c.h) + (d[month]?.hold || 0), used = countOf(c.u) + (d[month]?.usage || 0);
  const sentSince = Math.max(0, countOf(c.h, 'sent') - (quota.sentMark || 0));
  // 全体：LINEの実使用量の残りから、確定前の予約分と、聞いた後に確定した分を引いて足りるか。個人：今月30通まで
  if (quota.left - sentSince - held < n) return 'quota_all';
  if (isPersonal && (!c.uRef || used + n > PER_USER_MONTHLY)) return 'quota_user';
  if (c.uRef) addDelta(d, month, 'usage', n);
  addDelta(d, month, 'hold', n);
  return '';
}
const sameFriend = (a, b) => !!b && b.lineUserId === a.lineUserId;

async function runSender({db, token, validateOnly=false, recoveryAt, maxSends=Infinity, push=null}) {
  // LINEの接続確認。失敗しても、アプリ通知は止めない（LINEだけあとで送る）。確認だけの実行・自分宛ての復旧は、従来どおり止める
  let lineOk = true, lineProblem = '';
  try {
    const botResponse = await lineRequest('/v2/bot/info', token);
    if (!botResponse.ok) { lineOk = false; lineProblem = `LINE接続情報を確認できません（HTTP ${botResponse.status}）。`; }
    else if ((await botResponse.json()).basicId !== '@626hnkgo') { lineOk = false; lineProblem = 'LINE接続情報がヒビルカの公式アカウント用ではありません。'; }
  } catch { lineOk = false; lineProblem = 'LINEとの通信を確認できませんでした。'; }
  if (!lineOk && (validateOnly || recoveryAt)) throw new Error(lineProblem);
  if (!lineOk) console.error('LINEを確認できないため、このときはLINEを送りません（アプリ通知は送ります）。');
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
  const minute = new Date().getUTCMinutes();
  // LINEに残りを聞く。聞く直前の「アプリが送信確定した数」を控え、その後に確定した分は自分で引く（同時実行でも上限を超えない）
  const fetchQuota = async () => {
    if (!lineOk) return null;
    const month = monthKey();
    const h = await holdRef(db, month).get().catch(() => null), hd = h?.exists ? h.data() : {};
    const q = await accountQuota(token).catch(() => null);
    if (!q) return null;
    q.sentMark = Number(hd.sent) || 0; q.month = month;
    await saveQuota(db, q, Number(hd.count) || 0).catch(() => {});
    return q;
  };
  // 30分ごとに、全体の残りを画面用に控える（送信がなくても「残り」が分かるように。LINEへの問い合わせは無料）
  if (!recoveryAt && lineOk && minute % 30 === 0) quota = (await fetchQuota()) || undefined;
  // 取り残された確保分（予定を消した・取り消した後に止まった等）を返す。数分に1回、少しずつ
  if (!recoveryAt && minute % 5 === 2) await sweepHeld(db).catch(() => {});
  for (const doc of snapshot.docs) {
    const isPersonal = doc.ref.parent?.id === "personalEvents";
    const coll = isPersonal ? 'personalEvents' : 'events';
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
      if (processed >= maxSends) return {sent,failed,lineOk};
      const lRef = db.collection(LEDGER).doc(ledgerId(coll, doc.id, candidate.id));
      const pre = await lRef.get(), preL = pre.exists ? pre.data() : null;
      const fixed = Array.isArray(preL?.linePayload?.friends) ? preL.linePayload.friends : null;
      // 送る相手（LINE）を確かめる。初回の送信のあとは、固定した相手だけを確かめる
      const ids0 = fixed ? fixed.map(f => f.id).filter(id => typeof id === 'string' && id && !id.includes('/')).slice(0, 20)
        : [...new Set(candidate.friendIds || [])].filter(id => typeof id === 'string' && id && id !== PUSH_SELF && !id.includes('/')).slice(0, 20);
      const refs0 = ids0.map(id => db.collection(isPersonal ? 'personalFriends' : 'friends').doc(id));
      const recipients = !refs0.length ? [] : db.getAll ? await db.getAll(...refs0) : await Promise.all(refs0.map(ref=>ref.get()));
      const owner = doc.data().ownerUid;
      const valid = recipients.map((d, i) => d.exists ? {id: ids0[i], f: d.data()} : null).filter(x => x && (!isPersonal || (typeof owner === 'string' && x.f.ownerUid === owner)) && x.f.status === 'joined' && /^U[0-9a-f]{32}$/i.test(x.f.lineUserId || ''));
      const validMap = new Map(valid.map(x => [x.id, x.f]));
      const need = new Set(valid.map(x => x.f.lineUserId)).size;
      const mayNeedQuota = lineOk && (!preL || preL.lineState === 'todo' || (preL.lineState === 'held' && !holdsOf(preL).some(h => h.month === monthKey())));
      if (quota && quota.month !== monthKey()) quota = undefined; // 月が変わった：全体の残りを取り直す
      if (mayNeedQuota && need && quota === undefined) quota = await fetchQuota();
      const token0 = randomUUID();
      const claimed = await db.runTransaction(async tx => {
        const fresh = await tx.get(doc.ref);
        const ledger = await tx.get(lRef);
        if (!fresh.exists) return null; // 予定が消えた：確保分は見回りで返す
        const ev = fresh.data(), item = sendList(ev.sends).find(s => s.id === candidate.id);
        if (!item || !validSend(item) || !recoveryMatches(ev, item) || item.status !== 'wait' || item.at > now) return null;
        const l = ledger.exists ? {...ledger.data()} : newLedger({coll, eventId: doc.id, sendId: item.id, ownerUid: ev.ownerUid, item, isPersonal});
        if ((l.leaseUntil || 0) > Date.now()) return null;
        if (JSON.stringify(l.linePayload?.friends || null) !== JSON.stringify(fixed)) return null; // 読んでいる間に変わった：次の回に
        const before = JSON.stringify(l);
        // 前回が途中で止まっていた：アプリ通知は送ったか分からないので重ねて送らない。LINEは「結果不明」として扱う
        if (l.pushInflight) { l.pushState = 'unknown'; l.pushInflight = false; }
        if (l.lineInflight) {
          l.lineInflight = false; l.lineUnsure = true;
          l.tries = triesOf(l).map(t => t.result === 'inflight' ? {...t, result: 'unsure'} : t);
        }
        // 以前の版の台帳（初回の時刻・本文の控えがない）で、もう送ったことがあるもの
        if (l.lineState === 'held' && !l.linePayload && (l.attempts || 0) > 0) l.keyWindowUnknown = true;
        const d = {}, cur = monthKey(), edge = nearMonthEdge();
        const closed = cancelsOf(ev).has(item.id) ? 'cancelled' : deadlinePassed(ev) ? 'expired' : '';
        let reserveCur = 0, probe = false, lineWait = false;
        if (closed) {
          closeLine(l, closed, d); closePush(l);
        } else if (l.lineState === 'held') {
          if (!keyUsable(l)) closeLine(l, 'unknown', d); // 24時間を過ぎた・初回の時刻が分からない：同じキーで確かめられないので、結果不明で終える
          else if (!l.linePayload) closeLine(l, 'legacy', d); // 本文の控えがない以前の台帳：同じキーで別の内容を送らない
          else if (!l.linePayload.friends.every(f => sameFriend(f, validMap.get(f.id)))) closeLine(l, 'changed', d); // 相手の登録が変わった
          else if (!lineOk || edge) lineWait = true;
          else if (!holdsOf(l).some(h => h.month === cur)) {
            // 月をまたいだ再送
            if (!everUnsure(l)) { holdsOf(l).forEach(h => refundHold(d, h)); l.holds = []; reserveCur = l.linePayload.to.length; } // 前月は受け付けられていない：今月で確保し直す
            else if (holdsOf(l).some(h => h.probe)) closeLine(l, 'unknown', d); // もう一度月が変わった：これ以上は確かめない
            else { probe = true; reserveCur = l.linePayload.to.length; } // 結果不明：今送ると今月の分になるので、今月にも仮で確保して確かめる
          }
        } else if (l.lineState === 'todo') {
          if (!need) { l.lineState = 'blocked'; l.lineReason = 'nobody'; }
          else if (!lineOk) { lineWait = true; l.lineReason = 'line_down'; }
          else if (edge) { lineWait = true; l.lineReason = 'month_edge'; } // 月の境目：どちらの月で使うか決まらないので、少し待つ
          else reserveCur = need;
        }
        const cs = await readCounters(tx, db, l, d, isPersonal && typeof ev.ownerUid === 'string', [...(reserveCur ? [cur] : []), ...holdsOf(l).map(h => h.month)]);
        if (reserveCur) {
          const reason = reserveIn(d, cs, cur, reserveCur, quota, isPersonal);
          if (reason === 'quota_check') { lineWait = true; if (l.lineState === 'todo') l.lineReason = 'quota_check'; } // 残りが分からない：送らずに待つ（数えない）
          else if (reason && probe) closeLine(l, 'unknown', d); // 確かめると今月分を使うかもしれないが、枠がない：確かめない（前月分は返さない）
          else if (reason) { if (l.lineState === 'held') { l.lineState = 'returned'; l.holds = []; l.linePayload = null; l.lineReason = reason; } else { l.lineState = 'blocked'; l.lineReason = reason; } }
          else if (probe) l.holds = [...holdsOf(l), { month: cur, count: reserveCur, probe: true }];
          else if (l.lineState === 'held') l.holds = [{ month: cur, count: reserveCur }];
          else {
            // 初回：この時点の本文と宛先を固定する（再送では同じものを使う）
            const fr = valid.map(x => ({ id: x.id, lineUserId: x.f.lineUserId }));
            l.month = cur; l.lineState = 'held'; l.lineReason = ''; l.lineCount = need; l.lineFriends = fr.map(x => x.id);
            l.holds = [{ month: cur, count: need }];
            l.linePayload = { to: [...new Set(fr.map(x => x.lineUserId))].slice(0, need), text: buildText(ev, item.from, item.note), friends: fr };
          }
        }
        const doLine = !closed && l.lineState === 'held' && !lineWait && lineOk && !!l.linePayload;
        const doPush = !closed && pushPending(l) && typeof push === 'function';
        if (doLine || doPush) {
          l.leaseUntil = Date.now() + LEASE_MS; l.leaseToken = token0; l.attempts = (l.attempts || 0) + 1;
          if (doLine) {
            if (!Number.isFinite(l.firstSentMs)) l.firstSentMs = Date.now();
            l.lineInflight = true; // 送る直前の印。返事が来たら外す（止まったら「結果不明」）
            l.tries = [...triesOf(l), { ms: Date.now(), month: cur, result: 'inflight' }].slice(-12);
          }
          if (doPush) l.pushInflight = true;
        }
        // アプリ通知の送り手がいない実行では、行は待ちのまま（送れる実行に任せる）
        const waitingForPushSender = !closed && pushPending(l) && typeof push !== 'function';
        const next = mirror(item, l, closed);
        if (waitingForPushSender && next.status !== 'wait') next.status = 'wait';
        l.updatedMs = Date.now();
        // 何も変わらない待ち（LINEの確認待ちなど）は書かない（無料枠の書き込みを使わない）
        const changed = JSON.stringify({...l, updatedMs: 0}) !== JSON.stringify({...JSON.parse(before), updatedMs: 0}) || JSON.stringify(next) !== JSON.stringify(item) || Object.keys(d).length;
        if (changed) {
          tx.set(lRef, l);
          writeCounters(tx, l, d, cs);
          writeItem(tx, doc.ref, ev, item.id, next);
        }
        return doLine || doPush ? {ev, item, l, doLine, doPush, closed, sendMonth: cur} : {done: next.status, closed};
      });
      if (!claimed) continue;
      if (claimed.done) { if (claimed.done === 'fail') failed++; continue; }
      processed++;
      const {ev, item, l, doLine, doPush, sendMonth} = claimed;
      // 1) アプリ通知（Web Push）：LINEの枠や障害に関係なく実行する。成功は「送信処理の成功」（端末に届いたかは分からない）
      let pushOk = null;
      if (doPush) {
        const pushed = await push(ev.ownerUid, {title:`🔔 ${ev.title || '予定'}`, body:buildText(ev,'',item.note).replace(/^🔔[^\n]*\n+/, '').replace(/\n+ヒビルカより$/, '').slice(0, 300), url:'./?tab=list', tag:`plan-${doc.id}`}).catch(() => 0);
        pushOk = !!pushed;
      }
      // 2) LINE：初回に固定した本文・宛先を、同じ再送キーで送る
      let lineOutcome = null, reqId = '';
      // 送る直前に、確保した月のままか・月の境目でないかを確かめる（アプリ通知の間に月が変わることがある）
      if (doLine && (monthKey() !== sendMonth || nearMonthEdge())) lineOutcome = {kind:'skipped'};
      else if (doLine) {
        try {
          const response = await lineRequest('/v2/bot/message/multicast',token,{
            method:'POST', headers:{'X-Line-Retry-Key':retryKey(isPersonal ? `personal:${ev.ownerUid}:${doc.id}` : doc.id,item.id)},
            body:JSON.stringify({to:l.linePayload.to,messages:[{type:'text',text:l.linePayload.text}]})
          });
          reqId = String(response.headers?.get?.('x-line-request-id') || response.headers?.get?.('x-line-accepted-request-id') || '').slice(0, 80);
          if (response.ok) lineOutcome = {kind:'sent', now:true};
          else if (response.status === 409 && response.headers.has('x-line-accepted-request-id')) lineOutcome = {kind:'sent', now:false}; // 前の試行のどれかで受け付け済み
          else if (response.status === 429) {
            const reason = await Promise.resolve().then(() => response.json()).then(j => String(j?.message || ''), () => '');
            // 月の上限：LINEは受け付けていない（無料プランなので請求もない）。来月まで再送しても無駄
            lineOutcome = /monthly limit/i.test(reason) ? {kind:'rejected', reason:'limit'} : {kind:'retry', reason:'busy'};
          } else if (response.status >= 500) lineOutcome = {kind:'retry', unsure:true, reason:'unknown'};
          else lineOutcome = {kind:'rejected', reason:'rejected'};
        } catch { lineOutcome = {kind:'retry', unsure:true, reason:'unknown'}; }
      }
      // 3) 結果を台帳と行に書く（通数の確定・返却も同じトランザクションで）
      const result = await db.runTransaction(async tx => {
        const fresh = await tx.get(doc.ref);
        const ledger = await tx.get(lRef);
        if (!ledger.exists) return null;
        const l2 = {...ledger.data()}, d = {};
        if (l2.leaseToken !== token0) return null; // 別の実行に引き継がれた
        if (doPush) { l2.pushInflight = false; l2.pushTries = (l2.pushTries || 0) + 1; l2.pushState = pushOk ? 'ok' : 'fail'; }
        if (doLine && l2.lineState === 'held' && lineOutcome.kind === 'skipped') {
          // 送っていない：試行を「送らず」にして、次の回に新しい月の枠で確かめ直す（確保はそのまま。次の回で返す・取り直す）
          l2.lineInflight = false;
          l2.tries = triesOf(l2).map((t, i, a) => i === a.length - 1 && t.result === 'inflight' ? {...t, result: 'skipped'} : t);
          l2.attempts = Math.max(0, (l2.attempts || 0) - 1);
          if (!triesOf(l2).some(t => t.result !== 'skipped')) l2.firstSentMs = null;
        } else if (doLine && l2.lineState === 'held') {
          l2.lineInflight = false;
          const tries = triesOf(l2), last = tries[tries.length - 1];
          const res = lineOutcome.kind === 'sent' ? (lineOutcome.now ? 'accepted' : 'clear') : lineOutcome.unsure ? 'unsure' : 'clear';
          if (last && last.result === 'inflight') tries[tries.length - 1] = {...last, result: res, ...(reqId ? {reqId} : {})};
          l2.tries = tries;
          if (lineOutcome.unsure) l2.lineUnsure = true;
          if (lineOutcome.kind === 'sent') acceptLine(l2, d, lineOutcome.now, last?.month || monthKey());
          else if (lineOutcome.kind === 'rejected') closeLine(l2, lineOutcome.reason, d); // 前に結果不明があれば「結果不明」で閉じる（返さない）
          else { l2.lineReason = lineOutcome.reason; if ((l2.attempts || 0) >= MAX_LINE_ATTEMPTS || !keyUsable(l2)) closeLine(l2, lineOutcome.reason, d); }
        }
        l2.leaseUntil = 0; l2.updatedMs = Date.now();
        const ev2 = fresh.exists ? fresh.data() : null;
        const item2 = ev2 && sendList(ev2.sends).find(s => s.id === item.id);
        // 送っている間に取り消された／予定が消えた：まだ送っていない分だけ閉じる（送った分はそのまま記録）
        const closed = !ev2 || !item2 ? 'cancelled' : cancelsOf(ev2).has(item.id) ? 'cancelled' : '';
        if (closed) { closeLine(l2, 'cancelled', d); closePush(l2); }
        const c = await readCounters(tx, db, l2, d, isPersonal);
        tx.set(lRef, l2);
        writeCounters(tx, l2, d, c);
        if (item2) { const next = mirror(item2, l2, closed); writeItem(tx, doc.ref, ev2, item.id, next); return next.status; }
        return 'gone';
      });
      if (lineOutcome?.kind === 'rejected' && lineOutcome.reason === 'limit' && quota) quota.left = 0;
      if (result === 'sent' || result === 'partial') sent++; else if (result !== 'wait') failed++; else if (lineOutcome?.kind === 'retry' || pushOk === false) failed++;
    }
  }
  console.log(`完了：受付 ${sent}件 / 未完了 ${failed}件${lineOk ? '' : '（LINEは確認できず保留）'}`);
  return {sent,failed,lineOk};
}
// 見回り：処理中でない「確保済み」の台帳のうち、予定が消えた・行が消えた・取り消し済み・期限切れのものを閉じて返す。
// 1回に見る数は少しだけ。台帳のIDの順に、前回の続きから見る（先頭の台帳が残っていても、全部に順番が回る）
const SWEEP_STATE = ['schedulerStatus', 'sweep'];
async function sweepHeld(db, limit = 2) {
  const stRef = db.collection(SWEEP_STATE[0]).doc(SWEEP_STATE[1]);
  const st = await stRef.get().catch(() => null), after = st?.exists && typeof st.data().after === 'string' ? st.data().after : '';
  let q = db.collection(LEDGER).where('lineState', '==', 'held').orderBy('__name__');
  if (after) q = q.startAfter(after);
  const rows = (await q.limit(limit).get()).docs;
  // 最後まで見たら、次は先頭から
  const next = rows.length < limit ? '' : rows[rows.length - 1].id;
  const value = { after: next, checkedAt: new Date() };
  if (typeof db.set === 'function') await db.set(stRef, value).catch(() => {}); else await stRef.set(value).catch(() => {});
  for (const row of rows) {
    const r = row.data();
    if ((r.leaseUntil || 0) > Date.now() || Date.now() - (r.updatedMs || 0) < 10 * 60000) continue;
    if (!['events', 'personalEvents'].includes(r.coll) || typeof r.eventId !== 'string' || !r.eventId || r.eventId.includes('/')) continue;
    const eRef = db.collection(r.coll).doc(r.eventId);
    await db.runTransaction(async tx => {
      const ledger = await tx.get(row.ref);
      const ev = await tx.get(eRef);
      if (!ledger.exists) return;
      const l = {...ledger.data()};
      if (l.lineState !== 'held' || (l.leaseUntil || 0) > Date.now()) return;
      const e = ev.exists ? ev.data() : null, item = e && sendList(e.sends).find(s => s.id === l.sendId);
      const closed = !e || !item || item.status !== 'wait' ? 'cancelled' : cancelsOf(e).has(l.sendId) ? 'cancelled' : deadlinePassed(e) ? 'expired' : '';
      if (!closed) return; // まだ送る予定の行は、通常の送信処理に任せる
      const d = {};
      closeLine(l, closed, d); closePush(l); l.updatedMs = Date.now();
      const c = await readCounters(tx, db, l, d, r.coll === 'personalEvents');
      tx.set(row.ref, l);
      writeCounters(tx, l, d, c);
      if (item && item.status === 'wait') writeItem(tx, eRef, e, l.sendId, mirror(item, l, closed));
    });
  }
}
module.exports = { retryKey, nextSendAt, buildText, updateSend, runSender, sweepHeld, ledgerId, nearMonthEdge, PER_USER_MONTHLY, LEDGER, KEY_TTL_MS };
