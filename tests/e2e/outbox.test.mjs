// E2E for Step D.6 — the global unsent-writes indicator, and the flush that
// runs at app start on EVERY route.
//
// The unit tier (tests/unit/outbox-sync.test.mjs) covers the trigger logic
// against a fake event target. What only a real browser can prove is the part
// that motivated the step: that a queued write is retried when the app boots
// straight to a DETAIL route — the case the old Home-only call site missed,
// and the one a standalone PWA actually hits, because it relaunches at its
// last hash.
//
// MANDATORY MECHANIC (see tests/e2e/home.test.mjs): service workers blocked,
// because requests made from inside a SW are invisible to page.route() and
// the app would reach the LIVE database.
import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const TRACKABLE = {
  id: 366,
  name: 'Calories',
  value_shape: 'numeric',
  unit: 'kcal',
  aggregation: 'average',
  direction: 'break',
  target_type: 'none',
  target_value: null,
  bounds_enabled: false,
  bounds_mode: 'auto',
  bound_lower: null,
  bound_upper: null,
  relog_semantic: 'state',
  color: null,
  icon: null,
  sort_order: 0,
  archived: false,
};

// Seeds a persisted outbox BEFORE any app script runs, which is exactly the
// state a relaunched PWA hydrates from after logging offline.
async function seedOutbox(page, ops) {
  await page.addInitScript((seeded) => {
    localStorage.setItem('daily.outbox.v1', JSON.stringify({ v: 1, ops: seeded }));
  }, ops);
}

function op(trackableId, date, value) {
  return {
    id: `seed-${date}`,
    type: 'upsert',
    key: `${trackableId}|${date}`,
    payload: { trackable_id: trackableId, entry_date: date, value },
    queuedAt: 1,
  };
}

async function routeRest(page, { onUpsert } = {}) {
  await page.route('**/rest/v1/trackables*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([TRACKABLE]) });
  });
  await page.route('**/rest/v1/entries*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      if (onUpsert) onUpsert(JSON.parse(req.postData() || '{}'));
      const body = JSON.parse(req.postData() || '{}');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 1, note: null, source: null, ...body }]),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

test('D6-1 — the indicator is present but hidden when nothing is queued', async ({ page }) => {
  await routeRest(page);
  await page.goto('/');
  const el = page.locator('#outbox-status');
  await expect(el).toHaveCount(1);
  await expect(el).toBeHidden();
  await expect(el).toHaveAttribute('data-count', '0');
});

test('D6-2 — THE BUG: a write queued offline is flushed when the app boots to a DETAIL route', async ({ page }) => {
  // Before Step D.6, flushOutbox() was called only from the Home view's
  // mount. Booting to #/t/366 — which is what a standalone PWA does when it
  // relaunches at its last hash — left this op in localStorage forever while
  // the UI showed the value as saved.
  const upserts = [];
  await seedOutbox(page, [op(366, '2026-05-01', 1234)]);
  await routeRest(page, { onUpsert: (b) => upserts.push(b) });

  await page.goto('/#/t/366');

  await expect.poll(() => upserts.length, { timeout: 5000 }).toBe(1);
  expect(upserts[0]).toMatchObject({ trackable_id: 366, entry_date: '2026-05-01', value: 1234 });

  // And the queue is drained from persistent storage, not just from memory —
  // the Step 1.1 bug was precisely memory and storage disagreeing.
  await expect
    .poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('daily.outbox.v1') || '{"ops":[]}').ops.length))
    .toBe(0);
});

test('D6-3 — the indicator shows a count while the write cannot be sent, then clears', async ({ page }) => {
  let allowUpsert = false;
  const upserts = [];
  await seedOutbox(page, [op(366, '2026-05-01', 1234), op(366, '2026-05-02', 5678)]);

  await page.route('**/rest/v1/trackables*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([TRACKABLE]) });
  });
  await page.route('**/rest/v1/entries*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      if (!allowUpsert) {
        // 503 is retryable, so the op stays queued — the offline case.
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"down"}' });
        return;
      }
      const body = JSON.parse(req.postData() || '{}');
      upserts.push(body);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify([{ id: upserts.length, note: null, source: null, ...body }]),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.goto('/');

  const el = page.locator('#outbox-status');
  await expect(el).toBeVisible();
  await expect(el).toHaveText('2 logs not yet saved');
  // Not "syncing" — that would imply progress while there is none.
  await expect(el).not.toHaveText(/sync/i);

  // Network comes back, and a real browser event drives the retry.
  allowUpsert = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect(el).toBeHidden({ timeout: 5000 });
  await expect(el).toHaveAttribute('data-count', '0');
  expect(upserts.length).toBe(2);
});

test('D6-4 — the indicator is announced to assistive tech and does not break layout at 390px', async ({ page }) => {
  await seedOutbox(page, [op(366, '2026-05-01', 1234)]);
  await page.route('**/rest/v1/trackables*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([TRACKABLE]) });
  });
  await page.route('**/rest/v1/entries*', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"down"}' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  const el = page.locator('#outbox-status');
  await expect(el).toBeVisible();
  await expect(el).toHaveAttribute('role', 'status');
  await expect(el).toHaveAttribute('aria-live', 'polite');

  const scrolls = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    width: document.documentElement.clientWidth,
  }));
  expect(scrolls.horizontal, 'the indicator must not introduce horizontal scroll').toBe(false);
  expect(errors).toEqual([]);
});

test('D6-5 — the indicator appears from a DETAIL route too, not just Home', async ({ page }) => {
  // The whole point of putting it in the shell rather than in a view.
  await seedOutbox(page, [op(366, '2026-05-01', 1234)]);
  await page.route('**/rest/v1/trackables*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([TRACKABLE]) });
  });
  await page.route('**/rest/v1/entries*', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"down"}' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.goto('/#/settings');
  await expect(page.locator('#outbox-status')).toHaveText('1 log not yet saved');
});
