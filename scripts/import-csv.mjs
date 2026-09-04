// scripts/import-csv.mjs — Step D.5.
//
// One-off, orchestrator-run import of the user's historical CSV exports into
// `entries`. NOT an app feature (a user decision, recorded twice in
// BUILD_PLAN.md): there is no file picker, no settings screen, no iOS upload
// path. The user hands over files; this script transforms and pushes them.
//
// RUN (dry run is the default — nothing is written without --yes)
//   node scripts/import-csv.mjs --file <csv> --kind <kind> --trackable <name> \
//        --target <project-ref> [--collapse <rule>] [--source-tz naive|utc] \
//        [--local-tz <IANA zone>] [--on-collision skip|overwrite] [--yes]
//
//   --kind       nutrition   MyFitnessPal-style summary: one row per MEAL,
//                            plain `Date` column, `Calories` column.
//                strong      Strong app export: one row per SET, `Date` is a
//                            naive timestamp. Collapses to a boolean "worked
//                            out that day" (value 1) with the workout name(s)
//                            in `note`.
//                weight      Smart-scale export: one row per WEIGH-IN, `Time`
//                            is a naive timestamp, `WEIGHT (kg)` column.
//   --collapse   How the rows that land on ONE day combine into the single
//                value the schema allows: sum | average | last | first |
//                max | min. REQUIRED whenever the file has any day with more
//                than one row, because the collapse is lossy and silent —
//                the unique (trackable_id, entry_date) key means it cannot
//                raise. It is deliberately NOT inferred from the trackable's
//                `aggregation` column, which answers a different question
//                (how a RANGE of days rolls up, not how one day's rows
//                combine). Ignored for `strong`, where the value is always 1.
//   --source-tz  naive (default): a timestamp's date part IS the local
//                calendar day, i.e. the exporting app wrote the time the
//                user's clock showed when the row was logged.
//                utc, or an IANA zone (e.g. America/Toronto): the timestamps
//                are RENDERED in that zone and must be converted with
//                --local-tz before the date is taken. The IANA case is what
//                Strong does — it stores instants and renders the export in
//                the phone's CURRENT zone, so a workout done in another
//                country years ago shows the wrong clock time and can show
//                the wrong day. This is THE classic trap: a 00:30 timestamp
//                read in the wrong zone lands on the previous local day.
//   --local-tz   IANA zone the user lived in (where the calendar day is
//                defined). Required unless --source-tz is naive.
//   --local-tz-until <YYYY-MM-DD>=<IANA zone>  an EARLIER era: rows before
//                that date use this zone instead of --local-tz. Repeatable.
//                The dry-run report lists every row the zone choice moves to
//                a different day, so the user can confirm against a day they
//                remember.
//   --on-collision  skip (default): a day that already has an entry is left
//                alone — a row the user typed in the app is more trustworthy
//                than a row from a file. overwrite: the import wins.
//
// Every written row gets `source = 'import:<trackable>-<YYYY-MM-DD>'`, so the
// batch is reversible. The SAFE undo (see migration 0006 and DATA_MODEL.md
// for why the naive `where source = ...` is wrong) is printed after a write:
//
//   delete from public.entries
//   where source = '<batch>' and updated_at < '<batch finish timestamp>';
//
// Credentials: SUPABASE_URL / SUPABASE_KEY from the environment, falling back
// to js/config.js (the anon key — which can write today only because RLS is
// still `using (true)`; after D.7 a service_role key will be needed). The
// target must be named explicitly with --target and must match the URL in
// use; a bulk-write script that defaults to production is a data-loss tool.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPABASE_URL as CONFIG_URL, SUPABASE_ANON_KEY as CONFIG_KEY } from '../js/config.js';
import { projectRefFrom, PAGE_SIZE } from './backup.mjs';
import { chunk, buildUpsertUrl } from './restore.mjs';

export const KINDS = ['nutrition', 'strong', 'weight'];
export const COLLAPSE_RULES = ['sum', 'average', 'last', 'first', 'max', 'min'];
export const COLLISION_POLICIES = ['skip', 'overwrite'];
// --source-tz also accepts any IANA zone; these are the two special values.
export const SOURCE_TZS = ['naive', 'utc'];

