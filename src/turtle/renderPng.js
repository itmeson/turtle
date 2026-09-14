/**
 * PNG export — SPEC.md section 11.
 *
 * The rule that matters: **never call toDataURL on the visible canvas.** That
 * caps the output at whatever size the pane happened to be and is precisely the
 * "image downloads lose quality" behaviour this project exists to replace.
 *
 * Instead a fresh TurtleRenderer paints the same display list onto a detached
 * canvas at whatever pixel ratio was asked for. Reusing the renderer rather
 * than writing a second painter is deliberate: two painters drift, and then an
 * export stops matching what the student saw on screen.
 */

import { TurtleRenderer } from './renderCanvas.js';

/**
 * @param {import('./ops.js').DisplayOp[]} ops        committed display list
 * @param {{llx:number, lly:number, urx:number, ury:number}} world
 * @param {object} [options]
 * @param {number} [options.scale]            1, 2, 4 ... pixel ratio
 * @param {number} [options.pixelWidth]       exact output width; overrides scale
 * @param {boolean} [options.transparent]     omit the background fill
 * @param {import('./ops.js').TurtleState[]} [options.turtles] cursors to include
 * @returns {Promise<Blob>}
 */
export async function exportPng(ops, world, options = {}) {
  const {
    scale = 2,
    pixelWidth = null,
    transparent = false,
    turtles = [],
  } = options;

  const worldWidth = Math.max(1, world.urx - world.llx);
  const worldHeight = Math.max(1, world.ury - world.lly);

  // Width in CSS units stays the world size; the pixel ratio does the scaling,
  // so geometry is identical to the screen and only the resolution changes.
  const ratio = pixelWidth ? pixelWidth / worldWidth : scale;

  const canvas = document.createElement('canvas');
  const renderer = new TurtleRenderer(canvas, {}, {
    width: worldWidth,
    height: worldHeight,
    pixelRatio: ratio,
  });

  renderer.reset(world);
  renderer.setSpeed(0);                       // no animation: draw it all at once
  renderer.turtles = turtles;
  renderer.enqueue({ ops, turtles, seq: 0, tracing: false });
  renderer.flushAll();

  if (transparent) {
    // compose() paints the background first; redo it without one.
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(renderer.layer, 0, 0);
    for (const t of turtles) {
      if (t.visible) renderer.paintShape(ctx, t);
    }
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not create the PNG.'))),
      'image/png',
    );
  });
}
