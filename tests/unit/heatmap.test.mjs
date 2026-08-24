// Unit tests for the PURE exports of js/charts/heatmap.js (BUILD_PLAN Step
// 3.1, "Calendar heatmap") — MIN_ALPHA, rangeMaxValue, monthOf, shiftMonth,
// monthLabel, monthBoundsFor, clampMonth, heatmapModel. No DOM. Written
// strictly against CONTRACT-3.1.md §2 and §5.1 (cases U1-U13); the
// implementation is being written in parallel by another agent from the
// same contract and has NOT been read while writing this file.
//
// Fixtures are re-derived from the REAL js/dates.js (monthGrid, parseLocal)
// rather than trusted from the contract's own cross-check table — per the
// contract's instruction, a wrong hardcoded fixture becomes a wrong test
// that the implementation is then "fixed" to satisfy, which has happened
// three times in this project already.
//
// verdict/statusWord/formatValue/hasEntryValue are imported directly from
// js/views/home-model.js (the same pre-existing, already-tested module
// heatmap.js is contractually required to import from) so U8 in particular
// is a genuine regression guard against a second, parallel verdict
// implementation creeping into heatmap.js — see CONTRACT-3.1.md §0(a).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_ALPHA,
  rangeMaxValue,
  monthOf,
  shiftMonth,
  monthLabel,
  monthBoundsFor,
  clampMonth,
  heatmapModel,
} from '../../js/charts/heatmap.js';
import { monthGrid, parseLocal } from '../../js/dates.js';
import { verdict, statusWord, formatValue, hasEntryValue } from '../../js/views/home-model.js';

// ===========================================================================
// MIN_ALPHA
// ===========================================================================

describe('MIN_ALPHA', () => {
  it('is exactly 0.25', () => {
    assert.equal(MIN_ALPHA, 0.25);
  });
});

// ===========================================================================
// U1 — rangeMaxValue (contract §2.2)
// ===========================================================================

describe('U1 — rangeMaxValue', () => {
  it('largest Math.abs(value) among finite-value entries', () => {
    assert.equal(rangeMaxValue([{ value: 3 }, { value: -9 }, { value: 1 }]), 9);
  });

  it('empty array -> 0', () => {
    assert.equal(rangeMaxValue([]), 0);
  });

  it('no valid finite values anywhere -> 0', () => {
    assert.equal(
      rangeMaxValue([{ value: null }, { value: 'x' }, { value: NaN }, { value: Infinity }, null, undefined]),
      0
    );
  });

  it('a non-array argument -> 0', () => {
    assert.equal(rangeMaxValue('nope'), 0);
  });

  it('a single zero-value entry -> 0', () => {
    assert.equal(rangeMaxValue([{ value: 0 }]), 0);
  });

  it('never throws across a hostile cross-product of top-level inputs', () => {
    const hostile = [null, undefined, '', 0, {}, [], 'str', [null], [{}]];
    for (const x of hostile) {
      let result;
      assert.doesNotThrow(() => {
        result = rangeMaxValue(x);
      }, `threw for ${JSON.stringify(x)}`);
      assert.equal(typeof result, 'number', `non-number result for ${JSON.stringify(x)}`);
      assert.ok(!Number.isNaN(result), `NaN result for ${JSON.stringify(x)}`);
    }
  });
});

// ===========================================================================
// U2 — monthOf / shiftMonth / monthLabel (contract §2.3-§2.5)
// ===========================================================================

describe('U2 — monthOf', () => {
  it("monthOf('2026-08-23') === '2026-08'", () => {
    assert.equal(monthOf('2026-08-23'), '2026-08');
  });

  for (const bad of ['2026-8-3', null, 20260823]) {
    it(`monthOf(${JSON.stringify(bad)}) throws RangeError`, () => {
      assert.throws(() => monthOf(bad), RangeError);
    });
  }
});

describe('U2 — shiftMonth', () => {
  const cases = [
    ['2026-08', 1, '2026-09'],
    ['2026-12', 1, '2027-01'],
    ['2026-01', -1, '2025-12'],
    ['2026-08', 0, '2026-08'],
    ['2026-08', -20, '2024-12'],
    ['2026-08', 17, '2028-01'],
  ];
  for (const [m, d, expected] of cases) {
    it(`shiftMonth('${m}', ${d}) === '${expected}'`, () => {
      assert.equal(shiftMonth(m, d), expected);
    });
  }

  const badCases = [
    ['2026-13', 1],
    ['2026-00', 1],
    ['202608', 1],
    ['2026-08', 1.5],
  ];
  for (const [m, d] of badCases) {
    it(`shiftMonth(${JSON.stringify(m)}, ${JSON.stringify(d)}) throws RangeError`, () => {
      assert.throws(() => shiftMonth(m, d), RangeError);
    });
  }

  it('round-trip property: shiftMonth(shiftMonth("2026-08", d), -d) === "2026-08" for d in -30..30', () => {
    for (let d = -30; d <= 30; d++) {
      assert.equal(shiftMonth(shiftMonth('2026-08', d), -d), '2026-08', `failed for d=${d}`);
    }
  });
});

