// Contract tests for js/store.js — in-memory cache + localStorage mirror +
// offline outbox (BUILD_PLAN Step 1.1). Written strictly from the interface
// contract; the implementation is being written in parallel.
//
// The `api` dependency is fully injected here as a fake with configurable,
// call-recording methods — no real network, no real js/api.js network calls.
// Validation helpers (assertValidEntry/assertId/assertDate) are reimplemented
// locally to the documented contract shape, so these tests exercise store.js
// behavior in isolation from whatever js/api.js actually does internally.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, getStore, CACHE_KEY, OUTBOX_KEY } from '../../js/store.js';

// ---------------------------------------------------------------------------
// Local validation helpers matching the js/api.js contract exactly, used to
// build a self-contained fake `api` object.
// ---------------------------------------------------------------------------

class FakeValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION';
    this.retryable = false;
  }
}

function fakeAssertId(id, label) {
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id);
  if (typeof id === 'string' && /^\d+$/.test(id)) return id;
  throw new FakeValidationError(`invalid ${label}: ${JSON.stringify(id)}`);
}

function fakeAssertDate(date, label) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  throw new FakeValidationError(`invalid ${label}: ${JSON.stringify(date)}`);
}

function fakeAssertValidEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new FakeValidationError('entry must be a non-null, non-array object');
  }
  const allowed = new Set(['trackable_id', 'entry_date', 'value', 'note']);
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) throw new FakeValidationError(`unexpected key: ${key}`);
  }
  fakeAssertId(entry.trackable_id, 'trackable_id');
  const entry_date = fakeAssertDate(entry.entry_date, 'entry_date');
  if (typeof entry.value !== 'number' || !Number.isFinite(entry.value)) {
    throw new FakeValidationError('value must be a finite number');
  }
  const out = { trackable_id: entry.trackable_id, entry_date, value: entry.value };
  if ('note' in entry) {
    if (entry.note !== null && typeof entry.note !== 'string') {
      throw new FakeValidationError('note must be a string or null');
    }
    out.note = entry.note;
  }
  return out;
}

function fakeIsRetryable(err) {
  return Boolean(err && err.retryable === true);
}

// ---------------------------------------------------------------------------
// Configurable, call-recording async mock
// ---------------------------------------------------------------------------

function createMock() {
  const calls = [];
  const queue = [];
  let defaultImpl = async () => {
    throw new Error('mock called with no configured behavior');
  };
  const fn = async (...args) => {
    calls.push(args);
    const next = queue.shift();
    if (next) return next(...args);
    return defaultImpl(...args);
  };
  fn.calls = calls;
  fn.once = (impl) => {
    queue.push(impl);
    return fn;
  };
  fn.resolveOnce = (val) => fn.once(async () => val);
  fn.rejectOnce = (err) => fn.once(async () => { throw err; });
  fn.resolveDefault = (val) => {
    defaultImpl = async () => val;
    return fn;
  };
  fn.rejectDefault = (err) => {
    defaultImpl = async () => { throw err; };
    return fn;
  };
  return fn;
}

function createFakeApi() {
  return {
    listTrackables: createMock(),
    listEntries: createMock(),
    upsertEntry: createMock(),
    deleteEntry: createMock(),
    assertValidEntry: fakeAssertValidEntry,
    assertId: fakeAssertId,
    assertDate: fakeAssertDate,
    isRetryable: fakeIsRetryable,
  };
}

// ---------------------------------------------------------------------------
// Fake storage — Map-backed, never throws unless configured to.
// ---------------------------------------------------------------------------

function createFakeStorage() {
  const map = new Map();
  const state = { throwOnGet: false, throwOnSet: false };
  return {
    getItem(key) {
      if (state.throwOnGet) throw new Error('QuotaExceededError: get blocked');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, val) {
      if (state.throwOnSet) throw new Error('QuotaExceededError');
      map.set(key, String(val));
    },
    removeItem(key) {
      map.delete(key);
    },
    _map: map,
    _throwOnGet(v) {
      state.throwOnGet = v;
    },
    _throwOnSet(v) {
      state.throwOnSet = v;
    },
  };
}

function seedCache(storage, { trackables = [], entries = [] } = {}) {
  storage.setItem(CACHE_KEY, JSON.stringify({ v: 1, trackables, entries }));
}

function seedOutbox(storage, ops) {
  storage.setItem(OUTBOX_KEY, JSON.stringify({ v: 1, ops }));
}

function fixedNow(t = 1700000000000) {
  let n = t;
  return () => n++;
}

