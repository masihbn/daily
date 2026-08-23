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

// Expected `from` bounds, computed via the REAL addDays from js/dates.js —
// exactly the mechanism CONTRACT-2.3.md §2.2 mandates resolveRange use
// internally (`addDays(today, -(days-1))`), so these are an independent
// check on the app's arithmetic, not a copy of any hardcoded table.
const FROM_3M = addDays(TODAY, -(90 - 1));
const FROM_6M = addDays(TODAY, -(180 - 1));
const FROM_1Y = addDays(TODAY, -(365 - 1));

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
// D5 — default range is 3m, correct aria-pressed, correct entries bounds
// ===========================================================================

test('D5 — the default range is 3m: aria-pressed="true" on that button only, and the entries GET carries the resolveRange("3m", today) bounds', async ({
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
  // recorded request (mount() awaits loadTrackables() before loadEntries()).
  await expect.poll(() => getRequests.length).toBeGreaterThanOrEqual(1);
  const url = getRequests[0].url;
  expect(url).toContain(`entry_date=gte.${FROM_3M}`);
  expect(url).toContain(`entry_date=lte.${TODAY}`);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D6 — THE LOAD-ONCE GUARD (highest-value test in this step)
// ===========================================================================

test('D6 — with four slots visible, exactly ONE GET to /rest/v1/entries is issued on load; clicking 1Y issues exactly one more (two total) with the new gte bound', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  // T_NUM_BOUNDS + T_OTHER => bounds_enabled numeric with otherTrackableCount
  // > 0 => all four slots (heatmap, weekly, bounds, overlay). If any slot
  // fetched its own copy of the entries range, this test would see 3-4
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

  // Exactly one MORE request — two total — never three or four.
  await expect.poll(() => getRequests.length).toBe(2);

  const secondUrl = getRequests[1].url;
  expect(secondUrl).toContain(`entry_date=gte.${FROM_1Y}`);
  expect(secondUrl).toContain(`entry_date=lte.${TODAY}`);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// D7 — the "All" range omits entry_date=gte. entirely
// ===========================================================================

test('D7 — selecting the "All" range issues a request with NO entry_date=gte. parameter at all (asserted on absence, not on a different value)', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM_BOUNDS, T_OTHER]);
  const { getRequests } = await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  await page.locator('.detail-range[data-range="all"]').click();
  await expect(page.locator('section.detail')).toHaveAttribute('data-range', 'all');
  await expect(page.locator('.detail-range[data-range="all"]')).toHaveAttribute('aria-pressed', 'true');

  await expect.poll(() => getRequests.length).toBe(2);
  const allUrl = getRequests[1].url;

  // Assert the PARAMETER IS ABSENT, not merely that it doesn't equal some
  // specific value — a stray gte. with a wrong bound would still fail this.
  expect(allUrl).not.toMatch(/entry_date=gte\./);
  // 'to' is still always today, per contract §2.2, even for 'all'.
  expect(allUrl).toContain(`entry_date=lte.${TODAY}`);

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
