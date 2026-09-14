/**
 * Unit tests for the whitespace sanitiser — SPEC.md section 13, test/indent.
 * Pure Node, no dependencies:  node test/sanitize.test.mjs
 */

import { sanitize, expandTabs, stringSpans } from '../src/editor/sanitize.js';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`);
  }
}

const NBSP = String.fromCharCode(0x00A0); // non-breaking space
const ZWSP = String.fromCharCode(0x200B); // zero-width space
const BOM  = String.fromCharCode(0xFEFF); // byte-order mark

console.log('\nexpandTabs — column-aware, not a blind 4-space swap');
check('tab at column 0', expandTabs('\tx'), '    x');
check('tab at column 2 fills to stop', expandTabs('ab\tx'), 'ab  x');
check('tab at column 3 fills one space', expandTabs('abc\tx'), 'abc x');
check('tab at column 4 fills a full stop', expandTabs('abcd\tx'), 'abcd    x');
check('respects a starting column', expandTabs('\tx', 4, 2), '  x');

console.log('\nsanitize — tabs in indentation');
{
  const { text, report } = sanitize('def f():\n\tx = 1\n\treturn x\n');
  check('tabs become spaces', text, 'def f():\n    x = 1\n    return x\n');
  check('counts tab-indented lines', report.indentTabs, 2);
}

console.log('\nsanitize — mixed tabs and spaces (the TabError case)');
{
  const { text } = sanitize('if True:\n    a = 1\n\tb = 2\n');
  check('both indents land on 4 columns', text, 'if True:\n    a = 1\n    b = 2\n');
}

console.log('\nsanitize — non-breaking spaces (the invisible-corruption case)');
{
  const { text, report } = sanitize(`def f():\n${NBSP}${NBSP}${NBSP}${NBSP}return 1\n`);
  check('NBSP indent becomes real spaces', text, 'def f():\n    return 1\n');
  check('counts the line', report.indentExotic, 1);
}
{
  // NBSP between tokens, no quotes on the line: safe to fix.
  const { text, report } = sanitize(`x${NBSP}=${NBSP}1\n`);
  check('NBSP between tokens replaced', text, 'x = 1\n');
  check('counted as body replacements', report.bodyExotic, 2);
}

console.log('\nsanitize — must not alter program meaning');
{
  // NBSP inside a string literal is data. The line has quotes, so we leave it.
  const src = `print("a${NBSP}b")\n`;
  const { text, report } = sanitize(src);
  check('string contents untouched', text, src);
  check('but flagged for the student', report.bodyExoticSkipped, 1);
}
{
  const src = 'print("a\tb")\n';
  const { text, report } = sanitize(src);
  check('literal tab inside a string untouched', text, src);
  check('tab outside indent is reported', report.bodyTabsSkipped, 1);
}

console.log('\nsanitize — zero-width and BOM');
{
  const { text, report } = sanitize(`${BOM}x = 1${ZWSP}\n`);
  check('BOM and ZWSP removed', text, 'x = 1\n');
  check('both counted', report.zeroWidth, 2);
}

console.log('\nsanitize — line endings and trailing space');
{
  const { text, report } = sanitize('a = 1\r\nb = 2\r\n');
  check('CRLF normalised', text, 'a = 1\nb = 2\n');
  check('counted', report.crlf, 2);
}
{
  const { text, report } = sanitize('a = 1   \nb = 2\t\n');
  check('trailing whitespace stripped', text, 'a = 1\nb = 2\n');
  check('counted', report.trailing, 2);
}

console.log('\nsanitize — clean input must pass through untouched');
{
  const src = 'import turtle\n\nt = turtle.Turtle()\nfor i in range(4):\n    t.forward(100)\n    t.right(90)\n';
  const { text, report } = sanitize(src);
  check('unchanged', text, src);
  check('changed flag is false', report.changed, false);
}

console.log('\nstringSpans — locating Python string literals');
{
  const spanTexts = (src) => stringSpans(src).map(([a, b]) => src.slice(a, b));
  check('double quoted', spanTexts('x = "abc"'), ['"abc"']);
  check('single quoted', spanTexts("x = 'abc'"), ["'abc'"]);
  check('two on one line', spanTexts('f("a", "b")'), ['"a"', '"b"']);
  check('escaped quote does not end it', spanTexts('x = "a\\"b"'), ['"a\\"b"']);
  check('triple quoted spans lines', spanTexts('x = """a\nb"""'), ['"""a\nb"""']);
  check('quote inside the other quote', spanTexts(`x = "it's"`), [`"it's"`]);
  check('comments are not strings', spanTexts('x = 1  # "not a string"'), []);
  check('a quote inside a comment is ignored', spanTexts('# "\nx = "real"'), ['"real"']);
  check('unterminated string stops at the newline',
    spanTexts('x = "oops\ny = 1'), ['"oops']);
  check('no strings at all', spanTexts('x = 1 + 2'), []);
}

console.log('\nsanitize — string-aware body cleaning (the old heuristic got this wrong)');
{
  // A line with quotes on it used to be skipped entirely. Now only the
  // characters actually INSIDE the literal are protected. Turtle code is full
  // of quoted colour names, so this is the common case.
  const src = `t.pencolor(${NBSP}"red"${NBSP})\n`;
  const { text, report } = sanitize(src);
  check('NBSP outside the string is fixed', text, 't.pencolor( "red" )\n');
  check('counted as replaced', report.bodyExotic, 2);
  check('nothing wrongly skipped', report.bodyExoticSkipped, 0);
}
{
  const src = `t.write("a${NBSP}b")\n`;
  const { text, report } = sanitize(src);
  check('NBSP inside the string is preserved', text, src);
  check('counted as skipped', report.bodyExoticSkipped, 1);
}
{
  // Both at once, on the same line.
  const src = `print(${NBSP}"x${NBSP}y")\n`;
  const { text, report } = sanitize(src);
  check('mixed case: outside fixed, inside kept', text, `print( "x${NBSP}y")\n`);
  check('one of each counted', [report.bodyExotic, report.bodyExoticSkipped], [1, 1]);
}
{
  const src = `s = """keep${NBSP}this"""\nx${NBSP}=${NBSP}1\n`;
  const { text } = sanitize(src);
  check('triple-quoted content protected, code around it fixed',
    text, `s = """keep${NBSP}this"""\nx = 1\n`);
}
{
  // Zero-width characters inside a literal are data too.
  const src = `s = "a${ZWSP}b"\nx${ZWSP} = 1\n`;
  const { text } = sanitize(src);
  check('ZWSP kept inside a string, stripped outside', text, `s = "a${ZWSP}b"\nx = 1\n`);
}
{
  // Indentation is always normalised, even on a line that also has a string.
  const src = `def f():\n${NBSP}${NBSP}${NBSP}${NBSP}return "a${NBSP}b"\n`;
  const { text, report } = sanitize(src);
  check('indent fixed, string contents untouched',
    text, `def f():\n    return "a${NBSP}b"\n`);
  check('indent counted separately', report.indentExotic, 1);
  check('string NBSP reported as skipped', report.bodyExoticSkipped, 1);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
