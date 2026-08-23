// E2E tests for the Step 2.1 home view (js/views/home.js): trackable list +
// quick-log, mounted at #/ per CONTRACT-2.1.md. Written strictly against
// that contract's §3 (DOM contract/behaviour) and §6.2 (test plan, cases E1
// through E15) — the implementation is being written in parallel by another
// agent and is not visible here.
//
// Do NOT start a server here and do NOT hardcode the base URL or viewport;
// both are supplied by playwright.config.mjs (baseURL 127.0.0.1:8123,
// 390x844 viewport).
//
// GUARDRAIL (see docs/ORCHESTRATION.md / CONTRACT-2.1.md §7): nothing in
// this file may create, modify, or delete a real Supabase row. Every
// PostgREST call the app makes is intercepted with page.route() and fully
// fulfilled/aborted from fixtures — this file makes ZERO real network calls
// to Supabase. That is verified per-test below via installGuard().

import { test, expect } from '@playwright/test';

// MANDATORY MECHANIC #1: block service workers for every test in this file.
// sw.js installs a `fetch` event handler that proxies every request through
// itself (see sw.js's `fetch` listener). Requests that originate from
// *inside* a service worker are NOT visible to page.route() — Playwright's
// request interception only sees requests made by the page/document, so if
// the SW is allowed to install and take over fetch, our route() fixtures
// silently stop applying and the app hits the LIVE Supabase database
// instead. Blocking service workers entirely sidesteps that.
test.use({ serviceWorkers: 'block' });

// --- fixtures (ids matter for the assertions below — from contract §6.2) ---

const T_BOOL = {
  id: 1,
  name: 'Workout',
  value_shape: 'boolean',
  relog_semantic: 'cumulative',
  aggregation: 'count',
  direction: 'build',
  unit: null,
  color: null,
  sort_order: 0,
  archived: false,
};
const T_CUM = {
  id: 2,
  name: 'Calories',
  value_shape: 'numeric',
  relog_semantic: 'cumulative',
  aggregation: 'sum',
  direction: 'break',
  unit: 'kcal',
  color: null,
  sort_order: 1,
  archived: false,
};
const T_STATE = {
  id: 3,
  name: 'Weight',
  value_shape: 'numeric',
  relog_semantic: 'state',
  aggregation: 'last',
  direction: 'break',
  unit: 'kg',
  color: null,
  sort_order: 2,
  archived: false,
};
const T_ARCH = { id: 4, name: 'Old', value_shape: 'boolean', sort_order: 3, archived: true };

// --- CONTRACT-2.1b.md fixtures ("Replace-only logging + direction-aware
// visuals") -----------------------------------------------------------
//
// T_BREAK is the break-direction boolean fixture the contract's §6.2 asks
// for verbatim (id:5, name:'Smoking', direction:'break', sort_order:4,
// archived:false), extended with the same surrounding fields the other
// fixtures carry for consistency.
const T_BREAK = {
  id: 5,
  name: 'Smoking',
  value_shape: 'boolean',
  relog_semantic: 'state',
  aggregation: 'count',
  direction: 'break',
  unit: null,
  color: null,
  sort_order: 4,
  archived: false,
};

// T_CAL_STATE represents the post-migration-0004 reality for a numeric
// trackable: relog_semantic defaults to 'state' now, so re-logging Calories
// REPLACES today's value rather than adding to it. This is deliberately a
// separate fixture from T_CUM (id:2, relog_semantic:'cumulative') — T_CUM is
// kept as-is (see E6 below) to prove the underlying applyRelog cumulative
// branch still works for data that explicitly requests it (contract §3.7:
// "so a future trackable could still opt in"), while T_CAL_STATE is what a
// real Calories trackable looks like today, now that the UI never offers
// the cumulative choice.
const T_CAL_STATE = {
  id: 6,
  name: 'Calories',
  value_shape: 'numeric',
  relog_semantic: 'state',
  aggregation: 'sum',
  direction: 'break',
  unit: 'kcal',
  color: null,
  sort_order: 5,
  archived: false,
};

// T_NUM_BUILD is a build-direction numeric fixture, for V7's "more is
// better" case (T_CAL_STATE above covers "less is better").
const T_NUM_BUILD = {
  id: 7,
  name: 'Reading',
  value_shape: 'numeric',
  relog_semantic: 'state',
  aggregation: 'sum',
  direction: 'build',
  unit: 'pages',
  color: null,
  sort_order: 6,
  archived: false,
};

// V8 (greyscale survivability) needs all four boolean statusWord states
// visible at once, which needs four distinct rows (a single trackable can
// only be in one state per page load): build-logged, build-unlogged,
// break-logged, break-unlogged.
const T_V8_BUILD_LOGGED = {
  id: 10,
  name: 'V8BuildLogged',
  value_shape: 'boolean',
  direction: 'build',
  sort_order: 10,
  archived: false,
};
const T_V8_BUILD_UNLOGGED = {
  id: 11,
  name: 'V8BuildUnlogged',
  value_shape: 'boolean',
  direction: 'build',
  sort_order: 11,
  archived: false,
};
const T_V8_BREAK_LOGGED = {
  id: 12,
  name: 'V8BreakLogged',
  value_shape: 'boolean',
  direction: 'break',
  sort_order: 12,
  archived: false,
};
const T_V8_BREAK_UNLOGGED = {
  id: 13,
  name: 'V8BreakUnlogged',
  value_shape: 'boolean',
  direction: 'break',
  sort_order: 13,
  archived: false,
};

