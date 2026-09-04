// Step D.5 — unit tests for scripts/import-csv.mjs (pure helpers only; the
// network path was exercised live against production, recorded in
// BUILD_PLAN.md's D.5 Test Subjects).
//
// The helpers under test are the ones that can silently corrupt history:
//
//   - localDayOf       the timezone trap: a 00:30 timestamp read as UTC lands
//                      on the previous local day.
//   - collapseByDay    the lossy per-day collapse; it must REFUSE to guess a
//                      rule when a day has more than one row.
//   - planWrites       collisions with app-typed rows default to "keep the
//                      app's value".
//   - parseArgs        no --target, no run (a bulk write defaulting to
//                      production is a data-loss tool); dry run by default.
//   - assertTargetMatches  the named target must be the configured project.
//
// Guards are tested from both sides, per the convention set in D.3: a guard
// that rejects everything passes a one-sided test and breaks the tool.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCsv,
  toRecords,
  isIsoDate,
  localDayOf,
  dateInZone,
  zonedToInstant,
  zoneFor,
  isValidZone,
  extractNutrition,
  extractStrong,
  extractWeight,
  collapseValues,
  collapseByDay,
  planWrites,
  batchId,
  toEntryRows,
  parseArgs,
  assertTargetMatches,
  KIND_SHAPE,
  COLLAPSE_RULES,
} from '../../scripts/import-csv.mjs';

const REQUIRED = ['--file', 'x.csv', '--kind', 'nutrition', '--trackable', 'Calories', '--target', 'abc'];

describe('parseCsv', () => {
  it('handles quoted fields, doubled quotes, CRLF and a BOM', () => {
    const text = '﻿a,b\r\n1,"has, comma"\r\n2,"say ""hi"""\r\n';
    assert.deepEqual(parseCsv(text), [
      ['a', 'b'],
      ['1', 'has, comma'],
      ['2', 'say "hi"'],
    ]);
  });

  it('keeps a trailing empty field and a final line without newline', () => {
    assert.deepEqual(parseCsv('a,b\n1,'), [
      ['a', 'b'],
      ['1', ''],
    ]);
  });

  it('toRecords maps by trimmed header and drops blank lines', () => {
    const { header, records } = toRecords(parseCsv(' Date ,Calories\n2024-01-01,10\n\n'));
    assert.deepEqual(header, ['Date', 'Calories']);
    assert.deepEqual(records, [{ Date: '2024-01-01', Calories: '10' }]);
  });
});

