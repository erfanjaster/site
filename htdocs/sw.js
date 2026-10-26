/* FORGE INFINITE — service worker.
   Caches the app shell so the game opens instantly and survives flaky mobile
   networks. The API is NEVER cached (the server is the source of truth). */

const VER = 'fi-v2.0.0';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/main.js', 'js/store.js', 'js/api.js', 'js/fmt.js', 'js/balance.js',
  'js/juice.js', 'js/ui.js', 'js/cosmetic.js', 'js/screens.js',
  'config/balance.json', 'assets/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VER).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.includes('/api/')) return;          // never cache game state

  // balance.json: network first, cache fallback (so balance tweaks ship instantly)
  if (url.pathname.endsWith('balance.json')) {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(VER).then(c => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // everything else: cache first, then network, then the offline shell
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok && url.origin === location.origin) {
        const copy = r.clone();
        caches.open(VER).then(c => c.put(e.request, copy));
      }
      return r;
    }).catch(() => caches.match('index.html')))
  );
});
