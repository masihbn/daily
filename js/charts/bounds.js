// Two-bars threshold chart (Step 3.3). PURE-ish module, same split as
// js/charts/weekly.js: everything except renderBounds()/destroyBounds()
// runs with no DOM at all — no `fetch`, no `localStorage`, no `store.js`,
// no `api.js`. Only those two exports touch `document`/`window`. This
// module issues ZERO network requests, ever — entries arrive as a plain
// array argument from the caller (js/views/detail.js), which already
// loaded them through the store.
//
// See docs/APP_CONCEPT.md → "Motivating example: the two bars mechanic"
// and "Bounded metrics" for WHY this chart exists before touching the
// "what it draws" below: a metric like body weight oscillates between two
// subconscious thresholds, drifting toward one when it nears the other.
// Zone shading (§3.1) is the whole point — the reader should see where in
// the band today sits at a glance, without reading axis numbers. This is
// not "a line chart with two extra lines."
//
// Allowed imports, and only these (CONTRACT-3.3.md §2, widened after this
// step's implementer report to include addDays — see addDays' own call
// site in countReadingsInWindow() below for why: day arithmetic has
// exactly one implementation in this codebase, imported everywhere else
// rather than copied, and this module's earlier draft broke that rule
// with a local reimplementation before the import list was widened to
// close the gap):
import { deriveBounds } from '../aggregate.js';
import { rangeDays, addDays } from '../dates.js';

// --- §2.1 constants ------------------------------------------------------

// app_settings.rolling_window_days is the REAL source (live value: 90).
// Reading it here would mean a second network round trip on this screen
// and touching every existing e2e fixture, and nothing can change it
// until the settings screen ships in Step 4.1 — so this step uses the
// constant, and Step 4.1 must replace every caller of it with the real
// setting.
export const DEFAULT_ROLLING_WINDOW_DAYS = 90;

// The cold-start guard: fewer data points than the rolling window means
// auto-bounds are meaningless noise. 12 is not arbitrary — deriveBounds()
// uses R-7 percentiles, where the p10 index is 0.1 * (n - 1). That only
// clears the single lowest reading (p10 stops being pinned to the
// minimum) once 0.1 * (n - 1) >= 1, i.e. n >= 11; 12 is the next round
// number above that. See CONTRACT-3.3.md §2.1 for the measured table
// (n=11 is where an outlier at 50 among readings at 80+ stops
// contaminating p10) that confirms this arithmetic prediction.
export const MIN_BOUND_READINGS = 12;

// §2.4 — one logging cycle: long enough that a twice-a-week metric
// survives a normal week without shattering into isolated dots, short
// enough that a genuine multi-week lapse still reads as a break.
export const MAX_BRIDGE_DAYS = 7;

// --- shared local helpers -------------------------------------------------

