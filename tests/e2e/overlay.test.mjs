// E2E tests for Step 3.4's correlation marker overlay: discrete events from
// OTHER trackables (gym days) drawn as markers on a bounded metric's Range
// chart (js/charts/bounds.js's canvas), with a picker in the 'overlay'
// chart-slot (js/charts/overlay.js's renderOverlayPicker, wired by
// js/views/detail.js). Written strictly against CONTRACT-3.4.md §1 (the
// module contract), §2 (renderBounds's `model.overlays` behaviour) and §3
// (detail.js wiring) — cases O1 through O12 from §6. The implementation
// (js/charts/overlay.js, and the corresponding changes to js/charts/bounds.js
// and js/views/detail.js) is being written in parallel by another agent from
// the same contract and has NOT been read while writing this file.
//
// Do NOT start a server here and do NOT hardcode the base URL or viewport;
// both are supplied by playwright.config.mjs (baseURL 127.0.0.1:8123, 390x844
// viewport). Reuses the exact interception mechanics established in
// tests/e2e/bounds.test.mjs (read in full before writing this file): a
// catch-all **/rest/v1/** guard registered FIRST that records and aborts
// anything unclaimed, specific routes registered after it, service workers
// blocked, seedSession() in beforeEach, and expect(unexpected).toEqual([]) in
// every test.
//
// GUARDRAIL (CONTRACT-3.4.md / docs/ORCHESTRATION.md): nothing in this file
// may create, modify, or delete a real Supabase row. Every PostgREST call the
// app makes is intercepted with page.route() and fully fulfilled/aborted from
// fixtures — this file makes ZERO real network calls to Supabase.
//
// visibleSlots() (js/views/detail.js, unchanged by this contract) only shows
// the 'overlay' slot when 'bounds' is also shown (bounds_enabled === true AND
// value_shape === 'numeric' on the metric) AND at least one other
// non-archived trackable exists — every fixture combination below satisfies
// both.

import { test, expect } from '@playwright/test';
import { seedSession, installAuthGuard } from '../helpers/e2e-session.mjs';
import { addDays, isoWeekKey } from '../../js/dates.js';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await seedSession(page);
});

// --- storage key (CONTRACT-3.4.md §3, literal) -----------------------------

const OVERLAY_KEY = 'daily.detail.overlay.v1';

// --- fixtures ----------------------------------------------------------------

// A manual-bounds numeric metric — always resolves to status:'ok', isolating
// overlay behaviour from the bounds cold-start guard (which gets its own
// dedicated case, O8, via T_AUTO_FEW below). Mirrors tests/e2e/bounds.test
// .mjs's T_MANUAL exactly (same id, so a reader who knows that file
// recognizes it immediately).
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

// A boolean overlay candidate (CONTRACT-3.4.md §6's required fixture: id 601
// 'Workout', color '#bf5af2').
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
  target_type: 'none',
  target_value: null,
  color: '#bf5af2',
  sort_order: 1,
  archived: false,
};

// A numeric 'average' trackable — NOT a candidate (§0.2: average/last
// numerics are continuous readings, Step 3.5's territory).
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

// Two more boolean candidates for the MAX_OVERLAYS cap case (O6).
const T_READING = { ...T_WORKOUT, id: 603, name: 'Reading', color: '#34c759', sort_order: 3 };
const T_MEDITATION = { ...T_WORKOUT, id: 604, name: 'Meditation', color: '#ff3b30', sort_order: 4 };
// A fourth candidate that must go DISABLED once three are already selected.
const T_JOURNALING = { ...T_WORKOUT, id: 605, name: 'Journaling', color: '#007aff', sort_order: 5 };

// Compute "today" from local calendar components — never toISOString, which
// reads UTC and is wrong for part of every day (same mechanics as
// tests/e2e/bounds.test.mjs / weekly.test.mjs / heatmap.test.mjs).
const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const PAST_DATE = `${TODAY.slice(0, 7)}-01`;

// Workout's logged days: three offsets seven days apart. Any two calendar
// dates exactly 7 days apart always fall in different ISO weeks (a week is a
// non-overlapping 7-day Monday-Sunday block), so this guarantees three
// distinct ISO weeks without hardcoding which weeks they are — the expected
// distinct-week count is DERIVED below via isoWeekKey, per the task brief,
// never assumed.
const WORKOUT_OFFSETS = [2, 9, 16];
const WORKOUT_DATES = WORKOUT_OFFSETS.map((o) => addDays(TODAY, -o));
const WORKOUT_WEEK_COUNT = new Set(WORKOUT_DATES.map((dt) => isoWeekKey(dt))).size;
const WORKOUT_ENTRIES = WORKOUT_DATES.map((date, i) => ({
  id: 8000 + i,
  trackable_id: 601,
  entry_date: date,
  value: 1,
  note: null,
}));

