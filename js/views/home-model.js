// Pure view-model helpers for the Home screen (Step 2.1). PURE MODULE: no
// DOM, no fetch, no localStorage. May import only from ../aggregate.js and
// ../dates.js (only ../aggregate.js is actually needed here). Every
// function is total for the inputs it documents (never throws) except
// where a throw is explicitly specified — see nextValueFor().
//
// This module owns NO re-log semantics of its own: nextValueFor() is a
// thin wrapper over aggregate.js's applyRelog(), which is the single
// implementation of "what does re-logging today do."

import { applyRelog } from '../aggregate.js';

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// --- 2.1 visibleTrackables ------------------------------------------------

function compareIds(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    return na - nb;
  }
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

export function visibleTrackables(trackables) {
  if (!Array.isArray(trackables)) return [];

  const kept = trackables.filter(
    (t) => t !== null && typeof t === 'object' && t.archived !== true
  );

  // Array.prototype.sort is a stable sort (guaranteed by spec since
  // ES2019, and true of every engine this app targets), so ties on
  // (sort_order, id) preserve their relative input order without any
  // extra bookkeeping.
  return kept.sort((a, b) => {
    const soA = Number.isFinite(a.sort_order) ? a.sort_order : 0;
    const soB = Number.isFinite(b.sort_order) ? b.sort_order : 0;
    if (soA !== soB) return soA - soB;
    return compareIds(a.id, b.id);
  });
}

// --- 2.2 formatValue -------------------------------------------------------

export function formatValue(trackable, value) {
  if (!isFiniteNumber(value)) return '—'; // EM DASH

  const shape = trackable && typeof trackable === 'object' ? trackable.value_shape : undefined;

  if (shape === 'boolean') {
    return value !== 0 ? 'Done' : '—';
  }

  if (shape === 'numeric') {
    const rounded = Number(value.toFixed(2));
    let out = String(rounded);
    const unit = trackable.unit;
    if (typeof unit === 'string' && unit !== '') {
      out += ' ' + unit;
    }
    return out;
  }

  return '—';
}

// --- 2.3 relogHint -----------------------------------------------------
//
// Step 2.1b: additive wording is gone entirely — re-logging a numeric
// trackable REPLACES the day's value now (migration 0004), and every row
// is treated the same regardless of relog_semantic. See CONTRACT-2.1b.md
// §3.5. The good/bad meaning that used to leak into this text now lives
// in verdict()/statusWord()/statusSymbol() below instead.

const DOT = ' · '; // space, MIDDLE DOT, space

export function hasEntryValue(trackable, entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!isFiniteNumber(entry.value)) return false;
  if (trackable.value_shape === 'boolean' && entry.value === 0) return false;
  return true;
}

export function relogHint(trackable, entry) {
  if (!trackable || typeof trackable !== 'object') return '';

  const has = hasEntryValue(trackable, entry);
  const shape = trackable.value_shape;

  if (shape === 'boolean') {
    return has ? `Logged today${DOT}tap to clear` : 'Tap to log today';
  }

  if (shape === 'numeric') {
    return has
      ? `Today: ${formatValue(trackable, entry.value)}${DOT}tap to change`
      : "Tap to log today's value";
  }

  return '';
}

// --- 3.1-3.4 verdict / statusWord / statusSymbol / directionLabel --------
//
// The governing rule (CONTRACT-2.1b.md §0): a green check means "today is
// good", NOT "logged". For a `break`-direction habit the unlogged state
// is the good one — ticking a box reads as an achievement, so a bad
// habit's tick must not look rewarding. Do not "correct" this so that a
// check means logged; that would invert the entire point of the design.

function directionOrBuild(trackable) {
  return trackable && trackable.direction === 'break' ? 'break' : 'build';
}

export function verdict(trackable, entry) {
  if (!trackable || typeof trackable !== 'object') return 'neutral';

  if (trackable.value_shape === 'boolean') {
    const logged = hasEntryValue(trackable, entry);
    const dir = directionOrBuild(trackable);
    if (dir === 'break') {
      return logged ? 'bad' : 'good';
    }
    // 'build' (including missing/unknown direction)
    return logged ? 'good' : 'neutral';
  }

  if (trackable.value_shape === 'numeric') {
    // Step 2.4 defect 5: a numeric with manually-set bounds now reads as
    // good/bad against them — the user set bounds and saw no colour
    // change at all, which is the bug being fixed here. Both edges are
    // inclusive (a value exactly on a bound counts as in range).
    //
    // Only bounds_mode === 'manual' is handled. 'auto' bounds come from
    // aggregate.deriveBounds() over the rolling window, which needs
    // history the home screen does not load — that is wired up in
    // Step 3.3. Until then, an 'auto'-bounded numeric reading as
    // 'neutral' here is pending, not broken.
    if (
      trackable.bounds_enabled === true &&
      trackable.bounds_mode === 'manual' &&
      isFiniteNumber(trackable.bound_lower) &&
      isFiniteNumber(trackable.bound_upper) &&
      entry &&
      typeof entry === 'object' &&
      isFiniteNumber(entry.value)
    ) {
      if (entry.value < trackable.bound_lower || entry.value > trackable.bound_upper) {
        return 'bad';
      }
      return 'good';
    }
    return 'neutral';
  }

  // any other/unknown value_shape: no honest way to call it good or bad.
  return 'neutral';
}

