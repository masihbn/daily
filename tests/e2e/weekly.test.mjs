// E2E tests for the Step 3.2 weekly trend chart (js/charts/weekly.js,
// rendered inside js/views/detail.js's 'weekly' chart-slot), mounted at
// #/t/:id per CONTRACT-3.2.md. Written strictly against that contract's §3
// (DOM/Chart.js contract), §4 (instance lifecycle), §5 (detail.js wiring)
// and §6.2 (test plan, cases X1 through X7) — the implementation is being
// written in parallel by another agent and has NOT been read while writing
// this file.
//
// Do NOT start a server here and do NOT hardcode the base URL or viewport;
// both are supplied by playwright.config.mjs (baseURL 127.0.0.1:8123,
// 390x844 viewport). Reuses the exact interception mechanics established in
// tests/e2e/heatmap.test.mjs and tests/e2e/detail.test.mjs (both read first,
// per the task brief): a catch-all **/rest/v1/** guard registered FIRST
// that records and aborts anything unclaimed, specific routes registered
// after it, service workers blocked, and expect(unexpected).toEqual([]) in
// every test.
//
// GUARDRAIL (CONTRACT-3.2.md §7 / docs/ORCHESTRATION.md): nothing in this
// file may create, modify, or delete a real Supabase row. Every PostgREST
// call the app makes is intercepted with page.route() and fully
// fulfilled/aborted from fixtures — this file makes ZERO real network calls
// to Supabase.
//
// Chart.js instance registry, verified live against the pinned chart.js
// v4.5.1 UMD build before writing X4/X5 (not assumed from memory): the
// minified source defines `static instances = Cn` where `Cn` is a plain
// object literal (`const Cn = {}`), NOT an array. The Chart constructor
// does `Cn[this.id] = this` and `destroy()` does `delete Cn[this.id]`. So
// the correct live-instance count is `Object.keys(Chart.instances).length`,
// not `Chart.instances.length`. Confirmed by loading the real index.html in
// a headless browser and creating/destroying a real chart against it.
//
// chartjs-plugin-annotation v3.1.0's UMD build self-registers: its factory
// ends with `t.Chart.register(ee), ee` — meaning simply loading the
// <script> tag in index.html (already the case since Step 0.3) registers
// the plugin with the global Chart namespace, with NO app-code
// `Chart.register(...)` call required. Confirmed live:
// `Chart.registry.plugins.get('annotation')` returns the exact same object
// as the UMD global `window['chartjs-plugin-annotation']`, immediately
// after page load and before any chart has been created. So weekly.js is
// free to build a chart with `options.plugins.annotation.annotations`
// directly; the plugin normalizes each entry (Chart.js adds an `id` field
// matching the annotation's key) and applies it without any extra
// registration step — which is what X5 reads back to prove the target line
// actually reached the chart's live options.

import { test, expect } from '@playwright/test';
import { addDays } from '../../js/dates.js';

// MANDATORY MECHANIC #1: block service workers for every test in this file.
// sw.js installs a `fetch` event handler that proxies every request through
// itself. Requests that originate from *inside* a service worker are NOT
// visible to page.route() — if the SW is allowed to install and take over
// fetch, our route() fixtures silently stop applying and the app hits the
// LIVE Supabase database instead. Blocking service workers entirely
// sidesteps that.
test.use({ serviceWorkers: 'block' });

// --- fixtures ---------------------------------------------------------

// The contract's own worked example: aggregation:'sum' + target_type:
// 'weekly_average' + target_value:1700 — the exact combination the whole
// step exists to handle correctly (§0(a)). id 366 matches this project's
// established "Calories" fixture convention (heatmap.test.mjs,
// detail.test.mjs).
const T_CALORIES = {
  id: 366,
  name: 'Calories',
  value_shape: 'numeric',
  relog_semantic: 'state',
  aggregation: 'sum',
  direction: 'break',
  unit: 'kcal',
  bounds_enabled: false,
  bounds_mode: 'auto',
  bound_lower: null,
  bound_upper: null,
  target_type: 'weekly_average',
  target_value: 1700,
  color: '#34c759',
  sort_order: 0,
  archived: false,
};

