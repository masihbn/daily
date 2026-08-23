// Create / edit a trackable (Step 2.2). The user defines what they track
// without touching SQL.
//
// This file exports two kinds of things:
//   1. PURE form-model helpers (defaultsFor, applyShapeChange,
//      visibleFields, validate, buildPayload) — no DOM, no fetch, no
//      localStorage. A separate agent unit-tests these in Node with no
//      DOM, so nothing below the "pure exports" section may touch
//      `document`, `fetch` or `localStorage`.
//   2. `createTrackableView(...)`, the DOM + network wiring, following the
//      same view lifecycle as ./home.js (idempotent synchronous unmount,
//      a `disposed` flag checked after every await, exactly one delegated
//      listener per event type on the root, no exception ever escapes a
//      handler).
//
// See docs/BUILD_PLAN.md Step 2.2 and CONTRACT-2.2.md for the exact DOM
// shape, field visibility rules, validation messages and payload keys
// this file implements.

import { getStore } from '../store.js';
import * as apiModule from '../api.js';
import { parseNumericInput } from './home-model.js';

// --- shared constants ------------------------------------------------------

// DOM order for the `div.tform-field[data-field]` wrappers — also the
// order visibleFields() returns. Binding per CONTRACT-2.2.md §3.8.
const FIELD_ORDER = [
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
];

// Exact palette and order per CONTRACT-2.2.md §3.2.
const PALETTE = ['#34c759', '#3478f6', '#ff9f0a', '#ff453a', '#bf5af2', '#8e8e93'];
const COLOR_NAMES = {
  '#34c759': 'Green',
  '#3478f6': 'Blue',
  '#ff9f0a': 'Orange',
  '#ff453a': 'Red',
  '#bf5af2': 'Purple',
  '#8e8e93': 'Gray',
};

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// =============================================================================
// PURE FORM-MODEL EXPORTS — no DOM, no fetch, no localStorage. Keep it that
// way; a separate agent unit-tests these in Node with no DOM available.
// =============================================================================

// --- defaultsFor -------------------------------------------------------

// relog_semantic is deliberately NOT a form field: Step 2.1b removed
// additive logging from the product, so every trackable this form creates
// is written with relog_semantic: 'state' (see buildPayload below).
//
// target_type offers 'none' plus one shape-specific option — see
// targetOptionsFor() below (Step 2.4 defect 4: "Times per week" is
// meaningless for a numeric metric like calories, so the option offered
// now depends on value_shape). The schema also has a 'specific_days'
// target type (target_days column), but its UI is deliberately deferred —
// see docs/APP_CONCEPT.md "Specific days of week" (the one open design
// question left for v1). Do not add a control for it in this step.
export function defaultsFor(valueShape) {
  const shape = valueShape === 'numeric' ? 'numeric' : 'boolean';
  return {
    name: '',
    value_shape: shape,
    direction: 'build',
    unit: '',
    // aggregation is forced by value_shape — see applyShapeChange().
    aggregation: shape === 'numeric' ? 'sum' : 'count',
    target_type: 'none',
    target_value: '',
    bounds_enabled: false,
    bounds_mode: 'auto',
    bound_lower: '',
    bound_upper: '',
    color: PALETTE[0],
  };
}

// --- targetOptionsFor ------------------------------------------------------

// Step 2.4 defect 4: "Times per week" is meaningless for a numeric metric
// like calories, so the target options offered depend on value_shape.
// 'none' is legal for both shapes; each shape then gets exactly one
// target type of its own. Exported (named) so it is unit-testable and so
// applyShapeChange() below can derive "is the current target_type still
// legal for the new shape" from the same single source of truth instead
// of duplicating the option list.
export function targetOptionsFor(valueShape) {
  const shape = valueShape === 'numeric' ? 'numeric' : 'boolean';
  if (shape === 'numeric') {
    return [
      { value: 'none', label: 'No target' },
      { value: 'weekly_average', label: 'Average per week' },
    ];
  }
  return [
    { value: 'none', label: 'No target' },
    { value: 'weekly_count', label: 'Times per week' },
  ];
}

// --- applyShapeChange ----------------------------------------------------

