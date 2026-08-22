// Integration tests for Step 1.1: js/api.js, the thin PostgREST client.
//
// Real PostgREST calls against the LIVE Supabase project — this exercises
// js/api.js's own functions directly (not just the tests/helpers/supabase.mjs
// scaffolding), including its real error mapping against real Postgres
// errors (FK violations, check constraints).
//
// Every trackable created here is named __test__1.1_<something> and is
// queued for cleanup the moment we attempt to create it (even if the create
// itself is expected to fail/reject) — cleanupTestRows() on a name that was
// never actually inserted is a harmless no-op, so queuing eagerly is
// strictly safer than queuing only after a successful create. Entries have
// no name of their own, so they are always created against one of these
// tracked trackables and rely on ON DELETE CASCADE to disappear during
// teardown.
//
// app_settings is a live singleton with no name column and therefore no
// __test__ guard — see the "settings" describe block below for how writes
// to it are kept net-zero.
//
// Network calls to Supabase can take a few seconds, so every test carries
// an explicit generous timeout rather than relying on the runner default.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  listTrackables,
  createTrackable,
  updateTrackable,
  archiveTrackable,
  listEntries,
  upsertEntry,
  deleteEntry,
  getSettings,
  updateSettings,
} from '../../js/api.js';
import { cleanupTestRows } from '../helpers/supabase.mjs';

const NETWORK_TIMEOUT_MS = 15000;
const CLEANUP_TIMEOUT_MS = 30000;

// Every __test__ name any test in this file attempts to create. Populated
// eagerly (before the create call, not after), so a failed/rejected create
// still leaves its name here for the final sweep.
const createdNames = [];
function track(name) {
  createdNames.push(name);
  return name;
}

after(
  async () => {
    await cleanupTestRows(createdNames);

    // Post-teardown assertion (must account for archived rows, which is
    // why includeArchived: true is used here): nothing this file created
    // should still exist under either name.
    const remaining = await listTrackables({ includeArchived: true });
    const leftover = remaining.filter(
      (t) => typeof t.name === 'string' && t.name.startsWith('__test__1.1_')
    );
    assert.equal(
      leftover.length,
      0,
      `test rows left behind after cleanup: ${leftover.map((t) => t.name).join(', ')}`
    );
  },
  { timeout: CLEANUP_TIMEOUT_MS }
);

describe('api.js (Step 1.1): trackable lifecycle', () => {
  it(
    'create -> list -> update -> archive -> excluded/included by listTrackables',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__1.1_lifecycle');
      const created = await createTrackable({ name, value_shape: 'numeric', unit: 'reps' });

      assert.equal(typeof created.id, 'number');
      assert.equal(created.name, name);
      assert.equal(created.value_shape, 'numeric');
      assert.equal(created.unit, 'reps');
      assert.equal(created.archived, false);
      // Schema defaults applied by the DB, not sent by the client.
      assert.equal(created.relog_semantic, 'cumulative');
      assert.equal(created.aggregation, 'sum');

      const listed = await listTrackables();
      assert.ok(
        listed.some((t) => t.id === created.id),
        'newly created trackable must appear in the default (non-archived) listing'
      );

      const updated = await updateTrackable(created.id, { unit: 'sets' });
      assert.equal(updated.id, created.id);
      assert.equal(updated.unit, 'sets');

      const archived = await archiveTrackable(created.id);
      assert.equal(archived.id, created.id);
      assert.equal(archived.archived, true);

      const afterArchive = await listTrackables();
      assert.ok(
        !afterArchive.some((t) => t.id === created.id),
        'archived trackable must be excluded from the default listing'
      );

      const withArchived = await listTrackables({ includeArchived: true });
      assert.ok(
        withArchived.some((t) => t.id === created.id),
        'archived trackable must still appear when includeArchived is true'
      );
    }
  );
});

describe('api.js (Step 1.1): upsertEntry round-trip', () => {
  // The most important case in this file: the entire re-log design
  // (BUILD_PLAN Step 1.1) rests on upsertEntry() editing the same
  // (trackable_id, entry_date) row in place instead of erroring with a
  // 409 conflict, and on the DB trigger — not the client — maintaining
  // updated_at.
  it(
    'a second upsert for the same (trackable_id, entry_date) updates the row rather than conflicting, and updated_at strictly advances',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__1.1_upsert');
      const trackable = await createTrackable({ name });

      const first = await upsertEntry({
        trackable_id: trackable.id,
        entry_date: '2026-04-01',
        value: 1,
      });
      assert.equal(Number(first.value), 1);
      const firstUpdatedAt = new Date(first.updated_at).getTime();

      const second = await upsertEntry({
        trackable_id: trackable.id,
        entry_date: '2026-04-01',
        value: 99,
      });
      assert.equal(second.id, first.id, 'must edit the same row, not insert a second one');
      assert.equal(Number(second.value), 99);
      const secondUpdatedAt = new Date(second.updated_at).getTime();

      assert.ok(
        secondUpdatedAt > firstUpdatedAt,
        `expected updated_at to strictly advance: ${first.updated_at} -> ${second.updated_at}`
      );
    }
  );
});

