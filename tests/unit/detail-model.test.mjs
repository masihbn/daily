// Contract tests for the PURE exports of js/views/detail.js (BUILD_PLAN
// Step 2.3, "Trackable detail screen shell") — RANGES, resolveRange,
// visibleSlots, SLOT_TITLES. No DOM, no fetch, no localStorage. Written
// strictly from CONTRACT-2.3.md §2; the implementation is being written in
// parallel by another agent from the same contract, so every assertion
// here is against the documented worked examples and rules, not against
// any particular internal approach.
//
// IMPORTANT: every resolveRange date fixture below was independently
// recomputed against the REAL js/dates.js (both by running it once outside
// this file, and again inline here via the property-based checks that call
// addDays/rangeDays directly) rather than trusted from the contract text.
// All eight of the contract's §2.2 worked examples matched exactly on
// recomputation — no mismatch found. See the accompanying report for the
// full recomputation log.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RANGES, resolveRange, visibleSlots, SLOT_TITLES } from '../../js/views/detail.js';
import { addDays, rangeDays } from '../../js/dates.js';

// ===========================================================================
// RANGES (contract §2.1)
// ===========================================================================

describe('RANGES — exact shape and order (contract §2.1)', () => {
  it('is an array of exactly 4 entries', () => {
    assert.ok(Array.isArray(RANGES));
    assert.equal(RANGES.length, 4);
  });

  it('matches the documented array exactly', () => {
    assert.deepEqual(RANGES, [
      { key: '3m', label: '3M', days: 90 },
      { key: '6m', label: '6M', days: 180 },
      { key: '1y', label: '1Y', days: 365 },
      { key: 'all', label: 'All', days: null },
    ]);
  });

  it('every entry has exactly the keys key/label/days, in that shape', () => {
    for (const entry of RANGES) {
      assert.deepEqual(Object.keys(entry).sort(), ['days', 'key', 'label']);
    }
  });
});

// ===========================================================================
// resolveRange (contract §2.2)
// ===========================================================================

