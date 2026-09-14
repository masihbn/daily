// E2E tests for the overlay chart, updated through CONTRACT-3.4c.md (delta
// over CONTRACT-3.4b.md, itself a delta over CONTRACT-3.4.md after the
// device check): the overlay is the overlay trackable's OWN trend series,
// drawn on a visible right-hand axis ('yOverlay'). Two overlay KINDS as of
// 3.4c: 'bar' (count/sum aggregations — bars from zero, verdict against
// targetFor, target line) and 'line' (average/last aggregations, e.g.
// Weight — a dashed line judged by its OWN band via boundsFor, axis frames
// the data, never forced to zero). 3.4c also widened candidacy: every
// non-archived boolean OR numeric trackable is now offered, not just
// count/sum numerics. Only ONE overlay at a time (tapping another chip
// SWAPS the selection; there is no cap-disable state). Written strictly
// against CONTRACT-3.4c.md's §1 (module contract), §2 (renderBounds's
// `model.overlays` behaviour) and §3 (detail.js wiring) — cases O1 through
// O15 from §6 (O1-O12 carried over from 3.4b with O1/O6 updated for the
// widened candidacy; O13-O15 new for line-kind overlays). The
// implementation (js/charts/overlay.js, js/charts/bounds.js,
// js/views/detail.js) is being written in parallel by another agent from
// the same contract and has NOT been read while writing this file.
//
// Do NOT start a server here and do NOT hardcode the base URL or viewport;
// both are supplied by playwright.config.mjs (baseURL 127.0.0.1:8123, 390x844
// viewport). Reuses the exact interception mechanics established in
// tests/e2e/bounds.test.mjs (read in full before writing this file, and
// before this rewrite): a catch-all **/rest/v1/** guard registered FIRST
// that records and aborts anything unclaimed, specific routes registered
// after it, service workers blocked, seedSession() in beforeEach, and
// expect(unexpected).toEqual([]) in every test.
//
// GUARDRAIL (CONTRACT-3.4.md / CONTRACT-3.4b.md / CONTRACT-3.4c.md /
// docs/ORCHESTRATION.md): nothing in this file may create, modify, or
// delete a real Supabase row. Every PostgREST call the app makes is
// intercepted with page.route() and fully fulfilled/aborted from fixtures —
// ZERO real network calls.
//
// visibleSlots() (js/views/detail.js, unchanged by this contract) only shows
// the 'overlay' slot when 'bounds' is also shown (bounds_enabled === true AND
// value_shape === 'numeric' on the metric) AND at least one other
// non-archived trackable exists — every fixture combination below satisfies
// both.

import { test, expect } from '@playwright/test';
import { seedSession, installAuthGuard } from '../helpers/e2e-session.mjs';
import { addDays, isoWeekKey, startOfIsoWeek, isoWeeksInRange } from '../../js/dates.js';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await seedSession(page);
});

// --- storage key (CONTRACT-3.4.md §3, literal, unchanged by 3.4b) ---------

const OVERLAY_KEY = 'daily.detail.overlay.v1';

// --- fixtures ----------------------------------------------------------------

// A manual-bounds numeric metric — always resolves to status:'ok', isolating
// overlay behaviour from the bounds cold-start guard (O8 gets its own
// dedicated fixture, T_AUTO_FEW). Mirrors tests/e2e/bounds.test.mjs's
// T_MANUAL exactly (same id).
const T_MANUAL = {
  id: 501,
  name: 'Weight',
  value_shape: 'numeric',
  relog_semantic: 'state',
  aggregation: 'last',
  direction: 'break',
  unit: 'kg',
  bounds_enabled: true,
  bounds_mode: 'manual',
  bound_lower: 78,
  bound_upper: 85,
  target_type: 'none',
  target_value: null,
  color: '#5856d6',
  sort_order: 0,
  archived: false,
};

// Auto-derivation, no manual bounds, fed with fewer than MIN_BOUND_READINGS
// entries — used by O8 to prove the picker still renders (and data-overlays
// is forced to "0") when the bounds chart itself has no canvas.
const T_AUTO_FEW = {
  id: 502,
  name: 'Weight Auto',
  value_shape: 'numeric',
  relog_semantic: 'state',
  aggregation: 'last',
  direction: 'break',
  unit: 'kg',
  bounds_enabled: true,
  bounds_mode: 'auto',
  bound_lower: null,
  bound_upper: null,
  target_type: 'none',
  target_value: null,
  color: '#5856d6',
  sort_order: 1,
  archived: false,
};

// CONTRACT-3.4b.md §6's required fixture: boolean count candidate with a
// weekly_count target of 3, so the good/bad verdict split (O5) is genuinely
// exercised.
const T_WORKOUT = {
  id: 601,
  name: 'Workout',
  value_shape: 'boolean',
  relog_semantic: 'state',
  aggregation: 'count',
  direction: 'build',
  unit: null,
  bounds_enabled: false,
  bounds_mode: 'auto',
  bound_lower: null,
  bound_upper: null,
  target_type: 'weekly_count',
  target_value: 3,
  color: '#bf5af2',
  sort_order: 1,
  archived: false,
};

