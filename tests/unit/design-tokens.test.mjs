// Structural/text-based tests for css/styles.css (Step U.0, "Foundations:
// tokens, type, component kit, chrome icons") — read as plain text and
// asserted against with string/regex checks, no CSS parser, no rendering.
// Same pattern as tests/unit/sw-assets.test.mjs's checks on sw.js.
//
// Written strictly from CONTRACT-U.0.md §1 (token values), §2 (globals), §3
// (component kit class names), and §7 (test cases T1-T9). The implementation
// is being written in parallel by another agent from the same contract, so
// every assertion here traces back to the contract text, not to
// css/styles.css itself.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const cssPath = path.join(repoRoot, 'css', 'styles.css');
const swPath = path.join(repoRoot, 'sw.js');

const rawCss = fs.readFileSync(cssPath, 'utf8');
const swText = fs.readFileSync(swPath, 'utf8');

// Strip /* ... */ comments so a token mentioned only in prose (e.g. "this
// used to be #3478f6") can't produce a false failure/pass, and so brace
// matching below can't be thrown off by braces or colons inside a comment.
// Note: CSS comments cannot be nested and don't contain "*/" themselves, so
// a non-greedy match is safe here.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

const css = stripComments(rawCss);

// ===========================================================================
// Helpers
// ===========================================================================

// Finds the first `:root { ... }` block at or after `fromIndex` and returns
// its inner content (the text between the braces), tolerant of whitespace
// between `:root` and `{`. Returns null if none is found or braces are
// unbalanced.
function findRootBlockContent(text, fromIndex = 0) {
  const re = /:root\s*\{/g;
  re.lastIndex = fromIndex;
  const m = re.exec(text);
  if (!m) return null;
  const openIndex = m.index + m[0].length - 1; // index of the '{'
  return extractBraceBlockContent(text, openIndex);
}

// Given the index of an opening '{', returns the content between it and its
// matching '}' (balanced-brace aware, so nested rules inside a media block
// don't confuse it). Returns null if unbalanced.
function extractBraceBlockContent(text, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(openBraceIndex + 1, i);
      }
    }
  }
  return null;
}

// Finds the `@media (prefers-color-scheme: <scheme>) { ... }` block and
// returns its inner content, tolerant of whitespace.
function findMediaBlockContent(text, scheme) {
  const re = new RegExp(`@media\\s*\\(\\s*prefers-color-scheme\\s*:\\s*${scheme}\\s*\\)\\s*\\{`);
  const m = re.exec(text);
  if (!m) return null;
  const openIndex = m.index + m[0].length - 1;
  return extractBraceBlockContent(text, openIndex);
}

// True iff `--name:` (a custom property declaration) appears in `block`.
function definesToken(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped + '\\s*:').test(block);
}

// True iff `selector` appears as a selector token in `text` — i.e. the
// literal text is present and not immediately followed by a character that
// would make it part of a longer, different token (so `.btn` does not count
// `.btn--primary` as a match, and `.tform-error` does not count some other
// `.tform-error-foo`).
function hasSelectorToken(text, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped + '(?![\\w-])').test(text);
}

// ===========================================================================
// T1 — first :root {...} block (dark) defines every §1 dark token, and the
// literal --accent value.
// ===========================================================================

const DARK_REQUIRED_TOKENS = [
  // surfaces
  '--bg', '--surface', '--surface-2', '--surface-3',
  // text
  '--fg', '--fg-2', '--fg-3', '--hairline',
  // accent
  '--accent', '--accent-fg',
  // semantics
  '--good', '--good-bg', '--bad', '--bad-bg', '--warn', '--focus', '--shadow',
  // legacy aliases
  '--bg-elevated', '--fg-muted', '--border', '--danger',
  // type
  '--font', '--t-lg-title', '--t-title', '--t-head', '--t-body', '--t-sub',
  '--t-cap', '--t-micro',
  // space, radius
  '--s1', '--s2', '--s3', '--s4', '--s5', '--s6',
  '--r-ctl', '--r-card', '--r-sheet', '--r-pill', '--nav-height',
];

