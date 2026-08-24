// Unit tests for the PURE exports of js/charts/weekly.js (BUILD_PLAN Step
// 3.2, "Weekly trend chart + target line") — seriesAggregationFor,
// fillValueFor, weekLabel, targetFor, weekVerdict, weeklyModel. No DOM, no
// window.Chart. Written strictly against CONTRACT-3.2.md §2 and §6.1 (cases
// W1 through W11); the implementation (js/charts/weekly.js) is being written
// in parallel by another agent from the same contract and has NOT been read
// while writing this file.
//
// Fixtures are re-derived from the REAL js/aggregate.js (rollup, fillSeries)
// and js/dates.js (isoWeeksInRange, isoWeekKey) rather than hardcoded and
// trusted — per the contract's own instruction (and this project's repeated
// history, cf. BUILD_PLAN Step 0.0/1.1 postmortems): a wrong hardcoded
// fixture becomes a wrong test that the implementation is then "fixed" to
// satisfy. W11 in particular exists to prove weeklyModel delegates to the
// real rollup() rather than reimplementing weekly grouping — the same class
// of regression guard as heatmap.test.mjs's U8 (verdict delegation).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  seriesAggregationFor,
  fillValueFor,
  weekLabel,
  targetFor,
  weekVerdict,
  weeklyModel,
  axisBoundsFor,
} from '../../js/charts/weekly.js';
import { rollup, fillSeries } from '../../js/aggregate.js';
import { isoWeeksInRange, isoWeekKey, addDays, startOfIsoWeek, parseLocal } from '../../js/dates.js';

// ===========================================================================
// W1 — seriesAggregationFor (contract §2.1) — THE §0(a) DECISION IN CODE
// ===========================================================================

describe('W1 — seriesAggregationFor', () => {
  // THE REGRESSION GUARD FOR §0(a) / THE 2026-08-24 USER DECISION: "the
  // target defines the chart's unit". A trackable whose aggregation says
  // 'sum' but whose target_type is 'weekly_average' must plot AVERAGES, not
  // totals — otherwise the live Calories trackable (aggregation:'sum',
  // target_type:'weekly_average', target_value:1700) would show
  // ~11,900kcal bars against a line at 1,700, pinning the line to the
  // floor. Do not "fix" this branch back to returning trackable.aggregation.
  it('THE DECISION: {aggregation:"sum", target_type:"weekly_average"} -> "average", regardless of aggregation (APP_CONCEPT.md, 2026-08-24)', () => {
    assert.equal(seriesAggregationFor({ aggregation: 'sum', target_type: 'weekly_average' }), 'average');
  });

  it('the weekly_average override wins even when aggregation is missing entirely', () => {
    assert.equal(seriesAggregationFor({ target_type: 'weekly_average' }), 'average');
  });

  it('the weekly_average override wins even when aggregation is garbage', () => {
    assert.equal(seriesAggregationFor({ aggregation: 'bogus', target_type: 'weekly_average' }), 'average');
  });

  it('the weekly_average override wins even when aggregation is a legitimate but different value (count)', () => {
    assert.equal(seriesAggregationFor({ aggregation: 'count', target_type: 'weekly_average' }), 'average');
  });

  const fixtures = [
    [{ aggregation: 'sum', target_type: 'none' }, 'sum'],
    [{ aggregation: 'count', target_type: 'weekly_count' }, 'count'],
    [{ aggregation: 'last', target_type: 'none' }, 'last'],
    [{ aggregation: 'average', target_type: 'none' }, 'average'],
    [{ aggregation: 'bogus', target_type: 'none' }, 'sum'],
    [{}, 'sum'],
    [null, 'sum'],
    [undefined, 'sum'],
    ['x', 'sum'],
    [42, 'sum'],
  ];
  for (const [input, expected] of fixtures) {
    it(`seriesAggregationFor(${JSON.stringify(input)}) === '${expected}'`, () => {
      assert.equal(seriesAggregationFor(input), expected);
    });
  }

  it('never throws across a hostile spread of inputs', () => {
    const hostile = [null, undefined, '', 0, {}, [], 'str', true, NaN, Symbol('x'), { target_type: 42 }];
    for (const x of hostile) {
      let result;
      assert.doesNotThrow(() => {
        result = seriesAggregationFor(x);
      }, `threw for ${String(x)}`);
      assert.ok(['sum', 'count', 'average', 'last'].includes(result), `bad result for ${String(x)}: ${result}`);
    }
  });
});

// ===========================================================================
// W2 — fillValueFor (contract §2.2) — the honesty rule
// ===========================================================================

describe('W2 — fillValueFor', () => {
  const fixtures = [
    ['sum', 0],
    ['count', 0],
    ['average', null],
    ['last', null],
    ['bogus', 0],
  ];
  for (const [input, expected] of fixtures) {
    it(`fillValueFor('${input}') === ${JSON.stringify(expected)}`, () => {
      assert.equal(fillValueFor(input), expected);
    });
  }

  // The honesty rule, asserted explicitly and separately from the fixture
  // table above: a week you didn't weigh yourself is not a week you
  // weighed 0kg. 'average'/'last' must produce a GAP (null), never 0.
  it('average and last give null, and it is strictly not 0 (would drag the trend to the floor)', () => {
    assert.equal(fillValueFor('average'), null);
    assert.notEqual(fillValueFor('average'), 0);
    assert.equal(fillValueFor('last'), null);
    assert.notEqual(fillValueFor('last'), 0);
  });

  it('sum and count give a real zero, not null (a week with no entries genuinely IS zero)', () => {
    assert.equal(fillValueFor('sum'), 0);
    assert.notEqual(fillValueFor('sum'), null);
    assert.equal(fillValueFor('count'), 0);
    assert.notEqual(fillValueFor('count'), null);
  });

  it('never throws for hostile inputs, and anything unrecognized falls back to 0', () => {
    const hostile = [null, undefined, '', 0, {}, [], 'weird', 42, true];
    for (const x of hostile) {
      let result;
      assert.doesNotThrow(() => {
        result = fillValueFor(x);
      });
      assert.equal(result, 0, `expected 0 for unrecognized input ${JSON.stringify(x)}, got ${result}`);
    }
  });
});

