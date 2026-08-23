// Integration tests for Step 0.2: the migration from the narrow
// skills/skill_entries schema to the general trackables/entries model,
// plus the new single-row app_settings table.
//
// Real PostgREST calls against the LIVE Supabase project. Every trackable
// created here is named __test__0_2_<something> and is queued for cleanup
// the moment we attempt to create it (even if the create itself is expected
// to fail/reject) — cleanupTestRows() on a name that was never actually
// inserted is a harmless no-op, so queuing eagerly is strictly safer than
// queuing only after a successful create.
//
// Network calls to Supabase can take a few seconds, so every test carries
// an explicit generous timeout rather than relying on the runner default.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  restGet,
  createTestTrackable,
  cleanupTestRows,
  createTestEntry,
  upsertTestEntry,
} from '../helpers/supabase.mjs';

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
  },
  { timeout: CLEANUP_TIMEOUT_MS }
);

describe('schema (Step 0.2): tables exist / renamed away', () => {
  it(
    'trackables is queryable',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const { status } = await restGet('trackables?select=id&limit=1');
      assert.equal(status, 200);
    }
  );

  it(
    'entries is queryable',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const { status } = await restGet('entries?select=id&limit=1');
      assert.equal(status, 200);
    }
  );

  it(
    'skills no longer exists (renamed away by the migration)',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const { status } = await restGet('skills?select=id&limit=1');
      assert.notEqual(status, 200);
    }
  );

  it(
    'skill_entries no longer exists (renamed away by the migration)',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const { status } = await restGet('skill_entries?select=id&limit=1');
      assert.notEqual(status, 200);
    }
  );

  it(
    'counter is untouched by the migration (the keepalive workflow depends on it)',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const { status, body } = await restGet('counter?id=eq.1&select=value');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 1);
      assert.equal(typeof body[0].value, 'number');
    }
  );
});

describe('schema (Step 0.2): app_settings is a seeded singleton', () => {
  // Read-only on purpose: app_settings has no name column and therefore no
  // __test__ guard, so writing to it from this suite would be out of
  // bounds. The single-row check constraint itself is verified separately
  // by the orchestrator via direct database introspection.
  it(
    'has exactly one row, id 1, rolling_window_days defaulted to 90',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const { status, body } = await restGet(
        'app_settings?select=id,rolling_window_days'
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 1);
      assert.equal(body[0].id, 1);
      assert.equal(body[0].rolling_window_days, 90);
    }
  );
});

describe('schema (Step 0.2): round-trip create -> read -> delete', () => {
  // This is the headline test of this step. Until trackables existed,
  // createTestTrackable() had never successfully completed a real insert
  // against a live table — only its input guard and its table-missing
  // fallback path were exercised. This is the first end-to-end proof that
  // the teardown helper (cleanupTestRows -> deleteTestTrackablesByName)
  // actually deletes what it claims to, rather than merely returning a
  // plausible-looking count.
  it(
    'create resolves to a row with a numeric id and the given name',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_roundtrip');
      const row = await createTestTrackable({ name });
      assert.equal(typeof row.id, 'number');
      assert.equal(row.name, name);
    }
  );

  it(
    'full round-trip: read finds it, cleanup deletes exactly one, read then finds none',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_roundtrip_2');
      const created = await createTestTrackable({ name });

      const before = await restGet(
        `trackables?name=eq.${name}&select=*`
      );
      assert.equal(before.status, 200);
      assert.equal(before.body.length, 1);
      assert.equal(before.body[0].id, created.id);

      const deletedCount = await cleanupTestRows([name]);
      assert.equal(deletedCount, 1);

      const after1 = await restGet(
        `trackables?name=eq.${name}&select=*`
      );
      assert.equal(after1.status, 200);
      assert.equal(after1.body.length, 0);
    }
  );
});

