// Normalized multi-series comparison chart (Step 3.5, CONTRACT-3.5.md).
// Chart type 4b: any number of numeric/boolean trackables on ONE chart,
// each aggregated to a common period with its OWN aggregation, then
// normalized to ITS OWN min-max in the shown window (0-100%) — so
// differently-scaled series (calories vs. dollars) are visually
// comparable. This is a TOP-LEVEL screen (#/compare), not a per-trackable
// chart: js/views/compare.js is its caller, never js/views/detail.js.
//
// Same split as js/charts/weekly.js/bounds.js/overlay.js: everything
// except destroyCompare()/renderCompare() runs with no DOM at all — no
// `fetch`, no `localStorage`, no `store.js`, no `api.js`. This module
// issues ZERO network requests, ever; entries arrive as a plain
// { [id]: entries[] } map from the caller, which already loaded them
// through the store.
//
// Allowed imports, and only these (CONTRACT-3.5.md §1):
import { rollup, fillSeries, normalizeSeries } from '../aggregate.js';
// §0(b)-style discipline (weekly.js's own words, repeated at every chart
// module in this codebase): rollup()/fillSeries()/normalizeSeries() are
// the SINGLE implementation of "bucket, fill the gaps, scale 0-100" — this
// module reuses them rather than encoding a second, parallel version.
// seriesAggregationFor/fillValueFor/periodKeysFor/periodLabel are already
// the single implementation of "what does this trackable's trend look
// like, bucketed to a period" (weekly.js) — reused here for exactly the
// same reason, per trackable, before normalizing.
import { seriesAggregationFor, fillValueFor, periodKeysFor, periodLabel } from './weekly.js';
import { isoWeekKey } from '../dates.js';

// =============================================================================
// PURE EXPORTS — no DOM, no fetch, no localStorage. Keep it that way; a
// separate agent unit-tests these in Node with no DOM available.
// =============================================================================

// --- §1 constants (CONTRACT-3.5.md §1) --------------------------------

export const COMPARE_STORAGE_KEY = 'daily.compare.v1';
// Above this many drawn lines, readability degrades badly enough to warn
// about (APP_CONCEPT.md flags this explicitly) — but there is deliberately
// NO hard cap (§0 rule 5): Chart.js's own legend click already gives a
// free "toggle a series off without deselecting it" affordance, so a cap
// would only prevent something the user can already fix themselves.
export const RECOMMENDED_MAX_SERIES = 4;
// Fixed palette, used only when a trackable has no colour of its own
// (seriesColorFor() below) — picked so 8 series stay visually distinct
// before any repeat.
export const COMPARE_PALETTE = ['#3478f6', '#34c759', '#ff9f0a', '#ff453a', '#bf5af2', '#5ac8fa', '#ffd60a', '#ac8e68'];
export const COMPARE_RANGES = ['3m', '6m', '1y', 'all'];
export const COMPARE_PERIODS = ['day', 'week', 'month'];
export const DEFAULT_COMPARE_STATE = { ids: [], period: 'week', range: '3m' };

