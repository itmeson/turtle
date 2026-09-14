/**
 * Display-list op definitions — SPEC.md section 5.
 *
 * This is the central data structure of the project. The live canvas, the SVG
 * export and the PNG export are all renderings of the SAME op stream. That is
 * what makes exports lossless: nothing is ever screenshotted.
 *
 * Coordinates are TURTLE-SPACE: origin at the centre of the world rectangle,
 * y increasing UPWARD. Renderers apply the flip and the scale. Never bake
 * screen coordinates into an op -- doing so forces every exporter to re-derive
 * the geometry, which is how canvas and SVG drift apart.
 */

/**
 * @typedef {string} Color   a CSS colour: "#rrggbb" or a colour name
 *
 * @typedef {{op:'line',   x1:number, y1:number, x2:number, y2:number, color:Color, width:number}} LineOp
 * @typedef {{op:'dot',    x:number, y:number, d:number, color:Color}} DotOp
 * @typedef {{op:'poly',   pts:Array<[number,number]>, fill:Color}} PolyOp
 * @typedef {{op:'text',   x:number, y:number, s:string, font:[string,number,string], align:'left'|'center'|'right', color:Color}} TextOp
 * @typedef {{op:'stamp',  id:number, x:number, y:number, heading:number, shape:string, fill:Color, pen:Color, stretch:[number,number], outline:number, tilt:number}} StampOp
 * @typedef {{op:'clearstamp', id:number}} ClearStampOp
 * @typedef {{op:'clear'}} ClearOp
 * @typedef {{op:'bgcolor', color:Color}} BgColorOp
 * @typedef {{op:'setworld', llx:number, lly:number, urx:number, ury:number}} SetWorldOp
 *
 * @typedef {LineOp|DotOp|PolyOp|TextOp|StampOp|ClearStampOp|ClearOp|BgColorOp|SetWorldOp} DisplayOp
 */

/**
 * A turtle cursor. Not part of the display list: cursors are transient and are
 * repainted every frame on top of the committed drawing.
 *
 * @typedef {object} TurtleState
 * @property {number} x
 * @property {number} y
 * @property {number} heading      degrees, standard maths convention
 * @property {boolean} visible
 * @property {string} shape
 * @property {Color} fill
 * @property {Color} pen
 * @property {[number,number]} stretch
 * @property {number} outline
 * @property {number} tilt
 */

/**
 * One flush from the worker.
 * @typedef {{ops: DisplayOp[], turtles: TurtleState[], seq: number}} OpBatch
 */

/** Ops that change persistent screen state rather than adding marks. */
export const STATE_OPS = new Set(['clear', 'bgcolor', 'setworld', 'clearstamp']);

export {};
