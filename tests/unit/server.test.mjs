// Tests for tests/helpers/server.mjs — the static file server used both by
// this node-tier suite (via startServer) and by Playwright (via its CLI
// mode, on a fixed port started separately by playwright.config.mjs).
//
// Every test here binds its OWN ephemeral port (port: 0) so it can never
// collide with the Playwright webServer on 8123, and always tears the
// server down in a finally/after block.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Socket } from 'node:net';
import { startServer } from '../helpers/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// Sends a hand-crafted HTTP/1.1 request line over a raw TCP socket, bypassing
// any URL parser. This exists ONLY for directory-traversal vectors: fetch()
// (and every other WHATWG-URL-based client) normalizes `/../` dot-segments
// client-side before the request is ever put on the wire, so
// fetch(server.url + '/../package.json') actually transmits `GET /package.json`
// — an ordinary, in-bounds file — and the server's containment guard is never
// exercised. Writing the raw bytes here is the only way to test what a real
// attacker, or any non-normalizing HTTP client, can actually send.
//
// Always tears the socket down (via .finally()), whatever happens, so a
// timeout or parse failure can never leak an open handle and stall the
// runner's exit. A socket-level timeout guarantees this can't hang the tier.
function sendRawRequest(port, rawPath, { host = '127.0.0.1', timeoutMs = 2000 } = {}) {
  const socket = new Socket();
  const chunks = [];

  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const succeed = (statusCode) => {
      if (settled) return;
      settled = true;
      resolve(statusCode);
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () =>
      fail(new Error(`raw request to ${rawPath} timed out after ${timeoutMs}ms (socket may be hanging)`))
    );
    socket.once('error', fail);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('close', () => {
      if (settled) return;
      const response = Buffer.concat(chunks).toString('latin1');
      const statusLine = response.split('\r\n')[0] || '';
      const match = statusLine.match(/^HTTP\/\d\.\d (\d{3})/);
      if (!match) {
        fail(new Error(`could not parse an HTTP status line from response: ${JSON.stringify(statusLine)}`));
        return;
      }
      succeed(Number(match[1]));
    });

    socket.connect(port, host, () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
    });
  });

  return promise.finally(() => socket.destroy());
}

