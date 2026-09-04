// E2E tests for the Step 2.3 trackable detail screen (js/views/detail.js):
// per-trackable shell, one-shot range-scoped entries load, and the range
// control, mounted at #/t/:id per CONTRACT-2.3.md. Written strictly against
// that contract's §3 (DOM contract/behaviour) and §4.2 (test plan, cases D1
// through D11) — the implementation is being written in parallel by another
// agent and is not visible here.
//
// Do NOT start a server here and do NOT hardcode the base URL or viewport;
// both are supplied by playwright.config.mjs (baseURL 127.0.0.1:8123,
// 390x844 viewport). Reuses the exact interception mechanics established in
// tests/e2e/home.test.mjs (read first, per the task brief).
//
// GUARDRAIL (docs/ORCHESTRATION.md / CONTRACT-2.3.md): nothing in this file
// may create, modify, or delete a real Supabase row. Every PostgREST call
// the app makes is intercepted with page.route() and fully fulfilled/aborted
// from fixtures — this file makes ZERO real network calls to Supabase,
// verified per-test via installGuard().

import { test, expect } from '@playwright/test';
import { addDays } from '../../js/dates.js';

// MANDATORY MECHANIC #1: block service workers for every test in this file.
// sw.js installs a `fetch` event handler that proxies every request through
// itself. Requests that originate from *inside* a service worker are NOT
// visible to page.route() — Playwright's request interception only sees
// requests made by the page/document, so if the SW is allowed to install and
// take over fetch, our route() fixtures silently stop applying and the app
// hits the LIVE Supabase database instead. Blocking service workers entirely
// sidesteps that.
test.use({ serviceWorkers: 'block' });

// --- fixtures -----------------------------------------------------------

// A boolean trackable — value_shape:'boolean' means bounds/overlay can never
// apply (contract §2.3), so this is the fixture for D2 (exactly two slots).
const T_BOOL = {
  id: 1,
  name: 'Workout',
  value_shape: 'boolean',
  relog_semantic: 'state',
  aggregation: 'count',
  direction: 'build',
  unit: null,
  bounds_enabled: false,
  color: null,
  sort_order: 0,
  archived: false,
};

// The primary fixture for most cases: numeric, bounds_enabled:true, direction
// 'break' (so .detail-direction should read "less is better" if asserted).
// id 366 is chosen to match CONTRACT-2.3.md's own §3.3 DOM-contract example
// verbatim ("Calories" / "kcal" / id 366).
const T_NUM_BOUNDS = {
  id: 366,
  name: 'Calories',
  value_shape: 'numeric',
  relog_semantic: 'state',
  aggregation: 'sum',
  direction: 'break',
  unit: 'kcal',
  bounds_enabled: true,
  bounds_mode: 'auto',
  bound_lower: null,
  bound_upper: null,
  color: '#34c759',
  sort_order: 1,
  archived: false,
};

// A second, non-archived trackable whose only job is to make
// otherTrackableCount > 0 for T_NUM_BOUNDS, so the overlay slot appears
// (contract §2.3: overlay needs bounds present AND at least one other
// non-archived trackable).
const T_OTHER = {
  id: 2,
  name: 'Weight',
  value_shape: 'numeric',
  relog_semantic: 'state',
  aggregation: 'last',
  direction: 'break',
  unit: 'kg',
  bounds_enabled: false,
  color: null,
  sort_order: 2,
  archived: false,
};

// An archived trackable — included in a couple of GET fixtures to prove
// otherTrackableCount excludes archived rows, per contract §2.3
// ("non-archived trackables other than this one"). Not required by any
// single lettered case on its own, but cheap to fold into fixtures that
// already assert slot counts.
const T_ARCHIVED_OTHER = {
  id: 3,
  name: 'Old',
  value_shape: 'numeric',
  bounds_enabled: false,
  color: null,
  sort_order: 3,
  archived: true,
};

