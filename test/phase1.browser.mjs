/**
 * Phase 1 verification — turtle graphics end to end.
 *
 *   node test/phase1.browser.mjs
 *
 * The renderer is already covered in isolation by renderer.browser.mjs. This
 * suite is about the Python shim and the path from `import turtle` to pixels.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Resolved from this file so the suite runs from any directory, and so
// Windows gets a real path rather than "/C:/..." from URL.pathname.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const PORT = 8128;
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
const run = async () => {
  await page.click('#run');
  await page.waitForFunction(
    () => !document.getElementById('run').disabled
      && document.getElementById('status').textContent !== 'Running',
    null, { timeout: 60000 },
  );
  // The program finishing and the DRAWING finishing are different events now
  // that speed() actually paces the animation, so wait for both.
  await page.evaluate(() => window.__renderer.whenIdle());
};
const consoleText = () => page.textContent('.console-lines');
const status = () => page.textContent('#status');
/** The committed display list, i.e. what a renderer or exporter would consume. */
const ops = () => page.evaluate(() => window.__renderer.committed.map((o) => o.op));
const opsFull = () => page.evaluate(() => window.__renderer.committed);
const turtles = () => page.evaluate(() => window.__renderer.turtles);

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 90000 });

  /* -------------------------------------------------- 1. import works */
  console.log('\n1. import turtle');
  await setCode('import turtle\nprint("imported", turtle.__name__)\nt = turtle.Turtle()\nprint("made", type(t).__name__)\n');
  await run();
  let out = await consoleText();
  check('import turtle succeeds', out.includes('imported turtle'), out.slice(0, 200));
  check('Turtle() constructs', out.includes('made Turtle'));
  check('no tkinter error', !out.includes('tkinter'));

  /* ------------------------------------------------------ 2. geometry */
  console.log('\n2. Motion produces correct geometry');
  await setCode(`import turtle
t = turtle.Turtle()
t.speed(0)
for i in range(4):
    t.forward(100)
    t.left(90)
`);
  await run();
  const square = await opsFull();
  const lines = square.filter((o) => o.op === 'line');
  check('four line segments', lines.length === 4, `got ${lines.length}`);
  check('starts at the origin', Math.abs(lines[0].x1) < 1e-6 && Math.abs(lines[0].y1) < 1e-6);
  check('first side goes east 100', Math.abs(lines[0].x2 - 100) < 1e-6 && Math.abs(lines[0].y2) < 1e-6,
    JSON.stringify(lines[0]));
  check('second side goes north', Math.abs(lines[1].x2 - 100) < 1e-6 && Math.abs(lines[1].y2 - 100) < 1e-6,
    JSON.stringify(lines[1]));
  check('closes back at the origin',
    Math.abs(lines[3].x2) < 1e-9 && Math.abs(lines[3].y2) < 1e-9,
    JSON.stringify(lines[3]));

  /* -------------------------------------------------- 3. pen up / down */
  console.log('\n3. Pen up leaves no mark');
  await setCode('import turtle\nt = turtle.Turtle()\nt.penup()\nt.forward(50)\nt.pendown()\nt.forward(50)\n');
  await run();
  const pen = await opsFull();
  check('only the pen-down move draws', pen.filter((o) => o.op === 'line').length === 1);
  check('it starts where the pen went down',
    Math.abs(pen.filter((o) => o.op === 'line')[0].x1 - 50) < 1e-6);

  /* ------------------------------------------------------- 4. filling */
  console.log('\n4. Filling');
  await setCode(`import turtle
t = turtle.Turtle()
t.fillcolor("red")
t.begin_fill()
for i in range(3):
    t.forward(100)
    t.left(120)
t.end_fill()
`);
  await run();
  const filled = await opsFull();
  const polys = filled.filter((o) => o.op === 'poly');
  check('one polygon emitted', polys.length === 1, `got ${polys.length}`);
  check('polygon is the triangle path', polys[0] && polys[0].pts.length >= 3);
  // Colours reach the renderer as CSS-valid strings: a validated name stays a
  // name, tuples become hex. Canvas and SVG both understand either natively.
  check('fill colour carried through', polys[0] && polys[0].fill === 'red', polys[0]?.fill);
  check('outline still drawn', filled.filter((o) => o.op === 'line').length === 3);

  /* -------------------------------------------------------- 5. colour */
  console.log('\n5. Colour handling');
  await setCode(`import turtle
t = turtle.Turtle()
t.pencolor("rebeccapurple")
t.forward(10)
t.pencolor("#00ff00")
t.forward(10)
turtle.colormode(255)
t.pencolor((255, 128, 0))
t.forward(10)
`);
  await run();
  const colored = (await opsFull()).filter((o) => o.op === 'line');
  check('named colour passes through', colored[0].color === 'rebeccapurple', colored[0].color);
  check('hex colour passes through', colored[1].color === '#00ff00', colored[1].color);
  check('255-mode tuple becomes hex', colored[2].color === '#ff8000', colored[2].color);

  await setCode('import turtle\nt = turtle.Turtle()\nt.color("purpel")\n');
  await run();
  out = await consoleText();
  check('a misspelt colour is a clear error',
    out.includes('TurtleGraphicsError') && out.includes('bad color string: purpel'),
    out.slice(0, 200));

  /* ------------------------------------------------ 6. dots and stamps */
  console.log('\n6. Dots, stamps and text');
  await setCode(`import turtle
t = turtle.Turtle()
t.dot(20, "blue")
t.forward(50)
s = t.stamp()
t.forward(50)
t.write("hi", font=("Arial", 16, "bold"))
print("stamp id", s)
`);
  await run();
  const marks = await ops();
  check('dot emitted', marks.includes('dot'));
  check('stamp emitted', marks.includes('stamp'));
  check('text emitted', marks.includes('text'));
  check('stamp returns an id', (await consoleText()).includes('stamp id 1'));

  await setCode(`import turtle
t = turtle.Turtle()
a = t.stamp()
t.forward(40)
b = t.stamp()
t.clearstamp(a)
`);
  await run();
  const afterClear = await opsFull();
  check('clearstamp removes exactly one stamp',
    afterClear.filter((o) => o.op === 'stamp').length === 1,
    `stamps remaining: ${afterClear.filter((o) => o.op === 'stamp').length}`);

  /* -------------------------------------------- 7. multiple turtles */
  console.log('\n7. Multiple turtles');
  await setCode(`import turtle
a = turtle.Turtle()
b = turtle.Turtle()
a.color("red")
b.color("blue")
a.forward(80)
b.left(90)
b.forward(80)
print("turtles:", len(turtle.Screen().turtles()))
`);
  await run();
  out = await consoleText();
  const cursors = await turtles();
  check('screen knows about both turtles', out.includes('turtles: 2'), out.slice(0, 200));
  check('two cursors reported to the renderer', cursors.length === 2, `got ${cursors.length}`);
  check('they are in different places',
    Math.abs(cursors[0].x - cursors[1].x) > 1 || Math.abs(cursors[0].y - cursors[1].y) > 1,
    JSON.stringify(cursors));
  check('each keeps its own colour',
    cursors[0].pen === 'red' && cursors[1].pen === 'blue',
    JSON.stringify(cursors.map((c) => c.pen)));

  /* ----------------------------------------------- 8. state queries */
  console.log('\n8. State queries');
  await setCode(`import turtle
t = turtle.Turtle()
t.forward(100)
t.left(90)
print("pos", round(t.xcor()), round(t.ycor()))
print("heading", t.heading())
print("towards", round(t.towards(100, 200)))
print("distance", round(t.distance(0, 0)))
t.home()
print("home", round(t.xcor()), round(t.ycor()), t.heading())
`);
  await run();
  out = await consoleText();
  check('xcor/ycor correct', out.includes('pos 100 0'), out.slice(0, 300));
  check('heading correct', out.includes('heading 90.0'));
  check('towards correct', out.includes('towards 90'));
  check('distance correct', out.includes('distance 100'));
  check('home resets position and heading', out.includes('home 0 0 0.0'));

  /* ------------------------------------------------- 9. unsupported */
  console.log('\n9. Unsupported features explain themselves');
  await setCode('import turtle\nt = turtle.Turtle()\nt.forward(50)\nt.undo()\n');
  await run();
  out = await consoleText();
  check('undo() explains rather than crashing',
    out.includes('Not available in this editor') && out.includes('undo() is not available'),
    out.slice(0, 250));
  check('the drawing before it still appears',
    (await opsFull()).filter((o) => o.op === 'line').length === 1,
    'a partial drawing must survive an error');

  await setCode('import turtle\nturtle.onkey(lambda: None, "a")\n');
  await run();
  out = await consoleText();
  check('onkey() explains rather than crashing', out.includes("doesn't support"), out.slice(0, 250));

  /* ---------------------------------------- 10. errors mid-drawing */
  console.log('\n10. A crash still shows the partial drawing');
  await setCode(`import turtle
t = turtle.Turtle()
t.speed(0)
for i in range(3):
    t.forward(60)
    t.left(90)
print(1 / 0)
`);
  await run();
  check('ZeroDivisionError reported', (await consoleText()).includes('ZeroDivisionError'));
  check('three sides still drawn',
    (await opsFull()).filter((o) => o.op === 'line').length === 3);

  /* ---------------------------------------------- 11. screen methods */
  console.log('\n11. Screen methods');
  await setCode(`import turtle
s = turtle.Screen()
s.bgcolor("lightblue")
t = turtle.Turtle()
t.forward(50)
print("bg", s.bgcolor())
`);
  await run();
  check('bgcolor applied', (await page.evaluate(() => window.__renderer.bg)) === 'lightblue',
    await page.evaluate(() => window.__renderer.bg));
  check('bgcolor readable back', (await consoleText()).includes('bg lightblue'));

  await setCode(`import turtle
turtle.setworldcoordinates(0, 0, 10, 10)
t = turtle.Turtle()
t.goto(5, 5)
`);
  await run();
  const world = await page.evaluate(() => window.__renderer.world);
  check('setworldcoordinates reaches the renderer',
    world.llx === 0 && world.ury === 10, JSON.stringify(world));

  /* ------------------------------------------- 12. tracer and speed */
  console.log('\n12. tracer(0) and update()');
  await setCode(`import turtle
t = turtle.Turtle()
turtle.tracer(0)
for i in range(200):
    t.forward(2)
    t.left(3)
turtle.update()
print("done")
`);
  await run();
  check('all 200 segments arrive',
    (await opsFull()).filter((o) => o.op === 'line').length === 200,
    `got ${(await opsFull()).filter((o) => o.op === 'line').length}`);

  /* ------------------------------------ 12b. speed actually paces */
  console.log('\n12b. speed() changes how long the drawing takes');
  // The regression this guards: the app used to flush the whole queue the
  // moment Python finished, so every speed looked identical.
  const timeDrawing = async (code) => {
    await setCode(code);
    await page.click('#run');
    await page.waitForFunction(
      () => !document.getElementById('run').disabled
        && document.getElementById('status').textContent !== 'Running',
      null, { timeout: 60000 },
    );
    return page.evaluate(async () => {
      const t0 = performance.now();
      await window.__renderer.whenIdle();
      return performance.now() - t0;
    });
  };

  const prog = (s) => `import turtle
t = turtle.Turtle()
t.speed(${s})
for i in range(4):
    t.forward(120)
    t.left(90)
`;
  const slow = await timeDrawing(prog(1));
  const fastSpeed = await timeDrawing(prog(10));
  const none = await timeDrawing(prog(0));
  console.log(`       speed 1: ${Math.round(slow)} ms, speed 10: ${Math.round(fastSpeed)} ms, speed 0: ${Math.round(none)} ms`);

  check('speed(1) visibly animates', slow > 800, `${Math.round(slow)} ms`);
  check('speed(10) is much quicker', fastSpeed < slow / 3,
    `${Math.round(fastSpeed)} ms vs ${Math.round(slow)} ms`);
  check('speed(0) is effectively instant', none < 120, `${Math.round(none)} ms`);

  /* ------------------------------------------------- 13. stop works */
  console.log('\n13. Stop interrupts a drawing loop');
  await setCode('import turtle\nt = turtle.Turtle()\nwhile True:\n    t.forward(5)\n    t.left(7)\n');
  await page.click('#run');
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Running',
    null, { timeout: 15000 });
  await page.waitForTimeout(900);
  await page.click('#stop');
  await page.waitForFunction(() => document.getElementById('status').textContent !== 'Running',
    null, { timeout: 15000 });
  check('stopped cleanly', (await status()).includes('Stopped'), await status());
  await page.waitForFunction(() => !document.getElementById('run').disabled, null, { timeout: 30000 });
  await setCode('import turtle\nt = turtle.Turtle()\nt.forward(10)\nprint("alive")\n');
  await run();
  check('turtle still works after Stop', (await consoleText()).includes('alive'));

  /* ------------------------------------------------------ 14. hygiene */
  console.log('\n14. Hygiene');
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('\n         '));

  // Visual reference.
  await setCode(`import turtle
t = turtle.Turtle()
t.shape("turtle")
t.speed(0)
s = turtle.Screen()
s.bgcolor("#101820")
colors = ["#ff4d6d", "#ffd166", "#06d6a0", "#4cc9f0", "#b892ff"]
t.pensize(2)
for i in range(120):
    t.pencolor(colors[i % len(colors)])
    t.forward(i * 2)
    t.right(59)
t.penup()
t.goto(-260, -250)
t.pendown()
t.pencolor("white")
t.write("phase 1", font=("Arial", 20, "bold"))
`);
  await run();
  await page.screenshot({ path: join(ROOT, 'test/phase1-screenshot.png') });
  console.log('       screenshot -> test/phase1-screenshot.png');
} catch (err) {
  failed++;
  console.log(`\n  FAIL (threw) ${err.message}\n${err.stack}`);
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
