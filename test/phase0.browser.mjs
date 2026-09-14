/**
 * Phase 0 verification — SPEC.md section 14, Phase 0 exit criteria.
 *
 *   node test/phase0.browser.mjs
 *
 * Proves, in a real browser, that:
 *   1. Pyodide boots in a worker and print() round-trips
 *   2. syntax errors arrive with an exact line and column, before execution
 *   3. runtime tracebacks contain the student's frames and nothing else
 *   4. Stop actually kills an infinite loop, and the pre-warmed spare works
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Resolved from this file so the suite runs from any directory, and so
// Windows gets a real path rather than "/C:/..." from URL.pathname.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
  }
}

const server = spawn(process.execPath, [join(ROOT, 'serve.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('server did not start')), 10000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('http://')) { clearTimeout(t); res(); }
  });
});

const browser = await chromium.launch();
const page = await browser.newPage();

/** @type {string[]} */
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`);
});

const helpers = {
  setCode: (code) => page.evaluate((c) => { window.__editor.value = c; }, code),
  run: async () => {
    await page.click('#run');
    await page.waitForFunction(
      () => !document.getElementById('run').disabled
        && document.getElementById('status').textContent !== 'Running',
      null, { timeout: 60000 },
    );
  },
  consoleText: () => page.textContent('.console-lines'),
  status: () => page.textContent('#status'),
};

try {
  /* ---------------------------------------------------------- 1. boot */
  console.log('\n1. Pyodide boots and print() round-trips');
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 90000 });
  const bootWall = Date.now() - t0;

  const info = await page.evaluate(() => ({ ...document.body.dataset }));
  console.log(`       Python ${info.pythonVersion}, Pyodide ${info.pyodideVersion}`);
  console.log(`       worker boot ${info.bootMs} ms, cold page load ${bootWall} ms`);

  check('Python 3.14 reported', /^3\.14/.test(info.pythonVersion), `got ${info.pythonVersion}`);

  // Set our own source rather than relying on whatever the starter program is:
  // the starter changes as the project grows, and this test should not.
  await helpers.setCode('print("Hello from CPython in the browser!")\nfor i in range(1, 4):\n    print("line", i)\n');
  await helpers.run();
  let out = await helpers.consoleText();
  check('print() output reached the page', out.includes('Hello from CPython in the browser!'));
  check('loop output present', out.includes('line 1') && out.includes('line 3'));
  check('status reports success', (await helpers.status()).startsWith('Finished'));

  /* -------------------------------------------------- 2. syntax error */
  console.log('\n2. Syntax error: exact position, before execution');
  await helpers.setCode('print("before")\nfor i in range(3)\n    print(i)\n');
  await helpers.run();
  out = await helpers.consoleText();
  check('SyntaxError reported', out.includes('SyntaxError'), out.slice(0, 200));
  check("CPython's own message shown", out.includes("expected ':'"));
  check('located on line 2', out.includes('line 2'));
  check('gloss offered', out.includes('Python expects a colon'));
  check('nothing executed before the error', !out.includes('before'),
    'compile() pre-pass must run before exec()');
  // The editor gained a CodeMirror lint gutter in Phase 2; check the diagnostic
  // it was handed resolves to line 2 of the document.
  const diagLine = await page.evaluate(() => {
    const d = (window.__editor.lastDiagnostics ?? [])[0];
    if (!d) return null;
    return window.__editor.view.state.doc.lineAt(d.from).number;
  });
  check('error marked on line 2', diagLine === 2, `marked line ${diagLine}`);
  check('lint gutter shows a marker',
    await page.locator('.cm-lint-marker-error').count() > 0);

  /* ------------------------------------------- 3. indentation errors */
  console.log('\n3. Indentation errors');
  await helpers.setCode('def f():\n    a = 1\n      b = 2\n');
  await helpers.run();
  out = await helpers.consoleText();
  check('IndentationError reported', out.includes('IndentationError'), out.slice(0, 200));

  // Mixed tab/space, set directly so the paste sanitiser does not intervene.
  await helpers.setCode('def f():\n    a = 1\n\tb = 2\n');
  await helpers.run();
  out = await helpers.consoleText();
  check('TabError reported', out.includes('TabError'), out.slice(0, 200));
  check('gloss explains tabs vs spaces', out.includes('look identical on screen'));

  // And the repair path fixes it.
  await page.click('#normalize');
  await helpers.run();
  out = await helpers.consoleText();
  check('Clean up indentation repairs it', !out.includes('TabError'));
  check('status is now success', (await helpers.status()).startsWith('Finished'));

  /* ------------------------------------------------- 4. runtime error */
  console.log('\n4. Runtime traceback contains only the student\'s frames');
  await helpers.setCode('def inner():\n    return 1 / 0\n\ndef outer():\n    return inner()\n\nouter()\n');
  await helpers.run();
  out = await helpers.consoleText();
  check('ZeroDivisionError reported', out.includes('ZeroDivisionError'));
  check('student filename shown', out.includes('<your program>'));
  check('both student frames kept', (out.match(/<your program>/g) || []).length >= 3,
    'expected frames for outer(), inner() and module level');
  check('no harness frames leaked', !out.includes('_harness'));
  check('no pyodide frames leaked', !/pyodide|importlib|_pyodide/.test(out));
  // Source lines and anchors come from linecache; compile() does not populate
  // it, so this guards the _register_source() call in harness.py.
  check('source line shown for each frame', out.includes('return 1 / 0'));
  check('fine-grained caret preserved', out.includes('~~^~~'), 'CPython 3.11+ anchors');
  check('gloss offered', out.includes('divided by zero'));

  /* ----------------------------------------- 5. stop an infinite loop */
  console.log('\n5. Stop kills an infinite loop, spare takes over');
  await helpers.setCode('while True:\n    pass\n');
  await page.click('#run');
  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Running',
    null, { timeout: 15000 },
  );
  await page.waitForTimeout(1200);
  check('still running after 1.2 s', (await helpers.status()) === 'Running');

  const tStop = Date.now();
  await page.click('#stop');
  await page.waitForFunction(
    () => document.getElementById('status').textContent !== 'Running',
    null, { timeout: 15000 },
  );
  console.log(`       stop took ${Date.now() - tStop} ms`);
  check('page still responsive after an infinite loop', true);

  // The pre-warmed spare should make the next run work without a fresh boot.
  await page.waitForFunction(
    () => !document.getElementById('run').disabled, null, { timeout: 30000 },
  );
  const tNext = Date.now();
  await helpers.setCode('print("spare worker is alive")\n');
  await helpers.run();
  const spareMs = Date.now() - tNext;
  out = await helpers.consoleText();
  check('runs again after Stop', out.includes('spare worker is alive'));
  check(`spare avoided a cold boot (${spareMs} ms)`, spareMs < Number(info.bootMs),
    `took ${spareMs} ms vs a ${info.bootMs} ms cold boot`);

  /* -------------------------------------------------------- 6. hygiene */
  console.log('\n6. Page hygiene');
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('\n         '));

  await page.screenshot({ path: join(ROOT, 'test/phase0-screenshot.png'), fullPage: false });
  console.log('       screenshot -> test/phase0-screenshot.png');
} catch (err) {
  failed++;
  console.log(`\n  FAIL (threw) ${err.message}\n${err.stack}`);
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