describe('dates', () => {
  it('isIsoDate accepts a real date and rejects an impossible one', () => {
    assert.equal(isIsoDate('2024-02-29'), true);
    assert.equal(isIsoDate('2023-02-29'), false);
    assert.equal(isIsoDate('2024-1-1'), false);
  });

  it('naive: the date part is the day, whatever the time', () => {
    assert.equal(localDayOf('2023-01-08 02:22:01'), '2023-01-08');
    assert.equal(localDayOf('2023-01-08 23:59:59', { sourceTz: 'naive' }), '2023-01-08');
  });

  it('utc: a post-midnight UTC timestamp maps to the previous local day west of UTC', () => {
    // 02:22 UTC on 8 Jan is 21:22 on 7 Jan in New York (UTC-5 in winter).
    assert.equal(localDayOf('2023-01-08 02:22:01', { sourceTz: 'utc', localTz: 'America/New_York' }), '2023-01-07');
    // ...and 22:30 UTC on 8 Jan is 23:30 on 8 Jan in Amsterdam (UTC+1) — same day.
    assert.equal(localDayOf('2023-01-08 22:30:00', { sourceTz: 'utc', localTz: 'Europe/Amsterdam' }), '2023-01-08');
    // ...but 23:30 UTC is already 9 Jan in Amsterdam.
    assert.equal(localDayOf('2023-01-08 23:30:00', { sourceTz: 'utc', localTz: 'Europe/Amsterdam' }), '2023-01-09');
  });

  it('utc without a local zone is an error, not a silent naive fallback', () => {
    assert.throws(() => localDayOf('2023-01-08 02:22:01', { sourceTz: 'utc' }), /local-tz/);
  });

  it('rejects garbage and out-of-range times', () => {
    assert.equal(localDayOf('yesterday'), null);
    assert.equal(localDayOf('2023-01-08 25:00:00'), null);
    assert.equal(localDayOf('2023-13-08 10:00:00'), null);
  });

  it('IANA source zone: a Strong export rendered in Toronto, for a workout done in Tehran', () => {
    // Strong renders its export in the phone's CURRENT zone. 15:40 Toronto
    // (EST, UTC-5) on 17 Jan is 00:10 on 18 Jan in Tehran (UTC+3:30) — the
    // workout happened on the 18th, and the naive reading says the 17th.
    const opts = { sourceTz: 'America/Toronto', localTz: 'Asia/Tehran' };
    assert.equal(localDayOf('2023-01-17 15:40:00', opts), '2023-01-18');
    assert.equal(localDayOf('2023-01-17 15:20:00', opts), '2023-01-17');
    // In summer Toronto is EDT (UTC-4) and Tehran no longer observes DST
    // (dropped in 2022), so the boundary moves to 16:30.
    assert.equal(localDayOf('2023-07-20 16:45:00', opts), '2023-07-21');
    assert.equal(localDayOf('2023-07-20 16:15:00', opts), '2023-07-20');
  });

  it('eras: rows before the cutoff use the earlier zone, rows after use --local-tz', () => {
    const opts = { sourceTz: 'America/Toronto', localTz: 'America/Toronto', eras: [{ until: '2023-09-01', zone: 'Asia/Tehran' }] };
    assert.equal(localDayOf('2023-01-17 15:40:00', opts), '2023-01-18'); // Tehran era: shifts
    assert.equal(localDayOf('2024-01-17 15:40:00', opts), '2024-01-17'); // Toronto era: identity
    assert.equal(zoneFor('2023-08-31', 'America/Toronto', opts.eras), 'Asia/Tehran');
    assert.equal(zoneFor('2023-09-01', 'America/Toronto', opts.eras), 'America/Toronto');
  });

  it('same zone in and out is the identity, so a correct naive file is not harmed', () => {
    const opts = { sourceTz: 'America/Toronto', localTz: 'America/Toronto' };
    assert.equal(localDayOf('2024-03-10 02:30:00', opts), '2024-03-10'); // inside the DST gap
    assert.equal(localDayOf('2024-11-03 01:30:00', opts), '2024-11-03'); // inside the DST overlap
    assert.equal(localDayOf('2024-07-04 23:59:59', opts), '2024-07-04');
  });

  it('zonedToInstant round-trips through dateInZone', () => {
    const inst = zonedToInstant({ y: 2023, mo: 1, d: 17, h: 15, mi: 40, s: 0 }, 'America/Toronto');
    assert.equal(inst.toISOString(), '2023-01-17T20:40:00.000Z');
    assert.equal(isValidZone('Asia/Tehran'), true);
    assert.equal(isValidZone('Mars/Olympus'), false);
    assert.throws(() => localDayOf('2023-01-17 15:40:00', { sourceTz: 'Mars/Olympus', localTz: 'Asia/Tehran' }), /unknown sourceTz/);
  });

  it('dateInZone respects DST', () => {
    // 2024-03-31 00:30 UTC is 01:30 CET (DST starts at 01:00 UTC that day).
    assert.equal(dateInZone(new Date('2024-03-31T00:30:00Z'), 'Europe/Amsterdam'), '2024-03-31');
    assert.equal(dateInZone(new Date('2024-03-30T23:30:00Z'), 'Europe/Amsterdam'), '2024-03-31');
  });
});

describe('extractors', () => {
  it('nutrition: one observation per meal row, bad rows reported with line numbers', () => {
    const { obs, bad } = extractNutrition([
      { Date: '2024-01-01', Meal: 'Breakfast', Calories: '500' },
      { Date: '2024-01-01', Meal: 'Dinner', Calories: '700.5' },
      { Date: 'nope', Meal: 'Lunch', Calories: '1' },
      { Date: '2024-01-02', Meal: 'Lunch', Calories: '' },
      { Date: '2024-01-02', Meal: 'Lunch', Calories: '-5' },
    ]);
    assert.equal(obs.length, 2);
    assert.deepEqual(obs.map((o) => o.value), [500, 700.5]);
    assert.deepEqual(bad.map((b) => b.line), [4, 5, 6]);
  });

  it('strong: sets collapse into sessions keyed by start timestamp', () => {
    const { obs, bad } = extractStrong([
      { Date: '2024-06-16 21:44:00', 'Workout Name': 'Chest', Duration: '1h', 'Set Order': '1' },
      { Date: '2024-06-16 21:44:00', 'Workout Name': 'Chest', Duration: '1h', 'Set Order': '2' },
      { Date: '2024-06-17 10:00:00', 'Workout Name': 'Legs', Duration: '40min', 'Set Order': '1' },
      { Date: '', 'Workout Name': 'x' },
    ]);
    assert.equal(obs.length, 2);
    assert.equal(obs[0].sets, 2);
    assert.equal(obs[0].value, 1);
    assert.equal(obs[0].label, 'Chest');
    assert.equal(bad.length, 1);
  });

  it('weight: finds the Time and WEIGHT columns by name, even with a BOM-prefixed header', () => {
    const { obs, bad } = extractWeight([
      { Time: '2026-08-26 07:23:08', 'Family Members': 'M', 'WEIGHT (kg)': '86.8' },
      { Time: '2026-08-25 08:12:29', 'Family Members': 'M', 'WEIGHT (kg)': '0' },
      { Time: 'bad', 'Family Members': 'M', 'WEIGHT (kg)': '80' },
    ]);
    assert.equal(obs.length, 1);
    assert.equal(obs[0].value, 86.8);
    assert.equal(obs[0].day, '2026-08-26');
    assert.equal(bad.length, 2);
  });

  it('weight: refuses a file with no WEIGHT column rather than importing zeros', () => {
    assert.throws(() => extractWeight([{ Time: '2026-08-26 07:23:08', BMI: '27' }]), /no WEIGHT column/);
  });
});

