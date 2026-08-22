// Timezone-hostile regression tier for js/dates.js (BUILD_PLAN Step 1.2).
//
// This is THE DATE TRAP file. The bugs it guards against (UTC slicing via
// toISOString, UTC-midnight parsing of 'YYYY-MM-DD' strings, millisecond
// day-arithmetic breaking across DST) are invisible when the test runner's
// own timezone happens to be benign (e.g. UTC, or a machine set to a
// zone where the bug doesn't bite on the specific dates chosen). So this
// file forces Node's TZ at PROCESS START in child processes — Node only
// honours TZ when the process boots, not via `process.env.TZ = ...` at
// runtime — and re-imports js/dates.js fresh inside each child.
//
// Zones covered, and why each earns its place:
//   UTC                    - the "no offset" control.
//   America/Toronto        - negative offset, observes DST (the classic
//                             North American case, and the DST-transition
//                             dates in the contract are keyed to it).
//   Pacific/Kiritimati     - UTC+14, the most extreme positive offset that
//                             exists; exposes "local day is a full day
//                             ahead of naive UTC" bugs hardest.
//   Pacific/Pago_Pago      - UTC-11, one of the most extreme negative
//                             offsets; exposes "local day is behind naive
//                             UTC" bugs hardest, no DST to confound it.
//   Asia/Kolkata           - UTC+5:30, a half-hour offset (not all zones
//                             are whole hours).
//   Australia/Lord_Howe    - a HALF-HOUR DST shift (30 min, not 60) —
//                             stresses any DST logic that assumes a full
//                             hour.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATES_JS_URL = pathToFileURL(path.resolve(__dirname, '../../js/dates.js')).href;

const ZONES = [
  'UTC',
  'America/Toronto',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
];

const CHILD_SCRIPT = `
  const mod = await import(${JSON.stringify(DATES_JS_URL)});
  const { todayLocal, parseLocal, formatLocal, isoWeekKey, rangeDays, addDays } = mod;
  const out = {};
  out.today2330 = todayLocal(new Date(2026, 7, 21, 23, 30));
  out.today0030 = todayLocal(new Date(2026, 7, 21, 0, 30));
  out.roundtrip = formatLocal(parseLocal('2026-08-21'));
  out.isoWeek = isoWeekKey('2026-01-01');
  out.springForward = rangeDays('2026-03-06', '2026-03-10');
  out.fallBack = rangeDays('2026-10-30', '2026-11-03');
  out.addSpring1 = addDays('2026-03-07', 1);
  out.addSpring2 = addDays('2026-03-08', 1);
  process.stdout.write(JSON.stringify(out));
`;

function runInZone(tz) {
  let raw;
  try {
    raw = execFileSync(process.execPath, ['--input-type=module'], {
      input: CHILD_SCRIPT,
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
      timeout: 20000,
    });
  } catch (err) {
    throw new Error(
      `[TZ=${tz}] child process failed: ${err.message}\nstdout: ${err.stdout}\nstderr: ${err.stderr}`
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`[TZ=${tz}] child process produced non-JSON stdout: ${raw}`);
  }
}

for (const tz of ZONES) {
  describe(`TZ=${tz}`, () => {
    let result;
    // Run once per zone; the child process is the expensive part (Node
    // startup + TZ database lookup), and every assertion below is cheap.
    const get = () => {
      if (!result) result = runInZone(tz);
      return result;
    };

    it(`[TZ=${tz}] todayLocal(23:30 local) is the SAME local day, not tomorrow`, () => {
      const r = get();
      assert.equal(r.today2330, '2026-08-21', `[TZ=${tz}] 23:30 local rolled to the wrong day: got ${r.today2330}`);
    });

    it(`[TZ=${tz}] todayLocal(00:30 local) is that same local day, not yesterday`, () => {
      const r = get();
      assert.equal(r.today0030, '2026-08-21', `[TZ=${tz}] 00:30 local rolled to the wrong day: got ${r.today0030}`);
    });

    it(`[TZ=${tz}] parseLocal -> formatLocal round-trips without a day shift`, () => {
      const r = get();
      assert.equal(
        r.roundtrip,
        '2026-08-21',
        `[TZ=${tz}] parseLocal/formatLocal round-trip shifted the day: got ${r.roundtrip}`
      );
    });

    it(`[TZ=${tz}] isoWeekKey('2026-01-01') is '2026-W01' regardless of zone`, () => {
      const r = get();
      assert.equal(r.isoWeek, '2026-W01', `[TZ=${tz}] isoWeekKey gave the wrong week: got ${r.isoWeek}`);
    });

    it(`[TZ=${tz}] rangeDays across spring-forward (America/Toronto DST) has exactly 5 consecutive, non-duplicate days`, () => {
      const r = get();
      const expected = ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'];
      assert.deepEqual(
        r.springForward,
        expected,
        `[TZ=${tz}] rangeDays broke across the spring-forward transition: got ${JSON.stringify(r.springForward)}`
      );
    });

    it(`[TZ=${tz}] rangeDays across fall-back has exactly 5 consecutive, non-duplicate days`, () => {
      const r = get();
      const expected = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'];
      assert.deepEqual(
        r.fallBack,
        expected,
        `[TZ=${tz}] rangeDays broke across the fall-back transition: got ${JSON.stringify(r.fallBack)}`
      );
    });

    it(`[TZ=${tz}] addDays is correct on both sides of the spring-forward transition`, () => {
      const r = get();
      assert.equal(
        r.addSpring1,
        '2026-03-08',
        `[TZ=${tz}] addDays('2026-03-07', 1) should be '2026-03-08': got ${r.addSpring1}`
      );
      assert.equal(
        r.addSpring2,
        '2026-03-09',
        `[TZ=${tz}] addDays('2026-03-08', 1) should be '2026-03-09': got ${r.addSpring2}`
      );
    });
  });
}