// CONTRACT-3.4c: every non-archived trackable is now a candidate, including
// this one — 'average' aggregation makes it a LINE-kind overlay when
// selected (Step 3.4c's whole point: a continuous reading like Calories or
// Weight, judged by its own band rather than a target).
const T_CALORIES = {
  id: 602,
  name: 'Calories',
  value_shape: 'numeric',
  relog_semantic: 'state',
  aggregation: 'average',
  direction: 'build',
  unit: 'kcal',
  bounds_enabled: false,
  bounds_mode: 'auto',
  bound_lower: null,
  bound_upper: null,
  target_type: 'none',
  target_value: null,
  color: '#ff9500',
  sort_order: 2,
  archived: false,
};

// A second boolean candidate, for the swap case (O6).
const T_READING = {
  id: 603,
  name: 'Reading',
  value_shape: 'boolean',
  relog_semantic: 'state',
  aggregation: 'count',
  direction: 'build',
  unit: null,
  bounds_enabled: false,
  bounds_mode: 'auto',
  bound_lower: null,
  bound_upper: null,
  target_type: 'none',
  target_value: null,
  color: '#34c759',
  sort_order: 3,
  archived: false,
};

// CONTRACT-3.4c.md §6's required fixture: a continuous (LINE-kind, aggregation
// 'last') candidate with its own manual band, so it is judged by zone
// (in/below/above its band) rather than a target. bounds_enabled is toggled
// off by O14's variant via spread, not a second literal object.
const T_WEIGHT_OVL = {
  id: 606,
  name: 'Weight',
  value_shape: 'numeric',
  relog_semantic: 'state',
  aggregation: 'last',
  direction: 'break',
  unit: 'kg',
  bounds_enabled: true,
  bounds_mode: 'manual',
  bound_lower: 78,
  bound_upper: 85,
  target_type: 'none',
  target_value: null,
  color: '#0a84ff',
  sort_order: 4,
  archived: false,
};

// Compute "today" from local calendar components — never toISOString, which
// reads UTC and is wrong for part of every day (same mechanics as
// tests/e2e/bounds.test.mjs / weekly.test.mjs / heatmap.test.mjs).
const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const PAST_DATE = `${TODAY.slice(0, 7)}-01`;

// Workout's logged days: two full, COMPLETED ISO weeks, placed so one week
// hits its target (>=3 distinct days) and the other misses it (<3) — the
// exact split O5 needs to prove the good/bad colour partition. Anchored to
// startOfIsoWeek() rather than a raw day-offset from TODAY, so which three
// calendar days land "in the same ISO week" never depends on what weekday
// TODAY happens to be (three CONSECUTIVE offsets like -2/-3/-4 could
// straddle a Sunday/Monday boundary on some run dates and not others — this
// anchoring avoids that entirely). Both weeks are >=3 weeks back, so they
// are never "this week" (which is still open) and comfortably inside the
// default 3M range. The per-week day COUNT used in assertions comes from
// isoWeekKey against these exact dates, never a hardcoded "3".
const GOOD_WEEK_MONDAY = startOfIsoWeek(addDays(TODAY, -28));
const BAD_WEEK_MONDAY = addDays(GOOD_WEEK_MONDAY, 7);
const WORKOUT_DATES = [
  GOOD_WEEK_MONDAY,
  addDays(GOOD_WEEK_MONDAY, 1),
  addDays(GOOD_WEEK_MONDAY, 2),
  BAD_WEEK_MONDAY,
];
const WORKOUT_ENTRIES = WORKOUT_DATES.map((date, i) => ({
  id: 8000 + i,
  trackable_id: 601,
  entry_date: date,
  value: 1,
  note: null,
}));
// Distinct-day count per ISO week, derived (not hardcoded): a Map from week
// key -> count of distinct WORKOUT_DATES landing in it.
function weeklyCounts(dates) {
  const m = new Map();
  for (const dt of dates) {
    const k = isoWeekKey(dt);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
const WORKOUT_WEEK_COUNTS = weeklyCounts(WORKOUT_DATES);

const METRIC_ENTRIES = [{ id: 1, trackable_id: 501, entry_date: PAST_DATE, value: 80, note: null }];

// Weight's readings: three IN the 78-85 band, one below, one above — all
// well inside the default 3M range, spread across distinct weeks (offsets
// 5/12/20/30/40 days back) so O15's Weekly case has both populated and
// empty week buckets to check.
const WEIGHT_OVL_READINGS = [
  { offset: 5, value: 80 }, // in
  { offset: 12, value: 75 }, // below
  { offset: 20, value: 90 }, // above
  { offset: 30, value: 82 }, // in
  { offset: 40, value: 79 }, // in
];
const WEIGHT_OVL_ENTRIES = WEIGHT_OVL_READINGS.map(({ offset, value }, i) => ({
  id: 9000 + i,
  trackable_id: 606,
  entry_date: addDays(TODAY, -offset),
  value,
  note: null,
}));
const WEIGHT_IN_BAND_COUNT = WEIGHT_OVL_READINGS.filter((r) => r.value >= 78 && r.value <= 85).length;
const WEIGHT_OUT_BAND_COUNT = WEIGHT_OVL_READINGS.length - WEIGHT_IN_BAND_COUNT;
const WEIGHT_WEEK_KEYS = new Set(WEIGHT_OVL_ENTRIES.map((e) => isoWeekKey(e.entry_date)));

const AUTO_FEW_ENTRIES = [1, 3, 5, 7, 9].map((offset, i) => ({
  id: 900 + i,
  trackable_id: 502,
  entry_date: addDays(TODAY, -offset),
  value: 78 + i,
  note: null,
}));

// --- route helpers -----------------------------------------------------------

async function installGuard(page) {
  const unexpected = [];
  await page.route('**/rest/v1/**', async (route) => {
    unexpected.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort();
  });
  return unexpected;
}

async function routeTrackables(page, trackables) {
  await page.route('**/rest/v1/trackables*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.abort();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(trackables),
    });
  });
}

