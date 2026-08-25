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
import { isoWeeksInRange, isoWeekKey, monthsInRange, rangeDays } from '../dates.js';

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

// Step 3.2b (CONTRACT-3.2b.md §4, fixing D5): bare week numbers ('W34')
// made Chart.js's autoSkip label-thinning look like whole weeks were
// missing on device. 'YYYY-Www' -> the week's Monday, formatted 'd MMM'
// (e.g. '17 Aug', no leading zero on the day) instead. The full key stays
// available for the tooltip (weekKeys, read by renderWeekly()) — nothing
// is lost, only the axis gets shorter.
//
// Hardcoded English month abbreviations — deliberately NOT
// toLocaleString/Intl, which varies by host ICU build and would make the
// suite non-deterministic (same reasoning as heatmap.js's MONTH_NAMES).
const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Maps a week key to that week's Monday as a 'YYYY-MM-DD' string. This is
// the arithmetic inverse of dates.js#isoWeekKey (Jan 4 is always in ISO
// week 1 of its year; week 1's Monday is Jan 4 minus its own ISO weekday
// offset; every later week's Monday is 7*(weekNum-1) days after that) —
// done in Date.UTC, same as isoWeekKey itself, so this is DST-free and
// never touches local-time parsing/formatting (the date trap dates.js's
// header warns about). Verified at implementation time (not from memory)
// to round-trip — isoWeekKey(isoWeekKeyToMonday(k)) === k — for every key
// isoWeeksInRange() produces across an 18+ month span crossing a year
// boundary, including the 'W01 starts in December' trap ('2026-W01' ->
// '2025-12-29'). Local to this module; js/dates.js is not modified, per
// this step's boundaries.
function isoWeekKeyToMonday(weekKey) {
  const isoYear = Number(weekKey.slice(0, 4));
  const weekNum = Number(weekKey.slice(6));
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7; // Monday=0 .. Sunday=6
  const week1Monday = new Date(jan4.getTime());
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow);
  const monday = new Date(week1Monday.getTime());
  monday.setUTCDate(week1Monday.getUTCDate() + (weekNum - 1) * 7);
  const y = monday.getUTCFullYear();
  const m = monday.getUTCMonth() + 1;
  const d = monday.getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function weekLabel(weekKey) {
  if (typeof weekKey !== 'string' || !WEEK_KEY_RE.test(weekKey)) {
    throw new RangeError(`weekLabel: expected a 'YYYY-Www' string, got: ${JSON.stringify(weekKey)}`);
  }
  const monday = isoWeekKeyToMonday(weekKey);
  const day = Number(monday.slice(8, 10));
  const month = Number(monday.slice(5, 7));
  return `${day} ${MONTH_ABBR[month - 1]}`;
}

// --- Step 3.2c: granularity -------------------------------------------
//
// The user asked (2026-08-24) to choose Daily / Weekly / Monthly on this
// chart. `rollup()` in aggregate.js already supported all three periods;
// what this step adds is the key lists, the labels, and the per-period
// target rules below.

export const PERIODS = [
  { key: 'day', label: 'Daily' },
  { key: 'week', label: 'Weekly' },
  { key: 'month', label: 'Monthly' },
];

const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

// The complete, gap-free bucket-key list for a period. These keys must line
// up exactly with what rollup(entries, period, agg) produces — aggregate.js
// buckets 'day' by entry_date, 'week' by isoWeekKey and 'month' by
// entry_date.slice(0,7). Verified at implementation time rather than
// assumed. This list is what guarantees an empty period is rendered as an
// explicit zero/gap instead of silently vanishing from the axis
// (BUILD_PLAN Step 3.2: a skipped period makes a gap look like continuous
// activity, which is actively misleading on a habit tracker).
export function periodKeysFor(period, from, to) {
  if (period === 'day') return rangeDays(from, to);
  if (period === 'week') return isoWeeksInRange(from, to);
  if (period === 'month') return monthsInRange(from, to);
  throw new RangeError(`periodKeysFor: unknown period, got: ${JSON.stringify(period)}`);
}

