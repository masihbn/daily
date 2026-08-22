// Safety-critical suite: this guard is the only thing standing between a
// test teardown and the user's real logged data in Supabase. Every test row
// this project ever writes or deletes MUST be named with the `__test__`
// prefix, and `tests/helpers/supabase.mjs` is supposed to enforce that at
// the URL-building layer, not just "by convention". Be exhaustive and
// hostile here: assume the implementation is wrong until proven otherwise.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEST_PREFIX,
  isTestName,
  assertTestName,
  buildSweepListUrl,
  buildDeleteByNameUrl,
} from '../helpers/supabase.mjs';
import * as guard from '../helpers/supabase.mjs';
import { SUPABASE_URL } from '../../js/config.js';

// ---------------------------------------------------------------------------
// TEST_PREFIX
// ---------------------------------------------------------------------------

describe('TEST_PREFIX', () => {
  it('equals "__test__"', () => {
    assert.equal(TEST_PREFIX, '__test__');
  });
});

// ---------------------------------------------------------------------------
// isTestName — valid names
// ---------------------------------------------------------------------------

const VALID_NAMES = [
  '__test__x',
  '__test__', // exactly the prefix, nothing appended
  '__test__a b&c',
  '__test__' + 'x'.repeat(200),
];

describe('isTestName — valid names', () => {
  for (const name of VALID_NAMES) {
    it(`returns true for ${JSON.stringify(name.length > 40 ? name.slice(0, 40) + '...' : name)}`, () => {
      assert.equal(isTestName(name), true);
    });
  }
});

// ---------------------------------------------------------------------------
// isTestName — invalid names / hostile inputs, must return false, never throw
// ---------------------------------------------------------------------------

function makeSymbol() {
  return Symbol('__test__x');
}

function makeFunction() {
  const fn = function __test__x() {};
  return fn;
}

function makeToStringObject() {
  return {
    toString() {
      return '__test__x';
    },
  };
}

describe('isTestName — invalid names and hostile inputs (never throw, always false)', () => {
  const cases = [
    ['empty string', ''],
    ['prefix missing trailing underscore', '__test_'],
    ['leading underscore missing one', '_test__x'],
    ['missing leading underscores', 'test__x'],
    ['prefix appears mid-string, not at start', 'x__test__y'],
    ['leading space before prefix', ' __test__x'],
    ['wrong case — all caps', '__TEST__x'],
    ['wrong case — mixed', '__Test__x'],
    ['null', null],
    ['undefined', undefined],
    ['number 0', 0],
    ['number 42', 42],
    ['boolean true', true],
    ['boolean false', false],
    ['empty object', {}],
    ['empty array', []],
    ['array containing a valid name', ['__test__x']],
    ['Symbol wrapping a valid-looking name', makeSymbol()],
    ['function named like a valid name', makeFunction()],
    ['object with toString() returning a valid name', makeToStringObject()],
  ];

  for (const [label, value] of cases) {
    it(`returns false, does not throw — ${label}`, () => {
      let result;
      assert.doesNotThrow(() => {
        result = isTestName(value);
      });
      assert.equal(result, false);
    });
  }
});

// ---------------------------------------------------------------------------
// assertTestName — valid names do not throw
// ---------------------------------------------------------------------------

describe('assertTestName — does not throw for valid names', () => {
  for (const name of VALID_NAMES) {
    it(`does not throw for ${JSON.stringify(name.length > 40 ? name.slice(0, 40) + '...' : name)}`, () => {
      assert.doesNotThrow(() => assertTestName(name));
    });
  }
});

// ---------------------------------------------------------------------------
// assertTestName — invalid names throw, with a message naming both the
// literal '__test__' substring and String(value) (where computable safely).
// ---------------------------------------------------------------------------