// ONE handler for /rest/v1/entries*: parses the trackable_id=in.(...) filter
// out of the (URL-decoded) request URL, resolves fixtures per id from
// `fixturesById` (id string -> array of rows, or the string 'ERROR_500' to
// force a 500 for that request), and records every GET's URL + resolved id
// list so tests can count/inspect GETs per id. A non-GET falls through to
// abort.
async function routeEntries(page, fixturesById) {
  const getRequests = []; // { url, ids: string[] }
  await page.route('**/rest/v1/entries*', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') {
      await route.abort();
      return;
    }
    const url = req.url();
    let decoded = url;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      // Fall back to the raw URL if it isn't validly percent-encoded.
    }
    const match = decoded.match(/trackable_id=in\.\(([^)]*)\)/);
    const ids = match
      ? match[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    getRequests.push({ url, ids });

    const hasError = ids.some((id) => fixturesById[id] === 'ERROR_500');
    if (hasError) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'synthetic overlay load failure' }),
      });
      return;
    }

    let body = [];
    for (const id of ids) {
      const f = fixturesById[id];
      if (Array.isArray(f)) body = body.concat(f);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return getRequests;
}

function getsForId(getRequests, id) {
  return getRequests.filter((r) => r.ids.includes(String(id)));
}

function anyGetNames(getRequests, id) {
  return getsForId(getRequests, id).length > 0;
}

// --- chart / storage readers --------------------------------------------------

function liveChartInstanceCount(page) {
  return page.evaluate(() => Object.keys(window.Chart.instances).length);
}

// chart.data.labels are the pre-existing FORMATTED axis labels (e.g. '10 Aug'
// — the week's Monday, from bounds.js#boundsPeriodLabel, unchanged since
// Step 3.3); the raw 'YYYY-Www'/'YYYY-MM-DD'/'YYYY-MM' bucket keys never
// appear there, so indexOf-ing a raw week key against `labels` always misses.
// The tooltip title callback is the exposed channel back to those raw keys
// (bounds.js's `title(items)` returns model.dates[items[0].dataIndex]) — walk
// every bucket index through it once to get an index-aligned array of raw
// keys that CAN be looked up with indexOf.
function readRawBucketKeys(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.bounds-canvas');
    const chart = canvas ? window.Chart.getChart(canvas) : null;
    if (!chart) return [];
    const titleCb = chart.options.plugins.tooltip.callbacks.title;
    const keys = [];
    for (let i = 0; i < chart.data.labels.length; i++) {
      keys.push(titleCb([{ dataIndex: i }]));
    }
    return keys;
  });
}

// Reads the live bounds chart's overlay-relevant state in one round trip.
// Returns null when there is no canvas (non-'ok' bounds status).
function readChartInfo(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.bounds-canvas');
    const chart = canvas ? window.Chart.getChart(canvas) : null;
    if (!chart) return null;
    const scales = chart.options.scales || {};
    return {
      datasetCount: chart.data.datasets.length,
      datasets: chart.data.datasets.map((ds) => ({
        type: ds.type,
        label: ds.label,
        yAxisID: ds.yAxisID,
        data: ds.data,
        backgroundColor: ds.backgroundColor,
        borderDash: ds.borderDash,
        pointBackgroundColor: ds.pointBackgroundColor,
      })),
      labels: chart.data.labels,
      yOverlay: scales.yOverlay
        ? {
            position: scales.yOverlay.position,
            min: scales.yOverlay.min,
            suggestedMin: scales.yOverlay.suggestedMin,
            suggestedMax: scales.yOverlay.suggestedMax,
          }
        : null,
      yTitle: scales.y && scales.y.title ? scales.y.title.text : null,
      legendDisplay:
        chart.options.plugins && chart.options.plugins.legend ? chart.options.plugins.legend.display : undefined,
      legendItemsCount: chart.legend && chart.legend.legendItems ? chart.legend.legendItems.length : null,
      annotations:
        chart.options.plugins && chart.options.plugins.annotation ? chart.options.plugins.annotation.annotations : null,
    };
  });
}

