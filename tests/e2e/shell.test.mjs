// E2E smoke tests for the Step 0.3 app shell: hash router + persistent bottom
// nav rendered by index.html/js/main.js. Kept to high-value structural/browser
// checks (real navigation, real DOM, real script execution) — logic belongs
// in tests/unit/router.test.mjs and tests/unit/sw-assets.test.mjs instead.
//
// Do NOT start a server here and do NOT hardcode the base URL or viewport;
// both are supplied by playwright.config.mjs (baseURL 127.0.0.1:8123,
// 390x844 viewport).

import { test, expect } from '@playwright/test';

// MANDATORY MECHANIC #1 (see tests/e2e/home.test.mjs, read first): block
// service workers for every test in this file. sw.js installs a `fetch`
// event handler that proxies every request through itself; requests that
// originate from *inside* a service worker are NOT visible to
// page.route() — Playwright's request interception only sees requests
// made by the page/document, so if the SW is allowed to install and take
// over fetch, our route() fixtures below would silently stop applying and
// the app would hit the LIVE Supabase database instead. Blocking service
// workers entirely sidesteps that.
//
// Verified safe for every test in this file: none of them reference
// `navigator.serviceWorker`, `caches`, or any offline/install behaviour —
// they check data-route, nav markup, window.Chart, and layout, all of
// which come from the page's own script execution, not the SW.
test.use({ serviceWorkers: 'block' });

// --- route helpers -------------------------------------------------------
//
// Since Step 2.1/2.3, the 'home' and 'detail' routes each mount a real
// view whose mount() calls the store, which fetches from PostgREST. Any
// test in this file that navigates to '/' (home) or '#/t/:id' (detail)
// now makes a real network call unless intercepted — same guard-first
// pattern as tests/e2e/home.test.mjs: a broad catch-all registered FIRST
// records and aborts anything unclaimed, and (where a test needs one) a
// narrower fixture route is registered after it. This file has no
// interest in any particular data shape — these are shell/routing smoke
// tests, not view-content tests — so every fixture route below just
// returns an empty list.

async function installGuard(page) {
  const unexpected = [];
  await page.route('**/rest/v1/**', async (route) => {
    unexpected.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort();
  });
  return unexpected;
}

async function routeEmptyRest(page) {
  await page.route('**/rest/v1/trackables*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/rest/v1/entries*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

test('index.html loads: 200, title "Daily", no uncaught page errors', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err);
  });

  const unexpected = await installGuard(page);
  await routeEmptyRest(page);

  const response = await page.goto('/index.html');
  expect(response.status()).toBe(200);
  expect(await page.title()).toBe('Daily');
  expect(pageErrors).toEqual([]);

  expect(unexpected).toEqual([]);
});

test('#app exists and has data-route="home" on initial load', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html');
  const app = page.locator('#app');
  await expect(app).toHaveAttribute('data-route', 'home');

  expect(unexpected).toEqual([]);
});

test('#nav exists with exactly 3 links to #/, #/compare, #/settings', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html');
  const nav = page.locator('#nav');
  await expect(nav).toBeAttached();

  const links = nav.locator('a');
  await expect(links).toHaveCount(3);

  const hrefs = await links.evaluateAll((els) => els.map((el) => el.getAttribute('href')));
  expect(hrefs).toContain('#/');
  expect(hrefs).toContain('#/compare');
  expect(hrefs).toContain('#/settings');

  expect(unexpected).toEqual([]);
});

test('navigating via hash updates #app data-route for settings, compare, and new', async ({ page }) => {
  await page.goto('/index.html#/settings');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'settings');

  await page.goto('/index.html#/compare');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'compare');

  await page.goto('/index.html#/new');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'new');
});

// Repointed for Step 2.3: the old assertion ("#app contains the text '42'")
// tested the Step 2.2 static placeholder, which is gone — js/main.js now
// mounts the real js/views/detail.js for the 'detail' route. This file's
// job is the shell/router, not the detail view's internals (those are
// tests/e2e/detail.test.mjs's job), so what still matters here is the
// routing property: the router resolves '#/t/42' to data-route="detail"
// and actually mounts the detail view for that id. js/views/detail.js sets
// data-trackable-id from the route param even in its 'notfound' state (id
// 42 is not in the empty fixture below), so this assertion is stable
// regardless of whether id 42 exists.
test('#/t/42 routes to data-route="detail" and mounts section.detail for that id', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html#/t/42');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'detail');
  await expect(page.locator('section.detail')).toHaveAttribute('data-trackable-id', '42');

  expect(unexpected).toEqual([]);
});

test('#/nope renders a real notfound view without silently redirecting', async ({ page }) => {
  await page.goto('/index.html#/nope');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'notfound');

  // Must not have silently redirected away from the bad hash.
  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toBe('#/nope');

  // Must render a real view: a heading, plus a link back home. The contract
  // only requires these appear in the rendered view, not specifically inside
  // #app, so check the whole page rather than assuming a container.
  const heading = page.locator('h1, h2, h3');
  expect(await heading.count()).toBeGreaterThan(0);

  const homeLink = page.locator('a[href="#/"]');
  expect(await homeLink.count()).toBeGreaterThan(0);
});

test('clicking a nav link updates data-route without a full page reload', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'home');

  // Plant a sentinel on window. A full page reload/navigation would wipe it;
  // hash-only navigation must leave it intact.
  await page.evaluate(() => {
    window.__shellTestSentinel = 'still-here';
  });

  await page.locator('#nav a[href="#/settings"]').click();

  await expect(page.locator('#app')).toHaveAttribute('data-route', 'settings');
  const sentinel = await page.evaluate(() => window.__shellTestSentinel);
  expect(sentinel).toBe('still-here');

  expect(unexpected).toEqual([]);
});

test('the active nav link has aria-current="page" and inactive ones do not', async ({ page }) => {
  await page.goto('/index.html#/compare');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'compare');

  const activeLink = page.locator('#nav a[href="#/compare"]');
  await expect(activeLink).toHaveAttribute('aria-current', 'page');

  const homeLink = page.locator('#nav a[href="#/"]');
  const settingsLink = page.locator('#nav a[href="#/settings"]');
  await expect(homeLink).not.toHaveAttribute('aria-current', 'page');
  await expect(settingsLink).not.toHaveAttribute('aria-current', 'page');
});

test('window.Chart is defined after load (pinned Chart.js UMD script executed)', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html');
  const chartDefined = await page.evaluate(() => typeof window.Chart !== 'undefined');
  expect(chartDefined).toBe(true);

  expect(unexpected).toEqual([]);
});

test('the bottom nav is visible and its bounding box sits within the 390x844 viewport', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html');
  const nav = page.locator('#nav');
  await expect(nav).toBeVisible();

  const viewport = page.viewportSize();
  expect(viewport).toEqual({ width: 390, height: 844 });

  const box = await nav.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

  expect(unexpected).toEqual([]);
});