describe('U2 — monthLabel', () => {
  const cases = [
    ['2026-08', 'August 2026'],
    ['2025-12', 'December 2025'],
    ['2026-01', 'January 2026'],
  ];
  for (const [m, expected] of cases) {
    it(`monthLabel('${m}') === '${expected}'`, () => {
      assert.equal(monthLabel(m), expected);
    });
  }

  // Same validation/throw as shiftMonth's monthStr argument (contract §2.5).
  const bad = ['2026-13', '2026-00', '202608', null, undefined, 123, '2026-8', {}];
  for (const m of bad) {
    it(`monthLabel(${JSON.stringify(m)}) throws RangeError`, () => {
      assert.throws(() => monthLabel(m), RangeError);
    });
  }

  it('every month name is correct and never routed through Intl/toLocaleString (deterministic across hosts)', () => {
    const names = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    for (let i = 0; i < 12; i++) {
      assert.equal(monthLabel(`2026-${String(i + 1).padStart(2, '0')}`), `${names[i]} 2026`);
    }
  });
});

// ===========================================================================
// U3 — monthBoundsFor (contract §2.6)
// ===========================================================================

describe('U3 — monthBoundsFor', () => {
  it('fixture 1: from is a well-formed date string', () => {
    assert.deepEqual(
      monthBoundsFor({ from: '2026-05-27', today: '2026-08-23', entries: [] }),
      { min: '2026-05', max: '2026-08' }
    );
  });

  it("fixture 2: from is null ('all' range) — min is the earliest entry_date's month", () => {
    assert.deepEqual(
      monthBoundsFor({
        from: null,
        today: '2026-08-23',
        entries: [
          { entry_date: '2026-02-09', value: 1 },
          { entry_date: '2026-07-01', value: 1 },
        ],
      }),
      { min: '2026-02', max: '2026-08' }
    );
  });

  it('fixture 3: from null, no entries -> min === max', () => {
    assert.deepEqual(
      monthBoundsFor({ from: null, today: '2026-08-23', entries: [] }),
      { min: '2026-08', max: '2026-08' }
    );
  });

  it('fixture 4: from later than today -> min clamps down to max', () => {
    assert.deepEqual(
      monthBoundsFor({ from: '2027-01-01', today: '2026-08-23', entries: [] }),
      { min: '2026-08', max: '2026-08' }
    );
  });

  it('min never exceeds max, across a spread of inputs', () => {
    const cases = [
      { from: '2026-05-27', today: '2026-08-23', entries: [] },
      { from: null, today: '2026-08-23', entries: [{ entry_date: '2020-01-01', value: 1 }] },
      { from: '2030-01-01', today: '2026-08-23', entries: [] },
      { from: null, today: '2000-01-01', entries: [] },
      { from: 'not-a-date', today: '2026-08-23', entries: [{ entry_date: 'also-not-a-date' }] },
      { from: null, today: '2026-01-01', entries: [{ entry_date: '2099-01-01', value: 1 }] },
    ];
    for (const input of cases) {
      const b = monthBoundsFor(input);
      assert.ok(b.min <= b.max, `min ${b.min} > max ${b.max} for ${JSON.stringify(input)}`);
    }
  });

  it('throws RangeError on a malformed today', () => {
    for (const bad of [null, undefined, '', 'bad', 20260823, '2026-13-01', {}, []]) {
      assert.throws(
        () => monthBoundsFor({ from: null, today: bad, entries: [] }),
        RangeError,
        `expected throw for today=${JSON.stringify(bad)}`
      );
    }
  });

  it('tolerates a non-array entries without throwing, treating it as []', () => {
    for (const bad of [null, undefined, 'x', {}, 42]) {
      let result;
      assert.doesNotThrow(() => {
        result = monthBoundsFor({ from: null, today: '2026-08-23', entries: bad });
      }, `threw for entries=${JSON.stringify(bad)}`);
      assert.deepEqual(result, { min: '2026-08', max: '2026-08' });
    }
  });
});

// ===========================================================================
// U4 — clampMonth (contract §2.7)
// ===========================================================================

