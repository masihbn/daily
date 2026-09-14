// E2E tests for the Step 5.2 local app lock (CONTRACT-5.2.md §2/§3/§4/§6,
// cases K1-K10). js/main.js gates a signed-in session behind a WebAuthn
// lock screen when one is enabled (js/applock.js, js/views/lock.js); this
// file drives that gate through a real browser against a real js/main.js,
// with every network call intercepted and a fake `navigator.credentials`
// standing in for a platform authenticator (Chromium headless has none).
//
// The implementation (js/applock.js, js/views/lock.js, js/main.js,
// js/views/settings.js) is being written in parallel by another agent and
// has NOT been read while writing this file — everything here comes
// strictly from CONTRACT-5.2.md.
//
// MECHANICS (copied from tests/e2e/auth.test.mjs / tests/e2e/settings.test.mjs):
// service workers blocked (requests from inside a SW are invisible to
// page.route() and would otherwise reach the LIVE database); a broad
// catch-all guard registered FIRST for both /rest/v1/** and /auth/v1/**
// (installGuard / installAuthGuard from tests/helpers/e2e-session.mjs),
// recording and aborting anything not explicitly fixtured by a narrower
// route registered after it; every test seeds a signed-in session with
// seedSession() EXCEPT K10, which deliberately seeds none.
//
// FAKE WEBAUTHN: installed via addInitScript AFTER seedSession (per
// CONTRACT-5.2.md's testability decision, §0.7), replacing
// navigator.credentials with an object whose create()/get() are driven by
// window.__fakeWebAuthn — see installFakeWebAuthn() below. Every call is
// recorded there with a JSON-serializable snapshot of its `publicKey`
// options (BufferSource fields converted to plain arrays at record time,
// since the fake runs in-page and the test only ever reads calls back out
// through page.evaluate()).
//
// GUARDRAIL: nothing in this file may reach a real Supabase or GoTrue
// endpoint — see the guard/route helpers immediately below.

import { test, expect } from '@playwright/test';
import { seedSession, installAuthGuard } from '../helpers/e2e-session.mjs';

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

// Uneventful REST fixtures for trackables/entries/app_settings — this
// file's interest is the lock gate, not any view's content. `events`, if
// given, records which of the three fired, so a test can assert NONE of
// them fired while the lock screen is showing (K1).
async function routeEmptyRest(page, { events } = {}) {
  await page.route('**/rest/v1/trackables*', async (route) => {
    if (events) events.push('rest:GET:trackables');
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/rest/v1/entries*', async (route) => {
    if (events) events.push('rest:GET:entries');
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/rest/v1/app_settings*', async (route) => {
    if (events) events.push('rest:GET:app_settings');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 1, rolling_window_days: 90 }]),
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

// --- app-lock seeding ---------------------------------------------------

// Same base64url alphabet as CONTRACT-5.2.md §1 (toBase64Url): standard
// base64, -/+ swapped for _/-, padding stripped. Computed by hand here
// (not by importing js/applock.js) to keep this file's fixtures
// independent of the module under test.
const SEEDED_CREDENTIAL_ID_BYTES = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];

function seededCredentialIdB64() {
  return Buffer.from(SEEDED_CREDENTIAL_ID_BYTES)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Seeds `daily.applock.v1` (localStorage) before any page script runs —
// CONTRACT-5.2.md §6's seeding recipe.
async function seedLock(page, { credentialId = seededCredentialIdB64(), enabledAt = '2026-09-01T00:00:00.000Z' } = {}) {
  await page.addInitScript(
    ({ credentialId, enabledAt }) => {
      localStorage.setItem('daily.applock.v1', JSON.stringify({ v: 1, credentialId, enabledAt }));
    },
    { credentialId, enabledAt }
  );
}

// Seeds the sessionStorage "already unlocked this session" flag, for cases
// that need to land straight past the lock screen (e.g. reaching Settings
// with an existing lock already on, to test "Turn off" — CONTRACT-5.2.md
// never asks the lock to re-challenge a session that already unlocked).
async function seedUnlockedSession(page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('daily.applock.unlocked.v1', '1');
  });
}

