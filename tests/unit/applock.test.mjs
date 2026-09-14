// Unit tests for js/applock.js (Step 5.2 — CONTRACT-5.2.md §1 / §6, cases
// L1-L6). Written strictly against that contract; js/applock.js is being
// implemented in parallel by another agent and has not been read while
// writing this file.
//
// Everything here is injected (nav/storage/session/crypto/now) — no real
// WebAuthn, no real Storage, no real Date.now(). Fake-storage shapes
// (memStorage/throwingStorage) mirror tests/unit/auth.test.mjs's
// conventions so a reader of both files sees the same idioms.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCK_KEY,
  UNLOCKED_KEY,
  RP_NAME,
  toBase64Url,
  fromBase64Url,
  readLock,
  writeLock,
  clearLock,
  isLockEnabled,
  isUnlocked,
  markUnlocked,
  clearUnlocked,
  isWebAuthnSupported,
  isPlatformAuthenticatorAvailable,
  enableLock,
  unlock,
  disableLock,
} from '../../js/applock.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function memStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    _map: map,
  };
}

function throwingStorage() {
  return {
    getItem() {
      throw new Error('storage broken');
    },
    setItem() {
      throw new Error('storage broken');
    },
    removeItem() {
      throw new Error('storage broken');
    },
  };
}

// Deterministic "randomness": byte i of any request is (i*7+3) % 256,
// regardless of call — lets a test precompute the exact expected bytes for
// a given length without needing real entropy.
function expectedFill(length) {
  return Uint8Array.from({ length }, (_, i) => (i * 7 + 3) % 256);
}

function fakeCrypto() {
  const calls = [];
  return {
    calls,
    getRandomValues(arr) {
      calls.push(arr.length);
      for (let i = 0; i < arr.length; i++) arr[i] = (i * 7 + 3) % 256;
      return arr;
    },
  };
}

function notAllowedError() {
  const err = new Error('The operation was cancelled.');
  err.name = 'NotAllowedError';
  return err;
}

function fixedNow(iso) {
  return () => new Date(iso);
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  it('match the contract exactly', () => {
    assert.equal(LOCK_KEY, 'daily.applock.v1');
    assert.equal(UNLOCKED_KEY, 'daily.applock.unlocked.v1');
    assert.equal(RP_NAME, 'Daily');
  });
});

// ===========================================================================
// L1 — base64url round-trip
// ===========================================================================

describe('L1 — base64url encode/decode', () => {
  it('round-trips arbitrary bytes with no padding and the -_ alphabet', () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, i) => (i * 37 + 5) % 256);
    const encoded = toBase64Url(bytes);
    assert.equal(typeof encoded, 'string');
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.ok(!encoded.includes('='));
    assert.ok(!encoded.includes('+'));
    assert.ok(!encoded.includes('/'));

    const decoded = fromBase64Url(encoded);
    assert.deepEqual(Array.from(decoded), Array.from(bytes));
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', () => {
    const bytes = Uint8Array.from([251, 255, 191, 0, 16, 239]);
    const encoded = toBase64Url(bytes.buffer);
    const decoded = fromBase64Url(encoded);
    assert.deepEqual(Array.from(decoded), Array.from(bytes));
  });

  it('produces - and _ where standard base64 would use + and /', () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0xbf]);
    const std = Buffer.from(bytes).toString('base64');
    assert.ok(/[+/]/.test(std)); // sanity: this input DOES trigger + or / in standard base64
    const encoded = toBase64Url(bytes);
    assert.ok(!encoded.includes('+'));
    assert.ok(!encoded.includes('/'));
  });

  it('fromBase64Url tolerates missing padding at every base64 length class (mod 4 of 0, 2, 3)', () => {
    const cases = [
      Uint8Array.from([9]), // base64 "CQ==" -> unpadded length mod4 = 2
      Uint8Array.from([1, 2]), // base64 "AQI=" -> unpadded length mod4 = 3
      Uint8Array.from([1, 2, 3, 4]), // -> unpadded length mod4 = 3 as well (5,4 bytes give varied classes)
      Uint8Array.from([1, 2, 3]), // base64 "AQID" -> unpadded length mod4 = 0
    ];
    for (const bytes of cases) {
      const encoded = toBase64Url(bytes);
      const decoded = fromBase64Url(encoded);
      assert.deepEqual(Array.from(decoded), Array.from(bytes), `roundtrip failed for [${bytes}]`);
    }
  });

  it('fromBase64Url throws TypeError on non-string input', () => {
    for (const bad of [123, null, undefined, {}, [], true, 1.5]) {
      assert.throws(() => fromBase64Url(bad), TypeError);
    }
  });
});

