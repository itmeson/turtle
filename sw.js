/**
 * Service worker — SPEC.md section 12.
 *
 * Two caching strategies, chosen for opposite reasons:
 *
 *   vendor/**      CACHE FIRST, never revalidated. This is the 12.9 MB Pyodide
 *                  runtime and the CodeMirror bundle: version-pinned, enormous,
 *                  and identical every time. Day two onward they never touch the
 *                  network, which turns a 3-second start into an instant one and
 *                  removes the school wifi from the critical path entirely.
 *
 *   everything else NETWORK FIRST, falling back to cache. Our own code is small.
 *                  Serving it from cache would mean a teacher pushes a fix and
 *                  students keep running the old version until someone works out
 *                  how to clear a service worker -- a genuinely awful failure for
 *                  a tool nobody is paid to maintain. Correctness beats a few
 *                  kilobytes.
 *
 * The result: fast where it matters, never stale where it matters.
 *
 * Bump CACHE_VERSION when vendor/ changes. Old caches are deleted on activate.
 */

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `shell-${CACHE_VERSION}`;
const VENDOR_CACHE = `vendor-${CACHE_VERSION}`;

/** Small enough to precache on install without competing with the first paint. */
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './src/main.js',
  './src/starters.js',
  './src/editor/sanitize.js',
  './src/editor/codeMirrorEditor.js',
  './src/runner/client.js',
  './src/runner/worker.js',
  './src/runner/protocol.js',
  './src/runner/glosses.js',
  './src/runner/harness.py',
  './src/turtle/turtle.py',
  './src/turtle/ops.js',
  './src/turtle/shapes.js',
  './src/turtle/renderCanvas.js',
  './src/turtle/renderSvg.js',
  './src/turtle/renderPng.js',
  './src/storage/share.js',
  './src/storage/db.js',
  './src/storage/workspace.js',
  './src/storage/download.js',
  './src/ui/consolePane.js',
  './src/ui/panel.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Individually, so one missing file cannot fail the whole install.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, VENDOR_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.map((name) => (keep.has(name) ? null : caches.delete(name))));
    await self.clients.claim();
  })());
});

const isVendor = (url) => url.pathname.includes('/vendor/');

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // CSP blocks these anyway

  if (isVendor(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(VENDOR_CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    } catch (err) {
      const hit = await cache.match(request);
      if (hit) return hit;
      // A navigation with nothing cached: hand back the shell so the app can
      // at least start and explain itself.
      if (request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
