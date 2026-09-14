// E2E tests for the #/compare screen (Step 3.5), written strictly against
// CONTRACT-3.5.md's §1 (js/charts/compare.js module contract), §2
// (js/views/compare.js DOM/behaviour) and §6 (cases C1-C12). The
// implementation (js/charts/compare.js, js/views/compare.js, js/main.js's
// wiring) is being written in parallel by another agent from the same
// contract and has NOT been read while writing this file.
//
// Do NOT start a server here and do NOT hardcode the base URL or viewport;
// both are supplied by playwright.config.mjs (baseURL 127.0.0.1:8123, 390x844
// viewport). Reuses the exact interception mechanics established in
// tests/e2e/overlay.test.mjs (read in full before writing this file): a
// catch-all **/rest/v1/** guard registered FIRST that records and aborts
// anything unclaimed, specific routes registered after it, service workers
// blocked, seedSession() in beforeEach, and expect(unexpected).toEqual([])
// in every test.
//
// GUARDRAIL: nothing in this file may create, modify, or delete a real
// Supabase row. Every PostgREST call the app makes is intercepted with
// page.route() and fully fulfilled/aborted from fixtures — ZERO real
// network calls.

import { test, expect } from '@playwright/test';
import { seedSession, installAuthGuard } from '../helpers/e2e-session.mjs';
import { addDays, rangeDays, monthsInRange } from '../../js/dates.js';
import { RANGES, resolveRange } from '../../js/views/detail.js';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await seedSession(page);
});

// --- storage key (CONTRACT-3.5.md §1, literal) ------------------------------

const COMPARE_KEY = 'daily.compare.v1';

// --- fixtures ----------------------------------------------------------------

const T_CALORIES = {
  id: 701,
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
  sort_order: 0,
  archived: false,
};

const T_WORKOUT = {
  id: 702,
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
  color: null,
  sort_order: 1,
  archived: false,
};

const T_WEIGHT = {
  id: 703,
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
  sort_order: 2,
  archived: false,
};

// Never selected in any test — proves archived trackables are excluded from
// the candidate list at all.
const T_ARCHIVED = {
  id: 704,
  name: 'Retired',
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
  color: null,
  sort_order: 3,
  archived: true,
};

const T_EMPTY = {
  id: 705,
  name: 'Empty',
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
  color: null,
  sort_order: 4,
  archived: false,
};

const T_EXTRA1 = {
  id: 706,
  name: 'Extra1',
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
  color: null,
  sort_order: 5,
  archived: false,
};

const T_EXTRA2 = {
  ...T_EXTRA1,
  id: 707,
  name: 'Extra2',
  sort_order: 6,
};

const ALL_TRACKABLES = [T_CALORIES, T_WORKOUT, T_WEIGHT, T_ARCHIVED, T_EMPTY, T_EXTRA1, T_EXTRA2];

// Compute "today" from local calendar components — never toISOString, which
// reads UTC and is wrong for part of every day (same mechanics as
// tests/e2e/overlay.test.mjs / bounds.test.mjs / weekly.test.mjs).
const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// All offsets are < 90 (inside the default 3M window), per CONTRACT-3.5.md
// §6's fixture note. Each numeric series has at least two DISTINCT values in
// the window (needed for C2's "one dataset contains 0 and one contains
// 100"), placed far enough apart (>=1 week) that they land in different
// weekly buckets rather than averaging/overwriting each other.
function entryAt(trackableId, offset, value) {
  return { id: `${trackableId}-${offset}`, trackable_id: trackableId, entry_date: addDays(TODAY, -offset), value, note: null };
}

const CALORIES_ENTRIES = [entryAt(701, 5, 1500), entryAt(701, 40, 2000), entryAt(701, 75, 2500)];
// Three logged days close together (one busy week -> a count > 0 bucket)
// plus one isolated day far away, so the weekly-count series has both a
// genuine zero (an unlogged week) and a genuine high bucket to normalize
// between.
const WORKOUT_ENTRIES = [
  entryAt(702, 10, 1),
  entryAt(702, 11, 1),
  entryAt(702, 12, 1),
  entryAt(702, 50, 1),
];
const WEIGHT_ENTRIES = [entryAt(703, 5, 80), entryAt(703, 40, 75), entryAt(703, 75, 85)];
const EXTRA1_ENTRIES = [entryAt(706, 5, 100), entryAt(706, 20, 50)];
const EXTRA2_ENTRIES = [entryAt(707, 5, 30), entryAt(707, 20, 70)];

