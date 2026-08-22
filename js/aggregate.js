// Pure rollup/normalization/bound math. PURE MODULE: no DOM, no fetch, no
// localStorage — the only allowed import is ./dates.js. That purity is
// what lets this run in Node against exact fixtures and is where the
// subtle bugs (average vs. sum, min/max vs. percentile, boolean vs.
// cumulative vs. state relog) actually live.
//
// An "entry" throughout this file is a row shaped like
// { trackable_id, entry_date: 'YYYY-MM-DD', value: number, note }. Extra
// properties are ignored.

import { isoWeekKey, addDays } from './dates.js';

function isFiniteValue(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function bucketKeyFor(entryDate, period) {
  if (period === 'day') return entryDate;
  if (period === 'week') return isoWeekKey(entryDate);
  if (period === 'month') return entryDate.slice(0, 7);
  throw new RangeError(`rollup: unknown period, got: ${JSON.stringify(period)}`);
}

// rollup() deliberately ignores trackable_id and rolls up EVERY entry it is
// given, mixed together — filtering to one trackable (or a comparison set)
// is the caller's job, done before calling this.
export function rollup(entries, period, aggregation) {
  // Validate up front (even on empty input) so a typo'd period/aggregation
  // fails loudly instead of silently returning [].
  if (period !== 'day' && period !== 'week' && period !== 'month') {
    throw new RangeError(`rollup: unknown period, got: ${JSON.stringify(period)}`);
  }
  if (aggregation !== 'sum' && aggregation !== 'count' && aggregation !== 'average' && aggregation !== 'last') {
    throw new RangeError(`rollup: unknown aggregation, got: ${JSON.stringify(aggregation)}`);
  }

  const buckets = new Map();

  for (const entry of entries) {
    if (!entry || !isFiniteValue(entry.value)) continue; // invalid values are ignored entirely

    const key = bucketKeyFor(entry.entry_date, period);
    let b = buckets.get(key);
    if (!b) {
      b = { sum: 0, entryCount: 0, days: new Set(), lastValue: undefined, lastDate: undefined };
      buckets.set(key, b);
    }

    b.sum += entry.value;
    b.entryCount += 1; // every entry that landed in this bucket, for the output `count` field
    b.days.add(entry.entry_date); // distinct logged days, for 'count'/'average' aggregation

    // 'last' semantics: latest entry_date wins; ties go to whichever
    // appears later in the input array. Since we iterate the input in
    // order, ">=" always lets a same-date entry overwrite the previous
    // one, which is exactly "later in the array wins".
    if (b.lastDate === undefined || entry.entry_date >= b.lastDate) {
      b.lastValue = entry.value;
      b.lastDate = entry.entry_date;
    }
  }

  const result = [];
  for (const [key, b] of buckets) {
    let value;
    if (aggregation === 'sum') {
      value = b.sum;
    } else if (aggregation === 'count') {
      // Number of DAYS with an entry, not the sum of values — this is what
      // makes "gym sessions per week" work, and is easy to conflate with
      // 'sum'.
      value = b.days.size;
    } else if (aggregation === 'average') {
      // Sum divided by the number of days an entry was logged, never by 7
      // or by the number of days in the period. Two calorie logs in a
      // 7-day week average those two days, not a starvation week.
      value = b.sum / b.days.size;
    } else {
      value = b.lastValue;
    }
    result.push({ key, value, count: b.entryCount });
  }

  result.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return result;
}

export function fillSeries(buckets, keys, fillValue = 0) {
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  return keys.map((key) => {
    const existing = byKey.get(key);
    if (existing) {
      return { key, value: existing.value, count: existing.count };
    }
    return { key, value: fillValue, count: 0 };
  });
}

export function normalizeSeries(values) {
  const finite = values.filter(isFiniteValue);
  if (finite.length === 0) {
    return values.map(() => null);
  }

  const min = Math.min(...finite);
  const max = Math.max(...finite);

  if (min === max) {
    // Degenerate case: a single point or a perfectly flat series. The
    // naive (v - min) / (max - min) formula divides by zero here — return
    // a constant mid-line instead of NaN.
    return values.map((v) => (isFiniteValue(v) ? 50 : null));
  }

  return values.map((v) => (isFiniteValue(v) ? ((v - min) / (max - min)) * 100 : null));
}

// Percentile method pinned to "R-7" / Excel PERCENTILE.INC: sort
// ascending, idx = p * (n - 1); exact index returns that element,
// otherwise linearly interpolate between the elements on either side.
function percentileInc(sortedAsc, p) {
  const n = sortedAsc.length;
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[idx];
  const frac = idx - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

export function deriveBounds(entries, windowDays, method = 'percentile', options = {}) {
  if (method !== 'percentile' && method !== 'minmax') {
    throw new RangeError(`deriveBounds: unknown method, got: ${JSON.stringify(method)}`);
  }

  const list = Array.isArray(entries) ? entries : [];

  let asOf = options.asOf;
  if (asOf === undefined) {
    // Default to the latest entry_date present in `entries`, NOT the real
    // current date — that is what keeps this function pure/deterministic.
    const dated = list.filter((e) => e && typeof e.entry_date === 'string');
    if (dated.length === 0) {
      return { lower: null, upper: null };
    }
    asOf = dated.reduce((max, e) => (e.entry_date > max ? e.entry_date : max), dated[0].entry_date);
  }

  const windowStart = addDays(asOf, -(windowDays - 1));

  const values = list
    .filter(
      (e) =>
        e &&
        typeof e.entry_date === 'string' &&
        e.entry_date >= windowStart &&
        e.entry_date <= asOf &&
        isFiniteValue(e.value)
    )
    .map((e) => e.value);

  // A band derived from a single reading (or none) is noise — the same
  // reasoning that rejected raw min/max in favor of percentiles in the
  // first place. Fewer than 2 finite values in the window returns nulls.
  if (values.length < 2) {
    return { lower: null, upper: null };
  }

  const sorted = [...values].sort((a, b) => a - b);

  if (method === 'minmax') {
    return { lower: sorted[0], upper: sorted[sorted.length - 1] };
  }

  return { lower: percentileInc(sorted, 0.1), upper: percentileInc(sorted, 0.9) };
}

export function applyRelog(existingValue, newValue, trackable) {
  if (!trackable || typeof trackable !== 'object') {
    throw new RangeError(`applyRelog: trackable must be an object, got: ${JSON.stringify(trackable)}`);
  }

  if (trackable.value_shape === 'boolean') {
    // Logging a boolean habit a second time keeps it "done" — always 1,
    // idempotently, regardless of existingValue/newValue (newValue may be
    // omitted entirely). There is deliberately no un-toggle path here:
    // clearing a boolean day is a DELETE (api.deleteEntry), never
    // applyRelog(..., 0). Do not add one.
    return 1;
  }

  if (trackable.value_shape === 'numeric') {
    if (!isFiniteValue(newValue)) {
      throw new RangeError(`applyRelog: newValue must be a finite number for a numeric trackable, got: ${JSON.stringify(newValue)}`);
    }
    if (trackable.relog_semantic === 'cumulative') {
      // e.g. calories: a second log of 500 adds to the day's running total.
      const base = isFiniteValue(existingValue) ? existingValue : 0;
      return base + newValue;
    }
    if (trackable.relog_semantic === 'state') {
      // e.g. weight: a corrected reading replaces whatever was there.
      return newValue;
    }
    throw new RangeError(`applyRelog: unknown relog_semantic, got: ${JSON.stringify(trackable.relog_semantic)}`);
  }

  throw new RangeError(`applyRelog: unknown value_shape, got: ${JSON.stringify(trackable.value_shape)}`);
}