// Compute "today" the same way the app must (local calendar components, NOT
// toISOString, which reads UTC and is wrong for part of every day).
const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// --- route helpers -----------------------------------------------------
//
// Playwright matches multiple registered page.route() handlers most-
// recently-registered-first; a handler that doesn't fulfill/abort/continue
// (i.e. that never runs at all because a later, more specific handler
// already claimed the request) simply never fires. We exploit that: the
// broad catch-all guard below is registered FIRST (lowest priority) and the
// narrow, per-endpoint handlers are registered AFTER it in each test
// (higher priority, so they claim every request the test actually expects).
// Anything left over — any PostgREST call this step's contract doesn't
// account for — falls through to the guard, which records it and aborts it,
// so it can never reach the live database and the test can assert on it.

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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(trackables),
    });
  });
}

// post/del configs: { status, body, delayMs } (all optional). `getFixture`
// is the array returned for GET. Returns arrays this test can assert on:
// { postRequests, deleteRequests } — each entry { url, headers, body }.
async function routeEntries(page, { getFixture = [], post = {}, del = {} } = {}) {
  const postRequests = [];
  const deleteRequests = [];

  await page.route('**/rest/v1/entries*', async (route) => {
    const req = route.request();
    const method = req.method();

    if (method === 'GET') {
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
      const status = post.status ?? 200;
      const respBody = post.body ?? [];
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(respBody),
      });
      return;
    }

    if (method === 'DELETE') {
      deleteRequests.push({ url: req.url(), headers: req.headers() });
      if (del.delayMs) await new Promise((resolve) => setTimeout(resolve, del.delayMs));
      const status = del.status ?? 200;
      const respBody = del.body ?? [];
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(respBody),
      });
      return;
    }

    // Not a method this step's contract uses — let the guard's semantics
    // apply: abort rather than let it fall through to a real network call.
    await route.abort();
  });

  return { postRequests, deleteRequests };
}

// ===========================================================================
// E1 — empty
// ===========================================================================

test('E1 — empty trackables renders the empty state, no ul.tlist, a link to #/new', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, []);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/');

  const home = page.locator('section.home');
  await expect(home).toHaveAttribute('data-home-state', 'empty');
  await expect(page.locator('ul.tlist')).toHaveCount(0);
  const link = page.locator('a[href="#/new"]');
  await expect(link).toBeVisible();

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// E2 — list + sort + archived
// ===========================================================================

test('E2 — visible rows are sorted by sort_order/id and archived rows are dropped', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  // Deliberately out of order, with an archived row mixed in.
  await routeTrackables(page, [T_STATE, T_BOOL, T_ARCH, T_CUM]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/');

  const rows = page.locator('li.trow');
  await expect(rows).toHaveCount(3);
  const ids = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-trackable-id')));
  expect(ids).toEqual(['1', '2', '3']);
  await expect(page.locator('li.trow[data-trackable-id="4"]')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// E3 — boolean unlogged
// ===========================================================================

test('E3 — a boolean row with no entry today renders unlogged', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOOL]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="1"]');
  await expect(row).toHaveAttribute('data-logged', 'false');
  // CONTRACT-2.1b.md §4.2: boolean rows now show statusWord ('Not yet' /
  // 'Done' / 'Clean' / 'Logged'), not formatValue's '—' / 'Done'. T_BOOL is
  // direction:'build', so unlogged -> 'Not yet'.
  await expect(row.locator('.trow-value')).toHaveText('Not yet');
  await expect(row.locator('.trow-hint')).toHaveText('Tap to log today');
  const btn = row.locator('.trow-log');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(btn).toHaveAttribute('aria-label', 'Log Workout for today');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// E4 — boolean log is optimistic, then confirmed
// ===========================================================================

test('E4 — logging a boolean row is optimistic immediately, then confirmed by the server response', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOOL]);
  const { postRequests } = await routeEntries(page, {
    getFixture: [],
    post: {
      delayMs: 400,
      body: [
        {
          id: 501,
          trackable_id: 1,
          entry_date: TODAY,
          value: 1,
          note: null,
          created_at: `${TODAY}T00:00:00Z`,
          updated_at: `${TODAY}T00:00:00Z`,
        },
      ],
    },
  });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="1"]');
  await expect(row.locator('.trow-log')).toBeEnabled();

  await row.locator('.trow-log').click();

  // Must feel instant: the optimistic state is visible while the POST
  // (delayed ~400ms above) is still in flight.
  await expect(row).toHaveAttribute('data-logged', 'true');
  await expect(row).toHaveAttribute('data-state', 'pending');

  // Now wait for the delayed response to resolve and confirm.
  await expect(row).toHaveAttribute('data-state', 'idle');
  // CONTRACT-2.1b.md §4.2: '.trow-value' now shows statusWord, not
  // formatValue. T_BOOL is direction:'build', so logged -> 'Done' — this
  // happens to be textually identical to the old formatValue('Done')
  // result, but it is now sourced from a different function.
  await expect(row.locator('.trow-value')).toHaveText('Done');
  await expect(row).toHaveAttribute('data-verdict', 'good');

  expect(postRequests.length).toBe(1);
  const posted = postRequests[0];
  expect(posted.url).toContain('on_conflict=trackable_id,entry_date');
  expect(posted.headers['prefer']).toBe('resolution=merge-duplicates,return=representation');
  expect(JSON.parse(posted.body)).toEqual({ trackable_id: 1, entry_date: TODAY, value: 1 });

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// E5 — boolean un-toggle is a DELETE, not a zero-save
// ===========================================================================

