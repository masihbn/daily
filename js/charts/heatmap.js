// Calendar heatmap (Step 3.1). PURE-ish module: everything in this file
// except renderHeatmap() runs with no DOM at all — no `fetch`, no
// `localStorage`, no `store.js`, no `api.js`. Only renderHeatmap() touches
// `document`. This module issues ZERO network requests, ever: entries
// arrive as a plain array argument from the caller (js/views/detail.js),
// which already loaded them through the store. See CONTRACT-3.1.md §0(d)
// and Step 2.3's e2e case D6 (exactly one entries GET per detail-screen
// load, across every chart slot combined).
//
// Allowed imports, and only these:
import { monthGrid, parseLocal } from '../dates.js';
import { verdict, statusWord, formatValue, hasEntryValue } from '../views/home-model.js';

// §0(a): verdict() in js/views/home-model.js is the SINGLE implementation
// of "is this day good or bad". This module imports and calls it rather
// than encoding a second, parallel notion of good/bad. A `direction:
// 'break'` boolean reads an unlogged day as good (green) and a logged one
// as bad (red) — that is verdict()'s job, not this file's.
//
// §0(b)-(c): the detail screen is single-trackable, so cell *identity* is
// never in question (the header icon already carries it). Cell hue comes
// from verdict() where there is an honest verdict; where verdict() is
// 'neutral' (an unbounded numeric day), hue falls back to the trackable's
// own identity colour instead. Magnitude is a second, independent channel
// — alpha — so hue (good/bad/identity) and alpha (how much) never fight.

const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_STR_RE = /^\d{4}-\d{2}$/;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// The alpha floor for any logged numeric day, so a quiet day is still
// clearly distinguishable from an unlogged one.
export const MIN_ALPHA = 0.25;

// --- §2.2 rangeMaxValue ----------------------------------------------------

// Largest Math.abs(e.value) over entries whose value is a finite number.
// Never throws for any input.
export function rangeMaxValue(entries) {
  if (!Array.isArray(entries)) return 0;
  let max = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const v = e.value;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const abs = Math.abs(v);
    if (abs > max) max = abs;
  }
  return max;
}

// --- §2.3 monthOf ------------------------------------------------------

// Shape validation only ('YYYY-MM-DD') — no calendar validation beyond
// that; monthGrid/parseLocal do that where it matters.
export function monthOf(dateStr) {
  if (typeof dateStr !== 'string' || !DATE_STR_RE.test(dateStr)) {
    throw new RangeError(`monthOf: expected a 'YYYY-MM-DD' string, got: ${JSON.stringify(dateStr)}`);
  }
  return dateStr.slice(0, 7);
}

function isWellFormedMonth(str) {
  if (typeof str !== 'string' || !MONTH_STR_RE.test(str)) return false;
  const m = Number(str.slice(5, 7));
  return m >= 1 && m <= 12;
}

function parseMonthStrOrThrow(monthStr, fnName) {
  if (!isWellFormedMonth(monthStr)) {
    throw new RangeError(
      `${fnName}: expected a 'YYYY-MM' string with month 01-12, got: ${JSON.stringify(monthStr)}`
    );
  }
  return { year: Number(monthStr.slice(0, 4)), month: Number(monthStr.slice(5, 7)) };
}

// --- §2.4 shiftMonth -----------------------------------------------------

// Arithmetic on the absolute month index (year * 12 + (month - 1)) —
// deliberately NOT routed through Date, which brings back the
// day-of-month rollover trap this project has already been bitten by
// (see js/dates.js's header comment).
export function shiftMonth(monthStr, delta) {
  const { year, month } = parseMonthStrOrThrow(monthStr, 'shiftMonth');
  if (!Number.isSafeInteger(delta)) {
    throw new RangeError(`shiftMonth: delta must be a safe integer, got: ${JSON.stringify(delta)}`);
  }
  const idx = year * 12 + (month - 1) + delta;
  const newYear = Math.floor(idx / 12);
  const newMonth = idx - newYear * 12 + 1;
  return `${String(newYear).padStart(4, '0')}-${String(newMonth).padStart(2, '0')}`;
}

// --- §2.5 monthLabel -----------------------------------------------------

