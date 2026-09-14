// Contract tests for the Step 4.1 additions to js/store.js — settings state
// (getSettings/loadSettings/saveSettings) and updateTrackable. Written
// strictly from CONTRACT-4.1.md §1; the implementation is being written in
// parallel and has NOT been read while writing this file.
//
// Mirrors tests/unit/store.test.mjs's fake-api / fake-storage pattern
// exactly (that file is read-only reference here, not imported — its
// helpers are not exported, so they are duplicated below in the minimal
// shape this file actually needs).
//
// Required cases: T1-T5 (CONTRACT-4.1.md §8).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, CACHE_KEY } from '../../js/store.js';

// ---------------------------------------------------------------------------
// Configurable, call-recording async mock (same shape as store.test.mjs's).
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

// A fully-populated fake `api` — store.js's constructor/other methods may
// reference these even though this file only calls a handful of them.
function createFakeApi() {
  return {
    listTrackables: createMock(),
    listEntries: createMock(),
    upsertEntry: createMock(),
    deleteEntry: createMock(),
    getSettings: createMock(),
    updateSettings: createMock(),
    updateTrackable: createMock(),
    assertValidEntry: (e) => e,
    assertId: (id) => String(id),
    assertDate: (d) => d,
    isRetryable: (err) => Boolean(err && err.retryable === true),
  };
}

function createFakeStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, val) {
      map.set(key, String(val));
    },
    removeItem(key) {
      map.delete(key);
    },
    _map: map,
  };
}

function seedCache(storage, { trackables = [], entries = [], settings } = {}) {
  const blob = { v: 1, trackables, entries };
  if (settings !== undefined) blob.settings = settings;
  storage.setItem(CACHE_KEY, JSON.stringify(blob));
}

function fixedNow(t = 1700000000000) {
  let n = t;
  return () => n++;
}

const RETRYABLE_ERR = { name: 'NetworkError', code: 'NETWORK', retryable: true, message: 'offline' };
function nonRetryableErr(status = 400) {
  return { name: 'ApiError', code: 'BAD_REQUEST', status, retryable: false, message: 'rejected' };
}

function persistedBlob(storage) {
  const raw = storage._map.get(CACHE_KEY);
  return raw ? JSON.parse(raw) : null;
}

// ===========================================================================
// T1 — hydrate()
// ===========================================================================

describe('T1 — hydrate() settings acceptance', () => {
  it('blob without a settings key -> getSettings() is null', () => {
    const storage = createFakeStorage();
    seedCache(storage, {}); // no `settings` key at all
    const store = createStore({ api: createFakeApi(), storage, now: fixedNow() });
    assert.equal(store.getSettings(), null);
  });

  it('a valid settings object -> returned as a copy; mutating the copy does not change the next call', () => {
    const storage = createFakeStorage();
    seedCache(storage, { settings: { rolling_window_days: 45 } });
    const store = createStore({ api: createFakeApi(), storage, now: fixedNow() });

    const first = store.getSettings();
    assert.deepEqual(first, { rolling_window_days: 45 });
    first.rolling_window_days = 999;

    const second = store.getSettings();
    assert.deepEqual(second, { rolling_window_days: 45 });
  });

  it('malformed settings values are all discarded to null', () => {
    const cases = [
      'a string',
      ['not', 'an', 'object'],
      {}, // missing rolling_window_days
      { rolling_window_days: NaN },
      { rolling_window_days: 'ninety' },
      { rolling_window_days: undefined },
      null,
      42,
    ];
    for (const bad of cases) {
      const storage = createFakeStorage();
      seedCache(storage, { settings: bad });
      const store = createStore({ api: createFakeApi(), storage, now: fixedNow() });
      assert.equal(store.getSettings(), null, `expected null for settings=${JSON.stringify(bad)}`);
    }
  });

  it('a valid settings object stores ONLY the rolling_window_days key, dropping extras', () => {
    const storage = createFakeStorage();
    seedCache(storage, { settings: { rolling_window_days: 60, extra: 'nope' } });
    const store = createStore({ api: createFakeApi(), storage, now: fixedNow() });
    assert.deepEqual(store.getSettings(), { rolling_window_days: 60 });
  });
});

// ===========================================================================
// T2 — loadSettings()
// ===========================================================================

