// Sign-in gate (Step D.7). Rendered by js/main.js instead of any route's
// view whenever there is no session — see main.js's render() for the gate
// itself. This file's job is narrow: render the form, call
// auth.signInWithPassword(), and report success/failure. It does NOT
// navigate (the caller decides what "signed in" means for the current
// route via onSignedIn) and it never touches the hash.
//
// Same view lifecycle discipline as every other view in js/views/ (see
// home.js's header): idempotent mount, synchronous unmount, exactly one
// delegated listener, and no exception may ever escape a handler.
//
// PASSWORD HANDLING: the password field's value is read once, at submit,
// straight into the fetch call inside auth.js. It is never assigned to a
// module-level variable, never logged, never persisted to storage, and
// never appears in a URL — only the resulting session (access/refresh
// tokens) is ever stored, by js/auth.js.

import { getAuth } from '../auth.js';
import { NetworkError, AuthError } from '../errors.js';

export function createSignInView({ auth, onSignedIn } = {}) {
  const au = auth || getAuth();

  let container = null;
  let sectionEl = null;
  let disposed = true;

  // 'idle' | 'busy' | 'error' — mirrored onto section[data-state].
  let state = 'idle';
  let errorMessage = '';

  function ensureSection() {
    if (sectionEl) return sectionEl;
    sectionEl = document.createElement('section');
    sectionEl.className = 'signin';
    // Exactly one listener, delegated on this root, attached once here and
    // removed in unmount() — same rule as every other view.
    sectionEl.addEventListener('submit', handleSubmit);
    container.appendChild(sectionEl);
    return sectionEl;
  }

  function render() {
    if (disposed || !container) return;

    const section = ensureSection();
    section.setAttribute('data-state', state);
    section.innerHTML = '';

    const form = document.createElement('form');
    form.className = 'signin-form';
    form.setAttribute('novalidate', '');

    const emailLabel = document.createElement('label');
    emailLabel.className = 'signin-field';
    emailLabel.appendChild(document.createTextNode('Email'));
    const emailInput = document.createElement('input');
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
    const passwordInput = document.createElement('input');
    passwordInput.type = 'password';
    passwordInput.name = 'password';
    passwordInput.autocomplete = 'current-password';
    passwordInput.required = true;
    passwordLabel.appendChild(passwordInput);
    form.appendChild(passwordLabel);

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'signin-submit';
    submitBtn.disabled = state === 'busy';
    submitBtn.textContent = 'Sign in';
    form.appendChild(submitBtn);

    // Present always (never re-created only on error) so its role="alert"
    // element exists in the DOM from the first render, and `hidden` is
    // the only thing that changes when an error appears.
    const errorP = document.createElement('p');
    errorP.className = 'signin-error';
    errorP.setAttribute('role', 'alert');
    errorP.hidden = state !== 'error';
    errorP.textContent = state === 'error' ? errorMessage : '';
    form.appendChild(errorP);

    section.appendChild(form);
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

  function handleSubmit(event) {
    try {
      const form = event.target && event.target.closest ? event.target.closest('form.signin-form') : null;
      if (!form) return;
      event.preventDefault();
      if (state === 'busy') return;

      const emailInput = form.querySelector('input[name="email"]');
      const passwordInput = form.querySelector('input[name="password"]');
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
              // The caller's follow-up (flush + re-render) is not this
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
    // must not double-bind the submit listener. ensureSection() only
    // creates (and only ever attaches the listener to) sectionEl once per
    // instance, so a second mount() just re-renders the existing section.
    container = el;
    disposed = false;
    render();
  }

  function unmount() {
    if (disposed) return;
    disposed = true;
    if (sectionEl) {
      sectionEl.removeEventListener('submit', handleSubmit);
    }
    if (container) {
      container.innerHTML = '';
    }
    sectionEl = null;
    container = null;
  }

  return { mount, unmount };
}
