// Settings screen (Step 4.1, CONTRACT-4.1.md §4). Hosts three things that
// all belong "somewhere global" rather than on any one trackable's own
// screen: the rolling-window preference that drives every auto bounds band
// app-wide, trackable reordering + archived-trackable Unarchive, and the
// Sign out control that Step D.7 parked on a main.js placeholder (moved
// here verbatim in spirit — see handleSignOutClick() below).
//
// This file exports two kinds of things, same split as js/views/detail.js:
//   1. PURE pieces (WINDOW_MIN, WINDOW_MAX, parseWindowDays, reorderPlan) —
//      no DOM, no fetch, no localStorage. A separate agent unit-tests these
//      in Node with no DOM, so nothing above the "DOM + network wiring"
//      section may touch `document`, `fetch` or `localStorage`.
//   2. `createSettingsView(...)`, the DOM + store wiring, following the
//      same view lifecycle as every other view in js/views/: idempotent
//      mount, synchronous unmount, a `disposed` flag checked after every
//      await, exactly one delegated listener per event type on the root,
//      and no exception ever escapes a handler.

import { getStore } from '../store.js';
import { getAuth } from '../auth.js';
import { todayLocal } from '../dates.js';
import { visibleTrackables } from './home-model.js';
// Step 4.2 (CONTRACT-4.2.md §2): the CSV builder/delivery pieces live in
// their own leaf-ish module (js/export-csv.js) rather than here — its pure
// half (exportRows/buildCsv/exportFilename) is unit-tested with no DOM at
// all, and deliverCsv() is the one function in this whole screen that
// touches navigator/Blob/File/URL.
import { exportRows, buildCsv, exportFilename, deliverCsv } from '../export-csv.js';
// Step 5.1 addition: the account block shows the active service worker's
// CACHE name, sourced through requestAppVersion() — a human-checkable
// confirmation that a deploy's new worker actually took over. See that
// function's own comment in net-status.js for why it lives there.
import { requestAppVersion } from '../net-status.js';

// =============================================================================
// PURE EXPORTS — no DOM, no fetch, no localStorage. Keep it that way; a
// separate agent unit-tests these in Node with no DOM available.
// =============================================================================

// The DB check constraint's own range (CONTRACT-4.1.md §0 rule 6) — a whole
// number from 14 to 730, both inclusive.
export const WINDOW_MIN = 14;
export const WINDOW_MAX = 730;

// Rule (CONTRACT-4.1.md §4): after trim, the text must match /^\d+$/ (no
// sign, no decimal point, no exponent, no thousands separator) and parse to
// an integer within [WINDOW_MIN, WINDOW_MAX]. Deliberately stricter than
// home-model.js#parseNumericInput — a day COUNT has none of that function's
// reasons to accept a decimal or a comma. Never throws.
const WHOLE_NUMBER_RE = /^\d+$/;

export function parseWindowDays(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!WHOLE_NUMBER_RE.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < WINDOW_MIN || n > WINDOW_MAX) return null;
  return n;
}

// Reordering (CONTRACT-4.1.md §0 rule 4): Up/Down buttons per visible
// trackable; each move renumbers the visible list 0..n-1 and PATCHes only
// rows whose sort_order actually changed (normally two, but a list whose
// existing sort_orders are sparse — e.g. 0, 5, 9 — is renumbered densely,
// which can touch every row). `visible` is assumed to already be in display
// order (as from home-model.js#visibleTrackables); this function does not
// re-sort it. Never throws: a non-array `visible`, an unknown `id`, moving
// the first item up, or moving the last item down all yield [].
export function reorderPlan(visible, id, direction) {
  if (!Array.isArray(visible)) return [];

  const idStr = String(id);
  const idx = visible.findIndex((t) => t && String(t.id) === idStr);
  if (idx === -1) return [];

  const swapWith = direction === 'up' ? idx - 1 : direction === 'down' ? idx + 1 : -1;
  if (swapWith < 0 || swapWith >= visible.length) return [];

  const reordered = visible.slice();
  const tmp = reordered[idx];
  reordered[idx] = reordered[swapWith];
  reordered[swapWith] = tmp;

  const patches = [];
  reordered.forEach((t, position) => {
    if (!t) return;
    if (t.sort_order !== position) {
      patches.push({ id: String(t.id), sort_order: position });
    }
  });
  return patches;
}

