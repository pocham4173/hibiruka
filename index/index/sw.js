// Cache only a public offline page and app icons. Never cache user records,
// authentication callbacks, invitation URLs, Firebase or LINE API responses.
const CACHE_PREFIX = 'hibiruka-public-';
const CACHE = CACHE_PREFIX + 'v2';
const PUBLIC = ['./offline.html', './icon-192.png', './icon-512.png'].map(path => new URL(path, self.registration.scope).href);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PUBLIC)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(CACHE_PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await (await caches.open(CACHE)).match(PUBLIC[0])) || new Response("通信を確認して、もう一度開いてください。", {status:503,headers:{"Content-Type":"text/plain; charset=utf-8"}})));
  } else if (PUBLIC.includes(url.href)) {
    event.respondWith((async () => (await (await caches.open(CACHE)).match(request)) || fetch(request))());
  }
});

// 📱 アプリからの通知（予定のお知らせ）。中身はワーカーで暗号化されて届く。
self.addEventListener('push', event => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch { m = { body: event.data ? event.data.text() : '' }; }
  const title = String(m.title || '🔔 ヒビルカ').slice(0, 80);
  event.waitUntil(self.registration.showNotification(title, {
    body: String(m.body || '').slice(0, 300), tag: m.tag || undefined, renotify: !!m.tag,
    icon: new URL('./icon-192.png', self.registration.scope).href, badge: new URL('./icon-192.png', self.registration.scope).href,
    data: { url: new URL(m.url || './', self.registration.scope).href },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil((async () => {
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) if (c.url.startsWith(self.registration.scope) && 'focus' in c) { await c.focus(); return; }
    await self.clients.openWindow(url);
  })());
});
