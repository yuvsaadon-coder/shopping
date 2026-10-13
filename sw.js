// Service worker של אפליקציית הקניות: פתיחה גם בלי אינטרנט (בסופר הקליטה לפעמים גרועה)
// קבצי האפליקציה: קודם מהרשת, ואם אין – מהמטמון. השרת (מחירים, סנכרון) ותמונות החנויות לא נשמרים כאן.
const CACHE = 'shopping-v2';
const SHELL = ['./', './index.html', './app.js', './products.js', './manifest.webmanifest', './icon.svg', './icon-192.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('shopping-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req, { cache: 'no-store' }).then(res => {
    if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req.mode === 'navigate' ? './index.html' : req, copy)); }
    return res;
  }).catch(() => caches.match(req.mode === 'navigate' ? './index.html' : req).then(r => r || caches.match(req))));
});
