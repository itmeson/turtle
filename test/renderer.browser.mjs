/**
 * Renderer verification against a synthetic op stream.
 *
 * Deliberately independent of the Python shim: if a drawing comes out wrong,
 * this says whether the fault is in the renderer or in turtle.py.
 *
 *   node test/renderer.browser.mjs
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Resolved from this file so the suite runs from any directory, and so
// Windows gets a real path rather than "/C:/..." from URL.pathname.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const PORT = 8126;
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
const page = await browser.newPage({ viewportSize: { width: 640, height: 640 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

/** Colour of a pixel at a CSS-space point on the canvas. */
const pixelAt = (x, y) => page.evaluate(([px, py]) => {
  const c = document.getElementById('c');
  const d = window.devicePixelRatio || 1;
  const ctx = c.getContext('2d');
  const p = ctx.getImageData(Math.round(px * d), Math.round(py * d), 1, 1).data;
  return [p[0], p[1], p[2], p[3]];
}, [x, y]);

const near = (a, b, tol = 12) => Math.abs(a - b) <= tol;
const isColor = (px, [r, g, b]) => near(px[0], r) && near(px[1], g) && near(px[2], b);

try {
  await page.goto(`${BASE}/test/renderer-harness.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-ready="1"]');

  /* --------------------------------------------------- coordinate system */
  console.log('\n1. Coordinate system: y-up, origin centred');
  // World is 600x600 centred, canvas is 600x600 CSS -> 1:1.
  await page.evaluate(() => window.__feed([
    { op: 'bgcolor', color: '#ffffff' },
    // A horizontal red line along y = +100 (should appear ABOVE centre).
    { op: 'line', x1: -200, y1: 100, x2: 200, y2: 100, color: '#ff0000', width: 6 },
    // A vertical blue line along x = +100 (should appear RIGHT of centre).
    { op: 'line', x1: 100, y1: -200, x2: 100, y2: 200, color: '#0000ff', width: 6 },
  ]));

  check('origin maps to canvas centre (background there)', isColor(await pixelAt(300, 300), [255, 255, 255]));
  check('y=+100 is ABOVE centre', isColor(await pixelAt(300, 200), [255, 0, 0]),
    JSON.stringify(await pixelAt(300, 200)));
  check('y=+100 is not below centre', !isColor(await pixelAt(300, 400), [255, 0, 0]));
  check('x=+100 is RIGHT of centre', isColor(await pixelAt(400, 300), [0, 0, 255]),
    JSON.stringify(await pixelAt(400, 300)));
  check('x=+100 is not left of centre', !isColor(await pixelAt(200, 300), [0, 0, 255]));

  /* ------------------------------------------------------------- filling */
  console.log('\n2. Fills and dots');
  await page.evaluate(() => {
    window.__r.reset({ llx: -300, lly: -300, urx: 300, ury: 300 });
    window.__feed([
      { op: 'bgcolor', color: '#ffffff' },
      { op: 'poly', pts: [[-100, -100], [100, -100], [100, 100], [-100, 100]], fill: '#00aa00' },
      { op: 'dot', x: -200, y: 200, d: 40, color: '#ff00ff' },
    ]);
  });
  check('polygon fill present at its centre', isColor(await pixelAt(300, 300), [0, 170, 0]));
  check('polygon does not leak outside', isColor(await pixelAt(300, 150), [255, 255, 255]));
  check('dot drawn at (-200, +200)', isColor(await pixelAt(100, 100), [255, 0, 255]));

  /* ------------------------------------------------------ background op */
  console.log('\n3. Background colour');
  await page.evaluate(() => {
    window.__r.reset({ llx: -300, lly: -300, urx: 300, ury: 300 });
    window.__feed([{ op: 'bgcolor', color: '#000080' }]);
  });
  check('bgcolor fills the canvas', isColor(await pixelAt(20, 20), [0, 0, 128]));

  /* -------------------------------------------------------------- stamps */
  console.log('\n4. Turtle cursor orientation');
  // A "classic" turtle at the origin heading east (0 degrees). The shape is
  // defined pointing up in its own frame, so its tip must land to the RIGHT.
  await page.evaluate(() => {
    window.__r.reset({ llx: -60, lly: -60, urx: 60, ury: 60 });
    window.__feed(
      [{ op: 'bgcolor', color: '#ffffff' }],
      [{ x: 0, y: 0, heading: 0, visible: true, shape: 'triangle',
         fill: '#ff0000', pen: '#000000', stretch: [3, 3], outline: 1, tilt: 0 }],
    );
  });
  {
    // World is 120 units across mapped to 600px, so 1 unit = 5px.
    // triangle tip is at (0, 11.55) in shape space -> heading 0 puts it at +x.
    const ahead = await pixelAt(300 + 11.55 * 3 * 5 * 0.6, 300);
    const behind = await pixelAt(300 - 11.55 * 3 * 5 * 0.9, 300);
    check('cursor points along heading 0 (east)', isColor(ahead, [255, 0, 0]), JSON.stringify(ahead));
    check('cursor tail is not ahead of it', isColor(behind, [255, 255, 255]), JSON.stringify(behind));
  }

  await page.evaluate(() => {
    window.__r.reset({ llx: -60, lly: -60, urx: 60, ury: 60 });
    window.__feed(
      [{ op: 'bgcolor', color: '#ffffff' }],
      [{ x: 0, y: 0, heading: 90, visible: true, shape: 'triangle',
         fill: '#ff0000', pen: '#000000', stretch: [3, 3], outline: 1, tilt: 0 }],
    );
  });
  {
    const ahead = await pixelAt(300, 300 - 11.55 * 3 * 5 * 0.6);
    check('cursor points along heading 90 (north)', isColor(ahead, [255, 0, 0]), JSON.stringify(ahead));
  }

  /* ------------------------------------------------------- hidden turtle */
  await page.evaluate(() => {
    window.__r.reset({ llx: -60, lly: -60, urx: 60, ury: 60 });
    window.__feed(
      [{ op: 'bgcolor', color: '#ffffff' }],
      [{ x: 0, y: 0, heading: 0, visible: false, shape: 'triangle',
         fill: '#ff0000', pen: '#000000', stretch: [3, 3], outline: 1, tilt: 0 }],
    );
  });
  check('hidden turtle is not drawn', isColor(await pixelAt(300, 300), [255, 255, 255]));

  /* ------------------------------------------------------------ setworld */
  console.log('\n5. setworldcoordinates rescales');
  await page.evaluate(() => {
    window.__r.reset({ llx: -300, lly: -300, urx: 300, ury: 300 });
    window.__feed([
      { op: 'bgcolor', color: '#ffffff' },
      { op: 'setworld', llx: 0, lly: 0, urx: 10, ury: 10 },
      { op: 'poly', pts: [[0, 0], [5, 0], [5, 5], [0, 5]], fill: '#00aa00' },
    ]);
  });
  check('unit square fills the lower-left quadrant', isColor(await pixelAt(150, 450), [0, 170, 0]));
  check('upper-right quadrant is empty', isColor(await pixelAt(450, 150), [255, 255, 255]));

  /* ----------------------------------------------------------- animation */
  console.log('\n6. Speed pacing follows CPython\'s hop formula');
  // nhops = 1 + floor(distance / (3 * 1.1**speed * speed)) -- one hop per frame.
  const hops = await page.evaluate(() => {
    const r = window.__r;
    const line = { op: 'line', x1: 0, y1: 0, x2: 100, y2: 0, color: '#000', width: 1 };
    const out = {};
    for (const s of [1, 3, 6, 10]) {
      r.setSpeed(s);
      out[s] = r.hopsFor(line);
    }
    return out;
  });
  check('speed 1 takes ~31 frames for a 100-unit line', hops[1] === 31, `got ${hops[1]}`);
  check('speed 3 is much quicker', hops[3] === 9, `got ${hops[3]}`);
  check('speed 6 quicker still', hops[6] === 4, `got ${hops[6]}`);
  check('speed 10 is nearly instant', hops[10] === 2, `got ${hops[10]}`);
  check('slower speed means strictly more frames',
    hops[1] > hops[3] && hops[3] > hops[6] && hops[6] > hops[10]);

  // A single long line must animate, not appear whole -- this is the bug that
  // made every speed look identical when the app flushed on program end.
  const partial = await page.evaluate(async () => {
    const r = window.__r;
    r.reset({ llx: -300, lly: -300, urx: 300, ury: 300 });
    r.setSpeed(1);
    r.enqueue({
      ops: [{ op: 'line', x1: -250, y1: 0, x2: 250, y2: 0, color: '#000000', width: 4 }],
      turtles: [], seq: 1,
    });
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return {
      committed: r.committed.length,
      hasPartial: r.partial !== null,
      done: r.partial ? r.partial.done : null,
      nhops: r.partial ? r.partial.nhops : null,
      penTipX: r.penTip ? r.penTip.x : null,
    };
  });
  check('one long line is still in progress', partial.hasPartial,
    JSON.stringify(partial));
  check('it is not committed yet', partial.committed === 0);
  check('only a couple of hops have been drawn', partial.done <= 3 && partial.nhops > 100,
    `${partial.done} of ${partial.nhops}`);
  check('the pen has barely moved from the start',
    partial.penTipX !== null && partial.penTipX < -200,
    `penTip.x = ${partial.penTipX}`);

  // Skip animation finishes it and records the ORIGINAL op, not sub-segments.
  const skipped = await page.evaluate(() => {
    window.__r.flushAll();
    const r = window.__r;
    return { committed: r.committed.length, partial: r.partial, op: r.committed[0] };
  });
  check('skip finishes the line', skipped.partial === null && skipped.committed === 1);
  check('committed op is the original, not a sub-segment',
    skipped.op.x1 === -250 && skipped.op.x2 === 250, JSON.stringify(skipped.op));

  const instant = await page.evaluate(async () => {
    const r = window.__r;
    r.reset({ llx: -300, lly: -300, urx: 300, ury: 300 });
    r.setSpeed(0);
    r.enqueue({
      ops: [{ op: 'line', x1: -250, y1: 0, x2: 250, y2: 0, color: '#000', width: 2 }],
      turtles: [], seq: 1,
    });
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return { committed: r.committed.length, pending: r.hasPending() };
  });
  check('speed 0 draws in a single frame', instant.committed === 1 && !instant.pending);

  const traced = await page.evaluate(async () => {
    const r = window.__r;
    r.reset({ llx: -300, lly: -300, urx: 300, ury: 300 });
    r.setSpeed(1);
    // tracer(0): Python says do not animate, even at a slow speed.
    r.enqueue({
      ops: [{ op: 'line', x1: -250, y1: 0, x2: 250, y2: 0, color: '#000', width: 2 }],
      turtles: [], seq: 1, tracing: false,
    });
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return { committed: r.committed.length, pending: r.hasPending() };
  });
  check('tracer(0) overrides speed and draws at once',
    traced.committed === 1 && !traced.pending);

  const idle = await page.evaluate(async () => {
    const r = window.__r;
    r.reset({ llx: -300, lly: -300, urx: 300, ury: 300 });
    r.setSpeed(8);
    r.enqueue({
      ops: [{ op: 'line', x1: -100, y1: 0, x2: 100, y2: 0, color: '#000', width: 2 }],
      turtles: [], seq: 1,
    });
    const t0 = performance.now();
    await r.whenIdle();
    return { elapsed: performance.now() - t0, pending: r.hasPending() };
  });
  check('whenIdle() resolves once the drawing finishes',
    !idle.pending && idle.elapsed > 0, JSON.stringify(idle));

  /* ------------------------------------------------ cursor tracks the pen */
  console.log('\n7. Cursor follows the pen, not the backlog');
  // Python reports the turtle far away (as it would after a 128-op flush) while
  // the drawing is still catching up. The cursor must appear at the pen tip.
  const tip = await page.evaluate(async () => {
    const r = window.__r;
    r.reset({ llx: -300, lly: -300, urx: 300, ury: 300 });
    r.setSpeed(1); // one op per frame
    const ops = [{ op: 'bgcolor', color: '#ffffff' }];
    for (let i = 0; i < 40; i++) {
      ops.push({ op: 'line', x1: -200 + i * 5, y1: 0, x2: -195 + i * 5, y2: 0,
        color: '#000000', width: 2 });
    }
    r.enqueue({
      ops,
      // Reported position is the END of the batch, far to the right.
      turtles: [{ x: 250, y: 0, heading: 0, visible: true, shape: 'circle',
        fill: '#ff0000', pen: '#ff0000', stretch: [2, 2], outline: 0, tilt: 0 }],
      seq: 1,
    });
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return { penTip: r.penTip, queued: r.queue.length };
  });
  check('backlog still pending', tip.queued > 0, `queued ${tip.queued}`);
  check('pen tip tracked', tip.penTip !== null && tip.penTip.x < 0,
    JSON.stringify(tip.penTip));
  {
    // World 600 wide over 600px -> 1 unit = 1px; x=250 maps to 550px.
    const atReported = await pixelAt(550, 300);
    check('cursor is NOT at the reported position', !isColor(atReported, [255, 0, 0]),
      JSON.stringify(atReported));
    const tipPx = await page.evaluate(() => {
      const r = window.__r;
      const [sx, sy] = r.toScreen(r.penTip.x, r.penTip.y);
      return [sx, sy];
    });
    check('cursor is drawn at the pen tip', isColor(await pixelAt(tipPx[0], tipPx[1]), [255, 0, 0]),
      JSON.stringify(await pixelAt(tipPx[0], tipPx[1])));
  }

  /* -------------------------------------------------------------- hygiene */
  console.log('\n8. Hygiene');
  check('no uncaught page errors', errors.length === 0, errors.join('\n         '));

  // A visual reference for the eye, not an assertion.
  await page.evaluate(() => {
    const r = window.__r;
    r.reset({ llx: -300, lly: -300, urx: 300, ury: 300 });
    const ops = [{ op: 'bgcolor', color: '#ffffff' }];
    let a = 0;
    let x = 0;
    let y = 0;
    for (let i = 0; i < 140; i++) {
      const len = 4 + i * 1.6;
      const nx = x + len * Math.cos((a * Math.PI) / 180);
      const ny = y + len * Math.sin((a * Math.PI) / 180);
      ops.push({ op: 'line', x1: x, y1: y, x2: nx, y2: ny,
        color: `hsl(${(i * 5) % 360} 80% 45%)`, width: 3 });
      x = nx; y = ny; a += 89;
    }
    ops.push({ op: 'text', x: -280, y: -280, s: 'renderer check', font: ['Arial', 18, 'bold'], align: 'left', color: '#000000' });
    window.__feed(ops, [{ x, y, heading: a % 360, visible: true, shape: 'turtle',
      fill: '#2b7a2b', pen: '#144014', stretch: [1.5, 1.5], outline: 1, tilt: 0 }]);
  });
  await page.screenshot({ path: join(ROOT, 'test/renderer-check.png'), clip: { x: 0, y: 0, width: 600, height: 600 } });
  console.log('       screenshot -> test/renderer-check.png');
} catch (err) {
  failed++;
  console.log(`\n  FAIL (threw) ${err.message}\n${err.stack}`);
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