// Axis label for one bucket key. Days and weeks both read 'd MMM' (a week
// is labelled by its Monday — see weekLabel above for why bare 'W34' was
// replaced). Months read 'Aug', or 'Aug 26' when the series spans more than
// one calendar year: without the year an All-range monthly chart repeats
// Jan..Dec with no way to tell which year is which.
export function periodLabel(key, period, opts = {}) {
  if (period === 'day') {
    if (typeof key !== 'string' || !DATE_STR_RE.test(key)) {
      throw new RangeError(`periodLabel: expected a 'YYYY-MM-DD' string for period 'day', got: ${JSON.stringify(key)}`);
    }
    return `${Number(key.slice(8, 10))} ${MONTH_ABBR[Number(key.slice(5, 7)) - 1]}`;
  }
  if (period === 'week') return weekLabel(key);
  if (period === 'month') {
    if (typeof key !== 'string' || !MONTH_KEY_RE.test(key)) {
      throw new RangeError(`periodLabel: expected a 'YYYY-MM' string for period 'month', got: ${JSON.stringify(key)}`);
    }
    const monthNum = Number(key.slice(5, 7));
    if (monthNum < 1 || monthNum > 12) {
      throw new RangeError(`periodLabel: month out of range in ${JSON.stringify(key)}`);
    }
    const abbr = MONTH_ABBR[monthNum - 1];
    return opts && opts.multiYear === true ? `${abbr} ${key.slice(2, 4)}` : abbr;
  }
  throw new RangeError(`periodLabel: unknown period, got: ${JSON.stringify(period)}`);
}

// --- chartTypeFor ------------------------------------------------------
//
// STEP 3.2B's WEIGHT BUG, PROPERLY FIXED. That step tried to stop Weight's
// y-axis spanning 0-80 for a single reading of 80 by supplying
// suggestedMin/suggestedMax. It did not work on the device, and the reason
// was verified on a live chart rather than guessed: with identical options
// (suggestedMin 72, suggestedMax 88) a BAR chart resolves to 0-90 while a
// LINE chart resolves to 72-88. A bar is drawn from a zero baseline, so
// Chart.js forces 0 into range no matter what is suggested.
//
// So the mark type is the fix, not the axis:
//   'sum'/'count'     are amounts ACCUMULATED over the period -> bars
//   'average'/'last'  are LEVELS sampled during it            -> line
// which is also what BUILD_PLAN Step 3.2 asked for ("one bar/POINT per ISO
// week", "Chart.js bar/LINE").
//
// The transferable lesson, recorded because it cost a shipped defect: a
// unit test on chart CONFIG cannot catch the library overriding that config
// at render time. axisBoundsFor() was correct and its unit test passed
// while the phone showed 0-80. Only reading the RESOLVED scale off a live
// chart catches this class of bug.
export function chartTypeFor(aggregation) {
  return aggregation === 'average' || aggregation === 'last' ? 'line' : 'bar';
}

// --- meaningText -------------------------------------------------------
//
// The one line on screen that says what the bars actually ARE. It matters
// disproportionately because seriesAggregationFor() can override
// `aggregation` (the 2026-08-24 "target defines the unit" decision), so the
// bars are not always what the trackable's own config would suggest — and
// because "Average per week" would be a lie in Daily view. Spelled out per
// combination rather than derived: 'count' + 'day' would otherwise read
// "Days logged per day".
const MEANING = {
  sum: { day: 'Total per day', week: 'Total per week', month: 'Total per month' },
  count: { day: 'Logged', week: 'Days logged per week', month: 'Days logged per month' },
  average: { day: 'Average per day', week: 'Average per week', month: 'Average per month' },
  last: { day: 'Latest each day', week: 'Latest each week', month: 'Latest each month' },
};

