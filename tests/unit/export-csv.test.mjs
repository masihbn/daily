// Unit tests for js/export-csv.js (BUILD_PLAN Step 4.2, CSV export).
// Written strictly against CONTRACT-4.2.md §1 and §5 (cases X1-X7); the
// implementation is being written in parallel by another agent and has
// NOT been read while writing this file.
//
// Pure-section tests (X1-X6) import the real module directly. X7 exercises
// the DOM/browser section (deliverCsv) with a fully injected fake
// nav/doc/urlApi/File/Blob harness — no real DOM, no real fetch, no real
// download ever happens here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CSV_HEADER,
  CSV_BOM,
  csvField,
  csvLine,
  slugFor,
  exportFilename,
  exportRows,
  buildCsv,
  deliverCsv,
} from '../../js/export-csv.js';

// ===========================================================================
// X1 — csvField
// ===========================================================================

describe('X1 — csvField', () => {
  it('null/undefined -> empty string', () => {
    assert.equal(csvField(null), '');
    assert.equal(csvField(undefined), '');
  });

  it('a plain number -> String(v), unquoted', () => {
    assert.equal(csvField(12), '12');
    assert.equal(csvField(0), '0');
  });

  it('a boolean -> String(v), unquoted', () => {
    assert.equal(csvField(false), 'false');
    assert.equal(csvField(true), 'true');
  });

  it('a field containing a comma is quoted', () => {
    assert.equal(csvField('a,b'), '"a,b"');
  });

  it('a field containing a double quote is quoted, with the quote doubled', () => {
    assert.equal(csvField('say "hi"'), '"say ""hi"""');
  });

  it('a field containing \\n is quoted', () => {
    assert.equal(csvField('line\nbreak'), '"line\nbreak"');
  });

  it('a field containing \\r is quoted', () => {
    assert.equal(csvField('cr\rlf'), '"cr\rlf"');
  });

  it('plain text with none of , " \\r \\n is left unquoted', () => {
    assert.equal(csvField('plain text'), 'plain text');
  });

  it('never throws on exotic input', () => {
    assert.doesNotThrow(() => csvField({}));
    assert.doesNotThrow(() => csvField([1, 2]));
    assert.doesNotThrow(() => csvField(NaN));
  });
});

// ===========================================================================
// X2 — csvLine
// ===========================================================================

describe('X2 — csvLine', () => {
  it('joins csvField-mapped fields with commas, no line ending', () => {
    assert.equal(csvLine(['a', 'b,c', null, 3]), 'a,"b,c",,3');
  });

  it('an empty array -> empty string', () => {
    assert.equal(csvLine([]), '');
  });

  it('non-array -> empty string', () => {
    assert.equal(csvLine(null), '');
    assert.equal(csvLine(undefined), '');
    assert.equal(csvLine('nope'), '');
    assert.equal(csvLine({}), '');
  });
});

// ===========================================================================
// X3 — slugFor
// ===========================================================================

describe('X3 — slugFor', () => {
  it('the four examples in §1', () => {
    assert.equal(slugFor('Calories', 1), 'calories');
    assert.equal(slugFor('Weight (kg)!', 2), 'weight-kg');
    assert.equal(slugFor('  ', 3), 'trackable-3');
    // A 60-char name — see the dedicated truncation case below for the
    // "no trailing dash after truncation" rule; this one just proves the
    // straightforward all-alphanumeric case truncates to exactly 40.
    assert.equal(slugFor('a'.repeat(60), 4), 'a'.repeat(40));
  });

  it('a 60-char name is truncated to <=40 chars with no trailing "-"', () => {
    // Lower-cased: 39 a's + a run of non-alphanumerics (collapsed to one
    // '-') + 20 b's = 60 chars total. The first 40 characters of the
    // slugged string are exactly the 39 a's plus that one dash — a
    // truncation that would otherwise end on a trailing '-', which must
    // be trimmed off.
    const name = 'A'.repeat(39) + ' ' + 'B'.repeat(20);
    const slug = slugFor(name, 5);
    assert.equal(slug, 'a'.repeat(39));
    assert.ok(!slug.endsWith('-'));
    assert.ok(slug.length <= 40);
  });

  it('unicode letters are dropped (non-alphanumeric -> "-"), runs collapse to one dash', () => {
    // 'é' and '☕' are both non-alphanumeric under the ASCII-only rule
    // this slugger uses; together with the surrounding spaces they form
    // ONE run of non-alphanumeric characters between "caf" and "time".
    assert.equal(slugFor('Café ☕ Time', 6), 'caf-time');
  });

  it('id is String()-d for the empty-name fallback', () => {
    assert.equal(slugFor('', 42), 'trackable-42');
    assert.equal(slugFor(null, 7), 'trackable-7');
  });
});

