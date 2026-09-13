// Step D.7 — single-user Supabase Auth (GoTrue REST). This is the ONLY
// module in the app allowed to fetch() the `/auth/v1/` endpoints, the same
// way js/api.js is the only one allowed to fetch `/rest/v1/`. Keeping the
// two separate (rather than folding sign-in into api.js) is what avoids an
// import cycle: api.js needs getAuth() to attach a bearer token and retry a
// 401, so auth.js must not import api.js. It imports only config.js and
// errors.js — see js/errors.js's header for why those are a leaf module.
//
// SESSION MODEL. A session is
//   { v: 1, access_token, refresh_token, expires_at (unix seconds), user: { id, email } }
// held in memory and mirrored to localStorage under SESSION_KEY so the app
// can boot straight into the signed-in state after a cold PWA relaunch
// (iOS evicts a backgrounded PWA from memory freely — this is the same
// "must survive a relaunch" requirement js/store.js's cache exists for).
// An EXPIRED access token with a live refresh token still counts as
// signed in: the refresh token, not the access token, is what "has a
// session" means here. getAccessToken() is what turns that refresh token
// back into a usable access token, transparently, on demand.
//
// OFFLINE RELAUNCH TRAP THIS FILE IS DESIGNED AROUND: on a cold relaunch
// with no network, a refresh attempt will fail with a NetworkError, not an
// AuthError. That must NOT be treated as "the session is invalid" — the
// server never got to say so. getAccessToken() below returns the stale
// token and keeps the session in that case, deliberately, so the app can
// still render whatever is in the local cache. Only a real AuthError
// (the server rejecting the refresh token) clears the session.
//
// No signature verification anywhere in this file: decodeJwtClaims() is
// read-only introspection for UI/local bookkeeping (expiry math, display
// email) — actual authorization is enforced by Postgres RLS on the server,
// which verifies the token properly. Do not start trusting a decoded claim
// for anything security-relevant.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { NetworkError, AuthError } from './errors.js';

export const SESSION_KEY = 'daily.auth.v1';
// Refresh a bit before actual expiry, not exactly at it — a request that
// starts mid-flight while the token ticks over to expired would otherwise
// come back 401 even though getAccessToken() just said "you're fine".
export const REFRESH_MARGIN_S = 60;

// --- JWT introspection (no signature check — see header) -------------------

function base64UrlToBytes(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  let binary;
  if (typeof atob === 'function') {
    binary = atob(s);
  } else if (typeof Buffer !== 'undefined') {
    binary = Buffer.from(s, 'base64').toString('binary');
  } else {
    throw new Error('no base64 decoder available in this environment');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToUtf8(bytes) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(bytes);
  }
  return Buffer.from(bytes).toString('utf8');
}

// -> object | null. Never throws — any malformed input (not a string, too
// few parts, bad base64, bad JSON, a non-object payload) resolves to null.
export function decodeJwtClaims(token) {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const bytes = base64UrlToBytes(parts[1]);
    const text = bytesToUtf8(bytes);
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

// -> number (seconds) | null. Never throws.
export function decodeJwtExp(token) {
  const claims = decodeJwtClaims(token);
  if (!claims) return null;
  return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp : null;
}

// --- storage (private re-implementation — do NOT import js/store.js: that
// module imports js/api.js, which imports THIS file) -----------------------

function memoryShim() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

// Same rule as js/store.js's defaultStorage(): prefer real localStorage,
// but only if a probe write actually succeeds — private-mode Safari can
// expose a localStorage whose methods throw, which is worse than not
// having one.
function defaultStorage() {
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      const probeKey = '__daily_auth_storage_probe__';
      ls.setItem(probeKey, '1');
      ls.removeItem(probeKey);
      return ls;
    }
  } catch {
    // Fall through to the in-memory shim.
  }
  return memoryShim();
}

// --- factory -----------------------------------------------------------

