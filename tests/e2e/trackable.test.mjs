// E2E tests for the Step 2.2 create/edit trackable form (js/views/trackable.js),
// mounted at #/new and #/t/:id/edit per CONTRACT-2.2.md. Written strictly
// against that contract's §3 (form model, validation, payloads, archive) and
// §5.3 (test plan, cases F1 through F15) — the implementation is being
// written in parallel by another agent and is not visible here.
//
// AMENDED by CONTRACT-2.4.md ("Form fixes, per-shape targets, bounds
// verdict"), user feedback from the Phase 2 gate. Six defects; the ones
// touching this file:
//   DEFECT 1 — every progressive-disclosure assertion below (F1/F2/F3) was
//     REWRITTEN to check real rendered visibility (toBeHidden/toBeVisible)
//     plus each hidden control's disabled state, instead of only the
//     `hidden` attribute. See the dedicated comment on assertFieldHidden/
//     assertFieldVisible below for the full story — this is the actual
//     defect the user hit on device, and the reason this whole revision
//     exists.
//   DEFECT 3 — value_shape labels now read the raw words "Boolean"/
//     "Numeric" (new DEFECT3 test).
//   DEFECT 4 — target_type options are now per-shape, and applyShapeChange
//     resets an illegal target_type/target_value on a shape switch (new
//     DEFECT4a/DEFECT4b tests).
//   DEFECT 6 — the colour swatch selection affordance is strengthened; the
//     underlying functional contract (radio gets checked) is covered by the
//     new DEFECT6 test.
// DEFECT 2 (radio/label alignment) and DEFECT 5 (bounds verdict, covered in
// tests/e2e/home.test.mjs and tests/unit/home-model.test.mjs) are CSS/other-
// file concerns not exercised by new cases in this file.
//
// Do NOT start a server here and do NOT hardcode the base URL or viewport;
// both are supplied by playwright.config.mjs (baseURL 127.0.0.1:8123,
// 390x844 viewport). Reuses the exact interception mechanics established in
// tests/e2e/home.test.mjs (read first, per the task brief).
//
// GUARDRAIL (docs/ORCHESTRATION.md / CONTRACT-2.2.md): nothing in this file
// may create, modify, or delete a real Supabase row. Every PostgREST call
// the app makes is intercepted with page.route() and fully fulfilled/aborted
// from fixtures — this file makes ZERO real network calls to Supabase,
// verified per-test via installGuard().
//
// Attribute-naming judgment call (reported in the accompanying summary, not
// silently guessed past): CONTRACT-2.2.md §3.2 documents `name="value_shape"`
// / `name="direction"` / `name="color"` radio GROUPS and a
// `name="target_type"` / `name="bounds_mode"` SELECT, but does not spell out
// each radio's `value` attribute. This file assumes each radio's `value` is
// the literal enum value it represents (e.g. `value="boolean"`,
// `value="build"`, `value="#34c759"`) — the only natural way to implement a
// labeled radio group backed by an enum, and the same convention the DOM
// already uses elsewhere in this codebase (e.g. js/views/home.js's
// data-action / data-symbol values are the raw enum strings).

import { test, expect } from '@playwright/test';

// MANDATORY MECHANIC #1: block service workers for every test in this file.
// sw.js installs a `fetch` event handler that proxies every request through
// itself. Requests that originate from *inside* a service worker are NOT
// visible to page.route() — Playwright's request interception only sees
// requests made by the page/document, so if the SW is allowed to install and
// take over fetch, our route() fixtures silently stop applying and the app
// hits the LIVE Supabase database instead. Blocking service workers entirely
// sidesteps that.
test.use({ serviceWorkers: 'block' });

// --- fixtures ---------------------------------------------------------