function isPlainObject(v) {
  return v !== null && typeof v === 'object';
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;

// A regex-shape match ('YYYY-MM-DD') is not the same as a real calendar
// date ('2026-02-30' matches the shape but isn't a day that exists) —
// reusing isoWeekKey()'s own validation rather than a second hand-rolled
// calendar checker, the same move weekly.js/bounds.js/overlay.js all make
// with their own isRealDateStr().
function isRealDateStr(str) {
  if (typeof str !== 'string' || !DATE_STR_RE.test(str)) return false;
  try {
    isoWeekKey(str);
    return true;
  } catch {
    return false;
  }
}

// --- compareCandidates ---------------------------------------------------

// Every non-archived trackable, input order preserved (the view sorts by
// visibleTrackables() BEFORE calling this — see CONTRACT-3.5.md §0 rule
// 2). Non-array -> []. Never throws.
export function compareCandidates(trackables) {
  if (!Array.isArray(trackables)) return [];
  return trackables.filter((t) => isPlainObject(t) && t.archived !== true);
}

// --- readCompareState / writeCompareState --------------------------------
//
// Unlike overlay.js's per-metric selection map, this is ONE global blob —
// the compare screen is a single top-level view, not one instance per
// trackable — so the stored shape is the flat { ids, period, range } object
// itself, not keyed by anything.

function validPeriod(period) {
  return COMPARE_PERIODS.includes(period) ? period : 'week';
}

function validRange(range) {
  return COMPARE_RANGES.includes(range) ? range : '3m';
}

function validIds(ids) {
  return Array.isArray(ids) ? ids.map(String) : [];
}

// A literal object, built fresh every time — never a reference to
// DEFAULT_COMPARE_STATE's own `ids` array. Handing out a shared mutable
// array would let one caller's mutation of the returned state leak into
// the next caller's "default", which is exactly what "returns a fresh
// object each call" (CONTRACT-3.5.md §1) rules out.
function freshDefaultState() {
  return { ids: [], period: 'week', range: '3m' };
}

// `storage` is any object with getItem(key)/setItem(key, value), or
// null/undefined — same injectable-storage shape as js/store.js and
// overlay.js. Never throws, regardless of what `storage` is or does.
export function readCompareState(storage) {
  if (!storage) return freshDefaultState();
  try {
    const raw = storage.getItem(COMPARE_STORAGE_KEY);
    if (typeof raw !== 'string') return freshDefaultState();
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || Array.isArray(parsed)) return freshDefaultState();
    return {
      ids: validIds(parsed.ids),
      period: validPeriod(parsed.period),
      range: validRange(parsed.range),
    };
  } catch {
    return freshDefaultState();
  }
}