const RETRYABLE_ERR = { name: 'NetworkError', code: 'NETWORK', retryable: true, message: 'offline' };
function nonRetryableErr(status = 400) {
  return { name: 'ApiError', code: 'BAD_REQUEST', status, retryable: false, message: 'rejected' };
}

// ===========================================================================
// 1. Fresh store over empty storage
// ===========================================================================

describe('fresh store over empty storage', () => {
  it('getTrackables/getEntries/getOutbox all return [], no throw', () => {
    const store = createStore({ api: createFakeApi(), storage: createFakeStorage(), now: fixedNow() });
    assert.deepEqual(store.getTrackables(), []);
    assert.deepEqual(store.getEntries(), []);
    assert.deepEqual(store.getOutbox(), []);
  });
});

// ===========================================================================
// 2. Corrupt JSON in CACHE_KEY / OUTBOX_KEY
// ===========================================================================

describe('corrupt JSON hydration', () => {
  it('corrupt CACHE_KEY -> empty cache, key removed, no throw', () => {
    const storage = createFakeStorage();
    storage.setItem(CACHE_KEY, '{not valid json');
    let store;
    assert.doesNotThrow(() => {
      store = createStore({ api: createFakeApi(), storage, now: fixedNow() });
    });
    assert.deepEqual(store.getTrackables(), []);
    assert.equal(storage._map.has(CACHE_KEY), false);
  });

  it('corrupt OUTBOX_KEY -> empty outbox, key removed, no throw', () => {
    const storage = createFakeStorage();
    storage.setItem(OUTBOX_KEY, '[[[broken');
    let store;
    assert.doesNotThrow(() => {
      store = createStore({ api: createFakeApi(), storage, now: fixedNow() });
    });
    assert.deepEqual(store.getOutbox(), []);
    assert.equal(storage._map.has(OUTBOX_KEY), false);
  });
});

// ===========================================================================
// 3. Wrong version / wrong shape payloads discarded
// ===========================================================================

describe('wrong version / wrong shape payloads', () => {
  it('v:2 cache payload is discarded', () => {
    const storage = createFakeStorage();
    storage.setItem(CACHE_KEY, JSON.stringify({ v: 2, trackables: [{ id: 1 }], entries: [] }));
    const store = createStore({ api: createFakeApi(), storage, now: fixedNow() });
    assert.deepEqual(store.getTrackables(), []);
  });

  it('a JSON array (not an object) for cache is discarded', () => {
    const storage = createFakeStorage();
    storage.setItem(CACHE_KEY, JSON.stringify([1, 2, 3]));
    const store = createStore({ api: createFakeApi(), storage, now: fixedNow() });
    assert.deepEqual(store.getTrackables(), []);
  });

  it('a JSON array for outbox is discarded', () => {
    const storage = createFakeStorage();
    storage.setItem(OUTBOX_KEY, JSON.stringify([{ id: '1', type: 'upsert' }]));
    const store = createStore({ api: createFakeApi(), storage, now: fixedNow() });
    assert.deepEqual(store.getOutbox(), []);
  });
});

// ===========================================================================
// 4. Storage that always throws — store still fully works in memory
// ===========================================================================

describe('storage that always throws (iOS Safari private mode)', () => {
  it('save, queue, and read all succeed despite storage throwing on every op', async () => {
    const storage = createFakeStorage();
    storage._throwOnGet(true);
    storage._throwOnSet(true);
    const api = createFakeApi();
    api.upsertEntry.resolveDefault({ trackable_id: 1, entry_date: '2026-01-01', value: 5 });

    let store;
    assert.doesNotThrow(() => {
      store = createStore({ api, storage, now: fixedNow() });
    });

    const result = await store.saveEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 5 });
    assert.equal(result.status, 'saved');
    assert.equal(store.getEntry(1, '2026-01-01').value, 5);

    // queue path too
    api.deleteEntry.rejectDefault(RETRYABLE_ERR);
    const rm = await store.removeEntry(1, '2026-01-01');
    assert.equal(rm.status, 'queued');
    assert.equal(store.getOutbox().length, 1);
  });
});

// ===========================================================================
// 5. loadTrackables success
// ===========================================================================

describe('loadTrackables — success', () => {
  it('replaces cache, source network, persists v:1 with new rows', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    const rows = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
    api.listTrackables.resolveOnce(rows);
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.loadTrackables();
    assert.equal(result.source, 'network');
    assert.deepEqual(result.data, rows);
    assert.deepEqual(store.getTrackables(), rows);

    const persisted = JSON.parse(storage._map.get(CACHE_KEY));
    assert.equal(persisted.v, 1);
    assert.deepEqual(persisted.trackables, rows);
  });
});