const ENTRIES_BY_ID = {
  701: CALORIES_ENTRIES,
  702: WORKOUT_ENTRIES,
  703: WEIGHT_ENTRIES,
  704: [],
  705: [],
  706: EXTRA1_ENTRIES,
  707: EXTRA2_ENTRIES,
};

// --- route helpers (mechanics copied from tests/e2e/overlay.test.mjs) -------

async function installGuard(page) {
  const unexpected = [];
  await page.route('**/rest/v1/**', async (route) => {
    unexpected.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort();
  });
  return unexpected;
}

// Logs every trackables GET so C1 can assert "exactly one request total".
async function routeTrackables(page, trackables) {
  const getRequests = [];
  await page.route('**/rest/v1/trackables*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.abort();
      return;
    }
    getRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(trackables) });
  });
  return getRequests;
}

// ONE handler for /rest/v1/entries*: parses the trackable_id=in.(...) filter
// out of the (URL-decoded) request URL, resolves fixtures per id from
// `fixturesById` (id string -> array of rows, or the string 'ERROR_500' to
// force a 500 for that request), and records every GET's URL + resolved id
// list.
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
        body: JSON.stringify({ message: 'synthetic compare load failure' }),
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

// --- chart / storage / chip readers ------------------------------------------

function liveChartInstanceCount(page) {
  return page.evaluate(() => Object.keys(window.Chart.instances).length);
}

function readChartInfo(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas.compare-canvas');
    const chart = canvas ? window.Chart.getChart(canvas) : null;
    if (!chart) return null;
    const scales = chart.options.scales || {};
    return {
      datasetCount: chart.data.datasets.length,
      datasets: chart.data.datasets.map((ds) => ({
        label: ds.label,
        data: ds.data,
        borderColor: ds.borderColor,
        backgroundColor: ds.backgroundColor,
        pointBackgroundColor: ds.pointBackgroundColor,
        pointRadius: ds.pointRadius,
        pointHoverRadius: ds.pointHoverRadius,
        borderWidth: ds.borderWidth,
        tension: ds.tension,
        spanGaps: ds.spanGaps,
        fill: ds.fill,
      })),
      labels: chart.data.labels,
      yMin: scales.y ? scales.y.min : undefined,
      yMax: scales.y ? scales.y.max : undefined,
      yTitle: scales.y && scales.y.title ? scales.y.title.text : null,
      // The RESOLVED scale (chart.scales, not chart.options.scales) is what
      // afterBuildTicks actually produced — the config alone can't show the
      // fixed [0,25,50,75,100] tick set the amended contract pins.
      yTicks: chart.scales && chart.scales.y ? chart.scales.y.ticks.map((t) => t.value) : null,
      xType: scales.x ? scales.x.type : null,
      legendDisplay:
        chart.options.plugins && chart.options.plugins.legend ? chart.options.plugins.legend.display : undefined,
    };
  });
}

function readCompareStorage(page) {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  }, COMPARE_KEY);
}

async function seedCompareState(page, state) {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, JSON.stringify(value));
    },
    [COMPARE_KEY, state]
  );
}

function chip(page, id) {
  return page.locator(`.compare-chip[data-compare-id="${id}"]`);
}

// Clicks a chip and waits for the synchronous aria-pressed flip to true, then
// (when getRequests/expectedCount are given) waits for the fire-and-forget
// history load triggered by that selection to actually land — the same
// "click, then wait for the genuine network side-effect" discipline
// tests/e2e/overlay.test.mjs's selectOverlay() uses, since aria-pressed flips
// synchronously before the load settles (CONTRACT-3.5.md §2: "write, render,
// loadHistories([id])").
async function selectChip(page, id, getRequests, expectedCount) {
  await chip(page, id).click();
  await expect(chip(page, id)).toHaveAttribute('aria-pressed', 'true');
  if (getRequests && typeof expectedCount === 'number') {
    await expect.poll(() => getRequests.length).toBe(expectedCount);
  }
}