// What each kind expects of the trackable it writes to. A numeric import into
// a boolean trackable (or vice versa) would be silently wrong in every chart,
// so it is refused before a row is written.
export const KIND_SHAPE = { nutrition: 'numeric', strong: 'boolean', weight: 'numeric' };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

// --- CSV --------------------------------------------------------------------

// RFC 4180-ish: quoted fields, doubled quotes inside quotes, CRLF or LF, and a
// UTF-8 BOM on the first byte (the scale export has one). Returns arrays of
// strings; no type coercion here.
export function parseCsv(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Header row → array of {column: value} objects. Blank lines are dropped.
export function toRecords(rows) {
  if (!rows.length) return { header: [], records: [] };
  const header = rows[0].map((h) => h.trim());
  const records = [];
  for (const r of rows.slice(1)) {
    if (r.length === 1 && r[0].trim() === '') continue;
    const o = {};
    header.forEach((h, i) => {
      o[h] = r[i] ?? '';
    });
    records.push(o);
  }
  return { header, records };
}

// --- dates ------------------------------------------------------------------

export function isIsoDate(s) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Formats an instant as YYYY-MM-DD in an IANA zone, using Intl rather than
// hand-rolled offsets so DST is handled by the platform.
export function dateInZone(instant, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isValidZone(zone) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Offset (ms) of `zone` at `instant`, via Intl so DST and historical rule
// changes (Iran dropped DST in 2022) come from the platform's tz database.
function zoneOffsetMs(instant, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const g = (t) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  return asUtc - instant.getTime();
}

// A wall-clock time in `zone` → the instant it names. Two passes handle the
// offset changing between the guess and the answer (DST edges).
export function zonedToInstant({ y, mo, d, h, mi, s }, zone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let instant = new Date(guess - zoneOffsetMs(new Date(guess), zone));
  instant = new Date(guess - zoneOffsetMs(instant, zone));
  return instant;
}

// Picks the zone the user was in on a given rendered day: the first era
// whose `until` is after the day wins, else `localTz`. `eras` is
// [{until:'YYYY-MM-DD', zone}] sorted ascending by `until`.
export function zoneFor(day, localTz, eras = []) {
  for (const e of eras) if (day < e.until) return e.zone;
  return localTz;
}

// A "YYYY-MM-DD HH:MM:SS" timestamp → the local calendar day it belongs to.
//   naive:      the date part, verbatim (the app wrote the user's clock time).
//   utc:        interpret as UTC, convert to the user's zone, take the date.
//   IANA zone:  interpret as wall-clock time in THAT zone (the zone the
//               export was rendered in), convert to the user's zone, take
//               the date.
// The user's zone is `localTz`, or an earlier era's zone (see zoneFor).
// Returns null for anything that does not parse.
export function localDayOf(ts, { sourceTz = 'naive', localTz = null, eras = [] } = {}) {
  const m = TS_RE.exec(String(ts).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const day = `${y}-${mo}-${d}`;
  if (!isIsoDate(day)) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec ?? 0) > 59) return null;
  if (sourceTz === 'naive') return day;
  if (!localTz) throw new Error('localDayOf: --local-tz is required unless --source-tz is naive');
  const wall = { y: +y, mo: +mo, d: +d, h: +h, mi: +mi, s: +(sec ?? 0) };
  let instant;
  if (sourceTz === 'utc') instant = new Date(Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s));
  else if (isValidZone(sourceTz)) instant = zonedToInstant(wall, sourceTz);
  else throw new Error(`localDayOf: unknown sourceTz ${JSON.stringify(sourceTz)}`);
  return dateInZone(instant, zoneFor(day, localTz, eras));
}

// --- per-kind extraction ----------------------------------------------------
//
// Each extractor turns records into "observations": {day, value, note?, raw}
// where `day` is the local calendar day and `value` a finite number. Rows it
// cannot read go to `bad` with a reason, never silently dropped.

