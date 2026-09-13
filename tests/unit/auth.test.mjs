// Contract tests for js/auth.js (Step D.7 — CONTRACT-D.7.md §3, §12.2).
//
// The implementation is being written in parallel by another agent; these
// tests are written strictly from the interface contract, not from reading
// js/auth.js. Everything here is injected (storage, fetchImpl, now) — zero
// real network, zero real localStorage (Node has none anyway).
//
// createAuth() is used throughout rather than the getAuth() singleton, so
// each test gets an isolated instance with no cross-test state. The
// singleton itself is exercised by tests/unit/api.test.mjs (§12.3), which
// specifically needs the shared module-level instance that js/api.js calls
// getAuth() against.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuth,
  decodeJwtClaims,
  decodeJwtExp,
  SESSION_KEY,
  REFRESH_MARGIN_S,
} from '../../js/auth.js';
import { AuthError, NetworkError } from '../../js/errors.js';
import { fakeJwt as buildFakeJwt } from '../helpers/e2e-session.mjs';

const URL = 'https://fake-project.supabase.co';
const ANON_KEY = 'anon-key-abc123';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function jwt({ exp, sub = 'user-1', email = 'u@example.com', role = 'authenticated' } = {}) {
  return buildFakeJwt({ exp, sub, email, role });
}

function memStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const removed = [];
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { removed.push(k); map.delete(k); },
    _map: map,
    _removed: removed,
  };
}

function throwingStorage() {
  return {
    getItem() { throw new Error('storage broken'); },
    setItem() { throw new Error('storage broken'); },
    removeItem() { throw new Error('storage broken'); },
  };
}

function clock(startMs) {
  let t = startMs;
  const fn = () => t;
  fn.set = (ms) => { t = ms; };
  fn.advanceS = (s) => { t += s * 1000; };
  return fn;
}