// ===========================================================================
// L2 — lock storage + unlocked-session helpers
// ===========================================================================

describe('L2 — readLock/writeLock/clearLock/isLockEnabled', () => {
  it('readLock returns null when storage itself is missing', () => {
    assert.equal(readLock(null), null);
    assert.equal(readLock(undefined), null);
  });

  it('readLock returns null for a missing key, malformed JSON, or a missing credentialId', () => {
    assert.equal(readLock(memStorage()), null);
    assert.equal(readLock(memStorage({ [LOCK_KEY]: 'not json' })), null);
    assert.equal(readLock(memStorage({ [LOCK_KEY]: JSON.stringify({ v: 1 }) })), null);
    assert.equal(
      readLock(memStorage({ [LOCK_KEY]: JSON.stringify({ v: 1, enabledAt: '2026-01-01T00:00:00.000Z' }) })),
      null
    );
  });

  it('readLock returns {credentialId, enabledAt} for a well-formed v:1 record', () => {
    const storage = memStorage({
      [LOCK_KEY]: JSON.stringify({ v: 1, credentialId: 'abc123', enabledAt: '2026-01-01T00:00:00.000Z' }),
    });
    assert.deepEqual(readLock(storage), { credentialId: 'abc123', enabledAt: '2026-01-01T00:00:00.000Z' });
  });

  it('readLock never throws on a throwing storage; returns null', () => {
    assert.equal(readLock(throwingStorage()), null);
  });

  it('writeLock stores a v:1 record with the given credentialId/enabledAt', () => {
    const storage = memStorage();
    writeLock(storage, { credentialId: 'xyz', enabledAt: '2026-02-02T00:00:00.000Z' });
    const raw = storage.getItem(LOCK_KEY);
    assert.deepEqual(JSON.parse(raw), { v: 1, credentialId: 'xyz', enabledAt: '2026-02-02T00:00:00.000Z' });
  });

  it('writeLock never throws when storage.setItem throws', () => {
    assert.doesNotThrow(() => writeLock(throwingStorage(), { credentialId: 'x', enabledAt: 'y' }));
  });

  it('clearLock removes the key, and never throws on a throwing or null storage', () => {
    const storage = memStorage({ [LOCK_KEY]: JSON.stringify({ v: 1, credentialId: 'a', enabledAt: 'b' }) });
    clearLock(storage);
    assert.equal(storage.getItem(LOCK_KEY), null);
    assert.doesNotThrow(() => clearLock(throwingStorage()));
    assert.doesNotThrow(() => clearLock(null));
  });

  it('isLockEnabled is false for null/throwing/empty/malformed storage, true for a well-formed lock', () => {
    assert.equal(isLockEnabled(null), false);
    assert.equal(isLockEnabled(throwingStorage()), false);
    assert.equal(isLockEnabled(memStorage()), false);
    assert.equal(isLockEnabled(memStorage({ [LOCK_KEY]: 'garbage' })), false);
    const good = memStorage({ [LOCK_KEY]: JSON.stringify({ v: 1, credentialId: 'a', enabledAt: 'b' }) });
    assert.equal(isLockEnabled(good), true);
  });
});

