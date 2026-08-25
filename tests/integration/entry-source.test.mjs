// Step D.2 — entries.source against the LIVE database (migration 0006).
//
// These cover the three properties the CSV import's reversibility rests on.
// The middle one is the reason this file exists: it encodes a behaviour that
// is NOT obvious from reading the schema, was wrong in the first draft of the
// plan, and would silently destroy the user's hand-made corrections if a
// future session "simplified" the undo query.
//
// Every trackable is named __test__D.2_* and cleaned up in `after`. Entries
// have no name of their own and disappear via ON DELETE CASCADE.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { upsertEntry } from '../../js/api.js';
import {
  createTestTrackable,
  createTestEntry,
  cleanupTestRows,
  restGet,
} from '../helpers/supabase.mjs';

const NETWORK_TIMEOUT_MS = 15000;
const CLEANUP_TIMEOUT_MS = 30000;

const created = [];
function track(name) {
  created.push(name);
  return name;
}

after(async () => {
  await cleanupTestRows(created);
}, { timeout: CLEANUP_TIMEOUT_MS });

async function entryFor(trackableId) {
  const { body } = await restGet(
    `entries?trackable_id=eq.${trackableId}&select=id,value,source,created_at,updated_at`
  );
  return body[0];
}

describe('Step D.2: entries.source', () => {
  it('defaults to NULL — an app-written row is the NULL case by definition', async () => {
    const name = track('__test__D.2_default_null');
    const t = await createTestTrackable({ name, value_shape: 'numeric' });

    // Deliberately routed through js/api.js, not the test helper: the claim
    // being tested is about what the REAL app write produces.
    await upsertEntry({ trackable_id: t.id, entry_date: '2026-03-01', value: 1500 });

    const row = await entryFor(t.id);
    assert.equal(row.source, null, 'an entry written by the app must have source NULL');
  }, { timeout: NETWORK_TIMEOUT_MS });

  it('rejects an empty or whitespace-only source (entries_source_nonblank_check)', async () => {
    const name = track('__test__D.2_blank_guard');
    const t = await createTestTrackable({ name, value_shape: 'numeric' });

    // A blank source is the worst case: it matches neither `source is null`
    // (so it does not read as an app row) nor `source = '<batch>'` (so it
    // cannot be undone). Such a row would be permanently unattributable.
    for (const blank of ['', '   ', '\t', '\n  ']) {
      await assert.rejects(
        () => createTestEntry(t, { entry_date: '2026-03-02', value: 1, source: blank }),
        (err) => {
          assert.match(String(err.message), /entries_source_nonblank_check|check constraint/i);
          return true;
        },
        `a source of ${JSON.stringify(blank)} must be rejected`
      );
    }

    // ...and a real batch id is accepted, so the guard is not rejecting
    // everything.
    const ok = await createTestEntry(t, {
      entry_date: '2026-03-03',
      value: 1,
      source: 'import:calories-2026-08-25',
    });
    assert.equal(ok.source, 'import:calories-2026-08-25');
  }, { timeout: NETWORK_TIMEOUT_MS });

  it('THE UNDO TRAP: an app edit to an imported day PRESERVES the batch id and BUMPS updated_at', async () => {
    // This is the behaviour migration 0006's undo query is designed around,
    // and it is counter-intuitive enough to be worth a permanent test.
    //
    // PostgREST's `resolution=merge-duplicates` compiles to
    //   INSERT ... ON CONFLICT DO UPDATE SET <only the request body's columns>
    // and js/api.js never sends `source`. So on conflict the column is left
    // UNCHANGED — an imported day the user later corrects in the app keeps
    // its import batch id.
    //
    // Consequence: `delete from entries where source = '<batch>'` would also
    // delete the user's correction. The safe undo additionally requires
    // `updated_at < '<import finish time>'`, which only works because the
    // set_updated_at trigger bumps updated_at on that same conflict-update.
    // Both halves are asserted below; the undo is unsafe if either fails.
    const name = track('__test__D.2_undo_trap');
    const t = await createTestTrackable({ name, value_shape: 'numeric' });
    const BATCH = 'import:undo-trap-2026-08-25';

    await createTestEntry(t, { entry_date: '2026-03-04', value: 1500, source: BATCH });
    const before = await entryFor(t.id);
    assert.equal(before.source, BATCH);

    // A real app edit of that same day, through js/api.js.
    await upsertEntry({ trackable_id: t.id, entry_date: '2026-03-04', value: 1800 });
    const after_ = await entryFor(t.id);

    assert.equal(Number(after_.value), 1800, 'the app edit must actually land');
    assert.equal(
      after_.source,
      BATCH,
      'source must survive an app upsert — if this ever fails, migration 0006\'s undo notes and DATA_MODEL.md are wrong and must be rewritten'
    );
    assert.ok(
      new Date(after_.updated_at) > new Date(after_.created_at),
      'updated_at must advance on an app edit, or the updated_at-scoped safe undo cannot spare hand-corrected rows'
    );
  }, { timeout: NETWORK_TIMEOUT_MS });

  it('the safe undo deletes only untouched imported rows, sparing a hand-edited one', async () => {
    // End-to-end proof of the actual recovery procedure, rather than of its
    // ingredients.
    const name = track('__test__D.2_safe_undo');
    const t = await createTestTrackable({ name, value_shape: 'numeric' });
    const BATCH = 'import:safe-undo-2026-08-25';

    await createTestEntry(t, { entry_date: '2026-04-01', value: 1500, source: BATCH });
    await createTestEntry(t, { entry_date: '2026-04-02', value: 1600, source: BATCH });
    await createTestEntry(t, { entry_date: '2026-04-03', value: 1700, source: BATCH });

    // The user corrects one of them in the app, later.
    await upsertEntry({ trackable_id: t.id, entry_date: '2026-04-02', value: 1650 });

    const { body: rows } = await restGet(
      `entries?trackable_id=eq.${t.id}&select=entry_date,value,source,created_at,updated_at&order=entry_date.asc`
    );
    assert.equal(rows.length, 3);

    // Simulate the safe undo's predicate in JS rather than issuing a DELETE:
    // the point is which rows it SELECTS, and this file must not add a second
    // destructive call site (see tests/helpers/supabase.mjs's header).
    const edited = rows.filter((r) => new Date(r.updated_at) > new Date(r.created_at));
    assert.equal(edited.length, 1, 'exactly one row should look hand-edited');
    assert.equal(edited[0].entry_date, '2026-04-02');

    const wouldDelete = rows.filter(
      (r) => r.source === BATCH && new Date(r.updated_at) <= new Date(r.created_at)
    );
    assert.deepEqual(
      wouldDelete.map((r) => r.entry_date).sort(),
      ['2026-04-01', '2026-04-03'],
      'the safe undo must remove the untouched imported rows and spare the corrected one'
    );

    // And the naive undo would have taken all three — the thing to avoid.
    const naive = rows.filter((r) => r.source === BATCH);
    assert.equal(naive.length, 3, 'documents WHY the naive undo is unsafe');
  }, { timeout: NETWORK_TIMEOUT_MS });
});
