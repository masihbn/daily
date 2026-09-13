// Sign-in gate (Step D.7). Rendered by js/main.js instead of any route's
// view whenever there is no session — see main.js's render() for the gate
// itself. This file's job is narrow: render the form, call
// auth.signInWithPassword(), and report success/failure. It does NOT
// navigate (the caller decides what "signed in" means for the current
// route via onSignedIn) and it never touches the hash.
//
// Same view lifecycle discipline as every other view in js/views/ (see
// home.js's header): idempotent mount, synchronous unmount, exactly one
// delegated listener per event type, and no exception may ever escape a
// handler.
//
// PASSWORD HANDLING: the password field's value is read once, at submit,
// straight into the fetch call inside auth.js. It is never assigned to a
// module-level variable, never logged, never persisted to storage, and
// never appears in a URL — only the resulting session (access/refresh
// tokens) is ever stored, by js/auth.js. The Show/Hide toggle added
// 2026-09-13 only flips the input's `type` attribute between `password`
// and `text` so the browser renders it in cleartext; it never reads,
// copies, or otherwise touches the value itself.

import { getAuth } from '../auth.js';
import { NetworkError, AuthError } from '../errors.js';

export function createSignInView({ auth, onSignedIn } = {}) {
  const au = auth || getAuth();

  let container = null;
  let sectionEl = null;
  let formEl = null;
  let emailInput = null;
  let passwordInput = null;
  let toggleBtn = null;
  let submitBtn = null;
  let errorP = null;
  let disposed = true;

  // 'idle' | 'busy' | 'error' — mirrored onto section[data-state].
  let state = 'idle';
  let errorMessage = '';
  // Show/Hide toggle state (2026-09-13, device feedback: the user could
  // not tell what they had typed). Independent of `state` — surviving a
  // busy/error re-render is the whole point of tracking it separately.
  let showPassword = false;

  // Builds the form ONCE per mounted instance. Before 2026-09-13, render()
  // rebuilt the whole form on every call (`section.innerHTML = ''`), which
  // wiped whatever the user had typed the moment a submit failed — exactly
  // the busy -> error transition every real sign-in attempt goes through,
  // and it would have wiped the new Show/Hide toggle's state too. Building
  // the DOM once here and having render() below only flip attributes/text
  // on the elements captured here (never emailInput.value /
  // passwordInput.value) is what makes the typed values and the toggle's
  // shown/hidden choice survive a re-render (CONTRACT-D.7.md §6, A15).
  function buildForm(section) {
    const form = document.createElement('form');
    form.className = 'signin-form';
    form.setAttribute('novalidate', '');

    const emailLabel = document.createElement('label');
    emailLabel.className = 'signin-field';
    emailLabel.appendChild(document.createTextNode('Email'));
    emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.name = 'email';
    emailInput.autocomplete = 'username';
    emailInput.setAttribute('inputmode', 'email');
    emailInput.setAttribute('autocapitalize', 'none');
    emailInput.required = true;
    emailLabel.appendChild(emailInput);
    form.appendChild(emailLabel);

    const passwordLabel = document.createElement('label');
    passwordLabel.className = 'signin-field';
    passwordLabel.appendChild(document.createTextNode('Password'));
    passwordInput = document.createElement('input');
    passwordInput.type = 'password';
    passwordInput.name = 'password';
    passwordInput.autocomplete = 'current-password';
    passwordInput.required = true;
    passwordLabel.appendChild(passwordInput);
    form.appendChild(passwordLabel);

    // Show/Hide toggle (2026-09-13). Sits directly after the password
    // field, before the submit button. type="button" so a tap on it can
    // never submit the form (no preventDefault needed for that — a
    // type="button" button never triggers submission); handleClick()
    // below is the only thing it does.
    toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'signin-toggle';
    toggleBtn.setAttribute('aria-pressed', 'false');
    toggleBtn.textContent = 'Show';
    form.appendChild(toggleBtn);

    submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'signin-submit';
    submitBtn.textContent = 'Sign in';
    form.appendChild(submitBtn);

    // Present always (never re-created only on error) so its role="alert"
    // element exists in the DOM from the first render, and `hidden` is
    // the only thing that changes when an error appears.
    errorP = document.createElement('p');
    errorP.className = 'signin-error';
    errorP.setAttribute('role', 'alert');
    errorP.hidden = true;
    form.appendChild(errorP);

    section.appendChild(form);
    formEl = form;
  }

  function ensureSection() {
    if (sectionEl) return sectionEl;
    sectionEl = document.createElement('section');
    sectionEl.className = 'signin';
    // Exactly one listener per event type, delegated on this root,
    // attached once here and removed in unmount() — same rule as every
    // other view.
    sectionEl.addEventListener('submit', handleSubmit);
    sectionEl.addEventListener('click', handleClick);
    container.appendChild(sectionEl);
    buildForm(sectionEl);
    return sectionEl;
  }

  // Applies `state` / `errorMessage` / `showPassword` onto the elements
  // buildForm() created once above: section[data-state], the submit
  // button's disabled flag, the error paragraph, and the toggle's
  // text/aria-pressed (which also drives the password input's `type`).
  // Deliberately never touches emailInput.value or passwordInput.value —
  // see buildForm()'s header comment for why that matters.
  function render() {
    if (disposed || !container) return;

    const section = ensureSection();
    section.setAttribute('data-state', state);

    submitBtn.disabled = state === 'busy';

    errorP.hidden = state !== 'error';
    errorP.textContent = state === 'error' ? errorMessage : '';

    toggleBtn.textContent = showPassword ? 'Hide' : 'Show';
    toggleBtn.setAttribute('aria-pressed', String(showPassword));
    passwordInput.type = showPassword ? 'text' : 'password';
  }

  // Maps a thrown error to the exact user-facing message per CONTRACT-D.7
  // §6. Order matters: AuthError is checked before the generic fallback,
  // and within AuthError, `status === null` is what distinguishes the
  // local "you left a field empty" message from a real server rejection.
  function messageFor(err) {
    if (err instanceof AuthError && err.reason === 'invalid_credentials') {
      return err.status === null ? err.message : 'Wrong email or password.';
    }
    if (err instanceof NetworkError) {
      return 'You are offline. Signing in needs a connection.';
    }
    return 'Could not sign in. Try again in a moment.';
  }

  // Show/Hide toggle click. The typed value is untouched — only the
  // input's `type` attribute (and this button's own text/aria-pressed)
  // change, via render()'s toggle-sync lines above.
  function handleClick(event) {
    try {
      const btn = event.target && event.target.closest ? event.target.closest('button.signin-toggle') : null;
      if (!btn || !sectionEl || !sectionEl.contains(btn)) return;
      showPassword = !showPassword;
      render();
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  function handleSubmit(event) {
    try {
      const form = event.target && event.target.closest ? event.target.closest('form.signin-form') : null;
      if (!form || form !== formEl) return;
      event.preventDefault();
      if (state === 'busy') return;

      // Read straight from the live inputs — submitting always sends
      // whatever is currently typed, regardless of the Show/Hide choice
      // (toggling `type` between password/text never changes `.value`).
      const email = emailInput ? emailInput.value : '';
      const password = passwordInput ? passwordInput.value : '';

      state = 'busy';
      errorMessage = '';
      render();

      au.signInWithPassword(email, password)
        .then(() => {
          if (disposed) return;
          if (typeof onSignedIn === 'function') {
            try {
              onSignedIn();
            } catch {
              // The caller's follow-up (flushing the outbox) is not this
              // view's responsibility to protect beyond not crashing here.
            }
          }
        })
        .catch((err) => {
          if (disposed) return;
          state = 'error';
          errorMessage = messageFor(err);
          render();
        });
    } catch {
      // No handler may ever let an exception escape.
    }
  }

  function mount(el) {
    // Idempotent: calling mount() again on an already-mounted instance
    // must not double-bind listeners or rebuild the form. ensureSection()
    // only creates (and only ever attaches listeners to, and only ever
    // calls buildForm() for) sectionEl once per instance, so a second
    // mount() just re-applies the current state to the existing elements.
    container = el;
    disposed = false;
    render();
  }

  function unmount() {
    if (disposed) return;
    disposed = true;
    if (sectionEl) {
      sectionEl.removeEventListener('submit', handleSubmit);
      sectionEl.removeEventListener('click', handleClick);
    }
    if (container) {
      container.innerHTML = '';
    }
    sectionEl = null;
    formEl = null;
    emailInput = null;
    passwordInput = null;
    toggleBtn = null;
    submitBtn = null;
    errorP = null;
    container = null;
  }

  return { mount, unmount };
}
