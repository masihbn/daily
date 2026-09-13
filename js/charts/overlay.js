// Correlation marker overlay (Step 3.4). Chart type 4a: discrete events
// from OTHER trackables (gym days, smoking days) drawn as markers on the
// Range chart (js/charts/bounds.js), so the user can visually connect
// habit logs to a bounded metric's movement. See CONTRACT-3.4.md §0 for
// the settled design decisions this module encodes — do not re-derive
// them from first principles while reading this file.
//
// Same split as js/charts/bounds.js and js/charts/weekly.js: everything
// except renderOverlayPicker() runs with no DOM at all — no `fetch`, no
// `document`, no `window`. Only renderOverlayPicker() touches `document`.
// This module issues ZERO network requests, ever — the caller
// (js/views/detail.js) is the one place that loads entries through the
// store and localStorage through the injected `storage` argument below.
//
// Allowed imports, and only these (CONTRACT-3.4.md §1):
import { isoWeekKey } from '../dates.js';

// --- §1 constants ----------------------------------------------------------

export const OVERLAY_STORAGE_KEY = 'daily.detail.overlay.v1';
export const MAX_OVERLAYS = 3;
// §0 rule 3 — the "rug": each overlay is drawn on a fixed, hidden y-axis
// row rather than at the metric's own value that day, so the marker never
// depends on the metric's scale/bounds and never collides with another
// overlay's row.
export const OVERLAY_ROW_BASE = 0.06;
export const OVERLAY_ROW_STEP = 0.08;
export const OVERLAY_POINT_STYLES = ['triangle', 'rect', 'rectRot'];
export const OVERLAY_POINT_RADIUS = 5;

const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object';
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// --- §1 isOverlayCandidate ---------------------------------------------

// §0 rule 2 — candidates are trackables whose logged days are discrete
// EVENTS: boolean rows, or numeric rows whose aggregation is 'count' or
// 'sum'. 'average'/'last' numerics (calories, weight) are continuous
// readings, not events — that is what Step 3.5's comparison chart is for,
// never this one. Never throws.
export function isOverlayCandidate(trackable) {
  if (!isPlainObject(trackable)) return false;
  if (trackable.archived === true) return false;
  if (trackable.value_shape === 'boolean') return true;
  if (trackable.value_shape === 'numeric') {
    return trackable.aggregation === 'count' || trackable.aggregation === 'sum';
  }
  return false;
}

// --- §1 overlayCandidates ------------------------------------------------

// Filters `trackables` to overlay candidates, excluding the metric itself
// (compared as strings, since ids may be numbers on the wire and strings
// once round-tripped through localStorage — §0 rule 6). Input order is
// preserved; the caller passes visibleTrackables(list), which is already
// sorted the way the rest of the detail screen expects. Never throws.
export function overlayCandidates(trackables, metricId) {
  if (!Array.isArray(trackables)) return [];
  const metricIdStr = String(metricId);
  return trackables.filter(
    (t) => isOverlayCandidate(t) && String(t.id) !== metricIdStr
  );
}

// --- §1 readOverlaySelection / writeOverlaySelection ----------------------