test('E5 — un-toggling a logged boolean row issues a DELETE and never a POST', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOOL]);
  const { postRequests, deleteRequests } = await routeEntries(page, {
    getFixture: [
      { id: 99, trackable_id: 1, entry_date: TODAY, value: 1, note: null },
    ],
    del: { body: [{ id: 99, trackable_id: 1, entry_date: TODAY, value: 1, note: null }] },
  });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="1"]');
  await expect(row).toHaveAttribute('data-logged', 'true');

  await row.locator('.trow-log').click();

  await expect(row).toHaveAttribute('data-logged', 'false');
  await expect(row).toHaveAttribute('data-state', 'idle');

  expect(deleteRequests.length).toBe(1);
  expect(deleteRequests[0].url).toContain('trackable_id=eq.1');
  expect(deleteRequests[0].url).toContain(`entry_date=eq.${TODAY}`);
  expect(postRequests.length).toBe(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// E6 — numeric cumulative adds
// ===========================================================================

test('E6 — a numeric trackable whose DATA still says relog_semantic:"cumulative" still adds (applyRelog/nextValueFor untouched by 2.1b — CONTRACT-2.1b.md §3.7)', async ({
  page,
}) => {
  // NOTE (2.1b): this case is NOT obsolete. CONTRACT-2.1b.md §3.7 requires
  // nextValueFor to keep delegating to applyRelog exactly as before — "so a
  // future trackable could still opt in" — and forbids special-casing
  // replace-only in JS. The product-level "additive logging is removed"
  // change is achieved by the UI never creating a trackable with
  // relog_semantic:'cumulative' any more (migration 0004 defaults new rows
  // to 'state' and backfills existing ones), not by deleting the cumulative
  // code path. T_CUM here still explicitly claims relog_semantic:'cumulative'
  // to prove that path is intact. See V6 below for the actual regression
  // guard on the new default ('state') behaviour.
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CUM]);
  const { postRequests } = await routeEntries(page, {
    getFixture: [{ id: 100, trackable_id: 2, entry_date: TODAY, value: 320, note: null }],
    post: {
      body: [{ id: 101, trackable_id: 2, entry_date: TODAY, value: 820, note: null }],
    },
  });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="2"]');
  await expect(row.locator('.trow-value')).toHaveText('320 kcal');
  // CONTRACT-2.1b.md §3.5: relogHint's wording no longer varies by
  // relog_semantic at all — was 'Today: 320 kcal · new value is added'.
  await expect(row.locator('.trow-hint')).toHaveText('Today: 320 kcal · tap to change');

  await row.locator('.trow-log').click();

  const input = row.locator('input.trow-input');
  await expect(input).toBeAttached();
  await expect(input).toHaveAttribute('inputmode', 'decimal');
  await expect(input).toBeFocused();

  await input.fill('500');
  await row.locator('.trow-save').click();

  expect(postRequests.length).toBe(1);
  expect(JSON.parse(postRequests[0].body).value).toBe(820);
  await expect(row.locator('.trow-value')).toHaveText('820 kcal');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// E7 — numeric state replaces
// ===========================================================================

test('E7 — the numeric state editor replaces the existing value, does not add to it', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_STATE]);
  const { postRequests } = await routeEntries(page, {
    getFixture: [{ id: 200, trackable_id: 3, entry_date: TODAY, value: 78.4, note: null }],
    post: {
      body: [{ id: 201, trackable_id: 3, entry_date: TODAY, value: 79.1, note: null }],
    },
  });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="3"]');
  await row.locator('.trow-log').click();
  const input = row.locator('input.trow-input');
  await input.fill('79.1');
  await row.locator('.trow-save').click();

  expect(postRequests.length).toBe(1);
  // Must be exactly 79.1 (the replacement), NOT 157.5 (78.4 + 79.1).
  expect(JSON.parse(postRequests[0].body).value).toBe(79.1);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// E8 — invalid input
// ===========================================================================

test('E8 — invalid numeric input issues no request and shows an inline error', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CUM]);
  const { postRequests } = await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="2"]');
  await row.locator('.trow-log').click();
  const input = row.locator('input.trow-input');
  await input.fill('abc');
  await row.locator('.trow-save').click();

  expect(postRequests.length).toBe(0);
  await expect(input).toBeAttached();
  await expect(input).toHaveValue('abc');
  await expect(row.locator('.trow-error')).toHaveText('Enter a number');
  const state = await row.getAttribute('data-state');
  expect(state).not.toBe('failed');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// E9 — retryable failure -> outbox (highest-value case)
// ===========================================================================

