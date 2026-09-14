// Step 5.2 (CONTRACT-5.2 §2) — local app-lock screen. Rendered by
// js/main.js's render() in place of the current route's view whenever the
// signed-in gate finds a lock enabled and this session not yet unlocked
// (see main.js §3, and js/applock.js's header for exactly what this lock
// does and does not protect — read that before changing behaviour here).
//
// Same view lifecycle discipline as every other view in js/views/ (see
// js/views/signin.js's own header): idempotent mount, synchronous unmount,
// exactly one delegated listener per event type on the root, `disposed`
// checked after every await, and no exception may ever escape a handler.
//
// `storage`/`session`/`nav` are accepted for injection (tests can pass
// fakes) but are left undefined by main.js's real call site — unlock()/
// disableLock() in js/applock.js resolve their own real-browser defaults
// (localStorage/sessionStorage/navigator) when these are omitted, the same
// way every other production call site of those functions works.

import { getAuth } from '../auth.js';
import { getStore } from '../store.js';
import { unlock, disableLock } from '../applock.js';

const ERROR_CANCELLED = 'Unlock was cancelled.';
const ERROR_UNSUPPORTED = 'Face ID is not available in this browser. Sign out to continue.';
const ERROR_GENERIC = 'Could not unlock. Try again.';

export function createLockView({ auth, store, storage, session, nav, onUnlocked } = {}) {
  const au = auth || getAuth();
  const st = store || getStore();

  let container = null;
  let sectionEl = null;
  let unlockBtn = null;
  let errorP = null;
  let disposed = true;

  // 'idle' | 'busy' | 'error' — mirrored onto section[data-state].
  let state = 'idle';
  let errorMessage = '';
  // Set once a real unlock() attempt reports 'unsupported' (CONTRACT-5.2
  // §2) — the Unlock button stays disabled for the rest of this mount,
  // since nothing the user can do here changes the browser's WebAuthn
  // support mid-session.
  let unsupported = false;

  // Built once per mounted instance, same reasoning as js/views/signin.js's
  // buildForm() — nothing here holds live user input, but rebuilding on
  // every render would still be wasted work and would fight ensureSection's
  // "attach listeners once" contract.
  function buildSection(el) {
    const section = document.createElement('section');
    section.className = 'lock';

    const title = document.createElement('h2');
    title.className = 'lock-title';
    title.textContent = 'Daily is locked';
    section.appendChild(title);

    const help = document.createElement('p');
    help.className = 'lock-help';
    help.textContent = 'Unlock with Face ID, Touch ID or your device passcode.';
    section.appendChild(help);

    unlockBtn = document.createElement('button');
    unlockBtn.type = 'button';
    unlockBtn.className = 'lock-unlock';
    unlockBtn.textContent = 'Unlock';
    section.appendChild(unlockBtn);

    errorP = document.createElement('p');
    errorP.className = 'lock-error';
    errorP.setAttribute('role', 'alert');
    errorP.hidden = true;
    section.appendChild(errorP);

    const altP = document.createElement('p');
    altP.className = 'lock-alt';
    const signoutBtn = document.createElement('button');
    signoutBtn.type = 'button';
    signoutBtn.className = 'lock-signout';
    signoutBtn.textContent = 'Sign out instead';
    altP.appendChild(signoutBtn);
    section.appendChild(altP);

    el.appendChild(section);
    return section;
  }

  function ensureSection() {
    if (sectionEl) return sectionEl;
    sectionEl = buildSection(container);
    // Exactly one delegated listener per event type, attached once here and
    // removed in unmount() — same rule as every other view.
    sectionEl.addEventListener('click', handleClick);
    return sectionEl;
  }

  function render() {
    if (disposed || !container) return;
    const section = ensureSection();
    section.setAttribute('data-state', state);
    unlockBtn.disabled = state === 'busy' || unsupported;
    errorP.hidden = state !== 'error';
    errorP.textContent = state === 'error' ? errorMessage : '';
  }

  async function handleUnlockClick() {
    if (state === 'busy') return;
    state = 'busy';
    errorMessage = '';
    render();

    let result;
    try {
      result = await unlock({ nav, storage, session });
    } catch {
      // unlock() is documented never to reject; this guard only protects
      // against that invariant ever drifting.
      result = 'error';
    }
    if (disposed) return;

    if (result === 'unlocked' || result === 'no-lock') {
      // 'no-lock' means there is nothing left to enforce (e.g. it was
      // cleared elsewhere between this screen mounting and the tap) — the
      // honest thing is to let the user through, not strand them behind a
      // lock screen for a lock that no longer exists.
      state = 'idle';
      render();
      if (typeof onUnlocked === 'function') {
        try {
          onUnlocked();
        } catch {
          // The caller's follow-up (re-rendering the route) is not this
          // view's responsibility to protect beyond not crashing here.
        }
      }
      return;
    }

    if (result === 'cancelled') {
      state = 'error';
      errorMessage = ERROR_CANCELLED;
    } else if (result === 'unsupported') {
      unsupported = true;
      state = 'error';
      errorMessage = ERROR_UNSUPPORTED;
    } else {
      state = 'error';
      errorMessage = ERROR_GENERIC;
    }
    render();
  }

  // The escape hatch (CONTRACT-5.2 §0 rule 4): clears the lock, clears the
  // local cache, and signs out — bypassing Face ID costs the account
  // password, which is the honest boundary this lock offers instead of a
  // silent bypass.
  async function handleSignOutClick() {
    try {
      disableLock({ storage, session });
      st.clear();
      await au.signOut();
      // getAuth().onChange() (subscribed once in main.js's bootstrap())
      // fires from signOut()'s own setSession(null) and re-renders the
      // whole app to the sign-in gate; this view is about to be unmounted,
      // so no further render() here is needed.
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  function handleClick(event) {
    try {
      const target = event.target;
      if (!target || !target.closest) return;
      if (target.closest('button.lock-unlock')) {
        handleUnlockClick();
        return;
      }
      if (target.closest('button.lock-signout')) {
        handleSignOutClick();
      }
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  function mount(el) {
    // Idempotent: a second mount() just re-applies current state, same as
    // js/views/signin.js's mount().
    container = el;
    disposed = false;
    render();
  }

  function unmount() {
    if (disposed) return;
    disposed = true;
    if (sectionEl) {
      sectionEl.removeEventListener('click', handleClick);
    }
    if (container) {
      container.innerHTML = '';
    }
    sectionEl = null;
    unlockBtn = null;
    errorP = null;
    container = null;
    state = 'idle';
    errorMessage = '';
    unsupported = false;
  }

  return { mount, unmount };
}