// T1: a plain boolean trackable, used as "other row" filler in GET fixtures.
const T1 = {
  id: 1,
  name: 'Workout',
  value_shape: 'boolean',
  relog_semantic: 'state',
  aggregation: 'count',
  direction: 'build',
  unit: null,
  target_type: 'none',
  target_value: null,
  bounds_enabled: false,
  bounds_mode: 'auto',
  bound_lower: null,
  bound_upper: null,
  color: '#34c759',
  sort_order: 0,
  archived: false,
};

// T366: id chosen to match CONTRACT-2.2.md §5.3 F11 verbatim
// ("#/t/366/edit loads that trackable"). A numeric trackable with bounds set,
// so its presence also exercises edit-mode population of a fuller row.
const T366 = {
  id: 366,
  name: 'Weight',
  value_shape: 'numeric',
  relog_semantic: 'state',
  aggregation: 'last',
  direction: 'break',
  unit: 'kg',
  target_type: 'none',
  target_value: null,
  bounds_enabled: true,
  bounds_mode: 'manual',
  bound_lower: 50,
  bound_upper: 100,
  color: '#3478f6',
  sort_order: 1,
  archived: false,
};

// --- route helpers -----------------------------------------------------
//
// Same priority trick as tests/e2e/home.test.mjs: the broad catch-all guard
// is registered FIRST (lowest priority) and the narrow, per-endpoint
// handlers are registered AFTER it in each test (higher priority). Anything
// left over falls through to the guard, which records and aborts it.

// MANDATORY MECHANIC #2: every route() below is registered before the
// corresponding page.goto() in each test.

async function installGuard(page) {
  const unexpected = [];
  await page.route('**/rest/v1/**', async (route) => {
    unexpected.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort();
  });
  return unexpected;
}

// Handles all three methods trackable.js can issue against
// /rest/v1/trackables: GET (list, used to populate edit mode — js/api.js has
// no single-row-by-id read, so edit mode necessarily loads via the same list
// endpoint and finds the row client-side), POST (create), PATCH (update /
// archive). Returns arrays this test can assert request counts/bodies on.
async function routeTrackables(page, { getFixture = [], post = {}, patch = {} } = {}) {
  const postRequests = [];
  const patchRequests = [];

  await page.route('**/rest/v1/trackables*', async (route) => {
    const req = route.request();
    const method = req.method();

    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(getFixture),
      });
      return;
    }

    if (method === 'POST') {
      const bodyText = req.postData() || '';
      postRequests.push({ url: req.url(), headers: req.headers(), body: bodyText });
      if (post.delayMs) await new Promise((resolve) => setTimeout(resolve, post.delayMs));
      const status = post.status ?? 201;
      const respBody = post.body ?? [];
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(respBody),
      });
      return;
    }

    if (method === 'PATCH') {
      const bodyText = req.postData() || '';
      patchRequests.push({ url: req.url(), headers: req.headers(), body: bodyText });
      if (patch.delayMs) await new Promise((resolve) => setTimeout(resolve, patch.delayMs));
      const status = patch.status ?? 200;
      const respBody = patch.body ?? [];
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(respBody),
      });
      return;
    }

    // Not a method this step's contract uses — abort rather than let it
    // fall through to a real network call.
    await route.abort();
  });

  return { postRequests, patchRequests };
}

// Minimal entries handler — only needed by tests whose flow actually
// navigates to home (#/), which mounts js/views/home.js and triggers its own
// refresh sequence (store.loadTrackables + store.loadEntries). Tests that
// stay on the form never register this, so an unexpected entries call from
// the form itself would be caught by installGuard's catch-all instead of
// being silently swallowed here.
async function routeEntries(page, { getFixture = [] } = {}) {
  await page.route('**/rest/v1/entries*', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(getFixture),
      });
      return;
    }
    await route.abort();
  });
}

