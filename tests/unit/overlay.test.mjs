// Unit tests for the PURE exports of js/charts/overlay.js — REWRITTEN for
// CONTRACT-3.4b.md (delta over CONTRACT-3.4.md after the device check: the
// overlay is no longer fixed-row markers but the overlay trackable's OWN
// trend series — bars on a visible right axis, coloured by verdict against
// its own target, one overlay at a time). Written strictly against
// CONTRACT-3.4b.md §1 (every export's exact name/shape/string) and §6
// (cases U1-U5 kept, U6/U10 and every removed-export test deleted, U7-U15
// new) — the implementation (js/charts/overlay.js) is being written in
// parallel by another agent from the same contract and has NOT been read
// while writing this file.
//
// No DOM: renderOverlayPicker (the ONE DOM export) is exercised only through
// the e2e suite (tests/e2e/overlay.test.mjs), which has a real document.
// This file imports only overlay.js, dates.js, aggregate.js and weekly.js's
// named pure helpers — no jsdom, nothing touches `document`.
//
// Bucket keys and target/verdict cross-checks are derived from the REAL
// js/dates.js (rangeDays/isoWeeksInRange/monthsInRange/isoWeekKey/
// startOfIsoWeek/addDays) and js/charts/weekly.js (targetFor/weekVerdict/
// seriesAggregationFor/fillValueFor) rather than hand-computed and trusted,
// per this project's repeated convention (cf. tests/unit/bounds.test.mjs's
// header) — but every assertion below still checks the CONTRACT's stated
// shape/value, not just "whatever the helper happens to return".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERLAY_STORAGE_KEY,
  MAX_OVERLAYS,
  OVERLAY_BAR_ALPHA,
  isOverlayCandidate,
  overlayCandidates,
  readOverlaySelection,
  writeOverlaySelection,
  sanitizeSelection,
  overlayModel,
  overlayKindFor,
  zoneOf,
  withAlpha,
  overlayAxisFor,
  overlayAxisTitle,
  overlayTooltipLabel,
  overlayTargetAnnotation,
  overlayBoundAnnotations,
  overlayDatasets,
} from '../../js/charts/overlay.js';
import { rangeDays, isoWeekKey, startOfIsoWeek, addDays } from '../../js/dates.js';
import { targetFor, weekVerdict } from '../../js/charts/weekly.js';
// CONTRACT-3.4c.md §6, U1c: zoneOf is a local mirror of bounds.js#zoneFor —
// imported here (test file only, never from overlay.js) purely to assert
// the two agree across a table of cases.
import { zoneFor } from '../../js/charts/bounds.js';

// --- fake storage helpers (unchanged from 3.4) ------------------------------

function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    _data: data,
  };
}

function throwingGetStorage() {
  return {
    getItem() {
      throw new Error('boom');
    },
    setItem() {},
  };
}

function throwingSetStorage() {
  return {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error('boom');
    },
  };
}

// ===========================================================================
// U1 — isOverlayCandidate — CONTRACT-3.4c: every non-archived boolean OR
// numeric trackable is now a candidate (average/last included — Weight is
// the whole point of 3.4c). Aggregation no longer gates candidacy at all;
// only value_shape and archived do.
// ===========================================================================

describe('U1 — isOverlayCandidate (3.4c: average/last numerics are now candidates)', () => {
  it('boolean -> true', () => {
    assert.equal(isOverlayCandidate({ value_shape: 'boolean', archived: false }), true);
  });

  it('numeric + count -> true', () => {
    assert.equal(isOverlayCandidate({ value_shape: 'numeric', aggregation: 'count', archived: false }), true);
  });

  it('numeric + sum -> true', () => {
    assert.equal(isOverlayCandidate({ value_shape: 'numeric', aggregation: 'sum', archived: false }), true);
  });

  it('numeric + average -> true (CHANGED in 3.4c: was false)', () => {
    assert.equal(isOverlayCandidate({ value_shape: 'numeric', aggregation: 'average', archived: false }), true);
  });

  it('numeric + last -> true (CHANGED in 3.4c: was false)', () => {
    assert.equal(isOverlayCandidate({ value_shape: 'numeric', aggregation: 'last', archived: false }), true);
  });

  it('archived boolean -> false', () => {
    assert.equal(isOverlayCandidate({ value_shape: 'boolean', archived: true }), false);
  });

  it('archived numeric (any aggregation) -> false', () => {
    assert.equal(isOverlayCandidate({ value_shape: 'numeric', aggregation: 'average', archived: true }), false);
  });

  it('null / string / [] -> false, and never throws', () => {
    assert.equal(isOverlayCandidate(null), false);
    assert.equal(isOverlayCandidate(undefined), false);
    assert.equal(isOverlayCandidate('boolean'), false);
    assert.equal(isOverlayCandidate([]), false);
    assert.equal(isOverlayCandidate(42), false);
  });
});

// ===========================================================================
// U1b — overlayKindFor
// ===========================================================================

describe('U1b — overlayKindFor', () => {
  it("'count' / 'sum' -> 'bar'", () => {
    assert.equal(overlayKindFor('count'), 'bar');
    assert.equal(overlayKindFor('sum'), 'bar');
  });

  it("'average' / 'last' -> 'line'", () => {
    assert.equal(overlayKindFor('average'), 'line');
    assert.equal(overlayKindFor('last'), 'line');
  });

  it('garbage -> "bar" (safe default), never throws', () => {
    assert.equal(overlayKindFor(undefined), 'bar');
    assert.equal(overlayKindFor(null), 'bar');
    assert.equal(overlayKindFor('nonsense'), 'bar');
    assert.equal(overlayKindFor(42), 'bar');
    assert.equal(overlayKindFor([]), 'bar');
  });
});

// ===========================================================================
// U1c — zoneOf mirrors bounds.js#zoneFor
// ===========================================================================