// ===========================================================================
// W3 — weekLabel (contract §2.3)
// ===========================================================================

// CONTRACT-3.2b §4 / D5: weekLabel now returns the week's Monday formatted
// 'd MMM' (e.g. '17 Aug'), not the bare 'W34' suffix — Chart.js's autoSkip
// label-thinning made bare week numbers look like missing data. The
// fixtures below are re-derived from the REAL js/dates.js rather than
// trusted, per this file's header (and this project's repeated history of
// wrong hardcoded fixtures becoming wrong tests):
//   - isoWeekKey('2026-08-17') === '2026-W34', so '2026-W34' -> '17 Aug'.
//   - isoWeekKey('2025-12-29') === '2026-W01' (ISO week 1 of 2026 begins in
//     December 2025 — the year-boundary trap dates.js's header warns
//     about), so '2026-W01' -> '29 Dec'.
//   - the OLD '2025-W53' fixture here (kept from Step 3.2, W3) turns out to
//     be INVALID: 2025 is not a leap year and 1 Jan 2025 is a Wednesday, so
//     ISO year 2025 has only 52 weeks — isoWeekKey() never produces
//     '2025-W53' for any real date (isoWeekKey('2025-12-29') resolves to
//     '2026-W01', not '2025-W53'). The bare-number format never had to
//     notice this (it never derives a real date), but the new
//     Monday-derived format does, and per this file's own fixture-accuracy
//     rule a fixture that cannot correspond to any real ISO week cannot be
//     given a principled expected value — see this file's report for the
//     full note. Replaced with '2026-W53', a genuinely real 53-week ISO
//     year (verified: isoWeekKey('2026-12-28') === '2026-W53').
describe('W3 — weekLabel (D5: the week\'s Monday, formatted "d MMM")', () => {
  const fixtures = [
    ['2026-W34', '17 Aug'],
    ['2026-W01', '29 Dec'], // the ISO year-boundary case, required by CONTRACT-3.2b §6.2 B12
    ['2026-W53', '28 Dec'], // a genuine 53-week ISO year
    ['2026-W37', '7 Sep'], // single-digit day: proves no leading zero
  ];
  for (const [input, expected] of fixtures) {
    it(`weekLabel('${input}') === '${expected}'`, () => {
      assert.equal(weekLabel(input), expected);
    });
  }

  it('never produces a leading zero on the day', () => {
    assert.ok(!/^0/.test(weekLabel('2026-W37')), `expected no leading zero, got '${weekLabel('2026-W37')}'`);
  });

  const badCases = ['2026-34', '2026-W3', null, 20260834, undefined, '', '2026-W3A', 'garbage', {}, []];
  for (const bad of badCases) {
    it(`weekLabel(${JSON.stringify(bad)}) throws RangeError`, () => {
      assert.throws(() => weekLabel(bad), RangeError);
    });
  }
});

// ===========================================================================
// B13 — the label round-trip property, over an 18+ month span spanning TWO
// ISO year boundaries (2025->2026 and 2026->2027)
// ===========================================================================

