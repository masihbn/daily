// Step D.6 — js/outbox-sync.js.
//
// The defect being fixed: store.flushOutbox() had exactly ONE caller,
// js/views/home.js on mount. A write queued offline from a detail screen was
// therefore never retried unless the user happened to navigate to Home — and
// a standalone PWA relaunches at its last hash, which is routinely a detail
// route. The write sat in localStorage while the UI showed it as saved.
//
// These tests are deliberately in the Node tier rather than Playwright: the
// interesting cases are "the app was backgrounded and came back" and "the
// network returned", which a browser test cannot simulate faithfully but a
// fake event target can express exactly.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOutboxSync, renderOutboxStatus, SYNC_EVENTS } from '../../js/outbox-sync.js';

// Minimal EventTarget stand-in that records add/remove so listener leaks are
// assertable — a sync that re-registers on every start would multiply flushes.
function fakeTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type) || [];
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
    emit(type) {
      for (const fn of [...(listeners.get(type) || [])]) fn({ type });
    },
    count(type) {
      return (listeners.get(type) || []).length;
    },
  };
}

function fakeStore({ pending = 0, flushImpl } = {}) {
  const subs = new Set();
  let n = pending;
  const store = {
    flushes: 0,
    getOutbox: () => Array.from({ length: n }, (_, i) => ({ key: `k${i}` })),
    onOutboxChange(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    subscriberCount: () => subs.size,
    setPending(v) {
      n = v;
      for (const fn of subs) fn(n);
    },
    async flushOutbox() {
      store.flushes += 1;
      if (flushImpl) return flushImpl();
      const sent = n;
      n = 0;
      return { sent, failed: 0, remaining: 0 };
    },
  };
  return store;
}

describe('D.6: createOutboxSync — triggers', () => {
  let store;
  let target;
  let counts;
  let sync;

  beforeEach(() => {
    store = fakeStore({ pending: 2 });
    target = fakeTarget();
    counts = [];
    sync = createOutboxSync({
      store,
      target,
      doc: { visibilityState: 'visible' },
      onChange: (c) => counts.push(c),
    });
  });

  it('flushes once at start, regardless of route — THE bug this step fixes', async () => {
    sync.start();
    await sync.flushNow();
    assert.ok(store.flushes >= 1, 'start() must flush without waiting for any event');
  });

  it('registers exactly one listener per sync event', () => {
    sync.start();
    for (const type of SYNC_EVENTS) {
      assert.equal(target.count(type), 1, `expected exactly one ${type} listener`);
    }
  });

  it('start() is idempotent — a second call must not double-register', () => {
    sync.start();
    sync.start();
    for (const type of SYNC_EVENTS) {
      assert.equal(target.count(type), 1, `${type} was registered twice`);
    }
  });

  it('flushes on online, pageshow and focus', async () => {
    sync.start();
    await sync.flushNow();
    const base = store.flushes;
    for (const type of ['online', 'pageshow', 'focus']) {
      store.setPending(1);
      target.emit(type);
    }
    await new Promise((r) => setImmediate(r));
    assert.ok(store.flushes > base, 'events must trigger a flush');
  });

  it('flushes on visibilitychange when the app becomes VISIBLE', async () => {
    sync.start();
    await sync.flushNow();
    const base = store.flushes;
    store.setPending(1);
    target.emit('visibilitychange');
    await new Promise((r) => setImmediate(r));
    assert.equal(store.flushes, base + 1);
  });

  it('does NOT flush on visibilitychange when the app is being HIDDEN', async () => {
    // Flushing as the app backgrounds is worse than useless: iOS may suspend
    // the process mid-request, and it would double every foreground flush.
    const doc = { visibilityState: 'visible' };
    const s = createOutboxSync({ store, target, doc, onChange: () => {} });
    s.start();
    await s.flushNow();
    const base = store.flushes;

    doc.visibilityState = 'hidden';
    target.emit('visibilitychange');
    await new Promise((r) => setImmediate(r));
    assert.equal(store.flushes, base, 'must not flush while going to the background');
  });

  it('stop() removes every listener and unsubscribes from the store', () => {
    sync.start();
    assert.equal(store.subscriberCount(), 1);
    sync.stop();
    for (const type of SYNC_EVENTS) {
      assert.equal(target.count(type), 0, `${type} listener leaked past stop()`);
    }
    assert.equal(store.subscriberCount(), 0, 'store subscription leaked past stop()');
  });

  it('after stop(), a later event does not flush', async () => {
    sync.start();
    await sync.flushNow();
    sync.stop();
    const base = store.flushes;
    target.emit('online');
    await new Promise((r) => setImmediate(r));
    assert.equal(store.flushes, base);
  });
});

describe('D.6: createOutboxSync — robustness', () => {
  it('survives a store.flushOutbox() that rejects', async () => {
    // store.flushOutbox() is documented not to reject, but a sync loop that
    // dies on an unexpected throw is exactly what goes unnoticed for months.
    const store = fakeStore({ pending: 1, flushImpl: () => Promise.reject(new Error('boom')) });
    const sync = createOutboxSync({ store, target: fakeTarget(), onChange: () => {} });
    const res = await sync.flushNow();
    assert.equal(res.sent, 0);
    assert.equal(res.remaining, 1, 'a failed flush must report the ops as still pending');
  });

  it('survives an onChange callback that throws', async () => {
    const store = fakeStore({ pending: 1 });
    const sync = createOutboxSync({
      store,
      target: fakeTarget(),
      onChange: () => { throw new Error('bad listener'); },
    });
    await assert.doesNotReject(() => sync.flushNow());
  });

  it('survives a store.getOutbox() that throws', () => {
    const store = { ...fakeStore(), getOutbox: () => { throw new Error('no'); } };
    const sync = createOutboxSync({ store, target: fakeTarget() });
    assert.equal(sync.pendingCount(), 0);
  });

  it('works with no target at all (a non-DOM environment)', async () => {
    const store = fakeStore({ pending: 1 });
    const sync = createOutboxSync({ store, onChange: () => {} });
    assert.doesNotThrow(() => sync.start());
    await sync.flushNow();
    assert.ok(store.flushes >= 1);
  });

  it('requires a store', () => {
    assert.throws(() => createOutboxSync({}), TypeError);
  });

  it('does NOT consult navigator.onLine', async () => {
    // navigator.onLine reports true for a captive portal and a
    // connected-but-dead wifi, and false in cases where a request would
    // succeed. Attempting the flush and letting it fail is strictly more
    // accurate — a failed attempt leaves the op queued, where it already was.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../js/outbox-sync.js', import.meta.url), 'utf8')
    );
    const code = src.replace(/\/\/[^\n]*/g, '');
    assert.ok(!/navigator\s*\.\s*onLine/.test(code), 'outbox-sync must not gate flushing on navigator.onLine');
  });
});

