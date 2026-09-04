// Contract tests for js/api.js — the single module that owns all network
// access (BUILD_PLAN Step 1.1). The implementation is being written in
// parallel by another agent; these tests are written strictly from the
// interface contract handed to both agents, not from reading js/api.js.
//
// Every fetch is stubbed. Nothing here touches the network.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../js/config.js';
import * as api from '../../js/api.js';

const {
  ValidationError,
  NetworkError,
  ApiError,
  isRetryable,
  assertId,
  assertDate,
  assertValidEntry,
  listTrackables,
  createTrackable,
  updateTrackable,
  archiveTrackable,
  listEntries,
  upsertEntry,
  deleteEntry,
  getSettings,
  updateSettings,
  ENTRIES_PAGE_SIZE,
} = api;

const BASE = SUPABASE_URL;

// ---------------------------------------------------------------------------
// fetch stub helper
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function installFetch({ status = 200, body = [], text = undefined, reject = null } = {}) {
  const calls = [];
  const stub = async (url, init = {}) => {
    const record = {
      url: String(url),
      method: init.method || 'GET',
      headers: { ...(init.headers || {}) },
      body: init.body,
    };
    calls.push(record);
    if (reject) {
      throw reject;
    }
    const responseText =
      text !== undefined ? text : body === null ? '' : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => responseText,
      json: async () => JSON.parse(responseText),
    };
  };
  globalThis.fetch = stub;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function lastCall(calls) {
  return calls[calls.length - 1];
}

// Step D.6b: listEntries now pages through PostgREST's 1,000-row cap, which
// means a single test case can involve several sequential fetch() calls that
// must return DIFFERENT bodies (page 1, page 2, ...). installFetch() above
// always returns the same configured response for every call, so it cannot
// express "page 1 has 1000 rows, page 2 has 37". installFetchSequence()
// records every call exactly like installFetch() but returns the Nth
// configured response for the Nth call (the last configured response repeats
// if more calls happen than responses were supplied, which no pagination
// test here relies on).
function installFetchSequence(responses) {
  const calls = [];
  let callIndex = 0;
  const stub = async (url, init = {}) => {
    const record = {
      url: String(url),
      method: init.method || 'GET',
      headers: { ...(init.headers || {}) },
      body: init.body,
    };
    calls.push(record);
    const resp = responses[Math.min(callIndex, responses.length - 1)] || {};
    callIndex += 1;
    if (resp.reject) {
      throw resp.reject;
    }
    const { status = 200, body = [] } = resp;
    const responseText =
      resp.text !== undefined ? resp.text : body === null ? '' : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => responseText,
      json: async () => JSON.parse(responseText),
    };
  };
  globalThis.fetch = stub;
  return calls;
}

// ---------------------------------------------------------------------------
// 1 & 11. Exact method/URL for each function, including param order
// ---------------------------------------------------------------------------

