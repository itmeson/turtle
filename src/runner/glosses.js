/**
 * Plain-language glosses for CPython error messages — SPEC.md section 7a.
 *
 * Rules, in order of importance:
 *   1. CPython's real message is ALWAYS shown, verbatim and first.
 *   2. The gloss is secondary and clearly labelled. Students must end the year
 *      able to read a real Python error, not dependent on our paraphrase.
 *   3. No gloss is better than a wrong gloss. Unmatched messages get nothing.
 *
 * Phase 0 seeds the highest-frequency entries to prove the pipeline. The full
 * table lands in Phase 2 alongside the quick-fix actions.
 */

/**
 * @typedef {object} Gloss
 * @property {RegExp} match     tested against CPython's message
 * @property {(m: RegExpMatchArray) => string} text
 * @property {'normalize'} [fix] quick-fix action the UI can offer
 */

/** @type {Gloss[]} */
const SYNTAX_GLOSSES = [
  {
    match: /^expected ':'/,
    text: () =>
      "Python expects a colon at the end of this line. Lines that start a block -- if, for, while, def -- all end with a colon.",
  },
  {
    match: /^expected an indented block after '(.+)' statement on line (\d+)/,
    text: (m) =>
      `Line ${m[2]} opens a block with '${m[1]}', so the line after it has to be indented. Nothing underneath it is indented.`,
  },
  {
    match: /^unexpected indent/,
    text: () =>
      "This line is indented, but the line above it doesn't start a block. Only a line ending in a colon starts an indented block.",
  },
  {
    match: /^unindent does not match any outer indentation level/,
    text: () =>
      "This line is indented less than the block it was in, but it doesn't line up with any block outside it either. Use Clean up indentation to see whether tabs or invisible characters are involved.",
    fix: 'normalize',
  },
  {
    match: /^inconsistent use of tabs and spaces in indentation/,
    text: () =>
      "This program mixes tab characters and spaces for indentation. They look identical on screen, but Python counts them differently. Clean up indentation will convert every tab to spaces.",
    fix: 'normalize',
  },
  {
    match: /^'(.+)' was never closed/,
    text: (m) =>
      `This opening ${m[1]} never gets a matching closing one. Check the lines above for a bracket you didn't close.`,
  },
  {
    match: /^cannot assign to literal/,
    text: () =>
      "The left-hand side of = has to be a variable name. Something like 5 = x doesn't work; you probably meant x = 5.",
  },
  {
    match: /^invalid character '(.+)' \(U\+([0-9A-F]+)\)/,
    text: (m) =>
      `There's a character here (${m[1]}, Unicode U+${m[2]}) that Python doesn't accept in code. This almost always comes from pasting from a web page or a document. Clean up indentation removes most of them.`,
    fix: 'normalize',
  },
];

/** @type {Gloss[]} */
const RUNTIME_GLOSSES = [
  {
    match: /^name '(.+)' is not defined/,
    text: (m) =>
      `Python has never seen the name '${m[1]}'. Either it's a typo, or it's used before the line that creates it, or an import is missing.`,
  },
  {
    match: /^module 'turtle' has no attribute '(.+)'/,
    text: (m) => `The turtle module has no function called '${m[1]}'. Check the spelling.`,
  },
  {
    match: /division by zero/,
    text: () => 'Something divided by zero. Check the value of the variable on the right of the / or % sign.',
  },
  {
    match: /^unsupported operand type\(s\) for (.+): '(.+)' and '(.+)'/,
    text: (m) =>
      `You tried to use ${m[1]} between a ${m[2]} and a ${m[3]}, which Python doesn't allow. A common cause is text that looks like a number -- input() always gives you a string, so it needs int() or float() around it first.`,
  },
];

/**
 * @param {'syntax'|'runtime'} kind
 * @param {string} message
 * @returns {{text: string, fix?: string} | null}
 */
export function glossFor(kind, message) {
  if (!message) return null;
  const table = kind === 'syntax' ? SYNTAX_GLOSSES : RUNTIME_GLOSSES;
  for (const entry of table) {
    const m = message.match(entry.match);
    if (m) return { text: entry.text(m), fix: entry.fix };
  }
  return null;
}