// ===========================================================================
// X4 — exportFilename
// ===========================================================================

describe('X4 — exportFilename', () => {
  const today = '2026-09-14';

  it('"everything" shape: trackable omitted or null', () => {
    assert.equal(exportFilename({ today }), `daily-export-${today}.csv`);
    assert.equal(exportFilename({ today, trackable: null }), `daily-export-${today}.csv`);
  });

  it('"one" shape: daily-<slug>-<date>.csv', () => {
    const trackable = { id: 5, name: 'Calories' };
    assert.equal(exportFilename({ today, trackable }), `daily-calories-${today}.csv`);
  });

  it('"one" shape reuses slugFor exactly, including the empty-name fallback', () => {
    const trackable = { id: 9, name: '   ' };
    assert.equal(exportFilename({ today, trackable }), `daily-trackable-9-${today}.csv`);
  });
});

// ===========================================================================
// X5 — exportRows
// ===========================================================================

describe('X5 — exportRows', () => {
  const trackables = [
    { id: 2, name: 'B', sort_order: 1, archived: false, unit: 'kg', value_shape: 'numeric' },
    { id: 1, name: 'A', sort_order: 0, archived: false, unit: null, value_shape: 'boolean' },
    { id: 9, name: 'Old', sort_order: 5, archived: true, unit: null, value_shape: 'boolean' },
    { id: 3, name: 'Older', sort_order: 2, archived: true, unit: null, value_shape: 'boolean' },
  ];

  // Trackable 1 has two entries sharing the same entry_date (2026-01-01),
  // deliberately out of id order in the input, to prove the "ties by id
  // ascending" rule — real data can never violate the (trackable_id,
  // entry_date) uniqueness constraint, but exportRows is a pure function
  // over whatever it is handed and its sort must be well-defined anyway.
  const entries = [
    { id: 100, trackable_id: 1, entry_date: '2026-01-02', value: 1, note: null, source: null },
    { id: 103, trackable_id: 1, entry_date: '2026-01-01', value: 1, note: 'later id, same date', source: null },
    { id: 101, trackable_id: 1, entry_date: '2026-01-01', value: 1, note: null, source: null },
    { id: 200, trackable_id: 2, entry_date: '2026-02-01', value: 5, note: 'n', source: 'batch1' },
    { id: 999, trackable_id: 42, entry_date: '2026-01-01', value: 1, note: null, source: null }, // orphan
    { id: 300, trackable_id: 3, entry_date: '2026-03-01', value: 1, note: null, source: null },
    { id: 400, trackable_id: 9, entry_date: '2026-04-01', value: 1, note: null, source: null },
  ];

  it('orders by visibleTrackables (sort_order, id), then archived by id, then entry_date asc with id tie-break; drops orphans; preserves nulls', () => {
    const rows = exportRows({ trackables, entries });

    assert.deepEqual(rows, [
      { trackable_id: 1, trackable: 'A', unit: null, value_shape: 'boolean', entry_date: '2026-01-01', value: 1, note: null, source: null },
      { trackable_id: 1, trackable: 'A', unit: null, value_shape: 'boolean', entry_date: '2026-01-01', value: 1, note: 'later id, same date', source: null },
      { trackable_id: 1, trackable: 'A', unit: null, value_shape: 'boolean', entry_date: '2026-01-02', value: 1, note: null, source: null },
      { trackable_id: 2, trackable: 'B', unit: 'kg', value_shape: 'numeric', entry_date: '2026-02-01', value: 5, note: 'n', source: 'batch1' },
      { trackable_id: 3, trackable: 'Older', unit: null, value_shape: 'boolean', entry_date: '2026-03-01', value: 1, note: null, source: null },
      { trackable_id: 9, trackable: 'Old', unit: null, value_shape: 'boolean', entry_date: '2026-04-01', value: 1, note: null, source: null },
    ]);
  });

  it('non-array inputs -> []', () => {
    assert.deepEqual(exportRows({ trackables: null, entries: null }), []);
    assert.deepEqual(exportRows({ trackables: [], entries: 'nope' }), []);
    assert.deepEqual(exportRows({}), []);
  });

  it('no trackables at all -> every entry is an orphan -> []', () => {
    assert.deepEqual(exportRows({ trackables: [], entries }), []);
  });
});