function readOverlayStorage(page) {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  }, OVERLAY_KEY);
}

async function seedOverlaySelection(page, selection) {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, JSON.stringify(value));
    },
    [OVERLAY_KEY, selection]
  );
}

function chip(page, id) {
  return page.locator(`.overlay-chip[data-overlay-id="${id}"]`);
}

// Clicks a chip, waits for the synchronous aria-pressed flip, then waits for
// it to leave the `disabled` state — CONTRACT-3.4b keeps the "every chip is
// disabled while a load is in flight" rule from 3.4 (just drops the cap-
// disable case). This is a genuine contract-driven completion signal for the
// fire-and-forget history load, not a fixed sleep.
async function selectOverlay(page, id) {
  const c = chip(page, id);
  await c.click();
  await expect(c).toHaveAttribute('aria-pressed', 'true');
  await expect(c).not.toBeDisabled();
}

function pageErrorCollector(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));
  return errors;
}

// ===========================================================================
// O1 — nothing selected
// ===========================================================================

test('O1 — nothing selected: picker with the "Pick one…" hint, chips for ALL FOUR candidates (601, 602, 603, 606 — CONTRACT-3.4c widened candidacy), no overlay dataset, one entries GET', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES, T_READING, T_WEIGHT_OVL]);
  const getRequests = await routeEntries(page, {
    501: METRIC_ENTRIES,
    601: WORKOUT_ENTRIES,
    602: [],
    603: [],
    606: WEIGHT_OVL_ENTRIES,
  });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  const picker = page.locator('.chart-slot[data-slot="overlay"] .overlay-picker');
  await expect(picker).toHaveCount(1);
  await expect(picker.locator('.overlay-hint')).toHaveText(
    'Pick one to draw it on the Range chart above, on its own axis.'
  );

  // CONTRACT-3.4c widened candidacy: 602 (numeric average) and 606 (numeric
  // last) are now candidates too — 4 chips total, none for the metric.
  await expect(picker.locator('.overlay-chip')).toHaveCount(4);
  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'false');
  await expect(chip(page, 602)).toHaveAttribute('aria-pressed', 'false');
  await expect(chip(page, 603)).toHaveAttribute('aria-pressed', 'false');
  await expect(chip(page, 606)).toHaveAttribute('aria-pressed', 'false');
  await expect(chip(page, 501)).toHaveCount(0); // the metric itself, never offered

  await expect(page.locator('.bounds')).toHaveAttribute('data-overlays', '0');

  const info = await readChartInfo(page);
  expect(info.datasetCount).toBe(1);

  await expect.poll(() => getRequests.length).toBe(1);
  expect(getRequests[0].ids).toEqual(['501']);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O2 — selecting an overlay
// ===========================================================================

test('O2 — tapping a candidate chip draws a second bar dataset on a visible right axis, with both axis titles and a 2-item legend', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES, T_READING]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [], 603: [] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  await selectOverlay(page, 601);

  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.overlay-hint')).toHaveText('Drawn on the Range chart above, right axis. Tap another to swap.');

  await expect.poll(() => getRequests.length).toBe(2);
  const overlayReq = getRequests[getRequests.length - 1];
  expect(overlayReq.ids).toContain('601');
  expect(overlayReq.ids).not.toContain('501');

  await expect(page.locator('.bounds')).toHaveAttribute('data-overlays', '1');

  const info = await readChartInfo(page);
  expect(info.datasetCount).toBe(2);
  expect(info.datasets[1].type).toBe('bar');
  expect(info.datasets[1].yAxisID).toBe('yOverlay');
  expect(info.datasets[1].label).toBe('Workout');
  expect(info.yOverlay).not.toBeNull();
  expect(info.yOverlay.position).toBe('right');
  expect(info.yTitle).toBe('kg'); // T_MANUAL's unit
  expect(info.legendDisplay).toBe(true);
  expect(info.legendItemsCount).toBe(2);

  const stored = await readOverlayStorage(page);
  expect(stored).toEqual({ 501: ['601'] });

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O3 — persisted selection loads on mount
// ===========================================================================

