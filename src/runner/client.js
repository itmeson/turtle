/**
 * Main-thread wrapper around the Pyodide worker. SPEC.md section 3.
 *
 * Responsibilities:
 *   - own the worker lifecycle
 *   - make Stop instant and unconditional (terminate, never cooperate)
 *   - keep a pre-warmed spare so Stop -> Run has no cold start
 *
 * The spare is the part worth explaining. Booting Pyodide takes a couple of
 * seconds. A student whose program hangs will press Stop and immediately press
 * Run again; without a spare they would wait out a full boot every time, which
 * in a 50-minute period is the difference between debugging and giving up.
 */

import { FromWorker, ToWorker } from './protocol.js';

/**
 * @typedef {object} RunnerHandlers
 * @property {(text: string) => void} [onStdout]
 * @property {(text: string) => void} [onStderr]
 * @property {(info: {pyodideVersion: string, pythonVersion: string, bootMs: number, sealed: object}) => void} [onReady]
 * @property {(message: string) => void} [onFatal]
 * @property {(state: 'booting'|'idle'|'running'|'stopped') => void} [onState]
 */

let workerSeq = 0;

export class Runner {
  /** @param {RunnerHandlers} handlers */
  constructor(handlers = {}) {
    this.handlers = handlers;
    /** @type {any} */ this.primary = null;
    /** @type {any} */ this.spare = null;
    /** @type {{runId: string, resolve: Function} | null} */ this.pending = null;
    this.runSeq = 0;
    this.state = 'booting';
  }

  /** @param {'booting'|'idle'|'running'|'stopped'} s */
  setState(s) {
    this.state = s;
    this.handlers.onState?.(s);
  }

  /** Spawn a worker and begin its boot. Returns a handle. */
  spawn() {
    const id = ++workerSeq;
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      type: 'module',
      name: `pyodide-${id}`,
    });

    const handle = { id, worker, info: null, ready: null, dead: false };

    handle.ready = new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const msg = event.data;
        const isActive = this.primary === handle;

        switch (msg.type) {
          case FromWorker.READY:
            handle.info = msg;
            resolve(msg);
            if (isActive) {
              this.handlers.onReady?.(msg);
              this.setState('idle');
            }
            break;

          case FromWorker.STDOUT:
            if (isActive) this.handlers.onStdout?.(msg.text);
            break;

          case FromWorker.STDERR:
            if (isActive) this.handlers.onStderr?.(msg.text);
            break;

          case FromWorker.OPS:
            // Parsed here rather than in the worker: keeping the boundary a
            // plain string avoids proxy lifetime problems on the Python side.
            if (isActive) {
              try {
                this.handlers.onOps?.(JSON.parse(msg.payload));
              } catch (err) {
                this.handlers.onFatal?.(`Bad drawing data from Python: ${err.message}`);
              }
            }
            break;

          case FromWorker.RESULT:
            if (isActive && this.pending && this.pending.runId === msg.runId) {
              const { resolve: done } = this.pending;
              this.pending = null;
              this.setState('idle');
              done({ result: msg.result, elapsedMs: msg.elapsedMs });
            }
            break;

          case FromWorker.FATAL:
            handle.dead = true;
            reject(new Error(msg.message));
            if (isActive) this.handlers.onFatal?.(msg.message);
            break;

          default:
            break;
        }
      };

      worker.onerror = (event) => {
        handle.dead = true;
        const message = event.message || 'Worker failed to load.';
        reject(new Error(message));
        if (this.primary === handle) this.handlers.onFatal?.(message);
      };
    });

    // Swallow rejection here; callers observe it through onFatal or by awaiting.
    handle.ready.catch(() => {});
    worker.postMessage({ type: ToWorker.INIT });
    return handle;
  }

  /** Boot the primary worker. Resolves once Python is ready. */
  async start() {
    this.setState('booting');
    this.primary = this.spawn();
    const info = await this.primary.ready;
    this.prewarm();
    return info;
  }

  /** Boot a spare in the background if there isn't one. */
  prewarm() {
    if (this.spare || !this.primary) return;
    // Deliberately not awaited: the spare warms while the student types.
    this.spare = this.spawn();
  }

  /**
   * Execute source. Resolves with the run result.
   * @param {string} code
   * @param {{width?: number, height?: number}} [canvas] drawing surface size,
   *        which becomes turtle's default world (as the window does on desktop)
   * @returns {Promise<{result: any, elapsedMs: number}>}
   */
  async run(code, canvas = {}) {
    if (!this.primary) await this.start();
    if (this.primary.dead) throw new Error('Python worker is not available.');
    await this.primary.ready;
    if (this.pending) throw new Error('A program is already running.');

    const runId = `r${++this.runSeq}`;
    this.setState('running');

    return new Promise((resolve) => {
      this.pending = { runId, resolve };
      this.primary.worker.postMessage({
        type: ToWorker.RUN,
        runId,
        code,
        width: Math.round(canvas.width ?? 600),
        height: Math.round(canvas.height ?? 600),
      });
    });
  }

  /**
   * Stop whatever is running, immediately.
   * Terminates the worker and promotes the pre-warmed spare.
   * @returns {boolean} whether a run was actually interrupted
   */
  stop() {
    const wasRunning = this.pending !== null;

    if (this.pending) {
      const { resolve } = this.pending;
      this.pending = null;
      resolve({ result: { kind: 'stopped' }, elapsedMs: 0 });
    }

    if (this.primary) {
      this.primary.dead = true;
      this.primary.worker.terminate();
      this.primary = null;
    }

    if (this.spare && !this.spare.dead) {
      this.primary = this.spare;
      this.spare = null;
      // The spare may still be booting; reflect that honestly.
      if (this.primary.info) {
        this.setState('idle');
      } else {
        this.setState('booting');
        this.primary.ready.then(() => {
          if (this.state === 'booting') this.setState('idle');
        }).catch(() => {});
      }
      this.prewarm();
    } else {
      this.primary = this.spawn();
      this.setState('booting');
      this.primary.ready.then(() => {
        if (this.state === 'booting') this.setState('idle');
        this.prewarm();
      }).catch(() => {});
    }

    return wasRunning;
  }
}
