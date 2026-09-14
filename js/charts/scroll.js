// Full-screen chart sizing math + the pinned-axis Chart.js plugin (Step
// U.4, CONTRACT-U.4.md §2). PURE — no `document`/`window` touched at
// import time; pinnedAxisPlugin() returns a plain object whose
// afterRender() only touches the `chart`/`axisCanvas` it is handed, so the
// whole module is unit-testable in Node with fake objects
// (tests/unit/chart-scroll.test.mjs). Never throws.

// CSS px reserved for the pinned y axis strip.
export const AXIS_WIDTH = 52;

// CSS px per bucket at each granularity — wide enough that a label under
// each tick never collides with its neighbour even at the smallest bucket
// (day).
export const PX_PER_BUCKET = Object.freeze({ day: 14, week: 28, month: 44 });

// Unknown/garbage period -> the day density (the narrowest, safest
// default — never renders wider spacing than a caller actually asked for).
export function pxPerBucket(period) {
  return PX_PER_BUCKET[period] || 14;
}

// The chart track's width in CSS px: wide enough to hold every bucket at
// its period's density, but never narrower than the viewport minus the
// pinned axis (so a short series still fills the screen instead of
// leaving a blank gap). Every input is sanitized rather than trusted:
// non-finite/negative bucketCount or viewportWidth are treated as 0, and
// the result is never negative.
export function trackWidth(bucketCount, period, viewportWidth) {
  const count =
    typeof bucketCount === 'number' && Number.isFinite(bucketCount) && bucketCount > 0
      ? bucketCount
      : 0;
  const vw =
    typeof viewportWidth === 'number' && Number.isFinite(viewportWidth) && viewportWidth > 0
      ? viewportWidth
      : 0;

  const available = Math.max(vw - AXIS_WIDTH, 0);
  const needed = count * pxPerBucket(period);
  return Math.max(available, needed, 0);
}

// How many x-axis ticks a track this wide can hold before labels start
// colliding — floor(width / 70), never below 6 (Chart.js's autoSkip still
// thins further if the actual label text is wider than that).
export function maxTicksFor(width) {
  const w = typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 0;
  return Math.max(6, Math.floor(w / 70));
}

// A Chart.js inline plugin (passed via the chart's own `plugins: [...]`
// array, not the registry) that keeps a copy of the chart's own y-axis
// strip pinned in place while `.fs-scroll` scrolls the real canvas
// sideways underneath it. `afterRender` copies the device-pixel strip at
// the chart's left (or right, for an overlay's second axis) edge onto
// `axisCanvas` every time Chart.js redraws — cheap, and correct even
// though the underlying scale's tick VALUES never change as the chart
// scrolls (only their on-screen position would, which is exactly what
// this plugin exists to hide).
//
// Never throws: any missing piece (no chart/chartArea/canvas, no
// getContext, a zero-size strip) is a silent no-op, never a broken chart.
export function pinnedAxisPlugin(axisCanvas, side = 'left') {
  return {
    id: 'pinnedAxis',
    afterRender(chart) {
      try {
        if (!chart || !chart.canvas || !chart.chartArea) return;

        const { left, right } = chart.chartArea;
        const width = chart.width;
        const height = chart.height;
        if (
          typeof left !== 'number' ||
          typeof right !== 'number' ||
          typeof width !== 'number' ||
          typeof height !== 'number' ||
          !Number.isFinite(left) ||
          !Number.isFinite(right) ||
          !Number.isFinite(width) ||
          !Number.isFinite(height)
        ) {
          return;
        }

        const dpr = chart.currentDevicePixelRatio || 1;

        const sx = side === 'right' ? right * dpr : 0;
        const sw = side === 'right' ? (width - right) * dpr : left * dpr;
        const sy = 0;
        const sh = height * dpr;

        if (!(sw > 0) || !(sh > 0)) return;
        if (!axisCanvas || typeof axisCanvas.getContext !== 'function') return;

        const ctx = axisCanvas.getContext('2d');
        if (!ctx) return;

        axisCanvas.width = sw;
        axisCanvas.height = sh;
        if (axisCanvas.style) {
          axisCanvas.style.width = `${sw / dpr}px`;
          axisCanvas.style.height = `${sh / dpr}px`;
        }

        ctx.clearRect(0, 0, axisCanvas.width, axisCanvas.height);
        ctx.drawImage(chart.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      } catch {
        // A drawing failure must never break the chart it is pinned to.
      }
    },
  };
}