// Installs a fake navigator.credentials AFTER seedSession (per
// CONTRACT-5.2.md §0.7 / this file's task brief). `create`/`get` are each
// either a single plain, JSON-serializable spec — { ok: true, rawIdBytes?:
// number[] } or { ok: false, errorName?: string, message?: string } — or
// an ARRAY of such specs consumed one per call (the last one repeats once
// exhausted), for a test that needs the Nth call to behave differently
// (e.g. K4: the automatic attempt right after a fresh reload must behave
// differently from the one right after the first page load). The call
// index is kept in localStorage rather than a module-level counter,
// because addInitScript re-runs — and would otherwise reset an in-memory
// counter — on every navigation/reload within the same test.
//
// Every call (to either method) is pushed onto window.__fakeWebAuthn.calls
// as { method, opts } with BufferSource fields already converted to plain
// arrays, so a later page.evaluate(() => window.__fakeWebAuthn.calls)
// round-trips through JSON cleanly.
async function installFakeWebAuthn(page, { create = { ok: true }, get = { ok: true } } = {}) {
  await page.addInitScript(
    ({ create, get }) => {
      function toPlainOptions(opts) {
        const pk = (opts && opts.publicKey) || {};
        const snap = { ...pk };
        if (pk.challenge) snap.challenge = Array.from(new Uint8Array(pk.challenge));
        if (pk.user && pk.user.id) snap.user = { ...pk.user, id: Array.from(new Uint8Array(pk.user.id)) };
        if (Array.isArray(pk.allowCredentials)) {
          snap.allowCredentials = pk.allowCredentials.map((c) => ({ ...c, id: Array.from(new Uint8Array(c.id)) }));
        }
        return { publicKey: snap };
      }
      function nextSpec(method, specOrList) {
        const list = Array.isArray(specOrList) ? specOrList : [specOrList];
        const key = `__e2e_fakeWebAuthn_${method}_i`;
        const i = Number(localStorage.getItem(key) || '0');
        localStorage.setItem(key, String(i + 1));
        return list[Math.min(i, list.length - 1)];
      }
      function outcomeFn(method, specOrList) {
        return async (opts) => {
          const spec = nextSpec(method, specOrList);
          window.__fakeWebAuthn.calls.push({ method, opts: toPlainOptions(opts) });
          if (!spec || spec.ok === false) {
            const err = new Error((spec && spec.message) || 'failed');
            err.name = (spec && spec.errorName) || 'Error';
            throw err;
          }
          const rawIdBytes = (spec && spec.rawIdBytes) || [1, 2, 3, 4, 5];
          return { rawId: Uint8Array.from(rawIdBytes).buffer };
        };
      }
      // window.__fakeWebAuthn.calls itself IS reset on every reload (a
      // fresh document has a fresh `window`) — that's intended: every test
      // below reads it back only after the reload it cares about, never
      // needing calls to accumulate across reloads. Only the call-index
      // counters above need to survive a reload, hence localStorage.
      window.__fakeWebAuthn = { calls: [] };
      const credentials = { create: outcomeFn('create', create), get: outcomeFn('get', get) };
      Object.defineProperty(navigator, 'credentials', { value: credentials, configurable: true });
      if (!window.PublicKeyCredential) {
        window.PublicKeyCredential = function () {};
      }
      if (!window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
        window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
      }
    },
    { create, get }
  );
}

// K6/K9: simulates a browser with no WebAuthn API at all. Deliberately
// does NOT install the fake — it removes navigator.credentials and
// PublicKeyCredential outright.
async function removeWebAuthn(page) {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true });
    } catch {
      // Some engines may not allow redefining this — best effort.
    }
    window.PublicKeyCredential = undefined;
  });
}

// ===========================================================================
// K1 — locked at launch: gate attributes, nav hidden, hash preserved, no
// data GET at all while locked
// ===========================================================================

test('K1 — a seeded lock + signed-in session renders the lock screen, hides nav, keeps the route stamped and hash unchanged, with zero data GETs', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await seedSession(page);
  await seedLock(page);
  const events = [];
  await routeEmptyRest(page, { events });

  await page.goto('/index.html#/settings');

  await expect(page.locator('#app')).toHaveAttribute('data-lock', 'locked');
  await expect(page.locator('section.lock')).toBeVisible();
  await expect(page.locator('p.lock-help')).toHaveText(
    'Unlock with Face ID, Touch ID or your device passcode. Needs a network connection.'
  );
  await expect(page.locator('#nav')).toBeHidden();
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'settings');
  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toBe('#/settings');

  // No trackables/entries/app_settings GET at all while locked — nothing
  // beneath the lock gate ever mounted.
  expect(events).toEqual([]);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// K2 — automatic unlock on mount (no tap): exact get() options, then
