// E2E tests for Step 5.1 (CONTRACT-5.1.md): the visible #net-status offline
// indicator, and — in the one exception to this suite's usual rule — the
// REAL service worker's offline behaviour (cached shell + cached data).
//
// Do NOT start a server here and do NOT hardcode the base URL or viewport;
// both are supplied by playwright.config.mjs (baseURL 127.0.0.1:8123,
// 390x844 viewport).
//
// TWO GROUPS, deliberately different service-worker policy:
//
// Group A blocks the service worker, exactly like every other e2e file in
// this suite (see the MANDATORY MECHANIC note in tests/e2e/home.test.mjs /
// tests/e2e/shell.test.mjs): with the SW active, requests it originates are
// invisible to page.route(), so any Supabase fixture route would silently
// stop applying. Group A only exercises js/net-status.js's online/offline
// wiring, which has nothing to do with the SW, so blocking it is the same
// safe default as elsewhere.
//
// Group B is the one place in this repo that ALLOWS the service worker
// (`test.use({ serviceWorkers: 'allow' })`). This is safe here, and only
// here, because CONTRACT-5.1.md reworked sw.js to intercept ONLY same-origin
// GETs and the two pinned CDN scripts — Supabase's REST/auth calls are
// cross-origin and the worker never touches them, so page.route() still
// sees and can fulfil them even with the real worker installed and
// controlling the page. Group B asserts that directly (the trackables GET
// is observed by the route handler while the worker is active) rather than
// assuming it.
//
// GUARDRAIL: nothing in this file may reach a real Supabase row. Every
// PostgREST/auth call is intercepted with page.route()/installAuthGuard()
// and fulfilled or aborted from fixtures, verified per test.

import { test, expect } from '@playwright/test';
import { seedSession, installAuthGuard } from '../helpers/e2e-session.mjs';
import { OFFLINE_TEXT } from '../../js/net-status.js';

// --- shared fixtures/helpers ------------------------------------------

// Broad catch-all guard, registered FIRST so a more specific fixture route
// registered AFTER it (Playwright checks the most-recently-registered route
// first) wins for the endpoints this file actually cares about, and
// anything else falls through to here and is recorded + aborted rather than
// silently reaching the live database. Same pattern as installGuard() in
// tests/e2e/shell.test.mjs / tests/e2e/home.test.mjs.
async function installRestGuard(page) {
  const unexpected = [];
  await page.route('**/rest/v1/**', async (route) => {
    unexpected.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort();
  });
  return unexpected;
}

// Fulfils the three endpoints js/views/home.js's mount() can call
// (trackables, entries, app_settings) with uneventful empty/default
// fixtures. `calls`, if given, records every intercepted request so a test
// can assert the route handler actually saw traffic (CONTRACT-5.1.md's N2:
// "the trackables GET is observed by the route handler while the worker is
// active").
async function installRestFixtures(page, calls) {
  await page.route('**/rest/v1/trackables*', async (route) => {
    calls?.push(`${route.request().method()} ${route.request().url()}`);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/rest/v1/entries*', async (route) => {
    calls?.push(`${route.request().method()} ${route.request().url()}`);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/rest/v1/app_settings*', async (route) => {
    calls?.push(`${route.request().method()} ${route.request().url()}`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 1, rolling_window_days: 90 }]),
    });
  });
}

// --- Group A: net-status indicator, service worker blocked --------------

test.describe('Group A: #net-status indicator (service worker blocked)', () => {
  test.use({ serviceWorkers: 'block' });

  test.beforeEach(async ({ page }) => {
    // Step D.7: the app is gated behind a signed-in session; seed one
    // before any page script runs so this reaches the home view instead of
    // the sign-in gate.
    await seedSession(page);
  });

  test('N1: hidden on load, visible with OFFLINE_TEXT when offline, hidden again when back online', async ({
    page,
    context,
  }) => {
    const unexpected = await installRestGuard(page);
    const unexpectedAuth = await installAuthGuard(page);
    await installRestFixtures(page);

    await page.goto('/index.html#/');

    const status = page.locator('#net-status');
    await expect(status).toBeHidden();
    await expect(status).toHaveAttribute('data-online', 'true');

    // Playwright's context.setOffline fires the window 'offline'/'online'
    // events in Chromium (CONTRACT-5.1.md §5) — no reload needed.
    await context.setOffline(true);
    await expect(status).toBeVisible();
    await expect(status).toHaveText(OFFLINE_TEXT);
    await expect(status).toHaveAttribute('data-online', 'false');

    await context.setOffline(false);
    await expect(status).toBeHidden();
    await expect(status).toHaveAttribute('data-online', 'true');

    // Extra, low-cost check reusing the fixtures already registered above:
    // with the service worker blocked there is no controller, so
    // requestAppVersion resolves null immediately and the settings screen
    // falls back to "App version unknown".
    await page.goto('/index.html#/settings');
    await expect(page.locator('.settings-version')).toHaveText('App version unknown');

    expect(unexpected).toEqual([]);
    expect(unexpectedAuth).toEqual([]);
  });
});