describe('collapse', () => {
  it('every rule produces the expected value', () => {
    const v = [80.9, 87.1, 81.0];
    assert.equal(collapseValues(v, 'sum'), 249);
    assert.equal(collapseValues(v, 'average'), 83);
    assert.equal(collapseValues(v, 'last'), 81.0);
    assert.equal(collapseValues(v, 'first'), 80.9);
    assert.equal(collapseValues(v, 'max'), 87.1);
    assert.equal(collapseValues(v, 'min'), 80.9);
    assert.equal(COLLAPSE_RULES.length, 6);
  });

  it('sum rounds float noise to one decimal', () => {
    assert.equal(collapseValues([694.9, 641.9, 334.3], 'sum'), 1671.1);
  });

  it('rejects an unknown rule and an empty list', () => {
    assert.throws(() => collapseValues([1], 'median'), /unknown rule/);
    assert.throws(() => collapseValues([], 'sum'), /no values/);
  });

  it('REFUSES to collapse a multi-row day without an explicit rule', () => {
    const obs = [
      { day: '2024-01-01', value: 1 },
      { day: '2024-01-01', value: 2 },
    ];
    assert.throws(() => collapseByDay(obs, 'nutrition', null), /--collapse/);
  });

  it('...but a file with no multi-row day needs no rule', () => {
    const { days, multiDayCount } = collapseByDay([{ day: '2024-01-01', value: 5 }], 'nutrition', null);
    assert.equal(multiDayCount, 0);
    assert.deepEqual(days.map((d) => [d.entry_date, d.value]), [['2024-01-01', 5]]);
  });

  it('first/last follow timestamp order, not file order', () => {
    // The scale export is newest-first, so file order is the wrong order.
    const obs = [
      { day: '2025-08-31', value: 80.8, ts: '2025-08-31 13:53:48' },
      { day: '2025-08-31', value: 81.1, ts: '2025-08-31 07:14:10' },
    ];
    assert.equal(collapseByDay(obs, 'weight', 'first').days[0].value, 81.1);
    assert.equal(collapseByDay(obs, 'weight', 'last').days[0].value, 80.8);
  });

  it('strong: value is always 1, names join into the note, and no rule is required', () => {
    const obs = [
      { day: '2024-06-16', value: 1, ts: '2024-06-16 21:43:06', label: 'Chest' },
      { day: '2024-06-16', value: 1, ts: '2024-06-16 21:44:00', label: 'Evening Workout' },
      { day: '2024-06-17', value: 1, ts: '2024-06-17 10:00:00', label: 'Legs' },
    ];
    const { days, multiDayCount } = collapseByDay(obs, 'strong', null);
    assert.equal(multiDayCount, 1);
    assert.deepEqual(
      days.map((d) => [d.entry_date, d.value, d.note]),
      [
        ['2024-06-16', 1, 'Chest + Evening Workout'],
        ['2024-06-17', 1, 'Legs'],
      ]
    );
  });

  it('output is sorted by date regardless of input order', () => {
    const { days } = collapseByDay(
      [
        { day: '2024-01-03', value: 1 },
        { day: '2024-01-01', value: 1 },
      ],
      'nutrition',
      null
    );
    assert.deepEqual(days.map((d) => d.entry_date), ['2024-01-01', '2024-01-03']);
  });
});

describe('collisions', () => {
  const days = [
    { entry_date: '2026-09-01', value: 2100 },
    { entry_date: '2026-09-02', value: 1671.1 },
  ];
  const existing = [{ entry_date: '2026-09-02', value: 1700, source: null }];

  it('skip keeps the app value and reports the collision', () => {
    const plan = planWrites(days, existing, 'skip');
    assert.deepEqual(plan.writes.map((w) => w.entry_date), ['2026-09-01']);
    assert.equal(plan.collisions.length, 1);
    assert.equal(plan.collisions[0].existing.value, 1700);
    assert.equal(plan.skipped, 1);
  });

  it('overwrite writes both and still reports the collision', () => {
    const plan = planWrites(days, existing, 'overwrite');
    assert.equal(plan.writes.length, 2);
    assert.equal(plan.collisions.length, 1);
    assert.equal(plan.skipped, 0);
  });

  it('rejects an unknown policy', () => {
    assert.throws(() => planWrites(days, existing, 'merge'), /unknown policy/);
  });
});

