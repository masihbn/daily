// E2E tests for the Step 4.1 Settings screen (js/views/settings.js),
// mounted at #/settings per CONTRACT-4.1.md. Written strictly against that
// contract's §4 (DOM/behaviour contract) and §8 (test plan, cases S1
// through S10) — the implementation is being written in parallel by
// another agent and has NOT been read while writing this file.
//
// Do NOT start a server here and do NOT hardcode the base URL or viewport;
// both are supplied by playwright.config.mjs (baseURL 127.0.0.1:8123,
// 390x844 viewport). Mechanics (guard-first routing, service workers
// blocked, seedSession) copied from tests/e2e/auth.test.mjs and
// tests/e2e/bounds.test.mjs, per the task brief.
//
// GUARDRAIL: nothing in this file may touch a real Supabase row. Every
// PostgREST call is intercepted with page.route() and fully
// fulfilled/aborted from fixtures; a broad **/rest/v1/** catch-all guard is
// registered FIRST in every test (installGuard), specific routes are
// registered after it, and every test asserts expect(unexpected).toEqual([]).

import { test, expect } from '@playwright/test';
import { seedSession, installAuthGuard, FAKE_USER } from '../helpers/e2e-session.mjs';
import { addDays } from '../../js/dates.js';
import { deriveBounds } from '../../js/aggregate.js';
import { roundBound } from '../../js/charts/bounds.js';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  // Step D.7: the app is gated behind a signed-in session; seed one before
  // any page script runs. As of CONTRACT-4.1.md §0.7/§9, this also seeds
  // `daily.cache.v1` with `settings: { rolling_window_days: 90 }` (and
  // empty trackables/entries) in the same init script, so a test that does
  // not seed its own cache blob does not trigger an unwanted app_settings
  // GET on a detail-screen visit.
  await seedSession(page);
});

// --- fixtures ---------------------------------------------------------

const T_WORKOUT = {
  id: 10,
  name: 'Workout',
  value_shape: 'boolean',
  relog_semantic: 'cumulative',
  aggregation: 'count',
  direction: 'build',
  unit: null,
  bounds_enabled: false,
  bounds_mode: 'auto',
  bound_lower: null,
  bound_upper: null,
  target_type: 'none',
  target_value: null,
  color: '#5856d6',
  sort_order: 0,
  archived: false,
};

const T_CALORIES = {
  id: 20,
  name: 'Calories',
  value_shape: 'numeric',
  relog_semantic: 'cumulative',
  aggregation: 'sum',
  direction: 'break',
  unit: 'kcal',
  bounds_enabled: false,
  bounds_mode: 'auto',
  bound_lower: null,
  bound_upper: null,
  target_type: 'none',
  target_value: null,
  color: '#ff9500',
  sort_order: 1,
  archived: false,
};

// Auto-bounds numeric fixture used by S2/S8 — >=12 readings required for
// boundsFor() to resolve 'ok' rather than 'insufficient' (MIN_BOUND_READINGS,
// tests/unit/bounds.test.mjs's N2 header).
const T_WEIGHT = {
  id: 30,
  name: 'Weight',
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
  color: '#34c759',
  sort_order: 2,
  archived: false,
};

const T_OLD = {
  id: 40,
  name: 'Old Habit',
  value_shape: 'boolean',
  relog_semantic: 'cumulative',
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
  sort_order: 3,
  archived: true,
};

// Compute "today" from local date parts (never toISOString, which reads
// UTC) — same mechanics as tests/e2e/bounds.test.mjs.
const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 35 distinct daily readings for T_WEIGHT: the most recent 30 days are all
// 70, and the 5 days before that are all 10. This is deliberately built so
// a 30-day rolling window and a 90-day rolling window disagree: the 30-day
// window only ever sees the constant-70 run (lower=upper=70), while the
// 90-day window also sees the five 10s, pulling its derived lower bound
// down to 10 — the whole point of S2, which asserts the RESOLVED band
// after saving windowDays=30 matches deriveBounds(entries, 30), NOT the
// (very different) 90-day band.
function weightEntries() {
  const entries = [];
  for (let offset = 1; offset <= 30; offset++) {
    entries.push({ id: 2000 + offset, trackable_id: T_WEIGHT.id, entry_date: addDays(TODAY, -offset), value: 70, note: null });
  }
  for (let offset = 31; offset <= 35; offset++) {
    entries.push({ id: 2000 + offset, trackable_id: T_WEIGHT.id, entry_date: addDays(TODAY, -offset), value: 10, note: null });
  }
  return entries;
}

