import { parseRecord, monthText, takeQuota } from './ai.mjs';
import { isInquiryWord, inquiryStart, inquiryPick, inquiryReceive } from './inquiry.mjs';
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
  '「今日」と送る → 今日の予定と、これからの予定（あと◯日）',
  '「また行きたい」と送る → おすすめ機能の説明（行きたいリスト・おでかけコース）',
  '「行きたいリスト」と送る → あなたが集めた場所（地図つき）',
  '「ふりかえり」と送る → 今月の思い出をAIがまとめる',
  '　「先月」「8月のふりかえり」「2025年12月」のように前の月も',
  '',
  '「お問い合わせ」と送る → 不具合・ご意見を送る',
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
  APP_URL,
  '',
  '✉️ 不具合・ご意見は「お問い合わせ」と送ってください'
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

// 日付 → 「あと◯日」（今日を0として）
const daysBetween = (a, b) => Math.round((Date.UTC(...b.split('-').map((x, i) => i === 1 ? x - 1 : +x)) - Date.UTC(...a.split('-').map((x, i) => i === 1 ? x - 1 : +x))) / 86400000);
const addDay = (d, n) => { const [y, m, dd] = d.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, dd + n)); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`; };
async function listToday(db, owner, now) {
  const {date} = jstNow(now);
  const base = () => { let q = db.collection(eventsOf(owner.scope)); if (owner.scope === 'personal') q = q.where('ownerUid', '==', owner.uid); return q; };
  const days = Array.from({length: 31}, (_, i) => addDay(date, i));
  let rows;
  try { rows = (await Promise.all([days.slice(0, 16), days.slice(16)].map(part => base().where('date', 'in', part).select('date', 'time', 'title', 'place', 'cat', 'kind').limit(200).get()))).flatMap(r => r.docs).map(d => d.data()); }
  catch { rows = (await base().where('date', '==', date).select('date', 'time', 'title', 'place', 'cat', 'kind').get()).docs.map(d => d.data()); }
  const byTime = (a, b) => (a.date + String(a.time || '')).localeCompare(b.date + String(b.time || ''));
  const name = e => `${e.title || e.place || e.cat || '記録'}${e.title && e.place ? '（' + e.place + '）' : ''}`;
  const today = rows.filter(e => e.date === date).sort(byTime);
  const next = rows.filter(e => e.date > date && e.kind !== 'memory' && e.kind !== 'wish').sort(byTime).slice(0, 8);
  const parts = [today.length ? '📅 今日の予定・記録\n' + today.map(e => `${e.time ? e.time + ' ' : ''}${name(e)}`).join('\n') : '📅 今日の予定・記録はまだありません。'];
  if (next.length) parts.push('🎉 これからの予定\n' + next.map(e => { const n = daysBetween(date, e.date); return `${n === 1 ? '明日' : `あと${n}日`}｜${jpDate(e.date)}${e.time ? ' ' + e.time : ''} ${name(e)}`; }).join('\n'));
  else parts.push('これから30日の予定はまだありません。「10/12 14時 歯医者」のように送ると入ります。');
  return [text(parts.join('\n\n'))];
}

// また行きたい（♥）と行きたいリストを、地図・アプリのボタンつきのカードで
const mapLink = e => Number.isFinite(e.lat) && Number.isFinite(e.lng) ? `https://www.google.com/maps/search/?api=1&query=${(+e.lat).toFixed(6)},${(+e.lng).toFixed(6)}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.place || e.title || '')}`;
function placeCard(e, badge) {
  const img = /^https:\/\//.test(e.imageUrl || '') ? e.imageUrl : '';
  return {type: 'bubble', size: 'kilo',
    ...(img ? {hero: {type: 'image', url: img, size: 'full', aspectRatio: '20:13', aspectMode: 'cover'}} : {}),
    body: {type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      {type: 'text', text: badge, size: 'xs', color: '#ad4564', weight: 'bold'},
      {type: 'text', text: clip(shortAddress(e.place) || e.title || '場所', 40), weight: 'bold', size: 'md', wrap: true},
      ...(e.genre || e.cat ? [{type: 'text', text: clip(e.genre || e.cat, 30), size: 'xs', color: '#888888'}] : []),
    ]},
    footer: {type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      {type: 'button', style: 'primary', color: '#1f2d4a', height: 'sm', action: {type: 'uri', label: '🗺 地図で見る', uri: mapLink(e)}},
      {type: 'button', style: 'secondary', height: 'sm', action: {type: 'uri', label: '📅 アプリで予定にする', uri: APP_URL + '?tab=find'}},
    ]}};
}
// 「また行きたい」を押したら、まずおすすめ機能の説明カード（写真つき）を見せる
const GUIDE_IMG = 'https://pocham4173.github.io/hibiruka/guide/img/';
const introCard = (img, badge, title, lines, uri, label) => ({type: 'bubble', size: 'kilo',
  hero: {type: 'image', url: GUIDE_IMG + img, size: 'full', aspectRatio: '20:13', aspectMode: 'cover', action: {type: 'uri', uri: GUIDE_URL + '#wish'}},
  body: {type: 'box', layout: 'vertical', spacing: 'sm', contents: [
    {type: 'text', text: badge, size: 'xs', color: '#ad4564', weight: 'bold'},
    {type: 'text', text: title, weight: 'bold', size: 'md', wrap: true},
    ...lines.map(t => ({type: 'text', text: t, size: 'sm', color: '#555555', wrap: true})),
  ]},
  footer: {type: 'box', layout: 'vertical', contents: [{type: 'button', style: 'primary', color: '#1f2d4a', height: 'sm', action: {type: 'uri', label, uri}}]}});