// Compute "today" the same way the app must (local calendar components, NOT
// toISOString, which reads UTC and is wrong for part of every day) — same
// mechanics as tests/e2e/home.test.mjs and tests/e2e/trackable.test.mjs.
const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// NOTE: this file used to also compute FROM_3M/FROM_6M/FROM_1Y here (via the
// real addDays from js/dates.js) to check the mount GET's entry_date=gte.
// bound for each range. Step D.6b removed that bound entirely — the mount
// load now fetches the whole history with no from/to at all (see D5), and a
// range change is a local filter with zero requests (see D6/D7) — so those
// constants no longer have anything to check and were removed rather than
// left dead.

// A "past day of the current month" fixture date — the 1st of the CURRENT
// month, deliberately, not an arbitrary offset: guarantees it falls inside
// the default 3m range's `from` bound (90 days always exceeds the distance
// from the 1st of a month to any day within it) without depending on what
// day it happens to be run. Same convention as tests/e2e/heatmap.test.mjs
// and tests/e2e/weekly.test.mjs's own PAST_DATE (degenerates to "today" only
// on the 1st of the month).
const PAST_DATE = `${TODAY.slice(0, 7)}-01`;

// --- route helpers -----------------------------------------------------
//
// Same priority trick as tests/e2e/home.test.mjs: the broad catch-all guard
// is registered FIRST (lowest priority) and the narrow, per-endpoint
// handlers are registered AFTER it in each test (higher priority). Anything
// left over falls through to the guard, which records and aborts it.

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

// Single fixed fixture regardless of which trackable id is being queried —
// good enough for every case except D10, which needs per-trackable data.
// Returns `getRequests`, an array of { url } this test can assert counts/
// query-strings on — this is what D5/D6/D7 key their assertions off of.
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

// D10 needs the entries response to depend on which trackable was
// requested (api.js's listEntries sends trackable_id=in.(<id>)) — this
// keys a fixture map by trackable id string and returns whichever matches
// the request URL.
async function routeEntriesByTrackable(page, fixturesById) {
  const getRequests = [];
  await page.route('**/rest/v1/entries*', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') {
      await route.abort();
      return;
    }
    const url = req.url();
    getRequests.push({ url });
    let body = [];
    for (const [id, fixture] of Object.entries(fixturesById)) {
      if (url.includes(`trackable_id=in.(${id})`)) {
        body = fixture;
        break;
      }
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  return { getRequests };
}

function chartSlotKeys(page) {
  return page.locator('.chart-slot').evaluateAll((els) => els.map((el) => el.getAttribute('data-slot')));
}

// Step D.6b (D14): a route that inspects the requested offset= and serves a
// different fixture per page, so the test can prove the client actually
// issues a SECOND request when the first page comes back exactly
// ENTRIES_PAGE_SIZE (1000) long, and stops after a short page.
async function routeEntriesPaged(page, { page1 = [], page2 = [] } = {}) {
  const getRequests = [];
  await page.route('**/rest/v1/entries*', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') {
      await route.abort();
      return;
    }
    const url = req.url();
    getRequests.push({ url });
    let body = [];
    if (url.includes('offset=0')) body = page1;
    else if (url.includes('offset=1000')) body = page2;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  return { getRequests };
}

// `count` consecutive calendar dates, ascending, the last one being
// `endDate` — built via the real addDays so this never drifts from
// js/dates.js's own local-calendar arithmetic.
function buildConsecutiveDates(endDate, count) {
  const dates = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    dates.push(addDays(endDate, -i));
  }
  return dates;
}