test('E9 — a retryable (503) failure leaves the row pending and persists the op to the outbox', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOOL]);
  await routeEntries(page, {
    getFixture: [],
    post: { status: 503, body: { message: 'service unavailable' } },
  });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="1"]');
  await row.locator('.trow-log').click();

  await expect(row).toHaveAttribute('data-state', 'pending');
  await expect(row).toHaveAttribute('data-logged', 'true');

  const outboxRaw = await page.evaluate(() => localStorage.getItem('daily.outbox.v1'));
  expect(outboxRaw).not.toBeNull();
  const outbox = JSON.parse(outboxRaw);
  expect(outbox.ops.length).toBe(1);
  expect(outbox.ops[0].key).toBe(`1|${TODAY}`);
  expect(outbox.ops[0].payload.value).toBe(1);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// E10 — non-retryable failure reverts
// ===========================================================================

test('E10 — a non-retryable (400) failure reverts the row and leaves the outbox empty', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOOL]);
  await routeEntries(page, {
    getFixture: [],
    post: {
      status: 400,
      body: { code: '22P02', message: 'invalid input syntax', details: null, hint: null },
    },
  });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="1"]');
  await row.locator('.trow-log').click();

  await expect(row).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('.trow-error[role="alert"]')).toBeVisible();
  await expect(row).toHaveAttribute('data-logged', 'false');
  // CONTRACT-2.1b.md §4.2: boolean '.trow-value' shows statusWord now, not
  // formatValue's '—'. T_BOOL is direction:'build', reverted-to-unlogged ->
  // 'Not yet'.
  await expect(row.locator('.trow-value')).toHaveText('Not yet');

  const outboxRaw = await page.evaluate(() => localStorage.getItem('daily.outbox.v1'));
  if (outboxRaw !== null) {
    const outbox = JSON.parse(outboxRaw);
    expect(outbox.ops.length).toBe(0);
  }

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// E11 — offline read from cache
// ===========================================================================

test('E11 — a failed trackables load still shows cached data with an offline notice', async ({
  page,
}) => {
  const unexpected = await installGuard(page);

  await page.addInitScript((cache) => {
    localStorage.setItem('daily.cache.v1', JSON.stringify(cache));
  }, { v: 1, trackables: [T_BOOL], entries: [] });

  await page.route('**/rest/v1/trackables*', (route) => route.abort());
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/');

  await expect(page.locator('li.trow')).toHaveCount(1);
  const offline = page.locator('p.home-offline');
  await expect(offline).toBeVisible();
  const text = (await offline.textContent()) || '';
  expect(text.toLowerCase()).toContain('offline');

  // The trackables route always aborts, so it is expected to show up as an
  // aborted request from OUR OWN handler, not from the fallback guard — the
  // guard itself must still see nothing unaccounted for.
  expect(unexpected).toEqual([]);
});

// ===========================================================================
// E12 — no listener leak across navigation
// ===========================================================================

test('E12 — navigating away and back leaves exactly one section.home and no duplicated listeners', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOOL]);
  const { postRequests } = await routeEntries(page, {
    getFixture: [],
    post: { body: [{ id: 301, trackable_id: 1, entry_date: TODAY, value: 1, note: null }] },
  });

  await page.goto('/index.html#/');
  await expect(page.locator('section.home')).toHaveCount(1);

  await page.goto('/index.html#/settings');
  await page.goto('/index.html#/');
  await expect(page.locator('section.home')).toHaveCount(1);

  const row = page.locator('li.trow[data-trackable-id="1"]');
  await row.locator('.trow-log').click();
  await expect(row).toHaveAttribute('data-state', 'idle');

  // If the click listener had leaked (attached twice across the
  // navigations), one tap would have fired two writes.
  expect(postRequests.length).toBe(1);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// E13 — an open editor survives an unrelated re-render
// ===========================================================================

test('E13 — an open numeric editor survives a re-render triggered by another row', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOOL, T_CUM]);
  await routeEntries(page, {
    getFixture: [],
    post: { body: [{ id: 401, trackable_id: 1, entry_date: TODAY, value: 1, note: null }] },
  });

  await page.goto('/index.html#/');

  const calRow = page.locator('li.trow[data-trackable-id="2"]');
  await calRow.locator('.trow-log').click();
  const calInput = calRow.locator('input.trow-input');
  await calInput.fill('12');

  const workoutRow = page.locator('li.trow[data-trackable-id="1"]');
  await workoutRow.locator('.trow-log').click();
  await expect(workoutRow).toHaveAttribute('data-state', 'idle');

  await expect(calInput).toBeAttached();
  await expect(calInput).toHaveValue('12');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// E14 — no uncaught page errors, no horizontal scroll
// ===========================================================================

test('E14 — a populated home route throws no uncaught page errors and does not scroll horizontally at 390px', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err));

  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOOL, T_CUM, T_STATE]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/');
  await expect(page.locator('li.trow')).toHaveCount(3);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
  expect(pageErrors).toEqual([]);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// E15 — tap targets
// ===========================================================================

