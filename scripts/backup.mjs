// scripts/backup.mjs — Step D.3.
//
// Dumps the whole Supabase dataset to one timestamped JSON file.
//
// WHY THIS EXISTS: the Supabase free tier has no restore button, and the
// app's own CSV export is Step 4.2 (not built). Before this script, there
// was exactly one copy of the user's data and no supported way to get it
// out. From here on there is a second copy that is created without anyone
// remembering to do anything.
//
// RUN
//   node scripts/backup.mjs --out <dir>
//   node scripts/backup.mjs --out <dir> --stdout      (print, write nothing)
//
// Credentials come from SUPABASE_URL / SUPABASE_KEY in the environment, and
// fall back to js/config.js (the anon key) when unset. The fallback is
// deliberate here and NOT a hazard the way it would be for a destructive
// script: this one only ever issues GETs.
//
// >>> AFTER STEP D.7 (RLS hardening), THE ANON KEY WILL STOP BEING ABLE TO
// >>> READ THESE TABLES. Point SUPABASE_KEY at a service_role key then. A
// >>> backup that succeeds while returning zero rows is worse than one that
// >>> fails, so assertNonEmptyDump() below treats an all-empty dump as an
// >>> error rather than writing it.
//
// THE OUTPUT MUST NOT LAND IN THIS REPO. `masihbn/daily` is public because
// free GitHub Pages requires it, and this payload is weight, calorie and
// smoking history. assertOutsideRepo() enforces that rather than trusting
// .gitignore, which only stops `git add`, not a stray `git add -f` or a
// future glob.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPABASE_URL as CONFIG_URL, SUPABASE_ANON_KEY as CONFIG_KEY } from '../js/config.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Order matters on restore: trackables before entries (FK), and both are
// ordered by a stable key so pagination cannot skip or repeat a row.
export const TABLES = [
  { name: 'trackables', order: 'id.asc' },
  { name: 'entries', order: 'id.asc' },
  { name: 'app_settings', order: 'id.asc' },
];

export const PAGE_SIZE = 1000;
export const DUMP_FORMAT = 1;

// --- pure helpers (unit-tested) ---------------------------------------------

// PostgREST caps rows per response, so every table is paged. Ordering by a
// stable unique key is what makes offset paging safe: without `order`, row
// order is unspecified between requests and a page boundary can silently drop
// or duplicate rows.
export function buildPageUrl(baseUrl, table, order, offset, limit) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new TypeError(`buildPageUrl: baseUrl must be a non-empty string, got ${JSON.stringify(baseUrl)}`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(`buildPageUrl: offset must be a non-negative integer, got ${JSON.stringify(offset)}`);
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`buildPageUrl: limit must be a positive integer, got ${JSON.stringify(limit)}`);
  }
  const root = baseUrl.replace(/\/+$/, '');
  return `${root}/rest/v1/${table}?select=*&order=${encodeURIComponent(order)}&offset=${offset}&limit=${limit}`;
}

// Refuses any path inside this repository. See the header for why.
export function assertOutsideRepo(outDir, repoRoot = REPO_ROOT) {
  const resolved = path.resolve(outDir);
  const root = path.resolve(repoRoot);
  const rel = path.relative(root, resolved);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (inside) {
    throw new Error(
      `Refusing to write a backup inside the repository (${resolved}).\n` +
        `This repo is PUBLIC and the dump contains personal health data.\n` +
        `Pass --out with a directory outside ${root}.`
    );
  }
  return resolved;
}

export function dumpFileName(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `daily-backup-${stamp}.json`;
}

// A dump where every table is empty almost certainly means "the credentials
// can no longer read" rather than "the user deleted everything" — the exact
// silent failure Step D.7 introduces if SUPABASE_KEY is not updated. Refuse
// to write it, so the failure is loud.
export function assertNonEmptyDump(dump) {
  const total = TABLES.reduce((n, t) => n + (dump.tables[t.name]?.length ?? 0), 0);
  if (total === 0) {
    throw new Error(
      'Refusing to write an empty backup: every table returned zero rows.\n' +
        'The usual cause is credentials that can no longer read (see the D.7 note ' +
        'in this file), not genuinely empty tables. Verify before overriding.'
    );
  }
  return total;
}

export function projectRefFrom(url) {
  const m = /^https:\/\/([a-z0-9-]+)\.supabase\.co/i.exec(String(url).trim());
  return m ? m[1] : null;
}

export function parseArgs(argv) {
  const out = { outDir: null, stdout: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') {
      out.outDir = argv[i + 1] ?? null;
      i += 1;
    } else if (a === '--stdout') {
      out.stdout = true;
    } else {
      throw new Error(`backup: unknown argument ${JSON.stringify(a)}`);
    }
  }
  if (!out.stdout && !out.outDir) {
    throw new Error('backup: --out <dir> is required (or pass --stdout)');
  }
  return out;
}

// --- network ----------------------------------------------------------------

function headers(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' };
}

export async function fetchAll(baseUrl, key, table, order, fetchImpl = globalThis.fetch) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = buildPageUrl(baseUrl, table, order, offset, PAGE_SIZE);
    const res = await fetchImpl(url, { headers: headers(key) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`backup: GET ${table} failed with HTTP ${res.status}: ${body}`);
    }
    const page = await res.json();
    if (!Array.isArray(page)) {
      throw new Error(`backup: GET ${table} did not return an array`);
    }
    rows.push(...page);
    // A short page means the end. A full page means there may be more, so we
    // always issue one extra request rather than guessing from a count header.
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

export async function buildDump({ baseUrl, key, now = new Date(), fetchImpl } = {}) {
  const tables = {};
  for (const { name, order } of TABLES) {
    tables[name] = await fetchAll(baseUrl, key, name, order, fetchImpl);
  }
  return {
    format: DUMP_FORMAT,
    taken_at: now.toISOString(),
    project_ref: projectRefFrom(baseUrl),
    counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
    tables,
  };
}

// --- entry point ------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.SUPABASE_URL || CONFIG_URL;
  const key = process.env.SUPABASE_KEY || CONFIG_KEY;

  const outDir = args.stdout ? null : assertOutsideRepo(args.outDir);

  const dump = await buildDump({ baseUrl, key });
  const total = assertNonEmptyDump(dump);
  const json = JSON.stringify(dump, null, 2);

  if (args.stdout) {
    process.stdout.write(`${json}\n`);
    return;
  }

  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, dumpFileName());
  await writeFile(file, json, 'utf8');
  console.log(`backup: wrote ${total} rows to ${file}`);
  for (const [t, n] of Object.entries(dump.counts)) console.log(`  ${t}: ${n}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