// ===========================================================================
// X6 — buildCsv
// ===========================================================================

describe('X6 — buildCsv', () => {
  it('starts with the BOM, header exactly CSV_HEADER joined, and empty entries -> BOM + header only', () => {
    const csv = buildCsv({ trackables: [], entries: [] });
    assert.equal(csv, CSV_BOM + CSV_HEADER.join(',') + '\r\n');
  });

  it('every line, including the last, ends with \\r\\n', () => {
    const trackables = [{ id: 1, name: 'A', sort_order: 0, archived: false, unit: null, value_shape: 'boolean' }];
    const entries = [
      { id: 1, trackable_id: 1, entry_date: '2026-01-01', value: 1, note: null, source: null },
      { id: 2, trackable_id: 1, entry_date: '2026-01-02', value: 1, note: null, source: null },
    ];
    const csv = buildCsv({ trackables, entries });
    const lines = csv.split('\r\n');
    // header + 2 data rows + a trailing empty string from the final \r\n.
    assert.equal(lines.length, 4);
    assert.equal(lines[3], '');
    assert.ok(csv.endsWith('\r\n'));
    // No bare \n outside of a \r\n pair (i.e. no note payload here to
    // confuse this check — that is exercised separately below).
    assert.equal(csv.replace(/\r\n/g, '').includes('\n'), false);
  });

  it('a note with a comma AND a quote round-trips exactly per X1 quoting rules', () => {
    const trackables = [{ id: 1, name: 'A', sort_order: 0, archived: false, unit: null, value_shape: 'boolean' }];
    const entries = [
      { id: 1, trackable_id: 1, entry_date: '2026-01-01', value: 1, note: 'a,b "c"', source: null },
    ];
    const csv = buildCsv({ trackables, entries });
    const dataLine = csv.split('\r\n')[1];
    assert.equal(dataLine, '1,A,,boolean,2026-01-01,1,"a,b ""c""",');
  });

  it('the header line is exactly CSV_HEADER joined by commas', () => {
    const csv = buildCsv({ trackables: [], entries: [] });
    const headerLine = csv.slice(CSV_BOM.length).split('\r\n')[0];
    assert.equal(headerLine, CSV_HEADER.join(','));
  });
});

// ===========================================================================
// X7 — deliverCsv (fully injected fake nav/doc/urlApi/File/Blob harness)
// ===========================================================================

function createFakeAnchor(anchors, { throwOnClick = false } = {}) {
  const a = {
    tagName: 'a',
    href: undefined,
    download: undefined,
    rel: undefined,
    clicked: false,
    removed: false,
    appended: false,
    click() {
      this.clicked = true;
      if (throwOnClick) throw new Error('click failed');
    },
    remove() {
      this.removed = true;
    },
  };
  anchors.push(a);
  return a;
}

