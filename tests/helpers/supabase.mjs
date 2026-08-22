// Test-only Supabase helper. Talks to the LIVE project via raw fetch
// (PostgREST) — there is no local/staging Supabase for this app.
//
// HARD SAFETY RULE: every destructive request (DELETE/PATCH) MUST be
// constrained to rows whose name starts with '__test__'. The ONLY
// destructive URL this module ever builds is buildDeleteByNameUrl(),
// which routes through assertTestName() and produces an exact-match
// `name=eq.<...>` filter. There must be no code path that can issue an
// unfiltered, or wildcard-filtered, destructive request against this
// database.
//
// IMPORTANT — no SQL wildcard patterns, ever: an earlier version of the
// sweep built a PostgREST `name=like.__test__*` filter to find stale
// test rows. That is a trap: PostgREST translates `*` to `%` and hands
// the rest straight to SQL LIKE, where `_` is ALSO a wildcard (matches
// any single character). So `__test__%` does not mean "starts with
// __test__" — it means "any 2 chars, then the literal `test`, then any
// 2 chars, then anything", which matches ordinary user rows like
// `mytestrun` or `AAtestBB` and would delete real data.
//
// The fix is to never let SQL wildcard semantics decide what counts as
// a test row. sweepStaleTestRows() instead does a plain, unfiltered
// SELECT of id+name (buildSweepListUrl(), read-only, no name param at
// all) and filters the results in JS with isTestName() — the same
// predicate the unit tests exhaustively exercise against hostile
// inputs. Only names that pass isTestName() are ever handed to
// deleteTestTrackablesByName(), which re-derives the exact-match delete
// URL and re-checks assertTestName() itself. Do not "optimize" this
// back into a single clever LIKE/wildcard query — that is exactly the
// bug this file exists to avoid.
//
// Credentials come only from js/config.js — do not hardcode them here.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../js/config.js';

export const TEST_PREFIX = '__test__';

export function isTestName(name) {
  return typeof name === 'string' && name.startsWith(TEST_PREFIX);
}

export function assertTestName(name) {
  if (!isTestName(name)) {
    throw new Error(
      `Refusing to operate on a name that is not a ${TEST_PREFIX} name: ${String(name)}`
    );
  }
}

export function buildSweepListUrl() {
  // Read-only GET, intentionally with NO name filter — filtering happens
  // in JS via isTestName(), never in SQL. See the file header comment.
  return `${SUPABASE_URL}/rest/v1/trackables?select=id,name`;
}

export function buildDeleteByNameUrl(name) {
  assertTestName(name);
  return `${SUPABASE_URL}/rest/v1/trackables?name=eq.${encodeURIComponent(name)}`;
}

function standardHeaders() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function parseBody(res) {
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { text, json };
}

function isTableMissing(status, json) {
  if (status === 404) return true;
  if (json && typeof json === 'object' && (json.code === 'PGRST205' || json.code === '42P01')) {
    return true;
  }
  return false;
}

function throwHttpError(status, text, json) {
  const err = new Error(`Supabase request failed: HTTP ${status} — ${text}`);
  err.status = status;
  err.body = json;
  throw err;
}

export async function createTestTrackable(fields = {}) {
  const name =
    fields.name ??
    `__test__auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  assertTestName(name);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/trackables`, {
    method: 'POST',
    headers: { ...standardHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify({ ...fields, name }),
  });
  const { text, json } = await parseBody(res);

  if (!res.ok) {
    if (isTableMissing(res.status, json)) {
      const err = new Error(
        `trackables table does not exist yet: HTTP ${res.status} — ${text}`
      );
      err.code = 'TABLE_MISSING';
      err.status = res.status;
      err.body = json;
      throw err;
    }
    throwHttpError(res.status, text, json);
  }

  const rows = json;
  return rows[0];
}

export async function deleteTestTrackablesByName(name) {
  assertTestName(name);
  const url = buildDeleteByNameUrl(name);

  const res = await fetch(url, {
    method: 'DELETE',
    headers: { ...standardHeaders(), Prefer: 'return=representation' },
  });
  const { text, json } = await parseBody(res);

  if (!res.ok) {
    if (isTableMissing(res.status, json)) return 0;
    throwHttpError(res.status, text, json);
  }

  const rows = json;
  return Array.isArray(rows) ? rows.length : 0;
}

export async function cleanupTestRows(names) {
  const list = Array.isArray(names) ? names : [names];

  // Validate every name BEFORE issuing any delete — a bad name anywhere
  // in the list must abort the whole call having deleted nothing.
  for (const name of list) {
    assertTestName(name);
  }

  let total = 0;
  for (const name of list) {
    total += await deleteTestTrackablesByName(name);
  }
  return total;
}

export async function sweepStaleTestRows() {
  const url = buildSweepListUrl();

  const res = await fetch(url, {
    method: 'GET',
    headers: standardHeaders(),
  });
  const { text, json } = await parseBody(res);

  if (!res.ok) {
    if (isTableMissing(res.status, json)) return 0;
    throwHttpError(res.status, text, json);
  }

  const rows = Array.isArray(json) ? json : [];
  const staleNames = new Set(
    rows.filter((r) => isTestName(r && r.name)).map((r) => r.name)
  );

  let total = 0;
  for (const name of staleNames) {
    total += await deleteTestTrackablesByName(name);
  }
  return total;
}

export async function restGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: standardHeaders(),
  });
  const { json } = await parseBody(res);
  return { status: res.status, body: json };
}