// CONTRACT-3.2c fixture: aggregation:'last' (a LEVEL, not an amount) with a
// single value of 80 and no target — the exact device-reported "Weight axis
// shows 0-80" regression (§0(c)/C12). target_type:'none' so no annotation
// competes with the axis-bounds assertion.
const T_WEIGHT = {
  id: 501,
  name: 'Weight',
  value_shape: 'numeric',
  relog_semantic: 'state',
  aggregation: 'last',
  direction: 'break',
  unit: 'kg',
  bounds_enabled: false,
  bounds_mode: 'auto',
  bound_lower: null,
  bound_upper: null,
  target_type: 'none',
  target_value: null,
  color: '#5856d6',
  sort_order: 1,
  archived: false,
};

// CONTRACT-3.2c fixture: aggregation:'count' (an AMOUNT ACCUMULATED) with a
// genuine weekly_count target of 3 — used for C13 (bar type) and C16 (the
// scaled-target label, 3 -> 12 in Monthly view).
const T_WORKOUT = {
  id: 602,
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
  color: '#ff9500',
  sort_order: 2,
  archived: false,
};

// Compute "today" the same way the app must (local calendar components, NOT
// toISOString, which reads UTC and is wrong for part of every day) — same
// mechanics as tests/e2e/home.test.mjs, detail.test.mjs and heatmap.test.mjs.
const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// A "past day of the current month" fixture date — the 1st of the CURRENT
// month, deliberately, not an arbitrary offset: guarantees it falls inside
// the default 3m range's `from` bound (90 days always exceeds the distance
// from the 1st of a month to any day within it) without depending on what
// day it happens to be run. Same reasoning/caveat as heatmap.test.mjs's
// PAST_DATE (degenerates to "today" only on the 1st of the month).
const PAST_DATE = `${TODAY.slice(0, 7)}-01`;

// --- route helpers -------------------------------------------------------
//
// Same priority trick as heatmap.test.mjs/detail.test.mjs: the broad
// catch-all guard is registered FIRST (lowest priority) and the narrow,
// per-endpoint handlers are registered AFTER it in each test (higher
// priority). Anything left over falls through to the guard, which records
// and aborts it.

// MANDATORY MECHANIC #2: every route() below is registered before the
// corresponding page.goto() in each test.

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

// getDelayMs is new for CONTRACT-3.2b's B16 (U1 loading-state case): every
// other existing call site omits it (defaults to 0), so this is additive
// and does not change any existing test's behaviour.
async function routeEntries(page, { getFixture = [], getDelayMs = 0 } = {}) {
  const getRequests = [];
  await page.route('**/rest/v1/entries*', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') {
      await route.abort();
      return;
    }
    getRequests.push({ url: req.url() });
    if (getDelayMs) await new Promise((resolve) => setTimeout(resolve, getDelayMs));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(getFixture),
    });
  });
  return { getRequests };
}

// Reads the live count of Chart.js instances. Chart.instances is a plain
// object keyed by chart id ({ [id]: instance }), NOT an array — verified
// against the pinned chart.js@4.5.1 UMD build (see the file header).
// Object.keys(...).length is therefore the correct count, not `.length`.
function liveChartInstanceCount(page) {
  return page.evaluate(() => Object.keys(window.Chart.instances).length);
}

// ===========================================================================
// X1 — basic render
// ===========================================================================

test('X1 — .chart-slot[data-slot="weekly"] contains .weekly with canvas.weekly-canvas, and window.Chart is defined', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CALORIES]);
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null }],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  const weekly = page.locator('.chart-slot[data-slot="weekly"] .weekly');
  await expect(weekly).toHaveCount(1);
  await expect(weekly.locator('canvas.weekly-canvas')).toHaveCount(1);

  const hasChart = await page.evaluate(() => typeof window.Chart !== 'undefined');
  expect(hasChart).toBe(true);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// X2 — the load-once guard still holds with heatmap AND weekly both live
