// Full-screen chart view (Step U.4, CONTRACT-U.4.md §4). Mounted at the
// real hash route `#/t/:id/chart/:kind` (js/router.js) — a landscape,
// sideways-scrolling rendering of the SAME model the detail screen's
// Weekly trend / Range card draws, opened from that card's Expand button
// (js/views/detail.js). Same view lifecycle as every other view in
// js/views/: `mount(el)` / `unmount()`, idempotent unmount, a `disposed`
// flag checked after every await, one delegated click listener on the
// root, no exception ever escapes a handler.
//
// Deliberately reuses detail.js's own pure exports (RANGES, resolveRange,
// historyFrom, and the three storage-key constants) rather than
// duplicating them — the fullscreen view answers exactly the same
// "what's in range/what's the lens" question the detail card does, over
// data loaded through the same store, and must read/write the SAME
// localStorage keys so the two stay in sync with each other.

import { getStore } from '../store.js';
import { todayLocal } from '../dates.js';
import { uiIconSvg } from '../ui-icons.js';
import {
  RANGES,
  resolveRange,
  historyFrom,
  RANGE_STORAGE_KEY,
  PERIOD_STORAGE_KEY,
  BOUNDS_PERIOD_STORAGE_KEY,
} from './detail.js';
import { renderWeekly, destroyWeekly, trendModel, PERIODS, periodKeysFor } from '../charts/weekly.js';
import { renderBounds, destroyBounds, boundsModel, boundsFor, DEFAULT_ROLLING_WINDOW_DAYS } from '../charts/bounds.js';
import { readOverlaySelection, overlayModel } from '../charts/overlay.js';
import { trackWidth as computeTrackWidth, pinnedAxisPlugin } from '../charts/scroll.js';
// Step U.5 (CONTRACT-U.5.md §4): the `kind: 'compare'` route reuses
// js/charts/compare.js's own pure model/state helpers verbatim — built
// "exactly as the compare view does" (js/views/compare.js), never a second
// copy of its candidate/sanitize/model logic.
import {
  compareCandidates,
  sanitizeCompareIds,
  readCompareState,
  writeCompareState,
  compareModel,
  renderCompare,
  destroyCompare,
} from '../charts/compare.js';
import { visibleTrackables } from './home-model.js';

const KIND_LABEL = { trend: 'Weekly trend', range: 'Range' };

