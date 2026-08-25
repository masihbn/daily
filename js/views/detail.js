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
import { directionLabel, visibleTrackables, parseNumericInput, hasEntryValue } from './home-model.js';
import { iconSvg, hasIcon } from '../icons.js';
import { renderHeatmap, heatmapModel, monthBoundsFor, monthOf, shiftMonth, clampMonth, monthLabel } from '../charts/heatmap.js';
import { renderWeekly, destroyWeekly, trendModel, PERIODS } from '../charts/weekly.js';

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
const PERIOD_STORAGE_KEY = 'daily.detail.period.v1';

// Step 3.2c: Daily is capped at 3 months (recorded user decision,
// 2026-08-24). 365 daily marks on a 390px screen is unreadable, so
// selecting Daily forces the range to 3M and disables the wider options
// while it is active. Leaving Daily re-enables them and leaves the range
// where it is — no auto-restore, because predictable beats clever.
const DAILY_RANGE_KEY = '3m';

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

function readStoredPeriod() {
  try {
    const raw = localStorage.getItem(PERIOD_STORAGE_KEY);
    if (typeof raw === 'string' && PERIODS.some((p) => p.key === raw)) {
      return raw;
    }
  } catch {
    // Fall through to the default below.
  }
  return 'week';
}

function writeStoredPeriod(key) {
  try {
    localStorage.setItem(PERIOD_STORAGE_KEY, key);
  } catch {
    // Best-effort only, same as writeStoredRange.
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

  // Step 3.2b (CONTRACT-3.2b.md §5, fixing U1): true from the start of
  // mount() until the FIRST loadEntriesForRange() settles — success or
  // failure alike, since an offline failure still returns real cached
  // rows from the store that must be shown, not treated as "still
  // loading". While true, every visible chart slot renders a "Loading…"
  // placeholder instead of its chart/placeholder, so the user never sees
  // provisional/cached-only content snap into real content ~1s later.
  // First-load only, by design: it is set false exactly once, in
  // loadEntriesForRange(), and nothing ever sets it back to true — a
  // range change re-populates the same charts with plausible data
  // already in hand, so blanking them again would be worse than the
  // snap-in this fixes. See loadEntriesForRange() and mount()'s catch
  // block for the two paths that settle it.
  let chartsPending = true;

  // Step 3.2c: trend-chart granularity ('day' | 'week' | 'month'). Lives
  // here rather than in the chart module for the same reason monthStr does
  // — js/charts/weekly.js is stateless and this view owns the render loop.
  let periodKey = 'week';

  // Step 3.1: calendar heatmap state. The heatmap module itself is
  // stateless (js/charts/heatmap.js) — the displayed month and the
  // selected day live here, in the view that owns the render loop. See
  // CONTRACT-3.1.md §4.2.
  let monthStr = null; // 'YYYY-MM' currently displayed
  let selectedDay = null; // 'YYYY-MM-DD' with the day editor open, or null
  let dayDraft = ''; // numeric editor text
  let dayError = null; // string | null
  let dayInFlight = false;
  // Not part of the contract's formal state list, but needed to mirror
  // home.js's focus/select pattern (see buildDayEditor()/render() below):
  // 'select' only right after the editor is freshly opened, so a later
  // re-render (e.g. after a failed save) refocuses without nuking
  // whatever the user has typed since.
  let dayFocusMode = null;

  // Same 'day monthName year' shape js/charts/heatmap.js's heatmapModel()
  // builds internally for cell labels (its `base`) — duplicated here
  // because heatmap.js only exports monthLabel() ('Month Year', no day).
  // The two must stay in agreement; this array is kept identical to
  // heatmap.js's MONTH_NAMES.
  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  function dayEditorDateText(dateStr) {
    const [yStr, mStr, dStr] = dateStr.split('-');
    return `${Number(dStr)} ${MONTH_NAMES[Number(mStr) - 1]} ${yStr}`;
  }

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
    // Settles chartsPending unconditionally — idempotent after the first
    // call (see the flag's own comment above for why it must never flip
    // back to true on a later range change).
    chartsPending = false;
    lastEntriesError = result.error;
    entriesForRange = Array.isArray(result.data) ? result.data : [];
    // The 'all' range's navigable minimum month depends on what actually
    // got loaded, so re-clamp every time the loaded window changes.
    clampMonthState();
  }

  // Keeps monthStr inside the months the current range/entries allow
  // navigating to (CONTRACT-3.1.md §4.3).
  function currentBounds() {
    const { from } = resolveRange(rangeKey, day);
    return monthBoundsFor({ from, today: day, entries: entriesForRange });
  }

  function clampMonthState() {
    const b = currentBounds();
    monthStr = clampMonth(monthStr === null ? monthOf(day) : monthStr, b);
  }

  // Synchronous refresh of entriesForRange from the store's in-memory
  // cache after a write. entriesForRange is a snapshot taken at load
  // time, so a write that only updates the store's cache would otherwise
  // leave the heatmap showing stale data. store.getEntries() is
  // synchronous and issues ZERO requests — do NOT call st.loadEntries()
  // here, that would re-issue the range GET and break Step 2.3's D6
  // load-once guarantee (CONTRACT-3.1.md §4.7).
  function refreshEntriesFromStore() {
    const { from, to } = resolveRange(rangeKey, day);
    const filters = { trackableIds: [id], to };
    if (from !== null) filters.from = from;
    entriesForRange = st.getEntries(filters);
  }

  // --- render --------------------------------------------------------------

  function ensureSection() {
    if (sectionEl) return sectionEl;
    sectionEl = document.createElement('section');
    sectionEl.className = 'detail';
    // Exactly one delegated click listener and one delegated submit
    // listener on this root, attached once here and removed in
    // unmount().
    sectionEl.addEventListener('click', handleClick);
    sectionEl.addEventListener('submit', handleSubmit);
    container.appendChild(sectionEl);
    return sectionEl;
  }

  function render() {
    if (disposed || !container) return;

    // Step 3.2 (CONTRACT-3.2.md §4): destroy any existing weekly Chart.js
    // instance before the section's innerHTML is wiped below. The wipe
    // detaches the canvas but does not destroy the Chart instance holding
    // it, which leaks and produces the classic "tooltips from the
    // previous chart" bug.
    destroyWeekly();

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
      // Step 3.2c: Daily caps the range at 3M, so the wider options are
      // disabled while Daily is active rather than silently ignored.
      btn.disabled = entriesLoading || (periodKey === 'day' && r.key !== DAILY_RANGE_KEY);
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

      if (chartsPending) {
        // Step 3.2b (CONTRACT-3.2b.md §5, fixing U1): before the first
        // entries load has settled, every visible slot shows only this
        // placeholder — never its chart, and never the Phase-3
        // placeholder either. Min-height is set per-slot in CSS off the
        // data-slot attribute already on slotSection, so the page does
        // not jump when real content replaces it.
        const loadingP = document.createElement('p');
        loadingP.className = 'chart-slot-loading';
        loadingP.setAttribute('aria-live', 'polite');
        loadingP.textContent = 'Loading…';
        slotSection.appendChild(loadingP);
      } else if (slot === 'heatmap') {
        // monthStr is kept legal (never null) by clampMonthState(), called
        // right after the first refreshTrackableFromStore() in mount()
        // and after every entries load — see CONTRACT-3.1.md §4.3/§4.4.
        // heatmapModel() itself tolerates a garbage month by clamping, but
        // that is a safety net here, not the normal path.
        const { from } = resolveRange(rangeKey, day);
        const model = heatmapModel({ trackable, entries: entriesForRange, month: monthStr, today: day, from });
        slotSection.appendChild(renderHeatmap(model));
        if (selectedDay !== null) {
          slotSection.appendChild(buildDayEditor());
        }
      } else if (slot === 'weekly') {
        const { from, to } = resolveRange(rangeKey, day);
        slotSection.appendChild(
          renderWeekly(trendModel({ trackable, entries: entriesForRange, from, to, period: periodKey }))
        );
      } else {
        // bounds/overlay keep their existing placeholder — Steps 3.3-3.5.
        const placeholder = document.createElement('p');
        placeholder.className = 'chart-slot-placeholder';
        placeholder.textContent = 'Chart arrives in Phase 3.';
        slotSection.appendChild(placeholder);
      }

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

    // Same focus/select pattern as home.js's numeric editor: focus on
    // every render while the editor is open, but only select() on the
    // render right after it was freshly opened, so a later re-render
    // (e.g. after a failed save) doesn't nuke what the user typed since.
    if (selectedDay !== null) {
      const input = section.querySelector('.day-input');
      if (input) {
        input.focus();
        if (dayFocusMode === 'select') input.select();
      }
    }
    dayFocusMode = null;
  }

  // --- day editor (Step 3.1) ------------------------------------------------
  //
  // Tapping a day opens that day's entry for editing — the only way to
  // fix a mis-logged past day (BUILD_PLAN.md Step 3.1). Unlike home.js's
  // today-only row editor, this is a deliberate correction of a specific
  // past date, so it waits for the write to settle rather than updating
  // optimistically: every button stays disabled (dayInFlight) until the
  // result is known. See CONTRACT-3.1.md §4.5-§4.7.

  function buildDayEditor() {
    const existing = entriesForRange.find((e) => e.entry_date === selectedDay) || null;
    const hasExisting = hasEntryValue(trackable, existing);

    const div = document.createElement('div');
    div.className = 'day-editor';
    div.dataset.date = selectedDay;

    const dateP = document.createElement('p');
    dateP.className = 'day-editor-date';
    dateP.textContent = dayEditorDateText(selectedDay);
    div.appendChild(dateP);

    if (trackable.value_shape === 'boolean') {
      const markBtn = document.createElement('button');
      markBtn.type = 'button';
      markBtn.className = 'day-mark';
      markBtn.dataset.action = 'day-mark';
      markBtn.disabled = dayInFlight;
      markBtn.textContent = 'Mark done';
      div.appendChild(markBtn);

      if (hasExisting) {
        div.appendChild(makeDayClearButton());
      }
      div.appendChild(makeDayCancelButton());
    } else {
      // Numeric (and defensively, any other shape) gets the numeric form.
      const form = document.createElement('form');
      form.className = 'day-form';

      const input = document.createElement('input');
      input.className = 'day-input';
      // type="text" + inputmode="decimal" is deliberate, NOT
      // type="number" — same reasoning as home.js's trow-input (see its
      // comment): type="number" would silently discard a decimal-comma
      // before parseNumericInput() ever sees it.
      input.type = 'text';
      input.setAttribute('inputmode', 'decimal');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('enterkeyhint', 'done');
      input.setAttribute('aria-label', `Value for ${dayEditorDateText(selectedDay)}`);
      input.value = dayDraft;
      input.disabled = dayInFlight;
      form.appendChild(input);

      const saveBtn = document.createElement('button');
      saveBtn.type = 'submit';
      saveBtn.className = 'day-save';
      saveBtn.dataset.action = 'day-save';
      saveBtn.disabled = dayInFlight;
      saveBtn.textContent = 'Save';
      form.appendChild(saveBtn);

      if (hasExisting) {
        form.appendChild(makeDayClearButton());
      }
      form.appendChild(makeDayCancelButton());

      div.appendChild(form);
    }

    if (dayError !== null) {
      const errP = document.createElement('p');
      errP.className = 'day-error';
      errP.setAttribute('role', 'alert');
      errP.textContent = dayError;
      div.appendChild(errP);
    }

    return div;
  }

  function makeDayClearButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-clear';
    btn.dataset.action = 'day-clear';
    btn.disabled = dayInFlight;
    btn.textContent = 'Clear';
    return btn;
  }

  function makeDayCancelButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-cancel';
    btn.dataset.action = 'day-cancel';
    btn.disabled = dayInFlight;
    btn.textContent = 'Cancel';
    return btn;
  }

  function openDayEditor(dateStr) {
    if (selectedDay === dateStr) {
      // Tapping the already-selected day closes the editor (toggle).
      selectedDay = null;
      dayDraft = '';
      dayError = null;
      render();
      return;
    }
    const existing = entriesForRange.find((e) => e.entry_date === dateStr) || null;
    selectedDay = dateStr;
    // The user is correcting a day, so the current value must be visible.
    dayDraft = existing && Number.isFinite(existing.value) ? String(existing.value) : '';
    dayError = null;
    dayFocusMode = 'select';
    render();
  }

  function applyDayResult(result) {
    const status = result && result.status;
    if (status === 'saved' || status === 'queued') {
      selectedDay = null;
      dayDraft = '';
      dayError = null;
    } else {
      // 'failed', or a thrown exception normalized to this shape by the
      // caller.
      const err = result && result.error;
      dayError = (err && err.message) || 'Something went wrong.';
    }
  }

  function runDayWrite(fn) {
    dayInFlight = true;
    render();
    fn()
      .then((result) => {
        if (disposed) return;
        applyDayResult(result);
      })
      .catch((err) => {
        if (disposed) return;
        applyDayResult({ status: 'failed', error: err });
      })
      .finally(() => {
        dayInFlight = false;
        refreshEntriesFromStore();
        if (!disposed) render();
      });
  }

  function handleDayMark() {
    if (dayInFlight || entriesLoading || !trackable || selectedDay === null) return;
    runDayWrite(() => st.saveEntry({ trackable_id: trackable.id, entry_date: selectedDay, value: 1 }));
  }

  function handleDayClear() {
    if (dayInFlight || entriesLoading || !trackable || selectedDay === null) return;
    runDayWrite(() => st.removeEntry(trackable.id, selectedDay));
  }

  function handleDayCancel() {
    selectedDay = null;
    dayDraft = '';
    dayError = null;
    render();
  }

  // Note: the numeric day editor writes the parsed value DIRECTLY — it
  // must NOT call applyRelog/nextValueFor. This is an edit of a past day,
  // not a re-log of today; under relog_semantic: 'cumulative' a re-log
  // ADDS, which would make it impossible to correct a wrong value
  // downward, and correcting a mis-logged day is the entire reason this
  // affordance exists (BUILD_PLAN.md Step 3.1). Do not "helpfully" route
  // this through applyRelog for consistency with home.js — see
  // CONTRACT-3.1.md §4.6 for the full reasoning.
  function handleDaySave(inputText) {
    if (dayInFlight || entriesLoading || !trackable || selectedDay === null) return;
    const n = parseNumericInput(inputText);
    if (n === null) {
      dayError = 'Enter a number';
      dayDraft = inputText;
      render();
      return;
    }
    dayDraft = inputText;
    runDayWrite(() => st.saveEntry({ trackable_id: trackable.id, entry_date: selectedDay, value: n }));
  }

  // --- event handlers ------------------------------------------------------

  async function handleRangeChange(key) {
    if (entriesLoading) return;
    if (key === rangeKey) return;
    if (!RANGES.some((r) => r.key === key)) return;

    rangeKey = key;
    writeStoredRange(key);
    // A change of range can put the selected day out of the loaded
    // window, so the day editor cannot survive a range change.
    selectedDay = null;
    dayError = null;
    dayDraft = '';
    render();

    await loadEntriesForRange(key);
    if (disposed) return;
    // loadEntriesForRange() already re-clamps monthStr internally, but the
    // 'all' range's min depends on exactly this load, so make it explicit
    // here too (CONTRACT-3.1.md §4.3) — clampMonthState() is idempotent.
    clampMonthState();
    render();
  }

  // Step 3.2c. Changing granularity re-buckets data already in hand, so it
  // must issue ZERO network requests — that is the load-once guarantee
  // Steps 2.3/3.1/3.2 all assert. The single exception is the Daily cap:
  // switching to Daily from a range wider than 3M genuinely changes the
  // query window, so that one path reloads.
  async function handlePeriodChange(key) {
    if (entriesLoading) return;
    if (key === periodKey) return;
    if (!PERIODS.some((p) => p.key === key)) return;

    periodKey = key;
    writeStoredPeriod(key);
    // A day editor opened from the heatmap is unrelated to the trend
    // chart's bucketing, but leaving it open across a re-render that
    // changes what is on screen below it is confusing.
    selectedDay = null;
    dayError = null;
    dayDraft = '';

    const needsRangeChange = key === 'day' && rangeKey !== DAILY_RANGE_KEY;
    if (!needsRangeChange) {
      render();
      return;
    }

    rangeKey = DAILY_RANGE_KEY;
    writeStoredRange(rangeKey);
    render();
    await loadEntriesForRange(rangeKey);
    if (disposed) return;
    clampMonthState();
    render();
  }

  function handleClick(event) {
    try {
      const target = event.target;
      if (!target || !target.closest) return;

      const rangeBtn = target.closest('button.detail-range[data-range]');
      if (rangeBtn && sectionEl.contains(rangeBtn)) {
        handleRangeChange(rangeBtn.dataset.range);
        return;
      }

      const periodBtn = target.closest('button.trend-period[data-period]');
      if (periodBtn && sectionEl.contains(periodBtn)) {
        handlePeriodChange(periodBtn.dataset.period);
        return;
      }

      const navBtn = target.closest('button.hm-nav[data-heatmap-nav]');
      if (navBtn && sectionEl.contains(navBtn)) {
        if (entriesLoading) return;
        const dir = navBtn.dataset.heatmapNav === 'next' ? 1 : -1;
        monthStr = clampMonth(shiftMonth(monthStr, dir), currentBounds());
        selectedDay = null;
        dayError = null;
        dayDraft = '';
        render();
        return;
      }

      const cellBtn = target.closest('button.hm-cell[data-date]');
      if (cellBtn && sectionEl.contains(cellBtn)) {
        if (entriesLoading || dayInFlight) return;
        openDayEditor(cellBtn.dataset.date);
        return;
      }

      const actionBtn = target.closest('button[data-action]');
      if (actionBtn && sectionEl.contains(actionBtn)) {
        const action = actionBtn.dataset.action;
        if (action === 'day-mark') {
          handleDayMark();
        } else if (action === 'day-clear') {
          handleDayClear();
        } else if (action === 'day-cancel') {
          handleDayCancel();
        }
        // action === 'day-save' is a submit button inside form.day-form;
        // the delegated 'submit' listener handles it, not this click
        // listener.
      }
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  function handleSubmit(event) {
    try {
      const form = event.target && event.target.closest ? event.target.closest('form.day-form') : null;
      if (!form || !sectionEl.contains(form)) return;
      event.preventDefault();
      const input = form.querySelector('.day-input');
      handleDaySave(input ? input.value : '');
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  // --- lifecycle -----------------------------------------------------------

  async function mount(el) {
    container = el;
    disposed = false;
    rangeKey = readStoredRange();
    periodKey = readStoredPeriod();
    // A stored Daily period with a stored range wider than 3M is a legal
    // combination on disk (the two keys are written independently) but not
    // a legal one on screen, so reconcile before the first load rather than
    // issuing a query for a window the UI will immediately contradict.
    if (periodKey === 'day' && rangeKey !== DAILY_RANGE_KEY) {
      rangeKey = DAILY_RANGE_KEY;
      writeStoredRange(rangeKey);
    }

    // Step 1: synchronous first paint from the store's already-hydrated
    // cache — must happen before any await.
    refreshTrackableFromStore();
    clampMonthState();
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
      // whole sequence anyway (mirrors home.js's identical guard). Also
      // settle chartsPending here: if the trackable was already warm in
      // the store's cache, the very first synchronous render above could
      // already be showing chart slots (state 'ready' from cache) with
      // chartsPending still true — an exception on this path must not
      // leave them stuck on "Loading…" forever.
      chartsPending = false;
      if (!lastTrackablesError) lastTrackablesError = err;
      trackablesLoaded = true;
      render();
    }
  }

  function unmount() {
    if (disposed) return;
    disposed = true;
    // Step 3.2 (CONTRACT-3.2.md §4): also destroy on unmount, not just on
    // the next render — otherwise navigating away from the detail screen
    // for good (not just re-rendering it) leaks the instance.
    destroyWeekly();
    if (sectionEl) {
      sectionEl.removeEventListener('click', handleClick);
      sectionEl.removeEventListener('submit', handleSubmit);
    }
    if (container) {
      container.innerHTML = '';
    }
    sectionEl = null;
    container = null;
    selectedDay = null;
    dayDraft = '';
    dayError = null;
    dayInFlight = false;
    monthStr = null;
    dayFocusMode = null;
    periodKey = 'week';
  }

  return { mount, unmount };
}