describe('L2 — isUnlocked/markUnlocked/clearUnlocked', () => {
  it('isUnlocked is true only when session.getItem(UNLOCKED_KEY) === "1"', () => {
    assert.equal(isUnlocked(memStorage({ [UNLOCKED_KEY]: '1' })), true);
    assert.equal(isUnlocked(memStorage({ [UNLOCKED_KEY]: 'true' })), false);
    assert.equal(isUnlocked(memStorage({ [UNLOCKED_KEY]: 1 })), false);
    assert.equal(isUnlocked(memStorage()), false);
    assert.equal(isUnlocked(null), false);
    assert.equal(isUnlocked(throwingStorage()), false);
  });

  it('markUnlocked sets "1", and never throws on a throwing session', () => {
    const session = memStorage();
    markUnlocked(session);
    assert.equal(session.getItem(UNLOCKED_KEY), '1');
    assert.doesNotThrow(() => markUnlocked(throwingStorage()));
    assert.doesNotThrow(() => markUnlocked(null));
  });

  it('clearUnlocked removes the key, and never throws on a throwing or null session', () => {
    const session = memStorage({ [UNLOCKED_KEY]: '1' });
    clearUnlocked(session);
    assert.equal(session.getItem(UNLOCKED_KEY), null);
    assert.doesNotThrow(() => clearUnlocked(throwingStorage()));
    assert.doesNotThrow(() => clearUnlocked(null));
  });
});

// ===========================================================================
// L3 — WebAuthn support detection
// ===========================================================================

describe('L3 — isWebAuthnSupported / isPlatformAuthenticatorAvailable', () => {
  it('true only when nav.credentials.create AND win.PublicKeyCredential both exist', () => {
    const nav = { credentials: { create: () => {}, get: () => {} } };
    const win = { PublicKeyCredential: function () {} };
    assert.equal(isWebAuthnSupported({ nav, win }), true);
  });

  it('false when nav.credentials is missing', () => {
    assert.equal(isWebAuthnSupported({ nav: {}, win: { PublicKeyCredential: function () {} } }), false);
  });

  it('false when nav.credentials.create is not a function', () => {
    const nav = { credentials: {} };
    assert.equal(isWebAuthnSupported({ nav, win: { PublicKeyCredential: function () {} } }), false);
  });

  it('false when win.PublicKeyCredential is missing', () => {
    const nav = { credentials: { create: () => {} } };
    assert.equal(isWebAuthnSupported({ nav, win: {} }), false);
  });

  it('false with no nav/win at all', () => {
    assert.equal(isWebAuthnSupported({}), false);
    assert.equal(isWebAuthnSupported(), false);
  });

  it('isPlatformAuthenticatorAvailable resolves the API\'s own answer (true/false)', async () => {
    const winTrue = { PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => true } };
    const winFalse = { PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => false } };
    assert.equal(await isPlatformAuthenticatorAvailable({ win: winTrue }), true);
    assert.equal(await isPlatformAuthenticatorAvailable({ win: winFalse }), false);
  });

  it('resolves false when the API (or win) is missing entirely', async () => {
    assert.equal(await isPlatformAuthenticatorAvailable({ win: {} }), false);
    assert.equal(await isPlatformAuthenticatorAvailable({}), false);
    assert.equal(await isPlatformAuthenticatorAvailable(), false);
  });

  it('resolves false, never rejects, when the API itself rejects', async () => {
    const win = {
      PublicKeyCredential: {
        isUserVerifyingPlatformAuthenticatorAvailable: async () => {
          throw new Error('boom');
        },
      },
    };
    await assert.doesNotReject(async () => {
      const result = await isPlatformAuthenticatorAvailable({ win });
      assert.equal(result, false);
    });
  });
});

// ===========================================================================
// L4 — enableLock()
// ===========================================================================

