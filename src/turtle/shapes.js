/**
 * Turtle cursor shapes and their orientation transform.
 *
 * Polygon data is copied from CPython's turtle.py so stamps and cursors look
 * like the real thing. Shapes are defined pointing "up" (+y) in their own
 * frame; the transform below rotates that onto the turtle's heading.
 *
 * Living in JS rather than in the Python shim is deliberate: the canvas
 * renderer, the SVG exporter and the PNG exporter must all use identical
 * geometry, and the op stream only carries a shape NAME.
 */

/** @type {Record<string, Array<[number, number]>>} */
export const SHAPES = {
  classic: [[0, 0], [-5, -9], [0, -7], [5, -9]],
  arrow: [[-10, 0], [10, 0], [0, 10]],
  square: [[10, -10], [10, 10], [-10, 10], [-10, -10]],
  triangle: [[10, -5.77], [0, 11.55], [-10, -5.77]],
  circle: [
    [10, 0], [9.51, 3.09], [8.09, 5.88], [5.88, 8.09], [3.09, 9.51],
    [0, 10], [-3.09, 9.51], [-5.88, 8.09], [-8.09, 5.88], [-9.51, 3.09],
    [-10, 0], [-9.51, -3.09], [-8.09, -5.88], [-5.88, -8.09], [-3.09, -9.51],
    [0, -10], [3.09, -9.51], [5.88, -8.09], [8.09, -5.88], [9.51, -3.09],
  ],
  turtle: [
    [0, 16], [-2, 14], [-1, 10], [-4, 7], [-7, 9], [-9, 8], [-6, 5], [-7, 1],
    [-5, -3], [-8, -6], [-6, -8], [-4, -5], [0, -7], [4, -5], [6, -8], [8, -6],
    [5, -3], [7, 1], [6, 5], [9, 8], [7, 9], [4, 7], [1, 10], [2, 14],
  ],
  blank: [],
};

export const SHAPE_NAMES = Object.keys(SHAPES);

/**
 * Place a shape into world coordinates.
 *
 * Shapes are authored pointing "up" (+y). The mapping rotates that onto the
 * turtle's heading, so the shape's +y axis lands along (cos h, sin h):
 *
 *     x' = px + e1 * x + e0 * y
 *     y' = py + e1 * y - e0 * x      where (e0, e1) = (cos h, sin h)
 *
 * That matrix has determinant +1 -- a pure rotation, no reflection. Check it
 * against the two headings that matter: at h = 0 the tip (0, t) lands at
 * (+t, 0), due east; at h = 90 it lands at (0, +t), due north.
 *
 * (An earlier draft transcribed this from memory of CPython's `_polytrafo`
 * with the y-sign flipped, which pointed every cursor backwards at headings
 * off the x-axis. The renderer test now pins both headings.)
 *
 * Stretch is applied first, in the shape's own frame, where +x is across the
 * turtle's width and +y is along its length -- hence stretch[0] scales x and
 * stretch[1] scales y. Tilt then rotates within that frame.
 *
 * @param {string} name
 * @param {{x:number, y:number, heading:number, stretch?:[number,number], tilt?:number}} state
 * @returns {Array<[number, number]>} world-space polygon
 */
export function shapePolygon(name, state) {
  const base = SHAPES[name] ?? SHAPES.classic;
  if (base.length === 0) return [];

  const [sx, sy] = state.stretch ?? [1, 1];
  const tilt = ((state.tilt ?? 0) * Math.PI) / 180;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);

  const h = (state.heading * Math.PI) / 180;
  const e0 = Math.cos(h);
  const e1 = Math.sin(h);

  return base.map(([bx, by]) => {
    // stretch in the shape's own frame
    let x = bx * sx;
    let y = by * sy;
    // tilt within that frame
    if (tilt !== 0) {
      const tx = x * ct - y * st;
      const ty = x * st + y * ct;
      x = tx;
      y = ty;
    }
    // orient the shape's +y axis onto the heading
    return [state.x + e1 * x + e0 * y, state.y + e1 * y - e0 * x];
  });
}