// --- DEFECT 1 visibility helpers (CONTRACT-2.4.md §3, §9.3) ---------------
//
// THE WHOLE REASON THIS DEFECT SHIPPED: every progressive-disclosure
// assertion in this file used to check the `hidden` ATTRIBUTE
// (toHaveJSProperty('hidden', true)) rather than actual rendered visibility.
// Those assertions passed even while, on the real device, the fields were
// plainly visible and tapping one raised the iOS keyboard — because
// `.tform-field { display: flex }` is an AUTHOR stylesheet rule, and an
// author rule always beats the browser's built-in `[hidden] { display:
// none }`, regardless of specificity. Setting `wrap.hidden = true` set the
// attribute; it did not hide anything on screen.
//
// Playwright's `toBeHidden()` / `toBeVisible()` check the element's
// COMPUTED STYLE (effectively: is it in the accessibility tree / does it
// have zero rendered box), which is what determines what a real user can
// see and tap — that is what actually would have caught this bug, and it
// is the BINDING assertion below. The `hidden` JS property is still
// checked alongside as a secondary/mechanism signal, but it must never be
// the only thing asserted again. Do NOT "simplify" these helpers back to
// attribute-only checks.
//
// Defence-in-depth (CONTRACT-2.4.md §3, fix half 2): every input/select/
// textarea/button inside a hidden `.tform-field` must also be `disabled` —
// a disabled control cannot be focused and cannot raise a keyboard even if
// the CSS rule that makes toBeHidden() pass is later deleted. `controls` is
// an array of selectors (scoped to `page`, e.g. `input[name="unit"]`) for
// every focusable control inside that field wrapper.

async function assertFieldHidden(page, field, controls) {
  const wrapper = page.locator(`.tform-field[data-field="${field}"]`);
  // BINDING: real, rendered invisibility.
  await expect(wrapper).toBeHidden();
  // Secondary signal only — never sufficient by itself (see comment above).
  await expect(wrapper).toHaveJSProperty('hidden', true);
  for (const selector of controls) {
    await expect(page.locator(selector)).toBeDisabled();
  }
}

async function assertFieldVisible(page, field, controls) {
  const wrapper = page.locator(`.tform-field[data-field="${field}"]`);
  await expect(wrapper).toBeVisible();
  await expect(wrapper).toHaveJSProperty('hidden', false);
  for (const selector of controls) {
    await expect(page.locator(selector)).toBeEnabled();
  }
}

// Selector(s) for the focusable control(s) inside each progressively-
// disclosed field wrapper, per CONTRACT-2.2.md §3.2's control column.
const FIELD_CONTROLS = {
  unit: ['input[name="unit"]'],
  aggregation: ['select[name="aggregation"]'],
  target_value: ['input[name="target_value"]'],
  bounds_enabled: ['input[name="bounds_enabled"]'],
  bounds_mode: ['select[name="bounds_mode"]'],
  bound_lower: ['input[name="bound_lower"]'],
  bound_upper: ['input[name="bound_upper"]'],
};

// ===========================================================================
// F1 — #/new renders the defaults
// ===========================================================================

