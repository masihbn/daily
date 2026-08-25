// Unit tests for the PURE exports of js/charts/bounds.js (BUILD_PLAN Step
// 3.3, "Two-bars threshold chart") — boundsFor, zoneFor, shouldBridge,
// boundsModel, boundsAxisFor, and the three constants. No DOM, no
// window.Chart. Written strictly against CONTRACT-3.3.md §2 and §5.1 (cases
// N1 through N11); the implementation (js/charts/bounds.js) is being written
// in parallel by another agent from the same contract and has NOT been read
// while writing this file.
//
// Fixtures are re-derived from the REAL js/aggregate.js (deriveBounds) and
// js/dates.js (addDays, rangeDays, parseLocal) rather than hardcoded and
// trusted — per this project's repeated history (cf. tests/unit/weekly.test
// .mjs's own header note): a wrong hardcoded fixture becomes a wrong test
// that the implementation is then "fixed" to satisfy. N3 in particular
// exists to prove boundsFor delegates to the real deriveBounds() rather than
// reimplementing percentile math — the same class of regression guard as
// weekly.test.mjs's W11 (rollup delegation).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundsFor,
  zoneFor,
  shouldBridge,
  segmentVisibility,
  boundsModel,
  boundsAxisFor,
  DEFAULT_ROLLING_WINDOW_DAYS,
  MIN_BOUND_READINGS,
  MAX_BRIDGE_DAYS,
} from '../../js/charts/bounds.js';
import { deriveBounds } from '../../js/aggregate.js';
import { addDays, rangeDays, parseLocal } from '../../js/dates.js';

// --- shared fixture builders -----------------------------------------------

// n distinct daily readings ending exactly at `asOf` (asOf, asOf-1, ...,
// asOf-(n-1)) — n distinct calendar days, latest date === asOf, matching
// both boundsFor's own asOf rule (§2.2 rule 3: "asOf is the latest
// entry_date present") and deriveBounds's identical default (js/aggregate.js
// deriveBounds: "Default to the latest entry_date present in `entries`").
function readingsEndingAt(asOf, n, valueFn = (i) => 70 + ((i * 7) % 25)) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ entry_date: i === 0 ? asOf : addDays(asOf, -i), value: valueFn(i) });
  }
  return out;
}

// n readings dated well outside a 90-day window anchored at `asOf` —
// starting 300 days back, so even the most recent of them (offsetStart) is
// far past any window this file uses.
function oldReadings(asOf, n, offsetStart = 300) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ entry_date: addDays(asOf, -(offsetStart + i)), value: 60 + i });
  }
  return out;
}

const T_MANUAL_OK = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'manual', bound_lower: 78, bound_upper: 85 };
const T_AUTO = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'auto' };

// ===========================================================================
// N1 — boundsFor: manual mode
// ===========================================================================

describe('N1 — boundsFor: manual bounds', () => {
  it('valid manual bounds (numbers) -> ok, mode manual, lower/upper returned as-is', () => {
    const result = boundsFor(T_MANUAL_OK, []);
    assert.equal(result.status, 'ok');
    assert.equal(result.mode, 'manual');
    assert.equal(result.lower, 78);
    assert.equal(result.upper, 85);
  });

  it('valid manual bounds as numeric STRINGS coerce via Number(), same as weekly.js targetFor', () => {
    const t = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'manual', bound_lower: '78', bound_upper: '85' };
    const result = boundsFor(t, []);
    assert.equal(result.status, 'ok');
    assert.equal(result.lower, 78);
    assert.equal(result.upper, 85);
  });

  it('equal bounds (lower === upper) are valid: rule is lower <= upper', () => {
    const t = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'manual', bound_lower: 80, bound_upper: 80 };
    const result = boundsFor(t, []);
    assert.equal(result.status, 'ok');
    assert.equal(result.lower, 80);
    assert.equal(result.upper, 80);
  });

  it('reversed bounds (lower > upper) -> invalid, bounds null, mode still "manual" — never silently falls back to auto', () => {
    const t = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'manual', bound_lower: 90, bound_upper: 80 };
    const result = boundsFor(t, []);
    assert.equal(result.status, 'invalid');
    assert.equal(result.mode, 'manual');
    assert.equal(result.lower, null);
    assert.equal(result.upper, null);
  });

  it('one bound missing (upper) -> invalid', () => {
    const t = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'manual', bound_lower: 78, bound_upper: undefined };
    const result = boundsFor(t, []);
    assert.equal(result.status, 'invalid');
    assert.equal(result.lower, null);
    assert.equal(result.upper, null);
  });

  it('one bound missing (lower) -> invalid', () => {
    const t = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'manual', bound_lower: null, bound_upper: 85 };
    const result = boundsFor(t, []);
    assert.equal(result.status, 'invalid');
  });

  it('both bounds missing -> invalid', () => {
    const t = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'manual', bound_lower: null, bound_upper: null };
    const result = boundsFor(t, []);
    assert.equal(result.status, 'invalid');
  });

  // The full reject list, applied to EACH bound independently while the
  // other stays valid — proves the coercion trap (Number('')===0,
  // Number(null)===0, Number([])===0, Number(true)===1) does not smuggle a
  // spurious valid-looking bound through.
  const badValues = [null, undefined, '', [], {}, true, false, NaN, 'abc', '3 kg'];
  for (const bad of badValues) {
    it(`bound_lower=${JSON.stringify(bad)} (bound_upper valid) -> invalid`, () => {
      const t = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'manual', bound_lower: bad, bound_upper: 85 };
      const result = boundsFor(t, []);
      assert.equal(result.status, 'invalid');
      assert.equal(result.lower, null);
      assert.equal(result.upper, null);
    });
    it(`bound_upper=${JSON.stringify(bad)} (bound_lower valid) -> invalid`, () => {
      const t = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'manual', bound_lower: 78, bound_upper: bad };
      const result = boundsFor(t, []);
      assert.equal(result.status, 'invalid');
      assert.equal(result.lower, null);
      assert.equal(result.upper, null);
    });
  }

  it('windowDays defaults to DEFAULT_ROLLING_WINDOW_DAYS when omitted', () => {
    const result = boundsFor(T_MANUAL_OK, []);
    assert.equal(result.windowDays, DEFAULT_ROLLING_WINDOW_DAYS);
  });

  it('never throws for a hostile spread of manual-mode configs', () => {
    const hostile = [
      { bound_lower: Symbol('x'), bound_upper: 85 },
      { bound_lower: 78, bound_upper: () => 85 },
      { bound_lower: [78], bound_upper: [85] },
      { bound_lower: Infinity, bound_upper: -Infinity },
    ];
    for (const extra of hostile) {
      const t = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'manual', ...extra };
      assert.doesNotThrow(() => boundsFor(t, []));
    }
  });
});