test('E15 — every .trow-log button is at least 44px tall', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOOL, T_CUM, T_STATE]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/');

  const buttons = page.locator('.trow-log');
  await expect(buttons).toHaveCount(3);
  const heights = await buttons.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  for (const h of heights) {
    expect(h).toBeGreaterThanOrEqual(44);
  }

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// CONTRACT-2.1b.md §6.2 — V1 through V8
// ===========================================================================
// "Replace-only logging + direction-aware visuals": V1-V4 cover the four
// possible (direction × logged) boolean states and their verdict/statusWord/
// statusSymbol; V5 proves the optimistic toggle recomputes verdict
// immediately, not just data-logged; V6 is the primary regression guard for
// the whole revision (numeric re-logging must REPLACE, never add); V7
// covers the new directionLabel on numeric rows; V8 proves the four boolean
// states are distinguishable by text alone (WCAG 1.4.1 — colour is never
// the only cue).

// ===========================================================================
// V1 — build boolean, unlogged
// ===========================================================================

test('V1 — a build-direction boolean with no entry today is verdict "neutral", text "Not yet", symbol "empty"', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOOL]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="1"]');
  await expect(row).toHaveAttribute('data-verdict', 'neutral');
  await expect(row.locator('.trow-value')).toHaveText('Not yet');
  await expect(row.locator('.trow-symbol')).toHaveAttribute('data-symbol', 'empty');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// V2 — build boolean, logged
// ===========================================================================

test('V2 — a build-direction boolean logged today is verdict "good", text "Done", symbol "check"', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOOL]);
  await routeEntries(page, {
    getFixture: [{ id: 600, trackable_id: 1, entry_date: TODAY, value: 1, note: null }],
  });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="1"]');
  await expect(row).toHaveAttribute('data-verdict', 'good');
  await expect(row.locator('.trow-value')).toHaveText('Done');
  await expect(row.locator('.trow-symbol')).toHaveAttribute('data-symbol', 'check');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// V3 — break boolean, unlogged — THE COUNTER-INTUITIVE CASE
// ===========================================================================

// This is deliberate and is the heart of CONTRACT-2.1b's design — DO NOT
// "fix" it to mean logged==good. A green check here means "today is good",
// not "logged". For a break-direction habit (e.g. Smoking) the UNLOGGED day
// is the win: ticking a bad-habit box would otherwise read as an
// achievement and reward exactly the behaviour the user is trying to stop.
// CONTRACT-2.1b.md §0 cites the research backing this: the Loop Habit
// Tracker (the most established open-source tracker) refuses bad-habit
// tracking for this exact reason, while apps that do support it (Streaks
// "negative tasks", Quitzilla, Simple Streak) invert the reward so the
// clean day is the win. If a future change makes this test fail because
// "check now means logged", that is a regression, not a fix — revert it.
test('V3 — a break-direction boolean with NO entry today is verdict "good" (a clean day is the win, not a "fix")', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BREAK]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="5"]');
  await expect(row).toHaveAttribute('data-verdict', 'good');
  await expect(row.locator('.trow-value')).toHaveText('Clean');
  await expect(row.locator('.trow-symbol')).toHaveAttribute('data-symbol', 'check');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// V4 — break boolean, logged
// ===========================================================================

test('V4 — a break-direction boolean logged today is verdict "bad", text "Logged", symbol "cross"', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BREAK]);
  await routeEntries(page, {
    getFixture: [{ id: 601, trackable_id: 5, entry_date: TODAY, value: 1, note: null }],
  });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="5"]');
  await expect(row).toHaveAttribute('data-verdict', 'bad');
  await expect(row.locator('.trow-value')).toHaveText('Logged');
  await expect(row.locator('.trow-symbol')).toHaveAttribute('data-symbol', 'cross');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// V5 — tapping a break boolean flips good->bad immediately (optimistic
// update must recompute verdict, not just data-logged — CONTRACT-2.1b.md §4.3)
// ===========================================================================

test('V5 — tapping an unlogged break-direction boolean flips verdict good->bad and symbol check->cross while the POST is still in flight', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BREAK]);
  await routeEntries(page, {
    getFixture: [],
    post: {
      delayMs: 400,
      body: [
        {
          id: 602,
          trackable_id: 5,
          entry_date: TODAY,
          value: 1,
          note: null,
          created_at: `${TODAY}T00:00:00Z`,
          updated_at: `${TODAY}T00:00:00Z`,
        },
      ],
    },
  });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="5"]');
  await expect(row).toHaveAttribute('data-verdict', 'good');

  await row.locator('.trow-log').click();

  // The POST is delayed ~400ms above — this assertion must observe the
  // optimistic state WHILE the request is still open, not after it settles.
  await expect(row).toHaveAttribute('data-verdict', 'bad');
  await expect(row.locator('.trow-symbol')).toHaveAttribute('data-symbol', 'cross');
  await expect(row).toHaveAttribute('data-state', 'pending');

  // Let the delayed response resolve so the test doesn't leak a pending
  // route into the next test.
  await expect(row).toHaveAttribute('data-state', 'idle');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// V6 — numeric replaces, never adds (PRIMARY REGRESSION GUARD)
// ===========================================================================

