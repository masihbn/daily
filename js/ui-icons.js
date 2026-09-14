// Chrome icon set (Step U.0, CONTRACT-U.0.md §5). PURE MODULE: no DOM, no
// fetch, no localStorage — same shape and safety contract as js/icons.js,
// which draws the per-trackable identity icons. This module is separate
// from that one because it draws the app's own chrome (nav, back/forward,
// expand, status pills, …), not a trackable's identity, and the two sets
// are never picked from the same UI (a trackable icon picker never lists
// "wifi-off"; a title bar never lists "dumbbell").
//
// Drawing rules — every entry MUST obey these or the set stops reading as
// one family (see CONTRACT-U.0.md §5):
//   - 24x24 viewBox, stroke-width 1.75, round caps/joins, `fill="none"` on
//     the wrapper.
//   - `currentColor` only. NO hardcoded hex anywhere in a path — a chrome
//     icon is tinted by its button's own `color` (fg / fg-2 / fg-3 /
//     good / bad depending on state), never by an inline colour of its
//     own. Where a glyph needs a solid dot (wifi-off's status dot), it is
//     drawn as a zero-length `<line>` with a round linecap instead of a
//     filled circle, so the "stroke only" rule never needs an exception.
//   - path is INNER markup only (one or more path/line/circle/rect/
//     polyline elements), NOT a whole <svg> — uiIconSvg() below supplies
//     the wrapper.

export const UI_ICON_KEYS = Object.freeze([
  'home',
  'compare',
  'settings',
  'back',
  'forward',
  'plus',
  'expand',
  'close',
  'check',
  'chevron-left',
  'chevron-right',
  'chevron-down',
  'edit',
  'share',
  'lock',
  'wifi-off',
  'clock',
]);

const PATHS = {
  home: '<path d="M4 11.5l8-7 8 7"/><path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9"/><path d="M10 20v-6h4v6"/>',

  compare: '<rect x="4" y="7" width="10" height="13" rx="2"/><rect x="10" y="4" width="10" height="13" rx="2"/>',

  settings:
    '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2"/>' +
    '<line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2"/>' +
    '<line x1="4" y1="18" x2="20" y2="18"/><circle cx="8" cy="18" r="2"/>',

  back: '<line x1="19" y1="12" x2="5" y2="12"/><path d="M11 6l-6 6 6 6"/>',

  forward: '<line x1="5" y1="12" x2="19" y2="12"/><path d="M13 6l6 6-6 6"/>',

  plus: '<line x1="12" y1="4" x2="12" y2="20"/><line x1="4" y1="12" x2="20" y2="12"/>',

  expand:
    '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>',

  close: '<line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/>',

  check: '<path d="M4 12l6 6L20 6"/>',

  'chevron-left': '<path d="M15 5l-7 7 7 7"/>',

  'chevron-right': '<path d="M9 5l7 7-7 7"/>',

  'chevron-down': '<path d="M5 9l7 7 7-7"/>',

  edit: '<path d="M4 20h4l11-11-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',

  share:
    '<path d="M14 4h6v6"/><path d="M20 4l-8 8"/>' +
    '<path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/>',

  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',

  'wifi-off':
    '<line x1="2" y1="2" x2="22" y2="22"/>' +
    '<path d="M16.7 11.1A11 11 0 0 1 19 12.6"/>' +
    '<path d="M5 12.6a11 11 0 0 1 5.2-2.4"/>' +
    '<path d="M10.7 5.1A16 16 0 0 1 22.6 9"/>' +
    '<path d="M1.4 9A16 16 0 0 1 6.1 6.1"/>' +
    '<path d="M8.5 16.1a6 6 0 0 1 7 0"/>' +
    '<line x1="12" y1="20" x2="12.01" y2="20"/>',

  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
};

// Wraps a PATHS[key] entry into a full inline <svg>. Returns '' for an
// unknown/missing/non-string key — never throws. This is the ONLY place
// this module produces markup meant for innerHTML; the caller (a view) is
// responsible for only ever assigning it via innerHTML on an element that
// holds nothing else user-supplied (same rule as js/icons.js's iconSvg()).
export function uiIconSvg(key) {
  if (typeof key !== 'string') return '';
  if (!Object.prototype.hasOwnProperty.call(PATHS, key)) return '';
  const path = PATHS[key];
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    path +
    '</svg>'
  );
}

// True iff `key` names a real entry in this set. Hostile input (undefined,
// null, numbers, objects, prototype-pollution keys like 'toString' or
// 'constructor', etc.) returns false rather than throwing — same guard
// pattern as js/icons.js's hasIcon().
export function hasUiIcon(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(PATHS, key);
}