// ===========================================================================
// N2 — boundsFor: the cold-start guard (highest-value case)
// ===========================================================================
//
// CONTRACT-3.3.md §2.1's measured table pins p10 to an outlier below n=11
// and clears it at n=11; MIN_BOUND_READINGS=12 is the next round number
// above that. This asserts the MIN_BOUND_READINGS boundary in BOTH
// directions using the imported constant, not a hardcoded 12, so the test
// tracks the constant if it is ever retuned.
// ===========================================================================

describe('N2 — boundsFor: the cold-start guard at the MIN_BOUND_READINGS boundary', () => {
  const ASOF = '2026-06-01';

  it(`MIN_BOUND_READINGS - 1 readings (${MIN_BOUND_READINGS - 1}) -> insufficient, bounds null, readingCount reported correctly`, () => {
    const entries = readingsEndingAt(ASOF, MIN_BOUND_READINGS - 1);
    const result = boundsFor(T_AUTO, entries);
    assert.equal(result.status, 'insufficient');
    assert.equal(result.lower, null);
    assert.equal(result.upper, null);
    assert.equal(result.readingCount, MIN_BOUND_READINGS - 1);
  });

  it(`exactly MIN_BOUND_READINGS readings (${MIN_BOUND_READINGS}) -> ok, finite bounds, readingCount reported correctly`, () => {
    const entries = readingsEndingAt(ASOF, MIN_BOUND_READINGS);
    const result = boundsFor(T_AUTO, entries);
    assert.equal(result.status, 'ok');
    assert.equal(result.mode, 'auto');
    assert.equal(typeof result.lower, 'number');
    assert.ok(Number.isFinite(result.lower));
    assert.equal(typeof result.upper, 'number');
    assert.ok(Number.isFinite(result.upper));
    assert.equal(result.readingCount, MIN_BOUND_READINGS);
  });

  // bounds_mode omitted entirely defaults to 'auto' per §2.2 rule 3 — the
  // same boundary must hold on that implicit path too.
  it('the same boundary holds when bounds_mode is omitted (defaults to auto)', () => {
    const tNoMode = { value_shape: 'numeric', bounds_enabled: true };
    const short = boundsFor(tNoMode, readingsEndingAt(ASOF, MIN_BOUND_READINGS - 1));
    const exact = boundsFor(tNoMode, readingsEndingAt(ASOF, MIN_BOUND_READINGS));
    assert.equal(short.status, 'insufficient');
    assert.equal(exact.status, 'ok');
  });

  // Evidence for the constant, per the contract's own suggestion ("A test
  // may reproduce this table as evidence... but MIN_BOUND_READINGS itself is
  // the value the code must use"). Reproduces the documented p10-contaminated
  // -> clean transition directly against the REAL deriveBounds, independent
  // of boundsFor, to show why 12 (not e.g. 10) was chosen.
  it('evidence: deriveBounds p10 is still outlier-contaminated at n=10 and clears by n=11 (the real function, not boundsFor)', () => {
    // One low outlier (50) among a clean baseline of 80-89. Verified against
    // the live deriveBounds before writing this assertion: n=10 -> lower 77
    // (interpolated between the outlier and the baseline min — still pulled
    // below the clean 80-89 range); n=11 -> lower 80 (exactly the baseline
    // min — the outlier's own value no longer reaches the p10 index at all).
    const base = (i) => 80 + (i % 10);
    const outlierFirst = (n) => [{ entry_date: ASOF, value: 50 }, ...readingsEndingAt(addDays(ASOF, -1), n - 1, base)];
    const at10 = deriveBounds(outlierFirst(10), 90, 'percentile', { asOf: ASOF });
    const at11 = deriveBounds(outlierFirst(11), 90, 'percentile', { asOf: ASOF });
    assert.ok(at10.lower < 80, `expected p10 still pulled below the clean baseline (80) at n=10, got ${at10.lower}`);
    assert.ok(at11.lower >= 80, `expected p10 to have cleared the outlier by n=11 (>= clean baseline min 80), got ${at11.lower}`);
    assert.ok(at11.lower > at10.lower, 'expected p10 to move strictly upward from n=10 to n=11');
  });
});

// ===========================================================================
// N3 — boundsFor: delegation (the guard against reimplemented percentile math)
// ===========================================================================