// `aggregation` is forced by `value_shape`, never merely disabled: 'count'
// is never offered in the numeric select, and the numeric options are
// never applied to a boolean. Every other field is left as-is — only
// aggregation changes here — EXCEPT target_type/target_value, which must
// also reset when the current target_type is not legal for the new shape
// (Step 2.4 defect 4): switching Boolean -> Numeric with 'weekly_count'
// selected must not leave an illegal combination that the database check
// constraint would reject on save.
export function applyShapeChange(state, valueShape) {
  const shape = valueShape === 'numeric' ? 'numeric' : 'boolean';
  const base = state && typeof state === 'object' ? state : {};

  const legalTargetTypes = targetOptionsFor(shape).map((opt) => opt.value);
  const targetStillLegal = legalTargetTypes.includes(base.target_type);

  return {
    ...base,
    value_shape: shape,
    aggregation: shape === 'numeric' ? 'sum' : 'count',
    target_type: targetStillLegal ? base.target_type : 'none',
    target_value: targetStillLegal ? base.target_value : '',
  };
}

// --- visibleFields ---------------------------------------------------------

export function visibleFields(state) {
  const s = state && typeof state === 'object' ? state : {};
  const numeric = s.value_shape === 'numeric';
  const boundsOn = numeric && s.bounds_enabled === true;
  const manual = boundsOn && s.bounds_mode === 'manual';

  const visibility = {
    name: true,
    value_shape: true,
    direction: true,
    unit: numeric,
    aggregation: numeric,
    target_type: true,
    // Step 2.4 defect 4: applies to both target types (weekly_count and
    // weekly_average), so this is keyed on "has a target" rather than on
    // one specific target_type value.
    target_value: s.target_type !== 'none',
    bounds_enabled: numeric,
    bounds_mode: boundsOn,
    bound_lower: manual,
    bound_upper: manual,
    color: true,
  };

  return FIELD_ORDER.filter((f) => visibility[f]);
}

// --- validate ----------------------------------------------------------

// Runs on submit, before any network call. Only the first failing message
// is returned — the caller must not attempt to show more than one.
export function validate(state) {
  const s = state && typeof state === 'object' ? state : {};

  const name = typeof s.name === 'string' ? s.name : '';
  if (name.trim() === '') {
    return { ok: false, message: 'Name is required' };
  }

  // Step 2.4 defect 4: the same rule applies to both target types
  // (weekly_count and weekly_average) — same message either way.
  if (s.target_type !== 'none') {
    const tv = parseNumericInput(s.target_value);
    if (tv === null || !(tv > 0)) {
      return { ok: false, message: 'Target must be a number greater than 0' };
    }
  }

  const numeric = s.value_shape === 'numeric';
  const boundsOn = numeric && s.bounds_enabled === true;
  const manual = boundsOn && s.bounds_mode === 'manual';
  if (manual) {
    const lower = parseNumericInput(s.bound_lower);
    const upper = parseNumericInput(s.bound_upper);
    if (lower === null || upper === null) {
      return { ok: false, message: 'Both bounds are required' };
    }
    if (lower >= upper) {
      return { ok: false, message: 'Lower bound must be less than upper bound' };
    }
  }

  return { ok: true };
}

// --- buildPayload --------------------------------------------------------