export const WISH_INTRO = [
  introCard('line-wish-1.jpg', '✨ おすすめ機能 1', '📌 行きたいリスト', ['「探す」で見つけた場所の「ここ行きたい！」で集まります。', '予定に入れる → 行ったら思い出に、までつながります。'], APP_URL + '?tab=find', 'アプリで探してみる'),
  introCard('line-wish-2.jpg', '✨ おすすめ機能 2', '🧭 おでかけコース', ['行きたい場所を「コースに入れる」で集めて、順番と時間を決めるだけ。', 'AIにおまかせも、予定にまとめて入れるのもワンタップ。'], APP_URL + '?tab=find', 'コースを作ってみる'),
  introCard('line-wish-3.jpg', '✨ おすすめ機能 3', '☀️ 行く日の天気に合わせて', ['行く場所と日を選ぶと、その日の天気と、雨なら屋内・晴れなら公園などのおすすめが出ます。'], GUIDE_URL + '#find', '写真つきの使い方'),
];
async function listFavorites(db, owner) {
  const base = () => { let q = db.collection(eventsOf(owner.scope)); if (owner.scope === 'personal') q = q.where('ownerUid', '==', owner.uid); return q; };
  const [fav, wish] = await Promise.all([
    base().where('fav', '==', true).select('place', 'title', 'cat', 'lat', 'lng').limit(40).get(),
    base().where('kind', '==', 'wish').select('place', 'title', 'genre', 'lat', 'lng', 'imageUrl', 'status').limit(40).get().catch(() => ({docs: []})),
  ]);
  const favs = fav.docs.map(d => d.data()), wishes = wish.docs.map(d => d.data()).filter(w => w.status !== 'visited');
  if (!favs.length && !wishes.length) return [text('「また行きたい」はまだありません。\n・行った思い出に ♥ を付ける\n・アプリの「探す」で「📌 ここ行きたい！」を押す\nと、ここに集まります。\n\n📖 使い方\n' + GUIDE_URL + '#wish')];
  const seen = new Set(), cards = [];
  for (const [e, badge] of [...wishes.map(w => [w, '📌 行きたいリスト']), ...favs.map(f => [f, '♥ また行きたい'])]) {
    const k = String(e.place || e.title || ''); if (!k || seen.has(k)) continue; seen.add(k); cards.push(placeCard(e, badge));
    if (cards.length >= 8) break;
  }
  cards.push({type: 'bubble', size: 'kilo', body: {type: 'box', layout: 'vertical', spacing: 'md', contents: [
    {type: 'text', text: '📖 もっと楽しむコツ', weight: 'bold', size: 'md'},
    {type: 'text', text: '行きたい場所を集めて、行く日の天気に合わせた「おでかけコース」にできます。', size: 'sm', wrap: true, color: '#555555'},
  ]}, footer: {type: 'box', layout: 'vertical', spacing: 'sm', contents: [
    {type: 'button', style: 'primary', color: '#ad4564', height: 'sm', action: {type: 'uri', label: '写真つきの使い方', uri: GUIDE_URL + '#wish'}},
    {type: 'button', style: 'secondary', height: 'sm', action: {type: 'uri', label: 'アプリで探す', uri: APP_URL + '?tab=find'}},
  ]}});
  const list = [...seen].slice(0, 20).map(n => '・' + n).join('\n');
  return [{type: 'flex', altText: `♥ また行きたい・行きたいリスト（${seen.size}か所）`, contents: {type: 'carousel', contents: cards}}, text(`♥ また行きたい・📌 行きたいリスト\n${list}`)];
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
  catch (e) { r = {type:'error', diag:'X:' + String(e?.message || '').replace(/[^\x20-\x7e]/g, '').slice(0, 30)}; }
  if (r.type === 'error') { console.error('Hibiruka LINE AI failed: ' + r.diag); return [text(`うまく読み取れませんでした。少し待ってもう一度送ってください。\n（${r.diag}）`)]; }
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
  if (data.kind === 'plan') return [text(`📅 予定に入れました\n${when}\n${what}\n\nLINEやアプリ通知で知らせるときは、アプリで予定を開いて「予定を知らせる」を押してください。\nちがっていたら「取り消す」を押してください。`, quickReply)];
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

// 「ふりかえり」「先月」「先々月」「3か月前」「8月のふりかえり」「2025年12月」→ 何か月前か（ふりかえりでなければ null）
export function monthsAgoFrom(t, now) {
  const s = String(t || '').normalize('NFKC').replace(/\s+/g, '').replace(/の?(ふりかえり|振り返り)$/, '').replace(/の/g, '');
  const asked = /(ふりかえり|振り返り)/.test(String(t).normalize('NFKC'));
  const j = new Date(now + 9 * 3600000), y = j.getUTCFullYear(), m = j.getUTCMonth() + 1;
  if (asked && (s === '' || s === '今月')) return 0;
  if (s === '今月') return 0;
  if (s === '先月') return 1;
  if (s === '先々月') return 2;
  let x = s.match(/^(\d{1,2})(か|ヶ|ケ|カ)?月前$/); if (x) return Math.min(+x[1], 36);
  if (s === '去年' || s === '昨年') return asked ? 12 : null;
  x = s.match(/^(?:(\d{4})年|(去年|昨年))?(\d{1,2})月$/);
  if (x && (asked || x[1] || x[2]) && +x[3] >= 1 && +x[3] <= 12) {
    const yy = x[1] ? +x[1] : x[2] ? y - 1 : (+x[3] > m ? y - 1 : y); // 先の月なら去年のこと
    const ago = (y - yy) * 12 + (m - +x[3]);
    return ago >= 0 && ago <= 36 ? ago : null;
  }
  return null;
}
const monthQuick = ago => ({items: [ago + 1, ago + 2, ago + 3].filter(n => n <= 36).map(n => ({type: 'action', action: {type: 'message', label: n === 1 ? '先月' : n === 2 ? '先々月' : `${n}か月前`, text: n === 1 ? '先月のふりかえり' : n === 2 ? '先々月のふりかえり' : `${n}か月前のふりかえり`}}))});
// 実際にあったか（アプリ index.html の isDone と同じ。中止が付いたものは、種類が何でも入れない）
export const isDoneRecord = (e, today) => e.outcome !== 'cancelled' && (e.kind === 'memory' || (e.kind !== 'memory' && e.kind !== 'wish' && !!e.date && e.date < today && e.outcome === 'done'));
// 「ふりかえり」：その月の思い出をAIがまとめる
async function lookBack(db, env, owner, monthsAgo, now) {
  if (!env.AI) return [text('ふりかえりは、いま準備中です。')];
  const j = new Date(now + 9 * 3600000); j.setUTCDate(1); j.setUTCMonth(j.getUTCMonth() - monthsAgo);
  const ym = `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}`, label = `${j.getUTCFullYear()}年${j.getUTCMonth() + 1}月`;
  const {date: today} = jstNow(now);
  const base = () => { let q = db.collection(eventsOf(owner.scope)); if (owner.scope === 'personal') q = q.where('ownerUid', '==', owner.uid); return q; };
  const fieldsOf = q => q.select('date', 'title', 'place', 'cat', 'memo', 'fav', 'kind', 'outcome');
  // Read only that month (two "in" queries of up to 16 days) so a look-back costs a few reads, not every record.
  const days = Array.from({length: new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth() + 1, 0)).getUTCDate()}, (_, i) => `${ym}-${pad(i + 1)}`);
  let found;
  try { found = (await Promise.all([days.slice(0, 16), days.slice(16)].map(part => fieldsOf(base().where('date', 'in', part)).limit(200).get()))).flatMap(r => r.docs); }
  catch (e) { console.error('Hibiruka look-back month query failed, reading recent records instead: ' + String(e?.message || '').slice(0, 80)); found = (await fieldsOf(base()).limit(400).get()).docs; }
  const rows = found.map(d => d.data())
    // 実際にあったことだけ：思い出、または予定で「行った」を選んだもの（日付が過ぎただけの予定・中止は入れない。アプリの isDone と同じ判定）
    .filter(e => String(e.date || '').startsWith(ym) && isDoneRecord(e, today) && (e.title || e.place))
    .sort((a, b) => a.date < b.date ? -1 : 1).slice(0, 40)
    .map(e => ({date:e.date, title:clip(e.title, 40), place:clip(shortAddress(e.place), 40), cat:clip(e.cat, 20), memo:clip(e.memo, 60), fav:!!e.fav}));
  if (!rows.length) return [text(`${label}の思い出はまだありません。位置情報を送ったり、「昨日 ランチ行った」と送ったりすると記録できます。\n前の月も見られます👇`, monthQuick(monthsAgo))];
  const quota = await takeQuota(db, owner.uid, now);
  if (!quota.ok) return [text(AI_LIMIT)];
  let r;
  try { r = await monthText(env, label, rows); } catch (e) { r = {text:'', diag:'X:' + String(e?.message || '').replace(/[^\x20-\x7e]/g, '').slice(0, 30)}; }
  if (!r.text) { console.error('Hibiruka LINE look-back failed: ' + r.diag); return [text(`うまくまとめられませんでした。少し待ってもう一度送ってください。\n（${r.diag}）`)]; }
  return [text(`✨ ${label}のふりかえり（${rows.length}件）\n\n${r.text}\n\n前の月もふりかえれます👇（「8月のふりかえり」のように送ってもOK）`, monthQuick(monthsAgo))];
}