// --- Group B: real service worker --------------------------------------

test.describe('Group B: real service worker (offline shell + cached data)', () => {
  test.use({ serviceWorkers: 'allow' });

  test.beforeEach(async ({ page }) => {
    await seedSession(page);
  });

  // N2, N3 and N4 run as one flow (not three separate tests): N3 and N4
  // both depend on the worker already installed and controlling the page
  // from N2, and re-establishing that from scratch per test would just
  // repeat the same bounded reload-retry three times over for no benefit —
  // CONTRACT-5.1.md explicitly asks to "keep this group small."
  test('N2-N4: worker installs and takes control; offline reload still renders the cached shell + cached data with the indicator visible; back online hides it', async ({
    page,
    context,
  }) => {
    const unexpected = await installRestGuard(page);
    const unexpectedAuth = await installAuthGuard(page);
    const trackablesCalls = [];
    await installRestFixtures(page, trackablesCalls);

    // --- N2: install, activate, take control -----------------------------
    await page.goto('/index.html#/');
    await page.evaluate(() => navigator.serviceWorker.ready);

    // The very first load of a page is never controlled by the worker that
    // installs during that same load (CONTRACT-5.1.md §1 item 5 — a
    // controllerchange-driven reload only fires when a worker was ALREADY
    // controlling). A subsequent navigation is what picks up control, so
    // reload with bounded retries until navigator.serviceWorker.controller
    // is set.
    let controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    for (let attempt = 0; attempt < 10 && !controlled; attempt += 1) {
      await page.reload();
      await page.evaluate(() => navigator.serviceWorker.ready).catch(() => {});
      controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    }
    expect(controlled).toBe(true);

    const cacheNames = await page.evaluate(() => caches.keys());
    expect(cacheNames.some((name) => /^daily-v\d+$/.test(name))).toBe(true);

    const mainJsCached = await page.evaluate(() =>
      caches.match('./js/main.js').then((res) => !!res)
    );
    expect(mainJsCached).toBe(true);

    // The worker never intercepts cross-origin requests, so this file's
    // page.route fixtures still see (and fulfilled) the Supabase call even
    // with the real worker installed and controlling the page.
    expect(trackablesCalls.length).toBeGreaterThan(0);

    // --- Settings screen shows the SW's cache version (requestAppVersion) --
    await page.goto('/index.html#/settings');
    await expect(page.locator('.settings-version')).toHaveText(/^App version daily-v\d+$/);

    // Back to home before exercising the offline shell fallback (N3/N4).
    await page.goto('/index.html#/');
    await expect(page.locator('section.home')).toBeVisible();

    // --- N3: go offline, reload — cached shell + cached data still render
    await context.setOffline(true);
    await page.reload();

    await expect(page.locator('#app')).toBeAttached();
    // js/views/home.js's mount() renders synchronously from the store's
    // already-hydrated cache before any network await, so this appears
    // regardless of whether the (mocked, still-routed) Supabase calls
    // resolve — the point under test is the SW/shell fallback, not the
    // fixture data. This is the real check: the shell rendered with the
    // network genuinely cut (the worker served it from cache).
    await expect(page.locator('section.home')).toBeVisible();

    // Verified by the Runner: Chromium's context.setOffline(true) cuts the
    // network (a cross-origin probe fails with ERR_INTERNET_DISCONNECTED
    // and the worker does serve the cached shell above), but it does NOT
    // propagate into a freshly loaded document's navigator.onLine — the new
    // document still reads onLine === true and fires no 'offline' event.
    // js/net-status.js is spec-correct (CONTRACT-5.1.md §2/§3: it reads
    // nav.onLine at startup and listens for the events) — this is a
    // platform/emulation gap, not a product bug, so the test dispatches the
    // event itself to exercise the indicator's reaction to it.
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));

    await expect(page.locator('#net-status')).toBeVisible();
    await expect(page.locator('#net-status')).toHaveText(OFFLINE_TEXT);
    await expect(page.locator('#net-status')).toHaveAttribute('data-online', 'false');

    // --- N4: back online, reload — indicator hidden again -----------------
    await context.setOffline(false);
    await page.reload();
    await expect(page.locator('#net-status')).toBeHidden();
    await expect(page.locator('#net-status')).toHaveAttribute('data-online', 'true');

    expect(unexpected).toEqual([]);
    expect(unexpectedAuth).toEqual([]);
  });
});
