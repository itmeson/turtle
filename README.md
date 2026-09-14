# Python Turtle Editor

A browser-based Python editor for intro programming classes. Real CPython, real
error messages, no AI assistance, nothing sent anywhere.

See `SPEC.md` for the full design and `BRIEF.md` for the version to forward to
Technology Services.

**Status: complete and ready to deploy.** `GITHUB-SETUP.md` takes you from an
empty folder to a live URL; `DEPLOY.md` covers other hosts and later updates.

`import turtle` works. Errors are CPython's own, pointing at the exact
character. Indentation problems are made visible before they become confusing.
Work autosaves with version history and cannot be lost to a failed save.
Programs share as links; drawings export as lossless SVG or PNG at any scale.
There is no AI assistance, and the runtime sandbox makes that checkable: student
Python has no network reach at all, verified by a test that attacks a real
listener and passes only if nothing arrives.
After the first visit it runs entirely offline.

---

## Running it

You need Node (any recent version). There are **no dependencies to install.**

```
node serve.mjs
```

Then open <http://localhost:8000>.

Opening `index.html` directly from the filesystem will not work — ES modules and
WebAssembly both require a real `http://` origin. That is all `serve.mjs` is for.

## Running the tests

```
npm test                          # all of it
npm run test:dist                 # builds dist/ and checks it as a host will serve it
```

Or individually:

```
node test/csp.test.mjs            # 43 checks: CSP, sandbox wiring, deploy packaging
node test/security.browser.mjs    # 12 checks: student Python cannot reach the network
node test/sanitize.test.mjs       # 46 unit checks, no browser needed
node test/share.test.mjs          # 29 checks: share codec + zip-bomb refusal, no browser
node test/renderer.browser.mjs    # 34 checks: renderer vs a synthetic op stream
node test/phase0.browser.mjs      # 29 checks: Python, errors, Stop
node test/phase1.browser.mjs      # 47 checks: import turtle through to pixels
node test/phase2.browser.mjs      # 36 checks: the CodeMirror editor
node test/phase3.browser.mjs      # 51 checks: storage, sharing, export, save honesty
node test/phase4.browser.mjs      # 27 checks: examples, service worker, offline
node test/dist.browser.mjs        # 19 checks: the built site, from a subpath, no CSP header
```

373 checks in total. `security.browser.mjs` and `dist.browser.mjs` gate every
deploy from GitHub Actions — together with `csp.test.mjs` they are what keep the
privacy claim in `BRIEF.md` true. `renderer.browser.mjs` deliberately does not involve Python:
when a drawing looks wrong it tells you whether the fault is in the renderer or
in the shim, which is worth the extra file.

The browser suites need Playwright and a Chromium build. Install them once,
in the project folder — this works the same on Windows, macOS and Linux:

```
npm install --save-dev playwright
npx playwright install chromium
```

`test/csp.test.mjs`, `test/sanitize.test.mjs` and `test/share.test.mjs` need
none of that — they are plain Node and run anywhere. Run `csp.test.mjs` before
every deploy.

All suites resolve the project folder from their own location, so they can be
run from any directory.

## What is here

```
index.html          three-pane layout: editor | canvas / console
styles.css
favicon.svg         generated from the real turtle shape data
sw.js               service worker: offline start (SPEC section 12)
_headers            CSP and caching, for hosts that can set headers
serve.mjs           zero-dependency dev server; reads its CSP from _headers
build.mjs           produces dist/ from an explicit include list
.github/workflows/  test-gated deploy to GitHub Pages (GITHUB-SETUP.md)
vendor/pyodide/     Pyodide 314.0.6, pinned and self-hosted
vendor/codemirror/  CodeMirror 6, bundled once with esbuild (BUILD-CODEMIRROR.md)
src/
  main.js           wiring
  starters.js       the six example programs
  editor/
    sanitize.js        THE important module - whitespace repair (SPEC section 8)
    codeMirrorEditor.js  editor mounting: highlighting, diagnostics, whitespace
  runner/
    worker.js       Pyodide host, runs in a Web Worker
    sandbox.js      removes the worker's network + storage reach
    client.js       worker lifecycle, Stop, pre-warmed spare
    harness.py      compile-then-exec, traceback filtering (SPEC section 7)
    protocol.js     message types shared across the worker boundary
    glosses.js      plain-language explanations of CPython error messages
  turtle/
    turtle.py       the shim - shadows the stdlib module (SPEC section 6)
    ops.js          display-list op definitions (SPEC section 5)
    shapes.js       cursor polygons and the heading transform
    renderCanvas.js canvas painter, animation pacing
    renderSvg.js    vector export (SPEC section 11)
    renderPng.js    raster export at any scale
  storage/
    share.js        URL-fragment share codec (SPEC section 10)
    db.js           IndexedDB access, no policy
    workspace.js    autosave, snapshots, projects (SPEC section 9)
    download.js     downloads and File System Access
  ui/
    consolePane.js  output and error rendering
    panel.js        the Programs / History overlay
test/
```

## Design notes worth knowing before editing

**No build step, no npm dependencies.** Plain ES modules served statically.
Deployment is copying a folder. See SPEC section 16 for why, and what it costs.

**Python runs in a Web Worker.** That is what makes Stop work: it is
`worker.terminate()`, which is unconditional and takes about 30 ms. A
pre-warmed spare worker is kept booted so Stop → Run does not pay a cold start.

**Compile before executing.** `harness.py` calls `compile()` first so syntax and
indentation errors are reported with an exact line and column and *nothing runs
beforehand*. A student with a syntax error on line 12 should not see output from
lines 1–11.

