// 只缓存页面外壳，用于断网时还能打开；数据接口 /api/ 一律走网络，绝不缓存
const CACHE = 'cw-shell-v3';
const SHELL = ['/', '/app.js', '/style.css', '/manifest.json', '/icon.svg', '/icon-192.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // 先走网络（保证每次都是最新版本），失败再用缓存
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request.mode === 'navigate' ? '/' : e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request.mode === 'navigate' ? '/' : e.request)));
});
