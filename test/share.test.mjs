/**
 * Share codec round-trip tests — SPEC.md section 13, test/share.
 * Pure Node (Node 18+ has CompressionStream):  node test/share.test.mjs
 *
 * The requirement is byte-exactness. A share link that loses a trailing newline
 * or mangles a non-ASCII identifier is worse than no share link at all, because
 * the damage is silent.
 */

import { encodeShare, decodeShare, buildShareUrl, readShareFromHash, LENGTH_WARNING, MAX_DECOMPRESSED } from '../src/storage/share.js';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

const roundTrip = async (src, name) => {
  const encoded = await encodeShare(src);
  const back = await decodeShare(encoded);
  check(name, back === src,
    `in  ${JSON.stringify(src).slice(0, 80)}\n         out ${JSON.stringify(back).slice(0, 80)}`);
  return encoded;
};

console.log('\nRound trip must be byte-exact');
await roundTrip('', 'empty program');
await roundTrip('\n', 'a single newline');
await roundTrip('print("hello")', 'no trailing newline');
await roundTrip('print("hello")\n', 'with trailing newline');
await roundTrip('print("hello")\n\n\n', 'multiple trailing newlines');
await roundTrip('x = 1\n\ty = 2\n', 'tab characters survive');
await roundTrip('# café niño ünicode\nx = 1\n', 'non-ASCII in comments');
await roundTrip('días = 5\nprint(días)\n', 'non-ASCII identifiers');
await roundTrip('print("🐢 turtle 🎨")\n', 'emoji in strings');
await roundTrip('s = "a\\nb\\\\c"\n', 'escapes are not interpreted');
await roundTrip(`x = ${String.fromCharCode(0x00A0)}1\n`, 'even a non-breaking space survives');

console.log('\nRealistic programs');
{
  const program = `import turtle

t = turtle.Turtle()
t.shape("turtle")
t.speed(6)

colors = ["red", "orange", "yellow", "green", "blue", "purple"]

for i in range(120):
    t.pencolor(colors[i % len(colors)])
    t.forward(i * 2)
    t.right(59)

t.hideturtle()
`;
  const encoded = await roundTrip(program, 'a full turtle program');
  console.log(`       ${program.length} chars -> ${encoded.length} chars of link payload`);
  check('compresses rather than inflating', encoded.length < program.length,
    `${encoded.length} vs ${program.length}`);
  check('comfortably under the truncation warning', encoded.length < LENGTH_WARNING);
}

{
  // Highly repetitive code should compress very well.
  const repetitive = 't.forward(10)\nt.right(90)\n'.repeat(200);
  const encoded = await encodeShare(repetitive);
  check('repetitive code compresses hard', encoded.length < repetitive.length / 10,
    `${repetitive.length} -> ${encoded.length}`);
  check('and still round-trips', (await decodeShare(encoded)) === repetitive);
}

console.log('\nURL handling');
{
  const url = await buildShareUrl('print("hi")\n', 'https://example.org/editor/');
  check('payload lands in the fragment', url.includes('#c='), url);
  check('nothing leaks into the query string', !url.includes('?'), url);

  const back = await readShareFromHash(new URL(url).hash);
  check('reads back out of a hash', back === 'print("hi")\n', JSON.stringify(back));
}
{
  check('no hash means no shared program', (await readShareFromHash('')) === null);
  check('an unrelated hash is ignored', (await readShareFromHash('#section-2')) === null);
}

console.log('\nDamaged and hostile input must not throw raw');
{
  let msg = null;
  try { await decodeShare('!!!not-base64!!!'); } catch (e) { msg = e.message; }
  check('garbage payload raises a readable error', typeof msg === 'string' && msg.length > 0, String(msg));
}
{
  let msg = null;
  try { await decodeShare(''); } catch (e) { msg = e.message; }
  check('empty payload raises a readable error', /empty or damaged/.test(String(msg)), String(msg));
}
{
  // Version byte 99 with valid base64: should be rejected by version, not crash.
  const bytes = new Uint8Array([99, 1, 2, 3, 4]);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const payload = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let msg = null;
  try { await decodeShare(payload); } catch (e) { msg = e.message; }
  check('a future format version is named, not guessed at',
    /newer version/.test(String(msg)), String(msg));
}

console.log('\nA crafted link must not be able to exhaust memory');
{
  // A "zip bomb": highly compressible input that expands enormously. Deflate
  // turns this into a tiny payload, so the LINK looks harmless.
  const bomb = 'A'.repeat(MAX_DECOMPRESSED * 4);
  const payload = await encodeShare(bomb);
  console.log(`       ${bomb.length} bytes compresses to a ${payload.length}-character link`);
  check('the link itself is small enough to look innocent', payload.length < 5000,
    `${payload.length} chars`);

  let message = null;
  const before = Date.now();
  try { await decodeShare(payload); } catch (e) { message = e.message; }
  const elapsed = Date.now() - before;

  check('decoding refuses rather than expanding it', typeof message === 'string',
    'a zip bomb must not be inflated into memory');
  check('and says why, in plain language', /larger than any real program/.test(String(message)),
    String(message));
  check('it gives up quickly', elapsed < 5000, `${elapsed} ms`);
}
{
  // Just under the ceiling must still work, so the limit cannot break real use.
  const big = 'x'.repeat(400 * 1024);
  const payload = await encodeShare(big);
  const back = await decodeShare(payload);
  check('a large but legitimate program still round-trips', back === big,
    `${back.length} vs ${big.length}`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
