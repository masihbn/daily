// Unit tests for the PURE exports of js/charts/compare.js — written against
// CONTRACT-3.5.md §1 (every export's exact name/shape/string) and §6
// (cases K1-K9). The implementation (js/charts/compare.js) is being written
// in parallel by another agent from the same contract and has NOT been read
// while writing this file — everything below is derived from the contract
// text plus the REAL js/aggregate.js, js/charts/weekly.js and js/dates.js
// helpers it says compare.js is built on, per this project's convention of
// deriving expectations from the real pure helpers rather than hand-computed
// numbers trusted on faith (cf. tests/unit/overlay.test.mjs's header).
//
// No DOM: renderCompare/destroyCompare (the two DOM exports) are exercised
// only through the e2e suite (tests/e2e/compare.test.mjs), which has a real
// document. This file imports only compare.js, aggregate.js, weekly.js and
// dates.js's named pure helpers — no jsdom, nothing touches `document`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPARE_STORAGE_KEY,
  RECOMMENDED_MAX_SERIES,
  COMPARE_PALETTE,
  COMPARE_RANGES,
  COMPARE_PERIODS,
  DEFAULT_COMPARE_STATE,
  compareCandidates,
  readCompareState,
  writeCompareState,
  sanitizeCompareIds,
  seriesColorFor,
  compareSeries,
  compareModel,
  compareTooltipLabel,
  compareKeyText,
} from '../../js/charts/compare.js';
import { rollup, fillSeries, normalizeSeries } from '../../js/aggregate.js';
import { periodKeysFor, periodLabel, seriesAggregationFor, fillValueFor } from '../../js/charts/weekly.js';
import { isoWeekKey } from '../../js/dates.js';

// --- fake storage helpers (same shape as tests/unit/overlay.test.mjs's) ----

function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}

function throwingStorage() {
  return {
    getItem() {
      throw new Error('boom');
    },
    setItem() {
      throw new Error('boom');
    },
  };
}

// --- shared helpers to independently derive expectations -------------------
//
// Mirrors the sanitisation rule the contract spells out for compareSeries's
// `raw` field ("entries sanitised first ... duplicate entry_date first-wins,
// like bounds.js#boundsSeries") and js/charts/weekly.js's own isRealDateStr
// pattern, so a malformed date is rejected the same way trendModel/boundsSeries
// reject it — not a second, looser notion of "valid date".
const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;
function isRealDateStr(str) {
  if (typeof str !== 'string' || !DATE_STR_RE.test(str)) return false;
  try {
    isoWeekKey(str);
    return true;
  } catch {
    return false;
  }
}

function isFiniteValue(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function sanitizeEntriesForSeries(entries) {
  const clean = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && typeof e === 'object' && isRealDateStr(e.entry_date) && isFiniteValue(e.value)
  );
  const byDate = new Map();
  for (const e of clean) {
    if (!byDate.has(e.entry_date)) byDate.set(e.entry_date, e);
  }
  return [...byDate.values()];
}

// Orchestrator amendment (applied here): `hasData` is NOT "at least one
// finite raw value after fill" — a count/sum trackable with zero real
// entries in the window still fills every bucket to a finite 0, which would
// wrongly read as "has data". The real rule is "the trackable has at least
// one real (sanitised) entry whose bucket key is one of `keys`". When that's
// false, min/max are null too, regardless of what the filled `raw` array
// contains. Mirrors aggregate.js#bucketKeyFor (day: the date itself; week:
// isoWeekKey; month: the first 7 chars) since that's the bucketing raw
// entries are matched against.
function bucketKeyForPeriod(entryDate, period) {
  if (period === 'week') return isoWeekKey(entryDate);
  if (period === 'month') return entryDate.slice(0, 7);
  return entryDate; // 'day', and the unknown-period fallback compareSeries uses
}