// =============================================================================
// DOM + network wiring
// =============================================================================

const WINDOW_SAVE_ERROR = 'Could not save. Check your connection and try again.';
const WINDOW_VALIDATION_ERROR = 'Enter a whole number from 14 to 730.';
const WINDOW_LOAD_ERROR = 'Could not load settings.';
const ORDER_SAVE_ERROR = 'Could not save. Check your connection and try again.';
const OFFLINE_TEXT = 'You appear to be offline — showing the last saved data.';
// Step 4.2 (CONTRACT-4.2.md §2).
const EXPORT_LOAD_ERROR = 'Could not load your data. Check your connection and try again.';
const EXPORT_FALLBACK_HELP = 'Your browser did not offer a download. Select all, copy, and paste into a file.';

export function createSettingsView({ store, auth, today } = {}) {
  const st = store || getStore();
  const au = auth || getAuth();
  // Step 4.2: `today` is now actually used, by exportFilename() — injected
  // per the interface contract, same as ./detail.js's `today`, so tests can
  // pin the date in an exported filename without mocking the clock.
  const day = today || todayLocal();

  let container = null;
  let sectionEl = null;
  let disposed = true;

  // Built once in ensureSection()/buildWindowBlock() and never recreated —
  // see buildWindowBlock()'s own comment for why (js/views/signin.js's
  // build-once form is the pattern being followed here).
  let windowBlockEl = null;
  let windowFormEl = null;
  let windowInput = null;
  let windowSaveBtn = null;
  let windowStatusP = null;
  let windowErrorP = null;

  let trackablesLoaded = false;
  let lastTrackablesError = null;
  let lastSettingsError = null;

  // What the user has typed but not yet (successfully) saved. null means
  // "never typed anything this mount" — only then does render() overwrite
  // the input from the loaded setting (CONTRACT-4.1.md §4's "the input is
  // set from the loaded value only when the draft is null ... or right
  // after a successful save").
  let draft = null;
  let windowStatus = ''; // '' | 'Saving…' | 'Saved.'
  let windowError = null; // string | null
  let savingWindow = false;

  // Order/archived actions share one busy flag (CONTRACT-4.1.md §0 rule 4
  // covers both under "every move/unarchive button disabled while busy").
  let busy = false;
  let settingsError = null; // last move/unarchive failure, or null

  let signoutWarningText = '';

  // Step 5.1 addition. `appVersionKnown` starts false so the paragraph is
  // simply absent until requestAppVersion() settles (mount() fires it after
  // the first render, without awaiting it — see mount() below); `null` in
  // appVersionCache after that means "settled but unknown" (no controller,
  // or the worker never answered), distinct from "hasn't settled yet".
  let appVersionKnown = false;
  let appVersionCache = null;

  // Step 4.2 (CONTRACT-4.2.md §2). Shares `busy` above with reorder/
  // unarchive (both kinds of action are mutually exclusive on this
  // screen). The three pieces of export state survive re-renders (kept
  // here, re-applied by buildExportBlock() on every render) rather than
  // living only inside the handler's local scope, since the block is
  // rebuilt from scratch every render like order/archived/account.
  let exportStatus = ''; // '' | 'Preparing…' | `Exported ${n} rows.` | 'Export cancelled.' | 'Nothing to export.'
  let exportError = null; // string | null
  let exportFallbackText = null; // the CSV text, only non-null after a 'fallback' outcome

  // --- render ----------------------------------------------------------

  // Built exactly once per mounted instance (CONTRACT-4.1.md §4): the
  // window form's input must never be recreated, or a re-render mid-typing
  // (e.g. from the delegated 'input' listener triggering nothing, or from
  // an unrelated async load landing) would wipe the cursor position and
  // whatever the user had just typed — same reasoning as
  // js/views/signin.js's buildForm().
  function buildWindowBlock(section) {
    const block = document.createElement('section');
    block.className = 'settings-block';
    block.dataset.block = 'window';

    const h3 = document.createElement('h3');
    h3.className = 'settings-title';
    h3.textContent = 'Rolling window';
    block.appendChild(h3);

    const help = document.createElement('p');
    help.className = 'settings-help';
    help.textContent =
      'Automatic bands use the 10th–90th percentile of the last N days. Between 14 and 730.';
    block.appendChild(help);

    const form = document.createElement('form');
    form.className = 'settings-window-form';
    form.setAttribute('novalidate', '');

    const label = document.createElement('label');
    label.className = 'settings-field';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'settings-label';
    labelSpan.textContent = 'Days';
    label.appendChild(labelSpan);

    windowInput = document.createElement('input');
    windowInput.className = 'settings-window-input';
    windowInput.type = 'text';
    windowInput.setAttribute('inputmode', 'numeric');
    windowInput.name = 'rolling_window_days';
    windowInput.setAttribute('autocomplete', 'off');
    label.appendChild(windowInput);
    form.appendChild(label);

    windowSaveBtn = document.createElement('button');
    windowSaveBtn.type = 'submit';
    windowSaveBtn.className = 'settings-window-save';
    windowSaveBtn.textContent = 'Save';
    form.appendChild(windowSaveBtn);

    block.appendChild(form);
    windowFormEl = form;

    windowStatusP = document.createElement('p');
    windowStatusP.className = 'settings-window-status';
    windowStatusP.setAttribute('role', 'status');
    block.appendChild(windowStatusP);

    windowErrorP = document.createElement('p');
    windowErrorP.className = 'settings-window-error';
    windowErrorP.setAttribute('role', 'alert');
    block.appendChild(windowErrorP);

    section.appendChild(block);
    windowBlockEl = block;
  }

  // Applies current state onto the window block's persistent elements.
  // Deliberately never touches windowInput.value except in the one case
  // documented on `draft` above.
  function updateWindowBlock() {
    const settings = st.getSettings();

    if (draft === null) {
      windowInput.value = settings ? String(settings.rolling_window_days) : '';
    }

    windowSaveBtn.disabled = settings === null || savingWindow;
    windowStatusP.textContent = windowStatus;
    windowErrorP.hidden = windowError === null;
    windowErrorP.textContent = windowError === null ? '' : windowError;
  }

  function buildOrderBlock() {
    const block = document.createElement('section');
    block.className = 'settings-block';
    block.dataset.block = 'order';

    const h3 = document.createElement('h3');
    h3.className = 'settings-title';
    h3.textContent = 'Order';
    block.appendChild(h3);

    const visible = visibleTrackables(st.getTrackables());

    if (visible.length === 0) {
      const emptyP = document.createElement('p');
      emptyP.className = 'settings-order-empty';
      emptyP.textContent = 'No trackables yet.';
      block.appendChild(emptyP);
      return block;
    }

    const ol = document.createElement('ol');
    ol.className = 'settings-order';
    visible.forEach((t, i) => {
      const idStr = String(t.id);

      const li = document.createElement('li');
      li.className = 'settings-order-item';
      li.dataset.id = idStr;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'settings-order-name';
      nameSpan.textContent = typeof t.name === 'string' ? t.name : '';
      li.appendChild(nameSpan);

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'settings-move';
      upBtn.dataset.action = 'move-up';
      upBtn.dataset.id = idStr;
      upBtn.setAttribute('aria-label', 'Move up');
      upBtn.disabled = busy || i === 0;
      upBtn.textContent = '↑'; // UPWARDS ARROW
      li.appendChild(upBtn);

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'settings-move';
      downBtn.dataset.action = 'move-down';
      downBtn.dataset.id = idStr;
      downBtn.setAttribute('aria-label', 'Move down');
      downBtn.disabled = busy || i === visible.length - 1;
      downBtn.textContent = '↓'; // DOWNWARDS ARROW
      li.appendChild(downBtn);

      ol.appendChild(li);
    });
    block.appendChild(ol);
    return block;
  }

  function buildArchivedBlock() {
    const block = document.createElement('section');
    block.className = 'settings-block';
    block.dataset.block = 'archived';

    const h3 = document.createElement('h3');
    h3.className = 'settings-title';
    h3.textContent = 'Archived';
    block.appendChild(h3);

    const all = st.getTrackables();
    const archived = (Array.isArray(all) ? all : []).filter(
      (t) => t && typeof t === 'object' && t.archived === true
    );

    if (archived.length === 0) {
      const emptyP = document.createElement('p');
      emptyP.className = 'settings-archived-empty';
      emptyP.textContent = 'Nothing archived.';
      block.appendChild(emptyP);
      return block;
    }

    const ul = document.createElement('ul');
    ul.className = 'settings-archived';
    for (const t of archived) {
      const idStr = String(t.id);

      const li = document.createElement('li');
      li.className = 'settings-archived-item';
      li.dataset.id = idStr;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'settings-archived-name';
      nameSpan.textContent = typeof t.name === 'string' ? t.name : '';
      li.appendChild(nameSpan);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-unarchive';
      btn.dataset.action = 'unarchive';
      btn.dataset.id = idStr;
      btn.disabled = busy;
      btn.textContent = 'Unarchive';
      li.appendChild(btn);

      ul.appendChild(li);
    }
    block.appendChild(ul);
    return block;
  }

  // Step 4.2 (CONTRACT-4.2.md §2): "Export everything" plus one "Export"
  // button per NON-archived trackable (an archived trackable is only ever
  // reachable through "everything" — see handleExportAll()/exportRows()'s
  // own archived-rows-after-visible ordering). Rebuilt fresh every render,
  // same as order/archived/account — the status/error/fallback lines are
  // driven entirely by the module-level state above, not by anything the
  // textarea itself holds (a fresh textarea with the same .value on every
  // render is indistinguishable from a persistent one here, since nothing
  // types into it).
  function buildExportBlock() {
    const block = document.createElement('section');
    block.className = 'settings-block';
    block.dataset.block = 'export';

    const h3 = document.createElement('h3');
    h3.className = 'settings-title';
    h3.textContent = 'Export';
    block.appendChild(h3);

    const help = document.createElement('p');
    help.className = 'settings-help';
    help.textContent = 'A CSV with one row per logged day: trackable, unit, date, value, note, source.';
    block.appendChild(help);

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'settings-export-all';
    allBtn.dataset.action = 'export-all';
    allBtn.disabled = busy;
    allBtn.textContent = 'Export everything (CSV)';
    block.appendChild(allBtn);

    const visible = visibleTrackables(st.getTrackables());
    if (visible.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'settings-export-list';
      for (const t of visible) {
        const idStr = String(t.id);

        const li = document.createElement('li');
        li.className = 'settings-export-item';
        li.dataset.id = idStr;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'settings-export-name';
        nameSpan.textContent = typeof t.name === 'string' ? t.name : '';
        li.appendChild(nameSpan);

        const oneBtn = document.createElement('button');
        oneBtn.type = 'button';
        oneBtn.className = 'settings-export-one';
        oneBtn.dataset.action = 'export-one';
        oneBtn.dataset.id = idStr;
        oneBtn.disabled = busy;
        oneBtn.textContent = 'Export';
        li.appendChild(oneBtn);

        ul.appendChild(li);
      }
      block.appendChild(ul);
    }

    const statusP = document.createElement('p');
    statusP.className = 'settings-export-status';
    statusP.setAttribute('role', 'status');
    statusP.textContent = exportStatus;
    block.appendChild(statusP);

    const errorP = document.createElement('p');
    errorP.className = 'settings-export-error';
    errorP.setAttribute('role', 'alert');
    errorP.hidden = exportError === null;
    errorP.textContent = exportError === null ? '' : exportError;
    block.appendChild(errorP);

    const fallbackDiv = document.createElement('div');
    fallbackDiv.className = 'settings-export-fallback';
    fallbackDiv.hidden = exportFallbackText === null;

    const fallbackHelp = document.createElement('p');
    fallbackHelp.className = 'settings-help';
    fallbackHelp.textContent = EXPORT_FALLBACK_HELP;
    fallbackDiv.appendChild(fallbackHelp);

    const textarea = document.createElement('textarea');
    textarea.className = 'settings-export-text';
    textarea.readOnly = true;
    textarea.setAttribute('aria-label', 'CSV export');
    textarea.value = exportFallbackText === null ? '' : exportFallbackText;
    fallbackDiv.appendChild(textarea);

    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'settings-export-select';
    selectBtn.dataset.action = 'export-select';
    selectBtn.textContent = 'Select all';
    fallbackDiv.appendChild(selectBtn);

    block.appendChild(fallbackDiv);
    return block;
  }

  // Step D.7's sign-out block, moved here unchanged in DOM/texts — see
  // handleSignOutClick() below for the moved logic. Rebuilt fresh every
  // render (unlike the window block above) because nothing here holds live
  // user input; `signoutWarningText` is the one piece of state that used to
  // live directly on a persistent DOM node in main.js and now lives here
  // instead, since this block no longer survives across renders.
  function buildAccountBlock() {
    const block = document.createElement('section');
    block.className = 'settings-block';
    block.dataset.block = 'account';

    const session = au.getSession();
    const email = session && session.user && session.user.email ? session.user.email : 'unknown';

    const asP = document.createElement('p');
    asP.className = 'signin-as';
    asP.appendChild(document.createTextNode('Signed in as '));
    const emailSpan = document.createElement('span');
    emailSpan.className = 'signin-email';
    emailSpan.textContent = email;
    asP.appendChild(emailSpan);
    block.appendChild(asP);

    const warningP = document.createElement('p');
    warningP.className = 'signout-warning';
    warningP.hidden = signoutWarningText === '';
    warningP.textContent = signoutWarningText;
    block.appendChild(warningP);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'signout';
    btn.id = 'signout-btn';
    btn.textContent = 'Sign out';
    block.appendChild(btn);

    // Step 5.1 addition: absent until requestAppVersion() settles (see
    // `appVersionKnown`'s comment above), then either the running cache
    // name or an explicit "unknown" — never left blank, since a blank
    // paragraph reads as a loading state that never resolves.
    if (appVersionKnown) {
      const versionP = document.createElement('p');
      versionP.className = 'settings-version';
      versionP.textContent = appVersionCache ? `App version ${appVersionCache}` : 'App version unknown';
      block.appendChild(versionP);
    }

    return block;
  }

  function buildSettingsErrorP() {
    const p = document.createElement('p');
    p.className = 'settings-error';
    p.setAttribute('role', 'alert');
    p.textContent = ORDER_SAVE_ERROR;
    return p;
  }

  function buildOfflineP() {
    const p = document.createElement('p');
    p.className = 'detail-offline';
    p.textContent = OFFLINE_TEXT;
    return p;
  }

  function ensureSection() {
    if (sectionEl) return sectionEl;
    sectionEl = document.createElement('section');
    sectionEl.className = 'settings';
    // Exactly one delegated listener per event type on this root, attached
    // once here and removed in unmount() — same rule as every other view.
    sectionEl.addEventListener('click', handleClick);
    sectionEl.addEventListener('submit', handleSubmit);
    sectionEl.addEventListener('input', handleInput);
    container.appendChild(sectionEl);
    buildWindowBlock(sectionEl);
    return sectionEl;
  }

  function render() {
    if (disposed || !container) return;

    const section = ensureSection();
    section.setAttribute('data-settings-state', trackablesLoaded ? 'ready' : 'loading');

    updateWindowBlock();

    // Everything after the window block is cheap to rebuild wholesale on
    // every render — none of it holds live user input (contrast the window
    // block above, which does and must never be recreated).
    while (windowBlockEl.nextSibling) {
      section.removeChild(windowBlockEl.nextSibling);
    }

    section.appendChild(buildOrderBlock());
    section.appendChild(buildArchivedBlock());
    section.appendChild(buildExportBlock());
    section.appendChild(buildAccountBlock());

    if (settingsError !== null) {
      section.appendChild(buildSettingsErrorP());
    }

    if (lastTrackablesError !== null || lastSettingsError !== null) {
      section.appendChild(buildOfflineP());
    }
  }

  // --- actions -----------------------------------------------------------

  function submitWindowForm() {
    if (windowSaveBtn.disabled) return;

    const n = parseWindowDays(windowInput.value);
    if (n === null) {
      windowStatus = '';
      windowError = WINDOW_VALIDATION_ERROR;
      render();
      return;
    }

    savingWindow = true;
    windowStatus = 'Saving…';
    windowError = null;
    render();

    st.saveSettings({ rolling_window_days: n })
      .then((result) => {
        if (disposed) return;
        savingWindow = false;
        if (result.status === 'saved') {
          windowStatus = 'Saved.';
          windowError = null;
          draft = null;
        } else {
          windowStatus = '';
          windowError = WINDOW_SAVE_ERROR;
        }
        render();
      })
      .catch(() => {
        // saveSettings() is documented never to reject; this guard only
        // protects against that invariant ever drifting.
        if (disposed) return;
        savingWindow = false;
        windowStatus = '';
        windowError = WINDOW_SAVE_ERROR;
        render();
      });
  }

  async function handleMove(id, direction) {
    if (busy) return;

    const visible = visibleTrackables(st.getTrackables());
    const patches = reorderPlan(visible, id, direction);
    if (patches.length === 0) return;

    busy = true;
    settingsError = null;
    render();

    for (const patch of patches) {
      const result = await st.updateTrackable(patch.id, { sort_order: patch.sort_order });
      if (disposed) return;
      if (result.status === 'failed') {
        settingsError = ORDER_SAVE_ERROR;
        break;
      }
    }

    if (disposed) return;
    // Resync regardless of outcome — see CONTRACT-4.1.md §4's "for each
    // patch in order ... on the first 'failed' set the settings error,
    // stop, THEN await st.loadTrackables(...) to resync".
    const reload = await st.loadTrackables({ includeArchived: true });
    if (disposed) return;
    lastTrackablesError = reload.error;
    busy = false;
    render();
  }

  async function handleUnarchive(id) {
    if (busy) return;

    busy = true;
    settingsError = null;
    render();

    const result = await st.updateTrackable(id, { archived: false });
    if (disposed) return;
    if (result.status === 'failed') {
      settingsError = ORDER_SAVE_ERROR;
    }
    busy = false;
    render();
  }

  // Step 4.2 (CONTRACT-4.2.md §2). Shares `busy` with reorder/unarchive —
  // ignored while any of those is in flight, and sets `busy` for its own
  // duration so those, in turn, are disabled while an export runs.
  async function handleExportAll() {
    if (busy) return;

    busy = true;
    exportStatus = 'Preparing…';
    exportError = null;
    exportFallbackText = null;
    render();

    // "Everything" means the whole history of every trackable — an
    // unfiltered loadEntries() (js/store.js) pages through every entry the
    // account owns, not just what happens to already be cached.
    const result = await st.loadEntries({});
    if (disposed) return;
    if (result.error !== null) {
      // A partial CSV built from a stale cache would be silently wrong in
      // a way the user has no way to notice — refuse instead.
      exportError = EXPORT_LOAD_ERROR;
      exportStatus = '';
      busy = false;
      render();
      return;
    }

    const trackables = st.getTrackables();
    const entries = st.getEntries({});
    const rows = exportRows({ trackables, entries });
    if (rows.length === 0) {
      exportStatus = 'Nothing to export.';
      busy = false;
      render();
      return;
    }

    const text = buildCsv({ trackables, entries });
    const filename = exportFilename({ today: day, trackable: null });
    const outcome = await deliverCsv({ filename, text });
    if (disposed) return;

    if (outcome === 'cancelled') {
      exportStatus = 'Export cancelled.';
    } else {
      exportStatus = `Exported ${rows.length} rows.`;
      if (outcome === 'fallback') {
        exportFallbackText = text;
      }
    }
    busy = false;
    render();
  }

  // Same shape as handleExportAll() above, scoped to one trackable — see
  // that function's comments for the shared reasoning. `id` must name a
  // currently-visible (non-archived) trackable; a stale button click
  // (e.g. the trackable was archived elsewhere between render and click)
  // is silently ignored rather than exporting the wrong thing.
  async function handleExportOne(id) {
    if (busy) return;

    const idStr = String(id);
    const trackable = visibleTrackables(st.getTrackables()).find((t) => String(t.id) === idStr);
    if (!trackable) return;

    busy = true;
    exportStatus = 'Preparing…';
    exportError = null;
    exportFallbackText = null;
    render();

    const result = await st.loadEntries({ trackableIds: [idStr] });
    if (disposed) return;
    if (result.error !== null) {
      exportError = EXPORT_LOAD_ERROR;
      exportStatus = '';
      busy = false;
      render();
      return;
    }

    // `trackables: [trackable]` is what scopes exportRows()'s output to
    // just this one id — see export-csv.js#exportRows's own comment on
    // dropping entries whose trackable_id matches nothing in the list.
    const entries = st.getEntries({ trackableIds: [idStr] });
    const rows = exportRows({ trackables: [trackable], entries });
    if (rows.length === 0) {
      exportStatus = 'Nothing to export.';
      busy = false;
      render();
      return;
    }

    const text = buildCsv({ trackables: [trackable], entries });
    const filename = exportFilename({ today: day, trackable });
    const outcome = await deliverCsv({ filename, text });
    if (disposed) return;

    if (outcome === 'cancelled') {
      exportStatus = 'Export cancelled.';
    } else {
      exportStatus = `Exported ${rows.length} rows.`;
      if (outcome === 'fallback') {
        exportFallbackText = text;
      }
    }
    busy = false;
    render();
  }

  // The fallback textarea is rebuilt fresh every render (see
  // buildExportBlock()), so this queries for it at click time rather than
  // holding a stale reference.
  function handleExportSelect() {
    const textarea = sectionEl ? sectionEl.querySelector('.settings-export-text') : null;
    if (!textarea) return;
    textarea.focus();
    textarea.select();
  }

  // Step D.7's handleSignOutClick(), moved from js/main.js verbatim in
  // spirit (same refusal-while-outbox-non-empty rule, same warning texts,
  // same store.clear() then auth.signOut() sequence) — see
  // CONTRACT-4.1.md §0 rule 5. The one necessary change: the warning used
  // to be written straight onto a DOM node main.js never re-rendered; here
  // it is state (`signoutWarningText`) that render() reflects, since this
  // view's account block is rebuilt every render.
  async function handleSignOutClick() {
    try {
      const pending = st.getOutbox().length;

      if (pending > 0) {
        // Refuse: signing out clears the localStorage mirror below, and
        // that mirror is where a queued write actually lives until it
        // reaches the server. Signing out here would destroy it, not just
        // hide it.
        signoutWarningText =
          pending === 1
            ? '1 log not yet saved. Get online and wait for them to send before signing out.'
            : `${pending} logs not yet saved. Get online and wait for them to send before signing out.`;
        render();
        return;
      }

      signoutWarningText = '';
      render();

      // The localStorage mirror holds personal data (trackables/entries)
      // and must not outlive the session it belongs to — the next person
      // to open this browser must not see it before anyone signs in again.
      st.clear();
      await au.signOut();
      // getAuth().onChange() (subscribed once in main.js's bootstrap())
      // fires from signOut()'s own setSession(null) and re-renders the
      // whole app to the sign-in gate; this view is about to be unmounted,
      // so no further render() here is needed.
    } catch {
      // A Settings click handler must never crash the app.
    }
  }

  // --- event handlers ------------------------------------------------------

  function handleInput(event) {
    try {
      if (event.target !== windowInput) return;
      // Records that the user has typed, so render() stops overwriting the
      // input from the loaded setting — see `draft`'s own comment. The DOM
      // value itself needs no help; the browser already holds what was
      // typed.
      draft = windowInput.value;
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  function handleSubmit(event) {
    try {
      const form = event.target && event.target.closest ? event.target.closest('form.settings-window-form') : null;
      if (!form || form !== windowFormEl) return;
      event.preventDefault();
      submitWindowForm();
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  function handleClick(event) {
    try {
      const target = event.target;
      if (!target || !target.closest) return;

      const signoutBtn = target.closest('#signout-btn');
      if (signoutBtn && sectionEl.contains(signoutBtn)) {
        handleSignOutClick();
        return;
      }

      const actionBtn = target.closest('button[data-action]');
      if (actionBtn && sectionEl.contains(actionBtn)) {
        const action = actionBtn.dataset.action;
        const id = actionBtn.dataset.id;
        if (action === 'move-up') {
          handleMove(id, 'up');
        } else if (action === 'move-down') {
          handleMove(id, 'down');
        } else if (action === 'unarchive') {
          handleUnarchive(id);
        } else if (action === 'export-all') {
          handleExportAll();
        } else if (action === 'export-one') {
          handleExportOne(id);
        } else if (action === 'export-select') {
          handleExportSelect();
        }
      }
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  // --- lifecycle -----------------------------------------------------------

  async function mount(el) {
    container = el;
    disposed = false;

    // Step 1: synchronous first paint from whatever the store already has
    // cached — must happen before any await.
    render();

    // Step 5.1 addition: deliberately NOT awaited here — it must never
    // delay the trackables/settings loads below (Steps 2-3), and it has its
    // own bounded timeout (net-status.js's requestAppVersion() never
    // rejects). It settles independently and re-renders the account block
    // whenever it does, checking `disposed` the same as every other
    // post-await continuation in this file.
    requestAppVersion().then((cache) => {
      if (disposed) return;
      appVersionKnown = true;
      appVersionCache = cache;
      render();
    });

    // Step 2: the Settings screen always loads trackables (including
    // archived rows) on mount, per CONTRACT-4.1.md §0 rule 1 — it is the
    // one screen that must show the truth about order/archived state, not
    // a possibly-stale cache.
    const tResult = await st.loadTrackables({ includeArchived: true });
    if (disposed) return;
    lastTrackablesError = tResult.error;
    trackablesLoaded = true;
    render();

    // Step 3: likewise always loads settings on mount (§0 rule 1) — unlike
    // ./detail.js, which only loads it once when nothing is cached.
    const sResult = await st.loadSettings();
    if (disposed) return;
    lastSettingsError = sResult.error;
    if (sResult.error !== null && st.getSettings() === null) {
      windowError = WINDOW_LOAD_ERROR;
    }
    render();
  }

  function unmount() {
    if (disposed) return;
    disposed = true;
    if (sectionEl) {
      sectionEl.removeEventListener('click', handleClick);
      sectionEl.removeEventListener('submit', handleSubmit);
      sectionEl.removeEventListener('input', handleInput);
    }
    if (container) {
      container.innerHTML = '';
    }
    sectionEl = null;
    windowBlockEl = null;
    windowFormEl = null;
    windowInput = null;
    windowSaveBtn = null;
    windowStatusP = null;
    windowErrorP = null;
    container = null;

    trackablesLoaded = false;
    lastTrackablesError = null;
    lastSettingsError = null;
    draft = null;
    windowStatus = '';
    windowError = null;
    savingWindow = false;
    busy = false;
    settingsError = null;
    signoutWarningText = '';
    exportStatus = '';
    exportError = null;
    exportFallbackText = null;
    appVersionKnown = false;
    appVersionCache = null;
  }

  return { mount, unmount };
}
