// Integration tests for Step D.7 — RLS hardening (CONTRACT-D.7.md §9, §12.7).
//
// Real PostgREST/RPC calls against the TEST Supabase project only (Step
// D.4's fail-closed target resolver + Step D.7's resolveTestCredentials
// keep this off production; tests/helpers/run-tier.mjs refuses to run this
// tier anywhere else). This is the one integration file that deliberately
// makes requests with the ANON key on purpose — that is the whole point of
// an RLS test — but it never writes with it in a way cleanupTestRows()
// can't undo: every row this file creates is named __test__rls_* and is
// cleaned up in `after`, and the one anon WRITE attempt (case b) is
// expected to be REJECTED by the database, not to succeed.
//
// Every trackable is named __test__rls_<something>; entries have no name of
// their own and cascade-delete with their parent trackable, exactly like
// tests/integration/api.test.mjs.

import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../js/config.js';
import { getAuth } from '../../js/auth.js';
import { upsertEntry, listEntries } from '../../js/api.js';
import {
  ensureSignedIn,
  currentUserId,
  createTestTrackable,
  cleanupTestRows,
  restGet,
} from '../helpers/supabase.mjs';

const NETWORK_TIMEOUT_MS = 15000;
const CLEANUP_TIMEOUT_MS = 30000;

before(ensureSignedIn, { timeout: NETWORK_TIMEOUT_MS });

const created = [];
function track(name) {
  created.push(name);
  return name;
}

after(async () => {
  await cleanupTestRows(created);
}, { timeout: CLEANUP_TIMEOUT_MS });

// --- raw fetch helpers, deliberately bypassing tests/helpers/supabase.mjs's
// standardHeaders() so these requests carry EXACTLY the anon key, nothing
// more — that is the condition under test. ---------------------------------

async function anonFetch(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function signedFetch(path, init = {}) {
  await ensureSignedIn();
  const session = getAuth().getSession();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

describe('D.7 RLS: anon reads are denied on the owner-scoped tables', () => {
  it(
    '(a) anon GET /rest/v1/trackables -> 401 or 403, never 200',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const { status } = await anonFetch('trackables?select=id');
      assert.ok([401, 403].includes(status), `expected 401 or 403, got ${status}`);
      assert.notEqual(status, 200);
    }
  );
});

describe('D.7 RLS: anon writes are denied', () => {
  it(
    '(b) anon POST /rest/v1/trackables -> 401/403, and no such row exists when read back signed in',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const name = track('__test__rls_anon');
      const { status } = await anonFetch('trackables', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ name }),
      });
      assert.ok([401, 403].includes(status), `expected 401 or 403, got ${status}`);

      // Read back SIGNED IN (owner-scoped select), proving the anon POST
      // above did not actually create a row under anyone's ownership.
      const { status: readStatus, body } = await restGet(
        `trackables?name=eq.${encodeURIComponent(name)}&select=id`
      );
      assert.equal(readStatus, 200);
      assert.deepEqual(body, []);
    }
  );
});

describe('D.7 RLS: signed-in writes are owned by the signed-in user', () => {
  it(
    '(c) a trackable created signed-in carries user_id === currentUserId(); so does an entry created through js/api.js',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      await ensureSignedIn();
      const trackable = await createTestTrackable({ name: track('__test__rls_owner') });
      assert.equal(trackable.user_id, currentUserId());

      await upsertEntry({ trackable_id: trackable.id, entry_date: '2026-01-01', value: 1 });
      const entries = await listEntries({ trackableIds: [trackable.id] });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].user_id, currentUserId());
    }
  );
});

describe('D.7 RLS: counter keeps its anon-read keepalive contract', () => {
  it(
    '(d) anon GET /rest/v1/counter -> 200 (the keepalive workflow depends on this)',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const { status, body } = await anonFetch('counter?id=eq.1&select=value');
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
    }
  );

  it(
    '(e) anon PATCH /rest/v1/counter -> 401/403 (the keepalive only ever needs to READ it)',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const { status } = await anonFetch('counter?id=eq.1', {
        method: 'PATCH',
        body: JSON.stringify({ value: 0 }),
      });
      assert.ok([401, 403].includes(status), `expected 401 or 403, got ${status}`);
    }
  );
});

describe('D.7 RLS: daily_resync_identity() is no longer callable by anon', () => {
  it(
    '(f) anon POST /rest/v1/rpc/daily_resync_identity -> 401/403; signed in -> 200',
    { timeout: NETWORK_TIMEOUT_MS },
    async () => {
      const anonResult = await anonFetch('rpc/daily_resync_identity', { method: 'POST', body: '{}' });
      assert.ok([401, 403].includes(anonResult.status), `expected 401 or 403, got ${anonResult.status}`);

      const signedInResult = await signedFetch('rpc/daily_resync_identity', { method: 'POST', body: '{}' });
      assert.equal(signedInResult.status, 200);
    }
  );
});
