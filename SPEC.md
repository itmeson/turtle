# Online Python Turtle Editor — Build Specification

**Version:** 1.0 (pre-implementation)
**Date:** September 2026
**Scope decisions locked:** drawing-only turtle, no backend, desktop Mac/Windows browsers.

---

## 1. Goals

1. `import turtle` works, always, offline, with no configuration.
2. Error messages are CPython's real messages, pointing at the exact character.
3. Indentation problems are made **visible** before they become confusing.
4. Student work cannot be lost, because saving never touches a network.
5. Programs and images can be shared and exported without degradation.
6. No AI assistance exists in the product, and this is technically verifiable.

## 2. Non-goals for v1

Explicitly out of scope. Listing them here so they do not creep in.

- `input()`, `textinput()`, `numinput()` — requires blocking the worker via `SharedArrayBuffer`, which requires COOP/COEP headers. Deferred.
- `onkey`, `onclick`, `onscreenclick`, `ontimer`, `listen` — event plumbing. Deferred.
- Multiple files, imports of student modules, package installation (`micropip`).
- Accounts, submissions, teacher dashboards, grading.
- Mobile and tablet layouts. Desktop only.
- Any code completion, suggestion, or generation feature.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────┐
│  MAIN THREAD                                         │
│                                                      │
│   CodeMirror 6 editor ──┐                            │
│     indent normalizer   │                            │
│     diagnostics gutter  │                            │
│                         ▼                            │
│   Autosave → IndexedDB (debounced 400ms)             │
│   Snapshot history (30s cadence, keep 50)            │
│   Share-link encode/decode (URL fragment)            │
│                                                      │
│   Render queue ──► Canvas 2D  (live view)            │
│                └─► SVG serializer   (export)         │
│                └─► OffscreenCanvas  (PNG @ N×)       │
└───────────────┬──────────────────────────────────────┘
                │  postMessage (structured clone)
                │  ops down, control up
┌───────────────▼──────────────────────────────────────┐
│  WEB WORKER                                          │
│                                                      │
│   Pyodide  (CPython 3.14 → WebAssembly)              │
│     └── sys.path[0] = /turtle-shim/                  │
│           turtle.py  ← emits display-list ops        │
│     stdout/stderr capture                            │
│     compile() pre-pass for syntax errors             │
│     traceback sanitizer                              │
└──────────────────────────────────────────────────────┘
```

**Why a worker:** an infinite loop in student code must not freeze the tab. Stop = `worker.terminate()`, which is unconditional and instant. A spare worker is pre-warmed after the first successful run so Stop→Run has no cold start.

**Why Pyodide over Skulpt/Brython:** real CPython means the real tokenizer, the real `IndentationError`/`TabError`, and PEP 657 fine-grained error locations. Goals 2 and 3 are unachievable on a reimplementation.

### Stack

- **Vite + TypeScript.** No UI framework — the app is one screen; a framework adds weight and indirection for nothing.
- **CodeMirror 6** (`@codemirror/state`, `@codemirror/view`, `@codemirror/lang-python`, `@codemirror/lint`).
- **Pyodide 314.x**, pinned to an exact patch version, **self-hosted**. Do not use jsDelivr: school content filters block CDNs unpredictably, and a CDN outage becomes a class outage.

---

## 4. Repository layout

```
online-python/
  index.html
  public/
    pyodide/                  # pinned release, committed or fetched at build
      pyodide.mjs
      pyodide.asm.wasm
      python_stdlib.zip
    _headers                  # Cloudflare Pages: CSP, cache-control
  src/
    main.ts
    ui/
      layout.ts               # split pane, toolbar
      toolbar.ts
      errorPanel.ts
      historyPanel.ts
    editor/
      setup.ts                # CodeMirror extension assembly
      indent.ts               # tab→space, paste sanitizer, whitespace deco
      diagnostics.ts          # PyDiagnostic → CodeMirror lint
      commands.ts             # normalize-indentation, etc.
    runner/
      worker.ts               # Pyodide host (runs in worker)
      client.ts               # main-thread wrapper, lifecycle, pre-warm
      protocol.ts             # SHARED message types — single source of truth
      traceback.ts            # frame filtering
      glosses.ts              # CPython message → student-facing explanation
    turtle/
      turtle.py               # the shim (asset, loaded into Pyodide FS)
      ops.ts                  # DisplayOp type definitions
      renderCanvas.ts
      renderSvg.ts
      renderPng.ts
      colors.ts               # Tk colour-name table
    storage/
      db.ts                   # IndexedDB open/migrate
      autosave.ts
      history.ts
      share.ts                # deflate + base64url fragment codec
      fileSystem.ts           # File System Access API, with fallback
  test/
    golden/                   # reference programs + expected SVG/PNG
    errors/                   # broken programs + expected diagnostics
    indent/                   # dirty-whitespace fixtures
  vite.config.ts
```

---

## 5. The display list

This is the central data structure. **Everything** — live canvas, SVG export, PNG export — is a rendering of the same op stream. This is what makes exports lossless: nothing is ever screenshotted.

### Coordinate convention

Ops carry **turtle-space coordinates**: origin at centre, **y increases upward**, units are turtle units. Renderers apply the flip and translation. Do not bake screen coordinates into ops — doing so is what forces exporters to re-derive geometry and introduces drift.

### Op types (`src/turtle/ops.ts`)

```ts
export type Color = string;              // any CSS-valid colour: a validated name, or "#rrggbb"

