// Unit tests for js/charts/bounds.js's `roundBound()` and its wiring into
// `boundsFor()`'s auto branch (orchestrator decision, device feedback,
// 2026-09-14): auto-derived bounds are now rounded for display —
// non-finite values pass through unchanged, |v| >= 100 rounds to the
// nearest whole number, otherwise to one decimal place. Manual bounds are
// untouched (they are whatever the user configured, not a derived
// percentile). The implementation is being written in parallel and has
// NOT been read while writing this file — expectations below are derived
// from the orchestrator's spec message, and the fractional-rounding edge
// cases are verified against Node's actual Math.round semantics rather
// than hand-computed, per that same message's instruction.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { roundBound, boundsFor, MIN_BOUND_READINGS, DEFAULT_ROLLING_WINDOW_DAYS } from '../../js/charts/bounds.js';
import { deriveBounds } from '../../js/aggregate.js';
import { addDays } from '../../js/dates.js';

// Local reference implementation, exactly as specified by the
// orchestrator, used only to compute expected values for the boundsFor()
// integration cases below (kcal/kg fixtures) — NOT used to test
// roundBound() itself, which is asserted against literal expected numbers
// so a wrong reference copy here can't mask a wrong implementation there.
function referenceRoundBound(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  if (Math.abs(v) >= 100) return Math.round(v);
  return Math.round(v * 10) / 10;
}

const TODAY = '2026-09-14';

// ===========================================================================
// roundBound()
// ===========================================================================

describe('roundBound', () => {
  it('|v| >= 100 rounds to the nearest whole number', () => {
    assert.equal(roundBound(3180.04), 3180);
    assert.equal(roundBound(1644.2), 1644);
    assert.equal(roundBound(100), 100);
    assert.equal(roundBound(100.5), 101);
  });

  it('|v| < 100 rounds to one decimal place', () => {
    assert.equal(roundBound(99.96), 100); // crosses the 1-decimal boundary up to a whole number
    assert.equal(roundBound(80.44), 80.4);
    // Verified against Node's actual Math.round: 80.45 * 10 === 804.5
    // exactly in IEEE754 here, and Math.round ties toward +Infinity, so
    // this rounds UP to 80.5 — not down — on this engine. Asserting the
    // literal reference-implementation result (not a hand-picked "80.4 or
    // 80.5") is what the orchestrator's brief asked for.
    assert.equal(roundBound(80.45), referenceRoundBound(80.45));
    assert.equal(roundBound(80.45), 80.5);
  });

  it('negative values round the same way, symmetrically through Math.round (not away-from-zero)', () => {
    assert.equal(roundBound(-3180.04), -3180);
    assert.equal(roundBound(-100), -100);
    // Math.round(-804.5) === -804 (ties toward +Infinity means toward
    // -804, not -805) -> /10 = -80.4, mirroring the positive 80.45 case
    // landing on 80.5 rather than 80.4.
    assert.equal(roundBound(-80.45), referenceRoundBound(-80.45));
    assert.equal(roundBound(-80.45), -80.4);
    assert.equal(roundBound(-99.96), -100);
  });

  it('non-finite values pass through unchanged', () => {
    assert.equal(roundBound(NaN), roundBound(NaN)); // NaN !== NaN by ===, so compare shape not value
    assert.ok(Number.isNaN(roundBound(NaN)));
    assert.equal(roundBound(Infinity), Infinity);
    assert.equal(roundBound(-Infinity), -Infinity);
  });

  it('non-number values (null/undefined/strings) pass through unchanged', () => {
    assert.equal(roundBound(null), null);
    assert.equal(roundBound(undefined), undefined);
    assert.equal(roundBound('80.45'), '80.45');
  });
});

// ===========================================================================
// boundsFor() — auto branch returns roundBound(derived.lower/upper);
// manual branch is untouched
// ===========================================================================

describe('boundsFor — auto bounds are rounded, manual bounds are exact', () => {
  it('a kcal-scale fixture (values > 100, fractional percentiles): resolved bounds equal roundBound(deriveBounds(...))', () => {
    const trackable = {
      value_shape: 'numeric',
      bounds_enabled: true,
      bounds_mode: 'auto',
      bound_lower: null,
      bound_upper: null,
    };
    // 20 distinct daily readings, fractional and > 100, well above
    // MIN_BOUND_READINGS, so deriveBounds's 10th/90th percentile
    // interpolation is genuinely fractional before rounding.
    const entries = [];
    for (let i = 0; i < 20; i++) {
      entries.push({
        trackable_id: 1,
        entry_date: addDays(TODAY, -i),
        value: 1500 + i * 13.7,
      });
    }
    assert.ok(entries.length >= MIN_BOUND_READINGS);

    const result = boundsFor(trackable, entries, DEFAULT_ROLLING_WINDOW_DAYS);
    assert.equal(result.status, 'ok');
    assert.equal(result.mode, 'auto');

    const raw = deriveBounds(entries, DEFAULT_ROLLING_WINDOW_DAYS);
    // Sanity: this fixture must actually exercise the >= 100 / fractional
    // rounding path, or the case would pass vacuously.
    assert.ok(Math.abs(raw.lower) >= 100 && !Number.isInteger(raw.lower));

    assert.equal(result.lower, roundBound(raw.lower));
    assert.equal(result.upper, roundBound(raw.upper));
  });

  it('a kg-scale fixture (values < 100, sub-decimal spread): resolved bounds equal roundBound(deriveBounds(...))', () => {
    const trackable = {
      value_shape: 'numeric',
      bounds_enabled: true,
      bounds_mode: 'auto',
      bound_lower: null,
      bound_upper: null,
    };
    const entries = [];
    for (let i = 0; i < 20; i++) {
      entries.push({
        trackable_id: 2,
        entry_date: addDays(TODAY, -i),
        value: 70 + i * 0.37,
      });
    }
    assert.ok(entries.length >= MIN_BOUND_READINGS);

    const result = boundsFor(trackable, entries, DEFAULT_ROLLING_WINDOW_DAYS);
    assert.equal(result.status, 'ok');
    assert.equal(result.mode, 'auto');

    const raw = deriveBounds(entries, DEFAULT_ROLLING_WINDOW_DAYS);
    // Sanity: this fixture must actually exercise the < 100 /
    // one-decimal rounding path.
    assert.ok(Math.abs(raw.lower) < 100);

    assert.equal(result.lower, roundBound(raw.lower));
    assert.equal(result.upper, roundBound(raw.upper));
  });

  it('manual bounds are returned EXACTLY as stored — never rounded', () => {
    const trackable = {
      value_shape: 'numeric',
      bounds_enabled: true,
      bounds_mode: 'manual',
      bound_lower: 78.25,
      bound_upper: 85.75,
    };
    const result = boundsFor(trackable, [], DEFAULT_ROLLING_WINDOW_DAYS);
    assert.equal(result.status, 'ok');
    assert.equal(result.mode, 'manual');
    assert.equal(result.lower, 78.25);
    assert.equal(result.upper, 85.75);
  });

  it('manual bounds well above 100 are also returned exactly, unrounded', () => {
    const trackable = {
      value_shape: 'numeric',
      bounds_enabled: true,
      bounds_mode: 'manual',
      bound_lower: 1700.33,
      bound_upper: 2100.67,
    };
    const result = boundsFor(trackable, [], DEFAULT_ROLLING_WINDOW_DAYS);
    assert.equal(result.lower, 1700.33);
    assert.equal(result.upper, 2100.67);
  });
});
