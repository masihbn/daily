// Contract tests for js/ui-icons.js (Step U.0, "Foundations: tokens, type,
// component kit, chrome icons") — pure functions/data, no DOM. Written
// strictly from CONTRACT-U.0.md §5 and §7 (cases U1-U4); the implementation
// is being written in parallel by another agent from the same contract, so
// every assertion here traces back to the contract text, not to
// js/ui-icons.js itself.
//
// Mirrors the established pattern in tests/unit/icons.test.mjs (the sibling
// js/icons.js contract tests) wherever the two contracts overlap.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UI_ICON_KEYS, uiIconSvg, hasUiIcon } from '../../js/ui-icons.js';

// ===========================================================================
// The exact key set (CONTRACT-U.0.md §5) — transcribed directly from the
// contract, not from the implementation.
// ===========================================================================

const EXPECTED_UI_ICON_KEYS = [
  'home', 'compare', 'settings', 'back', 'forward', 'plus', 'expand',
  'close', 'check', 'chevron-left', 'chevron-right', 'chevron-down',
  'edit', 'share', 'lock', 'wifi-off', 'clock',
];

// ===========================================================================
// U1 — UI_ICON_KEYS is frozen, has exactly the 17 keys above, no dupes.
// ===========================================================================

describe('U1 — UI_ICON_KEYS (CONTRACT-U.0.md §5, §7)', () => {
  it('is frozen (Object.freeze)', () => {
    assert.equal(Object.isFrozen(UI_ICON_KEYS), true);
  });

  it('has exactly the 17 documented keys, in the documented order', () => {
    assert.deepEqual(UI_ICON_KEYS, EXPECTED_UI_ICON_KEYS);
  });

  it('has exactly 17 entries', () => {
    assert.equal(UI_ICON_KEYS.length, 17);
  });

  it('has no duplicate entries', () => {
    assert.equal(new Set(UI_ICON_KEYS).size, UI_ICON_KEYS.length);
  });
});

// ===========================================================================
// U2 — uiIconSvg(key) shape, for every key.
// ===========================================================================

// "no `#` followed by 3 or 6 hex digits" (§7 U2), anchored so a longer run of
// hex digits (e.g. an 8-digit #RRGGBBAA, which is not what the rule names)
// doesn't get flagged for containing a 6-digit prefix, and so a shorter
// partial match can't slip through either.
const HEX_3_OR_6_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/;
// Inline event handler attribute, e.g. onclick=, onerror=. Anchored on a
// non-word character (or start) before "on" so it cannot match inside a
// longer identifier that merely contains the letters "on" (e.g. "button=",
// "icon=" — neither of which is an event handler attribute).
const EVENT_HANDLER_RE = /(?:^|[^\w-])on[a-z]+=/i;
const DRAWING_ELEMENT_RE = /<(path|circle|line|rect|polyline)\b/;

describe('U2 — uiIconSvg(key) shape for every documented key (CONTRACT-U.0.md §5, §7)', () => {
  for (const key of EXPECTED_UI_ICON_KEYS) {
    describe(`uiIconSvg("${key}")`, () => {
      const svg = uiIconSvg(key);

      it('is a string', () => {
        assert.equal(typeof svg, 'string');
      });

      it('starts with "<svg"', () => {
        assert.ok(svg.startsWith('<svg'), `got: ${svg.slice(0, 30)}`);
      });

      it('ends with "</svg>"', () => {
        assert.ok(svg.endsWith('</svg>'), `got tail: ${svg.slice(-30)}`);
      });

      it('contains viewBox="0 0 24 24"', () => {
        assert.ok(svg.includes('viewBox="0 0 24 24"'));
      });

      it('contains stroke="currentColor"', () => {
        assert.ok(svg.includes('stroke="currentColor"'));
      });

      it('contains aria-hidden="true"', () => {
        assert.ok(svg.includes('aria-hidden="true"'));
      });

      it('contains stroke-width="1.75"', () => {
        assert.ok(svg.includes('stroke-width="1.75"'));
      });

      it('contains no hex colour (# followed by 3 or 6 hex digits)', () => {
        assert.ok(!HEX_3_OR_6_RE.test(svg), `unexpected hex colour in: ${svg}`);
      });

      it('contains no <script', () => {
        assert.ok(!/<script/i.test(svg));
      });

      it('contains no inline event handler attribute (on[a-z]+=)', () => {
        assert.ok(!EVENT_HANDLER_RE.test(svg), `unexpected event handler in: ${svg}`);
      });

      it('has at least one drawing element (path/circle/line/rect/polyline)', () => {
        assert.ok(DRAWING_ELEMENT_RE.test(svg), `no drawing element found in: ${svg}`);
      });
    });
  }
});

// ===========================================================================
// U3 — hostile inputs return '' and never throw.
// ===========================================================================

const HOSTILE_INPUTS = ['not-a-real-key', '', null, undefined, 42, {}];

describe('U3 — uiIconSvg hostile inputs (CONTRACT-U.0.md §7)', () => {
  for (const input of HOSTILE_INPUTS) {
    it(`uiIconSvg(${JSON.stringify(input)}) === '' and does not throw`, () => {
      let result;
      assert.doesNotThrow(() => {
        result = uiIconSvg(input);
      }, `uiIconSvg(${JSON.stringify(input)}) threw`);
      assert.equal(result, '');
    });
  }
});

// ===========================================================================
// U4 — hasUiIcon agreement.
// ===========================================================================

describe('U4 — hasUiIcon (CONTRACT-U.0.md §7)', () => {
  for (const key of EXPECTED_UI_ICON_KEYS) {
    it(`hasUiIcon("${key}") === true`, () => {
      assert.equal(hasUiIcon(key), true);
    });
  }

  for (const input of HOSTILE_INPUTS) {
    it(`hasUiIcon(${JSON.stringify(input)}) === false and does not throw`, () => {
      let result;
      assert.doesNotThrow(() => {
        result = hasUiIcon(input);
      }, `hasUiIcon(${JSON.stringify(input)}) threw`);
      assert.equal(result, false);
    });
  }

  // Prototype-pollution-shaped keys (§7 U4): a naive `UI_ICON_KEYS[key]` or
  // `key in someObject`-style implementation could wrongly say true for
  // these because they collide with real Object.prototype members.
  for (const input of ['toString', 'constructor']) {
    it(`hasUiIcon(${JSON.stringify(input)}) === false (prototype key, not a real icon key)`, () => {
      let result;
      assert.doesNotThrow(() => {
        result = hasUiIcon(input);
      }, `hasUiIcon(${JSON.stringify(input)}) threw`);
      assert.equal(result, false);
    });
  }
});