describe('U4 — clampMonth', () => {
  const bounds = { min: '2026-06', max: '2026-08' };
  const cases = [
    ['2026-05', '2026-06'],
    ['2026-09', '2026-08'],
    ['2026-07', '2026-07'],
    ['2026-06', '2026-06'],
    ['2026-08', '2026-08'],
    [null, '2026-08'],
    ['', '2026-08'],
    ['garbage', '2026-08'],
    ['2026-13', '2026-08'],
    [42, '2026-08'],
  ];
  for (const [input, expected] of cases) {
    it(`clampMonth(${JSON.stringify(input)}, bounds) === '${expected}'`, () => {
      assert.equal(clampMonth(input, bounds), expected);
    });
  }

  it('never throws for 12+ hostile monthStr values', () => {
    const hostile = [
      null, undefined, '', 'garbage', '2026-13', '2026', 42, {}, [], true, NaN, '2026-08-01', Symbol('x'),
    ];
    assert.ok(hostile.length >= 12);
    for (const h of hostile) {
      let result;
      assert.doesNotThrow(() => {
        result = clampMonth(h, bounds);
      }, `threw for ${String(h)}`);
      assert.equal(typeof result, 'string');
    }
  });
});

// ===========================================================================
// U5 — the grid is always 42 cells, in monthGrid order (re-derived, not a
// hardcoded table)
// ===========================================================================

describe('U5 — 42-cell grid matches the real monthGrid exactly', () => {
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  // Search for a month whose 1st falls on a Monday using the REAL monthGrid,
  // rather than trusting any hand-picked example — the contract explicitly
  // labels its own August-2026 cross-check table as non-authoritative.
  function findMondayFirstMonth() {
    for (let y = 2020; y <= 2035; y++) {
      for (let m = 1; m <= 12; m++) {
        const grid = monthGrid(y, m);
        if (grid[0].date === `${y}-${pad2(m)}-01`) {
          return { year: y, month: m };
        }
      }
    }
    throw new Error('no Monday-first month found in the searched range');
  }

  const monday = findMondayFirstMonth();

  const months = [
    { year: 2026, month: 8 }, // the contract's own worked example
    { year: 2026, month: 2 }, // 28-day February
    { year: 2024, month: 2 }, // leap-year February, 29 days
    { year: 2026, month: 1 },
    { year: 2026, month: 12 },
    monday, // 1st is a Monday
  ];

  for (const { year, month } of months) {
    const monthStr = `${year}-${pad2(month)}`;
    it(`${monthStr}: 42 cells, date/inMonth/day all matching the real monthGrid`, () => {
      const expectedGrid = monthGrid(year, month);
      assert.equal(expectedGrid.length, 42);

      // today = the 1st of the target month, so monthBoundsFor's clamp is a
      // no-op (bounds collapse to exactly this month) and `month` passes
      // through unchanged — isolating this test from clamping behaviour,
      // which U12 covers separately.
      const today = `${monthStr}-01`;
      const model = heatmapModel({ trackable: null, entries: [], month: monthStr, today, from: null });

      assert.equal(model.month, monthStr);
      assert.equal(model.cells.length, 42);
      for (let i = 0; i < 42; i++) {
        assert.equal(model.cells[i].date, expectedGrid[i].date, `cell ${i} date mismatch`);
        assert.equal(model.cells[i].inMonth, expectedGrid[i].inMonth, `cell ${i} inMonth mismatch`);
        const expectedDay = parseLocal(expectedGrid[i].date).getDate();
        assert.equal(model.cells[i].day, expectedDay, `cell ${i} day mismatch`);
      }
    });
  }
});

// ===========================================================================
// U6 — state precedence and the forced-neutral rule
// ===========================================================================

describe('U6 — state precedence and the forced-neutral rule', () => {
  it('all four states appear in one grid; every non-day cell is forced hasEntry:false/value:null/verdict:neutral/alpha:0/tappable:false, even when an entry exists for that date', () => {
    // direction:'break' matters here: if the forcing were NOT real, an
    // unlogged day would read 'good' and a logged day 'bad' — seeding
    // entries on the before/future dates below and still expecting
    // 'neutral' is what proves the forcing actually happens.
    const trackable = { id: 5, value_shape: 'boolean', direction: 'break' };
    const month = '2026-08';
    const today = '2026-08-15';
    const from = '2026-08-05';

    const entries = [
      { trackable_id: 5, entry_date: '2026-08-20', value: 1 }, // future date, entry exists
      { trackable_id: 5, entry_date: '2026-08-02', value: 1 }, // before date, entry exists
    ];

    const model = heatmapModel({ trackable, entries, month, today, from });

    const states = new Set(model.cells.map((c) => c.state));
    assert.ok(states.has('outside'), 'expected an outside cell');
    assert.ok(states.has('future'), 'expected a future cell');
    assert.ok(states.has('before'), 'expected a before cell');
    assert.ok(states.has('day'), 'expected a day cell');

    for (const cell of model.cells) {
      if (cell.state !== 'day') {
        assert.equal(cell.hasEntry, false, `${cell.date} (${cell.state}) hasEntry`);
        assert.equal(cell.value, null, `${cell.date} (${cell.state}) value`);
        assert.equal(cell.verdict, 'neutral', `${cell.date} (${cell.state}) verdict`);
        assert.equal(cell.alpha, 0, `${cell.date} (${cell.state}) alpha`);
        assert.equal(cell.tappable, false, `${cell.date} (${cell.state}) tappable`);
      }
    }

    const futureCell = model.cells.find((c) => c.date === '2026-08-20');
    assert.equal(futureCell.state, 'future');
    assert.equal(futureCell.verdict, 'neutral');
    assert.equal(futureCell.hasEntry, false);

    const beforeCell = model.cells.find((c) => c.date === '2026-08-02');
    assert.equal(beforeCell.state, 'before');
    assert.equal(beforeCell.verdict, 'neutral');
    assert.equal(beforeCell.hasEntry, false);
  });
});

