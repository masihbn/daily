// Contract tests for js/aggregate.js (BUILD_PLAN Step 1.2) — pure
// rollup/normalization/bound-math functions, no DOM, no network, no
// Supabase. Written strictly from the interface contract; the
// implementation is being written in parallel by another agent.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rollup, fillSeries, normalizeSeries, deriveBounds, applyRelog } from '../../js/aggregate.js';

function entry(trackable_id, entry_date, value, extra = {}) {
  return { trackable_id, entry_date, value, note: null, ...extra };
}

// ===========================================================================
// rollup
// ===========================================================================

describe('rollup — bucketing by period', () => {
  it("period 'week' merges entries from different calendar years into ONE ISO-week bucket", () => {
    // 2025-12-31 and 2026-01-01 are both in ISO week 2026-W01 — the
    // classic New Year week-merge/split bug.
    const entries = [entry(1, '2025-12-31', 10), entry(1, '2026-01-01', 5)];
    const result = rollup(entries, 'week', 'sum');
    assert.equal(result.length, 1, 'must land in exactly one bucket');
    assert.equal(result[0].key, '2026-W01');
    assert.equal(result[0].value, 15);
    assert.equal(result[0].count, 2);
  });

  it("period 'day' keys by YYYY-MM-DD", () => {
    const entries = [entry(1, '2026-03-01', 1), entry(1, '2026-03-02', 2)];
    const result = rollup(entries, 'day', 'sum');
    assert.deepEqual(
      result.map((r) => r.key),
      ['2026-03-01', '2026-03-02']
    );
  });

  it("period 'month' keys by YYYY-MM", () => {
    const entries = [entry(1, '2026-03-01', 1), entry(1, '2026-03-31', 2), entry(1, '2026-04-01', 3)];
    const result = rollup(entries, 'month', 'sum');
    assert.deepEqual(
      result.map((r) => [r.key, r.value]),
      [
        ['2026-03', 3],
        ['2026-04', 3],
      ]
    );
  });

  it('unknown period throws RangeError', () => {
    assert.throws(() => rollup([entry(1, '2026-01-01', 1)], 'fortnight', 'sum'), RangeError);
  });

  it('unknown aggregation throws RangeError', () => {
    assert.throws(() => rollup([entry(1, '2026-01-01', 1)], 'day', 'median'), RangeError);
  });
});

describe('rollup — aggregation semantics', () => {
  it("'count' counts days-with-an-entry, NOT the sum of values", () => {
    const entries = [entry(1, '2026-01-01', 5), entry(1, '2026-01-02', 3)];
    const countResult = rollup(entries, 'week', 'count');
    const sumResult = rollup(entries, 'week', 'sum');
    assert.equal(countResult[0].value, 2, "'count' aggregation value must be 2 (two days), not 8");
    assert.equal(sumResult[0].value, 8, "'sum' aggregation value must be 8");
  });

  it("'average' divides by days-with-an-entry, never by 7 and never by days-in-period", () => {
    // Both entries fall in the same ISO week.
    const entries = [entry(1, '2026-01-05', 2000), entry(1, '2026-01-06', 2400)];
    const result = rollup(entries, 'week', 'average');
    assert.equal(result.length, 1);
    assert.equal(result[0].value, 2200, 'average must be (2000+2400)/2 = 2200, not /7');
  });

  it("'last' picks the entry with the latest entry_date in the bucket, from shuffled input", () => {
    const entries = [
      entry(1, '2026-01-03', 30),
      entry(1, '2026-01-01', 10),
      entry(1, '2026-01-02', 20),
    ];
    const result = rollup(entries, 'week', 'last');
    assert.equal(result[0].value, 30, 'must pick 2026-01-03 (latest date), not the first array element');
  });

  it("'last' ties on the same entry_date go to whichever appears later in the input array", () => {
    // Same-day "relog" scenario shouldn't happen given the entries unique
    // constraint in the real schema, but rollup itself must still define
    // deterministic behavior for it.
    const entries = [entry(1, '2026-01-01', 111), entry(1, '2026-01-01', 222)];
    const result = rollup(entries, 'week', 'last');
    assert.equal(result[0].value, 222, 'later array element should win the tie');
  });

  it('count field on every bucket reflects entries that fell in it, regardless of chosen aggregation', () => {
    const entries = [entry(1, '2026-01-01', 1), entry(1, '2026-01-02', 2), entry(1, '2026-01-03', 3)];
    for (const agg of ['sum', 'count', 'average', 'last']) {
      const result = rollup(entries, 'week', agg);
      assert.equal(result[0].count, 3, `aggregation '${agg}' must still report count:3`);
    }
  });
});

