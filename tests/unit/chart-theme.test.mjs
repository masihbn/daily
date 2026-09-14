// Contract tests for js/charts/theme.js (Step U.3, CONTRACT-U.3.md §1/§6,
// cases TH1-TH8) — the shared Chart.js styling module every chart file
// (weekly.js/bounds.js/overlay.js) is being wired to read colours, fonts,
// grid/tooltip/annotation-label looks and dataset fragments from. This file
// is written strictly against that contract; the implementation is being
// written in parallel by another agent and is not visible here.
//
// PURE unit file: zero dependencies, no DOM, no real CSS. Every function
// under test takes an injectable `read` (a plain `(name) => value` function)
// per the contract's own signature (`cssVar(name, fallback, read = defaultRead)`
// and friends) — this file never touches `document`/`getComputedStyle`, so
// it stays a genuine `node --test` unit file per this project's convention
// (see tests/unit/net-status.test.mjs, read first, for the established
// injectable-dependency style this follows).
//
// The one exception is TH6's scriptable `backgroundColor` function inside
// `lineSeriesTheme` — that function itself touches a *fake* canvas gradient
// object handed to it by Chart.js at draw time (never real DOM), per the
// contract's exact fixture shape (§6 TH6 note).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cssVar,
  chartFont,
  xAxisTheme,
  yAxisTheme,
  tooltipTheme,
  annotationLabelTheme,
  lineSeriesTheme,
  barSeriesTheme,
  withAlpha,
} from '../../js/charts/theme.js';

// A fixed token map standing in for :root's real custom properties. Every
// name theme.js's fragments are documented (§1) to read from is present
// here, so every fragment under test resolves through the injected `read`
// rather than ever falling back to its hardcoded default (which would mask
// a wiring bug — reading the wrong token name would still "pass" if the
// fallback happened to look plausible).
const TOKENS = {
  '--fg': '#111111',
  '--fg-2': '#222222',
  '--fg-3': '#333333',
  '--hairline': '#e5e5e5',
  '--surface-3': '#f7f7f7',
};

function makeRead(map) {
  return (name) => map[name];
}

function throwingRead() {
  return () => {
    throw new Error('read boom');
  };
}

// ===========================================================================
// TH1 — cssVar
// ===========================================================================

describe('TH1 — cssVar(name, fallback, read)', () => {
  it('trims whitespace off a found value', () => {
    const read = makeRead({ '--x': '  #abcdef  ' });
    assert.equal(cssVar('--x', 'fallback', read), '#abcdef');
  });

  it('falls back when the name is missing from the map (read returns undefined)', () => {
    const read = makeRead({});
    assert.equal(cssVar('--missing', 'fallback', read), 'fallback');
  });

  it('falls back when the value is empty (or whitespace-only)', () => {
    const read = makeRead({ '--empty': '', '--blank': '   ' });
    assert.equal(cssVar('--empty', 'fallback', read), 'fallback');
    assert.equal(cssVar('--blank', 'fallback', read), 'fallback');
  });

  it('falls back when read() throws, and never propagates the throw', () => {
    assert.doesNotThrow(() => cssVar('--x', 'fallback', throwingRead()));
    assert.equal(cssVar('--x', 'fallback', throwingRead()), 'fallback');
  });

  it('returns the exact trimmed value, not the fallback, when a real value is present', () => {
    const read = makeRead({ '--c': '#34c759' });
    assert.equal(cssVar('--c', '#000000', read), '#34c759');
  });
});

// ===========================================================================
// chartFont — not independently cased in §6, but every themed fragment
// below embeds it; TH2-TH5's own assertions cover its effect indirectly.
// No dedicated describe block here, per the "test EXACTLY §6" boundary.
// ===========================================================================

// ===========================================================================
// TH2 — xAxisTheme
// ===========================================================================

describe('TH2 — xAxisTheme(read)', () => {
  it('grid.display === false, ticks.maxRotation === 0, ticks.maxTicksLimit === 6, tick colour = the map\'s --fg-3', () => {
    const read = makeRead(TOKENS);
    const result = xAxisTheme(read);
    assert.equal(result.grid.display, false);
    assert.equal(result.ticks.maxRotation, 0);
    assert.equal(result.ticks.maxTicksLimit, 6);
    assert.equal(result.ticks.color, TOKENS['--fg-3']);
  });
});

// ===========================================================================
// TH3 — yAxisTheme
// ===========================================================================

describe('TH3 — yAxisTheme(read)', () => {
  it('grid colour = --hairline, border.display === false', () => {
    const read = makeRead(TOKENS);
    const result = yAxisTheme(read);
    assert.equal(result.grid.color, TOKENS['--hairline']);
    assert.equal(result.border.display, false);
  });
});

// ===========================================================================
// TH4 — tooltipTheme
// ===========================================================================

