// E2E tests for the Step 3.1 calendar heatmap (js/charts/heatmap.js,
// rendered inside js/views/detail.js's 'heatmap' chart-slot), mounted at
// #/t/:id per CONTRACT-3.1.md. Written strictly against that contract's §3
// (DOM contract), §4 (detail.js wiring) and §5.2 (test plan, cases H1
// through H14) — the implementation is being written in parallel by another
// agent and has NOT been read while writing this file.
//
// Do NOT start a server here and do NOT hardcode the base URL or viewport;
// both are supplied by playwright.config.mjs (baseURL 127.0.0.1:8123,
// 390x844 viewport). Reuses the exact interception mechanics established in
// tests/e2e/detail.test.mjs and tests/e2e/home.test.mjs (both read first,
// per the task brief): a catch-all **/rest/v1/** guard registered FIRST
// that records and aborts anything unclaimed, specific routes registered
// after it, service workers blocked, and expect(unexpected).toEqual([]) in
// every test.
//
// GUARDRAIL (CONTRACT-3.1.md §6 / docs/ORCHESTRATION.md): nothing in this
// file may create, modify, or delete a real Supabase row. Every PostgREST
// call the app makes is intercepted with page.route() and fully
// fulfilled/aborted from fixtures — this file makes ZERO real network calls
// to Supabase.

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

// --- fixtures -------------------------------------------------------------

const T_NUM = {
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
  color: '#34c759',
  sort_order: 0,
  archived: false,
};

const T_BOOL_BUILD = {
  id: 1,
  name: 'Workout',
  value_shape: 'boolean',
  relog_semantic: 'state',
  aggregation: 'count',
  direction: 'build',
  unit: null,
  bounds_enabled: false,
  color: null,
  sort_order: 1,
  archived: false,
};

const T_BOOL_BREAK = {
  id: 5,
  name: 'Smoking',
  value_shape: 'boolean',
  relog_semantic: 'state',
  aggregation: 'count',
  direction: 'break',
  unit: null,
  bounds_enabled: false,
  color: null,
  sort_order: 5,
  archived: false,
};

// Compute "today" the same way the app must (local calendar components, NOT
// toISOString, which reads UTC and is wrong for part of every day) — same
// mechanics as tests/e2e/home.test.mjs and tests/e2e/detail.test.mjs.
const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// A "past day of the current month" fixture date. Deliberately the 1st of
// the CURRENT month rather than an arbitrary offset: this guarantees it
// falls within the default-displayed month (the app defaults monthStr to
// the current month) and within the default 3m range's `from` bound (90
// days always exceeds the distance from the 1st of a month to any day
// within it). It equals TODAY only on the one day per month that IS the
// 1st, in which case "past day" degenerates to "today" — the same order of
// magnitude of calendar-edge risk already accepted elsewhere in this
// project's e2e suite (e.g. tests/e2e/detail.test.mjs D10's addDays(TODAY, -1)).
const PAST_DATE = `${TODAY.slice(0, 7)}-01`;

// A second, dominant data point safely within the default 3m window (90
// days) but far from PAST_DATE, used only by H9 to pin rangeMax well above
// the values being tested there — see the comment on that test for why.
const ANCHOR_DATE = addDays(TODAY, -45);

// --- route helpers ---------------------------------------------------------
//
// Same priority trick as detail.test.mjs/home.test.mjs: the broad catch-all
// guard is registered FIRST (lowest priority) and the narrow, per-endpoint
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

// Returns { getRequests, postRequests, deleteRequests } — arrays of
// { url, headers, body? } this test can assert counts/bodies on.
async function routeEntries(page, { getFixture = [], post = {}, del = {} } = {}) {
  const getRequests = [];
  const postRequests = [];
  const deleteRequests = [];

  await page.route('**/rest/v1/entries*', async (route) => {
    const req = route.request();
    const method = req.method();

    if (method === 'GET') {
      getRequests.push({ url: req.url() });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(getFixture),
      });
      return;
    }

    if (method === 'POST') {
      const bodyText = req.postData() || '';
      postRequests.push({ url: req.url(), headers: req.headers(), body: bodyText });
      if (post.delayMs) await new Promise((resolve) => setTimeout(resolve, post.delayMs));
      await route.fulfill({
        status: post.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(post.body ?? []),
      });
      return;
    }

    if (method === 'DELETE') {
      deleteRequests.push({ url: req.url(), headers: req.headers() });
      if (del.delayMs) await new Promise((resolve) => setTimeout(resolve, del.delayMs));
      await route.fulfill({
        status: del.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(del.body ?? []),
      });
      return;
    }

    // Not a method this step's contract uses — abort rather than let it
    // fall through to a real network call.
    await route.abort();
  });

  return { getRequests, postRequests, deleteRequests };
}