function expectedSeriesFor(trackable, entries, keys, period) {
  const agg = seriesAggregationFor(trackable);
  const deduped = sanitizeEntriesForSeries(entries);
  const keySet = new Set(keys);
  const hasData = deduped.some((e) => keySet.has(bucketKeyForPeriod(e.entry_date, period)));
  const buckets = rollup(deduped, period, agg);
  const raw = fillSeries(buckets, keys, fillValueFor(agg)).map((b) => b.value);
  if (!hasData) {
    return { raw, hasData: false, min: null, max: null };
  }
  const finite = raw.filter(isFiniteValue);
  const min = finite.length > 0 ? Math.min(...finite) : null;
  const max = finite.length > 0 ? Math.max(...finite) : null;
  return { raw, hasData: true, min, max };
}

// =============================================================================
// K1 — compareCandidates
// =============================================================================

describe('K1 compareCandidates', () => {
  it('drops archived, keeps input order', () => {
    const t1 = { id: 1, name: 'A', archived: false };
    const t2 = { id: 2, name: 'B', archived: true };
    const t3 = { id: 3, name: 'C', archived: false };
    const t4 = { id: 4, name: 'D' }; // no archived flag at all -> kept
    const out = compareCandidates([t1, t2, t3, t4]);
    assert.deepEqual(
      out.map((t) => t.id),
      [1, 3, 4]
    );
  });

  it('non-array input -> []', () => {
    assert.deepEqual(compareCandidates(null), []);
    assert.deepEqual(compareCandidates(undefined), []);
    assert.deepEqual(compareCandidates('nope'), []);
    assert.deepEqual(compareCandidates({}), []);
    assert.deepEqual(compareCandidates(42), []);
  });

  it('never throws on garbage entries mixed in', () => {
    assert.doesNotThrow(() => compareCandidates([null, undefined, 5, 'x', { id: 1, archived: false }]));
  });
});

// =============================================================================
// K2 — readCompareState
// =============================================================================

describe('K2 readCompareState', () => {
  it('null storage -> a fresh copy of DEFAULT_COMPARE_STATE', () => {
    const out = readCompareState(null);
    assert.deepEqual(out, DEFAULT_COMPARE_STATE);
    assert.notEqual(out, DEFAULT_COMPARE_STATE);
  });

  it('storage.getItem returning null -> defaults', () => {
    const out = readCompareState(makeStorage());
    assert.deepEqual(out, DEFAULT_COMPARE_STATE);
  });

  it('bad JSON -> defaults', () => {
    const out = readCompareState(makeStorage({ [COMPARE_STORAGE_KEY]: '{not json' }));
    assert.deepEqual(out, DEFAULT_COMPARE_STATE);
  });

  it('a JSON array (non-object) -> defaults', () => {
    const out = readCompareState(makeStorage({ [COMPARE_STORAGE_KEY]: JSON.stringify(['ids', 'week', '3m']) }));
    assert.deepEqual(out, DEFAULT_COMPARE_STATE);
  });

  it('a plain JSON scalar -> defaults', () => {
    const out = readCompareState(makeStorage({ [COMPARE_STORAGE_KEY]: '42' }));
    assert.deepEqual(out, DEFAULT_COMPARE_STATE);
  });

  it('storage.getItem throwing -> defaults, never throws', () => {
    let out;
    assert.doesNotThrow(() => {
      out = readCompareState(throwingStorage());
    });
    assert.deepEqual(out, DEFAULT_COMPARE_STATE);
  });

  it('missing fields default independently', () => {
    const out = readCompareState(makeStorage({ [COMPARE_STORAGE_KEY]: JSON.stringify({}) }));
    assert.deepEqual(out, { ids: [], period: 'week', range: '3m' });
  });

  it('ids coerced to strings', () => {
    const out = readCompareState(
      makeStorage({ [COMPARE_STORAGE_KEY]: JSON.stringify({ ids: [1, 2, '3'], period: 'week', range: '3m' }) })
    );
    assert.deepEqual(out.ids, ['1', '2', '3']);
  });

  it('a non-array ids field -> []', () => {
    const out = readCompareState(
      makeStorage({ [COMPARE_STORAGE_KEY]: JSON.stringify({ ids: 'nope', period: 'week', range: '3m' }) })
    );
    assert.deepEqual(out.ids, []);
  });

  it("bad period -> 'week'", () => {
    for (const bad of ['bogus', 5, null, undefined, {}]) {
      const out = readCompareState(
        makeStorage({ [COMPARE_STORAGE_KEY]: JSON.stringify({ ids: [], period: bad, range: '3m' }) })
      );
      assert.equal(out.period, 'week');
    }
    for (const good of COMPARE_PERIODS) {
      const out = readCompareState(
        makeStorage({ [COMPARE_STORAGE_KEY]: JSON.stringify({ ids: [], period: good, range: '3m' }) })
      );
      assert.equal(out.period, good);
    }
  });

  it("bad range -> '3m'", () => {
    for (const bad of ['bogus', 5, null, undefined, {}]) {
      const out = readCompareState(
        makeStorage({ [COMPARE_STORAGE_KEY]: JSON.stringify({ ids: [], period: 'week', range: bad }) })
      );
      assert.equal(out.range, '3m');
    }
    for (const good of COMPARE_RANGES) {
      const out = readCompareState(
        makeStorage({ [COMPARE_STORAGE_KEY]: JSON.stringify({ ids: [], period: 'week', range: good }) })
      );
      assert.equal(out.range, good);
    }
  });

  it('returns a fresh object each call — mutating one does not affect the next', () => {
    const storage = makeStorage({ [COMPARE_STORAGE_KEY]: JSON.stringify({ ids: ['1'], period: 'month', range: '1y' }) });
    const a = readCompareState(storage);
    a.ids.push('mutated');
    a.period = 'day';
    const b = readCompareState(storage);
    assert.deepEqual(b.ids, ['1']);
    assert.equal(b.period, 'month');
  });
});