// ===========================================================================
// 6. loadTrackables failure — cache stays intact
// ===========================================================================

describe('loadTrackables — failure', () => {
  it('returns cached data + error, source cache, no throw, cache unchanged', async () => {
    const storage = createFakeStorage();
    seedCache(storage, { trackables: [{ id: 9, name: 'existing' }] });
    const api = createFakeApi();
    const err = nonRetryableErr(500);
    api.listTrackables.rejectOnce(err);
    const store = createStore({ api, storage, now: fixedNow() });

    let result;
    await assert.doesNotReject(async () => {
      result = await store.loadTrackables();
    });
    assert.equal(result.source, 'cache');
    assert.deepEqual(result.data, [{ id: 9, name: 'existing' }]);
    assert.equal(result.error, err);
    assert.deepEqual(store.getTrackables(), [{ id: 9, name: 'existing' }]);
  });
});

// ===========================================================================
// 7. Cache must never overwrite server
// ===========================================================================

describe('loadEntries — server is authoritative, never overwritten by stale cache', () => {
  it('server value 9 wins over cached value 5 for the same trackable/day', async () => {
    const storage = createFakeStorage();
    seedCache(storage, {
      entries: [{ trackable_id: 1, entry_date: '2026-01-01', value: 5 }],
    });
    const api = createFakeApi();
    api.listEntries.resolveOnce([{ trackable_id: 1, entry_date: '2026-01-01', value: 9 }]);
    const store = createStore({ api, storage, now: fixedNow() });

    assert.equal(store.getEntry(1, '2026-01-01').value, 5);
    await store.loadEntries({ trackableIds: [1], from: '2026-01-01', to: '2026-01-01' });
    assert.equal(store.getEntry(1, '2026-01-01').value, 9);
  });
});

// ===========================================================================
// 8. In-window drop, out-of-window survive
// ===========================================================================

describe('loadEntries — window-scoped replace', () => {
  it('a cached entry inside the window not returned by the server is dropped; entries outside survive', async () => {
    const storage = createFakeStorage();
    seedCache(storage, {
      entries: [
        { trackable_id: 1, entry_date: '2026-01-05', value: 1 }, // inside window, will be dropped
        { trackable_id: 2, entry_date: '2026-01-05', value: 2 }, // different trackable, outside window
        { trackable_id: 1, entry_date: '2026-02-01', value: 3 }, // same trackable, date outside range
      ],
    });
    const api = createFakeApi();
    api.listEntries.resolveOnce([]); // server has nothing for trackable 1 in-range
    const store = createStore({ api, storage, now: fixedNow() });

    await store.loadEntries({ trackableIds: [1], from: '2026-01-01', to: '2026-01-10' });

    assert.equal(store.getEntry(1, '2026-01-05'), null, 'in-window row not returned by server must be dropped');
    assert.equal(store.getEntry(2, '2026-01-05').value, 2, 'different trackable must survive');
    assert.equal(store.getEntry(1, '2026-02-01').value, 3, 'out-of-range date must survive');
  });
});

// ===========================================================================
// 9. Pending outbox op survives a network reload
// ===========================================================================

describe('loadEntries — a pending outbox op is reapplied on top of the server response', () => {
  it('a queued save is still readable and still pending after a reload that omits it', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    api.upsertEntry.rejectDefault(RETRYABLE_ERR);
    const store = createStore({ api, storage, now: fixedNow() });

    const saveResult = await store.saveEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 42 });
    assert.equal(saveResult.status, 'queued');
    assert.equal(store.getEntry(1, '2026-01-01').value, 42);
    assert.equal(store.getEntry(1, '2026-01-01').pending, true);

    api.listEntries.resolveOnce([]); // server response lacks the pending entry entirely
    await store.loadEntries({ trackableIds: [1], from: '2026-01-01', to: '2026-01-01' });

    const after = store.getEntry(1, '2026-01-01');
    assert.ok(after, 'pending entry must survive the reload');
    assert.equal(after.value, 42);
    assert.equal(after.pending, true);
  });
});

// ===========================================================================
// 10. saveEntry happy path
// ===========================================================================