// ===========================================================================
// U7 — THE HIGHEST-VALUE CASE: a break boolean never claims a clean day it
// has no data for
// ===========================================================================

describe('U7 — a break-direction boolean never claims a clean day it has no data for', () => {
  it('before/future -> neutral; in-window unlogged -> good; in-window logged -> bad', () => {
    const trackable = { id: 5, value_shape: 'boolean', direction: 'break' };
    const today = '2026-08-23';
    const from = '2026-08-10';
    const month = '2026-08';
    const entries = [{ trackable_id: 5, entry_date: '2026-08-12', value: 1 }];

    const model = heatmapModel({ trackable, entries, month, today, from });
    const byDate = (d) => model.cells.find((c) => c.date === d);

    assert.equal(byDate('2026-08-05').state, 'before');
    assert.equal(byDate('2026-08-05').verdict, 'neutral');

    assert.equal(byDate('2026-08-25').state, 'future');
    assert.equal(byDate('2026-08-25').verdict, 'neutral');

    assert.equal(byDate('2026-08-11').state, 'day');
    assert.equal(byDate('2026-08-11').verdict, 'good');

    assert.equal(byDate('2026-08-12').state, 'day');
    assert.equal(byDate('2026-08-12').verdict, 'bad');
  });
});

// ===========================================================================
// U8 — verdict is delegated, not reimplemented (regression guard for §0(a))
// ===========================================================================

describe('U8 — cell.verdict === verdict(trackable, entry), delegated from the real js/views/home-model.js', () => {
  const targetDate = '2026-08-12';
  const month = '2026-08';
  const today = '2026-08-23'; // in-window, no 'from' -> only outside/future/day possible, isolating this from U6/U7's state logic

  const trackables = [
    null,
    { id: 8, value_shape: 'weird' },
    { id: 1, value_shape: 'boolean', direction: 'build' },
    { id: 2, value_shape: 'boolean', direction: 'break' },
    { id: 3, value_shape: 'numeric', direction: 'build', bounds_enabled: false },
    { id: 4, value_shape: 'numeric', direction: 'break', bounds_enabled: false },
    {
      id: 5, value_shape: 'numeric', direction: 'build',
      bounds_enabled: true, bounds_mode: 'manual', bound_lower: 10, bound_upper: 20,
    },
    {
      id: 6, value_shape: 'numeric', direction: 'break',
      bounds_enabled: true, bounds_mode: 'manual', bound_lower: 10, bound_upper: 20,
    },
    {
      id: 7, value_shape: 'numeric', direction: 'build',
      bounds_enabled: true, bounds_mode: 'auto', bound_lower: 10, bound_upper: 20,
    },
  ];

  const entryOptions = [null, { value: 1 }, { value: 0 }, { value: 15 }, { value: 25 }, { value: -5 }];

  let n = 0;
  for (const trackable of trackables) {
    for (const entryOpt of entryOptions) {
      n += 1;
      it(`combo #${n}: trackable=${JSON.stringify(trackable)} entry=${JSON.stringify(entryOpt)}`, () => {
        const trackableId = trackable && trackable.id;
        const entries = entryOpt
          ? [{ trackable_id: trackableId, entry_date: targetDate, value: entryOpt.value }]
          : [];
        const model = heatmapModel({ trackable, entries, month, today, from: null });
        const cell = model.cells.find((c) => c.date === targetDate);
        const expectedEntry = entryOpt
          ? { trackable_id: trackableId, entry_date: targetDate, value: entryOpt.value }
          : null;
        assert.equal(cell.verdict, verdict(trackable, expectedEntry));
      });
    }
  }
});

// ===========================================================================
// §2.0 — hasEntryValue delegation (bonus, closely related to U8's guard)
// ===========================================================================