// ===========================================================================

test('X2 — with both the heatmap and the weekly chart live, loading the detail screen issues exactly ONE GET to /rest/v1/entries', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CALORIES]);
  const { getRequests } = await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null }],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.chart-slot[data-slot="heatmap"] .heatmap')).toHaveCount(1);
  await expect(page.locator('.chart-slot[data-slot="weekly"] .weekly')).toHaveCount(1);

  await expect.poll(() => getRequests.length).toBe(1);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// X3 — the meaning line states plainly what the bars are (§0(a) on screen)
// ===========================================================================

test('X3 — for the Calories fixture (aggregation:sum, target_type:weekly_average), .weekly-meaning reads "Average per week · kcal"', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CALORIES]);
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null }],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  await expect(page.locator('.weekly-meaning')).toHaveText('Average per week · kcal');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// X4 — no leaked Chart instance (the "tooltips from the previous chart" bug)
// ===========================================================================

test('X4 — changing range repeatedly, and navigating away and back, never leaves more than one live Chart instance', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CALORIES]);
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null }],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.weekly-canvas')).toHaveCount(1);

  // Exactly one live Chart instance after the initial render — the heatmap
  // is hand-rolled CSS grid (BUILD_PLAN Architecture decisions), not
  // Chart.js, and bounds/overlay stay as unimplemented placeholders per
  // contract §5, so weekly.js's chart is the only Chart.js consumer on this
  // screen at this step.
  await expect.poll(() => liveChartInstanceCount(page)).toBe(1);

  // Re-render repeatedly via the range control — each click re-runs
  // detail.js's render(), which per contract §4 must destroy the previous
  // instance before creating a new one. If it didn't, the count would grow
  // by one on every click instead of staying pinned at 1.
  for (const range of ['6m', '1y', 'all', '3m', '6m']) {
    await page.locator(`.detail-range[data-range="${range}"]`).click();
    await expect(page.locator('section.detail')).toHaveAttribute('data-range', range);
    await expect.poll(() => liveChartInstanceCount(page)).toBe(1);
  }

  // Navigate away entirely: detail.js's unmount() must call destroyWeekly()
  // per contract §5.4, leaving zero live instances while off-screen.
  await page.goto('/index.html#/');
  await expect(page.locator('section.home')).toBeVisible();
  await expect.poll(() => liveChartInstanceCount(page)).toBe(0);

  // And back again: exactly one instance, not two (i.e. the destroy-before-
  // create in render() and the destroy-on-unmount don't double-fire into a
  // stuck state, and a fresh mount creates exactly one new chart).
  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => liveChartInstanceCount(page)).toBe(1);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// X5 — the target line renders
// ===========================================================================

test('X5 — the annotation plugin is registered, and the live chart carries an annotation at the target value (1700)', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CALORIES]);
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null }],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.weekly-canvas')).toHaveCount(1);

  const result = await page.evaluate(() => {
    const canvas = document.querySelector('.weekly-canvas');
    const chart = window.Chart.getChart(canvas);
    const pluginRegistered = !!window.Chart.registry.plugins.get('annotation');
    const annotationOpt = chart && chart.options && chart.options.plugins && chart.options.plugins.annotation;
    const annotations = annotationOpt ? annotationOpt.annotations : null;
    let foundAtTarget = false;
    const seen = [];
    if (annotations && typeof annotations === 'object') {
      for (const key of Object.keys(annotations)) {
        const a = annotations[key];
        seen.push(a);
        if (a && (a.yMin === 1700 || a.yMax === 1700 || a.value === 1700)) {
          foundAtTarget = true;
        }
      }
    }
    return {
      hasChart: !!chart,
      pluginRegistered,
      hasAnnotationOption: !!annotationOpt,
      foundAtTarget,
      seen,
    };
  });

  expect(result.hasChart).toBe(true);
  expect(result.pluginRegistered).toBe(true);
  expect(result.hasAnnotationOption).toBe(true);
  expect(result.foundAtTarget).toBe(true);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// X6 — empty state
