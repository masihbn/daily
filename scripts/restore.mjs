// scripts/restore.mjs — Step D.3.
//
// Restores a dump written by scripts/backup.mjs.
//
// "An unverified backup is not a backup." This file is the half that makes
// the other half true, and it is the dangerous half: a restore script that
// defaults to production is a data-loss tool. Hence the rules below.
//
// RUN
//   node scripts/restore.mjs --file <dump.json> --target <https://ref.supabase.co> [--yes]
//
//   Without --yes it is a DRY RUN: it reports exactly what it would write and
//   touches nothing.
//
// THREE HARD RULES, each enforced in code rather than by convention:
//
//  1. The target URL must be passed EXPLICITLY on the command line. There is
//     no fallback to js/config.js, unlike backup.mjs, because that fallback
//     points at production. Forgetting an argument must fail, never default.
//  2. Writing requires --yes. The default is a dry run.
//  3. If the dump's project_ref differs from the target's, refuse unless
//     --allow-cross-project is passed. That is the flag to use when seeding
//     the Step D.4 test project from a production dump; it exists so that
//     restoring the WRONG dump into production is a deliberate act.
//
// The credential comes from SUPABASE_KEY in the environment. It is never a
// command-line argument, so it cannot end up in shell history.
//
// Upserts, never deletes: every write is ON CONFLICT DO UPDATE on the row's
// natural key. Running the same restore twice is a no-op. This script issues
// no DELETE of any kind, deliberately — restoring is about putting rows back,
// and a restore that also removed rows "not in the dump" would turn a stale
// dump into a data-loss event.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRefFrom, DUMP_FORMAT } from './backup.mjs';

// Restore order is FK order: a trackable must exist before its entries.
export const RESTORE_PLAN = [
  { table: 'trackables', onConflict: 'id' },
  { table: 'entries', onConflict: 'trackable_id,entry_date' },
  { table: 'app_settings', onConflict: 'id' },
];

export const BATCH_SIZE = 500;

// --- pure helpers (unit-tested) ---------------------------------------------

export function parseArgs(argv) {
  const out = { file: null, target: null, yes: false, allowCrossProject: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file') { out.file = argv[i + 1] ?? null; i += 1; }
    else if (a === '--target') { out.target = argv[i + 1] ?? null; i += 1; }
    else if (a === '--yes') { out.yes = true; }
    else if (a === '--allow-cross-project') { out.allowCrossProject = true; }
    else throw new Error(`restore: unknown argument ${JSON.stringify(a)}`);
  }
  if (!out.file) throw new Error('restore: --file <dump.json> is required');
  if (!out.target) {
    throw new Error(
      'restore: --target <https://<ref>.supabase.co> is required.\n' +
        'There is deliberately NO default — a restore script that defaults to ' +
        'production is a data-loss tool.'
    );
  }
  return out;
}

export function assertDumpShape(dump) {
  if (dump === null || typeof dump !== 'object' || Array.isArray(dump)) {
    throw new Error('restore: dump must be a JSON object');
  }
  if (dump.format !== DUMP_FORMAT) {
    throw new Error(`restore: unsupported dump format ${JSON.stringify(dump.format)}, expected ${DUMP_FORMAT}`);
  }
  if (dump.tables === null || typeof dump.tables !== 'object') {
    throw new Error('restore: dump.tables is missing');
  }
  for (const { table } of RESTORE_PLAN) {
    if (!Array.isArray(dump.tables[table])) {
      throw new Error(`restore: dump.tables.${table} is missing or not an array`);
    }
  }
  return dump;
}

export function assertProjectMatch(dump, targetUrl, allowCrossProject) {
  const dumpRef = dump.project_ref ?? null;
  const targetRef = projectRefFrom(targetUrl);
  if (dumpRef && targetRef && dumpRef !== targetRef && !allowCrossProject) {
    throw new Error(
      `restore: dump came from project "${dumpRef}" but the target is "${targetRef}".\n` +
        'Pass --allow-cross-project if that is genuinely what you want ' +
        '(e.g. seeding the test project from a production dump).'
    );
  }
  return { dumpRef, targetRef, crossProject: Boolean(dumpRef && targetRef && dumpRef !== targetRef) };
}

export function chunk(rows, size = BATCH_SIZE) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError(`chunk: size must be a positive integer, got ${JSON.stringify(size)}`);
  }
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export function buildUpsertUrl(baseUrl, table, onConflict) {
  const root = String(baseUrl).replace(/\/+$/, '');
  return `${root}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`;
}

// --- network ----------------------------------------------------------------

function headers(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  };
}

export async function restoreTable(baseUrl, key, table, onConflict, rows, fetchImpl = globalThis.fetch) {
  let written = 0;
  for (const batch of chunk(rows)) {
    const res = await fetchImpl(buildUpsertUrl(baseUrl, table, onConflict), {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`restore: upsert into ${table} failed with HTTP ${res.status}: ${body}`);
    }
    written += batch.length;
  }
  return written;
}

// Restoring explicit ids does NOT advance the identity sequence, so without
// this the next entry the user logs would reuse an existing id and fail on
// the primary key — a restore that appears to succeed and then breaks the app
// on the next write. Migration 0008 added the function; calling it here means
// no one has to remember. See that migration for the full explanation.
export async function resyncIdentity(baseUrl, key, fetchImpl = globalThis.fetch) {
  const root = String(baseUrl).replace(/\/+$/, '');
  const res = await fetchImpl(`${root}/rest/v1/rpc/daily_resync_identity`, {
    method: 'POST',
    headers: { ...headers(key), Prefer: 'return=representation' },
    body: '{}',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `restore: identity resync failed with HTTP ${res.status}: ${body}\n` +
        'The rows are restored but the id sequences are stale — the next write ' +
        'will collide. Run: select public.daily_resync_identity();'
    );
  }
  return res.json().catch(() => null);
}

// --- entry point ------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = process.env.SUPABASE_KEY;
  if (!key && args.yes) throw new Error('restore: SUPABASE_KEY must be set in the environment to write');

  const dump = assertDumpShape(JSON.parse(await readFile(args.file, 'utf8')));
  const { dumpRef, targetRef, crossProject } = assertProjectMatch(dump, args.target, args.allowCrossProject);

  console.log(`restore: dump taken_at=${dump.taken_at} project=${dumpRef}`);
  console.log(`restore: target=${targetRef}${crossProject ? '  (CROSS-PROJECT, explicitly allowed)' : ''}`);
  for (const { table } of RESTORE_PLAN) {
    console.log(`  ${table}: ${dump.tables[table].length} rows`);
  }

  if (!args.yes) {
    console.log('\nrestore: DRY RUN — nothing was written. Re-run with --yes to apply.');
    return;
  }

  for (const { table, onConflict } of RESTORE_PLAN) {
    const n = await restoreTable(args.target, key, table, onConflict, dump.tables[table]);
    console.log(`restore: upserted ${n} rows into ${table}`);
  }

  const resynced = await resyncIdentity(args.target, key);
  for (const row of resynced ?? []) {
    console.log(`restore: ${row.table_name} identity resynced, next id ${row.next_id}`);
  }
  console.log('restore: done');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
