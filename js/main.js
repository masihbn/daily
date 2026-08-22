// App entry point: boots the hash router, renders placeholder views into
// #app, keeps the bottom nav's active state in sync, and registers the
// service worker. No data fetching yet — later steps replace the
// placeholders with real views from js/views/.

import { parseHash } from './router.js';

const VIEW_TITLES = {
  home: 'Home',
  detail: 'Trackable',
  new: 'New Trackable',
  compare: 'Compare',
  settings: 'Settings',
  notfound: 'Not Found',
};

function renderView(route) {
  const { name, params } = route;

  switch (name) {
    case 'home':
      return {
        title: VIEW_TITLES.home,
        body: '<p>Your trackables will be listed here.</p>',
      };
    case 'detail':
      return {
        title: VIEW_TITLES.detail,
        body: `<p>Detail view placeholder for trackable id: <strong>${escapeHtml(
          params.id
        )}</strong></p>`,
      };
    case 'new':
      return {
        title: VIEW_TITLES.new,
        body: '<p>Form to create a new trackable will go here.</p>',
      };
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

function render() {
  const app = document.getElementById('app');
  if (!app) return;

  const route = parseHash(location.hash);
  const { title, body } = renderView(route);

  app.setAttribute('data-route', route.name);
  app.innerHTML = `<h1>${escapeHtml(title)}</h1>${body}`;

  updateNav(route.name);
}

function bootstrap() {
  window.addEventListener('hashchange', render);
  render();

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
