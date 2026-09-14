// Step 5.1 (CONTRACT-5.1 §2) — a visible "offline" indicator, driven by
// navigator.onLine and the browser's online/offline events. This is a
// different fact from the per-view "you appear to be offline" banners
// (those mean "this particular load failed"); #net-status means "the
// browser currently believes there is no network," which is the condition
// under which the app is serving last-known cached data. Injectable (el /
// target / nav) so the scheduling logic is unit-testable in Node, matching
// the pattern outbox-sync.js already established for renderOutboxStatus.

export const OFFLINE_TEXT = 'Offline — showing last saved data';

// Renders the indicator into `el`. Kept separate from the event wiring
// (startNetStatus) so the render step itself is trivially testable and
// DOM-free at the call site — same split as outbox-sync.js's
// renderOutboxStatus vs. createOutboxSync.
export function renderNetStatus(el, online) {
  if (!el) return;
  try {
    if (online) {
      el.hidden = true;
      el.textContent = '';
      el.setAttribute('data-online', 'true');
    } else {
      el.hidden = false;
      el.textContent = OFFLINE_TEXT;
      el.setAttribute('data-online', 'false');
    }
  } catch {
    // A broken indicator must never take the app down with it.
  }
}

// Wires renderNetStatus to `target`'s online/offline events, seeding the
// initial state from `nav.onLine`. Returns { stop() } so callers (and
// tests) can tear the listeners down cleanly.
export function startNetStatus({ el, target = window, nav = navigator } = {}) {
  const handleOnline = () => renderNetStatus(el, true);
  const handleOffline = () => renderNetStatus(el, false);

  renderNetStatus(el, !!(nav && nav.onLine));

  if (target && typeof target.addEventListener === 'function') {
    target.addEventListener('online', handleOnline);
    target.addEventListener('offline', handleOffline);
  }

  function stop() {
    if (target && typeof target.removeEventListener === 'function') {
      target.removeEventListener('online', handleOnline);
      target.removeEventListener('offline', handleOffline);
    }
  }

  return { stop };
}

// Step 5.1 addition (device verification of the update path, added after
// the initial contract): asks the currently-controlling service worker
// which CACHE it is running (sw.js's `message` handler for
// `{type: 'GET_VERSION'}`), so Settings can display it as a
// human-checkable confirmation that a deploy's new worker actually took
// over — rather than eyeballing whether anything visibly changed. This
// module is where it lives because it is "platform status" in the same
// sense as online/offline, not app data — same reasoning as net-status
// above.
//
// Never rejects: no controller (no SW support, or the very first load
// before one has taken control) resolves null immediately; a controller
// that never answers (an old/broken worker with no GET_VERSION handler)
// resolves null after `timeoutMs`. Lazy default on `nav` so importing this
// module in Node with no `navigator` still works, same as startNetStatus.
export function requestAppVersion({ nav = navigator, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const sw = nav && nav.serviceWorker;
    const controller = sw && sw.controller;
    if (!sw || !controller) {
      resolve(null);
      return;
    }

    let settled = false;
    let timer = null;

    function finish(value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      sw.removeEventListener('message', handleMessage);
      resolve(value);
    }

    function handleMessage(event) {
      if (event && event.data && event.data.type === 'VERSION') {
        finish(typeof event.data.cache === 'string' ? event.data.cache : null);
      }
    }

    sw.addEventListener('message', handleMessage);
    timer = setTimeout(() => finish(null), timeoutMs);

    try {
      controller.postMessage({ type: 'GET_VERSION' });
    } catch {
      // A controller that can't be posted to (e.g. torn down mid-call) is
      // equivalent to "no answer" — resolve null rather than reject.
      finish(null);
    }
  });
}