describe('TH4 — tooltipTheme(read)', () => {
  it('background = --surface-3, displayColors === false, cornerRadius === 8', () => {
    const read = makeRead(TOKENS);
    const result = tooltipTheme(read);
    assert.equal(result.backgroundColor, TOKENS['--surface-3']);
    assert.equal(result.displayColors, false);
    assert.equal(result.cornerRadius, 8);
  });
});

// ===========================================================================
// TH5 — annotationLabelTheme
// ===========================================================================

describe('TH5 — annotationLabelTheme(read)', () => {
  it('background --surface-3, colour --fg, borderRadius === 6', () => {
    const read = makeRead(TOKENS);
    const result = annotationLabelTheme(read);
    assert.equal(result.backgroundColor, TOKENS['--surface-3']);
    assert.equal(result.color, TOKENS['--fg']);
    assert.equal(result.borderRadius, 6);
  });
});

// ===========================================================================
// TH6 — lineSeriesTheme
// ===========================================================================

describe('TH6 — lineSeriesTheme(color, opts)', () => {
  it('borderColor, borderWidth, default pointRadius/pointHoverRadius, fill, and a function backgroundColor', () => {
    const result = lineSeriesTheme('#ff9500');
    assert.equal(result.borderColor, '#ff9500');
    assert.equal(result.borderWidth, 2);
    assert.equal(result.tension, 0);
    assert.equal(result.pointRadius, 3);
    assert.equal(result.pointHoverRadius, 5); // pointRadius + 2
    assert.equal(result.pointBorderWidth, 0);
    assert.equal(result.fill, 'origin');
    assert.equal(typeof result.backgroundColor, 'function');
  });

  it('pointRadius: 0 is honoured exactly (falsy but explicit), and pointHoverRadius follows it', () => {
    const result = lineSeriesTheme('#ff9500', { pointRadius: 0 });
    assert.equal(result.pointRadius, 0);
    assert.equal(result.pointHoverRadius, 2); // 0 + 2
  });

  it('backgroundColor(ctx) with chart.chartArea undefined returns withAlpha(color, .12)', () => {
    const result = lineSeriesTheme('#ff9500');
    const ctxNoArea = { chart: { chartArea: undefined } };
    assert.equal(result.backgroundColor(ctxNoArea), withAlpha('#ff9500', 0.12));
  });

  it('backgroundColor(ctx) with a ready chartArea builds a vertical gradient via ctx.chart.ctx.createLinearGradient, with the documented stops', () => {
    const result = lineSeriesTheme('#ff9500');

    const stopCalls = [];
    const fakeGradient = {
      addColorStop(offset, color) {
        stopCalls.push([offset, color]);
      },
    };
    const ctxWithArea = {
      chart: {
        chartArea: { top: 0, bottom: 100 },
        ctx: { createLinearGradient: (...args) => fakeGradient },
      },
    };

    const returned = result.backgroundColor(ctxWithArea);
    assert.equal(returned, fakeGradient);
    assert.deepEqual(stopCalls, [
      [0, withAlpha('#ff9500', 0.28)],
      [1, withAlpha('#ff9500', 0)],
    ]);
  });
});

// ===========================================================================
// TH7 — barSeriesTheme
// ===========================================================================

describe('TH7 — barSeriesTheme()', () => {
  it('matches the documented fragment exactly', () => {
    assert.deepEqual(barSeriesTheme(), { borderRadius: 4, borderSkipped: false, maxBarThickness: 28 });
  });
});

// ===========================================================================
// TH8 — withAlpha
// ===========================================================================

describe('TH8 — withAlpha(color, alpha)', () => {
  it('3-digit hex shorthand expands correctly', () => {
    assert.equal(withAlpha('#f90', 0.5), 'rgba(255, 153, 0, 0.5)');
  });

  it('6-digit hex', () => {
    assert.equal(withAlpha('#ff9500', 0.5), 'rgba(255, 149, 0, 0.5)');
  });

  it('rgb(...) input', () => {
    assert.equal(withAlpha('rgb(1, 2, 3)', 0.5), 'rgba(1, 2, 3, 0.5)');
  });

  it('rgba(...) input keeps the RGB channels and replaces the alpha', () => {
    assert.equal(withAlpha('rgba(1, 2, 3, 0.9)', 0.5), 'rgba(1, 2, 3, 0.5)');
  });

  it('an unparseable string (e.g. a CSS colour keyword) falls back to itself, verbatim', () => {
    assert.equal(withAlpha('tomato', 0.5), 'tomato');
  });

  it('a non-string input falls back to rgba(0, 0, 0, 0.5)', () => {
    const hostile = [undefined, null, 42, {}, [], true];
    for (const v of hostile) {
      assert.equal(withAlpha(v, 0.5), 'rgba(0, 0, 0, 0.5)');
    }
  });
});