describe('T2 — loadSettings()', () => {
  it('success: caches, persists (blob contains settings), and returns network/data', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    api.getSettings.resolveOnce({ id: 1, rolling_window_days: 45, updated_at: '2026-01-01T00:00:00Z' });
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.loadSettings();

    assert.equal(result.source, 'network');
    assert.equal(result.error, null);
    assert.deepEqual(result.data, { rolling_window_days: 45 });
    assert.deepEqual(store.getSettings(), { rolling_window_days: 45 });

    const blob = persistedBlob(storage);
    assert.deepEqual(blob.settings, { rolling_window_days: 45 });
  });

  it('failure (api rejects): returns cache/error, cache untouched, never rejects', async () => {
    const storage = createFakeStorage();
    seedCache(storage, { settings: { rolling_window_days: 30 } });
    const api = createFakeApi();
    const err = nonRetryableErr(500);
    api.getSettings.rejectOnce(err);
    const store = createStore({ api, storage, now: fixedNow() });

    let result;
    await assert.doesNotReject(async () => {
      result = await store.loadSettings();
    });

    assert.equal(result.source, 'cache');
    assert.equal(result.error, err);
    assert.deepEqual(result.data, { rolling_window_days: 30 });
    assert.deepEqual(store.getSettings(), { rolling_window_days: 30 });
    assert.deepEqual(persistedBlob(storage).settings, { rolling_window_days: 30 });
  });

  it('non-numeric row value -> treated as an error, never rejects, cache untouched (nothing cached before)', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    api.getSettings.resolveOnce({ id: 1, rolling_window_days: 'not-a-number' });
    const store = createStore({ api, storage, now: fixedNow() });

    let result;
    await assert.doesNotReject(async () => {
      result = await store.loadSettings();
    });

    assert.equal(result.source, 'cache');
    assert.equal(result.data, null); // nothing was ever cached
    assert.ok(result.error, 'expected an error object');
    assert.equal(result.error.name, 'ValidationError');
    assert.match(result.error.message, /rolling_window_days/);
    assert.equal(store.getSettings(), null);
    assert.equal(persistedBlob(storage), null, 'nothing should have been persisted');
  });

  it('non-numeric row value with a prior cached settings value -> old value preserved, error returned', async () => {
    const storage = createFakeStorage();
    seedCache(storage, { settings: { rolling_window_days: 30 } });
    const api = createFakeApi();
    api.getSettings.resolveOnce({ id: 1, rolling_window_days: NaN });
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.loadSettings();

    assert.equal(result.source, 'cache');
    assert.deepEqual(result.data, { rolling_window_days: 30 });
    assert.ok(result.error);
    assert.deepEqual(store.getSettings(), { rolling_window_days: 30 });
  });
});

// ===========================================================================
// T3 — saveSettings()
// ===========================================================================

describe('T3 — saveSettings()', () => {
  it('success: updates cache + blob, returns saved/data, nothing queued', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    api.updateSettings.resolveOnce({ id: 1, rolling_window_days: 30, updated_at: '2026-01-02T00:00:00Z' });
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.saveSettings({ rolling_window_days: 30 });

    assert.equal(result.status, 'saved');
    assert.deepEqual(result.data, { rolling_window_days: 30 });
    assert.deepEqual(store.getSettings(), { rolling_window_days: 30 });
    assert.deepEqual(persistedBlob(storage).settings, { rolling_window_days: 30 });
    assert.equal(api.updateSettings.calls.length, 1);
    assert.deepEqual(api.updateSettings.calls[0][0], { rolling_window_days: 30 });
    assert.deepEqual(store.getOutbox(), []);
  });

  it('failure: returns failed/error, cache AND blob unchanged, never rejects, nothing queued', async () => {
    const storage = createFakeStorage();
    seedCache(storage, { settings: { rolling_window_days: 90 } });
    const api = createFakeApi();
    const err = nonRetryableErr(500);
    api.updateSettings.rejectOnce(err);
    const store = createStore({ api, storage, now: fixedNow() });

    let result;
    await assert.doesNotReject(async () => {
      result = await store.saveSettings({ rolling_window_days: 30 });
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error, err);
    assert.deepEqual(store.getSettings(), { rolling_window_days: 90 }, 'cache must be unchanged on failure');
    assert.deepEqual(persistedBlob(storage).settings, { rolling_window_days: 90 });
    assert.deepEqual(store.getOutbox(), []);
  });

  it('a RETRYABLE-shaped rejection is still just "failed", never queued (settings writes are online-only)', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    api.updateSettings.rejectOnce(RETRYABLE_ERR);
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.saveSettings({ rolling_window_days: 30 });

    assert.equal(result.status, 'failed');
    assert.deepEqual(store.getOutbox(), []);
    assert.equal(store.getSettings(), null);
  });
});

