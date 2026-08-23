// Trackable detail screen shell (Step 2.3). Tapping a trackable opens its
// own screen with a slot for each chart its config calls for. THE CHARTS
// THEMSELVES ARE PHASE 3 — this file builds the shell, the data loading,
// and the date-range control every chart module will read from once it
// exists.
//
// This file exports two kinds of things:
//   1. PURE pieces (RANGES, resolveRange, visibleSlots, SLOT_TITLES) — no
//      DOM, no fetch, no localStorage. A separate agent unit-tests these
//      in Node with no DOM, so nothing above the "DOM + network wiring"
//      section may touch `document`, `fetch` or `localStorage`.
//   2. `createDetailView(...)`, the DOM + store wiring, following the same
//      view lifecycle as ./home.js and ./trackable.js (idempotent
//      synchronous unmount, a `disposed` flag checked after every await,
//      exactly one delegated listener per event type on the root, no
//      exception ever escapes a handler).
//
// See docs/BUILD_PLAN.md Step 2.3 and CONTRACT-2.3.md for the exact DOM
// shape, load sequence and fixture tables this file implements.

import { getStore } from '../store.js';
import * as apiModule from '../api.js';
import { todayLocal, addDays } from '../dates.js';
import { directionLabel, visibleTrackables } from './home-model.js';
import { iconSvg, hasIcon } from '../icons.js';

// =============================================================================
// PURE EXPORTS — no DOM, no fetch, no localStorage. Keep it that way; a
// separate agent unit-tests these in Node with no DOM available.
// =============================================================================

// --- RANGES ------------------------------------------------------------
//
// Day counts, not calendar months: dates.js exposes addDays but
// deliberately has no addMonths, and month arithmetic has its own
// end-of-month traps (31 Mar minus one month is ambiguous). A fixed day
// count is unambiguous and testable. Labels stay short because this is a
// phone screen.
export const RANGES = [
  { key: '3m', label: '3M', days: 90 },
  { key: '6m', label: '6M', days: 180 },
  { key: '1y', label: '1Y', days: 365 },
  { key: 'all', label: 'All', days: null },
];

// --- resolveRange --------------------------------------------------------
//
// `today` is injected — never read the clock inside this function; that
// is what makes it testable. `to` is always `today`. For a numeric-days
// range, `from` is `days - 1` days before `today`, so the window is
// inclusive of both ends and exactly `days` days long. Uses addDays()
// from ../dates.js and nothing else — addDays accepts and returns a
// 'YYYY-MM-DD' string, so its result is used directly (never re-wrapped
// in formatLocal, which throws on a string input). An unknown/missing
// rangeKey falls back to '3m'.
export function resolveRange(rangeKey, today) {
  const range = RANGES.find((r) => r.key === rangeKey) || RANGES[0];
  if (range.days === null) {
    return { from: null, to: today };
  }
  return { from: addDays(today, -(range.days - 1)), to: today };
}

// --- visibleSlots --------------------------------------------------------
//
// Which chart slots this trackable's config calls for, in this exact
// order, driven by config and never hardcoded (BUILD_PLAN.md Step 2.3).
// `otherTrackableCount` is the number of non-archived trackables other
// than this one; a non-number is treated as 0. A null/non-object
// trackable yields ['heatmap','weekly']. Never throws.
export function visibleSlots(trackable, otherTrackableCount) {
  const slots = ['heatmap', 'weekly'];

  if (!trackable || typeof trackable !== 'object') return slots;

  // Bounds are meaningless on a boolean trackable, so a stray
  // bounds_enabled flag on a boolean row must not produce a chart that
  // cannot render.
  const boundsOk = trackable.bounds_enabled === true && trackable.value_shape === 'numeric';
  if (!boundsOk) return slots;

  slots.push('bounds');

  const count =
    typeof otherTrackableCount === 'number' && Number.isFinite(otherTrackableCount)
      ? otherTrackableCount
      : 0;
  if (count > 0) slots.push('overlay');

  return slots;
}

// --- SLOT_TITLES ---------------------------------------------------------

export const SLOT_TITLES = {
  heatmap: 'Calendar',
  weekly: 'Weekly trend',
  bounds: 'Range',
  overlay: 'Overlay',
};

// =============================================================================
// DOM + network wiring
// =============================================================================

const RANGE_STORAGE_KEY = 'daily.detail.range.v1';

// iOS private mode throws on setItem/getItem — a logging app must never
// die on that. Every storage access here is wrapped individually, same
// pattern as store.js's safeGetItem/safeSetItem.
function readStoredRange() {
  try {
    const raw = localStorage.getItem(RANGE_STORAGE_KEY);
    if (typeof raw === 'string' && RANGES.some((r) => r.key === raw)) {
      return raw;
    }
  } catch {
    // Fall through to the default below.
  }
  return '3m';
}

function writeStoredRange(key) {
  try {
    localStorage.setItem(RANGE_STORAGE_KEY, key);
  } catch {
    // Best-effort only — an unreadable/unwritable store just means the
    // selection won't persist across visits, which is not fatal.
  }
}