const METRIC_ENTRIES = [{ id: 1, trackable_id: 501, entry_date: PAST_DATE, value: 80, note: null }];

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

// ONE handler for /rest/v1/entries*, per the task brief: parses the
// trackable_id=in.(...) filter out of the (URL-decoded) request URL,
// resolves fixtures per id from `fixturesById` (id string -> array of rows,
// or the string 'ERROR_500' to force a 500 for that request), and records
// every GET's URL + resolved id list so tests can count/inspect GETs per id.
// A non-GET falls through to abort.
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

// Reads the live bounds chart's overlay-relevant state in one round trip.
// Returns null when there is no canvas (non-'ok' bounds status).
function readChartInfo(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.bounds-canvas');
    const chart = canvas ? window.Chart.getChart(canvas) : null;
    if (!chart) return null;
    return {
      datasetCount: chart.data.datasets.length,
      datasets: chart.data.datasets.map((ds) => ({
        label: ds.label,
        yAxisID: ds.yAxisID,
        showLine: ds.showLine,
        data: ds.data,
      })),
      labels: chart.data.labels,
      hasYOverlay: !!(chart.options.scales && chart.options.scales.yOverlay),
      legendDisplay:
        chart.options.plugins && chart.options.plugins.legend ? chart.options.plugins.legend.display : undefined,
      legendItemsCount: chart.legend && chart.legend.legendItems ? chart.legend.legendItems.length : null,
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
// it to leave the `disabled` state — per CONTRACT-3.4.md §1, EVERY chip
// (selected or not) is disabled while overlayLoading is true, and that flag
// only clears once loadOverlayHistories' fetch has settled (success OR
// error) and its trailing render() has run. This is a genuine
// contract-driven completion signal, not a fixed sleep.
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

test('O1 — nothing selected: picker with the initial hint, one chip per real candidate, no canvas overlay dataset, one entries GET', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  const picker = page.locator('.chart-slot[data-slot="overlay"] .overlay-picker');
  await expect(picker).toHaveCount(1);
  await expect(picker.locator('.overlay-hint')).toHaveText(
    'Pick up to 3 to mark their logged days on the Range chart above.'
  );

  await expect(picker.locator('.overlay-chip')).toHaveCount(1);
  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'false');
  // The non-candidate (average numeric) and the metric itself are never
  // offered as chips.
  await expect(chip(page, 602)).toHaveCount(0);
  await expect(chip(page, 501)).toHaveCount(0);

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

test('O2 — tapping a candidate chip marks it pressed, loads its history in exactly one more GET, and draws a second yOverlay dataset', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  await selectOverlay(page, 601);

  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.overlay-hint')).toHaveText('Marked on the Range chart above.');

  await expect.poll(() => getRequests.length).toBe(2);
  const overlayReq = getRequests[getRequests.length - 1];
  expect(overlayReq.ids).toContain('601');
  expect(overlayReq.ids).not.toContain('501');

  await expect(page.locator('.bounds')).toHaveAttribute('data-overlays', '1');

  const info = await readChartInfo(page);
  expect(info.datasetCount).toBe(2);
  expect(info.datasets[1].yAxisID).toBe('yOverlay');
  expect(info.datasets[1].showLine).toBe(false);
  const nonNull = info.datasets[1].data.filter((v) => v !== null);
  expect(nonNull.length).toBe(WORKOUT_OFFSETS.length);

  const stored = await readOverlayStorage(page);
  expect(stored).toEqual({ 501: ['601'] });

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O3 — persisted selection loads on mount, in the metric+overlay batch
// ===========================================================================

test('O3 — a persisted selection is pressed on load and its history is fetched with no tap needed', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [] });
  await seedOverlaySelection(page, { 501: ['601'] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'true');

  await expect.poll(() => getRequests.length).toBe(2);
  expect(anyGetNames(getRequests, 501)).toBe(true);
  expect(anyGetNames(getRequests, 601)).toBe(true);

  await expect.poll(async () => {
    const info = await readChartInfo(page);
    return info ? info.datasetCount : null;
  }).toBe(2);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O4 — deselecting is a pure local action
// ===========================================================================

test('O4 — tapping the pressed chip off removes the overlay locally with NO additional GET', async ({ page }) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [] });
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
// O5 — granularity changes re-bucket the overlay locally, zero new GETs
// ===========================================================================

test('O5 — switching the Range chart to Weekly re-buckets the overlay marker count to distinct ISO weeks, with zero additional GETs', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [] });
  await seedOverlaySelection(page, { 501: ['601'] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(async () => {
    const info = await readChartInfo(page);
    return info ? info.datasetCount : null;
  }).toBe(2);
  await expect.poll(() => getRequests.length).toBe(2);
  const countBefore = getRequests.length;

  const infoAtDay = await readChartInfo(page);
  const dayNonNull = infoAtDay.datasets[1].data.filter((v) => v !== null).length;
  expect(dayNonNull).toBe(WORKOUT_OFFSETS.length);
  const labelsAtDay = infoAtDay.labels;

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
  const weekNonNull = infoAtWeek.datasets[1].data.filter((v) => v !== null).length;
  expect(weekNonNull).toBe(WORKOUT_WEEK_COUNT);
  const labelsAtWeek = infoAtWeek.labels;

  await page.locator('.bounds-period[data-bounds-period="day"]').click();
  await expect(page.locator('.bounds-period[data-bounds-period="day"]')).toHaveAttribute('aria-pressed', 'true');

  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return JSON.stringify(info ? info.labels : null) !== JSON.stringify(labelsAtWeek);
    })
    .toBe(true);

  const infoBackAtDay = await readChartInfo(page);
  const backNonNull = infoBackAtDay.datasets[1].data.filter((v) => v !== null).length;
  expect(backNonNull).toBe(WORKOUT_OFFSETS.length);

  expect(getRequests.length).toBe(countBefore);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O6 — MAX_OVERLAYS cap
// ===========================================================================

test('O6 — selecting three overlays disables a fourth candidate chip; unselecting one re-enables it', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_READING, T_MEDITATION, T_JOURNALING]);
  const getRequests = await routeEntries(page, {
    501: METRIC_ENTRIES,
    601: WORKOUT_ENTRIES,
    603: [],
    604: [],
    605: [],
  });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  await selectOverlay(page, 601);
  await selectOverlay(page, 603);
  await selectOverlay(page, 604);

  await expect(page.locator('.bounds')).toHaveAttribute('data-overlays', '3');
  await expect(chip(page, 605)).toBeDisabled();

  await chip(page, 601).click(); // unselect — local only, no network
  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'false');

  await expect(chip(page, 605)).toBeEnabled();

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
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: 'ERROR_500', 602: [] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  await selectOverlay(page, 601);

  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.detail-offline')).toBeVisible();

  const firstFailureCount = getsForId(getRequests, 601).length;
  expect(firstFailureCount).toBe(1);

  // Toggle off (local, no network) then on again — the failed id was never
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

