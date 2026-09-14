// E2E tests for the Step 4.2 CSV export block on the Settings screen
// (js/views/settings.js's "Export" block backed by js/export-csv.js),
// mounted at #/settings per CONTRACT-4.2.md. Written strictly against that
// contract's §2 (DOM/behaviour) and §5 (test plan, cases E1 through E7) —
// the implementation is being written in parallel by another agent and has
// NOT been read while writing this file.
//
// Mechanics copied from tests/e2e/settings.test.mjs: guard-first routing,
// service workers blocked, seedSession, an app_settings + trackables +
// entries route trio with request logs. GUARDRAIL: nothing here may touch
// a real Supabase row — every PostgREST call is intercepted and every test
// asserts expect(unexpected).toEqual([]).
//
// Chromium headless has no `navigator.share`, so every case here exercises
// the anchor-download path (or, for E5, the textarea fallback) rather than
// the Web Share path — that path is covered instead by
// tests/unit/export-csv.test.mjs's X7(a)/(b)/(c) against a fully injected
// fake `nav`.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { seedSession, installAuthGuard } from '../helpers/e2e-session.mjs';
import { CSV_HEADER, CSV_BOM } from '../../js/export-csv.js';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await seedSession(page);
});

// --- fixtures ---------------------------------------------------------

const T_CALORIES = {
  id: 10,
  name: 'Calories',
  value_shape: 'numeric',
  relog_semantic: 'cumulative',
  aggregation: 'sum',
  direction: 'break',
  unit: 'kcal',
  bounds_enabled: false,
  bounds_mode: 'auto',
  bound_lower: null,
  bound_upper: null,
  target_type: 'none',
  target_value: null,
  color: '#ff9500',
  sort_order: 0,
  archived: false,
};

const T_WORKOUT = {
  id: 20,
  name: 'Workout',
  value_shape: 'boolean',
  relog_semantic: 'cumulative',
  aggregation: 'count',
  direction: 'build',
  unit: null,
  bounds_enabled: false,
  bounds_mode: 'auto',
  bound_lower: null,
  bound_upper: null,
  target_type: 'none',
  target_value: null,
  color: '#5856d6',
  sort_order: 1,
  archived: false,
};

const T_OLD = {
  id: 30,
  name: 'Old Habit',
  value_shape: 'boolean',
  relog_semantic: 'cumulative',
  aggregation: 'count',
  direction: 'build',
  unit: null,
  bounds_enabled: false,
  bounds_mode: 'auto',
  bound_lower: null,
  bound_upper: null,
  target_type: 'none',
  target_value: null,
  color: null,
  sort_order: 2,
  archived: true,
};

// Notes deliberately carry a comma and an embedded double quote — the RFC
// 4180 quoting round-trip this suite exists to prove end to end (the pure
// math is already covered by tests/unit/export-csv.test.mjs's X1/X6).
const ALL_ENTRIES = [
  { id: 1, trackable_id: 10, entry_date: '2026-01-01', value: 500, note: 'lunch, "yum"', source: null },
  { id: 2, trackable_id: 10, entry_date: '2026-01-02', value: 600, note: null, source: 'batch1' },
  { id: 3, trackable_id: 20, entry_date: '2026-01-01', value: 1, note: 'a,b', source: null },
  { id: 4, trackable_id: 30, entry_date: '2026-02-01', value: 1, note: null, source: null },
];

// --- route helpers -------------------------------------------------------

async function installGuard(page) {
  const unexpected = [];
  await page.route('**/rest/v1/**', async (route) => {
    unexpected.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort();
  });
  return unexpected;
}

async function routeSettings(page) {
  await page.route('**/rest/v1/app_settings*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.abort();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 1, rolling_window_days: 90, updated_at: '2026-01-01T00:00:00Z' }]),
    });
  });
}

async function routeTrackables(page, trackables) {
  await page.route('**/rest/v1/trackables*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.abort();
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(trackables) });
  });
}

