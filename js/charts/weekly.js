// Weekly trend chart (Step 3.2). PURE-ish module: everything in this file
// except renderWeekly()/destroyWeekly() runs with no DOM at all — no
// `fetch`, no `localStorage`, no `store.js`, no `api.js`. Only those two
// exports touch `document`/`window`. This module issues ZERO network
// requests, ever: entries arrive as a plain array argument from the caller
// (js/views/detail.js), which already loaded them through the store. See
// CONTRACT-3.2.md §0(d) and Step 2.3's e2e case D6 / Step 3.1's H2 (exactly
// one entries GET per detail-screen load, across every chart slot combined).
//
// Allowed imports, and only these:
import { rollup, fillSeries } from '../aggregate.js';
import { isoWeeksInRange, isoWeekKey } from '../dates.js';

// §0(b): rollup(), fillSeries() and the ISO-week helpers in js/dates.js are
// the SINGLE implementation of rollup/grouping math. This module imports
// and calls them rather than encoding a second, parallel notion of weekly
// buckets — the same rule that made Step 3.1 import verdict() rather than
// copy it.

const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_KEY_RE = /^\d{4}-W\d{2}$/;

// A regex-shape match ('YYYY-MM-DD') is not the same as a real calendar
// date ('2026-02-30' matches the shape but isn't a day that exists).
// Reusing isoWeekKey()'s own validation (which routes through
// dates.js#parseLocal) rather than reimplementing calendar-date checking
// here is what §0(b) asks for; the try/catch is what turns dates.js's
// "throw on garbage" contract into this module's "never throw on garbage
// `from`/entry_date" contract (§2.6) without duplicating the validation
// logic itself.
function isRealDateStr(str) {
  if (typeof str !== 'string' || !DATE_STR_RE.test(str)) return false;
  try {
    isoWeekKey(str);
    return true;
  } catch {
    return false;
  }
}

// --- §2.1 seriesAggregationFor ---------------------------------------------

// THIS FUNCTION IS §0(a) IN CODE — it decides what the bars mean. Resolved
// by the user 2026-08-24 (APP_CONCEPT.md → "The target defines the chart's
// unit"): when a trackable's target is a weekly AVERAGE, the chart must
// plot the weekly average even if `aggregation` says something else
// (typically 'sum') — otherwise weekly-total bars near 11,900 kcal get
// drawn against a target line at 1,700 and the line is meaningless. Do NOT
// "correct" this back to `aggregation`, and do not add a second code path
// that also plots the raw aggregation "as well" — see CONTRACT-3.2.md §0(a)
// and §2.1.
export function seriesAggregationFor(trackable) {
  if (trackable && typeof trackable === 'object' && trackable.target_type === 'weekly_average') {
    return 'average';
  }
  const agg = trackable && typeof trackable === 'object' ? trackable.aggregation : undefined;
  if (agg === 'sum' || agg === 'count' || agg === 'average' || agg === 'last') return agg;
  return 'sum';
}

// --- §2.2 fillValueFor -----------------------------------------------------

// NOT uniform across aggregations, deliberately. For 'sum'/'count', a week
// with no entries genuinely IS zero — zero workouts, zero kcal logged. For
// 'average'/'last', zero would be a LIE: a week you didn't weigh yourself is
// not a week you weighed 0kg, and plotting it as 0 would drag the whole
// trend to the floor. Those render as an explicit gap (null) instead. Never
// throws.
export function fillValueFor(aggregation) {
  if (aggregation === 'sum' || aggregation === 'count') return 0;
  if (aggregation === 'average' || aggregation === 'last') return null;
  return 0;
}

// --- §2.3 weekLabel ----------------------------------------------------

// 'YYYY-Www' -> 'Www'. Short because this is a phone screen and a 1-year
// range is 52 categories; the full key stays available for the tooltip
// (weekKeys, read by renderWeekly()).
export function weekLabel(weekKey) {
  if (typeof weekKey !== 'string' || !WEEK_KEY_RE.test(weekKey)) {
    throw new RangeError(`weekLabel: expected a 'YYYY-Www' string, got: ${JSON.stringify(weekKey)}`);
  }
  return weekKey.slice(5);
}

