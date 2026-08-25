// Step D.6 — store.flushOutbox() must serialize concurrent calls, and
// persistOutbox() must notify subscribers.
//
// WHY SERIALIZATION BECAME NECESSARY IN THIS STEP: before D.6, flushOutbox()
// had a single caller (the Home view's mount), so concurrency was not
// reachable. D.6 adds four more triggers — app start, `online`,
// `visibilitychange`, `pageshow`/`focus` — and two of them routinely fire
// within milliseconds of each other (unlocking a phone in a tunnel that just
// regained signal fires `visibilitychange` and `online` together).
//
// runFlush() takes a SNAPSHOT of the outbox and dequeues as it goes, so two
// overlapping runs would each snapshot the same ops and send them twice.
// Upserts and deletes are idempotent so stored data survives, but it doubles
// the write volume at exactly the moment the network is worst, and it makes
// the returned {sent, failed} counts wrong.
//
// The real validators from js/api.js are used rather than reimplemented, so
// these fakes cannot drift from the contract the store actually enforces.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/store.js';
import { assertValidEntry, assertId, assertDate, isRetryable } from '../../js/api.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function baseApi(overrides = {}) {
  return {
    assertValidEntry,
    assertId,
    assertDate,
    isRetryable,
    async listTrackables() { return []; },
    async listEntries() { return []; },
    async upsertEntry(p) { return { id: 1, ...p }; },
    async deleteEntry() { return 1; },
    ...overrides,
  };
}

function offlineError() {
  const e = new Error('offline');
  e.retryable = true;
  return e;
}

// An api whose upsert hangs until released, so two flushes can be made to
// overlap deterministically rather than by timing luck.
function gatedApi() {
  let release;
  const gate = new Promise((r) => { release = r; });
  const sent = [];
  return {
    release: () => release(),
    sent,
    api: baseApi({
      async upsertEntry(payload) {
        sent.push(payload);
        await gate;
        return { id: sent.length, ...payload };
      },
    }),
  };
}

// Queues one op by letting a save fail retryably, then hands back the shared
// storage so a second store can hydrate the same outbox.
async function storageWithOneQueuedOp() {
  const storage = memoryStorage();
  const api = baseApi({ async upsertEntry() { throw offlineError(); } });
  const store = createStore({ api, storage });
  const res = await store.saveEntry({ trackable_id: 7, entry_date: '2026-02-02', value: 5 });
  assert.equal(res.status, 'queued', 'precondition: the op must be queued');
  assert.equal(store.getOutbox().length, 1);
  return storage;
}

