// Step D.4 — the fail-closed test-target resolver, and js/config.js's env
// override.
//
// What is being protected: the integration tier CREATES and DELETES rows, and
// sweepStaleTestRows() runs an unfiltered SELECT over `trackables`. Once the
// user's three months of logging exist, pointing that tier at production is a
// standing hazard with no upside. This resolver is the thing that decides,
// and its whole value is in refusing rather than guessing.
//
// Every case here is a refusal case or a "the refusal did not overreach"
// case. A resolver that throws for everything would satisfy a one-sided test
// and make the suite unrunnable.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveTestTarget,
  projectRefOf,
  productionWarningLines,
  PRODUCTION_REF,
  TEST_URL_VAR,
  TEST_KEY_VAR,
} from '../../tests/helpers/test-target.mjs';

const PROD = { productionUrl: `https://${PRODUCTION_REF}.supabase.co`, productionKey: 'prod-key' };
const TEST_URL = 'https://abcdefghijklmnop.supabase.co';

describe('D.4: resolveTestTarget — refuses by default', () => {
  it('throws when nothing is configured, and says what to set', () => {
    assert.throws(
      () => resolveTestTarget({}, PROD),
      (err) => {
        assert.match(err.message, new RegExp(TEST_URL_VAR));
        assert.match(err.message, new RegExp(TEST_KEY_VAR));
        assert.match(err.message, /no automatic fallback to production/i);
        return true;
      }
    );
  });

  it('throws when only the URL is set — half-configured is an error, not a fallback', () => {
    // Someone who set one variable meant to set both. Silently running
    // against production because they mistyped the second name is exactly
    // the outcome this file exists to prevent.
    assert.throws(
      () => resolveTestTarget({ [TEST_URL_VAR]: TEST_URL }, PROD),
      /must be set together/
    );
  });

  it('throws when only the KEY is set', () => {
    assert.throws(
      () => resolveTestTarget({ [TEST_KEY_VAR]: 'k' }, PROD),
      /must be set together/
    );
  });

  it('treats empty and whitespace-only values as unset', () => {
    assert.throws(() => resolveTestTarget({ [TEST_URL_VAR]: '   ', [TEST_KEY_VAR]: '' }, PROD), /refusing/i);
  });
});

describe('D.4: resolveTestTarget — accepts a real test project', () => {
  it('returns the test target when both vars are set', () => {
    const t = resolveTestTarget({ [TEST_URL_VAR]: TEST_URL, [TEST_KEY_VAR]: 'k' }, PROD);
    assert.equal(t.mode, 'test');
    assert.equal(t.url, TEST_URL);
    assert.equal(t.key, 'k');
    assert.equal(t.ref, 'abcdefghijklmnop');
  });

  it('trims surrounding whitespace (pasted values routinely carry it)', () => {
    const t = resolveTestTarget({ [TEST_URL_VAR]: `  ${TEST_URL}  `, [TEST_KEY_VAR]: ' k ' }, PROD);
    assert.equal(t.url, TEST_URL);
    assert.equal(t.key, 'k');
  });

  it('REFUSES a test URL that is actually the production project', () => {
    // The most plausible mistake in this whole step: production's URL is the
    // one closest to hand, and pasting it here would silently undo everything
    // the step is for. Recognising production by name beats merely avoiding
    // it by omission.
    assert.throws(
      () => resolveTestTarget({ [TEST_URL_VAR]: PROD.productionUrl, [TEST_KEY_VAR]: 'k' }, PROD),
      /points at the PRODUCTION project/
    );
  });

  it('rejects a URL that is not a Supabase project URL', () => {
    for (const bad of ['http://evil.example.com', 'abcdefg.supabase.co', 'https://a.b.supabase.co/x']) {
      assert.throws(
        () => resolveTestTarget({ [TEST_URL_VAR]: bad, [TEST_KEY_VAR]: 'k' }, PROD),
        /must look like https:\/\/<ref>\.supabase\.co/,
        `should reject ${bad}`
      );
    }
  });
});