// LINE gives "日本、〒386-0013 長野県…"; the country and postal code only add noise.
export const shortAddress = s => String(s || '').replace(/^日本[、,]\s*/, '').replace(/^〒?\s*\d{3}-?\d{4}\s*/, '').trim();

// fetcher：Googleフォームへ届けるときに使う（テストで直接呼ぶときは渡さない＝フォームへは送らない）
export async function handleEvent(db, env, ev, now = Date.now(), fetcher = null) {
  const userId = ev.source?.type === 'user' ? ev.source.userId : null;
  if (!userId || !/^U[0-9a-f]{32}$/i.test(userId)) return [];
  const msg = ev.type === 'message' ? ev.message : null;
  if (msg?.type === 'text') {
    const code = linkCodeFrom(msg.text);
    if (code && CODE.test(code)) return [text(await link(db, userId, code, now))];
  }
  // お問い合わせ（つながっていない人も使える）
  if (ev.type === 'postback') { const pb = new URLSearchParams(ev.postback?.data || ''); if (pb.get('a') === 'inq') return inquiryPick(db, userId, pb.get('c'), now); }
  if (msg?.type === 'text' && isInquiryWord(msg.text.normalize('NFKC').trim())) return inquiryStart();
  const owner = await resolveOwner(db, userId);
  if (msg) { const got = await inquiryReceive(db, userId, msg, owner, now, { fetcher }); if (got) return got; }
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
  // メニューの「また行きたい」は、まずおすすめ機能の説明。自分の場所の一覧はボタン（または「行きたいリスト」と送る）で
  if (/^また行きたい$/.test(t)) return [{type: 'flex', altText: '✨ また行きたい・行きたいリストのおすすめ機能', contents: {type: 'carousel', contents: WISH_INTRO}},
    text('♥ また行きたい・📌 行きたいリストは、行ってみたい場所を集めて、天気に合わせたおでかけコースにできる機能です。\n\nあなたが集めた場所は、下のボタンで見られます👇', {items: [{type: 'action', action: {type: 'message', label: '♥ わたしの場所を見る', text: 'わたしの行きたい場所'}}]})];
  if (/^(わたしの|私の)?(行きたい場所|行きたいリスト)$/.test(t)) return listFavorites(db, owner);
  if (/^(使い方|説明書|ヘルプ|help)$/i.test(t)) return [text(HELP)];
  const ago = monthsAgoFrom(t, now);
  if (ago !== null) return lookBack(db, env, owner, ago, now);
  if (env.AI && t.length >= 2 && t.length <= 200) return fromText(db, env, owner, ev, t, now);
  return [text('位置情報を送ると記録できます。「使い方」と送ると、できることを確認できます。')];
}

