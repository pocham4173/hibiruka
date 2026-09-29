// Cache only a public offline page and app icons. Never cache user records,
// authentication callbacks, invitation URLs, Firebase or LINE API responses.
const CACHE_PREFIX = 'hibiruka-public-';
const CACHE = CACHE_PREFIX + 'v1';
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