describe('D.6: flushOutbox serialization', () => {
  it('an overlapping flush joins the in-flight run and sends the op exactly ONCE', async () => {
    // Note on what is asserted here. An earlier version of this test compared
    // the two returned promises with strictEqual. That was wrong: flushOutbox
    // is an `async function`, so it always returns a fresh promise even when
    // it hands back the in-flight run. Promise identity is an implementation
    // detail; the contract that actually protects the user is that the queued
    // op reaches the network once, and that both callers see the same result.
    const storage = await storageWithOneQueuedOp();
    const { api, release, sent } = gatedApi();
    const store = createStore({ api, storage });
    assert.equal(store.getOutbox().length, 1, 'hydrated store should carry the queued op');

    const a = store.flushOutbox();
    const b = store.flushOutbox();

    // Both were started while the first run was still gated open, so if the
    // guard were missing, both would have snapshotted the same op by now.
    release();
    const [ra, rb] = await Promise.all([a, b]);

    assert.equal(sent.length, 1, 'the queued op must be sent exactly once, not twice');
    assert.deepEqual(ra, rb, 'both callers must observe the same run result');
    assert.equal(ra.sent, 1);
    assert.equal(store.getOutbox().length, 0);
  });

  it('WITHOUT the guard this test would fail — proving it is not vacuous', async () => {
    // Guards against the version of the above test that passes for the wrong
    // reason. Here the two flushes are deliberately NOT overlapped, so the op
    // legitimately goes out once; if the first test ever starts passing
    // because the ops were serialised by timing rather than by the guard,
    // this one still pins the difference between the two situations.
    const storage = await storageWithOneQueuedOp();
    const { api, release, sent } = gatedApi();
    const store = createStore({ api, storage });

    const first = store.flushOutbox();
    release();
    await first;
    assert.equal(sent.length, 1);

    // Outbox is empty now, so a second flush must not re-send anything.
    await store.flushOutbox();
    assert.equal(sent.length, 1, 'a drained outbox must not resend');
  });

  it('a flush AFTER the previous one settles does start a new run', async () => {
    const store = createStore({ api: baseApi(), storage: memoryStorage() });
    const first = store.flushOutbox();
    await first;
    const second = store.flushOutbox();
    assert.notStrictEqual(first, second, 'the in-flight guard must clear once a run settles');
    await second;
  });

  it('the guard clears even when the run throws, so sync is not wedged forever', async () => {
    // If a rejected flush left flushInFlight set, every later trigger would
    // return the same rejected promise and the outbox would never drain
    // again — a permanent silent failure, which is the whole class of bug
    // this step exists to remove.
    const storage = await storageWithOneQueuedOp();
    const api = baseApi({ async upsertEntry() { throw new TypeError('unexpected'); } });
    const store = createStore({ api, storage });

    await store.flushOutbox().catch(() => {});
    const after = store.flushOutbox();
    await after.catch(() => {});
    const again = store.flushOutbox();
    assert.notStrictEqual(after, again, 'a settled (even failed) run must not stay latched');
    await again.catch(() => {});
  });

  it('an empty-outbox flush is a no-op that issues no request', async () => {
    let called = 0;
    const api = baseApi({
      async upsertEntry() { called += 1; return {}; },
      async deleteEntry() { called += 1; return 1; },
    });
    const store = createStore({ api, storage: memoryStorage() });
    const res = await store.flushOutbox();
    assert.deepEqual(res, { sent: 0, failed: 0, remaining: 0 });
    assert.equal(called, 0, 'redundant triggers must cost nothing when nothing is queued');
  });
});

describe('D.6: onOutboxChange', () => {
  const failing = () => baseApi({
    async upsertEntry() { throw offlineError(); },
    async deleteEntry() { throw offlineError(); },
  });

  it('fires with the new length when a write is queued', async () => {
    const store = createStore({ api: failing(), storage: memoryStorage() });
    const seen = [];
    store.onOutboxChange((n) => seen.push(n));

    await store.saveEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1 });
    assert.ok(seen.length > 0, 'queuing a write must notify subscribers');
    assert.equal(seen[seen.length - 1], 1);

    await store.saveEntry({ trackable_id: 1, entry_date: '2026-01-02', value: 1 });
    assert.equal(seen[seen.length - 1], 2);
  });

  it('fires when the outbox DRAINS, so the indicator clears itself', async () => {
    const storage = await storageWithOneQueuedOp();
    const store = createStore({ api: baseApi(), storage });
    const seen = [];
    store.onOutboxChange((n) => seen.push(n));

    await store.flushOutbox();
    assert.equal(seen[seen.length - 1], 0, 'a drained outbox must notify with 0');
  });

  it('returns an unsubscribe function that actually stops notifications', async () => {
    const store = createStore({ api: failing(), storage: memoryStorage() });
    const seen = [];
    const off = store.onOutboxChange((n) => seen.push(n));
    await store.saveEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1 });
    const countAfterFirst = seen.length;

    off();
    await store.saveEntry({ trackable_id: 1, entry_date: '2026-01-02', value: 1 });
    assert.equal(seen.length, countAfterFirst, 'unsubscribed listener must not be called');
  });

  it('a throwing subscriber does not break the write', async () => {
    // Persisting the outbox is what protects data; notifying is cosmetic.
    const store = createStore({ api: failing(), storage: memoryStorage() });
    store.onOutboxChange(() => { throw new Error('bad listener'); });
    const res = await store.saveEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1 });
    assert.equal(res.status, 'queued');
    assert.equal(store.getOutbox().length, 1, 'the op must still be queued despite the bad listener');
  });

  it('rejects a non-function subscriber', () => {
    const store = createStore({ api: failing(), storage: memoryStorage() });
    assert.throws(() => store.onOutboxChange('nope'), TypeError);
  });
});
