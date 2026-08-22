// Contract tests for js/dates.js (BUILD_PLAN Step 1.2) — pure date-math
// helpers, no DOM, no network. Written strictly from the interface
// contract; the implementation is being written in parallel by another
// agent, so every assertion here targets the documented behavior, not any
// particular internal approach.
//
// Timezone-hostile regression coverage (the actual point of this step)
// lives in tests/unit/dates-tz.test.mjs, run via child processes with TZ
// forced to specific zones. This file only asserts behavior that is
// timezone-INDEPENDENT by construction: every "local" Date here is built
// with the (year, month, day, hour, minute) constructor form, so its
// local components are whatever we asked for regardless of the host's
// real offset, and reading them back with local getters must agree.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLocal,
  todayLocal,
  parseLocal,
  addDays,
  isoWeekKey,
  startOfIsoWeek,
  isoWeeksInRange,
  rangeDays,
  monthGrid,
} from '../../js/dates.js';

// ===========================================================================
// formatLocal
// ===========================================================================

describe('formatLocal', () => {
  it('zero-pads single-digit month and day', () => {
    assert.equal(formatLocal(new Date(2026, 0, 5)), '2026-01-05');
  });

  it('zero-pads a single-digit month with a double-digit day', () => {
    assert.equal(formatLocal(new Date(2026, 2, 15)), '2026-03-15');
  });

  it('handles a year boundary (Dec 31 -> Jan 1 are distinct)', () => {
    assert.equal(formatLocal(new Date(2026, 11, 31)), '2026-12-31');
    assert.equal(formatLocal(new Date(2027, 0, 1)), '2027-01-01');
  });

  it('ignores time-of-day, using only local date components', () => {
    assert.equal(formatLocal(new Date(2026, 7, 21, 23, 59, 59, 999)), '2026-08-21');
  });

  it('throws RangeError for a non-Date value', () => {
    assert.throws(() => formatLocal('2026-08-21'), RangeError);
    assert.throws(() => formatLocal(1755820800000), RangeError);
    assert.throws(() => formatLocal({}), RangeError);
    assert.throws(() => formatLocal(null), RangeError);
    assert.throws(() => formatLocal(undefined), RangeError);
  });

  it('throws RangeError for an invalid Date (Invalid Date)', () => {
    assert.throws(() => formatLocal(new Date('nonsense')), RangeError);
  });
});

// ===========================================================================
// todayLocal
// ===========================================================================

describe('todayLocal', () => {
  it('returns the local calendar day of an injected Date at midday', () => {
    assert.equal(todayLocal(new Date(2026, 7, 21, 12, 0)), '2026-08-21');
  });

  it('the 11pm case: 23:30 local must return the SAME local day, not the next day', () => {
    // This is the exact failure mode of `date.toISOString().slice(0,10)`
    // in a positive-offset zone: it would push 23:30 local into the next
    // UTC day.
    assert.equal(todayLocal(new Date(2026, 7, 21, 23, 30)), '2026-08-21');
  });

  it('the 00:30 case: half past midnight local must return that same local day', () => {
    // Symmetric failure mode in a negative-offset zone: UTC slicing would
    // pull 00:30 local back into the previous UTC day.
    assert.equal(todayLocal(new Date(2026, 7, 21, 0, 30)), '2026-08-21');
  });

  it('respects the injected `now` default parameter shape (explicit arg wins)', () => {
    const injected = new Date(2020, 0, 1, 5, 0);
    assert.equal(todayLocal(injected), '2020-01-01');
  });
});

// ===========================================================================
// parseLocal
// ===========================================================================

describe('parseLocal — returns local midnight', () => {
  it('all local time components are exactly zero', () => {
    const d = parseLocal('2026-08-21');
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getSeconds(), 0);
    assert.equal(d.getMilliseconds(), 0);
  });

  it('local Y/M/D round-trip to the input', () => {
    const d = parseLocal('2026-08-21');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 7); // 0-based
    assert.equal(d.getDate(), 21);
  });
});

