// Hand-written monochrome icon set (Step 2.5). PURE MODULE: no DOM, no
// fetch, no localStorage — safe to import from a pure view-model module or
// from DOM-wiring code alike.
//
// Why this exists: the per-trackable `color` was stored and computed into
// rowModel() but nothing ever rendered it, so picking a colour had no
// visible effect anywhere (user-reported bug). The fix is to give every
// trackable an icon whose glyph is tinted by that colour — see
// CONTRACT-2.5.md §0. This module owns ONLY the icon geometry and lookup;
// the tinting itself happens in the views (home.js/detail.js/trackable.js)
// via a CSS `color` set from the trackable's stored colour, which the SVG's
// `stroke="currentColor"` (and, for `dot` only, `fill="currentColor"`)
// picks up.
//
// Drawing rules — every entry MUST obey these or the set stops reading as
// one family:
//   - 24x24 viewBox, stroke-width 2, round caps/joins.
//   - `currentColor` only. NO hardcoded hex anywhere in a path — that is
//     what makes an icon tintable at all; a stray hex would silently break
//     tinting for that one icon only, which is exactly the kind of defect
//     nobody notices. `dot` is the sole deliberate exception to "fill:
//     none": it is a plain FILLED circle (the documented fallback shown
//     before a trackable has any icon chosen), so its circle sets
//     `fill="currentColor"` explicitly — still tintable, never a hardcoded
//     colour.
//   - Simple geometric silhouettes over detail: these render around 28px
//     on a phone.