// Hardcoded English month names — deliberately NOT toLocaleString/Intl,
// which vary by host ICU build and would make every test non-deterministic
// across machines.
export function monthLabel(monthStr) {
  const { year, month } = parseMonthStrOrThrow(monthStr, 'monthLabel');
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

// --- §2.6 monthBoundsFor ---------------------------------------------------

// Which months the user is allowed to navigate to. `max` is never the
// future (monthOf(today)); `min` is the month of `from` when given, else
// the month of the earliest entry_date in `entries` (the 'all' range's
// case), else `max` itself when there is no data at all.
export function monthBoundsFor({ from, today, entries } = {}) {
  // parseLocal is the canonical "is this a real local calendar date"
  // check in this codebase (js/dates.js) — it throws RangeError for both
  // a malformed shape and a rolled-over invalid date (e.g. Feb 30), which
  // is exactly what "today must be a valid 'YYYY-MM-DD' string" calls for.
  parseLocal(today);
  const max = monthOf(today);

  let min;
  if (typeof from === 'string' && DATE_STR_RE.test(from)) {
    min = monthOf(from);
  } else {
    const list = Array.isArray(entries) ? entries : [];
    let earliest = null;
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      const d = e.entry_date;
      if (typeof d !== 'string' || !DATE_STR_RE.test(d)) continue;
      if (earliest === null || d < earliest) earliest = d;
    }
    // 'YYYY-MM-DD' strings compare lexicographically in chronological
    // order (js/dates.js relies on the same fact) — safe to compare as
    // plain strings without parsing to numbers.
    min = earliest !== null ? monthOf(earliest) : max;
  }

  if (min > max) return { min: max, max };
  return { min, max };
}

// --- §2.7 clampMonth -------------------------------------------------------

// Never throws for any monthStr. `bounds` is always supplied by
// monthBoundsFor, so it is assumed well-formed here.
export function clampMonth(monthStr, bounds) {
  if (!isWellFormedMonth(monthStr)) return bounds.max;
  if (monthStr < bounds.min) return bounds.min;
  if (monthStr > bounds.max) return bounds.max;
  return monthStr;
}

// --- §2.8 heatmapModel -----------------------------------------------------

// The core pure function. Everything the DOM needs, computed here. Never
// throws for any input except a malformed `today` (propagated from
// monthBoundsFor's parseLocal check above).
export function heatmapModel({ trackable, entries, month, today, from } = {}) {
  const bounds = monthBoundsFor({ from, today, entries });
  const clampedMonth = clampMonth(month, bounds);
  const canPrev = clampedMonth > bounds.min;
  const canNext = clampedMonth < bounds.max;
  const monthLbl = monthLabel(clampedMonth);

  const year = Number(clampedMonth.slice(0, 4));
  const monthNum = Number(clampedMonth.slice(5, 7));
  const grid = monthGrid(year, monthNum);

  const list = Array.isArray(entries) ? entries : [];
  const rangeMax = rangeMaxValue(list);

  // A null/garbage trackable must not throw anywhere below — hasEntryValue
  // (home-model.js §2.0) is a private helper there that assumes its caller
  // already validated `trackable`, which every existing call site inside
  // that module does. This is the one new call site, so the guard is
  // applied here rather than inside home-model.js (which the contract
  // forbids touching beyond the `export` keyword).
  const validTrackable = trackable && typeof trackable === 'object' ? trackable : null;

  const identityColor =
    validTrackable && typeof validTrackable.color === 'string' && validTrackable.color !== ''
      ? validTrackable.color
      : null;

  const shape =
    validTrackable && validTrackable.value_shape === 'boolean'
      ? 'boolean'
      : validTrackable && validTrackable.value_shape === 'numeric'
      ? 'numeric'
      : 'unknown';

  const fromWellFormed = typeof from === 'string' && DATE_STR_RE.test(from) ? from : null;

  let loggedDayCount = 0;

  const cells = grid.map((gridCell) => {
    const { date, inMonth } = gridCell;
    const cellYear = date.slice(0, 4);
    const cellMonthNum = Number(date.slice(5, 7));
    const day = Number(date.slice(8, 10));
    const base = `${day} ${MONTH_NAMES[cellMonthNum - 1]} ${cellYear}`;

    // §2.8 rule 2 — state precedence. A day outside the loaded window
    // ('before') or in the future never gets a verdict: with
    // direction: 'break', an unlogged day reads good, so a day we simply
    // have no data for must never be painted "clean". See CONTRACT-3.1.md
    // §2.8 rule 2's comment for the full reasoning.
    let state;
    if (!inMonth) {
      state = 'outside';
    } else if (date > today) {
      state = 'future';
    } else if (fromWellFormed !== null && date < fromWellFormed) {
      state = 'before';
    } else {
      state = 'day';
    }

    if (state !== 'day') {
      // §2.8 rule 3 — force every non-'day' cell to neutral/empty. Do not
      // look up an entry for these cells at all, even if one exists.
      let label = '';
      if (state === 'future') label = `${base} — future`;
      else if (state === 'before') label = `${base} — no data`;
      return {
        date,
        day,
        inMonth,
        state,
        hasEntry: false,
        value: null,
        verdict: 'neutral',
        alpha: 0,
        label,
        tappable: false,
      };
    }

    const entry = list.find((e) => e && typeof e === 'object' && e.entry_date === date) || null;
    const hasEntry = validTrackable ? hasEntryValue(validTrackable, entry) : false;
    const value = entry && typeof entry.value === 'number' && Number.isFinite(entry.value) ? entry.value : null;
    // §0(a): verdict() is the single implementation of good/bad — call it
    // directly, do not reimplement it here.
    const cellVerdict = verdict(trackable, entry);

    let alphaRaw;
    if (!hasEntry) {
      alphaRaw = 0;
    } else if (shape === 'boolean') {
      alphaRaw = 1;
    } else if (rangeMax > 0 && Number.isFinite(rangeMax)) {
      alphaRaw = MIN_ALPHA + (1 - MIN_ALPHA) * Math.min(1, Math.abs(value) / rangeMax);
    } else {
      // Degenerate guard, same class as aggregate.js's normalizeSeries
      // min === max case: with no spread to normalize against, a logged
      // day is simply fully opaque.
      alphaRaw = 1;
    }
    const alpha = Math.round(alphaRaw * 1000) / 1000;

    if (hasEntry) loggedDayCount += 1;

    let label;
    if (shape === 'boolean') {
      label = `${base} — ${statusWord(trackable, entry)}`;
    } else if (hasEntry) {
      label = `${base} — ${formatValue(trackable, value)}`;
      const word = statusWord(trackable, entry);
      if (typeof word === 'string' && word !== '') label += `, ${word}`;
    } else {
      label = `${base} — not logged`;
    }

    return {
      date,
      day,
      inMonth,
      state,
      hasEntry,
      value,
      verdict: cellVerdict,
      alpha,
      label,
      tappable: true,
    };
  });

  return {
    month: clampedMonth,
    monthLabel: monthLbl,
    canPrev,
    canNext,
    weekdayLabels: WEEKDAY_LABELS,
    identityColor,
    shape,
    rangeMax,
    loggedDayCount,
    cells,
  };
}

