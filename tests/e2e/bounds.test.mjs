// E2E tests for the Step 3.3 two-bars threshold chart (js/charts/bounds.js,
// rendered inside js/views/detail.js's 'bounds' chart-slot), mounted at
// #/t/:id per CONTRACT-3.3.md. Written strictly against that contract's §3
// (DOM/Chart.js contract), §3.1 (zone shading), §3.2 (gap bridging), §3.3
// (instance lifecycle), §4 (detail.js wiring) and §5.2 (test plan, cases P1
// through P9) — the implementation is being written in parallel by another
// agent and has NOT been read while writing this file.
//
// Do NOT start a server here and do NOT hardcode the base URL or viewport;
// both are supplied by playwright.config.mjs (baseURL 127.0.0.1:8123,
// 390x844 viewport). Reuses the exact interception mechanics established in
// tests/e2e/weekly.test.mjs and tests/e2e/heatmap.test.mjs (both read first,
// per the task brief): a catch-all **/rest/v1/** guard registered FIRST
// that records and aborts anything unclaimed, specific routes registered
// after it, service workers blocked, and expect(unexpected).toEqual([]) in
// every test.
//
// GUARDRAIL (CONTRACT-3.3.md §6 / docs/ORCHESTRATION.md): nothing in this
// file may create, modify, or delete a real Supabase row. Every PostgREST
// call the app makes is intercepted with page.route() and fully
// fulfilled/aborted from fixtures — this file makes ZERO real network calls
// to Supabase.
//
// visibleSlots() (js/views/detail.js, shipped/device-verified) only shows
// the 'bounds' slot when bounds_enabled === true AND value_shape ===
// 'numeric' — every fixture below sets both. The 'overlay' slot additionally
// requires otherTrackableCount > 0, so P2 (which needs all four slots live)
// routes a second trackable alongside the fixture under test.

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

// A manual-bounds numeric trackable — always resolves to status:'ok'
// regardless of how many entries are loaded, which is what most of these
// cases need to isolate the bounds-chart behaviour from the auto-derivation
// cold-start guard (that guard gets its own dedicated fixture, T_AUTO_FEW).
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

// Reversed manual bounds (lower > upper) — CONTRACT-3.3.md §2.2 rule 2:
// status 'invalid', never a silent fallback to auto.
const T_INVALID = {
  ...T_MANUAL,
  id: 503,
  name: 'Weight Invalid',
  bound_lower: 90,
  bound_upper: 80,
};

// Auto-derivation mode with no manual bounds set — used for the cold-start
// case (P5), fed with fewer than MIN_BOUND_READINGS entries.
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

// A second, unrelated trackable — used only by P2 to push otherTrackableCount
// above 0 so visibleSlots() also shows the 'overlay' slot (four slots live).
const T_OTHER = {
  id: 700,
  name: 'Steps',
  value_shape: 'numeric',
  relog_semantic: 'state',
  aggregation: 'sum',
  direction: 'build',
  unit: null,
  bounds_enabled: false,
  bounds_mode: 'auto',
  bound_lower: null,
  bound_upper: null,
  target_type: 'none',
  target_value: null,
  color: '#34c759',
  sort_order: 1,
  archived: false,
};

// Compute "today" the same way the app must (local calendar components, NOT
// toISOString, which reads UTC and is wrong for part of every day) — same
// mechanics as tests/e2e/weekly.test.mjs and tests/e2e/heatmap.test.mjs.
const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// A "past day of the current month" fixture date — the 1st of the CURRENT
// month, deliberately, not an arbitrary offset: guarantees it falls inside
// the default 3m range's `from` bound without depending on what day it
// happens to be run. Same reasoning/caveat as heatmap.test.mjs's PAST_DATE.
const PAST_DATE = `${TODAY.slice(0, 7)}-01`;

// --- route helpers -------------------------------------------------------
//
// Same priority trick as heatmap.test.mjs/weekly.test.mjs: the broad
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

