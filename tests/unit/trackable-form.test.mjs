// Contract tests for the PURE exports of js/views/trackable.js (Step 2.2 —
// "Create / edit a trackable"): defaultsFor, applyShapeChange, visibleFields,
// validate, buildPayload. No DOM, no fetch, no localStorage. Written
// strictly from CONTRACT-2.2.md §3.2-3.6 and §5.2; the implementation is
// being written in parallel by another agent from the same contract, so
// every assertion here is against the documented rules and worked examples,
// not against any particular internal approach.
//
// Two judgment calls made where the contract does not spell out an exact
// data type/behavior (reported to the orchestrator in the accompanying
// report, not silently guessed past):
//   1. buildPayload's target_value / bound_lower / bound_upper are asserted
//      to be JS numbers (not the raw input strings) — validate() already
//      parses these fields via parseNumericInput to decide validity, and
//      every other numeric value that crosses into a PostgREST payload in
//      this codebase (entries.value, see home.js/home-model.js) is a number,
//      never a numeral string. Sending the unparsed string would be a
//      surprising, inconsistent design.
//   2. buildPayload(state) takes only `state`, not `mode` — its documented
//      signature has no mode parameter. An earlier version of this suite
//      asserted buildPayload ALWAYS includes `archived: false`, reasoning
//      that a mode-based omission would have to live in the caller. That
//      turned out to be a real bug, not just an untested split: the form
//      has no `archived` control at all, so unconditionally sending
//      `archived: false` meant opening an archived trackable's edit URL
//      and saving silently un-archived it (the PATCH carried the same
//      key). The fix removes `archived` from buildPayload's output
//      entirely, in both 'new' and edit-mode use — the database column
//      already defaults to false on insert, so create mode does not need
//      to send it either. See "buildPayload never sends `archived`" below
//      for the regression case that guards this.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultsFor,
  applyShapeChange,
  visibleFields,
  validate,
  buildPayload,
} from '../../js/views/trackable.js';

// ===========================================================================
// defaultsFor (CONTRACT-2.2.md §3.3)
// ===========================================================================

describe('defaultsFor — §3.3 exact defaults', () => {
  it("defaultsFor('boolean') matches the documented default form state exactly", () => {
    assert.deepEqual(defaultsFor('boolean'), {
      name: '',
      value_shape: 'boolean',
      direction: 'build',
      unit: '',
      aggregation: 'count',
      target_type: 'none',
      target_value: '',
      bounds_enabled: false,
      bounds_mode: 'auto',
      bound_lower: '',
      bound_upper: '',
      color: '#34c759',
    });
  });

  it("defaultsFor('numeric') matches the same defaults but value_shape:'numeric' and aggregation:'sum' (aggregation forced by value_shape)", () => {
    assert.deepEqual(defaultsFor('numeric'), {
      name: '',
      value_shape: 'numeric',
      direction: 'build',
      unit: '',
      aggregation: 'sum',
      target_type: 'none',
      target_value: '',
      bounds_enabled: false,
      bounds_mode: 'auto',
      bound_lower: '',
      bound_upper: '',
      color: '#34c759',
    });
  });
});

// ===========================================================================
// applyShapeChange (CONTRACT-2.2.md §3.3 "aggregation is forced by
// value_shape")
// ===========================================================================