// Records every call (url/method/headers/body parsed) and resolves the Nth
// call with the Nth configured response (last one repeats if exhausted).
// Mirrors installFetchSequence() in tests/unit/api.test.mjs.
function installFetchSequence(responses) {
  const calls = [];
  let i = 0;
  const stub = async (url, init = {}) => {
    const record = {
      url: String(url),
      method: init.method || 'GET',
      headers: { ...(init.headers || {}) },
      body: init.body,
    };
    calls.push(record);
    const resp = responses[Math.min(i, responses.length - 1)] || {};
    i += 1;
    if (resp.reject) throw resp.reject;
    const { status = 200, body = {} } = resp;
    const text = resp.text !== undefined ? resp.text : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
  return { fetchImpl: stub, calls };
}

function freshSession(overrides = {}) {
  return {
    v: 1,
    access_token: jwt({ exp: 9999999999, sub: 'existing-user' }),
    refresh_token: 'existing-refresh',
    expires_at: 9999999999,
    user: { id: 'existing-user', email: 'existing@example.com' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// decodeJwtClaims / decodeJwtExp
// ---------------------------------------------------------------------------

describe('decodeJwtClaims', () => {
  it('decodes a valid 3-part token', () => {
    const token = jwt({ exp: 123, sub: 'abc', email: 'x@y.com', role: 'authenticated' });
    const claims = decodeJwtClaims(token);
    assert.equal(claims.sub, 'abc');
    assert.equal(claims.email, 'x@y.com');
    assert.equal(claims.role, 'authenticated');
    assert.equal(claims.exp, 123);
  });

  it('decodes an unpadded base64url payload', () => {
    // JSON with a length that would need '=' padding in standard base64.
    const payload = { sub: 'unpadded-case', exp: 42 };
    const seg = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.ok(!seg.includes('='), 'fixture should actually be unpadded');
    const token = `hdr.${seg}.sig`;
    assert.deepEqual(decodeJwtClaims(token), payload);
  });

  it('decodes a PADDED base64url payload (some producers emit "=")', () => {
    const payload = { sub: 'padded-case', exp: 42, x: 'y' };
    const std = Buffer.from(JSON.stringify(payload)).toString('base64'); // may carry '='
    const seg = std.replace(/\+/g, '-').replace(/\//g, '_');
    const token = `hdr.${seg}.sig`;
    assert.deepEqual(decodeJwtClaims(token), payload);
  });

  it('a 2-part token (no signature segment) still decodes part[1] if present', () => {
    const payload = { sub: 'two-part', exp: 7 };
    const seg = b64url(payload);
    const token = `hdr.${seg}`;
    assert.deepEqual(decodeJwtClaims(token), payload);
  });

  it('garbage (not base64 JSON) returns null, does not throw', () => {
    assert.equal(decodeJwtClaims('not.valid.jwt'), null);
    assert.equal(decodeJwtClaims('!!!.###.$$$'), null);
    assert.equal(decodeJwtClaims('justonesegmentnodots'), null);
    assert.equal(decodeJwtClaims(''), null);
  });

  it('non-string input returns null, does not throw', () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      assert.doesNotThrow(() => decodeJwtClaims(bad));
      assert.equal(decodeJwtClaims(bad), null);
    }
  });
});

describe('decodeJwtExp', () => {
  it('returns the exp claim (seconds) for a valid token', () => {
    const token = jwt({ exp: 1999999999 });
    assert.equal(decodeJwtExp(token), 1999999999);
  });

  it('returns null when exp is missing', () => {
    const seg = b64url({ sub: 'no-exp' });
    assert.equal(decodeJwtExp(`hdr.${seg}.sig`), null);
  });

  it('returns null when exp is non-numeric', () => {
    const seg = b64url({ sub: 'x', exp: 'not-a-number' });
    assert.equal(decodeJwtExp(`hdr.${seg}.sig`), null);
  });

  it('returns null when exp is present but null', () => {
    const seg = b64url({ sub: 'x', exp: null });
    assert.equal(decodeJwtExp(`hdr.${seg}.sig`), null);
  });

  it('returns null for garbage input, never throws', () => {
    assert.doesNotThrow(() => decodeJwtExp('garbage'));
    assert.equal(decodeJwtExp('garbage'), null);
    assert.equal(decodeJwtExp(null), null);
    assert.equal(decodeJwtExp(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// hydrate (constructor reads storage synchronously)
// ---------------------------------------------------------------------------

describe('createAuth — hydrate from storage', () => {
  it('absent key -> session null', () => {
    const auth = createAuth({ storage: memStorage(), url: URL, anonKey: ANON_KEY });
    assert.equal(auth.getSession(), null);
  });

  it('v !== 1 -> null, and the bad value is removed', () => {
    const bad = JSON.stringify({ v: 2, access_token: 'a', refresh_token: 'b' });
    const storage = memStorage({ [SESSION_KEY]: bad });
    const auth = createAuth({ storage, url: URL, anonKey: ANON_KEY });
    assert.equal(auth.getSession(), null);
    assert.ok(storage._removed.includes(SESSION_KEY));
  });

  it('corrupt JSON -> null, removed', () => {
    const storage = memStorage({ [SESSION_KEY]: '{not json' });
    const auth = createAuth({ storage, url: URL, anonKey: ANON_KEY });
    assert.equal(auth.getSession(), null);
    assert.ok(storage._removed.includes(SESSION_KEY));
  });

  it('missing access_token/refresh_token strings -> null, removed', () => {
    const cases = [
      { v: 1, refresh_token: 'b' }, // no access_token
      { v: 1, access_token: 'a' }, // no refresh_token
      { v: 1, access_token: 5, refresh_token: 'b' }, // non-string
      { v: 1, access_token: 'a', refresh_token: null },
    ];
    for (const bad of cases) {
      const storage = memStorage({ [SESSION_KEY]: JSON.stringify(bad) });
      const auth = createAuth({ storage, url: URL, anonKey: ANON_KEY });
      assert.equal(auth.getSession(), null, JSON.stringify(bad));
      assert.ok(storage._removed.includes(SESSION_KEY), JSON.stringify(bad));
    }
  });

  it('a valid stored session hydrates getSession()', () => {
    const session = freshSession();
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(session) });
    const auth = createAuth({ storage, url: URL, anonKey: ANON_KEY });
    assert.deepEqual(auth.getSession(), session);
    assert.equal(auth.isSignedIn(), true);
  });

  it('storage that throws on every method still works, in memory', () => {
    const storage = throwingStorage();
    assert.doesNotThrow(() => createAuth({ storage, url: URL, anonKey: ANON_KEY }));
    const auth = createAuth({ storage, url: URL, anonKey: ANON_KEY });
    assert.equal(auth.getSession(), null);
  });
});

// ---------------------------------------------------------------------------
// signInWithPassword
// ---------------------------------------------------------------------------

describe('signInWithPassword — request shape and local validation', () => {
  it('empty email -> local AuthError invalid_credentials, no fetch', async () => {
    const { fetchImpl, calls } = installFetchSequence([]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    await assert.rejects(() => auth.signInWithPassword('', 'pw'), (err) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.reason, 'invalid_credentials');
      assert.equal(err.message, 'Enter your email and password.');
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it('whitespace-only email (trims to empty) -> local AuthError, no fetch', async () => {
    const { fetchImpl, calls } = installFetchSequence([]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    await assert.rejects(() => auth.signInWithPassword('   ', 'pw'), { reason: 'invalid_credentials' });
    assert.equal(calls.length, 0);
  });

  it('empty password -> local AuthError, no fetch', async () => {
    const { fetchImpl, calls } = installFetchSequence([]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    await assert.rejects(() => auth.signInWithPassword('a@b.com', ''), { reason: 'invalid_credentials' });
    assert.equal(calls.length, 0);
  });

  it('whitespace-only PASSWORD is NOT trimmed, so it is a non-empty string and DOES go to the network', async () => {
    // Asymmetry per contract §3.3: email is trim()'d before the emptiness
    // check, password is not. A whitespace password is nonsensical but is
    // not this layer's job to reject.
    const { fetchImpl, calls } = installFetchSequence([{ status: 400, body: { msg: 'Invalid login credentials' } }]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    await assert.rejects(() => auth.signInWithPassword('a@b.com', '   '), { reason: 'invalid_credentials' });
    assert.equal(calls.length, 1, 'a whitespace password must still reach the network');
  });

  it('exact request: URL, method, headers, body; email trimmed, password left as-is', async () => {
    const goodBody = { access_token: jwt({ exp: 9999999999 }), refresh_token: 'rt', expires_at: 9999999999, user: { id: 'u1', email: 'a@b.com' } };
    const { fetchImpl, calls } = installFetchSequence([{ status: 200, body: goodBody }]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    await auth.signInWithPassword('  a@b.com  ', '  pw  ');
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.url, `${URL}/auth/v1/token?grant_type=password`);
    assert.equal(call.headers.apikey, ANON_KEY);
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.equal(call.headers.Accept, 'application/json');
    const sent = JSON.parse(call.body);
    assert.equal(sent.email, 'a@b.com', 'email must be trimmed in the sent body');
    assert.equal(sent.password, '  pw  ', 'password must NOT be trimmed');
  });
});

describe('signInWithPassword — 2xx response parsing', () => {
  it('stores session with expires_at taken from the body when finite', async () => {
    const body = { access_token: jwt({ exp: 111 }), refresh_token: 'rt', expires_at: 555555, user: { id: 'u1', email: 'a@b.com' } };
    const { fetchImpl } = installFetchSequence([{ status: 200, body }]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    const session = await auth.signInWithPassword('a@b.com', 'pw');
    assert.equal(session.expires_at, 555555);
  });

  it('falls back to now()/1000 + expires_in when expires_at is absent', async () => {
    const body = { access_token: jwt({}), refresh_token: 'rt', expires_in: 3600, user: { id: 'u1', email: 'a@b.com' } };
    const { fetchImpl } = installFetchSequence([{ status: 200, body }]);
    const nowMs = 1700000000000;
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY, now: () => nowMs });
    const session = await auth.signInWithPassword('a@b.com', 'pw');
    assert.equal(session.expires_at, Math.floor(nowMs / 1000) + 3600);
  });

  it('falls back to the JWT exp claim when expires_at and expires_in are both absent', async () => {
    const body = { access_token: jwt({ exp: 1888888888 }), refresh_token: 'rt', user: { id: 'u1', email: 'a@b.com' } };
    const { fetchImpl } = installFetchSequence([{ status: 200, body }]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    const session = await auth.signInWithPassword('a@b.com', 'pw');
    assert.equal(session.expires_at, 1888888888);
  });

  it('falls back to 0 when nothing supplies an expiry', async () => {
    const body = { access_token: 'not-a-jwt-at-all', refresh_token: 'rt', user: { id: 'u1', email: 'a@b.com' } };
    const { fetchImpl } = installFetchSequence([{ status: 200, body }]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    const session = await auth.signInWithPassword('a@b.com', 'pw');
    assert.equal(session.expires_at, 0);
  });

  it('user.id/email come from body.user when present', async () => {
    const body = { access_token: jwt({ sub: 'jwt-sub', email: 'jwt@e.com', exp: 999999999 }), refresh_token: 'rt', expires_at: 999999999, user: { id: 'body-id', email: 'body@e.com' } };
    const { fetchImpl } = installFetchSequence([{ status: 200, body }]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    const session = await auth.signInWithPassword('a@b.com', 'pw');
    assert.equal(session.user.id, 'body-id');
    assert.equal(session.user.email, 'body@e.com');
  });

  it('user.id/email fall back to the JWT sub/email claims when body.user is absent', async () => {
    const body = { access_token: jwt({ sub: 'jwt-sub', email: 'jwt@e.com', exp: 999999999 }), refresh_token: 'rt', expires_at: 999999999 };
    const { fetchImpl } = installFetchSequence([{ status: 200, body }]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    const session = await auth.signInWithPassword('a@b.com', 'pw');
    assert.equal(session.user.id, 'jwt-sub');
    assert.equal(session.user.email, 'jwt@e.com');
  });

  it('user.id/email are null when neither body nor JWT supplies them', async () => {
    const body = { access_token: 'not-a-jwt', refresh_token: 'rt', expires_at: 999999999 };
    const { fetchImpl } = installFetchSequence([{ status: 200, body }]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    const session = await auth.signInWithPassword('a@b.com', 'pw');
    assert.equal(session.user.id, null);
    assert.equal(session.user.email, null);
  });

  it('a 2xx body missing a string access_token/refresh_token throws AuthError reason "server"', async () => {
    const cases = [
      { refresh_token: 'rt' }, // no access_token
      { access_token: 'at' }, // no refresh_token
      { access_token: 123, refresh_token: 'rt' }, // non-string
    ];
    for (const body of cases) {
      const { fetchImpl } = installFetchSequence([{ status: 200, body }]);
      const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
      await assert.rejects(() => auth.signInWithPassword('a@b.com', 'pw'), (err) => {
        assert.ok(err instanceof AuthError, JSON.stringify(body));
        assert.equal(err.reason, 'server', JSON.stringify(body));
        return true;
      });
    }
  });

  it('persists the session to storage and getSession() returns it', async () => {
    const body = { access_token: jwt({ exp: 999999999 }), refresh_token: 'rt', expires_at: 999999999, user: { id: 'u1', email: 'a@b.com' } };
    const { fetchImpl } = installFetchSequence([{ status: 200, body }]);
    const storage = memStorage();
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY });
    const session = await auth.signInWithPassword('a@b.com', 'pw');
    assert.deepEqual(auth.getSession(), session);
    const stored = JSON.parse(storage._map.get(SESSION_KEY));
    assert.equal(stored.access_token, session.access_token);
  });

  it('onChange fires exactly once with the new session copy', async () => {
    const body = { access_token: jwt({ exp: 999999999 }), refresh_token: 'rt', expires_at: 999999999, user: { id: 'u1', email: 'a@b.com' } };
    const { fetchImpl } = installFetchSequence([{ status: 200, body }]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    const seen = [];
    auth.onChange((s) => seen.push(s));
    const session = await auth.signInWithPassword('a@b.com', 'pw');
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], session);
  });
});

describe('signInWithPassword — error responses', () => {
  for (const status of [400, 401, 403, 422]) {
    it(`${status} with { msg } body -> invalid_credentials with that message`, async () => {
      const { fetchImpl } = installFetchSequence([{ status, body: { msg: 'Invalid login credentials' } }]);
      const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
      await assert.rejects(() => auth.signInWithPassword('a@b.com', 'wrong'), (err) => {
        assert.ok(err instanceof AuthError);
        assert.equal(err.reason, 'invalid_credentials');
        assert.equal(err.message, 'Invalid login credentials');
        assert.equal(err.status, status);
        assert.equal(err.retryable, false);
        return true;
      });
    });
  }

  it('400 with { error_description } body shape (GoTrue uses both) -> invalid_credentials with that message', async () => {
    const { fetchImpl } = installFetchSequence([{ status: 400, body: { error_description: 'Wrong password' } }]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    await assert.rejects(() => auth.signInWithPassword('a@b.com', 'wrong'), (err) => {
      assert.equal(err.reason, 'invalid_credentials');
      assert.equal(err.message, 'Wrong password');
      return true;
    });
  });

  it('a 4xx body with neither msg/error_description/error falls back to "Sign-in failed"', async () => {
    const { fetchImpl } = installFetchSequence([{ status: 400, body: {} }]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    await assert.rejects(() => auth.signInWithPassword('a@b.com', 'wrong'), (err) => {
      assert.equal(err.message, 'Sign-in failed');
      return true;
    });
  });

  it('500 -> reason "server", retryable true', async () => {
    const { fetchImpl } = installFetchSequence([{ status: 500, body: { error: 'boom' } }]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    await assert.rejects(() => auth.signInWithPassword('a@b.com', 'pw'), (err) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.reason, 'server');
      assert.equal(err.message, 'boom');
      assert.equal(err.status, 500);
      assert.equal(err.retryable, true);
      return true;
    });
  });

  it('429 -> reason "server"', async () => {
    const { fetchImpl } = installFetchSequence([{ status: 429, body: { error: 'slow down' } }]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    await assert.rejects(() => auth.signInWithPassword('a@b.com', 'pw'), { reason: 'server' });
  });

  it('a rejecting fetchImpl -> NetworkError with the cause preserved', async () => {
    const cause = new TypeError('fetch failed');
    const fetchImpl = async () => { throw cause; };
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    await assert.rejects(() => auth.signInWithPassword('a@b.com', 'pw'), (err) => {
      assert.ok(err instanceof NetworkError);
      assert.equal(err.message, 'Sign-in failed: network');
      assert.equal(err.cause, cause);
      return true;
    });
  });

  it('a failed sign-in leaves an existing session untouched', async () => {
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(freshSession()) });
    const { fetchImpl } = installFetchSequence([{ status: 400, body: { msg: 'nope' } }]);
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY });
    await assert.rejects(() => auth.signInWithPassword('a@b.com', 'wrong'), { reason: 'invalid_credentials' });
    assert.deepEqual(auth.getSession(), freshSession());
  });
});

// ---------------------------------------------------------------------------
// getAccessToken
// ---------------------------------------------------------------------------

describe('getAccessToken', () => {
  it('signed out -> null, no fetch', async () => {
    const { fetchImpl, calls } = installFetchSequence([]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    const token = await auth.getAccessToken();
    assert.equal(token, null);
    assert.equal(calls.length, 0);
  });

  it('fresh token (well beyond the margin) -> resolves current token, no fetch', async () => {
    const nowS = 1700000000;
    const session = freshSession({ access_token: 'AT1', expires_at: nowS + REFRESH_MARGIN_S + 3600 });
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(session) });
    const { fetchImpl, calls } = installFetchSequence([]);
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY, now: () => nowS * 1000 });
    const token = await auth.getAccessToken();
    assert.equal(token, 'AT1');
    assert.equal(calls.length, 0);
  });

  it('within the margin -> refreshes and resolves the NEW token', async () => {
    const nowS = 1700000000;
    const session = freshSession({ access_token: 'OLD', refresh_token: 'oldrt', expires_at: nowS + 30 }); // 30s < 60s margin
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(session) });
    const newBody = { access_token: 'NEW', refresh_token: 'newrt', expires_at: nowS + 3600 };
    const { fetchImpl, calls } = installFetchSequence([{ status: 200, body: newBody }]);
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY, now: () => nowS * 1000 });
    const token = await auth.getAccessToken();
    assert.equal(token, 'NEW');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('grant_type=refresh_token'));
  });

  it('exactly at the margin boundary (difference == REFRESH_MARGIN_S) still refreshes', async () => {
    // Contract: "> REFRESH_MARGIN_S -> no request; otherwise refresh" — the
    // boundary itself (not strictly greater) must refresh.
    const nowS = 1700000000;
    const session = freshSession({ access_token: 'OLD', refresh_token: 'oldrt', expires_at: nowS + REFRESH_MARGIN_S });
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(session) });
    const newBody = { access_token: 'NEW', refresh_token: 'newrt', expires_at: nowS + 3600 };
    const { fetchImpl, calls } = installFetchSequence([{ status: 200, body: newBody }]);
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY, now: () => nowS * 1000 });
    const token = await auth.getAccessToken();
    assert.equal(calls.length, 1, 'boundary case must trigger a refresh');
    assert.equal(token, 'NEW');
  });

  it('refresh NetworkError -> the STALE token is returned and the session is kept', async () => {
    const nowS = 1700000000;
    const session = freshSession({ access_token: 'OLD', refresh_token: 'oldrt', expires_at: nowS + 10 });
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(session) });
    const fetchImpl = async () => { throw new TypeError('offline'); };
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY, now: () => nowS * 1000 });
    const token = await auth.getAccessToken();
    assert.equal(token, 'OLD');
    assert.equal(auth.isSignedIn(), true);
    assert.deepEqual(auth.getSession(), session);
  });

  it('refresh 400 (session invalid) propagates AuthError session_expired, and clears the session', async () => {
    const nowS = 1700000000;
    const session = freshSession({ access_token: 'OLD', refresh_token: 'oldrt', expires_at: nowS + 10 });
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(session) });
    const { fetchImpl } = installFetchSequence([{ status: 400, body: {} }]);
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY, now: () => nowS * 1000 });
    const seen = [];
    auth.onChange((s) => seen.push(s));
    await assert.rejects(() => auth.getAccessToken(), (err) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.reason, 'session_expired');
      assert.equal(err.retryable, true);
      return true;
    });
    assert.equal(auth.getSession(), null);
    assert.deepEqual(seen, [null]);
  });
});