describe('D.4: the interim --allow-production escape', () => {
  it('permits production only when explicitly opted in', () => {
    const t = resolveTestTarget({}, { ...PROD, allowProduction: true });
    assert.equal(t.mode, 'production');
    assert.equal(t.url, PROD.productionUrl);
    assert.equal(t.ref, PRODUCTION_REF);
  });

  it('a configured TEST TARGET WINS over the escape hatch', () => {
    // Once the second project exists, leaving --allow-production in
    // package.json by accident must not quietly send the tier back to
    // production. Precedence, not just presence.
    const t = resolveTestTarget(
      { [TEST_URL_VAR]: TEST_URL, [TEST_KEY_VAR]: 'k' },
      { ...PROD, allowProduction: true }
    );
    assert.equal(t.mode, 'test');
    assert.equal(t.ref, 'abcdefghijklmnop');
  });

  it('the warning banner names the project and the exact fix', () => {
    const text = productionWarningLines(PRODUCTION_REF).join('\n');
    assert.match(text, /PRODUCTION DATABASE/);
    assert.match(text, new RegExp(PRODUCTION_REF));
    assert.match(text, /DELETES rows/);
    assert.match(text, new RegExp(TEST_URL_VAR));
  });

  it('package.json still carries the flag — this test FLIPS when D.4 finishes', () => {
    // Deliberately written to fail once --allow-production is removed. That
    // failure is the reminder to come back here, delete this case, and record
    // D.4 as done — rather than the flag lingering unnoticed for months,
    // which is precisely how an interim escape becomes permanent.
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const script = pkg.scripts['test:integration'];
    assert.match(
      script,
      /--allow-production/,
      'If this fails, the second Supabase project is presumably wired up: delete this test ' +
        'and mark Step D.4 DONE in docs/BUILD_PLAN.md.'
    );
  });
});

describe('D.4: projectRefOf', () => {
  it('extracts the ref, tolerating a trailing slash and mixed case', () => {
    assert.equal(projectRefOf('https://AbCdEf.supabase.co'), 'abcdef');
    assert.equal(projectRefOf('https://abcdef.supabase.co/'), 'abcdef');
  });

  it('returns null for anything that is not a project root URL', () => {
    for (const bad of ['', null, undefined, 42, 'https://example.com', 'https://a.supabase.co/rest/v1']) {
      assert.equal(projectRefOf(bad), null, `${JSON.stringify(bad)} should not parse`);
    }
  });
});

describe('D.4: js/config.js env override', () => {
  it('falls back to the PRODUCTION literals when no override is set', async () => {
    // The deployed app must be unaffected by this mechanism. The browser has
    // no `process`, so it always takes this path — asserted against the real
    // literals rather than "some string", so an accidental edit to the
    // production URL is caught here.
    const src = readFileSync(new URL('../../js/config.js', import.meta.url), 'utf8');
    assert.match(src, /'https:\/\/okwzgmvnsdlheuolcthn\.supabase\.co'/);
    assert.match(src, /'sb_publishable_JL-5T3kRE0jH0kLqKCcH9Q_-ljk_rxB'/);
  });

  it('guards the process access so it is inert in a browser', () => {
    const src = readFileSync(new URL('../../js/config.js', import.meta.url), 'utf8');
    assert.match(
      src,
      /typeof process === 'undefined'/,
      'config.js must not touch `process` unguarded — it would throw in the browser'
    );
  });

  it('still never contains a service_role key', () => {
    // Standing invariant, not specific to this step: config.js ships to every
    // browser that loads the app.
    const src = readFileSync(new URL('../../js/config.js', import.meta.url), 'utf8');
    assert.ok(!/service_role/i.test(src.replace(/\/\/[^\n]*/g, '')), 'service_role key must never appear in config.js');
    assert.ok(!/\bsb_secret_/.test(src), 'a secret key must never appear in config.js');
  });
});