function isFiniteValue(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Floors to a safe positive integer (falling back to the default for
// anything else, including a fractional or non-finite input). The floor
// is required, not cosmetic: addDays() below throws on a non-integer `n`
// (Number.isSafeInteger), and this value flows into `-(windowDays - 1)` —
// so a fractional windowDays must never reach it un-floored, or
// countReadingsInWindow() would throw where it used to (silently, if
// imprecisely) tolerate one.
function sanitizeWindowDays(windowDays) {
  if (!isFiniteValue(windowDays)) return DEFAULT_ROLLING_WINDOW_DAYS;
  const floored = Math.floor(windowDays);
  return floored > 0 ? floored : DEFAULT_ROLLING_WINDOW_DAYS;
}

const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;

// A regex-shape match ('YYYY-MM-DD') is not the same as a real calendar
// date ('2026-02-30' matches the shape but isn't a day that exists).
// rangeDays(str, str) is the one date-arithmetic function this module may
// import (§2), and it already throws on exactly this class of garbage
// (via dates.js#parseLocal, transitively) — reusing it here rather than
// hand-rolling a second calendar validator is the same move
// js/charts/weekly.js makes with isoWeekKey() in its own isRealDateStr().
function isRealDateStr(str) {
  if (typeof str !== 'string' || !DATE_STR_RE.test(str)) return false;
  try {
    rangeDays(str, str);
    return true;
  } catch {
    return false;
  }
}

// Exactly weekly.js#targetFor's coercion rule (CONTRACT-3.3.md §2.2 rule
// 2 requires it verbatim): reject null/undefined/'' and anything that
// isn't a plain number or string BEFORE calling Number(). Number([]) === 0
// and Number(true) === 1 are both finite and would otherwise silently
// accept a bound value that was never meant to be numeric.
function coerceFinite(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function unitOf(trackable) {
  return trackable && typeof trackable === 'object' && typeof trackable.unit === 'string' && trackable.unit !== ''
    ? trackable.unit
    : null;
}

function identityColorOf(trackable) {
  return trackable && typeof trackable === 'object' && typeof trackable.color === 'string' && trackable.color !== ''
    ? trackable.color
    : null;
}

// Hardcoded English month abbreviations — deliberately NOT toLocaleString/
// Intl, which varies by host ICU build and would make the suite non-
// deterministic (same reasoning as heatmap.js/weekly.js's MONTH_ABBR).
const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function dayLabel(dateStr) {
  const day = Number(dateStr.slice(8, 10));
  const month = Number(dateStr.slice(5, 7));
  return `${day} ${MONTH_ABBR[month - 1]}`;
}

// §2.2 rule 3's readingCount, computed to always agree with deriveBounds'
// own default `asOf` resolution (latest entry_date PRESENT, string-shaped
// only — matching aggregate.js#deriveBounds exactly, "which keeps it
// pure" per CONTRACT-3.3.md §2.2). If that max-date string isn't a REAL
// calendar date, this returns 0 (not merely `undefined`/throwing) — which
// keeps boundsFor() below the MIN_BOUND_READINGS threshold and so never
// reaches the deriveBounds() call that would otherwise try (and fail) to
// do date arithmetic on that same garbage string.
function countReadingsInWindow(entries, windowDays) {
  const list = Array.isArray(entries) ? entries : [];
  const dated = list.filter((e) => e && typeof e === 'object' && typeof e.entry_date === 'string');
  if (dated.length === 0) return 0;
  const asOf = dated.reduce((max, e) => (e.entry_date > max ? e.entry_date : max), dated[0].entry_date);
  if (!isRealDateStr(asOf)) return 0;
  // `windowDays` arrives here already floored to a safe positive integer
  // by sanitizeWindowDays() (every call site below routes through it), so
  // `-(windowDays - 1)` is always a safe integer too — addDays()'s own
  // precondition.
  const windowStart = addDays(asOf, -(windowDays - 1));
  let count = 0;
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    if (!isRealDateStr(e.entry_date)) continue;
    if (e.entry_date < windowStart || e.entry_date > asOf) continue;
    if (isFiniteValue(e.value)) count++;
  }
  return count;
}

// --- §2.2 boundsFor --------------------------------------------------------

// Never throws for any input. Resolves which bounds to draw (or whether
// they can be drawn at all) per CONTRACT-3.3.md §2.2's ordered rules.
export function boundsFor(trackable, entries, windowDays = DEFAULT_ROLLING_WINDOW_DAYS) {
  const wd = sanitizeWindowDays(windowDays);
  const list = Array.isArray(entries) ? entries : [];

  // Rule 1 — disabled. Boolean trackables can never reach this slot in
  // practice (detail.js's visibleSlots already suppresses it), but this
  // function is total anyway.
  if (!trackable || typeof trackable !== 'object' || trackable.value_shape !== 'numeric' || trackable.bounds_enabled !== true) {
    return { status: 'disabled', mode: null, lower: null, upper: null, readingCount: 0, windowDays: wd };
  }

  const readingCount = countReadingsInWindow(list, wd);

  // Rule 2 — manual. A manual mode with missing or reversed bounds is a
  // config problem the user can fix, and must say so (status: 'invalid')
  // rather than silently falling back to auto.
  if (trackable.bounds_mode === 'manual') {
    const lower = coerceFinite(trackable.bound_lower);
    const upper = coerceFinite(trackable.bound_upper);
    if (lower !== null && upper !== null && lower <= upper) {
      return { status: 'ok', mode: 'manual', lower, upper, readingCount, windowDays: wd };
    }
    return { status: 'invalid', mode: 'manual', lower: null, upper: null, readingCount, windowDays: wd };
  }

  // Rule 3 — auto (also the default for a missing/unrecognized column).
  if (readingCount < MIN_BOUND_READINGS) {
    return { status: 'insufficient', mode: 'auto', lower: null, upper: null, readingCount, windowDays: wd };
  }

  let derived;
  try {
    // Defensive only: boundsFor's own contract is "never throws for any
    // input", but deriveBounds() (untouched — see this step's boundaries)
    // computes its own window start via dates.js#addDays on the max
    // entry_date STRING it finds among all of `list` (filtered only by
    // `typeof === 'string'`, not real-calendar-date validity — see
    // aggregate.js#deriveBounds). countReadingsInWindow() above already
    // re-validates that same max-date string as a REAL date before
    // readingCount can reach MIN_BOUND_READINGS, so this branch should be
    // unreachable in practice; the try/catch is cheap insurance against
    // that invariant ever drifting.
    derived = deriveBounds(list, wd);
  } catch {
    derived = { lower: null, upper: null };
  }
  if (!isFiniteValue(derived.lower) || !isFiniteValue(derived.upper)) {
    return { status: 'insufficient', mode: 'auto', lower: null, upper: null, readingCount, windowDays: wd };
  }
  return { status: 'ok', mode: 'auto', lower: derived.lower, upper: derived.upper, readingCount, windowDays: wd };
}

// --- §2.3 zoneFor ----------------------------------------------------------

// Both edges inclusive — a value exactly on a bound is 'in', matching
// home-model.js's verdict() and Step 2.4's convention (and §0's explicit
// "bounds are symmetric" decision: direction is NOT applied here). Never
// throws.
export function zoneFor(value, bounds) {
  if (!isFiniteValue(value)) return 'unknown';
  if (!bounds || typeof bounds !== 'object' || bounds.status !== 'ok') return 'unknown';
  if (!isFiniteValue(bounds.lower) || !isFiniteValue(bounds.upper)) return 'unknown';
  if (value < bounds.lower) return 'below';
  if (value > bounds.upper) return 'above';
  return 'in';
}

// --- §2.4 shouldBridge -------------------------------------------------

// `gapDays` is the count of MISSING days between two real readings (not
// an index distance) — 0 means "not a gap" (the readings are on adjacent
// days; there is nothing to bridge, the segment is just always drawn).
// Never throws.
export function shouldBridge(gapDays, maxBridgeDays = MAX_BRIDGE_DAYS) {
  if (!isFiniteValue(gapDays)) return false;
  const max = isFiniteValue(maxBridgeDays) ? maxBridgeDays : MAX_BRIDGE_DAYS;
  return gapDays > 0 && gapDays <= max;
}

// --- §2.5 boundsModel ------------------------------------------------------

function emptyModel(trackable, bounds) {
  return {
    status: 'empty',
    bounds,
    labels: [],
    dates: [],
    values: [],
    zones: [],
    unit: unitOf(trackable),
    identityColor: identityColorOf(trackable),
    pointCount: 0,
    todayZone: 'unknown',
  };
}

// Never throws except on a malformed `to`. Raw daily values, never
// rollup() (§0) — a bounded metric wants the actual trend, not a sum.
export function boundsModel({ trackable, entries, from, to, windowDays = DEFAULT_ROLLING_WINDOW_DAYS } = {}) {
  // Must throw unconditionally for a malformed `to`, including on an
  // early-return path below — validated first, exactly as
  // weekly.js#trendModel pre-validates `to` with isoWeekKey(to) before any
  // other logic runs. rangeDays(to, to) reuses this module's one allowed
  // date-arithmetic import rather than a second hand-rolled check.
  rangeDays(to, to);

  const wd = sanitizeWindowDays(windowDays);
  const list = Array.isArray(entries) ? entries : [];
  const bounds = boundsFor(trackable, list, wd);
  const dateValidEntries = list.filter((e) => e && typeof e === 'object' && isRealDateStr(e.entry_date));

  let lowerBound;
  if (isRealDateStr(from)) {
    lowerBound = from;
  } else {
    let earliest = null;
    for (const e of dateValidEntries) {
      if (earliest === null || e.entry_date < earliest) earliest = e.entry_date;
    }
    if (earliest === null) return emptyModel(trackable, bounds);
    lowerBound = earliest;
  }

  // 'YYYY-MM-DD' strings compare lexicographically in chronological order
  // (both sides are proven real dates by this point) — same fact
  // trendModel() relies on.
  if (lowerBound > to) return emptyModel(trackable, bounds);

  const dates = rangeDays(lowerBound, to);
  const labels = dates.map(dayLabel);

  // One entry per trackable per day is guaranteed by the schema's unique
  // constraint; if duplicates appear anyway, first wins (§2.5).
  const byDate = new Map();
  for (const e of dateValidEntries) {
    if (!byDate.has(e.entry_date)) byDate.set(e.entry_date, e);
  }

  const values = [];
  const zones = [];
  let pointCount = 0;
  let lastFiniteValue = null;
  for (const d of dates) {
    const entry = byDate.get(d);
    const v = entry && isFiniteValue(entry.value) ? entry.value : null;
    values.push(v);
    zones.push(zoneFor(v, bounds));
    if (v !== null) {
      pointCount += 1;
      lastFiniteValue = v;
    }
  }

  return {
    // 'empty' already returned above for the only two cases that mean it;
    // otherwise this mirrors bounds.status exactly (§2.5 status
    // precedence).
    status: bounds.status,
    bounds,
    labels,
    dates,
    values,
    zones,
    unit: unitOf(trackable),
    identityColor: identityColorOf(trackable),
    pointCount,
    todayZone: lastFiniteValue === null ? 'unknown' : zoneFor(lastFiniteValue, bounds),
  };
}

// --- §3 y-axis: boundsAxisFor --------------------------------------------

// PURE — same shape as weekly.js#axisBoundsFor, but ALWAYS frames both
// bounds (never just the data), and NEVER opts into beginAtZero (§3: this
// is a level, not an accumulated amount — a zero-based axis is exactly
// the Weight bug Step 3.2c fixed. That fix was "use a line chart instead
// of a bar", which this chart already is; the remaining piece, framing
// both bound lines strictly inside the window so neither is drawn on the
// chart border, is what this function guarantees). Never throws.
export function boundsAxisFor(model) {
  const rawValues = model && Array.isArray(model.values) ? model.values : [];
  const finite = rawValues.filter(isFiniteValue);

  const bounds = model && typeof model === 'object' ? model.bounds : null;
  const lower = bounds && isFiniteValue(bounds.lower) ? bounds.lower : null;
  const upper = bounds && isFiniteValue(bounds.upper) ? bounds.upper : null;

  const candidates = finite.slice();
  if (lower !== null) candidates.push(lower);
  if (upper !== null) candidates.push(upper);

  if (candidates.length === 0) {
    return { suggestedMin: undefined, suggestedMax: undefined };
  }

  const lo = Math.min(...candidates);
  const hi = Math.max(...candidates);
  const span = hi - lo;
  // A flat/degenerate span (span 0 — e.g. bounds equal, or a single
  // reading exactly on a bound) has nothing to derive a window from; pad
  // by a fraction of the magnitude instead, floored at 1 so a bound of 0
  // still gets a visible window. `pad` is always > 0 either way, which is
  // what guarantees the strict inequality N10 checks: suggestedMin < lo
  // <= lower and suggestedMax > hi >= upper always hold.
  const pad = span > 0 ? span * 0.15 : Math.max(1, Math.abs(hi) * 0.1);

  return { suggestedMin: lo - pad, suggestedMax: hi + pad };
}

// =============================================================================
// DOM — the only exports in this file that touch `document`/`window`.
// =============================================================================

// §3.2 gap-bridging visibility table. PURE (no Chart.js, no DOM) even
// though it lives in this half of the file — it exists only to feed
// renderBounds()'s per-segment styling below. See renderBounds()'s own
// comment for what was actually measured on a live chart and why this
// precomputed-table approach replaced the contract's suggested
// `ctx.p1DataIndex - ctx.p0DataIndex` check.
//
// `values` is one slot per CALENDAR DAY (boundsModel's `dates`/`values`
// are built from rangeDays(), gap-free) — so index distance IS day
// distance, and the missing-day count between two real neighbours is
// exactly computable without any help from Chart.js. Returns an array of
// length values.length - 1; visible[i] describes the segment between
// index i and i+1: true if it should render, false if it falls inside a
// gap longer than MAX_BRIDGE_DAYS (or has no real value on one side to
// bridge to at all).
//
// Exported for testability: this is the function that ACTUALLY decides
// whether the line breaks — renderBounds()'s `segment.borderColor`
// callback just looks up its output by `ctx.p0DataIndex`. shouldBridge()
// is the per-gap predicate this function consults (once per run of
// missing days, via the `missingDays === 0 ? true : shouldBridge(...)`
// line below); shouldBridge() alone is not what the renderer draws from.
export function segmentVisibility(values) {
  const list = Array.isArray(values) ? values : [];
  const n = list.length;
  const visible = new Array(Math.max(0, n - 1)).fill(false);
  if (n < 2) return visible;

  // nextRealIndex[i] = smallest j >= i with a real value, or -1.
  const nextRealIndex = new Array(n).fill(-1);
  let nr = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (isFiniteValue(list[i])) nr = i;
    nextRealIndex[i] = nr;
  }

  let prevReal = -1; // largest j < i with a real value, tracked while scanning forward
  for (let i = 0; i < n - 1; i++) {
    if (isFiniteValue(list[i])) prevReal = i;
    const leftReal = isFiniteValue(list[i]) ? i : prevReal;
    const rightReal = isFiniteValue(list[i + 1]) ? i + 1 : nextRealIndex[i + 1];
    if (leftReal === -1 || rightReal === -1) continue; // nothing to bridge to
    const missingDays = rightReal - leftReal - 1;
    visible[i] = missingDays === 0 ? true : shouldBridge(missingDays);
  }
  return visible;
}

// Reads a CSS custom property off :root at render time (light/dark both
// work), with a hardcoded fallback — same as weekly.js#cssVar (duplicated
// rather than imported: §2's import list is deriveBounds/rangeDays only,
// and this function touches `document` anyway so it belongs in this half
// of the file regardless).
function cssVar(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name);
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
  } catch {
    return fallback;
  }
}