describe('exact method + URL per function', () => {
  it('listTrackables() default', async () => {
    const calls = installFetch({ body: [] });
    await listTrackables();
    assert.equal(lastCall(calls).method, 'GET');
    assert.equal(
      lastCall(calls).url,
      `${BASE}/rest/v1/trackables?select=*&archived=is.false&order=sort_order.asc,id.asc`
    );
  });

  it('listTrackables({includeArchived:true}) omits archived param', async () => {
    const calls = installFetch({ body: [] });
    await listTrackables({ includeArchived: true });
    assert.equal(
      lastCall(calls).url,
      `${BASE}/rest/v1/trackables?select=*&order=sort_order.asc,id.asc`
    );
  });

  it('createTrackable POST', async () => {
    const calls = installFetch({ body: [{ id: 1, name: 'x' }] });
    await createTrackable({ name: 'x' });
    assert.equal(lastCall(calls).method, 'POST');
    assert.equal(lastCall(calls).url, `${BASE}/rest/v1/trackables`);
  });

  it('updateTrackable PATCH', async () => {
    const calls = installFetch({ body: [{ id: 5, name: 'x' }] });
    await updateTrackable(5, { name: 'x' });
    assert.equal(lastCall(calls).method, 'PATCH');
    assert.equal(lastCall(calls).url, `${BASE}/rest/v1/trackables?id=eq.5`);
  });

  it('archiveTrackable PATCH', async () => {
    const calls = installFetch({ body: [{ id: 5, archived: true }] });
    await archiveTrackable(5);
    assert.equal(lastCall(calls).method, 'PATCH');
    assert.equal(lastCall(calls).url, `${BASE}/rest/v1/trackables?id=eq.5`);
  });

  // Step D.6b: listEntries now pages through PostgREST's 1,000-row cap, so
  // even a single-page result (this fixture returns 0 rows, well under the
  // page size) carries the offset/limit pair on every request — amended
  // per CONTRACT-D.6b.md §1.3's worked example, which appends
  // '&offset=0&limit=1000' after 'order=...' on every page including the
  // first.
  it('listEntries GET with all params in order', async () => {
    const calls = installFetch({ body: [] });
    await listEntries({ trackableIds: [1, 2], from: '2026-01-01', to: '2026-01-31' });
    assert.equal(lastCall(calls).method, 'GET');
    assert.equal(
      lastCall(calls).url,
      `${BASE}/rest/v1/entries?select=*&trackable_id=in.(1,2)&entry_date=gte.2026-01-01&entry_date=lte.2026-01-31&order=entry_date.asc,trackable_id.asc&offset=0&limit=1000`
    );
  });

  it('upsertEntry POST with on_conflict', async () => {
    const calls = installFetch({ body: [{ id: 1, trackable_id: 1, entry_date: '2026-01-01', value: 1 }] });
    await upsertEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1 });
    assert.equal(lastCall(calls).method, 'POST');
    assert.equal(
      lastCall(calls).url,
      `${BASE}/rest/v1/entries?on_conflict=trackable_id,entry_date`
    );
  });

  it('deleteEntry DELETE with both filters', async () => {
    const calls = installFetch({ body: [{ id: 1 }] });
    await deleteEntry(1, '2026-01-01');
    assert.equal(lastCall(calls).method, 'DELETE');
    assert.equal(
      lastCall(calls).url,
      `${BASE}/rest/v1/entries?trackable_id=eq.1&entry_date=eq.2026-01-01`
    );
  });

  it('getSettings GET', async () => {
    const calls = installFetch({ body: [{ id: 1, rolling_window_days: 90 }] });
    await getSettings();
    assert.equal(lastCall(calls).method, 'GET');
    assert.equal(lastCall(calls).url, `${BASE}/rest/v1/app_settings?select=*&id=eq.1`);
  });

  it('updateSettings PATCH', async () => {
    const calls = installFetch({ body: [{ id: 1, rolling_window_days: 30 }] });
    await updateSettings({ rolling_window_days: 30 });
    assert.equal(lastCall(calls).method, 'PATCH');
    assert.equal(lastCall(calls).url, `${BASE}/rest/v1/app_settings?id=eq.1`);
  });
});

// ---------------------------------------------------------------------------
// 2. Every function sends apikey / Authorization / Accept
// ---------------------------------------------------------------------------

