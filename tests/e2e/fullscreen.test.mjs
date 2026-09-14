// E2E tests for the Step U.4 fullscreen chart view (js/views/fullscreen.js)
// and its `#/t/:id/chart/:kind` route, per CONTRACT-U.4.md §4 (markup/
// behaviour), §5 (js/main.js wiring), §6 (the detail screen's Expand
// buttons) and §9 (cases F1-F9). The implementation (js/router.js,
// js/charts/scroll.js, js/views/fullscreen.js, js/main.js, js/views/
// detail.js, css/styles.css) is being written in parallel by another agent
// and has NOT been read while writing this file.
//
// Do NOT start a server here and do NOT hardcode the base URL or viewport;
// both are supplied by playwright.config.mjs (baseURL 127.0.0.1:8123, a
// 390x844 default viewport). Reuses the exact interception mechanics
// established in tests/e2e/detail.test.mjs and tests/e2e/overlay.test.mjs
// (both read in full before writing this file): a catch-all **/rest/v1/**
// guard registered FIRST that records and aborts anything unclaimed,
// specific routes registered after it, service workers blocked,
// seedSession()/installAuthGuard() from tests/helpers/e2e-session.mjs, and
// expect(unexpected).toEqual([]) (plus the auth guard's own) in every test.
//
// GUARDRAIL (CONTRACT-U.4.md / docs/ORCHESTRATION.md): nothing in this file
// may create, modify, or delete a real Supabase row. Every PostgREST call
// the app makes is intercepted with page.route() and fully fulfilled/
// aborted from fixtures — ZERO real network calls.

import { test, expect } from '@playwright/test';
import { seedSession, installAuthGuard } from '../helpers/e2e-session.mjs';
import { addDays } from '../../js/dates.js';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await seedSession(page);
});

// --- storage keys (CONTRACT-U.4.md §4, literal, read off js/views/
// detail.js's own RANGE_STORAGE_KEY/PERIOD_STORAGE_KEY/OVERLAY_STORAGE_KEY
// constants) ---------------------------------------------------------------

const RANGE_KEY = 'daily.detail.range.v1';
const PERIOD_KEY = 'daily.detail.period.v1';
const OVERLAY_KEY = 'daily.detail.overlay.v1';

// --- fixtures ----------------------------------------------------------------

// The primary metric: numeric, bounds_enabled with MANUAL bounds (never
// 'insufficient' regardless of how many entries are seeded — mirrors
// tests/e2e/overlay.test.mjs's T_MANUAL/tests/e2e/bounds.test.mjs's
// T_MANUAL exactly), so the Range chart's canvas always renders and F1-F5
// exercise a genuine chart rather than the "not enough data" message.
const T_METRIC = {
  id: 366,
  name: 'Calories',
  value_shape: 'numeric',
  relog_semantic: 'state',
  aggregation: 'sum',
  direction: 'break',
  unit: 'kcal',
  bounds_enabled: true,
  bounds_mode: 'manual',
  bound_lower: 300,
  bound_upper: 800,
  target_type: 'none',
  target_value: null,
  color: '#34c759',
  sort_order: 0,
  archived: false,
};

// A second, non-archived trackable: makes otherTrackableCount > 0 for
// T_METRIC (so the detail screen's overlay slot exists at all — needed for
// F6's expand button to be reachable on a screen shaped like the real app)
// and doubles as F5's overlay candidate.
const T_OTHER = {
  id: 2,
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

// Compute "today" from local calendar components — never toISOString,
// which reads UTC and is wrong for part of every day (same mechanics as
// tests/e2e/detail.test.mjs / overlay.test.mjs).
const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const PAST_DATE = `${TODAY.slice(0, 7)}-01`;

// A couple of entries inside the default 3M window — CONTRACT-U.4.md's own
// note for F3 says the 1Y range's bucket COUNT depends on the range, not on
// how many entries exist, so a small, realistic fixture is enough for every
// case (including F3's "365 * 14" track-width check).
const METRIC_ENTRIES = [
  { id: 1, trackable_id: 366, entry_date: TODAY, value: 500, note: null },
  { id: 2, trackable_id: 366, entry_date: PAST_DATE, value: 600, note: null },
];
const OTHER_ENTRIES = [
  { id: 3, trackable_id: 2, entry_date: TODAY, value: 80, note: null },
  { id: 4, trackable_id: 2, entry_date: PAST_DATE, value: 81, note: null },
];

// --- route helpers -----------------------------------------------------------
//
// Same priority trick as tests/e2e/detail.test.mjs: the broad catch-all
// guard is registered FIRST (lowest priority) and the narrow per-endpoint
// handlers are registered AFTER it in each test.

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
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(trackables) });
  });
}

// One handler for /rest/v1/entries*, keyed by trackable id — same mechanic
// as tests/e2e/overlay.test.mjs's routeEntries (copied locally, not
// imported, per this step's "do not add helper files" boundary): resolves
// the trackable_id=in.(...) filter out of the (URL-decoded) request URL and
// concatenates whichever fixtures match. A single-id fixture map is exactly
// tests/e2e/detail.test.mjs's simpler routeEntries; this version also
// supports F5, which needs BOTH the metric's and the overlay trackable's
// history loaded from one route handler.
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

    let body = [];
    for (const id of ids) {
      const f = fixturesById[id];
      if (Array.isArray(f)) body = body.concat(f);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return getRequests;
}