// =============================================================================
// K3 — writeCompareState
// =============================================================================

describe('K3 writeCompareState', () => {
  it('round-trips through readCompareState', () => {
    const storage = makeStorage();
    writeCompareState(storage, { ids: [1, '2'], period: 'month', range: '1y' });
    const back = readCompareState(storage);
    assert.deepEqual(back, { ids: ['1', '2'], period: 'month', range: '1y' });
  });

  it('invalid fields are written as their defaults (validated the same way as readCompareState)', () => {
    const storage = makeStorage();
    writeCompareState(storage, { ids: 'nope', period: 'bogus', range: 'nah' });
    const back = readCompareState(storage);
    assert.deepEqual(back, { ids: [], period: 'week', range: '3m' });
  });

  it('a throwing storage is swallowed, never throws', () => {
    assert.doesNotThrow(() => writeCompareState(throwingStorage(), { ids: ['1'], period: 'week', range: '3m' }));
  });

  it('a null storage never throws', () => {
    assert.doesNotThrow(() => writeCompareState(null, { ids: ['1'], period: 'week', range: '3m' }));
  });
});

// =============================================================================
// K4 — sanitizeCompareIds
// =============================================================================

describe('K4 sanitizeCompareIds', () => {
  const candidates = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];

  it('dedupes, drops non-candidates, keeps order, no cap (6 survive)', () => {
    const out = sanitizeCompareIds(['1', '2', '2', '3', '4', '5', '6', '999'], candidates);
    assert.deepEqual(out, ['1', '2', '3', '4', '5', '6']);
  });

  it('coerces numeric ids to strings and matches candidates by String(c.id)', () => {
    const out = sanitizeCompareIds([1, 2], candidates);
    assert.deepEqual(out, ['1', '2']);
  });

  it('drops ids that are not among candidates', () => {
    const out = sanitizeCompareIds(['999', '1'], candidates);
    assert.deepEqual(out, ['1']);
  });

  it('non-array ids -> []', () => {
    assert.deepEqual(sanitizeCompareIds(null, candidates), []);
    assert.deepEqual(sanitizeCompareIds(undefined, candidates), []);
    assert.deepEqual(sanitizeCompareIds('nope', candidates), []);
  });

  it('never throws on garbage', () => {
    assert.doesNotThrow(() => sanitizeCompareIds([null, undefined, {}], candidates));
    assert.doesNotThrow(() => sanitizeCompareIds(['1'], null));
  });
});