// ---------------------------------------------------------------------------
// refreshSession
// ---------------------------------------------------------------------------

describe('refreshSession', () => {
  it('signed out -> AuthError signed_out, no fetch', async () => {
    const { fetchImpl, calls } = installFetchSequence([]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    await assert.rejects(() => auth.refreshSession(), (err) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.reason, 'signed_out');
      assert.equal(err.retryable, true);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it('exact request shape: URL, method, headers, body = { refresh_token }', async () => {
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(freshSession({ refresh_token: 'rt-xyz' })) });
    const newBody = { access_token: 'NEW', refresh_token: 'NEWRT', expires_at: 9999999999 };
    const { fetchImpl, calls } = installFetchSequence([{ status: 200, body: newBody }]);
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY });
    await auth.refreshSession();
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.url, `${URL}/auth/v1/token?grant_type=refresh_token`);
    assert.equal(call.headers.apikey, ANON_KEY);
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(call.body), { refresh_token: 'rt-xyz' });
  });

  it('2xx replaces the WHOLE session and rotates the refresh token in storage', async () => {
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(freshSession({ refresh_token: 'old-rt' })) });
    const newBody = { access_token: 'NEW-AT', refresh_token: 'NEW-RT', expires_at: 8888888888, user: { id: 'u2', email: 'new@e.com' } };
    const { fetchImpl } = installFetchSequence([{ status: 200, body: newBody }]);
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY });
    const session = await auth.refreshSession();
    assert.equal(session.refresh_token, 'NEW-RT');
    assert.equal(session.access_token, 'NEW-AT');
    assert.equal(auth.getSession().refresh_token, 'NEW-RT');
    const stored = JSON.parse(storage._map.get(SESSION_KEY));
    assert.equal(stored.refresh_token, 'NEW-RT');
  });

  it('a fetchImpl rejection -> NetworkError, session kept', async () => {
    const original = freshSession();
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(original) });
    const fetchImpl = async () => { throw new TypeError('down'); };
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY });
    await assert.rejects(() => auth.refreshSession(), { name: 'NetworkError' });
    assert.deepEqual(auth.getSession(), original);
  });

  it('any 4xx -> the refresh token is dead: session cleared, AuthError session_expired', async () => {
    for (const status of [400, 401, 403]) {
      const storage = memStorage({ [SESSION_KEY]: JSON.stringify(freshSession()) });
      const { fetchImpl } = installFetchSequence([{ status, body: {} }]);
      const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY });
      const seen = [];
      auth.onChange((s) => seen.push(s));
      await assert.rejects(() => auth.refreshSession(), (err) => {
        assert.equal(err.reason, 'session_expired');
        assert.equal(err.status, status);
        return true;
      });
      assert.equal(auth.getSession(), null, `status ${status}`);
      assert.deepEqual(seen, [null], `status ${status}`);
      assert.equal(storage._map.has(SESSION_KEY), false, `status ${status}`);
    }
  });

  it('5xx -> AuthError reason "server", session KEPT', async () => {
    const original = freshSession();
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(original) });
    const { fetchImpl } = installFetchSequence([{ status: 500, body: {} }]);
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY });
    await assert.rejects(() => auth.refreshSession(), { reason: 'server' });
    assert.deepEqual(auth.getSession(), original);
  });

  it('single-flight: three concurrent calls share exactly one in-flight request', async () => {
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(freshSession()) });
    const newBody = { access_token: 'NEW', refresh_token: 'NEWRT', expires_at: 9999999999 };
    const { fetchImpl, calls } = installFetchSequence([{ status: 200, body: newBody }]);
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY });
    const [a, b, c] = await Promise.all([auth.refreshSession(), auth.refreshSession(), auth.refreshSession()]);
    assert.equal(calls.length, 1, 'exactly one network request for three concurrent callers');
    assert.equal(a.access_token, 'NEW');
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
  });
});