test('O9 — a persisted id that is no longer a candidate is dropped on load: no GET names it, and storage is rewritten', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [] });
  await seedOverlaySelection(page, { 501: ['999', '601'] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  await expect.poll(() => getRequests.length).toBe(2);
  expect(getRequests.some((r) => r.ids.includes('999'))).toBe(false);
  expect(anyGetNames(getRequests, 601)).toBe(true);
  expect(anyGetNames(getRequests, 501)).toBe(true);

  // The chip list reflects only real candidates — one chip, for 601.
  await expect(page.locator('.chart-slot[data-slot="overlay"] .overlay-chip')).toHaveCount(1);
  await expect(chip(page, 601)).toHaveAttribute('aria-pressed', 'true');

  await expect.poll(async () => readOverlayStorage(page)).toEqual({ 501: ['601'] });

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O10 — legend
// ===========================================================================

test('O10 — the legend is hidden with zero overlays and shows exactly one item (the overlay, not the metric line) with one selected', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  const infoBefore = await readChartInfo(page);
  expect(infoBefore.legendDisplay).toBe(false);

  await selectOverlay(page, 601);

  await expect.poll(async () => {
    const info = await readChartInfo(page);
    return info ? info.datasetCount : null;
  }).toBe(2);

  const infoAfter = await readChartInfo(page);
  expect(infoAfter.legendDisplay).toBe(true);
  expect(infoAfter.legendItemsCount).toBe(1);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O11 — lifecycle: no leaked Chart instance after navigating away
// ===========================================================================

test('O11 — selecting an overlay then navigating Home leaves zero live Chart instances', async ({ page }) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  await selectOverlay(page, 601);
  await expect.poll(async () => {
    const info = await readChartInfo(page);
    return info ? info.datasetCount : null;
  }).toBe(2);

  await page.goto('/index.html#/');
  await expect(page.locator('section.home')).toBeVisible();
  await expect.poll(() => liveChartInstanceCount(page)).toBe(0);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// O12 — range change with an overlay selected issues zero GETs
// ===========================================================================

test('O12 — changing the date range with an overlay selected issues ZERO additional entries GETs', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_MANUAL, T_WORKOUT, T_CALORIES]);
  const getRequests = await routeEntries(page, { 501: METRIC_ENTRIES, 601: WORKOUT_ENTRIES, 602: [] });
  await seedOverlaySelection(page, { 501: ['601'] });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(2);
  const countBefore = getRequests.length;

  await page.locator('.detail-range[data-range="6m"]').click();
  await expect(page.locator('section.detail')).toHaveAttribute('data-range', '6m');

  expect(getRequests.length).toBe(countBefore);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});