// LINEは返事を長く待たないので、AIを使うときは「入力中…」を出してから考える（無料・送信数に数えない）
async function showTyping(env, ev, fetcher) {
  const id = ev.source?.type === 'user' ? ev.source.userId : null;
  if (!id) return;
  await fetcher('https://api.line.me/v2/bot/chat/loading/start', {method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer ' + env.LINE_CHANNEL_ACCESS_TOKEN}, body:JSON.stringify({chatId:id, loadingSeconds:20}), signal:AbortSignal.timeout(5000)}).catch(() => {});
}

export async function handleWebhook(request, env, {db, fetcher = fetch, now = Date.now, waitUntil} = {}) {
  if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN) return new Response('Not configured', {status:503});
  const body = await request.text();
  if (body.length > 200000 || !(await verifySignature(env.LINE_CHANNEL_SECRET, body, request.headers.get('x-line-signature')))) return new Response('Unauthorized', {status:401});
  let payload;
  try { payload = JSON.parse(body); } catch { return new Response('Bad request', {status:400}); }
  const events = Array.isArray(payload.events) ? payload.events.slice(0, MAX_EVENTS) : [];
  if (!events.length) return new Response('OK'); // LINE Developersの「検証」
  const work = (async () => {
    let database;
    try { database = await db(); } catch { console.error('Hibiruka webhook could not open the database.'); return; }
    for (const ev of events) {
      try {
        if (env.AI && ev.type === 'message' && ev.message?.type === 'text') await showTyping(env, ev, fetcher);
        const messages = await handleEvent(database, env, ev, now(), fetcher);
        await reply(env.LINE_CHANNEL_ACCESS_TOKEN, ev.replyToken, messages, fetcher);
      } catch {
        console.error('Hibiruka webhook event failed.'); // 本文・名前・トークンは出さない
        try { await reply(env.LINE_CHANNEL_ACCESS_TOKEN, ev.replyToken, [text('うまく受け取れませんでした。少し待ってもう一度送ってください。')], fetcher); } catch {}
      }
    }
  })();
  // 本番：LINEにはすぐ「受け取った」と返し、続きはそのあとで（AIの返事に数秒かかっても切られない）
  if (waitUntil) { waitUntil(work); return new Response('OK'); }
  await work;
  return new Response('OK');
}