describe('assertTestName — throws for invalid names', () => {
  const stringableCases = [
    ['empty string', ''],
    ['prefix missing trailing underscore', '__test_'],
    ['leading underscore missing one', '_test__x'],
    ['missing leading underscores', 'test__x'],
    ['prefix appears mid-string, not at start', 'x__test__y'],
    ['leading space before prefix', ' __test__x'],
    ['wrong case — all caps', '__TEST__x'],
    ['wrong case — mixed', '__Test__x'],
    ['null', null],
    ['undefined', undefined],
    ['number 0', 0],
    ['number 42', 42],
    ['boolean true', true],
    ['boolean false', false],
  ];

  for (const [label, value] of stringableCases) {
    it(`throws with message containing '__test__' and String(value) — ${label}`, () => {
      assert.throws(
        () => assertTestName(value),
        (err) => {
          assert.ok(err instanceof Error, 'should throw an Error instance');
          assert.ok(
            err.message.includes('__test__'),
            `message should contain the literal substring '__test__', got: ${err.message}`
          );
          assert.ok(
            err.message.includes(String(value)),
            `message should contain String(value) (${String(value)}), got: ${err.message}`
          );
          return true;
        }
      );
    });
  }

  // Values where String(value) is not a stable/meaningful representation of
  // "the offending name" (objects, arrays, functions, symbols) — still must
  // throw and still must mention '__test__', but we don't require the message
  // to contain String(value) for these.
  const nonStringableCases = [
    ['empty object', {}],
    ['empty array', []],
    ['array containing a valid name', ['__test__x']],
    ['Symbol wrapping a valid-looking name', makeSymbol()],
    ['function named like a valid name', makeFunction()],
    ['object with toString() returning a valid name', makeToStringObject()],
  ];

  for (const [label, value] of nonStringableCases) {
    it(`throws with message containing '__test__' — ${label}`, () => {
      assert.throws(
        () => assertTestName(value),
        (err) => {
          assert.ok(err instanceof Error, 'should throw an Error instance');
          assert.ok(
            err.message.includes('__test__'),
            `message should contain the literal substring '__test__', got: ${err.message}`
          );
          return true;
        }
      );
    });
  }
});

// ---------------------------------------------------------------------------
// buildSweepUrl must be GONE — it built /rest/v1/trackables?name=like.__test__*
// which PostgREST translates to SQL `LIKE '__test__%'`. In SQL LIKE, `_` is a
// single-character wildcard, so that pattern does NOT mean "starts with
// __test__" — it matches any 2 chars + "test" + any 2 chars + anything. A
// real user trackable like 'mytestrun' matched it and would have been
// permanently deleted by the sweep that runs at the start of every suite run,
// against the user's LIVE database. The fix removes SQL wildcards from the
// sweep entirely (see buildSweepListUrl below). This assertion guards against
// the hazard being reintroduced under the old name or a similarly-shaped one.
// ---------------------------------------------------------------------------

describe('buildSweepUrl — must no longer exist', () => {
  it('is not exported (the LIKE-wildcard sweep hazard must not be reintroduced)', () => {
    assert.equal(typeof guard.buildSweepUrl, 'undefined');
  });
});

// ---------------------------------------------------------------------------
// buildSweepListUrl — the replacement contract.
//
// This is a READ-ONLY GET url. It deliberately carries NO `name` filter of
// any kind — filtering happens in JS, via the already-exhaustively-tested
// isTestName() predicate, never in SQL. This is what closes the data-loss
// bug: there is no wildcard pattern left anywhere for SQL LIKE to
// misinterpret.
// ---------------------------------------------------------------------------

describe('buildSweepListUrl', () => {
  it('starts with SUPABASE_URL + /rest/v1/trackables', () => {
    const url = buildSweepListUrl();
    assert.ok(
      url.startsWith(`${SUPABASE_URL}/rest/v1/trackables`),
      `expected url to start with ${SUPABASE_URL}/rest/v1/trackables, got: ${url}`
    );
  });

  it('selects id,name', () => {
    const url = buildSweepListUrl();
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('select'), 'id,name');
  });

  it('carries no name filter at all', () => {
    const url = buildSweepListUrl();
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('name'), null);
  });

  it('contains no SQL wildcard characters (no % and no *) anywhere in the URL', () => {
    const url = buildSweepListUrl();
    assert.ok(!url.includes('%'), `expected no '%' in url, got: ${url}`);
    assert.ok(!url.includes('*'), `expected no '*' in url, got: ${url}`);
  });
});

