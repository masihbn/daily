// Step 5.1 (CONTRACT-5.1 §1). Reworked from the network-first-with-cache-
// fallback worker that cached EVERY request indiscriminately (§0.1) into one
// that only ever intercepts same-origin GETs and the two pinned CDN scripts.
// Supabase REST/auth responses are never seen by `respondWith` at all — the
// browser handles them natively — so there is exactly one cache of app data
// (js/store.js), not two competing stale layers (§0.1).
//
// §0.7 TESTABILITY: this file is evaluated in a Node `vm` sandbox by
// tests/unit/sw-handlers.test.mjs, with fake self/caches/fetch/Request/
// Response/URL. That means: register everything ONLY through
// self.addEventListener, touch no globals besides self, caches, fetch,
// Request, Response, URL, Promise, console, and never run a fetch (or any
// other side effect) at evaluation time — only inside a listener.

const CACHE = 'daily-v44';

// Same-origin assets — safe to load via cache.addAll (all-or-nothing).
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/main.js',
  './js/router.js',
  './js/config.js',
  './js/errors.js',
  './js/auth.js',
  './js/api.js',
  './js/applock.js',
  './js/store.js',
  './js/export-csv.js',
  './js/outbox-sync.js',
  './js/net-status.js',
  './js/dates.js',
  './js/aggregate.js',
  './js/icons.js',
  './js/charts/heatmap.js',
  './js/charts/weekly.js',
  './js/charts/bounds.js',
  './js/charts/overlay.js',
  './js/charts/compare.js',
  './js/views/home.js',
  './js/views/home-model.js',
  './js/views/trackable.js',
  './js/views/detail.js',
  './js/views/compare.js',
  './js/views/signin.js',
  './js/views/settings.js',
  './js/views/lock.js',
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

// §0.1 — the fetch handler must only ever respondWith() for these. Every
// other request (cross-origin Supabase REST/auth, non-GET writes, anything
// else) falls through untouched and the browser handles it natively.
function isCdnAsset(url) {
  return CDN_ASSETS.includes(url);
}

function isSameOrigin(url) {
  return new URL(url).origin === self.location.origin;
}

