// Unit tests for the PURE exports of js/views/settings.js: WINDOW_MIN,
// WINDOW_MAX, parseWindowDays, reorderPlan. Written strictly against
// CONTRACT-4.1.md §4; the implementation is being written in parallel and
// has NOT been read while writing this file.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WINDOW_MIN, WINDOW_MAX, parseWindowDays, reorderPlan } from '../../js/views/settings.js';

// ===========================================================================
// Constants
// ===========================================================================

describe('WINDOW_MIN / WINDOW_MAX', () => {
  it('are 14 and 730', () => {
    assert.equal(WINDOW_MIN, 14);
    assert.equal(WINDOW_MAX, 730);
  });
});

// ===========================================================================
// parseWindowDays — every example in §4 plus boundaries 14, 730
// ===========================================================================

describe('parseWindowDays', () => {
  const table = [
    ['30', 30],
    [' 30 ', 30],
    ['30.0', null],
    ['30.5', null],
    ['abc', null],
    ['', null],
    ['13', null], // below WINDOW_MIN
    ['731', null], // above WINDOW_MAX
    ['-5', null],
    ['1e2', null],
    ['14', 14], // boundary: WINDOW_MIN
    ['730', 730], // boundary: WINDOW_MAX
  ];

  for (const [input, expected] of table) {
    it(`parseWindowDays(${JSON.stringify(input)}) -> ${expected}`, () => {
      assert.equal(parseWindowDays(input), expected);
    });
  }
});

// ===========================================================================
// reorderPlan
// ===========================================================================

describe('reorderPlan', () => {
  const dense3 = [
    { id: 1, sort_order: 0 },
    { id: 2, sort_order: 1 },
    { id: 3, sort_order: 2 },
  ];

  it('moving the middle item up: exactly two patches, swapped sort_orders, ordered by new position', () => {
    const plan = reorderPlan(dense3, '2', 'up');
    assert.deepEqual(plan, [
      { id: '2', sort_order: 0 },
      { id: '1', sort_order: 1 },
    ]);
  });

  it('moving the middle item down: exactly two patches, swapped sort_orders, ordered by new position', () => {
    const plan = reorderPlan(dense3, '2', 'down');
    assert.deepEqual(plan, [
      { id: '3', sort_order: 1 },
      { id: '2', sort_order: 2 },
    ]);
  });

  it('accepts a numeric id too (matched via String(id))', () => {
    const plan = reorderPlan(dense3, 2, 'up');
    assert.deepEqual(plan, [
      { id: '2', sort_order: 0 },
      { id: '1', sort_order: 1 },
    ]);
  });

  it('moving the first item up -> []', () => {
    assert.deepEqual(reorderPlan(dense3, '1', 'up'), []);
  });

  it('moving the last item down -> []', () => {
    assert.deepEqual(reorderPlan(dense3, '3', 'down'), []);
  });

  it('an unknown id -> []', () => {
    assert.deepEqual(reorderPlan(dense3, '999', 'up'), []);
    assert.deepEqual(reorderPlan(dense3, '999', 'down'), []);
  });

  it('a sparse existing sort_order list (0, 5, 9) is renumbered densely: patches for every row whose value changes', () => {
    const sparse = [
      { id: 'a', sort_order: 0 },
      { id: 'b', sort_order: 5 },
      { id: 'c', sort_order: 9 },
    ];
    // Moving 'b' up swaps positions with 'a': new order [b, a, c].
    // Dense targets: b->0, a->1, c->2. Every one of the three differs from
    // its ORIGINAL sort_order (0, 5, 9), including 'c', which does not
    // change position at all but still needs a patch because its sparse
    // value (9) doesn't match its dense target (2).
    const plan = reorderPlan(sparse, 'b', 'up');
    assert.deepEqual(plan, [
      { id: 'b', sort_order: 0 },
      { id: 'a', sort_order: 1 },
      { id: 'c', sort_order: 2 },
    ]);
  });

  it('a sparse list where the moved pair already have adjacent-enough values still only patches what changes', () => {
    // Here only the two swapped rows actually change: 'x' and 'y' swap
    // (0 <-> 1), and 'z' already sits at dense value 2.
    const almostDense = [
      { id: 'x', sort_order: 0 },
      { id: 'y', sort_order: 1 },
      { id: 'z', sort_order: 2 },
    ];
    const plan = reorderPlan(almostDense, 'y', 'up');
    assert.deepEqual(plan, [
      { id: 'y', sort_order: 0 },
      { id: 'x', sort_order: 1 },
    ]);
  });

  it('non-array `visible` -> []', () => {
    assert.deepEqual(reorderPlan(null, '1', 'up'), []);
    assert.deepEqual(reorderPlan(undefined, '1', 'up'), []);
    assert.deepEqual(reorderPlan({}, '1', 'up'), []);
    assert.deepEqual(reorderPlan('nope', '1', 'up'), []);
  });

  it('an empty visible list -> []', () => {
    assert.deepEqual(reorderPlan([], '1', 'up'), []);
  });
});