describe('every function sends required auth/accept headers', () => {
  const cases = [
    ['listTrackables', () => listTrackables(), { body: [] }],
    ['createTrackable', () => createTrackable({ name: 'x' }), { body: [{ id: 1, name: 'x' }] }],
    ['updateTrackable', () => updateTrackable(1, { name: 'x' }), { body: [{ id: 1 }] }],
    ['archiveTrackable', () => archiveTrackable(1), { body: [{ id: 1, archived: true }] }],
    ['listEntries', () => listEntries(), { body: [] }],
    [
      'upsertEntry',
      () => upsertEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1 }),
      { body: [{ id: 1 }] },
    ],
    ['deleteEntry', () => deleteEntry(1, '2026-01-01'), { body: [] }],
    ['getSettings', () => getSettings(), { body: [{ id: 1, rolling_window_days: 90 }] }],
    ['updateSettings', () => updateSettings({ rolling_window_days: 30 }), { body: [{ id: 1 }] }],
  ];

  for (const [label, fn, resp] of cases) {
    it(`${label} sends apikey/Authorization/Accept`, async () => {
      const calls = installFetch(resp);
      await fn();
      const h = lastCall(calls).headers;
      assert.equal(h.apikey, SUPABASE_ANON_KEY);
      assert.equal(h.Authorization, `Bearer ${SUPABASE_ANON_KEY}`);
      assert.equal(h.Accept, 'application/json');
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Content-Type only on body-bearing requests
// ---------------------------------------------------------------------------

describe('Content-Type header presence', () => {
  it('GET (listTrackables) does not send Content-Type', async () => {
    const calls = installFetch({ body: [] });
    await listTrackables();
    assert.equal(lastCall(calls).headers['Content-Type'], undefined);
  });

  it('GET (listEntries) does not send Content-Type', async () => {
    const calls = installFetch({ body: [] });
    await listEntries();
    assert.equal(lastCall(calls).headers['Content-Type'], undefined);
  });

  it('GET (getSettings) does not send Content-Type', async () => {
    const calls = installFetch({ body: [{ id: 1, rolling_window_days: 90 }] });
    await getSettings();
    assert.equal(lastCall(calls).headers['Content-Type'], undefined);
  });

  it('POST (createTrackable) sends Content-Type: application/json', async () => {
    const calls = installFetch({ body: [{ id: 1, name: 'x' }] });
    await createTrackable({ name: 'x' });
    assert.equal(lastCall(calls).headers['Content-Type'], 'application/json');
  });

  it('PATCH (updateTrackable) sends Content-Type: application/json', async () => {
    const calls = installFetch({ body: [{ id: 1 }] });
    await updateTrackable(1, { name: 'x' });
    assert.equal(lastCall(calls).headers['Content-Type'], 'application/json');
  });

  it('POST (upsertEntry) sends Content-Type: application/json', async () => {
    const calls = installFetch({ body: [{ id: 1 }] });
    await upsertEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1 });
    assert.equal(lastCall(calls).headers['Content-Type'], 'application/json');
  });
});

// ---------------------------------------------------------------------------
// 4. archived param behavior (also covered above, kept for clarity)
// ---------------------------------------------------------------------------

describe('listTrackables archived filter', () => {
  it('default includes archived=is.false', async () => {
    const calls = installFetch({ body: [] });
    await listTrackables();
    assert.ok(lastCall(calls).url.includes('archived=is.false'));
  });

  it('includeArchived:true omits archived filter entirely', async () => {
    const calls = installFetch({ body: [] });
    await listTrackables({ includeArchived: true });
    assert.ok(!lastCall(calls).url.includes('archived'));
  });
});

// ---------------------------------------------------------------------------
// 5. upsertEntry — the single most important line
// ---------------------------------------------------------------------------

describe('upsertEntry — on_conflict and Prefer (re-log must not 409)', () => {
  it('sends on_conflict=trackable_id,entry_date and merge-duplicates Prefer', async () => {
    const calls = installFetch({ body: [{ id: 1, trackable_id: 1, entry_date: '2026-01-01', value: 1 }] });
    await upsertEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1 });
    const call = lastCall(calls);
    assert.ok(call.url.includes('on_conflict=trackable_id,entry_date'));
    assert.equal(call.headers.Prefer, 'resolution=merge-duplicates,return=representation');
  });
});

// ---------------------------------------------------------------------------
// 6. assertValidEntry / upsertEntry reject disallowed keys, zero fetches
// ---------------------------------------------------------------------------

describe('assertValidEntry / upsertEntry reject disallowed keys with zero fetches', () => {
  const validBase = { trackable_id: 1, entry_date: '2026-01-01', value: 1 };
  const badKeys = ['updated_at', 'id', 'created_at', 'some_unknown_key'];

  for (const key of badKeys) {
    it(`assertValidEntry rejects key '${key}'`, () => {
      const entry = { ...validBase, [key]: 'x' };
      assert.throws(
        () => assertValidEntry(entry),
        (err) => {
          assert.equal(err.name, 'ValidationError');
          assert.equal(err.code, 'VALIDATION');
          assert.equal(err.retryable, false);
          assert.ok(err.message.includes(key), `message should name '${key}', got: ${err.message}`);
          return true;
        }
      );
    });

    it(`upsertEntry rejects key '${key}' and makes zero fetches`, async () => {
      const calls = installFetch({ body: [{ id: 1 }] });
      const entry = { ...validBase, [key]: 'x' };
      await assert.rejects(() => upsertEntry(entry), { name: 'ValidationError' });
      assert.equal(calls.length, 0);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. assertValidEntry — value/note validation
// ---------------------------------------------------------------------------

describe('assertValidEntry — value and note validation', () => {
  it('accepts 0', () => {
    const out = assertValidEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 0 });
    assert.equal(out.value, 0);
  });

  it('accepts a negative value', () => {
    const out = assertValidEntry({ trackable_id: 1, entry_date: '2026-01-01', value: -5 });
    assert.equal(out.value, -5);
  });

  it('accepts a decimal value', () => {
    const out = assertValidEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 3.5 });
    assert.equal(out.value, 3.5);
  });

  it('accepts null note', () => {
    const out = assertValidEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1, note: null });
    assert.equal(out.note, null);
  });

  it('accepts a string note', () => {
    const out = assertValidEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1, note: 'hi' });
    assert.equal(out.note, 'hi');
  });

  it('omits note when not supplied', () => {
    const out = assertValidEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1 });
    assert.equal('note' in out, false);
  });

  it('preserves trackable_id as given (number)', () => {
    const out = assertValidEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1 });
    assert.equal(out.trackable_id, 1);
  });

  it('preserves trackable_id as given (digit string)', () => {
    const out = assertValidEntry({ trackable_id: '1', entry_date: '2026-01-01', value: 1 });
    assert.equal(out.trackable_id, '1');
  });

  const rejects = [
    ['NaN value', { trackable_id: 1, entry_date: '2026-01-01', value: NaN }],
    ['Infinity value', { trackable_id: 1, entry_date: '2026-01-01', value: Infinity }],
    ['string value "12"', { trackable_id: 1, entry_date: '2026-01-01', value: '12' }],
    ['missing value', { trackable_id: 1, entry_date: '2026-01-01' }],
    ['numeric note', { trackable_id: 1, entry_date: '2026-01-01', value: 1, note: 5 }],
    ['null entry', null],
    ['array entry', [1, 2]],
    ['non-object entry (string)', 'nope'],
    ['non-object entry (number)', 42],
  ];

  for (const [label, entry] of rejects) {
    it(`rejects ${label}`, () => {
      assert.throws(() => assertValidEntry(entry), { name: 'ValidationError' });
    });
  }
});