describe('resolveRange — worked examples (contract §2.2, assert exactly; independently recomputed)', () => {
  // Every row below was recomputed via `addDays(today, -(days-1))` against
  // the real js/dates.js before being hardcoded here (see the module
  // header and the accompanying report). None disagreed with the
  // contract's table, including the leap-year case, which the contract
  // itself flags as previously wrong in an earlier draft
  // ('2023-03-01', off by one) — the correct value, confirmed by running
  // addDays, is '2023-03-02'.
  const cases = [
    ['3m', '2026-08-23', { from: '2026-05-26', to: '2026-08-23' }],
    ['6m', '2026-08-23', { from: '2026-02-25', to: '2026-08-23' }],
    ['1y', '2026-08-23', { from: '2025-08-24', to: '2026-08-23' }],
    ['all', '2026-08-23', { from: null, to: '2026-08-23' }],
    ['nope', '2026-08-23', { from: '2026-05-26', to: '2026-08-23' }],
    [undefined, '2026-08-23', { from: '2026-05-26', to: '2026-08-23' }],
    ['3m', '2026-01-01', { from: '2025-10-04', to: '2026-01-01' }],
    ['1y', '2024-02-29', { from: '2023-03-02', to: '2024-02-29' }],
  ];

  let n = 0;
  for (const [rangeKey, today, expected] of cases) {
    n += 1;
    it(`case ${n}: resolveRange(${JSON.stringify(rangeKey)}, ${JSON.stringify(today)}) === ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(resolveRange(rangeKey, today), expected);
    });
  }
});

describe('resolveRange — property: matches addDays(today, -(days-1)) directly, not a hardcoded table (independent recomputation)', () => {
  // Rather than trusting the fixture table above, this recomputes the
  // expected `from` for every numeric RANGES entry via the real addDays,
  // for a spread of `today` values including a second (different-year)
  // leap day, and asserts resolveRange agrees. This is the check that
  // would have caught the contract's own earlier off-by-one error even if
  // the hardcoded table above had been transcribed wrong.
  const todays = ['2026-08-23', '2026-08-24', '2026-01-01', '2026-03-01', '2024-02-29', '2028-02-29', '2027-01-01'];

  for (const range of RANGES) {
    if (range.days === null) continue; // 'all' has no day-count arithmetic
    for (const today of todays) {
      it(`${range.key} @ ${today}: from === addDays(today, -(days-1))`, () => {
        const expectedFrom = addDays(today, -(range.days - 1));
        const result = resolveRange(range.key, today);
        assert.equal(result.from, expectedFrom);
        assert.equal(result.to, today);
      });

      it(`${range.key} @ ${today}: inclusive rangeDays(from, to).length === days`, () => {
        const result = resolveRange(range.key, today);
        assert.equal(rangeDays(result.from, result.to).length, range.days);
      });
    }
  }
});

describe('resolveRange — from is never later than to (contract §4.1)', () => {
  const todays = ['2026-08-23', '2026-01-01', '2024-02-29'];
  for (const range of RANGES) {
    for (const today of todays) {
      it(`${range.key} @ ${today}: from <= to (or from is null)`, () => {
        const result = resolveRange(range.key, today);
        assert.equal(result.to, today);
        if (result.from !== null) {
          assert.ok(result.from <= result.to, `from (${result.from}) should be <= to (${result.to})`);
        }
      });
    }
  }
});

describe('resolveRange — additional documented rules', () => {
  it("'all' always yields from: null regardless of today", () => {
    assert.equal(resolveRange('all', '2026-08-23').from, null);
    assert.equal(resolveRange('all', '2000-01-01').from, null);
  });

  it('to always equals the injected today, verbatim, for every range key', () => {
    for (const range of RANGES) {
      assert.equal(resolveRange(range.key, '2026-08-23').to, '2026-08-23');
    }
  });

  it('an unknown rangeKey falls back to the same result as "3m" exactly', () => {
    const today = '2026-08-23';
    assert.deepEqual(resolveRange('bogus', today), resolveRange('3m', today));
    assert.deepEqual(resolveRange('', today), resolveRange('3m', today));
    assert.deepEqual(resolveRange(null, today), resolveRange('3m', today));
  });
});

// ===========================================================================
// visibleSlots (contract §2.3)
// ===========================================================================

describe('visibleSlots — worked examples (contract §2.3, assert exactly)', () => {
  const cases = [
    [{ value_shape: 'boolean' }, 5, ['heatmap', 'weekly']],
    [{ value_shape: 'numeric' }, 5, ['heatmap', 'weekly']],
    [{ value_shape: 'numeric', bounds_enabled: true }, 0, ['heatmap', 'weekly', 'bounds']],
    [{ value_shape: 'numeric', bounds_enabled: true }, 3, ['heatmap', 'weekly', 'bounds', 'overlay']],
    [{ value_shape: 'boolean', bounds_enabled: true }, 3, ['heatmap', 'weekly']],
    [{ value_shape: 'numeric', bounds_enabled: true }, undefined, ['heatmap', 'weekly', 'bounds']],
    [null, 3, ['heatmap', 'weekly']],
  ];

  let n = 0;
  for (const [trackable, count, expected] of cases) {
    n += 1;
    it(`case ${n}: visibleSlots(${JSON.stringify(trackable)}, ${JSON.stringify(count)}) === ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(visibleSlots(trackable, count), expected);
    });
  }
});

