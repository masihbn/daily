// Thin PostgREST client. This is the ONLY module in the app allowed to
// call fetch() against Supabase — everything else (store.js, and later
// the views) goes through the functions exported here. That keeps the
// error handling, header shape, and (most importantly) the delete-filter
// safety invariant below in exactly one place.
//
// fetch is resolved from globalThis at call time (never captured into a
// module-level const) so tests can stub globalThis.fetch after this
// module has already been imported.
//
// DATA-SAFETY INVARIANT: deleteEntry() is the only function in this
// module that builds a request with method: 'DELETE', and that request
// always carries both a trackable_id=eq. and an entry_date=eq. filter.
// A prior bug in this project's history was a delete whose filter was
// wider than intended — do not add another DELETE call site without
// re-reading that function's comment.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const ID_RE = /^\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// The ONLY keys the app may send for an entry. Anything else throws a
// ValidationError before a request is issued.
//
// `updated_at` is absent because a database trigger owns it (DATA_MODEL.md).
//
// `source` is absent DELIBERATELY, and must stay absent. Migration 0006 added
// entries.source for provenance, with the contract "NULL = logged in the app,
// non-null = the id of the import batch that created the row". The app is the
// NULL case by definition, so it has nothing to say about this column. An
// import is a one-off script run outside the app and does not go through
// api.js at all. Adding `source` here would let a UI bug stamp a batch id onto
// a hand-logged row, or blank one off an imported row — either way corrupting
// the only thing that makes the import reversible.
//
// Related behaviour worth knowing before you touch upsertEntry(): because
// `source` is never in the request body, PostgREST's merge-duplicates upsert
// leaves it UNCHANGED on conflict. Editing an imported day in the app
// therefore keeps its batch id. That is why migration 0006's undo query is
// scoped by `updated_at` as well as by `source` — verified live, 2026-08-25.
const ENTRY_KEYS = ['trackable_id', 'entry_date', 'value', 'note'];

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION';
    this.retryable = false;
  }
}

export class NetworkError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'NetworkError';
    this.code = 'NETWORK';
    this.retryable = true;
    this.cause = cause;
  }
}

export class ApiError extends Error {
  constructor({ status, method, url, body }) {
    const pgMessage = body && typeof body === 'object' ? body.message : null;
    const message = pgMessage
      ? `HTTP ${status}: ${pgMessage}`
      : `HTTP ${status}`;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = (body && typeof body === 'object' && body.code) || null;
    this.details = (body && typeof body === 'object' && body.details) || null;
    this.hint = (body && typeof body === 'object' && body.hint) || null;
    this.body = body;
    this.method = method;
    this.url = url;
    this.retryable = status >= 500 || status === 408 || status === 429;
  }
}

export function isRetryable(err) {
  return !!(err && err.retryable === true);
}

// --- validation helpers -----------------------------------------------

export function assertId(id, label = 'id') {
  if (typeof id === 'number') {
    if (Number.isSafeInteger(id) && id > 0) return String(id);
    throw new ValidationError(`${label} must be a positive integer, got: ${id}`);
  }
  if (typeof id === 'string' && ID_RE.test(id)) {
    return id;
  }
  throw new ValidationError(`${label} must be a positive integer, got: ${JSON.stringify(id)}`);
}

export function assertDate(date, label = 'date') {
  if (typeof date === 'string' && DATE_RE.test(date)) return date;
  throw new ValidationError(`${label} must be a YYYY-MM-DD date string, got: ${JSON.stringify(date)}`);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function assertValidEntry(entry) {
  if (!isPlainObject(entry)) {
    throw new ValidationError(`entry must be a non-null, non-array object, got: ${JSON.stringify(entry)}`);
  }
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.includes(key)) {
      throw new ValidationError(`entry contains a disallowed key: ${key}`);
    }
  }

  assertId(entry.trackable_id, 'trackable_id');

  const out = {};
  // trackable_id is preserved as given (number or digit-string) — only
  // entry_date needs its assertX() return value since we don't otherwise
  // normalize dates.
  out.trackable_id = entry.trackable_id;
  out.entry_date = assertDate(entry.entry_date, 'entry_date');

  if (typeof entry.value !== 'number' || !Number.isFinite(entry.value)) {
    throw new ValidationError(`entry.value must be a finite number, got: ${JSON.stringify(entry.value)}`);
  }
  out.value = entry.value;

  if (Object.prototype.hasOwnProperty.call(entry, 'note')) {
    if (entry.note !== null && typeof entry.note !== 'string') {
      throw new ValidationError(`entry.note must be a string or null, got: ${JSON.stringify(entry.note)}`);
    }
    out.note = entry.note;
  }

  return out;
}