describe('L4 — enableLock()', () => {
  function makeNav(createImpl) {
    return {
      credentials: {
        create: createImpl,
        get: async () => {
          throw new Error('get() not used by enableLock');
        },
      },
    };
  }

  it('calls create() with the exact publicKey option shape, and stores base64url(rawId) + ISO enabledAt from now', async () => {
    let captured = null;
    const rawId = Uint8Array.from([10, 20, 30, 40, 50]).buffer;
    const nav = makeNav(async (opts) => {
      captured = opts;
      return { rawId };
    });
    const storage = memStorage();
    const crypto = fakeCrypto();
    const now = fixedNow('2026-09-14T12:00:00.000Z');

    const result = await enableLock({ nav, storage, crypto, rpId: 'example.test', now });

    assert.equal(result, 'enabled');
    assert.ok(captured);
    const pk = captured.publicKey;

    assert.equal(pk.challenge.length, 32);
    assert.deepEqual(Array.from(pk.challenge), Array.from(expectedFill(32)));

    assert.deepEqual(pk.rp, { name: RP_NAME, id: 'example.test' });

    assert.equal(pk.user.name, 'daily');
    assert.equal(pk.user.displayName, 'Daily');
    assert.equal(pk.user.id.length, 16);
    assert.deepEqual(Array.from(pk.user.id), Array.from(expectedFill(16)));

    assert.deepEqual(pk.pubKeyCredParams, [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ]);
    assert.deepEqual(pk.authenticatorSelection, {
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'preferred',
    });
    assert.equal(pk.timeout, 60000);
    assert.equal(pk.attestation, 'none');

    const stored = readLock(storage);
    assert.ok(stored);
    assert.equal(stored.credentialId, toBase64Url(rawId));
    assert.equal(stored.enabledAt, '2026-09-14T12:00:00.000Z');
  });

  it('NotAllowedError from create() -> "cancelled", and nothing is stored', async () => {
    const nav = makeNav(async () => {
      throw notAllowedError();
    });
    const storage = memStorage();
    const result = await enableLock({
      nav,
      storage,
      crypto: fakeCrypto(),
      rpId: 'x',
      now: fixedNow('2026-01-01T00:00:00.000Z'),
    });
    assert.equal(result, 'cancelled');
    assert.equal(readLock(storage), null);
  });

  it('any other create() error -> "error", and nothing is stored', async () => {
    const nav = makeNav(async () => {
      throw new Error('boom');
    });
    const storage = memStorage();
    const result = await enableLock({
      nav,
      storage,
      crypto: fakeCrypto(),
      rpId: 'x',
      now: fixedNow('2026-01-01T00:00:00.000Z'),
    });
    assert.equal(result, 'error');
    assert.equal(readLock(storage), null);
  });

  it('no WebAuthn API -> "unsupported", without touching storage', async () => {
    const storage = memStorage();
    const result = await enableLock({
      nav: {},
      storage,
      crypto: fakeCrypto(),
      rpId: 'x',
      now: fixedNow('2026-01-01T00:00:00.000Z'),
    });
    assert.equal(result, 'unsupported');
    assert.equal(readLock(storage), null);
  });

  it('never rejects, even on an exotic (non-Error) throw from create()', async () => {
    const nav = makeNav(async () => {
      throw 'a bare string throw';
    });
    await assert.doesNotReject(() =>
      enableLock({
        nav,
        storage: memStorage(),
        crypto: fakeCrypto(),
        rpId: 'x',
        now: fixedNow('2026-01-01T00:00:00.000Z'),
      })
    );
  });
});

// ===========================================================================
// L5 — unlock()
// ===========================================================================