// ===========================================================================
//
// NOTE on why this must select the 'all' range rather than relying on the
// default 3m view with zero entries: per contract §2.6 step 2, when `from`
// is well-formed (which the 3m/6m/1y ranges always resolve to a concrete
// date, never null), the window's lower bound comes from `from` regardless
// of whether any entries exist — so an empty entries fixture under the
// default 3m range still produces a fully zero-filled, non-empty series
// (the whole point of §0(c), zero-entry weeks are never omitted). The
// isEmpty:true branch is reachable only when `from` is null (the 'all'
// range) AND there are no entries at all to derive a lower bound from. This
// was worked out from the contract's algorithm, not guessed.

test('X6 — a trackable with NO entries at all, on the "all" range, renders .weekly-empty and creates no canvas', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CALORIES]);
  const { getRequests } = await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBeGreaterThanOrEqual(1);

  await page.locator('.detail-range[data-range="all"]').click();
  await expect(page.locator('section.detail')).toHaveAttribute('data-range', 'all');

  const weekly = page.locator('.chart-slot[data-slot="weekly"] .weekly');
  await expect(weekly).toHaveCount(1);
  await expect(weekly.locator('.weekly-empty')).toHaveText('Not enough data yet.');
  await expect(weekly.locator('canvas')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// X7 — layout: no page errors, no horizontal scroll, real wrapper height
// ===========================================================================

test('X7 — no uncaught page errors, no horizontal scroll at 390px, and .weekly-canvas-wrap has a genuinely non-zero rendered height', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err));

  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CALORIES]);
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null }],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.weekly-canvas')).toHaveCount(1);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);

  // The collapsed-wrapper failure mode this case exists to catch: with
  // maintainAspectRatio:false, the canvas fills its parent — a parent with
  // no CSS height collapses to 0px and every attribute-level assertion
  // above (canvas exists, has the right class) would still pass on a
  // completely invisible chart. Assert the REAL rendered box, not an
  // attribute.
  const wrapBox = await page
    .locator('.weekly-canvas-wrap')
    .evaluate((el) => el.getBoundingClientRect());
  expect(wrapBox.height).toBeGreaterThan(0);
  expect(wrapBox.width).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
});

// ===========================================================================
// CONTRACT-3.2b §5 / §6.3 — U1 fix: per-chart loading state (cases B16-B17)
//
// Root cause (§0): detail.js painted charts from cache first, then
// re-rendered after entries loaded — provisional content snapping to real
// content ~1s later online. The fix adds `chartsPending`, true from mount()
// until the first loadEntriesForRange() settles, during which every visible
// chart slot shows ONLY a `.chart-slot-loading` placeholder in place of its
// chart. `.chart-slot-loading` does not exist at all pre-fix.
// ===========================================================================

test('B16 — U1: every visible chart slot shows the loading placeholder until the (delayed) entries response resolves, then shows real charts; still exactly one entries GET', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CALORIES]);
  const { getRequests } = await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null }],
    getDelayMs: 800,
  });

  await page.goto('/index.html#/t/366');

  const heatmapSlot = page.locator('.chart-slot[data-slot="heatmap"]');
  const weeklySlot = page.locator('.chart-slot[data-slot="weekly"]');

  // While the (deliberately delayed) entries GET is still in flight, every
  // visible chart slot must show the loading placeholder and NOT its chart.
  await expect(heatmapSlot.locator('.chart-slot-loading')).toBeVisible();
  await expect(weeklySlot.locator('.chart-slot-loading')).toBeVisible();
  await expect(heatmapSlot.locator('.heatmap')).toHaveCount(0);
  await expect(weeklySlot.locator('.weekly')).toHaveCount(0);

  await expect.poll(() => getRequests.length).toBe(1);

  // After the delayed response resolves: loading placeholders are gone, the
  // real charts are present, and it was still exactly ONE entries GET (the
  // same load-once guard as X2/H2 — this fix must not add a network call).
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(heatmapSlot.locator('.chart-slot-loading')).toHaveCount(0);
  await expect(weeklySlot.locator('.chart-slot-loading')).toHaveCount(0);
  await expect(heatmapSlot.locator('.heatmap')).toHaveCount(1);
  await expect(weeklySlot.locator('.weekly')).toHaveCount(1);

  expect(getRequests.length).toBe(1);

  expect(unexpected).toEqual([]);
});

