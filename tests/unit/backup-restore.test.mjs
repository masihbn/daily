// Step D.3 — unit tests for scripts/backup.mjs and scripts/restore.mjs.
//
// The end-to-end restore was verified against the live database (recorded in
// BUILD_PLAN.md's D.3 Test Subjects). These cover the pure helpers, which is
// where the guards live — and the guards are the point of these scripts:
//
//   - assertOutsideRepo   stops a dump of personal health data being written
//                         into a PUBLIC repo.
//   - assertNonEmptyDump  stops a credentials failure being silently written
//                         as a "successful" empty backup.
//   - parseArgs (restore) stops a restore defaulting at production.
//   - assertProjectMatch  stops the wrong dump going into the wrong project.
//
// Every one of those is a data-loss or data-exposure guard, so each is tested
// from both sides: it must reject the bad case AND accept the good one. A
// guard that rejects everything passes a one-sided test and breaks the tool.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  buildPageUrl,
  assertOutsideRepo,
  assertNonEmptyDump,
  projectRefFrom,
  dumpFileName,
  fetchAll,
  buildDump,
  parseArgs as backupParseArgs,
  PAGE_SIZE,
  REPO_ROOT,
} from '../../scripts/backup.mjs';

import {
  parseArgs as restoreParseArgs,
  assertDumpShape,
  assertProjectMatch,
  chunk,
  buildUpsertUrl,
  RESTORE_PLAN,
} from '../../scripts/restore.mjs';

const PROJECT = 'https://okwzgmvnsdlheuolcthn.supabase.co';

function jsonResponse(rows) {
  return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
}

describe('D.3 backup: buildPageUrl', () => {
  it('builds a paged, ordered select', () => {
    const url = buildPageUrl(PROJECT, 'entries', 'id.asc', 0, 1000);
    assert.equal(url, `${PROJECT}/rest/v1/entries?select=*&order=id.asc&offset=0&limit=1000`);
  });

  it('strips a trailing slash rather than producing a double slash', () => {
    assert.match(buildPageUrl(`${PROJECT}/`, 'entries', 'id.asc', 0, 10), /\.co\/rest\/v1\/entries/);
  });

  it('URL-encodes the order clause', () => {
    assert.match(buildPageUrl(PROJECT, 'e', 'entry_date.asc,id.asc', 0, 10), /order=entry_date\.asc%2Cid\.asc/);
  });

  it('rejects a negative or non-integer offset and a non-positive limit', () => {
    assert.throws(() => buildPageUrl(PROJECT, 'e', 'id.asc', -1, 10), RangeError);
    assert.throws(() => buildPageUrl(PROJECT, 'e', 'id.asc', 1.5, 10), RangeError);
    assert.throws(() => buildPageUrl(PROJECT, 'e', 'id.asc', 0, 0), RangeError);
    assert.throws(() => buildPageUrl(PROJECT, 'e', 'id.asc', 0, -5), RangeError);
    assert.throws(() => buildPageUrl('', 'e', 'id.asc', 0, 10), TypeError);
  });
});

describe('D.3 backup: assertOutsideRepo — the public-repo guard', () => {
  it('refuses the repo root, a subdirectory, and a deeply nested path', () => {
    for (const p of [REPO_ROOT, path.join(REPO_ROOT, 'backups'), path.join(REPO_ROOT, 'a', 'b', 'c')]) {
      assert.throws(() => assertOutsideRepo(p), /Refusing to write a backup inside the repository/, `should refuse ${p}`);
    }
  });

  it('refuses a path that only escapes and comes back (../<repo>/x)', () => {
    // The naive implementation of this guard is a string prefix check, which
    // this case defeats. path.relative() is used precisely so it does not.
    const sneaky = path.join(REPO_ROOT, '..', path.basename(REPO_ROOT), 'backups');
    assert.throws(() => assertOutsideRepo(sneaky), /Refusing to write a backup/);
  });

  it('ACCEPTS a directory outside the repo, and returns it resolved', () => {
    const outside = path.join(REPO_ROOT, '..', 'Daily-backups');
    const got = assertOutsideRepo(outside);
    assert.equal(got, path.resolve(outside));
  });

  it('is not fooled by a sibling whose name starts with the repo name', () => {
    // "<repo>-backups" shares a string prefix with "<repo>" but is NOT inside
    // it. A prefix-based guard would wrongly refuse this and the tool would be
    // unusable at exactly the path a user would naturally pick.
    const sibling = `${REPO_ROOT}-backups`;
    assert.equal(assertOutsideRepo(sibling), path.resolve(sibling));
  });
});