describe('saveEntry — happy path', () => {
  it('calls api.upsertEntry once with the normalized payload, status saved, no pending, empty outbox', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    const serverRow = { id: 100, trackable_id: 1, entry_date: '2026-01-01', value: 7, note: null };
    api.upsertEntry.resolveOnce(serverRow);
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.saveEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 7 });

    assert.equal(api.upsertEntry.calls.length, 1);
    assert.deepEqual(api.upsertEntry.calls[0][0], { trackable_id: 1, entry_date: '2026-01-01', value: 7 });
    assert.equal(result.status, 'saved');
    assert.deepEqual(result.entry, serverRow);
    assert.equal(result.error, null);

    const cached = store.getEntry(1, '2026-01-01');
    assert.equal(cached.value, 7);
    assert.equal('pending' in cached, false);
    assert.deepEqual(store.getOutbox(), []);
  });
});

// ===========================================================================
// 11. saveEntry retryable error -> queued
// ===========================================================================

describe('saveEntry — retryable error', () => {
  it('status queued, optimistic value readable with pending:true, one outbox op', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    api.upsertEntry.rejectOnce(RETRYABLE_ERR);
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.saveEntry({ trackable_id: 3, entry_date: '2026-01-02', value: 11 });

    assert.equal(result.status, 'queued');
    const cached = store.getEntry(3, '2026-01-02');
    assert.equal(cached.value, 11);
    assert.equal(cached.pending, true);

    const outbox = store.getOutbox();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].type, 'upsert');
    assert.equal(outbox[0].key, '3|2026-01-02');
    assert.deepEqual(outbox[0].payload, { trackable_id: 3, entry_date: '2026-01-02', value: 11 });
  });
});

// ===========================================================================
// 12. saveEntry non-retryable error -> failed, revert, no ghost
// ===========================================================================

describe('saveEntry — non-retryable error', () => {
  it('status failed, cache reverted, no prior entry -> row absent afterward, outbox stays empty', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    api.upsertEntry.rejectOnce(nonRetryableErr(400));
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.saveEntry({ trackable_id: 4, entry_date: '2026-01-03', value: 99 });

    assert.equal(result.status, 'failed');
    assert.equal(result.entry, null);
    assert.equal(store.getEntry(4, '2026-01-03'), null, 'must not leave a ghost row');
    assert.deepEqual(store.getOutbox(), []);
  });
});

// ===========================================================================
// 13. saveEntry invalid entry -> throws, no api call, nothing mutated
// ===========================================================================

describe('saveEntry — invalid entry', () => {
  it('throws ValidationError, api.upsertEntry never called, memory/storage unchanged', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    const store = createStore({ api, storage, now: fixedNow() });

    const before = store.getTrackables();
    const beforeOutbox = store.getOutbox();

    await assert.rejects(
      () => store.saveEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1, updated_at: 'nope' }),
      { name: 'ValidationError' }
    );

    assert.equal(api.upsertEntry.calls.length, 0);
    assert.deepEqual(store.getTrackables(), before);
    assert.deepEqual(store.getOutbox(), beforeOutbox);
    assert.equal(store.getEntry(1, '2026-01-01'), null);
  });
});

// ===========================================================================
// 14. Dedupe, position preserved
// ===========================================================================

describe('outbox dedupe — position preserved, latest payload wins', () => {
  it('A, B, A(new value) -> 2 ops, A still first, newer value', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    api.upsertEntry.rejectDefault(RETRYABLE_ERR);
    const store = createStore({ api, storage, now: fixedNow() });

    await store.saveEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1 }); // A
    await store.saveEntry({ trackable_id: 2, entry_date: '2026-01-02', value: 2 }); // B
    await store.saveEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 3 }); // A again

    const outbox = store.getOutbox();
    assert.equal(outbox.length, 2);
    assert.equal(outbox[0].key, '1|2026-01-01');
    assert.equal(outbox[0].payload.value, 3);
    assert.equal(outbox[1].key, '2|2026-01-02');
  });
});

// ===========================================================================
// 15. delete replaces queued upsert and vice versa
// ===========================================================================

describe('outbox dedupe — delete/upsert mutual replacement', () => {
  it('a queued delete replaces a queued upsert for the same key', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    api.upsertEntry.rejectDefault(RETRYABLE_ERR);
    api.deleteEntry.rejectDefault(RETRYABLE_ERR);
    const store = createStore({ api, storage, now: fixedNow() });

    await store.saveEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1 });
    assert.equal(store.getOutbox().length, 1);
    assert.equal(store.getOutbox()[0].type, 'upsert');

    await store.removeEntry(1, '2026-01-01');
    const outbox = store.getOutbox();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].type, 'delete');
    assert.equal(outbox[0].key, '1|2026-01-01');
  });

  it('a queued upsert replaces a queued delete for the same key', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    api.upsertEntry.rejectDefault(RETRYABLE_ERR);
    api.deleteEntry.rejectDefault(RETRYABLE_ERR);
    const store = createStore({ api, storage, now: fixedNow() });

    await store.removeEntry(1, '2026-01-01');
    assert.equal(store.getOutbox().length, 1);
    assert.equal(store.getOutbox()[0].type, 'delete');

    await store.saveEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 5 });
    const outbox = store.getOutbox();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].type, 'upsert');
    assert.equal(outbox[0].key, '1|2026-01-01');
  });
});