// See js/charts/weekly.js#annotationPluginAvailable for the full
// verification story (chartjs-plugin-annotation self-registers off
// window.Chart the moment its <script> tag runs — confirmed at
// implementation time by actually executing both pinned CDN files, not
// assumed from documentation). Duplicated locally rather than imported
// for the same reason as cssVar() above. Still checked here despite that
// self-registration: sw.js caches the two CDN scripts independently, so
// window.Chart can exist while the annotation plugin failed to load.
function annotationPluginAvailable() {
  try {
    return !!(
      window.Chart &&
      window.Chart.registry &&
      window.Chart.registry.plugins &&
      typeof window.Chart.registry.plugins.get === 'function' &&
      window.Chart.registry.plugins.get('annotation')
    );
  } catch {
    return false;
  }
}

function renderUnavailable(root) {
  const p = document.createElement('p');
  p.className = 'bounds-unavailable';
  p.textContent = 'Chart unavailable offline.';
  root.appendChild(p);
}

// The non-colour cue (WCAG 1.4.1) and the at-a-glance answer — see §3.
const ZONE_WORD = {
  in: 'In range',
  below: 'Below range',
  above: 'Above range',
  unknown: 'No reading yet',
};

function summaryText(model) {
  const status = model && typeof model === 'object' ? model.status : undefined;
  const bounds = model && typeof model === 'object' ? model.bounds : null;
  if (status === 'ok') {
    const zoneWord = ZONE_WORD[model.todayZone] || ZONE_WORD.unknown;
    const unit = typeof model.unit === 'string' && model.unit !== '' ? ` ${model.unit}` : '';
    const lower = bounds && isFiniteValue(bounds.lower) ? bounds.lower : '?';
    const upper = bounds && isFiniteValue(bounds.upper) ? bounds.upper : '?';
    return `${zoneWord} · ${lower}–${upper}${unit}`;
  }
  if (status === 'insufficient') {
    const count = bounds && typeof bounds.readingCount === 'number' ? bounds.readingCount : 0;
    return `Not enough data yet — ${count} of ${MIN_BOUND_READINGS} readings`;
  }
  if (status === 'invalid') return 'Bounds need a low and a high value.';
  if (status === 'disabled') return 'Bounds are off for this trackable.';
  if (status === 'empty') return 'Nothing logged yet.';
  return '';
}

