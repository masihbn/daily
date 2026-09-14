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

// --- §1 isOverlayCandidate (Step 3.4c — widened) --------------------------

// Step 3.4c §0 rule 1: EVERY non-archived trackable is now a candidate,
// event-shaped (boolean/count/sum -> drawn as bars, 3.4b's behaviour) or
// continuous (average/last, e.g. Weight -> drawn as a dashed line, new in
// 3.4c). overlayKindFor() below is what a caller uses to tell which kind a
// given candidate will render as. Never throws.
export function isOverlayCandidate(trackable) {
  if (!isPlainObject(trackable)) return false;
  if (trackable.archived === true) return false;
  return trackable.value_shape === 'boolean' || trackable.value_shape === 'numeric';
}

// --- §1 overlayKindFor (Step 3.4c) ----------------------------------------

// 'bar' — an accumulated count/amount per bucket (events): drawn from zero,
// judged against a target. 'line' — a continuous reading per bucket
// (Weight's weekly average): drawn as a level, judged against a band, not
// a target. Mirrors weekly.js#chartTypeFor's own bar-vs-line split, but
// named for what THIS module draws with each kind rather than reusing that
// name, since chartTypeFor answers a different question (what shape is the
// metric's OWN trend chart) than this one (what shape is the overlay).
// Garbage/unknown aggregation defaults to 'bar' — the 3.4b behaviour is
// the conservative default. Never throws.
export function overlayKindFor(aggregation) {
  return aggregation === 'average' || aggregation === 'last' ? 'line' : 'bar';
}

// --- §1 zoneOf (Step 3.4c) -------------------------------------------------