describe('T1 — first :root {} block (dark) defines every §1 token (CONTRACT-U.0.md §1, §7)', () => {
  const darkRoot = findRootBlockContent(css);

  it('a :root {} block exists at all', () => {
    assert.ok(darkRoot !== null, 'expected a :root {...} block in css/styles.css');
  });

  for (const token of DARK_REQUIRED_TOKENS) {
    it(`defines ${token}`, () => {
      assert.ok(definesToken(darkRoot, token), `expected the first :root {} block to define ${token}`);
    });
  }

  it('--accent is exactly #f5f5f7', () => {
    assert.match(darkRoot, /--accent\s*:\s*#f5f5f7\b/i);
  });
});

// ===========================================================================
// T2 — light-scheme media block's :root {...} defines every non-alias,
// non-type, non-space token, and the literal --accent value.
// ===========================================================================

const LIGHT_REQUIRED_TOKENS = [
  '--bg', '--surface', '--surface-2', '--surface-3',
  '--fg', '--fg-2', '--fg-3', '--hairline',
  '--accent', '--accent-fg',
  '--good', '--good-bg', '--bad', '--bad-bg', '--warn', '--focus', '--shadow',
];

describe('T2 — @media (prefers-color-scheme: light) { :root {} } defines every non-alias/type/space token (CONTRACT-U.0.md §1, §7)', () => {
  const lightMedia = findMediaBlockContent(css, 'light');

  it('the light media block exists', () => {
    assert.ok(lightMedia !== null, 'expected an @media (prefers-color-scheme: light) block');
  });

  const lightRoot = lightMedia ? findRootBlockContent(lightMedia) : null;

  it('the light media block contains a :root {} block', () => {
    assert.ok(lightRoot !== null, 'expected a :root {...} block inside the light media query');
  });

  for (const token of LIGHT_REQUIRED_TOKENS) {
    it(`defines ${token}`, () => {
      assert.ok(definesToken(lightRoot, token), `expected the light :root {} block to define ${token}`);
    });
  }

  it('--accent is exactly #0b0b0e', () => {
    assert.match(lightRoot, /--accent\s*:\s*#0b0b0e\b/i);
  });
});

// ===========================================================================
// T3 — legacy alias tokens present with their exact var() values.
// ===========================================================================

describe('T3 — legacy alias tokens (CONTRACT-U.0.md §1 decision 3, §7)', () => {
  it('--bg-elevated: var(--surface)', () => {
    assert.match(css, /--bg-elevated\s*:\s*var\(\s*--surface\s*\)/);
  });

  it('--fg-muted: var(--fg-2)', () => {
    assert.match(css, /--fg-muted\s*:\s*var\(\s*--fg-2\s*\)/);
  });

  it('--border: var(--hairline)', () => {
    assert.match(css, /--border\s*:\s*var\(\s*--hairline\s*\)/);
  });

  it('--danger: var(--bad)', () => {
    assert.match(css, /--danger\s*:\s*var\(\s*--bad\s*\)/);
  });
});

// ===========================================================================
// T4 — old palette literals are entirely gone.
// ===========================================================================

const FORBIDDEN_OLD_LITERALS = [
  '#3478f6', '#111111', '#1c1c1e', '#9a9a9a', '#2e2e30', '#ff6b6b',
];

describe('T4 — no literal old-palette colours remain anywhere (CONTRACT-U.0.md §7, case-insensitive)', () => {
  for (const literal of FORBIDDEN_OLD_LITERALS) {
    it(`does not contain ${literal}`, () => {
      assert.doesNotMatch(css, new RegExp(literal.replace('#', '#'), 'i'));
    });
  }
});

// ===========================================================================
// T5 — the global `button {}` reset rule has no background/border-radius.
// ===========================================================================

describe('T5 — global button {} rule is a reset only (CONTRACT-U.0.md §2, §7)', () => {
  // Per the contract's own parse instructions: find `\nbutton\s*\{[^}]*\}`.
  // Prepend a newline defensively in case the rule is (unusually) the very
  // first thing in the stripped text.
  const match = ('\n' + css).match(/\nbutton\s*\{([^}]*)\}/);

  it('a standalone `button { ... }` rule exists', () => {
    assert.ok(match, 'expected a top-level `button { ... }` rule (selector exactly "button")');
  });

  const body = match ? match[1] : '';

  it('does not set background: var(--accent)', () => {
    assert.doesNotMatch(body, /background\s*:\s*var\(\s*--accent\s*\)/);
  });

  it('does not set border-radius', () => {
    assert.doesNotMatch(body, /border-radius\s*:/);
  });
});

// ===========================================================================
// T6 — component kit rules exist.
// ===========================================================================

const KIT_SELECTORS = [
  '.btn', '.btn--primary', '.btn--secondary', '.btn--ghost', '.btn--danger',
  '.btn--icon', '.seg', '.seg__item', '.chip', '.card', '.list__row',
  '.field', '.input', '.pill',
];

describe('T6 — component kit rules exist (CONTRACT-U.0.md §3, §7)', () => {
  for (const selector of KIT_SELECTORS) {
    it(`${selector} appears as a selector`, () => {
      assert.ok(hasSelectorToken(css, selector), `expected ${selector} to appear as a selector in css/styles.css`);
    });
  }
});

// ===========================================================================
// T7 — :focus-visible rule and prefers-reduced-motion media block exist.
// ===========================================================================

describe('T7 — accessibility globals exist (CONTRACT-U.0.md §2, §7)', () => {
  it(':focus-visible rule exists', () => {
    assert.match(css, /:focus-visible\s*\{/);
  });

  it('a prefers-reduced-motion: reduce media block exists', () => {
    assert.match(css, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
  });
});

// ===========================================================================
// T8 — every pre-U.0 selector still exists (verbatim list from CONTRACT-U.0
// §7 — this is a RESTYLE, no selector may be dropped or renamed).
// ===========================================================================

const PRE_U0_SELECTOR_LIST = `
.trow .trow-icon .trow-symbol .trow-name .trow-value .trow-status
.trow-direction .trow-hint .trow-log .trow-editor .trow-input .trow-save
.trow-cancel .trow-error .home-new .home-empty .tform .tform-field
.tform-label .tform-select .tform-radio-group .tform-icon-grid
.tform-icon-option .tform-color-group .tform-color-swatch .tform-cancel
.tform-archive .tform-confirm-archive .tform-error .detail .detail-head
.detail-icon .detail-name .detail-direction .detail-edit .detail-ranges
.detail-range .detail-count .chart-slot .chart-slot-title
.chart-slot-loading .detail-offline .detail-error .heatmap .hm-head
.hm-nav .hm-month .hm-weekdays .hm-weekday .hm-grid .hm-cell .hm-fill
.hm-day .day-editor .day-input .day-cancel .day-save .day-error .weekly
.weekly-meaning .weekly-canvas .trend-periods .trend-period .bounds
.bounds-summary .bounds-canvas .bounds-meaning .overlay-picker
.overlay-hint .overlay-chips .overlay-chip .compare-view .compare-picker
.compare-hint .compare-chips .compare-meaning .compare-canvas
.compare-warning .compare-key .compare-key-item .signin .signin-form
.signin-field .signin-toggle .signin-submit .signin-error .signin-as
.signout-warning .lock .lock-title .lock-help .lock-unlock .lock-error
.lock-signout .settings .settings-block .settings-title .settings-help
.settings-window-input .settings-window-save .settings-window-error
.settings-archived .settings-unarchive .settings-export-all
.settings-export-status .settings-export-fallback .settings-export-text
.settings-applock-status .settings-applock-toggle .settings-applock-error
#nav #app .outbox-status .net-status .visually-hidden
`;

const PRE_U0_SELECTORS = Array.from(new Set(PRE_U0_SELECTOR_LIST.split(/\s+/).filter(Boolean)));

describe('T8 — every pre-U.0 selector still exists, verbatim (CONTRACT-U.0.md §7)', () => {
  it('the transcribed list is non-empty (sanity check on this test file itself)', () => {
    assert.ok(PRE_U0_SELECTORS.length > 50, `expected a large selector list, got ${PRE_U0_SELECTORS.length}`);
  });

  for (const selector of PRE_U0_SELECTORS) {
    it(`${selector} still appears as a selector`, () => {
      assert.ok(hasSelectorToken(css, selector), `expected ${selector} to still appear as a selector in css/styles.css`);
    });
  }
});

// ===========================================================================
// T9 — sw.js references the new module and bumps CACHE.
// ===========================================================================

describe('T9 — sw.js updated for the new module (CONTRACT-U.0.md §5, §7)', () => {
  it("contains './js/ui-icons.js'", () => {
    assert.ok(swText.includes('./js/ui-icons.js'));
  });

  it("CACHE is bumped to 'daily-v45'", () => {
    assert.match(swText, /CACHE\s*=\s*['"]daily-v45['"]/);
  });
});