describe('B13 — weekLabel derives the correct Monday for every real isoWeeksInRange() key across an 18+ month span', () => {
  // Independent reference implementation of "week key -> its Monday", built
  // ONLY from real js/dates.js exports (startOfIsoWeek, addDays) and the
  // same "ISO week 1 always contains 4 January" fact isoWeekKey's own
  // header comment documents. This is NOT read from js/charts/weekly.js —
  // it lets this test independently verify which Monday a key MUST map to,
  // then check that weekLabel's output was built from exactly that Monday
  // (rather than trusting weekLabel to grade its own homework).
  function mondayForWeekKey(key) {
    const m = /^(\d{4})-W(\d{2})$/.exec(key);
    const isoYear = Number(m[1]);
    const weekNum = Number(m[2]);
    const week1Monday = startOfIsoWeek(`${isoYear}-01-04`);
    return addDays(week1Monday, (weekNum - 1) * 7);
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function expectedLabelFor(mondayStr) {
    const d = parseLocal(mondayStr);
    return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }

  // Well over 18 months, deliberately straddling TWO real ISO year
  // boundaries — the one documented trap.
  const keys = isoWeeksInRange('2025-06-01', '2027-01-31');

  it('sanity: the span covers at least 18 months of weeks and crosses a year boundary', () => {
    assert.ok(keys.length >= 78, `expected at least 78 weeks (~18 months), got ${keys.length}`);
    assert.ok(keys.some((k) => k.startsWith('2025-')));
    assert.ok(keys.some((k) => k.startsWith('2026-')));
    assert.ok(keys.some((k) => k.startsWith('2027-')));
  });

  it('mondayForWeekKey is itself verified correct: isoWeekKey(monday) === key, for every key in the span', () => {
    for (const key of keys) {
      const monday = mondayForWeekKey(key);
      assert.equal(isoWeekKey(monday), key, `mondayForWeekKey(${key}) = ${monday} does not round-trip`);
    }
  });

  it('weekLabel(key) matches the independently-derived Monday, formatted "d MMM", for every key in the span', () => {
    for (const key of keys) {
      const monday = mondayForWeekKey(key);
      assert.equal(weekLabel(key), expectedLabelFor(monday), `weekLabel(${key}) mismatch`);
    }
  });
});

// ===========================================================================
// W4 — targetFor (contract §2.4) — highest-value case in this group
// ===========================================================================

describe('W4 — targetFor', () => {
  const fixtures = [
    [{ target_type: 'weekly_average', target_value: '1700' }, { value: 1700, kind: 'weekly_average' }],
    [{ target_type: 'weekly_count', target_value: 3 }, { value: 3, kind: 'weekly_count' }],
    [{ target_type: 'weekly_count', target_value: '3' }, { value: 3, kind: 'weekly_count' }],
    [{ target_type: 'none', target_value: '1700' }, null],
    [{ target_type: 'weekly_count', target_value: null }, null],
    [{ target_type: 'weekly_count', target_value: 'abc' }, null],
    [{ target_type: 'specific_days', target_value: 3 }, null],
    [null, null],
    [{}, null],
  ];
  for (const [input, expected] of fixtures) {
    it(`targetFor(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(targetFor(input), expected);
    });
  }

  it('missing target_type entirely -> null', () => {
    assert.equal(targetFor({ target_value: 1700 }), null);
  });

  // THE HIGH-VALUE CASE: 1700 (number) and '1700' (string, as a form input's
  // .value or a localStorage-mirrored row would carry it) must produce the
  // IDENTICAL result.
  it('a numeric 1700 and a string "1700" produce the identical result', () => {
    const fromNumber = targetFor({ target_type: 'weekly_average', target_value: 1700 });
    const fromString = targetFor({ target_type: 'weekly_average', target_value: '1700' });
    assert.deepEqual(fromNumber, fromString);
    assert.deepEqual(fromNumber, { value: 1700, kind: 'weekly_average' });
  });

  // THE TRAP: Number('') === 0 and Number(null) === 0. A coerce-first
  // implementation with no pre-check would silently draw a target line at
  // zero for an unset target. Each of these must give null, not {value:0,...}.
  describe('the coercion trap: an unset target must give null, never a line at zero', () => {
    const trapCases = ['', null, undefined];
    for (const tv of trapCases) {
      it(`target_value === ${JSON.stringify(tv)} -> null (NOT {value:0,...})`, () => {
        const result = targetFor({ target_type: 'weekly_count', target_value: tv });
        assert.equal(result, null);
      });
    }
  });

  // The contract's explicit reject list also names NaN, [], {}, true —
  // items whose Number() coercion is NOT uniformly non-finite (Number([])
  // is 0, Number(true) is 1, both finite). See this file's final report for
  // a note on the tension between that list and the one-line "not a finite
  // number after Number() coercion" framing directly above it in the
  // contract. Tested here per the EXPLICIT list, which is the more specific
  // and more authoritative statement of required behavior.
  describe('the full §2.4 reject list, tested literally', () => {
    const rejectValues = [NaN, null, '', undefined, [], {}, true];
    for (const tv of rejectValues) {
      it(`target_value === ${JSON.stringify(tv) ?? String(tv)} -> null`, () => {
        const result = targetFor({ target_type: 'weekly_count', target_value: tv });
        assert.equal(result, null, `expected null for target_value=${String(tv)}, got ${JSON.stringify(result)}`);
      });
    }
  });

  it('a well-formed numeric string with surrounding content that Number() cannot parse -> null', () => {
    assert.equal(targetFor({ target_type: 'weekly_count', target_value: '3 days' }), null);
  });

  it('never throws across a hostile cross-product of trackable shapes and target_value types', () => {
    const trackables = [
      null,
      undefined,
      {},
      'x',
      42,
      { target_type: 'weekly_average' },
      { target_type: 'weekly_count' },
      { target_type: 'none' },
      { target_type: 'specific_days' },
      { target_type: 42 },
    ];
    const targetValues = [1700, '1700', 0, '0', NaN, null, undefined, '', [], {}, true, false, Infinity, -Infinity, 'abc'];
    for (const t of trackables) {
      for (const tv of targetValues) {
        const input = t && typeof t === 'object' ? { ...t, target_value: tv } : t;
        let result;
        assert.doesNotThrow(() => {
          result = targetFor(input);
        }, `threw for trackable=${JSON.stringify(t)} target_value=${String(tv)}`);
        assert.ok(
          result === null || (typeof result === 'object' && typeof result.value === 'number' && Number.isFinite(result.value)),
          `bad result for trackable=${JSON.stringify(t)} target_value=${String(tv)}: ${JSON.stringify(result)}`
        );
      }
    }
  });
});

// ===========================================================================
// W5 — weekVerdict (contract §2.5)
// ===========================================================================

describe('W5 — weekVerdict', () => {
  const target = { value: 3 };
  const fixtures = [
    [3, target, 'build', 'good'],
    [4, target, 'build', 'good'],
    [2, target, 'build', 'bad'],
    [0, target, 'build', 'bad'],
    [3, target, 'break', 'good'],
    [2, target, 'break', 'good'],
    [4, target, 'break', 'bad'],
    [null, target, 'build', 'none'],
    [2, null, 'build', 'none'],
  ];
  for (const [value, tgt, direction, expected] of fixtures) {
    it(`weekVerdict(${JSON.stringify(value)}, ${JSON.stringify(tgt)}, '${direction}') === '${expected}'`, () => {
      assert.equal(weekVerdict(value, tgt, direction), expected);
    });
  }

  describe('both inclusive boundaries, explicit', () => {
    it('build: value === target.value counts as hitting it (good), not just exceeding', () => {
      assert.equal(weekVerdict(3, { value: 3 }, 'build'), 'good');
    });
    it('break: value === target.value counts as hitting it (good), not just staying under', () => {
      assert.equal(weekVerdict(3, { value: 3 }, 'break'), 'good');
    });
  });

  describe('direction handling', () => {
    it('missing direction defaults to build behavior (>= is good)', () => {
      assert.equal(weekVerdict(4, { value: 3 }, undefined), 'good');
      assert.equal(weekVerdict(2, { value: 3 }, undefined), 'bad');
    });
    it('an unknown direction string also defaults to build behavior', () => {
      assert.equal(weekVerdict(4, { value: 3 }, 'sideways'), 'good');
      assert.equal(weekVerdict(2, { value: 3 }, 'sideways'), 'bad');
    });
  });

  describe('a gap week (non-finite value) is always none, regardless of target/direction', () => {
    for (const v of [null, undefined, NaN, Infinity, -Infinity, 'x', {}, []]) {
      it(`value=${JSON.stringify(v)} -> 'none'`, () => {
        assert.equal(weekVerdict(v, { value: 3 }, 'build'), 'none');
      });
    }
  });

  describe('a null target is always none, regardless of value/direction', () => {
    for (const v of [3, 0, -5, 100]) {
      it(`value=${v}, target=null -> 'none'`, () => {
        assert.equal(weekVerdict(v, null, 'build'), 'none');
        assert.equal(weekVerdict(v, null, 'break'), 'none');
      });
    }
  });

  describe('fuzz: never throws, always one of good/bad/none', () => {
    const values = [3, 4, 2, 0, NaN, 'x', null, {}];
    const targets = [null, { value: 3 }, { value: 0 }, { value: NaN }, 'x'];
    const directions = ['build', 'break', 'weird', undefined];
    let n = 0;
    for (const v of values) {
      for (const t of targets) {
        for (const d of directions) {
          n += 1;
          it(`combo #${n}: value=${JSON.stringify(v)} target=${JSON.stringify(t)} direction=${JSON.stringify(d)}`, () => {
            let result;
            assert.doesNotThrow(() => {
              result = weekVerdict(v, t, d);
            });
            assert.ok(['good', 'bad', 'none'].includes(result), `bad result: ${result}`);
          });
        }
      }
    }
  });
});

