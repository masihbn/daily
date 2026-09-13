// E2E tests for the Step D.7 sign-in gate (CONTRACT-D.7.md §6, §7, §12.8).
// js/main.js gates the whole app behind getAuth().isSignedIn(); this file
// drives that gate through a real browser against a real js/main.js, with
// every network call (both /rest/v1/ and /auth/v1/) intercepted.
//
// MANDATORY MECHANIC (see tests/e2e/home.test.mjs, read first if unfamiliar):
// service workers blocked, because requests made from inside a SW are
// invisible to page.route() and would otherwise reach the LIVE database.
//
// GUARDRAIL: nothing in this file may reach a real Supabase or GoTrue
// endpoint. A broad catch-all is registered FIRST for both /rest/v1/** and
// /auth/v1/** (installGuard / installAuthGuard, the latter from the shared
// tests/helpers/e2e-session.mjs), recording and aborting anything not
// explicitly fixtured by a narrower route registered after it.
import { test, expect } from '@playwright/test';
import { fakeSession, seedSession, installAuthGuard, FAKE_USER } from '../helpers/e2e-session.mjs';

test.use({ serviceWorkers: 'block' });

// --- guards / fixtures ------------------------------------------------------

async function installGuard(page) {
  const unexpected = [];
  await page.route('**/rest/v1/**', async (route) => {
    unexpected.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort();
  });
  return unexpected;
}