// --- route helpers -------------------------------------------------------

async function installGuard(page) {
  const unexpected = [];
  await page.route('**/rest/v1/**', async (route) => {
    unexpected.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort();
  });
  return unexpected;
}

// GET answers with `get` (default: rolling_window_days:90); PATCH echoes
// the merged row back (or fails with `patchStatus` when given).
async function routeSettings(page, { get, patchStatus = 200 } = {}) {
  const fixture = get !== undefined ? get : [{ id: 1, rolling_window_days: 90, updated_at: '2026-01-01T00:00:00Z' }];
  const getRequests = [];
  const patchRequests = [];
  await page.route('**/rest/v1/app_settings*', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      getRequests.push({ url: req.url() });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
      return;
    }
    if (req.method() === 'PATCH') {
      const body = JSON.parse(req.postData() || '{}');
      patchRequests.push({ body });
      if (patchStatus !== 200) {
        await route.fulfill({ status: patchStatus, contentType: 'application/json', body: JSON.stringify({ message: 'down' }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 1, rolling_window_days: body.rolling_window_days, updated_at: '2026-01-02T00:00:00Z' }]),
      });
      return;
    }
    await route.abort();
  });
  return { getRequests, patchRequests };
}

// GET answers with the (mutable) `trackables` array, sorted the way
// listTrackables() itself orders (sort_order.asc, id.asc). PATCH mutates
// that same array in place (merging the patch into the matched row) so a
// later resync GET — the reorder/unarchive handlers' loadTrackables()
// re-fetch — reflects the update, exactly like the real PostgREST backend
// would.
async function routeTrackables(page, trackables, { patchStatus = 200 } = {}) {
  const getRequests = [];
  const patchRequests = [];
  await page.route('**/rest/v1/trackables*', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      getRequests.push({ url: req.url() });
      const sorted = trackables
        .slice()
        .sort((a, b) => (a.sort_order - b.sort_order) || (Number(a.id) - Number(b.id)));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sorted) });
      return;
    }
    if (req.method() === 'PATCH') {
      const url = new URL(req.url());
      const idFilter = url.searchParams.get('id') || '';
      const id = idFilter.replace(/^eq\./, '');
      const body = JSON.parse(req.postData() || '{}');
      patchRequests.push({ id, body });
      if (patchStatus !== 200) {
        await route.fulfill({ status: patchStatus, contentType: 'application/json', body: JSON.stringify({ message: 'down' }) });
        return;
      }
      const idx = trackables.findIndex((t) => String(t.id) === id);
      if (idx >= 0) trackables[idx] = { ...trackables[idx], ...body };
      const merged = idx >= 0 ? trackables[idx] : { id, ...body };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([merged]) });
      return;
    }
    await route.abort();
  });
  return { getRequests, patchRequests };
}

// GET-only: none of these cases write an entry.
async function routeEntries(page, getFixture = []) {
  const getRequests = [];
  await page.route('**/rest/v1/entries*', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') {
      await route.abort();
      return;
    }
    getRequests.push({ url: req.url() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(getFixture) });
  });
  return { getRequests };
}

// Reads the RESOLVED lower/upper bound values off the live bounds chart's
// annotation config — same mechanic as tests/e2e/bounds.test.mjs's
// readBoundsLineValues (Q12), reused here for S2.
function readBoundsLineValues(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.bounds-canvas');
    const chart = window.Chart.getChart(canvas);
    if (!chart) return null;
    const annotationOpt = chart.options && chart.options.plugins && chart.options.plugins.annotation;
    const annotations = annotationOpt ? annotationOpt.annotations : null;
    const entries = annotations && typeof annotations === 'object' ? Object.values(annotations) : [];
    const lines = entries.filter((a) => a && a.type === 'line');
    const values = lines.map((a) => {
      if (a.yMin !== undefined && a.yMin !== null) return a.yMin;
      if (a.yMax !== undefined && a.yMax !== null) return a.yMax;
      return a.value;
    });
    return values.slice().sort((a, b) => a - b);
  });
}

// ===========================================================================
// S1 — basic render: four blocks, seeded values, archived not filtered out
// ===========================================================================

