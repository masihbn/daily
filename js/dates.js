// Local-calendar-date math. PURE MODULE: no DOM, no fetch, no localStorage,
// no imports from api.js/store.js/config.js. That purity is what makes this
// testable in Node across arbitrary timezones, which is the whole point —
// see the trap below.
//
// THE DATE TRAP: entries are keyed by local calendar date, not a UTC
// instant. A user logging at 11pm local must land on "today", not
// "tomorrow". That means:
//   - never build "today" via new Date().toISOString().slice(0,10) — that
//     reads UTC and is wrong for part of every day in any non-UTC zone.
//   - never parse 'YYYY-MM-DD' via new Date(str) — the spec parses bare
//     date-only strings as UTC midnight, which shifts the day backward in
//     negative-offset zones.
//   - day arithmetic must use calendar-component arithmetic
//     (new Date(y, m-1, d+n), or Date#setFullYear(y, m, d+n)), never
//     n * 86400000 milliseconds — that breaks across DST transitions.
// Internally, ISO-week math below deliberately routes through Date.UTC()
// because that arithmetic is DST-free — what's forbidden is letting
// *input parsing* or *output formatting* go through UTC, since that's what
// shifts the calendar day.

const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateObject(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

// Builds a Date from explicit y/m/d components without going through the
// Date constructor's legacy two-digit-year quirk (new Date(0..99, ...)
// silently remaps to 1900-1999). Date#setFullYear does not have that
// quirk, so we seed an arbitrary valid date and overwrite every field.
function fromComponents(y, monthIndex, day) {
  const d = new Date(2000, 0, 1);
  d.setFullYear(y, monthIndex, day);
  return d;
}

export function formatLocal(date) {
  if (!isValidDateObject(date)) {
    throw new RangeError(`formatLocal: expected a valid Date, got: ${JSON.stringify(date)}`);
  }
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayLocal(now = new Date()) {
  return formatLocal(now);
}

export function parseLocal(str) {
  if (typeof str !== 'string' || !DATE_STR_RE.test(str)) {
    throw new RangeError(`parseLocal: expected a 'YYYY-MM-DD' string, got: ${JSON.stringify(str)}`);
  }
  const [yStr, mStr, dStr] = str.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const date = fromComponents(y, m - 1, d);
  // new Date(...) quietly rolls invalid components over into the next
  // month (e.g. Feb 30 -> Mar 2) instead of failing. Reject anything that
  // didn't round-trip rather than silently accepting a rolled-over date.
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    throw new RangeError(`parseLocal: '${str}' is not a valid calendar date`);
  }
  return date;
}

// Accepts either a Date or a 'YYYY-MM-DD' string (the "date-like" contract
// shared by most functions below) and returns a valid local Date.
function toDate(dateLike, label = 'date') {
  if (dateLike instanceof Date) {
    if (!isValidDateObject(dateLike)) {
      throw new RangeError(`${label}: expected a valid Date, got an invalid Date`);
    }
    return dateLike;
  }
  if (typeof dateLike === 'string') {
    return parseLocal(dateLike);
  }
  throw new RangeError(`${label}: expected a Date or 'YYYY-MM-DD' string, got: ${JSON.stringify(dateLike)}`);
}

export function addDays(date, n) {
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`addDays: n must be a safe integer, got: ${JSON.stringify(n)}`);
  }
  const d = toDate(date, 'addDays');
  // Handing an out-of-range day straight to setFullYear is exactly the
  // calendar-component arithmetic the date trap calls for: JS resolves
  // day-of-month overflow/underflow by rolling the month/year forward or
  // backward, with no real-elapsed-time math involved, so this is DST-safe.
  const result = fromComponents(d.getFullYear(), d.getMonth(), d.getDate() + n);
  return formatLocal(result);
}

// Standard ISO-8601 week algorithm: find the Thursday of the same week
// (Monday-start), then that Thursday's calendar year is the ISO week year,
// and the week number counts Thursdays (equivalently, Monday-aligned
// 7-day spans) from the first Thursday of that year. Done in Date.UTC so
// the arithmetic has no DST to worry about — only the initial read of the
// input's local y/m/d (via toDate) and this function's own output
// (a plain string, no formatting through UTC) touch "local" at all.
export function isoWeekKey(date) {
  const d = toDate(date, 'isoWeekKey');
  const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const isoDow = (utc.getUTCDay() + 6) % 7; // Monday=0 .. Sunday=6
  utc.setUTCDate(utc.getUTCDate() - isoDow + 3); // move to this week's Thursday
  const isoYear = utc.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4.getTime());
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow);
  const weekNum = Math.round((utc.getTime() - week1Monday.getTime()) / (7 * 86400000)) + 1;
  return `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
}

export function startOfIsoWeek(date) {
  const d = toDate(date, 'startOfIsoWeek');
  const isoDow = (d.getDay() + 6) % 7; // Monday=0 .. Sunday=6, in LOCAL time
  return addDays(d, -isoDow);
}

export function isoWeeksInRange(from, to) {
  const fromDate = toDate(from, 'from');
  const toDateVal = toDate(to, 'to');
  const fromStr = formatLocal(fromDate);
  const toStr = formatLocal(toDateVal);
  if (fromStr > toStr) {
    throw new RangeError(`isoWeeksInRange: from (${fromStr}) must be <= to (${toStr})`);
  }
  const lastWeekStart = startOfIsoWeek(toDateVal);
  const weeks = [];
  let cursor = startOfIsoWeek(fromDate);
  // 'YYYY-MM-DD' strings compare lexicographically in chronological order,
  // so plain string comparison is safe here.
  while (cursor <= lastWeekStart) {
    weeks.push(isoWeekKey(cursor));
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

export function rangeDays(from, to) {
  const fromDate = toDate(from, 'from');
  const toDateVal = toDate(to, 'to');
  const fromStr = formatLocal(fromDate);
  const toStr = formatLocal(toDateVal);
  if (fromStr > toStr) {
    throw new RangeError(`rangeDays: from (${fromStr}) must be <= to (${toStr})`);
  }
  const days = [];
  let cursor = fromStr;
  while (cursor <= toStr) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

export function monthGrid(year, month) {
  if (!Number.isInteger(year)) {
    throw new RangeError(`monthGrid: year must be an integer, got: ${JSON.stringify(year)}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`monthGrid: month must be an integer in 1..12, got: ${JSON.stringify(month)}`);
  }

  const first = fromComponents(year, month - 1, 1);
  const isoDow = (first.getDay() + 6) % 7; // Monday=0 .. Sunday=6
  let cursor = addDays(first, -isoDow); // Monday on or before the 1st

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = parseLocal(cursor);
    const inMonth = d.getFullYear() === year && d.getMonth() + 1 === month;
    const dow = ((d.getDay() + 6) % 7) + 1; // Monday=1 .. Sunday=7
    cells.push({ date: cursor, inMonth, dow });
    cursor = addDays(cursor, 1);
  }
  return cells;
}
