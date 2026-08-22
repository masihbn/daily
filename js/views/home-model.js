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

const DOT = ' · '; // space, MIDDLE DOT, space

function hasEntryValue(trackable, entry) {
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
    if (trackable.relog_semantic === 'cumulative') {
      return has
        ? `Today: ${formatValue(trackable, entry.value)}${DOT}new value is added`
        : "Adds to today's total";
    }
    if (trackable.relog_semantic === 'state') {
      return has
        ? `Today: ${formatValue(trackable, entry.value)}${DOT}new value replaces it`
        : "Replaces today's value";
    }
    return '';
  }

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
  };
}