describe('N3 — boundsFor delegates to the REAL deriveBounds(), not a reimplementation', () => {
  const ASOF = '2026-06-01';
  const entries = readingsEndingAt(ASOF, 30, (i) => 60 + ((i * 13) % 40));

  it('default windowDays (90): lower/upper equal deriveBounds(entries, 90)', () => {
    const result = boundsFor(T_AUTO, entries);
    const expected = deriveBounds(entries, 90);
    assert.equal(result.status, 'ok');
    assert.equal(result.lower, expected.lower);
    assert.equal(result.upper, expected.upper);
  });

  it('an explicit non-default windowDays (30) is actually threaded through, not hardcoded to 90: lower/upper equal deriveBounds(entries, 30)', () => {
    const result = boundsFor(T_AUTO, entries, 30);
    const expected = deriveBounds(entries, 30);
    assert.equal(result.lower, expected.lower);
    assert.equal(result.upper, expected.upper);
  });
});

// ===========================================================================
// N4 — boundsFor: readings outside the window are excluded from readingCount
// ===========================================================================

describe('N4 — boundsFor excludes out-of-window readings from readingCount', () => {
  it('20 old readings (300+ days back) + 3 recent readings -> readingCount 3, insufficient', () => {
    const ASOF = '2026-06-01';
    const recent = readingsEndingAt(ASOF, 3, (i) => 80 + i);
    const old = oldReadings(ASOF, 20);
    const entries = [...recent, ...old];

    const result = boundsFor(T_AUTO, entries); // default windowDays 90
    assert.equal(result.readingCount, 3);
    assert.equal(result.status, 'insufficient');
    assert.equal(result.lower, null);
    assert.equal(result.upper, null);
  });
});

// ===========================================================================
// N5 — boundsFor: disabled
// ===========================================================================

describe('N5 — boundsFor: disabled', () => {
  it('value_shape "boolean" -> disabled, even with bounds_enabled true and a valid manual config', () => {
    const t = { value_shape: 'boolean', bounds_enabled: true, bounds_mode: 'manual', bound_lower: 1, bound_upper: 2 };
    const result = boundsFor(t, []);
    assert.equal(result.status, 'disabled');
    assert.equal(result.mode, null);
    assert.equal(result.lower, null);
    assert.equal(result.upper, null);
  });

  it('bounds_enabled: false -> disabled, even with an otherwise-valid numeric/manual config', () => {
    const t = { value_shape: 'numeric', bounds_enabled: false, bounds_mode: 'manual', bound_lower: 1, bound_upper: 2 };
    const result = boundsFor(t, []);
    assert.equal(result.status, 'disabled');
  });

  it('bounds_enabled absent entirely -> disabled', () => {
    const t = { value_shape: 'numeric', bounds_mode: 'manual', bound_lower: 1, bound_upper: 2 };
    const result = boundsFor(t, []);
    assert.equal(result.status, 'disabled');
  });

  it('null trackable -> disabled, mode null, bounds null, never throws', () => {
    const result = boundsFor(null, []);
    assert.equal(result.status, 'disabled');
    assert.equal(result.mode, null);
    assert.equal(result.lower, null);
    assert.equal(result.upper, null);
  });

  for (const bad of [undefined, 'x', 42, [], true]) {
    it(`trackable=${JSON.stringify(bad)} (not an object, or an array) -> disabled`, () => {
      const result = boundsFor(bad, []);
      assert.equal(result.status, 'disabled');
    });
  }
});

// ===========================================================================
// N6 — zoneFor
// ===========================================================================

describe('N6 — zoneFor', () => {
  const OK_BOUNDS = { status: 'ok', mode: 'manual', lower: 78, upper: 85, readingCount: 0, windowDays: 90 };

  it('value === lower -> "in" (inclusive lower edge)', () => {
    assert.equal(zoneFor(78, OK_BOUNDS), 'in');
  });
  it('value === upper -> "in" (inclusive upper edge)', () => {
    assert.equal(zoneFor(85, OK_BOUNDS), 'in');
  });
  it('a value strictly between the bounds -> "in"', () => {
    assert.equal(zoneFor(80, OK_BOUNDS), 'in');
  });
  it('a value just below lower -> "below"', () => {
    assert.equal(zoneFor(77.999, OK_BOUNDS), 'below');
  });
  it('a value just above upper -> "above"', () => {
    assert.equal(zoneFor(85.001, OK_BOUNDS), 'above');
  });

  for (const bad of [NaN, Infinity, -Infinity, null, undefined, 'x', {}, []]) {
    it(`non-finite value ${JSON.stringify(bad)} -> "unknown"`, () => {
      assert.equal(zoneFor(bad, OK_BOUNDS), 'unknown');
    });
  }

  it('bounds.status !== "ok" (insufficient) -> "unknown" regardless of value', () => {
    const bounds = { status: 'insufficient', mode: 'auto', lower: null, upper: null, readingCount: 3, windowDays: 90 };
    assert.equal(zoneFor(80, bounds), 'unknown');
  });
  it('bounds.status !== "ok" (disabled) -> "unknown"', () => {
    const bounds = { status: 'disabled', mode: null, lower: null, upper: null, readingCount: 0, windowDays: 90 };
    assert.equal(zoneFor(80, bounds), 'unknown');
  });
  it('bounds.status !== "ok" (invalid) -> "unknown"', () => {
    const bounds = { status: 'invalid', mode: 'manual', lower: null, upper: null, readingCount: 0, windowDays: 90 };
    assert.equal(zoneFor(80, bounds), 'unknown');
  });
  it('garbage bounds (null) -> "unknown", never throws', () => {
    assert.doesNotThrow(() => zoneFor(80, null));
    assert.equal(zoneFor(80, null), 'unknown');
  });

  it('fuzz: never throws across a hostile cross-product of values and bounds shapes', () => {
    const values = [80, 78, 85, NaN, Infinity, null, undefined, 'x', {}, []];
    const boundsOptions = [OK_BOUNDS, null, undefined, {}, 'x', 42, { status: 'ok' }, { status: 'ok', lower: 'x', upper: 'y' }];
    for (const v of values) {
      for (const b of boundsOptions) {
        let result;
        assert.doesNotThrow(() => {
          result = zoneFor(v, b);
        }, `threw for value=${JSON.stringify(v)} bounds=${JSON.stringify(b)}`);
        assert.ok(['below', 'in', 'above', 'unknown'].includes(result), `bad result: ${result}`);
      }
    }
  });
});

