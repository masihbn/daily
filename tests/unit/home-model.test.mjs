// Contract tests for js/views/home-model.js (BUILD_PLAN Step 2.1) — pure
// functions, no DOM, no fetch, no localStorage. Written strictly from
// CONTRACT-2.1.md §2; the implementation is being written in parallel by
// another agent from the same contract, so every assertion here is against
// the documented worked examples and rules, not against any particular
// internal approach.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  visibleTrackables,
  formatValue,
  relogHint,
  parseNumericInput,
  nextValueFor,
  rowModel,
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

describe('relogHint — worked examples (contract §2.3, assert exactly)', () => {
  const cases = [
    [{ value_shape: 'boolean' }, null, 'Tap to log today'],
    [{ value_shape: 'boolean' }, { value: 1 }, 'Logged today · tap to clear'],
    [{ value_shape: 'boolean' }, { value: 0 }, 'Tap to log today'],
    [
      { value_shape: 'numeric', relog_semantic: 'cumulative', unit: 'kcal' },
      null,
      "Adds to today's total",
    ],
    [
      { value_shape: 'numeric', relog_semantic: 'cumulative', unit: 'kcal' },
      { value: 320 },
      'Today: 320 kcal · new value is added',
    ],
    [
      { value_shape: 'numeric', relog_semantic: 'state', unit: 'kg' },
      null,
      "Replaces today's value",
    ],
    [
      { value_shape: 'numeric', relog_semantic: 'state', unit: 'kg' },
      { value: 78.4 },
      'Today: 78.4 kg · new value replaces it',
    ],
    [
      { value_shape: 'numeric', relog_semantic: 'cumulative', unit: 'kcal' },
      { value: 0 },
      'Today: 0 kcal · new value is added',
    ],
    [{ value_shape: 'numeric' }, null, ''],
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

describe('relogHint — additional documented rules', () => {
  it('the separator is exactly space + U+00B7 MIDDLE DOT + space', () => {
    const hint = relogHint({ value_shape: 'boolean' }, { value: 1 });
    assert.ok(hint.includes(' · '), `expected " \\u00B7 " inside: ${JSON.stringify(hint)}`);
  });

  it('apostrophes in the "no entry" numeric hints are ASCII U+0027, not a curly quote', () => {
    const cumHint = relogHint({ value_shape: 'numeric', relog_semantic: 'cumulative' }, null);
    const stateHint = relogHint({ value_shape: 'numeric', relog_semantic: 'state' }, null);
    assert.ok(cumHint.includes("'"));
    assert.ok(stateHint.includes("'"));
    assert.doesNotMatch(cumHint, /[‘’]/);
    assert.doesNotMatch(stateHint, /[‘’]/);
  });

  it('unknown relog_semantic on a numeric trackable -> empty string', () => {
    assert.equal(relogHint({ value_shape: 'numeric', relog_semantic: 'weird' }, null), '');
  });

  it('unknown value_shape -> empty string, regardless of entry', () => {
    assert.equal(relogHint({ value_shape: 'weird' }, { value: 5 }), '');
  });

  it('entry with a non-finite value counts as "no entry" (has = false)', () => {
    assert.equal(relogHint({ value_shape: 'boolean' }, { value: NaN }), 'Tap to log today');
    assert.equal(
      relogHint({ value_shape: 'numeric', relog_semantic: 'cumulative' }, { value: Infinity }),
      "Adds to today's total"
    );
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

describe('rowModel — worked examples (contract §2.6, assert exactly)', () => {
  it('boolean, unlogged, idle', () => {
    const result = rowModel({ id: 7, name: 'Workout', value_shape: 'boolean' }, null, 'idle');
    assert.deepEqual(result, {
      id: '7',
      name: 'Workout',
      shape: 'boolean',
      logged: false,
      valueText: '—',
      hint: 'Tap to log today',
      state: 'idle',
      color: null,
    });
  });

  it('numeric cumulative, logged, pending, colored', () => {
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
      hint: 'Today: 320 kcal · new value is added',
      state: 'pending',
      color: '#ff0',
    });
  });
});

describe('rowModel — additional documented rules', () => {
  it("an unrecognized status normalizes to 'idle'", () => {
    const result = rowModel({ id: 1, name: 'X', value_shape: 'boolean' }, null, 'bogus');
    assert.equal(result.state, 'idle');
  });

  it('a null/non-object trackable returns the documented fallback object, state = the given status', () => {
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
    });
  });

  it('a non-object trackable (e.g. a string) also returns the fallback object', () => {
    const result = rowModel('boolean', null, 'idle');
    assert.equal(result.id, '');
    assert.equal(result.shape, 'unknown');
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
