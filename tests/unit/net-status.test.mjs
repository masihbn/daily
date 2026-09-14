// Unit tests for js/net-status.js — CONTRACT-5.1.md §2 / §5.
//
// Pure DOM-adjacent logic: renderNetStatus takes an element-like object and
// a boolean and sets its visible/text/attribute state; startNetStatus wires
// that function to online/offline events on an injectable target+nav pair.
// No real DOM, no browser — fakes are hand-rolled objects so this stays a
// pure `node --test` unit file (see the project convention: unit tests have
// zero dependencies).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OFFLINE_TEXT, renderNetStatus, startNetStatus, requestAppVersion } from '../../js/net-status.js';

// A minimal element-like fake: hidden, textContent, setAttribute — matching
// exactly what CONTRACT-5.1.md §2 says renderNetStatus is allowed to touch.
function fakeEl() {
  return {
    hidden: undefined,
    textContent: undefined,
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
  };
}

// A minimal window-like fake target: addEventListener/removeEventListener
// recording listeners by type, plus a way to fire them.
function fakeTarget() {
  const listeners = {};
  return {
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners[type];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
    fire(type) {
      for (const fn of listeners[type] || []) fn();
    },
    listenerCount(type) {
      return (listeners[type] || []).length;
    },
  };
}

describe('OFFLINE_TEXT', () => {
  it('is the exact contract string', () => {
    assert.equal(OFFLINE_TEXT, 'Offline — showing last saved data');
  });
});

describe('renderNetStatus(el, online)', () => {
  it('online: hides the element, clears text, sets data-online="true"', () => {
    const el = fakeEl();
    renderNetStatus(el, true);
    assert.equal(el.hidden, true);
    assert.equal(el.textContent, '');
    assert.equal(el.attrs['data-online'], 'true');
  });

  it('offline: shows the element, sets OFFLINE_TEXT, sets data-online="false"', () => {
    const el = fakeEl();
    renderNetStatus(el, false);
    assert.equal(el.hidden, false);
    assert.equal(el.textContent, OFFLINE_TEXT);
    assert.equal(el.attrs['data-online'], 'false');
  });

  it('null el: no-op, does not throw', () => {
    assert.doesNotThrow(() => renderNetStatus(null, true));
    assert.doesNotThrow(() => renderNetStatus(null, false));
  });

  it('undefined el: no-op, does not throw', () => {
    assert.doesNotThrow(() => renderNetStatus(undefined, false));
  });
});

describe('startNetStatus({ el, target, nav })', () => {
  it('initial state reflects nav.onLine === true (hidden)', () => {
    const el = fakeEl();
    const target = fakeTarget();
    const nav = { onLine: true };
    const handle = startNetStatus({ el, target, nav });
    assert.equal(el.hidden, true);
    assert.equal(el.attrs['data-online'], 'true');
    handle.stop();
  });

  it('initial state reflects nav.onLine === false (visible, OFFLINE_TEXT)', () => {
    const el = fakeEl();
    const target = fakeTarget();
    const nav = { onLine: false };
    const handle = startNetStatus({ el, target, nav });
    assert.equal(el.hidden, false);
    assert.equal(el.textContent, OFFLINE_TEXT);
    assert.equal(el.attrs['data-online'], 'false');
    handle.stop();
  });

  it("reacts to 'offline' then 'online' events", () => {
    const el = fakeEl();
    const target = fakeTarget();
    const nav = { onLine: true };
    const handle = startNetStatus({ el, target, nav });
    assert.equal(el.hidden, true);

    target.fire('offline');
    assert.equal(el.hidden, false);
    assert.equal(el.textContent, OFFLINE_TEXT);
    assert.equal(el.attrs['data-online'], 'false');

    target.fire('online');
    assert.equal(el.hidden, true);
    assert.equal(el.textContent, '');
    assert.equal(el.attrs['data-online'], 'true');

    handle.stop();
  });

  it("stop() removes both listeners — a later event does nothing further", () => {
    const el = fakeEl();
    const target = fakeTarget();
    const nav = { onLine: true };
    const handle = startNetStatus({ el, target, nav });

    handle.stop();
    assert.equal(target.listenerCount('online'), 0);
    assert.equal(target.listenerCount('offline'), 0);

    // Reset state by hand to a sentinel value, then fire — since listeners
    // were removed, nothing should touch the element again.
    el.hidden = 'sentinel';
    el.textContent = 'sentinel';
    target.fire('offline');
    target.fire('online');
    assert.equal(el.hidden, 'sentinel');
    assert.equal(el.textContent, 'sentinel');
  });

  it('never throws with a missing el (still wires/removes listeners cleanly)', () => {
    const target = fakeTarget();
    const nav = { onLine: true };
    let handle;
    assert.doesNotThrow(() => {
      handle = startNetStatus({ el: null, target, nav });
    });
    assert.doesNotThrow(() => target.fire('offline'));
    assert.doesNotThrow(() => target.fire('online'));
    assert.doesNotThrow(() => handle.stop());
  });
});

// A minimal fake `navigator.serviceWorker`-like object: addEventListener/
// removeEventListener recording 'message' listeners, plus a `_fire` helper
// to simulate an incoming message event and a `_listenerCount` helper to
// confirm requestAppVersion cleans up after itself.
function fakeServiceWorkerContainer({ controller } = {}) {
  const listeners = {};
  return {
    controller,
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners[type];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
    _fire(type, event) {
      for (const fn of (listeners[type] || []).slice()) fn(event);
    },
    _listenerCount(type) {
      return (listeners[type] || []).length;
    },
  };
}

describe('requestAppVersion({ nav, timeoutMs })', () => {
  it('resolves null immediately when nav.serviceWorker.controller is missing', async () => {
    const nav = { serviceWorker: fakeServiceWorkerContainer({ controller: undefined }) };
    const result = await requestAppVersion({ nav, timeoutMs: 20 });
    assert.equal(result, null);
  });

  it('resolves null immediately when nav.serviceWorker itself is missing', async () => {
    const nav = {};
    await assert.doesNotReject(requestAppVersion({ nav, timeoutMs: 20 }));
    const result = await requestAppVersion({ nav, timeoutMs: 20 });
    assert.equal(result, null);
  });

  it('posts GET_VERSION to the controller and resolves with the VERSION reply\'s cache, then removes its listener', async () => {
    const postMessageCalls = [];
    const sw = fakeServiceWorkerContainer({ controller: { postMessage: (m) => postMessageCalls.push(m) } });
    const nav = { serviceWorker: sw };

    const pending = requestAppVersion({ nav, timeoutMs: 1000 });
    assert.equal(postMessageCalls.length, 1);
    assert.deepEqual(postMessageCalls[0], { type: 'GET_VERSION' });
    assert.equal(sw._listenerCount('message'), 1);

    sw._fire('message', { data: { type: 'VERSION', cache: 'daily-v39' } });

    const result = await pending;
    assert.equal(result, 'daily-v39');
    assert.equal(sw._listenerCount('message'), 0);
  });

  it('ignores an unrelated message and resolves null after the timeout, never rejecting', async () => {
    const sw = fakeServiceWorkerContainer({ controller: { postMessage: () => {} } });
    const nav = { serviceWorker: sw };

    const pending = requestAppVersion({ nav, timeoutMs: 20 });
    sw._fire('message', { data: { type: 'SOMETHING_ELSE' } });

    const result = await pending;
    assert.equal(result, null);
  });
});