// ===========================================================================
// H1 — basic render
// ===========================================================================

test('H1 — .heatmap renders inside .chart-slot[data-slot="heatmap"] with exactly 42 .hm-cell and 7 .hm-weekday labels starting Mon', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  const heatmap = page.locator('.chart-slot[data-slot="heatmap"] .heatmap');
  await expect(heatmap).toHaveCount(1);
  await expect(heatmap.locator('.hm-grid > .hm-cell')).toHaveCount(42);

  const weekdays = heatmap.locator('.hm-weekday');
  await expect(weekdays).toHaveCount(7);
  await expect(weekdays.first()).toHaveText('Mon');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// H2 — the load-once guard still holds with the heatmap live
// ===========================================================================

test('H2 — with the heatmap live, loading the detail screen issues exactly ONE GET to /rest/v1/entries', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM]);
  const { getRequests } = await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.heatmap')).toHaveCount(1);

  await expect.poll(() => getRequests.length).toBe(1);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// H3 — next-month disabled on the current month
// ===========================================================================

test('H3 — the next-month button is disabled on the current month, and stays disabled after prev then next back', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  const next = page.locator('.hm-nav[data-heatmap-nav="next"]');
  const prev = page.locator('.hm-nav[data-heatmap-nav="prev"]');
  await expect(next).toBeDisabled();

  await prev.click();
  await expect(next).toBeEnabled();

  await next.click();
  await expect(next).toBeDisabled();

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// H4 — prev changes month, zero requests
// ===========================================================================

test('H4 — clicking prev changes .heatmap[data-month] and .hm-month text, and issues zero requests', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM]);
  const { getRequests } = await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  const heatmap = page.locator('.heatmap');
  const monthBefore = await heatmap.getAttribute('data-month');
  const textBefore = await page.locator('.hm-month').textContent();

  await page.locator('.hm-nav[data-heatmap-nav="prev"]').click();

  await expect
    .poll(async () => heatmap.getAttribute('data-month'))
    .not.toBe(monthBefore);
  const textAfter = await page.locator('.hm-month').textContent();
  expect(textAfter).not.toBe(textBefore);

  // Navigating months must never fetch — still exactly one GET total.
  await expect.poll(() => getRequests.length).toBe(1);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// H5 — a logged day is visibly filled (computed opacity, not just the attribute)
// ===========================================================================

test('H5 — a logged day has computed .hm-fill opacity > 0; an unlogged day computes to 0', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM]);
  await routeEntries(page, {
    getFixture: [{ id: 900, trackable_id: 366, entry_date: PAST_DATE, value: 500, note: null }],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  const loggedCell = page.locator(`.hm-cell[data-date="${PAST_DATE}"]`);
  await expect(loggedCell).toHaveAttribute('data-logged', 'true');
  const loggedOpacity = await loggedCell.locator('.hm-fill').evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(loggedOpacity)).toBeGreaterThan(0);

  const unloggedCell = page.locator('.hm-cell[data-cell-state="day"][data-logged="false"]').first();
  await expect(unloggedCell).toHaveCount(1);
  const unloggedOpacity = await unloggedCell.locator('.hm-fill').evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(unloggedOpacity)).toBe(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// H6 — the break-boolean reading (computed background-color, not just data-verdict)
// ===========================================================================

test('H6 — a break-direction boolean: an unlogged in-window day reads good, a logged day reads bad, and their computed .hm-fill colors differ', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOOL_BREAK]);
  await routeEntries(page, {
    getFixture: [{ id: 901, trackable_id: 5, entry_date: PAST_DATE, value: 1, note: null }],
  });

  await page.goto('/index.html#/t/5');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  const loggedCell = page.locator(`.hm-cell[data-date="${PAST_DATE}"]`);
  await expect(loggedCell).toHaveAttribute('data-verdict', 'bad');

  const unloggedCell = page.locator('.hm-cell[data-cell-state="day"][data-verdict="good"]').first();
  await expect(unloggedCell).toHaveCount(1);

  const loggedColor = await loggedCell.locator('.hm-fill').evaluate((el) => getComputedStyle(el).backgroundColor);
  const unloggedColor = await unloggedCell.locator('.hm-fill').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(loggedColor).not.toBe(unloggedColor);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// H7 — tap a past day -> editor opens prefilled
// ===========================================================================

