// Pure hash-route parser — no DOM, no network, no browser globals.
// Split out of main.js specifically so route parsing can be unit-tested
// in Node without a DOM.
//
// Hash routing (not the History API) is deliberate: GitHub Pages serves
// static files with no server-side rewrite, so a History-API deep link
// like /daily/t/5 would 404 on a hard refresh. Hash routes need no
// server config and survive the PWA's standalone relaunch.

const NOTFOUND = Object.freeze({ name: 'notfound', params: {} });

function fresh(route) {
  // Always return a new object (and a new params object) so a caller
  // can never mutate a shared/frozen singleton.
  return { name: route.name, params: { ...route.params } };
}

export function parseHash(hash) {
  if (typeof hash !== 'string') {
    return fresh(NOTFOUND);
  }

  // The input is location.hash, which is '' when there is no fragment and
  // otherwise always begins with '#'. A non-empty value without a leading
  // '#' is a plain path, not a hash fragment — accepting it would make a
  // History-API-style link (e.g. '/settings') look like it routes
  // correctly here, when this app is hash-routed and such a path would
  // actually 404 on a hard refresh from GitHub Pages. So '#' is mandatory
  // for every case except the empty-string one.
  if (hash === '') {
    return fresh({ name: 'home', params: {} });
  }

  if (!hash.startsWith('#')) {
    return fresh(NOTFOUND);
  }

  // Strip the leading '#', then a single trailing '/', then split.
  let path = hash.slice(1);

  if (path === '' || path === '/') {
    return fresh({ name: 'home', params: {} });
  }

  if (!path.startsWith('/')) {
    return fresh(NOTFOUND);
  }

  // Treat a trailing slash the same as without it (but don't strip the
  // root '/' itself — already handled above).
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  const segments = path.slice(1).split('/'); // drop leading '/', then split

  if (segments.length === 1) {
    switch (segments[0]) {
      case 'new':
        return fresh({ name: 'new', params: {} });
      case 'compare':
        return fresh({ name: 'compare', params: {} });
      case 'settings':
        return fresh({ name: 'settings', params: {} });
      default:
        return fresh(NOTFOUND);
    }
  }

  if (segments.length === 2 && segments[0] === 't') {
    const rawId = segments[1];
    if (rawId === '') {
      return fresh(NOTFOUND);
    }
    let id;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return fresh(NOTFOUND);
    }
    return fresh({ name: 'detail', params: { id } });
  }

  // Step 2.2: #/t/:id/edit — the literal third segment must be 'edit';
  // anything else in that position (#/t/5/extra) stays notfound.
  if (segments.length === 3 && segments[0] === 't' && segments[2] === 'edit') {
    const rawId = segments[1];
    if (rawId === '') {
      return fresh(NOTFOUND);
    }
    let id;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return fresh(NOTFOUND);
    }
    return fresh({ name: 'edit', params: { id } });
  }

  return fresh(NOTFOUND);
}