// --- internals -----------------------------------------------------------

function baseHeaders() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    Accept: 'application/json',
  };
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

// Every network call in this module goes through here so error shape and
// fetch resolution stay uniform in exactly one place. Returns the parsed
// body on any 2xx; callers that need the actual status too (e.g. to build
// an EMPTY_RESPONSE/NOT_FOUND ApiError with the real HTTP status) use
// requestWithStatus() below instead.
async function requestWithStatus(method, url, { headers = {}, body } = {}) {
  const fetchFn = globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new NetworkError('globalThis.fetch is not available');
  }

  let res;
  try {
    res = await fetchFn(url, { method, headers, body });
  } catch (cause) {
    throw new NetworkError(`fetch failed for ${method} ${url}: ${cause && cause.message}`, cause);
  }

  const parsed = await parseBody(res);

  if (!res.ok) {
    throw new ApiError({ status: res.status, method, url, body: parsed });
  }

  return { status: res.status, body: parsed };
}

async function request(method, url, opts) {
  const { body } = await requestWithStatus(method, url, opts);
  return body;
}

function requireNonEmptyRow(status, rows, method, url) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ApiError({
      status,
      method,
      url,
      body: { code: 'EMPTY_RESPONSE', message: 'PostgREST returned no rows for a call expecting one' },
    });
  }
  return rows[0];
}

// --- trackables ------------------------------------------------------------

export async function listTrackables({ includeArchived = false } = {}) {
  const params = includeArchived
    ? 'select=*&order=sort_order.asc,id.asc'
    : 'select=*&archived=is.false&order=sort_order.asc,id.asc';
  const url = `${SUPABASE_URL}/rest/v1/trackables?${params}`;
  const rows = await request('GET', url, { headers: baseHeaders() });
  return Array.isArray(rows) ? rows : [];
}

export async function createTrackable(fields) {
  if (!isPlainObject(fields)) {
    throw new ValidationError(`fields must be a non-null, non-array object, got: ${JSON.stringify(fields)}`);
  }
  if (typeof fields.name !== 'string' || fields.name.trim() === '') {
    throw new ValidationError(`fields.name must be a non-empty string, got: ${JSON.stringify(fields.name)}`);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'id')) {
    throw new ValidationError('fields must not contain id');
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'created_at')) {
    throw new ValidationError('fields must not contain created_at');
  }

  const url = `${SUPABASE_URL}/rest/v1/trackables`;
  const { status, body: rows } = await requestWithStatus('POST', url, {
    headers: { ...baseHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ ...fields, name: fields.name.trim() }),
  });
  return requireNonEmptyRow(status, rows, 'POST', url);
}

