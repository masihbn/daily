// Correlation overlay (Step 3.4, redesigned in Step 3.4b after the device
// check). CONTRACT-3.4b.md is a DELTA over CONTRACT-3.4.md — read both
// before touching this file; CONTRACT-3.4.md's §0 design decisions about
// candidates/selection storage still hold, only the marker shape changed.
//
// What changed and why (CONTRACT-3.4b.md §0): 3.4 drew a fixed-row marker
// meaning "at least one logged day in the bucket" — on the device that was
// a Workout triangle on every single week, true and useless. The
// redesign: the overlay is the OTHER trackable's own trend series (exactly
// what its Weekly-trend chart would show — same rollup, same target, same
// good/bad verdicts) drawn as bars on a second, visible y-axis, one
// overlay at a time. This makes the overlay answer "did Workout hit ITS
// OWN target this week", not "was there any Workout entry at all".
//
// Same split as js/charts/bounds.js/weekly.js: everything except
// renderOverlayPicker() runs with no DOM at all. Only renderOverlayPicker()
// touches `document`. This module issues ZERO network requests, ever.
//
// Allowed imports, and only these (CONTRACT-3.4b.md §1):
import { isoWeekKey } from '../dates.js';
import { rollup, fillSeries } from '../aggregate.js';
// §0(b)-style discipline (weekly.js's own words): rollup()/fillSeries() and
// weekly.js's own target/verdict/fill helpers are the SINGLE implementation
// of "what does this trackable's trend look like" — this module reuses
// them rather than encoding a second, parallel notion of a trend series.
import { seriesAggregationFor, fillValueFor, targetFor, weekVerdict } from './weekly.js';

// --- §1 constants ------------------------------------------------------

export const OVERLAY_STORAGE_KEY = 'daily.detail.overlay.v1';
// Step 3.4b §0 rule 1: one overlay at a time — two independent trend
// series sharing one right-hand axis read as noise, not correlation.
export const MAX_OVERLAYS = 1;
export const OVERLAY_BAR_ALPHA = 0.55;

const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object';
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// A regex-shape match ('YYYY-MM-DD') is not the same as a real calendar
// date ('2024-02-30' matches the shape but isn't a day that exists), and
// rollup()'s internal bucketKeyFor() throws on exactly that class of
// garbage via isoWeekKey (found in weekly.js/bounds.js already) — reusing
// isoWeekKey()'s own validation here rather than a second hand-rolled
// calendar checker is the same move both of those modules make.
function isRealDateStr(str) {
  if (typeof str !== 'string' || !DATE_STR_RE.test(str)) return false;
  try {
    isoWeekKey(str);
    return true;
  } catch {
    return false;
  }
}

// --- §1 isOverlayCandidate (unchanged from CONTRACT-3.4) -----------------

// Candidates are trackables whose logged days are discrete EVENTS: boolean
// rows, or numeric rows whose aggregation is 'count' or 'sum'.
// 'average'/'last' numerics (calories, weight) are continuous readings,
// not events — Step 3.5's comparison chart is for those, never this one.
// Never throws.
export function isOverlayCandidate(trackable) {
  if (!isPlainObject(trackable)) return false;
  if (trackable.archived === true) return false;
  if (trackable.value_shape === 'boolean') return true;
  if (trackable.value_shape === 'numeric') {
    return trackable.aggregation === 'count' || trackable.aggregation === 'sum';
  }
  return false;
}

// --- §1 overlayCandidates (unchanged) -------------------------------

// Filters `trackables` to overlay candidates, excluding the metric itself
// (compared as strings, since ids may be numbers on the wire and strings
// once round-tripped through localStorage). Input order is preserved.
// Never throws.
export function overlayCandidates(trackables, metricId) {
  if (!Array.isArray(trackables)) return [];
  const metricIdStr = String(metricId);
  return trackables.filter(
    (t) => isOverlayCandidate(t) && String(t.id) !== metricIdStr
  );
}

// --- §1 readOverlaySelection / writeOverlaySelection (unchanged) ---------