test('F1 — #/new renders section.tform[data-mode="new"] with the §3.3 defaults; unit/aggregation/bounds_*/target_value are ACTUALLY HIDDEN (not just carrying the attribute) and their controls are disabled', async ({
  page,
}) => {
  const unexpected = await installGuard(page);

  await page.goto('/index.html#/new');

  const form = page.locator('section.tform');
  await expect(form).toHaveAttribute('data-mode', 'new');
  await expect(form).toHaveAttribute('data-state', 'ready');

  await expect(page.locator('input[name="name"]')).toHaveValue('');
  await expect(page.locator('input[name="value_shape"][value="boolean"]')).toBeChecked();
  await expect(page.locator('input[name="direction"][value="build"]')).toBeChecked();
  await expect(page.locator('select[name="target_type"]')).toHaveValue('none');
  await expect(page.locator('input[name="color"][value="#34c759"]')).toBeChecked();

  for (const field of ['unit', 'aggregation', 'bounds_enabled', 'bounds_mode', 'bound_lower', 'bound_upper', 'target_value']) {
    await assertFieldHidden(page, field, FIELD_CONTROLS[field]);
  }

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// F2 — shape toggling reveals/hides numeric-only fields
// ===========================================================================

test('F2 — selecting numeric reveals (actually shows, enabled) unit/aggregation/bounds_enabled; selecting boolean again actually re-hides and disables them', async ({
  page,
}) => {
  const unexpected = await installGuard(page);

  await page.goto('/index.html#/new');

  await page.locator('input[name="value_shape"][value="numeric"]').check();
  await assertFieldVisible(page, 'unit', FIELD_CONTROLS.unit);
  await assertFieldVisible(page, 'aggregation', FIELD_CONTROLS.aggregation);
  await assertFieldVisible(page, 'bounds_enabled', FIELD_CONTROLS.bounds_enabled);

  await page.locator('input[name="value_shape"][value="boolean"]').check();
  await assertFieldHidden(page, 'unit', FIELD_CONTROLS.unit);
  await assertFieldHidden(page, 'aggregation', FIELD_CONTROLS.aggregation);
  await assertFieldHidden(page, 'bounds_enabled', FIELD_CONTROLS.bounds_enabled);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// F3 — bounds progressive disclosure
// ===========================================================================

test('F3 — ticking bounds_enabled actually reveals bounds_mode; choosing manual actually reveals both bound inputs (enabled); choosing auto actually re-hides them (disabled)', async ({
  page,
}) => {
  const unexpected = await installGuard(page);

  await page.goto('/index.html#/new');
  await page.locator('input[name="value_shape"][value="numeric"]').check();

  await assertFieldHidden(page, 'bounds_mode', FIELD_CONTROLS.bounds_mode);

  await page.locator('input[name="bounds_enabled"]').check();
  await assertFieldVisible(page, 'bounds_mode', FIELD_CONTROLS.bounds_mode);
  await assertFieldHidden(page, 'bound_lower', FIELD_CONTROLS.bound_lower);
  await assertFieldHidden(page, 'bound_upper', FIELD_CONTROLS.bound_upper);

  await page.locator('select[name="bounds_mode"]').selectOption('manual');
  await assertFieldVisible(page, 'bound_lower', FIELD_CONTROLS.bound_lower);
  await assertFieldVisible(page, 'bound_upper', FIELD_CONTROLS.bound_upper);

  await page.locator('select[name="bounds_mode"]').selectOption('auto');
  await assertFieldHidden(page, 'bound_lower', FIELD_CONTROLS.bound_lower);
  await assertFieldHidden(page, 'bound_upper', FIELD_CONTROLS.bound_upper);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// CONTRACT-2.4.md DEFECT 3 — value_shape labels read the raw model words
// ===========================================================================

test('DEFECT3 — the value_shape radio labels read exactly "Boolean" and "Numeric" (CONTRACT-2.4.md §5 — a deliberate, field-specific override of the "never render the raw enum" rule; direction/aggregation keep their plain-English labels)', async ({
  page,
}) => {
  const unexpected = await installGuard(page);

  await page.goto('/index.html#/new');

  const booleanRadio = page.locator('input[name="value_shape"][value="boolean"]');
  const numericRadio = page.locator('input[name="value_shape"][value="numeric"]');
  const booleanId = await booleanRadio.getAttribute('id');
  const numericId = await numericRadio.getAttribute('id');
  expect(booleanId).toBeTruthy();
  expect(numericId).toBeTruthy();

  await expect(page.locator(`label[for="${booleanId}"]`)).toHaveText('Boolean');
  await expect(page.locator(`label[for="${numericId}"]`)).toHaveText('Numeric');

  // direction keeps its plain-English labels (unaffected by DEFECT 3).
  await expect(page.locator('.tform-field[data-field="direction"]')).toContainText('More is better');
  await expect(page.locator('.tform-field[data-field="direction"]')).toContainText('Less is better');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// CONTRACT-2.4.md DEFECT 4 — target_type options depend on value_shape
// ===========================================================================

test('DEFECT4a — selecting Numeric shows "Average per week" and hides "Times per week" in the target select; selecting Boolean shows the reverse', async ({
  page,
}) => {
  const unexpected = await installGuard(page);

  await page.goto('/index.html#/new');

  const targetSelect = page.locator('select[name="target_type"]');

  // Default mode is boolean: "Times per week" is offered, "Average per
  // week" (meaningless for a boolean) must not exist as an option at all.
  await expect(targetSelect.locator('option', { hasText: 'Times per week' })).toHaveCount(1);
  await expect(targetSelect.locator('option', { hasText: 'Average per week' })).toHaveCount(0);

  await page.locator('input[name="value_shape"][value="numeric"]').check();
  // "Times per week" is meaningless for a number like calories — it must
  // not be offered; "Average per week" replaces it.
  await expect(targetSelect.locator('option', { hasText: 'Average per week' })).toHaveCount(1);
  await expect(targetSelect.locator('option', { hasText: 'Times per week' })).toHaveCount(0);

  await page.locator('input[name="value_shape"][value="boolean"]').check();
  await expect(targetSelect.locator('option', { hasText: 'Times per week' })).toHaveCount(1);
  await expect(targetSelect.locator('option', { hasText: 'Average per week' })).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

test('DEFECT4b — switching Boolean -> Numeric while "Times per week" is selected resets target_type to "No target" and hides+disables target_value (illegal combination must never reach the database check constraint)', async ({
  page,
}) => {
  const unexpected = await installGuard(page);

  await page.goto('/index.html#/new');

  await page.locator('select[name="target_type"]').selectOption({ label: 'Times per week' });
  await assertFieldVisible(page, 'target_value', FIELD_CONTROLS.target_value);
  await page.locator('input[name="target_value"]').fill('3');

  await page.locator('input[name="value_shape"][value="numeric"]').check();

  await expect(page.locator('select[name="target_type"]')).toHaveValue('none');
  await assertFieldHidden(page, 'target_value', FIELD_CONTROLS.target_value);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// CONTRACT-2.4.md DEFECT 6 — the selected colour swatch is visibly selected
// ===========================================================================

test('DEFECT6 — selecting a colour swatch marks its radio checked (and the previously-selected swatch is no longer checked)', async ({
  page,
}) => {
  const unexpected = await installGuard(page);

  await page.goto('/index.html#/new');

  const defaultSwatch = page.locator('input[name="color"][value="#34c759"]');
  await expect(defaultSwatch).toBeChecked();

  const targetSwatch = page.locator('input[name="color"][value="#3478f6"]');
  const targetId = await targetSwatch.getAttribute('id');
  expect(targetId).toBeTruthy();
  // §8: the radio itself stays "focusable-but-visually-collapsed" — its
  // <label> (the visible circle) is the real tap target, same as every
  // other radio group in this form (see the for/id label association
  // required by §3.8). Click the label, not the (possibly zero-size) input.
  await page.locator(`label[for="${targetId}"]`).click();

  await expect(targetSwatch).toBeChecked();
  await expect(defaultSwatch).not.toBeChecked();

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// F4 — empty name validation
// ===========================================================================

test('F4 — submitting with an empty name issues zero requests and shows exactly "Name is required"', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const { postRequests } = await routeTrackables(page, { getFixture: [] });

  await page.goto('/index.html#/new');
  await page.locator('.tform-save').click();

  await expect(page.locator('p.tform-error[role="alert"]')).toHaveText('Name is required');
  expect(postRequests.length).toBe(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// F5 — target validation
// ===========================================================================

test('F5 — target_type "weekly_count" with target_value "0" shows exactly the target message, zero requests', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const { postRequests } = await routeTrackables(page, { getFixture: [] });

  await page.goto('/index.html#/new');
  await page.locator('input[name="name"]').fill('Reading');
  await page.locator('select[name="target_type"]').selectOption('weekly_count');
  await page.locator('input[name="target_value"]').fill('0');
  await page.locator('.tform-save').click();

  await expect(page.locator('p.tform-error[role="alert"]')).toHaveText(
    'Target must be a number greater than 0'
  );
  expect(postRequests.length).toBe(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// F6 — bounds order validation
// ===========================================================================

test('F6 — manual bounds with lower 10 and upper 5 shows exactly the bounds-order message, zero requests', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const { postRequests } = await routeTrackables(page, { getFixture: [] });

  await page.goto('/index.html#/new');
  await page.locator('input[name="name"]').fill('Weight');
  await page.locator('input[name="value_shape"][value="numeric"]').check();
  await page.locator('input[name="bounds_enabled"]').check();
  await page.locator('select[name="bounds_mode"]').selectOption('manual');
  await page.locator('input[name="bound_lower"]').fill('10');
  await page.locator('input[name="bound_upper"]').fill('5');
  await page.locator('.tform-save').click();

  await expect(page.locator('p.tform-error[role="alert"]')).toHaveText(
    'Lower bound must be less than upper bound'
  );
  expect(postRequests.length).toBe(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// F7 — boolean save payload (HIGHEST-VALUE assertion in this step)
// ===========================================================================

test('F7 — a valid boolean save POSTs a body containing relog_semantic:"state"/aggregation:"count" and OMITTING unit/bounds_*/id/sort_order', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const { postRequests } = await routeTrackables(page, {
    getFixture: [],
    post: {
      body: [
        {
          id: 900,
          name: 'Workout',
          value_shape: 'boolean',
          relog_semantic: 'state',
          aggregation: 'count',
          direction: 'build',
          target_type: 'none',
          color: '#34c759',
          archived: false,
          sort_order: 0,
        },
      ],
    },
  });
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/new');
  await page.locator('input[name="name"]').fill('Workout');
  await page.locator('.tform-save').click();

  // Wait for the save + navigation to complete before inspecting the
  // recorded request — the click itself does not await the network call.
  await expect(page).toHaveURL(/#\/$/);

  expect(postRequests.length).toBe(1);
  const body = JSON.parse(postRequests[0].body);
  const keys = Object.keys(body);

  // Presence, asserted first.
  expect(body.relog_semantic).toBe('state');
  expect(body.aggregation).toBe('count');

  // Absence, asserted explicitly on the KEY LIST — not just "value is
  // falsy" — because a stray `unit: ''` on a boolean is exactly the bug
  // this test exists to catch, and `'unit' in body` would miss that.
  // 'archived' is included here for the same reason: buildPayload used to
  // unconditionally send `archived: false`, which — because the edit-save
  // handler PATCHes buildPayload's output straight through — meant saving
  // an archived trackable's edit form silently un-archived it. The form
  // has no archived control, so the key must never appear at all.
  for (const forbidden of ['unit', 'bounds_enabled', 'bounds_mode', 'bound_lower', 'bound_upper', 'id', 'sort_order', 'archived']) {
    expect(keys).not.toContain(forbidden);
  }

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// F8 — numeric save payload
// ===========================================================================

test('F8 — a valid numeric save includes unit and aggregation:"sum"', async ({ page }) => {
  const unexpected = await installGuard(page);
  const { postRequests } = await routeTrackables(page, {
    getFixture: [],
    post: {
      body: [
        {
          id: 901,
          name: 'Calories',
          value_shape: 'numeric',
          relog_semantic: 'state',
          aggregation: 'sum',
          direction: 'break',
          unit: 'kcal',
          target_type: 'none',
          color: '#34c759',
          archived: false,
          sort_order: 0,
        },
      ],
    },
  });
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/new');
  await page.locator('input[name="name"]').fill('Calories');
  await page.locator('input[name="value_shape"][value="numeric"]').check();
  await page.locator('input[name="unit"]').fill('kcal');
  await page.locator('.tform-save').click();

  await expect(page).toHaveURL(/#\/$/);

  expect(postRequests.length).toBe(1);
  const body = JSON.parse(postRequests[0].body);
  expect(body.unit).toBe('kcal');
  expect(body.aggregation).toBe('sum');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// F9 — successful save navigates home
// ===========================================================================

test('F9 — after a successful save the hash becomes #/ and the home view renders', async ({ page }) => {
  const unexpected = await installGuard(page);
  const { postRequests } = await routeTrackables(page, {
    getFixture: [],
    post: {
      body: [
        {
          id: 902,
          name: 'Workout',
          value_shape: 'boolean',
          relog_semantic: 'state',
          aggregation: 'count',
          direction: 'build',
          target_type: 'none',
          color: '#34c759',
          archived: false,
          sort_order: 0,
        },
      ],
    },
  });
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/new');
  await page.locator('input[name="name"]').fill('Workout');
  await page.locator('.tform-save').click();

  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator('section.home')).toBeVisible();

  expect(postRequests.length).toBe(1);
  expect(unexpected).toEqual([]);
});

// ===========================================================================
// F10 — failed save keeps the form mounted
// ===========================================================================

test('F10 — a failed save (500) keeps the form mounted, shows an error, and does not navigate away; the typed name survives', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const { postRequests } = await routeTrackables(page, {
    getFixture: [],
    post: { status: 500, body: { message: 'internal error' } },
  });

  await page.goto('/index.html#/new');
  await page.locator('input[name="name"]').fill('Workout');
  await page.locator('.tform-save').click();

  await expect(page.locator('p.tform-error[role="alert"]')).toBeVisible();
  await expect(page.locator('section.tform')).toHaveCount(1);
  await expect(page.locator('input[name="name"]')).toHaveValue('Workout');
  // Must NOT have navigated away — the hash stays #/new, never becomes #/.
  await expect(page).not.toHaveURL(/#\/$/);
  await expect(page).toHaveURL(/#\/new$/);

  expect(postRequests.length).toBe(1);
  expect(unexpected).toEqual([]);
});

// ===========================================================================
// F11 — edit mode load
// ===========================================================================

test('F11 — #/t/366/edit loads that trackable and populates the name input', async ({ page }) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, { getFixture: [T1, T366] });

  await page.goto('/index.html#/t/366/edit');

  const form = page.locator('section.tform');
  await expect(form).toHaveAttribute('data-mode', 'edit');
  await expect(page.locator('input[name="name"]')).toHaveValue('Weight');

  expect(unexpected).toEqual([]);
});

test('F11b — #/t/99999/edit (an id that does not exist) renders data-state="notfound" with a link back to #/', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, { getFixture: [T1, T366] });

  await page.goto('/index.html#/t/99999/edit');

  await expect(page.locator('section.tform')).toHaveAttribute('data-state', 'notfound');
  await expect(page.locator('section.tform a[href="#/"]')).toBeVisible();

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// F12 — two-step archive flow
// ===========================================================================

test('F12 — Archive is two-step: first click issues zero requests and shows the confirm box; Cancel issues zero requests and restores the button; Confirm PATCHes archived:true and navigates home', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  const { patchRequests } = await routeTrackables(page, {
    getFixture: [T1, T366],
    patch: { body: [{ ...T366, archived: true }] },
  });
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/t/366/edit');
  await expect(page.locator('input[name="name"]')).toHaveValue('Weight');

  const archiveBtn = page.locator('button.tform-archive');
  await expect(archiveBtn).toBeVisible();

  // First click: zero requests, confirm box appears.
  await archiveBtn.click();
  expect(patchRequests.length).toBe(0);
  const confirmBox = page.locator('div.tform-confirm-archive');
  await expect(confirmBox).toBeVisible();
  await expect(confirmBox).toContainText(
    'Archive this trackable? It will be hidden from Home but its history is kept.'
  );
  await expect(confirmBox.locator('button.tform-archive-confirm')).toHaveText('Archive');
  await expect(confirmBox.locator('button.tform-archive-cancel')).toHaveText('Cancel');

  // Cancel: zero requests, button restored, confirm box gone.
  await confirmBox.locator('button.tform-archive-cancel').click();
  expect(patchRequests.length).toBe(0);
  await expect(page.locator('button.tform-archive')).toBeVisible();
  await expect(page.locator('div.tform-confirm-archive')).toHaveCount(0);

  // Second time through: only the CONFIRM button issues the request.
  await page.locator('button.tform-archive').click();
  await page.locator('button.tform-archive-confirm').click();

  await expect(page).toHaveURL(/#\/$/);
  expect(patchRequests.length).toBe(1);
  const body = JSON.parse(patchRequests[0].body);
  // js/api.js's archiveTrackable(id) (unmodified by this step) calls
  // updateTrackable(id, { archived: true }) — the PATCH body is exactly
  // that single key, not a partial form dump.
  expect(body).toEqual({ archived: true });
  expect(patchRequests[0].url).toContain('id=eq.366');

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// F13 — no create-mode archive, no hard delete anywhere
// ===========================================================================

test('F13 — #/new has no .tform-archive button, and no .tform-delete button exists on either form (hard delete deliberately not shipped)', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, { getFixture: [T1, T366] });

  await page.goto('/index.html#/new');
  await expect(page.locator('.tform-archive')).toHaveCount(0);
  await expect(page.locator('.tform-delete')).toHaveCount(0);

  await page.goto('/index.html#/t/366/edit');
  await expect(page.locator('input[name="name"]')).toHaveValue('Weight');
  await expect(page.locator('.tform-delete')).toHaveCount(0);

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// F14 — entry points: home "New trackable" link, detail placeholder "Edit" link
// ===========================================================================

// Repointed for Step 2.3: the old assertion ("detail placeholder shows
// a[href=#/t/42/edit]") tested the Step 2.2 static placeholder, which is
// gone — js/main.js now mounts the real js/views/detail.js for the
// 'detail' route. The home half of this test ("home shows a.home-new")
// still holds unchanged. For the detail half, the real edit link only
// renders once the view reaches its 'ready' state (js/views/detail.js:
// the 'notfound' state renders just a link back to '#/'), so this now
// navigates to a trackable id (1, T1) that actually exists in this test's
// fixture, and asserts the real `a.detail-edit` element and its
// '#/t/<id>/edit' href — confirmed against js/views/detail.js's render()
// (class 'detail-edit', href `#/t/${id}/edit`) before writing this.
test('F14 — home shows a.home-new[href="#/new"] for a non-empty list, and the detail view shows a.detail-edit[href="#/t/1/edit"]', async ({
  page,
}) => {
  const unexpected = await installGuard(page);
  await routeTrackables(page, { getFixture: [T1] });
  await routeEntries(page, { getFixture: [] });

  await page.goto('/index.html#/');
  await expect(page.locator('a.home-new[href="#/new"]')).toBeVisible();

  await page.goto('/index.html#/t/1');
  await expect(page.locator('section.detail')).toHaveAttribute('data-detail-state', 'ready');
  await expect(page.locator('a.detail-edit[href="#/t/1/edit"]')).toBeVisible();

  expect(unexpected).toEqual([]);
});

// ===========================================================================
// F15 — no uncaught errors, no horizontal scroll, tap targets
// ===========================================================================

test('F15 — no uncaught page errors, no horizontal scroll at 390px, and every .tform-save/.tform-archive is >=44px tall', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err));

  const unexpected = await installGuard(page);
  await routeTrackables(page, { getFixture: [T1, T366] });

  await page.goto('/index.html#/t/366/edit');
  await expect(page.locator('input[name="name"]')).toHaveValue('Weight');

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);

  const targets = page.locator('.tform-save, .tform-archive');
  const count = await targets.count();
  expect(count).toBeGreaterThan(0);
  const heights = await targets.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  for (const h of heights) {
    expect(h).toBeGreaterThanOrEqual(44);
  }

  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
});