test('O3 — a persisted selection is pressed on load and both histories are fetched with no tap needed', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES, T_READING]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [], 603: [] });
  await seedOverlaySelection(page, { 501: ['601'] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'true');

  await expect.poll(() => getRequests.length).toBe(2);
  expect(anyGetNames(getRequests, 501)).toBe(true);
  expect(anyGetNames(getRequests, 601)).toBe(true);

  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(2);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O4 — clearing the selection is a pure local action
// ===========================================================================

test('O4 — tapping the pressed chip clears the overlay locally with NO additional GET', async ({ page }) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES, T_READING]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [], 603: [] });
  await seedOverlaySelection(page, { 501: ['601'] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => getRequests.length).toBe(2);
  const countBefore = getRequests.length;

  await chip(page, 601).click();

  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.bounds')).toHaveAttribute('data-overlays', '0');

  const info = await readChartInfo(page);
  expect(info.datasetCount).toBe(1);

  expect(getRequests.length).toBe(countBefore);

  const stored = await readOverlayStorage(page);
  expect(stored).toEqual({ 501: [] });

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O5 — Weekly bucketing, target line, and the good/bad colour partition
// ===========================================================================

test('O5 — Weekly shows per-ISO-week day counts with a good/bad colour split against the target line; Daily shows 0/1 with no target line', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES, T_READING]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [], 603: [] });
  await seedOverlaySelection(page, { 501: ['601'] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(2);
  await expect.poll(() => getRequests.length).toBe(2);
  const countBefore = getRequests.length;

  const infoAtDay = await readChartInfo(page);
  const labelsAtDay = infoAtDay.labels;
  // Daily: 0/1 bars, no target line (weekly targets don't apply at 'day').
  for (const v of infoAtDay.datasets[1].data) {
    expect([0, 1]).toContain(v);
  }
  const dayAnnotations = infoAtDay.annotations ? Object.values(infoAtDay.annotations) : [];
  expect(dayAnnotations.some((a) => a && a.scaleID === 'yOverlay')).toBe(false);

  await page.locator('.bounds-period[data-bounds-period="week"]').click();
  await expect(page.locator('.bounds-period[data-bounds-period="week"]')).toHaveAttribute('aria-pressed', 'true');

  // Genuine re-render proof (Step 3.2b's race lesson, reused from
  // bounds.test.mjs's Q9/Q12): trust the chart's own labels, not the
  // synchronously-set aria-pressed attribute.
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return JSON.stringify(info ? info.labels : null) !== JSON.stringify(labelsAtDay);
    })
    .toBe(true);

  const infoAtWeek = await readChartInfo(page);
  const weekLabels = infoAtWeek.labels; // formatted labels — only used to detect re-render below
  const weekRawKeys = await readRawBucketKeys(page); // raw 'YYYY-Www' keys, index-aligned with weekLabels
  const weekData = infoAtWeek.datasets[1].data;
  const weekBg = infoAtWeek.datasets[1].backgroundColor;

  // The target-line annotation exists on the right axis with value 3.
  const weekAnnotations = infoAtWeek.annotations ? Object.values(infoAtWeek.annotations) : [];
  const targetAnn = weekAnnotations.find((a) => a && a.scaleID === 'yOverlay');
  expect(targetAnn).toBeTruthy();
  expect(targetAnn.value).toBe(3);

  // For every week that actually has a logged count (from WORKOUT_WEEK_COUNTS),
  // the bar's value matches that count, and its colour is drawn from the
  // 'good' palette when count >= 3 and a different colour otherwise. We
  // don't assert the exact rgba (implementation detail) — only that weeks
  // meeting vs missing the target get two DIFFERENT colours, matching the
  // good/bad split, per the task brief.
  const goodColors = new Set();
  const badColors = new Set();
  for (const [weekKey, count] of WORKOUT_WEEK_COUNTS.entries()) {
    const idx = weekRawKeys.indexOf(weekKey);
    if (idx === -1) continue; // week fell outside the plotted range; not this test's concern
    expect(weekData[idx]).toBe(count);
    if (count >= 3) goodColors.add(weekBg[idx]);
    else badColors.add(weekBg[idx]);
  }
  expect(goodColors.size).toBeGreaterThan(0);
  expect(badColors.size).toBeGreaterThan(0);
  for (const g of goodColors) expect(badColors.has(g)).toBe(false);

  await page.locator('.bounds-period[data-bounds-period="day"]').click();
  await expect(page.locator('.bounds-period[data-bounds-period="day"]')).toHaveAttribute('aria-pressed', 'true');

  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return JSON.stringify(info ? info.labels : null) !== JSON.stringify(weekLabels);
    })
    .toBe(true);

  const infoBackAtDay = await readChartInfo(page);
  for (const v of infoBackAtDay.datasets[1].data) {
    expect([0, 1]).toContain(v);
  }
  const backAnnotations = infoBackAtDay.annotations ? Object.values(infoBackAtDay.annotations) : [];
  expect(backAnnotations.some((a) => a && a.scaleID === 'yOverlay')).toBe(false);

  expect(getRequests.length).toBe(countBefore);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O6 — swapping the selection
// ===========================================================================

