// Compare screen shell (Step 3.5, CONTRACT-3.5.md). A TOP-LEVEL view at
// `#/compare` — unlike js/views/detail.js this is not "one trackable's
// screen with slots", it is a picker over every eligible trackable plus
// ONE normalized multi-series chart (js/charts/compare.js). Same view
// lifecycle contract as every other view in this app: synchronous first
// paint from the store's cache, a `disposed` flag checked after every
// await, exactly one delegated click listener on the root, no exception
// ever escapes a handler, an idempotent synchronous unmount.
//
// This file owns: reading/writing the persisted { ids, period, range }
// state (localStorage, via the injected-storage pattern below — same
// reasoning as detail.js's overlayStorage()), the network loads, and
// building the per-series entries map at render time. js/charts/compare.js
// itself never touches the network or localStorage — see its own header.

import { getStore } from '../store.js';
import { todayLocal } from '../dates.js';
import { visibleTrackables } from './home-model.js';
// Step U.5 (CONTRACT-U.5.md §2): the Expand button uses the same chrome
// icon set as every other Expand control in the app (js/views/detail.js's
// own chart-slot Expand buttons) — never a second, hand-drawn glyph.
import { uiIconSvg } from '../ui-icons.js';
// RANGES/resolveRange are detail.js's own pure exports, reused verbatim
// (CONTRACT-3.5.md §2) so this screen's range control shares BOTH the
// exact behaviour (the Daily -> 3M rule) and the CSS classes
// (.detail-ranges/.detail-range) with the per-trackable detail screen,
// rather than encoding a second copy of either.
import { RANGES, resolveRange } from './detail.js';
import { PERIODS } from '../charts/weekly.js';
import {
  compareCandidates,
  readCompareState,
  writeCompareState,
  sanitizeCompareIds,
  seriesColorFor,
  compareModel,
  renderCompare,
  destroyCompare,
} from '../charts/compare.js';

// Step 3.2c's rule, reused verbatim here (CONTRACT-3.5.md §0 rule 6):
// Daily on a phone-width axis is unreadable past ~90 points, so selecting
// Daily forces the range to 3M and disables the wider options while it is
// active.
const DAILY_RANGE_KEY = '3m';

