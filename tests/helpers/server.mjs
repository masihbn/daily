// Zero-dependency static file server (node:http + node:fs) used by the
// test harness. Serves the repo root so the app can be exercised over a
// real HTTP origin (native ES modules are rejected under file://, and a
// wrong Content-Type on .js silently breaks module loading in the browser
// without an obvious error pointing at the server).
//
// Library usage:
//   import { startServer } from './server.mjs';
//   const { url, port, close } = await startServer({ root, port });
//
// CLI usage (this is what Playwright's webServer.command runs):
//   node tests/helpers/server.mjs [port]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PORT = 8123;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

function sendPlain(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function handleRequest(req, res, root) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendPlain(res, 405, 'Method Not Allowed');
    return;
  }

  const rawPath = req.url.split('?')[0];
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    sendPlain(res, 400, 'Bad Request');
    return;
  }

  const relPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const target = path.resolve(root, '.' + relPath);

  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    sendPlain(res, 403, 'Forbidden');
    return;
  }

  fs.stat(target, (err, stats) => {
    if (err) {
      sendPlain(res, 404, 'Not Found');
      return;
    }
    if (stats.isDirectory()) {
      sendPlain(res, 404, 'Not Found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentTypeFor(target),
      'Cache-Control': 'no-store',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(target);
    stream.on('error', () => {
      // Should be rare (stat succeeded above) — fail closed.
      if (!res.headersSent) {
        sendPlain(res, 404, 'Not Found');
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  });
}

export async function startServer({ root, port } = {}) {
  const resolvedRoot = root ? path.resolve(root) : DEFAULT_ROOT;
  const resolvedPort = port ?? 0;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) =>
      handleRequest(req, res, resolvedRoot)
    );
    server.on('error', reject);
    server.listen(resolvedPort, '127.0.0.1', () => {
      const address = server.address();
      const actualPort =
        address && typeof address === 'object' ? address.port : resolvedPort;
      resolve({
        url: `http://127.0.0.1:${actualPort}`,
        port: actualPort,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });
}

// --- CLI mode ---
const isDirectExecution =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const cliPort = process.argv[2] ? Number(process.argv[2]) : DEFAULT_PORT;
  const { url } = await startServer({ root: DEFAULT_ROOT, port: cliPort });
  console.log(`listening on ${url}`);
}
