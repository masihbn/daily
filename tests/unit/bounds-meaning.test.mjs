// Unit tests for the Step 4.1 extension to js/charts/bounds.js's
// boundsMeaningText(period, unit, bounds) — the optional third argument.
// Written strictly against CONTRACT-4.1.md §2; the implementation is being
// written in parallel and has NOT been read while writing this file.
//
// Does NOT edit tests/unit/bounds.test.mjs (which already pins the
// two-argument behaviour as N18) — this file only adds coverage for the
// new third argument, plus a minimal "still works with no third arg" smoke
// check so a regression here is caught in the file that actually owns the
// new behaviour.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { boundsMeaningText } from '../../js/charts/bounds.js';

const AUTO_SUFFIX_30 = ' · auto band: 10th–90th percentile of the last 30 days';

describe('boundsMeaningText — two-argument behaviour is unchanged', () => {
  it('no third arg at all', () => {
    assert.equal(boundsMeaningText('day', null), 'Daily value');
    assert.equal(boundsMeaningText('week', 'kg'), 'Weekly average · kg');
    assert.equal(boundsMeaningText('month', null), 'Monthly average');
  });
});

describe('boundsMeaningText — third argument: auto/ok/finite windowDays appends the suffix', () => {
  it('mode auto, status ok, windowDays 30 -> suffix present, names "30 days"', () => {
    const bounds = { mode: 'auto', status: 'ok', windowDays: 30 };
    const text = boundsMeaningText('day', null, bounds);
    assert.equal(text, 'Daily value' + AUTO_SUFFIX_30);
    assert.match(text, /last 30 days/);
  });

  it('carries a unit AND the auto suffix together', () => {
    const bounds = { mode: 'auto', status: 'ok', windowDays: 30 };
    const text = boundsMeaningText('week', 'kg', bounds);
    assert.equal(text, 'Weekly average · kg' + AUTO_SUFFIX_30);
  });

  it('a different windowDays value is reflected verbatim', () => {
    const bounds = { mode: 'auto', status: 'ok', windowDays: 60 };
    const text = boundsMeaningText('month', null, bounds);
    assert.equal(text, 'Monthly average · auto band: 10th–90th percentile of the last 60 days');
  });
});

describe('boundsMeaningText — no suffix when the bounds model does not qualify', () => {
  it('mode manual -> no suffix, even with status ok and a finite windowDays', () => {
    const bounds = { mode: 'manual', status: 'ok', windowDays: 90 };
    const text = boundsMeaningText('day', null, bounds);
    assert.equal(text, 'Daily value');
    assert.ok(!text.includes('auto band'));
  });

  it('mode auto but status insufficient -> no suffix', () => {
    const bounds = { mode: 'auto', status: 'insufficient', windowDays: 90 };
    const text = boundsMeaningText('day', null, bounds);
    assert.equal(text, 'Daily value');
  });

  it('mode auto but status invalid -> no suffix', () => {
    const bounds = { mode: 'auto', status: 'invalid', windowDays: 90 };
    assert.equal(boundsMeaningText('day', null, bounds), 'Daily value');
  });

  it('garbage bounds values all fall back to the two-argument text, no throw', () => {
    const garbageValues = [
      null,
      undefined,
      'nope',
      42,
      [],
      {}, // missing mode/status/windowDays entirely
      { mode: 'auto', status: 'ok' }, // missing windowDays
      { mode: 'auto', status: 'ok', windowDays: 'thirty' }, // non-finite
      { mode: 'auto', status: 'ok', windowDays: NaN },
      { mode: 'auto', status: 'ok', windowDays: Infinity },
      { mode: 'auto', status: 'ok', windowDays: null },
    ];
    for (const bounds of garbageValues) {
      let text;
      assert.doesNotThrow(() => {
        text = boundsMeaningText('day', 'kg', bounds);
      }, `boundsMeaningText must not throw for bounds=${JSON.stringify(bounds)}`);
      assert.equal(text, 'Daily value · kg', `expected no suffix for bounds=${JSON.stringify(bounds)}`);
    }
  });
});
