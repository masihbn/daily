const CACHE = 'daily-v14';

// Same-origin assets — safe to load via cache.addAll (all-or-nothing).
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/main.js',
  './js/router.js',
  './js/config.js',
  './js/api.js',
  './js/store.js',
  './js/dates.js',
  './js/aggregate.js',
  './js/views/home.js',
  './js/views/home-model.js',
  './js/views/trackable.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Cross-origin CDN assets. Fetched and cached individually (not via
// addAll) because cache.addAll() is all-or-nothing: a single failed or
// opaque cross-origin request would reject the whole batch and break
// the entire install.
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.1.0/dist/chartjs-plugin-annotation.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(ASSETS);
      await Promise.all(
        CDN_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url, { mode: 'cors' });
            await cache.put(url, res);
          } catch {
            // One CDN hiccup should not break the entire install.
          }
        })
      );
    })()
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