test('H7 — tapping a past day with an existing numeric entry opens the day editor prefilled with that value; zero requests so far', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM]);
  const { getRequests, postRequests, deleteRequests } = await routeEntries(page, {
    getFixture: [{ id: 902, trackable_id: 366, entry_date: PAST_DATE, value: 1850, note: null }],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  await page.locator(`.hm-cell[data-date="${PAST_DATE}"]`).click();

  const editor = page.locator(`.day-editor[data-date="${PAST_DATE}"]`);
  await expect(editor).toBeVisible();
  await expect(editor.locator('.day-input')).toHaveValue('1850');

  expect(getRequests.length).toBe(1);
  expect(postRequests.length).toBe(0);
  expect(deleteRequests.length).toBe(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// H8 — saving writes the parsed value, not a sum
// ===========================================================================

test('H8 — saving the day editor writes the parsed value directly (replace): POST body value is 1500, not 3350', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM]);
  const { postRequests } = await routeEntries(page, {
    getFixture: [{ id: 903, trackable_id: 366, entry_date: PAST_DATE, value: 1850, note: null }],
    post: { body: [{ id: 904, trackable_id: 366, entry_date: PAST_DATE, value: 1500, note: null }] },
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  await page.locator(`.hm-cell[data-date="${PAST_DATE}"]`).click();
  const editor = page.locator(`.day-editor[data-date="${PAST_DATE}"]`);
  await expect(editor).toBeVisible();

  await editor.locator('.day-input').fill('1500');
  await editor.locator('.day-save').click();

  await expect.poll(() => postRequests.length).toBe(1);
  const posted = JSON.parse(postRequests[0].body);
  expect(posted.value).toBe(1500);
  expect(posted.value).not.toBe(3350);
  expect(posted.trackable_id).toBe(366);
  expect(posted.entry_date).toBe(PAST_DATE);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// H9 — the grid updates after a save without a second GET
// ===========================================================================

test('H9 — after a save resolves, the cell reflects the new value (a genuinely lower .hm-fill opacity) and the entries GET count is still exactly 1', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM]);
  // A dominant anchor entry, safely within the default 3m window but far
  // from PAST_DATE, keeps rangeMax pinned well above both the before/after
  // values below. Without it, a single-entry rangeMax is always exactly
  // equal to that entry's own value (rangeMax = rangeMaxValue(entries), and
  // this cell's value is necessarily part of `entries` for it to be
  // rendered at all), so alpha would trivially clamp to 1 both before and
  // after and never actually demonstrate a change — see the equivalent
  // note in tests/unit/heatmap.test.mjs's U9 alpha suite.
  const { getRequests, postRequests } = await routeEntries(page, {
    getFixture: [
      { id: 950, trackable_id: 366, entry_date: ANCHOR_DATE, value: 5000, note: null },
      { id: 905, trackable_id: 366, entry_date: PAST_DATE, value: 1850, note: null },
    ],
    post: { body: [{ id: 906, trackable_id: 366, entry_date: PAST_DATE, value: 1500, note: null }] },
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  const cell = page.locator(`.hm-cell[data-date="${PAST_DATE}"]`);
  const opacityBefore = Number(await cell.locator('.hm-fill').evaluate((el) => getComputedStyle(el).opacity));

  await cell.click();
  const editor = page.locator(`.day-editor[data-date="${PAST_DATE}"]`);
  await editor.locator('.day-input').fill('1500');
  await editor.locator('.day-save').click();

  await expect.poll(() => postRequests.length).toBe(1);
  await expect(page.locator('.day-editor')).toHaveCount(0);

  await expect(cell).toHaveAttribute('data-logged', 'true');
  const opacityAfter = Number(await cell.locator('.hm-fill').evaluate((el) => getComputedStyle(el).opacity));
  expect(opacityAfter).toBeLessThan(opacityBefore);

  // Still exactly ONE GET total — the grid was refreshed from the store's
  // synchronous reader (contract §4.7), never a second network round trip.
  expect(getRequests.length).toBe(1);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// H10 — Clear issues a DELETE
// ===========================================================================

test('H10 — Clear on a boolean day with an entry issues a DELETE, and the cell becomes data-logged="false"', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOOL_BUILD]);
  const { deleteRequests } = await routeEntries(page, {
    getFixture: [{ id: 907, trackable_id: 1, entry_date: PAST_DATE, value: 1, note: null }],
    del: { body: [{ id: 907, trackable_id: 1, entry_date: PAST_DATE, value: 1, note: null }] },
  });

  await page.goto('/index.html#/t/1');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  const cell = page.locator(`.hm-cell[data-date="${PAST_DATE}"]`);
  await expect(cell).toHaveAttribute('data-logged', 'true');
  await cell.click();

  const editor = page.locator(`.day-editor[data-date="${PAST_DATE}"]`);
  await expect(editor).toBeVisible();
  await editor.locator('.day-clear').click();

  await expect.poll(() => deleteRequests.length).toBe(1);
  expect(deleteRequests[0].url).toContain('trackable_id=eq.1');
  expect(deleteRequests[0].url).toContain(`entry_date=eq.${PAST_DATE}`);

  await expect(page.locator('.day-editor')).toHaveCount(0);
  await expect(cell).toHaveAttribute('data-logged', 'false');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// H11 — a bad number issues zero requests
// ===========================================================================

test('H11 — typing "abc" and submitting shows .day-error "Enter a number" and issues zero requests', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM]);
  const { postRequests, deleteRequests, getRequests } = await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  await page.locator(`.hm-cell[data-date="${PAST_DATE}"]`).click();
  const editor = page.locator(`.day-editor[data-date="${PAST_DATE}"]`);
  await expect(editor).toBeVisible();

  await editor.locator('.day-input').fill('abc');
  await editor.locator('.day-save').click();

  await expect(editor.locator('.day-error')).toHaveText('Enter a number');
  await expect(editor).toBeVisible();

  expect(postRequests.length).toBe(0);
  expect(deleteRequests.length).toBe(0);
  expect(getRequests.length).toBe(1);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// H12 — future/outside/before cells are inert
// ===========================================================================

test('H12 — outside/future/before cells are not <button> elements, carry no data-date, and clicking one opens nothing', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');

  // 'outside' is unconditionally guaranteed: every 42-cell month grid has
  // at least one padding cell, since no calendar month has 42 days. 'future'
  // and 'before' are checked too, but only when the real calendar day the
  // suite happens to run on actually produces one in the default view (a
  // 'future' cell is absent only if today is the last day of its month; a
  // 'before' cell never appears in the default 3m view at all, since 90
  // days always exceeds the span from the 1st of the current month to
  // today) — this loop degrades gracefully rather than hardcoding an
  // assumption about the current date's position in its month.
  let checkedAtLeastOne = false;
  for (const state of ['outside', 'future', 'before']) {
    const cell = page.locator(`.hm-cell[data-cell-state="${state}"]`).first();
    if ((await cell.count()) === 0) continue;
    checkedAtLeastOne = true;

    const tagName = await cell.evaluate((el) => el.tagName);
    expect(tagName).not.toBe('BUTTON');
    expect(await cell.getAttribute('data-date')).toBeNull();

    await cell.click();
    await expect(page.locator('.day-editor')).toHaveCount(0);
  }
  expect(checkedAtLeastOne).toBe(true);

  const outsideCell = page.locator('.hm-cell[data-cell-state="outside"]').first();
  await expect(outsideCell).toHaveCount(1);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// H13 — Cancel closes the editor with zero requests
// ===========================================================================

test('H13 — Cancel closes the day editor with zero requests', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM]);
  const { postRequests, deleteRequests, getRequests } = await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect.poll(() => getRequests.length).toBe(1);

  await page.locator(`.hm-cell[data-date="${PAST_DATE}"]`).click();
  const editor = page.locator(`.day-editor[data-date="${PAST_DATE}"]`);
  await expect(editor).toBeVisible();

  await editor.locator('.day-cancel').click();
  await expect(page.locator('.day-editor')).toHaveCount(0);

  expect(postRequests.length).toBe(0);
  expect(deleteRequests.length).toBe(0);
  expect(getRequests.length).toBe(1);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// H14 — layout
// ===========================================================================

test('H14 — no uncaught page errors, no horizontal scroll at 390px, every .hm-cell is >=40px, .hm-nav buttons are >=44px', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err));

  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_NUM]);
  await routeEntries(page, {
    getFixture: [{ id: 908, trackable_id: 366, entry_date: PAST_DATE, value: 1850, note: null }],
  });

  await page.goto('/index.html#/t/366');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('.heatmap')).toHaveCount(1);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);

  const cellBoxes = await page.locator('.hm-cell').evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
  expect(cellBoxes.length).toBe(42);
  for (const box of cellBoxes) {
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.width).toBeGreaterThanOrEqual(40);
  }

  const navBoxes = await page.locator('.hm-nav').evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
  expect(navBoxes.length).toBeGreaterThan(0);
  for (const box of navBoxes) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
});