describe('D.3 backup: assertNonEmptyDump — the silent-credentials-failure guard', () => {
  const empty = { tables: { trackables: [], entries: [], app_settings: [] } };

  it('refuses a dump where every table is empty', () => {
    assert.throws(() => assertNonEmptyDump(empty), /Refusing to write an empty backup/);
  });

  it('accepts a dump with any rows at all, returning the total', () => {
    assert.equal(assertNonEmptyDump({ tables: { trackables: [1, 2], entries: [], app_settings: [1] } }), 3);
  });

  it('treats a missing table as zero rather than throwing a TypeError', () => {
    assert.throws(() => assertNonEmptyDump({ tables: {} }), /Refusing to write an empty backup/);
  });
});

describe('D.3 backup: misc helpers', () => {
  it('projectRefFrom extracts the ref, and returns null for a non-Supabase URL', () => {
    assert.equal(projectRefFrom(PROJECT), 'okwzgmvnsdlheuolcthn');
    assert.equal(projectRefFrom('https://example.com'), null);
    assert.equal(projectRefFrom(''), null);
  });

  it('dumpFileName is filesystem-safe (no colons — Windows rejects them)', () => {
    const name = dumpFileName(new Date('2026-08-25T14:00:25.390Z'));
    assert.equal(name, 'daily-backup-2026-08-25T14-00-25-390Z.json');
    assert.ok(!name.includes(':'));
  });

  it('parseArgs requires --out unless --stdout is given', () => {
    assert.throws(() => backupParseArgs([]), /--out <dir> is required/);
    assert.deepEqual(backupParseArgs(['--stdout']), { outDir: null, stdout: true });
    assert.deepEqual(backupParseArgs(['--out', 'x']), { outDir: 'x', stdout: false });
    assert.throws(() => backupParseArgs(['--nope']), /unknown argument/);
  });
});

describe('D.3 backup: pagination', () => {
  it('keeps paging while pages are full and stops on a short page', async () => {
    // The bug this guards: stopping after the first page silently truncates
    // the backup, and the dump still looks valid. With three months of daily
    // logging across four trackables this is reachable, not theoretical.
    const urls = [];
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i }));
    const fetchImpl = async (url) => {
      urls.push(url);
      return jsonResponse(urls.length === 1 ? full : [{ id: 9999 }]);
    };
    const rows = await fetchAll(PROJECT, 'k', 'entries', 'id.asc', fetchImpl);
    assert.equal(rows.length, PAGE_SIZE + 1);
    assert.equal(urls.length, 2);
    assert.match(urls[1], new RegExp(`offset=${PAGE_SIZE}`));
  });

  it('issues exactly one request when the first page is short', async () => {
    let n = 0;
    const fetchImpl = async () => { n += 1; return jsonResponse([{ id: 1 }]); };
    const rows = await fetchAll(PROJECT, 'k', 'entries', 'id.asc', fetchImpl);
    assert.equal(rows.length, 1);
    assert.equal(n, 1);
  });

  it('throws with the status and body on a non-2xx rather than dumping partial data', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'no', json: async () => ({}) });
    await assert.rejects(() => fetchAll(PROJECT, 'k', 'entries', 'id.asc', fetchImpl), /HTTP 401/);
  });

  it('buildDump records format, counts and project_ref', async () => {
    const fetchImpl = async (url) => jsonResponse(url.includes('trackables') ? [{ id: 1 }] : []);
    const dump = await buildDump({ baseUrl: PROJECT, key: 'k', now: new Date('2026-08-25T00:00:00Z'), fetchImpl });
    assert.equal(dump.format, 1);
    assert.equal(dump.project_ref, 'okwzgmvnsdlheuolcthn');
    assert.deepEqual(dump.counts, { trackables: 1, entries: 0, app_settings: 0 });
  });
});

