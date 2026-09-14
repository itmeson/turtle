/**
 * Phase 2 verification — CodeMirror editor.
 *
 *   node test/phase2.browser.mjs
 *
 * Covers the three things CodeMirror was brought in for: syntax highlighting,
 * exact inline error ranges, and visible whitespace. Plus the indentation
 * behaviour carried over from the textarea, which must not have regressed.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Resolved from this file so the suite runs from any directory, and so
// Windows gets a real path rather than "/C:/..." from URL.pathname.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const PORT = 8129;
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
const page = await browser.newPage({ viewportSize: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });

const setCode = (code) => page.evaluate((c) => { window.__editor.value = c; }, code);
const getCode = () => page.evaluate(() => window.__editor.value);
const run = async () => {
  await page.click('#run');
  await page.waitForFunction(
    () => !document.getElementById('run').disabled
      && document.getElementById('status').textContent !== 'Running',
    null, { timeout: 60000 },
  );
  await page.evaluate(() => window.__renderer.whenIdle());
};

/** Type into the editor with real key events. */
const typeIn = async (text) => {
  await page.click('.cm-content');
  await page.keyboard.type(text);
};

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 90000 });

  /* ------------------------------------------------------- 1. it mounted */
  console.log('\n1. CodeMirror is mounted');
  check('editor surface exists', await page.locator('.cm-editor').count() === 1);
  check('line numbers present', await page.locator('.cm-gutters').count() >= 1);
  check('no textarea left behind', await page.locator('#editor textarea.editor-area').count() === 0);
  check('starter program loaded', (await getCode()).includes('import turtle'));

  /* ------------------------------------------------- 2. syntax highlight */
  console.log('\n2. Python syntax highlighting');
  await setCode('def greet(name):\n    # a comment\n    count = 42\n    return "hello " + name\n');
  await page.waitForTimeout(150);

  const colours = await page.evaluate(() => {
    const seen = {};
    for (const el of document.querySelectorAll('.cm-content span')) {
      const t = el.textContent;
      if (!t || !t.trim()) continue;
      const c = getComputedStyle(el).color;
      if (!seen[t.trim()]) seen[t.trim()] = c;
    }
    return seen;
  });
  const distinct = new Set(Object.values(colours));
  check('tokens are coloured distinctly', distinct.size >= 4,
    `${distinct.size} distinct colours: ${JSON.stringify(colours).slice(0, 300)}`);
  check('keyword "def" is styled', colours.def && colours.def !== 'rgb(28, 32, 36)',
    `def -> ${colours.def}`);
  check('comment is styled', Object.entries(colours).some(([t, c]) => t.startsWith('#') && c !== 'rgb(28, 32, 36)'));

  /* ------------------------------------------------ 3. NO autocompletion */
  console.log('\n3. No autocompletion, at all');
  await setCode('import turtle\nt = turtle.Tur');
  await page.click('.cm-content');
  await page.keyboard.press('End');
  await page.keyboard.type('t');
  await page.waitForTimeout(400);
  check('no completion popup appears', await page.locator('.cm-tooltip-autocomplete').count() === 0);
  await page.keyboard.press('Control+Space');
  await page.waitForTimeout(400);
  check('Ctrl-Space does not summon one', await page.locator('.cm-tooltip-autocomplete').count() === 0);

  /* --------------------------------------------------- 4. indent by keys */
  console.log('\n4. Tab indents with spaces, never a tab character');
  await setCode('');
  await typeIn('x = 1');
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  let code = await getCode();
  check('Tab inserted spaces', code === '    x = 1', JSON.stringify(code));
  check('no tab character anywhere', !code.includes('\t'));

  await page.keyboard.press('Shift+Tab');
  code = await getCode();
  check('Shift-Tab dedents', code === 'x = 1', JSON.stringify(code));

  console.log('\n5. Enter auto-indents inside a block');
  await setCode('');
  await typeIn('for i in range(3):');
  await page.keyboard.press('Enter');
  await page.keyboard.type('print(i)');
  code = await getCode();
  check('line after a colon is indented', code === 'for i in range(3):\n    print(i)',
    JSON.stringify(code));

  /* --------------------------------------------------- 6. paste cleaning */
  console.log('\n6. Paste sanitising still works (the whole point of the project)');
  const NBSP = String.fromCharCode(0x00A0);
  await setCode('');
  await page.evaluate(async (nbsp) => {
    const view = window.__editor.view;
    view.focus();
    const dirty = `def f():\n${nbsp}${nbsp}${nbsp}${nbsp}return 1\n`;
    const dt = new DataTransfer();
    dt.setData('text/plain', dirty);
    view.contentDOM.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true,
    }));
  }, NBSP);
  await page.waitForTimeout(200);
  code = await getCode();
  check('non-breaking spaces replaced on paste', !code.includes(NBSP), JSON.stringify(code));
  check('indentation preserved as real spaces', code.includes('\n    return 1'), JSON.stringify(code));
  check('student is told what was cleaned',
    (await page.textContent('.console-lines')).includes('non-breaking'),
    await page.textContent('.console-lines'));

  await setCode('');
  await page.evaluate(async () => {
    const view = window.__editor.view;
    view.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', 'def f():\n\treturn 1\n');
    view.contentDOM.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true,
    }));
  });
  await page.waitForTimeout(200);
  code = await getCode();
  check('tabs expanded on paste', !code.includes('\t') && code.includes('    return 1'),
    JSON.stringify(code));

  /* --------------------------------------------- 7. exact error ranges */
  console.log('\n7. Errors underline the exact characters');
  await setCode('print("ok")\nfor i in range(3)\n    print(i)\n');
  await run();
  await page.waitForTimeout(200);

  const marked = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.cm-lintRange-error')];
    return els.map((e) => e.textContent);
  });
  check('an error range is marked', marked.length > 0, JSON.stringify(marked));
  check('the mark is on the offending line, not the whole file',
    marked.join('').length < 30, JSON.stringify(marked));
  // CPython points just past the end of the line for a missing colon; the
  // editor backs up one character so there is something visible to underline.
  check('the underline sits at the end of the broken line',
    marked.join('') === ')', JSON.stringify(marked));

  const gutterMarks = await page.locator('.cm-lint-marker-error').count();
  check('gutter shows an error marker', gutterMarks > 0, `${gutterMarks} markers`);

  await setCode('print("fine")\n');
  await run();
  check('errors clear on a clean run',
    await page.locator('.cm-lintRange-error').count() === 0);

  /* --------------------------------- 8. quick fix for indentation errors */
  console.log('\n8. TabError offers a one-click fix');
  await setCode('def f():\n    a = 1\n\tb = 2\nf()\n');
  await run();
  await page.waitForTimeout(200);
  check('TabError reported', (await page.textContent('.console-lines')).includes('TabError'));

  // The quick fix lives in the lint tooltip; check the diagnostic carries it.
  const hasAction = await page.evaluate(() => {
    const d = (window.__editor.lastDiagnostics ?? [])[0];
    return Boolean(d && d.actions && d.actions.length
      && d.actions[0].name === 'Clean up indentation');
  });
  check('quick fix attached to the diagnostic', hasAction,
    'showError() should attach a "Clean up indentation" action for TabError');

  /* ------------------------------------------------ 9. visible whitespace */
  console.log('\n9. Visible whitespace');
  await setCode('def f():\n    return 1\n');
  await page.waitForTimeout(150);

  const wsOffInitially = await page.locator('.cm-ws-indent').count();
  check('space dots are off by default', wsOffInitially === 0, `${wsOffInitially} marks`);

  await page.click('#ws');
  await page.waitForTimeout(200);
  check('toggle turns space dots on', await page.locator('.cm-ws-indent').count() > 0);
  check('button reflects the state',
    (await page.getAttribute('#ws', 'aria-pressed')) === 'true'
    && (await page.textContent('#ws')).includes('Hide'));

  await page.click('#ws');
  await page.waitForTimeout(200);
  check('toggle turns them off again', await page.locator('.cm-ws-indent').count() === 0);

  // Tabs must be visible whether or not the toggle is on.
  await setCode('def f():\n\treturn 1\n');
  await page.waitForTimeout(200);
  check('a tab is marked even with the toggle off',
    await page.locator('.cm-ws-tab').count() > 0,
    'a tab in Python source should never be invisible');

  /* ------------------------------------------- 10. clean up indentation */
  console.log('\n10. Clean up indentation command');
  await setCode('def f():\n\ta = 1\n\treturn a\n');
  await page.click('#normalize');
  await page.waitForTimeout(200);
  code = await getCode();
  check('tabs converted', !code.includes('\t') && code.includes('    a = 1'), JSON.stringify(code));
  check('reports what it changed',
    (await page.textContent('.console-lines')).includes('tabs'),
    await page.textContent('.console-lines'));

  await page.click('#normalize');
  await page.waitForTimeout(200);
  check('says so when nothing needs fixing',
    (await page.textContent('.console-lines')).includes('already clean'));

  /* ------------------------------------------------ 11. still runs code */
  console.log('\n11. The editor still drives Python');
  await setCode('import turtle\nt = turtle.Turtle()\nt.speed(0)\nt.forward(80)\nprint("drew")\n');
  await run();
  check('program runs from the new editor',
    (await page.textContent('.console-lines')).includes('drew'));
  check('turtle still draws',
    (await page.evaluate(() => window.__renderer.committed.filter((o) => o.op === 'line').length)) === 1);

  const undoWorks = await page.evaluate(async () => {
    const before = window.__editor.value;
    window.__editor.view.focus();
    window.__editor.view.dispatch({ changes: { from: 0, insert: '# scratch\n' } });
    const dirty = window.__editor.value;
    return { changed: dirty !== before };
  });
  check('edits dispatch normally', undoWorks.changed);

  /* --------------------------------------------------------- 12. hygiene */
  console.log('\n12. Hygiene');
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('\n         '));

  // Visual reference: highlighting + visible whitespace + an error underline.
  await setCode(`import turtle

def spiral(t, turns):
    # draw a coloured spiral
    for i in range(turns):
        t.pencolor("teal")
        t.forward(i * 3)
        t.right(91)

t = turtle.Turtle()
spiral(t, 60)
\tt.hideturtle()
`);
  await page.click('#ws');
  await run();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(ROOT, 'test/phase2-screenshot.png') });
  console.log('       screenshot -> test/phase2-screenshot.png');
} catch (err) {
  failed++;
  console.log(`\n  FAIL (threw) ${err.message}\n${err.stack}`);
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