export function createCompareView({ store, today } = {}) {
  const st = store || getStore();
  const day = today || todayLocal();

  let container = null;
  let sectionEl = null;
  let disposed = true;

  // Persisted view state (CONTRACT-3.5.md §0 rule 6: all three fields live
  // in ONE localStorage key as a per-device view preference).
  let ids = [];
  let period = 'week';
  let range = '3m';

  let trackablesLoaded = false;
  let lastTrackablesError = null;
  // True from the moment a history load for at least one not-yet-loaded id
  // starts until it settles — mirrors detail.js's overlayLoading, not its
  // chartsPending (there is no single "first load" here: every chip tap
  // can start a fresh load for just the newly-added id).
  let loading = false;
  let lastEntriesError = null;
  // Which ids' whole history has successfully loaded at least once — an id
  // whose load FAILED is deliberately left out, so toggling it off and
  // back on retries it (exactly detail.js#overlayLoadedIds's rule).
  const loadedIds = new Set();

  // iOS private mode throws on localStorage access — a logging app must
  // never die on that. Same guarded-accessor pattern as
  // detail.js#overlayStorage().
  function compareStorage() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  // Recomputed on every call (visibleTrackables()/compareCandidates() are
  // both pure/cheap), never cached — so a trackable archived or edited
  // elsewhere is reflected immediately, without this view needing its own
  // invalidation logic. Exactly detail.js#overlayCandidateList()'s own
  // reasoning.
  function candidateList() {
    return compareCandidates(visibleTrackables(st.getTrackables()));
  }

  // Mirrors detail.js#computeState()'s shape (loading/error/ready), but
  // there is no single trackable here to be "not found" — 'loading' is
  // "trackables haven't loaded and the cache has nothing to show yet",
  // 'error' is "they failed to load and there is still nothing to show",
  // and 'ready' covers everything else, INCLUDING a failed load that still
  // has stale cached candidates (the offline banner communicates that
  // case, not this attribute).
  function computeState() {
    const n = candidateList().length;
    if (!trackablesLoaded && n === 0) return 'loading';
    if (lastTrackablesError && n === 0) return 'error';
    return 'ready';
  }

  // Same range window and "omit `from` when null" rule as
  // detail.js#applyRangeFilter/#overlayEntriesFor — a synchronous cache
  // read, issues no request.
  function entriesFor(id) {
    const { from, to } = resolveRange(range, day);
    const filters = { trackableIds: [id], to };
    if (from !== null) filters.from = from;
    return st.getEntries(filters);
  }

  // Loads the WHOLE history of every id in `ids` that hasn't already
  // loaded successfully, in ONE request — never one request per series.
  // Exactly detail.js#loadOverlayHistories's own contract, restated here
  // because this view can have many selected ids at once instead of at
  // most one.
  async function loadHistories(idsToLoad) {
    const list = Array.isArray(idsToLoad) ? idsToLoad : [];
    const remaining = list.filter((id) => !loadedIds.has(id));
    if (remaining.length === 0) return;

    loading = true;
    render();

    const result = await st.loadEntries({ trackableIds: remaining });
    if (disposed) return;

    loading = false;
    lastEntriesError = result.error;
    if (result.error === null) {
      for (const id of remaining) loadedIds.add(id);
    }
    render();
  }

  // --- render ----------------------------------------------------------

  function ensureSection() {
    if (sectionEl) return sectionEl;
    sectionEl = document.createElement('section');
    sectionEl.className = 'compare-view';
    // Exactly one delegated click listener on this root, attached once
    // here and removed in unmount() — same rule every view in this app
    // follows.
    sectionEl.addEventListener('click', handleClick);
    container.appendChild(sectionEl);
    return sectionEl;
  }

  function render() {
    if (disposed || !container) return;

    // Step 3.2's rule, applied here too: destroy any existing Chart.js
    // instance BEFORE the section's innerHTML is wiped below. The wipe
    // detaches the canvas but does not destroy the Chart instance holding
    // it — that leaks. Unconditional (not inside an `if` for whichever
    // branch draws a chart this pass) because a pass that shows the
    // 'compare-loading' placeholder instead of a chart must still clean up
    // whatever the PREVIOUS pass drew. renderCompare() below also destroys
    // at its own top, for the branches that do reach it — both together
    // cover every combination.
    destroyCompare();

    const section = ensureSection();
    const state = computeState();
    section.setAttribute('data-compare-state', state);
    section.innerHTML = '';

    const candidates = candidateList();

    // --- picker ---------------------------------------------------------

    const pickerDiv = document.createElement('div');
    pickerDiv.className = 'compare-picker';

    const hint = document.createElement('p');
    hint.className = 'compare-hint';
    hint.textContent = candidates.length === 0 ? 'No trackables yet.' : `${ids.length} selected`;
    pickerDiv.appendChild(hint);

    const chips = document.createElement('div');
    chips.className = 'compare-chips';
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Trackables to compare');
    for (const t of candidates) {
      const cid = String(t.id);
      const isSelected = ids.includes(cid);

      const btn = document.createElement('button');
      btn.type = 'button';
      // .compare-chip carries this control's own hooks (data-compare-id);
      // .overlay-chip reuses the existing chip's visual treatment
      // (CONTRACT-3.5.md §4) rather than duplicating that CSS.
      btn.className = 'compare-chip overlay-chip';
      btn.dataset.compareId = cid;
      btn.setAttribute('aria-pressed', String(isSelected));
      btn.textContent = typeof t.name === 'string' ? t.name : '';

      // A SELECTED chip shows the colour it will actually draw with on the
      // chart (its position among the current selection, via
      // seriesColorFor() — the same function compareModel() uses, so the
      // chip and the line always agree); an unselected one previews the
      // trackable's own identity colour, if it has one, rather than a
      // palette slot it may never actually get.
      const color = isSelected
        ? seriesColorFor(t, ids.indexOf(cid))
        : typeof t.color === 'string' && t.color !== ''
        ? t.color
        : null;
      if (color) btn.style.setProperty('--chip-color', color);

      chips.appendChild(btn);
    }
    pickerDiv.appendChild(chips);
    section.appendChild(pickerDiv);

    // --- controls: range + granularity share one row (Step U.5,
    // CONTRACT-U.5.md §0 decision 2/§2) — the two `.seg`-look controls sit
    // side by side in one new wrapper instead of stacking full-width. Their
    // own markup/classes are unchanged (detail.js's/weekly.js's shared CSS).

    const controlsDiv = document.createElement('div');
    controlsDiv.className = 'compare-controls';

    const rangesDiv = document.createElement('div');
    rangesDiv.className = 'detail-ranges';
    rangesDiv.setAttribute('role', 'group');
    rangesDiv.setAttribute('aria-label', 'Date range');
    for (const r of RANGES) {
      const btn = document.createElement('button');
      btn.className = 'detail-range';
      btn.type = 'button';
      btn.dataset.range = r.key;
      btn.setAttribute('aria-pressed', String(r.key === range));
      // Same Daily-caps-the-range rule as detail.js's own range control.
      btn.disabled = loading || (period === 'day' && r.key !== DAILY_RANGE_KEY);
      btn.textContent = r.label;
      rangesDiv.appendChild(btn);
    }
    controlsDiv.appendChild(rangesDiv);

    const periodsDiv = document.createElement('div');
    periodsDiv.className = 'trend-periods';
    periodsDiv.setAttribute('role', 'group');
    periodsDiv.setAttribute('aria-label', 'Granularity');
    for (const p of PERIODS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'trend-period';
      btn.dataset.period = p.key;
      btn.setAttribute('aria-pressed', String(p.key === period));
      btn.textContent = p.label;
      periodsDiv.appendChild(btn);
    }
    controlsDiv.appendChild(periodsDiv);

    section.appendChild(controlsDiv);

    // --- toolbar: Expand -> #/compare/chart (Step U.5, CONTRACT-U.5.md §2)
    // Rendered only once there is something worth expanding: the picker/
    // network state is ready (not the initial cold load with nothing cached
    // yet) AND at least one trackable is selected — an empty selection has
    // nothing to show fullscreen either.

    if (state === 'ready' && ids.length > 0) {
      const toolbar = document.createElement('div');
      toolbar.className = 'compare-toolbar';
      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'chart-expand';
      expandBtn.dataset.expand = 'compare';
      expandBtn.setAttribute('aria-label', 'Expand Compare');
      // Own constant SVG markup only (js/ui-icons.js) — same rule detail.js's
      // own Expand buttons follow.
      expandBtn.innerHTML = uiIconSvg('expand');
      const expandText = document.createElement('span');
      expandText.className = 'visually-hidden';
      expandText.textContent = 'Expand';
      expandBtn.appendChild(expandText);
      toolbar.appendChild(expandBtn);
      section.appendChild(toolbar);
    }

    // --- chart, or a loading placeholder while nothing is drawable yet --

    // ONLY ids whose whole history has actually loaded (without error) are
    // ever passed to compareModel() as trackables — a selected-but-not-
    // yet-loaded or failed id stays selected in the picker but draws
    // nothing, the same rule detail.js's overlay applies to its own single
    // slot.
    const drawableIds = ids.filter((id) => loadedIds.has(id));

    if (loading && drawableIds.length === 0) {
      // Something is loading and there is nothing else to show in its
      // place yet (e.g. the very first load, or every selected id failing
      // and being retried) — CONTRACT-3.5.md §2's own wording.
      const p = document.createElement('p');
      p.className = 'compare-loading';
      p.textContent = 'Loading…';
      section.appendChild(p);
    } else {
      const selectedTrackables = drawableIds
        .map((id) => candidates.find((c) => c && String(c.id) === id))
        .filter(Boolean);
      const entriesById = {};
      for (const t of selectedTrackables) {
        entriesById[String(t.id)] = entriesFor(t.id);
      }
      const { from, to } = resolveRange(range, day);
      const model = compareModel({ trackables: selectedTrackables, entriesById, from, to, period });
      section.appendChild(renderCompare(model));

      // Step U.7 (CONTRACT-U.7.md §0 follow-up 5, §2): js/charts/compare.js
      // itself is out of scope for this step (its DOM builders are pinned by
      // exact-shape unit tests — see js/charts/overlay.js's own U.3 retreat
      // for the same reasoning), so the shared `.empty` component is applied
      // here, as a post-render decoration of whichever `.compare-empty`
      // paragraph renderCompare() just produced (the 'none'/'pick two or
      // more' case and the 'empty'/'no entries' case both use that class) —
      // its existing class and text are kept, only wrapped.
      const emptyP = section.querySelector('.compare-empty');
      if (emptyP && !emptyP.classList.contains('empty')) {
        const text = emptyP.textContent;
        emptyP.textContent = '';
        emptyP.classList.add('empty');
        const glyph = document.createElement('span');
        glyph.className = 'empty__glyph';
        glyph.setAttribute('aria-hidden', 'true');
        glyph.innerHTML = uiIconSvg('compare');
        emptyP.appendChild(glyph);
        const textSpan = document.createElement('span');
        textSpan.className = 'empty__text';
        textSpan.textContent = text;
        emptyP.appendChild(textSpan);
      }
    }

    // --- offline banner ---------------------------------------------------

    if (lastTrackablesError !== null || lastEntriesError !== null) {
      const offlineP = document.createElement('p');
      offlineP.className = 'detail-offline';
      offlineP.textContent = 'You appear to be offline — showing the last saved data.';
      section.appendChild(offlineP);
    }
  }

  // --- event handlers ----------------------------------------------------

  function handleChipToggle(cid) {
    if (loading) return;
    const isCandidate = candidateList().some((c) => c && String(c.id) === cid);
    if (!isCandidate) return;

    if (ids.includes(cid)) {
      // Purely local: no request for the id being cleared, ever — its
      // loaded history just stops being drawn (loadedIds is left alone, so
      // re-selecting it later does not re-fetch).
      ids = ids.filter((id) => id !== cid);
      writeCompareState(compareStorage(), { ids, period, range });
      render();
      return;
    }

    ids = [...ids, cid];
    writeCompareState(compareStorage(), { ids, period, range });
    render();
    loadHistories([cid]);
  }

  // As detail.js#handleRangeChange: a purely local re-filter over data
  // already in hand, so it must issue ZERO network requests.
  function handleRangeChange(key) {
    if (loading) return;
    if (key === range) return;
    if (!RANGES.some((r) => r.key === key)) return;

    range = key;
    writeCompareState(compareStorage(), { ids, period, range });
    render();
  }

  // As detail.js#handlePeriodChange, Daily -> 3M rule included.
  function handlePeriodChange(key) {
    if (loading) return;
    if (key === period) return;
    if (!PERIODS.some((p) => p.key === key)) return;

    period = key;
    if (key === 'day' && range !== DAILY_RANGE_KEY) {
      range = DAILY_RANGE_KEY;
    }
    writeCompareState(compareStorage(), { ids, period, range });
    render();
  }

  function handleClick(event) {
    try {
      const target = event.target;
      if (!target || !target.closest) return;

      const chipBtn = target.closest('button.compare-chip[data-compare-id]');
      if (chipBtn && sectionEl.contains(chipBtn)) {
        handleChipToggle(chipBtn.dataset.compareId);
        return;
      }

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

      // Step U.5 (CONTRACT-U.5.md §2): opens the same fullscreen view U.4
      // built, with kind='compare' — a plain hash assignment (not the
      // pushState+fromApp stamp detail.js's own Expand uses) is enough here:
      // fullscreen.js's Close for this kind always falls back to '#/compare'
      // when there is no app-originated history entry to go back to, which
      // is the only place this route is ever reached from.
      const expandBtn = target.closest('button.chart-expand[data-expand="compare"]');
      if (expandBtn && sectionEl.contains(expandBtn)) {
        location.hash = '#/compare/chart';
        return;
      }
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  // --- lifecycle -----------------------------------------------------------

  async function mount(el) {
    container = el;
    disposed = false;

    const stored = readCompareState(compareStorage());
    ids = stored.ids;
    period = stored.period;
    range = stored.range;
    // A stored Daily period with a stored range wider than 3M is a legal
    // combination on disk (the two fields are written together but a past
    // version could have left them inconsistent) but not a legal one on
    // screen — reconcile before the first load, same as detail.js#mount.
    if (period === 'day' && range !== DAILY_RANGE_KEY) {
      range = DAILY_RANGE_KEY;
      writeCompareState(compareStorage(), { ids, period, range });
    }

    // Step 1: synchronous first paint from the store's already-hydrated
    // cache — must happen before any await.
    render();

    try {
      // Step 2: needed both to populate the picker's real candidate list
      // and to know which stored ids are still valid.
      const tResult = await st.loadTrackables();
      lastTrackablesError = tResult.error;
      trackablesLoaded = true;
      if (disposed) return;

      // Drop any id that is no longer a valid candidate (archived,
      // deleted, or simply never existed — e.g. a stale/garbage id left
      // over from an older version of this app), and write back if that
      // dropped anything, so it does not keep reappearing in storage
      // forever. Exactly detail.js#mount's overlay-selection reconciliation.
      const candidates = candidateList();
      const sanitized = sanitizeCompareIds(ids, candidates);
      if (sanitized.length !== ids.length || sanitized.some((v, i) => v !== ids[i])) {
        ids = sanitized;
        writeCompareState(compareStorage(), { ids, period, range });
      }
      render();

      // Step 3: every surviving selected id's whole history, in ONE
      // request (D.6b: load once, range/granularity changes never refetch).
      await loadHistories(ids);
      if (disposed) return;

      render();
    } catch (err) {
      if (disposed) return;
      // store.loadTrackables()/loadEntries() never reject, but guard the
      // whole sequence anyway — same defensive rule detail.js#mount uses
      // for its own identical try/catch.
      if (!lastTrackablesError) lastTrackablesError = err;
      trackablesLoaded = true;
      render();
    }
  }

  function unmount() {
    if (disposed) return;
    disposed = true;
    // Also destroy on unmount, not just on the next render — otherwise
    // navigating away from this screen for good (not just re-rendering it)
    // leaks the instance. Same rule every chart-owning view in this app
    // follows.
    destroyCompare();
    if (sectionEl) {
      sectionEl.removeEventListener('click', handleClick);
    }
    if (container) {
      container.innerHTML = '';
    }
    sectionEl = null;
    container = null;
    // Reset so a later mount() (e.g. navigating away and back) starts from
    // a clean read of storage rather than carrying over this instance's
    // in-memory state — exactly detail.js#unmount's own reasoning for its
    // overlay state.
    ids = [];
    period = 'week';
    range = '3m';
    trackablesLoaded = false;
    lastTrackablesError = null;
    loading = false;
    lastEntriesError = null;
    loadedIds.clear();
  }

  return { mount, unmount };
}