describe('U1c — zoneOf mirrors bounds.js#zoneFor', () => {
  const okBounds = { status: 'ok', lower: 78, upper: 85 };
  const table = [
    ['in-band value', 80, okBounds],
    ['below-band value', 77, okBounds],
    ['above-band value', 86, okBounds],
    ['exactly at lower bound -> in', 78, okBounds],
    ['exactly at upper bound -> in', 85, okBounds],
    ['non-finite value (NaN)', NaN, okBounds],
    ['non-finite value (null)', null, okBounds],
    ['non-finite value (string)', '80', okBounds],
    ['status not ok (insufficient)', 80, { status: 'insufficient', lower: null, upper: null }],
    ['status not ok (invalid)', 80, { status: 'invalid', lower: null, upper: null }],
    ['lower null', 80, { status: 'ok', lower: null, upper: 85 }],
    ['upper null', 80, { status: 'ok', lower: 78, upper: null }],
    ['bounds null', 80, null],
    ['bounds undefined', 80, undefined],
    ['bounds not an object', 80, 'nope'],
  ];
  for (const [label, value, bounds] of table) {
    it(`${label}: zoneOf === zoneFor`, () => {
      assert.equal(zoneOf(value, bounds), zoneFor(value, bounds));
    });
  }

  it('the mirrored values are the real zone strings, not both-undefined vacuously', () => {
    assert.equal(zoneOf(80, okBounds), 'in');
    assert.equal(zoneOf(77, okBounds), 'below');
    assert.equal(zoneOf(86, okBounds), 'above');
    assert.equal(zoneOf(80, null), 'unknown');
  });
});

// ===========================================================================
// U2 — overlayCandidates (CONTRACT-3.4c: "non-candidate" fixtures updated —
// aggregation 'last' is now itself a candidate, so a genuine non-candidate
// needs a value_shape outside {'boolean','numeric'})
// ===========================================================================

describe('U2 — overlayCandidates', () => {
  it('preserves input order and drops non-candidates', () => {
    const trackables = [
      { id: '3', name: 'C', value_shape: 'boolean' },
      { id: '1', name: 'A', value_shape: 'text' }, // non-candidate: not boolean/numeric
      { id: '2', name: 'B', value_shape: 'numeric', aggregation: 'count' },
    ];
    const result = overlayCandidates(trackables, '999');
    assert.deepEqual(result.map((t) => t.id), ['3', '2']);
  });

  it('excludes the metric when metricId is a number and candidate ids are strings', () => {
    const trackables = [
      { id: 10, name: 'A', value_shape: 'boolean' },
      { id: '20', name: 'B', value_shape: 'boolean' },
      { id: 30, name: 'C', value_shape: 'text' }, // non-candidate
    ];
    const result = overlayCandidates(trackables, '10');
    assert.deepEqual(result.map((t) => t.id), ['20']);
  });

  it('excludes the metric when metricId is a string and the matching candidate id is a number', () => {
    const trackables = [
      { id: 10, name: 'A', value_shape: 'boolean' },
      { id: '20', name: 'B', value_shape: 'boolean' },
      { id: 30, name: 'C', value_shape: 'text' }, // non-candidate
    ];
    const result = overlayCandidates(trackables, 20);
    assert.deepEqual(result.map((t) => t.id), [10]);
  });

  it('non-array -> [], never throws', () => {
    assert.deepEqual(overlayCandidates(null, '1'), []);
    assert.deepEqual(overlayCandidates(undefined, '1'), []);
    assert.deepEqual(overlayCandidates('not-an-array', '1'), []);
    assert.deepEqual(overlayCandidates({}, '1'), []);
  });
});

// ===========================================================================
// U3 — readOverlaySelection (unchanged by 3.4b)
// ===========================================================================

describe('U3 — readOverlaySelection', () => {
  it('round-trips after write', () => {
    const storage = makeStorage();
    writeOverlaySelection(storage, '501', ['601']);
    assert.deepEqual(readOverlaySelection(storage, '501'), ['601']);
  });

  it('returns ids as strings even when stored as numbers', () => {
    const storage = makeStorage({ [OVERLAY_STORAGE_KEY]: JSON.stringify({ 5: [1, 2, 3] }) });
    assert.deepEqual(readOverlaySelection(storage, 5), ['1', '2', '3']);
  });

  it('missing key -> []', () => {
    const storage = makeStorage();
    assert.deepEqual(readOverlaySelection(storage, '501'), []);
  });

  it('bad JSON -> []', () => {
    const storage = makeStorage({ [OVERLAY_STORAGE_KEY]: '{not json' });
    assert.deepEqual(readOverlaySelection(storage, '501'), []);
  });

  it('top-level array -> []', () => {
    const storage = makeStorage({ [OVERLAY_STORAGE_KEY]: JSON.stringify(['601']) });
    assert.deepEqual(readOverlaySelection(storage, '501'), []);
  });

  it('value for the metric not an array -> []', () => {
    const storage = makeStorage({ [OVERLAY_STORAGE_KEY]: JSON.stringify({ 501: 'not-an-array' }) });
    assert.deepEqual(readOverlaySelection(storage, '501'), []);
    const storage2 = makeStorage({ [OVERLAY_STORAGE_KEY]: JSON.stringify({ 501: 123 }) });
    assert.deepEqual(readOverlaySelection(storage2, '501'), []);
  });

  it('storage.getItem throwing -> []', () => {
    assert.deepEqual(readOverlaySelection(throwingGetStorage(), '501'), []);
  });

  it('storage null/undefined -> []', () => {
    assert.deepEqual(readOverlaySelection(null, '501'), []);
    assert.deepEqual(readOverlaySelection(undefined, '501'), []);
  });
});

// ===========================================================================
// U4 — writeOverlaySelection (unchanged by 3.4b)
// ===========================================================================

describe('U4 — writeOverlaySelection', () => {
  it('merges: writing metric B keeps metric A', () => {
    const storage = makeStorage();
    writeOverlaySelection(storage, 'A', ['1']);
    writeOverlaySelection(storage, 'B', ['2']);
    assert.deepEqual(readOverlaySelection(storage, 'A'), ['1']);
    assert.deepEqual(readOverlaySelection(storage, 'B'), ['2']);
  });

  it('overwrites the same metric', () => {
    const storage = makeStorage();
    writeOverlaySelection(storage, 'A', ['1']);
    writeOverlaySelection(storage, 'A', ['3']);
    assert.deepEqual(readOverlaySelection(storage, 'A'), ['3']);
  });

  it('an unreadable existing value is replaced by a fresh object, not left corrupt', () => {
    const storage = makeStorage({ [OVERLAY_STORAGE_KEY]: '{garbage' });
    assert.doesNotThrow(() => writeOverlaySelection(storage, 'A', ['9']));
    assert.deepEqual(readOverlaySelection(storage, 'A'), ['9']);
    const raw = JSON.parse(storage.getItem(OVERLAY_STORAGE_KEY));
    assert.deepEqual(Object.keys(raw), ['A']);
  });

  it('storage.setItem throwing does not throw', () => {
    assert.doesNotThrow(() => writeOverlaySelection(throwingSetStorage(), 'A', ['1']));
  });

  it('storage null does not throw', () => {
    assert.doesNotThrow(() => writeOverlaySelection(null, 'A', ['1']));
    assert.doesNotThrow(() => writeOverlaySelection(undefined, 'A', ['1']));
  });
});