// GET-only: none of these cases write an entry, so POST/DELETE are not
// needed — anything other than GET falls through to installGuard's abort.
async function routeEntries(page, { getFixture = [] } = {}) {
  const getRequests = [];
  await page.route('**/rest/v1/entries*', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') {
      await route.abort();
      return;
    }
    getRequests.push({ url: req.url() });
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
// against the pinned chart.js@4.5.1 UMD build (see tests/e2e/weekly.test
// .mjs's file header, which confirmed this against the real build before
// relying on it).
function liveChartInstanceCount(page) {
  return page.evaluate(() => Object.keys(window.Chart.instances).length);
}

// ===========================================================================
// P1 — basic render (manual bounds)
// ===========================================================================

test('P1 — a manual-bounds numeric trackable renders .bounds with canvas.bounds-canvas inside .chart-slot[data-slot="bounds"]', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_MANUAL]);
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 501, entry_date: PAST_DATE, value: 80, note: null }],
  });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  const bounds = page.locator('.chart-slot[data-slot="bounds"] .bounds');
  await expect(bounds).toHaveCount(1);
  await expect(bounds.locator('canvas.bounds-canvas')).toHaveCount(1);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// P2 — the load-once guard, with all four slots live
// ===========================================================================

test('P2 — with heatmap, weekly, bounds AND overlay all live, loading the detail screen issues exactly ONE GET to /rest/v1/entries', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  // A second trackable pushes otherTrackableCount above 0, which is what
  // makes visibleSlots() also include 'overlay' — see this file's header.
  await routeTrackables(page, [T_MANUAL, T_OTHER]);
  const { getRequests } = await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 501, entry_date: PAST_DATE, value: 80, note: null }],
  });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.chart-slot[data-slot="heatmap"] .heatmap')).toHaveCount(1);
  await expect(page.locator('.chart-slot[data-slot="weekly"] .weekly')).toHaveCount(1);
  await expect(page.locator('.chart-slot[data-slot="bounds"] .bounds')).toHaveCount(1);
  await expect(page.locator('.chart-slot[data-slot="overlay"]')).toHaveCount(1);

  await expect.poll(() => getRequests.length).toBe(1);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// P3 — zone shading actually renders (the feature, not decoration)
// ===========================================================================

test('P3 — the live chart carries all five annotations (below/inBand/above boxes, lowerBound/upperBound lines) at the fixture\'s bounds', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_MANUAL]); // bound_lower:78, bound_upper:85
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 501, entry_date: PAST_DATE, value: 80, note: null }],
  });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.bounds-canvas')).toHaveCount(1);

  const result = await page.evaluate(() => {
    const canvas = document.querySelector('.bounds-canvas');
    const chart = window.Chart.getChart(canvas);
    const annotationOpt = chart && chart.options && chart.options.plugins && chart.options.plugins.annotation;
    const annotations = annotationOpt ? annotationOpt.annotations : null;
    const entries = annotations && typeof annotations === 'object' ? Object.values(annotations) : [];

    function matches(a, wantType, extentCheck) {
      if (!a) return false;
      if (a.type && a.type !== wantType) return false;
      return extentCheck(a);
    }

    const LOWER = 78;
    const UPPER = 85;

    const hasBelowBox = entries.some((a) =>
      matches(a, 'box', (a) => a.yMax === LOWER && (a.yMin === undefined || a.yMin === null))
    );
    const hasInBandBox = entries.some((a) => matches(a, 'box', (a) => a.yMin === LOWER && a.yMax === UPPER));
    const hasAboveBox = entries.some((a) =>
      matches(a, 'box', (a) => a.yMin === UPPER && (a.yMax === undefined || a.yMax === null))
    );
    const hasLowerLine = entries.some((a) =>
      matches(a, 'line', (a) => a.yMin === LOWER || a.yMax === LOWER || a.value === LOWER)
    );
    const hasUpperLine = entries.some((a) =>
      matches(a, 'line', (a) => a.yMin === UPPER || a.yMax === UPPER || a.value === UPPER)
    );

    return {
      hasChart: !!chart,
      annotationCount: entries.length,
      hasBelowBox,
      hasInBandBox,
      hasAboveBox,
      hasLowerLine,
      hasUpperLine,
      seen: entries,
    };
  });

  expect(result.hasChart).toBe(true);
  expect(result.annotationCount).toBe(5);
  expect(result.hasBelowBox).toBe(true);
  expect(result.hasInBandBox).toBe(true);
  expect(result.hasAboveBox).toBe(true);
  expect(result.hasLowerLine).toBe(true);
  expect(result.hasUpperLine).toBe(true);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// P4 — the axis frames both bounds (the RESOLVED scale, not config — the