describe('applyShapeChange — forces aggregation in both directions, preserves unrelated fields', () => {
  it("switching an existing numeric state to 'boolean' sets aggregation:'count' and value_shape:'boolean'", () => {
    const state = {
      ...defaultsFor('numeric'),
      name: 'Calories',
      direction: 'break',
      unit: 'kcal',
      aggregation: 'average',
      target_type: 'weekly_count',
      target_value: '3',
      color: '#ff9f0a',
    };
    const result = applyShapeChange(state, 'boolean');
    assert.equal(result.value_shape, 'boolean');
    assert.equal(result.aggregation, 'count');
  });

  it("switching an existing boolean state to 'numeric' sets aggregation:'sum' and value_shape:'numeric'", () => {
    const state = {
      ...defaultsFor('boolean'),
      name: 'Workout',
      direction: 'build',
      target_type: 'none',
      color: '#3478f6',
    };
    const result = applyShapeChange(state, 'numeric');
    assert.equal(result.value_shape, 'numeric');
    assert.equal(result.aggregation, 'sum');
  });

  it('preserves fields unrelated to value_shape/aggregation across a switch to numeric', () => {
    const state = {
      ...defaultsFor('boolean'),
      name: 'Reading',
      direction: 'break',
      target_type: 'weekly_count',
      target_value: '5',
      color: '#bf5af2',
    };
    const result = applyShapeChange(state, 'numeric');
    assert.equal(result.name, 'Reading');
    assert.equal(result.direction, 'break');
    assert.equal(result.target_type, 'weekly_count');
    assert.equal(result.target_value, '5');
    assert.equal(result.color, '#bf5af2');
  });

  it('preserves fields unrelated to value_shape/aggregation across a switch to boolean', () => {
    const state = {
      ...defaultsFor('numeric'),
      name: 'Weight',
      direction: 'break',
      target_type: 'none',
      color: '#8e8e93',
    };
    const result = applyShapeChange(state, 'boolean');
    assert.equal(result.name, 'Weight');
    assert.equal(result.direction, 'break');
    assert.equal(result.target_type, 'none');
    assert.equal(result.color, '#8e8e93');
  });

  it("count is never produced by switching to 'numeric', and no numeric aggregation ('sum'/'average'/'last') is ever produced by switching to 'boolean'", () => {
    const toNumeric = applyShapeChange({ ...defaultsFor('boolean'), aggregation: 'count' }, 'numeric');
    assert.notEqual(toNumeric.aggregation, 'count');
    assert.ok(['sum', 'average', 'last'].includes(toNumeric.aggregation));

    const toBoolean = applyShapeChange({ ...defaultsFor('numeric'), aggregation: 'average' }, 'boolean');
    assert.equal(toBoolean.aggregation, 'count');
  });
});

// ===========================================================================
// visibleFields (CONTRACT-2.2.md §3.2 table + §3.8 DOM order)
// ===========================================================================
//
// DOM order per §3.8: name, value_shape, direction, unit, aggregation,
// target_type, target_value, bounds_enabled, bounds_mode, bound_lower,
// bound_upper, color. visibleFields must return the subset that is visible,
// in that order.

describe('visibleFields — boolean shape (unit/aggregation/bounds_* never shown, regardless of bounds_enabled/bounds_mode)', () => {
  it('boolean, target_type "none": only the always-visible fields', () => {
    const state = { ...defaultsFor('boolean'), target_type: 'none' };
    assert.deepEqual(visibleFields(state), ['name', 'value_shape', 'direction', 'target_type', 'color']);
  });

  it('boolean, target_type "weekly_count": target_value inserted in its DOM position', () => {
    const state = { ...defaultsFor('boolean'), target_type: 'weekly_count', target_value: '3' };
    assert.deepEqual(visibleFields(state), [
      'name',
      'value_shape',
      'direction',
      'target_type',
      'target_value',
      'color',
    ]);
  });

  it('boolean with bounds_enabled/bounds_mode garbage set anyway: bounds_* still never shown (fields are hidden by value_shape, not merely by their own flags)', () => {
    const state = { ...defaultsFor('boolean'), bounds_enabled: true, bounds_mode: 'manual' };
    assert.deepEqual(visibleFields(state), ['name', 'value_shape', 'direction', 'target_type', 'color']);
  });
});

describe('visibleFields — numeric shape: all four combinations of bounds_enabled x bounds_mode (CONTRACT-2.2.md §5.2)', () => {
  it('numeric, bounds_enabled:false, bounds_mode:"auto" -> bounds_mode/bound_lower/bound_upper all hidden', () => {
    const state = { ...defaultsFor('numeric'), bounds_enabled: false, bounds_mode: 'auto' };
    assert.deepEqual(visibleFields(state), [
      'name',
      'value_shape',
      'direction',
      'unit',
      'aggregation',
      'target_type',
      'bounds_enabled',
      'color',
    ]);
  });

  it('numeric, bounds_enabled:false, bounds_mode:"manual" -> bounds_mode ignored while disabled, still hidden along with bound_lower/bound_upper', () => {
    const state = { ...defaultsFor('numeric'), bounds_enabled: false, bounds_mode: 'manual' };
    assert.deepEqual(visibleFields(state), [
      'name',
      'value_shape',
      'direction',
      'unit',
      'aggregation',
      'target_type',
      'bounds_enabled',
      'color',
    ]);
  });

  it('numeric, bounds_enabled:true, bounds_mode:"auto" -> bounds_mode shown, bound_lower/bound_upper still hidden', () => {
    const state = { ...defaultsFor('numeric'), bounds_enabled: true, bounds_mode: 'auto' };
    assert.deepEqual(visibleFields(state), [
      'name',
      'value_shape',
      'direction',
      'unit',
      'aggregation',
      'target_type',
      'bounds_enabled',
      'bounds_mode',
      'color',
    ]);
  });

  it('numeric, bounds_enabled:true, bounds_mode:"manual" -> bounds_mode AND both bound inputs shown', () => {
    const state = { ...defaultsFor('numeric'), bounds_enabled: true, bounds_mode: 'manual' };
    assert.deepEqual(visibleFields(state), [
      'name',
      'value_shape',
      'direction',
      'unit',
      'aggregation',
      'target_type',
      'bounds_enabled',
      'bounds_mode',
      'bound_lower',
      'bound_upper',
      'color',
    ]);
  });
});

