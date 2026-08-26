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
  parseEnvFile,
  mergeEnv,
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

  it('package.json must NOT carry --allow-production (D.4 is finished)', () => {
    // The inverse of the case that used to live here. While the second
    // Supabase project was being created, this asserted the flag was still
    // PRESENT, so that removing it would fail loudly and prompt someone to
    // finish the step. The project now exists (ref dftqrsngiroitugbwtaz), the
    // flag is gone, and the assertion is flipped to keep it gone.
    //
    // Re-adding the flag would silently re-point a tier that CREATES and
    // DELETES rows at the database holding the user's only copy of their
    // logged data. That is a deliberate act, and it should have to delete
    // this test to happen.
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const script = pkg.scripts['test:integration'];
    assert.ok(
      !/--allow-production/.test(script),
      'test:integration must not re-enable the production escape hatch: ' + script
    );
  });
});

describe('D.4: .env.test loading', () => {
  it('parses simple KEY=VALUE lines, ignoring comments and blanks', () => {
    const env = parseEnvFile([
      '# a comment',
      '',
      '   ',
      `${TEST_URL_VAR}=${TEST_URL}`,
      `${TEST_KEY_VAR}=abc123`,
    ].join('\n'));
    assert.deepEqual(env, { [TEST_URL_VAR]: TEST_URL, [TEST_KEY_VAR]: 'abc123' });
  });

  it('strips one matched pair of surrounding quotes', () => {
    // A pasted value that arrived wrapped in quotes must not carry them into
    // the key — that would produce a 401 that looks like a wrong key.
    const env = parseEnvFile(`${TEST_KEY_VAR}="abc"\nOTHER='def'`);
    assert.equal(env[TEST_KEY_VAR], 'abc');
    assert.equal(env.OTHER, 'def');
  });

  it('keeps "=" inside a value (keys can contain them)', () => {
    const env = parseEnvFile('K=a=b=c');
    assert.equal(env.K, 'a=b=c');
  });

  it('ignores malformed lines rather than throwing', () => {
    const env = parseEnvFile('novalue\n=noKey\nGOOD=1');
    assert.deepEqual(env, { GOOD: '1' });
  });

  it('handles an empty or absent file', () => {
    assert.deepEqual(parseEnvFile(''), {});
    assert.deepEqual(parseEnvFile(null), {});
    assert.deepEqual(parseEnvFile(undefined), {});
  });

  it('REAL environment variables win over the file', () => {
    // A one-off `DAILY_TEST_SUPABASE_URL=... npm test` must override whatever
    // is on disk, and CI must never be silently redirected by a stray local
    // file someone forgot about.
    const merged = mergeEnv(
      { [TEST_URL_VAR]: 'https://fromenv.supabase.co' },
      { [TEST_URL_VAR]: 'https://fromfile.supabase.co', [TEST_KEY_VAR]: 'k' }
    );
    assert.equal(merged[TEST_URL_VAR], 'https://fromenv.supabase.co');
    assert.equal(merged[TEST_KEY_VAR], 'k', 'file values still fill the gaps');
  });

  it('an empty real env var does not blank out a file value', () => {
    // Windows in particular loves handing through empty strings.
    const merged = mergeEnv({ [TEST_URL_VAR]: '   ' }, { [TEST_URL_VAR]: TEST_URL });
    assert.equal(merged[TEST_URL_VAR], TEST_URL);
  });

  it('a file WITHOUT credentials still leaves the resolver refusing', () => {
    // The file is a convenience, not a bypass. Fail-closed must survive it.
    const merged = mergeEnv({}, parseEnvFile('# nothing useful here\n'));
    assert.throws(() => resolveTestTarget(merged, PROD), /refusing/i);
  });

  it('.env.test.example ships the right variable names', () => {
    // A template with a typo'd name is worse than none: it produces the
    // "both must be set together" error with both lines apparently present.
    const example = readFileSync(new URL('../../.env.test.example', import.meta.url), 'utf8');
    const parsed = parseEnvFile(example);
    assert.ok(TEST_URL_VAR in parsed, `${TEST_URL_VAR} missing from .env.test.example`);
    assert.ok(TEST_KEY_VAR in parsed, `${TEST_KEY_VAR} missing from .env.test.example`);
  });

  it('.env.test is gitignored — this repo is PUBLIC', () => {
    const ignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
    const entries = ignore.split(/\r?\n/).map((l) => l.trim());
    assert.ok(entries.includes('.env.test'), '.env.test must be listed in .gitignore');
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
