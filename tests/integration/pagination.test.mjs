// Integration tests for Step D.6b: js/api.js's listEntries() paginates
// through PostgREST's 1,000-row cap (CONTRACT-D.6b.md §1). Real PostgREST
// calls against the TEST Supabase project (Step D.4) — never production;
// tests/helpers/test-target.mjs / tests/helpers/run-tier.mjs refuse to run
// the integration tier against anything else.
//
// This file's whole reason to exist is the seeding cost noted in
// BUILD_PLAN.md's Step D.6b notes: proving the pager actually crosses a real
// 1,000-row PostgREST response requires putting at least 1,001 real rows in
// front of it, which is expensive enough that it did not exist before this
// step. tests/helpers/supabase.mjs's upsertTestEntries() (added alongside
// this file) batches the seed in groups of 500, mirroring
// scripts/restore.mjs's chunk()/BATCH_SIZE upsert shape.
//
// The seeded trackable is __test__d6b_pager, created via createTestTrackable
// and torn down via cleanupTestRows() in the after-hook, exactly like
// tests/integration/api.test.mjs. Entries have no name of their own and
// cascade-delete with their parent trackable.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { listEntries } from '../../js/api.js';
import {
  createTestTrackable,
  upsertTestEntries,
  cleanupTestRows,
  restGet,
} from '../helpers/supabase.mjs';
import { addDays } from '../../js/dates.js';

// Generous multiple of this repo's normal 15s single-call network timeout:
// this test does one 1,001-row seed (3 upsert batches) plus 4 more network
// round trips (precondition proof + 3 listEntries calls, at least one of
// which itself pages twice), well within a 120s budget on a live network.
const TEST_TIMEOUT_MS = 120000;
const CLEANUP_TIMEOUT_MS = 30000;

const ROW_COUNT = 1001;
const END_DATE = '2026-09-01';
// The first of ROW_COUNT consecutive days ENDING at END_DATE (inclusive) —
// i.e. addDays(END_DATE, -(ROW_COUNT - 1)). Per CONTRACT-D.6b.md's worked
// example this lands on 2023-12-06; computed here via the real js/dates.js
// rather than hardcoded, so this test does not silently drift if that
// arithmetic ever changes, but also asserted against the literal below so a
// change IS noticed.
const START_DATE = addDays(END_DATE, -(ROW_COUNT - 1));

const createdNames = [];
function track(name) {
  createdNames.push(name);
  return name;
}

after(
  async () => {
    await cleanupTestRows(createdNames);
  },
  { timeout: CLEANUP_TIMEOUT_MS }
);

describe('api.js (Step D.6b): listEntries pages past PostgREST\'s 1,000-row cap', () => {
  it(
    'seeds 1,001 entries on one trackable, then proves the cap and the pager',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const name = track('__test__d6b_pager');
      const trackable = await createTestTrackable({ name, value_shape: 'numeric' });

      // --- seed --------------------------------------------------------
      const rows = [];
      for (let i = 0; i < ROW_COUNT; i += 1) {
        rows.push({ entry_date: addDays(START_DATE, i), value: i + 1 });
      }
      assert.equal(START_DATE, '2023-12-06');
      assert.equal(rows[0].entry_date, START_DATE);
      assert.equal(rows[rows.length - 1].entry_date, END_DATE);

      const written = await upsertTestEntries(trackable, rows);
      assert.equal(written, ROW_COUNT);

      // --- (a) precondition proof: the test project really caps at 1,000 -
      const { status, body } = await restGet(
        `entries?select=entry_date&trackable_id=eq.${trackable.id}&order=entry_date.asc`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.equal(
        body.length,
        1000,
        `expected the test project's PostgREST max-rows to be 1,000 so this pager test actually ` +
          `exercises the cap; got ${body.length} rows back from one unpaged GET. If the test ` +
          `project's db-max-rows setting is not 1,000, this test is not exercising the cap it ` +
          `claims to, and the pagination assertions below prove nothing about the real PostgREST ` +
          `limit.`
      );

      // --- (b) listEntries with no from/to returns the FULL 1,001 --------
      const all = await listEntries({ trackableIds: [trackable.id] });
      assert.equal(all.length, ROW_COUNT);
      const dates = all.map((e) => e.entry_date);
      assert.deepEqual(dates, [...dates].sort(), 'result must already be ascending by entry_date');
      assert.equal(new Set(dates).size, dates.length, 'no duplicate entry_date rows');
      assert.equal(all[0].entry_date, START_DATE);
      assert.equal(all[all.length - 1].entry_date, END_DATE);
      assert.equal(Number(all[all.length - 1].value), ROW_COUNT);

      // --- (c) from/to spanning the whole seeded range also returns 1,001 -
      const spanned = await listEntries({
        trackableIds: [trackable.id],
        from: START_DATE,
        to: END_DATE,
      });
      assert.equal(spanned.length, ROW_COUNT);

      // --- (d) a tiny from==to window is not disturbed by paging ---------
      const tiny = await listEntries({
        trackableIds: [trackable.id],
        from: END_DATE,
        to: END_DATE,
      });
      assert.equal(tiny.length, 1);
      assert.equal(tiny[0].entry_date, END_DATE);
    }
  );
});
