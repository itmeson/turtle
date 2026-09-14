/**
 * Pyodide host — runs in a Web Worker. SPEC.md section 3.
 *
 * Everything Python happens here so that an infinite loop in student code
 * cannot freeze the page. Stop is implemented on the main thread as
 * worker.terminate(), which is unconditional and instant -- that is the whole
 * reason for this file existing as a worker rather than a module.
 */

import { loadPyodide } from '../../vendor/pyodide/pyodide.mjs';
import { FromWorker, ToWorker } from './protocol.js';
import { sealWorkerGlobals } from './sandbox.js';

const PYODIDE_INDEX = new URL('../../vendor/pyodide/', import.meta.url).href;
const HARNESS_URL = new URL('./harness.py', import.meta.url).href;
const TURTLE_URL = new URL('../turtle/turtle.py', import.meta.url).href;

/** @type {any} */
let pyodide = null;
/** @type {((src: string) => string) | null} */
let runSource = null;

const post = (msg) => self.postMessage(msg);

async function init() {
  const t0 = performance.now();
  try {
    pyodide = await loadPyodide({
      indexURL: PYODIDE_INDEX,
      // Base runtime only. No micropip, no numpy -- keeps the payload at the
      // ~12.9MB floor measured in Phase 0.
      packages: [],
    });

    // Pyodide batches these by line, which is what we want: one message per
    // print() rather than one per character.
    pyodide.setStdout({ batched: (text) => post({ type: FromWorker.STDOUT, text }) });
    pyodide.setStderr({ batched: (text) => post({ type: FromWorker.STDERR, text }) });

    const fetchText = async (url, label) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${label} -> HTTP ${r.status}`);
      return r.text();
    };

    const [harness, turtleSource] = await Promise.all([
      fetchText(HARNESS_URL, 'harness.py'),
      fetchText(TURTLE_URL, 'turtle.py'),
    ]);

    // The turtle shim must SHADOW the stdlib module, which would fail on
    // `import tkinter`. Putting it at sys.path[0] is what makes plain
    // `import turtle` work in student code.
    pyodide.FS.mkdirTree('/opt/editor');
    pyodide.FS.writeFile('/opt/editor/_harness.py', harness);
    pyodide.FS.writeFile('/opt/editor/turtle.py', turtleSource);
    pyodide.runPython('import sys; sys.path.insert(0, "/opt/editor")');

    // The shim's only route back to the page. One JSON batch per flush.
    pyodide.registerJsModule('_turtle_bridge', {
      emit: (payload) => post({ type: FromWorker.OPS, payload }),
    });

    const mod = pyodide.pyimport('_harness');
    runSource = mod.run_source;

    // Everything Pyodide needs from the network has now loaded. From here on,
    // student Python must have no way to reach off this machine. See sandbox.js
    // -- this is what makes the privacy claim in BRIEF.md actually true.
    const sealed = sealWorkerGlobals(self);

    const versions = JSON.parse(mod.versions());

    post({
      type: FromWorker.READY,
      pyodideVersion: pyodide.version,
      pythonVersion: versions.python,
      bootMs: Math.round(performance.now() - t0),
      sealed,
    });
  } catch (err) {
    post({
      type: FromWorker.FATAL,
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null,
    });
  }
}

/**
 * @param {string} runId
 * @param {string} code
 * @param {number} width   canvas size in CSS pixels, used as the default world
 * @param {number} height
 */
function run(runId, code, width, height) {
  if (!runSource) {
    post({ type: FromWorker.FATAL, message: 'Worker is not ready yet.' });
    return;
  }
  const t0 = performance.now();
  let result;
  try {
    result = JSON.parse(runSource(code, width, height));
  } catch (err) {
    // A failure here is ours, not the student's: the harness itself threw.
    result = {
      kind: 'runtime',
      type: 'EditorError',
      msg: err && err.message ? err.message : String(err),
      traceback: '',
      internalOnly: true,
      lineno: null,
    };
  }
  post({
    type: FromWorker.RESULT,
    runId,
    result,
    elapsedMs: Math.round(performance.now() - t0),
  });
}

self.onmessage = (event) => {
  const msg = event.data;
  switch (msg && msg.type) {
    case ToWorker.INIT:
      init();
      break;
    case ToWorker.RUN:
      run(msg.runId, msg.code, msg.width ?? 600, msg.height ?? 600);
      break;
    default:
      break;
  }
};