// This is the highest-value test in this revision: additive logging has
// been removed from the product at the user's request (CONTRACT-2.1b.md
// §0.1). T_CAL_STATE represents what a real Calories trackable looks like
// today, post-migration-0004 (relog_semantic defaults to 'state' and
// existing rows were backfilled to it). If this test ever sees a POST body
// value of 2500 instead of 500, additive logging has silently come back.
test('V6 — numeric re-log REPLACES the day\'s value; the POST body must be 500, not 2500', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CAL_STATE]);
  const { postRequests } = await routeEntries(page, {
    getFixture: [{ id: 700, trackable_id: 6, entry_date: TODAY, value: 2000, note: null }],
    post: {
      body: [{ id: 701, trackable_id: 6, entry_date: TODAY, value: 500, note: null }],
    },
  });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="6"]');
  await expect(row.locator('.trow-value')).toHaveText('2000 kcal');

  await row.locator('.trow-log').click();
  const input = row.locator('input.trow-input');
  await input.fill('500');
  await row.locator('.trow-save').click();

  expect(postRequests.length).toBe(1);
  const posted = JSON.parse(postRequests[0].body);
  // The whole point of this test: 500, NOT 2000 + 500 = 2500.
  expect(posted.value).toBe(500);
  expect(posted.value).not.toBe(2500);
  await expect(row.locator('.trow-value')).toHaveText('500 kcal');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// V7 — numeric direction label
// ===========================================================================

test('V7 — numeric rows show a plain-English directionLabel ("less is better" / "more is better"), never the raw enum', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_CAL_STATE, T_NUM_BUILD]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/');

  const breakRow = page.locator('li.trow[data-trackable-id="6"]'); // T_CAL_STATE, direction:'break'
  await expect(breakRow.locator('.trow-direction')).toHaveText('less is better');

  const buildRow = page.locator('li.trow[data-trackable-id="7"]'); // T_NUM_BUILD, direction:'build'
  await expect(buildRow.locator('.trow-direction')).toHaveText('more is better');

  // Never the raw enum value leaking into the DOM.
  await expect(breakRow.locator('.trow-direction')).not.toHaveText('break');
  await expect(buildRow.locator('.trow-direction')).not.toHaveText('build');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// V8 — greyscale survivability (WCAG 1.4.1: colour is never the only cue)
// ===========================================================================

test('V8 — the four boolean statusWord states (Done/Not yet/Clean/Logged) are all distinct text, so meaning survives without colour', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [
    T_V8_BUILD_LOGGED,
    T_V8_BUILD_UNLOGGED,
    T_V8_BREAK_LOGGED,
    T_V8_BREAK_UNLOGGED,
  ]);
  await routeEntries(page, {
    getFixture: [
      { id: 800, trackable_id: 10, entry_date: TODAY, value: 1, note: null }, // build, logged
      // trackable_id 11 (build, unlogged): no entry
      { id: 801, trackable_id: 12, entry_date: TODAY, value: 1, note: null }, // break, logged
      // trackable_id 13 (break, unlogged): no entry
    ],
  });

  await page.goto('/index.html#/');

  // Use toHaveText (auto-retrying) rather than a raw .textContent() read:
  // mount()'s refresh sequence renders once after trackables load and again
  // after entries load (contract §3.2), so a plain one-shot read can
  // observe the interim trackables-only render — where every row still
  // looks unlogged — instead of the final state. toHaveText polls until it
  // matches or the assertion times out, which is what every other
  // state-reading assertion in this file already relies on.
  const buildLoggedRow = page.locator('li.trow[data-trackable-id="10"] .trow-value');
  const buildUnloggedRow = page.locator('li.trow[data-trackable-id="11"] .trow-value');
  const breakLoggedRow = page.locator('li.trow[data-trackable-id="12"] .trow-value');
  const breakUnloggedRow = page.locator('li.trow[data-trackable-id="13"] .trow-value');

  await expect(buildLoggedRow).toHaveText('Done');
  await expect(buildUnloggedRow).toHaveText('Not yet');
  await expect(breakLoggedRow).toHaveText('Logged');
  await expect(breakUnloggedRow).toHaveText('Clean');

  // All four must be textually distinct — that is what "meaning is carried
  // by words, not colour alone" actually requires. Safe to read with a
  // plain .textContent() now that each has already been confirmed settled
  // above.
  const allFour = await Promise.all([
    buildLoggedRow.textContent(),
    buildUnloggedRow.textContent(),
    breakLoggedRow.textContent(),
    breakUnloggedRow.textContent(),
  ]);
  expect(new Set(allFour).size).toBe(4);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// CONTRACT-2.4.md §9.4 — DEFECT 5: a bounded numeric outside its configured
// range must look wrong (not read as neutral, which was the reported bug).
// ===========================================================================
//
// T_BOUNDED is a manual-bounds numeric trackable (70-80), used by all three
// cases below — only the entry value and bounds_mode differ per test.
const T_BOUNDED = {
  id: 20,
  name: 'Weight',
  value_shape: 'numeric',
  relog_semantic: 'state',
  aggregation: 'last',
  direction: 'build',
  unit: 'kg',
  color: null,
  sort_order: 20,
  archived: false,
  bounds_enabled: true,
  bounds_mode: 'manual',
  bound_lower: 70,
  bound_upper: 80,
};

test('BOUNDS1 — a manual-bounds numeric with an in-range entry (75, inside 70-80) renders data-verdict="good" and .trow-status "In range"', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOUNDED]);
  await routeEntries(page, {
    getFixture: [{ id: 900, trackable_id: 20, entry_date: TODAY, value: 75, note: null }],
  });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="20"]');
  await expect(row).toHaveAttribute('data-verdict', 'good');
  await expect(row.locator('.trow-status')).toHaveText('In range');

  expect(unexpected).toEqual([]);
});

