import { parseRecord, monthText, takeQuota } from './ai.mjs';
// LINEから届いたメッセージを受け取る係（Webhook）。
// - LINEの署名を確かめたリクエストだけを処理する（それ以外は401）。
// - アプリ側で作った使い捨ての連携番号を、LINEから送ってもらって本人をつなぐ。
//   アプリが自己申告したLINEユーザーIDは使わない（docs/line-webhook.md）。
// - 返事は reply API だけを使う（月の送信数に数えられない）。
// - 名前・メッセージ本文・トークンはログに出さない。
const APP_URL = 'https://pocham4173.github.io/hibiruka/index/index/';
const GUIDE_URL = 'https://pocham4173.github.io/hibiruka/guide/';
const DEFAULT_CATS = ['遊び','食事','カフェ','旅行','買い物','病院','美容院'];
const CODE = /^[A-HJ-NP-Z2-9]{10}$/;
const MAX_EVENTS = 5;

const enc = new TextEncoder();
export async function verifySignature(secret, body, signature) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  let given;
  try { given = Uint8Array.from(atob(signature), c => c.charCodeAt(0)); } catch { return false; }
  if (given.length !== mac.length) return false;
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac[i] ^ given[i];
  return diff === 0;
}

const pad = n => String(n).padStart(2, '0');
function jstNow(now = Date.now()) {
  const d = new Date(now + 9 * 3600000);
  return {date:`${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`, time:`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`};
}
const clip = (s, n) => String(s || '').slice(0, n);
const docId = id => String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
const randomId = () => { const a = new Uint8Array(12); crypto.getRandomValues(a); return [...a].map(b => b.toString(36).padStart(2,'0')).join('').slice(0,20); };

export function linkCodeFrom(text) {
  const t = String(text || '').normalize('NFKC').toUpperCase();
  const m = t.match(/[A-HJ-NP-Z2-9]{10}/);
  if (!m) return null;
  // 「ヒビルカ連携 XXXXXXXXXX」またはコードだけ
  return (t.includes('連携') || t.trim() === m[0]) ? m[0] : null;
}

async function reply(token, replyToken, messages, fetcher) {
  if (!replyToken || !messages.length) return;
  const r = await fetcher('https://api.line.me/v2/bot/message/reply', {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer ' + token},
    body:JSON.stringify({replyToken, messages:messages.slice(0, 5)}), signal:AbortSignal.timeout(10000)
  });
  if (!r.ok) throw Error('LINE reply HTTP ' + r.status);
}
const text = (t, quickReply) => ({type:'text', text:clip(t, 4900), ...(quickReply ? {quickReply} : {})});

// LINEの人 → ヒビルカの持ち主。アプリから解除されたら使わない。
export async function resolveOwner(db, lineUserId) {
  const account = await db.collection('lineAccounts').doc(lineUserId).get();
  if (!account.exists) return null;
  const {ownerUid, scope} = account.data();
  if (typeof ownerUid !== 'string' || !['personal','legacy'].includes(scope)) return null;
  const link = await db.collection('lineLinks').doc(ownerUid).get();
  if (!link.exists || link.data().lineUserId !== lineUserId) return null;
  return {uid:ownerUid, scope};
}
const eventsOf = scope => scope === 'personal' ? 'personalEvents' : 'events';
async function categories(db, owner) {
  const cfg = owner.scope === 'personal' ? await db.collection('personalConfig').doc(owner.uid).get() : await db.collection('config').doc('app').get();
  const cats = cfg.exists && Array.isArray(cfg.data().cats) && cfg.data().cats.length ? cfg.data().cats : DEFAULT_CATS.map(name => ({name}));
  return cats.filter(c => c && typeof c.name === 'string' && c.name).slice(0, 13);
}
async function ownedEvent(db, owner, id) {
  const snap = await db.collection(eventsOf(owner.scope)).doc(id).get();
  if (!snap.exists) return null;
  if (owner.scope === 'personal' && snap.data().ownerUid !== owner.uid) return null;
  return snap;
}

