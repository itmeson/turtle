/**
 * SVG export — SPEC.md section 11.
 *
 * True vector output: the display list is already vector geometry in turtle
 * coordinates, so this is a translation rather than a rendering. A student can
 * scale the result to a poster without it going soft, which is the whole point
 * of keeping a display list instead of pixels.
 *
 * SVG's y axis points down and turtle's points up, so every point is flipped
 * here rather than by wrapping the document in a scale(1,-1) group -- a flipped
 * group would also flip the glyphs in `write()` output.
 */

import { shapePolygon } from './shapes.js';

/** Trim coordinate noise; 2dp is well below a pixel at any sane scale. */
const n = (v) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

const escapeText = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

/**
 * @param {import('./ops.js').DisplayOp[]} ops
 * @param {{llx:number, lly:number, urx:number, ury:number}} world
 * @param {object} [options]
 * @param {string} [options.background]   omit for a transparent image
 * @param {import('./ops.js').TurtleState[]} [options.turtles]
 * @param {string} [options.title]
 * @returns {string} a complete standalone SVG document
 */
export function exportSvg(ops, world, options = {}) {
  const { background = '#ffffff', turtles = [], title = 'Turtle drawing' } = options;

  const width = Math.max(1, world.urx - world.llx);
  const height = Math.max(1, world.ury - world.lly);

  // world -> svg
  const X = (x) => x - world.llx;
  const Y = (y) => world.ury - y;

  /** @type {string[]} */
  const body = [];

  if (background) {
    body.push(`<rect x="0" y="0" width="${n(width)}" height="${n(height)}" fill="${escapeAttr(background)}"/>`);
  }

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];

    switch (op.op) {
      case 'line': {
        // Merge the longest run of same-styled segments into one <path>. A
        // spiral is thousands of segments; one path per segment would produce
        // a file several times larger for identical output.
        let d = `M${n(X(op.x1))} ${n(Y(op.y1))}L${n(X(op.x2))} ${n(Y(op.y2))}`;
        let px = op.x2;
        let py = op.y2;
        let j = i + 1;
        while (j < ops.length) {
          const next = ops[j];
          if (next.op !== 'line' || next.color !== op.color || next.width !== op.width) break;
          if (next.x1 !== px || next.y1 !== py) d += `M${n(X(next.x1))} ${n(Y(next.y1))}`;
          d += `L${n(X(next.x2))} ${n(Y(next.y2))}`;
          px = next.x2;
          py = next.y2;
          j += 1;
        }
        i = j - 1;
        body.push(
          `<path d="${d}" fill="none" stroke="${escapeAttr(op.color)}" `
          + `stroke-width="${n(op.width)}" stroke-linecap="round" stroke-linejoin="round"/>`,
        );
        break;
      }

      case 'dot':
        body.push(
          `<circle cx="${n(X(op.x))}" cy="${n(Y(op.y))}" r="${n(op.d / 2)}" `
          + `fill="${escapeAttr(op.color)}"/>`,
        );
        break;

      case 'poly': {
        if (!op.pts || op.pts.length < 2) break;
        const pts = op.pts.map(([x, y]) => `${n(X(x))},${n(Y(y))}`).join(' ');
        body.push(`<polygon points="${pts}" fill="${escapeAttr(op.fill)}"/>`);
        break;
      }

      case 'text': {
        const [family, size, style] = op.font ?? ['Arial', 8, 'normal'];
        const anchor = op.align === 'center' ? 'middle' : op.align === 'right' ? 'end' : 'start';
        const weight = style === 'bold' ? ' font-weight="bold"' : '';
        const italic = style === 'italic' ? ' font-style="italic"' : '';
        body.push(
          `<text x="${n(X(op.x))}" y="${n(Y(op.y))}" `
          + `font-family="${escapeAttr(family)}, sans-serif" font-size="${n(size)}"`
          + `${weight}${italic} text-anchor="${anchor}" `
          + `fill="${escapeAttr(op.color)}">${escapeText(op.s)}</text>`,
        );
        break;
      }

      case 'stamp':
        body.push(polygonFor(op, X, Y));
        break;

      default:
        // bgcolor / setworld / clear were already resolved into `world` and
        // `background` by the caller; they contribute no marks.
        break;
    }
  }

  for (const t of turtles) {
    if (t.visible) body.push(polygonFor(t, X, Y));
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" `
    + `width="${n(width)}" height="${n(height)}" `
    + `viewBox="0 0 ${n(width)} ${n(height)}" shape-rendering="geometricPrecision">`,
    `<title>${escapeText(title)}</title>`,
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

/** Shared by stamps and live cursors so both match the canvas exactly. */
function polygonFor(state, X, Y) {
  const poly = shapePolygon(state.shape, state);
  if (!poly.length) return '';
  const pts = poly.map(([x, y]) => `${n(X(x))},${n(Y(y))}`).join(' ');
  const stroke = state.outline > 0
    ? ` stroke="${escapeAttr(state.pen)}" stroke-width="${n(state.outline)}"`
    : '';
  return `<polygon points="${pts}" fill="${escapeAttr(state.fill)}"${stroke}/>`;
}