// ===========================================================================
// 16-20. flushOutbox
// ===========================================================================

describe('flushOutbox', () => {
  it('all succeed -> sent:N, failed:0, remaining:0, outbox empty, pending cleared', async () => {
    const storage = createFakeStorage();
    seedCache(storage, {
      entries: [
        { trackable_id: 1, entry_date: '2026-01-01', value: 1, pending: true },
        { trackable_id: 2, entry_date: '2026-01-02', value: 2, pending: true },
      ],
    });
    seedOutbox(storage, [
      {
        id: '1-0',
        type: 'upsert',
        key: '1|2026-01-01',
        payload: { trackable_id: 1, entry_date: '2026-01-01', value: 1 },
        queuedAt: 1,
      },
      {
        id: '1-1',
        type: 'upsert',
        key: '2|2026-01-02',
        payload: { trackable_id: 2, entry_date: '2026-01-02', value: 2 },
        queuedAt: 2,
      },
    ]);
    const api = createFakeApi();
    api.upsertEntry.resolveOnce({ id: 10, trackable_id: 1, entry_date: '2026-01-01', value: 1 });
    api.upsertEntry.resolveOnce({ id: 11, trackable_id: 2, entry_date: '2026-01-02', value: 2 });
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.flushOutbox();
    assert.deepEqual(result, { sent: 2, failed: 0, remaining: 0 });
    assert.deepEqual(store.getOutbox(), []);
    assert.equal('pending' in store.getEntry(1, '2026-01-01'), false);
    assert.equal('pending' in store.getEntry(2, '2026-01-02'), false);
  });

  it('stops at the first retryable failure — later ops stay queued in order', async () => {
    const storage = createFakeStorage();
    seedOutbox(storage, [
      { id: 'a', type: 'upsert', key: '1|2026-01-01', payload: { trackable_id: 1, entry_date: '2026-01-01', value: 1 }, queuedAt: 1 },
      { id: 'b', type: 'upsert', key: '2|2026-01-02', payload: { trackable_id: 2, entry_date: '2026-01-02', value: 2 }, queuedAt: 2 },
      { id: 'c', type: 'upsert', key: '3|2026-01-03', payload: { trackable_id: 3, entry_date: '2026-01-03', value: 3 }, queuedAt: 3 },
    ]);
    const api = createFakeApi();
    api.upsertEntry.resolveOnce({ id: 1, trackable_id: 1, entry_date: '2026-01-01', value: 1 });
    api.upsertEntry.rejectOnce(RETRYABLE_ERR);
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.flushOutbox();
    assert.equal(api.upsertEntry.calls.length, 2, 'must stop after the second (failing) call');
    assert.equal(result.remaining, 2);
    const remaining = store.getOutbox();
    assert.equal(remaining.length, 2);
    assert.equal(remaining[0].key, '2|2026-01-02');
    assert.equal(remaining[1].key, '3|2026-01-03');
  });

  it('drops a non-retryable op and continues to the next', async () => {
    const storage = createFakeStorage();
    seedOutbox(storage, [
      { id: 'a', type: 'upsert', key: '1|2026-01-01', payload: { trackable_id: 1, entry_date: '2026-01-01', value: 1 }, queuedAt: 1 },
      { id: 'b', type: 'upsert', key: '2|2026-01-02', payload: { trackable_id: 2, entry_date: '2026-01-02', value: 2 }, queuedAt: 2 },
      { id: 'c', type: 'upsert', key: '3|2026-01-03', payload: { trackable_id: 3, entry_date: '2026-01-03', value: 3 }, queuedAt: 3 },
    ]);
    const api = createFakeApi();
    api.upsertEntry.resolveOnce({ id: 1, trackable_id: 1, entry_date: '2026-01-01', value: 1 });
    api.upsertEntry.rejectOnce(nonRetryableErr(400));
    api.upsertEntry.resolveOnce({ id: 3, trackable_id: 3, entry_date: '2026-01-03', value: 3 });
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.flushOutbox();
    assert.deepEqual(result, { sent: 2, failed: 1, remaining: 0 });
    assert.deepEqual(store.getOutbox(), []);
    assert.equal(api.upsertEntry.calls.length, 3);
  });

  it('empty outbox -> all zeros, zero api calls', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.flushOutbox();
    assert.deepEqual(result, { sent: 0, failed: 0, remaining: 0 });
    assert.equal(api.upsertEntry.calls.length, 0);
    assert.equal(api.deleteEntry.calls.length, 0);
  });

  it('replays ops in FIFO order — payload sequence matches queue order', async () => {
    const storage = createFakeStorage();
    seedOutbox(storage, [
      { id: 'a', type: 'upsert', key: '1|2026-01-01', payload: { trackable_id: 1, entry_date: '2026-01-01', value: 100 }, queuedAt: 1 },
      { id: 'b', type: 'upsert', key: '2|2026-01-02', payload: { trackable_id: 2, entry_date: '2026-01-02', value: 200 }, queuedAt: 2 },
      { id: 'c', type: 'upsert', key: '3|2026-01-03', payload: { trackable_id: 3, entry_date: '2026-01-03', value: 300 }, queuedAt: 3 },
    ]);
    const api = createFakeApi();
    api.upsertEntry.resolveDefault({ id: 1 });
    const store = createStore({ api, storage, now: fixedNow() });

    await store.flushOutbox();
    const values = api.upsertEntry.calls.map(([payload]) => payload.value);
    assert.deepEqual(values, [100, 200, 300]);
  });
});