function createFakeDoc({ throwOnClick = false } = {}) {
  const anchors = [];
  const doc = {
    createElement(tag) {
      return createFakeAnchor(anchors, { throwOnClick });
    },
    body: {
      appendChild(node) {
        node.appended = true;
      },
    },
  };
  doc._anchors = anchors;
  return doc;
}

function createFakeUrlApi({ hasCreateObjectURL = true, throwOnCreate = false } = {}) {
  const calls = { create: [], revoke: [] };
  if (!hasCreateObjectURL) {
    return { _calls: calls };
  }
  return {
    createObjectURL(blob) {
      if (throwOnCreate) throw new Error('createObjectURL failed');
      calls.create.push(blob);
      return 'blob:fake-url';
    },
    revokeObjectURL(url) {
      calls.revoke.push(url);
    },
    _calls: calls,
  };
}

function FakeBlob(parts, opts) {
  this.parts = parts;
  this.type = (opts && opts.type) || '';
}

function FakeFile(parts, name, opts) {
  this.parts = parts;
  this.name = name;
  this.type = (opts && opts.type) || '';
}

function createFakeNav({ hasShareApi = true, canShareResult = true, shareImpl } = {}) {
  if (!hasShareApi) return {};
  const calls = { canShare: [], share: [] };
  return {
    canShare(opts) {
      calls.canShare.push(opts);
      return canShareResult;
    },
    share(opts) {
      calls.share.push(opts);
      return shareImpl ? shareImpl(opts) : Promise.resolve();
    },
    _calls: calls,
  };
}

const FILENAME = 'daily-export-2026-09-14.csv';
const TEXT = CSV_BOM + 'a,b\r\n1,2\r\n';

