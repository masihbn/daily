// E2E smoke tests for the Step 0.3 app shell: hash router + persistent bottom
// nav rendered by index.html/js/main.js. Kept to high-value structural/browser
// checks (real navigation, real DOM, real script execution) — logic belongs
// in tests/unit/router.test.mjs and tests/unit/sw-assets.test.mjs instead.
//
// Do NOT start a server here and do NOT hardcode the base URL or viewport;
// both are supplied by playwright.config.mjs (baseURL 127.0.0.1:8123,
// 390x844 viewport).

import { test, expect } from '@playwright/test';
import { seedSession, installAuthGuard } from '../helpers/e2e-session.mjs';

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

test.beforeEach(async ({ page }) => {
  // Step D.7: the app is gated behind a signed-in session; seed one before
  // any page script runs so existing tests still reach the view under test
  // instead of the sign-in gate.
  await seedSession(page);
});

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
  // Step 4.1: #/settings now mounts a real view that GETs app_settings on
  // mount (js/views/settings.js). This file's interest is shell/nav
  // behaviour, not that view's content, so fulfil it with an uneventful row.
  await page.route('**/rest/v1/app_settings*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 1, rolling_window_days: 90 }]),
    });
  });
}

test('index.html loads: 200, title "Daily", no uncaught page errors', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err);
  });

  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeEmptyRest(page);

  const response = await page.goto('/index.html');
  expect(response.status()).toBe(200);
  expect(await page.title()).toBe('Daily');
  expect(pageErrors).toEqual([]);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

