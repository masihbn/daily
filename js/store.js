// In-memory cache of trackables/entries, mirrored to localStorage so the
// app has something to show offline. NETWORK IS THE SOURCE OF TRUTH — the
// cache exists only as a read-only fallback for offline display and as a
// staging area for writes that haven't reached the server yet. A cached
// value must never be allowed to overwrite a server value on reconnect;
// see loadEntries()'s window-scoped replace + outbox re-apply below.
//
// Failed writes are queued in a localStorage outbox (never silently
// dropped) and replayed by flushOutbox(). See the outbox dedupe rule in
// enqueueOp(): at most one pending op per (trackable_id, entry_date).

import * as defaultApi from './api.js';

export const CACHE_KEY = 'daily.cache.v1';
export const OUTBOX_KEY = 'daily.outbox.v1';

// --- storage ---------------------------------------------------------------

// iOS Safari private mode throws QuotaExceededError on setItem — a
// logging app must never die on that. Every storage call anywhere in this
// module goes through the wrappers below, which swallow all errors.
function safeGetItem(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    // Best-effort mirror only — the in-memory copy remains correct.
  }
}

function safeRemoveItem(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    // Nothing more to do — see safeSetItem.
  }
}

function memoryShim() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

// Prefer real localStorage, but only if a probe write actually succeeds —
// private-mode Safari can expose a localStorage object whose methods throw,
// which is worse than not having one because every call site would need
// its own guard. Falling back to an in-memory shim here means the rest of
// the module never has to think about it again.
export function defaultStorage() {
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      const probeKey = '__daily_storage_probe__';
      ls.setItem(probeKey, '1');
      ls.removeItem(probeKey);
      return ls;
    }
  } catch {
    // Fall through to the in-memory shim.
  }
  return memoryShim();
}

// --- pure helpers ------------------------------------------------------

function entryKey(trackableId, entryDate) {
  return `${trackableId}|${entryDate}`;
}

function sameId(a, b) {
  return String(a) === String(b);
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.entry_date !== b.entry_date) return a.entry_date < b.entry_date ? -1 : 1;
    const at = String(a.trackable_id);
    const bt = String(b.trackable_id);
    if (at !== bt) return at < bt ? -1 : 1;
    return 0;
  });
}

function filterEntries(entries, { trackableIds, from, to } = {}) {
  let idSet = null;
  if (Array.isArray(trackableIds) && trackableIds.length > 0) {
    idSet = new Set(trackableIds.map(String));
  }
  const fromOk = typeof from === 'string' ? from : null;
  const toOk = typeof to === 'string' ? to : null;

  return entries.filter((e) => {
    if (idSet && !idSet.has(String(e.trackable_id))) return false;
    if (fromOk && !(e.entry_date >= fromOk)) return false;
    if (toOk && !(e.entry_date <= toOk)) return false;
    return true;
  });
}

// Entries whose (trackable_id filter, date range) fall inside a just-loaded
// window are dropped from the cache before the server rows for that window
// are spliced in — this is what keeps "network is authoritative for the
// requested window" true without clobbering cached data outside it.
function isInWindow(entry, { trackableIds, from, to } = {}) {
  if (Array.isArray(trackableIds) && trackableIds.length > 0) {
    const idSet = new Set(trackableIds.map(String));
    if (!idSet.has(String(entry.trackable_id))) return false;
  }
  if (typeof from === 'string' && !(entry.entry_date >= from)) return false;
  if (typeof to === 'string' && !(entry.entry_date <= to)) return false;
  return true;
}

// --- factory -----------------------------------------------------------