describe('visibleSlots — additional documented rules', () => {
  it('heatmap and weekly are always present, in that order, as the first two entries, regardless of shape/bounds/count', () => {
    const combos = [
      [{ value_shape: 'boolean' }, 0],
      [{ value_shape: 'numeric', bounds_enabled: true }, 5],
      [{}, 5],
      [null, 5],
    ];
    for (const [trackable, count] of combos) {
      const result = visibleSlots(trackable, count);
      assert.deepEqual(result.slice(0, 2), ['heatmap', 'weekly']);
    }
  });

  it('bounds requires BOTH bounds_enabled:true AND value_shape:"numeric" — either alone is not enough', () => {
    assert.deepEqual(visibleSlots({ value_shape: 'numeric', bounds_enabled: false }, 5), ['heatmap', 'weekly']);
    assert.deepEqual(visibleSlots({ value_shape: 'boolean', bounds_enabled: true }, 5), ['heatmap', 'weekly']);
    assert.deepEqual(visibleSlots({ value_shape: 'numeric', bounds_enabled: true }, 5), [
      'heatmap',
      'weekly',
      'bounds',
      'overlay',
    ]);
  });

  it('overlay requires bounds to already be present — it never appears without bounds even if otherTrackableCount > 0', () => {
    const result = visibleSlots({ value_shape: 'boolean', bounds_enabled: true }, 10);
    assert.ok(!result.includes('overlay'));
  });

  it('overlay appears only when otherTrackableCount is a real positive number (not merely truthy)', () => {
    const trackable = { value_shape: 'numeric', bounds_enabled: true };
    assert.ok(!visibleSlots(trackable, 0).includes('overlay'));
    assert.ok(visibleSlots(trackable, 1).includes('overlay'));
    assert.ok(visibleSlots(trackable, 3).includes('overlay'));
  });
});

describe('visibleSlots — hostile input sweep, never throws (contract §4.1)', () => {
  const hostile = [null, undefined, 0, '', [], {}, true, NaN];
  const validSlots = new Set(['heatmap', 'weekly', 'bounds', 'overlay']);

  it('every (trackable, otherTrackableCount) pair in the hostile x hostile cross product never throws and returns a valid slot array', () => {
    for (const t of hostile) {
      for (const c of hostile) {
        let result;
        assert.doesNotThrow(() => {
          result = visibleSlots(t, c);
        }, `visibleSlots(${JSON.stringify(t)}, ${JSON.stringify(c)}) threw`);
        assert.ok(Array.isArray(result), `visibleSlots(${JSON.stringify(t)}, ${JSON.stringify(c)}) did not return an array`);
        for (const slot of result) {
          assert.ok(validSlots.has(slot), `unexpected slot "${slot}"`);
        }
        // heatmap/weekly are unconditional per the contract, so they must
        // survive every hostile input.
        assert.ok(result.includes('heatmap'));
        assert.ok(result.includes('weekly'));
      }
    }
  });

  it('a null/non-object trackable yields exactly [\'heatmap\',\'weekly\'] for every hostile otherTrackableCount (contract §2.3)', () => {
    for (const c of hostile) {
      assert.deepEqual(visibleSlots(null, c), ['heatmap', 'weekly']);
    }
  });

  it('every hostile value for a primitive/array trackable (never a genuine numeric+bounds_enabled object) also yields exactly [\'heatmap\',\'weekly\'] (none of them carries value_shape:"numeric" + bounds_enabled:true)', () => {
    for (const t of hostile) {
      assert.deepEqual(visibleSlots(t, 0), ['heatmap', 'weekly']);
    }
  });

  it('a non-number otherTrackableCount is treated as 0 — overlay never appears for any hostile count value, even on a bounds-enabled numeric trackable', () => {
    const trackable = { value_shape: 'numeric', bounds_enabled: true };
    for (const c of hostile) {
      const result = visibleSlots(trackable, c);
      assert.deepEqual(result, ['heatmap', 'weekly', 'bounds']);
    }
  });
});

// ===========================================================================
// SLOT_TITLES (contract §2.4)
// ===========================================================================

describe('SLOT_TITLES — exact mapping (contract §2.4)', () => {
  it('matches the documented object exactly', () => {
    assert.deepEqual(SLOT_TITLES, {
      heatmap: 'Calendar',
      weekly: 'Weekly trend',
      bounds: 'Range',
      overlay: 'Overlay',
    });
  });

  it('has an entry for every slot key visibleSlots can ever produce', () => {
    const possibleSlots = ['heatmap', 'weekly', 'bounds', 'overlay'];
    for (const slot of possibleSlots) {
      assert.equal(typeof SLOT_TITLES[slot], 'string');
      assert.ok(SLOT_TITLES[slot].length > 0);
    }
  });
});