describe('§2.0 — cell.hasEntry matches the real hasEntryValue: boolean 0 is not logged, numeric 0 is', () => {
  it('boolean value 0 -> hasEntry false; numeric value 0 -> hasEntry true', () => {
    const boolT = { id: 1, value_shape: 'boolean', direction: 'build' };
    const numT = { id: 2, value_shape: 'numeric', unit: 'kg' };
    const target = '2026-08-12';
    const month = '2026-08';
    const today = '2026-08-23';

    const boolModel = heatmapModel({
      trackable: boolT,
      entries: [{ trackable_id: 1, entry_date: target, value: 0 }],
      month, today, from: null,
    });
    const boolCell = boolModel.cells.find((c) => c.date === target);
    assert.equal(boolCell.hasEntry, hasEntryValue(boolT, { entry_date: target, value: 0 }));
    assert.equal(boolCell.hasEntry, false);

    const numModel = heatmapModel({
      trackable: numT,
      entries: [{ trackable_id: 2, entry_date: target, value: 0 }],
      month, today, from: null,
    });
    const numCell = numModel.cells.find((c) => c.date === target);
    assert.equal(numCell.hasEntry, hasEntryValue(numT, { entry_date: target, value: 0 }));
    assert.equal(numCell.hasEntry, true);
  });
});

// ===========================================================================
// U9 — alpha
// ===========================================================================

describe('U9 — alpha', () => {
  const NUM_T = { id: 9, value_shape: 'numeric', direction: 'build', unit: 'kcal', bounds_enabled: false };
  const targetDate = '2026-08-12';
  const month = '2026-08';
  const today = '2026-08-23';

  // An "anchor" entry on an unrelated date pins rangeMaxValue(entries) at
  // exactly 100 regardless of the target day's own value, AS LONG AS the
  // target day's value does not itself exceed 100 (see the dedicated note
  // below on why the contract's "value 200" line cannot be reproduced this
  // way). The anchor's own date is irrelevant to rangeMaxValue, which scans
  // the whole entries array regardless of grid membership (contract §2.2).
  const anchor = { trackable_id: 9, entry_date: '1999-01-01', value: 100 };

  function alphaFor(value) {
    const entries = [anchor, { trackable_id: 9, entry_date: targetDate, value }];
    const model = heatmapModel({ trackable: NUM_T, entries, month, today, from: null });
    assert.equal(model.rangeMax, 100, 'anchor invariant broken: rangeMax should stay pinned at 100');
    const cell = model.cells.find((c) => c.date === targetDate);
    return cell.alpha;
  }

  it('value 100, rangeMax 100 -> alpha 1', () => {
    assert.equal(alphaFor(100), 1);
  });
  it('value 50, rangeMax 100 -> alpha 0.625', () => {
    assert.equal(alphaFor(50), 0.625);
  });
  it('value 1, rangeMax 100 -> alpha 0.258', () => {
    assert.equal(alphaFor(1), 0.258);
  });
  it('value -50, rangeMax 100 -> alpha 0.625 (magnitude, not sign)', () => {
    assert.equal(alphaFor(-50), 0.625);
  });

  // NOTE on the contract's fifth alpha fixture ("value 200 -> 1 (clamped)",
  // §2.8.4, with the stated context "rangeMax = 100"): this combination
  // cannot be constructed through a single self-consistent heatmapModel
  // call. rangeMax is defined as rangeMaxValue(entries) computed over the
  // SAME `entries` array that must contain this cell's own value for
  // hasEntry/alpha to apply at all (a cell's value can only come from an
  // entry that is actually in `entries`). Since rangeMaxValue is exactly
  // the max abs value across that array, rangeMax is therefore always >=
  // abs(value) for any rendered day cell — the ratio inside the alpha
  // formula can never exceed 1 in practice; the contract's own worked
  // premise (value=200 while rangeMax=100) is unreachable via the public
  // heatmapModel API. This was flagged rather than guessed at — see the
  // final report. What IS tested below is the same underlying property the
  // fixture was presumably trying to protect: the min(1, ...) clamp holds
  // even when a cell's value equals (and therefore defines) rangeMax, and a
  // broad fuzz (further below) proves alpha never exceeds 1 for any input.
  it('value 200 with NO anchor (so rangeMax is genuinely set BY this value, i.e. rangeMax===200, not the unreachable 100) -> alpha still clamps to exactly 1', () => {
    const entries = [{ trackable_id: 9, entry_date: targetDate, value: 200 }];
    const model = heatmapModel({ trackable: NUM_T, entries, month, today, from: null });
    assert.equal(model.rangeMax, 200);
    const cell = model.cells.find((c) => c.date === targetDate);
    assert.equal(cell.alpha, 1);
  });

  const BOOL_T = { id: 10, value_shape: 'boolean', direction: 'build' };

  it('boolean, logged -> alpha always 1', () => {
    const model = heatmapModel({
      trackable: BOOL_T,
      entries: [{ trackable_id: 10, entry_date: targetDate, value: 1 }],
      month, today, from: null,
    });
    assert.equal(model.cells.find((c) => c.date === targetDate).alpha, 1);
  });

  it('boolean, not logged -> alpha always 0', () => {
    const model = heatmapModel({ trackable: BOOL_T, entries: [], month, today, from: null });
    assert.equal(model.cells.find((c) => c.date === targetDate).alpha, 0);
  });

  it('rangeMax === 0 (degenerate guard, same class as normalizeSeries min===max): a logged numeric day still gets alpha 1', () => {
    const entries = [{ trackable_id: 9, entry_date: targetDate, value: 0 }];
    const model = heatmapModel({ trackable: NUM_T, entries, month, today, from: null });
    assert.equal(model.rangeMax, 0);
    const cell = model.cells.find((c) => c.date === targetDate);
    assert.equal(cell.hasEntry, true);
    assert.equal(cell.alpha, 1);
  });

  it('alpha is always in [0, 1] and never NaN, across a fuzz of values including 0, negatives, 1e9, and non-numbers', () => {
    const values = [0, -1, -100, 1e9, -1e9, 0.0001, -0.0001, NaN, Infinity, -Infinity, 'x', null, undefined, {}, []];
    for (const v of values) {
      const entries = [{ trackable_id: 9, entry_date: targetDate, value: v }];
      const model = heatmapModel({ trackable: NUM_T, entries, month, today, from: null });
      for (const cell of model.cells) {
        assert.ok(!Number.isNaN(cell.alpha), `alpha NaN for value ${JSON.stringify(v)} on cell ${cell.date}`);
        assert.ok(cell.alpha >= 0 && cell.alpha <= 1, `alpha out of [0,1] for value ${JSON.stringify(v)}: ${cell.alpha}`);
      }
    }
  });
});

