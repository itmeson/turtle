/**
 * Phase 4 verification — examples, service worker, offline start.
 *
 *   node test/phase4.browser.mjs
 *
 * The headline check here is that EVERY example program actually runs. Shipping
 * a broken example to a class of beginners is worse than shipping none: a
 * student cannot tell our mistake from theirs, and will assume it is theirs.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { STARTERS } from '../src/starters.js';

// Resolved from this file so the suite runs from any directory, and so
// Windows gets a real path rather than "/C:/..." from URL.pathname.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const PORT = 8131;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

const server = spawn(process.execPath, [join(ROOT, 'serve.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((res) => server.stdout.on('data', (d) => String(d).includes('http://') && res()));

const browser = await chromium.launch();
const context = await browser.newContext({ viewportSize: { width: 1280, height: 800 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });

const ready = async (target = page) => {
  await target.waitForSelector('body[data-storage-ready="1"]', { timeout: 60000 });
  await target.waitForSelector('body[data-ready="1"]', { timeout: 90000 });
};
const setCode = (code, t = page) => t.evaluate((c) => { window.__editor.value = c; }, code);
const run = async (t = page) => {
  await t.click('#run');
  await t.waitForFunction(
    () => !document.getElementById('run').disabled
      && document.getElementById('status').textContent !== 'Running',
    null, { timeout: 60000 },
  );
  await t.evaluate(() => window.__renderer.whenIdle());
};

try {
  // ?nosw keeps this section deterministic; the service worker gets its own page.
  await page.goto(`${BASE}/?nosw`, { waitUntil: 'domcontentloaded' });
  await ready();

  /* ------------------------------------------------ 1. every example runs */
  console.log('\n1. Every example program runs correctly');
  for (const starter of STARTERS) {
    await setCode(starter.code);
    // eslint-disable-next-line no-await-in-loop
    await run();
    // eslint-disable-next-line no-await-in-loop
    const state = await page.evaluate(() => ({
      status: document.getElementById('status').textContent,
      console: document.querySelector('.console-lines').textContent,
      marks: window.__renderer.committed.filter(
        (o) => o.op === 'line' || o.op === 'poly' || o.op === 'dot' || o.op === 'text',
      ).length,
    }));
    const clean = state.status.startsWith('Finished')
      && !/Error/.test(state.console);
    check(`"${starter.name}" runs without error`, clean,
      `${state.status} | ${state.console.slice(0, 160)}`);
    check(`"${starter.name}" actually draws something`, state.marks > 0,
      `${state.marks} marks`);
  }

  /* --------------------------------------------------- 2. examples menu */
  console.log('\n2. Examples menu');
  await page.click('#examples-menu');
  await page.waitForTimeout(150);
  check('menu opens', await page.locator('#examples-list').isVisible());
  const entries = await page.locator('#examples-list button').count();
  check('every example is listed', entries === STARTERS.length, `${entries} entries`);
  check('each has a one-line explanation',
    (await page.textContent('#examples-list')).includes(STARTERS[0].blurb));

  // The toolbar scrolls horizontally, which clips absolutely-positioned
  // children. Check the menu is actually on screen, not merely in the DOM.
  const fits = await page.evaluate(() => {
    const list = document.getElementById('examples-list');
    const r = list.getBoundingClientRect();
    const last = list.lastElementChild.getBoundingClientRect();
    return {
      left: r.left, right: r.right, bottom: last.bottom,
      vw: window.innerWidth, vh: window.innerHeight,
      clipped: r.right > window.innerWidth || r.left < 0 || last.bottom > window.innerHeight,
    };
  });
  check('the menu is fully on screen, not clipped by the toolbar',
    !fits.clipped, JSON.stringify(fits));

  const saveFits = await page.evaluate(() => {
    document.getElementById('save-menu').click();
    const list = document.getElementById('save-list');
    const r = list.getBoundingClientRect();
    const last = list.lastElementChild.getBoundingClientRect();
    const clipped = r.right > window.innerWidth || r.left < 0 || last.bottom > window.innerHeight;
    document.getElementById('save-menu').click();
    return { clipped, right: r.right, vw: window.innerWidth };
  });
  check('the Save menu is fully on screen too', !saveFits.clipped, JSON.stringify(saveFits));

  // Opening an example must not destroy whatever the student had open.
  // Close everything explicitly rather than assuming the current toggle state.
  await page.evaluate(() => document.body.click());
  await page.waitForSelector('#examples-list', { state: 'hidden' });

  await setCode('# MY UNFINISHED WORK\n');
  await page.waitForTimeout(700);

  await page.click('#examples-menu');
  await page.waitForSelector('#examples-list', { state: 'visible' });
  await page.locator('#examples-list button').nth(1).click();
  await page.waitForTimeout(600);

  check('the example loaded', (await page.evaluate(() => window.__editor.value)).includes('spiral')
    || (await page.evaluate(() => window.__editor.value)).includes('colours'),
  (await page.evaluate(() => window.__editor.value)).slice(0, 60));
  const safe = await page.evaluate(async () => {
    const all = await window.__workspace.listAll();
    return all.some((p) => p.code.includes('MY UNFINISHED WORK'));
  });
  check('the student\'s own work is still there', safe,
    'an example must open as a NEW program');
  check('it is named after the example',
    (await page.inputValue('#name')) === STARTERS[1].name, await page.inputValue('#name'));

  /* -------------------------------------------------------- 3. the icon */
  console.log('\n3. Polish');
  const favicon = await page.evaluate(async () => {
    const res = await fetch('./favicon.svg');
    return { ok: res.ok, type: res.headers.get('content-type') };
  });
  check('favicon exists and is served as SVG',
    favicon.ok && favicon.type.includes('svg'), JSON.stringify(favicon));

  /* ------------------------------------------- 4. service worker + offline */
  console.log('\n4. Service worker and offline start');
  const swPage = await context.newPage();
  const swErrors = [];
  swPage.on('pageerror', (e) => swErrors.push(String(e)));
  await swPage.goto(BASE, { waitUntil: 'load' });
  await ready(swPage);
  await swPage.waitForFunction(
    () => document.body.dataset.swRegistered, null, { timeout: 20000 },
  );
  check('service worker registered',
    (await swPage.evaluate(() => document.body.dataset.swRegistered)) === '1',
    await swPage.evaluate(() => document.body.dataset.swRegistered));

  await swPage.waitForFunction(
    () => navigator.serviceWorker.controller !== null, null, { timeout: 20000 },
  ).catch(() => {});

  // Warm the caches by reloading once while online.
  await swPage.reload({ waitUntil: 'load' });
  await ready(swPage);

  const cached = await swPage.evaluate(async () => {
    const names = await caches.keys();
    let vendorEntries = 0;
    for (const name of names) {
      const c = await caches.open(name);
      const keys = await c.keys();
      vendorEntries += keys.filter((r) => r.url.includes('/vendor/')).length;
    }
    return { names, vendorEntries };
  });
  check('a shell cache and a vendor cache exist',
    cached.names.some((n) => n.startsWith('shell-'))
    && cached.names.some((n) => n.startsWith('vendor-')),
    JSON.stringify(cached.names));
  check('the Pyodide runtime is cached', cached.vendorEntries > 0,
    `${cached.vendorEntries} vendor entries`);

  // The real test: pull the network and see whether Python still starts.
  await context.setOffline(true);
  const offline = await context.newPage();
  const offlineErrors = [];
  offline.on('pageerror', (e) => offlineErrors.push(String(e)));
  let offlineWorks = true;
  try {
    await offline.goto(BASE, { waitUntil: 'domcontentloaded' });
    await offline.waitForSelector('body[data-ready="1"]', { timeout: 90000 });
  } catch {
    offlineWorks = false;
  }
  check('the whole editor starts with no network at all', offlineWorks,
    offlineErrors.join(' | '));

  if (offlineWorks) {
    await setCode('import turtle\nt = turtle.Turtle()\nt.forward(60)\nprint("offline ok")\n', offline);
    await run(offline);
    check('and runs a turtle program offline',
      (await offline.textContent('.console-lines')).includes('offline ok'),
      await offline.textContent('.console-lines'));
  }
  await context.setOffline(false);
  await offline.close();
  await swPage.close();

  /* -------------------------------------------------------- 5. hygiene */
  console.log('\n5. Hygiene');
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('\n         '));

  await page.evaluate(() => window.__panel.close());
  await page.click('#examples-menu');
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(ROOT, 'test/phase4-examples.png') });
  console.log('       screenshot -> test/phase4-examples.png');
} catch (err) {
  failed++;
  console.log(`\n  FAIL (threw) ${err.message}\n${err.stack}`);
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