// Exactly the keys CONTRACT-2.2.md §3.6 allows — same key rules for both
// `new` (-> api.createTrackable) and `edit` (-> api.updateTrackable). Never
// includes id / created_at / sort_order.
export function buildPayload(state) {
  const s = state && typeof state === 'object' ? state : {};
  const numeric = s.value_shape === 'numeric';
  const boundsOn = numeric && s.bounds_enabled === true;
  const manual = boundsOn && s.bounds_mode === 'manual';

  const name = typeof s.name === 'string' ? s.name.trim() : '';

  // Step 2.4 defect 4: target_type is now one of 'none' /
  // 'weekly_count' / 'weekly_average' — any other value (e.g. the
  // deliberately-unexposed 'specific_days') collapses to 'none' here,
  // same as before.
  const targetType = ['weekly_count', 'weekly_average'].includes(s.target_type)
    ? s.target_type
    : 'none';

  const payload = {
    name,
    value_shape: numeric ? 'numeric' : 'boolean',
    relog_semantic: 'state',
    aggregation: s.aggregation,
    direction: s.direction === 'break' ? 'break' : 'build',
    target_type: targetType,
    color: s.color,
    // `archived` is deliberately never sent from this form: there is no
    // archived control here, and archiving is a separate explicit action
    // (api.archiveTrackable). Sending it (even `false`) would silently
    // un-archive a trackable when its edit URL is opened and saved. Don't
    // add it back "for symmetry" with the other columns.
  };

  if (numeric) {
    const unit = typeof s.unit === 'string' ? s.unit.trim() : '';
    payload.unit = unit === '' ? null : unit;
  }

  if (targetType !== 'none') {
    payload.target_value = parseNumericInput(s.target_value);
  }

  if (numeric) {
    payload.bounds_enabled = s.bounds_enabled === true;
    payload.bounds_mode = s.bounds_mode === 'manual' ? 'manual' : 'auto';
  }

  if (manual) {
    payload.bound_lower = parseNumericInput(s.bound_lower);
    payload.bound_upper = parseNumericInput(s.bound_upper);
  }

  return payload;
}

// =============================================================================
// DOM + network wiring
// =============================================================================

function stringifyNum(v) {
  return isFiniteNumber(v) ? String(v) : '';
}

// Maps a raw `trackables` row (server shape) to the form-state shape used
// by the pure helpers above, applying the same progressive-disclosure
// rules on the way in that visibleFields() applies on the way out.
function stateFromTrackable(t) {
  const numeric = t.value_shape === 'numeric';
  return {
    name: typeof t.name === 'string' ? t.name : '',
    value_shape: numeric ? 'numeric' : 'boolean',
    direction: t.direction === 'break' ? 'break' : 'build',
    unit: typeof t.unit === 'string' ? t.unit : '',
    aggregation: numeric
      ? ['sum', 'average', 'last'].includes(t.aggregation)
        ? t.aggregation
        : 'sum'
      : 'count',
    // Step 2.4 defect 4: 'weekly_average' joins 'weekly_count' as a legal
    // loaded value; anything else (including the unexposed
    // 'specific_days') maps to 'none' as before.
    target_type: ['weekly_count', 'weekly_average'].includes(t.target_type) ? t.target_type : 'none',
    target_value: stringifyNum(t.target_value),
    bounds_enabled: t.bounds_enabled === true,
    bounds_mode: t.bounds_mode === 'manual' ? 'manual' : 'auto',
    bound_lower: stringifyNum(t.bound_lower),
    bound_upper: stringifyNum(t.bound_upper),
    color: typeof t.color === 'string' && t.color !== '' ? t.color : PALETTE[0],
  };
}

