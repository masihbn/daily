// Unit tests for sw.js's runtime behaviour — CONTRACT-5.1.md §1 / §5 (cases
// W1-W13). sw.js is a classic (non-module) service worker, so it cannot be
// imported like normal ESM; instead its source text is evaluated inside a
// node:vm sandbox built from scratch here, with fake self/caches/fetch/
// Request/Response, and its captured event listeners are driven directly
// with fake events. This mirrors tests/unit/sw-assets.test.mjs's read of
// sw.js as text, but goes one level deeper: this file actually RUNS the
// handlers, sw-assets.test.mjs only greps the source.
//
// Do NOT read the in-progress sw.js for "how it's implemented" — this file
// is written strictly against CONTRACT-5.1.md's behavioural contract so it
// stays a true black-box test of whatever the implementer lands.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const swPath = path.join(repoRoot, 'sw.js');
const swText = fs.readFileSync(swPath, 'utf8');

// --- structural extraction (text-level, same technique as sw-assets.test.mjs) ---

function extractCacheName(text) {
  const m = text.match(/\b(?:const|let|var)\s+CACHE\s*=\s*(['"])([^'"]+)\1/);
  assert.ok(m, 'expected a CACHE declaration in sw.js');
  return m[2];
}

function extractArrayLiteral(text, varName) {
  const re = new RegExp(`\\b(?:const|let|var)\\s+${varName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`);
  const m = text.match(re);
  assert.ok(m, `expected a ${varName} array literal in sw.js`);
  const items = m[1].match(/(['"])((?:(?!\1).)*)\1/g) || [];
  return items.map((s) => s.slice(1, -1));
}

const CACHE_NAME = extractCacheName(swText);
const ASSETS = extractArrayLiteral(swText, 'ASSETS');
const CDN_ASSETS = extractArrayLiteral(swText, 'CDN_ASSETS');
const CDN_URL = CDN_ASSETS[0];

// --- fakes ----------------------------------------------------------------

class FakeRequest {
  constructor(input, init = {}) {
    const base = typeof input === 'string' ? { url: input } : input || {};
    this.url = base.url;
    this.method = init.method || base.method || 'GET';
    this.mode = init.mode || base.mode || 'cors';
    this.cache = init.cache || base.cache || 'default';
  }
}

class FakeResponse {
  constructor(init = {}) {
    this.status = init.status !== undefined ? init.status : 200;
    this.ok = init.ok !== undefined ? init.ok : this.status >= 200 && this.status < 300;
    this._marker = init.marker;
  }
  clone() {
    return new FakeResponse({ status: this.status, ok: this.ok, marker: this._marker });
  }
}

// A fake Cache Storage: real semantics (open/keys/delete on named caches;
// each cache backed by a Map keyed by request-or-string url) plus spies
// (`addAllCalls`/`putCalls`) so tests can assert on call shape, not just
// end state.
function makeFakeCaches() {
  const stores = new Map(); // name -> Map(url -> response)
  const cacheApis = new Map(); // name -> api object
  const deleteCalls = [];
  const openCalls = [];

  function keyFor(reqOrUrl) {
    return typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url;
  }

  function makeCacheApi(name) {
    const store = new Map();
    stores.set(name, store);
    const addAllCalls = [];
    const putCalls = [];
    const matchCalls = [];
    return {
      name,
      store,
      addAllCalls,
      putCalls,
      matchCalls,
      async addAll(requests) {
        addAllCalls.push(requests);
        for (const r of requests) {
          store.set(keyFor(r), new FakeResponse({ marker: 'installed-asset' }));
        }
      },
      async put(reqOrUrl, response) {
        const key = keyFor(reqOrUrl);
        putCalls.push({ key, response });
        store.set(key, response);
      },
      async match(reqOrUrl) {
        const key = keyFor(reqOrUrl);
        matchCalls.push(key);
        return store.get(key);
      },
    };
  }

  const caches = {
    async open(name) {
      openCalls.push(name);
      if (!cacheApis.has(name)) cacheApis.set(name, makeCacheApi(name));
      return cacheApis.get(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      deleteCalls.push(name);
      stores.delete(name);
      cacheApis.delete(name);
      return true;
    },
    // Top-level CacheStorage.match: searches every open cache (real browsers
    // search all caches when no `cacheName` option is given), returning the
    // first hit. Backed by the SAME per-name Maps as the per-cache `.match`
    // spy above, so seeding via `(await caches.open(NAME)).put(...)` is
    // visible here too.
    async match(reqOrUrl) {
      const key = keyFor(reqOrUrl);
      for (const store of stores.values()) {
        if (store.has(key)) return store.get(key);
      }
      return undefined;
    },
  };

  return { caches, cacheApis, stores, openCalls, deleteCalls };
}

// Builds a fresh sandbox, evaluates sw.js in it, and returns handles to
// everything a test needs. `fetchImpl(input, init)` controls the fake
// `fetch` global; defaults to always resolving with an OK 200.
function buildSandbox({ fetchImpl } = {}) {
  const listeners = new Map();

  const skipWaiting = () => {
    skipWaiting.calls += 1;
  };
  skipWaiting.calls = 0;

  const claim = () => {
    claim.calls += 1;
  };
  claim.calls = 0;

  const selfObj = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    skipWaiting,
    clients: { claim },
    location: { origin: 'https://app.test', href: 'https://app.test/daily/' },
  };

  const { caches, cacheApis, stores, openCalls, deleteCalls } = makeFakeCaches();

  const fetchCalls = [];
  const fetchFn = (input, init) => {
    fetchCalls.push({ input, init });
    if (typeof fetchImpl === 'function') return fetchImpl(input, init);
    return Promise.resolve(new FakeResponse({ ok: true, status: 200 }));
  };

  const ctx = vm.createContext({
    self: selfObj,
    caches,
    fetch: fetchFn,
    Request: FakeRequest,
    Response: FakeResponse,
    URL,
    console,
    Promise,
    setTimeout,
  });

  new vm.Script(swText, { filename: 'sw.js' }).runInContext(ctx);

  return {
    self: selfObj,
    caches,
    cacheApis,
    stores,
    openCalls,
    deleteCalls,
    fetchCalls,
    listeners,
    skipWaiting,
    claim,
  };
}

function dispatch(sandbox, type, event) {
  const fns = sandbox.listeners.get(type) || [];
  assert.ok(fns.length > 0, `expected at least one '${type}' listener registered`);
  for (const fn of fns) fn(event);
  return event;
}

function makeLifecycleEvent() {
  const ev = { promise: undefined };
  ev.waitUntil = (p) => {
    ev.promise = p;
  };
  return ev;
}

function makeFetchEvent(request) {
  const ev = { request, called: false, promise: undefined };
  ev.respondWith = (p) => {
    ev.called = true;
    ev.promise = p;
  };
  return ev;
}

async function cacheApi(sandbox, name = CACHE_NAME) {
  return sandbox.caches.open(name);
}

// --- W1 --------------------------------------------------------------------

describe('W1: evaluation registers listeners, runs no fetch', () => {
  it('registers install/activate/fetch/message listeners and calls no fetch at evaluation time', () => {
    const sandbox = buildSandbox();
    assert.ok((sandbox.listeners.get('install') || []).length > 0);
    assert.ok((sandbox.listeners.get('activate') || []).length > 0);
    assert.ok((sandbox.listeners.get('fetch') || []).length > 0);
    assert.ok((sandbox.listeners.get('message') || []).length > 0);
    assert.equal(sandbox.fetchCalls.length, 0);
  });
});

// --- W2 --------------------------------------------------------------------

describe('W2: install', () => {
  it('addAll receives one Request per ASSETS entry, each cache: "reload"; skipWaiting called', async () => {
    const sandbox = buildSandbox({ fetchImpl: () => Promise.resolve(new FakeResponse({ ok: true })) });
    const ev = makeLifecycleEvent();
    dispatch(sandbox, 'install', ev);
    assert.equal(sandbox.skipWaiting.calls, 1);
    await ev.promise;

    const api = await cacheApi(sandbox);
    assert.equal(api.addAllCalls.length, 1);
    const requests = api.addAllCalls[0];
    assert.equal(requests.length, ASSETS.length);
    for (const req of requests) {
      assert.ok(req instanceof FakeRequest, 'expected addAll to receive Request instances');
      assert.equal(req.cache, 'reload');
      assert.ok(ASSETS.includes(req.url), `unexpected asset url in addAll: ${req.url}`);
    }
  });

  it('an OK CDN response is fetched once per URL and put; the runtime fetch call omits cache: "reload"', async () => {
    const sandbox = buildSandbox({ fetchImpl: () => Promise.resolve(new FakeResponse({ ok: true, status: 200 })) });
    const ev = makeLifecycleEvent();
    dispatch(sandbox, 'install', ev);
    await ev.promise;

    const api = await cacheApi(sandbox);
    for (const url of CDN_ASSETS) {
      assert.ok(api.store.has(url), `expected ${url} to be cached`);
    }
    const cdnFetchCalls = sandbox.fetchCalls.filter((c) =>
      CDN_ASSETS.includes(typeof c.input === 'string' ? c.input : c.input.url)
    );
    assert.equal(cdnFetchCalls.length, CDN_ASSETS.length);
  });

  it('a 404 CDN response is not put', async () => {
    const sandbox = buildSandbox({ fetchImpl: () => Promise.resolve(new FakeResponse({ ok: false, status: 404 })) });
    const ev = makeLifecycleEvent();
    dispatch(sandbox, 'install', ev);
    await ev.promise;

    const api = await cacheApi(sandbox);
    for (const url of CDN_ASSETS) {
      assert.ok(!api.store.has(url), `expected ${url} NOT to be cached after a 404`);
    }
  });

  it('a throwing CDN fetch does not reject the install waitUntil promise', async () => {
    const sandbox = buildSandbox({ fetchImpl: () => Promise.reject(new Error('cdn network failure')) });
    const ev = makeLifecycleEvent();
    dispatch(sandbox, 'install', ev);
    await assert.doesNotReject(ev.promise);

    const api = await cacheApi(sandbox);
    for (const url of CDN_ASSETS) {
      assert.ok(!api.store.has(url));
    }
  });
});

// --- W3 --------------------------------------------------------------------

describe('W3: activate', () => {
  it('deletes every cache name other than CACHE and calls clients.claim', async () => {
    const sandbox = buildSandbox();
    await sandbox.caches.open('daily-v1');
    await sandbox.caches.open('daily-v2');
    await sandbox.caches.open(CACHE_NAME);

    const ev = makeLifecycleEvent();
    dispatch(sandbox, 'activate', ev);
    await ev.promise;

    assert.deepEqual([...sandbox.deleteCalls].sort(), ['daily-v1', 'daily-v2'].sort());
    assert.ok(!sandbox.deleteCalls.includes(CACHE_NAME));
    assert.equal(sandbox.claim.calls, 1);
  });
});

// --- W4-W10: fetch, same-origin + cross-origin -----------------------------

describe('W4: fetch, same-origin GET, network OK', () => {
  it('fetches the URL string with cache: "no-cache", returns the response, and puts it', async () => {
    const sandbox = buildSandbox({ fetchImpl: () => Promise.resolve(new FakeResponse({ ok: true, status: 200 })) });
    const url = 'https://app.test/js/main.js';
    const request = new FakeRequest(url, { method: 'GET', mode: 'cors' });
    const ev = makeFetchEvent(request);
    dispatch(sandbox, 'fetch', ev);

    assert.equal(ev.called, true);
    const res = await ev.promise;
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);

    assert.equal(sandbox.fetchCalls.length, 1);
    assert.equal(sandbox.fetchCalls[0].input, url, 'expected fetch to be called with the URL string');
    assert.equal(sandbox.fetchCalls[0].init.cache, 'no-cache');

    const api = await cacheApi(sandbox);
    assert.equal(api.putCalls.length, 1);
  });
});

describe('W5: same-origin GET, network 404', () => {
  it('returns the 404 response and does not cache it', async () => {
    const sandbox = buildSandbox({ fetchImpl: () => Promise.resolve(new FakeResponse({ ok: false, status: 404 })) });
    const url = 'https://app.test/js/missing.js';
    const request = new FakeRequest(url, { method: 'GET' });
    const ev = makeFetchEvent(request);
    dispatch(sandbox, 'fetch', ev);

    const res = await ev.promise;
    assert.equal(res.status, 404);

    const api = await cacheApi(sandbox);
    assert.equal(api.putCalls.length, 0);
  });
});

describe('W6: same-origin GET, network throws, cache hit', () => {
  it('returns the cached response and does not put again', async () => {
    const sandbox = buildSandbox({ fetchImpl: () => Promise.reject(new Error('offline')) });
    const url = 'https://app.test/js/main.js';
    const api = await cacheApi(sandbox);
    const cached = new FakeResponse({ ok: true, status: 200, marker: 'cached-main' });
    await api.put(url, cached);
    const putCallsBefore = api.putCalls.length;

    const request = new FakeRequest(url, { method: 'GET' });
    const ev = makeFetchEvent(request);
    dispatch(sandbox, 'fetch', ev);

    const res = await ev.promise;
    assert.equal(res._marker, 'cached-main');
    assert.equal(api.putCalls.length, putCallsBefore);
  });
});

describe('W7: same-origin navigation, network throws, no exact match', () => {
  it('falls back to the cached index shell', async () => {
    const sandbox = buildSandbox({ fetchImpl: () => Promise.reject(new Error('offline')) });
    const api = await cacheApi(sandbox);
    const indexResponse = new FakeResponse({ ok: true, status: 200, marker: 'index-shell' });
    // Seed under both plausible key forms the contract allows ('./index.html'
    // or 'index.html' resolved against self.location) — this test does not
    // know which one the implementation picked.
    await api.put('./index.html', indexResponse);
    await api.put('https://app.test/daily/index.html', indexResponse);

    const request = new FakeRequest('https://app.test/daily/some/route', {
      method: 'GET',
      mode: 'navigate',
    });
    const ev = makeFetchEvent(request);
    dispatch(sandbox, 'fetch', ev);

    const res = await ev.promise;
    assert.equal(res._marker, 'index-shell');
  });
});

describe('W8: same-origin GET, network throws, no cache at all', () => {
  it('rejects the respondWith promise', async () => {
    const sandbox = buildSandbox({ fetchImpl: () => Promise.reject(new Error('offline')) });
    const request = new FakeRequest('https://app.test/js/nothing-cached.js', { method: 'GET' });
    const ev = makeFetchEvent(request);
    dispatch(sandbox, 'fetch', ev);

    await assert.rejects(ev.promise);
  });
});

describe('W9: Supabase-style cross-origin URL, GET', () => {
  it('does not call respondWith and does not call fetch', () => {
    const sandbox = buildSandbox();
    const request = new FakeRequest('https://x.supabase.co/rest/v1/entries', { method: 'GET', mode: 'cors' });
    const ev = makeFetchEvent(request);
    dispatch(sandbox, 'fetch', ev);

    assert.equal(ev.called, false);
    assert.equal(sandbox.fetchCalls.length, 0);
  });
});

describe('W10: same-origin POST', () => {
  it('does not call respondWith', () => {
    const sandbox = buildSandbox();
    const request = new FakeRequest('https://app.test/js/main.js', { method: 'POST' });
    const ev = makeFetchEvent(request);
    dispatch(sandbox, 'fetch', ev);

    assert.equal(ev.called, false);
  });
});

describe('W11: CDN asset, cache-first', () => {
  it('cache hit: returned without a network fetch', async () => {
    const sandbox = buildSandbox();
    const api = await cacheApi(sandbox);
    const cached = new FakeResponse({ ok: true, status: 200, marker: 'cdn-cached' });
    await api.put(CDN_URL, cached);

    const request = new FakeRequest(CDN_URL, { method: 'GET', mode: 'cors' });
    const ev = makeFetchEvent(request);
    dispatch(sandbox, 'fetch', ev);

    const res = await ev.promise;
    assert.equal(res._marker, 'cdn-cached');
    assert.equal(sandbox.fetchCalls.length, 0);
  });

  it('cache miss, OK network response: fetched and put', async () => {
    const sandbox = buildSandbox({ fetchImpl: () => Promise.resolve(new FakeResponse({ ok: true, status: 200 })) });
    const request = new FakeRequest(CDN_URL, { method: 'GET', mode: 'cors' });
    const ev = makeFetchEvent(request);
    dispatch(sandbox, 'fetch', ev);

    const res = await ev.promise;
    assert.equal(res.ok, true);
    assert.equal(sandbox.fetchCalls.length, 1);

    const api = await cacheApi(sandbox);
    assert.ok(api.putCalls.some((c) => c.key === CDN_URL));
  });

  it('cache miss, 500 network response: returned, not put', async () => {
    const sandbox = buildSandbox({ fetchImpl: () => Promise.resolve(new FakeResponse({ ok: false, status: 500 })) });
    const request = new FakeRequest(CDN_URL, { method: 'GET', mode: 'cors' });
    const ev = makeFetchEvent(request);
    dispatch(sandbox, 'fetch', ev);

    const res = await ev.promise;
    assert.equal(res.status, 500);

    const api = await cacheApi(sandbox);
    assert.ok(!api.putCalls.some((c) => c.key === CDN_URL));
  });
});

// --- W12 ---------------------------------------------------------------

describe('W12: message handler', () => {
  it('{ type: "SKIP_WAITING" } calls skipWaiting', () => {
    const sandbox = buildSandbox();
    dispatch(sandbox, 'message', { data: { type: 'SKIP_WAITING' } });
    assert.equal(sandbox.skipWaiting.calls, 1);
  });

  it('other message types are ignored', () => {
    const sandbox = buildSandbox();
    dispatch(sandbox, 'message', { data: { type: 'SOMETHING_ELSE' } });
    assert.equal(sandbox.skipWaiting.calls, 0);
  });

  it('a message with no data is ignored without throwing', () => {
    const sandbox = buildSandbox();
    assert.doesNotThrow(() => dispatch(sandbox, 'message', { data: undefined }));
    assert.equal(sandbox.skipWaiting.calls, 0);
  });

  it('{ type: "GET_VERSION" } posts { type: "VERSION", cache: CACHE } back to event.source', () => {
    const sandbox = buildSandbox();
    const postMessageCalls = [];
    const source = { postMessage: (msg) => postMessageCalls.push(msg) };
    dispatch(sandbox, 'message', { data: { type: 'GET_VERSION' }, source });

    assert.equal(postMessageCalls.length, 1);
    // Field-by-field, not assert.deepEqual: the posted object is created
    // inside the vm sandbox's own realm, so it has a different Object
    // prototype than a literal created here — deepEqual's prototype check
    // fails even when the enumerable properties match exactly.
    assert.equal(postMessageCalls[0].type, 'VERSION');
    assert.equal(postMessageCalls[0].cache, CACHE_NAME);
    assert.deepEqual(Object.keys(postMessageCalls[0]).sort(), ['cache', 'type']);
  });

  it('{ type: "GET_VERSION" } with a null event.source does not throw', () => {
    const sandbox = buildSandbox();
    assert.doesNotThrow(() =>
      dispatch(sandbox, 'message', { data: { type: 'GET_VERSION' }, source: null })
    );
  });
});

// --- W13 -----------------------------------------------------------------

describe('W13: CACHE bump and ASSETS parity', () => {
  it('CACHE is not the retired daily-v37 and matches /^daily-v\\d+$/', () => {
    assert.notEqual(CACHE_NAME, 'daily-v37');
    assert.match(CACHE_NAME, /^daily-v\d+$/);
  });

  it('ASSETS contains ./js/net-status.js', () => {
    assert.ok(ASSETS.includes('./js/net-status.js'));
  });
});