describe('visibleFields — numeric with target_type "weekly_count" combined with full manual bounds (checks DOM ordering across both conditional groups at once)', () => {
  it('target_value appears between target_type and bounds_enabled, per §3.8 DOM order', () => {
    const state = {
      ...defaultsFor('numeric'),
      target_type: 'weekly_count',
      target_value: '10',
      bounds_enabled: true,
      bounds_mode: 'manual',
    };
    assert.deepEqual(visibleFields(state), [
      'name',
      'value_shape',
      'direction',
      'unit',
      'aggregation',
      'target_type',
      'target_value',
      'bounds_enabled',
      'bounds_mode',
      'bound_lower',
      'bound_upper',
      'color',
    ]);
  });
});

// ===========================================================================
// validate (CONTRACT-2.2.md §3.5)
// ===========================================================================

function validBooleanState(overrides = {}) {
  return { ...defaultsFor('boolean'), name: 'Workout', ...overrides };
}

function validNumericState(overrides = {}) {
  return { ...defaultsFor('numeric'), name: 'Weight', unit: 'kg', ...overrides };
}

describe('validate — happy path', () => {
  it('a fully valid boolean state (target_type "none") is ok', () => {
    assert.deepEqual(validate(validBooleanState()), { ok: true });
  });

  it('a fully valid numeric state with bounds disabled is ok', () => {
    assert.deepEqual(validate(validNumericState()), { ok: true });
  });

  it('a fully valid numeric state with manual bounds (10 < 20) is ok', () => {
    const state = validNumericState({
      bounds_enabled: true,
      bounds_mode: 'manual',
      bound_lower: '10',
      bound_upper: '20',
    });
    assert.deepEqual(validate(state), { ok: true });
  });

  it('a fully valid boolean state with a weekly_count target > 0 is ok', () => {
    const state = validBooleanState({ target_type: 'weekly_count', target_value: '3' });
    assert.deepEqual(validate(state), { ok: true });
  });
});

describe('validate — "Name is required"', () => {
  it('empty name', () => {
    assert.deepEqual(validate(validBooleanState({ name: '' })), {
      ok: false,
      message: 'Name is required',
    });
  });

  it('whitespace-only name', () => {
    assert.deepEqual(validate(validBooleanState({ name: '   ' })), {
      ok: false,
      message: 'Name is required',
    });
  });
});

describe('validate — "Target must be a number greater than 0"', () => {
  it('target_value "0"', () => {
    const state = validBooleanState({ target_type: 'weekly_count', target_value: '0' });
    assert.deepEqual(validate(state), { ok: false, message: 'Target must be a number greater than 0' });
  });

  it('target_value "-5" (negative)', () => {
    const state = validBooleanState({ target_type: 'weekly_count', target_value: '-5' });
    assert.deepEqual(validate(state), { ok: false, message: 'Target must be a number greater than 0' });
  });

  it('target_value "abc" (not a number)', () => {
    const state = validBooleanState({ target_type: 'weekly_count', target_value: 'abc' });
    assert.deepEqual(validate(state), { ok: false, message: 'Target must be a number greater than 0' });
  });

  it('target_value "" (empty)', () => {
    const state = validBooleanState({ target_type: 'weekly_count', target_value: '' });
    assert.deepEqual(validate(state), { ok: false, message: 'Target must be a number greater than 0' });
  });

  it('target_type "none" with a garbage target_value does NOT trigger the target error (field is hidden, not validated)', () => {
    const state = validBooleanState({ target_type: 'none', target_value: 'not a number' });
    assert.deepEqual(validate(state), { ok: true });
  });
});