// §3.3 — one module-scoped Chart.js instance, same lifecycle rule as
// weekly.js#chartInstance: renderBounds() always destroys any existing
// instance before creating a new one; destroyBounds() is also exported so
// detail.js can call it directly on unmount. A leaked Chart keeps
// responding to events on a detached canvas.
let chartInstance = null;

// Idempotent — safe to call when nothing exists, never throws.
export function destroyBounds() {
  if (chartInstance) {
    try {
      chartInstance.destroy();
    } catch {
      // A teardown call must never throw.
    }
    chartInstance = null;
  }
}

// §3 — the DOM export. Returns a container element; creates at most one
// Chart.js instance, tracked at module scope above. No innerHTML anywhere
// in this function — built with createElement/textContent/setAttribute
// only.
export function renderBounds(model) {
  destroyBounds();

  const root = document.createElement('div');
  root.className = 'bounds';

  const zone = model && typeof model === 'object' && typeof model.todayZone === 'string' ? model.todayZone : 'unknown';
  const summary = document.createElement('p');
  summary.className = 'bounds-summary';
  summary.dataset.zone = zone;
  summary.textContent = summaryText(model);
  root.appendChild(summary);

  const status = model && typeof model === 'object' ? model.status : undefined;
  // Every non-'ok' status renders only the summary above — no canvas, no
  // Chart instance (§3).
  if (status !== 'ok') return root;

  // The pinned CDN failed and the service worker had no cached copy — a
  // logging app must still show its data (the summary line above) when a
  // CDN is down, so this is a message, not a throw. Matches weekly.js's
  // identical guard.
  if (typeof window === 'undefined' || !window.Chart) {
    renderUnavailable(root);
    return root;
  }

  const wrap = document.createElement('div');
  wrap.className = 'bounds-canvas-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'bounds-canvas';
  wrap.appendChild(canvas);
  root.appendChild(wrap);

  const lineColor = model.identityColor || cssVar('--accent', '#3478f6');
  const goodColor = cssVar('--good', '#34c759');
  const badColor = cssVar('--bad', '#ff6b6b');
  // Per-point colour by zone; the LINE itself stays one colour throughout
  // (§3) — a line whose segments change colour is unreadable. Points with
  // no reading (null) get a colour too, but Chart.js never draws a point
  // marker for a null value, so it is inert.
  const pointColors = (Array.isArray(model.zones) ? model.zones : []).map((z) =>
    z === 'below' || z === 'above' ? badColor : z === 'in' ? goodColor : lineColor
  );

  // §3.2 — gap bridging. MEASURED on a live chart (chromium via
  // Playwright) against the pinned chart.js@4.5.1, category scale, not
  // assumed from the contract or from memory:
  //   1. `spanGaps` as a NUMBER (e.g. `spanGaps: MAX_BRIDGE_DAYS`) does
  //      NOT bridge anything on a category scale in this build — it
  //      behaves identically to `spanGaps: false` (0 bridged pixels in
  //      every probe, including a gap of exactly 1 missing day).
  //   2. The contract's suggested fallback also does not work as
  //      literally described: with `spanGaps: true`, the `segment` style
  //      callback fires once per PHYSICALLY ADJACENT data-index pair —
  //      `ctx.p1DataIndex - ctx.p0DataIndex` was measured to be exactly 1
  //      on every single call, including pairs that are both inside a
  //      long null run. It never reports "distance to the nearest real
  //      neighbour", so that difference cannot distinguish a 1-day gap
  //      from a 20-day one.
  //   3. What DOES work, also measured live: precompute the bridge/break
  //      decision ourselves (segmentVisibility(), pure, no Chart.js
  //      involved — see its own comment) and look it up in the `segment`
  //      callback by `ctx.p0DataIndex`, which IS confirmed to equal that
  //      segment's own left-hand data index on every call. Combined with
  //      `spanGaps: true` (so Chart.js positions points across nulls at
  //      all), this reproduces exactly the desired behaviour: a
  //      <=7-missing-day gap renders solid, a longer one renders fully
  //      transparent. Confirmed on an exact MAX_BRIDGE_DAYS-boundary case
  //      (7 missing days: bridged) and MAX_BRIDGE_DAYS+1 (8: broken).
  const visibility = segmentVisibility(model.values);
  const transparent = 'rgba(0, 0, 0, 0)';

  const dataset = {
    data: model.values,
    borderColor: lineColor,
    pointBackgroundColor: pointColors,
    pointBorderColor: pointColors,
    pointRadius: 3,
    borderWidth: 2,
    tension: 0,
    spanGaps: true,
    segment: {
      borderColor: (ctx) => (visibility[ctx.p0DataIndex] ? lineColor : transparent),
    },
  };

  const plugins = {
    legend: { display: false },
    tooltip: {
      callbacks: {
        // The tooltip title is the full 'YYYY-MM-DD' date, not the short
        // 'd MMM' axis label — same pattern as weekly.js's weekKeys title.
        title(items) {
          if (!items || items.length === 0) return '';
          return (Array.isArray(model.dates) && model.dates[items[0].dataIndex]) || '';
        },
      },
    },
  };

  // §3.1 — zone shading, the feature itself. Degrades to an unshaded line
  // chart (never throws) if the annotation plugin failed to load.
  if (annotationPluginAvailable()) {
    const mutedColor = cssVar('--fg-muted', '#9a9a9a');
    const belowBg = cssVar('--bad-bg', 'rgba(255, 107, 107, 0.18)');
    const inBg = cssVar('--good-bg', 'rgba(52, 199, 89, 0.18)');
    plugins.annotation = {
      annotations: {
        below: {
          type: 'box',
          yMax: model.bounds.lower,
          backgroundColor: belowBg,
          borderWidth: 0,
        },
        inBand: {
          type: 'box',
          yMin: model.bounds.lower,
          yMax: model.bounds.upper,
          backgroundColor: inBg,
          borderWidth: 0,
        },
        above: {
          type: 'box',
          yMin: model.bounds.upper,
          backgroundColor: belowBg,
          borderWidth: 0,
        },
        lowerBound: {
          type: 'line',
          yMin: model.bounds.lower,
          yMax: model.bounds.lower,
          borderColor: mutedColor,
          borderWidth: 1,
          borderDash: [6, 4],
          label: {
            display: true,
            content: String(model.bounds.lower),
            position: 'start',
            backgroundColor: mutedColor,
          },
        },
        upperBound: {
          type: 'line',
          yMin: model.bounds.upper,
          yMax: model.bounds.upper,
          borderColor: mutedColor,
          borderWidth: 1,
          borderDash: [6, 4],
          label: {
            display: true,
            content: String(model.bounds.upper),
            position: 'start',
            backgroundColor: mutedColor,
          },
        },
      },
    };
  }

  // §3 y-axis: boundsAxisFor() is the single source of the y-axis window
  // — never beginAtZero, both bounds framed strictly inside. See its own
  // comment for why.
  const axis = boundsAxisFor(model);
  const scales = {
    x: { type: 'category' },
    y: {
      suggestedMin: axis.suggestedMin,
      suggestedMax: axis.suggestedMax,
    },
  };

  try {
    chartInstance = new window.Chart(canvas, {
      type: 'line',
      data: {
        labels: model.labels,
        datasets: [dataset],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // Destroyed and recreated on every detail.js render (§3.3) rather
        // than updated in place, so animating every time would be visible
        // churn on a phone.
        animation: false,
        scales,
        plugins,
      },
    });
  } catch {
    // A construction failure must not break the whole detail screen —
    // degrade to the same offline-style message rather than throwing out
    // of render().
    wrap.remove();
    renderUnavailable(root);
  }

  return root;
}
