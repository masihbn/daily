// Step 5.2 (CONTRACT-5.2 §1) — local WebAuthn app-lock.
//
// WHAT THIS DOES AND DOES NOT PROTECT (read before touching this file):
// enableLock()/unlock() call the browser's WebAuthn API directly. There is
// no server on the other end of that call for this app — the resulting
// attestation (from create()) and assertion (from get()) are NEVER sent
// anywhere and NEVER verified against a stored public key or a challenge
// that anyone but this same device generated. The only thing enforcing
// anything here is the OS's own user-verification gate (Face ID / Touch ID
// / device passcode) refusing to resolve create()/get() until it passes.
// So: this stops someone holding your unlocked, installed phone from
// opening the app without your face/thumb/passcode. It does NOT protect
// against a compromised browser, a malicious script running on this page,
// or anyone who already has your Supabase account password — that
// account-level security is Step D.7's job (Supabase Auth + RLS), not
// this file's. Treat this exactly like a screen lock on an app icon, not
// like a second authentication factor.
//
// INJECTABLE, LAZY DEFAULTS. Every exported function that touches a
// browser API takes its objects (`nav`, `win`, `storage`, `session`,
// `crypto`) as parameters. Defaults are resolved by helper functions
// called from inside the function body — never by referencing a bare
// global (e.g. `navigator`) in a default-parameter expression — so this
// module imports cleanly under plain Node (unit tests, and this task's own
// `node --check`/import verification) with no `window`/`navigator`
// defined at all. In the real app every call site (js/views/lock.js,
// js/views/settings.js) calls these with the relevant object omitted and
// gets the real browser API; tests pass fakes explicitly.
//
// WebAuthn itself requires a secure context (HTTPS, or localhost) — that
// is the platform's own restriction, not something this file enforces.

export const LOCK_KEY = 'daily.applock.v1';
export const UNLOCKED_KEY = 'daily.applock.unlocked.v1';
export const RP_NAME = 'Daily';

// --- lazy default resolvers -------------------------------------------------
// Every one of these is safe to call in Node: `typeof x !== 'undefined'` never
// throws for an undeclared identifier, unlike referencing `x` bare.

function defaultNav() {
  return typeof navigator !== 'undefined' ? navigator : undefined;
}

function defaultWin() {
  return typeof window !== 'undefined' ? window : undefined;
}

function defaultCrypto() {
  return typeof crypto !== 'undefined' ? crypto : undefined;
}

function defaultRpId() {
  return typeof location !== 'undefined' && location && typeof location.hostname === 'string'
    ? location.hostname
    : '';
}

function defaultNow() {
  return new Date();
}

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

// Same "prefer the real thing, but only if a probe write actually
// succeeds" rule as js/store.js's defaultStorage() and js/auth.js's
// defaultStorage() — private-mode Safari can expose a localStorage/
// sessionStorage whose methods throw, which is worse than not having one.
function defaultLocalStorage() {
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      const probeKey = '__daily_applock_storage_probe__';
      ls.setItem(probeKey, '1');
      ls.removeItem(probeKey);
      return ls;
    }
  } catch {
    // Fall through to the in-memory shim.
  }
  return memoryShim();
}

function defaultSessionStorage() {
  try {
    const ss = globalThis.sessionStorage;
    if (ss) {
      const probeKey = '__daily_applock_session_probe__';
      ss.setItem(probeKey, '1');
      ss.removeItem(probeKey);
      return ss;
    }
  } catch {
    // Fall through to the in-memory shim.
  }
  return memoryShim();
}

// --- base64url (same shape as js/auth.js's base64Url helpers — kept
// separate here rather than shared, since auth.js is deliberately a leaf
// module js/api.js imports and must not grow new imports of its own) -------

