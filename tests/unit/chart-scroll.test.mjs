// Contract tests for js/charts/scroll.js (Step U.4, CONTRACT-U.4.md §2,
// cases S1-S5) — the pure sizing helpers and the Chart.js inline
// "pinnedAxis" plugin behind the fullscreen chart's sideways-scrolling
// track and its pinned y-axis copy. This file is written strictly against
// that contract; the implementation is being written in parallel by
// another agent and has not been read while writing this file.
//
// PURE unit file: zero dependencies, no real DOM. pinnedAxisPlugin's
// afterRender touches only fake `chart`/`canvas` objects built here (never
// real Chart.js, never real <canvas>) — same injectable-fake style as
// tests/unit/chart-theme.test.mjs's fakeGradient/ctxWithArea fixtures.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AXIS_WIDTH, PX_PER_BUCKET, pxPerBucket, trackWidth, maxTicksFor, pinnedAxisPlugin } from '../../js/charts/scroll.js';

// ===========================================================================
// Constants
// ===========================================================================

describe('scroll.js — constants', () => {
  it('AXIS_WIDTH === 52', () => {
    assert.equal(AXIS_WIDTH, 52);
  });

  it('PX_PER_BUCKET is exactly { day: 14, week: 28, month: 44 }, and frozen', () => {
    assert.deepEqual(PX_PER_BUCKET, { day: 14, week: 28, month: 44 });
    assert.equal(Object.isFrozen(PX_PER_BUCKET), true);
  });
});

// ===========================================================================
// S1 — pxPerBucket
// ===========================================================================

describe('S1 — pxPerBucket(period)', () => {
  it("'day' -> 14", () => {
    assert.equal(pxPerBucket('day'), 14);
  });

  it("'week' -> 28", () => {
    assert.equal(pxPerBucket('week'), 28);
  });

  it("'month' -> 44", () => {
    assert.equal(pxPerBucket('month'), 44);
  });

  it('an unknown period -> 14 (the default)', () => {
    assert.equal(pxPerBucket('quarter'), 14);
    assert.equal(pxPerBucket(''), 14);
    assert.equal(pxPerBucket(undefined), 14);
    assert.equal(pxPerBucket(null), 14);
    assert.equal(pxPerBucket(123), 14);
  });
});

// ===========================================================================
// S2 — trackWidth
// ===========================================================================

describe('S2 — trackWidth(bucketCount, period, viewportWidth)', () => {
  it("(10, 'day', 800) -> 748  (max(800-52, 10*14) = max(748, 140))", () => {
    assert.equal(trackWidth(10, 'day', 800), 748);
  });

  it("(100, 'day', 800) -> 1400  (max(748, 100*14=1400))", () => {
    assert.equal(trackWidth(100, 'day', 800), 1400);
  });

  it("(0, 'week', 300) -> 248  (max(300-52, 0*28) = max(248, 0))", () => {
    assert.equal(trackWidth(0, 'week', 300), 248);
  });

  it("(NaN, 'day', 100) -> 48  (a non-finite bucketCount is treated as 0: max(100-52, 0))", () => {
    assert.equal(trackWidth(NaN, 'day', 100), 48);
  });

  it("(10, 'day', 0) -> 140  (max(0-52, 10*14) = max(-52, 140), never below 0 anyway)", () => {
    assert.equal(trackWidth(10, 'day', 0), 140);
  });

  it('a negative viewport width is treated as 0, not as a negative number', () => {
    // viewportWidth clamped to 0 first: max(0 - AXIS_WIDTH, 10*14) = max(-52, 140) = 140.
    assert.equal(trackWidth(10, 'day', -50), 140);
  });

  it('the result is never below 0 (both inputs degenerate to their floors)', () => {
    // bucketCount 0, viewportWidth 0 (or negative) -> max(0-52, 0) = max(-52, 0) = 0.
    assert.equal(trackWidth(0, 'day', 0), 0);
    assert.equal(trackWidth(0, 'day', -100), 0);
  });
});