describe('D.3 restore: parseArgs — no default target, ever', () => {
  it('refuses to run without --target, and says why', () => {
    assert.throws(
      () => restoreParseArgs(['--file', 'd.json']),
      /--target .* is required[\s\S]*data-loss tool/
    );
  });

  it('refuses to run without --file', () => {
    assert.throws(() => restoreParseArgs(['--target', PROJECT]), /--file <dump.json> is required/);
  });

  it('defaults to a DRY RUN — writing requires --yes', () => {
    assert.equal(restoreParseArgs(['--file', 'd.json', '--target', PROJECT]).yes, false);
    assert.equal(restoreParseArgs(['--file', 'd.json', '--target', PROJECT, '--yes']).yes, true);
  });
});

describe('D.3 restore: assertDumpShape', () => {
  const good = { format: 1, tables: { trackables: [], entries: [], app_settings: [] } };

  it('accepts a well-formed dump', () => {
    assert.equal(assertDumpShape(good), good);
  });

  it('rejects a wrong or missing format version', () => {
    assert.throws(() => assertDumpShape({ ...good, format: 2 }), /unsupported dump format/);
    assert.throws(() => assertDumpShape({ tables: good.tables }), /unsupported dump format/);
  });

  it('rejects a dump missing any required table, naming the table', () => {
    for (const { table } of RESTORE_PLAN) {
      const broken = { format: 1, tables: { ...good.tables } };
      delete broken.tables[table];
      assert.throws(() => assertDumpShape(broken), new RegExp(`dump.tables.${table} is missing`));
    }
  });

  it('rejects non-objects and arrays', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      assert.throws(() => assertDumpShape(bad), /dump must be a JSON object|unsupported dump format/);
    }
  });
});

describe('D.3 restore: assertProjectMatch — wrong-dump-wrong-project guard', () => {
  it('allows a same-project restore', () => {
    const r = assertProjectMatch({ project_ref: 'abc' }, 'https://abc.supabase.co', false);
    assert.equal(r.crossProject, false);
  });

  it('REFUSES a cross-project restore by default, naming both projects', () => {
    assert.throws(
      () => assertProjectMatch({ project_ref: 'abc' }, 'https://xyz.supabase.co', false),
      /dump came from project "abc" but the target is "xyz"/
    );
  });

  it('allows it with --allow-cross-project, and reports that it is cross-project', () => {
    const r = assertProjectMatch({ project_ref: 'abc' }, 'https://xyz.supabase.co', true);
    assert.equal(r.crossProject, true);
  });
});

describe('D.3 restore: batching and URLs', () => {
  it('chunk splits evenly and handles an exact multiple and an empty list', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
    assert.deepEqual(chunk([], 2), []);
    assert.throws(() => chunk([1], 0), RangeError);
  });

  it('buildUpsertUrl encodes a composite on_conflict', () => {
    assert.equal(
      buildUpsertUrl(PROJECT, 'entries', 'trackable_id,entry_date'),
      `${PROJECT}/rest/v1/entries?on_conflict=trackable_id%2Centry_date`
    );
  });

  it('restores trackables BEFORE entries — entries carry an FK to trackables', () => {
    const order = RESTORE_PLAN.map((p) => p.table);
    assert.ok(
      order.indexOf('trackables') < order.indexOf('entries'),
      'restoring entries first would fail the foreign key on a fresh database'
    );
  });
});