// --- §2.4 targetFor ----------------------------------------------------

// Returns null ("no target line") for any `target_type` other than
// 'weekly_count'/'weekly_average' (so 'none', 'specific_days', missing all
// give null — specific_days has no UI and no defined line per BUILD_PLAN's
// Architecture decisions), and for any `target_value` that doesn't
// represent a real number.
//
// `target_value` is accepted as a `number` OR a `string` and coerced with
// Number() — verified against the live API at contract time: PostgREST
// returns `numeric` columns as JSON numbers, so the real Calories row
// arrives as target_value: 1700 (a number) and a plain Number.isFinite
// check would work today. Strings are accepted anyway because
// js/views/trackable.js builds payloads from form inputs (always strings)
// and store.js mirrors rows through localStorage — coercion is free and
// removes a whole class of "the target line silently never renders" bug.
//
// Anything that ISN'T a plain number or string (arrays, plain objects,
// booleans) is rejected outright rather than handed to Number(), because
// Number([]) === 0 and Number(true) === 1 are both finite — coercing those
// would silently draw a target line at 0 (or 1) for a value that was never
// meant to be numeric. '', null and undefined are rejected explicitly for
// the same reason: Number('') === 0 and Number(null) === 0.
export function targetFor(trackable) {
  if (!trackable || typeof trackable !== 'object') return null;
  const kind = trackable.target_type;
  if (kind !== 'weekly_count' && kind !== 'weekly_average') return null;

  const raw = trackable.target_value;
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;

  const value = Number(raw);
  if (!Number.isFinite(value)) return null;

  return { value, kind };
}

// --- §2.5 weekVerdict ----------------------------------------------------

// Both comparisons are inclusive — a week landing exactly on the line
// counts as hitting it, matching the inclusive-bounds convention Step 2.4
// established for home-model.js's verdict(). Never throws for any input.
export function weekVerdict(value, target, direction) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'none';
  if (!target || typeof target !== 'object' || typeof target.value !== 'number' || !Number.isFinite(target.value)) {
    return 'none';
  }
  if (direction === 'break') {
    return value <= target.value ? 'good' : 'bad';
  }
  return value >= target.value ? 'good' : 'bad';
}

// --- shared trackable-field readers, null-safe ------------------------

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

function directionOf(trackable) {
  return trackable && typeof trackable === 'object' && trackable.direction === 'break' ? 'break' : 'build';
}

function emptyModel(trackable) {
  return {
    isEmpty: true,
    aggregation: seriesAggregationFor(trackable),
    weekKeys: [],
    labels: [],
    values: [],
    verdicts: [],
    target: targetFor(trackable),
    unit: unitOf(trackable),
    identityColor: identityColorOf(trackable),
    direction: directionOf(trackable),
    weekCount: 0,
  };
}

// --- §2.6 weeklyModel --------------------------------------------------