export function createDetailView({ id, store, api, today } = {}) {
  const st = store || getStore();
  // `api` is accepted per CONTRACT-2.3.md §3, for interface symmetry
  // with ./trackable.js (both views follow the same injectable-dependency
  // shape). This view has no direct api.js call of its own yet — every
  // read goes through the store, which is the layer that owns caching
  // and the offline outbox — so the resolved value isn't bound to a name
  // here. `apiModule` stays imported so a future Phase 3 chart-loading
  // addition can start using it without touching the module's imports.
  const day = today || todayLocal();
  const idStr = String(id);

  let container = null;
  let sectionEl = null;
  let disposed = true;

  let trackable = null; // raw loaded row, or null before/if not found
  let otherTrackableCount = 0;
  let entriesForRange = [];
  let rangeKey = '3m';

  let trackablesLoaded = false;
  let lastTrackablesError = null;
  let lastEntriesError = null;
  let entriesLoading = false;

  function refreshTrackableFromStore() {
    const all = st.getTrackables();
    const list = Array.isArray(all) ? all : [];
    trackable = list.find((t) => t && String(t.id) === idStr) || null;

    const vis = visibleTrackables(list);
    otherTrackableCount = vis.filter((t) => String(t.id) !== idStr).length;
  }

  function computeState() {
    if (!trackablesLoaded && !trackable) return 'loading';
    if (lastTrackablesError && !trackable) return 'error';
    if (!trackable) return 'notfound';
    return 'ready';
  }

  // Exactly ONE entries request per range change: this is the only
  // function in the module that calls store.loadEntries, and every
  // caller (mount's initial load, handleRangeChange) is guarded so at
  // most one call is ever in flight at a time. Chart slots receive the
  // already-loaded array via entriesForRange and must never fetch of
  // their own accord — see BUILD_PLAN.md Step 2.3.
  async function loadEntriesForRange(key) {
    entriesLoading = true;
    const { from, to } = resolveRange(key, day);
    const filters = { trackableIds: [id], to };
    // For the 'all' range, `from` is omitted entirely rather than passed
    // as null — api.listEntries validates `from` and would throw a
    // ValidationError on a literal null.
    if (from !== null) filters.from = from;

    const result = await st.loadEntries(filters);
    entriesLoading = false;
    lastEntriesError = result.error;
    entriesForRange = Array.isArray(result.data) ? result.data : [];
  }

  // --- render --------------------------------------------------------------

  function ensureSection() {
    if (sectionEl) return sectionEl;
    sectionEl = document.createElement('section');
    sectionEl.className = 'detail';
    // Exactly one delegated click listener on this root, attached once
    // here and removed in unmount().
    sectionEl.addEventListener('click', handleClick);
    container.appendChild(sectionEl);
    return sectionEl;
  }

  function render() {
    if (disposed || !container) return;

    const section = ensureSection();
    const state = computeState();
    section.setAttribute('data-detail-state', state);
    section.setAttribute('data-trackable-id', idStr);
    section.setAttribute('data-range', rangeKey);
    section.innerHTML = '';

    if (state === 'notfound') {
      const p = document.createElement('p');
      p.appendChild(document.createTextNode('Trackable not found. '));
      const a = document.createElement('a');
      a.href = '#/';
      a.textContent = 'Back to Home';
      p.appendChild(a);
      section.appendChild(p);
      return;
    }

    if (state === 'loading') {
      const p = document.createElement('p');
      p.textContent = 'Loading…';
      section.appendChild(p);
      return;
    }

    if (state === 'error') {
      const p = document.createElement('p');
      p.className = 'detail-error';
      p.setAttribute('role', 'alert');
      p.textContent =
        lastTrackablesError && lastTrackablesError.message
          ? lastTrackablesError.message
          : 'Something went wrong.';
      section.appendChild(p);
      return;
    }

    // state === 'ready': full detail shell.

    const header = document.createElement('header');
    header.className = 'detail-head';

    // Step 2.5: same tinted-icon treatment as home.js's .trow-icon, at a
    // larger size (see styles.css). data-icon falls back to 'dot' for both
    // a null/empty icon and an unrecognized key. Tinted by the trackable's
    // colour ONLY — never by verdict/state, which this screen doesn't even
    // compute (see CONTRACT-2.5.md §0).
    const rawIcon = typeof trackable.icon === 'string' && trackable.icon !== '' ? trackable.icon : null;
    const iconKey = hasIcon(rawIcon) ? rawIcon : 'dot';
    const iconSpan = document.createElement('span');
    iconSpan.className = 'detail-icon';
    iconSpan.dataset.icon = iconKey;
    iconSpan.setAttribute('aria-hidden', 'true');
    if (typeof trackable.color === 'string' && trackable.color !== '') {
      iconSpan.style.color = trackable.color;
    }
    // Own constant SVG markup only (js/icons.js) — the only innerHTML
    // assignment in this file. Everything user-supplied (name, unit, etc.)
    // is set via textContent below.
    iconSpan.innerHTML = iconSvg(iconKey);
    header.appendChild(iconSpan);

    const h2 = document.createElement('h2');
    h2.className = 'detail-name';
    h2.textContent = typeof trackable.name === 'string' ? trackable.name : '';
    header.appendChild(h2);

    if (typeof trackable.unit === 'string' && trackable.unit !== '') {
      const unitSpan = document.createElement('span');
      unitSpan.className = 'detail-unit';
      unitSpan.textContent = trackable.unit;
      header.appendChild(unitSpan);
    }

    const dirLabel = directionLabel(trackable);
    if (dirLabel) {
      const dirSpan = document.createElement('span');
      dirSpan.className = 'detail-direction';
      dirSpan.textContent = dirLabel;
      header.appendChild(dirSpan);
    }

    const editLink = document.createElement('a');
    editLink.className = 'detail-edit';
    editLink.href = `#/t/${encodeURIComponent(String(trackable.id))}/edit`;
    editLink.textContent = 'Edit';
    header.appendChild(editLink);

    section.appendChild(header);

    const rangesDiv = document.createElement('div');
    rangesDiv.className = 'detail-ranges';
    rangesDiv.setAttribute('role', 'group');
    rangesDiv.setAttribute('aria-label', 'Date range');
    for (const r of RANGES) {
      const btn = document.createElement('button');
      btn.className = 'detail-range';
      btn.type = 'button';
      btn.dataset.range = r.key;
      btn.setAttribute('aria-pressed', String(r.key === rangeKey));
      btn.disabled = entriesLoading;
      btn.textContent = r.label;
      rangesDiv.appendChild(btn);
    }
    section.appendChild(rangesDiv);

    const n = entriesForRange.length;
    const countP = document.createElement('p');
    countP.className = 'detail-count';
    countP.textContent = n === 1 ? '1 entry in range' : `${n} entries in range`;
    section.appendChild(countP);

    const slots = visibleSlots(trackable, otherTrackableCount);
    for (const slot of slots) {
      const slotSection = document.createElement('section');
      slotSection.className = 'chart-slot';
      slotSection.dataset.slot = slot;

      const h3 = document.createElement('h3');
      h3.className = 'chart-slot-title';
      h3.textContent = SLOT_TITLES[slot] || '';
      slotSection.appendChild(h3);

      const placeholder = document.createElement('p');
      placeholder.className = 'chart-slot-placeholder';
      placeholder.textContent = 'Chart arrives in Phase 3.';
      slotSection.appendChild(placeholder);

      section.appendChild(slotSection);
    }

    // Offline banner: present iff the most recent trackables or entries
    // load returned a non-null error while we still have data (the
    // trackable itself, and whatever entries are cached) to show —
    // mirrors home.js's identical showOffline rule.
    if (lastTrackablesError !== null || lastEntriesError !== null) {
      const offlineP = document.createElement('p');
      offlineP.className = 'detail-offline';
      offlineP.textContent = 'You appear to be offline — showing the last saved data.';
      section.appendChild(offlineP);
    }
  }

  // --- event handlers ------------------------------------------------------

  async function handleRangeChange(key) {
    if (entriesLoading) return;
    if (key === rangeKey) return;
    if (!RANGES.some((r) => r.key === key)) return;

    rangeKey = key;
    writeStoredRange(key);
    render();

    await loadEntriesForRange(key);
    if (disposed) return;
    render();
  }

  function handleClick(event) {
    try {
      const btn = event.target.closest ? event.target.closest('button.detail-range[data-range]') : null;
      if (!btn || !sectionEl.contains(btn)) return;
      handleRangeChange(btn.dataset.range);
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  // --- lifecycle -----------------------------------------------------------

  async function mount(el) {
    container = el;
    disposed = false;
    rangeKey = readStoredRange();

    // Step 1: synchronous first paint from the store's already-hydrated
    // cache — must happen before any await.
    refreshTrackableFromStore();
    render();

    try {
      // Step 2: needed for both this trackable and the
      // otherTrackableCount that gates the overlay slot.
      const tResult = await st.loadTrackables();
      lastTrackablesError = tResult.error;
      trackablesLoaded = true;
      if (disposed) return;
      refreshTrackableFromStore();
      render();

      if (!trackable) {
        // Never issue the entries request for an id that doesn't exist.
        return;
      }

      // Step 3: resolve the range, then exactly ONE loadEntries call.
      await loadEntriesForRange(rangeKey);
      if (disposed) return;

      // Step 4: final render.
      render();
    } catch (err) {
      if (disposed) return;
      // store.loadTrackables()/loadEntries() never reject, but guard the
      // whole sequence anyway (mirrors home.js's identical guard).
      if (!lastTrackablesError) lastTrackablesError = err;
      trackablesLoaded = true;
      render();
    }
  }

  function unmount() {
    if (disposed) return;
    disposed = true;
    if (sectionEl) {
      sectionEl.removeEventListener('click', handleClick);
    }
    if (container) {
      container.innerHTML = '';
    }
    sectionEl = null;
    container = null;
  }

  return { mount, unmount };
}
