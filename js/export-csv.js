// CSV export (Step 4.2, CONTRACT-4.2.md). The user's data must be gettable
// out of this app in a form any other tool can read — a lossless, one-
// row-per-entry dump with the trackable's own name and unit on every row
// (not just its id), RFC 4180 quoting, and a UTF-8 BOM so Excel opens
// accented notes correctly.
//
// This file exports two kinds of things, same split as every other module
// with a PURE/DOM divide in this app (see js/views/detail.js's header):
//   1. PURE pieces (CSV_HEADER, CSV_BOM, csvField, csvLine, slugFor,
//      exportFilename, exportRows, buildCsv) — no DOM, no fetch, no
//      localStorage, no `navigator`. Imports only ./dates.js (not actually
//      needed by any pure function here, since `today` always arrives
//      pre-computed from the caller — see exportFilename() — but kept
//      import-free for the same reason: nothing above the divider may
//      touch `document`/`window`/`navigator`, so a separate agent can
//      unit-test this half in Node with no DOM available.
//   2. `deliverCsv(...)`, the one DOM/browser-API export, injectable so it
//      is unit-testable with fakes (CONTRACT-4.2.md §1's X7 table).

// =============================================================================
// PURE EXPORTS — no DOM, no fetch, no localStorage, no `navigator`. Keep it
// that way; a separate agent unit-tests these in Node with no DOM available.
// =============================================================================

export const CSV_HEADER = [
  'trackable_id',
  'trackable',
  'unit',
  'value_shape',
  'entry_date',
  'value',
  'note',
  'source',
];

// U+FEFF BYTE ORDER MARK — written literally (not ﻿ in a comment,
// since some editors mangle that) so Excel detects UTF-8 rather than
// guessing a legacy codepage and mangling an accented note.
export const CSV_BOM = '﻿';