// ===========================================================================
// U5 — sanitizeSelection — CONTRACT-3.4b: cap is now MAX_OVERLAYS = 1
// ===========================================================================

describe('U5 — sanitizeSelection (cap now 1)', () => {
  it('MAX_OVERLAYS is 1', () => {
    assert.equal(MAX_OVERLAYS, 1);
  });

  const candidates = [{ id: '1' }, { id: '2' }, { id: '3' }];

  it('dedupes, first occurrence wins, then caps to 1', () => {
    assert.deepEqual(sanitizeSelection(['3', '3', '1'], candidates), ['3']);
  });

  it('drops ids that are not candidates', () => {
    assert.deepEqual(sanitizeSelection(['9', '1'], candidates), ['1']);
  });

  it('caps at 1, keeping the first survivor in SELECTION order, not candidate order', () => {
    // Selection lists '2' before '1'; candidate list order is '1','2','3' —
    // the survivor must be '2' (selection order), not '1' (candidate order).
    assert.deepEqual(sanitizeSelection(['2', '1'], candidates), ['2']);
  });

  it("CONTRACT-3.4b's own worked example: ['601','603'] -> ['601']", () => {
    const c = [{ id: '601' }, { id: '603' }];
    assert.deepEqual(sanitizeSelection(['601', '603'], c), ['601']);
  });

  it('coerces numeric ids to strings', () => {
    const numericCandidates = [{ id: 1 }, { id: 2 }];
    assert.deepEqual(sanitizeSelection([1], numericCandidates), ['1']);
  });

  it('non-array ids -> [], never throws', () => {
    assert.deepEqual(sanitizeSelection(null, candidates), []);
    assert.deepEqual(sanitizeSelection(undefined, candidates), []);
    assert.deepEqual(sanitizeSelection('nope', candidates), []);
  });
});

// ===========================================================================
// U7 — overlayModel alignment (boolean count trackable)
// ===========================================================================