// Step 3.2c C12 lesson applied to this chart)
// ===========================================================================

test('P4 — the RESOLVED y-axis min/max strictly frame both bounds, and min is strictly above 0 for a weight-like fixture', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_MANUAL]); // bound_lower:78, bound_upper:85
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 501, entry_date: PAST_DATE, value: 80, note: null }],
  });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.bounds-canvas')).toHaveCount(1);

  const result = await page.evaluate(() => {
    const canvas = document.querySelector('.bounds-canvas');
    const chart = window.Chart.getChart(canvas);
    return { min: chart.scales.y.min, max: chart.scales.y.max };
  });

  // THE assertion: read off the LIVE chart instance's resolved scale — not
  // boundsAxisFor's config return, which was already correct in Step 3.2c's
  // D3/D4 regressions while the device still showed the bug.
  expect(result.min).toBeLessThan(78);
  expect(result.max).toBeGreaterThan(85);
  expect(result.min).toBeGreaterThan(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// P5 — cold start: not enough data for auto-derived bounds
// ===========================================================================

test('P5 — an auto fixture with 5 readings (below MIN_BOUND_READINGS) shows "Not enough data yet" and renders no canvas', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_AUTO_FEW]);
  // 5 distinct days, all safely inside the default 3m window, counting
  // backward from today (not forward from PAST_DATE, which could overrun
  // "today" on the 1st-4th of a month).
  const getFixture = [1, 3, 5, 7, 9].map((offset, i) => ({
    id: 900 + i,
    trackable_id: 502,
    entry_date: addDays(TODAY, -offset),
    value: 78 + i,
    note: null,
  }));
  await routeEntries(page, { getFixture });

  await page.goto('/index.html#/t/502');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  const bounds = page.locator('.chart-slot[data-slot="bounds"] .bounds');
  await expect(bounds).toHaveCount(1);
  await expect(bounds.locator('.bounds-summary')).toContainText('Not enough data yet');
  await expect(bounds.locator('canvas')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// P6 — the summary is the non-colour cue (WCAG 1.4.1)
// ===========================================================================

test('P6 — a fixture whose latest reading is above the upper bound shows "Above range" in .bounds-summary with data-zone="above"', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_MANUAL]); // bound_lower:78, bound_upper:85
  await routeEntries(page, {
    getFixture: [
      // An older, in-band reading, so the "most recent finite value" logic
      // is genuinely exercised rather than trivially satisfied by there
      // being only one entry.
      { id: 1, trackable_id: 501, entry_date: addDays(TODAY, -10), value: 80, note: null },
      // TODAY's reading, above the upper bound (85) — always inside the
      // visible range, since `to` is always TODAY (resolveRange).
      { id: 2, trackable_id: 501, entry_date: TODAY, value: 90, note: null },
    ],
  });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  const summary = page.locator('.chart-slot[data-slot="bounds"] .bounds-summary');
  await expect(summary).toContainText('Above range');
  await expect(summary).toHaveAttribute('data-zone', 'above');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// P7 — invalid manual config