// ---------------------------------------------------------------------------
// signOut
// ---------------------------------------------------------------------------

describe('signOut', () => {
  it('no-op when already signed out: no request, resolves undefined', async () => {
    const { fetchImpl, calls } = installFetchSequence([]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    const result = await auth.signOut();
    assert.equal(result, undefined);
    assert.equal(calls.length, 0);
  });

  it('POSTs /auth/v1/logout with apikey and the session bearer', async () => {
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(freshSession({ access_token: 'TOK' })) });
    const { fetchImpl, calls } = installFetchSequence([{ status: 204, body: null, text: '' }]);
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY });
    await auth.signOut();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, `${URL}/auth/v1/logout`);
    assert.equal(calls[0].headers.apikey, ANON_KEY);
    assert.equal(calls[0].headers.Authorization, 'Bearer TOK');
  });

  it('clears the session even when the logout request 500s', async () => {
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(freshSession()) });
    const { fetchImpl } = installFetchSequence([{ status: 500, body: { error: 'boom' } }]);
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY });
    const seen = [];
    auth.onChange((s) => seen.push(s));
    await assert.doesNotReject(() => auth.signOut());
    assert.equal(auth.getSession(), null);
    assert.deepEqual(seen, [null]);
    assert.equal(storage._map.has(SESSION_KEY), false);
  });

  it('clears the session even when the logout request rejects (offline)', async () => {
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(freshSession()) });
    const fetchImpl = async () => { throw new TypeError('down'); };
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY });
    await assert.doesNotReject(() => auth.signOut());
    assert.equal(auth.getSession(), null);
  });
});