describe('rollup — sorting and shape', () => {
  it('buckets come back sorted ascending by key, from shuffled input', () => {
    const entries = [
      entry(1, '2026-03-01', 1),
      entry(1, '2026-01-01', 1),
      entry(1, '2026-02-01', 1),
    ];
    const result = rollup(entries, 'month', 'sum');
    assert.deepEqual(
      result.map((r) => r.key),
      ['2026-01', '2026-02', '2026-03']
    );
  });

  it('rollup ignores trackable_id — mixed trackables in one call still merge by period', () => {
    const entries = [entry(1, '2026-01-01', 5), entry(2, '2026-01-01', 7)];
    const result = rollup(entries, 'day', 'sum');
    assert.equal(result.length, 1);
    assert.equal(result[0].value, 12);
    assert.equal(result[0].count, 2);
  });
});

describe('rollup — invalid value handling', () => {
  it('null, undefined, NaN, Infinity, and string values are ignored and do not inflate count', () => {
    const entries = [
      entry(1, '2026-01-01', 10),
      entry(1, '2026-01-02', null),
      entry(1, '2026-01-03', undefined),
      entry(1, '2026-01-04', NaN),
      entry(1, '2026-01-05', Infinity),
      entry(1, '2026-01-06', -Infinity),
      entry(1, '2026-01-07', '5'),
    ];
    const result = rollup(entries, 'week', 'sum');
    assert.equal(result.length, 1);
    assert.equal(result[0].value, 10, 'only the one finite-value entry should contribute');
    assert.equal(result[0].count, 1, 'invalid-value entries must not inflate count');
  });

  it('empty input -> []', () => {
    assert.deepEqual(rollup([], 'day', 'sum'), []);
  });

  it('input where every value is invalid -> []', () => {
    const entries = [entry(1, '2026-01-01', null), entry(1, '2026-01-02', 'nope')];
    assert.deepEqual(rollup(entries, 'day', 'sum'), []);
  });

  it('rollup invents no empty buckets between two distant entries', () => {
    const entries = [entry(1, '2026-01-01', 1), entry(1, '2026-06-01', 1)];
    const result = rollup(entries, 'month', 'sum');
    assert.equal(result.length, 2, 'must not synthesize Feb/Mar/Apr/May buckets');
    assert.deepEqual(
      result.map((r) => r.key),
      ['2026-01', '2026-06']
    );
  });
});

// ===========================================================================
// fillSeries
// ===========================================================================

describe('fillSeries', () => {
  it('fills absent keys with 0 by default, keeps present buckets, preserves key order, filled count is 0', () => {
    const buckets = [{ key: 'b', value: 5, count: 2 }];
    const keys = ['a', 'b', 'c'];
    const result = fillSeries(buckets, keys);
    assert.deepEqual(result, [
      { key: 'a', value: 0, count: 0 },
      { key: 'b', value: 5, count: 2 },
      { key: 'c', value: 0, count: 0 },
    ]);
  });

  it('fillValue: null produces a true gap', () => {
    const buckets = [{ key: 'b', value: 5, count: 2 }];
    const result = fillSeries(buckets, ['a', 'b'], null);
    assert.equal(result[0].value, null);
    assert.equal(result[0].count, 0);
    assert.equal(result[1].value, 5);
  });

  it('motivating case: a 3-week gap between two logged weeks becomes explicit zero weeks, not a disappearance', () => {
    const weekKeys = ['2026-W01', '2026-W02', '2026-W03', '2026-W04', '2026-W05'];
    const buckets = [
      { key: '2026-W01', value: 10, count: 1 },
      { key: '2026-W05', value: 20, count: 1 },
    ];
    const result = fillSeries(buckets, weekKeys, 0);
    assert.equal(result.length, 5);
    assert.deepEqual(
      result.map((r) => r.value),
      [10, 0, 0, 0, 20]
    );
    assert.deepEqual(
      result.map((r) => r.count),
      [1, 0, 0, 0, 1]
    );
  });
});

