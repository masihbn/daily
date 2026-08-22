// Integration tests: real PostgREST calls against the live Supabase project.
//
// READ-ONLY except through the sanctioned helper functions in
// tests/helpers/supabase.mjs. This file must never create or delete a row
// itself — it only exercises restGet (read-only) and the two helpers whose
// own contract guarantees they cannot touch a non-__test__ row
// (sweepStaleTestRows, cleanupTestRows's fail-fast validation).
//
// Network calls to Supabase from a home connection can take a few seconds,
// so every test here sets a generous explicit timeout rather than relying on
// the runner default.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { restGet, sweepStaleTestRows, cleanupTestRows } from '../helpers/supabase.mjs';

const NETWORK_TIMEOUT_MS = 15000;

describe('connectivity', () => {
  it(
    'restGet against counter proves credentials + network + PostgREST all work',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const { status, body } = await restGet('counter?id=eq.1&select=value');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body), 'body should be an array');
      assert.equal(body.length, 1);
      assert.equal(typeof body[0].value, 'number');
    }
  );

  it(
    'restGet against trackables tolerates either era (exists post-0.2, absent pre-0.2)',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const { status } = await restGet('trackables?select=id&limit=1');
      const known = [200, 404, 400];
      assert.ok(
        known.includes(status),
        `expected status to be one of ${known.join(', ')}, got ${status}`
      );
      if (status === 200) {
        console.log('[connectivity] trackables table EXISTS (post-Step-0.2 era)');
      } else {
        console.log(
          `[connectivity] trackables table ABSENT (pre-Step-0.2 era) — got status ${status}`
        );
      }
    }
  );

  it(
    'sweepStaleTestRows resolves to a number >= 0 and never throws, table present or not',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const result = await sweepStaleTestRows();
      assert.equal(typeof result, 'number');
      assert.ok(result >= 0);
    }
  );

  // This is the fail-fast guard that stops a teardown from ever touching a
  // real (non-__test__) row: cleanupTestRows must validate every name in the
  // list BEFORE issuing any delete, so a single bad name anywhere in the
  // list aborts the whole call having deleted nothing. No network call
  // should even be necessary for this to reject.
  it(
    'cleanupTestRows rejects when the list contains any non-test name (validates before deleting anything)',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      await assert.rejects(() => cleanupTestRows(['__test__ok', 'real_habit']));
    }
  );

  it(
    'cleanupTestRows([]) resolves to 0',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const result = await cleanupTestRows([]);
      assert.equal(result, 0);
    }
  );

  it(
    'restGet does not throw on a non-2xx response',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const { status } = await restGet('definitely_not_a_table?select=id');
      assert.notEqual(status, 200);
    }
  );
});
