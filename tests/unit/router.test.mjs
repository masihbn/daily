// Tests for js/router.js — a pure hash-parsing function, no DOM, no network.
// This is a CONTRACT test: the implementation is being written in parallel
// by another agent, so every assertion here is against the documented
// input->output table in the Step 0.3 spec, not against any particular
// internal approach (regex vs. split vs. URL parsing, etc).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash } from '../../js/router.js';

describe('parseHash — named static routes', () => {
  it("'' -> home", () => {
    assert.deepEqual(parseHash(''), { name: 'home', params: {} });
  });

  it("'#' -> home", () => {
    assert.deepEqual(parseHash('#'), { name: 'home', params: {} });
  });

  it("'#/' -> home", () => {
    assert.deepEqual(parseHash('#/'), { name: 'home', params: {} });
  });

  it("'#/new' -> new", () => {
    assert.deepEqual(parseHash('#/new'), { name: 'new', params: {} });
  });

  it("'#/compare' -> compare", () => {
    assert.deepEqual(parseHash('#/compare'), { name: 'compare', params: {} });
  });

  it("'#/settings' -> settings", () => {
    assert.deepEqual(parseHash('#/settings'), { name: 'settings', params: {} });
  });
});

describe('parseHash — detail route and id handling', () => {
  it("'#/t/5' -> detail, id '5' as a STRING (not coerced to number)", () => {
    const result = parseHash('#/t/5');
    assert.equal(result.name, 'detail');
    assert.equal(typeof result.params.id, 'string');
    assert.equal(result.params.id, '5');
    assert.notEqual(result.params.id, 5); // guards against == coercion masking a bug
  });

  it("'#/t/abc' -> detail, id 'abc'", () => {
    const result = parseHash('#/t/abc');
    assert.equal(result.name, 'detail');
    assert.equal(typeof result.params.id, 'string');
    assert.equal(result.params.id, 'abc');
  });
});

describe('parseHash — trailing slash equivalence', () => {
  it("'#/settings/' -> settings (static route)", () => {
    assert.deepEqual(parseHash('#/settings/'), { name: 'settings', params: {} });
  });

  it("'#/t/5/' -> detail, id '5' (detail route)", () => {
    const result = parseHash('#/t/5/');
    assert.equal(result.name, 'detail');
    assert.equal(result.params.id, '5');
  });
});

describe('parseHash — detail requires an id', () => {
  it("'#/t' -> notfound, not detail with an empty id", () => {
    const result = parseHash('#/t');
    assert.equal(result.name, 'notfound');
  });

  it("'#/t/' -> notfound, not detail with an empty id", () => {
    const result = parseHash('#/t/');
    assert.equal(result.name, 'notfound');
  });

  it("'#/t/5/extra' -> notfound (too many segments)", () => {
    const result = parseHash('#/t/5/extra');
    assert.equal(result.name, 'notfound');
  });
});