// path is INNER markup only (one or more path/circle/line/rect elements),
// NOT a whole <svg> — iconSvg() below supplies the wrapper.
export const ICONS = {
  // --- Fitness -------------------------------------------------------
  dumbbell: {
    label: 'Dumbbell',
    path:
      '<path d="M4 9v6"/><path d="M20 9v6"/><path d="M4 12h3"/><path d="M17 12h3"/>' +
      '<rect x="7" y="7" width="2" height="10" rx="1"/><rect x="15" y="7" width="2" height="10" rx="1"/>' +
      '<path d="M9 12h6"/>',
  },
  run: {
    label: 'Run',
    path:
      '<circle cx="15" cy="4" r="2"/><path d="M15 6l-2 5"/><path d="M13 11l4 3-1 6"/>' +
      '<path d="M13 11l-5 2"/><path d="M17 14l4-1"/><path d="M16 14l-2 4-4 2"/>',
  },
  walk: {
    label: 'Walk',
    path:
      '<circle cx="12" cy="4" r="2"/><path d="M12 6v6"/><path d="M12 8l-3 2"/>' +
      '<path d="M12 8l3 3"/><path d="M12 12l-2 8"/><path d="M12 12l3 8"/>',
  },
  bike: {
    label: 'Bike',
    path:
      '<circle cx="6" cy="17" r="3.5"/><circle cx="18" cy="17" r="3.5"/>' +
      '<path d="M6 17l4-8h4l3 8"/><path d="M10 9h3"/><path d="M13 17l2-8 3 3"/>',
  },
  swim: {
    label: 'Swim',
    path:
      '<circle cx="18" cy="5" r="1.6"/><path d="M4 9c3-2 5 2 8 0s5-2 8 0"/>' +
      '<path d="M2 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M2 19c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/>',
  },
  stretch: {
    label: 'Stretch',
    path:
      '<circle cx="12" cy="4" r="2"/><path d="M12 6v8"/><path d="M12 8l-4-4"/>' +
      '<path d="M12 8l4-4"/><path d="M12 14l-3 6"/><path d="M12 14l3 6"/>',
  },
  heart: {
    label: 'Heart',
    path:
      '<path d="M12 21s-7-4.35-9.5-9C1 8.5 2 5 5.5 5c2 0 3.5 1.2 4.5 3 1-1.8 2.5-3 4.5-3 3.5 0 4.5 3.5 3 7-2.5 4.65-9.5 9-9.5 9z"/>',
  },

  // --- Health ----------------------------------------------------------
  water: {
    label: 'Water',
    path: '<path d="M12 3c4 5 7 8.5 7 12a7 7 0 0 1-14 0c0-3.5 3-7 7-12z"/>',
  },
  apple: {
    label: 'Apple',
    path:
      '<path d="M12 8c-3-3-7-2-7 3 0 5 4 9 7 9s7-4 7-9c0-5-4-6-7-3z"/>' +
      '<path d="M12 8V5"/><path d="M12 5c0-1.5 1-2 2.5-2"/>',
  },
  pill: {
    label: 'Pill',
    path: '<rect x="3" y="9" width="18" height="6" rx="3"/><path d="M12 9v6"/>',
  },
  scale: {
    label: 'Scale',
    path:
      '<path d="M12 3v18"/><path d="M6 21h12"/><path d="M4 7h16"/>' +
      '<path d="M4 7l-2 5a3 3 0 0 0 6 0z"/><path d="M20 7l-2 5a3 3 0 0 0 6 0z"/>',
  },
  floss: {
    label: 'Floss',
    path:
      '<rect x="4" y="6" width="10" height="12" rx="2"/><circle cx="9" cy="9" r="1.5"/>' +
      '<circle cx="9" cy="15" r="1.5"/><path d="M14 10l6-2"/><path d="M14 14l6 2"/>',
  },
  sun: {
    label: 'Sun',
    path:
      '<circle cx="12" cy="12" r="4"/>' +
      '<path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1"/>',
  },

  // --- Sleep -----------------------------------------------------------
  bed: {
    label: 'Bed',
    path:
      '<path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6"/>' +
      '<path d="M3 18v2M21 18v2"/><path d="M3 13v-3a2 2 0 0 1 2-2h4v5"/>',
  },
  moon: {
    label: 'Moon',
    path: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
  },
  alarm: {
    label: 'Alarm',
    path:
      '<circle cx="12" cy="13" r="7"/><path d="M12 9v4l3 2"/>' +
      '<path d="M5 3L3 5M19 3l2 2"/><path d="M9 3h6"/>',
  },

  // --- Focus -------------------------------------------------------------
  target: {
    label: 'Target',
    path: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  },
  checklist: {
    label: 'Checklist',
    path:
      '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3h6v2H9z"/>' +
      '<path d="M8 11l2 2 4-4"/><path d="M8 17h8"/>',
  },
  timer: {
    label: 'Timer',
    path: '<circle cx="12" cy="13" r="8"/><path d="M12 13V9"/><path d="M10 2h4"/><path d="M12 2v3"/>',
  },
  laptop: {
    label: 'Laptop',
    path: '<rect x="4" y="5" width="16" height="10" rx="1"/><path d="M2 19h20"/>',
  },
  inbox: {
    label: 'Inbox',
    path:
      '<path d="M3 12h5l2 3h4l2-3h5"/>' +
      '<path d="M5 4h14l2 8v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6z"/>',
  },

  // --- Money -------------------------------------------------------------
  wallet: {
    label: 'Wallet',
    path: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="17" cy="14" r="1.5"/>',
  },
  coins: {
    label: 'Coins',
    path: '<circle cx="9" cy="9" r="6"/><circle cx="15" cy="15" r="6"/>',
  },
  piggybank: {
    label: 'Piggy bank',
    path:
      '<path d="M4 12a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1h2l-1 3h-1v2a1 1 0 0 1-1 1h-2v-2H9v2H7a1 1 0 0 1-1-1v-2a4 4 0 0 1-2-3z"/>' +
      '<circle cx="15" cy="11" r="1"/><path d="M9 6V4"/>',
  },
  receipt: {
    label: 'Receipt',
    path: '<path d="M5 3h14v18l-2-1-2 1-2-1-2 1-2-1-2 1-2-1z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  },

  // --- People --------------------------------------------------------
  people: {
    label: 'People',
    path:
      '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.5 2.5-6 6-6s6 2.5 6 6"/>' +
      '<circle cx="17" cy="9" r="2.5"/><path d="M15 20c.3-2.5 2-4.5 4.5-4.8"/>',
  },
  call: {
    label: 'Call',
    path:
      '<path d="M4 5c0-1 1-2 2-2h2l2 5-2 1a10 10 0 0 0 6 6l1-2 5 2v2c0 1-1 2-2 2C10 19 4 13 4 5z"/>',
  },
  chat: {
    label: 'Chat',
    path: '<path d="M3 4h18v12H9l-5 5v-5H3z"/>',
  },
  gift: {
    label: 'Gift',
    path:
      '<rect x="3" y="9" width="18" height="4" rx="1"/><rect x="5" y="13" width="14" height="8"/>' +
      '<path d="M12 9v12"/><path d="M12 9c-1.5-4-6-4-6-1 0 1.5 2 1 6 1z"/>' +
      '<path d="M12 9c1.5-4 6-4 6-1 0 1.5-2 1-6 1z"/>',
  },

  // --- Learning ------------------------------------------------------
  book: {
    label: 'Book',
    path:
      '<path d="M4 5a2 2 0 0 1 2-2h6v18H6a2 2 0 0 1-2-2z"/>' +
      '<path d="M20 5a2 2 0 0 0-2-2h-6v18h6a2 2 0 0 0 2-2z"/>',
  },
  pencil: {
    label: 'Pencil',
    path: '<path d="M4 20l1-5L16 4l4 4L9 19l-5 1z"/><path d="M14 6l4 4"/>',
  },
  graduation: {
    label: 'Graduation',
    path:
      '<path d="M2 9l10-5 10 5-10 5-10-5z"/>' +
      '<path d="M6 11v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/><path d="M22 9v6"/>',
  },
  globe: {
    label: 'Globe',
    path:
      '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>' +
      '<path d="M12 3c3 3 3 15 0 18"/><path d="M12 3c-3 3-3 15 0 18"/>',
  },

  // --- Mind ------------------------------------------------------------
  meditate: {
    label: 'Meditate',
    path:
      '<circle cx="12" cy="5" r="2"/><path d="M12 7v4"/>' +
      '<path d="M8 18c0-3 2-4 4-4s4 1 4 4"/><path d="M6 18h12"/>' +
      '<path d="M9 11l-2 3"/><path d="M15 11l2 3"/>',
  },
  leaf: {
    label: 'Leaf',
    path: '<path d="M20 4c-9 0-16 7-16 16 9 0 16-7 16-16z"/><path d="M5 19c4-4 8-8 15-15"/>',
  },
  wind: {
    label: 'Wind',
    path:
      '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/>' +
      '<path d="M3 16h9a2 2 0 1 1-2 2"/>',
  },
  journal: {
    label: 'Journal',
    path: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 3v18"/><path d="M12 8h5M12 12h5M12 16h3"/>',
  },

  // --- Screen --------------------------------------------------------
  phone: {
    label: 'Phone',
    path: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  },
  nophone: {
    label: 'No phone',
    path: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/><path d="M4 4l16 16"/>',
  },
  tv: {
    label: 'TV',
    path: '<rect x="3" y="5" width="18" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 18v3"/>',
  },

  // --- Home ------------------------------------------------------------
  house: {
    label: 'House',
    path: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-6h4v6"/>',
  },
  broom: {
    label: 'Broom',
    path: '<path d="M19 3L9 13"/><path d="M9 13l-5 5"/><path d="M4 21l3-3M4 21l1-4M4 21l4-1"/>',
  },
  plant: {
    label: 'Plant',
    path:
      '<path d="M12 21V10"/><path d="M12 10c0-4-3-6-7-6 0 4 3 7 7 6z"/>' +
      '<path d="M12 10c0-3 2-5 5-5 0 3-2 5-5 5z"/><path d="M8 21h8l-1-4H9z"/>',
  },
  laundry: {
    label: 'Laundry',
    path:
      '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="13" r="5"/>' +
      '<circle cx="7" cy="6" r="0.8"/><circle cx="10" cy="6" r="0.8"/>',
  },

  // --- Creative ------------------------------------------------------
  music: {
    label: 'Music',
    path: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  },
  camera: {
    label: 'Camera',
    path:
      '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/>' +
      '<circle cx="12" cy="13" r="4"/>',
  },
  palette: {
    label: 'Palette',
    path:
      '<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-.5-1.5-.5-2.5c0-1 .8-1.5 2-1.5h1.5A4 4 0 0 0 21 9c0-3.5-4-6-9-6z"/>' +
      '<circle cx="7.5" cy="10.5" r="1"/><circle cx="9.5" cy="7" r="1"/><circle cx="14.5" cy="7" r="1"/>',
  },

  // --- Avoid -------------------------------------------------------------
  cigarette: {
    label: 'Cigarette',
    path:
      '<rect x="2" y="11" width="16" height="4" rx="1"/><path d="M14 11v4"/><path d="M18 11v4"/>' +
      '<path d="M20 8c1 1 1 3 0 4"/><path d="M22 7c1.5 1.5 1.5 4.5 0 6"/>',
  },
  alcohol: {
    label: 'Alcohol',
    path: '<path d="M4 4h16l-8 9z"/><path d="M12 13v7"/><path d="M8 20h8"/>',
  },
  ban: {
    label: 'Ban',
    path: '<circle cx="12" cy="12" r="9"/><path d="M6 6l12 12"/>',
  },

  // --- Generic -------------------------------------------------------
  star: {
    label: 'Star',
    path:
      '<path d="M12 3l2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 17l-5.6 3.1 1.4-6.3L3 9.5l6.4-.6z"/>',
  },
  flag: {
    label: 'Flag',
    path: '<path d="M5 21V4"/><path d="M5 4h13l-3 4 3 4H5"/>',
  },
  bolt: {
    label: 'Bolt',
    path: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  },
  // Deliberate exception to "fill: none" (see module header): this is the
  // documented fallback icon shown when a trackable has no icon at all, so
  // it must be visible (a filled dot, not an outline) even before the user
  // picks anything. `fill="currentColor"` keeps it tintable by the
  // trackable's colour exactly like every stroked icon above — this is NOT
  // a hardcoded colour.
  dot: {
    label: 'Dot',
    path: '<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none"/>',
  },
};

// Display order — also the order the icon picker renders options in.
export const ICON_KEYS = [
  // Fitness
  'dumbbell', 'run', 'walk', 'bike', 'swim', 'stretch', 'heart',
  // Health
  'water', 'apple', 'pill', 'scale', 'floss', 'sun',
  // Sleep
  'bed', 'moon', 'alarm',
  // Focus
  'target', 'checklist', 'timer', 'laptop', 'inbox',
  // Money
  'wallet', 'coins', 'piggybank', 'receipt',
  // People
  'people', 'call', 'chat', 'gift',
  // Learning
  'book', 'pencil', 'graduation', 'globe',
  // Mind
  'meditate', 'leaf', 'wind', 'journal',
  // Screen
  'phone', 'nophone', 'tv',
  // Home
  'house', 'broom', 'plant', 'laundry',
  // Creative
  'music', 'camera', 'palette',
  // Avoid
  'cigarette', 'alcohol', 'ban',
  // Generic
  'star', 'flag', 'bolt', 'dot',
];

// Wraps an ICONS[key].path into a full inline <svg>. Returns '' for an
// unknown/missing/non-string key — never throws. This is the ONLY place
// this module produces markup meant for innerHTML; the caller (a view) is
// responsible for only ever assigning it via innerHTML on an element that
// holds nothing else user-supplied (see CONTRACT-2.5.md §3.1).
export function iconSvg(key) {
  if (typeof key !== 'string') return '';
  const entry = ICONS[key];
  if (!entry) return '';
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    entry.path +
    '</svg>'
  );
}

// True iff `key` names a real entry in ICONS. Hostile input (undefined,
// null, numbers, objects, etc.) returns false rather than throwing.
export function hasIcon(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(ICONS, key);
}