describe('parseLocal — rejects rollover dates rather than normalizing them', () => {
  const rollovers = ['2026-02-30', '2026-13-01', '2026-00-10', '2026-01-00', '2026-01-32', '2026-02-29'];
  for (const bad of rollovers) {
    it(`'${bad}' throws RangeError (2026 is not a leap year for -02-29)`, () => {
      assert.throws(() => parseLocal(bad), RangeError, bad);
    });
  }

  it("'2024-02-29' succeeds (2024 IS a leap year)", () => {
    const d = parseLocal('2024-02-29');
    assert.equal(d.getFullYear(), 2024);
    assert.equal(d.getMonth(), 1);
    assert.equal(d.getDate(), 29);
  });
});

describe('parseLocal — rejects malformed shapes', () => {
  const malformed = ['2026-1-1', '26-01-01', '2026/01/01', ''];
  for (const bad of malformed) {
    it(`'${bad}' throws RangeError`, () => {
      assert.throws(() => parseLocal(bad), RangeError, bad);
    });
  }

  it('null throws RangeError', () => {
    assert.throws(() => parseLocal(null), RangeError);
  });

  it('undefined throws RangeError', () => {
    assert.throws(() => parseLocal(undefined), RangeError);
  });

  it('a number throws RangeError', () => {
    assert.throws(() => parseLocal(20260821), RangeError);
  });

  it('a Date object throws RangeError (string-only input)', () => {
    assert.throws(() => parseLocal(new Date(2026, 7, 21)), RangeError);
  });
});

describe('parseLocal -> formatLocal round-trip', () => {
  const dates = [
    '2026-01-01',
    '2026-12-31',
    '2024-02-29', // leap day
    '2025-12-31', // year boundary
    '2026-01-01', // year boundary (other side)
    '2000-02-29', // century leap year
    '2026-08-22',
  ];
  for (const s of dates) {
    it(`'${s}' round-trips`, () => {
      assert.equal(formatLocal(parseLocal(s)), s);
    });
  }
});

// ===========================================================================
// addDays
// ===========================================================================

describe('addDays', () => {
  it('+1 across a month boundary', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  });

  it('-1 across a month boundary', () => {
    assert.equal(addDays('2026-02-01', -1), '2026-01-31');
  });

  it('+1 across a year boundary', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });

  it('-1 across a year boundary', () => {
    assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  });

  it('into a leap day', () => {
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  });

  it('out of a leap day', () => {
    assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  });

  it('n = 0 returns the same date', () => {
    assert.equal(addDays('2026-05-15', 0), '2026-05-15');
  });

  it('a large positive n (+400) is correct', () => {
    // 2026-01-01 + 400 days = 2027-02-05 (365 days -> 2027-01-01, +35 more)
    assert.equal(addDays('2026-01-01', 400), '2027-02-05');
  });

  it('a large negative n (-400) is correct', () => {
    assert.equal(addDays('2027-02-05', -400), '2026-01-01');
  });

  it('throws RangeError for a non-integer n', () => {
    assert.throws(() => addDays('2026-01-01', 1.5), RangeError);
  });

  it('throws RangeError for a non-safe-integer n', () => {
    assert.throws(() => addDays('2026-01-01', Number.MAX_SAFE_INTEGER + 10), RangeError);
    assert.throws(() => addDays('2026-01-01', NaN), RangeError);
    assert.throws(() => addDays('2026-01-01', Infinity), RangeError);
  });
});

// ===========================================================================
// isoWeekKey — authoritative fixture table, asserted individually
// ===========================================================================