// ===========================================================================
// T4 — updateTrackable()
// ===========================================================================

describe('T4 — updateTrackable()', () => {
  it('success: replaces the cached row whose String(id) matches, persists', async () => {
    const storage = createFakeStorage();
    seedCache(storage, {
      trackables: [
        { id: 1, name: 'A', sort_order: 0 },
        { id: 2, name: 'B', sort_order: 1 },
      ],
    });
    const api = createFakeApi();
    const updatedRow = { id: 1, name: 'A', sort_order: 5 };
    api.updateTrackable.resolveOnce(updatedRow);
    const store = createStore({ api, storage, now: fixedNow() });

    const result = await store.updateTrackable(1, { sort_order: 5 });

    assert.equal(result.status, 'saved');
    assert.deepEqual(result.data, updatedRow);
    assert.equal(api.updateTrackable.calls.length, 1);
    assert.deepEqual(api.updateTrackable.calls[0], [1, { sort_order: 5 }]);

    const trackables = store.getTrackables();
    assert.equal(trackables.length, 2);
    const row1 = trackables.find((t) => String(t.id) === '1');
    assert.deepEqual(row1, updatedRow);

    const blob = persistedBlob(storage);
    assert.deepEqual(blob.trackables.find((t) => String(t.id) === '1'), updatedRow);
  });

  it('success with string/number id mismatch still matches via String(id)', async () => {
    const storage = createFakeStorage();
    seedCache(storage, { trackables: [{ id: 2, name: 'B', sort_order: 1 }] });
    const api = createFakeApi();
    api.updateTrackable.resolveOnce({ id: 2, name: 'B', sort_order: 9 });
    const store = createStore({ api, storage, now: fixedNow() });

    await store.updateTrackable('2', { sort_order: 9 });

    const row = store.getTrackables().find((t) => String(t.id) === '2');
    assert.equal(row.sort_order, 9);
  });

  it('success appends the row when absent from the cache', async () => {
    const storage = createFakeStorage();
    seedCache(storage, { trackables: [{ id: 1, name: 'A', sort_order: 0 }] });
    const api = createFakeApi();
    const newRow = { id: 3, name: 'C', sort_order: 2 };
    api.updateTrackable.resolveOnce(newRow);
    const store = createStore({ api, storage, now: fixedNow() });

    await store.updateTrackable(3, { sort_order: 2 });

    const trackables = store.getTrackables();
    assert.equal(trackables.length, 2);
    assert.deepEqual(trackables.find((t) => String(t.id) === '3'), newRow);
  });

  it('failure: leaves the cache (and blob) unchanged, never rejects', async () => {
    const storage = createFakeStorage();
    seedCache(storage, { trackables: [{ id: 1, name: 'A', sort_order: 0 }] });
    const api = createFakeApi();
    const err = nonRetryableErr(400);
    api.updateTrackable.rejectOnce(err);
    const store = createStore({ api, storage, now: fixedNow() });

    let result;
    await assert.doesNotReject(async () => {
      result = await store.updateTrackable(1, { sort_order: 5 });
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error, err);
    assert.deepEqual(store.getTrackables(), [{ id: 1, name: 'A', sort_order: 0 }]);
    assert.deepEqual(persistedBlob(storage).trackables, [{ id: 1, name: 'A', sort_order: 0 }]);
  });
});

// ===========================================================================
// T5 — clear()
// ===========================================================================

describe('T5 — clear() resets settings', () => {
  it('clear() resets settings to null and removes the persisted blob', async () => {
    const storage = createFakeStorage();
    const api = createFakeApi();
    api.getSettings.resolveOnce({ id: 1, rolling_window_days: 45 });
    const store = createStore({ api, storage, now: fixedNow() });

    await store.loadSettings();
    assert.deepEqual(store.getSettings(), { rolling_window_days: 45 });
    assert.ok(storage._map.has(CACHE_KEY));

    store.clear();

    assert.equal(store.getSettings(), null);
    assert.equal(storage._map.has(CACHE_KEY), false);
  });
});
