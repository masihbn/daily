// Unit tests for the PURE exports of js/charts/overlay.js (BUILD_PLAN Step
// 3.4, "Correlation marker overlay" — discrete events from other trackables
// drawn as markers on the bounded metric's Range chart). Written strictly
// against CONTRACT-3.4.md §1 (every export's exact name/shape/hint string)
// and §6 (cases U1 through U12) — the implementation (js/charts/overlay.js)
// is being written in parallel by another agent from the same contract and
// has NOT been read while writing this file.
//
// No DOM: renderOverlayPicker (the ONE DOM export in §1) is exercised only
// through the e2e suite (tests/e2e/overlay.test.mjs), which has a real
// document via the browser. None of U1-U12 name it, and this file imports
// only overlay.js and dates.js — no jsdom, nothing touches `document`.
//
// Fixture week/month keys are derived from the REAL js/dates.js
// (isoWeekKey/startOfIsoWeek/addDays) rather than hardcoded and trusted,
// per this project's repeated convention (cf. tests/unit/bounds.test.mjs's
// own header note) — a wrong hardcoded fixture becomes a wrong test that
// the implementation then gets "fixed" to satisfy.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERLAY_STORAGE_KEY,
  MAX_OVERLAYS,
  OVERLAY_ROW_BASE,
  OVERLAY_ROW_STEP,
  OVERLAY_POINT_STYLES,
  OVERLAY_POINT_RADIUS,
  isOverlayCandidate,
  overlayCandidates,
  readOverlaySelection,
  writeOverlaySelection,
  sanitizeSelection,
  overlayBucketKey,
  overlayModel,
  overlayRowY,
  overlayPointStyle,
  overlayTooltipLabel,
  overlayDatasets,
} from '../../js/charts/overlay.js';
import { isoWeekKey, startOfIsoWeek, addDays } from '../../js/dates.js';