// Mirror of js/charts/bounds.js#zoneFor — NOT imported, deliberately:
// bounds.js imports overlayDatasets/overlayTooltipLabel/overlayAxisFor/
// overlayAxisTitle/overlayTargetAnnotation/overlayBoundAnnotations from
// THIS module, so an import the other way would create a cycle. The rule
// itself is six lines and unlikely to drift, but if bounds.js#zoneFor ever
// changes, this copy must change with it. Both edges inclusive — a value
// exactly on a bound is 'in', matching bounds.js's own convention. Never
// throws.
export function zoneOf(value, bounds) {
  if (!isFiniteNumber(value)) return 'unknown';
  if (!isPlainObject(bounds) || bounds.status !== 'ok') return 'unknown';
  if (!isFiniteNumber(bounds.lower) || !isFiniteNumber(bounds.upper)) return 'unknown';
  if (value < bounds.lower) return 'below';
  if (value > bounds.upper) return 'above';
  return 'in';
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

// --- §1 overlayModel (Step 3.4b shape; Step 3.4c adds bounds/kind/zones) -

// The per-overlay model, aligned to the METRIC's own bucket keys
// (boundsModel().dates) — this is exactly js/charts/weekly.js#trendModel,
// except it never invents its own keys: the caller (the Range chart) owns
// the x-axis, and bucket k must sit under the metric's point k even on the
// 'All' range where the two trackables' histories start on different
// dates. `bounds` (Step 3.4c) is a js/charts/bounds.js#boundsFor() result
// for THIS overlay trackable, computed by the caller over the same window
// — it is what a 'line'-kind overlay (a continuous reading, e.g. Weight)
// is judged against, since a continuous reading has no target, only a
// band. Never throws.
export function overlayModel({ trackable, entries, keys, period, bounds } = {}) {
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
  const kind = overlayKindFor(aggregation);
  const direction = isPlainObject(trackable) && trackable.direction === 'break' ? 'break' : 'build';
  const boundsArg = isPlainObject(bounds) ? bounds : null;

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
  // reasoning as weekly.js#trendModel's comment on this exact call. For
  // kind 'line' (aggregation 'average'/'last'), fillValueFor() already
  // fills an empty bucket with null, not 0 — a week you didn't weigh
  // yourself is a gap, not a zero reading (weekly.js#fillValueFor's own
  // reasoning, unchanged here).
  const buckets = rollup(deduped, per, aggregation);
  const filled = fillSeries(buckets, keyList, fillValueFor(aggregation));
  const values = filled.map((f) => f.value);

  // Step 3.4c §0 rule 2/3: 'bar' keeps 3.4b's target/verdict rule exactly.
  // 'line' has no target (a continuous reading is judged against a BAND,
  // not a single number) — its zones come from zoneOf() against `bounds`,
  // and its verdicts are derived from those zones (in -> good, below/above
  // -> bad, no band or no reading -> none), never from weekVerdict().
  let zones;
  let verdicts;
  let target;
  if (kind === 'line') {
    zones = values.map((v) => zoneOf(v, boundsArg));
    verdicts = zones.map((z) => (z === 'in' ? 'good' : z === 'below' || z === 'above' ? 'bad' : 'none'));
    target = null;
  } else {
    zones = values.map(() => 'unknown');
    target = targetFor(trackable, per);
    verdicts = values.map((v) => weekVerdict(v, target, direction));
  }

  const total = values.reduce((sum, v) => sum + (isFiniteNumber(v) ? v : 0), 0);

  return { id, name, color, unit, aggregation, direction, kind, values, zones, verdicts, target, bounds: boundsArg, total };
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

// --- §1 overlayAxisFor (Step 3.4c — branches by kind) ---------------------

// kind 'bar': exactly 3.4b — always framed from 0 (these are counts/sums,
// never a level), padded 15% above the larger of the data or the target
// line, rounded UP to a whole number for a 'count'/all-integer series,
// else to one decimal.
//
// kind 'line' (Step 3.4c): the user's own rule ("consider the highest and
// lowest values within the start and the end of the period, with some
// extra padding") — NEVER forced to zero (a weight axis starting at 0
// would flatten every real change to a sliver near the top, exactly
// weekly.js#axisBoundsFor's beginAtZero reasoning for 'average'/'last').
// The two bounds are folded into the frame when `bounds.status === 'ok'`,
// so a band line is never drawn on the axis border. A flat/single-point
// series pads by a flat 1 (not a percentage of a possibly-zero span).
// Never throws.
export function overlayAxisFor(model) {
  const kind = isPlainObject(model) ? model.kind : undefined;

  if (kind === 'line') {
    const values = isPlainObject(model) && Array.isArray(model.values) ? model.values : [];
    const finite = values.filter(isFiniteNumber);
    const bounds = isPlainObject(model) ? model.bounds : null;
    const boundsOk = isPlainObject(bounds) && bounds.status === 'ok';

    const candidates = finite.slice();
    if (boundsOk) {
      if (isFiniteNumber(bounds.lower)) candidates.push(bounds.lower);
      if (isFiniteNumber(bounds.upper)) candidates.push(bounds.upper);
    }

    if (candidates.length === 0) {
      return { suggestedMin: undefined, suggestedMax: undefined };
    }

    const lo = Math.min(...candidates);
    const hi = Math.max(...candidates);
    const span = hi - lo;
    const pad = span > 0 ? span * 0.1 : 1;
    return { suggestedMin: lo - pad, suggestedMax: hi + pad };
  }

  // kind 'bar' (or a garbage/missing model — the conservative default,
  // same reasoning as overlayKindFor()).
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

// --- §1 overlayAxisTitle (Step 3.4c — branches by kind) -------------------

// kind 'bar': exactly 3.4b. kind 'line': `unit` at every period — a weekly
// AVERAGE of kg is still kg, unlike a bar count which genuinely changes
// meaning per period ('days' vs 'days / week'). No unit -> the generic
// 'value', since a continuous reading with no unit has no natural noun the
// way a count trackable has 'days'. Never throws.
export function overlayAxisTitle(model, period) {
  const kind = isPlainObject(model) ? model.kind : undefined;
  const unit = isPlainObject(model) && typeof model.unit === 'string' && model.unit !== '' ? model.unit : null;

  if (kind === 'line') return unit || 'value';

  // kind 'bar' (or garbage) — exactly 3.4b.
  const aggregation = isPlainObject(model) ? model.aggregation : undefined;
  const base = unit !== null ? unit : aggregation === 'count' ? 'days' : '';
  if (period !== 'week' && period !== 'month') return base;
  if (base === '') return `per ${period}`;
  return `${base} / ${period}`;
}

// --- §1 overlayTooltipLabel (Step 3.4c — branches by kind) ----------------

// kind 'bar': exactly 3.4b (carries the target, '4 of 3', when there is
// one). kind 'line': carries the ROUNDED value and unit, plus the zone
// word (in range/below/above) when a band exists — the tooltip alone
// answers "was this reading in band" without cross-referencing the dashed
// bound lines. Never throws.
export function overlayTooltipLabel(model, index) {
  const name = isPlainObject(model) && typeof model.name === 'string' ? model.name : '';
  const kind = isPlainObject(model) ? model.kind : undefined;
  const values = isPlainObject(model) && Array.isArray(model.values) ? model.values : null;

  if (values === null || !Number.isInteger(index) || index < 0 || index >= values.length) {
    return `${name} · —`;
  }
  const value = values[index];
  if (!isFiniteNumber(value)) return `${name} · —`;

  if (kind === 'line') {
    const unit = isPlainObject(model) && typeof model.unit === 'string' && model.unit !== '' ? model.unit : null;
    const v = Math.round(value * 10) / 10;
    let out = `${name} · ${v}${unit ? ' ' + unit : ''}`;
    const zones = isPlainObject(model) && Array.isArray(model.zones) ? model.zones : [];
    const zone = zones[index];
    if (zone === 'in') out += ' · in range';
    else if (zone === 'below') out += ' · below';
    else if (zone === 'above') out += ' · above';
    return out;
  }

  // kind 'bar' (or garbage) — exactly 3.4b.
  const target = isPlainObject(model) ? model.target : null;
  if (!isPlainObject(target) || !isFiniteNumber(target.value)) return `${name} · ${value}`;
  const t = Math.round(target.value * 10) / 10;
  return `${name} · ${value} of ${t}`;
}

// --- §1 overlayTargetAnnotation (Step 3.4c — line kind has none) ---------

// The overlay's own target, drawn as a dashed line ON THE RIGHT AXIS
// (scaleID: 'yOverlay') — a target line with no scaleID would default to
// the chart's first/left y-axis and land at the wrong height entirely,
// since the two axes have unrelated ranges. null for kind 'line' (a
// continuous reading has a BAND, not a target — see
// overlayBoundAnnotations() below) or when there is no target at all
// (targetFor() already returns null for 'day' and untargeted trackables).
// Never throws.
export function overlayTargetAnnotation(model, fallbackColor) {
  const kind = isPlainObject(model) ? model.kind : undefined;
  if (kind === 'line') return null;

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

// --- §1 overlayBoundAnnotations (Step 3.4c — NEW) -------------------------

// A 'line'-kind overlay's balance is its BAND, not a target (§0 rule 3) —
// two dashed lines on the right axis, one per bound, only drawn when
// `model.bounds.status === 'ok'` (the same status boundsFor() uses to mean
// "there is a real band to show" for the metric's own Range chart). {}
// for a 'bar'-kind model, a missing/non-ok bounds object, or a bounds
// object whose lower/upper aren't finite — Object.assign/spread-safe, so
// the caller can always `{ ...overlayBoundAnnotations(...) }` into its own
// annotations map. Never throws.
export function overlayBoundAnnotations(model, fallbackColor) {
  const kind = isPlainObject(model) ? model.kind : undefined;
  if (kind !== 'line') return {};

  const bounds = isPlainObject(model) ? model.bounds : null;
  if (!isPlainObject(bounds) || bounds.status !== 'ok' || !isFiniteNumber(bounds.lower) || !isFiniteNumber(bounds.upper)) {
    return {};
  }

  const color = (isPlainObject(model) && model.color) || fallbackColor;

  return {
    overlayLower: {
      type: 'line',
      scaleID: 'yOverlay',
      value: bounds.lower,
      borderColor: color,
      borderWidth: 1,
      borderDash: [4, 4],
      label: { display: true, content: String(bounds.lower), position: 'end', backgroundColor: color },
    },
    overlayUpper: {
      type: 'line',
      scaleID: 'yOverlay',
      value: bounds.upper,
      borderColor: color,
      borderWidth: 1,
      borderDash: [4, 4],
      label: { display: true, content: String(bounds.upper), position: 'end', backgroundColor: color },
    },
  };
}

// --- §1 overlayDatasets (Step 3.4c — branches by kind) --------------------

// PURE Chart.js dataset configs, one per model, branching on `model.kind`:
//
// 'bar' — exactly 3.4b's bars: per-bucket colour by verdict (good/bad/
// neutral), semi-transparent fill so the bars read as a secondary series
// without competing with the metric's own line, `order: 2` keeps them
// drawn behind/after the line in Chart.js's default draw order.
//
// 'line' (Step 3.4c) — a dashed line (visually distinct from the metric's
// own solid line) with per-POINT colour by zone-derived verdict, so an
// out-of-band reading stands out even without reading the dashed bound
// lines. `fill: false`/`spanGaps: false`: an unlogged bucket is a real gap
// (weekly.js#fillValueFor's reasoning for 'average'/'last'), never bridged
// or shaded under. `order: 1` draws it ABOVE the bars (order 2), since a
// line overlay and a bar overlay never coexist (one overlay at a time),
// but a line reads better on top of the metric's own zone shading either
// way.
//
// `colors` is `{ good, bad, fallback }` — plain strings, resolved by the
// caller (js/charts/bounds.js) from CSS custom properties, since this
// module never touches `document`. Non-array `models` -> []. Never
// throws.
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
    const kind = isPlainObject(model) ? model.kind : undefined;

    if (kind === 'line') {
      const pointColors = verdicts.map((v) => (v === 'good' ? good : v === 'bad' ? bad : modelColor));
      return {
        type: 'line',
        label: name,
        yAxisID: 'yOverlay',
        data: values,
        borderColor: modelColor,
        backgroundColor: withAlpha(modelColor, OVERLAY_BAR_ALPHA),
        borderDash: [4, 3],
        borderWidth: 2,
        tension: 0,
        spanGaps: false,
        fill: false,
        pointRadius: 3,
        pointHoverRadius: 4,
        pointBackgroundColor: pointColors,
        pointBorderColor: pointColors,
        order: 1,
      };
    }

    // kind 'bar' (or garbage) — exactly 3.4b.
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