export async function updateTrackable(id, patch) {
  const idStr = assertId(id);
  if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
    throw new ValidationError(`patch must be a non-null, non-array object with at least one key, got: ${JSON.stringify(patch)}`);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'id')) {
    throw new ValidationError('patch must not contain id');
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'created_at')) {
    throw new ValidationError('patch must not contain created_at');
  }

  const url = `${SUPABASE_URL}/rest/v1/trackables?id=eq.${idStr}`;
  const rows = await request('PATCH', url, {
    headers: { ...baseHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  // PostgREST returns HTTP 200 with an empty array when the filter
  // matches no row (not a 404) — status stays 200 on this ApiError.
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ApiError({
      status: 200,
      method: 'PATCH',
      url,
      body: { code: 'NOT_FOUND', message: `no trackable matched id=${idStr}` },
    });
  }
  return rows[0];
}

export async function archiveTrackable(id) {
  return updateTrackable(id, { archived: true });
}

// --- entries -----------------------------------------------------------

// PostgREST's db-max-rows is 1,000 on this project — a single unfiltered
// GET /rest/v1/entries silently truncates to the first 1,000 rows in
// server order (verified 2026-09-04; see BUILD_PLAN.md Step D.6b). Since
// listEntries() orders by entry_date.asc, an unpaged call would drop the
// MOST RECENT rows once a trackable crosses that count with no error at
// all. listEntries() below pages through offset/limit until a short page
// comes back, mirroring scripts/backup.mjs's fetchAll()/buildPageUrl().
export const ENTRIES_PAGE_SIZE = 1000;

export async function listEntries({ trackableIds, from, to } = {}) {
  const parts = ['select=*'];

  if (trackableIds !== undefined) {
    if (!Array.isArray(trackableIds) || trackableIds.length === 0) {
      throw new ValidationError('trackableIds must be a non-empty array when supplied');
    }
    const ids = trackableIds.map((id) => assertId(id, 'trackableIds[]'));
    parts.push(`trackable_id=in.(${ids.join(',')})`);
  }

  let fromStr;
  let toStr;
  if (from !== undefined) {
    fromStr = assertDate(from, 'from');
  }
  if (to !== undefined) {
    toStr = assertDate(to, 'to');
  }
  if (fromStr !== undefined && toStr !== undefined && !(fromStr <= toStr)) {
    throw new ValidationError(`from (${fromStr}) must be <= to (${toStr})`);
  }
  if (fromStr !== undefined) parts.push(`entry_date=gte.${fromStr}`);
  if (toStr !== undefined) parts.push(`entry_date=lte.${toStr}`);

  parts.push('order=entry_date.asc,trackable_id.asc');

  const base = parts.join('&');

  // Offset paging is only safe under a total order over all rows: this
  // query's order (entry_date, trackable_id) is unique because of the
  // (trackable_id, entry_date) uniqueness constraint on `entries`, so no
  // row can be skipped or duplicated across page boundaries. Every page
  // reissues the exact same filters/order as the first, varying only
  // offset/limit — appended after `order=`, in that order, so a page URL
  // is always `<base>&offset=<n>&limit=1000`.
  const rows = [];
  for (let offset = 0; ; offset += ENTRIES_PAGE_SIZE) {
    const url = `${SUPABASE_URL}/rest/v1/entries?${base}&offset=${offset}&limit=${ENTRIES_PAGE_SIZE}`;
    const page = await request('GET', url, { headers: baseHeaders() });
    const pageRows = Array.isArray(page) ? page : [];
    rows.push(...pageRows);
    // A short page (including empty) means there is no more data. A full
    // page means there may be more, so we always issue one extra request
    // rather than guessing from a count header — same rule as
    // scripts/backup.mjs's fetchAll().
    if (pageRows.length < ENTRIES_PAGE_SIZE) break;
  }
  return rows;
}

export async function upsertEntry(entry) {
  const normalized = assertValidEntry(entry);
  const url = `${SUPABASE_URL}/rest/v1/entries?on_conflict=trackable_id,entry_date`;
  const { status, body: rows } = await requestWithStatus('POST', url, {
    headers: {
      ...baseHeaders(),
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(normalized),
  });
  return requireNonEmptyRow(status, rows, 'POST', url);
}

export async function deleteEntry(trackableId, entryDate) {
  const idStr = assertId(trackableId);
  const dateStr = assertDate(entryDate);

  // DATA-SAFETY INVARIANT (see module header): this is the only DELETE
  // call site in the module, and it must always carry both filters.
  const url = `${SUPABASE_URL}/rest/v1/entries?trackable_id=eq.${idStr}&entry_date=eq.${dateStr}`;
  const rows = await request('DELETE', url, {
    headers: { ...baseHeaders(), Prefer: 'return=representation' },
  });
  // Zero matched rows is a normal, non-error outcome (e.g. deleting an
  // entry that was never logged).
  return Array.isArray(rows) ? rows.length : 0;
}

// --- settings -----------------------------------------------------------

export async function getSettings() {
  const url = `${SUPABASE_URL}/rest/v1/app_settings?select=*&id=eq.1`;
  const rows = await request('GET', url, { headers: baseHeaders() });
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ApiError({
      status: 200,
      method: 'GET',
      url,
      body: { code: 'NOT_FOUND', message: 'app_settings row (id=1) not found' },
    });
  }
  return rows[0];
}

export async function updateSettings(patch) {
  if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
    throw new ValidationError(`patch must be a non-null, non-array object with at least one key, got: ${JSON.stringify(patch)}`);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'id')) {
    throw new ValidationError('patch must not contain id');
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'updated_at')) {
    throw new ValidationError('patch must not contain updated_at');
  }

  const url = `${SUPABASE_URL}/rest/v1/app_settings?id=eq.1`;
  const rows = await request('PATCH', url, {
    headers: { ...baseHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ApiError({
      status: 200,
      method: 'PATCH',
      url,
      body: { code: 'NOT_FOUND', message: 'app_settings row (id=1) not found' },
    });
  }
  return rows[0];
}
