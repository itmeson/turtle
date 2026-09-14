#!/usr/bin/env node
/**
 * Zero-dependency static server.
 *
 * The app has no build step and no npm dependencies, so this is all that is
 * needed to run it locally:
 *
 *     node serve.mjs
 *
 * Then open http://localhost:8000
 *
 * It exists mainly to serve .wasm with the correct MIME type -- opening
 * index.html directly from the filesystem will not work, because ES modules
 * and WebAssembly both require a real http:// origin.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

/**
 * Serve the SAME Content-Security-Policy as production, by reading it out of
 * the `_headers` file the host uses.
 *
 * Hard-coding it here once already caused a real problem: dev and production
 * drifted, and a policy that broke Pyodide outright was not noticed until it
 * was tested directly. Reading one source of truth makes that impossible.
 */
function productionCsp() {
  try {
    const text = readFileSync(join(ROOT, '_headers'), 'utf8');
    const line = text.split('\n').find((l) => l.includes('Content-Security-Policy:'));
    if (line) return line.split('Content-Security-Policy:')[1].trim();
  } catch { /* fall through */ }
  console.warn('WARNING: could not read _headers; serving a restrictive fallback CSP.');
  return "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
    + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
}

const CSP = productionCsp();
const PORT = Number(process.env.PORT ?? 8000);
const HOST = process.env.HOST ?? '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.py': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    // Collapse leading slashes first: "//foo" is a PROTOCOL-RELATIVE url, so
    // `new URL("//", base)` tries to read "" as a hostname and throws.
    const raw = (req.url ?? '/').replace(/^\/{2,}/, '/');

    let url;
    try {
      url = new URL(raw, `http://${req.headers.host}`);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Bad request');
      return;
    }

    let pathname;
    try {
      // Throws on a malformed percent-escape such as "/%ZZ".
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Bad request');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Contain the path inside ROOT.
    const target = resolve(join(ROOT, normalize(pathname)));
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }

    const body = await readFile(target);
    const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';

    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      // Read from _headers, so what works here is what works deployed.
      'content-security-policy': CSP,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Server error: ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Python Turtle Editor  ->  http://${HOST}:${PORT}`);
  console.log(`serving ${ROOT}`);
});