export type DisplayOp =
  | { op: 'line';    x1:number; y1:number; x2:number; y2:number;
                     color:Color; width:number }
  | { op: 'dot';     x:number; y:number; d:number; color:Color }
  | { op: 'poly';    pts:[number,number][]; fill:Color;
                     stroke:Color|null; width:number }        // completed begin_fill/end_fill
  | { op: 'text';    x:number; y:number; s:string;
                     font:[string,number,string];
                     align:'left'|'center'|'right'; color:Color }
  | { op: 'stamp';   id:number; x:number; y:number; heading:number;
                     shape:ShapeName; fill:Color; pen:Color;
                     stretch:[number,number]; outline:number }
  | { op: 'clearstamp'; id:number }
  | { op: 'clear' }                                            // clear drawings, keep turtle
  | { op: 'bgcolor'; color:Color }
  | { op: 'setworld'; llx:number; lly:number; urx:number; ury:number }
  | { op: 'screensize'; w:number; h:number };

export interface TurtleState {                                 // cursor, drawn last, not part of the list
  x:number; y:number; heading:number; visible:boolean;
  shape:ShapeName; fill:Color; pen:Color;
  stretch:[number,number]; outline:number; tilt:number;
}

export interface OpBatch {
  ops: DisplayOp[];
  turtles: TurtleState[];      // full state snapshot at end of batch
  seq: number;
}
```

### Batching and flow

The shim buffers ops and flushes on whichever comes first:

- 128 ops accumulated,
- an explicit `update()` call,
- 16 ms of wall time since last flush,
- program termination.

Flush = one `postMessage`. Do not post per-op; message overhead dominates and the UI thread starves.

### Animation model

Students expect to watch the turtle draw, and `speed()` is used pedagogically.
**Do not** implement this by sleeping in Python — it is slow and makes the worker
unresponsive to Stop.

Pacing happens on the main thread, and it reproduces **CPython's own formula**
from `TNavigator._goto`:

```
nhops = 1 + int(distance / (3 * 1.1**speed * speed))
```

Each hop is one animation frame. A long line is therefore split into
sub-segments and the pen is seen travelling along it; short lines and other
marks (dot, poly, text, stamp) cost one frame each; state ops are free.

| `speed()` | frames for a 100-unit line |
|---|---|
| 1 (slowest) | 31 |
| 3 (slow) | 9 |
| 6 (normal) | 4 |
| 10 (fast) | 2 |
| 0 (fastest) | drawn in a single frame |

`tracer(0)` overrides speed entirely and draws the batch at once, matching
desktop behaviour where nothing appears until `update()`.

> **Why not "N ops per frame".** The first implementation drained a fixed number
> of ops per frame. That is wrong: a four-segment square finishes in four frames
> at *every* speed, so `speed(1)` and `speed(10)` look identical on exactly the
> programs a beginner writes. Pacing has to be driven by distance, not op count.

**Sub-segments are painted but never committed.** `committed` records the
original op once the line completes, because that list is what repaint and
export consume and it must stay faithful to what Python emitted.

**Runaway guard:** past 20,000 queued ops, pacing is abandoned and a
"fast-forwarding" notice appears.

**The program finishing is not the drawing finishing.** A program that animates
for eight seconds at `speed(1)` executes in under ten milliseconds. The UI must
report the run result immediately, then wait on `renderer.whenIdle()` before
settling the status — and must *not* flush the queue on completion. A **Skip
animation** button is offered while a drawing plays out.

## 6. `turtle.py` shim

Loaded into the Pyodide filesystem and placed at `sys.path[0]` so `import turtle` resolves to it instead of the stdlib module (which would fail on `import tkinter`).

Prior art worth reading before writing: the [Raspberry Pi Foundation's Pyodide turtle](https://github.com/RaspberryPiFoundation/turtle) (GPLv3, archived April 2026) and [basthon-turtle](https://pypi.org/project/basthon-turtle/0.4.0/). **Recommendation: read them, then write our own.** Both are GPLv3, both emit SVG directly rather than a replayable op stream, and neither is maintained. A purpose-written shim is a few hundred lines, keeps licensing clean, and lets the op stream serve all three renderers.

### API surface — must support

**Motion:** `forward`/`fd`, `backward`/`bk`/`back`, `right`/`rt`, `left`/`lt`, `goto`/`setpos`/`setposition`, `setx`, `sety`, `setheading`/`seth`, `home`, `circle`, `dot`, `stamp`, `clearstamp`, `clearstamps`, `speed`

**State queries:** `position`/`pos`, `xcor`, `ycor`, `heading`, `towards`, `distance`

**Pen:** `pendown`/`pd`/`down`, `penup`/`pu`/`up`, `pensize`/`width`, `pen`, `isdown`

**Colour:** `color`, `pencolor`, `fillcolor`, `colormode`

**Fill:** `begin_fill`, `end_fill`, `filling`

**Appearance:** `hideturtle`/`ht`, `showturtle`/`st`, `isvisible`, `shape`, `shapesize`/`turtlesize`, `tilt`, `settiltangle`, `resizemode`

**Text:** `write`

**Screen:** `bgcolor`, `screensize`, `setworldcoordinates`, `tracer`, `update`, `delay`, `title`, `mode`, `clear`, `clearscreen`, `reset`, `resetscreen`

**Angles:** `degrees`, `radians`

**Classes:** `Turtle`, `Pen` (alias), `Screen()`, `TurtleScreen`, `RawTurtle`

**No-ops (must not error):** `done`, `mainloop`, `exitonclick`, `bye`. Students copy these from textbooks constantly. `exitonclick` and `bye` return immediately; `done`/`mainloop` return immediately.

### API surface — deliberately unsupported

`onkey`, `onkeypress`, `onkeyrelease`, `onclick`, `onrelease`, `ondrag`, `onscreenclick`, `ontimer`, `listen`, `textinput`, `numinput`, `getcanvas`, `getscreen().register_shape(<image>)`

These raise a **custom, friendly** error, not a bare `AttributeError`:

```python
class NotSupportedHere(NotImplementedError):
    pass

def onkey(*a, **k):
    raise NotSupportedHere(
        "onkey() needs keyboard input, which this editor doesn't support yet. "
        "This editor runs drawing programs — ones that draw a picture and finish."
    )
