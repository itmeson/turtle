/**
 * Whitespace sanitiser — SPEC.md section 8.
 *
 * This is the highest-value module in the project. It exists because the most
 * confusing failure in a classroom is code that LOOKS correctly indented and is
 * rejected by Python. The two causes are tab/space mixing and Unicode look-alike
 * spaces (U+00A0 especially, which arrives via copy-paste from web pages, PDFs
 * and Google Docs and is pixel-identical to a normal space in every editor font).
 *
 * Safety rule: never change the meaning of a program. A literal tab or
 * non-breaking space inside a string literal is DATA, not indentation.
 *
 *   - Leading whitespace : always normalised. Python forbids exotic spaces
 *                          there anyway, so rewriting is always safe.
 *   - Rest of a line     : normalised everywhere EXCEPT inside string literals,
 *                          located by the scanner below.
 *
 * All character classes below use \u escapes on purpose. Writing the literal
 * characters would make this file's own source vulnerable to exactly the
 * copy-paste corruption it is defending against.
 */

/**
 * Space-like characters that are neither U+0020 nor a tab.
 * U+00A0 (non-breaking space) is by far the most common offender.
 */
const EXOTIC_SPACE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/** Zero-width and invisible characters. Never meaningful in Python source. */
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

/** Any run of characters that could plausibly be indentation. */
const INDENT_RUN = /^[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u200B\u200C\u200D\u2060\uFEFF]*/;

export const DEFAULT_TAB_SIZE = 4;

/* -------------------------------------------------------- string literals */

/**
 * Find every span of `src` that lies inside a Python string literal.
 *
 * WHY A SCANNER AND NOT PYTHON'S OWN `tokenize`: we have real CPython in the
 * worker and it would give an exact answer, but paste has to be handled
 * synchronously. Going through the worker would make every paste asynchronous
 * and racy against the student's next keystroke. This scanner handles the
 * quoting rules that appear in real classroom code -- single and triple quotes,
 * prefixes, escapes -- and is unit-tested.
 *
 * Failure direction matters more than perfection. Being wrong in the "this IS a
 * string" direction only means we skip a fix and tell the student instead. The
 * one case that could go the other way is a Python 3.12+ f-string reusing the
 * same quote inside its braces, e.g. f"{d["k"]}", where the scanner ends the
 * literal early. That would require a look-alike space inside such a nested key
 * to cause harm, which is vanishingly unlikely.
 *
 * Comments are deliberately NOT protected: rewriting a look-alike space inside
 * a comment cannot change what a program does.
 *
 * @param {string} src
 * @returns {Array<[number, number]>} [start, end) spans, in order
 */
export function stringSpans(src) {
  /** @type {Array<[number, number]>} */
  const spans = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const ch = src[i];

    if (ch === '#') {                      // comment runs to end of line
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const start = i;
      const quote = src.startsWith(ch + ch + ch, i) ? ch + ch + ch : ch;
      const triple = quote.length === 3;
      i += quote.length;

      while (i < n) {
        // A backslash escapes the next character even in a raw string: r"\""
        // is a complete literal, because the escape still applies at the
        // tokenizer level even though the backslash survives into the value.
        if (src[i] === '\\') { i += 2; continue; }
        if (src.startsWith(quote, i)) { i += quote.length; break; }
        if (!triple && src[i] === '\n') break;   // unterminated single-quote
        i += 1;
      }
      spans.push([start, Math.min(i, n)]);
      continue;
    }

    i += 1;
  }
  return spans;
}

/**
 * Expand tabs to the next tab stop. NOT a blind 4-space swap: blind swapping
 * corrupts pasted code whose columns already line up.
 * @param {string} s
 * @param {number} [tabSize]
 * @param {number} [startCol]
 * @returns {string}
 */
export function expandTabs(s, tabSize = DEFAULT_TAB_SIZE, startCol = 0) {
  let out = '';
  let col = startCol;
  for (const ch of s) {
    if (ch === '\t') {
      const pad = tabSize - (col % tabSize);
      out += ' '.repeat(pad);
      col += pad;
    } else {
      out += ch;
      col += 1;
    }
  }
  return out;
}

/**
 * @typedef {object} SanitizeReport
 * @property {number} crlf              CRLF/CR line endings normalised
 * @property {number} indentTabs        lines whose indent contained a tab
 * @property {number} indentExotic      lines whose indent contained a look-alike space
 * @property {number} bodyExotic        look-alike spaces replaced outside the indent
 * @property {number} bodyExoticSkipped look-alike spaces left alone (inside a string)
 * @property {number} bodyTabsSkipped   literal tabs left alone outside the indent
 * @property {number} zeroWidth         zero-width characters removed
 * @property {number} trailing          lines that had trailing whitespace stripped
 * @property {boolean} changed
 */

/** @returns {SanitizeReport} */
function emptyReport() {
  return {
    crlf: 0, indentTabs: 0, indentExotic: 0,
    bodyExotic: 0, bodyExoticSkipped: 0, bodyTabsSkipped: 0,
    zeroWidth: 0, trailing: 0, changed: false,
  };
}