export function createStore({ api = defaultApi, storage = defaultStorage(), now = Date.now } = {}) {
  let trackables = [];
  let entries = [];
  let outbox = [];
  let opCounter = 0;

  function persistCache() {
    safeSetItem(storage, CACHE_KEY, JSON.stringify({ v: 1, trackables, entries }));
  }

  function persistOutbox() {
    safeSetItem(storage, OUTBOX_KEY, JSON.stringify({ v: 1, ops: outbox }));
  }

  function hydrate() {
    const rawCache = safeGetItem(storage, CACHE_KEY);
    if (rawCache !== null) {
      let parsed = null;
      try {
        parsed = JSON.parse(rawCache);
      } catch {
        parsed = null;
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        parsed.v === 1
      ) {
        trackables = Array.isArray(parsed.trackables) ? parsed.trackables : [];
        entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      } else {
        safeRemoveItem(storage, CACHE_KEY);
      }
    }

    const rawOutbox = safeGetItem(storage, OUTBOX_KEY);
    if (rawOutbox !== null) {
      let parsed = null;
      try {
        parsed = JSON.parse(rawOutbox);
      } catch {
        parsed = null;
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        parsed.v === 1
      ) {
        outbox = Array.isArray(parsed.ops) ? parsed.ops : [];
      } else {
        safeRemoveItem(storage, OUTBOX_KEY);
      }
    }
  }

  hydrate();

  // Enqueues (or replaces in place) the pending op for `key`, preserving
  // queue position — a 'delete' replacing a queued 'upsert' (or vice
  // versa) must not jump to the back of the line, and different days'
  // ordering must stay stable. See "Outbox dedupe rule" in the contract.
  function enqueueOp(type, key, payload) {
    const existingIndex = outbox.findIndex((op) => op.key === key);
    const op = { id: `${now()}-${opCounter++}`, type, key, payload, queuedAt: now() };
    if (existingIndex === -1) {
      outbox.push(op);
    } else {
      outbox[existingIndex] = op;
    }
    persistOutbox();
  }

  // Persists internally, deliberately — every call site that resolves an
  // outbox op (saveEntry/removeEntry success, flushOutbox) must drop it
  // from BOTH memory and storage in the same step. A prior version left
  // this to callers and one of them forgot persistOutbox(): a satisfied
  // op stayed in localStorage, so a later hydrate() + flushOutbox() could
  // replay a stale write over a newer server value — exactly the
  // "cache overwrites server on reconnect" bug this module's header
  // comment forbids. Do not hoist this persist back out to the callers.
  function dequeueByKey(key) {
    outbox = outbox.filter((op) => op.key !== key);
    persistOutbox();
  }

  function findEntryIndex(trackableId, entryDate) {
    return entries.findIndex(
      (e) => sameId(e.trackable_id, trackableId) && e.entry_date === entryDate
    );
  }

  // --- synchronous readers ----------------------------------------------

  function getTrackables() {
    return trackables.map((t) => ({ ...t }));
  }

  function getEntries(filters = {}) {
    return sortEntries(filterEntries(entries, filters)).map((e) => ({ ...e }));
  }

  function getEntry(trackableId, entryDate) {
    const idx = findEntryIndex(trackableId, entryDate);
    return idx === -1 ? null : { ...entries[idx] };
  }

  function getOutbox() {
    return outbox.map((op) => ({ ...op }));
  }

  // --- async operations ---------------------------------------------------

  async function loadTrackables({ includeArchived = false } = {}) {
    try {
      const data = await api.listTrackables({ includeArchived });
      trackables = data;
      persistCache();
      // Return a defensive copy so a caller mutating the result can't
      // corrupt the internal cache — same guarantee getTrackables() gives.
      return { data: getTrackables(), source: 'network', error: null };
    } catch (error) {
      return { data: getTrackables(), source: 'cache', error };
    }
  }

  async function loadEntries(filters = {}) {
    const { trackableIds, from, to } = filters;
    try {
      const data = await api.listEntries({ trackableIds, from, to });

      // Server is authoritative for the requested window only: drop
      // cached rows inside the window, splice in the server rows.
      const kept = entries.filter((e) => !isInWindow(e, { trackableIds, from, to }));
      entries = kept.concat(data);

      // Re-apply pending outbox ops on top so an unsent local log doesn't
      // appear to vanish just because the server round-trip completed.
      for (const op of outbox) {
        if (op.type === 'upsert') {
          const idx = findEntryIndex(op.payload.trackable_id, op.payload.entry_date);
          const row = { ...op.payload, pending: true };
          if (idx === -1) {
            entries.push(row);
          } else {
            entries[idx] = row;
          }
        } else if (op.type === 'delete') {
          const idx = findEntryIndex(op.payload.trackable_id, op.payload.entry_date);
          if (idx !== -1) entries.splice(idx, 1);
        }
      }

      persistCache();
      const result = sortEntries(filterEntries(entries, { trackableIds, from, to })).map((e) => ({
        ...e,
      }));
      return { data: result, source: 'network', error: null };
    } catch (error) {
      return { data: getEntries(filters), source: 'cache', error };
    }
  }

  async function saveEntry(entry) {
    // Programmer error, not a user-facing failure — propagate as a throw,
    // and touch nothing before it's validated.
    const normalized = api.assertValidEntry(entry);
    const key = entryKey(normalized.trackable_id, normalized.entry_date);

    const prevIndex = findEntryIndex(normalized.trackable_id, normalized.entry_date);
    const prevRow = prevIndex === -1 ? null : { ...entries[prevIndex] };

    const optimisticRow = { ...normalized, pending: true };
    if (prevIndex === -1) {
      entries.push(optimisticRow);
    } else {
      entries[prevIndex] = optimisticRow;
    }
    persistCache();

    try {
      const serverRow = await api.upsertEntry(normalized);
      const idx = findEntryIndex(normalized.trackable_id, normalized.entry_date);
      const stored = { ...serverRow };
      delete stored.pending;
      if (idx === -1) {
        entries.push(stored);
      } else {
        entries[idx] = stored;
      }
      dequeueByKey(key);
      persistCache();
      return { status: 'saved', entry: { ...stored }, error: null };
    } catch (err) {
      if (api.isRetryable(err)) {
        enqueueOp('upsert', key, normalized);
        const idx = findEntryIndex(normalized.trackable_id, normalized.entry_date);
        const queuedRow = idx === -1 ? { ...optimisticRow } : { ...entries[idx] };
        persistCache();
        return { status: 'queued', entry: queuedRow, error: err };
      }

      // Non-retryable: revert to the pre-optimistic state, don't queue.
      const idx = findEntryIndex(normalized.trackable_id, normalized.entry_date);
      if (idx !== -1) {
        if (prevRow === null) {
          entries.splice(idx, 1);
        } else {
          entries[idx] = prevRow;
        }
      }
      persistCache();
      return { status: 'failed', entry: null, error: err };
    }
  }

  async function removeEntry(trackableId, entryDate) {
    const idStr = api.assertId(trackableId);
    const dateStr = api.assertDate(entryDate);
    const key = entryKey(idStr, dateStr);

    const prevIndex = findEntryIndex(idStr, dateStr);
    const prevRow = prevIndex === -1 ? null : { ...entries[prevIndex] };

    if (prevIndex !== -1) entries.splice(prevIndex, 1);
    persistCache();

    try {
      await api.deleteEntry(idStr, dateStr);
      dequeueByKey(key);
      persistCache();
      return { status: 'saved', error: null };
    } catch (err) {
      if (api.isRetryable(err)) {
        // trackable_id is preserved as the caller passed it (number or
        // digit-string), not the assertId()-normalized idStr, so a delete
        // op's payload matches an upsert op's payload shape for the same
        // id. Do not "tidy" this back to idStr.
        enqueueOp('delete', key, { trackable_id: trackableId, entry_date: dateStr });
        persistCache();
        return { status: 'queued', error: err };
      }

      // Non-retryable: revert to the pre-optimistic state, don't queue.
      if (prevRow !== null) {
        const idx = findEntryIndex(idStr, dateStr);
        if (idx === -1) {
          entries.push(prevRow);
        } else {
          entries[idx] = prevRow;
        }
      }
      persistCache();
      return { status: 'failed', error: err };
    }
  }

  async function flushOutbox() {
    if (outbox.length === 0) {
      return { sent: 0, failed: 0, remaining: 0 };
    }

    let sent = 0;
    let failed = 0;

    // Process a snapshot of the current FIFO order so mutations to
    // `outbox` inside the loop (via dequeueByKey) don't shift indices
    // out from under us.
    const pending = [...outbox];

    for (const op of pending) {
      try {
        if (op.type === 'upsert') {
          const serverRow = await api.upsertEntry(op.payload);
          const idx = findEntryIndex(op.payload.trackable_id, op.payload.entry_date);
          const stored = { ...serverRow };
          delete stored.pending;
          if (idx === -1) {
            entries.push(stored);
          } else {
            entries[idx] = stored;
          }
        } else if (op.type === 'delete') {
          await api.deleteEntry(op.payload.trackable_id, op.payload.entry_date);
        }
        dequeueByKey(op.key);
        sent++;
      } catch (err) {
        if (api.isRetryable(err)) {
          // Stop immediately — leave this op and everything after it
          // queued rather than burning through offline retries.
          break;
        }
        // Non-retryable: this op can never succeed. Drop it and continue.
        dequeueByKey(op.key);
        failed++;
      }
    }

    // No trailing persistOutbox() here: dequeueByKey() above already
    // persists the outbox on every op it resolves, and a run that
    // resolves nothing left the outbox unchanged, so there is nothing
    // left to flush.
    persistCache();
    return { sent, failed, remaining: outbox.length };
  }

  function clear() {
    trackables = [];
    entries = [];
    outbox = [];
    opCounter = 0;
    safeRemoveItem(storage, CACHE_KEY);
    safeRemoveItem(storage, OUTBOX_KEY);
  }

  return {
    getTrackables,
    getEntries,
    getEntry,
    getOutbox,
    loadTrackables,
    loadEntries,
    saveEntry,
    removeEntry,
    flushOutbox,
    clear,
  };
}

let singleton = null;

export function getStore() {
  if (!singleton) {
    singleton = createStore();
  }
  return singleton;
}