const NEEDS_QUOTE_RE = /[,"\r\n]/;

// RFC 4180: null/undefined -> ''; otherwise String(v); the field is quoted
// (with any embedded '"' doubled) iff it contains a comma, a double quote,
// a CR or an LF. Never throws — String(v) is total for every JS value.
export function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (!NEEDS_QUOTE_RE.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

// One CSV line's worth of already-ordered fields, comma-joined, with NO
// line ending — the caller (buildCsv()) owns line termination, since the
// header row and every data row are terminated the same way. A non-array
// input is not a programmer error worth throwing over (an empty line is a
// harmless, honest answer for "no fields"), so this returns '' instead.
export function csvLine(fields) {
  if (!Array.isArray(fields)) return '';
  return fields.map(csvField).join(',');
}

const SLUG_COLLAPSE_RE = /[^a-z0-9]+/g;
const SLUG_TRIM_RE = /^-+|-+$/g;
const SLUG_MAX_LENGTH = 40;

// A filesystem-safe, human-legible filename fragment. Lower-cases first
// (so 'Weight' and 'weight' collapse to the one slug), then any run of
// characters that isn't a-z0-9 — including whitespace, punctuation, and
// non-ASCII letters, which have no case-folding guarantee across engines
// and are simplest to just treat as "not alphanumeric" — becomes a single
// '-'. Truncated to 40 chars AFTER slugging (matching a person's mental
// model of "the name, shortened", not "some arbitrary byte cut"), with any
// trailing '-' the truncation exposed trimmed off too. An empty result
// (a name that was entirely non-alphanumeric, or missing) falls back to
// `trackable-<id>` so every trackable still gets a distinct, non-empty
// filename. Never throws.
export function slugFor(name, id) {
  const raw = typeof name === 'string' ? name : '';
  let slug = raw.toLowerCase().replace(SLUG_COLLAPSE_RE, '-').replace(SLUG_TRIM_RE, '');
  if (slug.length > SLUG_MAX_LENGTH) {
    slug = slug.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '');
  }
  return slug === '' ? `trackable-${String(id)}` : slug;
}

// `trackable` omitted or null means "the everything export"; otherwise
// `{ name, id }` (a real trackable row works directly — only these two
// fields are read). Never throws for a well-formed `trackable`; a
// malformed one flows into slugFor(), which is itself total.
export function exportFilename({ today, trackable } = {}) {
  if (!trackable) return `daily-export-${today}.csv`;
  return `daily-${slugFor(trackable.name, trackable.id)}-${today}.csv`;
}

function compareIds(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

// Local reimplementation of home-model.js#visibleTrackables' ordering
// (sort_order then id), extended to also place archived rows after every
// visible one, ordered by id. Not imported from home-model.js: this file's
// pure section may import only ./dates.js (CONTRACT-4.2.md §1), and
// duplicating one small, stable comparator is cheaper than widening that
// rule. Array.prototype.sort is stable (ES2019+), so ties preserve input
// order without extra bookkeeping. Never throws.
function orderedTrackables(trackables) {
  const list = Array.isArray(trackables) ? trackables.filter((t) => t && typeof t === 'object') : [];
  const visible = list.filter((t) => t.archived !== true);
  const archived = list.filter((t) => t.archived === true);

  visible.sort((a, b) => {
    const soA = Number.isFinite(a.sort_order) ? a.sort_order : 0;
    const soB = Number.isFinite(b.sort_order) ? b.sort_order : 0;
    if (soA !== soB) return soA - soB;
    return compareIds(a.id, b.id);
  });
  archived.sort((a, b) => compareIds(a.id, b.id));

  return visible.concat(archived);
}

// Joins every entry to its trackable, in export order: trackables in
// orderedTrackables() order above, and within each trackable, entry_date
// ascending (plain string compare — entry_date is always 'YYYY-MM-DD',
// which sorts chronologically as a string), ties broken by the entry's own
// id ascending (a tie can only mean a data anomaly — the schema's unique
// (trackable_id, entry_date) constraint forbids two real rows on the same
// day — so this is defensive determinism, not a real code path). An entry
// whose trackable_id matches no trackable in `trackables` is dropped, not
// invented a placeholder for — `trackables` may include archived rows (the
// caller decides whether to pass them), and passing a filtered list is
// exactly how "export one" gets rows for only that trackable. Every value
// is carried through unchanged, nulls included (csvField() is what turns a
// null into an empty field, not this function). Never throws; a non-array
// `trackables`/`entries` is treated as empty.
export function exportRows({ trackables, entries } = {}) {
  const orderedT = orderedTrackables(trackables);
  const eList = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];

  const rows = [];
  for (const t of orderedT) {
    const idStr = String(t.id);
    const matching = eList.filter((e) => String(e.trackable_id) === idStr);
    matching.sort((a, b) => {
      const ad = typeof a.entry_date === 'string' ? a.entry_date : '';
      const bd = typeof b.entry_date === 'string' ? b.entry_date : '';
      if (ad !== bd) return ad < bd ? -1 : 1;
      return compareIds(a.id, b.id);
    });
    for (const e of matching) {
      rows.push({
        trackable_id: t.id,
        trackable: typeof t.name === 'string' ? t.name : '',
        unit: t.unit,
        value_shape: t.value_shape,
        entry_date: e.entry_date,
        value: e.value,
        note: e.note,
        source: e.source,
      });
    }
  }
  return rows;
}

// The full CSV text: BOM, then the header line, then one line per row from
// exportRows() — every line, including the last, terminated by '\r\n'
// (RFC 4180's line ending, and what keeps Excel from treating the whole
// file as one line on Windows). Never throws (exportRows() isn't either).
export function buildCsv({ trackables, entries } = {}) {
  const rows = exportRows({ trackables, entries });
  const lines = [csvLine(CSV_HEADER)];
  for (const r of rows) {
    lines.push(
      csvLine([r.trackable_id, r.trackable, r.unit, r.value_shape, r.entry_date, r.value, r.note, r.source])
    );
  }
  return CSV_BOM + lines.map((line) => `${line}\r\n`).join('');
}

// =============================================================================
// DOM/browser — the only export in this file that touches `navigator`,
// `document`, `URL`, `File` or `Blob`.
// =============================================================================

// Delivers `text` as a downloadable CSV file named `filename`, trying the
// most reliable path first for a home-screen iOS PWA (Web Share with a
// file — a bare anchor download is known to silently no-op in that
// context) and falling back progressively. Every dependency is injectable
// so this is unit-testable with fakes; the defaults are the real browser
// globals and are only evaluated if the caller omits them (default
// parameter expressions run at CALL time, not at module-import time, so
// importing this file never touches `navigator`/`document` even in Node).
//
// Resolves to one of:
//   'shared'     — the share sheet's own share() promise resolved.
//   'cancelled'  — the user dismissed the share sheet (AbortError). Not a
//                  failure — no fallback follows this.
//   'downloaded' — the anchor-click download path ran without throwing.
//   'fallback'   — neither browser API is usable, or the download path
//                  itself threw; the caller shows the CSV in a textarea.
// NEVER rejects — every code path here ends in one of the four strings.
export async function deliverCsv({
  filename,
  text,
  nav = navigator,
  doc = document,
  urlApi = URL,
  FileCtor = File,
  BlobCtor = Blob,
} = {}) {
  try {
    if (nav && typeof nav.canShare === 'function' && typeof nav.share === 'function') {
      let file = null;
      try {
        file = new FileCtor([text], filename, { type: 'text/csv' });
      } catch {
        file = null;
      }
      if (file && nav.canShare({ files: [file] })) {
        try {
          await nav.share({ files: [file], title: filename });
          return 'shared';
        } catch (err) {
          if (err && err.name === 'AbortError') return 'cancelled';
          // Some browsers claim canShare() then refuse share() itself —
          // fall through to the download path rather than giving up.
        }
      }
    }
  } catch {
    // A canShare()/File-construction hiccup is not fatal — fall through to
    // the download path exactly as above.
  }

  try {
    const blob = new BlobCtor([text], { type: 'text/csv;charset=utf-8' });
    const url = urlApi.createObjectURL(blob);
    try {
      const a = doc.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      doc.body.appendChild(a);
      a.click();
      a.remove();
      return 'downloaded';
    } finally {
      // Always runs, even if a.click() threw above — an object URL that
      // is never revoked leaks for the lifetime of the page.
      urlApi.revokeObjectURL(url);
    }
  } catch {
    return 'fallback';
  }
}