// ===========================================================================
// 21. Persistence across instances
// ===========================================================================

describe('persistence across store instances sharing the same storage', () => {
  it('a second store built over the same storage sees a saved entry and a queued op', async () => {
    const storage = createFakeStorage();
    const apiA = createFakeApi();
    apiA.upsertEntry.resolveOnce({ id: 1, trackable_id: 1, entry_date: '2026-01-01', value: 5 });
    const storeA = createStore({ api: apiA, storage, now: fixedNow() });
    await storeA.saveEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 5 });

    apiA.upsertEntry.rejectOnce(RETRYABLE_ERR);
    await storeA.saveEntry({ trackable_id: 2, entry_date: '2026-01-02', value: 9 });

    const storeB = createStore({ api: createFakeApi(), storage, now: fixedNow() });
    assert.equal(storeB.getEntry(1, '2026-01-01').value, 5);
    assert.equal(storeB.getOutbox().length, 1);
    assert.equal(storeB.getOutbox()[0].key, '2|2026-01-02');
  });
});

// ===========================================================================
// 22. getEntries filtering + sorting
// ===========================================================================

describe('getEntries — filtering and sorting', () => {
  function buildStoreWithEntries() {
    const storage = createFakeStorage();
    seedCache(storage, {
      entries: [
        { trackable_id: 1, entry_date: '2026-01-05', value: 1 },
        { trackable_id: 2, entry_date: '2026-01-01', value: 2 },
        { trackable_id: 1, entry_date: '2026-01-01', value: 3 },
        { trackable_id: 3, entry_date: '2026-01-10', value: 4 },
      ],
    });
    return createStore({ api: createFakeApi(), storage, now: fixedNow() });
  }

  it('unfiltered returns everything sorted by entry_date asc, trackable_id asc', () => {
    const store = buildStoreWithEntries();
    const rows = store.getEntries();
    assert.deepEqual(
      rows.map((r) => [r.entry_date, r.trackable_id]),
      [
        ['2026-01-01', 1],
        ['2026-01-01', 2],
        ['2026-01-05', 1],
        ['2026-01-10', 3],
      ]
    );
  });

  it('filters by trackableIds', () => {
    const store = buildStoreWithEntries();
    const rows = store.getEntries({ trackableIds: [1] });
    assert.deepEqual(
      rows.map((r) => r.entry_date),
      ['2026-01-01', '2026-01-05']
    );
  });

  it('filters by from/to', () => {
    const store = buildStoreWithEntries();
    const rows = store.getEntries({ from: '2026-01-02', to: '2026-01-10' });
    assert.deepEqual(
      rows.map((r) => [r.entry_date, r.trackable_id]),
      [
        ['2026-01-05', 1],
        ['2026-01-10', 3],
      ]
    );
  });
});

// ===========================================================================
// 23. getEntry — number/string tolerant matching
// ===========================================================================