// Filters `allEntries` by the request's own `trackable_id=in.(...)` filter
// (mirroring what a real PostgREST call would return), or serves
// everything when no such filter is present — so "export everything" vs.
// "export one" get genuinely different, filter-driven content rather than
// a hand-picked fixture per test.
async function routeEntries(page, allEntries, { status = 200 } = {}) {
  const getRequests = [];
  await page.route('**/rest/v1/entries*', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') {
      await route.abort();
      return;
    }
    getRequests.push({ url: req.url() });
    if (status !== 200) {
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ message: 'down' }) });
      return;
    }
    const url = new URL(req.url());
    const idFilter = url.searchParams.get('trackable_id'); // e.g. 'in.(20)'
    let rows = allEntries;
    if (idFilter) {
      const ids = idFilter.replace(/^in\.\(/, '').replace(/\)$/, '').split(',');
      rows = allEntries.filter((e) => ids.includes(String(e.trackable_id)));
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
  return { getRequests };
}

// Delays every entries GET by ~300ms — used by E7 to give a fixed window
// in which to observe the busy/disabled state.
async function routeEntriesDelayed(page, allEntries, delayMs = 300) {
  const getRequests = [];
  await page.route('**/rest/v1/entries*', async (route) => {
    getRequests.push({ url: route.request().url() });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(allEntries) });
  });
  return { getRequests };
}

async function readDownload(download) {
  const path = await download.path();
  const buf = await fs.promises.readFile(path);
  return buf.toString('utf8');
}

// ===========================================================================
// E1 — the export block renders
// ===========================================================================