// ===========================================================================
// U10 — label
// ===========================================================================

describe('U10 — label (§2.8.6 fixtures, verbatim, all on 2026-08-12)', () => {
  const month = '2026-08';
  const today = '2026-08-23';
  const target = '2026-08-12';

  const T_BOOL_BUILD = { id: 1, value_shape: 'boolean', direction: 'build' };
  const T_BOOL_BREAK = { id: 2, value_shape: 'boolean', direction: 'break' };
  const T_NUM_NOBOUNDS = { id: 3, value_shape: 'numeric', unit: 'kcal', bounds_enabled: false };
  const T_NUM_BOUNDS = {
    id: 4, value_shape: 'numeric', unit: 'kcal',
    bounds_enabled: true, bounds_mode: 'manual', bound_lower: 1600, bound_upper: 2200,
  };

  function cellFor(trackable, entry) {
    const entries = entry ? [{ trackable_id: trackable.id, entry_date: target, value: entry.value }] : [];
    const model = heatmapModel({ trackable, entries, month, today, from: null });
    return model.cells.find((c) => c.date === target);
  }

  it('boolean build, logged -> "12 August 2026 — Done"', () => {
    assert.equal(cellFor(T_BOOL_BUILD, { value: 1 }).label, '12 August 2026 — Done');
  });
  it('boolean build, no entry -> "12 August 2026 — Not yet"', () => {
    assert.equal(cellFor(T_BOOL_BUILD, null).label, '12 August 2026 — Not yet');
  });
  it('boolean break, logged -> "12 August 2026 — Logged"', () => {
    assert.equal(cellFor(T_BOOL_BREAK, { value: 1 }).label, '12 August 2026 — Logged');
  });
  it('boolean break, no entry -> "12 August 2026 — Clean"', () => {
    assert.equal(cellFor(T_BOOL_BREAK, null).label, '12 August 2026 — Clean');
  });
  it('numeric, unit kcal, no bounds, logged -> "12 August 2026 — 1850 kcal"', () => {
    assert.equal(cellFor(T_NUM_NOBOUNDS, { value: 1850 }).label, '12 August 2026 — 1850 kcal');
  });
  it('numeric, manual bounds 1600-2200, in range -> "...— 1850 kcal, In range"', () => {
    assert.equal(cellFor(T_NUM_BOUNDS, { value: 1850 }).label, '12 August 2026 — 1850 kcal, In range');
  });
  it('numeric, manual bounds 1600-2200, out of range -> "...— 2500 kcal, Out of range"', () => {
    assert.equal(cellFor(T_NUM_BOUNDS, { value: 2500 }).label, '12 August 2026 — 2500 kcal, Out of range');
  });
  it('numeric, unit kcal, no entry -> "12 August 2026 — not logged"', () => {
    assert.equal(cellFor(T_NUM_NOBOUNDS, null).label, '12 August 2026 — not logged');
  });

  it('boolean labels also match statusWord() algorithmically (independent cross-check, not just literal strings)', () => {
    for (const [trackable, entry] of [
      [T_BOOL_BUILD, { value: 1 }], [T_BOOL_BUILD, null],
      [T_BOOL_BREAK, { value: 1 }], [T_BOOL_BREAK, null],
    ]) {
      const cell = cellFor(trackable, entry);
      assert.equal(cell.label, `12 August 2026 — ${statusWord(trackable, entry || null)}`);
    }
  });

  it('numeric labels also match formatValue()/statusWord() algorithmically', () => {
    const cell = cellFor(T_NUM_BOUNDS, { value: 1850 });
    const expected = `12 August 2026 — ${formatValue(T_NUM_BOUNDS, 1850)}, ${statusWord(T_NUM_BOUNDS, { value: 1850 })}`;
    assert.equal(cell.label, expected);
  });

  it('outside cell label is the empty string', () => {
    const model = heatmapModel({ trackable: T_BOOL_BUILD, entries: [], month, today, from: null });
    const outsideCell = model.cells.find((c) => !c.inMonth);
    assert.ok(outsideCell, 'expected at least one outside cell in the August 2026 grid');
    assert.equal(outsideCell.label, '');
  });

  it('future cell label is "<base> — future"', () => {
    const model = heatmapModel({ trackable: T_BOOL_BUILD, entries: [], month, today: '2026-08-15', from: null });
    const futureCell = model.cells.find((c) => c.date === '2026-08-20');
    assert.equal(futureCell.state, 'future');
    assert.equal(futureCell.label, '20 August 2026 — future');
  });

  it('before cell label is "<base> — no data"', () => {
    const model = heatmapModel({ trackable: T_BOOL_BUILD, entries: [], month, today, from: '2026-08-10' });
    const beforeCell = model.cells.find((c) => c.date === '2026-08-05');
    assert.equal(beforeCell.state, 'before');
    assert.equal(beforeCell.label, '5 August 2026 — no data');
  });

  it('no label ever contains "undefined", "null" or "NaN", across a spread of hostile and valid models', () => {
    const models = [
      heatmapModel({ trackable: T_BOOL_BUILD, entries: [], month, today, from: null }),
      heatmapModel({
        trackable: T_BOOL_BREAK,
        entries: [{ trackable_id: 2, entry_date: target, value: 1 }],
        month, today: '2026-08-15', from: '2026-08-05',
      }),
      heatmapModel({
        trackable: T_NUM_BOUNDS,
        entries: [{ trackable_id: 4, entry_date: target, value: 2500 }],
        month, today, from: null,
      }),
      heatmapModel({ trackable: null, entries: [], month, today, from: null }),
      heatmapModel({ trackable: {}, entries: [null, {}], month: 'garbage', today, from: 'nope' }),
    ];
    for (const model of models) {
      for (const cell of model.cells) {
        assert.ok(!cell.label.includes('undefined'), `label contained 'undefined': "${cell.label}"`);
        assert.ok(!cell.label.includes('null'), `label contained 'null': "${cell.label}"`);
        assert.ok(!cell.label.includes('NaN'), `label contained 'NaN': "${cell.label}"`);
      }
    }
  });
});