// Repeatedly clicks the heatmap's prev-month nav until .heatmap[data-month]
// reaches targetMonth, bounded so a wiring bug can never hang the suite.
// maxClicks is 400, not a tighter bound: D12/D13/D15 walk from the CURRENT
// month back to the fixed 2024-01 fixture date, and that distance grows by
// one click every month that passes in real time — a bound of 40 (a little
// over 3 years) would itself start failing this suite in 2027, long before
// any real wiring bug would need catching.
async function navigateHeatmapToMonth(page, targetMonth, maxClicks = 400) {
  const heatmap = page.locator('.heatmap');
  const prev = page.locator('.hm-nav[data-heatmap-nav="prev"]');
  for (let i = 0; i < maxClicks; i += 1) {
    const month = await heatmap.getAttribute('data-month');
    if (month === targetMonth) return true;
    await prev.click();
  }
  return (await heatmap.getAttribute('data-month')) === targetMonth;
}

// ===========================================================================
// D1 — basic ready render
// ===========================================================================

test('D1 — #/t/366 renders section.detail[data-detail-state="ready"] with name, unit, and an edit link', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM_BOUNDS, T_OTHER]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');

  const section = page.locator('section.detail');
  await expect(section).toHaveAttribute('data-detail-state', 'ready');
  await expect(section).toHaveAttribute('data-trackable-id', '366');
  await expect(section.locator('.detail-name')).toHaveText('Calories');
  await expect(section.locator('.detail-unit')).toHaveText('kcal');
  const edit = section.locator('a.detail-edit');
  await expect(edit).toHaveAttribute('href', '#/t/366/edit');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D2 — boolean trackable: exactly two slots
// ===========================================================================

test('D2 — a boolean trackable shows exactly two .chart-slots (heatmap, weekly) in that DOM order', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOOL]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/1');

  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.chart-slot')).toHaveCount(2);
  const keys = await chartSlotKeys(page);
  assertOrder(keys, ['heatmap', 'weekly']);

  expect(unexpected).toEqual([]);
});

function assertOrder(actual, expected) {
  expect(actual).toEqual(expected);
}

// ===========================================================================
// D3 — numeric + bounds_enabled + other trackables present: four slots
// ===========================================================================

test('D3 — a numeric trackable with bounds_enabled:true and other trackables present shows four slots in order heatmap, weekly, bounds, overlay', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM_BOUNDS, T_OTHER, T_ARCHIVED_OTHER]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');

  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.chart-slot')).toHaveCount(4);
  const keys = await chartSlotKeys(page);
  assertOrder(keys, ['heatmap', 'weekly', 'bounds', 'overlay']);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D4 — same trackable as the ONLY trackable: three slots, no overlay
// ===========================================================================

