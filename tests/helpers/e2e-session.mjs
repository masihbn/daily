// Step D.7 — shared e2e helper for the auth gate.
//
// After D.7, js/main.js gates the whole app behind a signed-in session
// (js/auth.js, SESSION_KEY = 'daily.auth.v1'). Every existing e2e file that
// loads the app now needs a session seeded into localStorage BEFORE any app
// script runs (page.addInitScript, not page.evaluate — the latter runs too
// late, after js/main.js has already read localStorage and rendered the
// gate), or it hits the sign-in view instead of the view under test.
//
// This file is intentionally the ONLY new file the Test Author adds outside
// tests/unit|integration|e2e (CONTRACT-D.7.md §1 / §12.1).
//
// The fake JWT here is never verified by anything — js/auth.js only decodes
// it (CONTRACT-D.7.md §3: decodeJwtClaims/decodeJwtExp never verify a
// signature, the server does) — so the "signature" segment is a harmless
// placeholder string, not a real HMAC.

export const FAKE_USER = {
  id: '11111111-2222-4333-8444-555555555555',
  email: 'e2e@example.com',
};

export const SESSION_STORAGE_KEY = 'daily.auth.v1';

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// 'hdr.payload.sig' — the app only decodes part[1], so header and signature
// content are arbitrary; payload carries whatever claims a case needs.
export function fakeJwt({ exp, sub = FAKE_USER.id, email = FAKE_USER.email, role = 'authenticated' } = {}) {
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url({ sub, email, role, exp });
  return `${header}.${payload}.e2e-fake-signature`;
}

// The js/auth.js §3.1 session shape. expiresInS controls the default
// expires_at (now + expiresInS, in unix seconds); any field in `overrides`
// (including expires_at itself, to simulate an already-expired session, or
// access_token/refresh_token/user) replaces the computed default — the app
// reads session.expires_at straight off the stored object, it never
// recomputes it from the JWT on hydrate, so overriding expires_at alone is
// enough to simulate an expired-but-still-signed-in session.
export function fakeSession({ expiresInS = 3600, ...overrides } = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  const expiresAt = nowS + expiresInS;
  return {
    v: 1,
    access_token: fakeJwt({ exp: expiresAt }),
    refresh_token: `fake-refresh-${Math.random().toString(36).slice(2)}`,
    expires_at: expiresAt,
    user: { id: FAKE_USER.id, email: FAKE_USER.email },
    ...overrides,
  };
}

// Seeds localStorage BEFORE any page script runs, so js/main.js's first
// render() sees a session already on hydration — exactly the cold-relaunch
// case a standalone PWA hits every time it reopens.
export async function seedSession(page, session = fakeSession()) {
  await page.addInitScript((s) => {
    localStorage.setItem('daily.auth.v1', JSON.stringify(s));
  }, session);
}

// Same catch-all-guard pattern as the REST installGuard() helpers duplicated
// across tests/e2e/*.test.mjs (home.test.mjs etc.): registered as a route
// that records and aborts, so a stray GoTrue call never reaches the network
// and is asserted on instead.
export async function installAuthGuard(page) {
  const unexpected = [];
  await page.route('**/auth/v1/**', async (route) => {
    unexpected.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort();
  });
  return unexpected;
}