function finite(s) {
  if (s === undefined || s === null || String(s).trim() === '') return null;
  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

export function extractNutrition(records) {
  const obs = [];
  const bad = [];
  records.forEach((r, i) => {
    const day = String(r.Date ?? '').trim();
    const kcal = finite(r.Calories);
    if (!isIsoDate(day)) bad.push({ line: i + 2, reason: `bad Date ${JSON.stringify(r.Date)}` });
    else if (kcal === null) bad.push({ line: i + 2, reason: `bad Calories ${JSON.stringify(r.Calories)}` });
    else if (kcal < 0) bad.push({ line: i + 2, reason: `negative Calories ${kcal}` });
    else obs.push({ day, value: kcal, label: String(r.Meal ?? '').trim() });
  });
  return { obs, bad };
}

// Strong: one row per set; a session is identified by its start timestamp.
// Output is one observation per SESSION (not per set), value 1, with the
// workout name as the label so the collapse can build a note.
export function extractStrong(records, tzOpts) {
  const bad = [];
  const sessions = new Map();
  records.forEach((r, i) => {
    const ts = String(r.Date ?? '').trim();
    const day = localDayOf(ts, tzOpts);
    if (!day) {
      bad.push({ line: i + 2, reason: `bad Date ${JSON.stringify(r.Date)}` });
      return;
    }
    if (!sessions.has(ts)) {
      sessions.set(ts, {
        day,
        value: 1,
        ts,
        naiveDay: ts.slice(0, 10),
        label: String(r['Workout Name'] ?? '').trim(),
        duration: String(r.Duration ?? '').trim(),
        sets: 0,
      });
    }
    sessions.get(ts).sets += 1;
  });
  return { obs: [...sessions.values()], bad };
}

export function extractWeight(records, tzOpts) {
  const obs = [];
  const bad = [];
  if (!records.length) return { obs, bad };
  const keys = Object.keys(records[0]);
  const timeKey = keys.find((k) => /^time$/i.test(k)) ?? keys[0];
  const weightKey = keys.find((k) => /^weight/i.test(k));
  if (!weightKey) throw new Error(`extractWeight: no WEIGHT column among ${keys.join(', ')}`);
  records.forEach((r, i) => {
    const ts = String(r[timeKey] ?? '').trim();
    const day = localDayOf(ts, tzOpts);
    const kg = finite(r[weightKey]);
    if (!day) bad.push({ line: i + 2, reason: `bad ${timeKey} ${JSON.stringify(r[timeKey])}` });
    else if (kg === null) bad.push({ line: i + 2, reason: `bad ${weightKey} ${JSON.stringify(r[weightKey])}` });
    else if (kg <= 0) bad.push({ line: i + 2, reason: `non-positive weight ${kg}` });
    else obs.push({ day, value: kg, ts, naiveDay: ts.slice(0, 10), label: String(r['Family Members'] ?? '').trim() });
  });
  return { obs, bad };
}

export const EXTRACTORS = { nutrition: extractNutrition, strong: extractStrong, weight: extractWeight };

// --- collapse ---------------------------------------------------------------

export function round1(n) {
  return Math.round(n * 10) / 10;
}

// Combines the values of one day's observations under one rule. `last` and
// `first` follow timestamp order when the observations carry one, else file
// order. Input order is file order.
export function collapseValues(values, rule) {
  if (!Array.isArray(values) || values.length === 0) throw new RangeError('collapseValues: no values');
  if (!COLLAPSE_RULES.includes(rule)) throw new RangeError(`collapseValues: unknown rule ${JSON.stringify(rule)}`);
  switch (rule) {
    case 'sum':
      return round1(values.reduce((a, b) => a + b, 0));
    case 'average':
      return round1(values.reduce((a, b) => a + b, 0) / values.length);
    case 'last':
      return values[values.length - 1];
    case 'first':
      return values[0];
    case 'max':
      return Math.max(...values);
    case 'min':
      return Math.min(...values);
    default:
      throw new RangeError(`collapseValues: unhandled rule ${rule}`);
  }
}

function byTimestampThenFile(a, b) {
  if (a.ts && b.ts && a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.idx - b.idx;
}

// obs → one {entry_date, value, note, from:[obs...]} per day.
// For `strong` the value is always 1 and the note lists the workout names.
export function collapseByDay(obs, kind, rule) {
  const groups = new Map();
  obs.forEach((o, idx) => {
    if (!groups.has(o.day)) groups.set(o.day, []);
    groups.get(o.day).push({ ...o, idx });
  });
  const multi = [...groups.values()].filter((g) => g.length > 1).length;
  if (kind !== 'strong' && multi > 0 && !rule) {
    throw new Error(
      `${multi} day(s) have more than one row; pass --collapse <${COLLAPSE_RULES.join('|')}> ` +
        'to say how they combine. This is not inferred (see the header).'
    );
  }
  const days = [];
  for (const [day, group] of groups) {
    group.sort(byTimestampThenFile);
    let value;
    let note = null;
    if (kind === 'strong') {
      value = 1;
      const names = [...new Set(group.map((g) => g.label).filter(Boolean))];
      note = names.length ? names.join(' + ') : null;
    } else {
      value = group.length === 1 ? group[0].value : collapseValues(group.map((g) => g.value), rule);
    }
    days.push({ entry_date: day, value, note, from: group });
  }
  days.sort((a, b) => (a.entry_date < b.entry_date ? -1 : 1));
  return { days, multiDayCount: multi };
}

// --- collisions -------------------------------------------------------------

// existing: rows already in `entries` for this trackable ({entry_date, value,
// source}). Splits the planned days into those that will be written and
// those that collide, per policy.
export function planWrites(days, existing, policy) {
  if (!COLLISION_POLICIES.includes(policy)) throw new RangeError(`planWrites: unknown policy ${JSON.stringify(policy)}`);
  const byDate = new Map(existing.map((e) => [e.entry_date, e]));
  const collisions = [];
  const writes = [];
  for (const d of days) {
    const hit = byDate.get(d.entry_date);
    if (hit) {
      collisions.push({ ...d, existing: hit });
      if (policy === 'overwrite') writes.push(d);
    } else {
      writes.push(d);
    }
  }
  return { writes, collisions, skipped: policy === 'skip' ? collisions.length : 0 };
}

export function batchId(trackableName, now = new Date()) {
  const slug = String(trackableName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) throw new RangeError('batchId: empty trackable name');
  return `import:${slug}-${now.toISOString().slice(0, 10)}`;
}

export function toEntryRows(writes, trackableId, source) {
  return writes.map((w) => ({
    trackable_id: trackableId,
    entry_date: w.entry_date,
    value: w.value,
    note: w.note ?? null,
    source,
  }));
}

// --- args -------------------------------------------------------------------

export function parseArgs(argv) {
  const out = {
    file: null,
    kind: null,
    trackable: null,
    target: null,
    collapse: null,
    sourceTz: 'naive',
    localTz: null,
    onCollision: 'skip',
    eras: [],
    yes: false,
  };
  const takes = {
    '--file': 'file',
    '--kind': 'kind',
    '--trackable': 'trackable',
    '--target': 'target',
    '--collapse': 'collapse',
    '--source-tz': 'sourceTz',
    '--local-tz': 'localTz',
    '--on-collision': 'onCollision',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--yes') out.yes = true;
    else if (a === '--local-tz-until') {
      const v = argv[i + 1];
      const m = v && /^(\d{4}-\d{2}-\d{2})=(.+)$/.exec(v);
      if (!m || !isIsoDate(m[1])) throw new Error('import: --local-tz-until needs <YYYY-MM-DD>=<IANA zone>');
      out.eras.push({ until: m[1], zone: m[2] });
      i += 1;
    } else if (a in takes) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`import: ${a} needs a value`);
      out[takes[a]] = v;
      i += 1;
    } else throw new Error(`import: unknown argument ${JSON.stringify(a)}`);
  }
  if (!out.file) throw new Error('import: --file <csv> is required');
  if (!KINDS.includes(out.kind)) throw new Error(`import: --kind must be one of ${KINDS.join('|')}`);
  if (!out.trackable) throw new Error('import: --trackable <name> is required');
  if (!out.target) {
    throw new Error(
      'import: --target <project-ref> is required.\n' +
        'A bulk-write script that defaults to production is a data-loss tool; name the project.'
    );
  }
  if (out.collapse !== null && !COLLAPSE_RULES.includes(out.collapse)) {
    throw new Error(`import: --collapse must be one of ${COLLAPSE_RULES.join('|')}`);
  }
  if (!SOURCE_TZS.includes(out.sourceTz) && !isValidZone(out.sourceTz)) {
    throw new Error(`import: --source-tz must be naive, utc, or a valid IANA zone (got ${JSON.stringify(out.sourceTz)})`);
  }
  if (out.sourceTz !== 'naive' && !out.localTz) throw new Error('import: --local-tz <IANA zone> is required unless --source-tz is naive');
  if (out.localTz && !isValidZone(out.localTz)) throw new Error(`import: --local-tz ${JSON.stringify(out.localTz)} is not a valid IANA zone`);
  for (const e of out.eras) {
    if (!isValidZone(e.zone)) throw new Error(`import: --local-tz-until zone ${JSON.stringify(e.zone)} is not a valid IANA zone`);
  }
  out.eras.sort((a, b) => (a.until < b.until ? -1 : a.until > b.until ? 1 : 0));
  if (!COLLISION_POLICIES.includes(out.onCollision)) {
    throw new Error(`import: --on-collision must be one of ${COLLISION_POLICIES.join('|')}`);
  }
  return out;
}