describe('schema (Step 0.2): column defaults', () => {
  it(
    'a trackable created with only a name gets every documented default',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_defaults');
      const row = await createTestTrackable({ name });

      assert.equal(row.value_shape, 'boolean');
      // Default was changed from 'cumulative' to 'state' by migration 0004
      // (Step 2.1b, 2026-08-22) — the user tried additive re-logging on
      // device and asked for replace-only instead. This pins the CURRENT
      // default; it is deliberate, not drift.
      assert.equal(row.relog_semantic, 'state');
      assert.equal(row.aggregation, 'sum');
      assert.equal(row.direction, 'build');
      assert.equal(row.target_type, 'none');
      assert.equal(row.bounds_enabled, false);
      assert.equal(row.bounds_mode, 'auto');
      assert.equal(row.sort_order, 0);
      assert.equal(row.archived, false);
      assert.equal(typeof row.created_at, 'string');
      assert.ok(row.created_at.length > 0);

      assert.equal(row.target_days, null);
      assert.equal(row.bound_lower, null);
      assert.equal(row.bound_upper, null);
      assert.equal(row.unit, null);
      assert.equal(row.target_value, null);
    }
  );
});

describe('schema (Step 0.2): check constraints', () => {
  async function assertRejectsWith4xx(fields) {
    await assert.rejects(
      () => createTestTrackable(fields),
      (err) => {
        assert.ok(
          err.status >= 400 && err.status < 500,
          `expected a 4xx status, got ${err.status}`
        );
        return true;
      }
    );
  }

  it(
    'rejects an invalid value_shape',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_bad_shape');
      await assertRejectsWith4xx({ name, value_shape: 'nonsense' });
    }
  );

  it(
    'rejects an invalid relog_semantic',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_bad_relog');
      await assertRejectsWith4xx({ name, relog_semantic: 'nonsense' });
    }
  );

  it(
    'rejects an invalid aggregation',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_bad_agg');
      await assertRejectsWith4xx({ name, aggregation: 'nonsense' });
    }
  );

  it(
    'rejects an invalid bounds_mode',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_bad_mode');
      await assertRejectsWith4xx({ name, bounds_mode: 'nonsense' });
    }
  );

  it(
    'rejects an invalid direction',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_bad_dir');
      await assertRejectsWith4xx({ name, direction: 'nonsense' });
    }
  );

  it(
    'rejects an invalid target_type',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_bad_ttype');
      await assertRejectsWith4xx({ name, target_type: 'nonsense' });
    }
  );

  it(
    'rejects target_days containing 0 (not a valid ISO weekday)',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_bad_days');
      await assertRejectsWith4xx({ name, target_days: [0] });
    }
  );

  it(
    'rejects target_days containing 8 (not a valid ISO weekday)',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_bad_days8');
      await assertRejectsWith4xx({ name, target_days: [8] });
    }
  );

  it(
    'rejects bound_lower >= bound_upper',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_bad_bounds');
      await assertRejectsWith4xx({ name, bound_lower: 100, bound_upper: 10 });
    }
  );

  it(
    'accepts a valid target_days array and reads it back correctly',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_ok_days');
      const row = await createTestTrackable({ name, target_days: [1, 3, 5] });
      assert.ok(Array.isArray(row.target_days));
      assert.ok(row.target_days.includes(1));
      assert.ok(row.target_days.includes(3));
      assert.ok(row.target_days.includes(5));
    }
  );
});

describe('schema (Step 0.2): target_value is numeric, not smallint', () => {
  it(
    'accepts a fractional value that would be meaningless for a smallint',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_target');
      const row = await createTestTrackable({ name, target_value: 2000.5 });
      assert.equal(Number(row.target_value), 2000.5);
    }
  );

  it(
    'accepts a value that would overflow the old smallint (max 32767)',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_target_big');
      const row = await createTestTrackable({ name, target_value: 50000 });
      assert.equal(Number(row.target_value), 50000);
    }
  );
});