// ===========================================================================
// N7 — shouldBridge
// ===========================================================================

describe('N7 — shouldBridge', () => {
  for (let d = 1; d <= MAX_BRIDGE_DAYS; d++) {
    it(`shouldBridge(${d}) === true (within MAX_BRIDGE_DAYS)`, () => {
      assert.equal(shouldBridge(d), true);
    });
  }

  for (const d of [MAX_BRIDGE_DAYS + 1, MAX_BRIDGE_DAYS + 2, 30, 365]) {
    it(`shouldBridge(${d}) === false (beyond MAX_BRIDGE_DAYS)`, () => {
      assert.equal(shouldBridge(d), false);
    });
  }

  for (const d of [0, -1, -7]) {
    it(`shouldBridge(${d}) === false (zero/negative is not a gap)`, () => {
      assert.equal(shouldBridge(d), false);
    });
  }

  for (const d of [NaN, Infinity, -Infinity, null, undefined, 'x', {}, []]) {
    it(`shouldBridge(${JSON.stringify(d)}) === false, never throws`, () => {
      let result;
      assert.doesNotThrow(() => {
        result = shouldBridge(d);
      });
      assert.equal(result, false);
    });
  }

  it('a custom maxBridgeDays: within it is true, just past it is false', () => {
    assert.equal(shouldBridge(10, 14), true);
    assert.equal(shouldBridge(14, 14), true);
    assert.equal(shouldBridge(15, 14), false);
  });
});

// ===========================================================================
// N7b — segmentVisibility: the actual per-segment line-drawing decision
// ===========================================================================
//
// Coverage gap flagged by the coordinator, not by this Test Author: the
// contract named shouldBridge(gapDays) as the per-gap predicate, but the
// renderer actually consults a walker — segmentVisibility(values) — that
// applies shouldBridge to each adjacent pair of x-positions using the
// nearest real neighbours on either side. shouldBridge alone (N7) never
// exercised that walk. Contract for this function, as given directly by the
// coordinator (not read from js/charts/bounds.js):
//
//   segmentVisibility(values) -> boolean[]
//   - values: one slot per calendar day, each a finite number or null. A
//     non-array is treated as [].
//   - returns length max(0, values.length - 1); index i describes the
//     segment between values[i] and values[i+1].
//   - leftReal = nearest index <= i holding a finite value; rightReal =
//     nearest index >= i+1 holding one. Either missing -> false.
//   - missingDays = rightReal - leftReal - 1 (index distance IS day
//     distance, one slot per day).
//   - true iff missingDays === 0, or shouldBridge(missingDays) is true.
//   - never throws.
// ===========================================================================

