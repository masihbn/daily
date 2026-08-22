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
      // TEMPORARY DIAGNOSTIC — added 2026-08-22 to debug the iOS standalone
      // bottom-band layout bug: a band of empty/mismatched space appears
      // below the fixed bottom nav in the installed standalone PWA on a
      // physical iPhone, and cannot be reproduced in Playwright (no
      // safe-area-inset emulation). Two remote hypotheses were already
      // disproved (nav using bottom: env(safe-area-inset-bottom) instead of
      // padding-bottom; missing `html` background), so this renders a live
      // measurement readout instead of guessing a third time. This
      // replaces the real settings placeholder ONLY for the duration of
      // this investigation. MUST be removed and replaced with the real
      // settings screen in Step 4.1 — see docs/BUILD_PLAN.md Step 4.1.
      return {
        title: VIEW_TITLES.settings,
        body: renderDiagnosticReadout(),
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

// --- TEMPORARY DIAGNOSTIC (added 2026-08-22) ---------------------------
// Everything below this line, down to the matching end marker, exists
// only to debug the iOS standalone bottom-band layout bug described in
// the comment above the 'settings' case. Remove this whole block and the
// case 'settings' body above it in Step 4.1 (see docs/BUILD_PLAN.md).

// Rounds to 1 decimal place for screenshot readability. Returns 'n/a' for
// anything that isn't a finite number, so a missing/unsupported API never
// throws mid-render.
function fmt(n) {
  if (typeof n !== 'number' || !isFinite(n)) return 'n/a';
  return n.toFixed(1);
}

// env(safe-area-inset-*) cannot be read directly from JS. Measure it by
// laying out an off-screen probe element whose height is driven by the
// inset and reading back its rendered height.
function measureSafeAreaInset(side) {
  const probe = document.createElement('div');
  probe.style.position = 'fixed';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.top = '0';
  probe.style.left = '0';
  probe.style.width = '0';
  probe.style.height = `env(safe-area-inset-${side}, 0px)`;
  document.body.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  document.body.removeChild(probe);
  return height;
}

function rectRow(label, rect) {
  if (!rect) {
    return `<div>${escapeHtml(label)}: n/a</div>`;
  }
  return `<div>${escapeHtml(label)}: top=${fmt(rect.top)} bottom=${fmt(
    rect.bottom
  )} height=${fmt(rect.height)}</div>`;
}

// Builds the diagnostic readout body. Called fresh on every render of the
// settings view (renderView -> render() is invoked on every hashchange),
// so every value here is measured live — nothing is cached or hoisted to
// module scope.
function renderDiagnosticReadout() {
  const rows = [];

  // Viewport / screen
  rows.push(['window.innerHeight', fmt(window.innerHeight)]);
  rows.push(['window.innerWidth', fmt(window.innerWidth)]);
  rows.push([
    'document.documentElement.clientHeight',
    fmt(document.documentElement.clientHeight),
  ]);
  rows.push(['screen.height', fmt(screen.height)]);
  rows.push(['screen.availHeight', fmt(screen.availHeight)]);

  let vvHeight = 'n/a';
  let vvOffsetTop = 'n/a';
  if (window.visualViewport) {
    vvHeight = fmt(window.visualViewport.height);
    vvOffsetTop = fmt(window.visualViewport.offsetTop);
  }
  rows.push(['visualViewport.height', vvHeight]);
  rows.push(['visualViewport.offsetTop', vvOffsetTop]);

  rows.push(['devicePixelRatio', fmt(window.devicePixelRatio)]);

  // Standalone detection
  rows.push([
    'navigator.standalone',
    typeof navigator.standalone === 'boolean'
      ? String(navigator.standalone)
      : 'n/a',
  ]);

  let standaloneMedia = 'n/a';
  try {
    standaloneMedia = String(
      window.matchMedia('(display-mode: standalone)').matches
    );
  } catch {
    standaloneMedia = 'n/a';
  }
  rows.push(['matchMedia(display-mode: standalone)', standaloneMedia]);

  // Safe-area insets — the load-bearing measurement.
  let insetTop = NaN;
  let insetBottom = NaN;
  let insetLeft = NaN;
  let insetRight = NaN;
  try {
    insetTop = measureSafeAreaInset('top');
    insetBottom = measureSafeAreaInset('bottom');
    insetLeft = measureSafeAreaInset('left');
    insetRight = measureSafeAreaInset('right');
  } catch {
    // Leave as NaN -> renders as 'n/a' below.
  }
  rows.push(['safe-area-inset-top', fmt(insetTop)]);
  rows.push(['safe-area-inset-bottom', fmt(insetBottom)]);
  rows.push(['safe-area-inset-left', fmt(insetLeft)]);
  rows.push(['safe-area-inset-right', fmt(insetRight)]);

  const listHtml = rows
    .map(
      ([label, value]) =>
        `<div>${escapeHtml(label)}: ${escapeHtml(value)}</div>`
    )
    .join('');

  // Element geometry
  let navRect = null;
  try {
    const navEl = document.getElementById('nav');
    navRect = navEl ? navEl.getBoundingClientRect() : null;
  } catch {
    navRect = null;
  }

  let bodyRect = null;
  let htmlRect = null;
  try {
    bodyRect = document.body.getBoundingClientRect();
    htmlRect = document.documentElement.getBoundingClientRect();
  } catch {
    bodyRect = null;
    htmlRect = null;
  }

  const geomHtml =
    rectRow('#nav', navRect) +
    rectRow('document.body', bodyRect) +
    rectRow('document.documentElement', htmlRect);

  const gap = navRect ? window.innerHeight - navRect.bottom : NaN;

  return `
    <p style="font-weight:bold; margin:0 0 6px;">TEMPORARY DIAGNOSTIC OUTPUT — not the real settings screen (see docs/BUILD_PLAN.md Step 4.1)</p>
    <div style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11px; line-height:1.35;">
      ${listHtml}
      ${geomHtml}
      <div style="font-weight:bold; font-size:14px; margin-top:6px; border-top:1px solid currentColor; padding-top:4px;">gap below nav (innerHeight - nav.bottom): ${fmt(
        gap
      )}</div>
    </div>
  `;
}
// --- END TEMPORARY DIAGNOSTIC -------------------------------------------

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