// =============================================================================
// K5 — seriesColorFor
// =============================================================================

describe('K5 seriesColorFor', () => {
  it("uses the trackable's own colour when set", () => {
    assert.equal(seriesColorFor({ color: '#abcdef' }, 0), '#abcdef');
    assert.equal(seriesColorFor({ color: '#abcdef' }, 3), '#abcdef');
  });

  it('falls back to the palette by index when no colour', () => {
    assert.equal(seriesColorFor({ color: null }, 0), COMPARE_PALETTE[0]);
    assert.equal(seriesColorFor({ color: '' }, 1), COMPARE_PALETTE[1]);
    assert.equal(seriesColorFor({}, 2), COMPARE_PALETTE[2]);
    assert.equal(seriesColorFor(null, 0), COMPARE_PALETTE[0]);
  });

  it('wraps at the palette length', () => {
    const len = COMPARE_PALETTE.length;
    assert.equal(seriesColorFor({}, len), COMPARE_PALETTE[0]);
    assert.equal(seriesColorFor({}, len + 1), COMPARE_PALETTE[1]);
    assert.equal(seriesColorFor({}, len * 2), COMPARE_PALETTE[0]);
  });

  it('a non-integer/negative index falls back to palette[0]', () => {
    for (const bad of [-1, 1.5, NaN, undefined, 'x', null]) {
      assert.equal(seriesColorFor({}, bad), COMPARE_PALETTE[0]);
    }
  });
});

// =============================================================================
// K6 — compareSeries
// =============================================================================

