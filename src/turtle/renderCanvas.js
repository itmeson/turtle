/**
 * Canvas renderer for the turtle display list — SPEC.md sections 5 and 5.3.
 *
 * Two surfaces:
 *   - an offscreen LAYER holding committed marks. Marks are painted onto it
 *     once and never repainted, so a drawing with 100k segments still animates
 *     at full speed.
 *   - the VISIBLE canvas, repainted each frame as background, then the layer,
 *     then the turtle cursors on top. Cursors move constantly; marks do not.
 *
 * Ops fall into two classes, and keeping them straight is what makes this
 * correct:
 *   MARKS  (line, dot, poly, text, stamp)  append to the layer.
 *   STATE  (bgcolor, setworld, clear, clearstamp)  change how everything is
 *          drawn, so they force a full repaint from the committed list.
 *
 * Animation pacing lives here rather than in Python. The worker emits ops as
 * fast as it can and this queue drains N per frame according to speed(). That
 * keeps `while True` loops interruptible -- a Python-side sleep would make the
 * worker unresponsive and defeat the point of running it in a worker at all.
 */

import { shapePolygon } from './shapes.js';

/**
 * Distance covered per animation frame at a given speed(), in world units.
 *
 * This is CPython's own formula from `TNavigator._goto`:
 *
 *     nhops = 1 + int(distance / (3 * 1.1**speed * speed))
 *
 * where each hop is one screen update. Reproducing it is what makes speed(1)
 * actually feel like speed(1) on the desktop instead of merely "slightly fewer
 * segments per frame". A 100-unit line takes ~31 frames at speed 1 and 2 at
 * speed 10.
 *
 * @param {number} speed 1..10
 */
function hopDistance(speed) {
  return 3 * Math.pow(1.1, speed) * speed;
}

/** Marks that are not lines cost one frame each. */
const MARK_HOP_COST = 1;

/** Past this backlog, pacing is abandoned -- the runaway guard in SPEC 5.3. */
const RUNAWAY_QUEUE = 20000;

const IS_MARK = (op) => op.op === 'line' || op.op === 'dot' || op.op === 'poly'
  || op.op === 'text' || op.op === 'stamp';