async function link(db, lineUserId, code, now) {
  const ref = db.collection('lineLinkCodes').doc(code);
  const snap = await ref.get();
  if (!snap.exists) return '番号が見つかりませんでした。アプリの「設定」→「LINEから記録する」で、もう一度「LINEとつなぐ」を押してください。';
  const {ownerUid, scope, expiresAt} = snap.data();
  await db.remove(ref); // 使い捨て
  if (!(expiresAt instanceof Date) || expiresAt.getTime() < now) return '番号の有効期限（10分）が切れています。アプリでもう一度「LINEとつなぐ」を押してください。';
  if (typeof ownerUid !== 'string' || !ownerUid || ownerUid.includes('/')) return 'つなげませんでした。';
  // 持ち主の確認（作成時のルールでも確認済み）
  if (scope === 'personal') {
    if (!(await db.collection('personalConfig').doc(ownerUid).get()).exists) return 'つなげませんでした。';
  } else if (scope === 'legacy') {
    const [member, owners] = await Promise.all([db.collection('members').doc(ownerUid).get(), db.collection('config').doc('owners').get()]);
    if (!member.exists && !(owners.exists && (owners.data().uids || []).includes(ownerUid))) return 'つなげませんでした。';
  } else return 'つなげませんでした。';
  const old = await db.collection('lineLinks').doc(ownerUid).get();
  const ops = [
    {ref:db.collection('lineAccounts').doc(lineUserId), value:{ownerUid, scope, linkedAt:new Date(now)}},
    {ref:db.collection('lineLinks').doc(ownerUid), value:{lineUserId, linkedAt:new Date(now)}}
  ];
  // この持ち主に前につながっていた別のLINEは外す
  if (old.exists && old.data().lineUserId && old.data().lineUserId !== lineUserId) ops.push({ref:db.collection('lineAccounts').doc(old.data().lineUserId), remove:true});
  await db.commit(ops);
  return 'ヒビルカとつながりました🎉\n\n' + HELP;
}

const HELP = [
  'このトークでできること',
  '💬 話しかけるだけで記録',
  '　「10/12 14時 歯医者」→ 予定に入る',
  '　「昨日ゆかちゃんとランチ行った」→ 思い出に',
  '📍 位置情報を送る → その場所を「思い出」に記録',
  '「今日」と送る → 今日の予定・記録',
  '「また行きたい」と送る → また行きたいリスト',
  '「ふりかえり」と送る → 今月の思い出をAIがまとめる',
  '',
  '写真やくわしい内容は、アプリで追加できます。',
  APP_URL,
  '',
  '📖 写真つきの使い方',
  GUIDE_URL
].join('\n');

// つながっていない人（予定のお知らせを受け取っている友だちなど）向け
const GUEST_HELP = [
  'ヒビルカは、予定と思い出をひとつに残せるアプリです。',
  '無料・ダウンロード不要で使えます。',
  '',
  '📖 写真つきの使い方',
  GUIDE_URL,
  '',
  '▶ アプリを開く',
  APP_URL
].join('\n');
const GUEST_CONNECT = 'この機能は、ヒビルカのアプリとつなぐと使えます。\nアプリの「設定」→「LINEから記録する」からつないでください。\n\n📖 使い方\n' + GUIDE_URL;