test('BOUNDS2 — a manual-bounds numeric with an out-of-range entry (85, outside 70-80) renders data-verdict="bad", .trow-status "Out of range", and symbol "cross"', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_BOUNDED]);
  await routeEntries(page, {
    getFixture: [{ id: 901, trackable_id: 20, entry_date: TODAY, value: 85, note: null }],
  });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="20"]');
  await expect(row).toHaveAttribute('data-verdict', 'bad');
  await expect(row.locator('.trow-status')).toHaveText('Out of range');
  await expect(row.locator('.trow-symbol')).toHaveAttribute('data-symbol', 'cross');

  expect(unexpected).toEqual([]);
});

test('BOUNDS3 — the same trackable with bounds_mode "auto" (not yet wired to a real derivation — Step 3.3) renders data-verdict="neutral" and no .trow-status element at all', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const autoTrackable = { ...T_BOUNDED, bounds_mode: 'auto' };
  await routeTrackables(page, [autoTrackable]);
  await routeEntries(page, {
    // Same out-of-range value as BOUNDS2 (85) — proves the neutral result
    // here is because bounds_mode isn't 'manual', not because the value
    // happens to be in range.
    getFixture: [{ id: 902, trackable_id: 20, entry_date: TODAY, value: 85, note: null }],
  });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="20"]');
  await expect(row).toHaveAttribute('data-verdict', 'neutral');
  // Element must be OMITTED entirely when statusWord is empty, per
  // CONTRACT-2.4.md §7 ("Omit the element entirely when empty") — not just
  // present-but-empty-text, which is why this checks toHaveCount(0) rather
  // than toHaveText('').
  await expect(row.locator('.trow-status')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// CONTRACT-2.5.md §4.2 — icons + "make colour actually do something"
// ===========================================================================
//
// The reported bug: a per-trackable `color` was stored and computed
// (rowModel already returned it) but rendered NOWHERE — picking a colour
// had no visible effect at all. The fix renders an icon (js/icons.js, a
// tinted monochrome SVG set) as the FIRST child of each li.trow, tinted by
// the trackable's colour via inline `style.color` (which the SVG's
// `stroke="currentColor"`/`fill="currentColor"` picks up).
//
// T_ICON below is deliberately its own fixture (not reusing T_BOOL etc.)
// because none of the existing fixtures in this file set both `icon` and a
// non-null `color` together, and this is the one case that matters most:
// per CONTRACT-2.5.md §0, "the icon is the thing the colour tints."
const T_ICON = {
  id: 30,
  name: 'Workout',
  value_shape: 'boolean',
  relog_semantic: 'state',
  aggregation: 'count',
  direction: 'build',
  unit: null,
  icon: 'dumbbell',
  color: '#34c759',
  sort_order: 30,
  archived: false,
};

const T_ICON_NULL = { ...T_ICON, id: 31, icon: null, color: null };
const T_ICON_BOGUS = { ...T_ICON, id: 32, icon: 'bogus' };

test('ICON1 — a trackable with icon:"dumbbell" and color:"#34c759" renders .trow-icon[data-icon="dumbbell"] containing an svg, tinted rgb(52, 199, 89) via COMPUTED style — the regression guard for the colour-has-no-visual-effect bug', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_ICON]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="30"]');
  const icon = row.locator('.trow-icon');
  await expect(icon).toHaveAttribute('data-icon', 'dumbbell');
  await expect(icon.locator('svg')).toHaveCount(1);

  // THE BINDING ASSERTION (CONTRACT-2.5.md §0 / this task's brief): the
  // colour must be observably applied via getComputedStyle, not merely
  // stored as a data-/style- attribute string. Before the fix, `color` was
  // stored on the trackable and even computed by rowModel(), but nothing in
  // home.js ever read it — an assertion that only checked, say,
  // `.trow-icon`'s `style` attribute string or a `data-color` attribute
  // would have passed against that broken build (the attribute could exist
  // with the right value while the element rendered with no visible tint
  // at all, exactly like CONTRACT-2.4.md's DEFECT 1, where a `hidden`
  // *attribute* was asserted while the field was plainly visible on
  // screen). toHaveCSS reads the element's actual computed style, i.e.
  // what a real user's eye would see.
  await expect(icon).toHaveCSS('color', 'rgb(52, 199, 89)');

  expect(unexpected).toEqual([]);
});

test('ICON2 — a trackable with icon:null renders .trow-icon[data-icon="dot"] (the documented fallback), with no inline colour style when color is also null', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_ICON_NULL]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="31"]');
  const icon = row.locator('.trow-icon');
  await expect(icon).toHaveAttribute('data-icon', 'dot');
  await expect(icon.locator('svg')).toHaveCount(1);
  // CONTRACT-2.5.md §3.1: "When trackable.color is null/empty, omit the
  // inline style and let it inherit the muted default" — so el.style.color
  // must be unset, not merely "some computed colour" (which is always true
  // of every element and would prove nothing about whether the omit rule
  // was honoured).
  const inlineColor = await icon.evaluate((el) => el.style.color);
  expect(inlineColor).toBe('');

  expect(unexpected).toEqual([]);
});