// THE CORE PURE FUNCTION. Never throws except on a malformed `to` — a
// null/garbage `trackable`, a non-array `entries`, entries with garbage
// entry_dates or non-numeric values, and a garbage `from` (treated as null)
// must all produce a well-formed model.
export function weeklyModel({ trackable, entries, from, to } = {}) {
  // `to` must throw unconditionally for anything that isn't a real local
  // calendar date — including on an early-return path below (e.g. "no
  // entries at all"), so it is validated first, before any other logic.
  // Reusing isoWeekKey()'s own validation rather than a local regex means a
  // shape-only match like '2026-02-30' still throws, exactly as dates.js
  // would treat it.
  isoWeekKey(to);

  const list = Array.isArray(entries) ? entries : [];
  const aggregation = seriesAggregationFor(trackable);

  // rollup() only guards against non-finite VALUES, not bad dates — an
  // entry with a garbage entry_date would make its internal isoWeekKey()
  // call throw. Filtering to entries with a real calendar entry_date up
  // front is what keeps this function's own "never throws" promise; it is
  // input sanitization, not a reimplementation of rollup's grouping math
  // (§0(b)) — every entry that survives this filter is handed to rollup()
  // completely unchanged.
  const dateValidEntries = list.filter((e) => e && typeof e === 'object' && isRealDateStr(e.entry_date));

  let lowerBound;
  if (isRealDateStr(from)) {
    lowerBound = from;
  } else {
    let earliest = null;
    for (const e of dateValidEntries) {
      if (earliest === null || e.entry_date < earliest) earliest = e.entry_date;
    }
    if (earliest === null) return emptyModel(trackable);
    lowerBound = earliest;
  }

  // 'YYYY-MM-DD' strings compare lexicographically in chronological order
  // (js/dates.js relies on the same fact) — both sides are confirmed real
  // dates by this point, so a plain string comparison is safe.
  if (lowerBound > to) return emptyModel(trackable);

  // §0(c): the complete, gap-free list of ISO week keys in range — this is
  // what guarantees a skipped week never silently vanishes from the axis.
  const keys = isoWeeksInRange(lowerBound, to);

  const buckets = rollup(dateValidEntries, 'week', aggregation);
  // Note on rollup()'s own contract: it throws on an unknown
  // period/aggregation, but seriesAggregationFor() can only ever return one
  // of the four legal aggregation values, so that throw is unreachable from
  // here — no defensive try/catch is added around it, which would only
  // mask a real regression.
  const filled = fillSeries(buckets, keys, fillValueFor(aggregation));

  const target = targetFor(trackable);
  const direction = directionOf(trackable);

  const labels = [];
  const values = [];
  const verdicts = [];
  for (const point of filled) {
    labels.push(weekLabel(point.key));
    values.push(point.value);
    verdicts.push(weekVerdict(point.value, target, direction));
  }

  return {
    isEmpty: false,
    aggregation,
    weekKeys: keys,
    labels,
    values,
    verdicts,
    target,
    unit: unitOf(trackable),
    identityColor: identityColorOf(trackable),
    direction,
    weekCount: labels.length,
  };
}

// =============================================================================
// DOM — the only exports in this file that touch `document`/`window`.
// =============================================================================

// Plain-English phrase for what the bars mean, keyed by what
// seriesAggregationFor() actually returned — NOT by `trackable.aggregation`
// directly, since §0(a) means those can differ. This is the one place on
// screen that tells the user "these bars are averages", which matters most
// exactly when aggregation and the bars have diverged.
const AGGREGATION_PHRASE = {
  sum: 'Total per week',
  count: 'Days logged per week',
  average: 'Average per week',
  last: 'Latest each week',
};

function meaningText(model) {
  const phrase = AGGREGATION_PHRASE[model.aggregation] || AGGREGATION_PHRASE.sum;
  return model.unit ? `${phrase} · ${model.unit}` : phrase;
}

// Reads a CSS custom property off :root at render time (so light/dark both
// work — see css/styles.css's :root / prefers-color-scheme split), with a
// hardcoded fallback in case getComputedStyle throws or the property is
// unset (defensive; should not happen in this app's own stylesheet).
function cssVar(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name);
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
  } catch {
    return fallback;
  }
}

function colorForVerdict(verdict, identityColor) {
  if (verdict === 'good') return cssVar('--good', '#34c759');
  if (verdict === 'bad') return cssVar('--bad', '#ff6b6b');
  return identityColor || cssVar('--accent', '#3478f6');
}

