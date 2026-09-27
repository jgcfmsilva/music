// Service worker for the Music PWA. Only the app shell (HTML/CSS/JS/icons) is cached,
// network first, so a deploy shows up on the next open and the app still starts when the
// server is briefly unreachable. /rest (Navidrome: streams with Range requests, covers) and
// /api (music-api, live event stream) are never touched: they go straight to the network.
// Service workers need a secure origin; over plain http this only runs with
// Chrome's "unsafely-treat-insecure-origin-as-secure" flag set for the site.
const CACHE = 'music-shell-v1';
const SHELL = ['/', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'js/app.js', 'js/api.js', 'js/icons.js', 'js/md5.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/rest/') || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy));
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req.mode === 'navigate' ? '/' : req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
