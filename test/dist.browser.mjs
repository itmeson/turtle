/**
 * Verify the BUILT site, served the way GitHub Pages will serve it.
 *
 *     node build.mjs && node test/dist.browser.mjs
 *
 * Two things differ between `node serve.mjs` and the real deployment, and both
 * have historically broken static sites:
 *
 *   1. GitHub Pages serves a project site from a SUBPATH -- not
 *      `example.github.io/` but `example.github.io/online-python/`. Anything
 *      that assumed it lived at the root breaks, including the service worker's
 *      scope.
 *   2. GitHub Pages cannot set HTTP headers, so the Content-Security-Policy
 *      arrives only as the `<meta>` tag in index.html.
 *
 * This suite reproduces both: it serves `dist/` under a subpath with NO CSP
 * header at all, and checks the whole application still works.
 */

import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const PORT = 8134;
const SUBPATH = '/online-python';          // stands in for the repository name
const BASE = `http://127.0.0.1:${PORT}${SUBPATH}/`;

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

if (!existsSync(DIST)) {
  console.error('\ndist/ does not exist. Run `node build.mjs` first.\n');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm',
  '.py': 'text/plain; charset=utf-8', '.zip': 'application/zip',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

/** Deliberately header-free: this is what GitHub Pages gives you. */
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  if (!pathname.startsWith(`${SUBPATH}/`) && pathname !== SUBPATH) {
    res.writeHead(404).end('not found');
    return;
  }
  pathname = pathname.slice(SUBPATH.length) || '/';
  if (pathname.endsWith('/')) pathname += 'index.html';

  const target = resolve(join(DIST, pathname));
  if (target !== DIST && !target.startsWith(DIST + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let info = null;
  try { info = statSync(target); } catch { /* missing */ }
  if (!info || !info.isFile()) { res.writeHead(404).end('not found'); return; }

  res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
  res.end(readFileSync(target));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch();
const context = await browser.newContext({ viewportSize: { width: 1280, height: 800 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });
const missing = [];
page.on('response', (r) => { if (r.status() === 404) missing.push(r.url()); });

try {
  /* ------------------------------------------------- 1. it runs at all */
  console.log('\n1. The built site starts from a subpath with no CSP header');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-storage-ready="1"]', { timeout: 60000 });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 90000 });

  const info = await page.evaluate(() => ({ ...document.body.dataset }));
  check('Python booted', /^3\.14/.test(info.pythonVersion ?? ''), info.pythonVersion);
  check('nothing 404ed', missing.length === 0, missing.join('\n         '));
  check('page URL really is a subpath', page.url().includes(SUBPATH), page.url());

  /* --------------------------------------------- 2. the app still works */
  console.log('\n2. Everything still works from there');
  await page.evaluate(() => {
    window.__editor.value = 'import turtle\nt = turtle.Turtle()\nt.speed(0)\n'
      + 'for i in range(5):\n    t.forward(90)\n    t.right(144)\nprint("built ok")\n';
  });
  await page.click('#run');
  await page.waitForFunction(
    () => !document.getElementById('run').disabled
      && document.getElementById('status').textContent !== 'Running',
    null, { timeout: 60000 },
  );
  await page.evaluate(() => window.__renderer.whenIdle());

  check('a turtle program runs', (await page.textContent('.console-lines')).includes('built ok'));
  check('and draws', (await page.evaluate(
    () => window.__renderer.committed.filter((o) => o.op === 'line').length,
  )) === 5);

  /* ------------------------- 3. the sandbox is what protects the worker */
  console.log('\n3. Without a CSP header, the sandbox must still hold');
  const sealed = JSON.parse(await page.evaluate(() => document.body.dataset.sealed));
  check('the worker sealed its globals', sealed && sealed.removed.includes('fetch'),
    JSON.stringify(sealed));
  check('nothing failed to seal', sealed && sealed.failed.length === 0);

  /* -------------------------------------------- 4. service worker scope */
  console.log('\n4. Service worker registers under the subpath');
  await page.waitForFunction(() => document.body.dataset.swRegistered,
    null, { timeout: 20000 });
  check('registered', (await page.evaluate(() => document.body.dataset.swRegistered)) === '1',
    await page.evaluate(() => document.body.dataset.swRegistered));
  const scope = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.scope : null;
  });
  check('its scope is the subpath, not the domain root',
    scope !== null && scope.includes(SUBPATH), String(scope));

  /* ---------------------------------------------------- 5. share links */
  console.log('\n5. Share links keep the subpath');
  const shareUrl = await page.evaluate(async () => {
    const { buildShareUrl } = await import('./src/storage/share.js');
    return buildShareUrl('print("shared")\n', location.href.split('#')[0]);
  });
  check('link points back into the subpath', shareUrl.includes(`${SUBPATH}/`), shareUrl.slice(0, 90));
  check('and carries the program in the fragment', shareUrl.includes('#c='));

  /* ------------------------------------------------------- 6. offline */
  console.log('\n6. Offline still works from a subpath');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 90000 });
  await context.setOffline(true);
  const offline = await context.newPage();
  let works = true;
  try {
    await offline.goto(BASE, { waitUntil: 'domcontentloaded' });
    await offline.waitForSelector('body[data-ready="1"]', { timeout: 90000 });
  } catch { works = false; }
  check('the editor starts with no network', works);
  await context.setOffline(false);
  await offline.close();

  /* ------------------------------------------------------- 7. hygiene */
  // Assert on page errors BEFORE the probes below: those deliberately request
  // files that must not exist, and each 404 is logged as a console error. A
  // test that pollutes its own error collector would report a false failure.
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('\n         '));

  console.log('\n7. Nothing that should not be published is reachable');
  for (const path of ['test/csp.test.mjs', 'SPEC.md', 'BRIEF.md', 'serve.mjs',
    'package.json', 'node_modules/playwright/package.json']) {
    // eslint-disable-next-line no-await-in-loop
    const status = await page.evaluate(async (p) => {
      try { return (await fetch(p)).status; } catch { return 'blocked'; }
    }, path);
    check(`${path} is not on the live site`, status === 404 || status === 'blocked', String(status));
  }
} catch (err) {
  failed++;
  console.log(`\n  FAIL (threw) ${err.message}\n${err.stack}`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