// ===========================================================================
// W6 — the worked Calories fixture, end to end (contract §2.6 worked example)
// ===========================================================================

describe('W6 — the worked Calories fixture: average, not sum; the target line is meaningful', () => {
  // trackable = {value_shape:'numeric', aggregation:'sum', direction:'break',
  // target_type:'weekly_average', target_value:'1700', unit:'kcal'}
  // Entries in ISO week 2026-W34 (Mon 2026-08-17 ... Sun 2026-08-23):
  // 08-17: 1600, 08-18: 1800, 08-19: 1700.
  const trackable = {
    value_shape: 'numeric',
    aggregation: 'sum',
    direction: 'break',
    target_type: 'weekly_average',
    target_value: '1700',
    unit: 'kcal',
  };
  const entries = [
    { entry_date: '2026-08-17', value: 1600 },
    { entry_date: '2026-08-18', value: 1800 },
    { entry_date: '2026-08-19', value: 1700 },
  ];
  const to = '2026-08-23';

  it('sanity: all three entry dates and `to` really do fall in the same real ISO week', () => {
    const keys = new Set(entries.map((e) => isoWeekKey(e.entry_date)));
    keys.add(isoWeekKey(to));
    assert.equal(keys.size, 1, `expected one ISO week, got: ${[...keys].join(', ')}`);
  });

  it('seriesAggregationFor picks "average", not "sum" — the §0(a) decision applied to this exact fixture', () => {
    assert.equal(seriesAggregationFor(trackable), 'average');
  });

  it('the bar value is 1700 (the average), derived via the REAL rollup(), and is explicitly NOT 5100 (the sum)', () => {
    const agg = seriesAggregationFor(trackable);
    const buckets = rollup(entries, 'week', agg);
    assert.equal(buckets.length, 1);
    const expectedAverage = buckets[0].value;
    assert.equal(expectedAverage, 1700); // sum 5100 / 3 days-with-an-entry

    const model = weeklyModel({ trackable, entries, from: null, to });
    assert.equal(model.weekCount, 1);
    assert.equal(model.values[0], expectedAverage);
    assert.equal(model.values[0], 1700);
    assert.notEqual(model.values[0], 5100);
  });

  it('the target is {value:1700, kind:"weekly_average"} — the string "1700" was coerced', () => {
    const model = weeklyModel({ trackable, entries, from: null, to });
    assert.deepEqual(model.target, { value: 1700, kind: 'weekly_average' });
  });

  it('the verdict is "good" — the average lands exactly on the target line (inclusive)', () => {
    const model = weeklyModel({ trackable, entries, from: null, to });
    assert.equal(model.verdicts[0], 'good');
  });

  it('the rest of the model shape is well-formed for this fixture', () => {
    const model = weeklyModel({ trackable, entries, from: null, to });
    assert.equal(model.isEmpty, false);
    assert.equal(model.aggregation, 'average');
    assert.equal(model.unit, 'kcal');
    assert.equal(model.direction, 'break');
    assert.equal(model.weekKeys.length, 1);
    assert.equal(model.labels[0], weekLabel(model.weekKeys[0]));
  });
});

// ===========================================================================
// W7 — zero-entry weeks are present, not omitted (§0(c))
// ===========================================================================