// Verified at implementation time (not from memory) against the pinned
// chartjs-plugin-annotation@3.1.0 UMD build: loaded as a plain <script> tag
// (no CommonJS/AMD in scope, which is exactly index.html's situation), its
// factory's own last line is `Chart.register(ee)` — the plugin
// self-registers the moment its <script> tag runs, PROVIDED window.Chart
// already exists at that point (true here: index.html loads chart.umd
// before chartjs-plugin-annotation). No Chart.register(...) call is needed
// anywhere in this app's own code. This was confirmed by actually
// executing both pinned CDN files in a bare script-tag-shaped JS context
// and checking Chart.registry.plugins.get('annotation') came back
// non-null — not assumed from documentation.
//
// This check still matters at runtime despite that self-registration,
// because sw.js caches the two CDN scripts independently (Step 0.3's
// install handler fetches each with its own try/catch) — window.Chart can
// exist while the annotation plugin failed to load/cache, and the chart
// must still render, just without the target line.
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
  p.className = 'weekly-unavailable';
  p.textContent = 'Chart unavailable offline.';
  root.appendChild(p);
}

// §4 — one module-scoped Chart.js instance. detail.js re-renders by wiping
// its section's innerHTML, which detaches the canvas but does NOT destroy
// the Chart instance holding it — that leaks, and Chart.js keeps
// responding to events on a detached canvas (the classic "tooltips from
// the previous chart" bug). renderWeekly() always destroys any existing
// instance before creating a new one; destroyWeekly() is also exported so
// detail.js can call it directly on unmount.
let chartInstance = null;

// Idempotent — safe to call when nothing exists, never throws.
export function destroyWeekly() {
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
export function renderWeekly(model) {
  destroyWeekly();

  const root = document.createElement('div');
  root.className = 'weekly';

  const meaning = document.createElement('p');
  meaning.className = 'weekly-meaning';
  meaning.textContent = meaningText(model);
  root.appendChild(meaning);

  if (model.isEmpty) {
    const p = document.createElement('p');
    p.className = 'weekly-empty';
    p.textContent = 'Not enough data yet.';
    root.appendChild(p);
    return root;
  }

  // The pinned CDN failed and the service worker had no cached copy — a
  // logging app must still show its data when a CDN is down, so this is a
  // message, not a throw.
  if (typeof window === 'undefined' || !window.Chart) {
    renderUnavailable(root);
    return root;
  }

  const wrap = document.createElement('div');
  wrap.className = 'weekly-canvas-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'weekly-canvas';
  wrap.appendChild(canvas);
  root.appendChild(wrap);

  const backgroundColor = model.verdicts.map((v) => colorForVerdict(v, model.identityColor));

  const plugins = {
    legend: { display: false },
    tooltip: {
      callbacks: {
        // The axis only shows the short 'W34' label (weekLabel()) — the
        // tooltip title shows the full 'YYYY-Www' key instead.
        title(items) {
          if (!items || items.length === 0) return '';
          return model.weekKeys[items[0].dataIndex] || '';
        },
      },
    },
  };

  if (model.target !== null && annotationPluginAvailable()) {
    plugins.annotation = {
      annotations: {
        target: {
          type: 'line',
          yMin: model.target.value,
          yMax: model.target.value,
          borderColor: cssVar('--accent', '#3478f6'),
          borderWidth: 2,
          borderDash: [6, 4],
          label: {
            display: true,
            content: String(model.target.value),
            position: 'end',
            backgroundColor: cssVar('--accent', '#3478f6'),
          },
        },
      },
    };
  }

  const scales = {
    x: { type: 'category' },
    y: {},
  };
  // Forcing beginAtZero for 'average'/'last' would flatten every real
  // change in something like a weight chart into a straight line — see
  // CONTRACT-3.2.md §3.
  if (model.aggregation === 'sum' || model.aggregation === 'count') {
    scales.y.beginAtZero = true;
  }

  try {
    chartInstance = new window.Chart(canvas, {
      type: 'bar',
      data: {
        labels: model.labels,
        datasets: [
          {
            data: model.values,
            backgroundColor,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // This chart is destroyed and recreated on every detail.js render
        // (§4) rather than updated in place, so animating every time would
        // be visible churn on a phone.
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