describe('N7b — segmentVisibility', () => {
  it('all-real values -> every segment true (missingDays === 0 throughout)', () => {
    assert.deepEqual(segmentVisibility([1, 2, 3, 4]), [true, true, true]);
  });

  it('a single missing day between two readings -> both segments spanning the gap are true', () => {
    // [1, null, 3]: segment0 (idx0-1) and segment1 (idx1-2) both resolve to
    // leftReal=0/rightReal=2, missingDays=1 -> shouldBridge(1) is true.
    assert.deepEqual(segmentVisibility([1, null, 3]), [true, true]);
  });

  // THE BOUNDARY PAIR — highest-value case in this group. Built from the
  // imported MAX_BRIDGE_DAYS constant, not a hardcoded 7, so this tracks
  // the constant if it is ever retuned.
  describe('the MAX_BRIDGE_DAYS boundary, exact', () => {
    function gapArray(missingDays) {
      return [1, ...Array(missingDays).fill(null), 2];
    }

    it(`exactly MAX_BRIDGE_DAYS (${MAX_BRIDGE_DAYS}) missing days -> every segment true`, () => {
      const values = gapArray(MAX_BRIDGE_DAYS);
      const result = segmentVisibility(values);
      assert.equal(result.length, values.length - 1);
      assert.ok(result.every((v) => v === true), `expected every segment true, got ${JSON.stringify(result)}`);
    });

    it(`MAX_BRIDGE_DAYS + 1 (${MAX_BRIDGE_DAYS + 1}) missing days -> every segment false`, () => {
      const values = gapArray(MAX_BRIDGE_DAYS + 1);
      const result = segmentVisibility(values);
      assert.equal(result.length, values.length - 1);
      assert.ok(result.every((v) => v === false), `expected every segment false, got ${JSON.stringify(result)}`);
    });
  });

  it('leading nulls before the first reading -> those segments false (nothing to bridge FROM)', () => {
    // [null, null, 5]: segment0 (idx0-1) has no leftReal at all (indices
    // <=0 are all null) -> false. segment1 (idx1-2) also has no leftReal
    // (indices <=1 are all null) -> false.
    assert.deepEqual(segmentVisibility([null, null, 5]), [false, false]);
  });

  it('trailing nulls after the last reading -> those segments false (nothing to bridge TO)', () => {
    // [5, null, null]: segment0 (idx0-1): rightReal search from idx1
    // onward finds nothing real -> false. segment1 (idx1-2): same, no
    // rightReal -> false.
    assert.deepEqual(segmentVisibility([5, null, null]), [false, false]);
  });

  it('leading AND trailing nulls around a single real value in the middle -> every segment false', () => {
    assert.deepEqual(segmentVisibility([null, null, 5, null, null]), [false, false, false, false]);
  });

  it('all nulls -> every segment false', () => {
    assert.deepEqual(segmentVisibility([null, null, null]), [false, false]);
  });

  it('length 0 -> []', () => {
    assert.deepEqual(segmentVisibility([]), []);
  });

  it('length 1 -> [] (no adjacent pairs to describe)', () => {
    assert.deepEqual(segmentVisibility([5]), []);
    assert.deepEqual(segmentVisibility([null]), []);
  });

  describe('return length is always max(0, values.length - 1)', () => {
    const inputs = [
      [],
      [1],
      [1, 2],
      [1, null, 2, null, null, 3],
      new Array(10).fill(null),
      new Array(25).fill(0).map((_, i) => (i % 3 === 0 ? i : null)),
    ];
    for (const values of inputs) {
      it(`values.length=${values.length} -> result.length=${Math.max(0, values.length - 1)}`, () => {
        const result = segmentVisibility(values);
        assert.ok(Array.isArray(result));
        assert.equal(result.length, Math.max(0, values.length - 1));
      });
    }
  });

  it('a short gap AND a long gap in the SAME array: the short one is bridged, the long one is broken — the realistic weight-logging shape, and the case most likely to catch an off-by-one', () => {
    // idx0=1 (real), idx1=null (1-day gap), idx2=3 (real): missingDays=1,
    // bridged (segments 0,1 true). idx2=3 (real) ... idx11=12 (real), with
    // idx3..idx10 null (8 missing days > MAX_BRIDGE_DAYS=7): broken
    // (segments 2..10 false).
    const values = [1, null, 3, null, null, null, null, null, null, null, null, 12];
    const result = segmentVisibility(values);
    assert.equal(result.length, 11);
    assert.deepEqual(result.slice(0, 2), [true, true], 'the short (1-day) gap should be bridged');
    assert.deepEqual(
      result.slice(2, 11),
      new Array(9).fill(false),
      'the long (8-day) gap should be broken across every segment it spans'
    );
  });

  it('never throws for a non-array input, and treats it as [] (empty result)', () => {
    for (const bad of [null, undefined, 'x', 42, {}, true, NaN]) {
      let result;
      assert.doesNotThrow(() => {
        result = segmentVisibility(bad);
      }, `threw for ${JSON.stringify(bad)}`);
      assert.deepEqual(result, [], `expected [] for non-array input ${JSON.stringify(bad)}`);
    }
  });

  it('never throws for arrays containing hostile non-finite entries (undefined, NaN, Infinity, strings, objects), and always returns a boolean array of the right length', () => {
    const hostile = [1, undefined, NaN, Infinity, -Infinity, 'x', {}, [], null, 2];
    let result;
    assert.doesNotThrow(() => {
      result = segmentVisibility(hostile);
    });
    assert.equal(result.length, hostile.length - 1);
    for (const v of result) {
      assert.equal(typeof v, 'boolean');
    }
  });

  // THE CONSISTENCY PROPERTY: for several sparse arrays, every segment the
  // real segmentVisibility() marks true must itself satisfy
  // shouldBridge(missingDays) || missingDays === 0, where missingDays is
  // computed HERE, independently, by scanning `values` directly for the
  // nearest real neighbours — not by re-deriving it from segmentVisibility's
  // own output. This checks the walker actually agrees with the shouldBridge
  // predicate it is supposed to be built on, rather than trusting the two
  // were tested in isolation and assuming they agree.
  describe('consistency: every TRUE segment is justified by shouldBridge on independently-computed missingDays', () => {
    function isReal(v) {
      return typeof v === 'number' && Number.isFinite(v);
    }
    function nearestLeftReal(values, i) {
      for (let k = i; k >= 0; k--) {
        if (isReal(values[k])) return k;
      }
      return -1;
    }
    function nearestRightReal(values, j) {
      for (let k = j; k < values.length; k++) {
        if (isReal(values[k])) return k;
      }
      return -1;
    }

    const sparseArrays = [
      [5, null, null, 8, null, null, null, null, null, null, null, null, null, 20, null, 22],
      [null, 1, 2, null, null, null, 4, null, null, null, null, null, null, null, null, null, 9],
      [1, 2, 3, 4, 5],
      [null, null, null],
      [7, null, null, null, null, null, null, null, 9], // exactly MAX_BRIDGE_DAYS(7) missing
      [7, null, null, null, null, null, null, null, null, 9], // MAX_BRIDGE_DAYS+1 missing
      [null, null, 3, null, 5, null, null, null, null, null, null, null, null, null, null, null, null, 40, null, null],
    ];

    for (const [idx, values] of sparseArrays.entries()) {
      it(`fixture #${idx}: every true segment satisfies the predicate on independently-computed missingDays`, () => {
        const actual = segmentVisibility(values);
        assert.equal(actual.length, Math.max(0, values.length - 1));
        for (let i = 0; i < actual.length; i++) {
          if (actual[i] !== true) continue;
          const leftReal = nearestLeftReal(values, i);
          const rightReal = nearestRightReal(values, i + 1);
          assert.notEqual(leftReal, -1, `fixture #${idx} segment ${i}: marked true but has no leftReal`);
          assert.notEqual(rightReal, -1, `fixture #${idx} segment ${i}: marked true but has no rightReal`);
          const missingDays = rightReal - leftReal - 1;
          assert.ok(
            missingDays === 0 || shouldBridge(missingDays),
            `fixture #${idx} segment ${i}: marked true but missingDays=${missingDays} is neither 0 nor bridgeable`
          );
        }
      });
    }
  });
});