test('S1 — #/settings: four blocks, seeded values, archived not filtered, one settings GET + one trackables GET', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  const { getRequests: settingsGets } = await routeSettings(page);
  const { getRequests: trackablesGets } = await routeTrackables(page, [T_WORKOUT, T_CALORIES, T_WEIGHT, T_OLD]);
  await routeEntries(page, []);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  await expect(page.locator('section.settings-block[data-block="window"]')).toHaveCount(1);
  await expect(page.locator('section.settings-block[data-block="order"]')).toHaveCount(1);
  await expect(page.locator('section.settings-block[data-block="archived"]')).toHaveCount(1);
  await expect(page.locator('section.settings-block[data-block="account"]')).toHaveCount(1);

  await expect(page.locator('.settings-window-input')).toHaveValue('90');

  const orderItems = page.locator('li.settings-order-item');
  await expect(orderItems).toHaveCount(3);
  await expect(orderItems.nth(0)).toHaveAttribute('data-id', '10');
  await expect(orderItems.nth(1)).toHaveAttribute('data-id', '20');
  await expect(orderItems.nth(2)).toHaveAttribute('data-id', '30');
  await expect(orderItems.nth(0).locator('.settings-order-name')).toHaveText('Workout');

  const archivedItems = page.locator('li.settings-archived-item');
  await expect(archivedItems).toHaveCount(1);
  await expect(archivedItems.nth(0)).toHaveAttribute('data-id', '40');
  await expect(archivedItems.nth(0).locator('.settings-archived-name')).toHaveText('Old Habit');

  await expect(page.locator('.signin-as')).toHaveText(`Signed in as ${FAKE_USER.email}`);

  expect(settingsGets.length).toBe(1);
  expect(trackablesGets.length).toBe(1);
  // js/api.js#listTrackables expresses includeArchived by OMITTING the
  // archived filter entirely (its filtered branch sends
  // "archived=is.false") — assert that exact string is absent.
  expect(trackablesGets[0].url).not.toContain('archived=is.false');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// S2 — save 30, then a detail visit uses the cached value with no re-fetch,
// and the RESOLVED band is the 30-day one, not the 90-day one
// ===========================================================================

test('S2 — Save 30 PATCHes rolling_window_days; a later detail visit is cached (no settings GET) and uses the 30-day band', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  const { getRequests: settingsGets, patchRequests: settingsPatches } = await routeSettings(page);
  await routeTrackables(page, [T_WEIGHT]);
  const entries = weightEntries();
  await routeEntries(page, entries);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  await page.locator('.settings-window-input').fill('30');
  await page.locator('.settings-window-save').click();

  await expect(page.locator('.settings-window-status')).toHaveText('Saved.');
  expect(settingsPatches).toEqual([{ body: { rolling_window_days: 30 } }]);

  const settingsGetCountBefore = settingsGets.length;

  await page.goto(`/index.html#/t/${T_WEIGHT.id}`);
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.bounds-canvas')).toHaveCount(1);

  // Cached from the save above — no new app_settings GET.
  expect(settingsGets.length).toBe(settingsGetCountBefore);

  await expect(page.locator('.bounds-meaning')).toContainText('last 30 days');

  const liveValues = await readBoundsLineValues(page);
  // boundsFor() rounds auto-derived bounds for display (roundBound(): >=100
  // whole-number, else one decimal) — the raw deriveBounds() output must be
  // rounded the same way before comparing to what the live chart resolved.
  const expected30 = deriveBounds(entries, 30);
  const expected90 = deriveBounds(entries, 90);
  const sorted30 = [roundBound(expected30.lower), roundBound(expected30.upper)].sort((a, b) => a - b);
  const sorted90 = [roundBound(expected90.lower), roundBound(expected90.upper)].sort((a, b) => a - b);

  expect(liveValues).toEqual(sorted30);
  expect(liveValues).not.toEqual(sorted90);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// S3 — invalid window inputs: validation text, no PATCH
// ===========================================================================

test('S3 — "5", "abc", "1000", "30.5" each show the validation text and issue no PATCH', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  const { patchRequests } = await routeSettings(page);
  await routeTrackables(page, [T_WORKOUT]);
  await routeEntries(page, []);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  for (const bad of ['5', 'abc', '1000', '30.5']) {
    await page.locator('.settings-window-input').fill(bad);
    await page.locator('.settings-window-save').click();
    await expect(page.locator('.settings-window-error')).toHaveText('Enter a whole number from 14 to 730.');
  }

  expect(patchRequests.length).toBe(0);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// S4 — PATCH 500: save-failure text, input unchanged, never "Saved."
// ===========================================================================

test('S4 — a 500 on PATCH shows the save-failure text, keeps the typed input, and never shows "Saved."', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeSettings(page, { patchStatus: 500 });
  await routeTrackables(page, [T_WORKOUT]);
  await routeEntries(page, []);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  await page.locator('.settings-window-input').fill('30');
  await page.locator('.settings-window-save').click();

  await expect(page.locator('.settings-window-error')).toHaveText('Could not save. Check your connection and try again.');
  await expect(page.locator('.settings-window-input')).toHaveValue('30');
  await expect(page.locator('.settings-window-status')).not.toHaveText('Saved.');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// S5 — app_settings GET [] (routeEmptyRest-style): load-failure text
// ===========================================================================

test('S5 — app_settings GET [] shows "Could not load settings.", disables Save, still shows the account block, no pageerror', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err));

  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);

  // seedSession() (beforeEach) seeds daily.cache.v1 WITH a default settings
  // field, which would otherwise let the view find a cached value and skip
  // straight past the load-failure path this test exists to exercise.
  // Registering another addInitScript here runs AFTER it (same technique as
  // S8a below), so this overwrite — with no `settings` key at all — wins.
  await page.addInitScript(() => {
    localStorage.setItem('daily.cache.v1', JSON.stringify({ v: 1, trackables: [], entries: [] }));
  });

  await routeSettings(page, { get: [] });
  await routeTrackables(page, [T_WORKOUT]);
  await routeEntries(page, []);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  await expect(page.locator('.settings-window-error')).toBeVisible();
  await expect(page.locator('.settings-window-error')).toHaveText('Could not load settings.');
  await expect(page.locator('.settings-window-input')).toHaveValue('');
  await expect(page.locator('.settings-window-save')).toBeDisabled();
  await expect(page.locator('.signin-as')).toHaveText(`Signed in as ${FAKE_USER.email}`);

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// S6 — reordering: two PATCHes (lowest new position first), re-render, and
// Home reflects the new order too
// ===========================================================================

test('S6 — moving the second visible item up PATCHes the swapped sort_orders and reorders both Settings and Home', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  const trackables = [{ ...T_WORKOUT }, { ...T_CALORIES }, { ...T_WEIGHT }];
  const { patchRequests } = await routeTrackables(page, trackables);
  await routeSettings(page);
  await routeEntries(page, []);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  await page.locator('.settings-move[data-action="move-up"][data-id="20"]').click();

  await expect.poll(() => patchRequests.length).toBe(2);
  expect(patchRequests[0]).toEqual({ id: '20', body: { sort_order: 0 } });
  expect(patchRequests[1]).toEqual({ id: '10', body: { sort_order: 1 } });

  const orderItems = page.locator('li.settings-order-item');
  await expect(orderItems.nth(0)).toHaveAttribute('data-id', '20');
  await expect(orderItems.nth(1)).toHaveAttribute('data-id', '10');
  await expect(orderItems.nth(2)).toHaveAttribute('data-id', '30');

  await page.goto('/index.html#/');
  await expect(page.locator('section.home')).toBeVisible();
  const rows = page.locator('li.trow');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-trackable-id', '20');
  await expect(rows.nth(1)).toHaveAttribute('data-trackable-id', '10');
  await expect(rows.nth(2)).toHaveAttribute('data-trackable-id', '30');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// S7 — Unarchive
// ===========================================================================

test('S7 — Unarchive PATCHes {archived:false}, moves the item into Order, and empties Archived', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  const trackables = [{ ...T_WORKOUT }, { ...T_OLD }];
  const { patchRequests } = await routeTrackables(page, trackables);
  await routeSettings(page);
  await routeEntries(page, []);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');
  await expect(page.locator('li.settings-archived-item')).toHaveCount(1);

  await page.locator('.settings-unarchive[data-id="40"]').click();

  await expect.poll(() => patchRequests.length).toBe(1);
  expect(patchRequests[0]).toEqual({ id: '40', body: { archived: false } });

  await expect(page.locator('li.settings-archived-item')).toHaveCount(0);
  await expect(page.locator('.settings-archived-empty')).toHaveText('Nothing archived.');
  await expect(page.locator('li.settings-order-item[data-id="40"]')).toHaveCount(1);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// S8a — detail with NO cached settings: exactly one app_settings GET
// ===========================================================================

test('S8a — a detail visit with no cached settings issues exactly one app_settings GET, reflected in .bounds-meaning', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);

  // seedSession() already ran in beforeEach, seeding daily.cache.v1 WITH a
  // default settings field. Registering another addInitScript here runs
  // AFTER it (Playwright runs them in registration order), so this
  // overwrite — with no `settings` key at all — wins, per CONTRACT-4.1.md's
  // instruction for this exact case.
  await page.addInitScript(() => {
    localStorage.setItem('daily.cache.v1', JSON.stringify({ v: 1, trackables: [], entries: [] }));
  });

  const { getRequests: settingsGets } = await routeSettings(page, {
    get: [{ id: 1, rolling_window_days: 60, updated_at: '2026-01-01T00:00:00Z' }],
  });
  await routeTrackables(page, [T_WEIGHT]);
  const entries = weightEntries();
  await routeEntries(page, entries);

  await page.goto(`/index.html#/t/${T_WEIGHT.id}`);
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.bounds-canvas')).toHaveCount(1);

  expect(settingsGets.length).toBe(1);
  await expect(page.locator('.bounds-meaning')).toContainText('last 60 days');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// S8b — detail with the default seeded cache: zero app_settings GETs
// ===========================================================================

test('S8b — a detail visit with the default seeded settings cache issues zero app_settings GETs', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  const { getRequests: settingsGets } = await routeSettings(page);
  await routeTrackables(page, [T_WEIGHT]);
  const entries = weightEntries();
  await routeEntries(page, entries);

  await page.goto(`/index.html#/t/${T_WEIGHT.id}`);
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.bounds-canvas')).toHaveCount(1);

  expect(settingsGets.length).toBe(0);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// S9 — trackables GET 500: offline banner, blocks still render, no crash
// ===========================================================================

test('S9 — trackables GET 500 shows .detail-offline, blocks still render, no pageerror', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err));

  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await page.route('**/rest/v1/trackables*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.abort();
      return;
    }
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'boom' }) });
  });
  await routeSettings(page);
  await routeEntries(page, []);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  await expect(page.locator('section.settings-block[data-block="window"]')).toHaveCount(1);
  await expect(page.locator('section.settings-block[data-block="order"]')).toHaveCount(1);
  await expect(page.locator('section.settings-block[data-block="archived"]')).toHaveCount(1);
  await expect(page.locator('section.settings-block[data-block="account"]')).toHaveCount(1);

  await expect(page.locator('.detail-offline')).toHaveText('You appear to be offline — showing the last saved data.');

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// S10 — sign-out from the view: covered by the existing, unedited
// tests/e2e/auth.test.mjs A10 (successful sign-out) and A11 (refused while
// the outbox is non-empty). CONTRACT-4.1.md §8 explicitly asks that these
// two scenarios "still pass unchanged" now that sign-out lives inside
// js/views/settings.js instead of js/main.js — not that this file
// duplicate them. Both already exercise `#signout-btn` / `.signin-as` /
// `.signout-warning` against the real Settings route, so they cover S10 by
// running in the full suite; no new test is added here, and
// tests/e2e/auth.test.mjs is not edited (task boundary).
// ===========================================================================