// ---------------------------------------------------------------------------
// clearSession
// ---------------------------------------------------------------------------

describe('clearSession', () => {
  it('clears memory + storage and notifies null', () => {
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(freshSession()) });
    const auth = createAuth({ storage, url: URL, anonKey: ANON_KEY });
    const seen = [];
    auth.onChange((s) => seen.push(s));
    auth.clearSession();
    assert.equal(auth.getSession(), null);
    assert.deepEqual(seen, [null]);
    assert.equal(storage._map.has(SESSION_KEY), false);
  });

  it('is a no-op (no notification) when already signed out', () => {
    const auth = createAuth({ storage: memStorage(), url: URL, anonKey: ANON_KEY });
    const seen = [];
    auth.onChange((s) => seen.push(s));
    auth.clearSession();
    assert.equal(seen.length, 0);
  });
});

// ---------------------------------------------------------------------------
// handleUnauthorized
// ---------------------------------------------------------------------------

describe('handleUnauthorized', () => {
  it('signed out -> false, no fetch', async () => {
    const { fetchImpl, calls } = installFetchSequence([]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    const result = await auth.handleUnauthorized();
    assert.equal(result, false);
    assert.equal(calls.length, 0);
  });

  it('refresh succeeds -> true', async () => {
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(freshSession()) });
    const newBody = { access_token: 'NEW', refresh_token: 'NEWRT', expires_at: 9999999999 };
    const { fetchImpl } = installFetchSequence([{ status: 200, body: newBody }]);
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY });
    const result = await auth.handleUnauthorized();
    assert.equal(result, true);
  });

  it('refresh 4xx -> false, session cleared', async () => {
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(freshSession()) });
    const { fetchImpl } = installFetchSequence([{ status: 401, body: {} }]);
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY });
    const result = await auth.handleUnauthorized();
    assert.equal(result, false);
    assert.equal(auth.getSession(), null);
  });

  it('refresh NetworkError -> false, session KEPT', async () => {
    const original = freshSession();
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(original) });
    const fetchImpl = async () => { throw new TypeError('down'); };
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY });
    const result = await auth.handleUnauthorized();
    assert.equal(result, false);
    assert.deepEqual(auth.getSession(), original);
  });

  it('never throws', async () => {
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(freshSession()) });
    const fetchImpl = async () => { throw new TypeError('down'); };
    const auth = createAuth({ storage, fetchImpl, url: URL, anonKey: ANON_KEY });
    await assert.doesNotReject(() => auth.handleUnauthorized());
  });
});