// CONTRACT-U.4.md §4.F5 note: seed the overlay selection in the SAME
// addInitScript style tests/e2e/overlay.test.mjs's seedOverlaySelection
// uses, registered AFTER seedSession() so it runs (and wins) after the
// session/cache blob is written — Playwright runs addInitScript scripts in
// registration order, "last one registered wins" per that key.
async function seedOverlaySelection(page, selection) {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, JSON.stringify(value));
    },
    [OVERLAY_KEY, selection]
  );
}

function readLocalStorage(page, key) {
  return page.evaluate((k) => localStorage.getItem(k), key);
}

// F2's own instruction: wait for data-fs-state="ready", then allow one
// animation frame before reading scroll geometry (the view sets
// scroll.scrollLeft = scroll.scrollWidth only once the chart/track have
// actually been laid out).
async function waitReadyAndSettle(page) {
  await expect(page.locator('section.fullscreen')).toHaveAttribute('data-fs-state', 'ready');
  await page.evaluate(() => new Promise(requestAnimationFrame));
}

// ===========================================================================
// F1 — cold-launch into the trend fullscreen: shell hidden, rotated at
// portrait, section fills the viewport, track + pinned left axis exist
// ===========================================================================

test('F1 — #/t/366/chart/trend renders a rotated fullscreen section filling the viewport, with #nav/#title-bar hidden', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_METRIC, T_OTHER]);
  await routeEntries(page, { 366: METRIC_ENTRIES, 2: OTHER_ENTRIES });

  await page.goto('/index.html#/t/366/chart/trend');

  const section = page.locator('section.fullscreen');
  await expect(section).toHaveAttribute('data-kind', 'trend');
  await waitReadyAndSettle(page);

  await expect(page.locator('#nav')).toBeHidden();
  await expect(page.locator('#title-bar')).toBeHidden();
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'chart');

  // Default viewport (playwright.config.mjs) is 390x844, portrait — the app
  // rotates by CSS (CONTRACT-U.4.md §0 decision 3).
  await expect(section).toHaveAttribute('data-rotated', 'true');

  const viewport = page.viewportSize();
  const box = await section.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box.x - 0)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.y - 0)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.width - viewport.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.height - viewport.height)).toBeLessThanOrEqual(2);

  await expect(page.locator('.fs-track canvas')).toHaveCount(1);
  const leftAxis = page.locator('.fs-axis[data-side="left"]');
  await expect(leftAxis).toHaveCount(1);
  // Inside the (possibly rotated) section.fullscreen — layout width via
  // offsetWidth, not boundingBox() (screen-space, swapped by the CSS
  // rotation — see the F3 comment below for the full reasoning).
  const leftAxisWidth = await leftAxis.evaluate((el) => el.offsetWidth);
  expect(leftAxisWidth).toBeGreaterThan(0);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// F2 — the sideways scroll starts at its right edge (today) on open
// ===========================================================================

test('F2 — .fs-scroll opens scrolled all the way to its right edge', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_METRIC, T_OTHER]);
  await routeEntries(page, { 366: METRIC_ENTRIES, 2: OTHER_ENTRIES });

  await page.goto('/index.html#/t/366/chart/trend');
  await waitReadyAndSettle(page);

  const geometry = await page.evaluate(() => {
    const el = document.querySelector('.fs-scroll');
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollLeft: el.scrollLeft };
  });

  expect(geometry.scrollWidth).toBeGreaterThanOrEqual(geometry.clientWidth);
  expect(Math.abs(geometry.scrollLeft - (geometry.scrollWidth - geometry.clientWidth))).toBeLessThanOrEqual(2);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// F3 — any range x any period is allowed in fullscreen (CONTRACT-U.4.md §0
// decision 4): selecting 1Y + Daily is not disabled, unlike the capped
// detail-screen control, and produces a track wide enough for 365 daily
// buckets
// ===========================================================================

test('F3 — selecting 1Y then Daily is allowed (not disabled), persists to storage, and widens the track to >= 365*14px', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_METRIC, T_OTHER]);
  await routeEntries(page, { 366: METRIC_ENTRIES, 2: OTHER_ENTRIES });

  await page.goto('/index.html#/t/366/chart/trend');
  await waitReadyAndSettle(page);

  const rangeBtn = page.locator('.fs-range[data-range="1y"]');
  await rangeBtn.click();
  await expect(rangeBtn).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => readLocalStorage(page, RANGE_KEY)).toBe('1y');

  const periodBtn = page.locator('.fs-period[data-period="day"]');
  await expect(periodBtn).toBeEnabled();
  await periodBtn.click();
  await expect(periodBtn).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => readLocalStorage(page, PERIOD_KEY)).toBe('day');

  // Under the contract's CSS rotation (portrait phone -> the section is
  // rotated 90deg by CSS), Playwright's boundingBox() is SCREEN-space, so a
  // rotated element's layout WIDTH shows up as its screen-space height.
  // .fs-track lives inside the rotated section.fullscreen, so its size is
  // read via offsetWidth (layout px) through page.evaluate, never
  // boundingBox() — unlike the outer section's own box checks in F1/F8,
  // which are deliberately screen-space (they assert against the physical
  // viewport).
  await expect
    .poll(() => page.locator('.fs-track').evaluate((el) => el.offsetWidth))
    .toBeGreaterThanOrEqual(365 * 14);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// F4 — closing returns to the detail screen with the shell restored