async function deselectChip(page, id) {
  await chip(page, id).click();
  await expect(chip(page, id)).toHaveAttribute('aria-pressed', 'false');
}

function pageErrorCollector(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));
  return errors;
}

// ===========================================================================
// C1 — nothing selected
// ===========================================================================

test('C1 — #/compare with nothing selected: full chip roster (not the archived one), 0 selected, no chart, one request total', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  const trackablesGets = await routeTrackables(page, ALL_TRACKABLES);
  const getRequests = await routeEntries(page, ENTRIES_BY_ID);

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');

  await expect(page.locator('#app')).toHaveAttribute('data-route', 'compare');
  await expect(page.locator('#nav a[href="#/compare"]')).toHaveAttribute('aria-current', 'page');

  await expect(page.locator('.compare-chip')).toHaveCount(6);
  for (const id of [701, 702, 703, 705, 706, 707]) {
    await expect(chip(page, id)).toHaveAttribute('aria-pressed', 'false');
  }
  await expect(chip(page, 704)).toHaveCount(0);

  await expect(page.locator('.compare-hint')).toHaveText('0 selected');
  await expect(page.locator('.detail-range[data-range="3m"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.trend-period[data-period="week"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.compare-empty')).toHaveText('Pick two or more trackables above to compare them.');
  await expect(page.locator('canvas.compare-canvas')).toHaveCount(0);

  expect(trackablesGets.length).toBe(1);
  expect(getRequests.length).toBe(0);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// C2 — selecting two series
// ===========================================================================

test('C2 — selecting Calories then Workout draws a 2-line %-normalized chart with a key, and persists the selection', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  const getRequests = await routeEntries(page, ENTRIES_BY_ID);

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');

  await selectChip(page, 701, getRequests, 1);
  expect(getRequests[0].ids).toEqual(['701']);

  await selectChip(page, 702, getRequests, 2);
  expect(getRequests[1].ids).toEqual(['702']);

  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(2);

  const info = await readChartInfo(page);
  const labels = info.datasets.map((ds) => ds.label);
  expect(labels).toContain('Calories');
  expect(labels).toContain('Workout');
  // CONTRACT-3.5.md §1 amendment (device feedback): the scale itself runs
  // -5..105 so 0%/100% points aren't clipped at the axis edge, while
  // afterBuildTicks pins the visible ticks to exactly 0/25/50/75/100.
  expect(info.yMin).toBe(-5);
  expect(info.yMax).toBe(105);
  expect(info.yTicks).toEqual([0, 25, 50, 75, 100]);
  expect(info.yTitle).toContain('%');

  for (const ds of info.datasets) {
    const nonNull = ds.data.filter((v) => v !== null);
    for (const v of nonNull) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(nonNull).toContain(0);
    expect(nonNull).toContain(100);
  }

  await expect(page.locator('.compare-key .compare-key-item')).toHaveCount(2);
  const caloriesRange = page.locator('.compare-key-item[data-series-id="701"] .compare-key-range');
  await expect(caloriesRange).toContainText('kcal');

  const stored = await readCompareStorage(page);
  expect(stored).toEqual({ ids: ['701', '702'], period: 'week', range: '3m' });
  await expect(page.locator('.compare-hint')).toHaveText('2 selected');

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// C3 — persisted selection loads on mount, in ONE combined request
// ===========================================================================

test('C3 — a persisted 6M/Monthly two-id selection is restored on load with ONE combined entries GET', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  const getRequests = await routeEntries(page, ENTRIES_BY_ID);
  await seedCompareState(page, { ids: ['701', '703'], period: 'month', range: '6m' });

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');

  await expect(chip(page, 701)).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 703)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.detail-range[data-range="6m"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.trend-period[data-period="month"]')).toHaveAttribute('aria-pressed', 'true');

  await expect.poll(() => getRequests.length).toBe(1);
  expect([...getRequests[0].ids].sort()).toEqual(['701', '703']);

  const { from, to } = resolveRange('6m', TODAY);
  const expectedMonths = monthsInRange(from, to).length;

  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(2);

  const info = await readChartInfo(page);
  for (const ds of info.datasets) {
    expect(ds.data.length).toBe(expectedMonths);
  }

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// C4 — tooltip callbacks
// ===========================================================================

test('C4 — the tooltip label callback reports "Name: raw unit (pct%)" and the title callback reports the raw bucket key', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  const getRequests = await routeEntries(page, ENTRIES_BY_ID);

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');

  await selectChip(page, 701, getRequests, 1);
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(1);

  const dataIndex = await page.evaluate(() => {
    const canvas = document.querySelector('canvas.compare-canvas');
    const chart = window.Chart.getChart(canvas);
    return chart.data.datasets[0].data.findIndex((v) => v !== null);
  });
  expect(dataIndex).toBeGreaterThanOrEqual(0);

  const label = await page.evaluate(
    (idx) => {
      const canvas = document.querySelector('canvas.compare-canvas');
      const chart = window.Chart.getChart(canvas);
      return chart.options.plugins.tooltip.callbacks.label({ datasetIndex: 0, dataIndex: idx });
    },
    dataIndex
  );
  expect(label).toMatch(/^Calories: [\d.]+ kcal \(\d+%\)$/);

  const title = await page.evaluate(
    (idx) => {
      const canvas = document.querySelector('canvas.compare-canvas');
      const chart = window.Chart.getChart(canvas);
      return chart.options.plugins.tooltip.callbacks.title([{ dataIndex: idx }]);
    },
    dataIndex
  );
  // Default granularity is Weekly — the raw key behind the formatted axis
  // label is a 'YYYY-Www' bucket key.
  expect(title).toMatch(/^\d{4}-W\d{2}$/);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// C5 — granularity changes re-bucket with zero GETs; Daily snaps the range
// ===========================================================================

test('C5 — switching Weekly -> Monthly -> Daily re-buckets already-loaded data with zero GETs; Daily snaps the range to 3M and disables the wider options', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  const getRequests = await routeEntries(page, ENTRIES_BY_ID);

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');
  await selectChip(page, 701, getRequests, 1);
  await selectChip(page, 702, getRequests, 2);
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(2);
  const countBefore = getRequests.length;

  const { from: from3m } = resolveRange('3m', TODAY);
  const expectedMonths = monthsInRange(from3m, TODAY).length;
  const expectedDays = rangeDays(from3m, TODAY).length;
  expect(expectedDays).toBe(90);

  await page.locator('.trend-period[data-period="month"]').click();
  await expect(page.locator('.trend-period[data-period="month"]')).toHaveAttribute('aria-pressed', 'true');
  expect(getRequests.length).toBe(countBefore);
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasets[0].data.length : null;
    })
    .toBe(expectedMonths);

  await page.locator('.trend-period[data-period="day"]').click();
  await expect(page.locator('.trend-period[data-period="day"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.detail-range[data-range="3m"]')).toHaveAttribute('aria-pressed', 'true');
  for (const key of ['6m', '1y', 'all']) {
    await expect(page.locator(`.detail-range[data-range="${key}"]`)).toBeDisabled();
  }
  expect(getRequests.length).toBe(countBefore);

  const infoAtDay = await readChartInfo(page);
  expect(infoAtDay.datasets[0].data.length).toBe(expectedDays);
  for (const ds of infoAtDay.datasets) {
    expect(ds.pointRadius).toBe(0);
  }

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// C6 — deselecting is a pure local action
// ===========================================================================

test('C6 — deselecting a chip removes its dataset locally with NO additional GET and rewrites storage', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  const getRequests = await routeEntries(page, ENTRIES_BY_ID);

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');
  await selectChip(page, 701, getRequests, 1);
  await selectChip(page, 702, getRequests, 2);
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(2);
  const countBefore = getRequests.length;

  await deselectChip(page, 702);

  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(1);
  expect(getRequests.length).toBe(countBefore);

  const stored = await readCompareStorage(page);
  expect(stored.ids).toEqual(['701']);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// C7 — selecting an empty trackable
// ===========================================================================

test('C7 — selecting a trackable with no entries in range is listed as skipped, draws nothing new, but still counts toward the hint', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  const getRequests = await routeEntries(page, ENTRIES_BY_ID);

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');
  await selectChip(page, 701, getRequests, 1);
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(1);

  await selectChip(page, 705, getRequests, 2);

  await expect(page.locator('.compare-skipped')).toContainText('Empty');
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(1);
  await expect(page.locator('.compare-hint')).toHaveText('2 selected');

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// C8 — the soft warning above RECOMMENDED_MAX_SERIES
// ===========================================================================

test('C8 — selecting a 5th series with data shows the soft warning; dropping back to 4 clears it', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  const getRequests = await routeEntries(page, ENTRIES_BY_ID);

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');

  let expected = 0;
  for (const id of [701, 702, 703, 706, 707]) {
    expected += 1;
    await selectChip(page, id, getRequests, expected);
  }

  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(5);
  const warning = page.locator('.compare-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAttribute('role', 'status');

  await deselectChip(page, 707);

  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(4);
  await expect(page.locator('.compare-warning')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// C9 — a failed load
// ===========================================================================

test('C9 — a 500 on one series keeps its chip pressed, draws only the others, shows the offline banner, never throws, and a retry issues a fresh GET', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  const fixturesWithError = { ...ENTRIES_BY_ID, 702: 'ERROR_500' };
  const getRequests = await routeEntries(page, fixturesWithError);

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');

  await selectChip(page, 701, getRequests, 1);
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(1);

  await chip(page, 702).click();
  await expect(chip(page, 702)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => getsForId(getRequests, 702).length).toBe(1);

  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(1);
  await expect(page.locator('.detail-offline')).toBeVisible();
  await expect(page.locator('.detail-offline')).toHaveText('You appear to be offline — showing the last saved data.');

  // Clear (local, no network) then re-select — the failed id was never
  // marked loaded, so re-selecting must issue a NEW GET.
  await deselectChip(page, 702);
  await chip(page, 702).click();
  await expect(chip(page, 702)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => getsForId(getRequests, 702).length).toBe(2);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// C10 — lifecycle: leaving and returning
// ===========================================================================

test('C10 — navigating Home destroys the compare Chart instance; returning restores the selection from storage with one combined GET', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  const getRequests = await routeEntries(page, ENTRIES_BY_ID);

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');
  await selectChip(page, 701, getRequests, 1);
  await selectChip(page, 702, getRequests, 2);
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(2);

  const countBeforeHome = getRequests.length; // the two compare-selection GETs above

  await page.goto('/index.html#/');
  await expect(page.locator('section.home')).toBeVisible();
  await expect.poll(() => liveChartInstanceCount(page)).toBe(0);

  // Home's own mount paints synchronously from the (already-warm) store
  // cache — data-home-state can already read "ready" before Home's own
  // entries GET (fired only after its own `await st.loadTrackables()`) has
  // landed. Wait on the actual observable instead: Home issues exactly ONE
  // entries GET, so poll for the count to land at exactly +1 over the two
  // compare-selection GETs — if Home ever issued more than one, this poll
  // fails loudly rather than silently accepting an inflated baseline.
  await expect.poll(() => getRequests.length).toBe(countBeforeHome + 1);
  const countBeforeReturn = getRequests.length;

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');

  await expect(chip(page, 701)).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 702)).toHaveAttribute('aria-pressed', 'true');

  await expect.poll(() => getRequests.length).toBe(countBeforeReturn + 1);
  const restoreReq = getRequests[getRequests.length - 1];
  expect([...restoreReq.ids].sort()).toEqual(['701', '702']);

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
// C11 — a stale persisted id is dropped and rewritten
// ===========================================================================

test('C11 — a persisted stale id is dropped on load (no GET ever names it) and storage is rewritten to just the real id', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  const getRequests = await routeEntries(page, ENTRIES_BY_ID);
  // '999' is not a real trackable; sanitizeCompareIds must drop it and keep
  // the genuine id that follows it.
  await seedCompareState(page, { ids: ['999', '701'] });

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');

  await expect(chip(page, 701)).toHaveAttribute('aria-pressed', 'true');

  await expect.poll(() => getRequests.length).toBe(1);
  expect(getRequests.some((r) => r.ids.includes('999'))).toBe(false);
  expect(getRequests[0].ids).toEqual(['701']);

  await expect.poll(async () => readCompareStorage(page)).toEqual({ ids: ['701'], period: 'week', range: '3m' });

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// C12 — an illegal persisted Daily/1Y combination is reconciled
// ===========================================================================

test('C12 — a persisted Daily period with a 1Y range snaps the range to 3M on load and rewrites storage', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  const getRequests = await routeEntries(page, ENTRIES_BY_ID);
  await seedCompareState(page, { ids: [], period: 'day', range: '1y' });

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');

  await expect(page.locator('.trend-period[data-period="day"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.detail-range[data-range="3m"]')).toHaveAttribute('aria-pressed', 'true');
  for (const key of ['6m', '1y', 'all']) {
    await expect(page.locator(`.detail-range[data-range="${key}"]`)).toBeDisabled();
  }

  await expect.poll(async () => readCompareStorage(page)).toEqual({ ids: [], period: 'day', range: '3m' });
  expect(getRequests.length).toBe(0);
  expect(RANGES.some((r) => r.key === '3m')).toBe(true);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// Step U.5 (CONTRACT-U.5.md) — one control bar, the key list as an
// interactive legend above the chart, an Expand button, and the
// #/compare/chart fullscreen view. The implementation (js/views/compare.js,
// js/charts/compare.js's render/opts, js/views/fullscreen.js's `kind:
// 'compare'`, js/router.js, js/main.js) is being written in parallel by
// another agent from CONTRACT-U.5.md and has NOT been read while writing
// these cases. Every case below is CONTRACT-U.5.md §8's CU-1..CU-6, exactly.
// ===========================================================================

// Waits for the chart to have drawn exactly `count` datasets — the same
// poll-on-readChartInfo idiom every case above already uses.
async function waitForDatasetCount(page, count) {
  await expect
    .poll(async () => {
      const info = await readChartInfo(page);
      return info ? info.datasetCount : null;
    })
    .toBe(count);
}

// ===========================================================================
// CU-1 — one control bar: ranges left of periods, on one row
// ===========================================================================

test('CU-1 — .compare-controls holds .detail-ranges and .trend-periods side by side on one row', async ({ page }) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  await routeEntries(page, ENTRIES_BY_ID);

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');

  const controls = page.locator('.compare-controls');
  const ranges = controls.locator('.detail-ranges');
  const periods = controls.locator('.trend-periods');
  await expect(ranges).toHaveCount(1);
  await expect(periods).toHaveCount(1);

  const rangesBox = await ranges.boundingBox();
  const periodsBox = await periods.boundingBox();
  expect(rangesBox).not.toBeNull();
  expect(periodsBox).not.toBeNull();
  expect(Math.abs(rangesBox.y - periodsBox.y)).toBeLessThanOrEqual(2);
  expect(rangesBox.x).toBeLessThan(periodsBox.x);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// CU-2 — the chip row scrolls horizontally, all chips on one row
// ===========================================================================

test('CU-2 — with 6 candidates, all .compare-chip boxes sit on one row and .compare-chips scrolls horizontally', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  await routeEntries(page, ENTRIES_BY_ID);

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');

  const chips = page.locator('.compare-chip');
  await expect(chips).toHaveCount(6);

  const boxes = [];
  for (let i = 0; i < 6; i += 1) {
    const box = await chips.nth(i).boundingBox();
    expect(box).not.toBeNull();
    boxes.push(box);
  }
  const firstY = boxes[0].y;
  for (const box of boxes) {
    expect(Math.abs(box.y - firstY)).toBeLessThanOrEqual(2);
  }

  const overflowX = await page.locator('.compare-chips').evaluate((el) => getComputedStyle(el).overflowX);
  expect(['auto', 'scroll']).toContain(overflowX);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// CU-3 — the key list is the legend: ordered above the chart, tappable
// ===========================================================================

test('CU-3 — .compare-key precedes the canvas, each item is a >=44px toggle that hides/shows its series', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  const getRequests = await routeEntries(page, ENTRIES_BY_ID);

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');
  await selectChip(page, 701, getRequests, 1);
  await selectChip(page, 702, getRequests, 2);
  await waitForDatasetCount(page, 2);

  const order = await page.evaluate(() => {
    const key = document.querySelector('.compare-key');
    const wrap = document.querySelector('.compare-canvas-wrap');
    if (!key || !wrap) return null;
    // Node.DOCUMENT_POSITION_FOLLOWING === 4: true when `wrap` comes AFTER
    // `key` in document order, i.e. the key precedes the canvas wrap.
    return !!(key.compareDocumentPosition(wrap) & 4);
  });
  expect(order).toBe(true);

  const items = page.locator('.compare-key-item');
  await expect(items).toHaveCount(2);

  const firstItem = items.first();
  const firstToggle = firstItem.locator('.compare-key-toggle');
  await expect(firstItem).toHaveAttribute('data-hidden', 'false');
  await expect(firstToggle).toHaveAttribute('aria-pressed', 'true');
  const toggleBox = await firstToggle.boundingBox();
  expect(toggleBox).not.toBeNull();
  expect(toggleBox.height).toBeGreaterThanOrEqual(44);

  await firstToggle.click();
  await expect(firstToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(firstItem).toHaveAttribute('data-hidden', 'true');
  const hiddenLabel = await firstToggle.getAttribute('aria-label');
  expect(hiddenLabel.startsWith('Show')).toBe(true);

  await firstToggle.click();
  await expect(firstToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(firstItem).toHaveAttribute('data-hidden', 'false');
  const shownLabel = await firstToggle.getAttribute('aria-label');
  expect(shownLabel.startsWith('Hide')).toBe(true);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// CU-4 — the Expand button only exists once there is something to expand
// ===========================================================================

test('CU-4 — .chart-expand[data-expand="compare"] is absent with 0 selected and visible with >=1 selected', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  const getRequests = await routeEntries(page, ENTRIES_BY_ID);

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');

  const expandBtn = page.locator('button.chart-expand[data-expand="compare"]');
  await expect(expandBtn).toHaveCount(0);

  await selectChip(page, 701, getRequests, 1);
  await waitForDatasetCount(page, 1);

  await expect(expandBtn).toBeVisible();

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// CU-5 — Expand opens #/compare/chart (the U.4 fullscreen view, kind
// 'compare'); range changes there persist to daily.compare.v1; Close
// returns to a #/compare that reflects the change
// ===========================================================================

test('CU-5 — Expand opens the compare fullscreen view; a range change there persists and survives Close', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  const getRequests = await routeEntries(page, ENTRIES_BY_ID);

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');
  await selectChip(page, 701, getRequests, 1);
  await selectChip(page, 702, getRequests, 2);
  await waitForDatasetCount(page, 2);

  const expandBtn = page.locator('button.chart-expand[data-expand="compare"]');
  await expect(expandBtn).toBeVisible();
  await expandBtn.click();

  await page.waitForURL(/#\/compare\/chart$/);

  const fsSection = page.locator('section.fullscreen[data-kind="compare"]');
  await expect(fsSection).toHaveAttribute('data-fs-state', 'ready');
  await expect(page.locator('#nav')).toBeHidden();

  const leftAxis = page.locator('.fs-axis[data-side="left"]');
  await expect(leftAxis).toHaveCount(1);
  // Inside (possibly rotated) section.fullscreen — layout width via
  // offsetWidth through evaluate, never boundingBox() (see
  // tests/e2e/fullscreen.test.mjs's F1/F3 comments: boundingBox() is
  // screen-space and gets swapped by the CSS rotation).
  const leftAxisWidth = await leftAxis.evaluate((el) => el.offsetWidth);
  expect(leftAxisWidth).toBeGreaterThan(0);

  await expect(page.locator('.fs-track canvas')).toHaveCount(1);

  const rangeBtn = page.locator('.fs-range[data-range="1y"]');
  await rangeBtn.click();
  await expect(rangeBtn).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem('daily.compare.v1');
        return raw ? JSON.parse(raw).range : null;
      })
    )
    .toBe('1y');

  await page.locator('.fs-close').click();
  await page.waitForURL(/#\/compare$/);

  await expect(page.locator('section.compare-view')).toBeVisible();
  await expect(page.locator('.detail-range[data-range="1y"]')).toHaveAttribute('aria-pressed', 'true');

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// CU-6 — opening #/compare/chart directly with zero persisted ids renders
// the empty state, drawing no chart
// ===========================================================================

test('CU-6 — #/compare/chart with zero persisted ids renders data-fs-state="empty" with the pick-more-trackables message', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  const getRequests = await routeEntries(page, ENTRIES_BY_ID);
  // Exact stored shape per js/charts/compare.js's DEFAULT_COMPARE_STATE.
  await seedCompareState(page, { ids: [], period: 'week', range: '3m' });

  await page.goto('/index.html#/compare/chart');

  const fsSection = page.locator('section.fullscreen[data-kind="compare"]');
  await expect(fsSection).toHaveAttribute('data-fs-state', 'empty');
  await expect(page.locator('.fs-status')).toHaveText('Pick two or more trackables to compare them.');
  await expect(page.locator('.fs-track canvas')).toHaveCount(0);

  // Fewer than one id means the mount never reaches its entries load step
  // (CONTRACT-U.5.md §4: the empty-state branch returns before "load
  // entries for the ids").
  expect(getRequests.length).toBe(0);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// CU-7 — the fullscreen canvas fills its stage without overflowing it
// (orchestrator addition, post-U.5: a real bug seen in screenshots — the
// canvas sized itself by Chart.js's default aspect ratio instead of the
// stage's actual box). offsetHeight/clientHeight are LAYOUT values, so they
// are safe to compare directly even though the portrait section is rotated
// on screen (same reasoning as the offsetWidth reads above and in
// tests/e2e/fullscreen.test.mjs's F1/F3 comments).
// ===========================================================================

async function assertCanvasFillsStage(page) {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  await routeEntries(page, ENTRIES_BY_ID);
  await seedCompareState(page, { ids: ['701', '702'], period: 'week', range: '3m' });

  await page.goto('/index.html#/compare/chart');

  const fsSection = page.locator('section.fullscreen[data-kind="compare"]');
  await expect(fsSection).toHaveAttribute('data-fs-state', 'ready');

  // Chart.js's responsive ResizeObserver resizes the canvas a frame or two
  // after data-fs-state="ready" is set — a single read can catch the
  // pre-resize height even when the eventual layout is correct, so poll
  // instead of reading once.
  async function readSizes() {
    return page.evaluate(() => {
      const canvas = document.querySelector('.fs-track canvas');
      const stage = document.querySelector('.fs-stage');
      return canvas && stage ? { canvas: canvas.offsetHeight, stage: stage.clientHeight } : null;
    });
  }

  let lastSizes = null;
  await expect
    .poll(
      async () => {
        lastSizes = await readSizes();
        return lastSizes ? lastSizes.canvas <= lastSizes.stage && lastSizes.canvas >= lastSizes.stage - 40 : false;
      },
      { timeout: 5000 }
    )
    .toBe(true);

  // Assert the actual numbers once more with the same inequalities, so a
  // failure here still reports the real values rather than just "expected
  // true" from the boolean poll above.
  expect(lastSizes).not.toBeNull();
  expect(lastSizes.canvas).toBeLessThanOrEqual(lastSizes.stage);
  expect(lastSizes.canvas).toBeGreaterThanOrEqual(lastSizes.stage - 40);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
}

test('CU-7 — portrait viewport: the canvas height stays within 40px of the stage height, never exceeding it', async ({
  page,
}) => {
  await assertCanvasFillsStage(page);
});

test.describe('CU-7 — landscape viewport', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('the canvas height stays within 40px of the stage height, never exceeding it (not rotated)', async ({
    page,
  }) => {
    await assertCanvasFillsStage(page);
  });
});

// ===========================================================================
// CONTRACT-U.7.md §2/§6 — the .empty component wraps Compare's none state
// (the "0 selected" empty message, glyph 'compare'). Existing text is
// unchanged. The implementation is being written in parallel from the same
// contract and is not visible here.
// ===========================================================================

test('U7-3 — with zero selected, p.compare-empty.empty contains .empty__glyph svg and the existing text', async ({
  page,
}) => {
  const pageErrors = pageErrorCollector(page);
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, ALL_TRACKABLES);
  await routeEntries(page, ENTRIES_BY_ID);

  await page.goto('/index.html#/compare');
  await expect(page.locator('section.compare-view')).toHaveAttribute('data-compare-state', 'ready');

  const empty = page.locator('p.compare-empty.empty');
  await expect(empty).toHaveCount(1);
  await expect(empty.locator('.empty__glyph svg')).toHaveCount(1);
  await expect(empty).toHaveText('Pick two or more trackables above to compare them.');

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});