// unlocked + route mounts
// ===========================================================================

test('K2 — the lock screen unlocks automatically on mount, with no tap: get() is called once with the seeded credential id bytes and userVerification required; unlocks, mounts the route, shows nav, marks the session', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await seedSession(page);
  await seedLock(page);
  await installFakeWebAuthn(page, { get: { ok: true } });
  await routeEmptyRest(page);

  await page.goto('/index.html#/');

  // No tap anywhere in this test: the lock screen attempts unlock()
  // automatically on mount (CONTRACT-5.2.md §2 amendment).
  await expect(page.locator('#app')).toHaveAttribute('data-lock', 'unlocked');
  await expect(page.locator('#nav')).toBeVisible();
  await expect(page.locator('section.home')).toBeVisible();

  const calls = await page.evaluate(() => window.__fakeWebAuthn.calls);
  const getCalls = calls.filter((c) => c.method === 'get');
  expect(getCalls.length).toBe(1);
  expect(getCalls[0].opts.publicKey.userVerification).toBe('required');
  expect(getCalls[0].opts.publicKey.allowCredentials.length).toBe(1);
  expect(getCalls[0].opts.publicKey.allowCredentials[0].id).toEqual(SEEDED_CREDENTIAL_ID_BYTES);

  const sessionFlag = await page.evaluate(() => sessionStorage.getItem('daily.applock.unlocked.v1'));
  expect(sessionFlag).toBe('1');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// K3 — the automatic attempt is cancelled SILENTLY (idle, error hidden,
// Unlock enabled); a manual tap afterwards behaves exactly as before
// ===========================================================================

test('K3 — a NotAllowedError from the automatic attempt leaves it idle with the error hidden and Unlock enabled; a manual tap afterwards shows "Unlock was cancelled."; get() called twice in total', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await seedSession(page);
  await seedLock(page);
  await installFakeWebAuthn(page, { get: { ok: false, errorName: 'NotAllowedError' } });
  const events = [];
  await routeEmptyRest(page, { events });

  await page.goto('/index.html#/');

  // After the automatic attempt resolves 'cancelled': idle, error hidden,
  // Unlock enabled, still locked — no tap has happened yet.
  await expect(page.locator('#app')).toHaveAttribute('data-lock', 'locked');
  await expect(page.locator('section.lock')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('p.lock-error')).toBeHidden();
  await expect(page.locator('button.lock-unlock')).toBeEnabled();
  await expect
    .poll(async () => (await page.evaluate(() => window.__fakeWebAuthn.calls)).filter((c) => c.method === 'get').length)
    .toBe(1);

  // A manual tap afterwards behaves exactly as before the amendment: the
  // fake is still rejecting, so this second attempt shows the error.
  await page.locator('button.lock-unlock').click();

  await expect(page.locator('p.lock-error')).toBeVisible();
  await expect(page.locator('p.lock-error')).toHaveText('Unlock was cancelled.');
  await expect(page.locator('#app')).toHaveAttribute('data-lock', 'locked');

  const getCalls = (await page.evaluate(() => window.__fakeWebAuthn.calls)).filter((c) => c.method === 'get');
  expect(getCalls.length).toBe(2);

  expect(events).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// K4 — sessionStorage persists across reload; clearing it re-locks
// ===========================================================================

test('K4 — sessionStorage persists across reload (stays unlocked, no re-attempt); clearing it triggers a fresh automatic attempt on reload', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await seedSession(page);
  await seedLock(page);
  // Two-call sequence: the first automatic attempt (right after the
  // initial load) succeeds; the second (the automatic attempt that fires
  // on the reload AFTER sessionStorage.clear()) is rejected, so "locked
  // again on reload" is a stable, assertable state rather than a race
  // against another instantly-successful auto-unlock.
  await installFakeWebAuthn(page, { get: [{ ok: true }, { ok: false, errorName: 'NotAllowedError' }] });
  await routeEmptyRest(page);

  await page.goto('/index.html#/');
  // No tap: the first automatic attempt unlocks on its own.
  await expect(page.locator('#app')).toHaveAttribute('data-lock', 'unlocked');

  await page.reload();
  // Already unlocked this session (sessionStorage survives a reload), so
  // the lock view never mounts and no second get() call happens here.
  await expect(page.locator('#app')).toHaveAttribute('data-lock', 'unlocked');
  await expect(page.locator('section.lock')).toHaveCount(0);

  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  // The lock view mounts again and attempts unlock() automatically; this
  // is the sequence's second, rejecting outcome.
  await expect(page.locator('#app')).toHaveAttribute('data-lock', 'locked');
  await expect(page.locator('section.lock')).toBeVisible();

  const getCalls = (await page.evaluate(() => window.__fakeWebAuthn.calls)).filter((c) => c.method === 'get');
  expect(getCalls.length).toBe(1); // only this reload's attempt — calls resets per document

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// K5 — "Sign out instead": clears lock + cache, signs out
// ===========================================================================

test('K5 — "Sign out instead" clears the lock and cache, signs out, and shows the sign-in gate', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await seedSession(page);
  await seedLock(page);
  // The automatic attempt must NOT succeed here, or it would unlock before
  // this test gets to exercise the "Sign out instead" hatch.
  await installFakeWebAuthn(page, { get: { ok: false, errorName: 'NotAllowedError' } });
  const logoutRequests = [];
  await routeLogout(page, { requests: logoutRequests });
  await routeEmptyRest(page);

  await page.goto('/index.html#/');
  await expect(page.locator('#app')).toHaveAttribute('data-lock', 'locked');

  await page.locator('button.lock-signout').click();

  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-out');
  await expect(page.locator('section.signin')).toBeVisible();

  const lockAfter = await page.evaluate(() => localStorage.getItem('daily.applock.v1'));
  const cacheAfter = await page.evaluate(() => localStorage.getItem('daily.cache.v1'));
  expect(lockAfter).toBeNull();
  expect(cacheAfter).toBeNull();
  expect(logoutRequests.length).toBe(1);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// K6 — no WebAuthn API at all: the AUTOMATIC attempt itself resolves
// 'unsupported' (no tap needed); Unlock disabled; Sign out still works
// ===========================================================================

test('K6 — no navigator.credentials at all: the automatic attempt alone shows the unavailable text and disables Unlock; Sign out still works', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await seedSession(page);
  await seedLock(page);
  await removeWebAuthn(page);
  const logoutRequests = [];
  await routeLogout(page, { requests: logoutRequests });
  await routeEmptyRest(page);

  await page.goto('/index.html#/');
  await expect(page.locator('section.lock')).toBeVisible();

  // No tap: the automatic attempt on mount already finds no WebAuthn API.
  await expect(page.locator('p.lock-error')).toBeVisible();
  await expect(page.locator('p.lock-error')).toHaveText('Face ID is not available in this browser. Sign out to continue.');
  await expect(page.locator('button.lock-unlock')).toBeDisabled();

  await page.locator('button.lock-signout').click();
  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-out');
  expect(logoutRequests.length).toBe(1);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// K7 — Settings, no lock -> Turn on
// ===========================================================================

test('K7 — Settings "Turn on": create() gets userVerification required and rp.name "Daily"; status flips to On; a later Home visit does not lock', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await seedSession(page);
  await installFakeWebAuthn(page, { create: { ok: true, rawIdBytes: [11, 22, 33, 44] } });
  await routeEmptyRest(page);

  await page.goto('/index.html#/settings');
  const block = page.locator('section.settings-block[data-block="applock"]');
  await expect(block).toBeVisible();
  await expect(block.locator('.settings-help')).toHaveText(
    'Locks the app on this device behind Face ID, Touch ID or your passcode. Needs a network connection to unlock. Your account is separate: signing in still needs your password.'
  );
  await expect(block.locator('.settings-applock-status')).toHaveText('Off');
  await expect(block.locator('button[data-action="applock-on"]')).toHaveText('Turn on');

  await block.locator('button[data-action="applock-on"]').click();

  await expect(block.locator('.settings-applock-status')).toHaveText(/^On since \d{4}-\d{2}-\d{2}$/);

  const calls = await page.evaluate(() => window.__fakeWebAuthn.calls);
  const createCalls = calls.filter((c) => c.method === 'create');
  expect(createCalls.length).toBe(1);
  expect(createCalls[0].opts.publicKey.authenticatorSelection.userVerification).toBe('required');
  expect(createCalls[0].opts.publicKey.rp.name).toBe('Daily');

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('daily.applock.v1')));
  expect(typeof stored.credentialId).toBe('string');
  expect(stored.credentialId.length).toBeGreaterThan(0);
  expect(stored.credentialId).not.toMatch(/[+/=]/);

  // The user just verified turning it on, so a subsequent navigation within
  // the same session must NOT re-challenge.
  await page.goto('/index.html#/');
  await expect(page.locator('#app')).toHaveAttribute('data-lock', 'unlocked');
  await expect(page.locator('section.home')).toBeVisible();

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// K8 — Settings, lock already on -> Turn off
// ===========================================================================

test('K8 — Settings "Turn off": clears the stored lock and flips the status back to Off', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await seedSession(page);
  await seedLock(page);
  await seedUnlockedSession(page); // land on Settings directly, not the lock screen
  await installFakeWebAuthn(page); // present but unused by "off"
  await routeEmptyRest(page);

  await page.goto('/index.html#/settings');
  await expect(page.locator('#app')).toHaveAttribute('data-lock', 'unlocked');
  const block = page.locator('section.settings-block[data-block="applock"]');
  await expect(block.locator('.settings-applock-status')).toContainText('On since');

  await block.locator('button[data-action="applock-off"]').click();

  await expect(block.locator('.settings-applock-status')).toHaveText('Off');
  const stored = await page.evaluate(() => localStorage.getItem('daily.applock.v1'));
  expect(stored).toBeNull();

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// K9 — Settings, no WebAuthn support: unavailable text, no button
// ===========================================================================

test('K9 — Settings with no WebAuthn support shows the unavailable text and no toggle button', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await seedSession(page);
  await removeWebAuthn(page);
  await routeEmptyRest(page);

  await page.goto('/index.html#/settings');
  const block = page.locator('section.settings-block[data-block="applock"]');
  await expect(block).toBeVisible();
  await expect(block.locator('.settings-applock-status')).toHaveText('Not available on this device or browser.');
  await expect(block.locator('button.settings-applock-toggle')).toHaveCount(0);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// K10 — signed out + lock seeded: sign-in gate shows, never the lock screen
// ===========================================================================

test('K10 — signed out, even with a lock seeded: the sign-in gate shows, not the lock screen', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  // No seedSession() here — this case is signed-out on purpose.
  await seedLock(page);
  await routeEmptyRest(page);

  await page.goto('/index.html#/');

  await expect(page.locator('#app')).toHaveAttribute('data-auth', 'signed-out');
  await expect(page.locator('section.signin')).toBeVisible();
  await expect(page.locator('section.lock')).toHaveCount(0);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// Step U.1 (CONTRACT-U.1.md §2/§6): the locked gate also gets a shell title
// — "Locked", compact, no back — same per-route table as every other gate.
// The automatic unlock attempt (present since K2) must not fire here, or the
// screen would flip to unlocked before this test can observe the title, so
// the fake WebAuthn get() is made to reject like K3/K5.
// ===========================================================================

test('U.1 — a locked launch shows title "Locked", compact, with the back button hidden', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await seedSession(page);
  await seedLock(page);
  await installFakeWebAuthn(page, { get: { ok: false, errorName: 'NotAllowedError' } });
  const events = [];
  await routeEmptyRest(page, { events });

  await page.goto('/index.html#/settings');

  await expect(page.locator('#app')).toHaveAttribute('data-lock', 'locked');
  await expect(page.locator('section.lock')).toBeVisible();
  await expect(page.locator('#title')).toHaveText('Locked');
  await expect(page.locator('#title-bar')).toHaveAttribute('data-size', 'compact');
  await expect(page.locator('#title-back')).toHaveAttribute('hidden', '');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// CONTRACT-U.6.md §7 — LU-1: the lock glyph. Written strictly against §4/§5/
// §7 of that contract; the implementation (js/views/lock.js, css/styles.css)
// is being written in parallel and is not visible here. The automatic
// unlock attempt (present since K2) is made to reject, same as K3/K5/U.1,
// so the lock screen stays visible for this test to observe.
// ===========================================================================

test('LU-1 — a locked launch shows the lock glyph and a wide Unlock button, with the lock title unchanged', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await seedSession(page);
  await seedLock(page);
  await installFakeWebAuthn(page, { get: { ok: false, errorName: 'NotAllowedError' } });
  await routeEmptyRest(page);

  await page.goto('/index.html#/settings');

  await expect(page.locator('#app')).toHaveAttribute('data-lock', 'locked');
  await expect(page.locator('.lock-glyph svg')).toHaveCount(1);

  const box = await page.locator('button.lock-unlock').boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(300);

  await expect(page.locator('.lock-title')).toHaveText('Daily is locked');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});
