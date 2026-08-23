// Contract tests for js/icons.js (BUILD_PLAN Step 2.5, "Icons + make colour
// actually do something") — pure functions/data, no DOM. Written strictly
// from CONTRACT-2.5.md §2 and §4.1; the implementation was written in
// parallel by another agent from the same contract, so every assertion here
// is derived from the contract's documented rules and worked examples, not
// from reading js/icons.js.
//
// Per the task brief, js/icons.js, js/views/home.js, js/views/detail.js and
// js/views/trackable.js were deliberately NOT opened while writing this file
// — every expectation below traces back to CONTRACT-2.5.md.
//
// §4.1's "Corrected mid-step" callout (fill/stroke may be 'none' OR
// 'currentColor', not just 'none') is followed below, not the stricter rule
// it replaced — see the fill/stroke describe block.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ICONS, ICON_KEYS, iconSvg, hasIcon } from '../../js/icons.js';

// ===========================================================================
// The exact key set and category order (CONTRACT-2.5.md §2 "The set") —
// transcribed directly from the contract's category table, not from the
// implementation.
// ===========================================================================

const EXPECTED_ICON_KEYS = [
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

describe('ICON_KEYS — exact set and order (CONTRACT-2.5.md §2)', () => {
  it('ICON_KEYS lists exactly the contract\'s set, in the documented category order', () => {
    assert.deepEqual(ICON_KEYS, EXPECTED_ICON_KEYS);
  });

  it('ICON_KEYS has no duplicate entries', () => {
    assert.equal(new Set(ICON_KEYS).size, ICON_KEYS.length);
  });
});

// ===========================================================================
// No orphans in either direction (§4.1)
// ===========================================================================

describe('ICONS <-> ICON_KEYS — no orphans in either direction', () => {
  it('every ICON_KEYS entry exists as a key in ICONS', () => {
    for (const key of ICON_KEYS) {
      assert.ok(key in ICONS, `ICON_KEYS lists "${key}" but ICONS has no such entry`);
    }
  });

  it('every ICONS key is listed in ICON_KEYS', () => {
    for (const key of Object.keys(ICONS)) {
      assert.ok(ICON_KEYS.includes(key), `ICONS has key "${key}" but ICON_KEYS does not list it`);
    }
  });

  it('"dot" is present in both (documented fallback used when a trackable has no icon)', () => {
    assert.ok(ICON_KEYS.includes('dot'));
    assert.ok('dot' in ICONS);
  });
});

// ===========================================================================
// Every entry shape (§4.1: non-empty string label and path)
// ===========================================================================

describe('every ICONS entry has a non-empty string label and path', () => {
  for (const key of ICON_KEYS) {
    it(`${key}: label and path are non-empty strings`, () => {
      const entry = ICONS[key];
      assert.ok(entry, `ICONS.${key} should exist`);
      assert.equal(typeof entry.label, 'string', `ICONS.${key}.label should be a string`);
      assert.ok(entry.label.length > 0, `ICONS.${key}.label should be non-empty`);
      assert.equal(typeof entry.path, 'string', `ICONS.${key}.path should be a string`);
      assert.ok(entry.path.length > 0, `ICONS.${key}.path should be non-empty`);
    });
  }

  it('label examples given explicitly by the contract (§2): dumbbell -> "Dumbbell", nophone -> "No phone"', () => {
    assert.equal(ICONS.dumbbell.label, 'Dumbbell');
    assert.equal(ICONS.nophone.label, 'No phone');
  });
});

// ===========================================================================
// No hardcoded colour anywhere in a path (§4.1) — tint-ability guard
// ===========================================================================

const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/;
const RGB_HSL_FN_RE = /\b(rgb|rgba|hsl|hsla)\s*\(/i;
// A practical (not exhaustive) set of CSS named colours a hardcoded mistake
// would plausibly use. Matched as a whole word so it cannot false-positive
// against 'd' attribute path-data tokens (which are numbers and single
// letter SVG path commands, never English colour words).
const NAMED_COLORS = [
  'black', 'silver', 'gray', 'grey', 'white', 'maroon', 'red', 'purple',
  'fuchsia', 'green', 'lime', 'olive', 'yellow', 'navy', 'blue', 'teal',
  'aqua', 'orange', 'pink', 'brown', 'cyan', 'magenta', 'indigo', 'violet',
  'coral', 'salmon', 'khaki', 'beige', 'ivory', 'wheat', 'tan', 'plum',
  'orchid', 'crimson', 'chocolate', 'tomato', 'azure', 'lavender', 'gold',
  'skyblue', 'lightblue', 'darkblue', 'lightgreen', 'darkgreen',
  'lightgray', 'lightgrey', 'darkgray', 'darkgrey', 'transparent',
];
const NAMED_COLOR_RE = new RegExp(`\\b(${NAMED_COLORS.join('|')})\\b`, 'i');

describe('no path contains a hardcoded colour (§4.1: hex / rgb()/hsl() / named CSS colour)', () => {
  for (const key of ICON_KEYS) {
    it(`${key}: path contains no # hex colour`, () => {
      assert.ok(!HEX_COLOR_RE.test(ICONS[key].path), `icon "${key}" path contains a hex colour`);
    });

    it(`${key}: path contains no rgb()/rgba()/hsl()/hsla() function`, () => {
      assert.ok(!RGB_HSL_FN_RE.test(ICONS[key].path), `icon "${key}" path contains an rgb()/hsl() function`);
    });

    it(`${key}: path contains no named CSS colour`, () => {
      assert.ok(!NAMED_COLOR_RE.test(ICONS[key].path), `icon "${key}" path contains a named CSS colour`);
    });
  }
});

// ===========================================================================
// fill/stroke may ONLY ever be "none" or "currentColor" (§4.1, CORRECTED
// mid-step rule — do not write the stricter "fill must be none" version)
// ===========================================================================

const FILL_ATTR_RE = /fill="([^"]*)"/g;
const STROKE_ATTR_RE = /stroke="([^"]*)"/g;