// ===========================================================================
// N8 — boundsModel: array alignment
// ===========================================================================

describe('N8 — boundsModel: arrays aligned with rangeDays(from, to)', () => {
  const from = '2026-06-01';
  const to = '2026-06-05';
  const expectedDates = rangeDays(from, to);

  it('dates/labels/values/zones all have the same length as rangeDays(from, to)', () => {
    const entries = [
      { entry_date: '2026-06-02', value: 80 },
      { entry_date: '2026-06-04', value: 82 },
    ];
    const model = boundsModel({ trackable: T_MANUAL_OK, entries, from, to });
    assert.deepEqual(model.dates, expectedDates);
    assert.equal(model.labels.length, expectedDates.length);
    assert.equal(model.values.length, expectedDates.length);
    assert.equal(model.zones.length, expectedDates.length);
  });

  it('values[i] is the finite entry value for dates[i], null where there is no entry that day', () => {
    const entries = [
      { entry_date: '2026-06-02', value: 80 },
      { entry_date: '2026-06-04', value: 82 },
    ];
    const model = boundsModel({ trackable: T_MANUAL_OK, entries, from, to });
    assert.deepEqual(model.values, [null, 80, null, 82, null]);
  });

  it('zones align with values via zoneFor, given ok bounds (78-85): "in" where logged in-band, "unknown" where no entry', () => {
    const entries = [
      { entry_date: '2026-06-02', value: 80 },
      { entry_date: '2026-06-04', value: 82 },
    ];
    const model = boundsModel({ trackable: T_MANUAL_OK, entries, from, to });
    assert.deepEqual(model.zones, ['unknown', 'in', 'unknown', 'in', 'unknown']);
  });

  it('pointCount counts only finite values, not the empty days', () => {
    const entries = [
      { entry_date: '2026-06-02', value: 80 },
      { entry_date: '2026-06-04', value: 82 },
    ];
    const model = boundsModel({ trackable: T_MANUAL_OK, entries, from, to });
    assert.equal(model.pointCount, 2);
  });

  it('a duplicate entry_date: the FIRST entry in the array wins, not the last', () => {
    const entries = [
      { entry_date: '2026-06-02', value: 80 },
      { entry_date: '2026-06-02', value: 999 },
    ];
    const model = boundsModel({ trackable: T_MANUAL_OK, entries, from, to });
    const idx = expectedDates.indexOf('2026-06-02');
    assert.equal(model.values[idx], 80);
    assert.notEqual(model.values[idx], 999);
    assert.equal(model.pointCount, 1);
  });

  // Label format: 'd MMM', hardcoded English months, no leading zero, no
  // Intl (per §2.5, non-negotiable for determinism across host ICU).
  it('labels are "d MMM" with no leading zero, matching a hand-built (non-Intl) reference', () => {
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function expectedLabel(dateStr) {
      const d = parseLocal(dateStr);
      return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    }
    const model = boundsModel({ trackable: T_MANUAL_OK, entries: [], from: '2026-09-01', to: '2026-09-10' });
    const dates = rangeDays('2026-09-01', '2026-09-10');
    assert.deepEqual(model.labels, dates.map(expectedLabel));
    // single-digit day, no leading zero:
    assert.equal(model.labels[0], '1 Sep');
    assert.ok(!/^0/.test(model.labels[0]));
  });
});

// ===========================================================================
// N9 — boundsModel: status precedence
// ===========================================================================

describe('N9 — boundsModel: status precedence ("empty" beats everything; otherwise mirrors bounds.status)', () => {
  it('from: null, no entries at all -> "empty" (no data to resolve a lower bound from), even though bounds.status would be "ok"', () => {
    const model = boundsModel({ trackable: T_MANUAL_OK, entries: [], from: null, to: '2026-06-05' });
    assert.equal(model.status, 'empty');
    assert.deepEqual(model.labels, []);
    assert.deepEqual(model.dates, []);
    assert.deepEqual(model.values, []);
    assert.deepEqual(model.zones, []);
    assert.equal(model.pointCount, 0);
  });

  it('a well-formed `from`, no entries -> lower bound comes from `from` regardless of data, so NOT empty; mirrors bounds.status ("ok")', () => {
    const model = boundsModel({ trackable: T_MANUAL_OK, entries: [], from: '2026-06-01', to: '2026-06-05' });
    assert.equal(model.status, 'ok');
    assert.equal(model.dates.length, 5);
    assert.deepEqual(model.values, [null, null, null, null, null]);
    assert.equal(model.pointCount, 0);
  });

  it('from: null with a well-formed entry -> lower bound is the earliest entry_date, not empty', () => {
    const entries = [{ entry_date: '2026-06-02', value: 80 }];
    const model = boundsModel({ trackable: T_MANUAL_OK, entries, from: null, to: '2026-06-05' });
    assert.equal(model.status, 'ok');
    assert.notEqual(model.dates.length, 0);
  });

  it('a well-formed `from` that is LATER than `to` -> "empty", even with entries present', () => {
    const entries = [{ entry_date: '2026-06-01', value: 80 }];
    const model = boundsModel({ trackable: T_MANUAL_OK, entries, from: '2026-07-01', to: '2026-06-05' });
    assert.equal(model.status, 'empty');
    assert.deepEqual(model.values, []);
  });

  it('a malformed `from`, no entries -> "empty" (no earliest entry_date to fall back to)', () => {
    const model = boundsModel({ trackable: T_MANUAL_OK, entries: [], from: 'not-a-date', to: '2026-06-05' });
    assert.equal(model.status, 'empty');
  });

  it('a malformed `from` with a well-formed entry -> lower bound derived from that entry; status mirrors bounds.status ("disabled" here)', () => {
    const boolTrackable = { value_shape: 'boolean', bounds_enabled: true };
    const entries = [{ entry_date: '2026-06-02', value: 1 }];
    const model = boundsModel({ trackable: boolTrackable, entries, from: 'nope', to: '2026-06-05' });
    assert.equal(model.status, 'disabled');
    assert.notEqual(model.dates.length, 0);
  });

  it('mirrors "insufficient" when the underlying bounds are insufficient', () => {
    const t = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'auto' };
    const entries = [{ entry_date: '2026-06-02', value: 80 }]; // 1 reading, far below MIN_BOUND_READINGS
    const model = boundsModel({ trackable: t, entries, from: null, to: '2026-06-05' });
    assert.equal(model.status, 'insufficient');
  });

  it('mirrors "invalid" when the underlying manual bounds are invalid (reversed)', () => {
    const t = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'manual', bound_lower: 90, bound_upper: 80 };
    const entries = [{ entry_date: '2026-06-02', value: 80 }];
    const model = boundsModel({ trackable: t, entries, from: null, to: '2026-06-05' });
    assert.equal(model.status, 'invalid');
  });
});