```

The error panel special-cases `NotSupportedHere` and renders it as an explanation rather than a crash.

### Colour handling

`colormode(1.0)` (default) accepts floats 0.0–1.0; `colormode(255)` accepts ints. Accept: colour name strings, `"#rgb"`, `"#rrggbb"`, and 3-tuples.

**Revised in Phase 1.** This spec originally required every colour to be resolved to `#rrggbb` in the op stream. Implemented instead: **colours are emitted as CSS-valid strings** — a validated name stays a name, tuples and hex become `#rrggbb`. Reasons:

- Canvas and SVG both understand CSS colour names natively, so the consistency the original rule was protecting is not at risk.
- It avoids embedding a 148-entry name→hex table in the shim; only the *names* are needed, for validation.
- The student's own colour word survives into the display list, which helps when debugging and would help a future "show me the display list" view.

Validation still happens **at the point the colour is set**, not when it is drawn, so `t.color("purpel")` fails on that line rather than somewhere later. Unknown name → `TurtleGraphicsError: bad color string: purpel`, matching CPython. The name set is the 148 CSS/X11 names, generated rather than typed, plus `gray0`–`gray100` / `grey0`–`grey100` handled arithmetically.

### `undo()`

Real turtle keeps an undo buffer. Low classroom priority — **defer to Phase 4** or drop. If implemented, the shim keeps a parallel stack of (op-count, state) checkpoints and emits a `clear` + replay on undo. Note the cost before committing.

---

## 7. Error pipeline

Three distinct paths. Conflating them is the main way this gets built badly.

### 7a. Syntax and indentation errors — caught before execution

In the worker, **always compile first**:

```python
try:
    code = compile(source, "<your program>", "exec")
except SyntaxError as e:      # IndentationError and TabError subclass this
    report_syntax_error(e)
else:
    exec(code, namespace)
```

`SyntaxError` in Python 3.14 carries `lineno`, `offset`, `end_lineno`, `end_offset`, `msg`. Map straight to a CodeMirror diagnostic with an **exact character range** — underline the offending token, mark the gutter, scroll it into view.

**Do not display a traceback for these.** There is no meaningful stack; showing one teaches students to ignore output. Show: the CPython message, the underlined source line, and a gloss.

### The gloss table (`src/runner/glosses.ts`)

Always show CPython's real message. Show the gloss **beneath it**, visually secondary and labelled. Students must learn to read the real thing; the gloss is a bridge, not a replacement.

| CPython message (match on prefix) | Gloss | Offer fix |
|---|---|---|
| `expected ':'` | "Python expects a colon at the end of this line. `if`, `for`, `while`, and `def` lines all end with `:`" | insert `:` |
| `expected an indented block after '…' statement on line N` | "Line N opens a block, so the line after it must be indented. Nothing is indented under it." | indent line |
| `unexpected indent` | "This line is indented, but the line above it doesn't open a block. Only lines ending in `:` start an indented block." | dedent line |
| `unindent does not match any outer indentation level` | "This line is indented less than the block it's in, but doesn't line up with any block outside it either. Turn on **Show whitespace** to see the actual spacing." | Normalize indentation |
| `inconsistent use of tabs and spaces in indentation` (`TabError`) | "This file mixes tab characters and spaces for indentation. They look identical on screen but Python counts them differently." | **Normalize indentation** |
| `'(' was never closed` | "This opening bracket on line N never gets a matching one. Check for a missing `)` above." | — |
| `invalid syntax. Perhaps you forgot a comma?` | pass through unchanged — already good | — |
| `cannot assign to literal` | "The left side of `=` has to be a variable name. `5 = x` doesn't work; you probably meant `x = 5`." | — |
| *(no match)* | show CPython message alone | — |

### 7b. Runtime errors

Sanitize the traceback before display:

0. **Register the source in `linecache` under `<your program>` before executing.** `compile()` does not do this, and without it every traceback frame prints a bare `File "<your program>", line N` with no source line and **no `^^^^` anchors** — silently discarding the main reason this project runs real CPython instead of a JavaScript reimplementation. Found and fixed in Phase 0; there is a regression test for it.
1. Drop every frame whose filename is not `<your program>`. This removes the exec harness, Pyodide internals, and shim frames.
2. If **zero** student frames remain (error raised entirely inside the shim), that is a bug in *our* code — show the full trace and a "report this" note.
3. Preserve Python 3.14's `^^^^` caret lines verbatim. They are the most valuable part.
4. Preserve exception chaining (`During handling of the above exception…`).

**Near-miss suggestions.** On `NameError` or `AttributeError`, compare the offending name against the turtle API surface by Levenshtein distance ≤ 2 and append: *"Did you mean `forward`?"* CPython does some of this natively; extend it to turtle names specifically, since `fowards`, `foward`, `penUp`, `right_turn` are the common ones.

### 7c. Runaway programs

Watchdog on the main thread. If the worker has produced no ops and no stdout for **8 seconds** while still alive, show a non-modal bar: *"Your program is still running."* with a Stop button. Do not auto-kill — some legitimate drawings are slow. Never block the UI with a dialog.

---

## 8. Indentation subsystem

This is the highest-value subsystem in the project. Treat it as a first-class feature, not editor configuration.

### Prevention

- `indentUnit` = 4 spaces; `EditorState.tabSize` = 4.
- **Tab** → `indentMore`, **Shift-Tab** → `indentLess`. A literal `\t` can never be inserted by keystroke.
- **Paste sanitizer** — a CodeMirror `transactionFilter` on every inserted text:
  1. Normalize line endings CRLF/CR → LF.
  2. Expand tabs to the **next 4-column stop** (not a blind 4-space swap — blind swapping corrupts pasted code that was already aligned).
  3. Replace **U+00A0** (non-breaking space), U+2000–U+200A, U+202F, U+205F, U+3000 with a normal space.
  4. Strip U+FEFF (BOM) and U+200B (zero-width space).
  5. If anything changed, show a dismissible note: *"Cleaned up invisible characters from the pasted code (3 tabs, 12 non-breaking spaces)."*