describe('validate — "Both bounds are required"', () => {
  it('bound_lower is not a finite number ("abc")', () => {
    const state = validNumericState({
      bounds_enabled: true,
      bounds_mode: 'manual',
      bound_lower: 'abc',
      bound_upper: '20',
    });
    assert.deepEqual(validate(state), { ok: false, message: 'Both bounds are required' });
  });

  it('bound_upper is empty', () => {
    const state = validNumericState({
      bounds_enabled: true,
      bounds_mode: 'manual',
      bound_lower: '10',
      bound_upper: '',
    });
    assert.deepEqual(validate(state), { ok: false, message: 'Both bounds are required' });
  });

  it('both bounds are empty', () => {
    const state = validNumericState({
      bounds_enabled: true,
      bounds_mode: 'manual',
      bound_lower: '',
      bound_upper: '',
    });
    assert.deepEqual(validate(state), { ok: false, message: 'Both bounds are required' });
  });
});

describe('validate — "Lower bound must be less than upper bound"', () => {
  it('lower (10) > upper (5)', () => {
    const state = validNumericState({
      bounds_enabled: true,
      bounds_mode: 'manual',
      bound_lower: '10',
      bound_upper: '5',
    });
    assert.deepEqual(validate(state), { ok: false, message: 'Lower bound must be less than upper bound' });
  });

  it('lower === upper (5 === 5, not strictly less)', () => {
    const state = validNumericState({
      bounds_enabled: true,
      bounds_mode: 'manual',
      bound_lower: '5',
      bound_upper: '5',
    });
    assert.deepEqual(validate(state), { ok: false, message: 'Lower bound must be less than upper bound' });
  });
});

describe('validate — hidden fields are never validated', () => {
  it('boolean state with nonsense bounds_* values set anyway (fields not applicable to boolean at all) is still ok', () => {
    const state = validBooleanState({
      bounds_enabled: true,
      bounds_mode: 'manual',
      bound_lower: 'garbage',
      bound_upper: 'also garbage',
    });
    assert.deepEqual(validate(state), { ok: true });
  });

  it('numeric with bounds_enabled:false and bounds_mode:"manual" (mode set but bounds off) with garbage bounds is still ok', () => {
    const state = validNumericState({
      bounds_enabled: false,
      bounds_mode: 'manual',
      bound_lower: 'garbage',
      bound_upper: 'also garbage',
    });
    assert.deepEqual(validate(state), { ok: true });
  });

  it('numeric with bounds_enabled:true and bounds_mode:"auto" (not manual) with garbage bounds is still ok', () => {
    const state = validNumericState({
      bounds_enabled: true,
      bounds_mode: 'auto',
      bound_lower: 'garbage',
      bound_upper: 'also garbage',
    });
    assert.deepEqual(validate(state), { ok: true });
  });
});

describe('validate — first-failure-wins ordering (only the FIRST failing message from the §3.5 table is ever returned)', () => {
  it('name empty AND target invalid AND bounds invalid simultaneously -> "Name is required" wins (first in the table)', () => {
    const state = {
      ...defaultsFor('numeric'),
      name: '',
      unit: 'kg',
      target_type: 'weekly_count',
      target_value: '0',
      bounds_enabled: true,
      bounds_mode: 'manual',
      bound_lower: '',
      bound_upper: '',
    };
    assert.deepEqual(validate(state), { ok: false, message: 'Name is required' });
  });

  it('name valid, target invalid AND bounds invalid simultaneously -> target error wins (2nd in the table, before both bounds checks)', () => {
    const state = validNumericState({
      target_type: 'weekly_count',
      target_value: '-1',
      bounds_enabled: true,
      bounds_mode: 'manual',
      bound_lower: '',
      bound_upper: '',
    });
    assert.deepEqual(validate(state), { ok: false, message: 'Target must be a number greater than 0' });
  });

  it('name valid, target valid, bounds missing AND out-of-order simultaneously -> "Both bounds are required" wins (3rd beats 4th)', () => {
    // bound_lower is non-finite, which also happens to not satisfy any
    // meaningful ">=" comparison — "both required" must fire first.
    const state = validNumericState({
      target_type: 'weekly_count',
      target_value: '5',
      bounds_enabled: true,
      bounds_mode: 'manual',
      bound_lower: 'nope',
      bound_upper: '20',
    });
    assert.deepEqual(validate(state), { ok: false, message: 'Both bounds are required' });
  });
});