// ===========================================================================
// U11 — totality
// ===========================================================================

describe('U11 — heatmapModel never throws (except for malformed today) and always returns 42 well-formed cells', () => {
  const trackables = [
    null,
    {},
    { value_shape: 'weird' },
    { id: 1, value_shape: 'boolean', direction: 'build' },
    {
      id: 2, value_shape: 'numeric', direction: 'break', unit: 'kg',
      bounds_enabled: true, bounds_mode: 'manual', bound_lower: 1, bound_upper: 2,
    },
  ];
  const entriesOptions = [[], 'x', null, [null], [{}]];
  const months = ['2026-08', 'garbage', null, '2026-13'];
  const froms = [null, '2026-08-10', 'nope'];
  const today = '2026-08-23';

  const validStates = new Set(['outside', 'future', 'before', 'day']);
  const validVerdicts = new Set(['good', 'bad', 'neutral']);

  let count = 0;
  for (const trackable of trackables) {
    for (const entries of entriesOptions) {
      for (const month of months) {
        for (const from of froms) {
          count += 1;
          it(`combo #${count}: trackable=${JSON.stringify(trackable)} entries=${JSON.stringify(entries)} month=${JSON.stringify(month)} from=${JSON.stringify(from)}`, () => {
            let model;
            assert.doesNotThrow(() => {
              model = heatmapModel({ trackable, entries, month, today, from });
            });
            assert.ok(Array.isArray(model.cells));
            assert.equal(model.cells.length, 42);
            for (const cell of model.cells) {
              assert.ok(validStates.has(cell.state), `bad state: ${cell.state}`);
              assert.ok(validVerdicts.has(cell.verdict), `bad verdict: ${cell.verdict}`);
              assert.equal(typeof cell.date, 'string');
              assert.equal(typeof cell.inMonth, 'boolean');
              assert.equal(typeof cell.tappable, 'boolean');
              assert.equal(typeof cell.hasEntry, 'boolean');
              assert.ok(!Number.isNaN(cell.alpha));
              assert.ok(cell.alpha >= 0 && cell.alpha <= 1);
              assert.equal(typeof cell.label, 'string');
              assert.ok(Number.isInteger(cell.day));
            }
            assert.equal(typeof model.month, 'string');
            assert.equal(typeof model.monthLabel, 'string');
            assert.equal(typeof model.canPrev, 'boolean');
            assert.equal(typeof model.canNext, 'boolean');
            assert.ok(Array.isArray(model.weekdayLabels));
            assert.equal(model.weekdayLabels.length, 7);
            assert.ok(['boolean', 'numeric', 'unknown'].includes(model.shape));
            assert.equal(typeof model.rangeMax, 'number');
            assert.equal(typeof model.loggedDayCount, 'number');
          });
        }
      }
    }
  }

  it(`generated ${count} combinations (must be at least 60)`, () => {
    assert.ok(count >= 60, `only generated ${count} combinations`);
  });
});