test('B17 — U1 does not re-trigger on a range change: after the first load completes, changing range never re-shows the loading placeholder', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CALORIES]);
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null }],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.chart-slot-loading')).toHaveCount(0);

  await page.locator('.detail-range[data-range="6m"]').click();
  await expect(page.locator('section.detail')).toHaveAttribute('data-range', '6m');
  await expect(page.locator('.chart-slot-loading')).toHaveCount(0);

  await page.locator('.detail-range[data-range="1y"]').click();
  await expect(page.locator('section.detail')).toHaveAttribute('data-range', '1y');
  await expect(page.locator('.chart-slot-loading')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// B18 — CONTRACT-3.2b D3 end to end: the live chart's resolved y-axis max
// must sit strictly above the target, not on the border where it renders
// but cannot be seen.
// ===========================================================================

test('B18 — D3 end to end: the live chart\'s resolved y-axis max is strictly greater than the target value', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CALORIES]); // target_value: 1700
  await routeEntries(page, {
    // A single entry whose week-average equals the target exactly (1700) —
    // the precise D3 scenario: data max === target, so a naive data-derived
    // axis max lands exactly on the target line.
    getFixture: [{ id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 1700, note: null }],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.weekly-canvas')).toHaveCount(1);

  const resolvedMax = await page.evaluate(() => {
    const canvas = document.querySelector('.weekly-canvas');
    const chart = window.Chart.getChart(canvas);
    return chart.scales.y.max;
  });

  expect(resolvedMax).toBeGreaterThan(1700);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// CONTRACT-3.2c — Selectable granularity (Daily / Weekly / Monthly)
// ===========================================================================

// ===========================================================================
// C12 — THE WEIGHT REGRESSION, and the most important case in this step.
//
// A unit test on chart CONFIG (axisBoundsFor) already passed while the
// device showed a 0-80 axis, because a bar chart forces 0 into its scale
// regardless of suggestedMin — only the library's RESOLVED scale at render
// time exposes that override. This reads Chart.getChart(canvas).scales.y,
// NOT axisBoundsFor's return value and NOT chart.options.
// ===========================================================================

test('C12 — THE WEIGHT REGRESSION: for a single-value "last" fixture, the RESOLVED y-axis min is strictly above 0, and the live chart type is "line"', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_WEIGHT]);
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 501, entry_date: PAST_DATE, value: 80, note: null }],
  });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.weekly-canvas')).toHaveCount(1);

  const result = await page.evaluate(() => {
    const canvas = document.querySelector('.weekly-canvas');
    const chart = window.Chart.getChart(canvas);
    return {
      type: chart.config.type,
      min: chart.scales.y.min,
      max: chart.scales.y.max,
    };
  });

  // THE assertion: the RESOLVED scale, read off the live chart instance —
  // not axisBoundsFor's config, which was already correct and already
  // passing while the device showed 0-80.
  expect(result.type).toBe('line');
  expect(result.min).toBeGreaterThan(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// C13 — a genuine sum/count fixture still renders a bar chart
// ===========================================================================

test('C13 — a count-aggregation fixture renders config.type === "bar"', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_WORKOUT]);
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 602, entry_date: PAST_DATE, value: 1, note: null }],
  });

  await page.goto('/index.html#/t/602');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.weekly-canvas')).toHaveCount(1);

  const type = await page.evaluate(() => {
    const canvas = document.querySelector('.weekly-canvas');
    const chart = window.Chart.getChart(canvas);
    return chart.config.type;
  });

  expect(type).toBe('bar');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// C14 — switching period issues ZERO requests when the range does not change