// Refuses to run unless the named target is the project the URL points at.
export function assertTargetMatches(target, baseUrl) {
  const want = projectRefFrom(target) ?? String(target).trim();
  const have = projectRefFrom(baseUrl);
  if (!have) throw new Error(`import: cannot read a project ref from URL ${JSON.stringify(baseUrl)}`);
  if (want !== have) {
    throw new Error(`import: --target is "${want}" but the configured URL points at "${have}". Refusing.`);
  }
  return have;
}

// --- network ----------------------------------------------------------------

function headers(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json', ...extra };
}

async function getJson(url, key, fetchImpl) {
  const res = await fetchImpl(url, { headers: headers(key) });
  if (!res.ok) throw new Error(`import: GET ${url} failed with HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

export async function fetchTrackable(baseUrl, key, name, fetchImpl = globalThis.fetch) {
  const root = baseUrl.replace(/\/+$/, '');
  const rows = await getJson(`${root}/rest/v1/trackables?select=*&name=eq.${encodeURIComponent(name)}`, key, fetchImpl);
  if (rows.length !== 1) {
    throw new Error(`import: expected exactly one trackable named ${JSON.stringify(name)}, found ${rows.length}`);
  }
  return rows[0];
}

export async function fetchExistingEntries(baseUrl, key, trackableId, fetchImpl = globalThis.fetch) {
  const root = baseUrl.replace(/\/+$/, '');
  const all = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url =
      `${root}/rest/v1/entries?select=entry_date,value,note,source&trackable_id=eq.${trackableId}` +
      `&order=entry_date.asc&offset=${offset}&limit=${PAGE_SIZE}`;
    const page = await getJson(url, key, fetchImpl);
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return all;
}

export async function writeEntries(baseUrl, key, rows, policy, fetchImpl = globalThis.fetch) {
  const root = baseUrl.replace(/\/+$/, '');
  // skip: the collisions were already removed from `rows`, so a plain insert
  // is right and a duplicate would be a bug worth a loud 409, not a merge.
  // overwrite: upsert on the natural key.
  const url = policy === 'overwrite' ? buildUpsertUrl(root, 'entries', 'trackable_id,entry_date') : `${root}/rest/v1/entries`;
  const prefer = policy === 'overwrite' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal';
  let written = 0;
  for (const batch of chunk(rows)) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: headers(key, { 'Content-Type': 'application/json', Prefer: prefer }),
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      throw new Error(`import: insert failed with HTTP ${res.status} after ${written} rows: ${await res.text().catch(() => '')}`);
    }
    written += batch.length;
  }
  return written;
}

export async function countBySource(baseUrl, key, source, fetchImpl = globalThis.fetch) {
  const root = baseUrl.replace(/\/+$/, '');
  const res = await fetchImpl(`${root}/rest/v1/entries?select=id&source=eq.${encodeURIComponent(source)}`, {
    headers: headers(key, { Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' }),
  });
  if (!res.ok && res.status !== 206) throw new Error(`import: count failed with HTTP ${res.status}`);
  const cr = res.headers.get('content-range') ?? '';
  const m = /\/(\d+)$/.exec(cr);
  return m ? Number(m[1]) : null;
}

// --- report -----------------------------------------------------------------

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

export function buildReport({ args, file, header, recordCount, bad, obs, days, multiDayCount, plan, trackable, source }) {
  const L = [];
  const values = days.map((d) => d.value);
  L.push(`# Import dry-run report — ${path.basename(file)}`);
  L.push('');
  L.push(`- kind: ${args.kind}   trackable: ${trackable.name} (id ${trackable.id}, ${trackable.value_shape})`);
  L.push(`- batch id (source): ${source}`);
  L.push(`- columns: ${header.length} (${header.slice(0, 4).join(', ')}${header.length > 4 ? ', …' : ''})`);
  L.push(`- data rows: ${recordCount}   readable: ${recordCount - bad.length}   UNPARSEABLE: ${bad.length}`);
  for (const b of bad.slice(0, 10)) L.push(`    line ${b.line}: ${b.reason}`);
  if (bad.length > 10) L.push(`    … and ${bad.length - 10} more`);
  if (args.kind === 'strong') L.push(`- sessions (distinct start timestamps): ${obs.length}`);
  L.push(`- distinct days: ${days.length}   range: ${days[0]?.entry_date ?? '—'} → ${days[days.length - 1]?.entry_date ?? '—'}`);
  L.push(`- days with MORE THAN ONE row: ${multiDayCount}   collapse rule: ${args.kind === 'strong' ? 'n/a (boolean; names joined into note)' : args.collapse ?? '(none needed)'}`);
  const multiSamples = days.filter((d) => d.from.length > 1).slice(0, 6);
  for (const d of multiSamples) {
    const raw = d.from.map((f) => (f.ts ? `${f.ts.slice(11, 16)}=${f.value}${f.label ? ` (${f.label})` : ''}` : `${f.label || '?'}=${f.value}`)).join(', ');
    L.push(`    ${d.entry_date}: [${raw}] → ${d.value}${d.note ? `  note="${d.note}"` : ''}`);
  }
  if (args.kind !== 'strong') {
    L.push(`- value range after collapse: min ${Math.min(...values)}   median ${median(values)}   max ${Math.max(...values)}`);
    const lo = days.filter((d) => d.value < (args.kind === 'weight' ? 60 : 500));
    const hi = days.filter((d) => d.value > (args.kind === 'weight' ? 110 : 5000));
    if (lo.length) L.push(`    suspiciously LOW (${lo.length}): ${lo.slice(0, 8).map((d) => `${d.entry_date}=${d.value}`).join(', ')}`);
    if (hi.length) L.push(`    suspiciously HIGH (${hi.length}): ${hi.slice(0, 8).map((d) => `${d.entry_date}=${d.value}`).join(', ')}`);
  }
  const tzNote =
    args.kind === 'nutrition'
      ? 'file carries plain dates — no timezone assumption needed'
      : args.sourceTz === 'naive'
        ? "ASSUMED: timestamps are the user's clock time when logged; the date part is the calendar day verbatim"
        : `ASSUMED: timestamps are rendered in ${args.sourceTz}, converted to ${args.localTz}` +
          (args.eras.length ? ` (before ${args.eras.map((e) => `${e.until}: ${e.zone}`).join('; before ')})` : '');
  L.push(`- timezone: ${tzNote}`);
  if (args.kind !== 'nutrition') {
    const moved = obs.filter((o) => o.naiveDay && o.naiveDay !== o.day);
    const late = obs.filter((o) => o.ts && (Number(o.ts.slice(11, 13)) < 5 || Number(o.ts.slice(11, 13)) >= 22));
    L.push(`    rows moved to a different day by the timezone choice: ${moved.length}`);
    for (const o of moved.slice(0, 12)) L.push(`      ${o.ts} (as rendered) → ${o.day}${o.label ? `  ${o.label}` : ''}`);
    if (moved.length > 12) L.push(`      … and ${moved.length - 12} more`);
    L.push(`    rows timestamped 22:00–05:00 (the ones a wrong assumption would misplace): ${late.length}`);
    for (const o of late.slice(0, 6)) L.push(`      ${o.ts}${o.label ? `  ${o.label}` : ''}`);
  }
  L.push(`- days that ALREADY have an entry (collisions): ${plan.collisions.length}   policy: ${args.onCollision}`);
  for (const c of plan.collisions.slice(0, 20)) {
    L.push(`    ${c.entry_date}: app has ${c.existing.value}${c.existing.source ? ` [${c.existing.source}]` : ''}, file has ${c.value} → ${args.onCollision === 'skip' ? 'KEEP app value' : 'OVERWRITE with file value'}`);
  }
  if (plan.collisions.length > 20) L.push(`    … and ${plan.collisions.length - 20} more`);
  L.push('');
  L.push(`=> WOULD WRITE ${plan.writes.length} rows (${plan.skipped} skipped as collisions).`);
  return L.join('\n');
}

// --- entry point ------------------------------------------------------------

export async function runImport(args, { fetchImpl = globalThis.fetch, now = new Date(), log = console.log } = {}) {
  const baseUrl = process.env.SUPABASE_URL || CONFIG_URL;
  const key = process.env.SUPABASE_KEY || CONFIG_KEY;
  const targetRef = assertTargetMatches(args.target, baseUrl);

  const text = await readFile(args.file, 'utf8');
  const { header, records } = toRecords(parseCsv(text));
  const tzOpts = { sourceTz: args.sourceTz, localTz: args.localTz, eras: args.eras };
  const { obs, bad } = EXTRACTORS[args.kind](records, tzOpts);
  const { days, multiDayCount } = collapseByDay(obs, args.kind, args.collapse);

  const trackable = await fetchTrackable(baseUrl, key, args.trackable, fetchImpl);
  if (trackable.value_shape !== KIND_SHAPE[args.kind]) {
    throw new Error(
      `import: kind ${args.kind} produces ${KIND_SHAPE[args.kind]} values but trackable ` +
        `${JSON.stringify(trackable.name)} is ${trackable.value_shape}. Refusing.`
    );
  }
  const existing = await fetchExistingEntries(baseUrl, key, trackable.id, fetchImpl);
  const plan = planWrites(days, existing, args.onCollision);
  const source = batchId(trackable.name, now);

  const report = buildReport({ args, file: args.file, header, recordCount: records.length, bad, obs, days, multiDayCount, plan, trackable, source });
  log(`target project: ${targetRef}`);
  log(report);

  if (!args.yes) {
    log('\nDRY RUN — nothing written. Re-run with --yes to write the rows above.');
    return { dryRun: true, plan, report, source };
  }

  const rows = toEntryRows(plan.writes, trackable.id, source);
  const written = await writeEntries(baseUrl, key, rows, args.onCollision, fetchImpl);
  const finishedAt = new Date().toISOString();
  const onServer = await countBySource(baseUrl, key, source, fetchImpl);
  log(`\nWROTE ${written} rows. Server now holds ${onServer} rows with source=${source}.`);
  if (onServer !== rows.length) log(`!! MISMATCH: planned ${rows.length}, server reports ${onServer}. Investigate before trusting this import.`);
  log(`batch finished at ${finishedAt}`);
  log('Safe undo (spares any imported day the user later edits in the app):');
  log(`  delete from public.entries where source = '${source}' and updated_at < '${finishedAt}';`);
  return { dryRun: false, plan, report, source, written, onServer, finishedAt };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runImport(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}