describe('schema (Step 0.2): unique(trackable_id, entry_date)', () => {
  it(
    'one entry per day succeeds, a second for the same day conflicts, upsert merges, a different day is separate',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_unique');
      const trackable = await createTestTrackable({ name });

      const first = await createTestEntry(trackable, {
        entry_date: '2026-03-15',
        value: 1,
      });
      assert.equal(Number(first.value), 1);

      // This constraint is what the entire re-log-semantics design rests
      // on (Step 1.1's cumulative vs. state behavior needs "one row per
      // trackable per day" to be actually enforced by the database, not
      // just assumed by client code) — so prove the conflict is real.
      await assert.rejects(
        () =>
          createTestEntry(trackable, {
            entry_date: '2026-03-15',
            value: 1,
          }),
        (err) => {
          assert.equal(err.status, 409);
          return true;
        }
      );

      const merged = await upsertTestEntry(trackable, {
        entry_date: '2026-03-15',
        value: 7,
      });
      assert.equal(Number(merged.value), 7);

      const otherDay = await createTestEntry(trackable, {
        entry_date: '2026-03-16',
        value: 1,
      });
      assert.equal(typeof otherDay.id, 'number');
      assert.notEqual(otherDay.id, first.id);
    }
  );
});

describe('schema (Step 0.2): entries cascade on parent delete', () => {
  it(
    'deleting the trackable removes its entries too, leaving no orphans',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_cascade');
      const trackable = await createTestTrackable({ name });

      await createTestEntry(trackable, { entry_date: '2026-03-15', value: 1 });
      await createTestEntry(trackable, { entry_date: '2026-03-16', value: 1 });

      const before = await restGet(
        `entries?trackable_id=eq.${trackable.id}&select=id`
      );
      assert.equal(before.status, 200);
      assert.equal(before.body.length, 2);

      const deletedCount = await cleanupTestRows([name]);
      assert.equal(deletedCount, 1);

      const after1 = await restGet(
        `entries?trackable_id=eq.${trackable.id}&select=id`
      );
      assert.equal(after1.status, 200);
      assert.equal(after1.body.length, 0);
    }
  );
});

describe('schema (Step 0.2): updated_at trigger', () => {
  it(
    'updated_at advances strictly on a later upsert of the same day',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__0_2_touch');
      const trackable = await createTestTrackable({ name });

      const first = await createTestEntry(trackable, {
        entry_date: '2026-03-15',
        value: 1,
      });
      const firstUpdatedAt = new Date(first.updated_at).getTime();

      const second = await upsertTestEntry(trackable, {
        entry_date: '2026-03-15',
        value: 2,
      });
      const secondUpdatedAt = new Date(second.updated_at).getTime();

      // This trigger is what makes it safe for the app to never set
      // updated_at by hand — the old schema required the client to set it
      // manually on every write, which was a footgun (forget it once and
      // the timestamp silently goes stale). The migration removes that
      // responsibility from the client entirely.
      assert.ok(
        secondUpdatedAt > firstUpdatedAt,
        `expected updated_at to advance: ${first.updated_at} -> ${second.updated_at}`
      );
    }
  );
});

describe('schema (Step 0.2): entry helper guard rejects a non-test parent', () => {
  // Entries have no name column of their own, so the parent trackable's
  // name is the only thing that can prove an entry is test data. None of
  // these should make a network call at all — they must fail on the guard
  // before ever reaching fetch().
  it(
    'createTestEntry rejects when the parent trackable is not a __test__ row',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      await assert.rejects(() =>
        createTestEntry({ id: 1, name: 'real_habit' }, { entry_date: '2026-03-15' })
      );
    }
  );

  it(
    'upsertTestEntry rejects when the parent trackable is not a __test__ row',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      await assert.rejects(() =>
        upsertTestEntry({ id: 1, name: 'real_habit' }, { entry_date: '2026-03-15' })
      );
    }
  );

  it(
    'createTestEntry rejects when the parent trackable is null',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      await assert.rejects(() =>
        createTestEntry(null, { entry_date: '2026-03-15' })
      );
    }
  );

  it(
    'createTestEntry rejects when the parent trackable has no name at all',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      await assert.rejects(() =>
        createTestEntry({ id: 1 }, { entry_date: '2026-03-15' })
      );
    }
  );
});
