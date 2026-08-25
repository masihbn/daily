// Step D.6 — makes queued offline writes actually reach the server, and
// makes an unsent write visible from anywhere in the app.
//
// THE DEFECT THIS FIXES. Before this module, store.flushOutbox() had exactly
// one caller: js/views/home.js, on Home's mount. So a write queued while
// offline was only ever retried if the user happened to navigate to Home.
// The realistic losing sequence, on a phone, is:
//
//   1. Log a value from the calendar day-editor on a detail screen, in a
//      tunnel. The write is queued and persisted to localStorage.
//   2. iOS evicts the backgrounded PWA from memory (it does this freely).
//   3. The user reopens the app. A standalone PWA relaunches at its LAST
//      hash — a detail route, not Home.
//   4. Nothing ever calls flushOutbox(). The entry sits in localStorage
//      indefinitely, while the UI shows it as a normal logged value.
//
// Three months of daily logging is precisely the situation where a silently
// dropped write matters, because by the time it is noticed the context for
// reconstructing it is gone.
//
// DESIGN. Everything is injected — no module-level reference to `window`,
// `navigator` or `document`. That is what lets the trigger logic be tested
// in Node, which is where the plan wants coverage concentrated, rather than
// only through a browser that cannot easily simulate a flaky connection.

export const SYNC_EVENTS = ['online', 'visibilitychange', 'pageshow', 'focus'];

// Why four triggers rather than just 'online':
//
//   online           — the obvious one, but iOS Safari is unreliable about
//                      firing it, and `navigator.onLine` is famously
//                      optimistic (it reports true for a captive portal or
//                      a connected-but-dead wifi).
//   visibilitychange — the workhorse. Covers unlock-and-return, app switcher,
//                      and the common "reopen the PWA later" case.
//   pageshow         — fires on restore from the back/forward cache, where
//                      visibilitychange does not.
//   focus            — cheap belt-and-braces for desktop/tab switching.
//
// They overlap heavily and will often fire together. That is fine and
// intended: store.flushOutbox() serializes concurrent calls, and a flush
// with an empty outbox is a no-op that issues no network request at all.
// Reliability here is worth more than tidiness — a missed flush costs the
// user data, a redundant one costs nothing.

export function createOutboxSync({ store, target, doc, onChange } = {}) {
  if (!store) throw new TypeError('createOutboxSync requires a store');

  let started = false;
  let disposed = false;
  let unsubscribe = null;
  const handlers = new Map();

  function pendingCount() {
    try {
      return store.getOutbox().length;
    } catch {
      // getOutbox() reads hydrated state; if it ever throws, a broken
      // indicator must not take the whole app down with it.
      return 0;
    }
  }

  function notify() {
    if (typeof onChange === 'function') {
      try {
        onChange(pendingCount());
      } catch {
        // A listener that throws must not break syncing. The indicator is
        // an aid; the flush is the job.
      }
    }
  }

  // `reason` is passed through to onChange callers for diagnosis only; it
  // deliberately does not affect behaviour, so there is no branch here that
  // could make one trigger less reliable than another.
  async function flushNow() {
    if (disposed) return { sent: 0, failed: 0, remaining: 0, skipped: true };

    // Deliberately NOT gated on navigator.onLine. That property reports
    // true for a captive portal and for a connected-but-dead network, and
    // reports false in situations where a request would actually succeed.
    // Attempting the flush and letting it fail is strictly more accurate
    // than asking the browser to guess — and a failed attempt just leaves
    // the op queued, which is where it already was.
    let result;
    try {
      result = await store.flushOutbox();
    } catch {
      // store.flushOutbox() is documented not to reject, but a sync loop
      // that can die on an unexpected throw is exactly the thing that goes
      // unnoticed for three months.
      result = { sent: 0, failed: 0, remaining: pendingCount() };
    }
    notify();
    return result;
  }

  function shouldFlushFor(eventType) {
    // visibilitychange fires on hide as well as show. Flushing as the app
    // goes to the background is pointless (iOS may suspend the process
    // mid-request) and would double every foreground flush.
    if (eventType === 'visibilitychange') {
      return !doc || doc.visibilityState !== 'hidden';
    }
    return true;
  }

  function start() {
    if (started || disposed) return;
    started = true;

    if (target && typeof target.addEventListener === 'function') {
      for (const type of SYNC_EVENTS) {
        const handler = () => {
          if (shouldFlushFor(type)) flushNow();
        };
        handlers.set(type, handler);
        target.addEventListener(type, handler);
      }
    }

    // Update the indicator the moment a write is queued, not only when a
    // sync event happens to fire. Without this, logging offline shows no
    // sign that anything is pending until the next foreground/online event.
    if (typeof store.onOutboxChange === 'function') {
      unsubscribe = store.onOutboxChange(() => notify());
    }

    // Flush once at startup regardless of route. This is the case the old
    // Home-only call site missed entirely: a PWA relaunched straight to a
    // detail route.
    notify();
    flushNow();
  }

  function stop() {
    if (target && typeof target.removeEventListener === 'function') {
      for (const [type, handler] of handlers) {
        target.removeEventListener(type, handler);
      }
    }
    handlers.clear();
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    started = false;
    disposed = true;
  }

  return { start, stop, flushNow, pendingCount, notify };
}

// Renders the global "unsent" indicator. Kept separate from the sync so the
// scheduling logic stays DOM-free and unit-testable.
//
// Visible from EVERY route, which is the point: the per-row pending state in
// js/views/home.js only tells the user about a stuck write if they are on
// Home looking at that row.
export function renderOutboxStatus(el, count) {
  if (!el) return;
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  el.setAttribute('data-count', String(n));
  if (n === 0) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  // Plain, honest wording. Not "syncing…", which implies progress is being
  // made and would be a lie while the phone has no signal.
  el.textContent = n === 1 ? '1 log not yet saved' : `${n} logs not yet saved`;
}