test('#app exists and has data-route="home" on initial load', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html');
  const app = page.locator('#app');
  await expect(app).toHaveAttribute('data-route', 'home');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

test('#nav exists with exactly 3 links to #/, #/compare, #/settings', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
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
  expect(unexpectedAuth).toEqual([]);
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
  const unexpectedAuth = await installAuthGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html#/t/42');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'detail');
  await expect(page.locator('section.detail')).toHaveAttribute('data-trackable-id', '42');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
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
  const unexpectedAuth = await installAuthGuard(page);
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
  expect(unexpectedAuth).toEqual([]);
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
  const unexpectedAuth = await installAuthGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html');
  const chartDefined = await page.evaluate(() => typeof window.Chart !== 'undefined');
  expect(chartDefined).toBe(true);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

test('the bottom nav is visible and its bounding box sits within the 390x844 viewport', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
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
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// Step U.1 (CONTRACT-U.1.md §1/§2/§6): the shell gets a per-route title bar
// (#title-bar/#title/#title-back) instead of the permanent "Daily" <h1>, and
// tab-bar links get an icon + label. Cases S-T1..S-T6 below are exactly
// CONTRACT-U.1.md §6's list, added to this file's existing coverage.
// ===========================================================================

// S-T6 needs a SIGNED-OUT launch, but this file's beforeEach() above
// unconditionally seeds a session via addInitScript for every test (every
// other case in this file needs that). Stacking a second addInitScript that
// removes the session would not reliably win: Playwright's own docs say the
// evaluation order between multiple addInitScript calls on the same page is
// undefined. What IS guaranteed is that every addInitScript finishes before
// the navigated document's own scripts run — so this rewrites index.html's
// response to insert a synchronous inline <script> that removes the seeded
// session, placed immediately before the deferred `type="module"` main.js
// script tag. That inline script runs during HTML parsing, strictly after
// all addInitScripts and strictly before main.js's bootstrap() reads
// localStorage, giving a deterministic signed-out launch without touching
// the shared beforeEach or any existing test.
async function forceSignedOut(page) {
  await page.route('**/index.html', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const marker = '<script type="module" src="js/main.js"></script>';
    if (!body.includes(marker)) {
      throw new Error('forceSignedOut: expected marker script tag not found in index.html');
    }
    const patched = body.replace(marker, `<script>localStorage.removeItem('daily.auth.v1');</script>${marker}`);
    await route.fulfill({ response, body: patched, contentType: 'text/html' });
  });
}

test('S-T1 — home: #title-bar is large, #title reads "Today", #title-back is hidden, and #app has no h1 of its own', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html#/');

  await expect(page.locator('#title-bar')).toHaveAttribute('data-size', 'large');
  await expect(page.locator('#title')).toHaveText('Today');
  await expect(page.locator('#title-back')).toHaveAttribute('hidden', '');
  expect(await page.locator('#app h1').count()).toBe(0);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

test('S-T2 — #/settings and #/compare each show their own large title', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html#/settings');
  await expect(page.locator('#title-bar')).toHaveAttribute('data-size', 'large');
  await expect(page.locator('#title')).toHaveText('Settings');

  await page.goto('/index.html#/compare');
  await expect(page.locator('#title-bar')).toHaveAttribute('data-size', 'large');
  await expect(page.locator('#title')).toHaveText('Compare');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

test('S-T3 — #/new: compact title "New Trackable" with a visible back button to #/ containing an svg', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html#/new');

  await expect(page.locator('#title-bar')).toHaveAttribute('data-size', 'compact');
  await expect(page.locator('#title')).toHaveText('New Trackable');
  const back = page.locator('#title-back');
  await expect(back).not.toHaveAttribute('hidden');
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute('href', '#/');
  await expect(back.locator('svg')).toHaveCount(1);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

test('S-T4 — #/nope: compact title "Not Found", back to #/, and the body still has the "Go home" link', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html#/nope');

  await expect(page.locator('#title-bar')).toHaveAttribute('data-size', 'compact');
  await expect(page.locator('#title')).toHaveText('Not Found');
  const back = page.locator('#title-back');
  await expect(back).not.toHaveAttribute('hidden');
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute('href', '#/');

  // Scoped to #app so this is unambiguously the body's own "Go home" link,
  // distinct from the header's #title-back (also href="#/", but outside #app).
  const homeLink = page.locator('#app a[href="#/"]');
  await expect(homeLink).toBeVisible();

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

test('S-T5 — every #nav tab-bar link has an icon svg and a label span, with unchanged label text and count', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html#/');

  const links = page.locator('#nav a[data-route]');
  await expect(links).toHaveCount(3);

  const expectedLabels = { home: 'Home', compare: 'Compare', settings: 'Settings' };
  const count = await links.count();
  for (let i = 0; i < count; i += 1) {
    const link = links.nth(i);
    await expect(link.locator('.tab-bar__icon svg')).toHaveCount(1);
    await expect(link.locator('.tab-bar__label')).toHaveCount(1);
    const route = await link.getAttribute('data-route');
    const text = (await link.textContent()).trim();
    expect(text).toBe(expectedLabels[route]);
  }

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

test('S-T6 — signed out: compact title "Sign in", #title-back hidden, #nav hidden', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await forceSignedOut(page);
  await routeEmptyRest(page);

  await page.goto('/index.html#/');

  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-out');
  await expect(page.locator('#title-bar')).toHaveAttribute('data-size', 'compact');
  await expect(page.locator('#title')).toHaveText('Sign in');
  await expect(page.locator('#title-back')).toHaveAttribute('hidden', '');
  await expect(page.locator('#nav')).toBeHidden();

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// CONTRACT-U.7.md §4/§6 — two theme-color metas (dark/light) and the
// manifest's theme_color/icon purpose fields. The implementation is being
// written in parallel from the same contract and is not visible here.
// ===========================================================================

test('U7-4 — index.html has dark/light theme-color metas with the right contents, and manifest.json has theme_color "#0b0b0e" with purpose on every icon', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html');

  const metas = page.locator('meta[name="theme-color"]');
  await expect(metas).toHaveCount(2);

  const darkMeta = page.locator('meta[name="theme-color"][media*="dark"]');
  const lightMeta = page.locator('meta[name="theme-color"][media*="light"]');
  await expect(darkMeta).toHaveCount(1);
  await expect(lightMeta).toHaveCount(1);
  await expect(darkMeta).toHaveAttribute('content', '#0b0b0e');
  await expect(lightMeta).toHaveAttribute('content', '#f2f2f7');

  const manifestResponse = await page.request.get('/manifest.json');
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest.theme_color).toBe('#0b0b0e');
  expect(Array.isArray(manifest.icons)).toBe(true);
  expect(manifest.icons.length).toBeGreaterThan(0);
  for (const icon of manifest.icons) {
    expect(icon.purpose).toBeTruthy();
  }

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});