// ===========================================================================
// N10 — boundsAxisFor: EXACTLY {suggestedMin, suggestedMax}, no beginAtZero
// key at all; both bounds strictly inside
// ===========================================================================
//
// Contract correction (coordinator, 2026-08-24): the original §3 text said
// "the same shape as weekly.js's axisBoundsFor", which was under-specified —
// weekly's chart genuinely needs `beginAtZero`/`integer` because it can be a
// bar chart of counts; this chart is never zero-based (it plots a level, and
// a zero-based axis was exactly the Step 3.2c Weight regression), so the
// key must be ABSENT, not present-and-false. A permanently-false flag
// invites someone to flip it later; absence is the stronger guarantee. This
// replaces the earlier, weaker `assert.notEqual(axis.beginAtZero, true)`
// checks (which passed vacuously if the key was simply missing) with an
// exact-keys assertion — the same class of shape guard as CONTRACT-3.2c's
// fix to targetFor's return shape (tests/unit/weekly.test.mjs's "THE
// REGRESSION GUARD for the corrected §2.5" block).
// ===========================================================================

describe('N10 — boundsAxisFor: the y-axis frames data AND both bounds, strictly inside (never on the border)', () => {
  it('values [80,85,90], bounds 78/92 -> suggestedMin < 78 and suggestedMax > 92, using the weekly.js-shaped pad formula', () => {
    // lo = min(80,85,90,78,92) = 78; hi = max(...) = 92; span = 14;
    // pad = span * 0.15 = 2.1 -> suggestedMin 75.9, suggestedMax 94.1.
    const model = { values: [80, 85, 90], bounds: { status: 'ok', lower: 78, upper: 92 } };
    const axis = boundsAxisFor(model);
    assert.ok(axis.suggestedMin < 78, `expected suggestedMin < 78, got ${axis.suggestedMin}`);
    assert.ok(axis.suggestedMax > 92, `expected suggestedMax > 92, got ${axis.suggestedMax}`);
    assert.equal(axis.suggestedMin, 75.9);
    assert.equal(axis.suggestedMax, 94.1);
  });

  it('a tight band close to zero: values [1], bounds 0.5/0.6 -> still strictly inside', () => {
    // lo=0.5, hi=1, span=0.5, pad=0.075 -> suggestedMin 0.425, suggestedMax 1.075.
    const model = { values: [1], bounds: { status: 'ok', lower: 0.5, upper: 0.6 } };
    const axis = boundsAxisFor(model);
    assert.ok(axis.suggestedMin < 0.5);
    assert.ok(axis.suggestedMax > 0.6);
  });

  it('degenerate span (no values, lower === upper === 10): pad falls back to max(1, |hi|*0.1) -> still strictly inside on both sides', () => {
    // lo=hi=10, span=0 -> pad = max(1, 10*0.1) = 1 -> suggestedMin 9, suggestedMax 11.
    const model = { values: [], bounds: { status: 'ok', lower: 10, upper: 10 } };
    const axis = boundsAxisFor(model);
    assert.equal(axis.suggestedMin, 9);
    assert.equal(axis.suggestedMax, 11);
    assert.ok(axis.suggestedMin < 10);
    assert.ok(axis.suggestedMax > 10);
  });

  it('negative-range values: bounds strictly inside still holds below zero (the "never beginAtZero" case made concrete)', () => {
    // lo = min(-50,-40,-45,-35) = -50; hi = max(...) = -35; span=15; pad=2.25.
    const model = { values: [-50, -40], bounds: { status: 'ok', lower: -45, upper: -35 } };
    const axis = boundsAxisFor(model);
    assert.ok(axis.suggestedMin < -45, `expected suggestedMin < -45, got ${axis.suggestedMin}`);
    assert.ok(axis.suggestedMax > -35, `expected suggestedMax > -35, got ${axis.suggestedMax}`);
  });

  // THE SHAPE GUARD: exactly two keys, sorted, for every fixture above plus
  // the degenerate/empty-model case below. Object.keys(...).sort() rather
  // than a plain deepEqual against the object itself, so this fails loudly
  // if a `beginAtZero` (or `integer`, or anything else) key is present,
  // regardless of its value — including `beginAtZero: false`, which the
  // superseded version of this test would have let through.
  describe('THE SHAPE GUARD: boundsAxisFor returns EXACTLY {suggestedMin, suggestedMax} — no beginAtZero, no integer, nothing else', () => {
    const models = [
      { label: 'ok bounds, three values', model: { values: [80, 85, 90], bounds: { status: 'ok', lower: 78, upper: 92 } } },
      { label: 'tight band close to zero', model: { values: [1], bounds: { status: 'ok', lower: 0.5, upper: 0.6 } } },
      { label: 'degenerate span, no values', model: { values: [], bounds: { status: 'ok', lower: 10, upper: 10 } } },
      { label: 'negative-range values', model: { values: [-50, -40], bounds: { status: 'ok', lower: -45, upper: -35 } } },
      { label: 'no bounds at all (non-ok status)', model: { values: [1, 2, 3], bounds: { status: 'insufficient', lower: null, upper: null } } },
      { label: 'fully empty model', model: { values: [], bounds: null } },
    ];
    for (const { label, model } of models) {
      it(`${label}: Object.keys(boundsAxisFor(model)).sort() === ['suggestedMax', 'suggestedMin']`, () => {
        const axis = boundsAxisFor(model);
        assert.deepEqual(Object.keys(axis).sort(), ['suggestedMax', 'suggestedMin']);
      });
    }
  });

  it('never throws for garbage values/bounds', () => {
    const hostile = [
      { values: [], bounds: null },
      { values: null, bounds: { status: 'ok', lower: 1, upper: 2 } },
      { values: [NaN, 'x', null], bounds: { status: 'insufficient', lower: null, upper: null } },
      {},
      null,
    ];
    for (const model of hostile) {
      assert.doesNotThrow(() => boundsAxisFor(model), `threw for ${JSON.stringify(model)}`);
    }
  });
});

