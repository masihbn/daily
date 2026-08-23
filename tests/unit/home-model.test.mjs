// Contract tests for js/views/home-model.js (BUILD_PLAN Step 2.1, revised by
// Step 2.1b) — pure functions, no DOM, no fetch, no localStorage. Written
// strictly from CONTRACT-2.1.md §2 and CONTRACT-2.1b.md §3; the
// implementation is being written in parallel by another agent from the
// same contracts, so every assertion here is against the documented worked
// examples and rules, not against any particular internal approach.
//
// CONTRACT-2.1b.md ("Replace-only logging + direction-aware visuals") adds
// four new pure functions (verdict, statusWord, statusSymbol,
// directionLabel) and rewrites relogHint to remove all additive/cumulative
// wording — re-logging a numeric trackable now always REPLACES the day's
// value, and the hint text no longer varies by relog_semantic at all. Cases
// below marked "2.1b" are new or rewritten for that revision; everything
// else is unchanged Step 2.1 coverage.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  visibleTrackables,
  formatValue,
  relogHint,
  parseNumericInput,
  nextValueFor,
  rowModel,
  verdict,
  statusWord,
  statusSymbol,
  directionLabel,
} from '../../js/views/home-model.js';

// ===========================================================================
// visibleTrackables (contract §2.1)
// ===========================================================================

describe('visibleTrackables — non-array input -> []', () => {
  const nonArrayInputs = [
    ['null', null],
    ['undefined', undefined],
    ['{}', {}],
    ["'a string'", 'a string'],
    ['0', 0],
    ['NaN', NaN],
    ['true', true],
  ];
  for (const [label, input] of nonArrayInputs) {
    it(`${label} -> []`, () => {
      assert.deepEqual(visibleTrackables(input), []);
    });
  }
});

describe('visibleTrackables — drops non-object elements', () => {
  it('drops null/primitive elements, keeps object elements', () => {
    const input = [null, 1, 'x', true, undefined, NaN, { id: 1, sort_order: 0 }];
    const result = visibleTrackables(input);
    assert.deepEqual(result.map((t) => t.id), [1]);
  });
});

describe('visibleTrackables — archived filtering', () => {
  it('drops only strict archived === true', () => {
    const input = [{ id: 1, archived: true }, { id: 2, archived: false }];
    assert.deepEqual(visibleTrackables(input).map((t) => t.id), [2]);
  });

  it('keeps archived absent, false, or null (not just strict true is dropped)', () => {
    const input = [
      { id: 1 },
      { id: 2, archived: false },
      { id: 3, archived: null },
    ];
    assert.deepEqual(visibleTrackables(input).map((t) => t.id), [1, 2, 3]);
  });

  it('a truthy but non-strict-true archived value (e.g. 1, "true") does NOT drop the row', () => {
    const input = [
      { id: 1, archived: 1, sort_order: 0 },
      { id: 2, archived: 'true', sort_order: 1 },
    ];
    assert.deepEqual(visibleTrackables(input).map((t) => t.id), [1, 2]);
  });
});

describe('visibleTrackables — worked example (contract §2.1, assert exactly)', () => {
  const input = [
    { id: 3, sort_order: 1 },
    { id: 1, sort_order: 5 },
    { id: 2, sort_order: 1 },
    { id: 9, sort_order: 0, archived: true },
    { id: 4 },
  ];

  it('output ids in order [4, 2, 3, 1]', () => {
    const result = visibleTrackables(input);
    assert.deepEqual(result.map((t) => t.id), [4, 2, 3, 1]);
  });

  it('does not mutate the input array or its element order', () => {
    const originalOrder = input.map((t) => t.id);
    const originalLength = input.length;
    visibleTrackables(input);
    assert.equal(input.length, originalLength);
    assert.deepEqual(input.map((t) => t.id), originalOrder);
  });

  it('returns a different array reference but the same element object references', () => {
    const result = visibleTrackables(input);
    assert.notEqual(result, input);
    for (const row of result) {
      const original = input.find((t) => t.id === row.id);
      assert.equal(row, original, `element for id ${row.id} should be the same object reference`);
    }
  });
});

describe('visibleTrackables — sort_order coercion', () => {
  it('non-finite sort_order (NaN, missing, Infinity, a string) is treated as 0', () => {
    const input = [
      { id: 4, sort_order: Infinity },
      { id: 1, sort_order: 0 },
      { id: 2, sort_order: NaN },
      { id: 3 }, // missing
      { id: 5, sort_order: 'nope' },
    ];
    // All effectively sort_order:0 except id:4 (Infinity is not finite -> also 0).
    // So all five tie on sort_order -> ordered by id: 1,2,3,4,5.
    assert.deepEqual(visibleTrackables(input).map((t) => t.id), [1, 2, 3, 4, 5]);
  });
});