// ---------------------------------------------------------------------------
// Regression: the exact bug found 2026-08-21. `_` is a single-character
// wildcard in SQL LIKE, so the old sweep filter `name=like.__test__*`
// (translated by PostgREST to SQL `LIKE '__test__%'`) did NOT mean "starts
// with __test__". It meant: any 2 characters, then literal "test", then any
// 2 characters, then anything. Every name below matched that broken pattern
// and would have been silently, permanently deleted from the user's live
// Supabase database by the sweep that runs at the start of every suite run —
// none of them carry the real __test__ prefix and none of them should ever
// be treated as a test row. isTestName() must reject all of them, and
// buildDeleteByNameUrl() must refuse to build a delete URL for any of them.
// ---------------------------------------------------------------------------

describe('regression — names that matched the old broken LIKE pattern (2026-08-21)', () => {
  const OLD_PATTERN_FALSE_MATCHES = [
    'mytestrun',
    'AAtestBB',
    '12test34x',
    'qqtestzz',
    'xxtestyy',
    'ab' + 'test' + 'cd',
    'my test run x',
  ];

  for (const name of OLD_PATTERN_FALSE_MATCHES) {
    it(`isTestName(${JSON.stringify(name)}) is false`, () => {
      assert.equal(isTestName(name), false);
    });

    it(`buildDeleteByNameUrl(${JSON.stringify(name)}) throws`, () => {
      assert.throws(() => buildDeleteByNameUrl(name));
    });
  }
});

// ---------------------------------------------------------------------------
// buildDeleteByNameUrl — valid usage
// ---------------------------------------------------------------------------

describe('buildDeleteByNameUrl — valid names', () => {
  it('builds a URL with name=eq.<name>', () => {
    const url = buildDeleteByNameUrl('__test__abc');
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('name'), 'eq.__test__abc');
  });

  it('round-trips special characters (space, &, =) correctly through encoding', () => {
    // An unescaped '&' would truncate the query string at that point and
    // turn a targeted single-row delete into a delete matching a broader
    // (or entirely different) filter — exactly the class of bug this
    // asserts against.
    const url = buildDeleteByNameUrl('__test__a b&c=d');
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('name'), 'eq.__test__a b&c=d');
  });

  it('points at the trackables resource', () => {
    const url = buildDeleteByNameUrl('__test__abc');
    assert.ok(url.startsWith(`${SUPABASE_URL}/rest/v1/trackables`));
  });
});

// ---------------------------------------------------------------------------
// buildDeleteByNameUrl — the core guard, table-driven, hostile names.
// This must NEVER return a URL for a non-__test__ name.
// ---------------------------------------------------------------------------

const HOSTILE_NAMES = [
  ['empty string', ''],
  ['wildcard star', '*'],
  ['percent sign', '%'],
  ['single dot', '.'],
  ['looks like a real habit', 'real_habit'],
  ['a plausible real habit name', 'workout'],
  ['prefix missing trailing underscore', '__test'],
  ['single character', 'x'],
  ['null', null],
  ['undefined', undefined],
  ['sql-injection-shaped string', '; drop table trackables;'],
];

describe('buildDeleteByNameUrl — hostile names must always throw, never return a URL', () => {
  for (const [label, name] of HOSTILE_NAMES) {
    it(`throws for ${label} (${JSON.stringify(name)})`, () => {
      assert.throws(() => buildDeleteByNameUrl(name));
    });
  }

  it('asserts the name before doing anything else (all hostile names throw synchronously)', () => {
    for (const [, name] of HOSTILE_NAMES) {
      assert.throws(() => buildDeleteByNameUrl(name));
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant test — for every valid __test__ name, the built URL's name param
// always starts with 'eq.__test__'. Guards against a future refactor that
// silently drops or weakens the filter.
// ---------------------------------------------------------------------------

describe('buildDeleteByNameUrl — invariant: name param always starts with eq.__test__', () => {
  const candidateValidNames = [
    '__test__',
    '__test__x',
    '__test__abc123',
    '__test__auto_1234567890_abcdef',
    '__test__with spaces and & symbols = signs',
    '__test__' + 'y'.repeat(300),
    '__test__.dots.and-dashes',
    '__test__UPPER_lower_MiXeD',
  ];

  for (const name of candidateValidNames) {
    it(`holds for ${JSON.stringify(name.length > 40 ? name.slice(0, 40) + '...' : name)}`, () => {
      const url = buildDeleteByNameUrl(name);
      const parsed = new URL(url);
      const value = parsed.searchParams.get('name');
      assert.ok(
        value.startsWith('eq.__test__'),
        `expected name param to start with 'eq.__test__', got: ${value}`
      );
    });
  }
});