// ---------------------------------------------------------------------------
// 8 & 9. deleteEntry — URL shape, fuzz input, zero-network on invalid, count
// ---------------------------------------------------------------------------

describe('deleteEntry — URL and validation', () => {
  it('URL carries both trackable_id=eq. and entry_date=eq.', async () => {
    const calls = installFetch({ body: [] });
    await deleteEntry(7, '2026-02-03');
    const url = lastCall(calls).url;
    assert.ok(url.includes('trackable_id=eq.7'));
    assert.ok(url.includes('entry_date=eq.2026-02-03'));
  });

  it('returns 0 (number) for an empty response, no throw', async () => {
    installFetch({ body: [] });
    const result = await deleteEntry(1, '2026-01-01');
    assert.equal(result, 0);
    assert.equal(typeof result, 'number');
  });

  it('returns 2 when two rows come back', async () => {
    installFetch({ body: [{ id: 1 }, { id: 2 }] });
    const result = await deleteEntry(1, '2026-01-01');
    assert.equal(result, 2);
  });

  const badIds = [null, undefined, '', 0, -1, 1.5, '2026-8-1', '*', 'eq.1', '1;drop table', '1,2', {}, [], true];
  for (const badId of badIds) {
    it(`bad trackableId ${JSON.stringify(badId)} throws ValidationError with zero fetches`, async () => {
      const calls = installFetch({ body: [] });
      await assert.rejects(() => deleteEntry(badId, '2026-01-01'), { name: 'ValidationError' });
      assert.equal(calls.length, 0);
    });
  }

  const badDates = [null, undefined, '', '2026-8-1', '*', 'eq.1', '1;drop table', '1,2', {}, [], true, 0, -1, 1.5];
  for (const badDate of badDates) {
    it(`bad entryDate ${JSON.stringify(badDate)} throws ValidationError with zero fetches`, async () => {
      const calls = installFetch({ body: [] });
      await assert.rejects(() => deleteEntry(1, badDate), { name: 'ValidationError' });
      assert.equal(calls.length, 0);
    });
  }
});

// ---------------------------------------------------------------------------
// 10. listEntries — empty id array must never become unfiltered
// ---------------------------------------------------------------------------

describe('listEntries — validation, zero fetches on invalid input', () => {
  it('empty trackableIds array throws ValidationError, zero fetches', async () => {
    const calls = installFetch({ body: [] });
    await assert.rejects(() => listEntries({ trackableIds: [] }), { name: 'ValidationError' });
    assert.equal(calls.length, 0);
  });

  const badIdLists = [
    ['non-integer id', [1.5]],
    ["injection-shaped id '1)'", ['1)']],
    ["injection-shaped id '1,2'", ['1,2']],
    ["injection-shaped id '*'", ['*']],
  ];
  for (const [label, ids] of badIdLists) {
    it(`${label} throws ValidationError, zero fetches`, async () => {
      const calls = installFetch({ body: [] });
      await assert.rejects(() => listEntries({ trackableIds: ids }), { name: 'ValidationError' });
      assert.equal(calls.length, 0);
    });
  }

  it('from > to throws ValidationError, zero fetches', async () => {
    const calls = installFetch({ body: [] });
    await assert.rejects(
      () => listEntries({ from: '2026-02-01', to: '2026-01-01' }),
      { name: 'ValidationError' }
    );
    assert.equal(calls.length, 0);
  });

  it('malformed date throws ValidationError, zero fetches', async () => {
    const calls = installFetch({ body: [] });
    await assert.rejects(() => listEntries({ from: '2026-1-1' }), { name: 'ValidationError' });
    assert.equal(calls.length, 0);
  });
});