describe('visibleTrackables — id comparison rules', () => {
  it('numeric-looking ids (numbers or digit strings) compare numerically, not lexicographically', () => {
    const input = [
      { id: '10', sort_order: 0 },
      { id: '2', sort_order: 0 },
      { id: 1, sort_order: 0 },
    ];
    assert.deepEqual(visibleTrackables(input).map((t) => t.id), [1, '2', '10']);
  });

  it('non-numeric ids fall back to string comparison', () => {
    const input = [
      { id: 'banana', sort_order: 0 },
      { id: 'apple', sort_order: 0 },
    ];
    assert.deepEqual(visibleTrackables(input).map((t) => t.id), ['apple', 'banana']);
  });

  it('the sort is stable for fully-equal (sort_order, id) keys', () => {
    const a = { id: 5, sort_order: 0, tag: 'first' };
    const b = { id: 5, sort_order: 0, tag: 'second' };
    const c = { id: 5, sort_order: 0, tag: 'third' };
    const result = visibleTrackables([a, b, c]);
    assert.deepEqual(result.map((t) => t.tag), ['first', 'second', 'third']);
  });
});

// ===========================================================================
// formatValue (contract §2.2)
// ===========================================================================

describe('formatValue — worked examples (contract §2.2, assert exactly)', () => {
  const cases = [
    [{ value_shape: 'numeric', unit: 'kcal' }, 320, '320 kcal'],
    [{ value_shape: 'numeric', unit: 'kg' }, 78.4, '78.4 kg'],
    [{ value_shape: 'numeric', unit: 'kg' }, 78.456, '78.46 kg'],
    [{ value_shape: 'numeric', unit: 'kcal' }, 1234.5, '1234.5 kcal'],
    [{ value_shape: 'numeric', unit: 'kcal' }, 12345, '12345 kcal'],
    [{ value_shape: 'numeric', unit: 'kg' }, 0, '0 kg'],
    [{ value_shape: 'numeric', unit: '' }, 5, '5'],
    [{ value_shape: 'numeric', unit: null }, 5, '5'],
    [{ value_shape: 'numeric', unit: 'kg' }, -1.5, '-1.5 kg'],
    [{ value_shape: 'numeric', unit: 'kg' }, null, '—'],
    [{ value_shape: 'numeric', unit: 'kg' }, NaN, '—'],
    [{ value_shape: 'numeric', unit: 'kg' }, Infinity, '—'],
    [{ value_shape: 'boolean' }, 1, 'Done'],
    [{ value_shape: 'boolean' }, 7, 'Done'],
    [{ value_shape: 'boolean' }, 0, '—'],
    [{ value_shape: 'boolean' }, null, '—'],
    [{}, 5, '—'],
  ];

  let n = 0;
  for (const [trackable, value, expected] of cases) {
    n += 1;
    it(`case ${n}: formatValue(${JSON.stringify(trackable)}, ${String(value)}) === ${JSON.stringify(expected)}`, () => {
      assert.equal(formatValue(trackable, value), expected);
    });
  }
});

describe('formatValue — additional documented rules', () => {
  it('an unrecognized value_shape (e.g. "weird") -> em dash', () => {
    assert.equal(formatValue({ value_shape: 'weird' }, 5), '—');
  });

  it('undefined value -> em dash', () => {
    assert.equal(formatValue({ value_shape: 'numeric', unit: 'kg' }, undefined), '—');
  });

  it('-Infinity value -> em dash', () => {
    assert.equal(formatValue({ value_shape: 'numeric', unit: 'kg' }, -Infinity), '—');
  });

  it('the em dash is exactly one U+2014 character', () => {
    const result = formatValue({}, 5);
    assert.equal(result.length, 1);
    assert.equal(result.codePointAt(0), 0x2014);
  });

  it('no thousands separator and no locale-dependent grouping for large numbers', () => {
    assert.equal(formatValue({ value_shape: 'numeric', unit: null }, 1000000), '1000000');
    assert.doesNotMatch(formatValue({ value_shape: 'numeric', unit: null }, 1000000), /,/);
  });

  it('rounds to at most 2 decimal places and drops trailing zeros (0.1 + 0.2 style float noise)', () => {
    assert.equal(formatValue({ value_shape: 'numeric', unit: null }, 0.1 + 0.2), '0.3');
  });
});

// ===========================================================================
// relogHint (contract §2.3)
// ===========================================================================

describe('relogHint — worked examples (contract §2.3, assert exactly; wording updated by CONTRACT-2.1b.md §3.5)', () => {
  // 2.1b: additive logging is removed from the product. relog_semantic no
  // longer affects relogHint's output AT ALL — the numeric branch is keyed
  // purely on value_shape/logged now. Two consequences visible below vs.
  // the original Step 2.1 fixture table:
  //   - the "new value is added" / "new value replaces it" wording is gone,
  //     replaced by neutral "tap to change" / "Tap to log today's value"
  //     text that says nothing about semantics.
  //   - a numeric trackable with NO relog_semantic at all (case 9) used to
  //     fall through to '' (the old code only recognized 'cumulative' and
  //     'state'); now the numeric branch doesn't look at relog_semantic to
  //     decide whether to apply at all, so it produces real hint text.
  const cases = [
    [{ value_shape: 'boolean' }, null, 'Tap to log today'],
    [{ value_shape: 'boolean' }, { value: 1 }, 'Logged today · tap to clear'],
    [{ value_shape: 'boolean' }, { value: 0 }, 'Tap to log today'],
    [
      { value_shape: 'numeric', relog_semantic: 'cumulative', unit: 'kcal' },
      null,
      "Tap to log today's value",
    ],
    [
      { value_shape: 'numeric', relog_semantic: 'cumulative', unit: 'kcal' },
      { value: 320 },
      'Today: 320 kcal · tap to change',
    ],
    [
      { value_shape: 'numeric', relog_semantic: 'state', unit: 'kg' },
      null,
      "Tap to log today's value",
    ],
    [
      { value_shape: 'numeric', relog_semantic: 'state', unit: 'kg' },
      { value: 78.4 },
      'Today: 78.4 kg · tap to change',
    ],
    [
      { value_shape: 'numeric', relog_semantic: 'cumulative', unit: 'kcal' },
      { value: 0 },
      'Today: 0 kcal · tap to change',
    ],
    // case 9: no relog_semantic at all — 2.1b: numeric hint no longer
    // depends on relog_semantic, so this is NOT '' any more (see comment
    // above). This is a changed expectation, not a new case.
    [{ value_shape: 'numeric' }, null, "Tap to log today's value"],
    [{}, null, ''],
    [null, null, ''],
  ];

  let n = 0;
  for (const [trackable, entry, expected] of cases) {
    n += 1;
    it(`case ${n}: relogHint(${JSON.stringify(trackable)}, ${JSON.stringify(entry)}) === ${JSON.stringify(expected)}`, () => {
      assert.equal(relogHint(trackable, entry), expected);
    });
  }
});

