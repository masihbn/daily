// App entry point: boots the hash router, renders placeholder views into
// #app, keeps the bottom nav's active state in sync, and registers the
// service worker. No data fetching yet — later steps replace the
// placeholders with real views from js/views/.

import { parseHash } from './router.js';
import { createHomeView } from './views/home.js';
import { createTrackableView } from './views/trackable.js';
import { createDetailView } from './views/detail.js';
import { createOutboxSync, renderOutboxStatus } from './outbox-sync.js';
import { getStore } from './store.js';

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
    case 'compare':
      return {
        title: VIEW_TITLES.compare,
        body: '<p>Side-by-side comparison view will go here.</p>',
      };
    case 'settings':
      return {
        title: VIEW_TITLES.settings,
        body: '<p>App settings will go here.</p>',
      };
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
  } else {
    const { title, body } = renderView(route);
    app.innerHTML = `<h1>${escapeHtml(title)}</h1>${body}`;
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