describe('fill= and stroke= values in every path are only "none" or "currentColor" (CORRECTED rule — currentColor fill IS allowed, e.g. for the "dot" fallback)', () => {
  for (const key of ICON_KEYS) {
    it(`${key}: every fill="…" and stroke="…" value is "none" or "currentColor"`, () => {
      const path = ICONS[key].path;
      const fills = [...path.matchAll(FILL_ATTR_RE)].map((m) => m[1]);
      const strokes = [...path.matchAll(STROKE_ATTR_RE)].map((m) => m[1]);
      for (const value of [...fills, ...strokes]) {
        assert.ok(
          value === 'none' || value === 'currentColor',
          `icon "${key}" has a fill/stroke value of "${value}", which is neither "none" nor "currentColor"`
        );
      }
    });
  }

  it('the "dot" fallback is explicitly allowed to use fill="currentColor" (it is a plain filled circle, per the corrected rule)', () => {
    const path = ICONS.dot.path;
    const fills = [...path.matchAll(FILL_ATTR_RE)].map((m) => m[1]);
    for (const value of fills) {
      assert.ok(value === 'none' || value === 'currentColor');
    }
  });
});

// ===========================================================================
// iconSvg(key) wrapping (§4.1, §2)
// ===========================================================================

describe('iconSvg(key) wraps the entry\'s path in the documented svg shell (§2)', () => {
  for (const key of ICON_KEYS) {
    it(`iconSvg("${key}") starts with <svg, has the 24x24 viewBox, stroke="currentColor", and contains the entry's path`, () => {
      const svg = iconSvg(key);
      assert.equal(typeof svg, 'string');
      assert.ok(svg.startsWith('<svg'), `iconSvg("${key}") should start with "<svg", got: ${svg.slice(0, 30)}`);
      assert.ok(svg.includes('viewBox="0 0 24 24"'), `iconSvg("${key}") should contain viewBox="0 0 24 24"`);
      assert.ok(svg.includes('stroke="currentColor"'), `iconSvg("${key}") should contain stroke="currentColor"`);
      assert.ok(svg.includes(ICONS[key].path), `iconSvg("${key}") should contain the entry's own path markup`);
    });
  }
});

// ===========================================================================
// Hostile inputs — iconSvg returns '' and never throws (§4.1)
// ===========================================================================

const HOSTILE_INPUTS = [undefined, null, '', 'nope', 5, {}, [], true];

describe('iconSvg — hostile inputs return "" and never throw (§4.1)', () => {
  for (const input of HOSTILE_INPUTS) {
    it(`iconSvg(${JSON.stringify(input)}) === '' and does not throw`, () => {
      let result;
      assert.doesNotThrow(() => {
        result = iconSvg(input);
      }, `iconSvg(${JSON.stringify(input)}) threw`);
      assert.equal(result, '');
    });
  }
});

// ===========================================================================
// hasIcon agreement (§4.1)
// ===========================================================================

describe('hasIcon — agrees with ICONS for every real key and every hostile input (§4.1)', () => {
  for (const key of ICON_KEYS) {
    it(`hasIcon("${key}") === true`, () => {
      assert.equal(hasIcon(key), true);
    });
  }

  for (const input of HOSTILE_INPUTS) {
    it(`hasIcon(${JSON.stringify(input)}) === false and does not throw`, () => {
      let result;
      assert.doesNotThrow(() => {
        result = hasIcon(input);
      }, `hasIcon(${JSON.stringify(input)}) threw`);
      assert.equal(result, false);
    });
  }
});