describe('isoWeekKey — authoritative fixtures', () => {
  const fixtures = [
    ['2026-01-01', '2026-W01'], // Thu
    ['2025-12-28', '2025-W52'], // Sun
    ['2025-12-29', '2026-W01'], // Mon
    ['2025-12-31', '2026-W01'], // Wed
    ['2026-12-31', '2026-W53'], // Thu
    ['2027-01-01', '2026-W53'], // Fri
    ['2027-01-03', '2026-W53'], // Sun
    ['2027-01-04', '2027-W01'], // Mon
    ['2021-01-01', '2020-W53'], // Fri
    ['2021-01-03', '2020-W53'], // Sun
    ['2021-01-04', '2021-W01'], // Mon
    ['2016-01-01', '2015-W53'], // Fri
    ['2024-02-29', '2024-W09'], // Thu, leap day
    ['2026-08-22', '2026-W34'], // Sat
  ];

  for (const [input, expected] of fixtures) {
    it(`isoWeekKey('${input}') === '${expected}'`, () => {
      assert.equal(isoWeekKey(input), expected, `isoWeekKey('${input}') should be '${expected}'`);
    });
  }

  it('accepts a Date and a string for the same day and agrees', () => {
    for (const [input, expected] of fixtures) {
      const d = parseLocal(input);
      assert.equal(isoWeekKey(d), expected, `isoWeekKey(Date for '${input}') should be '${expected}'`);
      assert.equal(isoWeekKey(d), isoWeekKey(input), `Date and string forms disagree for '${input}'`);
    }
  });
});

// ===========================================================================
// startOfIsoWeek
// ===========================================================================

describe('startOfIsoWeek', () => {
  it("'2026-01-01' -> '2025-12-29' (the Monday of ISO week 2026-W01)", () => {
    assert.equal(startOfIsoWeek('2026-01-01'), '2025-12-29');
  });

  it('a Monday returns itself', () => {
    assert.equal(startOfIsoWeek('2025-12-29'), '2025-12-29');
  });

  it('a Sunday returns the Monday six days earlier', () => {
    assert.equal(startOfIsoWeek('2025-12-28'), '2025-12-22');
  });
});

// ===========================================================================
// isoWeeksInRange
// ===========================================================================

describe('isoWeeksInRange', () => {
  it('year-boundary example (verbatim from the contract)', () => {
    assert.deepEqual(
      isoWeeksInRange('2026-12-21', '2027-01-11'),
      ['2026-W52', '2026-W53', '2027-W01', '2027-W02']
    );
  });

  it('a range inside one week returns exactly one key', () => {
    // Monday of 2026-W34 is 2026-08-17 (2026-08-22 is Sat of W34).
    assert.deepEqual(isoWeeksInRange('2026-08-18', '2026-08-20'), ['2026-W34']);
  });

  it('from === to returns exactly one key', () => {
    assert.deepEqual(isoWeeksInRange('2026-08-22', '2026-08-22'), ['2026-W34']);
  });

  it('from > to throws RangeError', () => {
    assert.throws(() => isoWeeksInRange('2026-08-22', '2026-08-21'), RangeError);
  });

  it('a full calendar year of a 53-ISO-week year returns 53 strictly ascending, gap-free keys', () => {
    // 2026-01-01 (Thu) falls in 2026-W01, and 2026-12-31 (Thu) falls in
    // 2026-W53, and the whole span in between stays tagged 2026 because
    // both endpoints are Thursdays (mid-week, no year-label spillover).
    const result = isoWeeksInRange('2026-01-01', '2026-12-31');
    const expected = Array.from({ length: 53 }, (_, i) => `2026-W${String(i + 1).padStart(2, '0')}`);
    assert.deepEqual(result, expected);
    assert.equal(result.length, 53);
    // no duplicates
    assert.equal(new Set(result).size, result.length);
  });
});

// ===========================================================================
// rangeDays
// ===========================================================================