function isNavigation(req) {
  return req.mode === 'navigate';
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // §0.2 — the 10-minute update lag (Attempt 15, docs/PROJECT_NOTES.md).
      // GitHub Pages sends every file with Cache-Control: max-age=600, and a
      // plain `cache.addAll(ASSETS)` honours the browser's HTTP cache, so for
      // up to 10 minutes after a deploy an "updated" service worker installs
      // the PREVIOUS version of every asset. `cache: 'reload'` forces each
      // request straight to the network, bypassing the HTTP cache, so a new
      // worker always installs what was actually just deployed.
      await cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })));
      await Promise.all(
        CDN_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url, { mode: 'cors' });
            // Step D.6 — carried over from Step 0.3, where it was found on
            // review and deliberately deferred. WITHOUT this check, a 404 or
            // 5xx from jsDelivr gets cached as though it were the real
            // script, and is then served from cache forever after. The
            // result is a chart library that is permanently broken with no
            // network error to point at, on an installed phone, fixable only
            // by a CACHE bump. Leaving the URL uncached is strictly better:
            // the fetch handler already falls back to the network.
            if (res.ok) {
              await cache.put(url, res);
            }
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
  const { request } = event;

  // §0.1 — only intercept same-origin GETs and the two pinned CDN scripts.
  // A non-GET (e.g. a Supabase write), or a cross-origin request that isn't
  // one of the two CDN assets (Supabase REST/auth), is left completely
  // alone: no respondWith(), so the browser handles it as if this worker
  // did not exist. This is what keeps Supabase responses out of the SW
  // cache entirely.
  if (request.method !== 'GET') return;

  const sameOrigin = isSameOrigin(request.url);
  const cdn = isCdnAsset(request.url);
  if (!sameOrigin && !cdn) return;

  if (sameOrigin) {
    // Network-first, same as before the rework — data freshness beats
    // instant load for this app (BUILD_PLAN 5.1). §0.2 — bypass the HTTP
    // cache here too (`cache: 'no-cache'` revalidates with the server; a
    // 304 is cheap), or an already-running tab would keep getting the
    // pre-deploy asset for up to 10 minutes even though the SW itself is
    // network-first.
    event.respondWith(
      fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' })
        .then((res) => {
          // §0.3 — only cache OK responses; a 404/5xx must never be served
          // from cache later just because it was the last thing fetched.
          if (res.ok) {
            const copy = res.clone();
            caches
              .open(CACHE)
              .then((cache) => cache.put(request, copy))
              .catch(() => {
                // A cache-write failure must never turn a good network
                // response into a broken one.
              });
          }
          // Return the network's answer even when it isn't ok — that is
          // still the true, current answer, not a reason to fall back.
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          // §0.4 — the app is a single page; offline, a navigation with no
          // exact cache match (e.g. a fresh `#/t/xyz` deep link never
          // fetched directly before) still needs SOMETHING to render, and
          // the cached shell plus the hash router is that something.
          if (isNavigation(request)) {
            const shell =
              (await caches.match('./index.html')) ||
              (await caches.match(new URL('index.html', self.location.href).toString()));
            if (shell) return shell;
          }
          // Nothing cached and no network: let the failure propagate, same
          // as an uncontrolled fetch would.
          throw new Error('daily: offline and not cached');
        })
    );
    return;
  }

  // CDN asset: cache-first. These URLs are versioned and immutable (pinned
  // exact versions — see the "no floating CDN script version" test), so
  // there is nothing to revalidate; serving the cached copy is both correct
  // and faster than a round trip.
  //
  // Device defect (5.4 phone pass): offline, charts didn't draw even though
  // both CDN scripts WERE in the cache. jsDelivr sends `Vary:
  // Accept-Encoding`, and on WebKit the page's own <script> request for the
  // same URL doesn't Vary-match the entry the install-time `fetch(url, {
  // mode: 'cors' })` stored, so a plain `caches.match(request)` misses and
  // falls through to `fetch(request)`, which rejects offline. `ignoreVary:
  // true` is safe here specifically because these two URLs are pinned exact
  // versions marked immutable — there is only ever one possible response
  // body per URL, so Vary-matching buys nothing and only costs the miss.
  event.respondWith(
    caches.match(request, { ignoreVary: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches
              .open(CACHE)
              .then((cache) => cache.put(request, copy))
              .catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          // Network failed too (the offline case the Vary mismatch was
          // actually hitting). One more, looser lookup before giving up —
          // `ignoreSearch` in case the two entries otherwise differ only by
          // query string — and a clear, catchable error instead of letting
          // the original fetch rejection propagate as an unhandled one.
          const fallback = await caches.match(request, { ignoreVary: true, ignoreSearch: true });
          if (fallback) return fallback;
          throw new Error('daily: CDN asset unavailable offline');
        });
    })
  );
});

// §1 — lets a future "update now" UI force the waiting worker to activate
// immediately instead of waiting for all tabs to close. Harmless today
// (nothing posts this message yet).
//
// GET_VERSION was added for the device verification of the Step 5.1 update
// path (CACHE bump -> deploy -> confirm the phone picked it up): it lets
// js/net-status.js#requestAppVersion() ask "which CACHE are you actually
// running" and have Settings display the answer, rather than relying on
// eyeballing whether anything changed. `event.source` is the client that
// posted the message; it can be missing (e.g. a message with no window
// attached) so it's guarded — a version probe must never throw inside the
// worker.
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (event.data.type === 'GET_VERSION') {
    if (event.source) {
      event.source.postMessage({ type: 'VERSION', cache: CACHE });
    }
  }
});
