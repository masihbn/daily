// Structural/text-based tests for sw.js and index.html — no DOM, no browser.
// Read as plain text and asserted against with string/regex checks. This is
// the cheap tier for catching the single most-repeated gotcha in this
// project: adding a JS module (or a CDN asset) and forgetting to add it to
// the service-worker cache list, so already-installed phones never fetch it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const swPath = path.join(repoRoot, 'sw.js');
const indexPath = path.join(repoRoot, 'index.html');
const jsDir = path.join(repoRoot, 'js');
const cssPath = path.join(repoRoot, 'css', 'styles.css');

const swText = fs.readFileSync(swPath, 'utf8');
const indexText = fs.readFileSync(indexPath, 'utf8');
const cssText = fs.readFileSync(cssPath, 'utf8');

describe('sw.js — CACHE constant', () => {
  // This block used to pin CACHE to an exact value ('daily-v4'). That pin
  // was removed: the CACHE version legitimately changes on every legitimate
  // asset change — including this very fix, which touches css/styles.css
  // and therefore must bump the cache version so already-installed phones
  // don't keep serving the old (broken) stylesheet. An assertion that must
  // be hand-edited on every legitimate change is actively harmful: it
  // trains whoever is working to edit the test until it goes green, which
  // is exactly the habit docs/ORCHESTRATION.md forbids. The bump discipline
  // is enforced by review and the commit checklist, not by an assertion
  // that must itself be rewritten to stay green.
  it("the CACHE value matches /^daily-v\\d+$/ (guards against reverting to the old 'memtest-' naming)", () => {
    const match = swText.match(/\b(?:const|let|var)\s+CACHE\s*=\s*(['"])([^'"]+)\1/);
    assert.ok(match, 'expected a CACHE declaration in sw.js');
    const value = match[2];
    assert.match(value, /^daily-v\d+$/);
  });

  it("the CACHE value does not use the retired 'memtest-' naming", () => {
    const match = swText.match(/\b(?:const|let|var)\s+CACHE\s*=\s*(['"])([^'"]+)\1/);
    assert.ok(match, 'expected a CACHE declaration in sw.js');
    const value = match[2];
    assert.doesNotMatch(value, /^memtest-/);
  });
});

describe('sw.js — ASSETS list', () => {
  it('does not reference js/app.js anywhere', () => {
    assert.doesNotMatch(swText, /js\/app\.js/);
  });

  const requiredAssets = [
    './js/main.js',
    './js/router.js',
    './js/config.js',
    './index.html',
    './manifest.json',
    './css/styles.css',
    './icons/icon-192.png',
    './icons/icon-512.png',
  ];

  for (const asset of requiredAssets) {
    it(`contains ${asset}`, () => {
      assert.ok(swText.includes(asset), `expected sw.js to contain "${asset}"`);
    });
  }

  it("contains './' (the root/shell entry)", () => {
    // Asserted loosely as a quoted standalone entry, since it's easy to
    // false-positive-match inside a longer path otherwise.
    assert.match(swText, /['"]\.\/['"]/);
  });

  it(
    'HIGH-VALUE GUARD: every .js file actually present in js/ appears in sw.js — ' +
      'this is the exact gotcha that bites when a module is added but the cache ' +
      'list is not updated, so installed phones keep serving stale/missing files',
    () => {
      const jsFiles = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'));
      assert.ok(jsFiles.length > 0, 'expected at least one .js file in js/ to check against');
      for (const file of jsFiles) {
        const rel = `./js/${file}`;
        assert.ok(
          swText.includes(rel) || swText.includes(`js/${file}`),
          `expected sw.js to list ${rel} (found in js/ via fs.readdirSync but missing from the cache list)`
        );
      }
    }
  );

  it('contains at least two https://cdn.jsdelivr.net/ URLs (the pinned Chart.js + annotation plugin scripts)', () => {
    const matches = swText.match(/https:\/\/cdn\.jsdelivr\.net\/[^\s'"`)]+/g) || [];
    assert.ok(
      matches.length >= 2,
      `expected at least 2 jsdelivr URLs in sw.js, found ${matches.length}: ${JSON.stringify(matches)}`
    );
  });
});

describe('no floating CDN script version anywhere', () => {
  // The property that matters: every jsDelivr script URL is pinned to an
  // exact version, and none floats (via @latest, or any other non-exact
  // range like a bare major version). A silent major bump on an unpinned
  // URL would break the installed app on the user's phone with no deploy.
  //
  // A raw substring check for the literal text "@latest" is the wrong tool
  // for this: it can't distinguish a script URL from prose, so it flags (or
  // misses) things that have nothing to do with actual CDN references — e.g.
  // it would fail on a code comment that merely *mentions* "@latest" to
  // explain why it's avoided, and it would just as happily pass a URL like
  // chart.js@4 (a floating major-version range, exactly the hazard this is
  // meant to catch) since the literal string "@latest" never appears there.
  //
  // Instead: extract every jsDelivr URL from the file, require at least two
  // in each (so a regex that silently matches nothing can't make this pass
  // vacuously), and assert each one carries an exact x.y.z version pin.
  const jsdelivrUrlRe = /https:\/\/cdn\.jsdelivr\.net\/[^\s'"`)]+/g;
  const pinnedVersionRe = /@\d+\.\d+\.\d+/;

  for (const [label, text] of [
    ['sw.js', swText],
    ['index.html', indexText],
  ]) {
    it(`${label}: at least two jsDelivr URLs found, none floating, all exactly version-pinned`, () => {
      const urls = text.match(jsdelivrUrlRe) || [];
      assert.ok(
        urls.length >= 2,
        `expected at least 2 jsdelivr URLs in ${label}, found ${urls.length}: ${JSON.stringify(urls)}`
      );
      for (const url of urls) {
        assert.doesNotMatch(url, /@latest/, `${label}: floating @latest URL found: ${url}`);
        assert.match(
          url,
          pinnedVersionRe,
          `${label}: URL is not pinned to an exact x.y.z version: ${url}`
        );
      }
    });
  }
});

describe('index.html — module script and no app.js reference', () => {
  it('references js/main.js with type="module"', () => {
    // Look for a <script> tag combining type="module" and a src pointing at
    // js/main.js, tolerant of attribute order.
    const scriptTagRe = /<script\b[^>]*>/gi;
    const tags = indexText.match(scriptTagRe) || [];
    const found = tags.some(
      (tag) => /src=["'][^"']*js\/main\.js["']/.test(tag) && /type=["']module["']/.test(tag)
    );
    assert.ok(
      found,
      `expected a <script type="module" src=".../js/main.js"> tag in index.html, tags found: ${JSON.stringify(tags)}`
    );
  });

  it('does not reference js/app.js', () => {
    assert.doesNotMatch(indexText, /js\/app\.js/);
  });
});

describe('js/app.js is deleted', () => {
  it('does not exist on disk', () => {
    assert.equal(fs.existsSync(path.join(jsDir, 'app.js')), false);
  });
});

describe('CDN URL parity between index.html and sw.js', () => {
  it('every jsDelivr URL referenced in index.html also appears in sw.js (so charts still work offline)', () => {
    // Extract from <script src="..."> attributes to avoid over-matching, but
    // do not hardcode version numbers — the implementer picks them.
    const srcRe = /src=["'](https:\/\/cdn\.jsdelivr\.net\/[^"']+)["']/g;
    const urls = [];
    let m;
    while ((m = srcRe.exec(indexText)) !== null) {
      urls.push(m[1]);
    }
    assert.ok(
      urls.length >= 2,
      `expected at least 2 jsdelivr <script src> URLs in index.html, found ${urls.length}: ${JSON.stringify(urls)}`
    );
    for (const url of urls) {
      assert.ok(swText.includes(url), `expected sw.js to also cache ${url} (found referenced in index.html)`);
    }
  });
});

describe('css/styles.css — iOS safe-area handling (regression tests, NOT rendering tests)', () => {
  // Two real bugs were reported from a physical iPhone on 2026-08-22 that the
  // existing test suite — including the Playwright e2e "nav is inside the
  // viewport" test — did not catch:
  //
  //   1. The <header> overlapped the system clock in the notch, because
  //      nothing applied env(safe-area-inset-top).
  //   2. A band of mismatched color appeared below the bottom nav in
  //      installed standalone mode. NOTE: the first diagnosis of this was
  //      WRONG and is corrected here so nobody re-investigates the nav.
  //      #nav was ALREADY correct — `bottom: 0` with the inset carried as
  //      `padding-bottom` — so it was never the cause. The working theory
  //      is that `html` had no background, letting `body`'s color
  //      propagate to the canvas, while `height: 100%` resolves against a
  //      layout viewport that under `viewport-fit=cover` can be shorter
  //      than the physical screen; the leftover gap then painted in the
  //      page color against the nav's elevated color. `html` now carries
  //      the elevated color. That remains a hypothesis pending device
  //      re-verification — see the comment in css/styles.css.
  //
  //      The `bottom: env(...)` assertion below is therefore a guard
  //      against introducing that broken pattern, NOT a record of what
  //      caused this bug. It is still worth keeping: it is a real way to
  //      break the nav, it just is not what happened here.
  //
  // Playwright cannot catch either of these: it does not emulate
  // safe-area insets, so env(safe-area-inset-*) evaluates to 0 in headless
  // Chromium, and the existing e2e nav-in-viewport test passes happily on
  // broken CSS. The only true verification is a physical device.
  //
  // So the guard here is deliberately structural, not visual: assert the
  // stylesheet actually contains the rules that make safe-area handling
  // correct. This CANNOT prove the page renders correctly on a phone — it
  // only prevents someone from silently deleting or refactoring these rules
  // away and shipping a broken layout again. These are NOT rendering tests.

  it('references env(safe-area-inset-top (the header top inset)', () => {
    assert.match(cssText, /env\(\s*safe-area-inset-top/);
  });

  it('references env(safe-area-inset-bottom (the nav bottom inset)', () => {
    assert.match(cssText, /env\(\s*safe-area-inset-bottom/);
  });

  it('references env(safe-area-inset-left and env(safe-area-inset-right (landscape insets on a notched device)', () => {
    assert.match(cssText, /env\(\s*safe-area-inset-left/);
    assert.match(cssText, /env\(\s*safe-area-inset-right/);
  });

  it('every env(safe-area-inset-...) occurrence supplies a fallback value', () => {
    // A bare env(safe-area-inset-top) with no second argument makes the
    // *entire* CSS declaration it appears in invalid on browsers/engines
    // without safe-area support (e.g. older Safari, non-notched devices
    // that still don't recognize the env() function at all), so the
    // padding/inset silently vanishes rather than degrading to a sane
    // default. Every occurrence must be of the form
    // env(safe-area-inset-<side>, <fallback>) — extract every occurrence
    // with a global regex and require each one to have a comma-separated
    // second argument.
    const occurrences = cssText.match(/env\(\s*safe-area-inset-[a-z]+[^)]*\)/g) || [];
    assert.ok(
      occurrences.length > 0,
      'expected at least one env(safe-area-inset-...) occurrence in css/styles.css to check'
    );
    for (const occurrence of occurrences) {
      assert.match(
        occurrence,
        /env\(\s*safe-area-inset-[a-z]+\s*,\s*[^)]+\)/,
        `expected a fallback value (comma-separated 2nd argument) in: ${occurrence}`
      );
    }
  });

  it(
    'the nav must not be anchored with `bottom: env(safe-area-inset-bottom...)` — that ' +
      'pattern lifts the whole bar up off the screen edge instead of letting its ' +
      'background reach it (a guard against introducing this, NOT the cause of the ' +
      '2026-08-22 device report — see the note at the top of this block)',
    () => {
      // The lookbehind is load-bearing. Without it this pattern also matches
      // `padding-bottom: env(safe-area-inset-bottom, 0px)` — the CORRECT rule,
      // since "padding-bottom" ends in "bottom". The first version of this
      // test had that bug and could never pass on correct CSS, which would
      // have pressured someone into deleting the correct padding to go green.
      // Match only a standalone `bottom` property.
      assert.doesNotMatch(
        cssText,
        /(?<![-\w])bottom\s*:\s*env\(\s*safe-area-inset-bottom/,
        'found `bottom: env(safe-area-inset-bottom...)` in css/styles.css — that pattern ' +
          'lifts the nav off the screen edge; carry the inset as padding-bottom instead'
      );
    }
  );

  it('the nav rule anchors at the bottom edge with `bottom: 0` (padding, not position, should carry the inset)', () => {
    assert.match(cssText, /bottom\s*:\s*0(?:px)?\b/);
  });
});

describe('index.html — status bar style (regression test, NOT a rendering test)', () => {
  // Confirmed on a physical iPhone on 2026-08-22 — the installed standalone
  // PWA left a 59pt strip of bare screen uncovered at the bottom. Measured:
  //
  //   screen.height:       852.0
  //   window.innerHeight:  793.0    (852 - 793 = 59, exactly safe-area-inset-top)
  //   safe-area-inset-top: 59.0
  //   #nav: top=714.0 bottom=793.0
  //   gap below nav (innerHeight - nav.bottom): 0.0
  //
  // That last line rules out the nav: it was flush with the bottom of the
  // layout viewport the whole time, so no nav CSS could have been at fault.
  //
  // Mechanism: <meta name="apple-mobile-web-app-status-bar-style"
  // content="black-translucent"> makes iOS position the web view at the
  // physical top of the screen (y=0) but size it as
  // `screenHeight - statusBarHeight`. The 59pt deficit that results falls
  // off the BOTTOM of the view — outside it entirely, which is why no CSS
  // fix, however correct, could ever paint it. The fix is to use
  // content="black" instead, which makes iOS position the view below the
  // status bar and size it correctly, eliminating the deficit.
  //
  // This is invisible in Safari (Safari's own toolbar covers the region)
  // and invisible to Playwright (which does not emulate standalone display
  // mode or safe-area insets at all). A structural, text-level assertion
  // against the markup is therefore the only guard available — there is no
  // way to catch this by rendering.
  //
  // WARNING: someone will eventually want the translucent status bar back
  // for aesthetic reasons (it looks nicer than a solid black bar). Restoring
  // `black-translucent` silently reintroduces this exact bug. Don't do it
  // without also solving the view-sizing problem some other way first.

  it('no <meta> tag sets content="black-translucent" (the regression guard)', () => {
    // Assert on META TAGS, not on the raw file text. A bare
    // /black-translucent/ search over indexText also matches the HTML
    // comment directly above the tag that documents why the value must
    // not be used — i.e. it fails on the very documentation of the fix.
    //
    // That is the THIRD time in one day a text-level assertion here has
    // accused correct code by matching prose or a longer token: an
    // @latest check matched a comment explaining why @latest is avoided,
    // and a /bottom:/ check matched `padding-bottom:`. The lesson is
    // general — anchor the match to the construct you actually care
    // about (here, a meta tag's content attribute), never to a substring
    // that can occur in a comment.
    const metaTags = indexText.match(/<meta\b[^>]*>/gi) || [];
    assert.ok(metaTags.length > 0, 'expected at least one <meta> tag in index.html');
    for (const tag of metaTags) {
      assert.doesNotMatch(
        tag,
        /content=["'][^"']*black-translucent[^"']*["']/i,
        `found a meta tag using black-translucent, which reintroduces the ` +
          `59pt uncovered strip in standalone mode: ${tag}`
      );
    }
  });

  it('contains an apple-mobile-web-app-status-bar-style meta tag with content="black"', () => {
    // Tolerant of attribute order (name before/after content) and quote style.
    const nameFirst =
      /<meta\b[^>]*name=["']apple-mobile-web-app-status-bar-style["'][^>]*content=["']black["'][^>]*>/i;
    const contentFirst =
      /<meta\b[^>]*content=["']black["'][^>]*name=["']apple-mobile-web-app-status-bar-style["'][^>]*>/i;
    assert.ok(
      nameFirst.test(indexText) || contentFirst.test(indexText),
      'expected a <meta name="apple-mobile-web-app-status-bar-style" content="black"> tag in index.html'
    );
  });

  it('viewport meta still contains viewport-fit=cover (required for the fix — it still provides the bottom home-indicator inset and landscape left/right insets)', () => {
    assert.match(indexText, /viewport-fit=cover/);
  });
});