export function statusWord(trackable, entry) {
  if (!trackable || typeof trackable !== 'object') return '';

  if (trackable.value_shape === 'boolean') {
    const logged = hasEntryValue(trackable, entry);
    const dir = directionOrBuild(trackable);

    if (dir === 'break') {
      return logged ? 'Logged' : 'Clean';
    }
    return logged ? 'Done' : 'Not yet';
  }

  if (trackable.value_shape === 'numeric') {
    // Step 2.4 defect 5: the non-colour cue (WCAG 1.4.1) for the new
    // bounded-numeric verdict above. Mirrors verdict() exactly — see its
    // comment for why only bounds_mode 'manual' is handled.
    const v = verdict(trackable, entry);
    if (v === 'bad') return 'Out of range';
    if (v === 'good') return 'In range';
    return '';
  }

  return '';
}

export function statusSymbol(trackable, entry) {
  const v = verdict(trackable, entry);
  if (v === 'good') return 'check';
  if (v === 'bad') return 'cross';
  return 'empty';
}

export function directionLabel(trackable) {
  if (!trackable || typeof trackable !== 'object') return '';
  if (trackable.direction === 'build') return 'more is better';
  if (trackable.direction === 'break') return 'less is better';
  return '';
}

// --- 2.4 parseNumericInput -----------------------------------------------

const NUMERIC_RE = /^-?(\d+(\.\d*)?|\.\d+)$/;

export function parseNumericInput(text) {
  if (typeof text !== 'string') return null;

  const trimmed = text.trim();
  if (trimmed === '') return null;

  const commaCount = (trimmed.match(/,/g) || []).length;
  if (commaCount > 1) return null;
  if (trimmed.includes(',') && trimmed.includes('.')) return null;

  const normalized = commaCount === 1 ? trimmed.replace(',', '.') : trimmed;

  if (!NUMERIC_RE.test(normalized)) return null;

  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

// --- 2.5 nextValueFor ------------------------------------------------------

export function nextValueFor(trackable, entry, input) {
  const existing = entry && isFiniteNumber(entry.value) ? entry.value : null;

  if (trackable && typeof trackable === 'object' && trackable.value_shape === 'boolean') {
    // input is ignored for boolean rows — applyRelog always returns 1.
    return applyRelog(existing, 1, trackable);
  }

  return applyRelog(existing, input, trackable);
}

// --- 2.6 rowModel ------------------------------------------------------

export function rowModel(trackable, entry, status) {
  const state = status === 'idle' || status === 'pending' || status === 'failed' ? status : 'idle';

  if (!trackable || typeof trackable !== 'object') {
    return {
      id: '',
      name: '',
      shape: 'unknown',
      logged: false,
      valueText: '—',
      hint: '',
      state,
      color: null,
      icon: null,
      verdict: 'neutral',
      statusWord: '',
      statusSymbol: 'empty',
      directionLabel: '',
    };
  }

  const shape =
    trackable.value_shape === 'boolean'
      ? 'boolean'
      : trackable.value_shape === 'numeric'
      ? 'numeric'
      : 'unknown';

  return {
    id: String(trackable.id),
    name: typeof trackable.name === 'string' ? trackable.name : '',
    shape,
    logged: hasEntryValue(trackable, entry),
    valueText: formatValue(trackable, entry ? entry.value : null),
    hint: relogHint(trackable, entry),
    state,
    color: typeof trackable.color === 'string' && trackable.color !== '' ? trackable.color : null,
    // Step 2.5: the icon key, or null when the trackable has none set — the
    // view falls back to 'dot' for both null and an unrecognized key (see
    // home.js buildRow()), so the trackable's colour is visible even before
    // an icon is picked.
    icon: typeof trackable.icon === 'string' && trackable.icon !== '' ? trackable.icon : null,
    verdict: verdict(trackable, entry),
    statusWord: statusWord(trackable, entry),
    statusSymbol: statusSymbol(trackable, entry),
    directionLabel: directionLabel(trackable),
  };
}