// ===========================================================================
// normalizeSeries
// ===========================================================================

describe('normalizeSeries', () => {
  it('maps min -> 0 and max -> 100 with a correct midpoint', () => {
    const result = normalizeSeries([0, 50, 100]);
    assert.deepEqual(result, [0, 50, 100]);
  });

  it('scales an arbitrary range correctly', () => {
    const result = normalizeSeries([10, 20, 30]);
    assert.deepEqual(result, [0, 50, 100]);
  });

  it('min === max returns 50 for every finite element, never NaN — flat multi-element series', () => {
    const result = normalizeSeries([7, 7, 7, 7]);
    assert.deepEqual(result, [50, 50, 50, 50]);
    for (const v of result) assert.equal(Number.isNaN(v), false);
  });

  it('min === max returns 50 for a single-element series, never NaN', () => {
    const result = normalizeSeries([42]);
    assert.deepEqual(result, [50]);
    assert.equal(Number.isNaN(result[0]), false);
  });

  it('[] -> []', () => {
    assert.deepEqual(normalizeSeries([]), []);
  });

  it('non-finite entries become null; output length preserved; survivors scale against the finite min/max', () => {
    const result = normalizeSeries([0, NaN, 100, Infinity, 50, null, undefined]);
    assert.equal(result.length, 7);
    assert.equal(result[0], 0);
    assert.equal(result[1], null);
    assert.equal(result[2], 100);
    assert.equal(result[3], null);
    assert.equal(result[4], 50);
    assert.equal(result[5], null);
    assert.equal(result[6], null);
  });

  it('an all-invalid array is all null, same length', () => {
    const result = normalizeSeries([NaN, Infinity, -Infinity, null, undefined]);
    assert.equal(result.length, 5);
    for (const v of result) assert.equal(v, null);
  });

  it('no rounding — fractional scaled values are preserved exactly', () => {
    const result = normalizeSeries([0, 1, 3]);
    // min=0 max=3: 0->0, 1->33.333..., 3->100
    assert.equal(result[0], 0);
    assert.ok(Math.abs(result[1] - 100 / 3) < 1e-9);
    assert.equal(result[2], 100);
  });
});

// ===========================================================================
// deriveBounds
// ===========================================================================

function entriesForWindow(values, asOf, trackable_id = 1) {
  // Places values on consecutive days ending at `asOf`, so the whole set
  // sits inside a window of length values.length ending at asOf.
  const n = values.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const daysBack = n - 1 - i;
    out.push(entry(trackable_id, addDaysLocal(asOf, -daysBack), values[i]));
  }
  return out;
}