describe('relogHint — CONTRACT-2.1b.md §3.5 worked examples (assert exactly)', () => {
  const cases = [
    [
      { value_shape: 'boolean', direction: 'build' },
      { value: 1 },
      'Logged today · tap to clear',
    ],
    [
      { value_shape: 'boolean', direction: 'break' },
      { value: 1 },
      'Logged today · tap to clear',
    ],
    [{ value_shape: 'boolean', direction: 'break' }, null, 'Tap to log today'],
    [
      { value_shape: 'numeric', unit: 'kcal', relog_semantic: 'state' },
      { value: 2000 },
      'Today: 2000 kcal · tap to change',
    ],
    [
      { value_shape: 'numeric', unit: 'kcal', relog_semantic: 'cumulative' },
      { value: 2000 },
      'Today: 2000 kcal · tap to change',
    ],
    [{ value_shape: 'numeric', unit: 'kg' }, null, "Tap to log today's value"],
    [{}, null, ''],
  ];

  let n = 0;
  for (const [trackable, entry, expected] of cases) {
    n += 1;
    it(`case ${n}: relogHint(${JSON.stringify(trackable)}, ${JSON.stringify(entry)}) === ${JSON.stringify(expected)}`, () => {
      assert.equal(relogHint(trackable, entry), expected);
    });
  }
});

describe('relogHint — REGRESSION GUARD: additive wording is gone, not merely defaulted away (CONTRACT-2.1b.md §3.5)', () => {
  // This is the test that actually proves additive logging has been
  // removed from the hint text, as opposed to just no longer being the
  // default relog_semantic. Two numeric fixtures identical in every way
  // EXCEPT relog_semantic ('state' vs 'cumulative') MUST now produce byte-
  // identical hint strings for both the "logged" and "not logged" cases.
  // If an implementation still branches on relog_semantic internally (even
  // if it happens to produce the same text for the *default* case), a
  // hostile fixture with relog_semantic explicitly set to 'cumulative'
  // would catch it here.
  it('logged: state vs cumulative produce identical hint text', () => {
    const stateHint = relogHint(
      { value_shape: 'numeric', unit: 'kcal', relog_semantic: 'state' },
      { value: 2000 }
    );
    const cumulativeHint = relogHint(
      { value_shape: 'numeric', unit: 'kcal', relog_semantic: 'cumulative' },
      { value: 2000 }
    );
    assert.equal(stateHint, cumulativeHint);
    assert.equal(stateHint, 'Today: 2000 kcal · tap to change');
  });

  it('not logged: state vs cumulative produce identical hint text', () => {
    const stateHint = relogHint(
      { value_shape: 'numeric', unit: 'kg', relog_semantic: 'state' },
      null
    );
    const cumulativeHint = relogHint(
      { value_shape: 'numeric', unit: 'kg', relog_semantic: 'cumulative' },
      null
    );
    assert.equal(stateHint, cumulativeHint);
    assert.equal(stateHint, "Tap to log today's value");
  });

  it('boolean hint text is identical for build vs break direction (meaning is carried by verdict/statusWord/statusSymbol, not preachy hint text)', () => {
    const buildLogged = relogHint({ value_shape: 'boolean', direction: 'build' }, { value: 1 });
    const breakLogged = relogHint({ value_shape: 'boolean', direction: 'break' }, { value: 1 });
    assert.equal(buildLogged, breakLogged);

    const buildUnlogged = relogHint({ value_shape: 'boolean', direction: 'build' }, null);
    const breakUnlogged = relogHint({ value_shape: 'boolean', direction: 'break' }, null);
    assert.equal(buildUnlogged, breakUnlogged);
  });
});