// ===========================================================================
// CONTRACT-U.6.md §7 — Settings icon buttons and the app-lock status pill.
// Written strictly against §2/§5/§7 of that contract; the implementation
// (js/views/settings.js, css/styles.css) is being written in parallel and is
// not visible here.
// ===========================================================================

// SU-1 — every .settings-move: svg present, unchanged arrow text, >=44x44,
// and the up arrow is visually rotated (its computed transform is not none)
test('SU-1 — every .settings-move icon button carries an svg, keeps its arrow textContent, is >=44x44, and the up arrow is visually rotated', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeSettings(page);
  await routeTrackables(page, [T_WORKOUT, T_CALORIES]);
  await routeEntries(page, []);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  const moveButtons = page.locator('.settings-move');
  const count = await moveButtons.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i++) {
    const btn = moveButtons.nth(i);
    await expect(btn.locator('svg')).toHaveCount(1);
    const text = (await btn.textContent()).trim();
    expect(['↑', '↓']).toContain(text);
    const box = await btn.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }

  const upSvg = page.locator('.settings-move[data-action="move-up"] svg').first();
  const transform = await upSvg.evaluate((el) => getComputedStyle(el).transform);
  expect(transform).not.toBe('none');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// SU-2 — the account block's sign-out button is a full-width row control
test("SU-2 — the account block's #signout-btn is a wide tap target", async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeSettings(page);
  await routeTrackables(page, [T_WORKOUT]);
  await routeEntries(page, []);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  const box = await page.locator('#signout-btn').boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(200);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// SU-3 — the app-lock status carries the pill class
test('SU-3 — .settings-applock-status carries the "pill" class', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeSettings(page);
  await routeTrackables(page, [T_WORKOUT]);
  await routeEntries(page, []);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  await expect(page.locator('.settings-applock-status')).toHaveClass(/pill/);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});
