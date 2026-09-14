/**
 * Worker sandbox — removes the network and storage reach of student Python.
 *
 * WHY THIS EXISTS
 *
 * Pyodide exposes JavaScript's global scope to Python through the `js` module.
 * In a Web Worker that scope includes `fetch`, `XMLHttpRequest`, `WebSocket`
 * and friends, so `import js; js.fetch("/?leak=" + source)` is a working
 * exfiltration channel. Measured before this existed: the request arrived at
 * the server with the student's program in the query string.
 *
 * The Content-Security-Policy was supposed to prevent that, and it does stop
 * CROSS-origin requests -- but only when the policy arrives as an HTTP header,
 * and only same-origin requests were ever blocked by `connect-src 'self'`
 * anyway. Two consequences:
 *
 *   1. `BRIEF.md` tells Technology Services that student code cannot be
 *      transmitted anywhere. Without this file that claim is false.
 *   2. A `<meta>` CSP does NOT apply to workers at all, so on a host that
 *      cannot set headers (GitHub Pages) the CSP protects nothing here.
 *
 * Removing the primitives outright fixes both, and does not depend on the host.
 * The CSP then becomes a second line of defence rather than the only one.
 *
 * WHAT IS REMOVED, AND WHAT DELIBERATELY IS NOT
 *
 * Removed -- each is a way for a program to reach off the machine, or to read
 * other students' saved work:
 *   fetch, XMLHttpRequest, WebSocket, EventSource   direct network
 *   importScripts                                   a network request whose URL
 *                                                   can itself carry the payload
 *   Worker                                          a nested worker starts with
 *                                                   a PRISTINE global scope, so
 *                                                   leaving it would undo all of
 *                                                   the above in three lines
 *   BroadcastChannel                                reaches this app's other tabs
 *   indexedDB, caches                               saved programs and history
 *
 * Kept on purpose:
 *   postMessage   the worker's own channel to the page -- the turtle op stream
 *                 travels on it, so removing it would break drawing entirely
 *   navigator     `sendBeacon` is not exposed in this worker scope, so it is not
 *                 an exfiltration channel; removing it risks breaking library
 *                 code for no security gain
 *   Notification  not a data channel, and blocked without permission anyway
 *
 * TIMING: call this only after Pyodide has finished booting. Pyodide needs
 * `fetch` to load its own wasm and standard library. Nothing it does at RUN
 * time touches the network -- the stdlib is already in its virtual filesystem.
 */

/** Global names that are removed from the worker scope. */
export const REMOVED_GLOBALS = Object.freeze([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
  'Worker',
  'BroadcastChannel',
  'indexedDB',
  'caches',
]);

/**
 * Remove them, irreversibly, from this worker's global scope.
 *
 * `configurable: false` matters: without it a program could simply redefine the
 * property and carry on.
 *
 * @param {any} scope defaults to the worker global; injectable for testing
 * @returns {{removed: string[], absent: string[], failed: string[]}}
 */
export function sealWorkerGlobals(scope = globalThis) {
  const removed = [];
  const absent = [];
  const failed = [];

  for (const name of REMOVED_GLOBALS) {
    if (!(name in scope) || scope[name] === undefined) {
      absent.push(name);
      continue;
    }
    try {
      Object.defineProperty(scope, name, {
        value: undefined,
        writable: false,
        configurable: false,
        enumerable: false,
      });
      if (scope[name] === undefined) removed.push(name);
      else failed.push(name);
    } catch {
      failed.push(name);
    }
  }

  return { removed, absent, failed };
}