// Empty, uneventful REST fixtures — this file's interest is the gate, not
// any view's content. `events`, if given, gets an entry pushed for every
// call, so cross-endpoint ORDER (vs. an auth route registered the same way)
// can be asserted.
async function routeEmptyRest(page, { events } = {}) {
  await page.route('**/rest/v1/trackables*', async (route) => {
    if (events) events.push(`rest:GET:trackables`);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/rest/v1/entries*', async (route) => {
    if (events) events.push(`rest:GET:entries`);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

// A sequence of responses for GET /rest/v1/trackables*, one per call (the
// last one repeats if more calls happen than were configured) — mirrors
// installFetchSequence()'s shape in the unit tests, at the page.route level.
async function routeTrackablesSequence(page, responses, { events } = {}) {
  let i = 0;
  await page.route('**/rest/v1/trackables*', async (route) => {
    if (events) events.push(`rest:GET:trackables`);
    const resp = responses[Math.min(i, responses.length - 1)];
    i += 1;
    await route.fulfill({
      status: resp.status ?? 200,
      contentType: 'application/json',
      headers: resp.headers,
      body: JSON.stringify(resp.body ?? []),
    });
  });
}

// Records every request to the password/refresh endpoint, and its request
// headers/body, while fulfilling with the configured response. Matched on
// '**/auth/v1/token*' (no literal '?' in the glob — Playwright glob syntax
// treats a bare '?' as "any one character", which happens to still match a
// real query-string '?' but is fragile to rely on) and discriminated inside
// the handler by grant_type; a request for the OTHER grant type falls back
// to whatever route was registered before this one (installAuthGuard's
// catch-all), so an unexpected grant type is recorded and aborted rather
// than silently mishandled here.
async function routeAuthToken(page, { grantType, response, events, requests }) {
  await page.route('**/auth/v1/token*', async (route) => {
    const req = route.request();
    if (!req.url().includes(`grant_type=${grantType}`)) {
      await route.fallback();
      return;
    }
    if (events) events.push(`auth:${grantType}`);
    if (requests) {
      requests.push({
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        body: req.postData(),
      });
    }
    await route.fulfill({
      status: response.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(response.body ?? {}),
    });
  });
}

async function routeLogout(page, { status = 200, requests } = {}) {
  await page.route('**/auth/v1/logout', async (route) => {
    const req = route.request();
    if (requests) requests.push({ url: req.url(), method: req.method(), headers: req.headers() });
    await route.fulfill({ status, contentType: 'application/json', body: '{}' });
  });
}

function tokenResponseBody({ accessToken = 'NEW-ACCESS-TOKEN', refreshToken = 'new-refresh', expiresInS = 3600 } = {}) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresInS,
    token_type: 'bearer',
    user: { id: FAKE_USER.id, email: FAKE_USER.email },
  };
}

async function fillAndSubmit(page, { email, password }) {
  if (email !== undefined) await page.locator('input[name="email"]').fill(email);
  if (password !== undefined) await page.locator('input[name="password"]').fill(password);
  await page.locator('button.signin-submit').click();
}

async function seedOutbox(page, ops) {
  await page.addInitScript((seeded) => {
    localStorage.setItem('daily.outbox.v1', JSON.stringify({ v: 1, ops: seeded }));
  }, ops);
}

async function seedCache(page) {
  await page.addInitScript(() => {
    localStorage.setItem('daily.cache.v1', JSON.stringify({ v: 1, trackables: [{ id: 1 }], entries: [] }));
  });
}

function outboxOp() {
  return {
    id: 'seed-op',
    type: 'upsert',
    key: '366|2026-05-01',
    payload: { trackable_id: 366, entry_date: '2026-05-01', value: 1 },
    queuedAt: 1,
  };
}

// ===========================================================================
// A1 — no session: gated, zero network
// ===========================================================================

test('A1 — no session: signed-out, section.signin visible, #nav hidden, zero REST and zero auth requests', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html#/');

  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-out');
  await expect(page.locator('section.signin')).toBeVisible();
  await expect(page.locator('#nav')).toBeHidden();

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// A2 — the hash is preserved while gated
// ===========================================================================

test('A2 — the hash is preserved: #/settings still reads data-route="settings" while gated', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html#/settings');

  await expect(page.locator('#app')).toHaveAttribute('data-route', 'settings');
  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-out');
  await expect(page.locator('section.signin')).toBeVisible();
  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toBe('#/settings');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// A3 — successful sign-in
// ===========================================================================

test('A3 — submitting valid credentials POSTs to the password endpoint, then signs in and mounts the route', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  const requests = [];
  await routeAuthToken(page, { grantType: 'password', response: { status: 200, body: tokenResponseBody() }, requests });
  await routeEmptyRest(page);

  await page.goto('/index.html#/');
  await expect(page.locator('section.signin')).toBeVisible();

  await fillAndSubmit(page, { email: 'me@example.com', password: 'correct-horse' });

  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-in');
  await expect(page.locator('#nav')).toBeVisible();
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'home');

  expect(requests.length).toBe(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toContain('/auth/v1/token?grant_type=password');
  expect(requests[0].headers.apikey).toBeTruthy();
  expect(JSON.parse(requests[0].body)).toEqual({ email: 'me@example.com', password: 'correct-horse' });

  const stored = await page.evaluate(() => localStorage.getItem('daily.auth.v1'));
  expect(stored).toBeTruthy();
  const session = JSON.parse(stored);
  expect(session.access_token).toBe('NEW-ACCESS-TOKEN');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// A4 — wrong credentials (400, invalid_credentials shape)
// ===========================================================================

test('A4 — a mocked 400 invalid-credentials response shows "Wrong email or password.", stays gated', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeAuthToken(page, {
    grantType: 'password',
    response: { status: 400, body: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' } },
  });
  await routeEmptyRest(page);

  await page.goto('/index.html#/');
  await fillAndSubmit(page, { email: 'me@example.com', password: 'wrong' });

  await expect(page.locator('section.signin')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('.signin-error')).toHaveText('Wrong email or password.');
  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-out');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// A5 — offline (aborted request)
// ===========================================================================

test('A5 — an aborted sign-in request shows the offline message', async ({ page }) => {
  const unexpected = await installGuard(page);
  await page.route('**/auth/v1/token*', async (route) => {
    if (!route.request().url().includes('grant_type=password')) {
      await route.fallback();
      return;
    }
    await route.abort('internetdisconnected');
  });
  await routeEmptyRest(page);

  await page.goto('/index.html#/');
  await fillAndSubmit(page, { email: 'me@example.com', password: 'pw' });

  await expect(page.locator('section.signin')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('.signin-error')).toHaveText('You are offline. Signing in needs a connection.');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// A6 — empty fields: local validation, no request
// ===========================================================================

test('A6 — submitting with empty fields shows the local message and makes no request', async ({ page }) => {
  const unexpectedAuth = await installAuthGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html#/');
  // Leave both fields empty; the form carries `novalidate` specifically so
  // this reaches the JS handler instead of being blocked by the browser.
  await page.locator('button.signin-submit').click();

  await expect(page.locator('section.signin')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('.signin-error')).toHaveText('Enter your email and password.');
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// A7 — cold relaunch with an EXPIRED seeded session: refresh precedes the
// first REST GET, which then carries the new bearer.
// ===========================================================================

test('A7 — an expired seeded session refreshes before the first REST GET, which carries the NEW bearer', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  const events = [];
  const nowS = Math.floor(Date.now() / 1000);
  await seedSession(page, fakeSession({ expires_at: nowS - 3600, access_token: 'STALE-TOKEN' }));

  await routeAuthToken(page, {
    grantType: 'refresh_token',
    response: { status: 200, body: tokenResponseBody({ accessToken: 'FRESH-TOKEN' }) },
    events,
  });

  let trackablesAuthHeader = null;
  await page.route('**/rest/v1/trackables*', async (route) => {
    events.push('rest:GET:trackables');
    trackablesAuthHeader = route.request().headers()['authorization'];
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/rest/v1/entries*', async (route) => {
    events.push('rest:GET:entries');
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.goto('/index.html#/');
  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-in');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'home');

  expect(events[0]).toBe('auth:refresh_token');
  expect(events.indexOf('auth:refresh_token')).toBeLessThan(events.indexOf('rest:GET:trackables'));
  expect(trackablesAuthHeader).toBe('Bearer FRESH-TOKEN');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// A8 — a live 401 mid-session: GET -> refresh -> GET (retry), view renders
// ===========================================================================

test('A8 — trackables 401s once, refresh 200s, retry succeeds: order is GET, refresh, GET', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  const events = [];
  await seedSession(page, fakeSession({ access_token: 'ABOUT-TO-401' })); // fresh, well beyond margin

  await routeTrackablesSequence(
    page,
    [{ status: 401, body: { message: 'JWT expired' } }, { status: 200, body: [] }],
    { events }
  );
  await routeAuthToken(page, {
    grantType: 'refresh_token',
    response: { status: 200, body: tokenResponseBody({ accessToken: 'RECOVERED-TOKEN' }) },
    events,
  });
  await page.route('**/rest/v1/entries*', async (route) => {
    events.push('rest:GET:entries');
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.goto('/index.html#/');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'home');
  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-in');

  const relevant = events.filter((e) => e === 'rest:GET:trackables' || e === 'auth:refresh_token');
  expect(relevant).toEqual(['rest:GET:trackables', 'auth:refresh_token', 'rest:GET:trackables']);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// A9 — refresh 400: the gate reappears, storage is cleared
// ===========================================================================

test('A9 — an expired session whose refresh comes back 400: gate reappears, localStorage session removed', async ({ page }) => {
  const unexpected = await installGuard(page);
  const nowS = Math.floor(Date.now() / 1000);
  await seedSession(page, fakeSession({ expires_at: nowS - 3600 }));
  await routeAuthToken(page, { grantType: 'refresh_token', response: { status: 400, body: {} } });
  await routeEmptyRest(page);

  await page.goto('/index.html#/');

  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-out', { timeout: 5000 });
  await expect(page.locator('section.signin')).toBeVisible();

  const stored = await page.evaluate(() => localStorage.getItem('daily.auth.v1'));
  expect(stored).toBeNull();

  // The failing getAccessToken() call happens INSIDE authHeaders(), before
  // requestWithStatus() ever calls fetch() for the trackables/entries GET —
  // so neither should have actually reached the network.
  expect(unexpected).toEqual([]);
});

// ===========================================================================
// A10 — Settings: signed-in-as email, sign out
// ===========================================================================

test('A10 — Settings shows the signed-in email; Sign out logs out, clears storage, and shows the gate', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await seedSession(page);
  await seedCache(page);
  const logoutRequests = [];
  await routeLogout(page, { status: 200, requests: logoutRequests });
  await routeEmptyRest(page);

  await page.goto('/index.html#/settings');
  await expect(page.locator('.signin-as')).toHaveText(`Signed in as ${FAKE_USER.email}`);

  await page.locator('#signout-btn').click();

  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-out');
  await expect(page.locator('section.signin')).toBeVisible();

  expect(logoutRequests.length).toBe(1);
  expect(logoutRequests[0].method).toBe('POST');
  expect(logoutRequests[0].url).toContain('/auth/v1/logout');
  expect(logoutRequests[0].headers.authorization).toMatch(/^Bearer /);

  const sessionAfter = await page.evaluate(() => localStorage.getItem('daily.auth.v1'));
  const cacheAfter = await page.evaluate(() => localStorage.getItem('daily.cache.v1'));
  expect(sessionAfter).toBeNull();
  expect(cacheAfter).toBeNull();

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// A11 — sign-out refused with a non-empty outbox
// ===========================================================================

test('A11 — Sign out is refused while the outbox is non-empty, with the warning text, and issues no logout request', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await seedSession(page);
  await seedOutbox(page, [outboxOp()]);
  await routeEmptyRest(page);
  // The upsert POST must not succeed, or the boot-time flush would drain the
  // outbox before the test gets to click Sign out — 503 is retryable, same
  // fixture shape as tests/e2e/outbox.test.mjs's D6-3.
  await page.route('**/rest/v1/entries*', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"down"}' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.goto('/index.html#/settings');
  await expect(page.locator('.signin-as')).toBeVisible();

  await page.locator('#signout-btn').click();

  await expect(page.locator('.signout-warning')).toBeVisible();
  await expect(page.locator('.signout-warning')).toHaveText(
    '1 log not yet saved. Get online and wait for them to send before signing out.'
  );
  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-in');

  expect(unexpectedAuth).toEqual([]); // no /auth/v1/logout, no refresh — nothing at all
  expect(unexpected).toEqual([]);
});

// ===========================================================================
// A12 — reload with a fresh seeded session: still signed in, no auth request
// ===========================================================================

test('A12 — page.reload() with a fresh seeded session: still signed in, no auth request', async ({ page }) => {
  const unexpectedAuth = await installAuthGuard(page);
  await seedSession(page); // default 1h expiry
  await routeEmptyRest(page);

  await page.goto('/index.html#/');
  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-in');

  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-in');
  await expect(page.locator('section.signin')).toHaveCount(0);

  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// A13 — a fresh session boot makes NO /auth/v1/ request at all
// ===========================================================================

test('A13 — a fresh (1h) seeded session: booting the app makes zero /auth/v1/ requests', async ({ page }) => {
  const unexpectedAuth = await installAuthGuard(page);
  const unexpected = await installGuard(page);
  await seedSession(page);
  await routeEmptyRest(page);

  await page.goto('/index.html#/');
  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-in');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'home');

  expect(unexpectedAuth).toEqual([]);
  // installGuard() above is the catch-all for /rest/v1/**, but this file
  // routes trackables/entries explicitly via routeEmptyRest(), so this
  // simply proves nothing UNEXPECTED slipped through either.
  expect(unexpected).toEqual([]);
});

// ===========================================================================
// A14 (2026-09-13, device feedback) — the password Show/Hide toggle
// ===========================================================================

// Returns the document-order position, among form.signin-form's direct
// children, of the password field's label, the toggle, and the submit
// button — "between" (contract §6) is a document-order claim, not
// necessarily an immediate-sibling one, so this checks relative order
// rather than assuming a specific parent/child shape beyond what §6's DOM
// block actually draws (all three as direct children of form.signin-form).
async function toggleDomOrder(page) {
  const order = await page.evaluate(() => {
    const form = document.querySelector('form.signin-form');
    return Array.from(form.children).map((el) => {
      if (el.tagName === 'LABEL' && el.querySelector('input[name="password"]')) return 'password-field';
      if (el.classList.contains('signin-toggle')) return 'toggle';
      if (el.classList.contains('signin-submit')) return 'submit';
      return el.tagName;
    });
  });
  return { passwordIdx: order.indexOf('password-field'), toggleIdx: order.indexOf('toggle'), submitIdx: order.indexOf('submit') };
}

test('A14 — the Show/Hide toggle: position, attributes, flips the input type without touching its value, and never submits', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeEmptyRest(page);

  await page.goto('/index.html#/');
  await expect(page.locator('section.signin')).toBeVisible();

  // Position: between the password field and the submit button.
  const { passwordIdx, toggleIdx, submitIdx } = await toggleDomOrder(page);
  expect(passwordIdx).toBeGreaterThanOrEqual(0);
  expect(toggleIdx).toBeGreaterThan(passwordIdx);
  expect(toggleIdx).toBeLessThan(submitIdx);

  const toggle = page.locator('button.signin-toggle');
  const passwordInput = page.locator('input[name="password"]');

  // Initial state.
  await expect(toggle).toHaveAttribute('type', 'button');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveText('Show');
  await expect(passwordInput).toHaveAttribute('type', 'password');

  await passwordInput.fill('hunter2');

  // First click: reveal.
  await toggle.click();
  await expect(passwordInput).toHaveAttribute('type', 'text');
  await expect(toggle).toHaveText('Hide');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(await passwordInput.inputValue()).toBe('hunter2');

  // Second click: hide again, value still untouched.
  await toggle.click();
  await expect(passwordInput).toHaveAttribute('type', 'password');
  await expect(toggle).toHaveText('Show');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await passwordInput.inputValue()).toBe('hunter2');

  // Never submits: still gated, zero REST/auth requests through the guards.
  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-out');
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// A15 (2026-09-13) — typed values and toggle state survive an error re-render
// ===========================================================================

test('A15 — after a mocked 400 sign-in failure, the typed values and a "Hide" toggle state both survive the re-render', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeAuthToken(page, {
    grantType: 'password',
    response: { status: 400, body: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' } },
  });
  await routeEmptyRest(page);

  await page.goto('/index.html#/');
  await page.locator('input[name="email"]').fill('me@example.com');
  await page.locator('input[name="password"]').fill('wrong-password');

  // Set the toggle to "Hide" BEFORE submitting.
  await page.locator('button.signin-toggle').click();
  await expect(page.locator('button.signin-toggle')).toHaveText('Hide');

  await page.locator('button.signin-submit').click();
  await expect(page.locator('section.signin')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('.signin-error')).toHaveText('Wrong email or password.');

  // The whole point of this case: the re-render from busy -> error must not
  // have wiped the form back to a blank/default one.
  expect(await page.locator('input[name="email"]').inputValue()).toBe('me@example.com');
  expect(await page.locator('input[name="password"]').inputValue()).toBe('wrong-password');

  const toggle = page.locator('button.signin-toggle');
  await expect(toggle).toHaveText('Hide');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('input[name="password"]')).toHaveAttribute('type', 'text');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});