// Reads the raw { [metricId]: string[] } blob out of `storage`, tolerating
// every way it can be missing or malformed. Never throws, regardless of
// what `storage` is or does.
function readRawSelectionMap(storage) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(OVERLAY_STORAGE_KEY);
    if (typeof raw !== 'string') return {};
    const parsed = JSON.parse(raw);
    // A top-level array (or any non-plain-object) is not the documented
    // shape — treat it exactly like a missing key rather than guessing at
    // what it might mean.
    if (!isPlainObject(parsed) || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

// `storage` is any object with getItem(key)/setItem(key, value), or
// null/undefined — same injectable-storage shape as js/store.js. Never
// throws.
export function readOverlaySelection(storage, metricId) {
  const map = readRawSelectionMap(storage);
  const value = map[String(metricId)];
  if (!Array.isArray(value)) return [];
  return value.map(String);
}

// Merges { [String(metricId)]: ids.map(String) } into whatever else is
// already stored, so writing one metric's selection never clobbers
// another's (CONTRACT-3.4.md §1). An unreadable existing value is treated
// as {} (readRawSelectionMap already does this). Storage errors —
// including setItem throwing, e.g. iOS private mode — are swallowed.
// Never throws.
export function writeOverlaySelection(storage, metricId, ids) {
  if (!storage) return;
  try {
    const existing = readRawSelectionMap(storage);
    const merged = {
      ...existing,
      [String(metricId)]: (Array.isArray(ids) ? ids : []).map(String),
    };
    storage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Best-effort only — an unwritable store just means the selection
    // won't persist, which is not fatal (same rule as detail.js's own
    // writeStoredRange/writeStoredPeriod).
  }
}

// --- §1 sanitizeSelection --------------------------------------------------

// Coerces to strings, drops ids that are not current candidates, dedupes
// (first occurrence wins), and caps at MAX_OVERLAYS — all while KEEPING
// SELECTION ORDER (not candidate order), because selection order is what
// decides each overlay's row/point-style index (§0 rule 3). Never throws.
export function sanitizeSelection(ids, candidates) {
  if (!Array.isArray(ids)) return [];
  const candidateList = Array.isArray(candidates) ? candidates : [];
  const candidateIds = new Set(
    candidateList.filter(isPlainObject).map((c) => String(c.id))
  );

  const seen = new Set();
  const out = [];
  for (const raw of ids) {
    const s = String(raw);
    if (!candidateIds.has(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_OVERLAYS) break;
  }
  return out;
}

// --- §1 overlayBucketKey ---------------------------------------------------

// Bucket key for one entry_date under `period`, matching whatever lens the
// Range chart itself is using (boundsModel().period) — §0 rule 5, so
// marker k lines up with the metric's own point k. A malformed date (not
// matching the 'YYYY-MM-DD' shape, or not a real calendar date) is null,
// never a throw.
export function overlayBucketKey(dateStr, period) {
  if (typeof dateStr !== 'string' || !DATE_STR_RE.test(dateStr)) return null;
  try {
    if (period === 'week') return isoWeekKey(dateStr);
    if (period === 'month') return dateStr.slice(0, 7);
    // Unknown period, and 'day' itself, both use the date string as-is.
    return dateStr;
  } catch {
    // isoWeekKey() throws on a shape-valid-but-not-real date (e.g.
    // 2024-02-30) — this module's contract is "never throws", so that
    // becomes null here, same as any other malformed date.
    return null;
  }
}

// --- §1 overlayModel ---------------------------------------------------

// The per-overlay model plotted against `keys` (boundsModel().dates, in
// order). §0 rule 4: a day counts as "logged" iff its entry has a finite
// numeric value > 0 — a boolean row's stored 1 qualifies, a numeric count
// of 0 does not. Duplicate entry_date rows are deduped FIRST WINS before
// the logged check, exactly as js/charts/bounds.js#boundsSeries dedupes —
// one implementation of that rule would be nice, but the two modules
// don't share an import path for it (bounds.js dedupes for 'average'
// rollup, this dedupes for "was this calendar day an event at all"), so
// it is intentionally re-stated here rather than stretched into a shared
// helper that would blur two different questions. Never throws.
export function overlayModel({ trackable, entries, keys, period } = {}) {
  const id = isPlainObject(trackable) ? String(trackable.id) : '';
  const name =
    isPlainObject(trackable) && typeof trackable.name === 'string' && trackable.name !== ''
      ? trackable.name
      : '';
  const color =
    isPlainObject(trackable) && typeof trackable.color === 'string' && trackable.color !== ''
      ? trackable.color
      : null;

  const keyList = Array.isArray(keys) ? keys : [];
  const counts = new Array(keyList.length).fill(0);

  // First key wins for a repeated key too, though boundsModel() never
  // actually produces duplicate keys — this just keeps the lookup total.
  const keyIndex = new Map();
  keyList.forEach((k, i) => {
    if (!keyIndex.has(k)) keyIndex.set(k, i);
  });

  const list = Array.isArray(entries) ? entries : [];
  const byDate = new Map();
  for (const e of list) {
    if (!isPlainObject(e)) continue;
    const d = e.entry_date;
    if (typeof d !== 'string' || !DATE_STR_RE.test(d)) continue;
    if (!byDate.has(d)) byDate.set(d, e);
  }

  for (const [dateStr, entry] of byDate) {
    if (!isFiniteNumber(entry.value) || entry.value <= 0) continue; // not "logged"
    const bucketKey = overlayBucketKey(dateStr, period);
    if (bucketKey === null) continue;
    const idx = keyIndex.get(bucketKey);
    if (idx === undefined) continue; // outside the plotted range
    counts[idx] += 1;
  }

  const total = counts.reduce((a, b) => a + b, 0);
  return { id, name, color, counts, total };
}

// --- §1 overlayRowY / overlayPointStyle -----------------------------------

export function overlayRowY(index) {
  return OVERLAY_ROW_BASE + index * OVERLAY_ROW_STEP;
}

export function overlayPointStyle(index) {
  return OVERLAY_POINT_STYLES[index % OVERLAY_POINT_STYLES.length];
}

// --- §1 overlayTooltipLabel ------------------------------------------------

// At 'day' one marker means "logged that day" — the name says it all. At
// 'week'/'month' a marker means "at least one logged day in the bucket",
// so the tooltip must carry the count or it reads as a single event that
// may actually be three. Never throws.
export function overlayTooltipLabel(model, index, period) {
  const name = isPlainObject(model) && typeof model.name === 'string' ? model.name : '';
  const counts = isPlainObject(model) && Array.isArray(model.counts) ? model.counts : null;

  if (period !== 'week' && period !== 'month') return name;
  if (counts === null || !Number.isInteger(index) || index < 0 || index >= counts.length) {
    return name;
  }
  const n = counts[index];
  return `${name} · ${n} ${n === 1 ? 'day' : 'days'}`;
}

// --- §1 overlayDatasets --------------------------------------------------

// PURE Chart.js dataset configs, one per model, in selection order — index
// `i` here is what overlayRowY()/overlayPointStyle() key off, so it MUST
// be the model's position in `models`, not anything derived from the
// model itself. `showLine: false` + a hidden linear axis (wired up by the
// caller, js/charts/bounds.js) is what turns this into a rug of marker
// dots rather than a second line. Never throws.
export function overlayDatasets(models, fallbackColor) {
  const list = Array.isArray(models) ? models : [];
  return list.map((model, i) => {
    const counts = isPlainObject(model) && Array.isArray(model.counts) ? model.counts : [];
    const name = isPlainObject(model) && typeof model.name === 'string' ? model.name : '';
    const color = (isPlainObject(model) && model.color) || fallbackColor;
    return {
      type: 'line',
      label: name,
      showLine: false,
      yAxisID: 'yOverlay',
      data: counts.map((c) => (c > 0 ? overlayRowY(i) : null)),
      pointStyle: overlayPointStyle(i),
      pointRadius: OVERLAY_POINT_RADIUS,
      pointHoverRadius: OVERLAY_POINT_RADIUS + 1,
      backgroundColor: color,
      borderColor: color,
      borderWidth: 1,
      spanGaps: false,
    };
  });
}

// =============================================================================
// DOM — the only export in this file that touches `document`.
// =============================================================================

// The 'overlay' chart slot's content: NOT a chart, but the picker that
// adds/removes marker rows on the Range chart above (§0 rule 1). Builds
// with createElement/textContent only — no innerHTML, no listeners
// (js/views/detail.js owns the single delegated click listener that reads
// button.overlay-chip[data-overlay-id]).
export function renderOverlayPicker({ candidates, selected, disabled } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const selectedIds = Array.isArray(selected) ? selected.map(String) : [];

  const root = document.createElement('div');
  root.className = 'overlay-picker';

  const hint = document.createElement('p');
  hint.className = 'overlay-hint';
  if (list.length === 0) {
    hint.textContent = 'Nothing to overlay yet — add a yes/no or count trackable.';
  } else if (selectedIds.length === 0) {
    hint.textContent = 'Pick up to 3 to mark their logged days on the Range chart above.';
  } else {
    hint.textContent = 'Marked on the Range chart above.';
  }
  root.appendChild(hint);

  // No candidates -> the chips group is omitted entirely (§1), not just
  // rendered empty — there is nothing to group.
  if (list.length === 0) return root;

  const chips = document.createElement('div');
  chips.className = 'overlay-chips';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Overlay trackables');

  for (const candidate of list) {
    const cid = isPlainObject(candidate) ? String(candidate.id) : '';
    const isSelected = selectedIds.includes(cid);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'overlay-chip';
    btn.dataset.overlayId = cid;
    btn.setAttribute('aria-pressed', String(isSelected));
    btn.textContent =
      isPlainObject(candidate) && typeof candidate.name === 'string' ? candidate.name : '';

    const color =
      isPlainObject(candidate) && typeof candidate.color === 'string' && candidate.color !== ''
        ? candidate.color
        : null;
    if (color) btn.style.setProperty('--chip-color', color);

    // Disabled when the caller says so (a load is in flight), or when this
    // chip isn't already selected and the cap is reached (§0 rule 6).
    btn.disabled = disabled === true || (!isSelected && selectedIds.length >= MAX_OVERLAYS);

    chips.appendChild(btn);
  }

  root.appendChild(chips);
  return root;
}