// Minimal local addDays reimplementation ONLY for building fixture entry
// dates in these tests — deliberately not importing js/dates.js so this
// file exercises js/aggregate.js in isolation per the contract boundary.
function addDaysLocal(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

describe('deriveBounds — percentile method, authoritative worked examples', () => {
  const TOL = 1e-9;

  it('[1..10] -> p10 = 1.9, p90 = 9.1', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const asOf = '2026-06-10';
    const entries = entriesForWindow(values, asOf);
    const { lower, upper } = deriveBounds(entries, values.length, 'percentile', { asOf });
    assert.ok(Math.abs(lower - 1.9) <= TOL, `lower should be 1.9, got ${lower}`);
    assert.ok(Math.abs(upper - 9.1) <= TOL, `upper should be 9.1, got ${upper}`);
  });

  it('[70..80] (11 values) -> p10 = 71, p90 = 79', () => {
    const values = [70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80];
    const asOf = '2026-06-11';
    const entries = entriesForWindow(values, asOf);
    const { lower, upper } = deriveBounds(entries, values.length, 'percentile', { asOf });
    assert.ok(Math.abs(lower - 71) <= TOL, `lower should be 71, got ${lower}`);
    assert.ok(Math.abs(upper - 79) <= TOL, `upper should be 79, got ${upper}`);
  });

  it('[2,4] -> p10 = 2.2, p90 = 3.8', () => {
    const values = [2, 4];
    const asOf = '2026-06-02';
    const entries = entriesForWindow(values, asOf);
    const { lower, upper } = deriveBounds(entries, values.length, 'percentile', { asOf });
    assert.ok(Math.abs(lower - 2.2) <= TOL, `lower should be 2.2, got ${lower}`);
    assert.ok(Math.abs(upper - 3.8) <= TOL, `upper should be 3.8, got ${upper}`);
  });
});

describe('deriveBounds — window scoping', () => {
  it('entries outside the windowDays window are excluded', () => {
    const asOf = '2026-06-30';
    // In-window: 5 days of value 10 (windowDays=5, days 06-26..06-30).
    const inWindow = [
      entry(1, '2026-06-26', 10),
      entry(1, '2026-06-27', 10),
      entry(1, '2026-06-28', 10),
      entry(1, '2026-06-29', 10),
      entry(1, '2026-06-30', 10),
    ];
    // Way outside the window — would visibly move minmax bounds if
    // incorrectly included.
    const outOfWindow = [entry(1, '2026-01-01', 99999), entry(1, '2027-01-01', -99999)];
    const entries = [...outOfWindow, ...inWindow];

    const { lower, upper } = deriveBounds(entries, 5, 'minmax', { asOf });
    assert.equal(lower, 10, 'out-of-window value must not pull the lower bound down to -99999');
    assert.equal(upper, 10, 'out-of-window value must not pull the upper bound up to 99999');
  });

  it('asOf defaults to the latest entry_date present, not the real current date', () => {
    // All entries are safely in the past relative to any real "today".
    const entries = [
      entry(1, '2020-01-01', 1),
      entry(1, '2020-01-02', 2),
      entry(1, '2020-01-03', 3),
    ];
    const result = deriveBounds(entries, 3, 'minmax');
    assert.notEqual(result.lower, null, 'asOf must default to the latest entry_date, not real today');
    assert.notEqual(result.upper, null);
    assert.equal(result.lower, 1);
    assert.equal(result.upper, 3);
  });
});

describe('deriveBounds — edge cases and method dispatch', () => {
  it('zero entries -> { lower: null, upper: null }', () => {
    const result = deriveBounds([], 30, 'minmax', { asOf: '2026-06-01' });
    assert.deepEqual(result, { lower: null, upper: null });
  });

  it('exactly one finite value in the window -> { lower: null, upper: null }', () => {
    const entries = [entry(1, '2026-06-01', 42)];
    const result = deriveBounds(entries, 30, 'minmax', { asOf: '2026-06-01' });
    assert.deepEqual(result, { lower: null, upper: null });
  });

  it("'minmax' returns the true min/max", () => {
    const entries = [entry(1, '2026-06-01', 5), entry(1, '2026-06-02', 1), entry(1, '2026-06-03', 9)];
    const result = deriveBounds(entries, 30, 'minmax', { asOf: '2026-06-03' });
    assert.equal(result.lower, 1);
    assert.equal(result.upper, 9);
  });

  it('an unknown method throws RangeError', () => {
    const entries = [entry(1, '2026-06-01', 5), entry(1, '2026-06-02', 1)];
    assert.throws(() => deriveBounds(entries, 30, 'zscore', { asOf: '2026-06-02' }), RangeError);
  });

  it('lower <= upper whenever both are non-null (percentile, default method)', () => {
    const entries = [entry(1, '2026-06-01', 5), entry(1, '2026-06-02', 1), entry(1, '2026-06-03', 9)];
    const result = deriveBounds(entries, 30, 'percentile', { asOf: '2026-06-03' });
    assert.ok(result.lower !== null && result.upper !== null);
    assert.ok(result.lower <= result.upper);
  });

  it('default method (omitted) behaves as percentile', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const asOf = '2026-06-10';
    const entries = entriesForWindow(values, asOf);
    const withDefault = deriveBounds(entries, values.length, undefined, { asOf });
    const explicit = deriveBounds(entries, values.length, 'percentile', { asOf });
    assert.deepEqual(withDefault, explicit);
  });
});

