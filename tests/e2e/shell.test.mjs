// E2E smoke tests for the Step 0.3 app shell: hash router + persistent bottom
// nav rendered by index.html/js/main.js. Kept to high-value structural/browser
// checks (real navigation, real DOM, real script execution) — logic belongs
// in tests/unit/router.test.mjs and tests/unit/sw-assets.test.mjs instead.
//
// Do NOT start a server here and do NOT hardcode the base URL or viewport;
// both are supplied by playwright.config.mjs (baseURL 127.0.0.1:8123,
// 390x844 viewport).

import { test, expect } from '@playwright/test';

test('index.html loads: 200, title "Daily", no uncaught page errors', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err);
  });

  const response = await page.goto('/index.html');
  expect(response.status()).toBe(200);
  expect(await page.title()).toBe('Daily');
  expect(pageErrors).toEqual([]);
});

test('#app exists and has data-route="home" on initial load', async ({ page }) => {
  await page.goto('/index.html');
  const app = page.locator('#app');
  await expect(app).toHaveAttribute('data-route', 'home');
});

test('#nav exists with exactly 3 links to #/, #/compare, #/settings', async ({ page }) => {
  await page.goto('/index.html');
  const nav = page.locator('#nav');
  await expect(nav).toBeAttached();

  const links = nav.locator('a');
  await expect(links).toHaveCount(3);

  const hrefs = await links.evaluateAll((els) => els.map((el) => el.getAttribute('href')));
  expect(hrefs).toContain('#/');
  expect(hrefs).toContain('#/compare');
  expect(hrefs).toContain('#/settings');
});

test('navigating via hash updates #app data-route for settings, compare, and new', async ({ page }) => {
  await page.goto('/index.html#/settings');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'settings');

  await page.goto('/index.html#/compare');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'compare');

  await page.goto('/index.html#/new');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'new');
});

test('#/t/42 renders the detail view with the id visible', async ({ page }) => {
  await page.goto('/index.html#/t/42');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'detail');
  await expect(page.locator('#app')).toContainText('42');
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
  await page.goto('/index.html');
  const chartDefined = await page.evaluate(() => typeof window.Chart !== 'undefined');
  expect(chartDefined).toBe(true);
});

test('the bottom nav is visible and its bounding box sits within the 390x844 viewport', async ({ page }) => {
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
});