// Reads the raw { [metricId]: string[] } blob out of `storage`, tolerating
// every way it can be missing or malformed. Never throws, regardless of
// what `storage` is or does.
function readRawSelectionMap(storage) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(OVERLAY_STORAGE_KEY);
    if (typeof raw !== 'string') return {};
    const parsed = JSON.parse(raw);
    // A top-level array (or any non-plain-object) is not the documented
    // shape — treat it exactly like a missing key rather than guessing at
    // what it might mean.
    if (!isPlainObject(parsed) || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

// `storage` is any object with getItem(key)/setItem(key, value), or
// null/undefined — same injectable-storage shape as js/store.js. Never
// throws.
export function readOverlaySelection(storage, metricId) {
  const map = readRawSelectionMap(storage);
  const value = map[String(metricId)];
  if (!Array.isArray(value)) return [];
  return value.map(String);
}

// Merges { [String(metricId)]: ids.map(String) } into whatever else is
// already stored, so writing one metric's selection never clobbers
// another's. An unreadable existing value is treated as {}
// (readRawSelectionMap already does this). Storage errors — including
// setItem throwing, e.g. iOS private mode — are swallowed. Never throws.
export function writeOverlaySelection(storage, metricId, ids) {
  if (!storage) return;
  try {
    const existing = readRawSelectionMap(storage);
    const merged = {
      ...existing,
      [String(metricId)]: (Array.isArray(ids) ? ids : []).map(String),
    };
    storage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Best-effort only — an unwritable store just means the selection
    // won't persist, which is not fatal (same rule as detail.js's own
    // writeStoredRange/writeStoredPeriod).
  }
}

// --- §1 sanitizeSelection (unchanged code; cap is now MAX_OVERLAYS = 1) --

// Coerces to strings, drops ids that are not current candidates, dedupes
// (first occurrence wins), and caps at MAX_OVERLAYS (now 1 — Step 3.4b §0
// rule 1) — all while KEEPING SELECTION ORDER (not candidate order).
// Never throws.
export function sanitizeSelection(ids, candidates) {
  if (!Array.isArray(ids)) return [];
  const candidateList = Array.isArray(candidates) ? candidates : [];
  const candidateIds = new Set(
    candidateList.filter(isPlainObject).map((c) => String(c.id))
  );

  const seen = new Set();
  const out = [];
  for (const raw of ids) {
    const s = String(raw);
    if (!candidateIds.has(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_OVERLAYS) break;
  }
  return out;
}

// --- §1 overlayModel (Step 3.4b — replaces the 3.4 shape entirely) -------

// The per-overlay model, aligned to the METRIC's own bucket keys
// (boundsModel().dates) — this is exactly js/charts/weekly.js#trendModel,
// except it never invents its own keys: the caller (the Range chart) owns
// the x-axis, and bar k must sit under the metric's point k even on the
// 'All' range where the two trackables' histories start on different
// dates. Never throws.
export function overlayModel({ trackable, entries, keys, period } = {}) {
  const id = isPlainObject(trackable) ? String(trackable.id) : '';
  const name =
    isPlainObject(trackable) && typeof trackable.name === 'string' && trackable.name !== ''
      ? trackable.name
      : '';
  const color =
    isPlainObject(trackable) && typeof trackable.color === 'string' && trackable.color !== ''
      ? trackable.color
      : null;
  const unit =
    isPlainObject(trackable) && typeof trackable.unit === 'string' && trackable.unit !== ''
      ? trackable.unit
      : null;
  const aggregation = seriesAggregationFor(trackable);
  const direction = isPlainObject(trackable) && trackable.direction === 'break' ? 'break' : 'build';

  const per = period === 'week' || period === 'month' ? period : 'day';
  const keyList = Array.isArray(keys) ? keys : [];

  // Filter to plain objects with a REAL calendar entry_date and a finite
  // numeric value, then dedupe by entry_date FIRST WINS — exactly
  // js/charts/bounds.js#boundsSeries's own rule, restated here rather than
  // imported because bounds.js's dedupe is private to that module's
  // 'average' rollup and this module answers a different question (was
  // there a value at all, for any aggregation).
  const list = Array.isArray(entries) ? entries : [];
  const byDate = new Map();
  for (const e of list) {
    if (!isPlainObject(e)) continue;
    if (!isRealDateStr(e.entry_date)) continue;
    if (!isFiniteNumber(e.value)) continue;
    if (!byDate.has(e.entry_date)) byDate.set(e.entry_date, e);
  }
  const deduped = [...byDate.values()];

  // seriesAggregationFor() only ever returns one of rollup's four legal
  // aggregations, and `per` is always one of rollup's three legal periods
  // — so rollup()'s own validation throws are unreachable from here, same
  // reasoning as weekly.js#trendModel's comment on this exact call.
  const buckets = rollup(deduped, per, aggregation);
  const filled = fillSeries(buckets, keyList, fillValueFor(aggregation));

  const target = targetFor(trackable, per);

  const values = filled.map((f) => f.value);
  const verdicts = values.map((v) => weekVerdict(v, target, direction));
  const total = values.reduce((sum, v) => sum + (isFiniteNumber(v) ? v : 0), 0);

  return { id, name, color, unit, aggregation, direction, values, verdicts, target, total };
}

// --- §1 withAlpha --------------------------------------------------------

const HEX_SHORT_RE = /^#([0-9a-fA-F]{3})$/;
const HEX_LONG_RE = /^#([0-9a-fA-F]{6})$/;

// '#rgb'/'#rrggbb' -> 'rgba(r, g, b, alpha)'; any other string (e.g.
// 'rgb(1,2,3)', a CSS variable) is returned unchanged, since this module
// has no way to parse arbitrary CSS colour syntax; non-string -> black at
// the given alpha, a safe visible fallback. Never throws.
export function withAlpha(color, alpha) {
  if (typeof color !== 'string') return `rgba(0, 0, 0, ${alpha})`;

  const shortMatch = HEX_SHORT_RE.exec(color);
  if (shortMatch) {
    const [r, g, b] = shortMatch[1].split('').map((c) => parseInt(c + c, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const longMatch = HEX_LONG_RE.exec(color);
  if (longMatch) {
    const hex = longMatch[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  return color;
}

// --- §1 overlayAxisFor -----------------------------------------------

// The right-hand axis window. Always framed from 0 (these are counts/
// sums, never a level like weight — see weekly.js#axisBoundsFor's
// beginAtZero rule for 'sum'/'count'), and padded 15% above the larger of
// the data or the target line, so neither sits on the axis border. Rounds
// UP (never inward, which could clip the very point the padding protects)
// — to a whole number for a 'count' series or an all-integer series, else
// to one decimal. Never throws.
export function overlayAxisFor(model) {
  const values = isPlainObject(model) && Array.isArray(model.values) ? model.values : [];
  const finite = values.filter(isFiniteNumber);

  const target = isPlainObject(model) ? model.target : null;
  const hasTarget = isPlainObject(target) && isFiniteNumber(target.value);

  const candidates = finite.slice();
  if (hasTarget) candidates.push(target.value);
  candidates.push(1); // floor: a lone `1` still gets a visible window
  const rawMax = Math.max(...candidates) * 1.15;

  // Vacuously true when `finite` is empty — matches the "no data, no
  // target" case rounding to a whole number too (there is nothing
  // fractional to preserve).
  const allInts = finite.every(Number.isInteger) && (!hasTarget || Number.isInteger(target.value));
  const aggregation = isPlainObject(model) ? model.aggregation : undefined;

  const suggestedMax =
    aggregation === 'count' || allInts ? Math.ceil(rawMax) : Math.ceil(rawMax * 10) / 10;

  return { min: 0, suggestedMax };
}

// --- §1 overlayAxisTitle -------------------------------------------------

// The right axis needs its own title (§0 rule 5) — without one, a bar
// chart of "3" on an unlabelled axis answers nothing. `unit` wins when the
// trackable has one (e.g. 'cigarettes'); a bare count trackable with no
// unit reads as 'days' (it's a days-logged count); anything else has no
// natural noun and falls back to 'per <period>'. Never throws.
export function overlayAxisTitle(model, period) {
  const unit = isPlainObject(model) && typeof model.unit === 'string' && model.unit !== '' ? model.unit : null;
  const aggregation = isPlainObject(model) ? model.aggregation : undefined;
  const base = unit !== null ? unit : aggregation === 'count' ? 'days' : '';

  if (period !== 'week' && period !== 'month') return base;
  if (base === '') return `per ${period}`;
  return `${base} / ${period}`;
}

// --- §1 overlayTooltipLabel (Step 3.4b — new shape, no `period` arg) -----

// Tooltip line for bucket `index`. Carries the target when there is one
// ('4 of 3') so the tooltip alone answers "did this bucket hit its own
// target" without cross-referencing the dashed line. Never throws.
export function overlayTooltipLabel(model, index) {
  const name = isPlainObject(model) && typeof model.name === 'string' ? model.name : '';
  const values = isPlainObject(model) && Array.isArray(model.values) ? model.values : null;

  if (values === null || !Number.isInteger(index) || index < 0 || index >= values.length) {
    return `${name} · —`;
  }

  const value = values[index];
  if (!isFiniteNumber(value)) return `${name} · —`;

  const target = isPlainObject(model) ? model.target : null;
  if (!isPlainObject(target) || !isFiniteNumber(target.value)) return `${name} · ${value}`;

  const t = Math.round(target.value * 10) / 10;
  return `${name} · ${value} of ${t}`;
}

// --- §1 overlayTargetAnnotation ------------------------------------------

// The overlay's own target, drawn as a dashed line ON THE RIGHT AXIS
// (scaleID: 'yOverlay') — a target line with no scaleID would default to
// the chart's first/left y-axis and land at the wrong height entirely,
// since the two axes have unrelated ranges. null when there is no target
// (targetFor() already returns null for 'day' and untargeted trackables).
// Never throws.
export function overlayTargetAnnotation(model, fallbackColor) {
  const target = isPlainObject(model) ? model.target : null;
  if (!isPlainObject(target) || !isFiniteNumber(target.value)) return null;

  const name = isPlainObject(model) && typeof model.name === 'string' ? model.name : '';
  const color = (isPlainObject(model) && model.color) || fallbackColor;
  const t = Math.round(target.value * 10) / 10;

  return {
    type: 'line',
    scaleID: 'yOverlay',
    value: target.value,
    borderColor: color,
    borderWidth: 1,
    borderDash: [4, 4],
    label: {
      display: true,
      content: `${name} ${t}`,
      position: 'end',
      backgroundColor: color,
    },
  };
}

// --- §1 overlayDatasets (Step 3.4b — bars, not rug markers) --------------

// PURE Chart.js bar dataset configs, one per model. Per-bucket colour by
// verdict (good/bad/neutral), semi-transparent fill so the bars read as a
// secondary series without competing with the metric's own line —
// `order: 2` keeps the bars drawn behind/after the line in Chart.js's
// default draw order. `colors` is `{ good, bad, fallback }` — plain
// strings, resolved by the caller (js/charts/bounds.js) from CSS custom
// properties, since this module never touches `document`. Non-array
// `models` -> []. Never throws.
export function overlayDatasets(models, colors) {
  const list = Array.isArray(models) ? models : [];
  const palette = isPlainObject(colors) ? colors : {};
  const good = typeof palette.good === 'string' ? palette.good : '#34c759';
  const bad = typeof palette.bad === 'string' ? palette.bad : '#ff6b6b';
  const fallback = typeof palette.fallback === 'string' ? palette.fallback : '#3478f6';

  return list.map((model) => {
    const name = isPlainObject(model) && typeof model.name === 'string' ? model.name : '';
    const values = isPlainObject(model) && Array.isArray(model.values) ? model.values : [];
    const verdicts = isPlainObject(model) && Array.isArray(model.verdicts) ? model.verdicts : [];
    const modelColor = (isPlainObject(model) && model.color) || fallback;

    const solidColors = verdicts.map((v) => (v === 'good' ? good : v === 'bad' ? bad : modelColor));

    return {
      type: 'bar',
      label: name,
      yAxisID: 'yOverlay',
      data: values,
      backgroundColor: solidColors.map((c) => withAlpha(c, OVERLAY_BAR_ALPHA)),
      borderColor: solidColors,
      borderWidth: 1,
      barPercentage: 0.7,
      categoryPercentage: 0.8,
      order: 2,
    };
  });
}

// =============================================================================
// DOM — the only export in this file that touches `document`.
// =============================================================================

// The 'overlay' chart slot's content: NOT a chart, but the picker that
// picks the ONE trackable drawn on the Range chart's right axis (§0 rule
// 1). Builds with createElement/textContent only — no innerHTML, no
// listeners (js/views/detail.js owns the single delegated click listener
// that reads button.overlay-chip[data-overlay-id]).
export function renderOverlayPicker({ candidates, selected, disabled } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const selectedIds = Array.isArray(selected) ? selected.map(String) : [];

  const root = document.createElement('div');
  root.className = 'overlay-picker';

  const hint = document.createElement('p');
  hint.className = 'overlay-hint';
  if (list.length === 0) {
    hint.textContent = 'Nothing to overlay yet — add a yes/no or count trackable.';
  } else if (selectedIds.length === 0) {
    hint.textContent = 'Pick one to draw it on the Range chart above, on its own axis.';
  } else {
    hint.textContent = 'Drawn on the Range chart above, right axis. Tap another to swap.';
  }
  root.appendChild(hint);

  // No candidates -> the chips group is omitted entirely, not just
  // rendered empty — there is nothing to group.
  if (list.length === 0) return root;

  const chips = document.createElement('div');
  chips.className = 'overlay-chips';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Overlay trackables');

  for (const candidate of list) {
    const cid = isPlainObject(candidate) ? String(candidate.id) : '';
    const isSelected = selectedIds.includes(cid);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'overlay-chip';
    btn.dataset.overlayId = cid;
    btn.setAttribute('aria-pressed', String(isSelected));
    btn.textContent =
      isPlainObject(candidate) && typeof candidate.name === 'string' ? candidate.name : '';

    const color =
      isPlainObject(candidate) && typeof candidate.color === 'string' && candidate.color !== ''
        ? candidate.color
        : null;
    if (color) btn.style.setProperty('--chip-color', color);

    // Step 3.4b §1: no cap-disable — tapping another chip while one is
    // already selected REPLACES it (js/views/detail.js#handleOverlayToggle),
    // it never needs to be blocked. Disabled only while the caller says a
    // load is in flight.
    btn.disabled = disabled === true;

    chips.appendChild(btn);
  }

  root.appendChild(chips);
  return root;
}
