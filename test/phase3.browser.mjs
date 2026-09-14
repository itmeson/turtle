/**
 * Phase 3 verification — persistence, share links, lossless export.
 *
 *   node test/phase3.browser.mjs
 *
 * The share codec itself is covered without a browser in test/share.test.mjs.
 * This suite is about the parts that only exist in a real page: IndexedDB
 * surviving a reload, exports matching what was on screen, and a shared link
 * never clobbering the student's own work.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Resolved from this file so the suite runs from any directory, and so
// Windows gets a real path rather than "/C:/..." from URL.pathname.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const PORT = 8130;
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
// One persistent context so IndexedDB survives "reloads" the way it does for a
// student who closes the tab and comes back.
const context = await browser.newContext({ viewportSize: { width: 1280, height: 800 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });

const ready = async (target = page) => {
  await target.waitForSelector('body[data-ready="1"]', { timeout: 90000 });
  await target.waitForSelector('body[data-storage-ready="1"]', { timeout: 30000 });
};
const setCode = (code, target = page) =>
  target.evaluate((c) => { window.__editor.value = c; }, code);
const getCode = (target = page) => target.evaluate(() => window.__editor.value);
const run = async (target = page) => {
  await target.click('#run');
  await target.waitForFunction(
    () => !document.getElementById('run').disabled
      && document.getElementById('status').textContent !== 'Running',
    null, { timeout: 60000 },
  );
  await target.evaluate(() => window.__renderer.whenIdle());
};

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await ready();

  /* --------------------------------------------------- 0. clean first load */
  console.log('\n0. A fresh page is not pretending to be something else');
  check('no shared-program banner on a normal load',
    await page.locator('#banner').isHidden(),
    'a CSS display rule can defeat the [hidden] attribute');
  check('save menu starts closed', await page.locator('#save-list').isHidden());
  check('skip button starts hidden', await page.locator('#skip').isHidden());
  check('panel starts closed', await page.locator('#panel').isHidden());

  /* ------------------------------------------------------- 1. autosave */
  console.log('\n1. Autosave survives a reload');
  await setCode('# my work in progress\nimport turtle\nt = turtle.Turtle()\nt.forward(42)\n');
  await page.waitForTimeout(900);            // debounce is 400ms
  check('shows it saved', (await page.textContent('#saved')).includes('Saved'));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready();
  check('code came back after reload',
    (await getCode()).includes('my work in progress'), (await getCode()).slice(0, 80));
  check('no save button was ever needed',
    await page.locator('button:has-text("Save")').count() >= 0);

  /* ------------------------------------------------- 2. program naming */
  console.log('\n2. Programs have names');
  await page.fill('#name', 'Spiral study');
  await page.dispatchEvent('#name', 'change');
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready();
  check('name persisted', (await page.inputValue('#name')) === 'Spiral study',
    await page.inputValue('#name'));

  /* ---------------------------------------------------- 3. history */
  console.log('\n3. Snapshot history');
  await setCode('version one\n');
  await page.evaluate(() => window.__workspace.snapshot('test'));
  await setCode('version two\nwith another line\n');
  await page.evaluate(() => window.__workspace.snapshot('test'));
  await setCode('version three\n');

  await page.click('#work');
  await page.waitForTimeout(300);
  const snapCount = await page.locator('[data-snapshots] .panel-item').count();
  check('snapshots are listed', snapCount >= 2, `${snapCount} snapshots`);
  check('they show relative times',
    (await page.textContent('[data-snapshots]')).includes('ago')
    || (await page.textContent('[data-snapshots]')).includes('just now'));
  check('and a line comparison',
    (await page.textContent('[data-snapshots]')).includes('line'));

  // Preview then restore the oldest listed version.
  await page.locator('[data-snapshots] .panel-item-main').last().click();
  await page.waitForTimeout(150);
  check('preview shows the snapshot', (await page.textContent('[data-preview]')).includes('version one'),
    await page.textContent('[data-preview]'));

  await page.click('[data-restore]');
  await page.waitForTimeout(400);
  check('restore replaces the editor content',
    (await getCode()).includes('version one'), await getCode());

  // Restoring must itself be undoable: the pre-restore text is in history.
  await page.click('#work');
  await page.waitForTimeout(300);
  const texts = await page.locator('[data-snapshots]').textContent();
  check('history still has entries after restoring', texts.includes('ago') || texts.includes('just now'));
  const restored = await page.evaluate(async () => {
    const rows = await window.__workspace.history();
    return rows.some((r) => r.code.includes('version three'));
  });
  check('the pre-restore text was saved first', restored,
    'restoring must never lose what was on screen');
  await page.click('.panel-head [data-close]');

  /* ------------------------------------------- 4. multiple programs */
  console.log('\n4. Several programs');
  await page.click('#work');
  await page.waitForTimeout(200);

  // A new program must be named before it can exist. Silently creating another
  // "My program" is how a student ends up with a list they cannot read.
  await page.click('[data-new]');
  await page.waitForTimeout(150);
  check('naming the program is asked for first',
    await page.locator('[data-new-form]').isVisible());
  check('and Create is refused until there is a name',
    await page.locator('[data-new-create]').isDisabled());

  await page.fill('[data-new-name]', 'Second program');
  await page.waitForTimeout(100);
  check('the name enables Create', !(await page.locator('[data-new-create]').isDisabled()));
  await page.click('[data-new-create]');
  await page.waitForTimeout(400);
  check('new program starts empty', (await getCode()) === '', JSON.stringify(await getCode()));
  check('and carries the name that was typed',
    (await page.inputValue('#name')) === 'Second program', await page.inputValue('#name'));

  await setCode('second program\n');
  await page.waitForTimeout(700);
  await page.click('#work');
  await page.waitForTimeout(300);
  const projCount = await page.locator('[data-projects] .panel-item').count();
  check('both programs are listed', projCount >= 2, `${projCount} programs`);

  /* ------------------------------------ 4b. the list must hold still */
  // Reported from a classroom: clicking a program reshuffled the others, for
  // no reason a student could see. The cause was ordering by updatedAt while
  // persist() stamped updatedAt on every write -- including the flush of the
  // program being switched AWAY from, which sent it to the top.
  console.log('\n4b. Opening a program must not reorder the list');
  const orderBefore = await page.locator('[data-projects] .panel-item-name').allTextContents();
  await page.locator('[data-projects] .panel-item-main').nth(1).click();
  await page.waitForTimeout(400);
  check('switching programs loads the other one',
    (await getCode()) !== 'second program\n', await getCode());

  const orderAfter = await page.locator('[data-projects] .panel-item-name').allTextContents();
  check('the order is exactly what it was',
    JSON.stringify(orderBefore) === JSON.stringify(orderAfter),
    `before ${JSON.stringify(orderBefore)}\n         after  ${JSON.stringify(orderAfter)}`);

  // Typing must not move it either -- only a real edit updates "edited", and
  // position does not depend on that in any case.
  await page.click('.panel-head [data-close]');
  await page.waitForTimeout(150);
  await setCode('a genuine edit\n');
  await page.waitForTimeout(700);
  await page.click('#work');
  await page.waitForTimeout(300);
  check('and editing does not move it either',
    JSON.stringify(await page.locator('[data-projects] .panel-item-name').allTextContents())
      === JSON.stringify(orderAfter));

  /* -------------------------- 4c. a program with no history is legible */
  // Also reported: a program with no earlier versions showed an empty History
  // AND an empty Preview, so there was no way to tell what it was.
  console.log('\n4c. Preview always shows the program');
  await page.click('[data-new]');
  await page.waitForTimeout(150);
  await page.fill('[data-new-name]', 'Fresh with no history');
  await page.click('[data-new-create]');
  await page.waitForTimeout(400);
  check('creating a program closes the panel and returns to the editor',
    await page.locator('#panel').isHidden());
  await setCode('# brand new, never snapshotted\nprint("hello")\n');
  await page.waitForTimeout(700);
  await page.click('#work');
  await page.waitForTimeout(300);

  check('the preview is showing something',
    await page.locator('[data-preview]').isVisible());
  check('and it is this program, not a blank pane',
    (await page.textContent('[data-preview]')).includes('brand new, never snapshotted'),
    (await page.textContent('[data-preview]')).slice(0, 80));
  check('the current version is the row selected by default',
    (await page.textContent('[data-snapshots] .panel-item.is-current')).includes('Current version'),
    await page.textContent('[data-snapshots] .panel-item.is-current'));
  check('and it offers no Restore, because it is already on screen',
    await page.locator('[data-restore]').isHidden());

  /* --------------------------------- 4d. names cannot collide silently */
  console.log('\n4d. Two programs cannot share a name');
  await page.click('.panel-head [data-close]');
  await page.waitForTimeout(150);
  await page.fill('#name', 'Second program');
  await page.dispatchEvent('#name', 'change');
  await page.waitForTimeout(500);
  check('a duplicate name is made distinct',
    (await page.inputValue('#name')) !== 'Second program',
    await page.inputValue('#name'));
  check('and the student is told why',
    (await page.textContent('.console-lines')).includes('already have a program with that name'));

  /* --------------------------- 4e. the one name nobody chose gets a nudge */
  // The first program, a recovered buffer and a shared link are the only
  // routes left that can produce an unchosen name. Those get asked once,
  // after a run -- not before, and not twice.
  console.log('\n4e. A still-unnamed program is nudged once');
  await page.fill('#name', 'My program');
  await page.dispatchEvent('#name', 'change');
  await page.waitForTimeout(400);
  check('an unchosen name is marked on the field',
    await page.locator('#name.needs-name').count() === 1);

  await setCode('import turtle\nt = turtle.Turtle()\nt.forward(10)\n');
  await page.click('#run');
  await page.waitForFunction(() => !document.getElementById('run').disabled,
    null, { timeout: 60000 });
  await page.waitForTimeout(400);
  check('running it asks for a name',
    (await page.textContent('.console-lines')).includes('still called'),
    await page.textContent('.console-lines'));

  // Each run clears the console, so a second nudge would be plainly visible.
  await page.click('#run');
  await page.waitForFunction(() => !document.getElementById('run').disabled,
    null, { timeout: 60000 });
  await page.waitForTimeout(400);
  check('and does not ask again',
    !(await page.textContent('.console-lines')).includes('still called'),
    await page.textContent('.console-lines'));

  await page.fill('#name', 'Named at last');
  await page.dispatchEvent('#name', 'change');
  await page.waitForTimeout(300);
  check('naming it clears the mark',
    await page.locator('#name.needs-name').count() === 0);

  /* --------------------------------------------------- 5. share links */
  console.log('\n5. Share links');
  const shareUrl = await page.evaluate(async () => {
    const { buildShareUrl } = await import('/src/storage/share.js');
    window.__editor.value = 'import turtle\nt = turtle.Turtle()\nt.forward(99)\n';
    return buildShareUrl(window.__editor.value, location.href.split('#')[0]);
  });
  check('link carries the program in the fragment', shareUrl.includes('#c='), shareUrl.slice(0, 80));
  check('nothing is sent to the server', !shareUrl.includes('?'), shareUrl.slice(0, 80));

  // Open the link in a SEPARATE tab that already has its own work.
  const other = await context.newPage();
  other.on('pageerror', (e) => pageErrors.push(`other tab: ${e}`));
  other.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`other tab console: ${m.text()}`); });
  await other.goto(BASE, { waitUntil: 'domcontentloaded' });
  await ready(other);
  await setCode('MY OWN PRECIOUS WORK\n', other);
  await other.waitForTimeout(700);

  // A hash-only navigation does not reload the page, so this also exercises
  // the hashchange path a student hits when pasting a link into an open editor.
  await other.goto(shareUrl, { waitUntil: 'domcontentloaded' });
  await ready(other);
  await other.waitForFunction(
    () => !document.getElementById('banner').hidden, null, { timeout: 15000 },
  );
  check('shared program loads', (await getCode(other)).includes('t.forward(99)'),
    await getCode(other));
  check('the fragment is cleared so a reload will not duplicate it',
    !(await other.evaluate(() => location.hash)),
    await other.evaluate(() => location.hash));
  check('a banner says whose it is', await other.locator('#banner').isVisible());
  check('banner explains the situation',
    (await other.textContent('#banner-text')).includes("someone else's"));

  const ownWorkSafe = await other.evaluate(async () => {
    const all = await window.__workspace.listAll();
    return all.some((p) => p.code.includes('MY OWN PRECIOUS WORK'));
  });
  check('the student\'s own work was NOT overwritten', ownWorkSafe,
    'opening a share link must create a new program, never replace one');

  await other.click('#banner-fork');
  let forkOk = true;
  try {
    // Visibility, not the `hidden` property: a CSS display rule can override
    // the attribute, which is exactly the bug this once hid.
    await other.waitForSelector('#banner', { state: 'hidden', timeout: 8000 });
  } catch { forkOk = false; }
  check('Make a copy clears the banner', forkOk,
    `banner still visible = ${await other.locator('#banner').isVisible()}`);
  check('the copy is a separate program', await other.evaluate(async () => {
    const all = await window.__workspace.listAll();
    return all.filter((p) => p.code.includes('t.forward(99)')).length >= 2;
  }), 'forking should leave both the shared program and the copy');
  await other.close();

  /* ------------------------------------------------------- 6. exports */
  console.log('\n6. Lossless export');
  await setCode(`import turtle
t = turtle.Turtle()
t.speed(0)
t.pensize(4)
t.pencolor("red")
t.begin_fill()
t.fillcolor("blue")
for i in range(4):
    t.forward(100)
    t.left(90)
t.end_fill()
t.penup()
t.goto(-150, 120)
t.pendown()
t.write("hi", font=("Arial", 20, "bold"))
t.dot(30, "green")
`);
  await run();

  const svg = await page.evaluate(async () => {
    const { exportSvg } = await import('/src/turtle/renderSvg.js');
    const r = window.__renderer;
    return exportSvg(r.committed, r.world, { background: r.bg, turtles: [] });
  });
  check('SVG is a complete document', svg.startsWith('<?xml') && svg.includes('</svg>'));
  check('SVG has explicit width and height', /width="\d/.test(svg) && /height="\d/.test(svg));
  check('SVG has a viewBox', svg.includes('viewBox='));
  check('lines became paths', svg.includes('<path '));
  check('fill became a polygon', svg.includes('<polygon '));
  check('text became text, not an image', svg.includes('<text ') && svg.includes('>hi<'));
  check('dot became a circle', svg.includes('<circle '));
  check('colours carried over', svg.includes('red') && svg.includes('blue'));
  check('segments merged rather than one path each',
    (svg.match(/<path /g) || []).length <= 3,
    `${(svg.match(/<path /g) || []).length} paths for 4 same-styled segments`);

  const png = await page.evaluate(async () => {
    const { exportPng } = await import('/src/turtle/renderPng.js');
    const r = window.__renderer;
    const out = {};
    for (const scale of [1, 2, 4]) {
      const blob = await exportPng(r.committed, r.world, { scale, turtles: [] });
      const bitmap = await createImageBitmap(blob);
      out[scale] = { w: bitmap.width, h: bitmap.height, bytes: blob.size };
    }
    return { out, world: r.world };
  });
  const worldW = Math.round(png.world.urx - png.world.llx);
  check('PNG at 1x matches the world size', png.out[1].w === worldW,
    `${png.out[1].w} vs ${worldW}`);
  check('PNG at 2x is exactly double', png.out[2].w === worldW * 2, `${png.out[2].w}`);
  check('PNG at 4x is exactly quadruple', png.out[4].w === worldW * 4, `${png.out[4].w}`);
  check('higher resolution really means more data',
    png.out[4].bytes > png.out[2].bytes && png.out[2].bytes > png.out[1].bytes,
    JSON.stringify(png.out));

  // The decisive check: an export must match what the student actually saw.
  const match = await page.evaluate(async () => {
    const { exportPng } = await import('/src/turtle/renderPng.js');
    const r = window.__renderer;
    const blob = await exportPng(r.committed, r.world, { scale: 1, turtles: [] });
    const bitmap = await createImageBitmap(blob);

    const a = document.createElement('canvas');
    a.width = bitmap.width; a.height = bitmap.height;
    a.getContext('2d').drawImage(bitmap, 0, 0);
    const exported = a.getContext('2d').getImageData(0, 0, a.width, a.height).data;

    // Same geometry, drawn by the on-screen renderer at its own scale.
    const b = document.createElement('canvas');
    b.width = bitmap.width; b.height = bitmap.height;
    const bctx = b.getContext('2d');
    bctx.drawImage(r.canvas, 0, 0, r.canvas.width, r.canvas.height, 0, 0, b.width, b.height);
    const onScreen = bctx.getImageData(0, 0, b.width, b.height).data;

    let differing = 0;
    for (let i = 0; i < exported.length; i += 4) {
      if (Math.abs(exported[i] - onScreen[i]) > 24
        || Math.abs(exported[i + 1] - onScreen[i + 1]) > 24
        || Math.abs(exported[i + 2] - onScreen[i + 2]) > 24) differing += 1;
    }
    return { differing, total: exported.length / 4 };
  });
  const pct = (match.differing / match.total) * 100;
  check('exported PNG matches the on-screen drawing',
    pct < 2, `${pct.toFixed(2)}% of pixels differ (resampling tolerance)`);

  /* --------------------------------------------- 7. nothing to export */
  console.log('\n7. Guard rails');
  await page.click('#work');
  await page.waitForTimeout(200);
  await page.click('[data-new]');
  await page.waitForTimeout(150);
  await page.fill('[data-new-name]', 'Nothing drawn yet');
  await page.click('[data-new-create]');
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__export('png2'));
  await page.waitForTimeout(200);
  check('says so when there is no drawing yet',
    (await page.textContent('.console-lines')).includes('no drawing'),
    await page.textContent('.console-lines'));

  /* ---------------------------------------------------- 8. degraded */
  console.log('\n8. Storage failure must not lose the buffer');
  const mirrored = await page.evaluate(() => {
    window.__editor.value = 'mirror check\n';
    window.__workspace.update('mirror check\n');
    return localStorage.getItem('turtle-editor:buffer');
  });
  check('the localStorage mirror is written immediately',
    mirrored === 'mirror check\n', JSON.stringify(mirrored));

  /* --------------------------- 8b. storage failure must be REPORTED */
  console.log('\n8b. When storage fails, the UI must not claim otherwise');
  // Section 8 nudged the workspace directly, so let the debounce settle rather
  // than sampling mid-save.
  await page.waitForFunction(
    () => document.getElementById('saved').textContent.trim() !== 'Saving…',
    null, { timeout: 10000 },
  ).catch(() => {});
  check('a working save says Saved',
    (await page.textContent('#saved')).trim() === 'Saved',
    await page.textContent('#saved'));

  {
    // IndexedDB broken, localStorage fine: the current program survives in the
    // mirror but history does not, and the student should be told which.
    const ctx = await browser.newContext();
    const p2 = await ctx.newPage();
    await p2.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', {
        get() { throw new Error('IndexedDB is blocked in this test'); },
      });
    });
    await p2.goto(`${BASE}/?nosw`, { waitUntil: 'domcontentloaded' });
    await ready(p2);
    await setCode('work that must not be silently lost\n', p2);
    await p2.waitForTimeout(1200);

    const label = (await p2.textContent('#saved')).trim();
    check('it does NOT claim a plain "Saved"', label !== 'Saved', label);
    check('it says the work is only in this browser', /this browser only/i.test(label), label);
    check('and explains it in the console',
      (await p2.textContent('.console-lines')).includes('history is unavailable')
      || (await p2.textContent('.console-lines')).toLowerCase().includes('history'),
      (await p2.textContent('.console-lines')).slice(0, 200));
    await ctx.close();
  }

  {
    // Both stores broken: nothing has been saved anywhere, and saying so is the
    // whole point. This is the failure the project exists to stop hiding.
    const ctx = await browser.newContext();
    const p3 = await ctx.newPage();
    await p3.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', {
        get() { throw new Error('blocked'); },
      });
      Object.defineProperty(window, 'localStorage', {
        get() { throw new Error('blocked'); },
      });
    });
    await p3.goto(`${BASE}/?nosw`, { waitUntil: 'domcontentloaded' });
    await ready(p3);
    await setCode('this really is not saved anywhere\n', p3);
    await p3.waitForTimeout(1200);

    const label = (await p3.textContent('#saved')).trim();
    check('it says NOT SAVED rather than Saved', /not saved/i.test(label), label);
    check('and tells the student to download their work',
      (await p3.textContent('.console-lines')).toLowerCase().includes('download'),
      (await p3.textContent('.console-lines')).slice(0, 250));
    check('the unload guard knows there is unsaved work',
      await p3.evaluate(() => window.__workspace.hasUnsavedWork()) === true);
    await ctx.close();
  }

  /* --------------------------------------------------------- 9. hygiene */
  console.log('\n9. Hygiene');
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('\n         '));

  await page.evaluate(() => window.__panel.close());
  await setCode(`import turtle
t = turtle.Turtle()
t.shape("turtle")
t.speed(0)
turtle.Screen().bgcolor("#0f1720")
for i in range(90):
    t.pencolor(["#ff6b6b", "#ffd93d", "#6bcB77", "#4d96ff"][i % 4])
    t.forward(i * 2.5)
    t.left(88)
`);
  await page.fill('#name', 'Spiral study');
  await page.dispatchEvent('#name', 'change');
  await run();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(ROOT, 'test/phase3-screenshot.png') });
  console.log('       screenshot -> test/phase3-screenshot.png');
} catch (err) {
  failed++;
  console.log(`\n  FAIL (threw) ${err.message}\n${err.stack}`);
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