describe('parseHash — edit route (CONTRACT-2.2.md §2, added for Step 2.2)', () => {
  // segments.length === 3 && segments[0] === 't' && segments[2] === 'edit'
  // -> { name: 'edit', params: { id } }, id percent-decoded exactly the way
  // the existing detail route decodes it. Every fixture from CONTRACT-2.2.md
  // §2 is asserted exactly below.

  it("'#/t/5/edit' -> {name:'edit', params:{id:'5'}}", () => {
    assert.deepEqual(parseHash('#/t/5/edit'), { name: 'edit', params: { id: '5' } });
  });

  it("'#/t/5/edit/' -> {name:'edit', params:{id:'5'}} (trailing slash)", () => {
    assert.deepEqual(parseHash('#/t/5/edit/'), { name: 'edit', params: { id: '5' } });
  });

  it("'#/t/abc/edit' -> {name:'edit', params:{id:'abc'}}", () => {
    assert.deepEqual(parseHash('#/t/abc/edit'), { name: 'edit', params: { id: 'abc' } });
  });

  it("'#/t/5%2F6/edit' -> {name:'edit', params:{id:'5/6'}} (percent-decoded)", () => {
    assert.deepEqual(parseHash('#/t/5%2F6/edit'), { name: 'edit', params: { id: '5/6' } });
  });

  it("'#/t/5/extra' -> {name:'notfound', params:{}} — MUST SURVIVE from Step 2.1: only the literal third segment 'edit' matches the new route, 'extra' does not", () => {
    assert.deepEqual(parseHash('#/t/5/extra'), { name: 'notfound', params: {} });
  });

  it("'#/t//edit' -> {name:'notfound', params:{}} (empty id)", () => {
    assert.deepEqual(parseHash('#/t//edit'), { name: 'notfound', params: {} });
  });

  it("'#/t/5/edit/extra' -> {name:'notfound', params:{}} (too many segments)", () => {
    assert.deepEqual(parseHash('#/t/5/edit/extra'), { name: 'notfound', params: {} });
  });

  it("'#/t/%E0%A4%A/edit' -> {name:'notfound', params:{}} (malformed escape, must not throw)", () => {
    assert.doesNotThrow(() => parseHash('#/t/%E0%A4%A/edit'));
    assert.deepEqual(parseHash('#/t/%E0%A4%A/edit'), { name: 'notfound', params: {} });
  });

  it("'#/edit' -> {name:'notfound', params:{}} (single segment 'edit' is not a known static route)", () => {
    assert.deepEqual(parseHash('#/edit'), { name: 'notfound', params: {} });
  });

  it('params.id stays a STRING for the edit route, never coerced to a number', () => {
    const result = parseHash('#/t/5/edit');
    assert.equal(typeof result.params.id, 'string');
    assert.equal(result.params.id, '5');
    assert.notEqual(result.params.id, 5); // guards against == coercion masking a bug
  });
});

describe('parseHash — percent-decoding', () => {
  it("'#/t/a%20b' -> detail, id 'a b' (decoded)", () => {
    const result = parseHash('#/t/a%20b');
    assert.equal(result.name, 'detail');
    assert.equal(result.params.id, 'a b');
  });

  it("'#/t/%zz' (malformed escape) -> notfound, and does not throw", () => {
    assert.doesNotThrow(() => parseHash('#/t/%zz'));
    const result = parseHash('#/t/%zz');
    assert.equal(result.name, 'notfound');
  });
});

describe('parseHash — case sensitivity', () => {
  it("'#/Settings' -> notfound", () => {
    assert.equal(parseHash('#/Settings').name, 'notfound');
  });

  it("'#/HOME' -> notfound", () => {
    assert.equal(parseHash('#/HOME').name, 'notfound');
  });
});

describe('parseHash — unknown routes', () => {
  it("'#/nope' -> notfound", () => {
    assert.equal(parseHash('#/nope').name, 'notfound');
  });

  it("'#/t/5/6/7' -> notfound", () => {
    assert.equal(parseHash('#/t/5/6/7').name, 'notfound');
  });

  it("'#garbage' -> notfound", () => {
    assert.equal(parseHash('#garbage').name, 'notfound');
  });

  it("'/settings' (no leading '#') -> notfound", () => {
    assert.equal(parseHash('/settings').name, 'notfound');
  });
});

describe('parseHash — non-string input must never throw and must return notfound', () => {
  const nonStringInputs = [
    ['null', null],
    ['undefined', undefined],
    ['0', 0],
    ['42', 42],
    ['true', true],
    ['{}', {}],
    ['[]', []],
    ["['#/']", ['#/']],
  ];

  for (const [label, input] of nonStringInputs) {
    it(`${label} -> notfound, does not throw`, () => {
      let result;
      assert.doesNotThrow(() => {
        result = parseHash(input);
      });
      assert.equal(result.name, 'notfound');
      assert.deepEqual(result.params, {});
    });
  }
});

