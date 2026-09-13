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
  withAlpha,
  overlayAxisFor,
  overlayAxisTitle,
  overlayTooltipLabel,
  overlayTargetAnnotation,
  overlayDatasets,
} from '../../js/charts/overlay.js';
import { rangeDays, isoWeekKey, startOfIsoWeek, addDays } from '../../js/dates.js';
import { targetFor, weekVerdict } from '../../js/charts/weekly.js';

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
// U1 — isOverlayCandidate (unchanged by 3.4b)
// ===========================================================================

describe('U1 — isOverlayCandidate', () => {
  it('boolean -> true', () => {
    assert.equal(isOverlayCandidate({ value_shape: 'boolean', archived: false }), true);
  });

  it('numeric + count -> true', () => {
    assert.equal(isOverlayCandidate({ value_shape: 'numeric', aggregation: 'count', archived: false }), true);
  });

  it('numeric + sum -> true', () => {
    assert.equal(isOverlayCandidate({ value_shape: 'numeric', aggregation: 'sum', archived: false }), true);
  });

  it('numeric + average -> false', () => {
    assert.equal(isOverlayCandidate({ value_shape: 'numeric', aggregation: 'average', archived: false }), false);
  });

  it('numeric + last -> false', () => {
    assert.equal(isOverlayCandidate({ value_shape: 'numeric', aggregation: 'last', archived: false }), false);
  });

  it('archived boolean -> false', () => {
    assert.equal(isOverlayCandidate({ value_shape: 'boolean', archived: true }), false);
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
// U2 — overlayCandidates (unchanged by 3.4b)
// ===========================================================================

describe('U2 — overlayCandidates', () => {
  it('preserves input order and drops non-candidates', () => {
    const trackables = [
      { id: '3', name: 'C', value_shape: 'boolean' },
      { id: '1', name: 'A', value_shape: 'numeric', aggregation: 'last' }, // non-candidate
      { id: '2', name: 'B', value_shape: 'numeric', aggregation: 'count' },
    ];
    const result = overlayCandidates(trackables, '999');
    assert.deepEqual(result.map((t) => t.id), ['3', '2']);
  });

  it('excludes the metric when metricId is a number and candidate ids are strings', () => {
    const trackables = [
      { id: 10, name: 'A', value_shape: 'boolean' },
      { id: '20', name: 'B', value_shape: 'boolean' },
      { id: 30, name: 'C', value_shape: 'numeric', aggregation: 'last' },
    ];
    const result = overlayCandidates(trackables, '10');
    assert.deepEqual(result.map((t) => t.id), ['20']);
  });

  it('excludes the metric when metricId is a string and the matching candidate id is a number', () => {
    const trackables = [
      { id: 10, name: 'A', value_shape: 'boolean' },
      { id: '20', name: 'B', value_shape: 'boolean' },
      { id: 30, name: 'C', value_shape: 'numeric', aggregation: 'last' },
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
  });

  it("period 'day' -> target null and every verdict 'none' for a weekly_count trackable", () => {
    const trackable = { id: 601, name: 'Workout', aggregation: 'count', direction: 'build', target_type: 'weekly_count', target_value: 3 };
    const keys = rangeDays('2026-01-01', '2026-01-02');
    const entries = [{ entry_date: '2026-01-01', value: 1 }];
    const model = overlayModel({ trackable, entries, keys, period: 'day' });
    assert.equal(model.target, null);
    assert.deepEqual(model.verdicts, ['none', 'none']);
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
  });

  it('no target -> every verdict is none regardless of values', () => {
    const trackable = { id: 706, name: 'Untargeted', aggregation: 'count', direction: 'build' };
    const keys = rangeDays('2026-01-01', '2026-01-02');
    const entries = [{ entry_date: '2026-01-01', value: 1 }];
    const model = overlayModel({ trackable, entries, keys, period: 'day' });
    assert.equal(model.target, null);
    assert.deepEqual(model.verdicts, ['none', 'none']);
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

describe('U11 — overlayAxisFor', () => {
  it('values [3,2,4] target 3 -> suggestedMax ceil(4*1.15)=5 (integer rounding for count-like data)', () => {
    const model = { values: [3, 2, 4], target: { value: 3 }, aggregation: 'count' };
    const axis = overlayAxisFor(model);
    assert.equal(axis.min, 0);
    assert.equal(axis.suggestedMax, 5);
  });

  it('values [1] target 12 -> suggestedMax ceil(12*1.15)=14', () => {
    const model = { values: [1], target: { value: 12 }, aggregation: 'count' };
    const axis = overlayAxisFor(model);
    assert.equal(axis.suggestedMax, 14);
  });

  it('all null, no target -> min 0, suggestedMax ceil(1*1.15)=2', () => {
    const model = { values: [null, null], target: null, aggregation: 'average' };
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
// U12 — overlayAxisTitle
// ===========================================================================

describe('U12 — overlayAxisTitle', () => {
  it("count aggregation, no unit -> 'days' / 'days / week' / 'days / month'", () => {
    const model = { unit: null, aggregation: 'count' };
    assert.equal(overlayAxisTitle(model, 'day'), 'days');
    assert.equal(overlayAxisTitle(model, 'week'), 'days / week');
    assert.equal(overlayAxisTitle(model, 'month'), 'days / month');
  });

  it("unit 'cigarettes' -> 'cigarettes / week'", () => {
    const model = { unit: 'cigarettes', aggregation: 'sum' };
    assert.equal(overlayAxisTitle(model, 'week'), 'cigarettes / week');
  });

  it("no unit, sum aggregation, week/month -> 'per week' / 'per month'", () => {
    const model = { unit: null, aggregation: 'sum' };
    assert.equal(overlayAxisTitle(model, 'week'), 'per week');
    assert.equal(overlayAxisTitle(model, 'month'), 'per month');
  });

  it("no unit, sum aggregation, day -> '' (base, unmodified)", () => {
    const model = { unit: null, aggregation: 'sum' };
    assert.equal(overlayAxisTitle(model, 'day'), '');
  });
});

// ===========================================================================
// U13 — overlayTooltipLabel
// ===========================================================================

describe('U13 — overlayTooltipLabel', () => {
  it('value 4, target 3 -> "Workout · 4 of 3"', () => {
    const model = { name: 'Workout', values: [4], target: { value: 3 } };
    assert.equal(overlayTooltipLabel(model, 0), 'Workout · 4 of 3');
  });

  it('value 12, target 13.035 -> "Workout · 12 of 13" (target rounds to one decimal / whole)', () => {
    const model = { name: 'Workout', values: [12], target: { value: 13.035 } };
    assert.equal(overlayTooltipLabel(model, 0), 'Workout · 12 of 13');
  });

  it('no target -> "Workout · 4"', () => {
    const model = { name: 'Workout', values: [4], target: null };
    assert.equal(overlayTooltipLabel(model, 0), 'Workout · 4');
  });

  it('null value -> "Workout · —"', () => {
    const model = { name: 'Workout', values: [null], target: { value: 3 } };
    assert.equal(overlayTooltipLabel(model, 0), 'Workout · —');
  });

  it('out-of-range index -> "Workout · —"', () => {
    const model = { name: 'Workout', values: [4], target: { value: 3 } };
    assert.equal(overlayTooltipLabel(model, 99), 'Workout · —');
    assert.equal(overlayTooltipLabel(model, -1), 'Workout · —');
  });
});

// ===========================================================================
// U14 — overlayTargetAnnotation
// ===========================================================================

describe('U14 — overlayTargetAnnotation', () => {
  it('exact shape, including scaleID "yOverlay" and the raw target value', () => {
    const model = { name: 'Workout', color: '#bf5af2', target: { value: 3 } };
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
    const model = { name: 'Workout', color: '#bf5af2', target: { value: 13.035 } };
    const ann = overlayTargetAnnotation(model, '#000000');
    assert.equal(ann.label.content, 'Workout 13');
  });

  it('null when target is null', () => {
    const model = { name: 'Workout', color: '#bf5af2', target: null };
    assert.equal(overlayTargetAnnotation(model, '#000000'), null);
  });

  it('falls back to the passed-in colour when model.color is missing', () => {
    const model = { name: 'Workout', color: null, target: { value: 3 } };
    const ann = overlayTargetAnnotation(model, '#123456');
    assert.equal(ann.borderColor, '#123456');
    assert.equal(ann.label.backgroundColor, '#123456');
  });
});

// ===========================================================================
// U15 — overlayDatasets
// ===========================================================================

describe('U15 — overlayDatasets', () => {
  it('exact bar-dataset shape: type, yAxisID, data===values, per-bucket colours by verdict, label', () => {
    const models = [
      { name: 'Workout', color: '#bf5af2', values: [3, 2, 4], verdicts: ['good', 'bad', 'none'] },
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
    const models = [{ name: 'X', color: null, values: [1], verdicts: ['none'] }];
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