// ===========================================================================
// applyRelog
// ===========================================================================

describe('applyRelog — boolean: always 1, idempotent', () => {
  const bool = { value_shape: 'boolean' };

  it('applyRelog(1, 1, bool) -> 1', () => {
    assert.equal(applyRelog(1, 1, bool), 1);
  });

  it('applyRelog(null, 1, bool) -> 1', () => {
    assert.equal(applyRelog(null, 1, bool), 1);
  });

  it('applyRelog(1, 0, bool) -> 1 (clearing is a delete, not this)', () => {
    assert.equal(applyRelog(1, 0, bool), 1);
  });

  it('applyRelog(1, undefined, bool) -> 1 (newValue may be omitted)', () => {
    assert.equal(applyRelog(1, undefined, bool), 1);
  });
});

describe('applyRelog — numeric cumulative', () => {
  const cum = { value_shape: 'numeric', relog_semantic: 'cumulative' };

  it('applyRelog(320, 500, cum) -> 820', () => {
    assert.equal(applyRelog(320, 500, cum), 820);
  });

  it('null existing treated as 0', () => {
    assert.equal(applyRelog(null, 5, cum), 5);
  });

  it('undefined existing treated as 0', () => {
    assert.equal(applyRelog(undefined, 5, cum), 5);
  });

  it('NaN existing treated as 0', () => {
    assert.equal(applyRelog(NaN, 5, cum), 5);
  });

  it('negatives work', () => {
    assert.equal(applyRelog(10, -3, cum), 7);
  });

  it('decimals work', () => {
    assert.ok(Math.abs(applyRelog(1.5, 2.25, cum) - 3.75) < 1e-9);
  });
});

describe('applyRelog — numeric state', () => {
  const state = { value_shape: 'numeric', relog_semantic: 'state' };

  it('applyRelog(78.4, 79.1, state) -> 79.1 (replaces)', () => {
    assert.equal(applyRelog(78.4, 79.1, state), 79.1);
  });

  it('a null existing value still yields newValue', () => {
    assert.equal(applyRelog(null, 12, state), 12);
  });
});

describe('applyRelog — error cases', () => {
  const cum = { value_shape: 'numeric', relog_semantic: 'cumulative' };
  const state = { value_shape: 'numeric', relog_semantic: 'state' };

  it('non-finite newValue on a numeric trackable throws RangeError', () => {
    assert.throws(() => applyRelog(0, NaN, cum), RangeError);
    assert.throws(() => applyRelog(0, Infinity, cum), RangeError);
    assert.throws(() => applyRelog(0, undefined, state), RangeError);
    assert.throws(() => applyRelog(0, '5', cum), RangeError);
  });

  it('missing trackable throws RangeError', () => {
    assert.throws(() => applyRelog(0, 5, undefined), RangeError);
    assert.throws(() => applyRelog(0, 5, null), RangeError);
  });

  it('non-object trackable throws RangeError', () => {
    assert.throws(() => applyRelog(0, 5, 'boolean'), RangeError);
  });

  it('unknown value_shape throws RangeError', () => {
    assert.throws(() => applyRelog(0, 5, { value_shape: 'text' }), RangeError);
  });

  it('unknown relog_semantic on a numeric trackable throws RangeError', () => {
    assert.throws(
      () => applyRelog(0, 5, { value_shape: 'numeric', relog_semantic: 'average' }),
      RangeError
    );
  });
});