// =============================================================================
// DOM — the one export in this file that touches `document`.
// =============================================================================

// A pure serializer of heatmapModel()'s output. Attaches NO event
// listeners (js/views/detail.js owns the single delegated listener on its
// section root), holds no state, reads no clock, issues no requests.
// Called fresh on every detail.js render(). No innerHTML anywhere in this
// function — built with createElement/textContent/setAttribute only.
export function renderHeatmap(model) {
  const root = document.createElement('div');
  root.className = 'heatmap';
  root.dataset.month = model.month;
  if (model.identityColor !== null) {
    root.style.setProperty('--hm-identity', model.identityColor);
  }

  const head = document.createElement('div');
  head.className = 'hm-head';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'hm-nav';
  prevBtn.dataset.heatmapNav = 'prev';
  prevBtn.setAttribute('aria-label', 'Previous month');
  prevBtn.disabled = !model.canPrev;
  prevBtn.textContent = '‹'; // ‹
  head.appendChild(prevBtn);

  const monthSpan = document.createElement('span');
  monthSpan.className = 'hm-month';
  monthSpan.textContent = model.monthLabel;
  head.appendChild(monthSpan);

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'hm-nav';
  nextBtn.dataset.heatmapNav = 'next';
  nextBtn.setAttribute('aria-label', 'Next month');
  nextBtn.disabled = !model.canNext;
  nextBtn.textContent = '›'; // ›
  head.appendChild(nextBtn);

  root.appendChild(head);

  const weekdaysDiv = document.createElement('div');
  weekdaysDiv.className = 'hm-weekdays';
  weekdaysDiv.setAttribute('aria-hidden', 'true');
  for (const wLabel of model.weekdayLabels) {
    const span = document.createElement('span');
    span.className = 'hm-weekday';
    span.textContent = wLabel;
    weekdaysDiv.appendChild(span);
  }
  root.appendChild(weekdaysDiv);

  const gridDiv = document.createElement('div');
  gridDiv.className = 'hm-grid';

  for (const cell of model.cells) {
    const el = document.createElement(cell.tappable ? 'button' : 'div');
    el.className = 'hm-cell';
    el.dataset.cellState = cell.state;

    if (cell.tappable) {
      el.type = 'button';
      el.dataset.date = cell.date;
      el.dataset.verdict = cell.verdict;
      el.setAttribute('aria-label', cell.label);
    } else {
      el.setAttribute('aria-hidden', 'true');
    }
    el.dataset.logged = String(cell.hasEntry);
    el.style.setProperty('--hm-alpha', String(cell.alpha));

    const fill = document.createElement('span');
    fill.className = 'hm-fill';
    fill.setAttribute('aria-hidden', 'true');
    el.appendChild(fill);

    // §3 — padding cells from adjacent months must not read as days of
    // this month, so .hm-day is omitted for the 'outside' state only
    // (present for 'future'/'before'/'day', all of which are real days of
    // the displayed month).
    if (cell.state !== 'outside') {
      const dayEl = document.createElement('span');
      dayEl.className = 'hm-day';
      dayEl.textContent = String(cell.day);
      el.appendChild(dayEl);
    }

    gridDiv.appendChild(el);
  }

  root.appendChild(gridDiv);

  return root;
}
