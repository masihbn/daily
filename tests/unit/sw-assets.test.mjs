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

const swText = fs.readFileSync(swPath, 'utf8');
const indexText = fs.readFileSync(indexPath, 'utf8');

describe('sw.js — CACHE constant', () => {
  it("contains a CACHE declaration whose value is exactly 'daily-v4'", () => {
    // Flexible on whitespace/quote style (single or double quotes, var/let/const),
    // but the literal value must be exactly daily-v4.
    const match = swText.match(/\b(?:const|let|var)\s+CACHE\s*=\s*(['"])daily-v4\1/);
    assert.ok(
      match,
      `expected to find a CACHE declaration with value 'daily-v4' in sw.js, got:\n${swText.slice(0, 300)}...`
    );
  });

  it("the CACHE value matches /^daily-v\\d+$/ (guards against reverting to the old 'memtest-' naming)", () => {
    const match = swText.match(/\b(?:const|let|var)\s+CACHE\s*=\s*(['"])([^'"]+)\1/);
    assert.ok(match, 'expected a CACHE declaration in sw.js');
    const value = match[2];
    assert.match(value, /^daily-v\d+$/);
    assert.equal(value, 'daily-v4');
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