// Step D.6b (CONTRACT-D.6b.md §1.3): every request now carries
// '&offset=0&limit=1000' after 'order=...', on the first page as much as
// any later one — these fixtures all return 0 rows (well under the page
// size), so each case here still makes exactly one request, but that
// request's URL now ends with the offset/limit pair. This restates the
// exact-URL assertions to the new invariant; it does not change what each
// case is checking (which params are present for which inputs).
describe('listEntries — partial params build corresponding URL, order always present', () => {
  it('no params at all: only select and order', async () => {
    const calls = installFetch({ body: [] });
    await listEntries();
    assert.equal(
      lastCall(calls).url,
      `${BASE}/rest/v1/entries?select=*&order=entry_date.asc,trackable_id.asc&offset=0&limit=1000`
    );
  });

  it('only trackableIds', async () => {
    const calls = installFetch({ body: [] });
    await listEntries({ trackableIds: [3] });
    assert.equal(
      lastCall(calls).url,
      `${BASE}/rest/v1/entries?select=*&trackable_id=in.(3)&order=entry_date.asc,trackable_id.asc&offset=0&limit=1000`
    );
  });

  it('only from', async () => {
    const calls = installFetch({ body: [] });
    await listEntries({ from: '2026-01-01' });
    assert.equal(
      lastCall(calls).url,
      `${BASE}/rest/v1/entries?select=*&entry_date=gte.2026-01-01&order=entry_date.asc,trackable_id.asc&offset=0&limit=1000`
    );
  });

  it('only to', async () => {
    const calls = installFetch({ body: [] });
    await listEntries({ to: '2026-01-31' });
    assert.equal(
      lastCall(calls).url,
      `${BASE}/rest/v1/entries?select=*&entry_date=lte.2026-01-31&order=entry_date.asc,trackable_id.asc&offset=0&limit=1000`
    );
  });

  it('from and to both supplied, from == to (boundary, not an error)', async () => {
    const calls = installFetch({ body: [] });
    await listEntries({ from: '2026-01-01', to: '2026-01-01' });
    assert.equal(
      lastCall(calls).url,
      `${BASE}/rest/v1/entries?select=*&entry_date=gte.2026-01-01&entry_date=lte.2026-01-01&order=entry_date.asc,trackable_id.asc&offset=0&limit=1000`
    );
  });
});

// ---------------------------------------------------------------------------
// Step D.6b — listEntries pages through PostgREST's 1,000-row cap
// (CONTRACT-D.6b.md §1). Callers never see pages; api.js concatenates and
// returns a single flat array. These tests are written strictly from that
// contract; js/api.js's pagination loop is being written in parallel by
// another agent and is expected to fail here until that lands.
// ---------------------------------------------------------------------------