// ===========================================================================

test('P7 — invalid manual bounds (lower > upper) shows the invalid message and renders no canvas', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_INVALID]); // bound_lower:90, bound_upper:80
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 503, entry_date: PAST_DATE, value: 80, note: null }],
  });

  await page.goto('/index.html#/t/503');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  const bounds = page.locator('.chart-slot[data-slot="bounds"] .bounds');
  await expect(bounds).toHaveCount(1);
  await expect(bounds.locator('.bounds-summary')).toHaveText('Bounds need a low and a high value.');
  await expect(bounds.locator('canvas')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// P8 — layout hygiene
// ===========================================================================

test('P8 — no uncaught page errors, no horizontal scroll at 390px, and .bounds-canvas-wrap has a genuinely non-zero rendered height', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err));

  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_MANUAL]);
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 501, entry_date: PAST_DATE, value: 80, note: null }],
  });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.bounds-canvas')).toHaveCount(1);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);

  // The collapsed-wrapper failure mode this case exists to catch: with
  // maintainAspectRatio:false, the canvas fills its parent — a parent with
  // no CSS height collapses to 0px and every attribute-level assertion
  // above (canvas exists, has the right class) would still pass on a
  // completely invisible chart. Assert the REAL rendered box, not an
  // attribute — same lesson as tests/e2e/weekly.test.mjs's X7.
  const wrapBox = await page.locator('.bounds-canvas-wrap').evaluate((el) => el.getBoundingClientRect());
  expect(wrapBox.height).toBeGreaterThan(0);
  expect(wrapBox.width).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
});

// ===========================================================================
// P9 — no leaked Chart instance (now TWO charts on this screen: weekly and
// bounds — assert the live count does not grow past that)
// ===========================================================================

test('P9 — changing range repeatedly, and navigating away and back, never leaves more than the weekly+bounds pair of live Chart instances', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_MANUAL]);
  await routeEntries(page, {
    getFixture: [{ id: 1, trackable_id: 501, entry_date: PAST_DATE, value: 80, note: null }],
  });

  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.weekly-canvas')).toHaveCount(1);
  await expect(page.locator('.bounds-canvas')).toHaveCount(1);

  // Exactly two live Chart instances after the initial render: weekly's
  // trend chart and this step's bounds chart. The heatmap is hand-rolled
  // CSS grid (BUILD_PLAN Architecture decisions), not Chart.js, and overlay
  // stays an unimplemented placeholder per contract §5.
  await expect.poll(() => liveChartInstanceCount(page)).toBe(2);

  // Re-render repeatedly via the range control — each click re-runs
  // detail.js's render(), which per contract §3.3 must destroy the
  // previous bounds instance (and weekly's own, per its own contract)
  // before creating new ones. If it didn't, the count would grow by two on
  // every click instead of staying pinned at 2.
  for (const range of ['6m', '1y', 'all', '3m', '6m']) {
    await page.locator(`.detail-range[data-range="${range}"]`).click();
    await expect(page.locator('section.detail')).toHaveAttribute('data-range', range);
    await expect.poll(() => liveChartInstanceCount(page)).toBe(2);
  }

  // Navigate away entirely: detail.js's unmount() must call destroyBounds()
  // (alongside destroyWeekly()) per contract §4.2, leaving zero live
  // instances while off-screen.
  await page.goto('/index.html#/');
  await expect(page.locator('section.home')).toBeVisible();
  await expect.poll(() => liveChartInstanceCount(page)).toBe(0);

  // And back again: exactly two instances, not four — the destroy-before-
  // create in render() and the destroy-on-unmount don't double-fire into a
  // stuck state, and a fresh mount creates exactly one new instance of each.
  await page.goto('/index.html#/t/501');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => liveChartInstanceCount(page)).toBe(2);

  expect(unexpected).toEqual([]);
});