> **Note.** Step 3 is very likely the cause of the "code *looks* correctly indented" failures you've hit. Copying Python from a web page, a PDF, or a Google Doc frequently yields U+00A0 instead of U+0020. It is visually identical in every editor font, and Python rejects it with a message that appears to make no sense. Almost no classroom editor handles this. It is cheap to fix and worth surfacing loudly.

### Visibility

- **Show whitespace** toggle in the toolbar, state persisted. When on: leading spaces render as faint centre dots, tabs (if any survive) as a distinct arrow glyph in a warning colour, trailing whitespace highlighted.
- **Indentation guides**: light vertical rules at each 4-column level.
- Any line containing a literal tab in its leading whitespace gets a persistent gutter warning icon regardless of the toggle.

### String-aware body cleaning (implemented in Phase 2)

The original spec protected the rest of a line with a crude rule: skip it if the
line contains any quote character. That is badly wrong for turtle code, which is
full of quoted colour names — `t.pencolor( "red")` with a non-breaking space
*outside* the string was left broken because the line happened to contain quotes.

`sanitize.js` now locates Python string literals exactly (`stringSpans()`),
protecting only the characters actually inside a literal. Single, triple,
escaped and unterminated quotes are all handled, and comments are deliberately
*not* protected because rewriting a look-alike space in a comment cannot change
behaviour.

**Why a scanner rather than Python's `tokenize`.** We have real CPython in the
worker and it would give an exact answer, but paste must be handled
synchronously — a worker round-trip would make every paste async and racy
against the next keystroke. The scanner fails in the safe direction: treating
code as string means a missed fix and a note to the student, never a corrupted
program.

### Repair

**Normalize indentation** toolbar command and lint quick-fix. Operates on the whole document:

1. Expand tabs to 4-column stops.
2. Replace exotic Unicode spaces with U+0020.
3. Strip trailing whitespace on every line.
4. Normalize line endings to LF.
5. Ensure a single trailing newline.

Report what changed in a toast. Register as an undoable transaction so Ctrl-Z reverts it.

---

## 9. Persistence

No save operation touches a network. There is nothing to fail.

### IndexedDB (`turtle-editor` database)

```
projects:   { id, name, code, updatedAt, createdAt }
snapshots:  { id, projectId, code, at }         // index on [projectId, at]
settings:   { key, value }                       // showWhitespace, lastProjectId, speed
```

- **Autosave:** debounced 400 ms after typing stops → write `projects`.
- **Snapshots:** every 30 s, if `code` differs from the newest snapshot, append. Prune to the **newest 50 per project** on write.
- **History panel:** list snapshots with relative timestamps ("14 minutes ago") and a line-count delta. Selecting one shows a read-only diff; **Restore** creates a *new* snapshot of the current state first, then replaces the buffer. Restoring is never destructive.

### Belt and braces

Mirror the current buffer to `localStorage` on the same debounce. If IndexedDB is unavailable (Safari private browsing, quota exhaustion, corrupted store), fall back transparently and show a persistent, quiet indicator that history is unavailable this session.

Wrap **every** storage read and write in `try/catch`. A storage failure must never lose the in-memory buffer or break the editor.

### Explicit export

- **Download `.py`** — always available, all browsers.
- **Save to file…** — File System Access API (`showSaveFilePicker`) on Chrome and Edge. Retain the `FileSystemFileHandle` in IndexedDB so subsequent saves are one click to the same file. This is the killer feature for students keeping work in a OneDrive- or Drive-synced folder. Not available in Safari or Firefox — feature-detect and hide the button rather than showing a broken one.

### Unload guard

`beforeunload` prompt only if the last successful autosave is more than 2 seconds stale. In normal operation it never fires — which is the point.

---

## 10. Share links

### Codec (`src/storage/share.ts`)

```
encode:  code (string)
      → UTF-8 bytes
      → prepend version byte 0x01
      → CompressionStream('deflate-raw')
      → base64url (no padding)
      → location.hash = "#c=" + payload
```

Decode reverses it. Both `CompressionStream` and `DecompressionStream` are available in all target browsers.

Expected size: a 60-line turtle program (~1.4 KB) compresses to roughly 500 bytes → ~670 characters of base64url.

### Rules

- **The fragment is never sent to a server.** Browsers do not transmit `#...`. This is what makes the feature private by construction and is worth stating in the UI.
- **Opening a shared link never overwrites the current buffer.** It creates a *new* project ("Shared program — Sept 10") and switches to it. Clobbering a student's work with a classmate's link would be exactly the failure mode this project exists to eliminate.
- A shared program opens with a banner: *"You opened someone else's program."* plus a **Make a copy** action. The banner clears once edited.
- **Length warning** above ~12,000 payload characters: browsers handle far more, but Google Classroom, Canvas, and email clients silently truncate long URLs. Warn before the student discovers this the hard way.
- **Version byte** allows the format to change later without breaking old links.

### Round-trip requirement

`decode(encode(s)) === s` byte-for-byte, including trailing newlines, CRLF, non-ASCII identifiers, and emoji in strings. This is a test-suite entry, not an assumption.

---

## 11. Image export

Both exporters consume the same display list. Neither ever touches the visible canvas.

### SVG

Serialize to `<svg viewBox="llx lly w h">` with:

