// Shared Chart.js styling module (Step U.3, CONTRACT-U.3.md §1). PURE
// module apart from reading CSS custom properties through an injectable
// `read` function — no DOM touched at import time. js/charts/weekly.js,
// bounds.js and overlay.js read their colours, fonts, grid/tooltip/
// annotation-label looks and dataset fragments from here instead of each
// hand-rolling its own (weekly.js/bounds.js used to each carry a private,
// near-identical `cssVar` — this module is the single implementation now).
// js/charts/compare.js adopts it in U.5, not this step.
//
// Every export takes an optional `read` — a `(name) => string` function,
// defaulting to `getComputedStyle(document.documentElement).getPropertyValue`
// — so every fragment here is unit-testable in Node with an injected fake
// (tests/unit/chart-theme.test.mjs) and never throws even when `document`
// is unavailable or a lookup fails. The scriptable gradient inside
// lineSeriesTheme() is the only place in this module that ever touches a
// canvas, and only when Chart.js itself calls it at draw time.

function defaultRead(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

// Reads a CSS custom property off :root through `read`, trimmed; falls back
// to `fallback` when the name is missing, the value is empty/whitespace-only,
// or `read` itself throws. Never throws.
export function cssVar(name, fallback, read = defaultRead) {
  try {
    const value = read(name);
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
  } catch {
    return fallback;
  }
}

// The font stack + sizes every chart fragment below embeds. `size`/`weight`
// are fixed per the contract; only `family` is read from the token.
export function chartFont(read) {
  const family = cssVar(
    '--font',
    '-apple-system, system-ui, "SF Pro Text", "Segoe UI", sans-serif',
    read
  );
  return { family, size: 11, weight: '500' };
}

// Option fragment for a category x axis: no grid, no border, horizontal
// ticks capped at 6 labels (autoSkip lets Chart.js thin them further on a
// narrow phone screen without ever rotating text).
export function xAxisTheme(read) {
  return {
    grid: { display: false },
    border: { display: false },
    ticks: {
      color: cssVar('--fg-3', '#6e6e78', read),
      font: chartFont(read),
      maxRotation: 0,
      minRotation: 0,
      autoSkip: true,
      maxTicksLimit: 6,
      padding: 6,
    },
  };
}

// Option fragment for a linear y axis: a single hairline grid (no border,
// no tick marks), muted tick colour.
export function yAxisTheme(read) {
  return {
    grid: { color: cssVar('--hairline', 'rgba(255, 255, 255, 0.08)', read), drawTicks: false },
    border: { display: false },
    ticks: {
      color: cssVar('--fg-3', '#6e6e78', read),
      font: chartFont(read),
      padding: 6,
      maxTicksLimit: 6,
    },
  };
}

// plugins.tooltip fragment: a token-coloured card, no colour swatch (every
// chart in this app already carries the colour it needs elsewhere on
// screen — the swatch would only repeat it).
export function tooltipTheme(read) {
  const bodyTitleFont = chartFont(read);
  const font12 = { ...bodyTitleFont, size: 12 };
  return {
    backgroundColor: cssVar('--surface-3', '#2b2b31', read),
    titleColor: cssVar('--fg', '#f5f5f7', read),
    bodyColor: cssVar('--fg-2', '#a1a1aa', read),
    borderColor: cssVar('--hairline', 'rgba(255, 255, 255, 0.08)', read),
    borderWidth: 1,
    cornerRadius: 8,
    padding: 8,
    displayColors: false,
    titleFont: font12,
    bodyFont: font12,
  };
}

// Annotation label fragment (chartjs-plugin-annotation's `label`) shared by
// every dashed target/bound line in the app, so they all read as one family.
export function annotationLabelTheme(read) {
  return {
    display: true,
    backgroundColor: cssVar('--surface-3', '#2b2b31', read),
    color: cssVar('--fg', '#f5f5f7', read),
    font: { size: 11, weight: '600', family: chartFont(read).family },
    padding: { x: 6, y: 3 },
    borderRadius: 6,
  };
}

const HEX_SHORT_RE = /^#([0-9a-fA-F]{3})$/;
const HEX_LONG_RE = /^#([0-9a-fA-F]{6})$/;
const RGB_RE = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/i;

// '#rgb' / '#rrggbb' / 'rgb(a)(...)' -> 'rgba(r, g, b, alpha)', REPLACING
// any existing alpha channel rather than compounding it. Anything else
// (a CSS colour keyword, a var() reference this module can't resolve on its
// own) is returned unchanged — there is no general way to parse arbitrary
// CSS colour syntax here. A non-string input falls back to a visible black
// at the given alpha. Never throws.
export function withAlpha(color, alpha) {
  if (typeof color !== 'string') return `rgba(0, 0, 0, ${alpha})`;

  const shortMatch = HEX_SHORT_RE.exec(color);
  if (shortMatch) {
    const [r, g, b] = shortMatch[1].split('').map((c) => parseInt(c + c, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const longMatch = HEX_LONG_RE.exec(color);
  if (longMatch) {
    const hex = longMatch[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const rgbMatch = RGB_RE.exec(color);
  if (rgbMatch) {
    const [, r, g, b] = rgbMatch;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  return color;
}

// Dataset fragment for a line series drawn in `color`: a solid 2px line, no
// point markers by default (a caller with a sparse series, e.g. weekly.js's
// single-logged-week case, passes a larger pointRadius), and a soft vertical
// gradient fill under the line (`fill: 'origin'`) so the series reads as an
// area, not a bare line. The gradient is built lazily inside the scriptable
// `backgroundColor` — Chart.js only has a real canvas/chartArea to draw into
// once layout has run, so the very first call (before that) falls back to a
// flat low-alpha tint instead of throwing or drawing nothing.
export function lineSeriesTheme(color, { pointRadius = 3 } = {}) {
  return {
    borderColor: color,
    borderWidth: 2,
    tension: 0,
    pointRadius,
    pointHoverRadius: pointRadius + 2,
    pointBorderWidth: 0,
    fill: 'origin',
    backgroundColor(ctx) {
      const chart = ctx && ctx.chart;
      const area = chart && chart.chartArea;
      if (!area) return withAlpha(color, 0.12);
      const gradient = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
      gradient.addColorStop(0, withAlpha(color, 0.28));
      gradient.addColorStop(1, withAlpha(color, 0));
      return gradient;
    },
  };
}

// Dataset fragment for a bar series: rounded tops, no skipped border on a
// negative bar (never happens today, but a bounded metric could one day),
// and a phone-appropriate thickness ceiling so a short series doesn't grow
// bars into slabs.
export function barSeriesTheme() {
  return { borderRadius: 4, borderSkipped: false, maxBarThickness: 28 };
}
