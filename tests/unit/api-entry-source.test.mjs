// Step D.2 — js/api.js must never write entries.source.
//
// Migration 0006 added `entries.source` with the contract "NULL = logged in
// the app, non-null = the id of the import batch that created the row". The
// app is the NULL case BY DEFINITION, so api.js has nothing to say about the
// column, and the CSV import (Step D.5) is a one-off script that bypasses
// api.js entirely.
//
// tests/unit/api.test.mjs already covers "an unknown key is rejected"
// generically. These cases are deliberately redundant with that, and are
// worth their weight anyway: the failure they guard against is not someone
// passing a stray key, it is someone deciding that `source` is a legitimate
// entry field and ADDING it to ENTRY_KEYS. A generic test would keep passing
// through that change. These would not.
//
// Why it matters that this stays impossible: `source` is the only thing that
// makes a bulk import reversible. A UI bug that stamped a batch id onto a
// hand-logged row, or blanked one off an imported row, would corrupt the
// undo in a way nothing else could detect after the fact.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { assertValidEntry, upsertEntry, ValidationError } from '../../js/api.js';

const VALID = { trackable_id: 1, entry_date: '2026-01-15', value: 1500 };

describe('Step D.2: entries.source is not a key the app may write', () => {
  it('assertValidEntry rejects source, with the key named in the message', () => {
    assert.throws(
      () => assertValidEntry({ ...VALID, source: 'import:calories-2026-08-25' }),
      (err) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err?.constructor?.name}`);
        assert.match(err.message, /source/);
        return true;
      }
    );
  });

  it('assertValidEntry rejects source even when it is null — the app must omit the key, not send it empty', () => {
    // An explicit null would still land in the request body and, via
    // merge-duplicates, would OVERWRITE an imported row's batch id with NULL.
    // That is the exact corruption this guard exists to prevent, so "null is
    // harmless" must not become the reason someone allows the key.
    assert.throws(() => assertValidEntry({ ...VALID, source: null }), ValidationError);
  });

  it('assertValidEntry still accepts the four legal keys, so the guard is not just rejecting everything', () => {
    const out = assertValidEntry({ ...VALID, note: 'ok' });
    assert.deepEqual(out, { trackable_id: 1, entry_date: '2026-01-15', value: 1500, note: 'ok' });
    assert.ok(!('source' in out));
  });

  it('a valid entry never carries source through to the normalized payload', () => {
    const out = assertValidEntry(VALID);
    assert.deepEqual(Object.keys(out).sort(), ['entry_date', 'trackable_id', 'value']);
  });
});

describe('Step D.2: upsertEntry issues NO request when source is present', () => {
  let calls;
  let originalFetch;

  beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      // Must return a representation row, not []. upsertEntry treats an empty
      // 200 as an ApiError (EMPTY_RESPONSE) — correctly, since the request
      // asks for `return=representation` and a silent empty result there
      // would mean a save that reported success without persisting anything.
      return new Response(
        JSON.stringify([{ id: 1, ...VALID, note: null, source: null }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects before the network — asserting the CALL COUNT, not just the throw', async () => {
    // Asserting only that it throws would pass even if the request had already
    // gone out and the rejection happened afterwards. The count is the real
    // assertion here.
    await assert.rejects(
      () => upsertEntry({ ...VALID, source: 'import:x' }),
      ValidationError
    );
    assert.equal(calls.length, 0, 'upsertEntry must not reach the network when validation fails');
  });

  it('the same stub DOES get used for a legal entry — proving the zero-call assertion above is meaningful', async () => {
    await upsertEntry(VALID);
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.ok(!('source' in body), 'a legal upsert must not send a source key at all');
  });
});