describe('relogHint — additional documented rules', () => {
  it('the separator is exactly space + U+00B7 MIDDLE DOT + space', () => {
    const hint = relogHint({ value_shape: 'boolean' }, { value: 1 });
    assert.ok(hint.includes(' · '), `expected " \\u00B7 " inside: ${JSON.stringify(hint)}`);
  });

  it('apostrophes in the "no entry" numeric hint are ASCII U+0027, not a curly quote (both relog_semantic values converge on the same string per 2.1b)', () => {
    const cumHint = relogHint({ value_shape: 'numeric', relog_semantic: 'cumulative' }, null);
    const stateHint = relogHint({ value_shape: 'numeric', relog_semantic: 'state' }, null);
    assert.ok(cumHint.includes("'"));
    assert.ok(stateHint.includes("'"));
    assert.doesNotMatch(cumHint, /[‘’]/);
    assert.doesNotMatch(stateHint, /[‘’]/);
  });

  // 2.1b: relogHint's numeric branch no longer keys on relog_semantic at
  // all, so an unrecognized/unknown relog_semantic value on a numeric
  // trackable is now indistinguishable from any other numeric trackable —
  // it still produces real hint text, not ''. (Previously the numeric
  // branch only recognized 'cumulative'/'state' and anything else fell
  // through to the empty-string default; that fallthrough is gone.)
  it('an unrecognized relog_semantic on a numeric trackable no longer falls back to empty string (2.1b: relog_semantic is ignored by relogHint)', () => {
    assert.equal(
      relogHint({ value_shape: 'numeric', relog_semantic: 'weird' }, null),
      "Tap to log today's value"
    );
  });

  it('unknown value_shape -> empty string, regardless of entry', () => {
    assert.equal(relogHint({ value_shape: 'weird' }, { value: 5 }), '');
  });

  it('entry with a non-finite value counts as "no entry" (has = false)', () => {
    assert.equal(relogHint({ value_shape: 'boolean' }, { value: NaN }), 'Tap to log today');
    // 2.1b: no longer "Adds to today's total" — additive wording is gone.
    assert.equal(
      relogHint({ value_shape: 'numeric', relog_semantic: 'cumulative' }, { value: Infinity }),
      "Tap to log today's value"
    );
  });
});

// ===========================================================================
// verdict (CONTRACT-2.1b.md §3.1) — NEW in Step 2.1b
// ===========================================================================
//
// The governing rule this whole revision exists for: a green check means
// "today is good", not "logged". For a break-direction habit, being
// UNLOGGED is the good state — see the dedicated comment on the e2e V3
// case for the full rationale (WCAG 1.4.1 + the Loop Habit Tracker /
// Streaks precedent cited in CONTRACT-2.1b.md §0).

describe('verdict — worked examples (CONTRACT-2.1b.md §3.1, assert exactly)', () => {
  const cases = [
    [{ value_shape: 'boolean', direction: 'build' }, { value: 1 }, 'good'],
    [{ value_shape: 'boolean', direction: 'build' }, null, 'neutral'],
    [{ value_shape: 'boolean', direction: 'build' }, { value: 0 }, 'neutral'],
    [{ value_shape: 'boolean', direction: 'break' }, { value: 1 }, 'bad'],
    [{ value_shape: 'boolean', direction: 'break' }, null, 'good'],
    [{ value_shape: 'boolean', direction: 'break' }, { value: 0 }, 'good'],
    // missing direction -> treated as 'build'
    [{ value_shape: 'boolean' }, { value: 1 }, 'good'],
    [{ value_shape: 'numeric', direction: 'break' }, { value: 2000 }, 'neutral'],
    [{ value_shape: 'numeric', direction: 'build' }, null, 'neutral'],
    [{}, null, 'neutral'],
    [null, null, 'neutral'],
  ];

  let n = 0;
  for (const [trackable, entry, expected] of cases) {
    n += 1;
    it(`case ${n}: verdict(${JSON.stringify(trackable)}, ${JSON.stringify(entry)}) === ${JSON.stringify(expected)}`, () => {
      assert.equal(verdict(trackable, entry), expected);
    });
  }
});

describe('verdict — additional documented rules', () => {
  it('an unrecognized direction value (not "build" or "break") on a boolean trackable falls back to build-style verdict', () => {
    assert.equal(verdict({ value_shape: 'boolean', direction: 'sideways' }, { value: 1 }), 'good');
    assert.equal(verdict({ value_shape: 'boolean', direction: 'sideways' }, null), 'neutral');
  });

  it('numeric trackables are always neutral regardless of direction (no threshold invented without a target)', () => {
    assert.equal(verdict({ value_shape: 'numeric', direction: 'build' }, { value: 999999 }), 'neutral');
    assert.equal(verdict({ value_shape: 'numeric', direction: 'break' }, { value: 0 }), 'neutral');
  });

  it('an unrecognized value_shape -> neutral', () => {
    assert.equal(verdict({ value_shape: 'weird', direction: 'build' }, { value: 1 }), 'neutral');
  });
});

// ===========================================================================
// statusWord (CONTRACT-2.1b.md §3.2) — NEW in Step 2.1b
// ===========================================================================