test('O6 — selecting a second candidate while one is already selected SWAPS it: only the new one is pressed, one GET, storage updated', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES, T_READING, T_WEIGHT_OVL]);
  const getRequests = await routeEntries(page, {
    501: METRIC_ENTRIES,
    601: WORKOUT_ENTRIES,
    602: [],
    603: [],
    606: WEIGHT_OVL_ENTRIES,
  });
  await seedOverlaySelection(page, { 501: ['601'] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => getRequests.length).toBe(2);
  const countBefore = getRequests.length;

  // CONTRACT-3.4c widened candidacy: the full chip roster (all four
  // candidates) is present alongside the already-selected 601, and 602/606
  // (the newly-added candidates) are unpressed.
  await expect(page.locator('.chart-slot[data-slot="overlay"] .overlay-chip')).toHaveCount(4);
  await expect(chip(page, 602)).toHaveAttribute('aria-pressed', 'false');
  await expect(chip(page, 606)).toHaveAttribute('aria-pressed', 'false');

  await selectOverlay(page, 603);

  await expect(chip(page, 603)).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'false');

  await expect.poll(() => getRequests.length).toBe(countBefore + 1);
  const swapReq = getRequests[getRequests.length - 1];
  expect(swapReq.ids).toContain('603');

  const info = await readChartInfo(page);
  expect(info.datasetCount).toBe(2);
  expect(info.datasets[1].label).toBe('Reading');

  const stored = await readOverlayStorage(page);
  expect(stored).toEqual({ 501: ['603'] });

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O7 — overlay load failure
// ===========================================================================

test('O7 — a 500 on the overlay entries GET keeps the chip pressed, shows the offline banner, never throws, and a retry issues a fresh GET', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES, T_READING]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: 'ERROR_500', 602: [], 603: [] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  await selectOverlay(page, 601);

  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.detail-offline')).toBeVisible();

  expect(getsForId(getRequests, 601).length).toBe(1);

  // Clear (local, no network) then re-select — the failed id was never
  // marked loaded, so re-selecting must issue a NEW GET.
  await chip(page, 601).click();
  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'false');

  await selectOverlay(page, 601);
  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'true');

  await expect.poll(() => getsForId(getRequests, 601).length).toBe(2);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O8 — picker survives a non-'ok' bounds status
// ===========================================================================

test('O8 — with an insufficient-data bounds status and a persisted overlay: no canvas, data-overlays forced to 0, picker still rendered, no crash', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_AUTO_FEW, T_WORKOUT]);
  const getRequests = await routeEntries(page, { 502: AUTO_FEW_ENTRIES, 601: WORKOUT_ENTRIES });
  await seedOverlaySelection(page, { 502: ['601'] });

  await page.goto('/index.html#/t/502');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  const bounds = page.locator('.chart-slot[data-slot="bounds"] .bounds');
  await expect(bounds).toHaveCount(1);
  await expect(bounds.locator('.bounds-summary')).toContainText('Not enough data yet');
  await expect(bounds.locator('canvas')).toHaveCount(0);
  await expect(bounds).toHaveAttribute('data-overlays', '0');

  await expect(page.locator('.chart-slot[data-slot="overlay"] .overlay-picker')).toHaveCount(1);
  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'true');

  await expect.poll(() => getRequests.length).toBe(2);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O9 — a stale stored id is silently dropped and rewritten
// ===========================================================================

test('O9 — a persisted stale id is dropped on load (a real candidate listed after it still survives): no GET names the stale id, and storage is rewritten', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES, T_READING]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [], 603: [] });
  // '999' is not a real trackable; sanitizeSelection must drop it and keep
  // the genuine candidate that follows it, capped at MAX_OVERLAYS (1).
  await seedOverlaySelection(page, { 501: ['999', '601'] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  await expect.poll(() => getRequests.length).toBe(2); // metric's GET + 601's, never 999's
  expect(getRequests.some((r) => r.ids.includes('999'))).toBe(false);
  expect(anyGetNames(getRequests, 601)).toBe(true);

  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 603)).toHaveAttribute('aria-pressed', 'false');

  await expect.poll(async () => readOverlayStorage(page)).toEqual({ 501: ['601'] });

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O10 — lifecycle: no leaked Chart instance after navigating away
// ===========================================================================

test('O10 — selecting an overlay then navigating Home leaves zero live Chart instances', async ({ page }) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES, T_READING]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [], 603: [] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  await selectOverlay(page, 601);
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(2);

  await page.goto('/index.html#/');
  await expect(page.locator('section.home')).toBeVisible();
  await expect.poll(() => liveChartInstanceCount(page)).toBe(0);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O11 — range change with an overlay selected issues zero GETs
// ===========================================================================

