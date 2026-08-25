// Step D.4 — decides which Supabase project the test tiers are allowed to
// write to, and FAILS CLOSED.
//
// THE PROBLEM. The integration tier creates, PATCHes and DELETEs rows, and
// sweepStaleTestRows() runs an unfiltered SELECT over `trackables`, against
// the LIVE project. That project now holds the user's only copy of three
// months of personal logging. The `__test__` guard in supabase.mjs is
// genuinely strong — it was rewritten after a real data-loss bug and
// isTestName() is exhaustively fuzzed — but the blast radius is unnecessary.
//
// THE RULE. If DAILY_TEST_SUPABASE_URL / DAILY_TEST_SUPABASE_KEY are set, the
// tests use that project. If they are NOT set, this throws. There is
// deliberately no silent fallback to js/config.js: a fallback that quietly
// points destructive tests at production is precisely the hazard being
// removed, and it would be invisible on every future run.
//
// THE INTERIM ESCAPE, AND WHEN IT DIES. Until the second project exists, the
// `--allow-production` flag on run-tier.mjs permits the old behaviour —
// loudly, with an unmissable banner printed on every run. It is a CLI flag
// rather than an env var because `VAR=x cmd` is not portable to Windows and
// this project has a hard no-dependencies rule (so no cross-env).
//
// **Deleting `--allow-production` from package.json is the LAST ACTION of
// Step D.4.** It exists only so the suite is not red while the second project
// is being created. It is not a permanent option; nothing should ever set it
// automatically, conditionally, or in CI.

export const TEST_URL_VAR = 'DAILY_TEST_SUPABASE_URL';
export const TEST_KEY_VAR = 'DAILY_TEST_SUPABASE_KEY';
export const ALLOW_PROD_VAR = 'DAILY_TEST_ALLOW_PRODUCTION';

// The production project ref, hardcoded so the resolver can RECOGNISE
// production rather than merely avoid it by omission. Someone pasting the
// production URL into DAILY_TEST_SUPABASE_URL is a plausible mistake — it is
// the URL closest to hand — and it would silently defeat the whole step.
export const PRODUCTION_REF = 'okwzgmvnsdlheuolcthn';

export function projectRefOf(url) {
  const m = /^https:\/\/([a-z0-9-]+)\.supabase\.co\/?$/i.exec(String(url ?? '').trim());
  return m ? m[1].toLowerCase() : null;
}

function readVar(env, name) {
  const raw = env ? env[name] : undefined;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Resolves the Supabase project the tests may write to.
 *
 * Returns { url, key, mode, ref } where mode is 'test' or 'production'.
 * Throws when neither a test target nor the explicit production opt-in is
 * present.
 */
export function resolveTestTarget(
  env = {},
  { productionUrl, productionKey, allowProduction = false } = {}
) {
  const url = readVar(env, TEST_URL_VAR);
  const key = readVar(env, TEST_KEY_VAR);
  // A real test target ALWAYS wins over the escape hatch. Once the second
  // project is configured, leaving --allow-production in place by accident
  // must not quietly send the tier back to production.
  const allowProd = allowProduction || readVar(env, ALLOW_PROD_VAR) === '1';

  // Half-configured is an error, not a fallback. Someone who set one variable
  // meant to set both, and silently running against production because they
  // fat-fingered the second name is exactly the outcome this file prevents.
  if ((url && !key) || (key && !url)) {
    throw new Error(
      `Step D.4: both ${TEST_URL_VAR} and ${TEST_KEY_VAR} must be set together ` +
        `(got ${url ? TEST_URL_VAR : TEST_KEY_VAR} only). Refusing to guess.`
    );
  }

  if (url && key) {
    const ref = projectRefOf(url);
    if (!ref) {
      throw new Error(
        `Step D.4: ${TEST_URL_VAR} must look like https://<ref>.supabase.co, got: ${url}`
      );
    }
    if (ref === PRODUCTION_REF) {
      throw new Error(
        `Step D.4: ${TEST_URL_VAR} points at the PRODUCTION project (${ref}).\n` +
          'That defeats the entire point of the step — the test tier deletes rows. ' +
          'Use the separate test project.'
      );
    }
    return { url, key, mode: 'test', ref };
  }

  if (allowProd) {
    return {
      url: productionUrl,
      key: productionKey,
      mode: 'production',
      ref: projectRefOf(productionUrl),
    };
  }

  throw new Error(
    `Step D.4: refusing to run destructive tests without an explicit target.\n\n` +
      `Set ${TEST_URL_VAR} and ${TEST_KEY_VAR} to the separate test project.\n` +
      `See docs/BUILD_PLAN.md -> Step D.4 for how to create and seed it.\n\n` +
      `There is no automatic fallback to production: the integration tier ` +
      `creates and DELETES rows, and production holds the only copy of the ` +
      `user's logged data.`
  );
}

// The banner is deliberately hard to miss and deliberately not suppressible.
// A warning nobody sees is the same as no warning.
export function productionWarningLines(ref) {
  return [
    '',
    '  ############################################################',
    '  #  TESTS ARE RUNNING AGAINST THE PRODUCTION DATABASE       #',
    `  #  project: ${String(ref ?? 'unknown').padEnd(45)}#`,
    '  #                                                          #',
    '  #  This tier CREATES and DELETES rows. It is protected     #',
    '  #  only by the __test__ naming guard.                      #',
    '  #                                                          #',
    '  #  Fix: set DAILY_TEST_SUPABASE_URL / _KEY to the separate #',
    '  #  test project, then delete DAILY_TEST_ALLOW_PRODUCTION   #',
    '  #  from package.json. That is the last step of D.4.        #',
    '  ############################################################',
    '',
  ];
}