describe('U11 — a malformed today always throws RangeError', () => {
  const badTodays = [null, undefined, '', 'bad', 20260823, '2026-8-3', '2026-13-01', {}, []];
  for (const today of badTodays) {
    it(`today=${JSON.stringify(today)} throws`, () => {
      assert.throws(
        () => heatmapModel({ trackable: null, entries: [], month: '2026-08', today, from: null }),
        RangeError
      );
    });
  }
});

// ===========================================================================
// U12 — canPrev/canNext and the no-future rule
// ===========================================================================

describe('U12 — canPrev/canNext and the no-future rule', () => {
  it('at month === bounds.max (the current month), canNext is false', () => {
    const model = heatmapModel({ trackable: null, entries: [], month: '2026-08', today: '2026-08-23', from: null });
    assert.equal(model.month, '2026-08');
    assert.equal(model.canNext, false);
  });

  it('stepping forward via shiftMonth + clampMonth repeatedly never yields a month > bounds.max', () => {
    const bounds = monthBoundsFor({ from: null, today: '2026-08-23', entries: [] });
    let month = '2026-08';
    for (let i = 0; i < 5; i++) {
      month = clampMonth(shiftMonth(month, 1), bounds);
      assert.ok(month <= bounds.max, `month ${month} exceeded bounds.max ${bounds.max}`);
    }
    assert.equal(month, bounds.max);
  });

  it('at month === bounds.min, canPrev is false', () => {
    const model = heatmapModel({
      trackable: null, entries: [], month: '2026-05', today: '2026-08-23', from: '2026-05-27',
    });
    assert.equal(model.month, '2026-05');
    assert.equal(model.canPrev, false);
  });

  it('at a month strictly between min and max, both canPrev and canNext are true', () => {
    const model = heatmapModel({
      trackable: null, entries: [], month: '2026-06', today: '2026-08-23', from: '2026-05-27',
    });
    assert.equal(model.canPrev, true);
    assert.equal(model.canNext, true);
  });
});

// ===========================================================================
// U13 — loggedDayCount
// ===========================================================================

describe('U13 — loggedDayCount counts only state:"day" cells with an entry', () => {
  it('entries seeded on outside/future/before dates are not counted; a boolean-0 "day" entry is also not counted', () => {
    const trackable = { id: 1, value_shape: 'boolean', direction: 'build' };
    const month = '2026-08';
    const today = '2026-08-15';
    const from = '2026-08-05';

    const grid = monthGrid(2026, 8);
    const outsideDate = grid.find((c) => !c.inMonth).date;

    const entries = [
      { trackable_id: 1, entry_date: outsideDate, value: 1 }, // outside -> not counted
      { trackable_id: 1, entry_date: '2026-08-20', value: 1 }, // future -> not counted
      { trackable_id: 1, entry_date: '2026-08-02', value: 1 }, // before -> not counted
      { trackable_id: 1, entry_date: '2026-08-06', value: 1 }, // day, logged -> counted
      { trackable_id: 1, entry_date: '2026-08-10', value: 1 }, // day, logged -> counted
      { trackable_id: 1, entry_date: '2026-08-11', value: 0 }, // day, boolean 0 -> NOT logged
    ];

    const model = heatmapModel({ trackable, entries, month, today, from });
    assert.equal(model.loggedDayCount, 2);
  });
});