describe('X7 — deliverCsv', () => {
  it('(a) canShare true + share resolves -> "shared", called with a File named `filename`, type "text/csv"', async () => {
    const nav = createFakeNav({ canShareResult: true });
    const doc = createFakeDoc();
    const urlApi = createFakeUrlApi();

    const outcome = await deliverCsv({
      filename: FILENAME,
      text: TEXT,
      nav,
      doc,
      urlApi,
      FileCtor: FakeFile,
      BlobCtor: FakeBlob,
    });

    assert.equal(outcome, 'shared');
    assert.equal(nav._calls.share.length, 1);
    const shareArg = nav._calls.share[0];
    assert.equal(shareArg.files.length, 1);
    assert.equal(shareArg.files[0].name, FILENAME);
    assert.equal(shareArg.files[0].type, 'text/csv');
    assert.equal(shareArg.title, FILENAME);
    // Never touched the download path.
    assert.equal(urlApi._calls.create.length, 0);
    assert.equal(doc._anchors.length, 0);
  });

  it('(b) share rejects with AbortError -> "cancelled", no download attempted', async () => {
    const nav = createFakeNav({
      canShareResult: true,
      shareImpl: () => Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })),
    });
    const doc = createFakeDoc();
    const urlApi = createFakeUrlApi();

    const outcome = await deliverCsv({
      filename: FILENAME,
      text: TEXT,
      nav,
      doc,
      urlApi,
      FileCtor: FakeFile,
      BlobCtor: FakeBlob,
    });

    assert.equal(outcome, 'cancelled');
    assert.equal(urlApi._calls.create.length, 0);
    assert.equal(doc._anchors.length, 0);
  });

  it('(c) share rejects with a non-AbortError -> falls through to download -> "downloaded"', async () => {
    const nav = createFakeNav({
      canShareResult: true,
      shareImpl: () => Promise.reject(new Error('some other failure')),
    });
    const doc = createFakeDoc();
    const urlApi = createFakeUrlApi();

    const outcome = await deliverCsv({
      filename: FILENAME,
      text: TEXT,
      nav,
      doc,
      urlApi,
      FileCtor: FakeFile,
      BlobCtor: FakeBlob,
    });

    assert.equal(outcome, 'downloaded');
    assert.equal(urlApi._calls.create.length, 1);
    assert.equal(urlApi._calls.revoke.length, 1);
    assert.equal(urlApi._calls.revoke[0], 'blob:fake-url');
    assert.equal(doc._anchors.length, 1);
    assert.equal(doc._anchors[0].download, FILENAME);
    assert.equal(doc._anchors[0].clicked, true);
  });

  it('(d) no canShare (share API entirely absent) -> "downloaded"', async () => {
    const nav = createFakeNav({ hasShareApi: false });
    const doc = createFakeDoc();
    const urlApi = createFakeUrlApi();

    const outcome = await deliverCsv({
      filename: FILENAME,
      text: TEXT,
      nav,
      doc,
      urlApi,
      FileCtor: FakeFile,
      BlobCtor: FakeBlob,
    });

    assert.equal(outcome, 'downloaded');
    assert.equal(urlApi._calls.create.length, 1);
    assert.equal(doc._anchors[0].download, FILENAME);
    assert.equal(doc._anchors[0].clicked, true);
  });

  it('(e) createObjectURL throws -> "fallback" (revoke never called: no url was ever produced)', async () => {
    const nav = createFakeNav({ hasShareApi: false });
    const doc = createFakeDoc();
    const urlApi = createFakeUrlApi({ throwOnCreate: true });

    const outcome = await deliverCsv({
      filename: FILENAME,
      text: TEXT,
      nav,
      doc,
      urlApi,
      FileCtor: FakeFile,
      BlobCtor: FakeBlob,
    });

    assert.equal(outcome, 'fallback');
    assert.equal(urlApi._calls.revoke.length, 0);
  });

  it('(f) anchor.click() throws -> "fallback" AND revokeObjectURL is STILL called', async () => {
    const nav = createFakeNav({ hasShareApi: false });
    const doc = createFakeDoc({ throwOnClick: true });
    const urlApi = createFakeUrlApi();

    const outcome = await deliverCsv({
      filename: FILENAME,
      text: TEXT,
      nav,
      doc,
      urlApi,
      FileCtor: FakeFile,
      BlobCtor: FakeBlob,
    });

    assert.equal(outcome, 'fallback');
    assert.equal(urlApi._calls.create.length, 1);
    assert.equal(urlApi._calls.revoke.length, 1);
    assert.equal(urlApi._calls.revoke[0], 'blob:fake-url');
  });

  it('(g) no urlApi.createObjectURL and no share API -> "fallback"', async () => {
    const nav = createFakeNav({ hasShareApi: false });
    const doc = createFakeDoc();
    const urlApi = createFakeUrlApi({ hasCreateObjectURL: false });

    const outcome = await deliverCsv({
      filename: FILENAME,
      text: TEXT,
      nav,
      doc,
      urlApi,
      FileCtor: FakeFile,
      BlobCtor: FakeBlob,
    });

    assert.equal(outcome, 'fallback');
  });

  it('never rejects, across every scenario above', async () => {
    const scenarios = [
      () => deliverCsv({
        filename: FILENAME,
        text: TEXT,
        nav: createFakeNav({ hasShareApi: false }),
        doc: createFakeDoc({ throwOnClick: true }),
        urlApi: createFakeUrlApi({ throwOnCreate: true }),
        FileCtor: FakeFile,
        BlobCtor: FakeBlob,
      }),
      () => deliverCsv({
        filename: FILENAME,
        text: TEXT,
        nav: createFakeNav({ hasShareApi: false }),
        doc: createFakeDoc(),
        urlApi: createFakeUrlApi({ hasCreateObjectURL: false }),
        FileCtor: FakeFile,
        BlobCtor: FakeBlob,
      }),
    ];
    for (const run of scenarios) {
      await assert.doesNotReject(run);
    }
  });
});