describe('getEntry — number/string tolerant matching', () => {
  it('cached with number id, queried with string, matches', () => {
    const storage = createFakeStorage();
    seedCache(storage, { entries: [{ trackable_id: 1, entry_date: '2026-01-01', value: 1 }] });
    const store = createStore({ api: createFakeApi(), storage, now: fixedNow() });
    assert.equal(store.getEntry('1', '2026-01-01').value, 1);
  });

  it('cached with string id, queried with number, matches', () => {
    const storage = createFakeStorage();
    seedCache(storage, { entries: [{ trackable_id: '1', entry_date: '2026-01-01', value: 1 }] });
    const store = createStore({ api: createFakeApi(), storage, now: fixedNow() });
    assert.equal(store.getEntry(1, '2026-01-01').value, 1);
  });

  it('returns null for a miss', () => {
    const store = createStore({ api: createFakeApi(), storage: createFakeStorage(), now: fixedNow() });
    assert.equal(store.getEntry(999, '2026-01-01'), null);
  });
});

// ===========================================================================
// 24. getTrackables returns a copy
// ===========================================================================

describe('getTrackables — returns a copy', () => {
  it('mutating the returned array does not affect the next call', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    api.listTrackables.resolveOnce([{ id: 1, name: 'A' }]);
    const store = createStore({ api, storage, now: fixedNow() });
    await store.loadTrackables();

    const first = store.getTrackables();
    first.push({ id: 999, name: 'injected' });
    first[0].name = 'mutated';

    const second = store.getTrackables();
    assert.equal(second.length, 1);
    assert.equal(second[0].name, 'A');
  });
});

// ===========================================================================
// 25. getStore — singleton, no throw without localStorage
// ===========================================================================

describe('getStore — singleton', () => {
  it('repeated calls return the identical object and do not throw (no localStorage in Node)', () => {
    assert.equal(typeof globalThis.localStorage, 'undefined');
    let a, b;
    assert.doesNotThrow(() => {
      a = getStore();
      b = getStore();
    });
    assert.equal(a, b);
  });
});

// ===========================================================================
// 26. removeEntry
// ===========================================================================

describe('removeEntry', () => {
  it('happy path removes the cached row', async () => {
    const storage = createFakeStorage();
    seedCache(storage, { entries: [{ trackable_id: 1, entry_date: '2026-01-01', value: 5 }] });
    const api = createFakeApi();
    api.deleteEntry.resolveOnce(1);
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.removeEntry(1, '2026-01-01');
    assert.equal(result.status, 'saved');
    assert.equal(store.getEntry(1, '2026-01-01'), null);
  });

  it('offline: retryable failure queues a delete op', async () => {
    const storage = createFakeStorage();
    seedCache(storage, { entries: [{ trackable_id: 1, entry_date: '2026-01-01', value: 5 }] });
    const api = createFakeApi();
    api.deleteEntry.rejectOnce(RETRYABLE_ERR);
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.removeEntry(1, '2026-01-01');
    assert.equal(result.status, 'queued');
    const outbox = store.getOutbox();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].type, 'delete');
    assert.equal(outbox[0].key, '1|2026-01-01');
    assert.deepEqual(outbox[0].payload, { trackable_id: 1, entry_date: '2026-01-01' });
  });

  it('non-retryable failure reverts to the previous row', async () => {
    const storage = createFakeStorage();
    seedCache(storage, { entries: [{ trackable_id: 1, entry_date: '2026-01-01', value: 5 }] });
    const api = createFakeApi();
    api.deleteEntry.rejectOnce(nonRetryableErr(400));
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.removeEntry(1, '2026-01-01');
    assert.equal(result.status, 'failed');
    const restored = store.getEntry(1, '2026-01-01');
    assert.ok(restored, 'row must be restored on non-retryable failure');
    assert.equal(restored.value, 5);
  });

  it('validates via assertId/assertDate first — invalid input throws, api never called', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    const store = createStore({ api, storage, now: fixedNow() });

    await assert.rejects(() => store.removeEntry('not-an-id', '2026-01-01'), { name: 'ValidationError' });
    assert.equal(api.deleteEntry.calls.length, 0);
  });
});

// ===========================================================================
// 27. clear()
// ===========================================================================

describe('clear()', () => {
  it('empties memory and removes both storage keys', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    api.upsertEntry.resolveOnce({ id: 1, trackable_id: 1, entry_date: '2026-01-01', value: 1 });
    const store = createStore({ api, storage, now: fixedNow() });
    await store.saveEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1 });
    assert.ok(storage._map.has(CACHE_KEY));

    store.clear();

    assert.deepEqual(store.getTrackables(), []);
    assert.deepEqual(store.getEntries(), []);
    assert.deepEqual(store.getOutbox(), []);
    assert.equal(storage._map.has(CACHE_KEY), false);
    assert.equal(storage._map.has(OUTBOX_KEY), false);
  });
});