export function toBase64Url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i += 1) binary += String.fromCharCode(arr[i]);
  let b64;
  if (typeof btoa === 'function') {
    b64 = btoa(binary);
  } else if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(arr).toString('base64');
  } else {
    throw new Error('no base64 encoder available in this environment');
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(str) {
  if (typeof str !== 'string') throw new TypeError('fromBase64Url requires a string');
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
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

// --- storage shims: null-safe, never throw ---------------------------------

function safeGet(storage, key) {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Best-effort only — losing the write here just means the lock (or the
    // unlocked flag) doesn't persist, not a crash.
  }
}

function safeRemove(storage, key) {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Nothing more to do.
  }
}

// -> { credentialId, enabledAt } | null. `storage` is whatever the caller
// resolved (e.g. a try/catch localStorage accessor) — this function does
// not resolve its own default, unlike the WebAuthn-calling functions below,
// because every real call site already has a specific storage in hand.
export function readLock(storage) {
  const raw = safeGet(storage, LOCK_KEY);
  if (raw === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.v !== 1 ||
    typeof parsed.credentialId !== 'string' ||
    typeof parsed.enabledAt !== 'string'
  ) {
    return null;
  }
  return { credentialId: parsed.credentialId, enabledAt: parsed.enabledAt };
}

export function writeLock(storage, lock) {
  if (!lock || typeof lock !== 'object') return;
  const record = { v: 1, credentialId: lock.credentialId, enabledAt: lock.enabledAt };
  safeSet(storage, LOCK_KEY, JSON.stringify(record));
}

export function clearLock(storage) {
  safeRemove(storage, LOCK_KEY);
}

export function isLockEnabled(storage) {
  return readLock(storage) !== null;
}

export function isUnlocked(session) {
  return safeGet(session, UNLOCKED_KEY) === '1';
}

export function markUnlocked(session) {
  safeSet(session, UNLOCKED_KEY, '1');
}

export function clearUnlocked(session) {
  safeRemove(session, UNLOCKED_KEY);
}

// --- WebAuthn feature checks -------------------------------------------------

export function isWebAuthnSupported({ nav, win } = {}) {
  const n = nav || defaultNav();
  const w = win || defaultWin();
  return !!(n && n.credentials && typeof n.credentials.create === 'function' && w && w.PublicKeyCredential);
}

// Never rejects: resolves the platform's answer when the API exists, false
// otherwise (including when the API itself throws or rejects).
export async function isPlatformAuthenticatorAvailable({ win } = {}) {
  const w = win || defaultWin();
  try {
    if (
      w &&
      w.PublicKeyCredential &&
      typeof w.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
    ) {
      return await w.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    }
  } catch {
    // Fall through to false.
  }
  return false;
}

function randomBytes(cryptoObj, length) {
  const c = cryptoObj || defaultCrypto();
  const bytes = new Uint8Array(length);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  }
  return bytes;
}

// --- enable / unlock / disable ----------------------------------------------

// Creates a platform credential and stores its id. Never rejects — every
// failure path resolves to one of the documented strings instead.
export async function enableLock({ nav, storage, crypto: cryptoObj, rpId, now } = {}) {
  const n = nav || defaultNav();
  const st = storage || defaultLocalStorage();
  const rp = typeof rpId === 'string' ? rpId : defaultRpId();
  const nowFn = typeof now === 'function' ? now : defaultNow;

  if (!n || !n.credentials || typeof n.credentials.create !== 'function') {
    return 'unsupported';
  }

  const challenge = randomBytes(cryptoObj, 32);
  const userId = randomBytes(cryptoObj, 16);

  const options = {
    publicKey: {
      challenge,
      rp: { name: RP_NAME, id: rp },
      user: { id: userId, name: 'daily', displayName: 'Daily' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60000,
      attestation: 'none',
    },
  };

  let cred;
  try {
    cred = await n.credentials.create(options);
  } catch (err) {
    if (err && err.name === 'NotAllowedError') return 'cancelled';
    return 'error';
  }

  if (!cred || !cred.rawId) return 'error';

  try {
    writeLock(st, { credentialId: toBase64Url(cred.rawId), enabledAt: nowFn().toISOString() });
  } catch {
    return 'error';
  }
  return 'enabled';
}

// Verifies against the stored credential. Never rejects.
export async function unlock({ nav, storage, session, crypto: cryptoObj, rpId } = {}) {
  const st = storage || defaultLocalStorage();
  const sess = session || defaultSessionStorage();
  const rp = typeof rpId === 'string' ? rpId : defaultRpId();

  const lock = readLock(st);
  if (!lock) return 'no-lock';

  const n = nav || defaultNav();
  if (!n || !n.credentials || typeof n.credentials.get !== 'function') {
    return 'unsupported';
  }

  let idBytes;
  try {
    idBytes = fromBase64Url(lock.credentialId);
  } catch {
    return 'error';
  }

  const challenge = randomBytes(cryptoObj, 32);

  const options = {
    publicKey: {
      challenge,
      rpId: rp,
      allowCredentials: [{ type: 'public-key', id: idBytes, transports: ['internal'] }],
      userVerification: 'required',
      timeout: 60000,
    },
  };

  let assertion;
  try {
    assertion = await n.credentials.get(options);
  } catch (err) {
    if (err && err.name === 'NotAllowedError') return 'cancelled';
    return 'error';
  }

  if (!assertion) return 'error';

  markUnlocked(sess);
  return 'unlocked';
}

export function disableLock({ storage, session } = {}) {
  const st = storage || defaultLocalStorage();
  const sess = session || defaultSessionStorage();
  clearLock(st);
  clearUnlocked(sess);
}