- background as a full-bleed `<rect>`,
- `line` ops → `<path d="M…L…">` with `stroke-linecap="round"` (turtle's pen is round),
- consecutive collinear-continuing lines with identical style merged into one `<path>` — meaningfully reduces file size on dense drawings,
- `poly` → `<polygon>`, `dot` → `<circle>`, `text` → `<text>` with matching `text-anchor`,
- `shape-rendering="geometricPrecision"`,
- explicit `width`/`height` attributes so it opens correctly in Illustrator, Inkscape, and Word.

Checkbox: **include the turtle cursor** (default off).

### PNG

Render the display list to an `OffscreenCanvas` at scale factor S. Offer **1×, 2×, 4×**, and a custom pixel width. Options: transparent background (skip the background rect), include cursor.

**Never** `visibleCanvas.toDataURL()`. That caps output at the on-screen pixel size and is precisely the "loss on export" behaviour we're replacing.

### Filenames

`<project-name>.svg` / `<project-name>@2x.png`, slugified.

---

## 12. Deployment

### Cloudflare Pages, free tier

Unlimited static requests and bandwidth; 500 builds/month; **25 MiB per file** cap and 20,000 files per site — verify at build time that no Pyodide asset exceeds the file cap.

### `public/_headers`

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer

/pyodide/*
  Cache-Control: public, max-age=31536000, immutable

/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

`connect-src 'self'` is the enforceable form of the no-AI, no-telemetry guarantee, and it is what the review brief cites. **It must be verified in CI**, because a future dependency that fetches something would otherwise fail silently in class rather than at build time.

> **Corrected in Phase 0.** This spec originally called for `connect-src 'none'`. That value does not work: Pyodide fetches `pyodide.asm.wasm` and `python_stdlib.zip` over the network at boot, and `'none'` blocks those too — verified empirically, the runtime fails to start at all. `'self'` is the correct and still-strong policy: the page may talk only to its own origin, and that origin is a static file host with no API to receive anything. The brief has been corrected to match, since it was making a claim to Technology Services that would not have survived inspection.

`'wasm-unsafe-eval'` is required for WebAssembly compilation and is the narrow modern replacement for `unsafe-eval`.

### Service worker

Precache Pyodide assets and the app bundle on first visit; cache-first for versioned paths, network-first for `index.html`. Day 2 onward is an instant, fully offline-capable load.

### Pyodide loading

- Pin one exact version. Record it in `README`.
- `loadPyodide({ indexURL: '/pyodide/', packages: [] })` — base runtime only. No `micropip`, no `numpy`. Keeps the payload near the ~10–12 MB floor.
- Measure the actual byte total of the pinned release during Phase 0 and record it; the brief's network estimate depends on it.

---

## 13. Testing

| Suite | Contents | Asserts |
|---|---|---|
| `test/golden/` | ~15 reference programs: square, spiral, nested fills, `circle()` arcs, `write()` with each alignment, stamps, `setworldcoordinates`, colour modes | Rendered SVG matches committed golden; PNG matches within a small pixel tolerance |
| `test/errors/` | ~30 broken programs, one per gloss-table row plus uncovered cases | Exact `lineno`/`offset`/`end_offset`, correct gloss selected, traceback contains zero non-student frames |
| `test/indent/` | Tab-indented, mixed tab/space, NBSP-laden, CRLF, BOM-prefixed, already-clean files | Sanitizer output byte-exact; clean files pass through **unchanged** |
| `test/share/` | ASCII, Unicode identifiers, emoji in strings, 10 KB file, empty file, trailing-newline variants | `decode(encode(s)) === s` |
| `test/csp.test.mjs` | `_headers`, `serve.mjs`, all of `src/` | `connect-src 'self'` (and **not** `'none'`); no `unsafe-eval`; no external origin in our source; no socket opened; no completion extension registered; dev CSP read from `_headers` rather than duplicated |

Golden-image tests are the ones that catch renderer drift between canvas, SVG, and PNG — the single most likely source of "the export doesn't match what I saw."

---

## 14. Build phases

**Phase 0 — skeleton. ✅ COMPLETE.** Plain ESM (see §16), three-pane layout, self-hosted Pyodide in a worker, `print()` round-trips to a console pane, Run/Stop with a pre-warmed spare, `compile()` pre-pass with exact error positions, traceback sanitiser, whitespace sanitiser with unit tests. *Exit criteria met: `print("hi")` works and Pyodide's real byte size is recorded (§17).*

**Phase 1 — turtle. ✅ COMPLETE.** Shim with motion, pen, colour, fill, circle, dot, stamp, write, screen methods, multiple turtles and the unsupported-feature messages; op protocol; canvas renderer with speed pacing. *Exit criteria met: a spiral program draws and Stop kills an infinite loop cleanly.*

**Phase 2 — errors and indentation. ✅ COMPLETE.** CodeMirror 6 (vendored as a single bundle), Python syntax highlighting, exact inline error ranges with a quick fix, visible-whitespace toggle, always-visible tab marks, string-aware paste sanitiser, Normalize command. *Exit criteria met.*

**Phase 3 — persistence, sharing, export. ✅ COMPLETE.** IndexedDB autosave, snapshot history with preview and non-destructive restore, multiple programs, share codec, SVG and PNG export, File System Access. *Exit criteria met: round-trip and pixel-comparison suites pass.*

**Phase 4 — production. ✅ COMPLETE.** Service worker with offline start, `_headers` and CSP with an automated check, six example programs, favicon, deployment guide. *Exit criteria met: the editor starts and runs Python with the network switched off.*

Phases 0–2 are the ones that determine whether this is better than what you have now. Phases 3–4 are what make it durable.

---

## 15. Decisions (resolved)

1. **`undo()`** — **not implemented.** Raises `NotSupportedHere` with an explanation. Avoids a parallel checkpoint stack in the shim for a feature intro classes rarely use.
2. **Multiple turtles** — **supported.** `t1 = Turtle(); t2 = Turtle()` must work. The op stream already carries a `turtles[]` array; `RawTurtle`/`TurtleScreen` semantics are a Phase 1 exit test.
3. **Layout** — **three panes**: editor and canvas side by side, console spanning the full width underneath. Built and working in Phase 0. Collapses to a single column under 820px.
4. **Starter programs** — **yes, eventually.** 5–6 read-only examples from the empty state. Deferred to Phase 4; not needed to make the tool useful.

---

## 15b. Phase 2 results

| | |
|---|---|
| CodeMirror bundle | 884 KB, built once with esbuild, vendored like Pyodide |
| Verification | **192 checks** across five suites, all passing |
| `test/sanitize.test.mjs` | 46 — whitespace and string-literal scanning |
| `test/renderer.browser.mjs` | 34 |
| `test/phase0.browser.mjs` | 29 |
| `test/phase1.browser.mjs` | 47 |
| `test/phase2.browser.mjs` | 36 — the editor |

**What CodeMirror bought us**, concretely: Python syntax highlighting; error
ranges that underline the exact characters `compile()` named; a **Clean up
indentation** quick fix attached to the `TabError` diagnostic; and visible
whitespace — a dot per leading space behind a toggle, with **tabs marked at all
times whether the toggle is on or not**, because a tab in Python source is a
latent bug that should never be invisible.

The interim textarea editor has been deleted. The `vendor/codemirror/` bundle is
now a required build artifact, exactly like `vendor/pyodide/`.

Three bugs found by testing:

1. **`linter(() => [])` wiped our diagnostics.** Registering a lint source that
   returns nothing clears the diagnostic set every time it runs. `setDiagnostics()`
   installs the lint state field by itself, so no source should be registered at all.
2. **Spreading a transaction spec and then reassigning `effects`.** Written as
   `{...setDiagnostics(...), effects: scrollIntoView(...)}`, the second `effects`
   key silently overwrites the first — so the diagnostic payload never reached
   the editor. The two effect lists have to be concatenated. A plain JavaScript
   footgun, invisible in review.
3. **CPython points *past* the end of a line** for a missing colon or an
   unclosed bracket. A zero-width range renders as an invisible point marker, so
   the editor now backs up one character and underlines the last token: there has
   to be something on screen for a student to see.

## 15c. Phase 3 results

| | |
|---|---|
| Verification | **260 checks** across seven suites, all passing |
| `test/share.test.mjs` | 24 — codec round-trip, no browser needed |
| `test/phase3.browser.mjs` | 44 — storage, sharing, export |

### Deviations from this spec, and why

- **Snapshot preview is the text plus a line-count comparison, not a
  character-level diff.** The question a student is answering is "is this the
  version I want?", and reading the code answers it. A real diff is a lot of
  machinery for a marginal gain.
- **The File System Access handle is kept in memory, not IndexedDB.** A stored
  handle needs a fresh permission prompt on every page load, which costs more
  friction than the feature saves. Within a session the second save onwards is
  still one click to the same file.
- **A shared link strips its own fragment after importing.** Without that, every
  reload would import the same program again and a student who left the tab open
  would return to a pile of duplicates.

### Bugs found by testing

1. **A hash-only URL change does not reload the page.** Pasting a share link into
   an already-open editor did nothing at all. Now handled via `hashchange`, which
   is also the path the test exercises.
2. **Switching programs left the previous drawing on the canvas**, so an export
   could attribute one program's picture to another's name. `loadProject()` now
   resets the renderer.
3. **`.banner { display: flex }` silently defeated the `[hidden]` attribute**, so
   the shared-program banner showed on every fresh load. The browser's `[hidden]`
   rule is a plain `display: none` that any author rule outranks. Fixed globally
   with `[hidden] { display: none !important; }`.
4. **The test that should have caught #3 was checking the wrong thing** — the
   `hidden` DOM property rather than actual visibility. It passed while the
   banner was plainly on screen. Assertions about UI now check what a person can
   see.
5. **Phase 3 filled the toolbar past its width**, wrapping it to two lines with
   labels broken mid-word. Now a single non-wrapping row.

### The export check that matters

`test/phase3.browser.mjs` renders the display list to PNG, draws the live canvas
into a second canvas of the same size, and compares pixel by pixel. Under 2%
may differ (resampling tolerance). This is the guarantee that an exported image
is what the student actually saw — and the reason PNG export instantiates the
*same* `TurtleRenderer` at a different pixel ratio rather than reimplementing
painting. Two painters drift; one cannot.

## 15d. Phase 4 results

| | |
|---|---|
| Deployable site | 33 files, 15 MB, largest 9.6 MB (host cap is 25 MiB) |
| Verification | **307 checks** across nine suites, all passing |
| `test/csp.test.mjs` | 20 — deployment safety, no browser needed |
| `test/phase4.browser.mjs` | 27 — examples, service worker, offline |

### Caching strategy, and why it is split

The service worker uses **opposite** strategies for the two kinds of asset:

- **`vendor/**` cache-first, never revalidated.** 12.9 MB of pinned Pyodide and
  CodeMirror, byte-identical every time. Day two onward they never touch the
  network, which removes school wifi from the critical path.
- **Everything else network-first, cache as fallback.** Our own code is small.
  Serving it from cache would mean a teacher pushes a fix and students keep
  running the old version until somebody works out how to clear a service
  worker — a genuinely awful failure mode for a tool nobody is paid to maintain.

Fast where it matters; never stale where it matters. `CACHE_VERSION` in `sw.js`
must be bumped whenever `vendor/` changes — noted in `DEPLOY.md`.

### The CSP is now checked, not just written

`test/csp.test.mjs` runs without a browser and asserts that `connect-src` is
`'self'` and specifically **not** `'none'` (which breaks Pyodide's own wasm
fetch — the error this spec already made once), that `unsafe-eval` is absent,
that no external origin appears anywhere in our source, that nothing opens a
socket, and that no completion extension is registered. The review brief makes a
claim to Technology Services; this is what keeps that claim true.

**`serve.mjs` now reads its CSP from `_headers`** rather than repeating it. A
hard-coded copy had already drifted once — dev and production disagreed, and the
disagreement was invisible until tested directly. One source of truth makes that
impossible, and a test asserts the duplicate has not come back.

### Bugs found by testing

1. **The dropdown menus were clipped in half.** The `overflow-x: auto` added in
   Phase 3 to stop the toolbar wrapping also created a clipping context for
   absolutely-positioned children. Fixed with `position: fixed` menus placed
   from the button's rect; both menus are now checked to be fully on screen.
2. **The leftover hard-coded CSP in `serve.mjs`.** The edit that was supposed to
   replace it silently did not match, so dev kept serving the old policy — caught
   by the drift check written moments earlier.

### Every example is executed by the test suite

All six starter programs are run in a real browser and asserted to finish
without error *and* to produce marks. Shipping a broken example to beginners is
worse than shipping none: a student cannot tell our mistake from theirs, and
will assume it is theirs.

## 15e. Cross-platform fix (found on first Windows run)

`test/csp.test.mjs` derived the project root with
`new URL('..', import.meta.url).pathname`. On macOS and Linux that yields
`/home/user/project/` and works. **On Windows it yields `/C:/Users/...` — with a
leading slash** — so `join()` produced `C:\C:\Users\...` and every read failed
with a raw `ENOENT` stack.

The fix is `fileURLToPath()`, which is what `serve.mjs` already used. Two things
follow from this:

1. **`.pathname` is never the right way to turn a file URL into a path.** Use
   `fileURLToPath`. The bug is invisible on the developer's machine and fatal on
   the user's, which is the worst combination.
2. **It was found by a person, not the suite**, because the whole suite was
   developed and run on Linux. Nothing here can catch a Windows-only path bug
   from Linux; the defence is to use the correct API everywhere, not to test
   harder.

Hardened at the same time:

- All six browser suites now resolve the project from their own location and
  spawn `serve.mjs` by absolute path with an explicit `cwd`, so they run from
  any directory rather than only from the project root.
- `csp.test.mjs` checks that it actually found the project and exits with a
  readable message rather than an `ENOENT` stack if it ever does not.
- The README's Playwright setup used `ln -s`, which does not exist on Windows.
  Replaced with `npm install --save-dev playwright && npx playwright install
  chromium`, which is identical on all three platforms.

## 15f. Phase 5 — security and honesty hardening

Prompted by an external audit (`AUDIT-REPORT.md`) and a hosting proposal
(`GITHUB-PAGES-PROPOSAL.md`). Full analysis in `RECOMMENDATION.md`.

| | |
|---|---|
| Verification | **331 checks** across ten suites |
| New: `test/security.browser.mjs` | 12 — exfiltration attempts, measured by arrival |

### The sandbox (§12 addendum)

**Student Python could reach the network, and the brief said it could not.**
Measured before the fix: `import js; js.fetch("/?leak=" + source)` produced a
request that arrived at the server with the program in the query string. The CSP
never prevented this — `connect-src 'self'` permits same-origin requests by
definition.

`src/runner/sandbox.js` removes the primitives from the worker once Pyodide has
booted: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`,
`Worker`, `BroadcastChannel`, `indexedDB`, `caches`.

Three judgements worth recording:

- **`Worker` had to go.** A nested worker starts with a *pristine* global scope,
  so leaving it would have undone the whole sandbox in three lines. Neither the
  audit nor the proposal mentions this.
- **`navigator` was deliberately kept.** `sendBeacon` is not exposed in this
  worker scope, so it is not an exfiltration channel; removing it would risk
  breaking library code for no security gain. An earlier draft removed it
  reflexively.
- **`postMessage` obviously stays** — the turtle op stream travels on it.

Timing matters: Pyodide needs `fetch` for its own wasm and standard library, and
needs nothing from the network afterwards.

### Why this also settles the hosting question

A `<meta>` CSP **does not apply to Web Workers**. Measured: under a header CSP a
cross-origin request from student Python was blocked; under a `<meta>` CSP the
identical request arrived at a listener on another port. Since GitHub Pages
cannot set headers, a CSP-only defence would protect nothing there.

With the sandbox in place, the CSP becomes a second layer rather than the only
one, and the host's header capability stops being a security requirement. That
is what makes GitHub Pages a viable target — not the proposal's argument, which
was incorrect.

### Honest save reporting (§9 addendum)

`persist()` assumed success and the UI showed "Saved" on a 600 ms timer with no
reference to whether anything was written. Now:

- IndexedDB writes resolve on **`tx.oncomplete`, not `request.onsuccess`** — a
  quota error surfaces when the transaction commits, so the earlier signal was
  the wrong one to trust.
- Three distinct states: **Saved** / **Saved (this browser only)** / **NOT
  SAVED**, each with a console explanation and, for the failure cases, something
  the student can act on.
- Tested by breaking `indexedDB` and `localStorage` in the browser and asserting
  the UI does *not* claim success.

### Share-link decompression cap (§10 addendum)

`DecompressionStream` was read with `new Response(stream).arrayBuffer()`, which
buffers everything before any limit could apply. A 2 MB zip bomb compresses to a
**2,735-character link** that looks entirely innocent. Now capped at 512 KB,
read chunk by chunk, refused with a plain-language message.

### `BRIEF.md` rewritten

The absolute claim ("never transmitted anywhere") is replaced by two layers that
are each checkable, plus an explicit section on what the host *does* see —
ordinary connection logs. Stating that plainly is better governance material
than an absolute that does not survive inspection.

## 16. Build environment constraint (discovered in Phase 0)

**Neither build environment can reach the npm registry.** The local VM has no network at all; the cloud container's egress allowlist blocks `registry.npmjs.org`. GitHub release downloads *are* permitted, which is how Pyodide is vendored.

This forces one architectural change, and it is arguably an improvement:

> **The app has no build step and no npm dependencies.** It is plain ES modules, served statically. `node serve.mjs` (zero dependencies, ~80 lines) is the entire local toolchain.

Consequences:

- **Deployment is copying a folder.** No Vite, no bundler, no `node_modules`, no lockfile drift. For a tool that has to survive years of occasional teacher maintenance, this is a real durability win — there is no build that can rot.
- **CodeMirror 6 is deferred.** It is the only genuinely needed npm package, and it requires bundling. Phase 0 ships a textarea implementing the SPEC §8 indentation rules directly. The sanitiser (`src/editor/sanitize.js`) and the key handlers hold all the real logic and port to CodeMirror unchanged; only the mounting code is throwaway.
- **To add CodeMirror**, run `npm install` on a machine with internet, bundle CodeMirror to a single ESM file, and drop it in `vendor/`. The app imports it via an import map. Still no build step for our own code.
- **TypeScript is deferred** for the same reason. Source is plain JS with JSDoc type annotations, which `tsc --checkJs` can verify later without changing a line.

## 17. Phase 0 results (measured, not estimated)

| Metric | Value |
|---|---|
| Pyodide version | 314.0.6 |
| Python version | **3.14.2** |
| Runtime size on disk | **12.90 MB** |
| Runtime size over the wire (gzip) | **6.04 MB** |
| Worker cold boot | 2.2–3.0 s |
| Cold page load to interactive | ~2.5–3.7 s |
| Stop an infinite loop | **24–45 ms** |
| Run after Stop (pre-warmed spare) | **~67 ms** |
| Verification suite | 28 browser checks + 24 unit checks, all passing |

Two findings worth carrying forward:

1. **The `linecache` bug** (§7b, step 0) — without it, tracebacks lose source lines and carets entirely. It would have been easy to ship and hard to notice.
2. **The CSP correction** (§12) — `connect-src 'none'` is not viable, and the brief was claiming it to Technology Services.

## 18. Phase 1 results

| | |
|---|---|
| Verification | 119 checks across four suites, all passing |
| `test/sanitize.test.mjs` | 24 — whitespace repair, no browser needed |
| `test/renderer.browser.mjs` | 23 — renderer against a *synthetic* op stream |
| `test/phase0.browser.mjs` | 28 — Python, errors, Stop |
| `test/phase1.browser.mjs` | 44 — `import turtle` through to pixels |

**Testing the renderer against a synthetic op stream was worth the extra file.** When a drawing comes out wrong, that suite answers "renderer or shim?" without any guessing. It caught both Phase 1 bugs on its own, before the Python side existed.

Three things found by testing:

1. **The cursor transform had a sign error.** Transcribed from memory of CPython's `_polytrafo` with the y-sign flipped, which produced a matrix with determinant −1 — a rotation *plus a reflection*. At heading 0 it looked perfect, so a casual check would have passed it; at heading 90 every turtle pointed backwards. Both headings are now pinned by tests.
2. **`setworld` repainted from `committed` before the current batch had been added to it**, silently erasing anything drawn after a `setworldcoordinates` in the same flush. Fixed by recording ops *before* any repaint, and by splitting ops explicitly into MARKS and STATE.
3. **The CSP forbids inline `<script>`.** Correct and intended, but it means every test fixture needs an external module file too.

### Cursor leads the line (§5.3 addendum)

The worker reports turtle state once per 128-op flush, but pacing means the drawing lags behind that. Painting the cursor where Python says it is shows the turtle running *ahead of its own line* — which destroys exactly the illusion students are watching for.

While a backlog exists and there is exactly one turtle, the renderer draws the cursor at the **pen tip** — the end of the last segment actually painted — instead of at the reported position. With several turtles there is no way to know whose line the last segment was, so it falls back to reported state. Pinned by a renderer test.

### Post-Phase-1 fix: speed() did nothing

Reported from real use: "all is rendered faster than I can see at every speed."
Two separate causes, both now fixed and pinned by tests.

1. **The app flushed the render queue the instant Python finished.** Since a
   typical program executes in single-digit milliseconds, the entire drawing was
   dumped in one frame and pacing never ran at all. The run result is now
   reported immediately, and the status waits on `renderer.whenIdle()`.
2. **The pacing model was wrong anyway.** Draining N ops per frame means a
   four-segment square takes four frames at every speed. Replaced with CPython's
   distance-based hop formula (see section 5, Animation model).

Measured after the fix, drawing a 120-unit square: **speed(1) 2.5 s, speed(10)
112 ms, speed(0) 0 ms.**

Worth noting for later phases: neither the renderer suite nor the Phase 1 suite
caught this, because both drove the renderer directly or ran at `speed(0)`. The
bug lived in the *wiring* between them. There is now a timing test that runs the
same program at three speeds and asserts they differ.

### Deliberate deviations from desktop turtle

- **`write(move=True)`** advances the pen by an estimate (`0.6 × font size × length`). Real turtle measures the rendered text; Python cannot, from here.
- **`setworldcoordinates`** with an aspect ratio that does not match the canvas letterboxes rather than stretching. Arguably better, but different.
- **`mode("logo")`** affects `heading()`, `setheading()` and `towards()` only; `left()` and `right()` remain visually left and right, as on the desktop.
- **Default `speed()` is 6** ("normal"). CPython's default is not clearly documented; this is a classroom choice — fast enough not to waste a period, slow enough to watch.

---

## Appendix — reference links

- Pyodide, downloading and deploying: https://pyodide.org/en/stable/usage/downloading-and-deploying.html
- Raspberry Pi Foundation Pyodide turtle (GPLv3, archived): https://github.com/RaspberryPiFoundation/turtle
- basthon-turtle: https://pypi.org/project/basthon-turtle/0.4.0/
- Turtle on Pyodide discussion: https://github.com/pyodide/pyodide/discussions/4181
- Cloudflare Pages limits: https://developers.cloudflare.com/pages/platform/limits/
- File System Access API: https://developer.chrome.com/docs/capabilities/web-apis/file-system-access
- CPython `turtle` documentation (the API contract to match): https://docs.python.org/3/library/turtle.html