// ===========================================================================
// 28. Regression: dequeueByKey() must persist the shrunken outbox to
// storage, not just update it in memory.
//
// The bug (fixed in js/store.js): a satisfied op (a save/delete that
// succeeded after being queued) was removed from the in-memory `outbox`
// array but the OUTBOX_KEY payload in storage was never rewritten to
// match — only persistCache() ran, never persistOutbox(). So:
//   1. A save fails offline -> the op is queued AND persisted to
//      storage[OUTBOX_KEY].
//   2. The same entry is saved again and succeeds -> the op is dropped
//      from the in-memory outbox, but storage[OUTBOX_KEY] still has it.
//   3. The app "relaunches" (a new store is built over the same
//      storage) -> hydrate() reads the stale op back in from storage.
//   4. flushOutbox() would replay it, clobbering the newer server value
//      with the stale queued one — exactly the "cache overwrites
//      server" bug store.js's header comment forbids.
//
// This is why these tests assert on the raw storage payload (parsing
// storage._map.get(OUTBOX_KEY) directly) rather than store.getOutbox():
// an in-memory-only assertion passes under the old buggy code too,
// because the bug is specifically that memory and storage disagree. Do
// not "simplify" these back down to a getOutbox()-only check — that
// would silently stop covering the bug that was actually fixed.
// ===========================================================================

describe('dequeueByKey persists the shrunken outbox to storage (regression)', () => {
  it('saveEntry: a satisfied queued upsert is dropped from persisted OUTBOX_KEY, and does not come back after a simulated relaunch', async () => {
    const storage = createFakeStorage();
    const apiA = createFakeApi();
    apiA.upsertEntry.rejectOnce(RETRYABLE_ERR);
    const storeA = createStore({ api: apiA, storage, now: fixedNow() });

    // 1. Fails offline -> queued, and persisted to storage.
    const queued = await storeA.saveEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1 });
    assert.equal(queued.status, 'queued');

    const persistedAfterQueue = JSON.parse(storage._map.get(OUTBOX_KEY));
    assert.equal(persistedAfterQueue.ops.length, 1);
    assert.equal(persistedAfterQueue.ops[0].key, '1|2026-01-01');

    // 2. Same (trackable_id, entry_date) saved again, this time the
    // server accepts it with a newer value.
    apiA.upsertEntry.resolveOnce({ id: 100, trackable_id: 1, entry_date: '2026-01-01', value: 9 });
    const saved = await storeA.saveEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 9 });
    assert.equal(saved.status, 'saved');

    // The persisted payload -- not just storeA.getOutbox() -- must now be
    // empty.
    const persistedAfterSave = JSON.parse(storage._map.get(OUTBOX_KEY));
    assert.deepEqual(persistedAfterSave.ops, []);

    // 3. "Relaunch": a brand-new store built over the same storage must
    // not resurrect the satisfied op.
    const storeB = createStore({ api: createFakeApi(), storage, now: fixedNow() });
    assert.deepEqual(storeB.getOutbox(), []);
  });

  it('removeEntry: a satisfied queued delete is dropped from persisted OUTBOX_KEY, and does not come back after a simulated relaunch', async () => {
    const storage = createFakeStorage();
    const apiA = createFakeApi();
    apiA.deleteEntry.rejectOnce(RETRYABLE_ERR);
    const storeA = createStore({ api: apiA, storage, now: fixedNow() });

    // 1. Fails offline -> queued, and persisted to storage.
    const queued = await storeA.removeEntry(1, '2026-01-01');
    assert.equal(queued.status, 'queued');

    const persistedAfterQueue = JSON.parse(storage._map.get(OUTBOX_KEY));
    assert.equal(persistedAfterQueue.ops.length, 1);
    assert.equal(persistedAfterQueue.ops[0].key, '1|2026-01-01');

    // 2. Same (trackable_id, entry_date) removed again, this time the
    // server accepts the delete.
    apiA.deleteEntry.resolveOnce(1);
    const removed = await storeA.removeEntry(1, '2026-01-01');
    assert.equal(removed.status, 'saved');

    // The persisted payload -- not just storeA.getOutbox() -- must now be
    // empty.
    const persistedAfterRemove = JSON.parse(storage._map.get(OUTBOX_KEY));
    assert.deepEqual(persistedAfterRemove.ops, []);

    // 3. "Relaunch": a brand-new store built over the same storage must
    // not resurrect the satisfied op.
    const storeB = createStore({ api: createFakeApi(), storage, now: fixedNow() });
    assert.deepEqual(storeB.getOutbox(), []);
  });
});