describe('parseHash — the fullscreen chart route (CONTRACT-U.4.md §1, added for Step U.4)', () => {
  // segments.length === 4 && segments[0] === 't' && segments[2] === 'chart'
  // -> { name: 'chart', params: { id, kind } } where kind is EXACTLY 'trend'
  // or 'range' (no other value, no case-insensitivity). id is percent-
  // decoded exactly the way the existing detail/edit routes decode it.
  // Every fixture from CONTRACT-U.4.md §9's R-C1..R-C8 is asserted below.

  it("R-C1 — '#/t/5/chart/trend' -> {name:'chart', params:{id:'5', kind:'trend'}}", () => {
    assert.deepEqual(parseHash('#/t/5/chart/trend'), { name: 'chart', params: { id: '5', kind: 'trend' } });
  });

  it("R-C2 — '#/t/5/chart/range' -> {name:'chart', params:{id:'5', kind:'range'}}", () => {
    assert.deepEqual(parseHash('#/t/5/chart/range'), { name: 'chart', params: { id: '5', kind: 'range' } });
  });

  it("R-C3 — an unknown kind ('nope') -> notfound", () => {
    assert.deepEqual(parseHash('#/t/5/chart/nope'), { name: 'notfound', params: {} });
  });

  it("R-C3 — a wrong-case kind ('Trend') -> notfound (kind is an exact-string match, not case-insensitive)", () => {
    assert.deepEqual(parseHash('#/t/5/chart/Trend'), { name: 'notfound', params: {} });
  });

  it("R-C3 — an empty kind -> notfound. Reached via a doubled trailing slash ('#/t/5/chart//'): the router's single generic trailing-slash strip (shared by every route, see the '#/settings/'/'#/t/5/' cases above) removes exactly ONE trailing '/', turning '/t/5/chart//' into '/t/5/chart/' — which still splits into FOUR segments ['t','5','chart',''], the last one empty. A single trailing slash ('#/t/5/chart/trend/', see R-C5) is the trailing-slash-EQUIVALENCE case; this is deliberately the one-slash-further edge that actually produces kind === ''.", () => {
    assert.deepEqual(parseHash('#/t/5/chart//'), { name: 'notfound', params: {} });
  });

  it("R-C4 — an empty id ('#/t//chart/trend') -> notfound", () => {
    assert.deepEqual(parseHash('#/t//chart/trend'), { name: 'notfound', params: {} });
  });

  it("R-C5 — a trailing slash is tolerated: '#/t/5/chart/trend/' -> same as without it", () => {
    assert.deepEqual(parseHash('#/t/5/chart/trend/'), { name: 'chart', params: { id: '5', kind: 'trend' } });
  });

  it("R-C6 — '#/t/a%20b/chart/range' -> id 'a b' (percent-decoded), kind 'range'", () => {
    assert.deepEqual(parseHash('#/t/a%20b/chart/range'), { name: 'chart', params: { id: 'a b', kind: 'range' } });
  });

  it("R-C7 — five segments ('#/t/5/chart/trend/extra') -> notfound", () => {
    assert.deepEqual(parseHash('#/t/5/chart/trend/extra'), { name: 'notfound', params: {} });
  });

  it('R-C8 — the returned params object is fresh: mutating one call\'s result does not affect a later call', () => {
    const a = parseHash('#/t/5/chart/trend');
    a.name = 'mutated';
    a.params.id = 'mutated';
    a.params.kind = 'mutated';
    const b = parseHash('#/t/5/chart/trend');
    assert.deepEqual(b, { name: 'chart', params: { id: '5', kind: 'trend' } });

    // Same reference guarantee already established for the other routes
    // above (parseHash — fresh object guarantee): two calls never share an
    // object or a params object.
    const c = parseHash('#/t/5/chart/trend');
    assert.notEqual(b, c);
    assert.notEqual(b.params, c.params);
  });
});

describe('parseHash — fresh object guarantee', () => {
  it('two calls with the same input do not return the same object reference', () => {
    const a = parseHash('#/');
    const b = parseHash('#/');
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });

  it('mutating the result of one call does not affect a later call', () => {
    const a = parseHash('#/t/5');
    a.name = 'mutated';
    a.params.id = 'mutated';
    const b = parseHash('#/t/5');
    assert.equal(b.name, 'detail');
    assert.equal(b.params.id, '5');
  });

  it('the params object itself is also fresh across calls', () => {
    const a = parseHash('#/t/5');
    const b = parseHash('#/t/5');
    assert.notEqual(a.params, b.params);
  });
});