describe('statusWord — worked examples (CONTRACT-2.1b.md §3.2, assert exactly)', () => {
  const cases = [
    [{ value_shape: 'boolean', direction: 'build' }, { value: 1 }, 'Done'],
    [{ value_shape: 'boolean', direction: 'build' }, null, 'Not yet'],
    [{ value_shape: 'boolean', direction: 'break' }, { value: 1 }, 'Logged'],
    [{ value_shape: 'boolean', direction: 'break' }, null, 'Clean'],
    // missing/unknown direction -> treated as 'build'
    [{ value_shape: 'boolean' }, { value: 1 }, 'Done'],
    [{ value_shape: 'boolean' }, null, 'Not yet'],
    [{ value_shape: 'boolean', direction: 'sideways' }, { value: 1 }, 'Done'],
    // numeric rows show valueText instead, not a status word
    [{ value_shape: 'numeric', direction: 'build' }, { value: 5 }, ''],
    [{ value_shape: 'numeric' }, null, ''],
    [{}, null, ''],
    [null, null, ''],
  ];

  let n = 0;
  for (const [trackable, entry, expected] of cases) {
    n += 1;
    it(`case ${n}: statusWord(${JSON.stringify(trackable)}, ${JSON.stringify(entry)}) === ${JSON.stringify(expected)}`, () => {
      assert.equal(statusWord(trackable, entry), expected);
    });
  }
});

// ===========================================================================
// statusSymbol (CONTRACT-2.1b.md §3.3) — NEW in Step 2.1b
// ===========================================================================

describe('statusSymbol — worked examples (CONTRACT-2.1b.md §3.3, assert exactly)', () => {
  const cases = [
    [{ value_shape: 'boolean', direction: 'build' }, { value: 1 }, 'check'], // good
    [{ value_shape: 'boolean', direction: 'build' }, null, 'empty'], // neutral
    [{ value_shape: 'boolean', direction: 'break' }, { value: 1 }, 'cross'], // bad
    // The deliberate, counter-intuitive case: unlogged break -> good -> check.
    // Do not "correct" this to mean logged; see contract §3.3's note and the
    // dedicated comment on e2e case V3.
    [{ value_shape: 'boolean', direction: 'break' }, null, 'check'], // good
    [{ value_shape: 'numeric', direction: 'break' }, { value: 5 }, 'empty'], // neutral
    [{}, null, 'empty'],
    [null, null, 'empty'],
  ];

  let n = 0;
  for (const [trackable, entry, expected] of cases) {
    n += 1;
    it(`case ${n}: statusSymbol(${JSON.stringify(trackable)}, ${JSON.stringify(entry)}) === ${JSON.stringify(expected)}`, () => {
      assert.equal(statusSymbol(trackable, entry), expected);
    });
  }
});

describe('statusSymbol — consistent with verdict for every value_shape × direction × logged combination (contract §6.1)', () => {
  const shapes = ['boolean', 'numeric', 'weird', undefined];
  const directions = ['build', 'break', 'sideways', undefined];
  const entries = [null, { value: 0 }, { value: 1 }];
  const expectedSymbolFor = { good: 'check', bad: 'cross', neutral: 'empty' };

  for (const shape of shapes) {
    for (const direction of directions) {
      for (const entry of entries) {
        const trackable = { value_shape: shape, direction };
        it(`shape=${shape} direction=${direction} entry=${JSON.stringify(entry)}: statusSymbol matches verdict`, () => {
          const v = verdict(trackable, entry);
          const s = statusSymbol(trackable, entry);
          assert.equal(s, expectedSymbolFor[v], `verdict was ${v} but statusSymbol was ${s}`);
        });
      }
    }
  }
});

// ===========================================================================
// directionLabel (CONTRACT-2.1b.md §3.4) — NEW in Step 2.1b
// ===========================================================================

describe('directionLabel — worked examples (CONTRACT-2.1b.md §3.4, assert exactly)', () => {
  const cases = [
    [{ direction: 'build' }, 'more is better'],
    [{ direction: 'break' }, 'less is better'],
    [{ direction: 'sideways' }, ''],
    [{}, ''],
    [{ direction: null }, ''],
    [null, ''],
  ];

  let n = 0;
  for (const [trackable, expected] of cases) {
    n += 1;
    it(`case ${n}: directionLabel(${JSON.stringify(trackable)}) === ${JSON.stringify(expected)}`, () => {
      assert.equal(directionLabel(trackable), expected);
    });
  }

  it('never returns the raw enum value verbatim (must be plain English per BUILD_PLAN Step 2.2)', () => {
    assert.notEqual(directionLabel({ direction: 'build' }), 'build');
    assert.notEqual(directionLabel({ direction: 'break' }), 'break');
  });
});

// ===========================================================================
// Hostile input sweep — verdict/statusWord/statusSymbol/directionLabel
// (contract §6.1) — NEW in Step 2.1b
// ===========================================================================

