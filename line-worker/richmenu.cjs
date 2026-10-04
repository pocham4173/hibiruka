// Installs Hibiruka's LINE rich menu (the button bar under the chat) as the default for everyone.
// Runs from the "LINEメニューの反映" workflow. Creating and switching rich menus is free.
const fs = require('node:fs');
const APP = 'https://pocham4173.github.io/hibiruka/index/index/';
const GUIDE = 'https://pocham4173.github.io/hibiruka/guide/';
const NAME = 'hibiruka-main';
const SHARE = 'https://line.me/R/nv/recommendOA/%40626hnkgo'; // 友だちにヒビルカのLINEを紹介する画面
const W = 2500, H = 1686, cols = 3, rows = 2;
// 3列×2段。端数は最後の列・段にまとめて、すき間ができないようにする
const area = (i, action) => {
  const c = i % cols, r = Math.floor(i / cols), x = Math.round(c * W / cols), y = Math.round(r * H / rows);
  return { bounds: { x, y, width: Math.round((c + 1) * W / cols) - x, height: Math.round((r + 1) * H / rows) - y }, action };
};
const menu = {
  size: { width: W, height: H }, selected: true, name: NAME, chatBarText: 'メニュー',
  areas: [
    area(0, { type: 'uri', label: 'アプリを開く', uri: APP }),
    area(1, { type: 'message', label: '今日', text: '今日' }),
    area(2, { type: 'message', label: 'また行きたい', text: 'また行きたい' }),
    area(3, { type: 'message', label: 'ふりかえり', text: 'ふりかえり' }),
    area(4, { type: 'uri', label: '使い方', uri: GUIDE }),
    area(5, { type: 'uri', label: '友だちに紹介', uri: SHARE }),
  ],
};
if (require.main !== module) module.exports = { menu };
async function call(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { Authorization: 'Bearer ' + process.env.LINE_CHANNEL_ACCESS_TOKEN, ...(opt.headers || {}) }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Error(`${opt.method || 'GET'} ${url.replace(/richmenu-[0-9a-f]+/, 'richmenu-…')} → HTTP ${r.status}`);
  const t = await r.text(); return t ? JSON.parse(t) : {};
}
if (require.main === module) (async () => {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) throw Error('LINE_CHANNEL_ACCESS_TOKEN is missing');
  const image = fs.readFileSync(__dirname + '/richmenu.jpg');
  if (image.length > 1024 * 1024) throw Error('Rich menu image must be 1MB or less');
  const json = { 'Content-Type': 'application/json' };
  await call('https://api.line.me/v2/bot/richmenu/validate', { method: 'POST', headers: json, body: JSON.stringify(menu) });
  const before = (await call('https://api.line.me/v2/bot/richmenu/list')).richmenus || [];
  const { richMenuId } = await call('https://api.line.me/v2/bot/richmenu', { method: 'POST', headers: json, body: JSON.stringify(menu) });
  await call(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: image });
  await call(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, { method: 'POST' });
  // 前に作った同じ名前のメニューだけ片づける（ほかのメニューには触らない）
  for (const m of before.filter(m => m.name === NAME)) await call(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, { method: 'DELETE' }).catch(e => console.warn(e.message));
  console.log('Rich menu installed as default. Old Hibiruka menus removed:', before.filter(m => m.name === NAME).length);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