describe('D.6: createOutboxSync — the store subscription', () => {
  it('notifies the indicator the moment a write is queued, with no event', async () => {
    // Without this, logging offline shows no sign anything is pending until
    // the next foreground/online event — which may be hours away.
    const store = fakeStore({ pending: 0 });
    const counts = [];
    const sync = createOutboxSync({ store, target: fakeTarget(), onChange: (c) => counts.push(c) });
    sync.start();
    await sync.flushNow();
    counts.length = 0;

    store.setPending(3);
    assert.deepEqual(counts, [3], 'a queued write must update the indicator immediately');
  });
});

describe('D.6: renderOutboxStatus', () => {
  function fakeEl() {
    return { hidden: false, textContent: 'x', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  }

  it('hides and empties at zero', () => {
    const el = fakeEl();
    renderOutboxStatus(el, 0);
    assert.equal(el.hidden, true);
    assert.equal(el.textContent, '');
    assert.equal(el.attrs['data-count'], '0');
  });

  it('uses the singular for one and the plural above that', () => {
    const a = fakeEl();
    renderOutboxStatus(a, 1);
    assert.equal(a.hidden, false);
    assert.equal(a.textContent, '1 log not yet saved');

    const b = fakeEl();
    renderOutboxStatus(b, 4);
    assert.equal(b.textContent, '4 logs not yet saved');
  });

  it('does not say "syncing" — that would imply progress while offline', () => {
    const el = fakeEl();
    renderOutboxStatus(el, 2);
    assert.ok(!/sync/i.test(el.textContent));
  });

  it('treats junk counts as zero rather than rendering NaN', () => {
    for (const bad of [NaN, undefined, null, -1, 'x', {}]) {
      const el = fakeEl();
      renderOutboxStatus(el, bad);
      assert.equal(el.hidden, true, `${JSON.stringify(bad)} should hide the indicator`);
    }
  });

  it('does not throw on a null element', () => {
    assert.doesNotThrow(() => renderOutboxStatus(null, 3));
  });
});
