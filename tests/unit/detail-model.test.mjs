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
import {
  RANGES,
  resolveRange,
  visibleSlots,
  SLOT_TITLES,
  historyFrom,
  calendarFrom,
  CALENDAR_FLOOR_DAYS,
} from '../../js/views/detail.js';
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

// ===========================================================================
// historyFrom (Step D.6b, CONTRACT-D.6b.md §2.1) — the calendar's "reach the
// whole history regardless of the range control" primitive. Returns the
// smallest entry_date string among an array's well-formed rows, or null.
// Never throws. Plain string comparison, same fact js/charts/heatmap.js
// relies on for 'YYYY-MM-DD' ordering.
// ===========================================================================

describe('historyFrom(entries) — Step D.6b (contract §2.1)', () => {
  it('returns the earliest entry_date of an unsorted array', () => {
    const entries = [
      { entry_date: '2026-03-01' },
      { entry_date: '2024-01-15' },
      { entry_date: '2025-06-10' },
    ];
    assert.equal(historyFrom(entries), '2024-01-15');
  });

  it('a single-row array returns that row\'s own entry_date', () => {
    assert.equal(historyFrom([{ entry_date: '2026-01-01' }]), '2026-01-01');
  });

  it('an empty array returns null', () => {
    assert.equal(historyFrom([]), null);
  });

  const nonArrayInputs = [null, undefined, {}, 'nope', 42, true];
  for (const v of nonArrayInputs) {
    it(`non-array input ${JSON.stringify(v)} returns null`, () => {
      assert.equal(historyFrom(v), null);
    });
  }

  it('skips malformed rows (null, a number, a string, {}) and rows whose entry_date is not a string or does not match YYYY-MM-DD (a non-string, "2026-1-1", ""), returning the earliest well-formed row among the rest', () => {
    const entries = [
      null,
      42,
      'nope',
      {},
      { entry_date: 123 },
      { entry_date: '2026-1-1' },
      { entry_date: '' },
      { entry_date: '2025-05-05' },
      { entry_date: '2024-12-01' },
    ];
    assert.equal(historyFrom(entries), '2024-12-01');
  });

  it('when the row that would be earliest is malformed, the earliest WELL-FORMED row is returned instead', () => {
    const entries = [
      { entry_date: '2020-1-1' }, // conceptually earliest, but malformed (not zero-padded) — must be skipped
      { entry_date: '2021-05-05' },
      { entry_date: '2022-07-07' },
    ];
    assert.equal(historyFrom(entries), '2021-05-05');
  });

  it('never throws over a hostile-input sweep', () => {
    const hostileInputs = [
      null,
      undefined,
      [],
      'not-an-array',
      123,
      {},
      [null, undefined, 42, 'x', {}, [], true, Symbol('x')],
      [{ entry_date: undefined }, { entry_date: NaN }, { entry_date: {} }, { entry_date: [] }],
      [{}, { entry_date: '2026-13-40' }],
    ];
    for (const input of hostileInputs) {
      assert.doesNotThrow(() => historyFrom(input));
    }
  });
});

// ===========================================================================
// calendarFrom(entries, today) (Step D.6b follow-up, CONTRACT-D.6b.md §2.1/
// §2.5, revised after the first full-suite run) — the calendar's actual
// `from`. A trackable with zero or very recent entries must still be able to
// navigate back roughly 3 months, exactly as it could before D.6b's
// "whole-history load" changed historyFrom() to reach all the way back to
// the earliest entry (which, for a near-empty trackable, could be "no
// entries at all" -> no back-navigation whatsoever without this floor).
// calendarFrom is the earlier of historyFrom(entries) and a floor of
// CALENDAR_FLOOR_DAYS (90) days back from `today`; never null.
// ===========================================================================

describe('CALENDAR_FLOOR_DAYS (contract §2.1)', () => {
  it('equals 90', () => {
    assert.equal(CALENDAR_FLOOR_DAYS, 90);
  });
});

describe('calendarFrom(entries, today) — Step D.6b follow-up (contract §2.1/§2.5)', () => {
  // Fixed 'today' so the floor is a hardcodable, independently-verified
  // value rather than a moving target — recomputed via the REAL
  // addDays(today, -89) before being hardcoded here (2026-09-04 -> 89 days
  // back is 2026-06-07), and also cross-checked against
  // addDays(TODAY, -(CALENDAR_FLOOR_DAYS - 1)) inline below rather than
  // trusted from memory.
  const TODAY = '2026-09-04';
  const FLOOR = '2026-06-07';

  it('the floor is addDays(today, -89), independently recomputed via the real js/dates.js', () => {
    assert.equal(addDays(TODAY, -89), FLOOR);
    assert.equal(addDays(TODAY, -(CALENDAR_FLOOR_DAYS - 1)), FLOOR);
  });

  it('an empty array returns the floor', () => {
    assert.equal(calendarFrom([], TODAY), FLOOR);
  });

  it('null returns the floor', () => {
    assert.equal(calendarFrom(null, TODAY), FLOOR);
  });

  it('undefined returns the floor', () => {
    assert.equal(calendarFrom(undefined, TODAY), FLOOR);
  });

  const nonArrayInputs = ['nope', 42, {}, true];
  for (const v of nonArrayInputs) {
    it(`non-array input ${JSON.stringify(v)} returns the floor`, () => {
      assert.equal(calendarFrom(v, TODAY), FLOOR);
    });
  }

  it('an earliest entry BEFORE the floor returns that entry\'s date, not the floor', () => {
    const entries = [{ entry_date: '2024-03-01' }, { entry_date: '2025-01-01' }];
    assert.equal(calendarFrom(entries, TODAY), '2024-03-01');
  });

  it('an earliest entry AFTER the floor returns the floor, not the entry date', () => {
    const entries = [{ entry_date: '2026-08-01' }, { entry_date: '2026-08-15' }];
    assert.equal(calendarFrom(entries, TODAY), FLOOR);
  });

  it('an entry exactly ON the floor date returns the floor', () => {
    const entries = [{ entry_date: FLOOR }];
    assert.equal(calendarFrom(entries, TODAY), FLOOR);
  });

  it('malformed rows are ignored the same way historyFrom ignores them (mixed with a well-formed row before the floor)', () => {
    const entries = [
      null,
      42,
      'nope',
      {},
      { entry_date: 123 },
      { entry_date: '2026-1-1' },
      { entry_date: '' },
      { entry_date: '2020-12-01' },
    ];
    assert.equal(calendarFrom(entries, TODAY), '2020-12-01');
  });

  it('malformed rows only (nothing well-formed) falls back to the floor, not null', () => {
    const entries = [null, 42, 'nope', {}, { entry_date: 123 }, { entry_date: '2026-1-1' }];
    assert.equal(calendarFrom(entries, TODAY), FLOOR);
  });

  it('never throws over a hostile-input sweep for entries, and the result is never null', () => {
    const hostileEntries = [
      null,
      undefined,
      [],
      'not-an-array',
      123,
      {},
      [null, undefined, 42, 'x', {}, [], true, Symbol('x')],
      [{ entry_date: undefined }, { entry_date: NaN }, { entry_date: {} }, { entry_date: [] }],
      [{}, { entry_date: '2026-13-40' }],
    ];
    for (const input of hostileEntries) {
      let result;
      assert.doesNotThrow(() => {
        result = calendarFrom(input, TODAY);
      });
      assert.notEqual(result, null, `calendarFrom must never return null for ${JSON.stringify(input)}`);
    }
  });
});
