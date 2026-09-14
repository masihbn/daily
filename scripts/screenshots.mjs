// Phase U (docs/DESIGN_PLAN.md §2) — screenshots of every screen at iPhone
// size with a fixed fixture set, dark + light + landscape. NOT deployed.
// Zero real network calls: every REST/auth call is fulfilled or aborted from
// fixtures below. Orchestrator tooling: run before and after a design step
// and compare the pairs.
//
// Usage (PowerShell, from the repo root; Bash on this machine cannot reach
// local servers):
//   node tests/helpers/server.mjs 8123      # in the background
//   node scripts/screenshots.mjs <outDir>
import { chromium } from '@playwright/test';
import { seedSession } from '../tests/helpers/e2e-session.mjs';
import path from 'node:path';

const OUT = process.argv[2] || 'screenshots';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:8123';

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
}

const T = [
  { id: 1, name: 'Workout', value_shape: 'boolean', relog_semantic: 'state', aggregation: 'count', direction: 'build', unit: null, bounds_enabled: false, bounds_mode: 'auto', bound_lower: null, bound_upper: null, target_type: 'weekly_count', target_value: 3, color: '#bf5af2', icon: 'dumbbell', sort_order: 0, archived: false },
  { id: 2, name: 'Calories', value_shape: 'numeric', relog_semantic: 'state', aggregation: 'average', direction: 'break', unit: 'kcal', bounds_enabled: true, bounds_mode: 'auto', bound_lower: null, bound_upper: null, target_type: 'none', target_value: null, color: '#ff9500', icon: 'flame', sort_order: 1, archived: false },
  { id: 3, name: 'Weight', value_shape: 'numeric', relog_semantic: 'state', aggregation: 'last', direction: 'break', unit: 'kg', bounds_enabled: true, bounds_mode: 'manual', bound_lower: 78, bound_upper: 85, target_type: 'none', target_value: null, color: '#0a84ff', icon: 'scale', sort_order: 2, archived: false },
  { id: 4, name: 'Smoking', value_shape: 'numeric', relog_semantic: 'cumulative', aggregation: 'sum', direction: 'break', unit: 'cig', bounds_enabled: false, bounds_mode: 'auto', bound_lower: null, bound_upper: null, target_type: 'daily_value', target_value: 5, color: '#ff453a', icon: 'cigarette', sort_order: 3, archived: false },
  { id: 5, name: 'Reading', value_shape: 'boolean', relog_semantic: 'state', aggregation: 'count', direction: 'build', unit: null, bounds_enabled: false, bounds_mode: 'auto', bound_lower: null, bound_upper: null, target_type: 'weekly_count', target_value: 4, color: '#34c759', icon: 'book', sort_order: 4, archived: false },
];

let seed = 7;
function rnd() {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
}
const E = [];
let eid = 1;
for (let n = 0; n < 200; n++) {
  const date = daysAgo(n);
  if (rnd() < 0.45) E.push({ id: eid++, trackable_id: 1, entry_date: date, value: 1, note: null, source: 'app' });
  if (rnd() < 0.85) E.push({ id: eid++, trackable_id: 2, entry_date: date, value: Math.round(1800 + rnd() * 1200), note: null, source: 'app' });
  if (rnd() < 0.5) E.push({ id: eid++, trackable_id: 3, entry_date: date, value: Math.round((80 + Math.sin(n / 20) * 3 + rnd()) * 10) / 10, note: null, source: 'app' });
  if (rnd() < 0.6) E.push({ id: eid++, trackable_id: 4, entry_date: date, value: Math.round(rnd() * 9), note: null, source: 'app' });
  if (rnd() < 0.5) E.push({ id: eid++, trackable_id: 5, entry_date: date, value: 1, note: null, source: 'app' });
}

async function wire(page) {
  await page.route('**/rest/v1/app_settings*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, rolling_window_days: 90 }]) })
  );
  await page.route('**/rest/v1/trackables*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(T) })
  );
  await page.route('**/rest/v1/entries*', (r) => {
    let url = r.request().url();
    try { url = decodeURIComponent(url); } catch {}
    const m = url.match(/trackable_id=in\.\(([^)]*)\)/) || url.match(/trackable_id=eq\.(\d+)/);
    let rows = E;
    if (m) {
      const ids = new Set(m[1].split(',').map((s) => s.trim()));
      rows = E.filter((e) => ids.has(String(e.trackable_id)));
    }
    const gte = url.match(/entry_date=gte\.(\d{4}-\d{2}-\d{2})/);
    const lte = url.match(/entry_date=lte\.(\d{4}-\d{2}-\d{2})/);
    if (gte) rows = rows.filter((e) => e.entry_date >= gte[1]);
    if (lte) rows = rows.filter((e) => e.entry_date <= lte[1]);
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
  await page.route('**/auth/v1/**', (r) => r.abort());
}

async function shot(page, name, full = true) {
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full });
  console.log('shot', name);
}

const browser = await chromium.launch();
for (const scheme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await seedSession(page);
  await page.addInitScript(() => {
    localStorage.setItem('daily.detail.overlay.v1', JSON.stringify({ 2: [1] }));
    localStorage.setItem('daily.compare.v1', JSON.stringify({ ids: [2, 3, 1] }));
  });
  await wire(page);
  const p = scheme + '-';
  await page.goto(BASE + '/index.html#/');
  await shot(page, p + 'home');
  await page.goto(BASE + '/index.html#/t/2');
  await shot(page, p + 'detail-calories');
  await page.goto(BASE + '/index.html#/t/1');
  await shot(page, p + 'detail-workout');
  await page.goto(BASE + '/index.html#/t/3');
  await shot(page, p + 'detail-weight');
  await page.goto(BASE + '/index.html#/compare');
  await shot(page, p + 'compare');
  await page.goto(BASE + '/index.html#/settings');
  await shot(page, p + 'settings');
  await page.goto(BASE + '/index.html#/new');
  await shot(page, p + 'new');
  await page.goto(BASE + '/index.html#/t/2/edit');
  await shot(page, p + 'edit');
  await ctx.close();

  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme, serviceWorkers: 'block' });
  const page2 = await ctx2.newPage();
  await wire(page2);
  await page2.goto(BASE + '/index.html#/');
  await shot(page2, p + 'signin', false);
  await ctx2.close();

  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme, serviceWorkers: 'block' });
  const page3 = await ctx3.newPage();
  await seedSession(page3);
  await page3.addInitScript(() => localStorage.setItem('daily.applock.v1', JSON.stringify({ v: 1, credentialId: 'AAAA', enabledAt: '2026-09-14T00:00:00.000Z' })));
  await wire(page3);
  await page3.goto(BASE + '/index.html#/');
  await shot(page3, p + 'lock', false);
  await ctx3.close();
}
// Landscape detail, to see what the charts do today when the phone rotates.
const ctxL = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, colorScheme: 'dark', serviceWorkers: 'block' });
const pageL = await ctxL.newPage();
await seedSession(pageL);
await pageL.addInitScript(() => localStorage.setItem('daily.detail.overlay.v1', JSON.stringify({ 2: [1] })));
await wire(pageL);
await pageL.goto(BASE + '/index.html#/t/2');
await shot(pageL, 'landscape-detail-calories');
await ctxL.close();
await browser.close();