// ===========================================================================

test('F4 — .fs-close click returns to #/t/:id with the detail screen and shell restored', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_METRIC, T_OTHER]);
  await routeEntries(page, { 366: METRIC_ENTRIES, 2: OTHER_ENTRIES });

  await page.goto('/index.html#/t/366/chart/trend');
  await waitReadyAndSettle(page);

  await page.locator('.fs-close').click();
  await page.waitForURL(/#\/t\/366$/);

  await expect(page.locator('section.detail')).toBeVisible();
  await expect(page.locator('#nav')).toBeVisible();
  await expect(page.locator('#title-bar')).toBeVisible();

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// F5 — the Range chart's fullscreen honours the card's own overlay
// selection: a second dataset and a pinned right axis
// ===========================================================================

test('F5 — #/t/366/chart/range with a persisted overlay selection shows an overlaid bounds chart and a right pinned axis', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_METRIC, T_OTHER]);
  await routeEntries(page, { 366: METRIC_ENTRIES, 2: OTHER_ENTRIES });
  await seedOverlaySelection(page, { [String(T_METRIC.id)]: [String(T_OTHER.id)] });

  await page.goto('/index.html#/t/366/chart/range');
  await waitReadyAndSettle(page);

  await expect(page.locator('.fs-track .bounds')).toHaveAttribute('data-overlays', '1');
  await expect(page.locator('.fs-axis[data-side="right"]')).toHaveCount(1);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// F6 — the detail screen's Expand buttons are live and route into the
// fullscreen view (CONTRACT-U.4.md §6, restating detail.js's own DU-2 case
// with `hidden` now lifted)
// ===========================================================================

test('F6 — the detail screen\'s weekly Expand button is visible and navigates to #/t/:id/chart/trend', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_METRIC, T_OTHER]);
  await routeEntries(page, { 366: METRIC_ENTRIES, 2: OTHER_ENTRIES });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  const expandBtn = page.locator('.chart-slot[data-slot="weekly"] .chart-expand');
  await expect(expandBtn).toBeVisible();

  await expandBtn.click();
  await page.waitForURL(/#\/t\/366\/chart\/trend$/);

  await expect(page.locator('section.fullscreen')).toHaveAttribute('data-kind', 'trend');
  await waitReadyAndSettle(page);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// F7 — an unknown chart kind falls through the router to notfound
// ===========================================================================

test('F7 — #/t/366/chart/nope renders the notfound view (#title reads "Not Found")', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_METRIC, T_OTHER]);
  await routeEntries(page, { 366: METRIC_ENTRIES, 2: OTHER_ENTRIES });

  await page.goto('/index.html#/t/366/chart/nope');

  await expect(page.locator('#title')).toHaveText('Not Found');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// F8 — physically-landscape phone: no rotation applied
// ===========================================================================

test.describe('F8 — landscape viewport', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('data-rotated="false" and the section still fills the (now landscape) viewport, with a wide scroll area', async ({
    page,
  }) => {
    const unexpected = await installGuard(page);
    const unexpectedAuth = await installAuthGuard(page);
    await routeTrackables(page, [T_METRIC, T_OTHER]);
    await routeEntries(page, { 366: METRIC_ENTRIES, 2: OTHER_ENTRIES });

    await page.goto('/index.html#/t/366/chart/trend');
    await waitReadyAndSettle(page);

    const section = page.locator('section.fullscreen');
    await expect(section).toHaveAttribute('data-rotated', 'false');

    const viewport = page.viewportSize();
    const box = await section.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box.x - 0)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.y - 0)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.width - viewport.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.height - viewport.height)).toBeLessThanOrEqual(2);

    const clientWidth = await page.evaluate(() => document.querySelector('.fs-scroll').clientWidth);
    expect(clientWidth).toBeGreaterThanOrEqual(700);

    expect(unexpected).toEqual([]);
    expect(unexpectedAuth).toEqual([]);
  });
});

// ===========================================================================
// F9 — an unknown trackable id: notfound state, not a router notfound
// ===========================================================================

test('F9 — #/t/99999/chart/trend (a route-valid id that does not resolve to a trackable) renders data-fs-state="notfound"', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeTrackables(page, [T_METRIC, T_OTHER]);
  await routeEntries(page, { 366: METRIC_ENTRIES, 2: OTHER_ENTRIES });

  await page.goto('/index.html#/t/99999/chart/trend');

  const section = page.locator('section.fullscreen');
  await expect(section).toHaveAttribute('data-fs-state', 'notfound');
  await expect(page.locator('.fs-status')).toHaveText('Trackable not found.');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});