describe('W7 — zero-entry weeks are present in the model, not omitted', () => {
  // Two entries separated by (at least) three empty ISO weeks. +35 days is
  // exactly 5 ISO weeks later regardless of what day of the week the base
  // date falls on (each ISO week is a fixed 7-day Monday-aligned span), so
  // this guarantees 4 clear empty weeks strictly between the two entries —
  // comfortably more than the "at least three" the case calls for, without
  // hardcoding or trusting any specific week-number table.
  const firstDate = '2026-01-05';
  const secondDate = addDays(firstDate, 35);
  const to = secondDate;
  const entries = [
    { entry_date: firstDate, value: 10 },
    { entry_date: secondDate, value: 20 },
  ];

  it('sanity: the two dates really are five real ISO weeks apart, with real empty weeks between them', () => {
    const expectedKeys = isoWeeksInRange(firstDate, to);
    // 5 weeks apart, both endpoints inclusive -> 6 distinct week keys.
    assert.equal(expectedKeys.length, 6);
    assert.equal(expectedKeys[0], isoWeekKey(firstDate));
    assert.equal(expectedKeys[expectedKeys.length - 1], isoWeekKey(secondDate));
  });

  describe('sum trackable: gap weeks are an explicit 0', () => {
    const trackable = { aggregation: 'sum', target_type: 'none' };
    const model = weeklyModel({ trackable, entries, from: null, to });
    const expectedKeys = isoWeeksInRange(firstDate, to);

    it('weekKeys/labels cover every real week in the span, in order — cross-checked against isoWeeksInRange', () => {
      assert.deepEqual(model.weekKeys, expectedKeys);
      assert.equal(model.labels.length, expectedKeys.length);
    });

    it('values match the REAL rollup()+fillSeries() output exactly, value for value', () => {
      const agg = seriesAggregationFor(trackable);
      const buckets = rollup(entries, 'week', agg);
      const filled = fillSeries(buckets, expectedKeys, fillValueFor(agg));
      assert.deepEqual(model.values, filled.map((f) => f.value));
    });

    it('the endpoints carry the real values and every week strictly between them is 0, not omitted', () => {
      assert.equal(model.values[0], 10);
      assert.equal(model.values[model.values.length - 1], 20);
      for (let i = 1; i < model.values.length - 1; i++) {
        assert.equal(model.values[i], 0, `gap week at index ${i} (${model.weekKeys[i]}) was not 0`);
      }
      assert.ok(model.values.length - 2 >= 3, 'expected at least 3 gap weeks between the two entries');
    });
  });

  describe('average trackable: gap weeks are an explicit null (honesty rule), never 0', () => {
    const trackable = { aggregation: 'average', target_type: 'none' };
    const model = weeklyModel({ trackable, entries, from: null, to });
    const expectedKeys = isoWeeksInRange(firstDate, to);

    it('weekKeys cover every real week in the span, same as the sum case', () => {
      assert.deepEqual(model.weekKeys, expectedKeys);
    });

    it('values match the REAL rollup()+fillSeries() output exactly', () => {
      const agg = seriesAggregationFor(trackable);
      const buckets = rollup(entries, 'week', agg);
      const filled = fillSeries(buckets, expectedKeys, fillValueFor(agg));
      assert.deepEqual(model.values, filled.map((f) => f.value));
    });

    it('the endpoints carry real values and every gap week is null, never 0', () => {
      assert.equal(model.values[0], 10);
      assert.equal(model.values[model.values.length - 1], 20);
      for (let i = 1; i < model.values.length - 1; i++) {
        assert.equal(model.values[i], null, `gap week at index ${i} (${model.weekKeys[i]}) was not null`);
        assert.notEqual(model.values[i], 0);
      }
    });
  });
});

// ===========================================================================
// W8 — arrays stay aligned
// ===========================================================================

describe('W8 — labels.length === values.length === verdicts.length === weekKeys.length === weekCount', () => {
  function assertAligned(model, label) {
    const n = model.weekKeys.length;
    assert.equal(model.labels.length, n, `${label}: labels length mismatch`);
    assert.equal(model.values.length, n, `${label}: values length mismatch`);
    assert.equal(model.verdicts.length, n, `${label}: verdicts length mismatch`);
    assert.equal(model.weekCount, n, `${label}: weekCount mismatch`);
  }

  it('the empty model (no entries, all range)', () => {
    const model = weeklyModel({ trackable: { aggregation: 'sum', target_type: 'none' }, entries: [], from: null, to: '2026-08-23' });
    assertAligned(model, 'empty model');
    assert.equal(model.weekCount, 0);
  });

  it('the worked Calories fixture (single week)', () => {
    const trackable = { value_shape: 'numeric', aggregation: 'sum', direction: 'break', target_type: 'weekly_average', target_value: '1700', unit: 'kcal' };
    const entries = [
      { entry_date: '2026-08-17', value: 1600 },
      { entry_date: '2026-08-18', value: 1800 },
      { entry_date: '2026-08-19', value: 1700 },
    ];
    const model = weeklyModel({ trackable, entries, from: null, to: '2026-08-23' });
    assertAligned(model, 'Calories fixture');
  });

  it('a multi-week zero-gap span (sum)', () => {
    const model = weeklyModel({
      trackable: { aggregation: 'sum', target_type: 'none' },
      entries: [{ entry_date: '2026-01-05', value: 10 }, { entry_date: addDays('2026-01-05', 35), value: 20 }],
      from: null,
      to: addDays('2026-01-05', 35),
    });
    assertAligned(model, 'multi-week sum span');
  });

  it('a wide explicit-`from` range with sparse entries', () => {
    const model = weeklyModel({
      trackable: { aggregation: 'count', target_type: 'weekly_count', target_value: 3, direction: 'build' },
      entries: [{ entry_date: '2026-06-15', value: 1 }],
      from: '2026-01-01',
      to: '2026-08-23',
    });
    assertAligned(model, 'wide explicit-from range');
    assert.ok(model.weekCount > 10, 'expected a genuinely wide span of weeks');
  });

  it('a hostile/garbage trackable and entries', () => {
    const model = weeklyModel({ trackable: { aggregation: 'bogus' }, entries: [null, {}, 'x'], from: 'nope', to: '2026-08-23' });
    assertAligned(model, 'hostile inputs');
  });
});

// ===========================================================================
// W9 — the 'all' range (from: null)
// ===========================================================================