describe('U7 — overlayModel alignment: boolean count trackable', () => {
  const trackable = { id: 601, name: 'Workout', color: '#bf5af2', value_shape: 'boolean', aggregation: 'count', direction: 'build' };

  it('values are per-bucket day counts (0 where no entry); duplicates dedupe to 1; non-finite value and malformed/out-of-range dates dropped; total sums', () => {
    const keys = rangeDays('2026-01-01', '2026-01-10'); // 10 day-keys
    const entries = [
      { entry_date: '2026-01-02', value: 1 },
      { entry_date: '2026-01-02', value: 1 }, // duplicate entry_date -> counts once
      { entry_date: '2026-01-05', value: NaN }, // non-finite -> dropped entirely
      { entry_date: '2026-99-99', value: 1 }, // malformed date -> dropped
      { entry_date: '2020-01-01', value: 1 }, // outside keys -> ignored
    ];
    const model = overlayModel({ trackable, entries, keys, period: 'day' });
    assert.deepEqual(model.values, [0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(model.total, 1);
    assert.equal(model.id, '601');
    assert.equal(model.name, 'Workout');
    assert.equal(model.color, '#bf5af2');
    assert.equal(model.aggregation, 'count');
    assert.equal(model.direction, 'build');
    // CONTRACT-3.4c: every bar-kind model carries kind:'bar', all-'unknown'
    // zones, and bounds:null when no bounds were given.
    assert.equal(model.kind, 'bar');
    assert.deepEqual(model.zones, model.values.map(() => 'unknown'));
    assert.equal(model.bounds, null);
  });

  it('week granularity: three distinct logged days in one ISO week -> count 3 in that key, 0 in the other', () => {
    const monday = startOfIsoWeek('2026-02-02');
    const week1 = isoWeekKey(monday);
    const monday2 = addDays(monday, 7);
    const week2 = isoWeekKey(monday2);
    const keys = [week1, week2];
    const entries = [
      { entry_date: monday, value: 1 },
      { entry_date: addDays(monday, 1), value: 1 },
      { entry_date: addDays(monday, 2), value: 1 },
    ];
    const model = overlayModel({ trackable, entries, keys, period: 'week' });
    assert.deepEqual(model.values, [3, 0]);
    assert.equal(model.total, 3);
    assert.equal(model.kind, 'bar');
    assert.deepEqual(model.zones, ['unknown', 'unknown']);
    assert.equal(model.bounds, null);
  });
});

// ===========================================================================
// U8 — overlayModel aggregation (sum / average / weekly_average override)
// ===========================================================================

describe('U8 — overlayModel aggregation', () => {
  it("numeric 'sum' trackable sums per bucket; a duplicate entry_date is first-wins, not double-summed", () => {
    const trackable = { id: 701, name: 'Cigs', aggregation: 'sum', direction: 'build' };
    const keys = rangeDays('2026-03-01', '2026-03-03');
    const entries = [
      { entry_date: '2026-03-01', value: 2 },
      { entry_date: '2026-03-01', value: 30 }, // duplicate -> first (2) wins, not summed to 32
      { entry_date: '2026-03-02', value: 4 },
      // 2026-03-03 has no entries -> fillValueFor('sum') = 0
    ];
    const model = overlayModel({ trackable, entries, keys, period: 'day' });
    assert.deepEqual(model.values, [2, 4, 0]);
    assert.equal(model.total, 6);
    // 'sum' aggregation -> bar kind (CONTRACT-3.4c).
    assert.equal(model.kind, 'bar');
    assert.deepEqual(model.zones, ['unknown', 'unknown', 'unknown']);
    assert.equal(model.bounds, null);
  });

  it("numeric 'average' trackable averages per bucket and fills null for an empty bucket", () => {
    const trackable = { id: 702, name: 'Weight', aggregation: 'average', direction: 'build' };
    const keys = rangeDays('2026-03-10', '2026-03-11');
    const entries = [
      { entry_date: '2026-03-10', value: 10 },
      { entry_date: '2026-03-10', value: 999 }, // duplicate -> first (10) wins
      // 2026-03-11: no entries -> fillValueFor('average') = null
    ];
    const model = overlayModel({ trackable, entries, keys, period: 'day' });
    assert.deepEqual(model.values, [10, null]);
    assert.equal(model.total, 10);
    // 'average' aggregation -> LINE kind under CONTRACT-3.4c (see U9c for
    // the dedicated line-kind zone/verdict/target coverage).
    assert.equal(model.kind, 'line');
  });

  it("target_type: 'weekly_average' forces 'average' aggregation regardless of trackable.aggregation", () => {
    const trackable = { id: 703, name: 'Calories', aggregation: 'sum', direction: 'build', target_type: 'weekly_average', target_value: 2000 };
    const monday = startOfIsoWeek('2026-04-06');
    const week1 = isoWeekKey(monday);
    const keys = [week1];
    const entries = [
      { entry_date: monday, value: 10 },
      { entry_date: addDays(monday, 2), value: 20 },
    ];
    const model = overlayModel({ trackable, entries, keys, period: 'week' });
    assert.equal(model.aggregation, 'average');
    // Sum would be 30; average of the two logged days is 15 — proves the
    // override actually changed which aggregation ran, not just the label.
    assert.deepEqual(model.values, [15]);
    // Forced to 'average' -> LINE kind under CONTRACT-3.4c, regardless of
    // trackable.aggregation being 'sum'.
    assert.equal(model.kind, 'line');
  });
});

// ===========================================================================
// U9 — overlayModel target + verdicts
// ===========================================================================

describe('U9 — overlayModel target + verdicts', () => {
  it('weekly_count 3, direction build, week values [3,2,4] -> verdicts [good,bad,good], target.value 3', () => {
    const trackable = { id: 601, name: 'Workout', aggregation: 'count', direction: 'build', target_type: 'weekly_count', target_value: 3 };
    const monday = startOfIsoWeek('2026-05-04');
    const week1 = isoWeekKey(monday);
    const week2 = isoWeekKey(addDays(monday, 7));
    const week3 = isoWeekKey(addDays(monday, 14));
    const keys = [week1, week2, week3];
    // week1: 3 distinct logged days, week2: 2, week3: 4.
    const entries = [
      { entry_date: monday, value: 1 },
      { entry_date: addDays(monday, 1), value: 1 },
      { entry_date: addDays(monday, 2), value: 1 },
      { entry_date: addDays(monday, 7), value: 1 },
      { entry_date: addDays(monday, 8), value: 1 },
      { entry_date: addDays(monday, 14), value: 1 },
      { entry_date: addDays(monday, 15), value: 1 },
      { entry_date: addDays(monday, 16), value: 1 },
      { entry_date: addDays(monday, 17), value: 1 },
    ];
    const model = overlayModel({ trackable, entries, keys, period: 'week' });
    assert.deepEqual(model.values, [3, 2, 4]);
    assert.deepEqual(model.target, targetFor(trackable, 'week'));
    assert.equal(model.target.value, 3);
    assert.deepEqual(model.verdicts, ['good', 'bad', 'good']);
    assert.equal(model.kind, 'bar');
    assert.deepEqual(model.zones, ['unknown', 'unknown', 'unknown']);
    assert.equal(model.bounds, null);
  });

  it("period 'month' scales a weekly_count target up (>3), and verdicts compare against the scaled value", () => {
    const trackable = { id: 704, name: 'Sum thing', aggregation: 'sum', direction: 'build', target_type: 'weekly_count', target_value: 3 };
    const keys = ['2026-05', '2026-06'];
    const entries = [
      { entry_date: '2026-05-10', value: 15 },
      { entry_date: '2026-06-10', value: 5 },
    ];
    const model = overlayModel({ trackable, entries, keys, period: 'month' });
    assert.deepEqual(model.values, [15, 5]);
    const expectedTarget = targetFor(trackable, 'month');
    assert.equal(model.target.value, expectedTarget.value);
    assert.ok(model.target.value > 3);
    assert.deepEqual(model.verdicts, [
      weekVerdict(15, expectedTarget, 'build'),
      weekVerdict(5, expectedTarget, 'build'),
    ]);
    assert.deepEqual(model.verdicts, ['good', 'bad']);
    assert.equal(model.kind, 'bar');
    assert.deepEqual(model.zones, ['unknown', 'unknown']);
    assert.equal(model.bounds, null);
  });

  it("period 'day' -> target null and every verdict 'none' for a weekly_count trackable", () => {
    const trackable = { id: 601, name: 'Workout', aggregation: 'count', direction: 'build', target_type: 'weekly_count', target_value: 3 };
    const keys = rangeDays('2026-01-01', '2026-01-02');
    const entries = [{ entry_date: '2026-01-01', value: 1 }];
    const model = overlayModel({ trackable, entries, keys, period: 'day' });
    assert.equal(model.target, null);
    assert.deepEqual(model.verdicts, ['none', 'none']);
    assert.equal(model.kind, 'bar');
    assert.deepEqual(model.zones, ['unknown', 'unknown']);
    assert.equal(model.bounds, null);
  });

  it("direction 'break' with weekly_count 1, values [0,2] -> verdicts [good,bad] (under-target is good)", () => {
    const trackable = { id: 705, name: 'Smoking', aggregation: 'sum', direction: 'break', target_type: 'weekly_count', target_value: 1 };
    const monday = startOfIsoWeek('2026-06-01');
    const week1 = isoWeekKey(monday);
    const week2 = isoWeekKey(addDays(monday, 7));
    const keys = [week1, week2];
    const entries = [
      // week1: no entries -> fillValueFor('sum') = 0
      { entry_date: addDays(monday, 8), value: 2 }, // week2: sum 2
    ];
    const model = overlayModel({ trackable, entries, keys, period: 'week' });
    assert.deepEqual(model.values, [0, 2]);
    assert.deepEqual(model.verdicts, ['good', 'bad']);
    assert.equal(model.kind, 'bar');
    assert.deepEqual(model.zones, ['unknown', 'unknown']);
    assert.equal(model.bounds, null);
  });

  it('no target -> every verdict is none regardless of values', () => {
    const trackable = { id: 706, name: 'Untargeted', aggregation: 'count', direction: 'build' };
    const keys = rangeDays('2026-01-01', '2026-01-02');
    const entries = [{ entry_date: '2026-01-01', value: 1 }];
    const model = overlayModel({ trackable, entries, keys, period: 'day' });
    assert.equal(model.target, null);
    assert.deepEqual(model.verdicts, ['none', 'none']);
    assert.equal(model.kind, 'bar');
    assert.deepEqual(model.zones, ['unknown', 'unknown']);
    assert.equal(model.bounds, null);
  });
});

// ===========================================================================
// U9b — overlayModel degenerate inputs
// ===========================================================================

describe('U9b — overlayModel degenerate inputs', () => {
  it('trackable null -> id "" name "" color null unit null, and behaves like an empty/fill series', () => {
    const model = overlayModel({ trackable: null, entries: [], keys: ['2026-01-01'], period: 'day' });
    assert.equal(model.id, '');
    assert.equal(model.name, '');
    assert.equal(model.color, null);
    assert.equal(model.unit, null);
    assert.equal(model.values.length, 1);
    assert.equal(model.total, 0);
  });

  it('unit "" -> null (non-empty-string rule)', () => {
    const model = overlayModel({ trackable: { id: 5, name: 'Y', unit: '' }, entries: [], keys: ['2026-01-01'], period: 'day' });
    assert.equal(model.unit, null);
  });

  it('entries non-array -> all fill values (sum/count -> 0, average/last -> null)', () => {
    const sumModel = overlayModel({
      trackable: { id: 1, name: 'A', aggregation: 'sum' },
      entries: null,
      keys: ['2026-01-01', '2026-01-02'],
      period: 'day',
    });
    assert.deepEqual(sumModel.values, [0, 0]);
    assert.equal(sumModel.total, 0);

    const avgModel = overlayModel({
      trackable: { id: 1, name: 'A', aggregation: 'average' },
      entries: undefined,
      keys: ['2026-01-01', '2026-01-02'],
      period: 'day',
    });
    assert.deepEqual(avgModel.values, [null, null]);
    assert.equal(avgModel.total, 0);
  });

  it('keys [] -> values [] and total 0', () => {
    const model = overlayModel({
      trackable: { id: 1, name: 'A' },
      entries: [{ entry_date: '2026-01-01', value: 1 }],
      keys: [],
      period: 'day',
    });
    assert.deepEqual(model.values, []);
    assert.equal(model.total, 0);
  });

  it('never throws for garbage entries (numbers, null, missing fields)', () => {
    const entries = [1, 2, null, 'foo', { entry_date: 123 }, { entry_date: '2026-01-01' }];
    assert.doesNotThrow(() => {
      const model = overlayModel({ trackable: { id: 1, name: 'A', aggregation: 'sum' }, entries, keys: ['2026-01-01'], period: 'day' });
      assert.deepEqual(model.values, [0]);
      assert.equal(model.total, 0);
    });
  });
});

// ===========================================================================
// U9c — overlayModel LINE kind (CONTRACT-3.4c: aggregation 'last', a
// continuous reading like Weight, judged by its own band rather than a
// target)
// ===========================================================================

describe('U9c — overlayModel line kind: aggregation "last", bounds-driven zones/verdicts', () => {
  const trackable = { id: 601, name: 'Weight', color: '#0a84ff', unit: 'kg', value_shape: 'numeric', aggregation: 'last', direction: 'break' };

  // Four week buckets engineered to hit each zone once: week1 resolves via
  // 'last' semantics (two entries, LATER date wins — 77, not an average of
  // 100 and 77 — proving overlayModel really delegates to rollup('last')
  // rather than reimplementing it); week2/3 are single-entry in/above;
  // week4 has no entries at all -> fillValueFor('last') = null.
  const monday = startOfIsoWeek('2026-07-06');
  const week1 = isoWeekKey(monday);
  const week2 = isoWeekKey(addDays(monday, 7));
  const week3 = isoWeekKey(addDays(monday, 14));
  const week4 = isoWeekKey(addDays(monday, 21));
  const keys = [week1, week2, week3, week4];
  const entries = [
    { entry_date: monday, value: 100 }, // week1, earlier date
    { entry_date: addDays(monday, 2), value: 77 }, // week1, LATER date -> 'last' picks this
    { entry_date: addDays(monday, 7), value: 80 }, // week2
    { entry_date: addDays(monday, 14), value: 86 }, // week3
    // week4: no entries -> null
  ];

  it("aggregation 'last' resolves per bucket via rollup (later date wins, not an average); empty bucket -> null", () => {
    const model = overlayModel({ trackable, entries, keys, period: 'week', bounds: null });
    assert.deepEqual(model.values, [77, 80, 86, null]);
    assert.equal(model.kind, 'line');
  });

  it("with bounds { status: 'ok', lower: 78, upper: 85 }: zones/verdicts per value (77 below/bad, 80 in/good, 86 above/bad, null unknown/none); target always null for line kind", () => {
    const bounds = { status: 'ok', lower: 78, upper: 85 };
    const model = overlayModel({ trackable, entries, keys, period: 'week', bounds });
    assert.deepEqual(model.values, [77, 80, 86, null]);
    assert.deepEqual(model.zones, ['below', 'in', 'above', 'unknown']);
    assert.deepEqual(model.verdicts, ['bad', 'good', 'bad', 'none']);
    assert.equal(model.target, null);
    assert.deepEqual(model.bounds, bounds);
  });

  it("with bounds { status: 'insufficient' }: every zone/verdict is unknown/none regardless of value; target null", () => {
    const bounds = { status: 'insufficient', lower: null, upper: null };
    const model = overlayModel({ trackable, entries, keys, period: 'week', bounds });
    assert.deepEqual(model.values, [77, 80, 86, null]);
    assert.deepEqual(model.zones, ['unknown', 'unknown', 'unknown', 'unknown']);
    assert.deepEqual(model.verdicts, ['none', 'none', 'none', 'none']);
    assert.equal(model.target, null);
    assert.deepEqual(model.bounds, bounds);
  });
});

// ===========================================================================
// U10 — withAlpha
// ===========================================================================

describe('U10 — withAlpha', () => {
  it("'#fff' -> 'rgba(255, 255, 255, 0.55)'", () => {
    assert.equal(withAlpha('#fff', 0.55), 'rgba(255, 255, 255, 0.55)');
  });

  it("'#34c759' -> 'rgba(52, 199, 89, 0.55)'", () => {
    assert.equal(withAlpha('#34c759', 0.55), 'rgba(52, 199, 89, 0.55)');
  });

  it("'rgb(1,2,3)' is returned unchanged", () => {
    assert.equal(withAlpha('rgb(1,2,3)', 0.55), 'rgb(1,2,3)');
  });

  it('non-string -> rgba(0, 0, 0, alpha)', () => {
    assert.equal(withAlpha(null, 0.55), 'rgba(0, 0, 0, 0.55)');
    assert.equal(withAlpha(undefined, 0.55), 'rgba(0, 0, 0, 0.55)');
    assert.equal(withAlpha(42, 0.55), 'rgba(0, 0, 0, 0.55)');
  });

  it('OVERLAY_BAR_ALPHA is 0.55', () => {
    assert.equal(OVERLAY_BAR_ALPHA, 0.55);
  });
});

// ===========================================================================
// U11 — overlayAxisFor
// ===========================================================================

describe('U11 — overlayAxisFor (kind: "bar", as 3.4b)', () => {
  it('values [3,2,4] target 3 -> suggestedMax ceil(4*1.15)=5 (integer rounding for count-like data)', () => {
    const model = { kind: 'bar', values: [3, 2, 4], target: { value: 3 }, aggregation: 'count' };
    const axis = overlayAxisFor(model);
    assert.equal(axis.min, 0);
    assert.equal(axis.suggestedMax, 5);
  });

  it('values [1] target 12 -> suggestedMax ceil(12*1.15)=14', () => {
    const model = { kind: 'bar', values: [1], target: { value: 12 }, aggregation: 'count' };
    const axis = overlayAxisFor(model);
    assert.equal(axis.suggestedMax, 14);
  });

  it('all null, no target -> min 0, suggestedMax ceil(1*1.15)=2', () => {
    const model = { kind: 'bar', values: [null, null], target: null, aggregation: 'average' };
    const axis = overlayAxisFor(model);
    assert.equal(axis.min, 0);
    assert.equal(axis.suggestedMax, 2);
  });

  it('never throws on garbage', () => {
    assert.doesNotThrow(() => overlayAxisFor(null));
    assert.doesNotThrow(() => overlayAxisFor(undefined));
    assert.doesNotThrow(() => overlayAxisFor({}));
    assert.doesNotThrow(() => overlayAxisFor({ values: 'nope', target: 'nope' }));
  });
});

// ===========================================================================
// U11b — overlayAxisFor (kind: "line", CONTRACT-3.4c: frames the data,
// never forced to zero)
// ===========================================================================

describe('U11b — overlayAxisFor (kind: "line")', () => {
  it('values [79,81,80], no bounds -> span 2, pad 10% (0.2) -> suggestedMin 78.8, suggestedMax 81.2', () => {
    const model = { kind: 'line', values: [79, 81, 80], bounds: null };
    const axis = overlayAxisFor(model);
    assert.ok(Math.abs(axis.suggestedMin - 78.8) < 1e-9, `expected ~78.8, got ${axis.suggestedMin}`);
    assert.ok(Math.abs(axis.suggestedMax - 81.2) < 1e-9, `expected ~81.2, got ${axis.suggestedMax}`);
  });

  it('with ok bounds 78/85 widening the candidate range -> suggestedMin 78 - 0.7, suggestedMax 85 + 0.7', () => {
    // lo/hi become 78/85 (the bounds, since they're wider than the values);
    // span 7, pad 10% = 0.7.
    const model = { kind: 'line', values: [79, 81, 80], bounds: { status: 'ok', lower: 78, upper: 85 } };
    const axis = overlayAxisFor(model);
    assert.ok(Math.abs(axis.suggestedMin - (78 - 0.7)) < 1e-9, `expected ~77.3, got ${axis.suggestedMin}`);
    assert.ok(Math.abs(axis.suggestedMax - (85 + 0.7)) < 1e-9, `expected ~85.7, got ${axis.suggestedMax}`);
  });

  it('a single value 80 (flat/degenerate span) -> padded +/-1: suggestedMin 79, suggestedMax 81', () => {
    const model = { kind: 'line', values: [80], bounds: null };
    const axis = overlayAxisFor(model);
    assert.equal(axis.suggestedMin, 79);
    assert.equal(axis.suggestedMax, 81);
  });

  it('all null, no bounds -> no candidates -> suggestedMin/suggestedMax both undefined', () => {
    const model = { kind: 'line', values: [null, null], bounds: null };
    const axis = overlayAxisFor(model);
    assert.equal(axis.suggestedMin, undefined);
    assert.equal(axis.suggestedMax, undefined);
  });
});

// ===========================================================================
// U12 — overlayAxisTitle
// ===========================================================================

describe('U12 — overlayAxisTitle (kind: "bar", as 3.4b)', () => {
  it("count aggregation, no unit -> 'days' / 'days / week' / 'days / month'", () => {
    const model = { kind: 'bar', unit: null, aggregation: 'count' };
    assert.equal(overlayAxisTitle(model, 'day'), 'days');
    assert.equal(overlayAxisTitle(model, 'week'), 'days / week');
    assert.equal(overlayAxisTitle(model, 'month'), 'days / month');
  });

  it("unit 'cigarettes' -> 'cigarettes / week'", () => {
    const model = { kind: 'bar', unit: 'cigarettes', aggregation: 'sum' };
    assert.equal(overlayAxisTitle(model, 'week'), 'cigarettes / week');
  });

  it("no unit, sum aggregation, week/month -> 'per week' / 'per month'", () => {
    const model = { kind: 'bar', unit: null, aggregation: 'sum' };
    assert.equal(overlayAxisTitle(model, 'week'), 'per week');
    assert.equal(overlayAxisTitle(model, 'month'), 'per month');
  });

  it("no unit, sum aggregation, day -> '' (base, unmodified)", () => {
    const model = { kind: 'bar', unit: null, aggregation: 'sum' };
    assert.equal(overlayAxisTitle(model, 'day'), '');
  });
});

// ===========================================================================
// U12b — overlayAxisTitle (kind: "line")
// ===========================================================================

describe('U12b — overlayAxisTitle (kind: "line")', () => {
  it("unit 'kg' -> 'kg' at every period (day/week/month) — a weekly AVERAGE of kg is still kg", () => {
    const model = { kind: 'line', unit: 'kg' };
    assert.equal(overlayAxisTitle(model, 'day'), 'kg');
    assert.equal(overlayAxisTitle(model, 'week'), 'kg');
    assert.equal(overlayAxisTitle(model, 'month'), 'kg');
  });

  it("no unit -> 'value' at every period", () => {
    const model = { kind: 'line', unit: null };
    assert.equal(overlayAxisTitle(model, 'day'), 'value');
    assert.equal(overlayAxisTitle(model, 'week'), 'value');
    assert.equal(overlayAxisTitle(model, 'month'), 'value');
  });
});

// ===========================================================================
// U13 — overlayTooltipLabel
// ===========================================================================

describe('U13 — overlayTooltipLabel (kind: "bar", as 3.4b)', () => {
  it('value 4, target 3 -> "Workout · 4 of 3"', () => {
    const model = { kind: 'bar', name: 'Workout', values: [4], target: { value: 3 } };
    assert.equal(overlayTooltipLabel(model, 0), 'Workout · 4 of 3');
  });

  it('value 12, target 13.035 -> "Workout · 12 of 13" (target rounds to one decimal / whole)', () => {
    const model = { kind: 'bar', name: 'Workout', values: [12], target: { value: 13.035 } };
    assert.equal(overlayTooltipLabel(model, 0), 'Workout · 12 of 13');
  });

  it('no target -> "Workout · 4"', () => {
    const model = { kind: 'bar', name: 'Workout', values: [4], target: null };
    assert.equal(overlayTooltipLabel(model, 0), 'Workout · 4');
  });

  it('null value -> "Workout · —"', () => {
    const model = { kind: 'bar', name: 'Workout', values: [null], target: { value: 3 } };
    assert.equal(overlayTooltipLabel(model, 0), 'Workout · —');
  });

  it('out-of-range index -> "Workout · —"', () => {
    const model = { kind: 'bar', name: 'Workout', values: [4], target: { value: 3 } };
    assert.equal(overlayTooltipLabel(model, 99), 'Workout · —');
    assert.equal(overlayTooltipLabel(model, -1), 'Workout · —');
  });
});

// ===========================================================================
// U13b — overlayTooltipLabel (kind: "line")
// ===========================================================================

describe('U13b — overlayTooltipLabel (kind: "line")', () => {
  it('80.44 kg, zone "in" -> "Weight · 80.4 kg · in range" (value rounds to one decimal)', () => {
    const model = { kind: 'line', name: 'Weight', unit: 'kg', values: [80.44], zones: ['in'] };
    assert.equal(overlayTooltipLabel(model, 0), 'Weight · 80.4 kg · in range');
  });

  it('86, zone "above" -> "Weight · 86 kg · above"', () => {
    const model = { kind: 'line', name: 'Weight', unit: 'kg', values: [86], zones: ['above'] };
    assert.equal(overlayTooltipLabel(model, 0), 'Weight · 86 kg · above');
  });

  it('77, zone "below" -> "Weight · 77 kg · below"', () => {
    const model = { kind: 'line', name: 'Weight', unit: 'kg', values: [77], zones: ['below'] };
    assert.equal(overlayTooltipLabel(model, 0), 'Weight · 77 kg · below');
  });

  it('no bounds (zone "unknown") -> plain value, no zone suffix: "Weight · 80.4 kg"', () => {
    const model = { kind: 'line', name: 'Weight', unit: 'kg', values: [80.44], zones: ['unknown'] };
    assert.equal(overlayTooltipLabel(model, 0), 'Weight · 80.4 kg');
  });

  it('null value -> "Weight · —"', () => {
    const model = { kind: 'line', name: 'Weight', unit: 'kg', values: [null], zones: ['unknown'] };
    assert.equal(overlayTooltipLabel(model, 0), 'Weight · —');
  });

  it('no unit -> value only, no trailing unit', () => {
    const model = { kind: 'line', name: 'Weight', unit: null, values: [80], zones: ['in'] };
    assert.equal(overlayTooltipLabel(model, 0), 'Weight · 80 · in range');
  });
});

// ===========================================================================
// U14 — overlayTargetAnnotation
// ===========================================================================

describe('U14 — overlayTargetAnnotation (kind: "bar", as 3.4b)', () => {
  it('exact shape, including scaleID "yOverlay" and the raw target value', () => {
    const model = { kind: 'bar', name: 'Workout', color: '#bf5af2', target: { value: 3 } };
    const ann = overlayTargetAnnotation(model, '#000000');
    assert.deepEqual(ann, {
      type: 'line',
      scaleID: 'yOverlay',
      value: 3,
      borderColor: '#bf5af2',
      borderWidth: 1,
      borderDash: [4, 4],
      label: {
        display: true,
        content: 'Workout 3',
        position: 'end',
        backgroundColor: '#bf5af2',
      },
    });
  });

  it('rounds the label content the same way overlayTooltipLabel does', () => {
    const model = { kind: 'bar', name: 'Workout', color: '#bf5af2', target: { value: 13.035 } };
    const ann = overlayTargetAnnotation(model, '#000000');
    assert.equal(ann.label.content, 'Workout 13');
  });

  it('null when target is null', () => {
    const model = { kind: 'bar', name: 'Workout', color: '#bf5af2', target: null };
    assert.equal(overlayTargetAnnotation(model, '#000000'), null);
  });

  it('falls back to the passed-in colour when model.color is missing', () => {
    const model = { kind: 'bar', name: 'Workout', color: null, target: { value: 3 } };
    const ann = overlayTargetAnnotation(model, '#123456');
    assert.equal(ann.borderColor, '#123456');
    assert.equal(ann.label.backgroundColor, '#123456');
  });
});

// ===========================================================================
// U14b — overlayTargetAnnotation (kind: "line" -> always null) and
// overlayBoundAnnotations (NEW in 3.4c)
// ===========================================================================

describe('U14b — overlayTargetAnnotation (line -> null) / overlayBoundAnnotations', () => {
  it('overlayTargetAnnotation is null for kind "line", even with a (nonsensical) target present', () => {
    const model = { kind: 'line', name: 'Weight', color: '#0a84ff', target: { value: 80 } };
    assert.equal(overlayTargetAnnotation(model, '#000000'), null);
  });

  it('overlayBoundAnnotations: exact shape for kind "line" with ok bounds', () => {
    const model = { kind: 'line', name: 'Weight', color: '#0a84ff', bounds: { status: 'ok', lower: 78, upper: 85 } };
    const anns = overlayBoundAnnotations(model, '#000000');
    assert.deepEqual(anns, {
      overlayLower: {
        type: 'line',
        scaleID: 'yOverlay',
        value: 78,
        borderColor: '#0a84ff',
        borderWidth: 1,
        borderDash: [4, 4],
        label: { display: true, content: '78', position: 'end', backgroundColor: '#0a84ff' },
      },
      overlayUpper: {
        type: 'line',
        scaleID: 'yOverlay',
        value: 85,
        borderColor: '#0a84ff',
        borderWidth: 1,
        borderDash: [4, 4],
        label: { display: true, content: '85', position: 'end', backgroundColor: '#0a84ff' },
      },
    });
  });

  it('overlayBoundAnnotations falls back to the passed-in colour when model.color is missing', () => {
    const model = { kind: 'line', name: 'Weight', color: null, bounds: { status: 'ok', lower: 78, upper: 85 } };
    const anns = overlayBoundAnnotations(model, '#123456');
    assert.equal(anns.overlayLower.borderColor, '#123456');
    assert.equal(anns.overlayUpper.label.backgroundColor, '#123456');
  });

  it('overlayBoundAnnotations is {} for kind "bar" (even with bounds present)', () => {
    const model = { kind: 'bar', name: 'Workout', color: '#bf5af2', bounds: { status: 'ok', lower: 1, upper: 3 } };
    assert.deepEqual(overlayBoundAnnotations(model, '#000000'), {});
  });

  it('overlayBoundAnnotations is {} for kind "line" with no bounds', () => {
    const model = { kind: 'line', name: 'Weight', color: '#0a84ff', bounds: null };
    assert.deepEqual(overlayBoundAnnotations(model, '#000000'), {});
  });

  it('overlayBoundAnnotations is {} for kind "line" with a non-ok bounds status', () => {
    const model = { kind: 'line', name: 'Weight', color: '#0a84ff', bounds: { status: 'insufficient', lower: null, upper: null } };
    assert.deepEqual(overlayBoundAnnotations(model, '#000000'), {});
  });
});

// ===========================================================================
// U15 — overlayDatasets
// ===========================================================================

describe('U15 — overlayDatasets (kind: "bar", as 3.4b)', () => {
  it('exact bar-dataset shape: type, yAxisID, data===values, per-bucket colours by verdict, label', () => {
    const models = [
      { kind: 'bar', name: 'Workout', color: '#bf5af2', values: [3, 2, 4], verdicts: ['good', 'bad', 'none'] },
    ];
    const colors = { good: '#34c759', bad: '#ff6b6b', fallback: '#999999' };
    const datasets = overlayDatasets(models, colors);

    assert.equal(datasets.length, 1);
    const ds = datasets[0];

    const expectedKeys = [
      'type',
      'label',
      'yAxisID',
      'data',
      'backgroundColor',
      'borderColor',
      'borderWidth',
      'barPercentage',
      'categoryPercentage',
      'order',
    ].sort();
    assert.deepEqual(Object.keys(ds).sort(), expectedKeys);

    assert.equal(ds.type, 'bar');
    assert.equal(ds.label, 'Workout');
    assert.equal(ds.yAxisID, 'yOverlay');
    assert.deepEqual(ds.data, [3, 2, 4]);

    const expectedBg = [
      withAlpha(colors.good, OVERLAY_BAR_ALPHA),
      withAlpha(colors.bad, OVERLAY_BAR_ALPHA),
      withAlpha('#bf5af2', OVERLAY_BAR_ALPHA), // verdict 'none' -> model.color
    ];
    assert.deepEqual(ds.backgroundColor, expectedBg);
    assert.deepEqual(ds.borderColor, [colors.good, colors.bad, '#bf5af2']); // same colours, no alpha
    assert.equal(ds.borderWidth, 1);
    assert.equal(ds.barPercentage, 0.7);
    assert.equal(ds.categoryPercentage, 0.8);
    assert.equal(ds.order, 2);
  });

  it("verdict 'none' with no model.color falls back to colors.fallback", () => {
    const models = [{ kind: 'bar', name: 'X', color: null, values: [1], verdicts: ['none'] }];
    const colors = { good: '#34c759', bad: '#ff6b6b', fallback: '#999999' };
    const datasets = overlayDatasets(models, colors);
    assert.deepEqual(datasets[0].backgroundColor, [withAlpha('#999999', OVERLAY_BAR_ALPHA)]);
    assert.deepEqual(datasets[0].borderColor, ['#999999']);
  });

  it('non-array models -> [], never throws', () => {
    assert.deepEqual(overlayDatasets(null, { good: '#0f0', bad: '#f00', fallback: '#000' }), []);
    assert.deepEqual(overlayDatasets(undefined, { good: '#0f0', bad: '#f00', fallback: '#000' }), []);
    assert.deepEqual(overlayDatasets('nope', { good: '#0f0', bad: '#f00', fallback: '#000' }), []);
  });
});

// ===========================================================================
// U15b — overlayDatasets (kind: "line", CONTRACT-3.4c)
// ===========================================================================

describe('U15b — overlayDatasets (kind: "line")', () => {
  it('exact line-dataset shape: type, yAxisID, data===values, borderDash [4,3], point colours by verdict, spanGaps false', () => {
    const models = [
      { kind: 'line', name: 'Weight', color: '#0a84ff', values: [77, 80, null], verdicts: ['bad', 'good', 'none'] },
    ];
    const colors = { good: '#34c759', bad: '#ff6b6b', fallback: '#999999' };
    const datasets = overlayDatasets(models, colors);

    assert.equal(datasets.length, 1);
    const ds = datasets[0];

    const expectedKeys = [
      'type',
      'label',
      'yAxisID',
      'data',
      'borderColor',
      'backgroundColor',
      'borderDash',
      'borderWidth',
      'tension',
      'spanGaps',
      'fill',
      'pointRadius',
      'pointHoverRadius',
      'pointBackgroundColor',
      'pointBorderColor',
      'order',
    ].sort();
    assert.deepEqual(Object.keys(ds).sort(), expectedKeys);

    assert.equal(ds.type, 'line');
    assert.equal(ds.label, 'Weight');
    assert.equal(ds.yAxisID, 'yOverlay');
    assert.deepEqual(ds.data, [77, 80, null]);
    assert.equal(ds.borderColor, '#0a84ff');
    assert.equal(ds.backgroundColor, withAlpha('#0a84ff', OVERLAY_BAR_ALPHA));
    assert.deepEqual(ds.borderDash, [4, 3]);
    assert.equal(ds.borderWidth, 2);
    assert.equal(ds.tension, 0);
    assert.equal(ds.spanGaps, false);
    assert.equal(ds.fill, false);
    assert.equal(ds.pointRadius, 3);
    assert.equal(ds.pointHoverRadius, 4);
    assert.deepEqual(ds.pointBackgroundColor, [colors.bad, colors.good, '#0a84ff']);
    assert.deepEqual(ds.pointBorderColor, [colors.bad, colors.good, '#0a84ff']);
    assert.equal(ds.order, 1);
  });

  it('colour falls back to colors.fallback when model.color is missing', () => {
    const models = [{ kind: 'line', name: 'Weight', color: null, values: [80], verdicts: ['none'] }];
    const colors = { good: '#34c759', bad: '#ff6b6b', fallback: '#999999' };
    const datasets = overlayDatasets(models, colors);
    assert.equal(datasets[0].borderColor, '#999999');
    assert.deepEqual(datasets[0].pointBackgroundColor, ['#999999']);
  });
});