test('ICON3 — a trackable with an unknown icon key ("bogus") also renders .trow-icon[data-icon="dot"] — unknown keys fall back, they do not render an empty box', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, [T_ICON_BOGUS]);
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/');

  const row = page.locator('li.trow[data-trackable-id="32"]');
  const icon = row.locator('.trow-icon');
  await expect(icon).toHaveAttribute('data-icon', 'dot');
  await expect(icon.locator('svg')).toHaveCount(1);
  // Still tinted, per T_ICON_BOGUS's inherited color:'#34c759' — an unknown
  // icon key must not also lose the colour tint.
  await expect(icon).toHaveCSS('color', 'rgb(52, 199, 89)');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// NAV-RACE — a render suspended mid-mount must not clobber a later render
// ===========================================================================
//
// js/main.js's render() is async: for the 'home' route it awaits the home
// view's mount(), which itself awaits a network round trip for trackables
// before doing anything else (js/views/home.js mount(), step 2). If a
// second navigation is made and finishes while an earlier render's mount()
// is still suspended there, the earlier render's continuation resumes
// later and must not overwrite the nav/data-route state the newer,
// already-finished render painted.
//
// render#1 (#/) suspends at `await mount()` while the trackables request is
// deliberately delayed below. Before it resolves, we jump to #/settings:
// render#2 has no network step, so it runs synchronously to completion,
// paints data-route="settings" plus the Settings nav link, AND — critically
// — unmounts render#1's still-live home view instance (main.js's render()
// tears down `currentView` at the top of every call). That flips the home
// view's internal `disposed` flag, so when render#1's mount() resumes after
// the delayed trackables fetch, its own `if (disposed) return;` guard (step
// 2 in js/views/home.js) makes it bail out immediately — it never goes on
// to request entries. So there is no second network call to key a wait off
// of; the only network event render#1 produces at all is the one delayed
// trackables response.
//
// Why the wait can't just be `await expect(...).toHaveAttribute(...)` fired
// right after the hash switch: that assertion retries until it matches, so
// on the buggy build it would simply observe the correct state render#2
// just painted, pass immediately, and never stick around long enough to see
// render#1's stale updateNav('home') clobber it a moment later — a false
// pass on broken code. To actually exercise the race, we must let render#1's
// suspended continuation run to completion BEFORE asserting anything. We
// make that deterministic in two steps: (a) the trackables route handler
// resolves a promise right after its `route.fulfill()` returns, so the test
// knows precisely when the delayed response was handed to the page, and (b)
// a short fixed wait afterward gives the resulting microtask chain — fetch
// resolving, home.js's mount() resuming and hitting its disposed-guard
// return, then render()'s own `await currentView.mount()` resolving and
// (on the buggy build) calling updateNav() — time to actually run before we
// look at the DOM. Nothing after step (a) involves another network round
// trip or timer, so this buffer only has to cover promise-microtask
// plumbing, not another slow operation.
test('NAV-RACE — a render suspended on #/ must not clobber the nav after a later render to #/settings has already painted it', async ({
  page,
}) => {
  const unexpected = await installGuard(page);

  // Trackables GET is deliberately slow (~800ms) so render#1's mount() is
  // reliably still awaiting it when we switch the hash below. The handler
  // resolves `trackablesServed` right after fulfilling, so the test can
  // await the exact moment the delayed response reaches the page.
  let resolveServed;
  const trackablesServed = new Promise((resolve) => {
    resolveServed = resolve;
  });
  await page.route('**/rest/v1/trackables*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([T_BOOL]),
    });
    resolveServed();
  });
  await routeEntries(page, { getFixture: [] });

  // Plain goto, same as every other test in this file — its default
  // waitUntil ('load') only waits on the page's static resources (the
  // module script, the CDN chart libs), not on runtime fetch() calls made
  // afterward by app logic, so by the time this resolves render#1 has
  // already started and is suspended on the delayed trackables fetch below.
  // (An explicit `waitUntil: 'commit'` looked tempting for "don't wait on
  // network," but it can resolve before js/main.js has even executed,
  // racing the hash switch below against module load — do not switch to
  // it.)
  await page.goto('/index.html#/');

  // render#2: navigate to settings before render#1's fetch resolves.
  // Settings has no mount()/network step, so this runs synchronously and
  // paints data-route="settings" plus the settings nav link immediately.
  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'settings');

  // Now let render#1 actually resume and run its (short) continuation out
  // fully: wait for the delayed trackables response to be delivered to the
  // page, then give the resulting microtask chain — fetch resolving,
  // mount()'s disposed-guard return, render()'s outer await resolving and
  // (on the buggy build) its updateNav() call — a fixed buffer to actually
  // execute before we inspect the DOM. Nothing in that chain is another
  // network call or timer, so this is bounded, non-flaky plumbing time, not
  // a guess at how long real work takes.
  await trackablesServed;
  await page.waitForTimeout(200);

  // Only now assert — after render#1's stale continuation has had every
  // opportunity to clobber the nav, if it was going to.
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'settings');
  await expect(page.locator('#nav a[href="#/settings"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#nav a[href="#/"]')).not.toHaveAttribute('aria-current', 'page');

  expect(unexpected).toEqual([]);
});