describe('hostile input sweep — verdict/statusWord/statusSymbol/directionLabel never throw (CONTRACT-2.1b.md §6.1)', () => {
  const hostile = [null, undefined, 0, '', [], {}, true, NaN];

  it('verdict never throws and always returns one of good/bad/neutral', () => {
    for (const t of hostile) {
      for (const e of hostile) {
        let result;
        assert.doesNotThrow(() => {
          result = verdict(t, e);
        }, `verdict(${JSON.stringify(t)}, ${JSON.stringify(e)}) threw`);
        assert.ok(['good', 'bad', 'neutral'].includes(result), `unexpected verdict: ${result}`);
      }
    }
  });

  it('statusWord never throws and always returns a string', () => {
    for (const t of hostile) {
      for (const e of hostile) {
        let result;
        assert.doesNotThrow(() => {
          result = statusWord(t, e);
        }, `statusWord(${JSON.stringify(t)}, ${JSON.stringify(e)}) threw`);
        assert.equal(typeof result, 'string');
      }
    }
  });

  it('statusSymbol never throws and always returns one of check/cross/empty', () => {
    for (const t of hostile) {
      for (const e of hostile) {
        let result;
        assert.doesNotThrow(() => {
          result = statusSymbol(t, e);
        }, `statusSymbol(${JSON.stringify(t)}, ${JSON.stringify(e)}) threw`);
        assert.ok(['check', 'cross', 'empty'].includes(result), `unexpected statusSymbol: ${result}`);
      }
    }
  });

  it('directionLabel never throws and always returns a string', () => {
    for (const t of hostile) {
      let result;
      assert.doesNotThrow(() => {
        result = directionLabel(t);
      }, `directionLabel(${JSON.stringify(t)}) threw`);
      assert.equal(typeof result, 'string');
    }
  });
});

// ===========================================================================
// parseNumericInput (contract §2.4)
// ===========================================================================

const PARSE_CASES = [
  ['78.4', 78.4],
  [' 78.4 ', 78.4],
  ['78,4', 78.4],
  ['0', 0],
  ['-3', -3],
  ['.5', 0.5],
  ['5.', 5],
  ['000012', 12],
  ['-0.25', -0.25],
  ['', null],
  ['   ', null],
  ['abc', null],
  ['1e3', null],
  ['Infinity', null],
  ['NaN', null],
  ['+5', null],
  ['1 2', null],
  ['.', null],
  ['-', null],
  ['1,2,3', null],
  ['1.2,3', null],
  ['1.2.3', null],
  [null, null],
  [undefined, null],
  [5, null],
  [NaN, null],
  [{}, null],
  [[], null],
  ['0x10', null],
];