describe('L5 — unlock()', () => {
  function makeNav(getImpl) {
    return {
      credentials: {
        create: async () => {
          throw new Error('create() not used by unlock');
        },
        get: getImpl,
      },
    };
  }

  function goodLockStorage(credentialBytes = Uint8Array.from([1, 2, 3, 4])) {
    return memStorage({
      [LOCK_KEY]: JSON.stringify({
        v: 1,
        credentialId: toBase64Url(credentialBytes),
        enabledAt: '2026-01-01T00:00:00.000Z',
      }),
    });
  }

  it('"no-lock" when readLock finds nothing, and never calls get()', async () => {
    let called = false;
    const nav = makeNav(async () => {
      called = true;
      return {};
    });
    const result = await unlock({ nav, storage: memStorage(), session: memStorage(), crypto: fakeCrypto(), rpId: 'x' });
    assert.equal(result, 'no-lock');
    assert.equal(called, false);
  });

  it('calls get() with the exact publicKey option shape (decoded allowCredentials id, userVerification required); marks the session', async () => {
    const credentialBytes = Uint8Array.from([9, 8, 7, 6, 5]);
    const storage = goodLockStorage(credentialBytes);
    let captured = null;
    const nav = makeNav(async (opts) => {
      captured = opts;
      return {};
    });
    const session = memStorage();

    const result = await unlock({ nav, storage, session, crypto: fakeCrypto(), rpId: 'example.test' });

    assert.equal(result, 'unlocked');
    const pk = captured.publicKey;
    assert.equal(pk.challenge.length, 32);
    assert.deepEqual(Array.from(pk.challenge), Array.from(expectedFill(32)));
    assert.equal(pk.rpId, 'example.test');
    assert.equal(pk.userVerification, 'required');
    assert.equal(pk.timeout, 60000);
    assert.equal(pk.allowCredentials.length, 1);
    assert.equal(pk.allowCredentials[0].type, 'public-key');
    assert.deepEqual(Array.from(pk.allowCredentials[0].id), Array.from(credentialBytes));
    assert.deepEqual(pk.allowCredentials[0].transports, ['internal']);

    assert.equal(isUnlocked(session), true);
  });

  it('NotAllowedError from get() -> "cancelled", session not marked', async () => {
    const nav = makeNav(async () => {
      throw notAllowedError();
    });
    const session = memStorage();
    const result = await unlock({ nav, storage: goodLockStorage(), session, crypto: fakeCrypto(), rpId: 'x' });
    assert.equal(result, 'cancelled');
    assert.equal(isUnlocked(session), false);
  });

  it('no WebAuthn API but a lock exists -> "unsupported", session not marked', async () => {
    const session = memStorage();
    const result = await unlock({ nav: {}, storage: goodLockStorage(), session, crypto: fakeCrypto(), rpId: 'x' });
    assert.equal(result, 'unsupported');
    assert.equal(isUnlocked(session), false);
  });

  it('any other get() error -> "error", session not marked', async () => {
    const nav = makeNav(async () => {
      throw new Error('boom');
    });
    const session = memStorage();
    const result = await unlock({ nav, storage: goodLockStorage(), session, crypto: fakeCrypto(), rpId: 'x' });
    assert.equal(result, 'error');
    assert.equal(isUnlocked(session), false);
  });

  it('never rejects, even on an exotic (non-Error) throw from get()', async () => {
    const nav = makeNav(async () => {
      throw 'exotic';
    });
    await assert.doesNotReject(() =>
      unlock({ nav, storage: goodLockStorage(), session: memStorage(), crypto: fakeCrypto(), rpId: 'x' })
    );
  });
});

// ===========================================================================
// L6 — disableLock()
// ===========================================================================

describe('L6 — disableLock()', () => {
  it('clears both the stored lock and the unlocked-session flag', () => {
    const storage = memStorage({ [LOCK_KEY]: JSON.stringify({ v: 1, credentialId: 'a', enabledAt: 'b' }) });
    const session = memStorage({ [UNLOCKED_KEY]: '1' });
    disableLock({ storage, session });
    assert.equal(readLock(storage), null);
    assert.equal(isUnlocked(session), false);
  });

  it('never throws on a throwing storage/session', () => {
    assert.doesNotThrow(() => disableLock({ storage: throwingStorage(), session: throwingStorage() }));
  });
});