describe('startServer', () => {
  let server;

  before(async () => {
    server = await startServer({ root: repoRoot, port: 0 });
  });

  after(async () => {
    if (server) await server.close();
  });

  it('resolves to an object with url (no trailing slash), port > 0, and a close function', () => {
    assert.equal(typeof server.url, 'string');
    assert.ok(!server.url.endsWith('/'), `url should have no trailing slash, got: ${server.url}`);
    assert.equal(typeof server.port, 'number');
    assert.ok(server.port > 0);
    assert.equal(typeof server.close, 'function');
  });

  it('GET /index.html -> 200, exact content-type, non-empty body', async () => {
    const res = await fetch(`${server.url}/index.html`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    const body = await res.text();
    assert.ok(body.length > 0);
  });

  it('GET / serves the same bytes as GET /index.html', async () => {
    const [rootRes, indexRes] = await Promise.all([
      fetch(`${server.url}/`),
      fetch(`${server.url}/index.html`),
    ]);
    assert.equal(rootRes.status, 200);
    const [rootBody, indexBody] = await Promise.all([rootRes.text(), indexRes.text()]);
    assert.equal(rootBody, indexBody);
  });

  // Fixture note: this used to hit js/app.js, which was the app's only JS
  // file back in Step 0.0. Step 0.3 deleted js/app.js (its Supabase constants
  // moved to js/config.js, and the app shell now boots from js/main.js), so
  // the server correctly 404s on it now. Repointed at js/main.js — the app's
  // current module entry point — so the MIME coverage below isn't quietly
  // dropped.
  it('GET /js/main.js -> 200, content-type exactly text/javascript; charset=utf-8 (highest-value assertion: wrong MIME breaks every ES module silently)', async () => {
    const res = await fetch(`${server.url}/js/main.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  });

  it('GET /js/config.js -> 200, text/javascript; charset=utf-8', async () => {
    const res = await fetch(`${server.url}/js/config.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  });

  it('GET /css/styles.css -> 200, text/css; charset=utf-8', async () => {
    const res = await fetch(`${server.url}/css/styles.css`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
  });

  it('GET /manifest.json -> 200, application/json; charset=utf-8', async () => {
    const res = await fetch(`${server.url}/manifest.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  });

  it('GET /icons/icon-192.png -> 200, image/png', async () => {
    const res = await fetch(`${server.url}/icons/icon-192.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
  });

  it('GET /sw.js -> 200, text/javascript; charset=utf-8', async () => {
    const res = await fetch(`${server.url}/sw.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  });

  it('GET /index.html?v=123 -> 200 (query string stripped, not treated as part of filename)', async () => {
    const res = await fetch(`${server.url}/index.html?v=123`);
    assert.equal(res.status, 200);
  });

  it('every response above carries cache-control: no-store', async () => {
    const paths = [
      '/index.html',
      '/',
      '/js/main.js',
      '/js/config.js',
      '/css/styles.css',
      '/manifest.json',
      '/icons/icon-192.png',
      '/sw.js',
      '/index.html?v=123',
    ];
    for (const p of paths) {
      const res = await fetch(`${server.url}${p}`);
      assert.equal(
        res.headers.get('cache-control'),
        'no-store',
        `expected no-store cache-control for ${p}`
      );
    }
  });

  it('GET /does-not-exist.html -> 404', async () => {
    const res = await fetch(`${server.url}/does-not-exist.html`);
    assert.equal(res.status, 404);
  });

  it('GET /css (an existing directory) -> 404, not a directory listing', async () => {
    const res = await fetch(`${server.url}/css`);
    assert.equal(res.status, 404);
  });

  it('404 responses also carry cache-control: no-store', async () => {
    const res = await fetch(`${server.url}/does-not-exist.html`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  describe('directory traversal guard', () => {
    const traversalPaths = [
      '/..%2f..%2fWindows/win.ini',
      '/%2e%2e%2f%2e%2e%2fWindows%2fwin.ini',
    ];

    for (const p of traversalPaths) {
      it(`GET ${p} must not return 200 with file contents`, async () => {
        const res = await fetch(`${server.url}${p}`);
        assert.notEqual(res.status, 200);
        assert.ok(
          res.status === 403 || res.status === 404,
          `expected 403 or 404, got ${res.status}`
        );
      });
    }
  });

  describe('directory traversal guard — raw socket (literal /../ dot-segments)', () => {
    // fetch() cannot exercise this vector: the WHATWG URL parser it uses
    // collapses `/../` dot-segments client-side before the request is ever
    // sent, so fetch(server.url + '/../package.json') actually transmits
    // `GET /package.json` on the wire — an ordinary, in-bounds file — and the
    // server's containment guard is never reached. sendRawRequest() writes
    // the exact request-line bytes over a TCP socket instead, so this is the
    // only way to test what a real attacker (or any non-normalizing HTTP
    // client) can actually send. Do NOT "simplify" this back to fetch() —
    // that would silently delete this coverage again.
    const rawTraversalPaths = [
      '/../package.json', // sibling file that happens to be in-bounds once normalized
      '/../../Windows/win.ini', // escapes the served root entirely
    ];

    for (const rawPath of rawTraversalPaths) {
      it(`raw GET ${rawPath} must not return 200 with file contents`, async () => {
        const status = await sendRawRequest(server.port, rawPath);
        assert.notEqual(status, 200);
      });
    }
  });

  it('POST / -> 405', async () => {
    const res = await fetch(`${server.url}/`, { method: 'POST' });
    assert.equal(res.status, 405);
  });

  it('HEAD /index.html -> 200, correct content-type, empty body', async () => {
    const res = await fetch(`${server.url}/index.html`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    const body = await res.text();
    assert.equal(body, '');
  });
});

describe('startServer — malformed percent-escape', () => {
  let server;

  before(async () => {
    server = await startServer({ root: repoRoot, port: 0 });
  });

  after(async () => {
    if (server) await server.close();
  });

  it('a malformed percent-escape in the path -> 400', async () => {
    // '%' followed by non-hex-digits is an invalid percent-escape sequence.
    const res = await fetch(`${server.url}/%zz`);
    assert.equal(res.status, 400);
  });
});

describe('startServer — close', () => {
  it('after close(), further requests to the same port fail', async () => {
    const server = await startServer({ root: repoRoot, port: 0 });
    const { url } = server;
    await server.close();

    let failed = false;
    try {
      await fetch(`${url}/index.html`);
    } catch {
      failed = true;
    }
    assert.equal(failed, true, 'expected fetch to reject/fail after server close()');
  });
});