describe('parseNumericInput — worked examples (contract §2.4, assert exactly)', () => {
  let n = 0;
  for (const [input, expected] of PARSE_CASES) {
    n += 1;
    it(`case ${n}: parseNumericInput(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
      assert.equal(parseNumericInput(input), expected);
    });
  }
});

describe('parseNumericInput — never returns NaN or a non-finite number', () => {
  it('every case in the worked-example fixture table satisfies Number.isFinite(result) || result === null', () => {
    for (const [input] of PARSE_CASES) {
      const result = parseNumericInput(input);
      assert.ok(
        Number.isFinite(result) || result === null,
        `parseNumericInput(${JSON.stringify(input)}) returned ${result}, which is neither finite nor null`
      );
    }
  });

  it('an over-long numeric-looking string still never yields Infinity', () => {
    const result = parseNumericInput('1'.repeat(400));
    assert.ok(Number.isFinite(result) || result === null);
  });
});

// ===========================================================================
// nextValueFor (contract §2.5)
// ===========================================================================

describe('nextValueFor — worked examples (contract §2.5, assert exactly)', () => {
  const cum = { value_shape: 'numeric', relog_semantic: 'cumulative' };
  const state = { value_shape: 'numeric', relog_semantic: 'state' };
  const bool = { value_shape: 'boolean' };

  it('cumulative: existing 320 + input 500 = 820', () => {
    assert.equal(nextValueFor(cum, { value: 320 }, 500), 820);
  });

  it('cumulative: no entry -> input value alone (existing treated as 0)', () => {
    assert.equal(nextValueFor(cum, null, 500), 500);
  });

  it('cumulative: entry.value === null is treated as no existing value', () => {
    assert.equal(nextValueFor(cum, { value: null }, 500), 500);
  });

  it('cumulative: entry.value === 0 is a real existing value (0 + 500 = 500)', () => {
    assert.equal(nextValueFor(cum, { value: 0 }, 500), 500);
  });

  it('cumulative: decimals add correctly (1.5 + 2.25 = 3.75)', () => {
    assert.ok(Math.abs(nextValueFor(cum, { value: 1.5 }, 2.25) - 3.75) < 1e-9);
  });

  it('state: replaces the existing value (78.4 -> 79.1)', () => {
    assert.equal(nextValueFor(state, { value: 78.4 }, 79.1), 79.1);
  });

  it('state: no entry -> input value', () => {
    assert.equal(nextValueFor(state, null, 79.1), 79.1);
  });

  it('boolean: entry.value 1, input ignored (undefined) -> 1', () => {
    assert.equal(nextValueFor(bool, { value: 1 }, undefined), 1);
  });

  it('boolean: no entry, input ignored (undefined) -> 1', () => {
    assert.equal(nextValueFor(bool, null, undefined), 1);
  });

  it('throws RangeError: numeric cumulative with NaN input', () => {
    assert.throws(() => nextValueFor(cum, null, NaN), RangeError);
  });

  it('throws RangeError: numeric trackable with unknown relog_semantic', () => {
    assert.throws(() => nextValueFor({ value_shape: 'numeric', relog_semantic: 'weird' }, null, 5), RangeError);
  });

  it('throws RangeError: unknown value_shape', () => {
    assert.throws(() => nextValueFor({ value_shape: 'weird' }, null, 5), RangeError);
  });

  it('throws RangeError: trackable is null', () => {
    assert.throws(() => nextValueFor(null, null, 5), RangeError);
  });
});

describe('nextValueFor — delegates to applyRelog (contract §6.1 extra property)', () => {
  const bool = { value_shape: 'boolean' };

  it('boolean case returns 1 for (null, undefined)', () => {
    assert.equal(nextValueFor(bool, null, undefined), 1);
  });

  it('boolean case returns 1 for ({value:1}, undefined)', () => {
    assert.equal(nextValueFor(bool, { value: 1 }, undefined), 1);
  });

  it('boolean case returns 1 for ({value:0}, undefined)', () => {
    assert.equal(nextValueFor(bool, { value: 0 }, undefined), 1);
  });
});

// ===========================================================================
// rowModel (contract §2.6)
// ===========================================================================

describe('rowModel — worked examples (contract §2.6, assert exactly; extended by CONTRACT-2.1b.md §3.6)', () => {
  it('boolean, unlogged, idle', () => {
    const result = rowModel({ id: 7, name: 'Workout', value_shape: 'boolean' }, null, 'idle');
    assert.deepEqual(result, {
      id: '7',
      name: 'Workout',
      shape: 'boolean',
      logged: false,
      // 2.1b: hint wording is unchanged for booleans, but the row now also
      // carries verdict/statusWord/statusSymbol/directionLabel.
      valueText: '—',
      hint: 'Tap to log today',
      state: 'idle',
      color: null,
      // missing direction -> treated as 'build'; not logged -> neutral/'Not yet'/'empty'
      verdict: 'neutral',
      statusWord: 'Not yet',
      statusSymbol: 'empty',
      directionLabel: '',
    });
  });

  it('numeric cumulative, logged, pending, colored (2.1b: hint wording changed, relog_semantic no longer affects it)', () => {
    const result = rowModel(
      {
        id: 8,
        name: 'Calories',
        value_shape: 'numeric',
        relog_semantic: 'cumulative',
        unit: 'kcal',
        color: '#ff0',
      },
      { value: 320 },
      'pending'
    );
    assert.deepEqual(result, {
      id: '8',
      name: 'Calories',
      shape: 'numeric',
      logged: true,
      valueText: '320 kcal',
      // 2.1b: was 'Today: 320 kcal · new value is added'; additive wording
      // is gone regardless of relog_semantic.
      hint: 'Today: 320 kcal · tap to change',
      state: 'pending',
      color: '#ff0',
      // numeric rows are always verdict-neutral (no target to judge against
      // yet — Phase 3), statusWord is empty (valueText carries the number),
      // statusSymbol follows verdict, and this fixture has no direction.
      verdict: 'neutral',
      statusWord: '',
      statusSymbol: 'empty',
      directionLabel: '',
    });
  });

  it('boolean, break direction, logged: verdict "bad", statusWord "Logged", statusSymbol "cross" (CONTRACT-2.1b.md §3.1-3.3)', () => {
    const result = rowModel(
      { id: 5, name: 'Smoking', value_shape: 'boolean', direction: 'break' },
      { value: 1 },
      'idle'
    );
    assert.equal(result.verdict, 'bad');
    assert.equal(result.statusWord, 'Logged');
    assert.equal(result.statusSymbol, 'cross');
    assert.equal(result.directionLabel, 'less is better');
  });

  // The counter-intuitive case that is the whole point of CONTRACT-2.1b:
  // for a break-direction habit, the UNLOGGED state is GOOD. A green check
  // means "today is good", not "logged" — ticking a bad-habit box would
  // otherwise read as an achievement and reward the behaviour the user is
  // trying to stop (research cited in CONTRACT-2.1b.md §0: Loop Habit
  // Tracker refuses bad-habit tracking for this exact reason; Streaks/
  // Quitzilla invert the reward instead). Do NOT "fix" this into meaning
  // logged==good — that would silently undo the user-requested redesign.
  it('boolean, break direction, UNLOGGED: verdict "good", statusWord "Clean", statusSymbol "check" — a clean day is the win, not a "fix"', () => {
    const result = rowModel(
      { id: 5, name: 'Smoking', value_shape: 'boolean', direction: 'break' },
      null,
      'idle'
    );
    assert.equal(result.verdict, 'good');
    assert.equal(result.statusWord, 'Clean');
    assert.equal(result.statusSymbol, 'check');
    assert.equal(result.directionLabel, 'less is better');
  });

  it('numeric, build direction: directionLabel is "more is better" even though verdict stays neutral', () => {
    const result = rowModel(
      { id: 9, name: 'Reading', value_shape: 'numeric', direction: 'build', unit: 'pages' },
      { value: 12 },
      'idle'
    );
    assert.equal(result.verdict, 'neutral');
    assert.equal(result.statusWord, '');
    assert.equal(result.statusSymbol, 'empty');
    assert.equal(result.directionLabel, 'more is better');
  });
});

describe('rowModel — additional documented rules', () => {
  it("an unrecognized status normalizes to 'idle'", () => {
    const result = rowModel({ id: 1, name: 'X', value_shape: 'boolean' }, null, 'bogus');
    assert.equal(result.state, 'idle');
  });

  it('a null/non-object trackable returns the documented fallback object, state = the given status (extended by CONTRACT-2.1b.md §3.6)', () => {
    const result = rowModel(null, null, 'failed');
    assert.deepEqual(result, {
      id: '',
      name: '',
      shape: 'unknown',
      logged: false,
      valueText: '—',
      hint: '',
      state: 'failed',
      color: null,
      verdict: 'neutral',
      statusWord: '',
      statusSymbol: 'empty',
      directionLabel: '',
    });
  });

  it('a non-object trackable (e.g. a string) also returns the fallback object', () => {
    const result = rowModel('boolean', null, 'idle');
    assert.equal(result.id, '');
    assert.equal(result.shape, 'unknown');
    assert.equal(result.verdict, 'neutral');
    assert.equal(result.statusWord, '');
    assert.equal(result.statusSymbol, 'empty');
    assert.equal(result.directionLabel, '');
  });

  it("shape is 'unknown' for an unrecognized value_shape", () => {
    const result = rowModel({ id: 1, name: 'X', value_shape: 'weird' }, null, 'idle');
    assert.equal(result.shape, 'unknown');
  });

  it('color: non-empty string kept; empty string, missing, or non-string becomes null', () => {
    assert.equal(
      rowModel({ id: 1, name: 'X', value_shape: 'boolean', color: '#abc' }, null, 'idle').color,
      '#abc'
    );
    assert.equal(
      rowModel({ id: 1, name: 'X', value_shape: 'boolean', color: '' }, null, 'idle').color,
      null
    );
    assert.equal(
      rowModel({ id: 1, name: 'X', value_shape: 'boolean', color: null }, null, 'idle').color,
      null
    );
    assert.equal(rowModel({ id: 1, name: 'X', value_shape: 'boolean' }, null, 'idle').color, null);
    assert.equal(
      rowModel({ id: 1, name: 'X', value_shape: 'boolean', color: 5 }, null, 'idle').color,
      null
    );
  });

  it('name: a non-string name becomes an empty string', () => {
    assert.equal(rowModel({ id: 1, name: 42, value_shape: 'boolean' }, null, 'idle').name, '');
    assert.equal(rowModel({ id: 1, value_shape: 'boolean' }, null, 'idle').name, '');
  });

  it('id is always String(trackable.id), even for a numeric id', () => {
    const result = rowModel({ id: 123, name: 'X', value_shape: 'boolean' }, null, 'idle');
    assert.equal(result.id, '123');
    assert.equal(typeof result.id, 'string');
  });

  it('logged matches the "has" predicate from relogHint (numeric, value 0 counts as logged)', () => {
    const trackable = { id: 1, name: 'Cal', value_shape: 'numeric', relog_semantic: 'cumulative', unit: 'kcal' };
    const result = rowModel(trackable, { value: 0 }, 'idle');
    assert.equal(result.logged, true);
    assert.equal(result.valueText, '0 kcal');
  });

  it('logged is false for a boolean row whose entry value is 0', () => {
    const result = rowModel({ id: 1, name: 'B', value_shape: 'boolean' }, { value: 0 }, 'idle');
    assert.equal(result.logged, false);
  });

  it('valueText and hint are derived via formatValue/relogHint (entry null -> valueText from formatValue(trackable, null))', () => {
    const trackable = { id: 1, name: 'B', value_shape: 'boolean' };
    const result = rowModel(trackable, null, 'idle');
    assert.equal(result.valueText, formatValue(trackable, null));
    assert.equal(result.hint, relogHint(trackable, null));
  });
});

// ===========================================================================
// Hostile input sweep (contract §6.1)
// ===========================================================================

describe('hostile input sweep — formatValue/relogHint/rowModel never throw (contract §6.1)', () => {
  const hostile = [null, undefined, 0, '', [], {}, true, NaN];

  it('formatValue never throws and always returns a string, for every (trackable, value) pair in the hostile set', () => {
    for (const t of hostile) {
      for (const v of hostile) {
        let result;
        assert.doesNotThrow(() => {
          result = formatValue(t, v);
        }, `formatValue(${JSON.stringify(t)}, ${String(v)}) threw`);
        assert.equal(
          typeof result,
          'string',
          `formatValue(${JSON.stringify(t)}, ${String(v)}) did not return a string, got ${typeof result}`
        );
      }
    }
  });

  it('relogHint never throws and always returns a string, for every (trackable, entry) pair in the hostile set', () => {
    for (const t of hostile) {
      for (const e of hostile) {
        let result;
        assert.doesNotThrow(() => {
          result = relogHint(t, e);
        }, `relogHint(${JSON.stringify(t)}, ${JSON.stringify(e)}) threw`);
        assert.equal(
          typeof result,
          'string',
          `relogHint(${JSON.stringify(t)}, ${JSON.stringify(e)}) did not return a string, got ${typeof result}`
        );
      }
    }
  });

  it('rowModel never throws and always returns a non-null object, for every (trackable, entry, status) triple in the hostile set', () => {
    const statuses = [...hostile, 'idle', 'pending', 'failed'];
    for (const t of hostile) {
      for (const e of hostile) {
        for (const s of statuses) {
          let result;
          assert.doesNotThrow(() => {
            result = rowModel(t, e, s);
          }, `rowModel(${JSON.stringify(t)}, ${JSON.stringify(e)}, ${JSON.stringify(s)}) threw`);
          assert.equal(typeof result, 'object');
          assert.notEqual(result, null);
        }
      }
    }
  });
});