// ===========================================================================
// N11 — totality: boundsModel never throws for any hostile combo; malformed
// `to` always throws
// ===========================================================================

describe('N11 — boundsModel totality: a hostile cross-product across all four bounds-status trackables never throws and is always well-formed', () => {
  const T_DISABLED = { value_shape: 'boolean', bounds_enabled: true, bounds_mode: 'auto' };
  const T_INVALID = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'manual', bound_lower: 90, bound_upper: 80 };
  const T_INSUFFICIENT = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'auto' };
  const T_OK = { value_shape: 'numeric', bounds_enabled: true, bounds_mode: 'manual', bound_lower: 10, bound_upper: 20 };
  const trackables = [null, {}, T_DISABLED, T_INVALID, T_INSUFFICIENT, T_OK];

  const entriesOptions = [
    [],
    null,
    'x',
    [null],
    [{}],
    [{ entry_date: 'oops', value: 1 }],
    [{ entry_date: '2026-06-01', value: 'x' }],
    [{ entry_date: '2026-06-01', value: 15 }],
  ];

  const froms = [null, '2026-01-01', 'nope', undefined];
  const to = '2026-06-10';

  function assertWellFormedModel(model, ctx) {
    assert.ok(['ok', 'disabled', 'insufficient', 'invalid', 'empty'].includes(model.status), `${ctx}: bad status ${model.status}`);
    assert.ok(Array.isArray(model.labels), ctx);
    assert.ok(Array.isArray(model.dates), ctx);
    assert.ok(Array.isArray(model.values), ctx);
    assert.ok(Array.isArray(model.zones), ctx);
    const n = model.dates.length;
    assert.equal(model.labels.length, n, `${ctx}: labels length`);
    assert.equal(model.values.length, n, `${ctx}: values length`);
    assert.equal(model.zones.length, n, `${ctx}: zones length`);
    for (const v of model.values) {
      assert.ok(v === null || (typeof v === 'number' && Number.isFinite(v)), `${ctx}: bad value ${JSON.stringify(v)}`);
    }
    for (const z of model.zones) {
      assert.ok(['below', 'in', 'above', 'unknown'].includes(z), `${ctx}: bad zone ${z}`);
    }
    assert.ok(typeof model.pointCount === 'number' && model.pointCount >= 0 && model.pointCount <= n, `${ctx}: bad pointCount ${model.pointCount}`);
    assert.ok(model.unit === null || typeof model.unit === 'string', `${ctx}: bad unit ${JSON.stringify(model.unit)}`);
    assert.ok(model.identityColor === null || typeof model.identityColor === 'string', `${ctx}: bad identityColor ${JSON.stringify(model.identityColor)}`);
    assert.ok(['below', 'in', 'above', 'unknown'].includes(model.todayZone), `${ctx}: bad todayZone ${model.todayZone}`);
    assert.ok(model.bounds && typeof model.bounds === 'object', `${ctx}: bounds missing`);
    if (model.status === 'empty') {
      assert.equal(n, 0, `${ctx}: empty but dates.length !== 0`);
    }
  }

  let count = 0;
  const seenStatuses = new Set();
  for (const trackable of trackables) {
    for (const entries of entriesOptions) {
      for (const from of froms) {
        count += 1;
        const ctx = `combo #${count}: trackable=${JSON.stringify(trackable)} entries=${JSON.stringify(entries)} from=${JSON.stringify(from)}`;
        it(ctx, () => {
          let model;
          assert.doesNotThrow(() => {
            model = boundsModel({ trackable, entries, from, to });
          }, ctx);
          assertWellFormedModel(model, ctx);
          seenStatuses.add(model.status);
        });
      }
    }
  }

  it(`generated ${count} combinations (must be at least 60, per this project's cross-product convention)`, () => {
    assert.ok(count >= 60, `only generated ${count} combinations`);
  });

  describe('a malformed `to` always throws RangeError', () => {
    const badTodays = [null, undefined, '', 'bad', 20260610, '2026-6-1', '2026-13-01', {}, []];
    for (const badTo of badTodays) {
      it(`to=${JSON.stringify(badTo)} throws`, () => {
        assert.throws(() => boundsModel({ trackable: T_OK, entries: [], from: null, to: badTo }), RangeError);
      });
    }
  });
});