test('O11 — changing the date range with an overlay selected issues ZERO additional entries GETs, and the chart keeps both datasets', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES, T_READING]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [], 603: [] });
  await seedOverlaySelection(page, { 501: ['601'] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(2);
  const countBefore = getRequests.length;

  await page.locator('.detail-range[data-range="6m"]').click();
  await expect(page.locator('section.detail')).toHaveAttribute('data-range', '6m');

  expect(getRequests.length).toBe(countBefore);

  const info = await readChartInfo(page);
  expect(info.datasetCount).toBe(2);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O12 — tooltip callback
// ===========================================================================

test('O12 — the tooltip label callback reports "Workout · N of 3" for the overlay bar and "value kg" for the metric line', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES, T_READING]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [], 603: [] });
  await seedOverlaySelection(page, { 501: ['601'] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(2);
  await expect.poll(() => getRequests.length).toBe(2);

  const labelsAtDay = (await readChartInfo(page)).labels;
  await page.locator('.bounds-period[data-bounds-period="week"]').click();
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return JSON.stringify(info ? info.labels : null) !== JSON.stringify(labelsAtDay);
    })
    .toBe(true);

  const infoAtWeek = await readChartInfo(page);
  // Pick a week bucket that actually has one of Workout's logged weeks, so
  // the count in the tooltip text is meaningful (not just 0). chart.data
  // .labels holds the formatted axis labels ('10 Aug'), not the raw
  // 'YYYY-Www' keys — look those up through the tooltip title callback.
  const weekRawKeys = await readRawBucketKeys(page);
  let knownIdx = -1;
  let knownCount = null;
  for (const [weekKey, count] of WORKOUT_WEEK_COUNTS.entries()) {
    const idx = weekRawKeys.indexOf(weekKey);
    if (idx !== -1) {
      knownIdx = idx;
      knownCount = count;
      break;
    }
  }
  expect(knownIdx).toBeGreaterThanOrEqual(0);

  const overlayTooltip = await page.evaluate(
    ({ idx }) => {
      const canvas = document.querySelector('.bounds-canvas');
      const chart = window.Chart.getChart(canvas);
      return chart.options.plugins.tooltip.callbacks.label({ datasetIndex: 1, dataIndex: idx });
    },
    { idx: knownIdx }
  );
  expect(overlayTooltip).toBe(`Workout · ${knownCount} of 3`);

  const metricTooltip = await page.evaluate(
    ({ idx }) => {
      const canvas = document.querySelector('.bounds-canvas');
      const chart = window.Chart.getChart(canvas);
      return chart.options.plugins.tooltip.callbacks.label({ datasetIndex: 0, dataIndex: idx });
    },
    { idx: knownIdx }
  );
  expect(metricTooltip).toContain('kg');

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O13 — CONTRACT-3.4c: a continuous (line-kind) overlay at Daily, judged by
// its own band
// ===========================================================================

test('O13 — selecting Weight (line kind) at Daily draws a dashed line on a data-framed right axis, coloured by its own band, not a target', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES, T_READING, T_WEIGHT_OVL]);
  const getRequests = await routeEntries(page, {
    501: METRIC_ENTRIES,
    601: [],
    602: [],
    603: [],
    606: WEIGHT_OVL_ENTRIES,
  });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);
  // Daily is the bounds chart's default period.
  await expect(page.locator('.bounds-period[data-bounds-period="day"]')).toHaveAttribute('aria-pressed', 'true');

  await selectOverlay(page, 606);

  await expect.poll(() => getRequests.length).toBe(2);
  const overlayReq = getRequests[getRequests.length - 1];
  expect(overlayReq.ids).toContain('606');
  expect(overlayReq.ids).not.toContain('501');

  const info = await readChartInfo(page);
  expect(info.datasetCount).toBe(2);
  expect(info.datasets[1].type).toBe('line');
  expect(info.datasets[1].yAxisID).toBe('yOverlay');
  expect(info.datasets[1].borderDash).toEqual([4, 3]);

  // No min:0 for a line-kind overlay — it frames the data instead — and the
  // frame's suggestedMin sits below the lowest fixture reading (75).
  expect(info.yOverlay).not.toBeNull();
  expect(info.yOverlay.min).toBeUndefined();
  expect(info.yOverlay.suggestedMin).toBeLessThan(75);

  // The band lines (78/85) are drawn as annotations on the right axis.
  const annotations = info.annotations ? Object.values(info.annotations) : [];
  const overlayScaled = annotations.filter((a) => a && a.scaleID === 'yOverlay');
  const values = overlayScaled.map((a) => a.value).sort((a, b) => a - b);
  expect(values).toContain(78);
  expect(values).toContain(85);

  // Point colours partition into exactly one "in-band" colour and one
  // "out-of-band" colour, matching the fixture's 3-in / 2-out split.
  const rawKeys = await readRawBucketKeys(page); // 'day' period -> raw 'YYYY-MM-DD' keys
  const ptColors = info.datasets[1].pointBackgroundColor;
  const inBandColors = new Set();
  const outBandColors = new Set();
  let inBandIdx = -1;
  for (const r of WEIGHT_OVL_READINGS) {
    const dateStr = addDays(TODAY, -r.offset);
    const idx = rawKeys.indexOf(dateStr);
    expect(idx).toBeGreaterThanOrEqual(0);
    const inBand = r.value >= 78 && r.value <= 85;
    if (inBand) {
      inBandColors.add(ptColors[idx]);
      if (inBandIdx === -1) inBandIdx = idx;
    } else {
      outBandColors.add(ptColors[idx]);
    }
  }
  expect(inBandColors.size).toBe(1);
  expect(outBandColors.size).toBe(1);
  for (const c of inBandColors) expect(outBandColors.has(c)).toBe(false);
  expect(WEIGHT_IN_BAND_COUNT).toBeGreaterThan(0);
  expect(WEIGHT_OUT_BAND_COUNT).toBeGreaterThan(0);

  // Tooltip for an in-band index ends with '· in range' and includes 'kg'.
  const tooltip = await page.evaluate(
    ({ idx }) => {
      const canvas = document.querySelector('.bounds-canvas');
      const chart = window.Chart.getChart(canvas);
      return chart.options.plugins.tooltip.callbacks.label({ datasetIndex: 1, dataIndex: idx });
    },
    { idx: inBandIdx }
  );
  expect(tooltip).toContain('kg');
  expect(tooltip.endsWith('in range')).toBe(true);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O14 — same overlay with bounds disabled: no band, uniform colour, axis