describe("W9 — the 'all' range", () => {
  it('from: null derives the lower bound from the earliest well-formed entry_date, even when entries are unsorted', () => {
    const trackable = { aggregation: 'sum', target_type: 'none' };
    const entries = [
      { entry_date: '2026-03-10', value: 5 },
      { entry_date: '2026-02-01', value: 3 }, // earliest, deliberately not first in the array
      { entry_date: '2026-03-01', value: 7 },
    ];
    const to = '2026-03-15';
    const model = weeklyModel({ trackable, entries, from: null, to });
    const expectedKeys = isoWeeksInRange('2026-02-01', to);
    assert.deepEqual(model.weekKeys, expectedKeys);
    assert.equal(model.isEmpty, false);
  });

  it('entries with malformed entry_date strings are excluded from the earliest-date search', () => {
    const trackable = { aggregation: 'sum', target_type: 'none' };
    const entries = [
      { entry_date: 'not-a-date', value: 99 },
      { entry_date: '2026-05-01', value: 3 },
    ];
    const to = '2026-05-15';
    const model = weeklyModel({ trackable, entries, from: null, to });
    const expectedKeys = isoWeeksInRange('2026-05-01', to);
    assert.deepEqual(model.weekKeys, expectedKeys);
  });

  it('no entries at all -> isEmpty:true, all four arrays [], weekCount 0 — but target/unit/identityColor/aggregation/direction stay populated', () => {
    const trackable = {
      aggregation: 'sum',
      target_type: 'weekly_count',
      target_value: 3,
      unit: 'kg',
      direction: 'build',
      color: '#abc123',
    };
    const model = weeklyModel({ trackable, entries: [], from: null, to: '2026-03-15' });
    assert.equal(model.isEmpty, true);
    assert.deepEqual(model.labels, []);
    assert.deepEqual(model.values, []);
    assert.deepEqual(model.verdicts, []);
    assert.deepEqual(model.weekKeys, []);
    assert.equal(model.weekCount, 0);
    // Still populated so the view can render a sensible "no data yet" state.
    assert.equal(model.aggregation, 'sum');
    assert.deepEqual(model.target, { value: 3, kind: 'weekly_count' });
    assert.equal(model.unit, 'kg');
    assert.equal(model.direction, 'build');
  });

  it('a `from` later than `to` gives the empty model, even with entries present', () => {
    const trackable = { aggregation: 'sum', target_type: 'none' };
    const entries = [{ entry_date: '2026-03-01', value: 1 }];
    const model = weeklyModel({ trackable, entries, from: '2026-04-01', to: '2026-03-15' });
    assert.equal(model.isEmpty, true);
    assert.equal(model.weekCount, 0);
    assert.deepEqual(model.values, []);
  });

  it('a malformed `from` string degrades to null (same result as from:null), per §2.6\'s "garbage from -> treated as null"', () => {
    const trackable = { aggregation: 'sum', target_type: 'none' };
    const entries = [
      { entry_date: '2026-02-01', value: 3 },
      { entry_date: '2026-03-01', value: 7 },
    ];
    const to = '2026-03-15';
    const withNull = weeklyModel({ trackable, entries, from: null, to });
    const withGarbage = weeklyModel({ trackable, entries, from: 'nope', to });
    assert.deepEqual(withGarbage.weekKeys, withNull.weekKeys);
    assert.deepEqual(withGarbage.values, withNull.values);
    assert.deepEqual(withGarbage.labels, withNull.labels);
  });
});

// ===========================================================================
// W10 — totality: never throws (except malformed `to`), always well-formed
// ===========================================================================

describe('W10 — weeklyModel never throws for any (trackable, entries, from) combo, and always returns a well-formed model', () => {
  function assertWellFormedModel(model, ctx) {
    assert.equal(typeof model.isEmpty, 'boolean', ctx);
    assert.ok(['sum', 'count', 'average', 'last'].includes(model.aggregation), `${ctx}: bad aggregation ${model.aggregation}`);
    assert.ok(Array.isArray(model.weekKeys), ctx);
    assert.ok(Array.isArray(model.labels), ctx);
    assert.ok(Array.isArray(model.values), ctx);
    assert.ok(Array.isArray(model.verdicts), ctx);
    const n = model.weekKeys.length;
    assert.equal(model.labels.length, n, `${ctx}: labels length`);
    assert.equal(model.values.length, n, `${ctx}: values length`);
    assert.equal(model.verdicts.length, n, `${ctx}: verdicts length`);
    assert.equal(model.weekCount, n, `${ctx}: weekCount`);
    for (const v of model.values) {
      assert.ok(v === null || (typeof v === 'number' && !Number.isNaN(v)), `${ctx}: bad value ${JSON.stringify(v)}`);
    }
    for (const vd of model.verdicts) {
      assert.ok(['good', 'bad', 'none'].includes(vd), `${ctx}: bad verdict ${vd}`);
    }
    for (const l of model.labels) {
      assert.equal(typeof l, 'string', ctx);
    }
    assert.ok(
      model.target === null || (typeof model.target === 'object' && typeof model.target.value === 'number'),
      `${ctx}: bad target ${JSON.stringify(model.target)}`
    );
    assert.ok(model.unit === null || typeof model.unit === 'string', ctx);
    assert.ok(model.identityColor === null || typeof model.identityColor === 'string', ctx);
    assert.equal(typeof model.direction, 'string', ctx);
    if (model.isEmpty) {
      assert.equal(n, 0, `${ctx}: isEmpty but weekCount !== 0`);
    }
  }

  const trackables = [
    null,
    {},
    { value_shape: 'boolean', aggregation: 'count', direction: 'build', target_type: 'weekly_count', target_value: 3 }, // valid boolean
    { value_shape: 'numeric', aggregation: 'sum', direction: 'break', target_type: 'weekly_average', target_value: 1700, unit: 'kcal' }, // valid numeric
    { aggregation: 'bogus' },
  ];
  const entriesOptions = [
    [],
    null,
    'x',
    [null],
    [{}],
    [{ entry_date: 'oops', value: 1 }],
    [{ entry_date: '2026-08-17', value: 'x' }],
  ];
  const froms = [null, '2026-08-01', 'nope'];
  const to = '2026-08-23';

  let count = 0;
  for (const trackable of trackables) {
    for (const entries of entriesOptions) {
      for (const from of froms) {
        count += 1;
        const ctx = `combo #${count}: trackable=${JSON.stringify(trackable)} entries=${JSON.stringify(entries)} from=${JSON.stringify(from)}`;
        it(ctx, () => {
          let model;
          assert.doesNotThrow(() => {
            model = weeklyModel({ trackable, entries, from, to });
          }, ctx);
          assertWellFormedModel(model, ctx);
        });
      }
    }
  }

  it(`generated ${count} combinations (must be at least 60, per this contract's cross-product size)`, () => {
    assert.ok(count >= 60, `only generated ${count} combinations`);
  });

  describe('a malformed `to` always throws RangeError', () => {
    const badTodays = [null, undefined, '', 'bad', 20260823, '2026-8-3', '2026-13-01', {}, []];
    for (const badTo of badTodays) {
      it(`to=${JSON.stringify(badTo)} throws`, () => {
        assert.throws(
          () => weeklyModel({ trackable: {}, entries: [], from: null, to: badTo }),
          RangeError
        );
      });
    }
  });
});