// Writes { ids: ids.map(String), period, range }, each field validated the
// SAME way readCompareState validates it on the way back in — so a bad
// field written by a future/older version of this app is corrected on the
// next write rather than persisted forever. Storage errors (including
// setItem throwing, e.g. iOS private mode) are swallowed — best-effort
// only, same rule as every other writeStored*() in this codebase.
export function writeCompareState(storage, state) {
  if (!storage) return;
  try {
    const s = isPlainObject(state) ? state : {};
    const payload = {
      ids: validIds(s.ids),
      period: validPeriod(s.period),
      range: validRange(s.range),
    };
    storage.setItem(COMPARE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Best-effort only.
  }
}

// --- sanitizeCompareIds ----------------------------------------------------

// Coerces to strings, drops ids that are not current candidates, dedupes
// (first occurrence wins) — all while KEEPING SELECTION ORDER (not
// candidate order), and with NO CAP (§0 rule 5: no hard limit on series
// count, only a soft warning at render time). Never throws.
export function sanitizeCompareIds(ids, candidates) {
  if (!Array.isArray(ids)) return [];
  const candidateList = Array.isArray(candidates) ? candidates : [];
  const candidateIds = new Set(candidateList.filter(isPlainObject).map((c) => String(c.id)));

  const seen = new Set();
  const out = [];
  for (const raw of ids) {
    const s = String(raw);
    if (!candidateIds.has(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// --- seriesColorFor --------------------------------------------------------

// The trackable's own identity colour wins (so a series on this chart
// matches the colour the same trackable uses everywhere else in the app);
// otherwise a fixed palette by SELECTION index (not candidate index — the
// caller passes the position among ALL selected trackables, so colours
// stay stable as other series are added/removed — CONTRACT-3.5.md §0 rule
// 8 and the "skip the 2nd of 3" rule in compareModel() below). Never
// throws.
export function seriesColorFor(trackable, index) {
  if (isPlainObject(trackable) && typeof trackable.color === 'string' && trackable.color !== '') {
    return trackable.color;
  }
  const idx = Number.isInteger(index) && index >= 0 ? index : 0;
  return COMPARE_PALETTE[idx % COMPARE_PALETTE.length];
}

// --- compareSeries -----------------------------------------------------

// One series aligned to `keys` (the model's common bucket-key grid) — the
// pipeline resolved in APP_CONCEPT.md: bucket to the shared period with
// THIS trackable's OWN aggregation, fill the gaps honestly (0 for
// sum/count — an unlogged period genuinely IS zero, weekly.js#fillValueFor's
// own reasoning — null for average/last, a real gap, never bridged or
// invented), THEN normalize. Never throws for garbage entries/trackable;
// an unknown `period` falls back to 'day' (mirrors overlayModel()'s own
// per-call default, since the caller — compareModel() below — already
// validates period before this is ever reached in the DOM path).
export function compareSeries({ trackable, entries, keys, period, index } = {}) {
  const isObj = isPlainObject(trackable);
  const id = isObj ? String(trackable.id) : '';
  const name = isObj && typeof trackable.name === 'string' ? trackable.name : '';
  const unit = isObj && typeof trackable.unit === 'string' && trackable.unit !== '' ? trackable.unit : null;
  const color = seriesColorFor(trackable, index);
  const aggregation = seriesAggregationFor(trackable);
  const per = period === 'day' || period === 'week' || period === 'month' ? period : 'day';
  const keyList = Array.isArray(keys) ? keys : [];

  // Sanitize exactly like bounds.js#boundsSeries: a plain object, a REAL
  // calendar entry_date, a finite value, deduped by entry_date FIRST WINS
  // (the schema's unique (trackable_id, entry_date) constraint means this
  // never fires on real data — it exists for the same degenerate-input
  // guarantee bounds.js documents). Every surviving entry is handed to
  // rollup() unchanged: this is input filtering, not a second grouping
  // implementation.
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
  // — so rollup()'s own validation throws are unreachable from here (same
  // reasoning weekly.js#trendModel and overlay.js#overlayModel both give
  // for their own identical calls).
  const buckets = rollup(deduped, per, aggregation);
  const filled = fillSeries(buckets, keyList, fillValueFor(aggregation));
  const raw = filled.map((f) => f.value);
  const normalized = normalizeSeries(raw);

  // hasData comes from the ACTUAL buckets that fall inside `keys` (real
  // entries in the window) — NEVER from `raw`, the FILLED series.
  // Orchestrator amendment to CONTRACT-3.5.md §1 (post-implementation): for
  // 'sum'/'count', fillValueFor() honestly fills an unlogged period with 0
  // in `raw`/`normalized` (unchanged — a period with no entries elsewhere
  // in the window still reads as a real zero there), but a trackable with
  // ZERO entries anywhere in the window must not read as hasData:true just
  // because every bucket happened to fill with that same honest zero — a
  // flat line normalized to 50% would look like "average", when the truth
  // is "nothing logged".
  const keySet = new Set(keyList);
  const hasData = buckets.some((b) => keySet.has(b.key) && isFiniteNumber(b.value));

  // min/max, when there IS data, must be the lowest/highest of the FULL
  // post-fill `raw` array — exactly what normalizeSeries(raw) itself scales
  // against — so the key line's "what 0%/100% mean" text agrees with what
  // the chart actually draws at those percentages. Restricting min/max to
  // only the real (pre-fill) buckets, as a first pass at this amendment
  // did, was wrong: a sum series with raw [0, 15, 0, 40] normalizes against
  // 0..40 (the filled zeros count), so the key must say "0 – 40", not
  // "15 – 40". Second amendment, corrected here.
  const finite = raw.filter(isFiniteNumber);
  const min = hasData && finite.length > 0 ? Math.min(...finite) : null;
  const max = hasData && finite.length > 0 ? Math.max(...finite) : null;

  return { id, name, unit, color, aggregation, raw, normalized, min, max, hasData };
}

// True when the bucket keys span more than one calendar year — drives
// periodLabel's 'Aug' vs 'Aug 26' choice, same rule as weekly.js's own
// (private) spansMultipleYears(). Duplicated rather than imported: that
// helper is not exported, and every key form here starts with the
// four-digit year exactly as weekly.js's does, so one slice covers all
// three period shapes.
function spansMultipleYears(keys) {
  if (keys.length === 0) return false;
  const first = keys[0].slice(0, 4);
  return keys.some((k) => k.slice(0, 4) !== first);
}

// --- compareModel --------------------------------------------------------

// THE WHOLE MODEL. Never throws except on a malformed `to` or an unknown
// `period` (exactly trendModel()'s own contract) — a null/garbage
// `trackables`/`entriesById` and a garbage `from` (treated as null, same
// rule trendModel() uses) must all produce a well-formed model.
export function compareModel({ trackables, entriesById, from, to, period } = {}) {
  // Validated FIRST, unconditionally, including on every early-return path
  // below — same discipline as weekly.js#trendModel's isoWeekKey(to) call.
  isoWeekKey(to);
  if (period !== 'day' && period !== 'week' && period !== 'month') {
    throw new RangeError(`compareModel: unknown period, got: ${JSON.stringify(period)}`);
  }

  const list = Array.isArray(trackables) ? trackables.filter(isPlainObject) : [];
  const idsMap = isPlainObject(entriesById) ? entriesById : {};

  const skippedFor = (t) => ({
    id: String(t.id),
    name: typeof t.name === 'string' ? t.name : '',
  });

  if (list.length === 0) {
    return { status: 'none', period, keys: [], labels: [], multiYear: false, series: [], skipped: [], tooMany: false };
  }

  const entriesFor = (t) => {
    const raw = idsMap[String(t.id)];
    return Array.isArray(raw) ? raw : [];
  };

  let lowerBound;
  if (isRealDateStr(from)) {
    lowerBound = from;
  } else {
    let earliest = null;
    for (const t of list) {
      for (const e of entriesFor(t)) {
        if (!isPlainObject(e) || !isRealDateStr(e.entry_date)) continue;
        if (earliest === null || e.entry_date < earliest) earliest = e.entry_date;
      }
    }
    if (earliest === null) {
      return { status: 'empty', period, keys: [], labels: [], multiYear: false, series: [], skipped: list.map(skippedFor), tooMany: false };
    }
    lowerBound = earliest;
  }

  // 'YYYY-MM-DD' strings compare lexicographically in chronological order
  // (both sides proven real dates by this point) — same fact
  // trendModel()/boundsModel() both rely on.
  if (lowerBound > to) {
    return { status: 'empty', period, keys: [], labels: [], multiYear: false, series: [], skipped: list.map(skippedFor), tooMany: false };
  }

  const keys = periodKeysFor(period, lowerBound, to);
  const multiYear = spansMultipleYears(keys);
  const labels = keys.map((k) => periodLabel(k, period, { multiYear }));

  const series = [];
  const skipped = [];
  list.forEach((t, index) => {
    // `index` is the position among ALL SELECTED trackables, not just
    // those with data — this is what keeps a series' colour stable when an
    // earlier one is skipped (CONTRACT-3.5.md §1: "colour index is the
    // position among ALL selected").
    const s = compareSeries({ trackable: t, entries: entriesFor(t), keys, period, index });
    if (s.hasData) {
      series.push(s);
    } else {
      skipped.push(skippedFor(t));
    }
  });

  return {
    status: 'ok',
    period,
    keys,
    labels,
    multiYear,
    series,
    skipped,
    tooMany: series.length > RECOMMENDED_MAX_SERIES,
  };
}

// --- compareTooltipLabel ---------------------------------------------------

// Tooltip text for one series at bucket `index`: the RAW value stays
// visible even though only the plotted POSITION is normalized (§0 rule 4,
// "raw values stay visible" — resolved explicitly in APP_CONCEPT.md, so
// this is not optional polish). Never throws.
export function compareTooltipLabel(series, index) {
  const name = isPlainObject(series) && typeof series.name === 'string' ? series.name : '';
  const rawArr = isPlainObject(series) && Array.isArray(series.raw) ? series.raw : null;
  const raw = rawArr && Number.isInteger(index) && index >= 0 && index < rawArr.length ? rawArr[index] : undefined;

  if (!isFiniteNumber(raw)) return `${name}: —`;

  const normArr = isPlainObject(series) && Array.isArray(series.normalized) ? series.normalized : null;
  const norm = normArr ? normArr[index] : null;
  const unit = isPlainObject(series) && typeof series.unit === 'string' && series.unit !== '' ? series.unit : null;

  const r = Math.round(raw * 10) / 10;
  const p = isFiniteNumber(norm) ? Math.round(norm) : 0;
  return `${name}: ${r}${unit ? ' ' + unit : ''} (${p}%)`;
}

// --- compareKeyText ---------------------------------------------------------

// Key-line text: what 0% and 100% actually mean for this series, e.g.
// '1650 - 2300 kcal' — the other half of "raw values stay visible" (§0
// rule 4), since the chart itself only ever shows a percentage. Never
// throws.
export function compareKeyText(series) {
  const min = isPlainObject(series) && isFiniteNumber(series.min) ? series.min : null;
  const max = isPlainObject(series) && isFiniteNumber(series.max) ? series.max : null;
  if (min === null || max === null) return '—';

  const unit = isPlainObject(series) && typeof series.unit === 'string' && series.unit !== '' ? series.unit : null;
  const r = (v) => Math.round(v * 10) / 10;
  return `${r(min)} – ${r(max)}${unit ? ' ' + unit : ''}`;
}

// =============================================================================
// DOM — the only exports in this file that touch `document`/`window`.
// =============================================================================

// One module-scoped Chart.js instance, same lifecycle rule as every other
// chart module in this app (weekly.js#chartInstance, bounds.js#chartInstance):
// js/views/compare.js re-renders by wiping its section's innerHTML, which
// detaches the canvas but does NOT destroy the Chart instance holding it —
// that leaks, and a leaked instance keeps responding to events on a
// detached canvas. renderCompare() always destroys any existing instance
// before creating a new one (including on every early-return branch, so a
// pass that draws no chart at all still cleans up a PREVIOUS chart);
// destroyCompare() is also exported so the view can call it directly, both
// before an innerHTML wipe of its own and on unmount.
let chartInstance = null;

// Idempotent — safe to call when nothing exists, never throws.
export function destroyCompare() {
  if (chartInstance) {
    try {
      chartInstance.destroy();
    } catch {
      // A teardown call must never throw.
    }
    chartInstance = null;
  }
}

function renderUnavailable(root) {
  const p = document.createElement('p');
  p.className = 'compare-unavailable';
  p.textContent = 'Charts are unavailable offline until the chart library has been cached.';
  root.appendChild(p);
}

// The DOM export. Returns a container element; creates at most one
// Chart.js instance, tracked at module scope above. No innerHTML anywhere
// in this function — built with createElement/textContent/setAttribute
// only.
export function renderCompare(model) {
  destroyCompare();

  const root = document.createElement('div');
  root.className = 'compare';

  // §0 rule 4: the axis is a PERCENTAGE OF EACH SERIES' OWN RANGE, and an
  // unlabeled 0-100 axis would be read as absolute values — actively
  // misleading (APP_CONCEPT.md's own words). This line, plus the y-axis
  // title below, are what say so.
  const meaning = document.createElement('p');
  meaning.className = 'compare-meaning';
  meaning.textContent =
    "Each line is scaled to its own range in this window: 0% is its lowest value, 100% its highest.";
  root.appendChild(meaning);

  const status = isPlainObject(model) ? model.status : undefined;

  if (status === 'none') {
    const p = document.createElement('p');
    p.className = 'compare-empty';
    p.textContent = 'Pick two or more trackables above to compare them.';
    root.appendChild(p);
    return root;
  }

  if (status === 'empty') {
    const p = document.createElement('p');
    p.className = 'compare-empty';
    p.textContent = 'No entries in this range.';
    root.appendChild(p);
    return root;
  }

  // §0 rule 5: no hard cap, only a soft warning above RECOMMENDED_MAX_SERIES
  // — the "toggle off without deselecting" affordance is Chart.js's native
  // legend click, free, mentioned right in the warning text so the user
  // knows what to do about it.
  if (model.tooMany) {
    const p = document.createElement('p');
    p.className = 'compare-warning';
    p.setAttribute('role', 'status');
    p.textContent = 'More than 4 lines gets hard to read — tap a name in the legend to hide one.';
    root.appendChild(p);
  }

  const skipped = Array.isArray(model.skipped) ? model.skipped : [];
  if (skipped.length > 0) {
    const p = document.createElement('p');
    p.className = 'compare-skipped';
    const names = skipped.map((s) => (isPlainObject(s) && typeof s.name === 'string' ? s.name : '')).join(', ');
    p.textContent = `No data in this range: ${names}`;
    root.appendChild(p);
  }

  // The pinned CDN failed and the service worker had no cached copy — a
  // logging app must still show its data (the meaning/warning/skipped
  // lines above) when a CDN is down, so this is a message, not a throw.
  // Matches weekly.js/bounds.js's identical guard.
  if (typeof window === 'undefined' || !window.Chart) {
    renderUnavailable(root);
    return root;
  }

  const wrap = document.createElement('div');
  wrap.className = 'compare-canvas-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'compare-canvas';
  wrap.appendChild(canvas);
  root.appendChild(wrap);

  const series = Array.isArray(model.series) ? model.series : [];
  const activePeriod = model.period === 'day' || model.period === 'week' || model.period === 'month' ? model.period : 'week';

  // §0 rule 4: only the plotted POSITION is normalized — `data` is
  // `normalized`, never `raw`. The raw value survives in `series` itself,
  // read back out by compareTooltipLabel()'s tooltip callback below and by
  // the key list further down.
  const datasets = series.map((s) => ({
    label: s.name,
    data: s.normalized,
    borderColor: s.color,
    backgroundColor: s.color,
    pointBackgroundColor: s.color,
    // A daily chart with hundreds of points reads better with no point
    // markers at all (weekly.js's own precedent for its line series);
    // weekly/monthly get a visible marker per bucket.
    pointRadius: activePeriod === 'day' ? 0 : 3,
    pointHoverRadius: 4,
    borderWidth: 2,
    tension: 0,
    // A gap (null) is a period with no data for THIS series — bridging it
    // would draw a line implying a reading that was never taken, the same
    // rule weekly.js/bounds.js apply to their own lines.
    spanGaps: false,
    fill: false,
  }));

  try {
    chartInstance = new window.Chart(canvas, {
      type: 'line',
      data: {
        labels: model.labels,
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // Destroyed and recreated on every view render rather than updated
        // in place (same as every other chart in this app), so animating
        // every time would be visible churn on a phone.
        animation: false,
        scales: {
          x: { type: 'category' },
          y: {
            // Device amendment: plotted range gets 5 points of headroom on
            // each side (min -5/max 105) so a point sitting exactly at 0%
            // or 100% doesn't render clipped against the chart edge — this
            // is NOT a data-driven axis (§0 rule 4 still holds: it is
            // always a percentage of each series' own range). With a
            // non-zero min, Chart.js's own "nice tick" generation would
            // otherwise produce an unpredictable tick set, so the labelled
            // ticks are pinned deterministically to exactly 0/25/50/75/100
            // via afterBuildTicks rather than left to autogeneration.
            min: -5,
            max: 105,
            afterBuildTicks: (scale) => {
              scale.ticks = [0, 25, 50, 75, 100].map((value) => ({ value }));
            },
            ticks: { callback: (v) => `${v}%` },
            title: { display: true, text: "% of each line's own range" },
          },
        },
        plugins: {
          // Native legend click hides/shows a series without deselecting
          // it in the picker above — the free "toggle off" affordance §0
          // rule 5 asks for. No custom onClick needed.
          legend: { display: true },
          tooltip: {
            callbacks: {
              // The axis only shows the short period label — the tooltip
              // title shows the full bucket key, same pattern as
              // weekly.js's weekKeys / bounds.js's dates title callbacks.
              title(items) {
                if (!items || items.length === 0) return '';
                return (Array.isArray(model.keys) && model.keys[items[0].dataIndex]) || '';
              },
              label(item) {
                return compareTooltipLabel(model.series[item.datasetIndex], item.dataIndex);
              },
            },
          },
        },
      },
    });
  } catch {
    // A construction failure must not break the whole screen — degrade to
    // the same offline-style message rather than throwing out of render().
    wrap.remove();
    renderUnavailable(root);
    return root;
  }

  // The key list: what 0%/100% actually MEAN for each series, since the
  // chart itself only ever shows a percentage (§0 rule 4's other half).
  const ul = document.createElement('ul');
  ul.className = 'compare-key';
  for (const s of series) {
    const li = document.createElement('li');
    li.className = 'compare-key-item';
    li.dataset.seriesId = s.id;

    const dot = document.createElement('span');
    dot.className = 'compare-key-dot';
    dot.style.backgroundColor = s.color;
    li.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'compare-key-name';
    name.textContent = s.name;
    li.appendChild(name);

    const range = document.createElement('span');
    range.className = 'compare-key-range';
    range.textContent = compareKeyText(s);
    li.appendChild(range);

    ul.appendChild(li);
  }
  root.appendChild(ul);

  return root;
}