//
// RACE-RULE CARE: asserting the request count did NOT change is vacuous
// unless something first proves the re-render actually happened. This polls
// the live chart's own data.labels until they genuinely differ from the
// pre-click snapshot, before checking the request count.
// ===========================================================================

test('C14 — switching period issues ZERO new entries requests when the range is unchanged, and the chart genuinely re-renders', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CALORIES]);
  const { getRequests } = await routeEntries(page, {
    getFixture: [
      { id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null },
      { id: 2, trackable_id: 366, entry_date: addDays(PAST_DATE, 3), value: 700, note: null },
    ],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.weekly-canvas')).toHaveCount(1);
  await expect.poll(() => getRequests.length).toBe(1);
  const countBefore = getRequests.length;

  const labelsBefore = await page.evaluate(() => {
    const canvas = document.querySelector('.weekly-canvas');
    return window.Chart.getChart(canvas).data.labels.slice();
  });

  await page.locator('.trend-period[data-period="month"]').click();
  await expect(page.locator('.trend-period[data-period="month"]')).toHaveAttribute('aria-pressed', 'true');

  // Proof the re-render actually happened: the chart's OWN data, not a DOM
  // attribute flip (an optimistic aria-pressed toggle is not evidence the
  // chart rebuilt).
  await expect
    .poll(async () => {
      const labelsNow = await page.evaluate(() => {
        const canvas = document.querySelector('.weekly-canvas');
        const chart = window.Chart.getChart(canvas);
        return chart ? chart.data.labels.slice() : null;
      });
      return JSON.stringify(labelsNow) !== JSON.stringify(labelsBefore);
    })
    .toBe(true);

  // Only now, with genuine proof of re-render in hand, is "the count did not
  // change" a meaningful assertion rather than a vacuous one.
  expect(getRequests.length).toBe(countBefore);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// C15 — the Daily cap (§0(b))
// ===========================================================================

test('C15 — the Daily cap: clicking Daily disables 6M/1Y/All and forces the range to 3m; leaving Daily re-enables them and range stays at 3m', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CALORIES]);
  const { getRequests } = await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null }],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  // Start from 1Y so the Daily click below has to actively switch range.
  await page.locator('.detail-range[data-range="1y"]').click();
  await expect(page.locator('section.detail')).toHaveAttribute('data-range', '1y');
  await expect.poll(() => getRequests.length).toBeGreaterThanOrEqual(1);

  const countBeforeDaily = getRequests.length;
  await page.locator('.trend-period[data-period="day"]').click();

  // Step D.6b: the range control is now a pure in-memory filter over the
  // whole history loaded once on mount (CONTRACT-D.6b.md §2.4) — even the
  // Daily cap's forced range-window change (1y -> 3m) no longer reloads.
  // This used to be "the one case allowed to reload"; it no longer is. Wait
  // for the real DOM-level proof the range actually changed, then assert
  // ZERO new requests, not just that the click resolved.
  await expect(page.locator('section.detail')).toHaveAttribute('data-range', '3m');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await page.waitForTimeout(300);
  expect(getRequests.length).toBe(countBeforeDaily);

  await expect(page.locator('.trend-period[data-period="day"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('section.detail')).toHaveAttribute('data-range', '3m');

  await expect(page.locator('.detail-range[data-range="6m"]')).toBeDisabled();
  await expect(page.locator('.detail-range[data-range="1y"]')).toBeDisabled();
  await expect(page.locator('.detail-range[data-range="all"]')).toBeDisabled();
  await expect(page.locator('.detail-range[data-range="3m"]')).toBeEnabled();

  // Leaving Daily (back to Weekly) re-enables the range buttons. No auto-
  // restore: range stays at 3m (predictable beats clever).
  await page.locator('.trend-period[data-period="week"]').click();
  await expect(page.locator('.trend-period[data-period="week"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.detail-range[data-range="6m"]')).toBeEnabled();
  await expect(page.locator('.detail-range[data-range="1y"]')).toBeEnabled();
  await expect(page.locator('.detail-range[data-range="all"]')).toBeEnabled();
  await expect(page.locator('section.detail')).toHaveAttribute('data-range', '3m');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// C16 — the scaled target is labelled (§0(a) on screen)
// ===========================================================================

test('C16 — a weekly_count target of 3 renders a scaled annotation at 12 in Monthly view, labelled with "12"; no annotation at all in Daily view', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_WORKOUT]);
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 602, entry_date: PAST_DATE, value: 1, note: null }],
  });

  await page.goto('/index.html#/t/602');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.weekly-canvas')).toHaveCount(1);

  await page.locator('.trend-period[data-period="month"]').click();
  await expect(page.locator('.trend-period[data-period="month"]')).toHaveAttribute('aria-pressed', 'true');

  function readAnnotation() {
    return page.evaluate(() => {
      const canvas = document.querySelector('.weekly-canvas');
      const chart = window.Chart.getChart(canvas);
      if (!chart) return { hasChart: false, foundAt12: false, labelHas12: false, keyCount: 0 };
      const annotationOpt = chart.options && chart.options.plugins && chart.options.plugins.annotation;
      const annotations = annotationOpt ? annotationOpt.annotations : null;
      let foundAt12 = false;
      let labelHas12 = false;
      const keys = annotations && typeof annotations === 'object' ? Object.keys(annotations) : [];
      for (const key of keys) {
        const a = annotations[key];
        if (a && (a.yMin === 12 || a.yMax === 12 || a.value === 12)) {
          foundAt12 = true;
          const content = a.label && a.label.content;
          if (typeof content === 'string' && content.includes('12')) labelHas12 = true;
          if (Array.isArray(content) && content.some((c) => String(c).includes('12'))) labelHas12 = true;
        }
      }
      return { hasChart: true, foundAt12, labelHas12, keyCount: keys.length };
    });
  }

  // Proof the Monthly re-render actually landed before asserting on its
  // content: poll until the scaled annotation genuinely appears.
  await expect.poll(async () => (await readAnnotation()).foundAt12).toBe(true);

  const monthResult = await readAnnotation();
  expect(monthResult.foundAt12).toBe(true);
  expect(monthResult.labelHas12).toBe(true);

  // Now switch to Daily: weekly_count has NO line on a daily chart at all.
  await page.locator('.trend-period[data-period="day"]').click();
  await expect(page.locator('.trend-period[data-period="day"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  await expect.poll(async () => (await readAnnotation()).keyCount).toBe(0);
  const dayResult = await readAnnotation();
  expect(dayResult.hasChart).toBe(true);
  expect(dayResult.keyCount).toBe(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// C17 — period choice persists across navigation (away and back)
// ===========================================================================

test('C17 — the chosen period persists across navigating away (Home) and back', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CALORIES]);
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null }],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  await page.locator('.trend-period[data-period="month"]').click();
  await expect(page.locator('.trend-period[data-period="month"]')).toHaveAttribute('aria-pressed', 'true');

  await page.goto('/index.html#/');
  await expect(page.locator('section.home')).toBeVisible();

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.trend-period[data-period="month"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.trend-period[data-period="day"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.trend-period[data-period="week"]')).toHaveAttribute('aria-pressed', 'false');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// C18 — layout and network hygiene
// ===========================================================================

test('C18 — no uncaught page errors, no horizontal scroll at 390px, .trend-period buttons >= 44px, and still exactly one entries GET on initial load', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err));

  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CALORIES]);
  const { getRequests } = await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null }],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.weekly-canvas')).toHaveCount(1);

  await expect.poll(() => getRequests.length).toBe(1);
  expect(getRequests.length).toBe(1);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);

  const buttons = page.locator('.trend-period');
  const count = await buttons.count();
  expect(count).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < count; i++) {
    const box = await buttons.nth(i).boundingBox();
    expect(box).not.toBeNull();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
});