describe('K6 compareSeries', () => {
  it('day period: raw aligned to keys, dedupe first-wins, malformed dates/non-finite values dropped, normalized 0..100', () => {
    const trackable = { id: '701', name: 'Calories', unit: 'kcal', value_shape: 'numeric', aggregation: 'average', target_type: 'none' };
    const entries = [
      { trackable_id: '701', entry_date: '2026-01-01', value: 2000 },
      { trackable_id: '701', entry_date: '2026-01-01', value: 9999 }, // duplicate date -> first (2000) wins
      { trackable_id: '701', entry_date: '2026-01-02', value: 3000 },
      { trackable_id: '701', entry_date: 'not-a-date', value: 5000 }, // malformed date -> dropped
      { trackable_id: '701', entry_date: '2026-02-30', value: 5000 }, // shape-only fake date -> dropped
      { trackable_id: '701', entry_date: '2026-01-03', value: NaN }, // non-finite -> dropped
      { trackable_id: '701', entry_date: '2026-01-03', value: Infinity }, // non-finite -> dropped
    ];
    const keys = periodKeysFor('day', '2026-01-01', '2026-01-03');
    const out = compareSeries({ trackable, entries, keys, period: 'day', index: 0 });

    assert.equal(out.id, '701');
    assert.equal(out.name, 'Calories');
    assert.equal(out.unit, 'kcal');
    assert.equal(out.aggregation, 'average');
    assert.deepEqual(out.raw, [2000, 3000, null]);
    assert.deepEqual(out.normalized, [0, 100, null]);
    assert.equal(out.min, 2000);
    assert.equal(out.max, 3000);
    assert.equal(out.hasData, true);
    assert.equal(out.color, seriesColorFor(trackable, 0));
  });

  it('a flat series normalizes to 50 everywhere', () => {
    const trackable = { id: '1', name: 'Flat', aggregation: 'sum' };
    const entries = [
      { trackable_id: '1', entry_date: '2026-02-01', value: 5 },
      { trackable_id: '1', entry_date: '2026-02-02', value: 5 },
    ];
    const keys = periodKeysFor('day', '2026-02-01', '2026-02-02');
    const out = compareSeries({ trackable, entries, keys, period: 'day', index: 1 });
    assert.deepEqual(out.raw, [5, 5]);
    assert.deepEqual(out.normalized, [50, 50]);
    assert.equal(out.min, 5);
    assert.equal(out.max, 5);
    assert.equal(out.hasData, true);
  });

  it("boolean 'count' aggregation fills gaps with 0 (not null), giving a true 0%/100% split", () => {
    const trackable = { id: '702', name: 'Workout', value_shape: 'boolean', aggregation: 'count' };
    const entries = [{ trackable_id: '702', entry_date: '2026-03-02', value: 1 }];
    const keys = periodKeysFor('day', '2026-03-01', '2026-03-03');
    const out = compareSeries({ trackable, entries, keys, period: 'day', index: 2 });
    assert.deepEqual(out.raw, [0, 1, 0]);
    assert.deepEqual(out.normalized, [0, 100, 0]);
    assert.equal(out.min, 0);
    assert.equal(out.max, 1);
    assert.equal(out.hasData, true);
  });

  it('no entries at all -> raw is the fill value everywhere, normalized all-null, hasData false when the fill is null', () => {
    const trackable = { id: '3', name: 'Weight', aggregation: 'last' };
    const keys = periodKeysFor('day', '2026-04-01', '2026-04-02');
    const out = compareSeries({ trackable, entries: [], keys, period: 'day', index: 0 });
    assert.deepEqual(out.raw, [null, null]);
    assert.deepEqual(out.normalized, [null, null]);
    assert.equal(out.min, null);
    assert.equal(out.max, null);
    assert.equal(out.hasData, false);
  });

  // Orchestrator amendment: a count/sum trackable with ZERO real entries in
  // the window still fills every bucket to a finite 0 (fillValueFor('sum')
  // === 0) — that must NOT read as "has data". hasData/min/max are driven by
  // whether any REAL entry's bucket key falls in `keys`, not by whether the
  // post-fill `raw` array happens to contain finite numbers.
  it('a sum trackable with ZERO real entries in the window: hasData false and min/max null, even though every bucket fills to a finite 0', () => {
    const trackable = { id: '11', name: 'NoLogs', aggregation: 'sum' };
    const keys = periodKeysFor('day', '2026-05-01', '2026-05-03');
    const out = compareSeries({ trackable, entries: [], keys, period: 'day', index: 0 });
    assert.deepEqual(out.raw, [0, 0, 0]);
    assert.equal(out.hasData, false);
    assert.equal(out.min, null);
    assert.equal(out.max, null);
    // normalizeSeries itself is still applied to the (all-finite) raw array
    // regardless of hasData — hasData only decides whether compareModel
    // draws/skips this series, not what compareSeries itself computes.
    assert.deepEqual(out.normalized, normalizeSeries(out.raw));
  });

  it('a boolean count trackable with ZERO entries in the window: hasData false (what compareModel uses to skip it)', () => {
    const trackable = { id: '702', name: 'Workout', value_shape: 'boolean', aggregation: 'count' };
    const keys = periodKeysFor('week', '2026-01-01', '2026-02-01');
    const out = compareSeries({ trackable, entries: [], keys, period: 'week', index: 0 });
    assert.deepEqual(out.raw, keys.map(() => 0));
    assert.equal(out.hasData, false);
    assert.equal(out.min, null);
    assert.equal(out.max, null);
  });

  it('real entries whose bucket keys fall OUTSIDE the given `keys` window do not count toward hasData', () => {
    const trackable = { id: '12', name: 'Outside', aggregation: 'sum' };
    const entries = [{ trackable_id: '12', entry_date: '2026-01-01', value: 100 }]; // long before the window below
    const keys = periodKeysFor('day', '2026-05-01', '2026-05-03');
    const out = compareSeries({ trackable, entries, keys, period: 'day', index: 0 });
    assert.equal(out.hasData, false);
    assert.equal(out.min, null);
    assert.equal(out.max, null);
  });

  it('week period matches rollup+fillSeries+normalizeSeries derived independently, including hasData', () => {
    const trackable = { id: '9', name: 'Something', aggregation: 'sum', unit: 'x' };
    const entries = [
      { trackable_id: '9', entry_date: '2026-01-05', value: 10 },
      { trackable_id: '9', entry_date: '2026-01-06', value: 5 },
      { trackable_id: '9', entry_date: '2026-01-20', value: 40 },
    ];
    const keys = periodKeysFor('week', '2026-01-01', '2026-01-25');
    const out = compareSeries({ trackable, entries, keys, period: 'week', index: 0 });
    const expected = expectedSeriesFor(trackable, entries, keys, 'week');
    assert.deepEqual(out.raw, expected.raw);
    assert.deepEqual(out.normalized, normalizeSeries(expected.raw));
    assert.equal(out.min, expected.min);
    assert.equal(out.max, expected.max);
    assert.equal(out.hasData, expected.hasData);
    assert.equal(out.hasData, true); // sanity: this fixture DOES have real data in-window
  });

  it('month period matches rollup+fillSeries+normalizeSeries derived independently, including hasData', () => {
    const trackable = { id: '10', name: 'Monthly Thing', aggregation: 'average', unit: 'kg' };
    const entries = [
      { trackable_id: '10', entry_date: '2026-01-05', value: 80 },
      { trackable_id: '10', entry_date: '2026-02-10', value: 78 },
      { trackable_id: '10', entry_date: '2026-02-20', value: 82 },
    ];
    const keys = periodKeysFor('month', '2026-01-01', '2026-03-15');
    const out = compareSeries({ trackable, entries, keys, period: 'month', index: 4 });
    const expected = expectedSeriesFor(trackable, entries, keys, 'month');
    assert.deepEqual(out.raw, expected.raw);
    assert.deepEqual(out.normalized, normalizeSeries(expected.raw));
    assert.equal(out.hasData, expected.hasData);
    assert.equal(out.color, seriesColorFor(trackable, 4));
  });

  it('never throws for a garbage trackable/entries and falls back to day bucketing for an unknown period', () => {
    const keys = ['2026-04-01', '2026-04-02'];
    const entries = [
      { trackable_id: 1, entry_date: '2026-04-01', value: 7 },
      null,
      'garbage',
      { entry_date: '2026-04-01' }, // no value
    ];
    let out;
    assert.doesNotThrow(() => {
      out = compareSeries({ trackable: null, entries, keys, period: 'bogus', index: 0 });
    });
    // Falls back to 'day' bucketing: entry_date is used as the raw bucket key
    // directly, matching keys verbatim.
    assert.equal(out.name, '');
    assert.equal(out.unit, null);
    assert.equal(out.raw[0], 7);
    assert.equal(out.color, seriesColorFor(null, 0));
  });
});