test('D4 — the same bounds-enabled numeric trackable as the ONLY trackable shows three slots — no overlay', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  // Only T_NUM_BOUNDS itself — otherTrackableCount must be 0.
  await routeTrackables(page, [T_NUM_BOUNDS]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');

  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.chart-slot')).toHaveCount(3);
  const keys = await chartSlotKeys(page);
  assertOrder(keys, ['heatmap', 'weekly', 'bounds']);
  expect(keys).not.toContain('overlay');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D5 — default range is 3m, correct aria-pressed; the mount GET loads the
// WHOLE history (Step D.6b), not a range-scoped window
// ===========================================================================

test('D5 — the default range is 3m: aria-pressed="true" on that button only, and the mount GET carries trackable_id=in.(366)/offset=0/limit=1000 with NO entry_date=gte. and NO entry_date=lte. (Step D.6b: the range is a local filter, not a fetch)', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM_BOUNDS, T_OTHER]);
  const { getRequests } = await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');

  const section = page.locator('section.detail');
  await expect(section).toHaveAttribute('data-detail-state', 'ready');
  await expect(section).toHaveAttribute('data-range', '3m');

  const buttons = page.locator('.detail-range');
  await expect(buttons).toHaveCount(4);
  await expect(page.locator('.detail-range[data-range="3m"]')).toHaveAttribute('aria-pressed', 'true');
  for (const key of ['6m', '1y', 'all']) {
    await expect(page.locator(`.detail-range[data-range="${key}"]`)).toHaveAttribute('aria-pressed', 'false');
  }

  // Wait for the load to actually have happened before inspecting the
  // recorded request (mount() awaits loadTrackables() before loadAllEntries()).
  await expect.poll(() => getRequests.length).toBeGreaterThanOrEqual(1);
  const url = getRequests[0].url;
  expect(url).toContain('trackable_id=in.(366)');
  expect(url).toContain('offset=0');
  expect(url).toContain('limit=1000');
  // Assert absence, not a different value — a stray gte./lte. with a wrong
  // bound would still fail this (same discipline as D7's original check).
  expect(url).not.toMatch(/entry_date=gte\./);
  expect(url).not.toMatch(/entry_date=lte\./);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D6 — THE LOAD-ONCE GUARD (highest-value test in this step)
//
// Step D.6b restates this: the whole trackable's history is loaded exactly
// once on mount (Part B), and a range change is now a pure in-memory filter
// (no fetch at all) — so clicking 1Y must add ZERO requests, not one more.
// ===========================================================================

test('D6 — with four slots visible, exactly ONE GET to /rest/v1/entries is issued on load; clicking 1Y changes data-range/aria-pressed but issues NO further request', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  // T_NUM_BOUNDS + T_OTHER => bounds_enabled numeric with otherTrackableCount
  // > 0 => all four slots (heatmap, weekly, bounds, overlay). If any slot
  // fetched its own copy of the entries range, this test would see multiple
  // requests on load instead of 1 — this is exactly the regression
  // BUILD_PLAN Step 2.3 calls out ("3-4 round trips on a phone network").
  await routeTrackables(page, [T_NUM_BOUNDS, T_OTHER]);
  const { getRequests } = await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');

  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.chart-slot')).toHaveCount(4);

  // Assert on the recorded request COUNT, not on any rendered data — the
  // count is the thing this test exists to protect.
  await expect.poll(() => getRequests.length).toBe(1);

  await page.locator('.detail-range[data-range="1y"]').click();

  await expect(page.locator('section.detail')).toHaveAttribute('data-range', '1y');
  await expect(page.locator('.detail-range[data-range="1y"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.detail-range[data-range="3m"]')).toHaveAttribute('aria-pressed', 'false');

  // Step D.6b: a range change is a local filter — a short settle, then
  // still exactly 1 request total (never 2).
  await page.waitForTimeout(300);
  expect(getRequests.length).toBe(1);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D7 — range changes never fetch (Step D.6b restates the old "All range
// omits entry_date=gte." case: now EVERY range button, in turn, must add
// zero requests, because the whole history was already loaded on mount)
// ===========================================================================

test('D7 — range changes never fetch: clicking 6m, then 1y, then all each update data-range/aria-pressed but the request count stays at 1 throughout', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM_BOUNDS, T_OTHER]);
  const { getRequests } = await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  for (const key of ['6m', '1y', 'all']) {
    await page.locator(`.detail-range[data-range="${key}"]`).click();
    await expect(page.locator('section.detail')).toHaveAttribute('data-range', key);
    await expect(page.locator(`.detail-range[data-range="${key}"]`)).toHaveAttribute('aria-pressed', 'true');
    // Short settle, then still exactly 1 request total — never a second one.
    await page.waitForTimeout(300);
    expect(getRequests.length).toBe(1);
  }

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D8 — the chosen range persists across navigation
// ===========================================================================

test('D8 — selecting 6m, navigating to #/ and back to #/t/366 shows data-range="6m" with correct aria-pressed', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM_BOUNDS, T_OTHER]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  await page.locator('.detail-range[data-range="6m"]').click();
  await expect(page.locator('section.detail')).toHaveAttribute('data-range', '6m');

  // Navigate away (home needs its own trackables/entries fixtures, which
  // are already registered above as generic handlers) and back.
  await page.goto('/index.html#/');
  await expect(page.locator('section.home')).toBeVisible();

  await page.goto('/index.html#/t/366');
  const section = page.locator('section.detail');
  await expect(section).toHaveAttribute('data-detail-state', 'ready');
  await expect(section).toHaveAttribute('data-range', '6m');
  await expect(page.locator('.detail-range[data-range="6m"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.detail-range[data-range="3m"]')).toHaveAttribute('aria-pressed', 'false');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D9 — unknown id -> notfound
// ===========================================================================

test('D9 — #/t/99999 renders data-detail-state="notfound" with a link back to #/', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM_BOUNDS, T_OTHER]);
  // Whether or not the implementation issues an entries request for a
  // trackable id that turns out not to exist is unspecified by the
  // contract, so an entries route is registered defensively (harmless
  // either way) rather than asserted on.
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/99999');

  const section = page.locator('section.detail');
  await expect(section).toHaveAttribute('data-detail-state', 'notfound');
  await expect(section.locator('a[href="#/"]')).toBeVisible();
  // Never an empty shell for a missing id (contract §3.3).
  await expect(page.locator('.chart-slot')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D10 — entry count text, singular vs plural
// ===========================================================================

test('D10 — .detail-count reads "1 entry in range" for one entry and "3 entries in range" for three', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOOL, T_NUM_BOUNDS, T_OTHER]);
  await routeEntriesByTrackable(page, {
    1: [{ id: 501, trackable_id: 1, entry_date: TODAY, value: 1, note: null }],
    366: [
      { id: 601, trackable_id: 366, entry_date: TODAY, value: 100, note: null },
      { id: 602, trackable_id: 366, entry_date: addDays(TODAY, -1), value: 200, note: null },
      { id: 603, trackable_id: 366, entry_date: addDays(TODAY, -2), value: 300, note: null },
    ],
  });

  await page.goto('/index.html#/t/1');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.detail-count')).toHaveText('1 entry in range');

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.detail-count')).toHaveText('3 entries in range');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// CONTRACT-2.5.md §3.2/§4.2 — the detail header renders a tinted icon
// ===========================================================================
//
// T_NUM_BOUNDS already carries icon-agnostic fixture data plus a non-null
// color (#34c759); extending it with icon:'dumbbell' here (rather than
// inventing a new fixture) keeps this test's other DOM expectations (name,
// unit, slot count) identical to D1/D3's already-established baseline.

test('ICON-DETAIL1 — the detail header renders .detail-icon[data-icon="dumbbell"] containing an svg, tinted by the trackable colour (CONTRACT-2.5.md §3.2)', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const trackableWithIcon = { ...T_NUM_BOUNDS, icon: 'dumbbell' };
  await routeTrackables(page, [trackableWithIcon, T_OTHER]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');

  const section = page.locator('section.detail');
  await expect(section).toHaveAttribute('data-detail-state', 'ready');

  const icon = section.locator('.detail-icon');
  await expect(icon).toHaveAttribute('data-icon', 'dumbbell');
  await expect(icon.locator('svg')).toHaveCount(1);
  // Same binding regression-guard as home.test.mjs's ICON1: the colour must
  // be REALLY applied (computed style), not merely stored.
  await expect(icon).toHaveCSS('color', 'rgb(52, 199, 89)');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D11 — no uncaught errors, no horizontal scroll, tap targets
// ===========================================================================

test('D11 — no uncaught page errors, documentElement.scrollWidth <= 390, and every .detail-range button is >=44px tall', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err));

  const unexpected = await installGuard(page);
  // Four slots visible — the busiest layout this screen can render.
  await routeTrackables(page, [T_NUM_BOUNDS, T_OTHER]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.chart-slot')).toHaveCount(4);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);

  const buttons = page.locator('.detail-range');
  await expect(buttons).toHaveCount(4);
  const heights = await buttons.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  for (const h of heights) {
    expect(h).toBeGreaterThanOrEqual(44);
  }

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D12 — the calendar reaches the earliest entry regardless of the 3M range
// (Step D.6b, CONTRACT-D.6b.md §2.5)
// ===========================================================================

test('D12 — the calendar reaches the earliest entry regardless of the 3M range', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM_BOUNDS]);
  const { getRequests } = await routeEntries(page, {
    getFixture: [
      { id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null },
      { id: 2, trackable_id: 366, entry_date: '2024-01-15', value: 100, note: null },
    ],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('section.detail')).toHaveAttribute('data-range', '3m');

  // Only PAST_DATE falls inside the default 3m window; 2024-01-15 does not,
  // per the range control's job (contract §2.5: "the range control governs
  // only the trend chart, the bounds chart and the 'N entries in range'
  // line").
  await expect(page.locator('.detail-count')).toHaveText('1 entry in range');

  const reached = await navigateHeatmapToMonth(page, '2024-01');
  expect(reached).toBe(true);

  await expect(page.locator('.hm-nav[data-heatmap-nav="prev"]')).toBeDisabled();

  const loggedCell = page.locator('button.hm-cell[data-date="2024-01-15"]');
  await expect(loggedCell).toHaveCount(1);
  await expect(loggedCell).toHaveAttribute('data-logged', 'true');

  // A day before the earliest entry in the same month reads 'before'
  // (no data), never a false "clean" verdict — CONTRACT-3.1.md §2.8 rule 2.
  const beforeCell = page.locator('.hm-cell[data-cell-state="before"]').first();
  await expect(beforeCell).toHaveCount(1);

  // The whole scenario — mount, several months of prev navigation — is
  // still exactly one logical entries load.
  expect(getRequests.length).toBe(1);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D13 — the calendar ignores the Daily cap (Step D.6b, CONTRACT-D.6b.md
// §2.5): the trend chart's Daily -> 3M cap (Step 3.2c) is a filter on the
// trend/bounds charts only, and no longer limits what the calendar can reach.
// ===========================================================================

test('D13 — the calendar ignores the Daily cap: forcing the trend chart to Daily (which caps the range at 3m and disables 6M/1Y/All) does not stop the calendar reaching the earliest entry', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM_BOUNDS]);
  const { getRequests } = await routeEntries(page, {
    getFixture: [
      { id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null },
      { id: 2, trackable_id: 366, entry_date: '2024-01-15', value: 100, note: null },
    ],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  await page.locator('.trend-period[data-period="day"]').click();
  await expect(page.locator('.trend-period[data-period="day"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('section.detail')).toHaveAttribute('data-range', '3m');
  await expect(page.locator('.detail-range[data-range="6m"]')).toBeDisabled();
  await expect(page.locator('.detail-range[data-range="1y"]')).toBeDisabled();
  await expect(page.locator('.detail-range[data-range="all"]')).toBeDisabled();

  const reached = await navigateHeatmapToMonth(page, '2024-01');
  expect(reached).toBe(true);

  const loggedCell = page.locator('button.hm-cell[data-date="2024-01-15"]');
  await expect(loggedCell).toHaveCount(1);
  await expect(loggedCell).toHaveAttribute('data-logged', 'true');

  expect(getRequests.length).toBe(1);
  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D14 — a history longer than one page is fetched in full (Step D.6b,
// CONTRACT-D.6b.md §1.3): the mount load pages through PostgREST's
// 1,000-row cap, and the calendar/'All' count reflect every row, not just
// the first 1,000.
// ===========================================================================

test('D14 — a history longer than one page is fetched in full', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM_BOUNDS]);

  // Page 1: 1,000 consecutive days ending at PAST_DATE (a short-ish window
  // safely inside the default 3m range). Page 2: 5 more consecutive days
  // immediately before page 1's earliest day — short, so the pager stops.
  const page1Dates = buildConsecutiveDates(PAST_DATE, 1000);
  const page2EndDate = addDays(page1Dates[0], -1);
  const page2Dates = buildConsecutiveDates(page2EndDate, 5);

  const page1 = page1Dates.map((entry_date, i) => ({
    id: i + 1,
    trackable_id: 366,
    entry_date,
    value: 1,
    note: null,
  }));
  const page2 = page2Dates.map((entry_date, i) => ({
    id: 1000 + i + 1,
    trackable_id: 366,
    entry_date,
    value: 1,
    note: null,
  }));

  const { getRequests } = await routeEntriesPaged(page, { page1, page2 });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  await expect.poll(() => getRequests.length).toBe(2);
  expect(getRequests[0].url).toContain('offset=0');
  expect(getRequests[1].url).toContain('offset=1000');
  for (const r of getRequests) {
    expect(r.url).toContain('trackable_id=in.(366)');
    expect(r.url).toContain('limit=1000');
  }

  await page.locator('.detail-range[data-range="all"]').click();
  await expect(page.locator('section.detail')).toHaveAttribute('data-range', 'all');
  await expect(page.locator('.detail-count')).toHaveText('1005 entries in range');

  // Selecting 'All' must not have issued a third request — the whole
  // 1,005-row history was already loaded on mount.
  expect(getRequests.length).toBe(2);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D15 — tapping a day the calendar reaches but the 3M range excludes opens
// an editor pre-filled with that day's value (Step D.6b, CONTRACT-D.6b.md
// §2.7: the day editor reads the tapped day from allEntries, the trackable's
// whole loaded history, not entriesForRange's range-filtered slice).
// ===========================================================================

test('D15 — tapping a day the calendar reaches but the 3M range excludes opens an editor pre-filled with that day\'s value', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM_BOUNDS]);
  const { getRequests } = await routeEntries(page, {
    getFixture: [
      { id: 1, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null },
      { id: 2, trackable_id: 366, entry_date: '2024-01-15', value: 1234, note: null },
    ],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('section.detail')).toHaveAttribute('data-range', '3m');

  const reached = await navigateHeatmapToMonth(page, '2024-01');
  expect(reached).toBe(true);

  await page.locator('button.hm-cell[data-date="2024-01-15"]').click();

  const editor = page.locator('.day-editor[data-date="2024-01-15"]');
  await expect(editor).toHaveCount(1);
  await expect(editor.locator('.day-input')).toHaveValue('1234');
  await expect(editor.locator('.day-clear')).toHaveCount(1);

  // Do NOT click Save/Clear: routeEntries above only fulfills GET and
  // aborts everything else, so a write here would trip nothing useful and
  // is explicitly out of scope for this test (contract-mandated).
  expect(getRequests.length).toBe(1);

  await editor.locator('.day-cancel').click();
  await expect(page.locator('.day-editor')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D16 — a trackable with ZERO entries can still navigate back ~3 months
// (Step D.6b follow-up, CONTRACT-D.6b.md §2.1/§2.5's calendarFrom floor):
// historyFrom([]) is null, so without a floor the calendar for a brand-new
// trackable could not navigate back at all. calendarFrom(entries, today) is
// the earlier of historyFrom(entries) and CALENDAR_FLOOR_DAYS (90) days back
// from today, so a trackable with no entries yet still gets the same ~3
// month reach it had before D.6b.
// ===========================================================================

test('D16 — a trackable with ZERO entries can navigate the calendar back to the CALENDAR_FLOOR_DAYS floor month, and no further', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM_BOUNDS]);
  const { getRequests } = await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  // Computed via the real addDays, not hardcoded — CALENDAR_FLOOR_DAYS is
  // 90, so this is addDays(TODAY, -89)'s month.
  const floorMonth = addDays(TODAY, -89).slice(0, 7);

  const reached = await navigateHeatmapToMonth(page, floorMonth);
  expect(reached).toBe(true);

  await expect(page.locator('.heatmap')).toHaveAttribute('data-month', floorMonth);
  await expect(page.locator('.hm-nav[data-heatmap-nav="prev"]')).toBeDisabled();

  expect(getRequests.length).toBe(1);
  expect(unexpected).toEqual([]);
});