// ===========================================================================
// buildPayload (CONTRACT-2.2.md §3.6)
// ===========================================================================

describe('buildPayload — boolean, target_type "none": exactly the minimal key set', () => {
  it('contains exactly the documented keys, no more, no less', () => {
    const state = validBooleanState({ target_type: 'none' });
    const payload = buildPayload(state);
    // 'archived' is deliberately absent — see the file header note. Do not
    // add it back to this expected key list.
    assert.deepEqual(
      Object.keys(payload).sort(),
      ['aggregation', 'color', 'direction', 'name', 'relog_semantic', 'target_type', 'value_shape'].sort()
    );
  });

  it('relog_semantic is always "state"; aggregation is "count" for a boolean; archived is absent', () => {
    const state = validBooleanState();
    const payload = buildPayload(state);
    assert.equal(payload.relog_semantic, 'state');
    assert.equal(payload.aggregation, 'count');
    // Asserted on key presence, not value: `undefined` would pass a
    // truthiness/falsy check by accident and mask the bug this guards.
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'archived'), false);
  });

  it('never sends id, created_at, or sort_order, regardless of what stray keys exist on the input state', () => {
    const state = { ...validBooleanState(), id: 999, created_at: '2026-01-01', sort_order: 7 };
    const payload = buildPayload(state);
    assert.equal('id' in payload, false);
    assert.equal('created_at' in payload, false);
    assert.equal('sort_order' in payload, false);
  });

  it('omits unit, target_value, and every bounds_* key for a boolean/target_type:"none" trackable', () => {
    const payload = buildPayload(validBooleanState({ target_type: 'none' }));
    for (const key of ['unit', 'target_value', 'bounds_enabled', 'bounds_mode', 'bound_lower', 'bound_upper']) {
      assert.equal(key in payload, false, `expected "${key}" to be absent`);
    }
  });
});

describe('buildPayload — regression: never sends `archived`, in either mode (an edit must not silently un-archive a trackable)', () => {
  // Guards a real bug: buildPayload used to unconditionally attach
  // `archived: false`. The trackable form has no `archived` control, so
  // that key was always the client's own guess, never the user's intent.
  // Because js/views/trackable.js's edit-save handler sends buildPayload's
  // output straight through as the PATCH body, opening an archived
  // trackable's edit URL and saving (e.g. just to fix a typo in the name)
  // silently un-archived it — the row popped right back onto Home. The
  // fix removes `archived` from the payload entirely; the database column
  // already defaults to false on insert, so create mode loses nothing.
  it('a boolean state (as used by both #/new and #/t/:id/edit) never includes `archived`', () => {
    const payload = buildPayload(validBooleanState());
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload, 'archived'),
      false,
      'buildPayload must never send `archived` — the form has no control for it, and sending it can silently un-archive a trackable on edit'
    );
  });

  it('a numeric state with bounds/target set never includes `archived`', () => {
    const payload = buildPayload(
      validNumericState({
        target_type: 'weekly_count',
        target_value: '5',
        bounds_enabled: true,
        bounds_mode: 'manual',
        bound_lower: '1',
        bound_upper: '2',
      })
    );
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'archived'), false);
  });

  it('a stray `archived: true` on the input state (e.g. loaded from an archived row in edit mode) is never copied into the payload', () => {
    // Simulates the exact edit-mode scenario the bug hit: the loaded
    // trackable's own `archived` value ends up spread into form state.
    // buildPayload must strip it regardless of its value, not just its
    // own historical default of `false`.
    const state = { ...validBooleanState(), archived: true };
    const payload = buildPayload(state);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'archived'), false);
  });
});

describe('buildPayload — boolean, target_type "weekly_count": target_value included as a number', () => {
  it('includes target_value as a finite number, still omits unit/bounds_*', () => {
    const state = validBooleanState({ target_type: 'weekly_count', target_value: '3' });
    const payload = buildPayload(state);
    assert.equal(payload.target_type, 'weekly_count');
    assert.equal(payload.target_value, 3);
    assert.equal(typeof payload.target_value, 'number');
    for (const key of ['unit', 'bounds_enabled', 'bounds_mode', 'bound_lower', 'bound_upper']) {
      assert.equal(key in payload, false, `expected "${key}" to be absent`);
    }
  });
});