export class TurtleRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onFastForward?: () => void, onIdle?: () => void}} [handlers]
   * @param {{width: number, height: number, pixelRatio: number}} [sizeOverride]
   *   Paint at an explicit size instead of measuring the element. This is what
   *   lets PNG export reuse the ON-SCREEN painting code exactly, rather than a
   *   parallel implementation that would drift: an export must look identical
   *   to what the student saw. A detached canvas has clientWidth 0, so without
   *   this it could not be measured at all.
   */
  constructor(canvas, handlers = {}, sizeOverride = null) {
    this.canvas = canvas;
    this.handlers = handlers;
    this.sizeOverride = sizeOverride;
    this.ctx = canvas.getContext('2d');

    /** @type {import('./ops.js').DisplayOp[]} committed ops, kept for repaint and export */
    this.committed = [];
    /** @type {import('./ops.js').DisplayOp[]} */
    this.queue = [];
    /** @type {import('./ops.js').TurtleState[]} */
    this.turtles = [];

    this.world = { llx: -300, lly: -300, urx: 300, ury: 300 };
    this.bg = '#ffffff';
    this.speed = 6;
    this.tracing = true;
    this.fastForward = false;
    this.running = false;
    this.rafId = 0;

    /**
     * A line op partway through being drawn, so long moves animate rather than
     * appearing whole. @type {{op: any, nhops: number, done: number} | null}
     */
    this.partial = null;
    /** @type {Array<() => void>} */
    this.idleWaiters = [];

    // Where the pen actually is, as opposed to where Python says the turtle is.
    // See the note in compose().
    /** @type {{x:number, y:number, heading:number} | null} */
    this.penTip = null;

    this.layer = document.createElement('canvas');
    this.layerCtx = this.layer.getContext('2d');

    this.syncSize();
  }

  /* ------------------------------------------------------------ geometry */

  get cssWidth() {
    return Math.max(1, this.sizeOverride ? this.sizeOverride.width : this.canvas.clientWidth);
  }

  get cssHeight() {
    return Math.max(1, this.sizeOverride ? this.sizeOverride.height : this.canvas.clientHeight);
  }

  get dpr() {
    return this.sizeOverride ? this.sizeOverride.pixelRatio : (window.devicePixelRatio || 1);
  }

  /**
   * World -> screen mapping. Aspect ratio is preserved and the result is
   * letterboxed; with the default world (which matches the canvas) this is
   * exactly 1:1.
   */
  transform() {
    const { llx, lly, urx, ury } = this.world;
    const ww = Math.max(1e-9, urx - llx);
    const wh = Math.max(1e-9, ury - lly);
    const scale = Math.min(this.cssWidth / ww, this.cssHeight / wh);
    return {
      scale,
      ox: (this.cssWidth - ww * scale) / 2 - llx * scale,
      oy: (this.cssHeight - wh * scale) / 2 + ury * scale,
    };
  }

  /** @returns {[number, number]} world point to CSS-pixel point */
  toScreen(x, y) {
    const t = this.transform();
    return [t.ox + x * t.scale, t.oy - y * t.scale];
  }

  /** Set a context up so ops can be drawn directly in world units. */
  applyTransform(ctx) {
    const t = this.transform();
    const d = this.dpr;
    // y is negated: turtle space is y-up, canvas space is y-down.
    ctx.setTransform(t.scale * d, 0, 0, -t.scale * d, t.ox * d, t.oy * d);
  }

  syncSize() {
    const d = this.dpr;
    const w = Math.floor(this.cssWidth * d);
    const h = Math.floor(this.cssHeight * d);
    let changed = false;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      changed = true;
    }
    if (this.layer.width !== w || this.layer.height !== h) {
      this.layer.width = w;
      this.layer.height = h;
      changed = true;
    }
    return changed;
  }

  /* --------------------------------------------------------------- state */

  /** Start a fresh program run. */
  reset(world) {
    this.queue.length = 0;
    this.committed.length = 0;
    this.turtles = [];
    this.fastForward = false;
    this.penTip = null;
    this.partial = null;
    this.tracing = true;
    this.bg = '#ffffff';
    if (world) this.world = world;
    this.syncSize();
    this.clearLayer();
    this.compose();
    this.releaseIdle();
  }

  setSpeed(n) {
    this.speed = Math.max(0, Math.min(10, Math.round(n)));
  }

  /** Is anything still waiting to be drawn? */
  hasPending() {
    return this.queue.length > 0 || this.partial !== null;
  }

  /** Resolves once the drawing has finished playing out. */
  whenIdle() {
    if (!this.hasPending()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  releaseIdle() {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /** True when the drawing should appear all at once rather than animating. */
  get instant() {
    return this.speed === 0 || this.fastForward || !this.tracing;
  }

  /** The canvas changed size: repaint everything at the new resolution. */
  handleResize() {
    this.syncSize();
    this.rerenderAll();
    this.compose();
  }

  /** @param {import('./ops.js').OpBatch} batch */
  enqueue(batch) {
    if (batch.ops && batch.ops.length) this.queue.push(...batch.ops);
    if (batch.turtles) this.turtles = batch.turtles;
    if (typeof batch.speed === 'number') this.setSpeed(batch.speed);
    // tracer(0) means "don't animate, show it when I say update()".
    if (typeof batch.tracing === 'boolean') this.tracing = batch.tracing;

    if (!this.fastForward && this.queue.length > RUNAWAY_QUEUE) {
      this.fastForward = true;
      this.handlers.onFastForward?.();
    }
    this.start();
  }

  /**
   * Abandon pacing and draw everything immediately.
   *
   * NOT called when a program finishes -- that would defeat speed() entirely,
   * since most programs finish in a few milliseconds while their drawing is
   * meant to play out over seconds. This is for "skip the animation".
   */
  flushAll() {
    if (this.partial) {
      this.finishPartial();
    }
    if (this.queue.length) {
      this.commit(this.queue.splice(0, this.queue.length));
    }
    this.compose();
    this.releaseIdle();
  }

  /* ----------------------------------------------------------- animation */

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (this.instant) {
        if (this.partial) this.finishPartial();
        if (this.queue.length) this.commit(this.queue.splice(0, this.queue.length));
      } else {
        this.drainOneFrame();
      }

      this.compose();

      if (this.hasPending()) {
        this.rafId = requestAnimationFrame(tick);
      } else {
        this.running = false;
        this.handlers.onIdle?.();
        this.releaseIdle();
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /**
   * One frame's worth of drawing.
   *
   * A frame is one "hop". A long line is split into several hops so the pen is
   * seen travelling along it; short lines and other marks cost one hop each.
   * State ops are free, because they are bookkeeping rather than drawing.
   */
  drainOneFrame() {
    let hops = 1;

    while (hops > 0) {
      if (this.partial) {
        const p = this.partial;
        p.done += 1;
        this.paintMarks([this.subsegment(p.op, (p.done - 1) / p.nhops, p.done / p.nhops)]);
        if (p.done >= p.nhops) {
          // Record the ORIGINAL op, not the sub-segments: `committed` is what
          // export and repaint consume, and it must stay faithful to what
          // Python emitted.
          this.committed.push(p.op);
          this.partial = null;
        }
        hops -= 1;
        continue;
      }

      if (!this.queue.length) break;
      const op = this.queue[0];

      if (!IS_MARK(op)) {           // state op: free
        this.queue.shift();
        this.commit([op]);
        continue;
      }

      if (op.op !== 'line') {       // dot, poly, text, stamp
        this.queue.shift();
        this.commit([op]);
        hops -= MARK_HOP_COST;
        continue;
      }

      this.queue.shift();
      const nhops = this.hopsFor(op);
      if (nhops <= 1) {
        this.commit([op]);
        hops -= 1;
      } else {
        this.partial = { op, nhops, done: 0 };
      }
    }
  }

  /** How many frames this line should take, per CPython's formula. */
  hopsFor(op) {
    const length = Math.hypot(op.x2 - op.x1, op.y2 - op.y1);
    const per = hopDistance(this.speed);
    if (!(per > 0)) return 1;
    return 1 + Math.floor(length / per);
  }

  /** The piece of `op` between fractions a and b along its length. */
  subsegment(op, a, b) {
    return {
      op: 'line',
      x1: op.x1 + (op.x2 - op.x1) * a,
      y1: op.y1 + (op.y2 - op.y1) * a,
      x2: op.x1 + (op.x2 - op.x1) * b,
      y2: op.y1 + (op.y2 - op.y1) * b,
      color: op.color,
      width: op.width,
    };
  }

  /** Draw whatever remains of the in-flight line and commit the original. */
  finishPartial() {
    const p = this.partial;
    if (!p) return;
    this.paintMarks([this.subsegment(p.op, p.done / p.nhops, 1)]);
    this.committed.push(p.op);
    this.partial = null;
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.queue.length = 0;
    this.partial = null;
    this.releaseIdle();
  }

  /* ------------------------------------------------------------ committing */

  /**
   * Accept a slice of ops: record them, then either append their marks to the
   * layer (the fast common path) or repaint from scratch if any of them
   * changed global state.
   *
   * The ops are recorded BEFORE any repaint. An earlier version repainted from
   * `committed` while the current slice was still outside it, which silently
   * erased anything drawn after a setworld in the same batch.
   *
   * @param {import('./ops.js').DisplayOp[]} ops
   */
  commit(ops) {
    let full = false;

    for (const op of ops) {
      switch (op.op) {
        case 'clear':
          // Everything before this is gone; drop it rather than replaying it.
          this.committed.length = 0;
          full = true;
          break;
        case 'clearstamp': {
          const idx = this.committed.findIndex((o) => o.op === 'stamp' && o.id === op.id);
          if (idx >= 0) this.committed.splice(idx, 1);
          full = true;
          break;
        }
        case 'setworld':
          this.committed.push(op);
          full = true;
          break;
        case 'bgcolor':
          this.committed.push(op);
          this.bg = op.color;
          break;
        default:
          this.committed.push(op);
          break;
      }
    }

    if (full) this.rerenderAll();
    else this.paintMarks(ops);
  }

  clearLayer() {
    this.layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.layerCtx.clearRect(0, 0, this.layer.width, this.layer.height);
  }

  /**
   * Repaint the layer from the committed list.
   *
   * State ops are resolved first and last-one-wins, then every mark is painted
   * under the resulting transform. That matches desktop turtle, where
   * setworldcoordinates rescales the drawing that is already on screen rather
   * than leaving earlier strokes at their old scale.
   */
  rerenderAll() {
    for (const op of this.committed) {
      if (op.op === 'setworld') {
        this.world = { llx: op.llx, lly: op.lly, urx: op.urx, ury: op.ury };
      } else if (op.op === 'bgcolor') {
        this.bg = op.color;
      }
    }
    this.clearLayer();
    this.paintMarks(this.committed);
  }

  /* ------------------------------------------------------------- painting */

  /**
   * Paint the marks in `ops` onto the layer. Non-mark ops are skipped: their
   * effects were already resolved in commit()/rerenderAll().
   * @param {import('./ops.js').DisplayOp[]} ops
   */
  paintMarks(ops) {
    const ctx = this.layerCtx;

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!IS_MARK(op)) continue;

      switch (op.op) {
        case 'line': {
          // Merge the longest run of same-styled segments into one path.
          // Turtle programs emit thousands of these and per-path overhead
          // dominates otherwise.
          this.applyTransform(ctx);
          ctx.strokeStyle = op.color;
          ctx.lineWidth = op.width;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(op.x1, op.y1);
          ctx.lineTo(op.x2, op.y2);
          let px = op.x2;
          let py = op.y2;
          let j = i + 1;
          while (j < ops.length) {
            const n = ops[j];
            if (n.op !== 'line' || n.color !== op.color || n.width !== op.width) break;
            if (n.x1 !== px || n.y1 !== py) ctx.moveTo(n.x1, n.y1);
            ctx.lineTo(n.x2, n.y2);
            px = n.x2;
            py = n.y2;
            j++;
          }
          ctx.stroke();
          // Remember where the pen ended up, and which way it was travelling.
          this.penTip = {
            x: px,
            y: py,
            heading: (Math.atan2(py - ops[j - 1].y1, px - ops[j - 1].x1) * 180) / Math.PI,
          };
          i = j - 1;
          break;
        }

        case 'dot':
          this.applyTransform(ctx);
          ctx.fillStyle = op.color;
          ctx.beginPath();
          ctx.arc(op.x, op.y, op.d / 2, 0, Math.PI * 2);
          ctx.fill();
          break;

        case 'poly':
          if (op.pts.length < 2) break;
          this.applyTransform(ctx);
          ctx.fillStyle = op.fill;
          ctx.beginPath();
          ctx.moveTo(op.pts[0][0], op.pts[0][1]);
          for (let k = 1; k < op.pts.length; k++) ctx.lineTo(op.pts[k][0], op.pts[k][1]);
          ctx.closePath();
          ctx.fill();
          break;

        case 'stamp':
          this.paintShape(ctx, op);
          break;

        case 'text':
          this.paintText(ctx, op);
          break;

        default:
          break;
      }
    }
  }

  paintShape(ctx, s) {
    const poly = shapePolygon(s.shape, s);
    if (!poly.length) return;
    this.applyTransform(ctx);
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let k = 1; k < poly.length; k++) ctx.lineTo(poly[k][0], poly[k][1]);
    ctx.closePath();
    ctx.fillStyle = s.fill;
    ctx.fill();
    if (s.outline > 0) {
      ctx.strokeStyle = s.pen;
      ctx.lineWidth = s.outline;
      ctx.stroke();
    }
  }

  paintText(ctx, op) {
    // Text is drawn in screen space: the world transform flips y, which would
    // render glyphs upside down.
    const [sx, sy] = this.toScreen(op.x, op.y);
    const d = this.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const [family, size, style] = op.font;
    const weight = style === 'bold' ? 'bold ' : '';
    const italic = style === 'italic' ? 'italic ' : '';
    const scale = this.transform().scale;
    ctx.font = `${italic}${weight}${Math.max(1, size * scale)}px ${family}, sans-serif`;
    ctx.fillStyle = op.color;
    ctx.textAlign = op.align === 'center' ? 'center' : op.align === 'right' ? 'right' : 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(op.s, sx, sy);
  }

  /** Repaint the visible canvas: background, committed marks, then cursors. */
  compose() {
    const ctx = this.ctx;
    const d = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.drawImage(this.layer, 0, 0);

    // The worker reports turtle state once per flush (128 ops), but pacing
    // means the drawing lags behind that. Painting the cursor where Python
    // says it is would show the turtle running ahead of its own line, which
    // destroys the illusion students are actually watching for.
    //
    // While there is still a backlog and there is exactly one turtle, draw the
    // cursor at the pen tip instead. With several turtles there is no way to
    // tell whose line the last segment was, so fall back to reported state.
    const leading = this.hasPending() && this.turtles.length === 1 && this.penTip;

    for (const t of this.turtles) {
      if (!t.visible) continue;
      this.paintShape(ctx, leading ? { ...t, ...this.penTip } : t);
    }
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }
}