// ---------------------------------------------------------------------------
// getSession — copy semantics
// ---------------------------------------------------------------------------

describe('getSession — returns a copy', () => {
  it('mutating the returned object does not affect the next call', () => {
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(freshSession()) });
    const auth = createAuth({ storage, url: URL, anonKey: ANON_KEY });
    const first = auth.getSession();
    first.access_token = 'TAMPERED';
    const second = auth.getSession();
    assert.notEqual(second.access_token, 'TAMPERED');
  });

  it('isSignedIn() is true for an EXPIRED access token that still has a refresh token', () => {
    const storage = memStorage({ [SESSION_KEY]: JSON.stringify(freshSession({ expires_at: 1 })) });
    const auth = createAuth({ storage, url: URL, anonKey: ANON_KEY, now: () => Date.now() });
    assert.equal(auth.isSignedIn(), true);
  });
});

// ---------------------------------------------------------------------------
// onChange — subscription mechanics
// ---------------------------------------------------------------------------

describe('onChange', () => {
  it('unsubscribe stops further notifications', async () => {
    const body = { access_token: jwt({ exp: 999999999 }), refresh_token: 'rt', expires_at: 999999999, user: { id: 'u1' } };
    const { fetchImpl } = installFetchSequence([{ status: 200, body }]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    const seen = [];
    const unsub = auth.onChange((s) => seen.push(s));
    unsub();
    await auth.signInWithPassword('a@b.com', 'pw');
    assert.equal(seen.length, 0);
  });

  it('a listener that throws does not prevent other listeners from running or break the caller', async () => {
    const body = { access_token: jwt({ exp: 999999999 }), refresh_token: 'rt', expires_at: 999999999, user: { id: 'u1' } };
    const { fetchImpl } = installFetchSequence([{ status: 200, body }]);
    const auth = createAuth({ storage: memStorage(), fetchImpl, url: URL, anonKey: ANON_KEY });
    const seen = [];
    auth.onChange(() => { throw new Error('bad listener'); });
    auth.onChange((s) => seen.push(s));
    await assert.doesNotReject(() => auth.signInWithPassword('a@b.com', 'pw'));
    assert.equal(seen.length, 1);
  });
});

// ---------------------------------------------------------------------------
// AuthError shape (§2) — exercised directly, since every path above only
// checks it indirectly through specific reasons.
// ---------------------------------------------------------------------------

describe('AuthError shape', () => {
  it('name/code and the retryable rule per reason', () => {
    const cases = [
      ['invalid_credentials', false],
      ['session_expired', true],
      ['signed_out', true],
      ['server', true],
    ];
    for (const [reason, retryable] of cases) {
      const err = new AuthError('msg', { reason });
      assert.equal(err.name, 'AuthError');
      assert.equal(err.code, 'AUTH');
      assert.equal(err.reason, reason);
      assert.equal(err.retryable, retryable, reason);
    }
  });

  it('carries status and body when given', () => {
    const err = new AuthError('msg', { reason: 'server', status: 503, body: { x: 1 } });
    assert.equal(err.status, 503);
    assert.deepEqual(err.body, { x: 1 });
  });

  it('defaults status/body to null when omitted', () => {
    const err = new AuthError('msg', { reason: 'signed_out' });
    assert.equal(err.status, null);
    assert.equal(err.body, null);
  });
});