// =============================================================================
// K7 — compareModel
// =============================================================================

describe('K7 compareModel', () => {
  const T1 = { id: '1', name: 'A', aggregation: 'sum', color: '#111111' };
  const T2 = { id: '2', name: 'B', aggregation: 'average', unit: 'kg' };
  const T3 = { id: '3', name: 'C', value_shape: 'boolean', aggregation: 'count' };

  it("status 'none' with no trackables", () => {
    const out = compareModel({ trackables: [], entriesById: {}, from: null, to: '2026-01-10', period: 'week' });
    assert.equal(out.status, 'none');
    assert.deepEqual(out.keys, []);
    assert.deepEqual(out.labels, []);
    assert.deepEqual(out.series, []);
    assert.deepEqual(out.skipped, []);
    assert.equal(out.tooMany, false);
  });

  it("status 'empty' when trackables are selected but have no dated entries at all", () => {
    const out = compareModel({ trackables: [T1], entriesById: { 1: [] }, from: null, to: '2026-01-10', period: 'week' });
    assert.equal(out.status, 'empty');
    assert.deepEqual(out.keys, []);
    assert.deepEqual(out.labels, []);
    assert.deepEqual(out.series, []);
    assert.deepEqual(out.skipped, [{ id: '1', name: 'A' }]);
    assert.equal(out.tooMany, false);
  });

  it("status 'empty' when from > to", () => {
    const out = compareModel({
      trackables: [T1],
      entriesById: { 1: [{ trackable_id: '1', entry_date: '2026-01-15', value: 10 }] },
      from: '2026-02-01',
      to: '2026-01-01',
      period: 'week',
    });
    assert.equal(out.status, 'empty');
    assert.deepEqual(out.skipped, [{ id: '1', name: 'A' }]);
  });

  it("status 'ok' with a given `from`: keys start there", () => {
    const entriesById = {
      1: [{ trackable_id: '1', entry_date: '2026-01-02', value: 10 }],
      2: [{ trackable_id: '2', entry_date: '2026-01-05', value: 80 }],
    };
    const out = compareModel({ trackables: [T1, T2], entriesById, from: '2026-01-01', to: '2026-01-10', period: 'day' });
    assert.equal(out.status, 'ok');
    assert.deepEqual(out.keys, periodKeysFor('day', '2026-01-01', '2026-01-10'));
    assert.equal(out.series.length, 2);
    assert.equal(out.series[0].id, '1');
    assert.equal(out.series[1].id, '2');
    assert.equal(out.series[0].color, seriesColorFor(T1, 0));
    assert.equal(out.series[1].color, seriesColorFor(T2, 1));
    assert.deepEqual(out.labels, out.keys.map((k) => periodLabel(k, 'day', { multiYear: false })));
  });

  it('from null: keys start at the earliest entry across ALL given series, not per-series', () => {
    const entriesById = {
      1: [{ trackable_id: '1', entry_date: '2026-01-05', value: 10 }],
      2: [{ trackable_id: '2', entry_date: '2026-01-03', value: 80 }], // earlier than T1's own earliest
    };
    const out = compareModel({ trackables: [T1, T2], entriesById, from: null, to: '2026-01-10', period: 'day' });
    assert.equal(out.status, 'ok');
    assert.equal(out.keys[0], '2026-01-03');
    assert.deepEqual(out.keys, periodKeysFor('day', '2026-01-03', '2026-01-10'));
  });

  it('a two-year span sets multiYear true and labels use it', () => {
    const entriesById = {
      1: [{ trackable_id: '1', entry_date: '2025-01-10', value: 10 }],
    };
    const out = compareModel({ trackables: [T1], entriesById, from: null, to: '2027-06-01', period: 'month' });
    assert.equal(out.status, 'ok');
    assert.equal(out.multiYear, true);
    assert.deepEqual(out.labels, out.keys.map((k) => periodLabel(k, 'month', { multiYear: true })));
  });

  // Orchestrator amendment: T3 is a BOOLEAN COUNT trackable with zero entries
  // in the window — fillValueFor('count') === 0 fills every bucket with a
  // finite number, so this specifically exercises that a count aggregation
  // with no real entries still has hasData:false at the compareSeries level
  // and is skipped here, not drawn as a flat zero line.
  it('skipped lists selected trackables with no data in the window, absent from series', () => {
    const entriesById = {
      1: [{ trackable_id: '1', entry_date: '2026-01-02', value: 10 }],
      2: [{ trackable_id: '2', entry_date: '2026-01-05', value: 80 }],
      3: [], // no dated entries -> skipped (boolean 'count' aggregation)
    };
    const out = compareModel({ trackables: [T1, T2, T3], entriesById, from: '2026-01-01', to: '2026-01-10', period: 'day' });
    assert.equal(out.status, 'ok');
    assert.equal(out.series.length, 2);
    assert.equal(out.series.some((s) => s.id === '3'), false);
    assert.deepEqual(out.skipped, [{ id: '3', name: 'C' }]);
  });

  it('colour index is the position among ALL selected — skipping the 2nd of 3 keeps the 3rd at palette index 2', () => {
    const entriesById = {
      1: [{ trackable_id: '1', entry_date: '2026-01-02', value: 10 }],
      2: [], // skipped
      3: [{ trackable_id: '3', entry_date: '2026-01-03', value: 1 }],
    };
    const out = compareModel({ trackables: [T1, T2, T3], entriesById, from: '2026-01-01', to: '2026-01-10', period: 'day' });
    assert.equal(out.series.length, 2);
    assert.equal(out.series[0].id, '1');
    assert.equal(out.series[0].color, seriesColorFor(T1, 0));
    assert.equal(out.series[1].id, '3');
    assert.equal(out.series[1].color, seriesColorFor(T3, 2));
  });

  it('tooMany is false at exactly RECOMMENDED_MAX_SERIES (4), true at 5', () => {
    const mk = (id) => ({ id: String(id), name: `T${id}`, aggregation: 'sum' });
    const four = [1, 2, 3, 4].map(mk);
    const five = [1, 2, 3, 4, 5].map(mk);
    const entriesFor = (list) =>
      Object.fromEntries(list.map((t) => [t.id, [{ trackable_id: t.id, entry_date: '2026-01-02', value: 1 }]]));

    const outFour = compareModel({ trackables: four, entriesById: entriesFor(four), from: '2026-01-01', to: '2026-01-10', period: 'day' });
    assert.equal(outFour.series.length, 4);
    assert.equal(outFour.tooMany, false);
    assert.equal(RECOMMENDED_MAX_SERIES, 4);

    const outFive = compareModel({ trackables: five, entriesById: entriesFor(five), from: '2026-01-01', to: '2026-01-10', period: 'day' });
    assert.equal(outFive.series.length, 5);
    assert.equal(outFive.tooMany, true);
  });

  it('garbage `to` throws RangeError', () => {
    assert.throws(
      () =>
        compareModel({
          trackables: [T1],
          entriesById: { 1: [{ trackable_id: '1', entry_date: '2026-01-02', value: 10 }] },
          from: null,
          to: 'not-a-date',
          period: 'week',
        }),
      RangeError
    );
  });

  it('unknown period throws RangeError', () => {
    assert.throws(
      () =>
        compareModel({
          trackables: [T1],
          entriesById: { 1: [{ trackable_id: '1', entry_date: '2026-01-02', value: 10 }] },
          from: null,
          to: '2026-01-10',
          period: 'fortnight',
        }),
      RangeError
    );
  });
});