export function createFullscreenView({ id, kind, store, today } = {}) {
  const st = store || getStore();
  const idStr = String(id);
  // Step U.5 (CONTRACT-U.5.md §4) adds a third legal kind, 'compare' — it
  // has no per-trackable `id` at all (main.js mounts it as
  // `createFullscreenView({ kind: 'compare' })`, no `id`). Anything other
  // than the three legal kinds is treated as 'trend' — main.js only ever
  // mounts this view from a route js/router.js has already validated, but
  // this view stays total (never throws) for any input, same discipline as
  // every pure export in detail.js.
  const chartKind = kind === 'range' ? 'range' : kind === 'compare' ? 'compare' : 'trend';
  const todayStr = today || todayLocal();

  let container = null;
  let sectionEl = null;
  let disposed = true;

  let trackable = null;
  let trackablesLoaded = false;
  let lastTrackablesError = null;
  let entriesLoaded = false;

  // Only meaningful for chartKind === 'range': the ONE overlay trackable
  // selected on the card (readOverlaySelection's first id), once resolved
  // to a real, non-archived trackable row.
  let overlayTrackable = null;

  // Only meaningful for chartKind === 'compare': the sanitized, ordered ids
  // from `daily.compare.v1` and the trackable rows they resolve to — this
  // view never writes `ids` back (§4: "ids untouched"), only reads them,
  // same as js/views/compare.js's own mount()-time reconciliation but with
  // nowhere to persist a correction (there is no picker here to reflect it).
  let compareIds = [];
  let compareTrackables = [];
  // Which specific 'empty' message applies: 'pick' for "fewer than one id"
  // (CONTRACT-U.5.md §4's own wording), 'data' for a real compareModel()
  // 'empty' status ("No entries in this range."). Irrelevant for the other
  // two kinds, whose 'empty' text never varies.
  let compareEmptyReason = 'data';

  let rangeKey = '3m';
  let periodKey = 'week';

  let mq = null;
  let rafHandle = null;

  // --- storage (iOS private mode throws on getItem/setItem — every access
  // is wrapped individually, same pattern as detail.js's own accessors) ---

  // Step U.5 (CONTRACT-U.5.md §4): chartKind === 'compare' reads/writes
  // range AND period through ONE localStorage blob (`daily.compare.v1`,
  // via charts/compare.js's own readCompareState/writeCompareState) instead
  // of the two/three per-trackable keys the trend/range kinds use — the
  // exact same storage shape js/views/compare.js's own screen uses, so the
  // two stay in sync with each other (§4: "range/period changes there write
  // to daily.compare.v1"). `ids` is always round-tripped unchanged: this
  // view never writes a correction back (see compareIds's own comment).
  function readStoredRange() {
    if (chartKind === 'compare') {
      return readCompareState(overlayStorage()).range;
    }
    try {
      const raw = localStorage.getItem(RANGE_STORAGE_KEY);
      if (typeof raw === 'string' && RANGES.some((r) => r.key === raw)) return raw;
    } catch {
      // Fall through to the default below.
    }
    return '3m';
  }

  function writeStoredRange(key) {
    if (chartKind === 'compare') {
      const s = readCompareState(overlayStorage());
      writeCompareState(overlayStorage(), { ids: s.ids, period: s.period, range: key });
      return;
    }
    try {
      localStorage.setItem(RANGE_STORAGE_KEY, key);
    } catch {
      // Best-effort only — see detail.js's identical comment.
    }
  }

  function periodStorageKey() {
    return chartKind === 'range' ? BOUNDS_PERIOD_STORAGE_KEY : PERIOD_STORAGE_KEY;
  }

  function defaultPeriod() {
    return chartKind === 'range' ? 'day' : 'week';
  }

  function readStoredPeriod() {
    if (chartKind === 'compare') {
      return readCompareState(overlayStorage()).period;
    }
    try {
      const raw = localStorage.getItem(periodStorageKey());
      if (typeof raw === 'string' && PERIODS.some((p) => p.key === raw)) return raw;
    } catch {
      // Fall through to the default below.
    }
    return defaultPeriod();
  }

  function writeStoredPeriod(key) {
    if (chartKind === 'compare') {
      const s = readCompareState(overlayStorage());
      writeCompareState(overlayStorage(), { ids: s.ids, period: key, range: s.range });
      return;
    }
    try {
      localStorage.setItem(periodStorageKey(), key);
    } catch {
      // Best-effort only.
    }
  }

  function overlayStorage() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  // --- data -----------------------------------------------------------

  function refreshTrackableFromStore() {
    const all = st.getTrackables();
    const list = Array.isArray(all) ? all : [];
    trackable = list.find((t) => t && String(t.id) === idStr) || null;
  }

  // Step U.5 (CONTRACT-U.5.md §4): "candidates via compareCandidates; ids
  // via sanitizeCompareIds" — recomputed on every call from the store's
  // current cache, never cached here, exactly js/views/compare.js's own
  // candidateList()/mount()-time reconciliation (a trackable archived or
  // edited elsewhere is reflected immediately, without this view needing
  // its own invalidation logic). `compareTrackables` preserves SELECTION
  // order (sanitizeCompareIds's own contract), which is what keeps a
  // series' colour stable — compareModel() colours by position in this list.
  function refreshCompareSelection() {
    const all = st.getTrackables();
    const list = Array.isArray(all) ? all : [];
    const candidates = compareCandidates(visibleTrackables(list));
    const stored = readCompareState(overlayStorage());
    compareIds = sanitizeCompareIds(stored.ids, candidates);
    compareTrackables = compareIds
      .map((cid) => candidates.find((c) => c && String(c.id) === cid))
      .filter(Boolean);
  }

  function findOverlayTrackable(oid) {
    const all = st.getTrackables();
    const list = Array.isArray(all) ? all : [];
    return list.find((t) => t && String(t.id) === oid && t.archived !== true) || null;
  }

  function windowDaysSetting() {
    const s = st.getSettings();
    const n = s && s.rolling_window_days;
    return typeof n === 'number' && Number.isInteger(n) && n >= 14 && n <= 730
      ? n
      : DEFAULT_ROLLING_WINDOW_DAYS;
  }

  // Step U.5 (CONTRACT-U.5.md §4): "model = compareModel(...) built exactly
  // as the compare view does" — js/views/compare.js's own entriesFor()/
  // mount() pass `from` straight from resolveRange() into compareModel()
  // WITHOUT resolving a null 'all'-range `from` via historyFrom() first
  // (compareModel already does that internally, across every selected
  // trackable's entries, when `from` is null). This view's own bucketCount
  // sizing step then reads the model's OWN `keys` back out — never a second,
  // possibly-disagreeing periodKeysFor() call — see renderChart() below.
  function buildCompareModel() {
    const { from, to } = resolveRange(rangeKey, todayStr);
    const entriesById = {};
    for (const t of compareTrackables) {
      const filters = { trackableIds: [String(t.id)], to };
      if (from !== null) filters.from = from;
      entriesById[String(t.id)] = st.getEntries(filters);
    }
    const model = compareModel({ trackables: compareTrackables, entriesById, from, to, period: periodKey });
    return { kind: 'compare', model, from, to, period: periodKey };
  }

  // The chart model plus the exact from/to/period it was built over — the
  // sizing step (bucketCount) must use the SAME window, or the track width
  // and the chart's own bucket count would disagree.
  function buildModel() {
    if (chartKind === 'compare') return buildCompareModel();

    const { from: rawFrom, to } = resolveRange(rangeKey, todayStr);
    const allEntries = st.getEntries({ trackableIds: [id] });
    const from = rawFrom !== null ? rawFrom : historyFrom(allEntries);

    const filters = { trackableIds: [id], to };
    if (from !== null) filters.from = from;
    const windowEntries = st.getEntries(filters);

    if (chartKind === 'trend') {
      const model = trendModel({ trackable, entries: windowEntries, from, to, period: periodKey });
      return { kind: 'trend', model, from, to, period: periodKey };
    }

    const wd = windowDaysSetting();
    const bm = boundsModel({ trackable, entries: windowEntries, from, to, period: periodKey, windowDays: wd });

    let overlays = [];
    if (overlayTrackable) {
      const overlayFilters = { trackableIds: [String(overlayTrackable.id)], to };
      if (from !== null) overlayFilters.from = from;
      const overlayEntries = st.getEntries(overlayFilters);
      const overlayBounds = boundsFor(overlayTrackable, overlayEntries, wd);
      overlays = [
        overlayModel({
          trackable: overlayTrackable,
          entries: overlayEntries,
          keys: bm.dates,
          period: bm.period,
          bounds: overlayBounds,
        }),
      ];
    }

    const model = { ...bm, overlays, name: trackable && trackable.name };
    return { kind: 'range', model, from, to, period: periodKey };
  }

  function isEmptyModel(built) {
    if (!built) return true;
    if (built.kind === 'trend') return built.model.isEmpty === true;
    return built.model.status !== 'ok';
  }

  // --- lifecycle helpers ------------------------------------------------

  function scheduleRerender() {
    if (rafHandle !== null) return;
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      if (!disposed) render();
    });
  }

  function attachResponsiveListeners() {
    try {
      window.addEventListener('resize', scheduleRerender);
    } catch {
      // A browser with no window (never true in practice) must not break
      // mount().
    }
    try {
      mq = window.matchMedia('(orientation: portrait)');
      if (mq) {
        if (typeof mq.addEventListener === 'function') mq.addEventListener('change', scheduleRerender);
        else if (typeof mq.addListener === 'function') mq.addListener(scheduleRerender);
      }
    } catch {
      mq = null;
    }
  }

  function detachResponsiveListeners() {
    try {
      window.removeEventListener('resize', scheduleRerender);
    } catch {
      // See attachResponsiveListeners().
    }
    if (mq) {
      try {
        if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', scheduleRerender);
        else if (typeof mq.removeListener === 'function') mq.removeListener(scheduleRerender);
      } catch {
        // Never let teardown throw.
      }
    }
    mq = null;
    if (rafHandle !== null) {
      try {
        cancelAnimationFrame(rafHandle);
      } catch {
        // See above.
      }
      rafHandle = null;
    }
  }

  // --- render -----------------------------------------------------------

  function ensureSection() {
    if (sectionEl) return sectionEl;
    sectionEl = document.createElement('section');
    sectionEl.className = 'fullscreen';
    sectionEl.addEventListener('click', handleClick);
    container.appendChild(sectionEl);
    return sectionEl;
  }

  function titleText() {
    // Step U.5: there is no single trackable to name here — the bar's title
    // is just 'Compare', matching the top-level screen's own title bar.
    if (chartKind === 'compare') return 'Compare';
    const name = trackable && typeof trackable.name === 'string' ? trackable.name : '';
    return `${name} · ${KIND_LABEL[chartKind] || ''}`;
  }

  function statusTextFor(state, lastError) {
    if (state === 'loading') return 'Loading…';
    if (state === 'notfound') return 'Trackable not found.';
    if (state === 'error') return (lastError && lastError.message) || 'Something went wrong.';
    if (state === 'empty') {
      // Step U.5 (CONTRACT-U.5.md §4): compare's 'empty' state carries one of
      // two distinct messages depending on WHY it is empty — "fewer than one
      // id" selected (nothing to even try loading) reads differently from a
      // real compareModel() 'empty' status (ids selected, no entries in this
      // window). The other two kinds' 'empty' text never varies.
      if (chartKind === 'compare') {
        return compareEmptyReason === 'pick'
          ? 'Pick two or more trackables to compare them.'
          : 'No entries in this range.';
      }
      return 'Not enough data yet.';
    }
    return '';
  }

  function buildBar(section) {
    const bar = document.createElement('div');
    bar.className = 'fs-bar';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'fs-close btn btn--icon btn--ghost';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = uiIconSvg('close');
    bar.appendChild(closeBtn);

    const h2 = document.createElement('h2');
    h2.className = 'fs-title';
    h2.textContent = titleText();
    bar.appendChild(h2);

    const controls = document.createElement('div');
    controls.className = 'fs-controls';

    const rangesDiv = document.createElement('div');
    rangesDiv.className = 'seg fs-ranges';
    rangesDiv.setAttribute('role', 'group');
    rangesDiv.setAttribute('aria-label', 'Date range');
    for (const r of RANGES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'seg__item fs-range';
      btn.dataset.range = r.key;
      btn.setAttribute('aria-pressed', String(r.key === rangeKey));
      btn.textContent = r.label;
      rangesDiv.appendChild(btn);
    }
    controls.appendChild(rangesDiv);

    const periodsDiv = document.createElement('div');
    periodsDiv.className = 'seg fs-periods';
    periodsDiv.setAttribute('role', 'group');
    periodsDiv.setAttribute('aria-label', 'Granularity');
    for (const p of PERIODS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'seg__item fs-period';
      btn.dataset.period = p.key;
      btn.setAttribute('aria-pressed', String(p.key === periodKey));
      btn.textContent = p.label;
      periodsDiv.appendChild(btn);
    }
    controls.appendChild(periodsDiv);

    bar.appendChild(controls);
    section.appendChild(bar);
  }

  // Builds the chart into an already-attached `.fs-track`/`.fs-stage` so
  // `stage.clientWidth` reflects real, laid-out CSS — the whole reason the
  // stage skeleton is appended into the live document BEFORE this runs.
  function renderChart(built, stage, scroll, track) {
    // Step U.5: compareModel() already computed its own gap-free bucket-key
    // list (`built.model.keys`) — from a `from` that may itself be null
    // (resolved internally, across every selected trackable's entries) — so
    // reading it back out here is the single source of truth for the bucket
    // count. A second, independent periodKeysFor(built.period, built.from,
    // built.to) call would disagree whenever `built.from` is null, since
    // this view never resolves it via historyFrom() for the compare kind
    // (see buildCompareModel()'s own comment).
    const bucketCount =
      built.kind === 'compare'
        ? (built.model && Array.isArray(built.model.keys) ? built.model.keys.length : 0)
        : periodKeysFor(built.period, built.from, built.to).length;
    const viewportWidth = stage.clientWidth;
    const width = computeTrackWidth(bucketCount, built.period, viewportWidth);

    // CONTRACT-U.4.md §7: ".fs-track ... its width is set inline by the
    // view" — the canvas wrap inside renderWeekly()/renderBounds() gets
    // the same width (opts.trackWidth), but that alone does not widen
    // .fs-track's OWN box: a block element's width fills its containing
    // block regardless of an overflowing child's explicit pixel width, so
    // without this, .fs-scroll's scrollWidth (and hence how far the view
    // can scroll) would stay pinned to the viewport width instead of the
    // real track width.
    track.style.width = `${width}px`;

    const leftAxis = document.createElement('canvas');
    leftAxis.className = 'fs-axis';
    leftAxis.dataset.side = 'left';

    const hasOverlay =
      built.kind === 'range' && Array.isArray(built.model.overlays) && built.model.overlays.length > 0;

    const plugins = [pinnedAxisPlugin(leftAxis, 'left')];
    let rightAxis = null;
    if (hasOverlay) {
      rightAxis = document.createElement('canvas');
      rightAxis.className = 'fs-axis';
      rightAxis.dataset.side = 'right';
      plugins.push(pinnedAxisPlugin(rightAxis, 'right'));
    }

    const opts = { chrome: false, trackWidth: width, plugins };
    let chartRoot;
    if (built.kind === 'trend') chartRoot = renderWeekly(built.model, opts);
    else if (built.kind === 'range') chartRoot = renderBounds(built.model, opts);
    else chartRoot = renderCompare(built.model, opts);
    track.appendChild(chartRoot);

    stage.appendChild(leftAxis);
    if (rightAxis) stage.appendChild(rightAxis);

    // Today at the right edge on open (§0 decision 5) — and again after
    // every re-render (resize/orientation), which is the correct behaviour
    // there too: the chart was rebuilt at a new width/height, so "the
    // scroll position from before" no longer means anything.
    scroll.scrollLeft = scroll.scrollWidth;
  }

  function render() {
    if (disposed || !container) return;
    destroyWeekly();
    destroyBounds();
    destroyCompare();

    const section = ensureSection();

    let state;
    let built = null;
    compareEmptyReason = 'data';

    if (!trackablesLoaded) {
      state = 'loading';
    } else if (chartKind === 'compare') {
      // Step U.5 (CONTRACT-U.5.md §4): candidates/ids are recomputed from
      // the store's current cache on every render (never cached across
      // renders) — same rule js/views/compare.js's own candidateList()
      // follows, so a trackable archived/edited elsewhere while this screen
      // is open is reflected immediately.
      refreshCompareSelection();
      if (compareIds.length < 1) {
        state = 'empty';
        compareEmptyReason = 'pick';
      } else if (!entriesLoaded) {
        state = 'loading';
      } else {
        built = buildModel();
        state = isEmptyModel(built) ? 'empty' : 'ready';
      }
    } else if (lastTrackablesError && !trackable) {
      state = 'error';
    } else if (!trackable) {
      state = 'notfound';
    } else if (!entriesLoaded) {
      state = 'loading';
    } else {
      built = buildModel();
      state = isEmptyModel(built) ? 'empty' : 'ready';
    }

    const rotated = mq ? !!mq.matches : false;
    section.dataset.kind = chartKind;
    section.dataset.rotated = String(rotated);
    section.dataset.fsState = state;
    section.innerHTML = '';

    buildBar(section);

    const stage = document.createElement('div');
    stage.className = 'fs-stage';
    const scroll = document.createElement('div');
    scroll.className = 'fs-scroll';
    const track = document.createElement('div');
    track.className = 'fs-track';
    scroll.appendChild(track);
    stage.appendChild(scroll);
    section.appendChild(stage);

    const status = document.createElement('p');
    status.className = 'fs-status';
    status.textContent = statusTextFor(state, lastTrackablesError);
    status.hidden = state === 'ready';
    section.appendChild(status);

    if (state === 'ready' && built) {
      renderChart(built, stage, scroll, track);
    }
  }

  // --- event handlers -----------------------------------------------------

  function handleClose() {
    try {
      // Contract amendment (post-U.4, fixing F4): `history.length` is not a
      // usable signal for "was this route opened from within the app" — a
      // fresh tab already reports length 2 before this app runs a single
      // navigation of its own, while a cold-launched PWA can report 1
      // either way. detail.js's Expand button stamps `{ fromApp: true }`
      // into the history entry it pushes for this exact route, so reading
      // history.state here tells the two cases apart reliably: opened from
      // the app -> a real back() (so the iOS back gesture and this Close
      // button behave identically); cold launch / a direct/bookmarked URL
      // -> state is null, so go straight to the trackable instead of
      // risking `back()` leaving the app entirely.
      if (history.state && history.state.fromApp === true) {
        history.back();
      } else if (chartKind === 'compare') {
        // Step U.5 (CONTRACT-U.5.md §2/§4): the compare screen's own Expand
        // button opens this route with a plain `location.hash =` (no
        // pushState/fromApp stamp — see js/views/compare.js's own comment on
        // why that trick isn't needed here), so this branch is really the
        // ONLY path this kind ever takes: history.back() above never fires
        // for it in practice, but is kept for symmetry with the other two
        // kinds and in case a future caller ever does stamp fromApp.
        location.hash = '#/compare';
      } else {
        location.hash = `#/t/${encodeURIComponent(idStr)}`;
      }
    } catch {
      // A navigation failure must never throw out of a click handler.
    }
  }

  function handleRangeChange(key) {
    if (key === rangeKey) return;
    if (!RANGES.some((r) => r.key === key)) return;
    rangeKey = key;
    writeStoredRange(key);
    render();
  }

  function handlePeriodChange(key) {
    if (key === periodKey) return;
    if (!PERIODS.some((p) => p.key === key)) return;
    // §0 decision 4: any range × any period in fullscreen — unlike the
    // detail card, Daily is never forced back to a 3-month range here.
    periodKey = key;
    writeStoredPeriod(key);
    render();
  }

  function handleClick(event) {
    try {
      const target = event.target;
      if (!target || !target.closest) return;

      const closeBtn = target.closest('button.fs-close');
      if (closeBtn && sectionEl.contains(closeBtn)) {
        handleClose();
        return;
      }

      const rangeBtn = target.closest('button.fs-range[data-range]');
      if (rangeBtn && sectionEl.contains(rangeBtn)) {
        handleRangeChange(rangeBtn.dataset.range);
        return;
      }

      const periodBtn = target.closest('button.fs-period[data-period]');
      if (periodBtn && sectionEl.contains(periodBtn)) {
        handlePeriodChange(periodBtn.dataset.period);
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
    rangeKey = readStoredRange();
    periodKey = readStoredPeriod();

    attachResponsiveListeners();

    if (chartKind === 'compare') {
      refreshCompareSelection();
    } else {
      refreshTrackableFromStore();
    }
    render();

    try {
      // Step U.5 (CONTRACT-U.5.md §4): a completely separate load sequence
      // for 'compare' — there is no single trackable to find-or-fetch, no
      // rolling-window setting to read (compareModel() has no bands), and no
      // overlay slot. Trackables are only (re)loaded when the cache has
      // nothing to show yet, same "don't refetch what's already there" rule
      // the trend/range branch below applies to its own single `trackable`.
      if (chartKind === 'compare') {
        if (compareTrackables.length === 0) {
          const tResult = await st.loadTrackables();
          lastTrackablesError = tResult.error;
        }
        trackablesLoaded = true;
        if (disposed) return;
        refreshCompareSelection();
        render();

        if (compareIds.length === 0) return;

        // One request for every selected id's WHOLE history (D.6b: load
        // once, range/granularity changes never refetch) — exactly
        // js/views/compare.js's own loadHistories() contract, restated here
        // because this view has no picker to grow that list incrementally.
        await st.loadEntries({ trackableIds: compareIds });
        if (disposed) return;
        entriesLoaded = true;

        render();
        return;
      }

      if (!trackable) {
        const tResult = await st.loadTrackables();
        lastTrackablesError = tResult.error;
      }
      trackablesLoaded = true;
      if (disposed) return;
      refreshTrackableFromStore();
      render();

      if (!trackable) return;

      if (st.getSettings() === null) await st.loadSettings();
      if (disposed) return;

      // Whole history, same as detail.js's loadAllEntries() — the 3M/6M/
      // 1Y/All range control here is a purely local filter over data
      // already in hand, same reasoning as the card.
      await st.loadEntries({ trackableIds: [id] });
      if (disposed) return;
      entriesLoaded = true;

      if (chartKind === 'range') {
        const sel = readOverlaySelection(overlayStorage(), idStr);
        const oid = sel[0];
        if (oid) {
          const found = findOverlayTrackable(oid);
          if (found) {
            overlayTrackable = found;
            await st.loadEntries({ trackableIds: [String(found.id)] });
            if (disposed) return;
          }
        }
      }

      render();
    } catch (err) {
      if (disposed) return;
      trackablesLoaded = true;
      entriesLoaded = true;
      if (!lastTrackablesError) lastTrackablesError = err;
      render();
    }
  }

  function unmount() {
    if (disposed) return;
    disposed = true;
    destroyWeekly();
    destroyBounds();
    destroyCompare();
    detachResponsiveListeners();
    if (sectionEl) {
      sectionEl.removeEventListener('click', handleClick);
    }
    if (container) {
      container.innerHTML = '';
    }
    sectionEl = null;
    container = null;
    trackable = null;
    trackablesLoaded = false;
    lastTrackablesError = null;
    entriesLoaded = false;
    overlayTrackable = null;
    compareIds = [];
    compareTrackables = [];
    compareEmptyReason = 'data';
  }

  return { mount, unmount };
}