describe('buildPayload — numeric, bounds disabled: includes unit AND bounds_enabled/bounds_mode (§3.6: "only when numeric", not "only when numeric and enabled"), omits bound_lower/bound_upper and target_value', () => {
  // CONTRACT-2.2.md §3.6 reads: "plus bounds_enabled / bounds_mode only
  // when numeric, plus bound_lower / bound_upper only when bounds are
  // manual." bounds_enabled/bounds_mode are gated on value_shape alone —
  // they are the persisted state of the checkbox/select itself (so a later
  // edit still knows bounds are off), independent of whether the bounds_mode
  // picker is currently visible in the DOM. Only bound_lower/bound_upper are
  // gated on bounds actually being enabled AND manual. Do not conflate this
  // with visibleFields()'s DOM-visibility rule, which is a different axis.
  it('includes unit, aggregation, bounds_enabled:false and bounds_mode; omits bound_lower/bound_upper and target_value', () => {
    const state = validNumericState({ aggregation: 'sum', target_type: 'none', bounds_enabled: false, bounds_mode: 'auto' });
    const payload = buildPayload(state);
    assert.equal(payload.unit, 'kg');
    assert.equal(payload.aggregation, 'sum');
    assert.equal(payload.bounds_enabled, false);
    assert.equal(payload.bounds_mode, 'auto');
    for (const key of ['target_value', 'bound_lower', 'bound_upper']) {
      assert.equal(key in payload, false, `expected "${key}" to be absent`);
    }
  });
});

describe('buildPayload — numeric, bounds enabled + auto: includes bounds_enabled/bounds_mode, omits bound_lower/bound_upper', () => {
  it('bounds_enabled true, bounds_mode "auto" -> no bound_lower/bound_upper keys', () => {
    const state = validNumericState({ bounds_enabled: true, bounds_mode: 'auto' });
    const payload = buildPayload(state);
    assert.equal(payload.bounds_enabled, true);
    assert.equal(payload.bounds_mode, 'auto');
    assert.equal('bound_lower' in payload, false);
    assert.equal('bound_upper' in payload, false);
  });
});

describe('buildPayload — numeric, bounds enabled + manual: includes bound_lower/bound_upper as numbers', () => {
  it('bounds_enabled true, bounds_mode "manual", bound_lower "10", bound_upper "20" -> numeric 10 and 20', () => {
    const state = validNumericState({
      bounds_enabled: true,
      bounds_mode: 'manual',
      bound_lower: '10',
      bound_upper: '20',
    });
    const payload = buildPayload(state);
    assert.equal(payload.bound_lower, 10);
    assert.equal(payload.bound_upper, 20);
    assert.equal(typeof payload.bound_lower, 'number');
    assert.equal(typeof payload.bound_upper, 'number');
  });
});

describe('buildPayload — unit trimming and empty-unit-becomes-null rule (§3.5: "unit is trimmed; an empty unit is saved as null, not \'\'")', () => {
  it('a unit with surrounding whitespace is trimmed', () => {
    const payload = buildPayload(validNumericState({ unit: '  kg  ' }));
    assert.equal(payload.unit, 'kg');
  });

  it('an empty-string unit becomes null (key still present)', () => {
    const payload = buildPayload(validNumericState({ unit: '' }));
    assert.equal('unit' in payload, true);
    assert.equal(payload.unit, null);
  });

  it('a whitespace-only unit becomes null', () => {
    const payload = buildPayload(validNumericState({ unit: '   ' }));
    assert.equal('unit' in payload, true);
    assert.equal(payload.unit, null);
  });
});

describe('buildPayload — name trimming (§3.5: "name is trimmed before saving")', () => {
  it('leading/trailing whitespace is trimmed from name', () => {
    const payload = buildPayload(validBooleanState({ name: '  Workout  ' }));
    assert.equal(payload.name, 'Workout');
  });
});

describe('buildPayload — never sends id/created_at/sort_order for a full numeric+bounds+target state either', () => {
  it('the full numeric key set still excludes id/created_at/sort_order', () => {
    const state = {
      ...validNumericState({
        target_type: 'weekly_count',
        target_value: '5',
        bounds_enabled: true,
        bounds_mode: 'manual',
        bound_lower: '1',
        bound_upper: '2',
      }),
      id: 42,
      created_at: 'x',
      sort_order: 3,
    };
    const payload = buildPayload(state);
    assert.equal('id' in payload, false);
    assert.equal('created_at' in payload, false);
    assert.equal('sort_order' in payload, false);
  });
});