/**
 * @param {string} text
 * @param {{tabSize?: number, stripTrailing?: boolean}} [opts]
 * @returns {{text: string, report: SanitizeReport}}
 */
export function sanitize(text, opts = {}) {
  const tabSize = opts.tabSize ?? DEFAULT_TAB_SIZE;
  const stripTrailing = opts.stripTrailing ?? true;
  const report = emptyReport();

  // 1. Line endings.
  let src = text;
  const crlf = src.match(/\r\n?/g);
  if (crlf) {
    report.crlf = crlf.length;
    src = src.replace(/\r\n?/g, '\n');
  }

  // 2. A byte-order mark at the very start is always noise.
  if (src.charCodeAt(0) === 0xfeff) {
    src = src.slice(1);
    report.zeroWidth += 1;
  }

  // 3. Locate string literals ONCE, on the whole source. Both edits above
  //    happen first so these offsets stay valid.
  const spans = stringSpans(src);
  let spanIdx = 0;
  const inString = (pos) => {
    while (spanIdx < spans.length && spans[spanIdx][1] <= pos) spanIdx += 1;
    const s = spans[spanIdx];
    return Boolean(s && pos >= s[0] && pos < s[1]);
  };

  const lines = src.split('\n');
  const out = [];
  let lineStart = 0;

  for (const line of lines) {
    const m = INDENT_RUN.exec(line);
    let indent = m ? m[0] : '';
    const restStart = lineStart + indent.length;
    let rest = line.slice(indent.length);

    /* --- leading whitespace: always safe to rewrite --- */
    if (indent.includes('\t')) report.indentTabs += 1;
    if (EXOTIC_SPACE.test(indent)) report.indentExotic += 1;
    EXOTIC_SPACE.lastIndex = 0;

    const zwIndent = indent.match(ZERO_WIDTH);
    if (zwIndent) report.zeroWidth += zwIndent.length;

    indent = indent.replace(ZERO_WIDTH, '').replace(EXOTIC_SPACE, ' ');
    indent = expandTabs(indent, tabSize, 0);

    /* --- rest of line: character by character, skipping string literals --- */
    let rebuilt = '';
    for (let k = 0; k < rest.length; k += 1) {
      const ch = rest[k];
      const abs = restStart + k;

      ZERO_WIDTH.lastIndex = 0;
      EXOTIC_SPACE.lastIndex = 0;

      if (ZERO_WIDTH.test(ch)) {
        // Zero-width characters are invisible everywhere, including inside a
        // string, but removing one from a string WOULD change the value -- so
        // they are only stripped outside literals.
        if (inString(abs)) {
          rebuilt += ch;
        } else {
          report.zeroWidth += 1;
        }
        continue;
      }

      EXOTIC_SPACE.lastIndex = 0;
      if (EXOTIC_SPACE.test(ch)) {
        if (inString(abs)) {
          report.bodyExoticSkipped += 1;
          rebuilt += ch;
        } else {
          report.bodyExotic += 1;
          rebuilt += ' ';
        }
        continue;
      }

      if (ch === '\t') {
        // A tab outside the indent is either inside a string (data) or cosmetic
        // alignment. Either way it is reported, never silently rewritten.
        report.bodyTabsSkipped += 1;
      }
      rebuilt += ch;
    }
    rest = rebuilt;

    let result = indent + rest;
    if (stripTrailing) {
      const trimmed = result.replace(/[ \t]+$/, '');
      if (trimmed !== result) {
        report.trailing += 1;
        result = trimmed;
      }
    }
    out.push(result);
    lineStart += line.length + 1;   // +1 for the newline
  }

  const result = out.join('\n');
  report.changed = result !== text;
  return { text: result, report };
}

/**
 * Human-readable summary of a sanitise pass, or null when nothing changed.
 * Deliberately concrete: students should learn what was wrong with their paste,
 * not merely that "something" was fixed.
 * @param {SanitizeReport} r
 * @returns {string | null}
 */
export function describeReport(r) {
  if (!r.changed) return null;
  /** @type {string[]} */
  const parts = [];
  const n = (c, one, many) => `${c} ${c === 1 ? one : many}`;

  if (r.indentTabs) parts.push(`${n(r.indentTabs, 'line', 'lines')} indented with tabs converted to spaces`);
  if (r.indentExotic) parts.push(`${n(r.indentExotic, 'line', 'lines')} indented with non-breaking spaces`);
  if (r.bodyExotic) parts.push(`${n(r.bodyExotic, 'non-breaking space', 'non-breaking spaces')} replaced`);
  if (r.zeroWidth) parts.push(`${n(r.zeroWidth, 'invisible character', 'invisible characters')} removed`);
  if (r.crlf) parts.push('line endings normalised');
  if (r.trailing) parts.push(`trailing spaces removed from ${n(r.trailing, 'line', 'lines')}`);

  let msg = `Cleaned up the pasted code: ${parts.join(', ')}.`;
  const skipped = r.bodyExoticSkipped + r.bodyTabsSkipped;
  if (skipped) msg += ` Left ${skipped} character(s) alone because they are inside text.`;
  return msg;
}