export function createAuth({
  storage = defaultStorage(),
  fetchImpl,
  now = () => Date.now(),
  url = SUPABASE_URL,
  anonKey = SUPABASE_ANON_KEY,
} = {}) {
  // Resolved at call time, never captured at creation — same rule as
  // js/api.js's fetch resolution, so tests can stub globalThis.fetch after
  // this module (and this instance) already exist.
  function doFetch(...args) {
    const impl = typeof fetchImpl === 'function' ? fetchImpl : (...a) => globalThis.fetch(...a);
    return impl(...args);
  }

  function safeGetItem(key) {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  }
  function safeSetItem(key, value) {
    try {
      storage.setItem(key, value);
    } catch {
      // Best-effort mirror only.
    }
  }
  function safeRemoveItem(key) {
    try {
      storage.removeItem(key);
    } catch {
      // Nothing more to do.
    }
  }

  function isValidSessionShape(v) {
    return (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      v.v === 1 &&
      typeof v.access_token === 'string' &&
      typeof v.refresh_token === 'string'
    );
  }

  function hydrate() {
    const raw = safeGetItem(SESSION_KEY);
    if (raw === null) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!isValidSessionShape(parsed)) {
      safeRemoveItem(SESSION_KEY);
      return null;
    }
    return parsed;
  }

  let session = hydrate();
  const listeners = new Set();
  let refreshInFlight = null;

  function copySession(s) {
    return s ? { ...s, user: { ...s.user } } : null;
  }

  function notify() {
    const copy = copySession(session);
    for (const fn of listeners) {
      try {
        fn(copy);
      } catch {
        // A broken listener must not break the auth module.
      }
    }
  }

  // Persists AND notifies in one place, deliberately (same reasoning as
  // js/store.js's persistOutbox()): every call site that changes the
  // session must update memory, storage and listeners together, or a
  // future call site could forget one and leave them inconsistent.
  function setSession(s) {
    session = s;
    if (s === null) {
      safeRemoveItem(SESSION_KEY);
    } else {
      safeSetItem(SESSION_KEY, JSON.stringify(s));
    }
    notify();
  }

  function getSession() {
    return copySession(session);
  }

  function isSignedIn() {
    return session !== null;
  }

  function onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('onChange requires a function');
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function clearSession() {
    if (session === null) return;
    setSession(null);
  }

  // --- GoTrue request plumbing --------------------------------------------

  function authRequestHeaders() {
    return { apikey: anonKey, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  async function parseBody(res) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function messageFrom(body, fallback) {
    if (body && typeof body === 'object') {
      return body.msg ?? body.error_description ?? body.error ?? fallback;
    }
    return fallback;
  }

  // Builds the 3.1 session shape from a GoTrue token response. Returns
  // null when the body doesn't even have the two required tokens (a 2xx
  // that isn't really a session — treated as AuthError('server') by callers).
  function buildSession(body) {
    if (!body || typeof body !== 'object') return null;
    const accessToken = body.access_token;
    const refreshToken = body.refresh_token;
    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') return null;

    let expiresAt;
    if (typeof body.expires_at === 'number' && Number.isFinite(body.expires_at)) {
      expiresAt = body.expires_at;
    } else if (typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)) {
      expiresAt = Math.floor(now() / 1000) + body.expires_in;
    } else {
      const jwtExp = decodeJwtExp(accessToken);
      expiresAt = jwtExp !== null ? jwtExp : 0;
    }

    const claims = decodeJwtClaims(accessToken);
    const bodyUser = body.user && typeof body.user === 'object' ? body.user : null;
    const id = (bodyUser && bodyUser.id !== undefined ? bodyUser.id : null) ?? (claims && claims.sub) ?? null;
    const email =
      (bodyUser && bodyUser.email !== undefined ? bodyUser.email : null) ?? (claims && claims.email) ?? null;

    return {
      v: 1,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      user: { id, email },
    };
  }

  async function signInWithPassword(email, password) {
    const emailTrim = typeof email === 'string' ? email.trim() : '';
    const pass = typeof password === 'string' ? password : '';
    if (emailTrim === '' || pass === '') {
      throw new AuthError('Enter your email and password.', { reason: 'invalid_credentials' });
    }

    let res;
    try {
      res = await doFetch(`${url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: authRequestHeaders(),
        body: JSON.stringify({ email: emailTrim, password: pass }),
      });
    } catch (cause) {
      throw new NetworkError('Sign-in failed: network', cause);
    }

    const body = await parseBody(res);

    if (res.ok) {
      const s = buildSession(body);
      if (!s) throw new AuthError('Sign-in failed', { reason: 'server', status: res.status, body });
      setSession(s);
      return getSession();
    }

    const message = messageFrom(body, 'Sign-in failed');
    if ([400, 401, 403, 422].includes(res.status)) {
      throw new AuthError(message, { reason: 'invalid_credentials', status: res.status, body });
    }
    // 429 and 5xx (and anything else unexpected) — treated as a server
    // problem, not a wrong password, since it isn't one of the shapes
    // GoTrue uses to say "bad credentials".
    throw new AuthError(message, { reason: 'server', status: res.status, body });
  }

  async function doRefresh() {
    if (session === null) {
      throw new AuthError('Not signed in', { reason: 'signed_out' });
    }
    const refreshToken = session.refresh_token;

    let res;
    try {
      res = await doFetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: authRequestHeaders(),
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch (cause) {
      // Session KEPT — the server never got to say the refresh token is
      // bad, so we must not act as though it did. See the header comment.
      throw new NetworkError('Refresh failed: network', cause);
    }

    const body = await parseBody(res);

    if (res.ok) {
      const s = buildSession(body);
      if (!s) throw new AuthError('Refresh failed', { reason: 'server', status: res.status, body });
      // GoTrue rotates the refresh token on every use — always store the
      // new one, never keep the old one around "just in case".
      setSession(s);
      return getSession();
    }

    if (res.status >= 400 && res.status < 500) {
      // The refresh token itself is dead. This is the one path that must
      // clear the session — every other failure mode here keeps it.
      const message = messageFrom(body, 'Session expired');
      setSession(null);
      throw new AuthError(message, { reason: 'session_expired', status: res.status, body });
    }

    // 5xx — session KEPT; this is the server's problem, not proof the
    // refresh token is invalid.
    const message = messageFrom(body, 'Could not refresh session');
    throw new AuthError(message, { reason: 'server', status: res.status, body });
  }

  // Single-flight: concurrent callers share one in-flight request, the
  // same pattern js/store.js's flushOutbox() uses for the same reason — a
  // burst of near-simultaneous requests (e.g. several views mounting at
  // once) must not fire several refreshes and race each other's rotated
  // refresh token.
  async function refreshSession() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = doRefresh();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  async function getAccessToken() {
    if (session === null) return null;
    const nowS = now() / 1000;
    if (session.expires_at - nowS > REFRESH_MARGIN_S) {
      return session.access_token;
    }
    try {
      const refreshed = await refreshSession();
      return refreshed.access_token;
    } catch (err) {
      if (err instanceof NetworkError) {
        // Offline relaunch case: return the stale token and keep the
        // session — the server, not the client, gets to reject it.
        return session !== null ? session.access_token : null;
      }
      // AuthError (session invalid, or a server-side refresh failure) —
      // propagate. js/api.js's caller treats this as retryable and keeps
      // the write queued.
      throw err;
    }
  }

  async function handleUnauthorized() {
    if (session === null) return false;
    try {
      await refreshSession();
      return true;
    } catch {
      // AuthError -> session already cleared by refreshSession's own path
      // (or was never valid). NetworkError -> session kept, but we still
      // can't retry the caller's request with a new token right now.
      // Either way: false, and never throw out of this function.
      return false;
    }
  }

  async function signOut() {
    if (session === null) return undefined;
    const token = session.access_token;
    try {
      await doFetch(`${url}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
      });
    } catch {
      // Best effort — any failure (network, 4xx, 5xx) is swallowed. The
      // local session is cleared regardless; a stray still-valid refresh
      // token left on the server is not this app's problem to solve.
    }
    setSession(null);
    return undefined;
  }

  return {
    getSession,
    isSignedIn,
    onChange,
    signInWithPassword,
    getAccessToken,
    refreshSession,
    handleUnauthorized,
    signOut,
    clearSession,
  };
}

let singleton = null;

export function getAuth() {
  if (!singleton) {
    singleton = createAuth();
  }
  return singleton;
}