describe('listEntries — pagination (Step D.6b)', () => {
  it('ENTRIES_PAGE_SIZE is exported and equals 1000', () => {
    assert.equal(ENTRIES_PAGE_SIZE, 1000);
  });

  it('pages of 1000/1000/37 rows -> exactly 3 requests; 2037 rows in concatenated order; offsets 0/1000/2000; every URL identical to the first except offset', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ n: i }));
    const page2 = Array.from({ length: 1000 }, (_, i) => ({ n: 1000 + i }));
    const page3 = Array.from({ length: 37 }, (_, i) => ({ n: 2000 + i }));
    const calls = installFetchSequence([{ body: page1 }, { body: page2 }, { body: page3 }]);

    const result = await listEntries();

    assert.equal(calls.length, 3);
    assert.equal(result.length, 2037);
    // Concatenation order: page 1 rows, then page 2, then page 3.
    assert.equal(result[0].n, 0);
    assert.equal(result[999].n, 999);
    assert.equal(result[1000].n, 1000);
    assert.equal(result[1999].n, 1999);
    assert.equal(result[2000].n, 2000);
    assert.equal(result[2036].n, 2036);

    assert.ok(calls[0].url.endsWith('&offset=0&limit=1000'), calls[0].url);
    assert.ok(calls[1].url.endsWith('&offset=1000&limit=1000'), calls[1].url);
    assert.ok(calls[2].url.endsWith('&offset=2000&limit=1000'), calls[2].url);

    const withoutOffset0 = calls[0].url.replace('offset=0', 'offset=__X__');
    const withoutOffset1 = calls[1].url.replace('offset=1000', 'offset=__X__');
    const withoutOffset2 = calls[2].url.replace('offset=2000', 'offset=__X__');
    assert.equal(withoutOffset1, withoutOffset0, 'page 2 URL must be identical to page 1 except offset');
    assert.equal(withoutOffset2, withoutOffset0, 'page 3 URL must be identical to page 1 except offset');
  });

  it('first page of 0 rows -> exactly 1 request, result []', async () => {
    const calls = installFetchSequence([{ body: [] }]);
    const result = await listEntries();
    assert.equal(calls.length, 1);
    assert.deepEqual(result, []);
  });

  it('first page of exactly 1000 rows, second page 0 rows -> exactly 2 requests, result has 1000 rows', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ n: i }));
    const calls = installFetchSequence([{ body: page1 }, { body: [] }]);
    const result = await listEntries();
    assert.equal(calls.length, 2);
    assert.equal(result.length, 1000);
  });

  it('first page of 999 rows -> exactly 1 request (the short-page rule)', async () => {
    const page1 = Array.from({ length: 999 }, (_, i) => ({ n: i }));
    const calls = installFetchSequence([{ body: page1 }]);
    const result = await listEntries();
    assert.equal(calls.length, 1);
    assert.equal(result.length, 999);
  });

  it('with trackableIds/from/to, every page URL carries the same filters and order, before offset=', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ n: i }));
    const page2 = Array.from({ length: 5 }, (_, i) => ({ n: 1000 + i }));
    const calls = installFetchSequence([{ body: page1 }, { body: page2 }]);

    await listEntries({ trackableIds: [3], from: '2026-01-01', to: '2026-01-31' });

    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.ok(call.url.includes('trackable_id=in.(3)'), call.url);
      assert.ok(call.url.includes('entry_date=gte.2026-01-01'), call.url);
      assert.ok(call.url.includes('entry_date=lte.2026-01-31'), call.url);
      const orderIdx = call.url.indexOf('order=entry_date.asc,trackable_id.asc');
      const offsetIdx = call.url.indexOf('offset=');
      assert.ok(orderIdx !== -1, `missing order= in ${call.url}`);
      assert.ok(offsetIdx !== -1, `missing offset= in ${call.url}`);
      assert.ok(orderIdx < offsetIdx, `order= must precede offset= in ${call.url}`);
    }
  });

  it('a non-array JSON body on page 1 counts as an empty page -> 1 request, result []', async () => {
    const calls = installFetchSequence([{ body: {} }]);
    const result = await listEntries();
    assert.equal(calls.length, 1);
    assert.deepEqual(result, []);
  });

  it('page 2 returning HTTP 500 rejects the whole call with ApiError (status 500, retryable true); nothing partial is returned', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ n: i }));
    installFetchSequence([{ body: page1 }, { status: 500, body: { message: 'server error' } }]);
    await assert.rejects(() => listEntries(), (err) => {
      assert.equal(err.name, 'ApiError');
      assert.equal(err.status, 500);
      assert.equal(err.retryable, true);
      return true;
    });
  });

  it('page 2 fetch rejecting (TypeError) rejects the whole call with NetworkError', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ n: i }));
    installFetchSequence([{ body: page1 }, { reject: new TypeError('fetch failed') }]);
    await assert.rejects(() => listEntries(), { name: 'NetworkError' });
  });

  it('validation failure still makes zero fetches under pagination (empty trackableIds array)', async () => {
    const calls = installFetchSequence([{ body: [] }]);
    await assert.rejects(() => listEntries({ trackableIds: [] }), { name: 'ValidationError' });
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 12. Error mapping
// ---------------------------------------------------------------------------

describe('error mapping — ApiError', () => {
  it('400 with PostgREST JSON body carries message/code/details/hint, retryable false', async () => {
    installFetch({
      status: 400,
      body: { message: 'bad input', code: '23505', details: 'dup key', hint: 'try again' },
    });
    await assert.rejects(() => listTrackables(), (err) => {
      assert.equal(err.name, 'ApiError');
      assert.equal(err.status, 400);
      assert.equal(err.code, '23505');
      assert.equal(err.details, 'dup key');
      assert.equal(err.hint, 'try again');
      assert.equal(err.retryable, false);
      assert.ok(err.message.includes('400'));
      assert.ok(err.message.includes('bad input'));
      return true;
    });
  });

  it('500 is retryable', async () => {
    installFetch({ status: 500, body: { message: 'server error' } });
    await assert.rejects(() => listTrackables(), (err) => {
      assert.equal(err.retryable, true);
      return true;
    });
  });

  it('408 is retryable', async () => {
    installFetch({ status: 408, body: { message: 'timeout' } });
    await assert.rejects(() => listTrackables(), (err) => {
      assert.equal(err.retryable, true);
      return true;
    });
  });

  it('429 is retryable', async () => {
    installFetch({ status: 429, body: { message: 'rate limited' } });
    await assert.rejects(() => listTrackables(), (err) => {
      assert.equal(err.retryable, true);
      return true;
    });
  });

  it('non-JSON error body (e.g. HTML 502 page) -> body is raw text, does not throw while building', async () => {
    installFetch({ status: 502, text: '<html>Bad Gateway</html>' });
    await assert.rejects(() => listTrackables(), (err) => {
      assert.equal(err.name, 'ApiError');
      assert.equal(err.body, '<html>Bad Gateway</html>');
      return true;
    });
  });
});

describe('error mapping — NetworkError', () => {
  it('fetch rejecting -> NetworkError with retryable true and cause preserved', async () => {
    const cause = new Error('ECONNRESET');
    installFetch({ reject: cause });
    await assert.rejects(() => listTrackables(), (err) => {
      assert.equal(err.name, 'NetworkError');
      assert.equal(err.code, 'NETWORK');
      assert.equal(err.retryable, true);
      assert.equal(err.cause, cause);
      return true;
    });
  });

  it('globalThis.fetch removed entirely -> NetworkError, not TypeError', async () => {
    delete globalThis.fetch;
    await assert.rejects(() => listTrackables(), (err) => {
      assert.equal(err.name, 'NetworkError');
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// 15. fetch resolved at call time, not captured at import
// ---------------------------------------------------------------------------

describe('fetch is resolved at call time', () => {
  it('a stub installed after import is the one used', async () => {
    const calls = installFetch({ body: [] });
    await listTrackables();
    assert.equal(calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 16. Empty-array response mapping per function
// ---------------------------------------------------------------------------

describe('empty-array responses map to the documented error codes', () => {
  it('updateTrackable empty array -> NOT_FOUND, status remains 200', async () => {
    installFetch({ status: 200, body: [] });
    await assert.rejects(() => updateTrackable(1, { name: 'x' }), (err) => {
      assert.equal(err.name, 'ApiError');
      assert.equal(err.code, 'NOT_FOUND');
      assert.equal(err.status, 200);
      return true;
    });
  });

  it('getSettings empty array -> NOT_FOUND', async () => {
    installFetch({ status: 200, body: [] });
    await assert.rejects(() => getSettings(), { name: 'ApiError', code: 'NOT_FOUND' });
  });

  it('updateSettings empty array -> NOT_FOUND', async () => {
    installFetch({ status: 200, body: [] });
    await assert.rejects(() => updateSettings({ rolling_window_days: 30 }), {
      name: 'ApiError',
      code: 'NOT_FOUND',
    });
  });

  it('createTrackable empty array -> EMPTY_RESPONSE', async () => {
    installFetch({ status: 200, body: [] });
    await assert.rejects(() => createTrackable({ name: 'x' }), {
      name: 'ApiError',
      code: 'EMPTY_RESPONSE',
    });
  });

  it('upsertEntry empty array -> EMPTY_RESPONSE', async () => {
    installFetch({ status: 200, body: [] });
    await assert.rejects(
      () => upsertEntry({ trackable_id: 1, entry_date: '2026-01-01', value: 1 }),
      { name: 'ApiError', code: 'EMPTY_RESPONSE' }
    );
  });
});

// ---------------------------------------------------------------------------
// 17. createTrackable — name trimming and validation
// ---------------------------------------------------------------------------

describe('createTrackable — name handling', () => {
  it('trims the name in the sent body', async () => {
    const calls = installFetch({ body: [{ id: 1, name: 'hello' }] });
    await createTrackable({ name: '  hello  ' });
    const sent = JSON.parse(lastCall(calls).body);
    assert.equal(sent.name, 'hello');
  });

  const badNames = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['non-string (number)', 42],
    ['missing name', undefined],
  ];
  for (const [label, name] of badNames) {
    it(`rejects ${label}`, async () => {
      const calls = installFetch({ body: [{ id: 1 }] });
      const fields = name === undefined ? {} : { name };
      await assert.rejects(() => createTrackable(fields), { name: 'ValidationError' });
      assert.equal(calls.length, 0);
    });
  }

  it('rejects an id key', async () => {
    const calls = installFetch({ body: [{ id: 1 }] });
    await assert.rejects(() => createTrackable({ name: 'x', id: 5 }), { name: 'ValidationError' });
    assert.equal(calls.length, 0);
  });

  it('rejects a created_at key', async () => {
    const calls = installFetch({ body: [{ id: 1 }] });
    await assert.rejects(
      () => createTrackable({ name: 'x', created_at: '2026-01-01' }),
      { name: 'ValidationError' }
    );
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 18. archiveTrackable delegates correctly
// ---------------------------------------------------------------------------

describe('archiveTrackable', () => {
  it('issues PATCH ?id=eq.{id} with body {"archived":true}', async () => {
    const calls = installFetch({ body: [{ id: 9, archived: true }] });
    await archiveTrackable(9);
    const call = lastCall(calls);
    assert.equal(call.method, 'PATCH');
    assert.equal(call.url, `${BASE}/rest/v1/trackables?id=eq.9`);
    assert.deepEqual(JSON.parse(call.body), { archived: true });
  });
});

// ---------------------------------------------------------------------------
// 19. isRetryable
// ---------------------------------------------------------------------------

describe('isRetryable', () => {
  it('true for a NetworkError', async () => {
    installFetch({ reject: new Error('down') });
    try {
      await listTrackables();
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(isRetryable(err), true);
    }
  });

  it('true for a retryable ApiError (500)', async () => {
    installFetch({ status: 500, body: { message: 'x' } });
    try {
      await listTrackables();
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(isRetryable(err), true);
    }
  });

  it('false for a non-retryable ApiError (400)', async () => {
    installFetch({ status: 400, body: { message: 'x' } });
    try {
      await listTrackables();
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(isRetryable(err), false);
    }
  });

  it('false for a ValidationError', () => {
    try {
      assertValidEntry(null);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(isRetryable(err), false);
    }
  });

  it('returns false, no throw, for null/undefined/plain Error/string', () => {
    assert.equal(isRetryable(null), false);
    assert.equal(isRetryable(undefined), false);
    assert.equal(isRetryable(new Error('plain')), false);
    assert.equal(isRetryable('some string'), false);
  });
});

// ---------------------------------------------------------------------------
// assertId / assertDate direct coverage
// ---------------------------------------------------------------------------

describe('assertId', () => {
  it('accepts a positive safe integer, returns as string', () => {
    assert.equal(assertId(5, 'id'), '5');
  });

  it('accepts a digit-only string, returns as string', () => {
    assert.equal(assertId('5', 'id'), '5');
  });

  const bad = [null, undefined, '', 0, -1, 1.5, '2026-8-1', '*', 'eq.1', '1;drop table', '1,2', {}, [], true, '1)', 'abc'];
  for (const v of bad) {
    it(`rejects ${JSON.stringify(v)}`, () => {
      assert.throws(() => assertId(v, 'id'), { name: 'ValidationError' });
    });
  }
});

describe('assertDate', () => {
  it('accepts YYYY-MM-DD', () => {
    assert.equal(assertDate('2026-01-01', 'entry_date'), '2026-01-01');
  });

  const bad = [null, undefined, '', '2026-8-1', '*', 'eq.1', '1;drop table', '1,2', {}, [], true, 0, -1, 1.5, '2026/01/01'];
  for (const v of bad) {
    it(`rejects ${JSON.stringify(v)}`, () => {
      assert.throws(() => assertDate(v, 'entry_date'), { name: 'ValidationError' });
    });
  }
});

// ---------------------------------------------------------------------------
// 20. Structural guardrail — exactly one literal 'DELETE' method in js/api.js
//
// Regression guard mirroring the isolation-guard sweep bug from Step 0.0:
// there must be exactly one place in this module that can build a DELETE
// request, and (per case 8 above) its URL always carries both the
// trackable_id and entry_date filters. If a future refactor adds a second
// DELETE code path, it is very easy for that path to skip validation and
// silently wipe rows outside the (trackable_id, entry_date) pair — this
// assertion is a tripwire for that, not a stylistic nitpick. Do not
// "simplify" this test away; it is the only thing standing between a
// careless refactor and a real data-loss bug at this layer.
// ---------------------------------------------------------------------------

describe('structural guardrail — single DELETE method literal', () => {
  it("the literal 'DELETE' appears exactly once as a request method in js/api.js", () => {
    const apiPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'js',
      'api.js'
    );
    const source = readFileSync(apiPath, 'utf8');
    const matches = source.match(/method:\s*['"]DELETE['"]/g) || [];
    assert.equal(
      matches.length,
      1,
      `expected exactly one 'method: DELETE' literal in js/api.js, found ${matches.length}`
    );
  });
});

// ---------------------------------------------------------------------------
// Error class shape checks (name/code/retryable), independent of a live call
// ---------------------------------------------------------------------------

describe('error class shapes', () => {
  it('ValidationError has the documented shape', () => {
    try {
      assertValidEntry(null);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'ValidationError');
      assert.equal(err.code, 'VALIDATION');
      assert.equal(err.retryable, false);
    }
  });

  it('exported error classes extend Error', () => {
    assert.ok(ValidationError.prototype instanceof Error);
    assert.ok(NetworkError.prototype instanceof Error);
    assert.ok(ApiError.prototype instanceof Error);
  });
});