// --- fake storage helpers ---------------------------------------------------

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
// U1 — isOverlayCandidate
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
// U2 — overlayCandidates
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
      { id: 10, name: 'A', value_shape: 'boolean' }, // number id, metric itself
      { id: '20', name: 'B', value_shape: 'boolean' },
      { id: 30, name: 'C', value_shape: 'numeric', aggregation: 'last' }, // non-candidate
    ];
    const result = overlayCandidates(trackables, '10');
    assert.deepEqual(result.map((t) => t.id), ['20']);
  });

  it('excludes the metric when metricId is a string and the matching candidate id is a number', () => {
    const trackables = [
      { id: 10, name: 'A', value_shape: 'boolean' },
      { id: '20', name: 'B', value_shape: 'boolean' }, // metric itself, string id
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
// U3 — readOverlaySelection
// ===========================================================================

describe('U3 — readOverlaySelection', () => {
  it('round-trips after write', () => {
    const storage = makeStorage();
    writeOverlaySelection(storage, '501', ['601', '603']);
    assert.deepEqual(readOverlaySelection(storage, '501'), ['601', '603']);
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
    const storage = makeStorage({ [OVERLAY_STORAGE_KEY]: JSON.stringify(['601', '603']) });
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
// U4 — writeOverlaySelection
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
    writeOverlaySelection(storage, 'A', ['3', '4']);
    assert.deepEqual(readOverlaySelection(storage, 'A'), ['3', '4']);
  });

  it('an unreadable existing value is replaced by a fresh object, not left corrupt', () => {
    const storage = makeStorage({ [OVERLAY_STORAGE_KEY]: '{garbage' });
    assert.doesNotThrow(() => writeOverlaySelection(storage, 'A', ['9']));
    assert.deepEqual(readOverlaySelection(storage, 'A'), ['9']);
    // The fresh object holds only what was just written.
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
// U5 — sanitizeSelection
// ===========================================================================

describe('U5 — sanitizeSelection', () => {
  const candidates = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }];

  it('dedupes, first occurrence wins', () => {
    assert.deepEqual(sanitizeSelection(['1', '2', '1'], candidates), ['1', '2']);
  });

  it('drops ids that are not candidates', () => {
    assert.deepEqual(sanitizeSelection(['1', '9'], candidates), ['1']);
  });

  it('keeps SELECTION order, not candidate order', () => {
    const reordered = [{ id: '3' }, { id: '1' }, { id: '2' }];
    assert.deepEqual(sanitizeSelection(['2', '1'], reordered), ['2', '1']);
  });

  it('caps at MAX_OVERLAYS, keeping the first three in selection order', () => {
    assert.equal(MAX_OVERLAYS, 3);
    assert.deepEqual(sanitizeSelection(['1', '2', '3', '4'], candidates), ['1', '2', '3']);
  });

  it('coerces numeric ids to strings', () => {
    const numericCandidates = [{ id: 1 }, { id: 2 }];
    assert.deepEqual(sanitizeSelection([1, 2], numericCandidates), ['1', '2']);
  });

  it('non-array ids -> [], never throws', () => {
    assert.deepEqual(sanitizeSelection(null, candidates), []);
    assert.deepEqual(sanitizeSelection(undefined, candidates), []);
    assert.deepEqual(sanitizeSelection('nope', candidates), []);
  });
});

// ===========================================================================
// U6 — overlayBucketKey
// ===========================================================================

describe('U6 — overlayBucketKey', () => {
  it("'day' is identity on a well-formed date string", () => {
    assert.equal(overlayBucketKey('2026-03-15', 'day'), '2026-03-15');
  });

  it("'week' equals isoWeekKey, and a Sunday differs from the following Monday", () => {
    // Derive a Monday/Sunday pair from the real dates.js rather than
    // assuming a weekday for a hardcoded string.
    const monday = startOfIsoWeek('2026-02-10');
    const sunday = addDays(monday, -1); // last day of the PRIOR iso week
    const mondayKey = overlayBucketKey(monday, 'week');
    const sundayKey = overlayBucketKey(sunday, 'week');
    assert.equal(mondayKey, isoWeekKey(monday));
    assert.equal(sundayKey, isoWeekKey(sunday));
    assert.notEqual(mondayKey, sundayKey);
  });

  it("'week' for 2025-12-29 -> '2026-W01' (ISO year-boundary case)", () => {
    assert.equal(overlayBucketKey('2025-12-29', 'week'), isoWeekKey('2025-12-29'));
    assert.equal(overlayBucketKey('2025-12-29', 'week'), '2026-W01');
  });

  it("'month' -> 'YYYY-MM'", () => {
    assert.equal(overlayBucketKey('2026-03-15', 'month'), '2026-03');
    assert.equal(overlayBucketKey('2026-11-01', 'month'), '2026-11');
  });

  it('unknown period is treated as day', () => {
    assert.equal(overlayBucketKey('2026-03-15', 'fortnight'), '2026-03-15');
    assert.equal(overlayBucketKey('2026-03-15', undefined), '2026-03-15');
  });

  it('malformed date -> null', () => {
    assert.equal(overlayBucketKey('2026-3-5', 'day'), null);
    assert.equal(overlayBucketKey('not-a-date', 'week'), null);
    assert.equal(overlayBucketKey('', 'month'), null);
    assert.equal(overlayBucketKey(null, 'day'), null);
    assert.equal(overlayBucketKey(undefined, 'day'), null);
  });
});

// ===========================================================================
// U7 — overlayModel at 'day'
// ===========================================================================

describe('U7 — overlayModel at day granularity', () => {
  const keys = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
  const trackable = { id: 601, name: 'Workout', color: '#bf5af2' };

  it('counts align to keys: 0 stays not-logged, duplicates dedupe to 1, out-of-range/malformed dates ignored, boolean-style 1 logs, total sums', () => {
    const entries = [
      { entry_date: '2026-01-01', value: 0 }, // value 0 -> not logged
      { entry_date: '2026-01-01', value: 0 }, // duplicate, still not logged
      { entry_date: '2026-01-02', value: 5 }, // logged
      { entry_date: '2026-01-02', value: 3 }, // duplicate entry_date -> count stays 1 for this key
      { entry_date: '2026-01-03', value: null }, // not logged
      { entry_date: '2026-01-03', value: NaN }, // not logged
      { entry_date: '2026-01-03', value: '3' }, // string value -> not logged
      { entry_date: '2026-01-04', value: 1 }, // boolean-row-style numeric 1 -> logged
      { entry_date: '2099-01-01', value: 10 }, // outside keys -> ignored
      { entry_date: 'garbage', value: 10 }, // malformed date -> ignored
    ];
    const model = overlayModel({ trackable, entries, keys, period: 'day' });
    assert.deepEqual(model.counts, [0, 1, 0, 1]);
    assert.equal(model.total, 2);
  });
});

// ===========================================================================
// U8 — overlayModel at 'week' and 'month'
// ===========================================================================

describe('U8 — overlayModel at week/month granularity', () => {
  const trackable = { id: 601, name: 'Workout', color: '#bf5af2' };

  it('three logged days in one ISO week -> count 3 in that key, 0 elsewhere; keys order respected', () => {
    const monday = startOfIsoWeek('2026-02-02');
    const week1 = isoWeekKey(monday);
    const monday2 = addDays(monday, 7);
    const week2 = isoWeekKey(monday2);
    const entries = [
      { entry_date: monday, value: 1 },
      { entry_date: addDays(monday, 1), value: 1 },
      { entry_date: addDays(monday, 2), value: 1 },
      { entry_date: monday2, value: 0 }, // not logged (value 0)
    ];

    const forward = overlayModel({ trackable, entries, keys: [week1, week2], period: 'week' });
    assert.deepEqual(forward.counts, [3, 0]);
    assert.equal(forward.total, 3);

    // Same entries, keys order reversed -> counts follow the keys, not a
    // fixed chronological assumption.
    const reversed = overlayModel({ trackable, entries, keys: [week2, week1], period: 'week' });
    assert.deepEqual(reversed.counts, [0, 3]);
    assert.equal(reversed.total, 3);
  });

  it('three logged days in one month -> count 3 in that key, 0 elsewhere', () => {
    const month1 = '2026-02';
    const month2 = '2026-03';
    const entries = [
      { entry_date: '2026-02-05', value: 1 },
      { entry_date: '2026-02-14', value: 1 },
      { entry_date: '2026-02-27', value: 1 },
      { entry_date: '2026-03-01', value: 0 }, // not logged
    ];
    const model = overlayModel({ trackable, entries, keys: [month1, month2], period: 'month' });
    assert.deepEqual(model.counts, [3, 0]);
    assert.equal(model.total, 3);
  });
});

// ===========================================================================
// U9 — overlayModel degenerate inputs
// ===========================================================================

describe('U9 — overlayModel degenerate inputs', () => {
  it('trackable null -> id "" name "" color null', () => {
    const model = overlayModel({ trackable: null, entries: [], keys: ['2026-01-01'], period: 'day' });
    assert.equal(model.id, '');
    assert.equal(model.name, '');
    assert.equal(model.color, null);
    assert.deepEqual(model.counts, [0]);
    assert.equal(model.total, 0);
  });

  it('color "" -> null', () => {
    const model = overlayModel({ trackable: { id: 5, name: 'Y', color: '' }, entries: [], keys: ['2026-01-01'], period: 'day' });
    assert.equal(model.id, '5');
    assert.equal(model.name, 'Y');
    assert.equal(model.color, null);
  });

  it('entries non-array -> all zeros', () => {
    const model = overlayModel({
      trackable: { id: 1, name: 'A', color: '#fff' },
      entries: null,
      keys: ['2026-01-01', '2026-01-02'],
      period: 'day',
    });
    assert.deepEqual(model.counts, [0, 0]);
    assert.equal(model.total, 0);
  });

  it('keys [] -> counts [] total 0', () => {
    const model = overlayModel({
      trackable: { id: 1, name: 'A' },
      entries: [{ entry_date: '2026-01-01', value: 1 }],
      keys: [],
      period: 'day',
    });
    assert.deepEqual(model.counts, []);
    assert.equal(model.total, 0);
  });

  it('never throws for garbage entries (numbers, null, missing fields)', () => {
    const entries = [1, 2, null, 'foo', { entry_date: 123 }, { entry_date: '2026-01-01' }];
    assert.doesNotThrow(() => {
      const model = overlayModel({ trackable: { id: 1, name: 'A' }, entries, keys: ['2026-01-01'], period: 'day' });
      assert.deepEqual(model.counts, [0]);
      assert.equal(model.total, 0);
    });
  });
});

// ===========================================================================
// U10 — overlayRowY / overlayPointStyle
// ===========================================================================

describe('U10 — overlayRowY / overlayPointStyle', () => {
  it('overlayRowY: OVERLAY_ROW_BASE + index * OVERLAY_ROW_STEP for 0,1,2', () => {
    assert.equal(overlayRowY(0), OVERLAY_ROW_BASE + 0 * OVERLAY_ROW_STEP);
    assert.equal(overlayRowY(1), OVERLAY_ROW_BASE + 1 * OVERLAY_ROW_STEP);
    assert.equal(overlayRowY(2), OVERLAY_ROW_BASE + 2 * OVERLAY_ROW_STEP);
  });

  it('overlayPointStyle: exact styles for 0,1,2 and cycling at 3', () => {
    assert.equal(overlayPointStyle(0), OVERLAY_POINT_STYLES[0]);
    assert.equal(overlayPointStyle(1), OVERLAY_POINT_STYLES[1]);
    assert.equal(overlayPointStyle(2), OVERLAY_POINT_STYLES[2]);
    assert.equal(overlayPointStyle(3), OVERLAY_POINT_STYLES[0]);
    assert.equal(overlayPointStyle(4), OVERLAY_POINT_STYLES[1]);
  });
});

// ===========================================================================
// U11 — overlayTooltipLabel
// ===========================================================================

describe('U11 — overlayTooltipLabel', () => {
  const model = { name: 'Workout', counts: [1, 3, 0] };

  it("period 'day' -> just the name", () => {
    assert.equal(overlayTooltipLabel(model, 0, 'day'), 'Workout');
  });

  it("period 'week' with count 1 -> singular 'day'", () => {
    assert.equal(overlayTooltipLabel(model, 0, 'week'), 'Workout · 1 day');
  });

  it("period 'month' with count 3 -> plural 'days'", () => {
    assert.equal(overlayTooltipLabel(model, 1, 'month'), 'Workout · 3 days');
  });

  it('out-of-range index -> just the name', () => {
    assert.equal(overlayTooltipLabel(model, 99, 'week'), 'Workout');
    assert.equal(overlayTooltipLabel(model, -1, 'week'), 'Workout');
  });

  it('missing counts -> just the name', () => {
    assert.equal(overlayTooltipLabel({ name: 'Workout' }, 0, 'week'), 'Workout');
  });
});

// ===========================================================================
// U12 — overlayDatasets
// ===========================================================================

describe('U12 — overlayDatasets', () => {
  it('one dataset per model, exact key set, correct data/null placement, colours and fallback', () => {
    const models = [
      { id: '601', name: 'Workout', color: '#bf5af2', counts: [0, 2, 0, 5], total: 7 },
      { id: '603', name: 'Smoking', color: null, counts: [1, 0], total: 1 },
    ];
    const fallback = '#888888';
    const datasets = overlayDatasets(models, fallback);

    assert.equal(datasets.length, 2);

    const expectedKeys = [
      'type',
      'label',
      'showLine',
      'yAxisID',
      'data',
      'pointStyle',
      'pointRadius',
      'pointHoverRadius',
      'backgroundColor',
      'borderColor',
      'borderWidth',
      'spanGaps',
    ].sort();
    assert.deepEqual(Object.keys(datasets[0]).sort(), expectedKeys);

    const d0 = datasets[0];
    assert.equal(d0.type, 'line');
    assert.equal(d0.label, 'Workout');
    assert.equal(d0.showLine, false);
    assert.equal(d0.yAxisID, 'yOverlay');
    assert.deepEqual(d0.data, [null, overlayRowY(0), null, overlayRowY(0)]);
    assert.equal(d0.pointStyle, overlayPointStyle(0));
    assert.equal(d0.pointRadius, OVERLAY_POINT_RADIUS);
    assert.equal(d0.pointHoverRadius, OVERLAY_POINT_RADIUS + 1);
    assert.equal(d0.backgroundColor, '#bf5af2');
    assert.equal(d0.borderColor, '#bf5af2');
    assert.equal(d0.borderWidth, 1);
    assert.equal(d0.spanGaps, false);

    const d1 = datasets[1];
    assert.equal(d1.label, 'Smoking');
    assert.deepEqual(d1.data, [overlayRowY(1), null]);
    assert.equal(d1.pointStyle, overlayPointStyle(1));
    // color null -> falls back to the passed-in fallback colour.
    assert.equal(d1.backgroundColor, fallback);
    assert.equal(d1.borderColor, fallback);
  });

  it('non-array models -> [], never throws', () => {
    assert.deepEqual(overlayDatasets(null, '#000'), []);
    assert.deepEqual(overlayDatasets(undefined, '#000'), []);
    assert.deepEqual(overlayDatasets('nope', '#000'), []);
  });
});