**The source must be registered in `linecache`.** `compile()` does not do it, and
without it tracebacks silently lose their source lines and `^^^^` anchors. There
is a regression test.

**Tracebacks are filtered to the student's own frames.** If zero student frames
remain, the error came from our code, and the UI says so rather than blaming the
student.

**CPython's error message is always shown verbatim and first.** Our plain-language
gloss is secondary and clearly labelled. Students should finish the year able to
read a real Python error.

**Never break a working program while cleaning whitespace.** A tab or
non-breaking space inside a string literal is DATA. `sanitize.js` locates Python
string literals exactly (`stringSpans()`) and protects only what is inside them.
It fails in the safe direction: mistaking a string for code is the only way to
corrupt a program, so when in doubt it skips the fix and tells the student.
Read the header comment before changing it.

**No autocompletion, anywhere.** That is a feature. See SPEC section 12.

**Student Python has no network primitives.** `sandbox.js` removes `fetch`,
`XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, `Worker`,
`BroadcastChannel`, `indexedDB` and `caches` from the worker once Pyodide has
booted. Without it, `import js; js.fetch("/?leak=" + source)` works and the
request arrives - the CSP alone never stopped same-origin requests, and a
`<meta>` CSP does not cover workers at all. Never call this before Pyodide has
finished loading; it needs `fetch` for its own wasm and stdlib.

**The save indicator must never claim more than happened.** IndexedDB writes are
confirmed on `tx.oncomplete`, not `request.onsuccess` - a quota error surfaces at
commit. The UI distinguishes "Saved", "Saved (this browser only)" and
"NOT SAVED". A tool that says it saved when it did not is the failure this
project exists to replace.

**One display list feeds every output.** The canvas, and later the SVG and PNG
exporters, all consume the same op stream in turtle coordinates. Never bake
screen coordinates into an op, and never export by screenshotting the canvas -
that is exactly the lossy behaviour this project exists to replace.

**Marks vs state.** Ops that add marks (line, dot, poly, text, stamp) append to
an offscreen layer and are never repainted. Ops that change global state
(bgcolor, setworld, clear, clearstamp) force a full repaint from the committed
list. Mixing these up is how the renderer breaks; see SPEC section 18.

**The cursor is drawn at the pen tip, not where Python says it is.** Python
reports turtle state once per flush, and animation pacing lags behind that.
Drawing the cursor at the reported position makes the turtle run ahead of its
own line.

**A program finishing is not the drawing finishing.** `speed(1)` animates for
seconds while the Python program itself completes in milliseconds. Never call
`renderer.flushAll()` when a run ends - that was a real bug that made every
speed setting look identical. Wait on `renderer.whenIdle()` instead.

**Animation pacing uses CPython's own hop formula**, so a long line is drawn
progressively rather than appearing whole. Draining a fixed number of ops per
frame does not work: a four-segment square takes four frames at every speed.

**PNG export instantiates the SAME renderer at a different pixel ratio.** Never
write a second painter, and never `toDataURL()` the visible canvas - that caps
the output at the pane size and is the lossy behaviour this project replaces.
A pixel-comparison test guards it.

**A shared link always becomes a NEW program.** Opening someone else's link must
never overwrite what a student was working on. It also strips its own fragment
afterwards, or every reload would import it again.

**Saving is not an event a student can fail at.** No save button, no request,
three redundant layers: IndexedDB autosave 400ms after typing stops, a
localStorage mirror written synchronously, and rolling snapshots.

**Hiding is `[hidden] { display: none !important }`.** The browser's own rule is
a plain `display: none`, which any author `display` rule silently outranks - and
the result is an element that is "hidden" in the DOM and visible on screen.

**UI assertions must check visibility, not the `hidden` property.** A test that
checks the property passes while the user is staring at the thing.

**The service worker caches `vendor/` forever and everything else never.** Pinned
12.9 MB assets should never hit the network twice; our own code should never be
stale, because a teacher pushing a fix must reach students on the next reload.
Bump `CACHE_VERSION` in `sw.js` whenever `vendor/` changes.

**`serve.mjs` reads its CSP from `_headers`.** Never hard-code a second copy -
they drift, and the drift is invisible until production breaks. A test enforces
this.

**Every example program is executed by the test suite.** A broken example is
worse than no example: a beginner cannot tell our mistake from theirs.

**No linter source is registered in CodeMirror.** Diagnostics come from
CPython's `compile()`, pushed with `setDiagnostics()`. Registering a
`linter()` source that returns `[]` would wipe them every time it ran.

**Tabs are marked in the editor at all times**, whether or not "Show spaces" is
on. Space dots are noise when you don't need them; an invisible tab is a bug
waiting to happen.

## About the editor

`codeMirrorEditor.js` is the mounting only — extensions, keymaps, decorations.
The rules it enforces live in `sanitize.js`, which has no CodeMirror dependency
and is unit-tested without a browser. Keep it that way: logic in `sanitize.js`,
wiring in `codeMirrorEditor.js`.

The CodeMirror bundle in `vendor/codemirror/` is a required build artifact, like
`vendor/pyodide/`. It is built once; see `BUILD-CODEMIRROR.md`.

## Phase 0 measurements

| | |
|---|---|
| Python | 3.14.2 (Pyodide 314.0.6) |
| Runtime on disk | 12.90 MB |
| Runtime over the wire (gzip) | 6.04 MB |
| Worker cold boot | 2.2–3.0 s |
| Stop an infinite loop | 24–45 ms |
| Run after Stop (spare) | ~67 ms |
