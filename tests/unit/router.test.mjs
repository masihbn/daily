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