// ===========================================================================
// W11 — no reimplementation (§0(b) guard)
// ===========================================================================

describe('W11 — weeklyModel delegates to the real rollup(), not a second grouping implementation', () => {
  it('matches rollup() value-for-value on the worked Calories fixture', () => {
    const trackable = {
      value_shape: 'numeric',
      aggregation: 'sum',
      direction: 'break',
      target_type: 'weekly_average',
      target_value: '1700',
      unit: 'kcal',
    };
    const entries = [
      { entry_date: '2026-08-17', value: 1600 },
      { entry_date: '2026-08-18', value: 1800 },
      { entry_date: '2026-08-19', value: 1700 },
    ];
    const to = '2026-08-23';
    const model = weeklyModel({ trackable, entries, from: null, to });
    const agg = seriesAggregationFor(trackable);
    const buckets = rollup(entries, 'week', agg);
    for (const bucket of buckets) {
      const idx = model.weekKeys.indexOf(bucket.key);
      assert.ok(idx !== -1, `bucket key ${bucket.key} missing from model.weekKeys`);
      assert.equal(model.values[idx], bucket.value);
    }
  });

  it('matches rollup() across a wider, multi-week, multi-aggregation spread', () => {
    const entries = [
      { entry_date: '2026-02-02', value: 5 },
      { entry_date: '2026-02-03', value: 7 },
      { entry_date: '2026-02-10', value: 100 },
      { entry_date: '2026-02-16', value: 1 },
      { entry_date: '2026-02-17', value: 1 },
      { entry_date: '2026-02-17', value: 1 }, // second entry, same date: 'last'/'count' semantics matter
    ];
    const to = '2026-02-28';

    for (const [aggregation, target_type] of [
      ['sum', 'none'],
      ['count', 'weekly_count'],
      ['average', 'none'],
      ['last', 'none'],
    ]) {
      const trackable = { aggregation, target_type, target_value: 1 };
      const model = weeklyModel({ trackable, entries, from: null, to });
      const agg = seriesAggregationFor(trackable);
      assert.equal(agg, aggregation === 'sum' && target_type === 'none' ? 'sum' : agg); // sanity, no override in play here
      const buckets = rollup(entries, 'week', agg);
      assert.ok(buckets.length > 0, `expected at least one bucket for aggregation=${aggregation}`);
      for (const bucket of buckets) {
        const idx = model.weekKeys.indexOf(bucket.key);
        assert.ok(idx !== -1, `[${aggregation}] bucket key ${bucket.key} missing from model.weekKeys`);
        assert.equal(model.values[idx], bucket.value, `[${aggregation}] mismatch at week ${bucket.key}`);
      }
    }
  });

  // weeklyModel's `entries` are already scoped to this trackable by the
  // caller and must NOT be re-filtered by trackable_id (contract §2.6: "not
  // re-filtered here"; the same rule rollup() itself follows, per its own
  // header comment in js/aggregate.js). An implementation that accidentally
  // filters by `entry.trackable_id === trackable.id` would silently drop
  // entries whenever the caller's scoping doesn't line up with that exact
  // comparison — this proves both entries land in the bucket regardless.
  it('does not filter entries by trackable_id — matches rollup(), which also ignores it', () => {
    const trackable = { id: 1, value_shape: 'numeric', aggregation: 'sum', target_type: 'none', direction: 'build' };
    const entries = [
      { entry_date: '2026-08-17', value: 100, trackable_id: 999 },
      { entry_date: '2026-08-17', value: 50, trackable_id: 1 },
    ];
    const to = '2026-08-23';
    const model = weeklyModel({ trackable, entries, from: null, to });
    const buckets = rollup(entries, 'week', 'sum');
    assert.equal(model.values[0], buckets[0].value);
    assert.equal(model.values[0], 150);
  });
});

// ===========================================================================
// CONTRACT-3.2b §3 / §6.2 — D2/D3/D4 fix: axisBoundsFor (cases B8-B11)
//
// Root cause (§0): scales.y had no bounds derivation at all — Chart.js fell
// back to its own defaults, which produced fractional count ticks (D2), a
// target line sitting exactly on the axis border (D3), and a 0-80 axis for
// a single 80-value point (D4). axisBoundsFor is a brand-new pure function;
// it does not exist in the pre-fix module at all, so every case below fails
// to even import against pre-fix code.
// ===========================================================================