// still frames the data (never forced to zero)
// ===========================================================================

test('O14 — with bounds_enabled false, the line overlay has no band annotations, every point is the same (trackable) colour, and the axis still frames the data above zero', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  const weightNoBounds = { ...T_WEIGHT_OVL, bounds_enabled: false };
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES, T_READING, weightNoBounds]);
  const getRequests = await routeEntries(page, {
    501: METRIC_ENTRIES,
    601: [],
    602: [],
    603: [],
    606: WEIGHT_OVL_ENTRIES,
  });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  await selectOverlay(page, 606);
  await expect.poll(() => getRequests.length).toBe(2);

  const info = await readChartInfo(page);
  expect(info.datasetCount).toBe(2);

  // No band annotations at all (no overlayLower/overlayUpper, no
  // overlayTarget — Weight has no target either).
  const annotations = info.annotations ? Object.values(info.annotations) : [];
  const overlayScaled = annotations.filter((a) => a && a.scaleID === 'yOverlay');
  expect(overlayScaled.length).toBe(0);

  // Every point (including the ones with real readings) is the trackable's
  // own colour — status isn't 'ok', so every verdict is 'none'.
  const ptColors = info.datasets[1].pointBackgroundColor.filter((c) => c !== undefined && c !== null);
  const distinctColors = new Set(ptColors);
  expect(distinctColors.size).toBe(1);
  expect(distinctColors.has('#0a84ff')).toBe(true);

  // The axis still frames the data (never forced to zero): suggestedMin is
  // below the lowest fixture reading (75) yet still positive.
  expect(info.yOverlay.suggestedMin).toBeLessThan(75);
  expect(info.yOverlay.suggestedMin).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O15 — Weekly bucketing for a line-kind overlay: aligned bucket count, gaps
// stay gaps, zero extra GETs
// ===========================================================================

test('O15 — Weekly for the line overlay has one value per ISO week in range, a week with no reading is null, and switching period issues zero GETs', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES, T_READING, T_WEIGHT_OVL]);
  const getRequests = await routeEntries(page, {
    501: METRIC_ENTRIES,
    601: [],
    602: [],
    603: [],
    606: WEIGHT_OVL_ENTRIES,
  });
  await seedOverlaySelection(page, { 501: ['606'] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(2);
  await expect.poll(() => getRequests.length).toBe(2);
  const countBefore = getRequests.length;

  const labelsAtDay = (await readChartInfo(page)).labels;
  await page.locator('.bounds-period[data-bounds-period="week"]').click();
  await expect(page.locator('.bounds-period[data-bounds-period="week"]')).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return JSON.stringify(info ? info.labels : null) !== JSON.stringify(labelsAtDay);
    })
    .toBe(true);

  const infoAtWeek = await readChartInfo(page);
  const weekRawKeys = await readRawBucketKeys(page);

  // The default 3M range's own ISO-week bucket count — the same "resolveRange
  // + isoWeeksInRange" arithmetic detail.js/boundsModel() use — not a
  // hardcoded number.
  const rangeFrom = addDays(TODAY, -89); // resolveRange('3m', TODAY).from
  const expectedWeekCount = isoWeeksInRange(rangeFrom, TODAY).length;
  expect(infoAtWeek.datasets[1].data.length).toBe(expectedWeekCount);
  expect(weekRawKeys.length).toBe(expectedWeekCount);

  // A week with none of Weight's logged days is null (a real gap, not 0).
  let emptyWeekIdx = -1;
  for (let i = 0; i < weekRawKeys.length; i++) {
    if (!WEIGHT_WEEK_KEYS.has(weekRawKeys[i])) {
      emptyWeekIdx = i;
      break;
    }
  }
  expect(emptyWeekIdx).toBeGreaterThanOrEqual(0);
  expect(infoAtWeek.datasets[1].data[emptyWeekIdx]).toBeNull();

  // A week that DOES contain one of Weight's logged days has a real value.
  let populatedWeekIdx = -1;
  for (let i = 0; i < weekRawKeys.length; i++) {
    if (WEIGHT_WEEK_KEYS.has(weekRawKeys[i])) {
      populatedWeekIdx = i;
      break;
    }
  }
  expect(populatedWeekIdx).toBeGreaterThanOrEqual(0);
  expect(infoAtWeek.datasets[1].data[populatedWeekIdx]).not.toBeNull();

  expect(getRequests.length).toBe(countBefore);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});