// ===========================================================================
// S3 — maxTicksFor
// ===========================================================================

describe('S3 — maxTicksFor(width)', () => {
  it('(100) -> 6  (max(6, floor(100/70)=1))', () => {
    assert.equal(maxTicksFor(100), 6);
  });

  it('(700) -> 10  (max(6, floor(700/70)=10))', () => {
    assert.equal(maxTicksFor(700), 10);
  });
});

// ===========================================================================
// S4 — pinnedAxisPlugin: shape, and the exact copy math on both sides
// ===========================================================================

// A fake axis <canvas>: tracks every clearRect/drawImage call (order and
// arguments) without touching a real 2D context, and exposes a plain
// `style` object exactly as the contract's afterRender is documented to
// write to (style.width/height as CSS px strings).
function makeFakeAxisCanvas() {
  const calls = []; // [{ type: 'clearRect'|'drawImage', args }]
  const ctx = {
    clearRect(...args) {
      calls.push({ type: 'clearRect', args });
    },
    drawImage(...args) {
      calls.push({ type: 'drawImage', args });
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext: () => ctx,
  };
  return { canvas, calls };
}

// The exact fixture from CONTRACT-U.4.md §9 S4.
const FAKE_CHART = {
  canvas: {}, // the source <canvas> drawImage copies FROM — identity-checked below
  chartArea: { left: 52, right: 380 },
  width: 400,
  height: 200,
  currentDevicePixelRatio: 2,
};

describe('S4 — pinnedAxisPlugin(axisCanvas, side)', () => {
  it("returns { id: 'pinnedAxis', afterRender } — a plain Chart.js inline-plugin shape", () => {
    const { canvas } = makeFakeAxisCanvas();
    const plugin = pinnedAxisPlugin(canvas);
    assert.equal(plugin.id, 'pinnedAxis');
    assert.equal(typeof plugin.afterRender, 'function');
  });

  it("left side: canvas sized/styled to the LEFT axis strip in device/CSS px, and drawImage copies exactly that strip", () => {
    const { canvas, calls } = makeFakeAxisCanvas();
    const plugin = pinnedAxisPlugin(canvas, 'left');

    plugin.afterRender(FAKE_CHART);

    // Source rect: (0, 0, chartArea.left*dpr, chart.height*dpr) = (0, 0, 104, 400).
    assert.equal(canvas.width, 104);
    assert.equal(canvas.height, 400);
    // CSS px of the strip: chartArea.left (52) wide, chart.height (200) tall.
    assert.equal(canvas.style.width, '52px');
    assert.equal(canvas.style.height, '200px');

    const clears = calls.filter((c) => c.type === 'clearRect');
    const draws = calls.filter((c) => c.type === 'drawImage');
    assert.equal(clears.length, 1);
    assert.equal(draws.length, 1);
    // clearRect happens before drawImage, per §2 ("ctx.clearRect(whole),
    // then drawImage(...)") — the exact clearRect arguments are not pinned
    // by the contract beyond "the whole (resized) canvas", so only the
    // ordering and call count are asserted here.
    assert.ok(calls.indexOf(clears[0]) < calls.indexOf(draws[0]));

    assert.deepEqual(draws[0].args, [FAKE_CHART.canvas, 0, 0, 104, 400, 0, 0, 104, 400]);
  });

  it('right side: sx/sw come from the RIGHT axis strip (chart.width - chartArea.right), styled accordingly', () => {
    const { canvas, calls } = makeFakeAxisCanvas();
    const plugin = pinnedAxisPlugin(canvas, 'right');

    plugin.afterRender(FAKE_CHART);

    // Source rect: (chartArea.right*dpr, 0, (chart.width-chartArea.right)*dpr, chart.height*dpr)
    // = (760, 0, 40, 400).
    assert.equal(canvas.width, 40);
    assert.equal(canvas.height, 400);
    assert.equal(canvas.style.width, '20px'); // chart.width(400) - chartArea.right(380)
    assert.equal(canvas.style.height, '200px');

    const draws = calls.filter((c) => c.type === 'drawImage');
    assert.equal(draws.length, 1);
    const [img, sx, sy, sw, sh, dx, dy, dw, dh] = draws[0].args;
    assert.equal(img, FAKE_CHART.canvas);
    assert.equal(sx, 760);
    assert.equal(sy, 0);
    assert.equal(sw, 40);
    assert.equal(sh, 400);
    assert.equal(dx, 0);
    assert.equal(dy, 0);
    assert.equal(dw, sw);
    assert.equal(dh, sh);
  });

  it("defaults to side 'left' when omitted", () => {
    const { canvas: leftCanvas } = makeFakeAxisCanvas();
    const { canvas: defaultCanvas } = makeFakeAxisCanvas();
    pinnedAxisPlugin(leftCanvas, 'left').afterRender(FAKE_CHART);
    pinnedAxisPlugin(defaultCanvas).afterRender(FAKE_CHART);
    assert.equal(defaultCanvas.width, leftCanvas.width);
    assert.equal(defaultCanvas.height, leftCanvas.height);
    assert.equal(defaultCanvas.style.width, leftCanvas.style.width);
    assert.equal(defaultCanvas.style.height, leftCanvas.style.height);
  });
});

// ===========================================================================
// S5 — never throws: no chartArea / getContext returning null / dpr missing
// ===========================================================================

describe('S5 — pinnedAxisPlugin never throws on a missing piece', () => {
  it('no chartArea at all -> does not throw, and draws nothing', () => {
    const { canvas, calls } = makeFakeAxisCanvas();
    const plugin = pinnedAxisPlugin(canvas, 'left');
    const chartWithoutArea = { canvas: {}, width: 400, height: 200, currentDevicePixelRatio: 2 };

    assert.doesNotThrow(() => plugin.afterRender(chartWithoutArea));
    assert.equal(calls.filter((c) => c.type === 'drawImage').length, 0);
  });

  it('axisCanvas.getContext() returning null -> does not throw, and draws nothing', () => {
    const canvas = { width: 0, height: 0, style: {}, getContext: () => null };
    const plugin = pinnedAxisPlugin(canvas, 'left');

    assert.doesNotThrow(() => plugin.afterRender(FAKE_CHART));
  });

  it('a missing currentDevicePixelRatio is treated as 1 (not a throw, and not treated as 0)', () => {
    const { canvas, calls } = makeFakeAxisCanvas();
    const plugin = pinnedAxisPlugin(canvas, 'left');
    const chartNoDpr = { canvas: {}, chartArea: { left: 52, right: 380 }, width: 400, height: 200 };

    assert.doesNotThrow(() => plugin.afterRender(chartNoDpr));

    // dpr defaults to 1: source rect (0, 0, 52*1, 200*1).
    assert.equal(canvas.width, 52);
    assert.equal(canvas.height, 200);
    assert.equal(canvas.style.width, '52px');
    assert.equal(canvas.style.height, '200px');
    const draws = calls.filter((c) => c.type === 'drawImage');
    assert.equal(draws.length, 1);
    assert.deepEqual(draws[0].args, [chartNoDpr.canvas, 0, 0, 52, 200, 0, 0, 52, 200]);
  });

  // Beyond §9's three required S5 fixtures: §2's own text ("any missing
  // piece (no chartArea, no getContext, zero size) -> return without
  // drawing") also names a zero-size strip explicitly. Covered here too,
  // since it is cheap and directly documented, not merely inferred.
  it('a zero-width strip (chartArea.left === 0 on the left side) -> does not throw, and draws nothing', () => {
    const { canvas, calls } = makeFakeAxisCanvas();
    const plugin = pinnedAxisPlugin(canvas, 'left');
    const chartZeroLeft = { canvas: {}, chartArea: { left: 0, right: 400 }, width: 400, height: 200, currentDevicePixelRatio: 2 };

    assert.doesNotThrow(() => plugin.afterRender(chartZeroLeft));
    assert.equal(calls.filter((c) => c.type === 'drawImage').length, 0);
  });
});