describe('rangeDays', () => {
  it('inclusive of both ends', () => {
    assert.deepEqual(rangeDays('2026-01-01', '2026-01-03'), [
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
    ]);
  });

  it('from === to returns a single element', () => {
    assert.deepEqual(rangeDays('2026-01-01', '2026-01-01'), ['2026-01-01']);
  });

  it('from > to throws RangeError', () => {
    assert.throws(() => rangeDays('2026-01-02', '2026-01-01'), RangeError);
  });

  it('a 31-day month range has exactly 31 entries', () => {
    const result = rangeDays('2026-01-01', '2026-01-31');
    assert.equal(result.length, 31);
  });

  it('strictly ascending with no duplicates', () => {
    const result = rangeDays('2026-01-01', '2026-02-05');
    const sorted = [...result].sort();
    assert.deepEqual(result, sorted);
    assert.equal(new Set(result).size, result.length);
  });
});

// ===========================================================================
// monthGrid — authoritative fixture table
// ===========================================================================

describe('monthGrid — authoritative fixtures', () => {
  const fixtures = [
    { year: 2026, month: 2, firstCell: '2026-01-26', lastCell: '2026-03-08', inMonthCount: 28, firstInMonthIdx: 6 },
    { year: 2026, month: 8, firstCell: '2026-07-27', lastCell: '2026-09-06', inMonthCount: 31, firstInMonthIdx: 5 },
    { year: 2026, month: 3, firstCell: '2026-02-23', lastCell: '2026-04-05', inMonthCount: 31, firstInMonthIdx: 6 },
    { year: 2021, month: 2, firstCell: '2021-02-01', lastCell: '2021-03-14', inMonthCount: 28, firstInMonthIdx: 0 },
  ];

  for (const fx of fixtures) {
    describe(`monthGrid(${fx.year}, ${fx.month})`, () => {
      const grid = monthGrid(fx.year, fx.month);

      it('returns exactly 42 cells', () => {
        assert.equal(grid.length, 42);
      });

      it(`first cell is '${fx.firstCell}'`, () => {
        assert.equal(grid[0].date, fx.firstCell);
      });

      it(`last cell is '${fx.lastCell}'`, () => {
        assert.equal(grid[41].date, fx.lastCell);
      });

      it(`inMonth count is ${fx.inMonthCount}`, () => {
        assert.equal(grid.filter((c) => c.inMonth).length, fx.inMonthCount);
      });

      it(`index of first in-month cell is ${fx.firstInMonthIdx}`, () => {
        assert.equal(grid.findIndex((c) => c.inMonth), fx.firstInMonthIdx);
      });

      it('dow runs 1..7 repeating, first cell dow is 1 (Monday)', () => {
        assert.equal(grid[0].dow, 1);
        for (let i = 0; i < 42; i++) {
          assert.equal(grid[i].dow, (i % 7) + 1, `cell ${i} dow`);
        }
      });

      it('every date is a valid YYYY-MM-DD and dates are consecutive with no gaps', () => {
        for (const cell of grid) {
          assert.match(cell.date, /^\d{4}-\d{2}-\d{2}$/);
        }
        for (let i = 1; i < 42; i++) {
          assert.equal(addDays(grid[i - 1].date, 1), grid[i].date, `gap between cell ${i - 1} and ${i}`);
        }
      });

      it('inMonth:true cells are exactly the days of that month, in order', () => {
        const inMonthDates = grid.filter((c) => c.inMonth).map((c) => c.date);
        const expected = [];
        for (let d = 1; d <= fx.inMonthCount; d++) {
          expected.push(`${fx.year}-${String(fx.month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
        }
        assert.deepEqual(inMonthDates, expected);
      });
    });
  }
});

describe('monthGrid — invalid input', () => {
  it('throws RangeError for month 0', () => {
    assert.throws(() => monthGrid(2026, 0), RangeError);
  });

  it('throws RangeError for month 13', () => {
    assert.throws(() => monthGrid(2026, 13), RangeError);
  });

  it('throws RangeError for a non-integer month', () => {
    assert.throws(() => monthGrid(2026, 2.5), RangeError);
  });

  it('throws RangeError for a non-integer year', () => {
    assert.throws(() => monthGrid(2026.5, 2), RangeError);
  });
});