export function createTrackableView({ mode, id, api, store } = {}) {
  const ap = api || apiModule;
  const st = store || getStore();
  const formMode = mode === 'edit' ? 'edit' : 'new';

  let container = null;
  let sectionEl = null;
  let disposed = true;

  let formState = null;
  let trackable = null; // raw loaded row, edit mode only
  // 'loading' | 'ready' | 'saving' | 'notfound' | 'error'
  //
  // ASSUMPTION (contract does not pin this down with a worked example):
  // a client-side validation failure (empty name, bad target, bad bounds)
  // never issues a network request, so it leaves viewState at 'ready' and
  // only sets errorMessage — 'error' is reserved for a failed save (a
  // real createTrackable/updateTrackable/archiveTrackable rejection).
  let viewState = 'loading';
  let errorMessage = null;
  let showArchiveConfirm = false;

  function ensureSection() {
    if (sectionEl) return sectionEl;
    sectionEl = document.createElement('section');
    sectionEl.className = 'tform';
    // Exactly one listener per event type, delegated on this root,
    // attached once here and removed in unmount().
    sectionEl.addEventListener('change', handleChange);
    sectionEl.addEventListener('submit', handleSubmit);
    sectionEl.addEventListener('click', handleClick);
    container.appendChild(sectionEl);
    return sectionEl;
  }

  // --- field builders ------------------------------------------------------

  function textField(fieldName, labelText, { decimal = false } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'tform-field';
    wrap.dataset.field = fieldName;

    const id = `tf-${fieldName}`;
    const label = document.createElement('label');
    label.setAttribute('for', id);
    label.textContent = labelText;
    wrap.appendChild(label);

    const input = document.createElement('input');
    input.className = 'tform-input';
    // type="text" + inputmode="decimal" for numeric-ish fields — NOT
    // type="number": inputmode="decimal" is what raises iOS's numeric
    // keypad, and type="number" would silently discard a decimal-comma
    // before parseNumericInput() ever sees it (see home.js for the same
    // established pattern). Do not "fix" this to type="number".
    input.type = 'text';
    if (decimal) input.setAttribute('inputmode', 'decimal');
    input.id = id;
    input.name = fieldName;
    input.value = typeof formState[fieldName] === 'string' ? formState[fieldName] : '';
    wrap.appendChild(input);

    return wrap;
  }

  function radioField(fieldName, labelText, options) {
    const wrap = document.createElement('div');
    wrap.className = 'tform-field';
    wrap.dataset.field = fieldName;

    const legend = document.createElement('span');
    legend.className = 'tform-label';
    legend.textContent = labelText;
    wrap.appendChild(legend);

    const group = document.createElement('div');
    group.className = 'tform-radio-group';
    for (const opt of options) {
      const id = `tf-${fieldName}-${opt.value}`;

      // DEFECT 2 fix (CONTRACT-2.4.md §4): each radio + its label is
      // wrapped in one flex item (span.tform-radio-pair) so a wrap can
      // never split a radio from its own label, and so the two are
      // vertically centred against each other directly instead of relying
      // on the group's cross-axis alignment.
      const pair = document.createElement('span');
      pair.className = 'tform-radio-pair';

      const input = document.createElement('input');
      input.type = 'radio';
      input.id = id;
      input.name = fieldName;
      input.value = opt.value;
      input.checked = formState[fieldName] === opt.value;
      pair.appendChild(input);

      const lab = document.createElement('label');
      lab.setAttribute('for', id);
      lab.textContent = opt.label;
      pair.appendChild(lab);

      group.appendChild(pair);
    }
    wrap.appendChild(group);

    return wrap;
  }

  function selectField(fieldName, labelText, options) {
    const wrap = document.createElement('div');
    wrap.className = 'tform-field';
    wrap.dataset.field = fieldName;

    const id = `tf-${fieldName}`;
    const label = document.createElement('label');
    label.setAttribute('for', id);
    label.textContent = labelText;
    wrap.appendChild(label);

    const select = document.createElement('select');
    select.className = 'tform-select';
    select.id = id;
    select.name = fieldName;
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (formState[fieldName] === opt.value) o.selected = true;
      select.appendChild(o);
    }
    wrap.appendChild(select);

    return wrap;
  }

  function checkboxField() {
    const wrap = document.createElement('div');
    wrap.className = 'tform-field';
    wrap.dataset.field = 'bounds_enabled';

    const id = 'tf-bounds_enabled';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.name = 'bounds_enabled';
    input.checked = formState.bounds_enabled === true;
    wrap.appendChild(input);

    const label = document.createElement('label');
    label.setAttribute('for', id);
    label.textContent = 'Track a healthy range';
    wrap.appendChild(label);

    return wrap;
  }

  function colorField() {
    const wrap = document.createElement('div');
    wrap.className = 'tform-field';
    wrap.dataset.field = 'color';

    const legend = document.createElement('span');
    legend.className = 'tform-label';
    legend.textContent = 'Color';
    wrap.appendChild(legend);

    const group = document.createElement('div');
    group.className = 'tform-color-group';
    for (const hex of PALETTE) {
      const id = `tf-color-${hex.slice(1)}`;
      const input = document.createElement('input');
      input.type = 'radio';
      input.id = id;
      input.name = 'color';
      input.value = hex;
      input.checked = formState.color === hex;
      group.appendChild(input);

      const lab = document.createElement('label');
      lab.setAttribute('for', id);
      lab.className = 'tform-color-swatch';
      lab.style.backgroundColor = hex;
      lab.title = COLOR_NAMES[hex] || hex;
      const srText = document.createElement('span');
      srText.className = 'visually-hidden';
      srText.textContent = COLOR_NAMES[hex] || hex;
      lab.appendChild(srText);
      group.appendChild(lab);
    }
    wrap.appendChild(group);

    return wrap;
  }

  function buildField(fieldName, visible) {
    let wrap;
    switch (fieldName) {
      case 'name':
        wrap = textField('name', 'Name');
        break;
      case 'value_shape':
        // DEFECT 3 (CONTRACT-2.4.md §5): the user explicitly asked for the
        // raw model words here — this deliberately OVERRIDES the "never
        // render the raw enum" rule from CONTRACT-2.2.md §3.2 for this one
        // field only. direction and aggregation below keep their
        // plain-English labels; do not "fix" this back to Yes/No.
        wrap = radioField('value_shape', 'Type', [
          { value: 'boolean', label: 'Boolean' },
          { value: 'numeric', label: 'Numeric' },
        ]);
        break;
      case 'direction':
        // Never render the raw enum — see CONTRACT-2.2.md §3.2.
        wrap = radioField('direction', 'Direction', [
          { value: 'build', label: 'More is better' },
          { value: 'break', label: 'Less is better' },
        ]);
        break;
      case 'unit':
        wrap = textField('unit', 'Unit');
        break;
      case 'aggregation':
        // Never render the raw enum, and never offer 'count' here — it is
        // forced automatically for boolean trackables (applyShapeChange).
        wrap = selectField('aggregation', 'Roll-up', [
          { value: 'sum', label: 'Total' },
          { value: 'average', label: 'Average' },
          { value: 'last', label: 'Latest' },
        ]);
        break;
      case 'target_type':
        // DEFECT 4 (CONTRACT-2.4.md §6): the options depend on
        // value_shape — "Times per week" is meaningless for a numeric
        // metric like calories. See targetOptionsFor() above. The schema
        // also has a 'specific_days' target type (target_days column) —
        // its UI is deliberately deferred; see docs/APP_CONCEPT.md
        // "Specific days of week". Do not add a control for it here.
        wrap = selectField('target_type', 'Target', targetOptionsFor(formState.value_shape));
        break;
      case 'target_value': {
        // Label tracks whichever target type is currently selected, since
        // this one field now serves two different targets (Step 2.4
        // defect 4). Not pinned down verbatim by the contract; kept
        // consistent with the wording used in the target_type select
        // itself so the two never disagree.
        const label = formState.target_type === 'weekly_average' ? 'Average per week' : 'Times per week';
        wrap = textField('target_value', label, { decimal: true });
        break;
      }
      case 'bounds_enabled':
        wrap = checkboxField();
        break;
      case 'bounds_mode':
        wrap = selectField('bounds_mode', 'Bounds', [
          { value: 'auto', label: 'Automatic' },
          { value: 'manual', label: 'Manual' },
        ]);
        break;
      case 'bound_lower':
        wrap = textField('bound_lower', 'Lower bound', { decimal: true });
        break;
      case 'bound_upper':
        wrap = textField('bound_upper', 'Upper bound', { decimal: true });
        break;
      case 'color':
        wrap = colorField();
        break;
      default:
        wrap = document.createElement('div');
    }
    // DEFECT 1 fix (CONTRACT-2.4.md §3), defence-in-depth half: a
    // stylesheet rule alone (`.tform-field[hidden] { display: none }` in
    // styles.css) is enough to actually hide the field, but a `disabled`
    // control additionally cannot be focused, cannot raise the iOS
    // keyboard, and is never submitted — so even if that CSS rule is ever
    // deleted, a hidden field can no longer capture input. Every wrapper
    // is rebuilt fresh on each render, so there is nothing to "clear" when
    // a field becomes visible again — a freshly built control is never
    // disabled unless this branch runs.
    if (!visible) {
      wrap.hidden = true;
      for (const el of wrap.querySelectorAll('input, select, textarea, button')) {
        el.disabled = true;
      }
    }
    return wrap;
  }

  // --- render ----------------------------------------------------------

  function render() {
    if (disposed || !container) return;

    const section = ensureSection();
    section.setAttribute('data-mode', formMode);
    section.setAttribute('data-state', viewState);
    section.innerHTML = '';

    if (viewState === 'notfound') {
      const p = document.createElement('p');
      p.appendChild(document.createTextNode('Trackable not found. '));
      const a = document.createElement('a');
      a.href = '#/';
      a.textContent = 'Back to Home';
      p.appendChild(a);
      section.appendChild(p);
      return;
    }

    if (viewState === 'loading') {
      const p = document.createElement('p');
      p.textContent = 'Loading…';
      section.appendChild(p);
      return;
    }

    // ready / saving / error: render the form.
    const form = document.createElement('form');
    form.className = 'tform-form';

    const vis = new Set(visibleFields(formState));
    for (const fieldName of FIELD_ORDER) {
      form.appendChild(buildField(fieldName, vis.has(fieldName)));
    }

    const saveBtn = document.createElement('button');
    saveBtn.className = 'tform-save';
    saveBtn.type = 'submit';
    saveBtn.disabled = viewState === 'saving';
    saveBtn.textContent = 'Save';
    form.appendChild(saveBtn);

    const cancelLink = document.createElement('a');
    cancelLink.className = 'tform-cancel';
    cancelLink.href = '#/';
    cancelLink.textContent = 'Cancel';
    form.appendChild(cancelLink);

    section.appendChild(form);

    // Archive (edit mode only) — archive, never a hard delete. See the
    // comment on doArchive() below for why.
    if (formMode === 'edit') {
      if (!showArchiveConfirm) {
        const archiveBtn = document.createElement('button');
        archiveBtn.className = 'tform-archive';
        archiveBtn.type = 'button';
        archiveBtn.disabled = viewState === 'saving';
        archiveBtn.textContent = 'Archive';
        section.appendChild(archiveBtn);
      } else {
        const confirmDiv = document.createElement('div');
        confirmDiv.className = 'tform-confirm-archive';
        confirmDiv.appendChild(
          document.createTextNode(
            'Archive this trackable? It will be hidden from Home but its history is kept.'
          )
        );

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'tform-archive-confirm';
        confirmBtn.type = 'button';
        confirmBtn.disabled = viewState === 'saving';
        confirmBtn.textContent = 'Archive';
        confirmDiv.appendChild(confirmBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'tform-archive-cancel';
        cancelBtn.type = 'button';
        cancelBtn.disabled = viewState === 'saving';
        cancelBtn.textContent = 'Cancel';
        confirmDiv.appendChild(cancelBtn);

        section.appendChild(confirmDiv);
      }
    }

    if (errorMessage) {
      const errP = document.createElement('p');
      errP.className = 'tform-error';
      errP.setAttribute('role', 'alert');
      errP.textContent = errorMessage;
      section.appendChild(errP);
    }
  }

  // --- event handlers ------------------------------------------------------

  // Reads the current DOM values of every plain-text field back into
  // formState before a re-render (triggered by a structural change
  // elsewhere in the form, or by submit) so nothing the user already
  // typed is lost — the same principle as home.js's captureLiveDraft(),
  // just covering every text field this form has instead of one.
  function syncTextFieldsFromDom() {
    if (!sectionEl) return;
    const form = sectionEl.querySelector('form.tform-form');
    if (!form) return;
    for (const name of ['name', 'unit', 'target_value', 'bound_lower', 'bound_upper']) {
      const input = form.querySelector(`input[name="${name}"]`);
      if (input) formState[name] = input.value;
    }
  }

  function handleChange(event) {
    try {
      const t = event.target;
      if (!t || !t.name || !sectionEl.contains(t)) return;

      syncTextFieldsFromDom();

      if (t.name === 'value_shape') {
        formState = applyShapeChange(formState, t.value);
      } else if (t.name === 'bounds_enabled') {
        formState.bounds_enabled = t.checked;
      } else if (t.type === 'radio' || t.tagName === 'SELECT') {
        formState[t.name] = t.value;
      } else {
        return;
      }

      render();
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  function handleClick(event) {
    try {
      const btn = event.target.closest ? event.target.closest('button') : null;
      if (!btn || !sectionEl.contains(btn)) return;

      if (btn.classList.contains('tform-archive')) {
        showArchiveConfirm = true;
        errorMessage = null;
        render();
      } else if (btn.classList.contains('tform-archive-cancel')) {
        showArchiveConfirm = false;
        render();
      } else if (btn.classList.contains('tform-archive-confirm')) {
        doArchive();
      }
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  function handleSubmit(event) {
    try {
      const form = event.target && event.target.closest ? event.target.closest('form.tform-form') : null;
      if (!form) return;
      event.preventDefault();
      if (viewState === 'saving') return;

      syncTextFieldsFromDom();

      const result = validate(formState);
      if (!result.ok) {
        errorMessage = result.message;
        render();
        return;
      }

      errorMessage = null;
      viewState = 'saving';
      render();

      const payload = buildPayload(formState);
      // Trackable writes are not queued offline — the outbox is
      // entries-only by design (store.js has no trackable-write methods;
      // see the module comment above createTrackableView). If this fails,
      // show the error and stay on the form; do not pretend it succeeded.
      const promise = formMode === 'edit' ? ap.updateTrackable(id, payload) : ap.createTrackable(payload);

      promise
        .then(() => {
          if (disposed) return;
          // Navigate home. #/'s mount() already calls
          // store.loadTrackables(), which refreshes the cache with the
          // new/changed row — this view does not need to touch the store
          // itself.
          location.hash = '#/';
        })
        .catch((err) => {
          if (disposed) return;
          viewState = 'error';
          errorMessage = err && err.message ? err.message : 'Something went wrong.';
          render();
        });
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  // Archive only — there is deliberately no hard delete in this step.
  // Reasons (recorded so it is not "added back for completeness" later):
  //   1. BUILD_PLAN.md Step 2.2: "Archive, not delete. The `archived`
  //      flag exists so history is never destroyed."
  //   2. `entries` cascades on the trackable FK, so a hard delete would
  //      silently destroy every logged day for that trackable —
  //      unrecoverable, and this app's entire purpose is that history.
  //   3. js/api.js has no deleteTrackable, and none is added here: its
  //      module header carries a data-safety invariant that deleteEntry()
  //      is the only DELETE call site, asserted structurally by the unit
  //      suite reading the file. Adding one would turn that suite red for
  //      a good reason.
  function doArchive() {
    if (viewState === 'saving') return;
    viewState = 'saving';
    errorMessage = null;
    render();

    ap.archiveTrackable(id)
      .then(() => {
        if (disposed) return;
        location.hash = '#/';
      })
      .catch((err) => {
        if (disposed) return;
        viewState = 'ready';
        showArchiveConfirm = false;
        errorMessage = err && err.message ? err.message : 'Something went wrong.';
        render();
      });
  }

  // --- lifecycle -----------------------------------------------------------

  async function mount(el) {
    container = el;
    disposed = false;
    ensureSection();

    if (formMode === 'edit') {
      viewState = 'loading';
      errorMessage = null;
      render();

      try {
        await st.loadTrackables();
        if (disposed) return;

        const list = st.getTrackables();
        trackable = Array.isArray(list) ? list.find((t) => t && String(t.id) === String(id)) : undefined;

        if (!trackable) {
          viewState = 'notfound';
          render();
          return;
        }

        formState = stateFromTrackable(trackable);
        viewState = 'ready';
        render();
      } catch (err) {
        if (disposed) return;
        // store.loadTrackables() never rejects, but guard the whole
        // sequence anyway (mirrors home.js's identical guard). Treat an
        // unexpected failure the same as "not found" rather than risk
        // rendering a blank form that could silently create a duplicate
        // on save.
        trackable = null;
        viewState = 'notfound';
        render();
      }
    } else {
      formState = defaultsFor('boolean');
      viewState = 'ready';
      errorMessage = null;
      render();
    }
  }

  function unmount() {
    if (disposed) return;
    disposed = true;
    if (sectionEl) {
      sectionEl.removeEventListener('change', handleChange);
      sectionEl.removeEventListener('submit', handleSubmit);
      sectionEl.removeEventListener('click', handleClick);
    }
    if (container) {
      container.innerHTML = '';
    }
    sectionEl = null;
    container = null;
  }

  return { mount, unmount };
}