// =============================================================================
// K8 — compareTooltipLabel
// =============================================================================

describe('K8 compareTooltipLabel', () => {
  it('formats name/unit/pct, rounding raw to 1 decimal and pct to a whole number', () => {
    const series = { name: 'Calories', unit: 'kcal', raw: [1916.44], normalized: [73.4] };
    assert.equal(compareTooltipLabel(series, 0), 'Calories: 1916.4 kcal (73%)');
  });

  it('no unit -> no trailing unit segment', () => {
    const series = { name: 'Workout', unit: null, raw: [3], normalized: [100] };
    assert.equal(compareTooltipLabel(series, 0), 'Workout: 3 (100%)');
  });

  it('a null/non-finite raw value -> "Name: —"', () => {
    const seriesNull = { name: 'Workout', unit: null, raw: [null], normalized: [null] };
    assert.equal(compareTooltipLabel(seriesNull, 0), 'Workout: —');
    const seriesNaN = { name: 'Workout', unit: null, raw: [NaN], normalized: [null] };
    assert.equal(compareTooltipLabel(seriesNaN, 0), 'Workout: —');
  });
});

// =============================================================================
// K9 — compareKeyText
// =============================================================================

describe('K9 compareKeyText', () => {
  it('formats min–max with an en dash and the unit', () => {
    assert.equal(compareKeyText({ min: 1650, max: 2300, unit: 'kcal' }), '1650 – 2300 kcal');
  });

  it('no unit -> no trailing unit segment', () => {
    assert.equal(compareKeyText({ min: 65.34, max: 70, unit: null }), '65.3 – 70');
  });

  it('a null min or max -> "—"', () => {
    assert.equal(compareKeyText({ min: null, max: null, unit: 'kcal' }), '—');
    assert.equal(compareKeyText({ min: null, max: 100, unit: null }), '—');
    assert.equal(compareKeyText({ min: 50, max: null, unit: null }), '—');
  });
});
