// LINEのお問い合わせ：「お問い合わせ」→ 種類を選ぶ → 内容を1回送る → 受付。
// 返事（reply）は無料で、月の通数に数えない。個別のお返事はしない（よくある質問・お知らせで返す）。
// 受け付けた内容はサーバー専用の inquiries に保存し、Googleフォームが設定されていれば同じフォームにも届ける（受け取る場所を1つにする）。
import { inquiryNo } from './account.mjs';
export const FAQ_URL = 'https://pocham4173.github.io/hibiruka/guide/#faq';
export const CONTACT_URL = 'https://pocham4173.github.io/hibiruka/terms/#contact';
// Googleフォーム（作ったら入れる）。entry の番号は「事前入力したURLを取得」で分かる
export const FORM = { url: 'https://docs.google.com/forms/d/e/1FAIpQLSfUJmj_ja4CkWWw0naho5ML6O4T3MzVJXsnzDG_RRwLUoIIvA/formResponse', entry: { kind: 'entry.1764692148', text: 'entry.317546293', device: 'entry.673106725', when: 'entry.456326230', no: 'entry.620971036', agree: 'entry.879427435' } };
export const AGREE = '確認しました'; // フォームの「同意」の選択肢と同じ文字
export const KINDS = { bug: '🐞 不具合（うまく動かない）', how: '❓ 使い方がわからない', idea: '💡 ご意見・ほしい機能', ad: '🏷 広告（PR）について', other: '✉️ その他' };
const PER_DAY = 3, WAIT_MIN = 15, MAX_LEN = 1000;
const pad = n => String(n).padStart(2, '0');
const jstDay = now => { const d = new Date(now + 9 * 3600e3); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`; };
const text = (t, quickReply) => ({ type: 'text', text: String(t).slice(0, 4900), ...(quickReply ? { quickReply } : {}) });
const cancelItem = { type: 'action', action: { type: 'postback', label: 'やめる', data: 'a=inq&c=cancel', displayText: 'やめる' } };

// やめても、その日の回数は残す
const stop = async (db, ref) => { const s = await ref.get(); if (s.exists) await db.set(ref, { ...s.data(), kind: '', until: new Date(0) }); };
export const isInquiryWord = t => /^(お?問い?合わ?せ|お問合せ|問合せ|不具合|要望|ご意見|意見|連絡)(したい|窓口|する)?$/.test(t) || /お問い?合わせ/.test(t) && t.length <= 15;

export function inquiryStart() {
  return [text([
    '✉️ お問い合わせ',
    '',
    '先に「よくある質問」をご覧ください。多くはここで解決します。',
    FAQ_URL,
    '',
    'それでも解決しないときは、下から種類を選んで、このトークに内容を送ってください。',
    '',
    '・個別のお返事はしていません。いただいた内容は、アプリの改善や「よくある質問」に使います',
    '・パスワード、住所、電話番号などの個人情報は書かないでください',
    '・記録やアカウントの削除は、アプリの「設定」からご自身でできます'
  ].join('\n'), { items: [...Object.entries(KINDS).map(([c, label]) => ({ type: 'action', action: { type: 'postback', label: label.slice(0, 20), data: 'a=inq&c=' + c, displayText: label } })), cancelItem] })];
}

// 種類を選んだ（postback）
export async function inquiryPick(db, userId, c, now) {
  const ref = db.collection('lineInquiry').doc(userId);
  if (c === 'cancel') { await stop(db, ref); return [text('お問い合わせをやめました。')]; }
  if (!KINDS[c]) return [];
  const s = await ref.get(), old = s.exists ? s.data() : {}, day = jstDay(now);
  const count = old.day === day ? Number(old.count) || 0 : 0;
  if (count >= PER_DAY) return [text(`お問い合わせは1日${PER_DAY}回までです。また明日お送りください。`)];
  await db.set(ref, { kind: c, until: new Date(now + WAIT_MIN * 60000), day, count });
  return [text(`「${KINDS[c]}」ですね。\n内容を、このトークに1回のメッセージで送ってください（${MAX_LEN}文字まで）。${c === 'bug' ? '\n\n「どの画面で」「何をしたら」「どうなったか」と、スマホの種類（iPhone・Android）も書いてもらえると助かります。' : ''}\n\n※個人情報は書かないでください`, { items: [cancelItem] })];
}

// お問い合わせの内容を待っている人か（待っていれば受け付けて返事を返す。待っていなければ null）
export async function inquiryReceive(db, userId, msg, owner, now, { fetcher = null } = {}) {
  const ref = db.collection('lineInquiry').doc(userId);
  const s = await ref.get();
  if (!s.exists) return null;
  const st = s.data(), until = st.until instanceof Date ? st.until.getTime() : Date.parse(st.until);
  if (!(until > now) || !KINDS[st.kind]) return null;
  if (msg.type !== 'text') return [text('お問い合わせは、文字で送ってください。写真は受け付けていません。', { items: [cancelItem] })];
  const body = String(msg.text || '').trim();
  if (/^(やめる|キャンセル|中止)$/.test(body)) { await stop(db, ref); return [text('お問い合わせをやめました。')]; }
  const no = owner ? await inquiryNo(owner.uid) : '';
  const id = `${jstDay(now)}-${Math.random().toString(36).slice(2, 10)}`;
  await db.set(db.collection('inquiries').doc(id), { via: 'line', kind: st.kind, text: body.slice(0, MAX_LEN), no, status: 'new', createdAt: new Date(now) });
  await db.set(ref, { kind: '', until: new Date(0), day: st.day, count: (Number(st.count) || 0) + 1 });
  if (fetcher) await toForm({ kind: KINDS[st.kind].replace(/^\S+\s/, ''), text: body.slice(0, MAX_LEN), device: 'LINEから', when: new Date(now + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), no, agree: AGREE }, fetcher);
  return [text(`お問い合わせを受け付けました。ありがとうございます😊\n受付番号：${id.toUpperCase()}\n\nすべて読んでいます。個別のお返事はしていませんが、改善はアプリのお知らせや「よくある質問」でお知らせします。\n${FAQ_URL}`)];
}

// Googleフォームへも届ける（設定されているときだけ。失敗しても受付は済んでいる）
export async function toForm(fields, fetcher = fetch, form = FORM) {
  if (!/^https:\/\/docs\.google\.com\/forms\/d\/e\/[\w-]+\/formResponse$/.test(form.url || '')) return false;
  const p = new URLSearchParams();
  for (const [k, entry] of Object.entries(form.entry || {})) if (/^entry\.\d+$/.test(entry || '') && fields[k]) p.append(entry, fields[k]);
  try { const r = await fetcher(form.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: p.toString(), signal: AbortSignal.timeout(8000) }); return r.ok; } catch { return false; }
}