describe('rows', () => {
  it('batchId slugs the trackable name and stamps the date', () => {
    assert.equal(batchId('Calories', new Date('2026-09-04T12:00:00Z')), 'import:calories-2026-09-04');
    assert.equal(batchId('  Body Weight! ', new Date('2026-09-04T12:00:00Z')), 'import:body-weight-2026-09-04');
    assert.throws(() => batchId('!!!'), /empty/);
  });

  it('toEntryRows emits exactly the five columns, note defaulting to null', () => {
    const rows = toEntryRows([{ entry_date: '2024-01-01', value: 1 }], 365, 'import:workout-2026-09-04');
    assert.deepEqual(rows, [{ trackable_id: 365, entry_date: '2024-01-01', value: 1, note: null, source: 'import:workout-2026-09-04' }]);
  });

  it('KIND_SHAPE pins strong to boolean and the others to numeric', () => {
    assert.deepEqual(KIND_SHAPE, { nutrition: 'numeric', strong: 'boolean', weight: 'numeric' });
  });
});

describe('parseArgs', () => {
  it('defaults to a dry run, naive timestamps and skip-on-collision', () => {
    const a = parseArgs(REQUIRED);
    assert.equal(a.yes, false);
    assert.equal(a.sourceTz, 'naive');
    assert.equal(a.onCollision, 'skip');
    assert.equal(a.collapse, null);
  });

  it('refuses to run without --target, and says why', () => {
    assert.throws(() => parseArgs(REQUIRED.slice(0, 6)), /--target.*\n.*data-loss/s);
  });

  it('accepts a full valid invocation', () => {
    const a = parseArgs([...REQUIRED, '--collapse', 'sum', '--source-tz', 'utc', '--local-tz', 'Europe/Amsterdam', '--on-collision', 'overwrite', '--yes']);
    assert.equal(a.yes, true);
    assert.equal(a.collapse, 'sum');
    assert.equal(a.localTz, 'Europe/Amsterdam');
    assert.equal(a.onCollision, 'overwrite');
  });

  it('rejects bad enum values and utc without a zone', () => {
    assert.throws(() => parseArgs([...REQUIRED, '--kind', 'fitbit']), /--kind/);
    assert.throws(() => parseArgs([...REQUIRED, '--collapse', 'median']), /--collapse/);
    assert.throws(() => parseArgs([...REQUIRED, '--on-collision', 'merge']), /--on-collision/);
    assert.throws(() => parseArgs([...REQUIRED, '--source-tz', 'utc']), /--local-tz/);
    assert.throws(() => parseArgs([...REQUIRED, '--source-tz', 'Mars/Olympus', '--local-tz', 'Asia/Tehran']), /valid IANA zone/);
    assert.throws(() => parseArgs([...REQUIRED, '--source-tz', 'utc', '--local-tz', 'Mars/Olympus']), /not a valid IANA zone/);
    assert.throws(() => parseArgs([...REQUIRED, '--local-tz-until', 'Asia/Tehran']), /YYYY-MM-DD/);
    assert.throws(() => parseArgs([...REQUIRED, '--local-tz-until', '2023-09-01=Mars/Olympus']), /not a valid IANA zone/);
  });

  it('accepts an IANA source zone and sorts repeated eras by date', () => {
    const a = parseArgs([
      ...REQUIRED,
      '--source-tz', 'America/Toronto', '--local-tz', 'America/Toronto',
      '--local-tz-until', '2024-01-01=Europe/Amsterdam',
      '--local-tz-until', '2023-09-01=Asia/Tehran',
    ]);
    assert.equal(a.sourceTz, 'America/Toronto');
    assert.deepEqual(a.eras, [
      { until: '2023-09-01', zone: 'Asia/Tehran' },
      { until: '2024-01-01', zone: 'Europe/Amsterdam' },
    ]);
    assert.throws(() => parseArgs([...REQUIRED, '--bogus']), /unknown argument/);
    assert.throws(() => parseArgs([...REQUIRED, '--collapse']), /needs a value/);
  });
});

describe('assertTargetMatches', () => {
  it('accepts the matching ref, as a bare ref or a URL', () => {
    assert.equal(assertTargetMatches('abc', 'https://abc.supabase.co'), 'abc');
    assert.equal(assertTargetMatches('https://abc.supabase.co/', 'https://abc.supabase.co'), 'abc');
  });

  it('refuses a mismatch, naming both sides', () => {
    assert.throws(() => assertTargetMatches('test-project', 'https://prod.supabase.co'), /"test-project".*"prod"/);
  });
});
