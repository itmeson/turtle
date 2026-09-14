/**
 * Worker message protocol — SPEC.md section 3.
 *
 * Single source of truth for both sides of the postMessage boundary.
 * Phase 0 carries stdout/stderr and results. Phase 1 adds the turtle op
 * batches; the OpBatch slot is reserved here so the shape does not churn.
 */

/** Worker -> main */
export const FromWorker = {
  /** Pyodide finished booting and the harness is loaded. */
  READY: 'ready',
  /** A batch of stdout text. */
  STDOUT: 'stdout',
  /** A batch of stderr text. */
  STDERR: 'stderr',
  /** A run finished (successfully or with an error). Carries a RunResult. */
  RESULT: 'result',
  /** Phase 1: a batch of turtle display-list ops. */
  OPS: 'ops',
  /** The worker could not start at all. */
  FATAL: 'fatal',
};

/** Main -> worker */
export const ToWorker = {
  /** Begin booting Pyodide. */
  INIT: 'init',
  /** Execute source. Carries { runId, code }. */
  RUN: 'run',
};

/**
 * @typedef {object} SyntaxResult
 * @property {'syntax'} kind
 * @property {string} type        SyntaxError | IndentationError | TabError | ValueError
 * @property {string} msg         CPython's own message, shown verbatim
 * @property {number} lineno      1-based
 * @property {number|null} offset 1-based column
 * @property {number|null} endLineno
 * @property {number|null} endOffset
 * @property {string|null} text   the offending source line
 */

/**
 * @typedef {object} RuntimeResult
 * @property {'runtime'} kind
 * @property {string} type
 * @property {string} msg
 * @property {string} traceback   already stripped to student frames
 * @property {boolean} internalOnly
 * @property {number|null} lineno
 */

/**
 * @typedef {{kind: 'ok'}} OkResult
 * @typedef {OkResult | SyntaxResult | RuntimeResult} RunResult
 */

export {};