async function addLocation(db, owner, ev, now) {
  const loc = ev.message;
  const lat = Number(loc.latitude), lng = Number(loc.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [text('位置情報を読み取れませんでした。')];
  const cats = await categories(db, owner);
  const {date, time} = jstNow(now);
  const place = clip(loc.title || shortAddress(loc.address) || '送った場所', 100);
  const id = 'line_' + (docId(ev.webhookEventId) || randomId());
  const data = {
    cat:cats[0]?.name || '遊び', kind:'memory', date, time, who:[], place, title:'',
    memo:loc.address && loc.address !== place ? clip(loc.address, 300) : '', link:'', fav:false, thumbs:[],
    sends:[], nextSendAt:null, lat, lng, source:'line', createdAt:new Date(now), updatedAt:new Date(now)
  };
  if (owner.scope === 'personal') data.ownerUid = owner.uid;
  try { await db.create(db.collection(eventsOf(owner.scope)).doc(id), data); }
  catch (e) { if (e.status !== 409 && e.code !== 'ALREADY_EXISTS') throw e; } // 再送は1件にまとめる
  const quickReply = {items:cats.map((c, i) => ({type:'action', action:{type:'postback', label:clip(c.label || c.name, 20), data:`a=cat&e=${id}&c=${i}`, displayText:clip(c.label || c.name, 20)}}))};
  return [text(`📍「${place}」を、今日の思い出に記録しました。\n何の記録ですか？下から選べます。`, quickReply)];
}

async function setCategory(db, owner, data) {
  const p = new URLSearchParams(data);
  if (p.get('a') !== 'cat') return [];
  const id = docId(p.get('e')), i = Number(p.get('c'));
  if (!id || !Number.isInteger(i) || i < 0) return [];
  const snap = await ownedEvent(db, owner, id);
  if (!snap) return [text('その記録は見つかりませんでした。')];
  const cat = (await categories(db, owner))[i];
  if (!cat) return [text('分類が見つかりませんでした。アプリで変えてください。')];
  await db.patch(snap.ref, {cat:cat.name, updatedAt:new Date()});
  return [text(`「${cat.label || cat.name}」で記録しました。`)];
}

async function listToday(db, owner, now) {
  const {date} = jstNow(now);
  let q = db.collection(eventsOf(owner.scope));
  if (owner.scope === 'personal') q = q.where('ownerUid', '==', owner.uid);
  const docs = (await q.where('date', '==', date).select('date', 'time', 'title', 'place', 'cat').get()).docs.map(d => d.data()).sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  if (!docs.length) return [text('今日の予定・記録はまだありません。')];
  return [text('📅 今日の予定・記録\n\n' + docs.map(e => `${e.time ? e.time + ' ' : ''}${e.title || e.place || e.cat || '記録'}${e.title && e.place ? '（' + e.place + '）' : ''}`).join('\n'))];
}

async function listFavorites(db, owner) {
  let q = db.collection(eventsOf(owner.scope));
  if (owner.scope === 'personal') q = q.where('ownerUid', '==', owner.uid);
  const docs = (await q.where('fav', '==', true).select('place', 'title', 'cat').limit(40).get()).docs.map(d => d.data());
  if (!docs.length) return [text('「また行きたい」はまだありません。アプリで記録に♥をつけると、ここに出ます。')];
  return [text('♥ また行きたい\n\n' + docs.map(e => '・' + (e.place || e.title || e.cat || '記録')).join('\n') + '\n\nほかはアプリで見られます。')];
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const jpDate = d => { const [y, m, dd] = d.split('-').map(Number); return `${m}月${dd}日(${WEEK[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]})`; };
const AI_LIMIT = 'AIは1日20回までです。また明日送ってください。（位置情報での記録は、いつでも使えます）';

// 💬 話しかけるだけで記録：AIが文を読んで、予定か思い出を1件作る
async function fromText(db, env, owner, ev, message, now) {
  const quota = await takeQuota(db, owner.uid, now);
  if (!quota.ok) return [text(AI_LIMIT)];
  const cats = await categories(db, owner);
  const {date: today, time: nowTime} = jstNow(now);
  let r;
  try { r = await parseRecord(env, message, today, cats.map(c => c.name)); }
  catch { return [text('うまく読み取れませんでした。少し待ってもう一度送ってください。')]; }
  if (r.type === 'none') return [text('予定や思い出として記録するときは、こんなふうに送ってください。\n\n「10/12 14時 歯医者」\n「明日 ゆかちゃんとランチ」\n「昨日 上田城でお花見した」\n\n「使い方」と送ると、できることを確認できます。')];
  if (!r.date) return [text('いつの予定か分かりませんでした。\n「10/12 14時 歯医者」「来週の土曜 ランチ」のように、日にちも入れて送ってください。')];
  if (!r.title && !r.place) return [text('何の予定か分かりませんでした。「10/12 14時 歯医者」のように送ってください。')];
  const id = 'line_' + (docId(ev.webhookEventId) || randomId());
  const data = {
    cat:r.cat || cats[0]?.name || '遊び', kind:r.type === 'plan' ? 'plan' : 'memory', date:r.date, time:r.time || (r.type === 'memory' && r.date === today ? nowTime : ''),
    who:r.who, place:r.place, title:r.title, memo:r.diary, link:'', fav:false, thumbs:[], sends:[], nextSendAt:null,
    source:'line', createdAt:new Date(now), updatedAt:new Date(now)
  };
  if (owner.scope === 'personal') data.ownerUid = owner.uid;
  try { await db.create(db.collection(eventsOf(owner.scope)).doc(id), data); }
  catch (e) { if (e.status !== 409 && e.code !== 'ALREADY_EXISTS') throw e; }
  const what = [data.title || data.place, data.title && data.place ? '📍' + data.place : '', data.who.length ? '👥' + data.who.join('・') : ''].filter(Boolean).join('　');
  const when = jpDate(data.date) + (data.time ? ' ' + data.time : '');
  const quickReply = {items:[{type:'action', action:{type:'postback', label:'取り消す', data:`a=del&e=${id}`, displayText:'取り消す'}}]};
  if (data.kind === 'plan') return [text(`📅 予定に入れました\n${when}\n${what}\n\nLINEで誰かに届けるときは、アプリで予定を開いて「LINEで予定を送る」を押してください。\nちがっていたら「取り消す」を押してください。`, quickReply)];
  return [text(`📝 思い出に記録しました\n${when}\n${what}${data.memo ? '\n\n' + data.memo : ''}\n\n写真はアプリで追加できます。ちがっていたら「取り消す」を押してください。`, quickReply)];
}

// LINEから作った記録だけ、1日以内なら取り消せる
async function undoRecord(db, owner, postback, now) {
  const id = docId(new URLSearchParams(postback).get('e'));
  const snap = id && await ownedEvent(db, owner, id);
  if (!snap) return [text('その記録は見つかりませんでした（もう取り消し済みかもしれません）。')];
  const d = snap.data(), made = d.createdAt instanceof Date ? d.createdAt.getTime() : 0;
  if (d.source !== 'line' || now - made > 864e5) return [text('この記録は、アプリから消してください。')];
  await db.remove(snap.ref);
  return [text('取り消しました。')];
}

// 「ふりかえり」：その月の思い出をAIがまとめる
async function lookBack(db, env, owner, monthsAgo, now) {
  if (!env.AI) return [text('ふりかえりは、いま準備中です。')];
  const j = new Date(now + 9 * 3600000); j.setUTCDate(1); j.setUTCMonth(j.getUTCMonth() - monthsAgo);
  const ym = `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}`, label = `${j.getUTCFullYear()}年${j.getUTCMonth() + 1}月`;
  const {date: today} = jstNow(now);
  let q = db.collection(eventsOf(owner.scope));
  if (owner.scope === 'personal') q = q.where('ownerUid', '==', owner.uid);
  const rows = (await q.select('date', 'title', 'place', 'cat', 'memo', 'fav', 'kind').limit(400).get()).docs.map(d => d.data())
    .filter(e => String(e.date || '').startsWith(ym) && (e.kind === 'memory' || e.date < today) && (e.title || e.place))
    .sort((a, b) => a.date < b.date ? -1 : 1).slice(0, 40)
    .map(e => ({date:e.date, title:clip(e.title, 40), place:clip(shortAddress(e.place), 40), cat:clip(e.cat, 20), memo:clip(e.memo, 60), fav:!!e.fav}));
  if (!rows.length) return [text(`${label}の思い出はまだありません。位置情報を送ったり、「昨日 ランチ行った」と送ったりすると記録できます。`)];
  const quota = await takeQuota(db, owner.uid, now);
  if (!quota.ok) return [text(AI_LIMIT)];
  let body;
  try { body = await monthText(env, label, rows); } catch { body = ''; }
  if (!body) return [text('うまくまとめられませんでした。少し待ってもう一度送ってください。')];
  return [text(`✨ ${label}のふりかえり（${rows.length}件）\n\n${body}`)];
}

// LINE gives "日本、〒386-0013 長野県…"; the country and postal code only add noise.
export const shortAddress = s => String(s || '').replace(/^日本[、,]\s*/, '').replace(/^〒?\s*\d{3}-?\d{4}\s*/, '').trim();

export async function handleEvent(db, env, ev, now = Date.now()) {
  const userId = ev.source?.type === 'user' ? ev.source.userId : null;
  if (!userId || !/^U[0-9a-f]{32}$/i.test(userId)) return [];
  const msg = ev.type === 'message' ? ev.message : null;
  if (msg?.type === 'text') {
    const code = linkCodeFrom(msg.text);
    if (code && CODE.test(code)) return [text(await link(db, userId, code, now))];
  }
  if (msg?.type === 'text' && /お問い?合わせ/.test(msg.text)) return [text('ご質問・ご要望は、このトークにそのまま送ってください。確認してお返事します。')];
  const owner = await resolveOwner(db, userId);
  if (!owner) {
    // つながっていない人。予定のお知らせを受け取っている友だちもここ。
    if (msg && msg.type !== 'text') return [text('ヒビルカのアプリとつなぐと、位置情報を送るだけで記録できます。\nアプリの「設定」→「LINEから記録する」からつないでください。\n' + APP_URL + '\n\n📖 使い方\n' + GUIDE_URL)];
    const g = msg?.type === 'text' ? msg.text.normalize('NFKC').trim() : '';
    if (/^(使い方|説明書|ヘルプ|help)$/i.test(g)) return [text(GUEST_HELP)];
    if (/^(今日|きょう)(の予定)?$|^また行きたい$|ふりかえり|振り返り/.test(g)) return [text(GUEST_CONNECT)];
    return []; // ふつうの文字は返事しない（手動でのやりとり用）
  }
  if (ev.type === 'postback') return new URLSearchParams(ev.postback?.data || '').get('a') === 'del' ? undoRecord(db, owner, ev.postback.data, now) : setCategory(db, owner, ev.postback?.data || '');
  if (!msg) return [];
  if (msg.type === 'location') return addLocation(db, owner, ev, now);
  if (msg.type === 'image') return [text('写真からの記録は、これから使えるようになります。今はアプリの記録に写真を追加してください。\n' + APP_URL)];
  if (msg.type !== 'text') return [];
  const t = msg.text.normalize('NFKC').trim();
  if (/^(今日|きょう)(の予定)?$/.test(t)) return listToday(db, owner, now);
  if (/^また行きたい$/.test(t)) return listFavorites(db, owner);
  if (/^(使い方|説明書|ヘルプ|help)$/i.test(t)) return [text(HELP)];
  const look = t.match(/^(今月|先月)?の?(ふりかえり|振り返り)$|^(今月|先月)$/);
  if (look) return lookBack(db, env, owner, (look[1] || look[3]) === '先月' ? 1 : 0, now);
  if (env.AI && t.length >= 2 && t.length <= 200) return fromText(db, env, owner, ev, t, now);
  return [text('位置情報を送ると記録できます。「使い方」と送ると、できることを確認できます。')];
}

export async function handleWebhook(request, env, {db, fetcher = fetch, now = Date.now} = {}) {
  if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN) return new Response('Not configured', {status:503});
  const body = await request.text();
  if (body.length > 200000 || !(await verifySignature(env.LINE_CHANNEL_SECRET, body, request.headers.get('x-line-signature')))) return new Response('Unauthorized', {status:401});
  let payload;
  try { payload = JSON.parse(body); } catch { return new Response('Bad request', {status:400}); }
  const events = Array.isArray(payload.events) ? payload.events.slice(0, MAX_EVENTS) : [];
  if (!events.length) return new Response('OK'); // LINE Developersの「検証」
  const database = await db();
  for (const ev of events) {
    try {
      const messages = await handleEvent(database, env, ev, now());
      await reply(env.LINE_CHANNEL_ACCESS_TOKEN, ev.replyToken, messages, fetcher);
    } catch {
      console.error('Hibiruka webhook event failed.'); // 本文・名前・トークンは出さない
      try { await reply(env.LINE_CHANNEL_ACCESS_TOKEN, ev.replyToken, [text('うまく受け取れませんでした。少し待ってもう一度送ってください。')], fetcher); } catch {}
    }
  }
  return new Response('OK');
}