describe('api.js (Step 1.1): listEntries range filtering', () => {
  it(
    'from/to are inclusive on both ends, ordered by entry_date ascending',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__1.1_range');
      const trackable = await createTrackable({ name });

      const beforeFrom = '2026-05-01';
      const onFrom = '2026-05-05';
      const middle = '2026-05-10';
      const onTo = '2026-05-15';
      const afterTo = '2026-05-20';

      for (const entry_date of [beforeFrom, onFrom, middle, onTo, afterTo]) {
        await upsertEntry({ trackable_id: trackable.id, entry_date, value: 1 });
      }

      const result = await listEntries({
        trackableIds: [trackable.id],
        from: onFrom,
        to: onTo,
      });

      assert.deepEqual(
        result.map((e) => e.entry_date),
        [onFrom, middle, onTo],
        'range must include both boundary dates and exclude rows outside them'
      );
    }
  );
});

describe('api.js (Step 1.1): listEntries scoping', () => {
  it(
    'scoping to one trackable does not return another trackable\'s entries',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const nameA = track('__test__1.1_scopeA');
      const nameB = track('__test__1.1_scopeB');
      const a = await createTrackable({ name: nameA });
      const b = await createTrackable({ name: nameB });

      await upsertEntry({ trackable_id: a.id, entry_date: '2026-06-01', value: 1 });
      await upsertEntry({ trackable_id: b.id, entry_date: '2026-06-01', value: 1 });

      const result = await listEntries({ trackableIds: [a.id] });
      assert.ok(result.length > 0, 'trackable A must have at least its own entry');
      assert.ok(
        result.every((e) => Number(e.trackable_id) === a.id),
        'listEntries scoped to A must not return B\'s entries'
      );
    }
  );
});

describe('api.js (Step 1.1): deleteEntry', () => {
  it(
    'returns 1 and removes the row; a second delete of the same row returns 0 without throwing',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__1.1_delete');
      const trackable = await createTrackable({ name });
      await upsertEntry({ trackable_id: trackable.id, entry_date: '2026-07-01', value: 5 });

      const firstCount = await deleteEntry(trackable.id, '2026-07-01');
      assert.equal(firstCount, 1);

      const afterDelete = await listEntries({
        trackableIds: [trackable.id],
        from: '2026-07-01',
        to: '2026-07-01',
      });
      assert.equal(afterDelete.length, 0);

      const secondCount = await deleteEntry(trackable.id, '2026-07-01');
      assert.equal(secondCount, 0, 'deleting an already-gone row is a normal 0-row result, not an error');
    }
  );
});

describe('api.js (Step 1.1): settings', () => {
  it(
    'getSettings returns the id=1 singleton with a numeric rolling_window_days',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const settings = await getSettings();
      assert.equal(settings.id, 1);
      assert.equal(typeof settings.rolling_window_days, 'number');
    }
  );

  // app_settings is a live singleton with no name column and therefore no
  // __test__ guard (see the file header). Writing anything other than the
  // row's own current value here would permanently alter real state read
  // by the live app, and there is no teardown that could undo it. So this
  // test reads the current rolling_window_days into V and writes exactly
  // V back — this still exercises the real PATCH round-trip (request
  // shape, response shape, the "no id/updated_at in patch" contract)
  // without ever introducing a net change. Do not change this test to
  // write any other value.
  it(
    'updateSettings round-trips with no net change to the live row',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const before = await getSettings();
      const V = before.rolling_window_days;

      const updated = await updateSettings({ rolling_window_days: V });
      assert.equal(updated.id, 1);
      assert.equal(updated.rolling_window_days, V);

      const after1 = await getSettings();
      assert.equal(after1.rolling_window_days, V, 'the live row must be unchanged after this test');
    }
  );
});

describe('api.js (Step 1.1): real error mapping', () => {
  it(
    'upsertEntry against a non-existent trackable_id rejects with an ApiError carrying a real FK violation code and a 4xx, non-retryable status',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      await assert.rejects(
        () =>
          upsertEntry({
            trackable_id: 999999999,
            entry_date: '2026-08-01',
            value: 1,
          }),
        (err) => {
          assert.equal(err.name, 'ApiError');
          assert.ok(err.status >= 400 && err.status < 500, `expected a 4xx status, got ${err.status}`);
          assert.ok(err.code, 'expected a real PostgREST error code (e.g. 23503) on the error');
          assert.equal(err.retryable, false);
          return true;
        }
      );
    }
  );

  it(
    'createTrackable with an invalid value_shape rejects with an ApiError carrying a 4xx, non-retryable status',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__1.1_badshape');
      await assert.rejects(
        () => createTrackable({ name, value_shape: 'nonsense' }),
        (err) => {
          assert.equal(err.name, 'ApiError');
          assert.ok(err.status >= 400 && err.status < 500, `expected a 4xx status, got ${err.status}`);
          assert.equal(err.retryable, false);
          return true;
        }
      );
    }
  );
});