test('E1 — the export block renders "Export everything" and one "Export" per non-archived fixture', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeSettings(page);
  await routeTrackables(page, [T_CALORIES, T_WORKOUT, T_OLD]);
  await routeEntries(page, ALL_ENTRIES);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  await expect(page.locator('button.settings-export-all')).toHaveText('Export everything (CSV)');

  const items = page.locator('li.settings-export-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute('data-id', '10');
  await expect(items.nth(0).locator('.settings-export-name')).toHaveText('Calories');
  await expect(items.nth(1)).toHaveAttribute('data-id', '20');
  await expect(items.nth(1).locator('.settings-export-name')).toHaveText('Workout');

  // The archived fixture (id 30) gets no row in the "export one" list.
  await expect(page.locator('li.settings-export-item[data-id="30"]')).toHaveCount(0);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// E2 — export everything
// ===========================================================================

test('E2 — export everything: one unfiltered entries GET, a well-named download with all rows quoted correctly, and the row-count status', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeSettings(page);
  await routeTrackables(page, [T_CALORIES, T_WORKOUT, T_OLD]);
  const { getRequests } = await routeEntries(page, ALL_ENTRIES);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('button.settings-export-all').click();
  const download = await downloadPromise;

  expect(getRequests.length).toBe(1);
  expect(getRequests[0].url).not.toContain('trackable_id=');

  expect(download.suggestedFilename()).toMatch(/^daily-export-\d{4}-\d{2}-\d{2}\.csv$/);

  const content = await readDownload(download);
  expect(content.startsWith(CSV_BOM)).toBe(true);
  const headerLine = content.slice(CSV_BOM.length).split('\r\n')[0];
  expect(headerLine).toBe(CSV_HEADER.join(','));

  // All three trackables, including the archived one, are present.
  expect(content).toContain('Calories');
  expect(content).toContain('Workout');
  expect(content).toContain('Old Habit');

  // RFC 4180 round-trip: comma inside the field forces quoting, and the
  // embedded " is doubled.
  expect(content).toContain('"lunch, ""yum"""');
  expect(content).toContain('"a,b"');

  await expect(page.locator('.settings-export-status')).toHaveText(`Exported ${ALL_ENTRIES.length} rows.`);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// E3 — export one
// ===========================================================================

test('E3 — export one: the entries GET names only that trackable, the filename carries its slug, and content is scoped to it', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeSettings(page);
  await routeTrackables(page, [T_CALORIES, T_WORKOUT, T_OLD]);
  const { getRequests } = await routeEntries(page, ALL_ENTRIES);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('li.settings-export-item[data-id="20"] button.settings-export-one').click();
  const download = await downloadPromise;

  expect(getRequests.length).toBe(1);
  expect(getRequests[0].url).toContain('trackable_id=in.(20)');

  expect(download.suggestedFilename()).toMatch(/^daily-workout-\d{4}-\d{2}-\d{2}\.csv$/);

  const content = await readDownload(download);
  const dataLines = content
    .slice(CSV_BOM.length)
    .split('\r\n')
    .slice(1)
    .filter((l) => l !== '');
  expect(dataLines.length).toBe(1);
  expect(dataLines[0]).toContain('Workout');
  expect(content).not.toContain('Calories');
  expect(content).not.toContain('Old Habit');

  await expect(page.locator('.settings-export-status')).toHaveText('Exported 1 rows.');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// E4 — entries GET 500: error line, no download
// ===========================================================================

test('E4 — entries GET 500 shows the load-error line, issues no download, and clears the status', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeSettings(page);
  await routeTrackables(page, [T_CALORIES, T_WORKOUT, T_OLD]);
  await routeEntries(page, ALL_ENTRIES, { status: 500 });

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  const downloadPromise = page.waitForEvent('download', { timeout: 1000 });
  await page.locator('button.settings-export-all').click();
  await expect(downloadPromise).rejects.toThrow();

  await expect(page.locator('.settings-export-error')).toHaveText(
    'Could not load your data. Check your connection and try again.'
  );
  await expect(page.locator('.settings-export-status')).toHaveText('');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// E5 — fallback: no URL.createObjectURL (and no navigator.share in headless
// chromium) forces the textarea path
// ===========================================================================

test('E5 — with URL.createObjectURL removed, export falls back to the textarea, and "Select all" selects its full value', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await page.addInitScript(() => {
    delete window.URL.createObjectURL;
  });
  await routeSettings(page);
  await routeTrackables(page, [T_CALORIES, T_WORKOUT, T_OLD]);
  await routeEntries(page, ALL_ENTRIES);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  await page.locator('button.settings-export-all').click();

  const fallback = page.locator('div.settings-export-fallback');
  await expect(fallback).toBeVisible();

  const textarea = fallback.locator('textarea.settings-export-text');
  const value = await textarea.inputValue();
  expect(value.startsWith(CSV_BOM)).toBe(true);
  // A <textarea>'s value setter normalises every CRLF to LF per spec, so a
  // literal '\r\n' split would find nothing to split on here (unlike the
  // downloaded-file content in E2/E3, which is read straight off disk and
  // keeps its real \r\n endings). Split on either so "first line equals the
  // header" still holds regardless of which line ending survived.
  const headerLine = value.slice(CSV_BOM.length).split(/\r\n|\n/)[0];
  expect(headerLine).toBe(CSV_HEADER.join(','));

  await fallback.locator('button.settings-export-select').click();
  const selection = await textarea.evaluate((el) => ({ start: el.selectionStart, end: el.selectionEnd, length: el.value.length }));
  expect(selection.start).toBe(0);
  expect(selection.end).toBe(selection.length);

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// E6 — no entries at all
// ===========================================================================

test('E6 — no entries at all: "Nothing to export.", no download', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeSettings(page);
  await routeTrackables(page, [T_CALORIES, T_WORKOUT, T_OLD]);
  await routeEntries(page, []);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  const downloadPromise = page.waitForEvent('download', { timeout: 1000 });
  await page.locator('button.settings-export-all').click();
  await expect(downloadPromise).rejects.toThrow();

  await expect(page.locator('.settings-export-status')).toHaveText('Nothing to export.');

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});

// ===========================================================================
// E7 — buttons disabled while an export is in flight
// ===========================================================================

test('E7 — export buttons are disabled while a load is in flight, and re-enabled afterward', async ({ page }) => {
  const unexpected = await installGuard(page);
  const unexpectedAuth = await installAuthGuard(page);
  await routeSettings(page);
  await routeTrackables(page, [T_CALORIES, T_WORKOUT, T_OLD]);
  await routeEntriesDelayed(page, ALL_ENTRIES, 300);

  await page.goto('/index.html#/settings');
  await expect(page.locator('section.settings')).toHaveAttribute('data-settings-state', 'ready');

  const allBtn = page.locator('button.settings-export-all');
  const oneBtn = page.locator('li.settings-export-item[data-id="10"] button.settings-export-one');

  const downloadPromise = page.waitForEvent('download');
  await allBtn.click();

  await expect(allBtn).toBeDisabled();
  await expect(oneBtn).toBeDisabled();

  await downloadPromise;

  await expect(allBtn).toBeEnabled();
  await expect(oneBtn).toBeEnabled();

  expect(unexpected).toEqual([]);
  expect(unexpectedAuth).toEqual([]);
});
