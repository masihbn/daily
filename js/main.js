// App entry point: boots the hash router, renders placeholder views into
// #app, keeps the bottom nav's active state in sync, and registers the
// service worker. No data fetching yet — later steps replace the
// placeholders with real views from js/views/.

import { parseHash } from './router.js';
import { createHomeView } from './views/home.js';
import { createTrackableView } from './views/trackable.js';
import { createDetailView } from './views/detail.js';
import { createCompareView } from './views/compare.js';
import { createSignInView } from './views/signin.js';
import { createOutboxSync, renderOutboxStatus } from './outbox-sync.js';
import { getStore } from './store.js';
import { getAuth } from './auth.js';

const VIEW_TITLES = {
  detail: 'Trackable',
  new: 'New Trackable',
  edit: 'Edit Trackable',
  compare: 'Compare',
  settings: 'Settings',
  notfound: 'Not Found',
};

// The currently-mounted view instance (only the 'home' route has one so
// far). Torn down at the start of every render() so a route change never
// leaves a previous view's listeners attached — a leaked listener across
// navigation is how a single tap ends up firing two writes.
let currentView = null;

function renderView(route) {
  const { name, params } = route;

  switch (name) {
    case 'settings': {
      // Step D.7: sign-out lives on the settings placeholder body rather
      // than in its own view — there is nothing else here yet to justify
      // a dedicated module, and the whole block is wired up by
      // wireSignOutButton() right after this markup lands in the DOM.
      const session = getAuth().getSession();
      const email = session && session.user && session.user.email ? session.user.email : 'unknown';
      return {
        title: VIEW_TITLES.settings,
        body: `<p>App settings will go here.</p>
<p class="signin-as">Signed in as <span class="signin-email">${escapeHtml(email)}</span></p>
<p class="signout-warning" hidden></p>
<button type="button" class="signout" id="signout-btn">Sign out</button>`,
      };
    }
    case 'notfound':
    default:
      return {
        title: VIEW_TITLES.notfound,
        body: '<p>That page does not exist. <a href="#/">Go home</a>.</p>',
      };
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateNav(routeName) {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const links = nav.querySelectorAll('a[data-route]');
  links.forEach((link) => {
    if (link.getAttribute('data-route') === routeName) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
}

async function render() {
  const app = document.getElementById('app');
  if (!app) return;

  const route = parseHash(location.hash);

  // Unmount whatever view is currently attached before rendering the new
  // route, whether or not the new route has a view of its own.
  if (currentView) {
    currentView.unmount();
    currentView = null;
  }

  app.setAttribute('data-route', route.name);

  // Step D.7 gate. The route is still resolved and stamped onto data-route
  // above EVEN WHILE SIGNED OUT — a hash of '#/settings' opened cold must
  // still read data-route="settings" once the user signs in, without
  // touching location.hash to get there. #nav gets `hidden` rather than
  // being removed from the DOM, matching the app's other hidden-toggle
  // convention (e.g. #outbox-status) and keeping the nav's own listeners
  // (updateNav()) intact for when it reappears.
  const auth = getAuth();
  const signedIn = auth.isSignedIn();
  app.setAttribute('data-auth', signedIn ? 'signed-in' : 'signed-out');
  const nav = document.getElementById('nav');
  if (nav) nav.hidden = !signedIn;

  if (!signedIn) {
    app.innerHTML = '<h1>Sign in</h1><div id="view"></div>';
    currentView = createSignInView({
      auth,
      onSignedIn: () => {
        // A write queued while signed out (or while the previous session
        // was dying) needs to reach the server now that there is a fresh
        // token — see outbox-sync.js's canFlush header comment for why
        // this can't just wait for the next SYNC_EVENTS trigger.
        //
        // Deliberately NOT calling render() here (contract amended
        // 2026-09-05): a successful sign-in flips lastSignedIn's session
        // state from null to a session, which the auth.onChange flip
        // listener below (subscribed once in bootstrap()) already detects
        // and renders for. Rendering again here would mount the landing
        // route's view twice and issue its entries load twice.
        if (outboxSync) outboxSync.flushNow();
      },
    });
    currentView.mount(document.getElementById('view'));
    return;
  }

  // Must run synchronously, before the `await` below, not at the end of
  // render(). render() is async and awaits currentView.mount() for the
  // 'home' route; if two renders race (e.g. user taps Home then Settings
  // before the first render's network mount resolves), a later render can
  // finish and set data-route/nav for its route, only for the earlier
  // render to resume afterward and overwrite the nav with its own (stale)
  // route. Keeping updateNav() here, alongside the other synchronous route
  // bookkeeping, ensures nav updates happen in trigger order so the last
  // render to start wins the nav state too — matching data-route.
  updateNav(route.name);

  if (route.name === 'home') {
    app.innerHTML = '<h1>Today</h1><div id="view"></div>';
    currentView = createHomeView();
    await currentView.mount(document.getElementById('view'));
  } else if (route.name === 'new' || route.name === 'edit') {
    const title = route.name === 'edit' ? VIEW_TITLES.edit : VIEW_TITLES.new;
    app.innerHTML = `<h1>${escapeHtml(title)}</h1><div id="view"></div>`;
    currentView =
      route.name === 'edit'
        ? createTrackableView({ mode: 'edit', id: route.params.id })
        : createTrackableView({ mode: 'new' });
    await currentView.mount(document.getElementById('view'));
  } else if (route.name === 'detail') {
    // Step 2.3: the real detail view supersedes the Step 2.2 placeholder
    // (which showed just the id and an Edit link).
    app.innerHTML = `<h1>${escapeHtml(VIEW_TITLES.detail)}</h1><div id="view"></div>`;
    currentView = createDetailView({ id: route.params.id });
    await currentView.mount(document.getElementById('view'));
  } else if (route.name === 'compare') {
    // Step 3.5: the real compare view supersedes the placeholder that used
    // to be a `case 'compare'` branch inside renderView() below.
    app.innerHTML = '<h1>Compare</h1><div id="view"></div>';
    currentView = createCompareView();
    await currentView.mount(document.getElementById('view'));
  } else {
    const { title, body } = renderView(route);
    app.innerHTML = `<h1>${escapeHtml(title)}</h1>${body}`;
    if (route.name === 'settings') wireSignOutButton();
  }
}

// Step D.7 — the Settings placeholder's sign-out button. A fresh element is
// created on every render() (app.innerHTML is fully replaced above), so in
// the normal case there is nothing to double-bind; the dataset guard exists
// for the defensive case of this function running twice against the same
// element before the next render replaces it.
function wireSignOutButton() {
  const btn = document.getElementById('signout-btn');
  if (!btn || btn.dataset.bound === 'true') return;
  btn.dataset.bound = 'true';
  btn.addEventListener('click', handleSignOutClick);
}

async function handleSignOutClick() {
  try {
    const store = getStore();
    const warningEl = document.querySelector('.signout-warning');
    const pending = store.getOutbox().length;

    if (pending > 0) {
      // Refuse: signing out clears the localStorage mirror below, and that
      // mirror is where a queued write actually lives until it reaches the
      // server. Signing out here would destroy it, not just hide it.
      if (warningEl) {
        warningEl.textContent =
          pending === 1
            ? '1 log not yet saved. Get online and wait for them to send before signing out.'
            : `${pending} logs not yet saved. Get online and wait for them to send before signing out.`;
        warningEl.hidden = false;
      }
      return;
    }

    if (warningEl) {
      warningEl.hidden = true;
      warningEl.textContent = '';
    }

    // The localStorage mirror holds personal data (trackables/entries) and
    // must not outlive the session it belongs to — the next person to open
    // this browser must not see it before anyone signs in again.
    store.clear();
    await getAuth().signOut();
    // getAuth().onChange() (subscribed once in bootstrap()) fires from
    // signOut()'s own setSession(null) and re-renders to the gate; no
    // explicit render() call is needed here.
  } catch {
    // A Settings click handler must never crash the app.
  }
}

// Step D.6. Started once, at boot, for every route — not from a view.
// Before this, store.flushOutbox() was called only by the Home view's
// mount(), so a write queued offline from the calendar day-editor was
// never retried unless the user happened to navigate to Home. A standalone
// PWA relaunches at its last hash, which is routinely a detail route, so
// that write could sit in localStorage indefinitely while the UI displayed
// it as saved.
let outboxSync = null;

function startOutboxSync() {
  outboxSync = createOutboxSync({
    store: getStore(),
    target: window,
    doc: document,
    onChange: (count) => {
      renderOutboxStatus(document.getElementById('outbox-status'), count);
    },
    // Step D.7: see outbox-sync.js's header comment on `canFlush` for why a
    // flush must not even attempt to run while signed out.
    canFlush: () => getAuth().isSignedIn(),
  });
  outboxSync.start();
  return outboxSync;
}

// Exported for the e2e tests, which need to observe a flush without waiting
// on a real network event. Not part of the app's own control flow.
export function getOutboxSync() {
  return outboxSync;
}

function bootstrap() {
  // render() is async now (it awaits the home view's mount()); the
  // listener does not need to await it — a stray unhandled rejection can't
  // occur here since render()'s own view lifecycle never lets an error
  // escape (see js/views/home.js).
  window.addEventListener('hashchange', render);

  // Step D.7 (contract amended 2026-09-05 after review): auth.onChange()
  // fires on EVERY session change, including a routine background token
  // refresh from getAccessToken() — which happens constantly during normal
  // use and carries no gate transition at all. Re-rendering on every one of
  // those would unmount whatever view is currently loading (mid-fetch) and
  // remount it, issuing a second entries load for no reason.
  //
  // What actually needs a re-render is a FLIP of the signed-in/signed-out
  // state: a sign-in, a sign-out, or a session dying mid-use (some
  // request's refresh came back with AuthError('session_expired')). So the
  // listener tracks the signed-in state itself and only renders when it
  // changes, not on every notification.
  const auth = getAuth();
  let lastSignedIn = auth.isSignedIn();
  auth.onChange(() => {
    const signedIn = auth.isSignedIn();
    if (signedIn !== lastSignedIn) {
      lastSignedIn = signedIn;
      render();
    }
  });

  render();

  startOutboxSync();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js');
    });
  }
}

// Guard so importing this module in a non-DOM environment (e.g. a Node
// unit test) does not throw.
if (typeof document !== 'undefined') {
  bootstrap();
}
