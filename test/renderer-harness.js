/** Test fixture: exposes a bare TurtleRenderer for renderer.browser.mjs.
 *  External file rather than an inline script because the app's CSP
 *  (script-src 'self') forbids inline execution -- as it should. */
import { TurtleRenderer } from '../src/turtle/renderCanvas.js';

const r = new TurtleRenderer(document.getElementById('c'));
r.reset({ llx: -300, lly: -300, urx: 300, ury: 300 });
r.setSpeed(0);

window.__r = r;
window.__feed = (ops, turtles) => {
  r.enqueue({ ops, turtles: turtles ?? [], seq: 0 });
  r.flushAll();
};
document.body.dataset.ready = '1';