export function meaningText(aggregation, period, unit) {
  const row = MEANING[aggregation] || MEANING.sum;
  const base = row[period] || row.week;
  return typeof unit === 'string' && unit !== '' ? `${base} · ${unit}` : base;
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
// Step 3.2c: `period` decides whether — and at what value — the target line
// is drawn. Recorded user decision, 2026-08-24:
//
//   weekly_count   ("3 times per week")  day: NO LINE | week: 3 | month: 12
//   weekly_average ("1700 kcal average") every period: 1700, never scaled
//
// weekly_average is a RATE, so it answers the same question at any
// granularity. weekly_count is a count tied to the week itself: on a daily
// chart a line at 3 means nothing, so none is drawn rather than inventing
// one. The monthly multiplier is a flat x4 ("four weeks in a month"),
// chosen by the user over the arithmetically-truer 4.345 because it is how
// people think about it — the consequence, accepted, is that a 31-day month
// is marginally easier than hitting 3 every week. `label` carries the
// COMPUTED number ('12 / month') so a scaled target is self-explaining on
// screen rather than mysterious.
//
// `period` defaults to 'week' so every pre-3.2c caller keeps its exact
// behaviour.
const MONTHS_TO_WEEKS = 4;
const PERIOD_WORD = { day: 'day', week: 'week', month: 'month' };

export function targetFor(trackable, period = 'week') {
  if (!trackable || typeof trackable !== 'object') return null;
  const kind = trackable.target_type;
  if (kind !== 'weekly_count' && kind !== 'weekly_average') return null;

  const raw = trackable.target_value;
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;

  const baseValue = Number(raw);
  if (!Number.isFinite(baseValue)) return null;

  const per = PERIOD_WORD[period] ? period : 'week';

  let value = baseValue;
  if (kind === 'weekly_count') {
    if (per === 'day') return null;
    if (per === 'month') value = baseValue * MONTHS_TO_WEEKS;
  }

  // The returned shape is EXACTLY { value, kind } and must stay that way.
  // Step 3.2's contract pinned it, and the existing unit tests deep-equal
  // against it — an earlier draft of 3.2c added baseValue/scaled/label here
  // and broke six of them. Presentation (the '12 / month' line label)
  // belongs in the presentation layer, not smuggled into a model object
  // whose shape is part of a tested contract. See targetLabel() below.
  return { value, kind };
}

// Display label for the target line, e.g. '12 / month'. Kept out of
// targetFor()'s return value deliberately (see above). Carries the COMPUTED
// number so a target scaled from weeks to months is self-explaining on
// screen rather than mysterious — a silently rescaled target would be the
// same class of quiet lie as plotting a sum against an average line.
export function targetLabel(target, period = 'week') {
  if (!target || typeof target !== 'object' || typeof target.value !== 'number' || !Number.isFinite(target.value)) {
    return '';
  }
  const per = PERIOD_WORD[period] ? period : 'week';
  return `${String(Number(target.value))} / ${PERIOD_WORD[per]}`;
}

// True when this period's target line is a scaled version of the stored
// weekly figure (weekly_count on a monthly chart). Derived rather than
// stored, for the same shape-stability reason.
export function targetIsScaled(target, period) {
  return !!(target && target.kind === 'weekly_count' && period === 'month');
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

// --- §2.7 axisBoundsFor (Step 3.2b, fixing D2/D3/D4) --------------------
//
// PURE — inputs come only from the model (`values`, `target`,
// `aggregation`), no DOM and no Chart.js, so it is unit-testable in Node.
// One gap produced all three device defects: `scales.y` had no integer
// constraint (D2, fractional tick labels on a count series), no framing
// around the target (D3, a target equal to the data max sits exactly on
// the axis border and is invisible), and nothing to fall back on with a
// single data point (D4, Chart.js has no range to derive and defaults to
// 0, flattening a single-point weight chart into a tall empty bar).
// CONTRACT-3.2b.md §3. Never throws for any input.
export function axisBoundsFor(model) {
  const rawValues = model && Array.isArray(model.values) ? model.values : [];
  const finite = rawValues.filter((v) => typeof v === 'number' && Number.isFinite(v));

  const aggregation = model && typeof model === 'object' ? model.aggregation : undefined;
  // Unchanged from Step 3.2 — forcing a weight/average chart to start at
  // zero flattens every real change into a straight line near the top.
  const beginAtZero = aggregation === 'sum' || aggregation === 'count';

  const rawTarget = model && typeof model === 'object' ? model.target : null;
  const hasTarget =
    !!rawTarget &&
    typeof rawTarget === 'object' &&
    typeof rawTarget.value === 'number' &&
    Number.isFinite(rawTarget.value);

  // True iff every value AND (when present) the target are integers — a
  // `count` series benefits directly, and an all-integer `sum` series
  // (e.g. whole-number calories) benefits too, without hardcoding to
  // `aggregation === 'count'`. Vacuously true for an empty `finite` with
  // no target, per contract.
  const integer = finite.every((v) => Number.isInteger(v)) && (!hasTarget || Number.isInteger(rawTarget.value));

  if (finite.length === 0 && !hasTarget) {
    // Nothing to frame — let Chart.js do whatever it likes.
    return { beginAtZero, suggestedMin: undefined, suggestedMax: undefined, integer };
  }

  // The target is folded into the span so its line is always drawn
  // strictly inside the chart, never on the border (D3).
  let lo = finite.length > 0 ? Math.min(...finite) : rawTarget.value;
  let hi = finite.length > 0 ? Math.max(...finite) : rawTarget.value;
  if (hasTarget) {
    lo = Math.min(lo, rawTarget.value);
    hi = Math.max(hi, rawTarget.value);
  }

  const span = hi - lo;
  // A flat/single-point series (span 0) has nothing to derive a window
  // from — pad by a fraction of the magnitude instead, floored at 1 so a
  // value of 0 still gets a visible window (D4).
  const pad = span > 0 ? span * 0.15 : Math.max(1, Math.abs(hi) * 0.1);

  let suggestedMax = hi + pad;
  let suggestedMin = beginAtZero ? 0 : lo - pad;

  if (integer) {
    // Round outward, never inward — inward rounding could clip the very
    // data/target point the padding was added to protect.
    suggestedMin = Math.floor(suggestedMin);
    suggestedMax = Math.ceil(suggestedMax);
  }

  return { beginAtZero, suggestedMin, suggestedMax, integer };
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

function emptyModel(trackable, period) {
  return {
    isEmpty: true,
    period,
    multiYear: false,
    aggregation: seriesAggregationFor(trackable),
    weekKeys: [],
    labels: [],
    values: [],
    verdicts: [],
    target: targetFor(trackable, period),
    unit: unitOf(trackable),
    identityColor: identityColorOf(trackable),
    direction: directionOf(trackable),
    weekCount: 0,
  };
}

// True when the bucket keys span more than one calendar year — drives
// periodLabel's 'Aug' vs 'Aug 26' choice. Every key form ('YYYY-MM-DD',
// 'YYYY-Www', 'YYYY-MM') starts with the four-digit year, so one slice
// covers all three.
function spansMultipleYears(keys) {
  if (keys.length === 0) return false;
  const first = keys[0].slice(0, 4);
  return keys.some((k) => k.slice(0, 4) !== first);
}

// --- §2.6 trendModel ---------------------------------------------------

// THE CORE PURE FUNCTION. Never throws except on a malformed `to` or an
// unknown `period` — a null/garbage `trackable`, a non-array `entries`,
// entries with garbage entry_dates or non-numeric values, and a garbage
// `from` (treated as null) must all produce a well-formed model.
//
// Step 3.2c generalized this from weeks to any period. `weeklyModel` below
// is kept as a thin wrapper so every pre-3.2c caller and test keeps
// exercising the exact same behaviour under the same name.
export function trendModel({ trackable, entries, from, to, period = 'week' } = {}) {
  // `to` must throw unconditionally for anything that isn't a real local
  // calendar date — including on an early-return path below (e.g. "no
  // entries at all"), so it is validated first, before any other logic.
  // Reusing isoWeekKey()'s own validation rather than a local regex means a
  // shape-only match like '2026-02-30' still throws, exactly as dates.js
  // would treat it.
  isoWeekKey(to);

  // An unknown period is a programmer error, not bad user data — fail
  // loudly rather than silently defaulting to weeks and drawing a chart
  // that quietly answers a different question.
  if (period !== 'day' && period !== 'week' && period !== 'month') {
    throw new RangeError(`trendModel: unknown period, got: ${JSON.stringify(period)}`);
  }

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
    if (earliest === null) return emptyModel(trackable, period);
    lowerBound = earliest;
  }

  // 'YYYY-MM-DD' strings compare lexicographically in chronological order
  // (js/dates.js relies on the same fact) — both sides are confirmed real
  // dates by this point, so a plain string comparison is safe.
  if (lowerBound > to) return emptyModel(trackable, period);

  // §0(c): the complete, gap-free list of bucket keys in range — this is
  // what guarantees a skipped period never silently vanishes from the axis.
  const keys = periodKeysFor(period, lowerBound, to);

  const buckets = rollup(dateValidEntries, period, aggregation);
  // Note on rollup()'s own contract: it throws on an unknown
  // period/aggregation, but seriesAggregationFor() can only ever return one
  // of the four legal aggregation values, so that throw is unreachable from
  // here — no defensive try/catch is added around it, which would only
  // mask a real regression.
  const filled = fillSeries(buckets, keys, fillValueFor(aggregation));

  const target = targetFor(trackable, period);
  const direction = directionOf(trackable);
  const multiYear = spansMultipleYears(keys);

  const labels = [];
  const values = [];
  const verdicts = [];
  for (const point of filled) {
    labels.push(periodLabel(point.key, period, { multiYear }));
    values.push(point.value);
    // Verdicts compare against the SCALED target value (e.g. 12/month for a
    // 3/week goal), which is what targetFor already returns for this period.
    verdicts.push(weekVerdict(point.value, target, direction));
  }

  return {
    isEmpty: false,
    period,
    multiYear,
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

// Kept exported and behaviour-identical to its pre-3.2c self: 386 existing
// unit tests call this name, and preserving it means none of them had to be
// edited to accommodate the generalization — a test changed to fit a new
// implementation has stopped testing anything.
export function weeklyModel(args) {
  return trendModel({ ...(args || {}), period: 'week' });
}

// =============================================================================
// DOM — the only exports in this file that touch `document`/`window`.
// =============================================================================

// Plain-English phrase for what the bars mean, keyed by what
// seriesAggregationFor() actually returned — NOT by `trackable.aggregation`
// directly, since §0(a) means those can differ. This is the one place on
// screen that tells the user "these bars are averages", which matters most
// exactly when aggregation and the bars have diverged.
function modelMeaningText(model) {
  return meaningText(model.aggregation, model.period || 'week', model.unit);
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
  meaning.textContent = modelMeaningText(model);
  root.appendChild(meaning);

  // Step 3.2c §3.1 — the granularity control lives ON the chart it governs.
  // The 3M/6M/1Y/All range control deliberately stays global at the top of
  // the detail screen because it also bounds the heatmap's navigable months
  // and its 'before' cutoff; bucketing affects only this chart, so it sits
  // here. Attaches NO listeners — detail.js owns the one delegated click
  // listener, exactly as the heatmap's month nav does.
  const periods = document.createElement('div');
  periods.className = 'trend-periods';
  periods.setAttribute('role', 'group');
  periods.setAttribute('aria-label', 'Granularity');
  const activePeriod = model.period || 'week';
  for (const p of PERIODS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'trend-period';
    btn.dataset.period = p.key;
    btn.setAttribute('aria-pressed', String(p.key === activePeriod));
    btn.textContent = p.label;
    periods.appendChild(btn);
  }
  root.appendChild(periods);

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
        // The axis only shows the short 'd MMM' label (weekLabel()) — the
        // tooltip title shows the full 'YYYY-Www' key instead.
        title(items) {
          if (!items || items.length === 0) return '';
          return model.weekKeys[items[0].dataIndex] || '';
        },
      },
    },
  };

  // For a line chart the per-point verdict colours ride on the points; the
  // line itself stays one neutral colour, because a line whose segments
  // change colour is unreadable.
  const chartType = chartTypeFor(model.aggregation);
  const dataset = {
    data: model.values,
  };
  if (chartType === 'line') {
    dataset.borderColor = model.identityColor || cssVar('--accent', '#3478f6');
    dataset.pointBackgroundColor = backgroundColor;
    dataset.pointBorderColor = backgroundColor;
    // A single logged period must not vanish into an invisible line.
    dataset.pointRadius = 4;
    dataset.borderWidth = 2;
    // A gap is a period with no data. Bridging it would draw a line
    // implying readings that were never taken.
    dataset.spanGaps = false;
    dataset.tension = 0;
  } else {
    dataset.backgroundColor = backgroundColor;
  }

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
            // The COMPUTED number, e.g. '12 / month' for a 3/week goal.
            // A silently rescaled target with no visible number is the same
            // class of quiet lie as plotting a sum against an average line.
            content: targetLabel(model.target, model.period || 'week'),
            position: 'end',
            backgroundColor: cssVar('--accent', '#3478f6'),
          },
        },
      },
    };
  }

  // Step 3.2b (CONTRACT-3.2b.md §3, fixing D2/D3/D4): axisBoundsFor() is
  // the single source of the y-axis window — see its own comment for why
  // each of the three device defects traced back to this one gap.
  const bounds = axisBoundsFor(model);
  const scales = {
    x: { type: 'category' },
    y: {},
  };
  if (bounds.beginAtZero) scales.y.beginAtZero = true;
  if (bounds.suggestedMin !== undefined) scales.y.suggestedMin = bounds.suggestedMin;
  if (bounds.suggestedMax !== undefined) scales.y.suggestedMax = bounds.suggestedMax;
  if (bounds.integer) {
    // Verified at implementation time against the pinned chart.js@4.5.1
    // build (a live Playwright-driven chart, not from memory):
    // `ticks: { precision: 0 }` alone fully suppresses fractional tick
    // labels, on both a narrow integer range (0-3, the Workout/D2 case)
    // and a wide one (1530-1870, the Calories-shaped case) — Chart.js's
    // own default tick-count budget (~11) already renders a handful of
    // evenly spaced ticks on the wide range, not hundreds. `stepSize: 1`
    // is deliberately NOT added: it is unnecessary once precision:0 does
    // the job, and forcing it is the shape of change that risks an
    // absurd tick count on a wide axis if that default budget ever
    // changes upstream. See this step's implementer report for the exact
    // numbers measured.
    scales.y.ticks = { precision: 0 };
  }

  try {
    chartInstance = new window.Chart(canvas, {
      // Step 3.2c §0(c): bars for accumulated amounts, a line for sampled
      // levels. This is what actually fixes Weight's 0-80 axis — a bar is
      // drawn from a zero baseline, so Chart.js forces 0 into range no
      // matter what suggestedMin says. See chartTypeFor().
      type: chartType,
      data: {
        labels: model.labels,
        datasets: [dataset],
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