describe('B8 — axisBoundsFor against all five CONTRACT-3.2b §3 worked rows, field by field', () => {
  it('D3 Calories: values [1700], target 1700 -> lo=hi=1700, pad=170, suggestedMin 1530, suggestedMax 1870', () => {
    const bounds = axisBoundsFor({ values: [1700], target: { value: 1700 }, aggregation: 'average' });
    assert.equal(bounds.beginAtZero, false);
    assert.equal(bounds.integer, true);
    assert.equal(bounds.suggestedMin, 1530);
    assert.equal(bounds.suggestedMax, 1870);
  });

  it('D4 Weight: single value 80, no target, aggregation "last" -> beginAtZero false, 72...88 (NOT 0...80)', () => {
    const bounds = axisBoundsFor({ values: [80], target: null, aggregation: 'last' });
    assert.equal(bounds.beginAtZero, false);
    assert.equal(bounds.suggestedMin, 72);
    assert.equal(bounds.suggestedMax, 88);
  });

  it('D2 Workout: aggregation "count", values [0,0,2,0] -> beginAtZero true, integer true, suggestedMin 0, suggestedMax 3', () => {
    const bounds = axisBoundsFor({ values: [0, 0, 2, 0], target: null, aggregation: 'count' });
    assert.equal(bounds.beginAtZero, true);
    assert.equal(bounds.integer, true);
    assert.equal(bounds.suggestedMin, 0);
    assert.equal(bounds.suggestedMax, 3);
  });

  it('Empty: no values, no target -> suggestedMin/suggestedMax both undefined', () => {
    const bounds = axisBoundsFor({ values: [], target: null, aggregation: 'sum' });
    assert.equal(bounds.suggestedMin, undefined);
    assert.equal(bounds.suggestedMax, undefined);
  });

  it('Target only: no values, target 3, non-zero-based aggregation -> 2...4', () => {
    const bounds = axisBoundsFor({ values: [], target: { value: 3 }, aggregation: 'last' });
    assert.equal(bounds.beginAtZero, false);
    assert.equal(bounds.suggestedMin, 2);
    assert.equal(bounds.suggestedMax, 4);
  });

  it('Target only: no values, target 3, zero-based aggregation -> 0...4', () => {
    const bounds = axisBoundsFor({ values: [], target: { value: 3 }, aggregation: 'count' });
    assert.equal(bounds.beginAtZero, true);
    assert.equal(bounds.suggestedMin, 0);
    assert.equal(bounds.suggestedMax, 4);
  });
});

describe('B9 — THE D3 CASE, NAMED: the target line is strictly inside the axis, never on its edge', () => {
  it('values [1700], target 1700 -> suggestedMax > 1700 strictly', () => {
    const bounds = axisBoundsFor({ values: [1700], target: { value: 1700 }, aggregation: 'average' });
    assert.ok(bounds.suggestedMax > 1700, `expected suggestedMax > 1700, got ${bounds.suggestedMax}`);
  });
});

describe('B10 — THE D4 CASE, NAMED: a single data point does not fall back to a zero-based axis', () => {
  it("single value 80, aggregation 'last' -> beginAtZero false and suggestedMin > 0 strictly", () => {
    const bounds = axisBoundsFor({ values: [80], target: null, aggregation: 'last' });
    assert.equal(bounds.beginAtZero, false);
    assert.ok(bounds.suggestedMin > 0, `expected suggestedMin > 0, got ${bounds.suggestedMin}`);
  });
});

describe('B11 — THE D2 CASE, NAMED: integer axis suppression', () => {
  it("aggregation 'count', values [0,0,2,0] -> integer true (stops the 1.5, 2, 2.5, 3 ticks)", () => {
    const bounds = axisBoundsFor({ values: [0, 0, 2, 0], target: null, aggregation: 'count' });
    assert.equal(bounds.integer, true);
  });

  it('a series containing 1.5 -> integer false', () => {
    const bounds = axisBoundsFor({ values: [0, 1.5, 2], target: null, aggregation: 'count' });
    assert.equal(bounds.integer, false);
  });

  it('an all-integer series with a fractional target -> integer false', () => {
    const bounds = axisBoundsFor({ values: [0, 1, 2], target: { value: 1.5 }, aggregation: 'sum' });
    assert.equal(bounds.integer, false);
  });

  it('an all-integer series with an integer target -> integer true', () => {
    const bounds = axisBoundsFor({ values: [0, 1, 2], target: { value: 3 }, aggregation: 'sum' });
    assert.equal(bounds.integer, true);
  });
});

// ===========================================================================
// B14 — model.weekKeys still carries full ISO keys, unchanged by the D5
// label change (the tooltip's source, per CONTRACT-3.2b §4's final note)
// ===========================================================================

describe('B14 — weeklyModel.weekKeys still carries full ISO week keys after the D5 label shortening', () => {
  it('weekKeys stay in the full YYYY-Wnn shape, distinct in form from the new short labels', () => {
    const trackable = { aggregation: 'sum', target_type: 'none' };
    const entries = [
      { entry_date: '2026-08-17', value: 1 },
      { entry_date: '2026-08-24', value: 1 },
    ];
    const model = weeklyModel({ trackable, entries, from: null, to: '2026-08-30' });
    assert.ok(model.weekKeys.length > 0);
    for (const key of model.weekKeys) {
      assert.match(key, /^\d{4}-W\d{2}$/, `weekKeys entry '${key}' is not a full ISO key`);
    }
    // labels are the new SHORT form; weekKeys must remain the FULL form —
    // proving the tooltip's source (weekKeys) wasn't collapsed to match the
    // shortened axis labels.
    assert.notEqual(model.labels[0], model.weekKeys[0]);
    assert.equal(model.labels[0], weekLabel(model.weekKeys[0]));
  });
});
