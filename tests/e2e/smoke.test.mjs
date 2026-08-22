// Smoke test: proves the e2e tier actually drives a real browser against the
// server started by playwright.config.mjs's webServer (baseURL
// 127.0.0.1:8123). Not a test of app logic — keep it small.
//
// Do NOT start a server here and do NOT hardcode the base URL; both are
// supplied by playwright.config.mjs.

import { test, expect } from '@playwright/test';

test('index.html loads with no uncaught page errors and a non-empty title', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err);
  });

  const response = await page.goto('/index.html');
  expect(response.status()).toBe(200);

  const title = await page.title();
  expect(typeof title).toBe('string');
  expect(title.length).toBeGreaterThan(0);

  // Note: the current placeholder page performs a live Supabase fetch on
  // load but catches its own failures, so a network hiccup should not
  // surface as an uncaught page error. If this fails, that is a real
  // finding, not a flaky test.
  expect(pageErrors).toEqual([]);
});

test('the server enforces the ES module MIME rule end-to-end', async ({ request }) => {
  const res = await request.get('/js/app.js');
  expect(res.status()).toBe(200);
  const contentType = res.headers()['content-type'];
  expect(contentType.startsWith('text/javascript')).toBe(true);
});

test('a missing script 404s', async ({ request }) => {
  const res = await request.get('/nope.js');
  expect(res.status()).toBe(404);
});
