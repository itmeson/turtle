#!/usr/bin/env node
/**
 * Produce `dist/` — exactly the files the live site needs, and nothing else.
 *
 *     node build.mjs
 *
 * This is not a bundler. There is no compilation step in this project; the
 * browser runs the source as written. All this does is copy the production
 * files somewhere clean, so a deployment cannot accidentally publish the test
 * suite, the screenshots, `node_modules`, or the internal planning documents.
 *
 * Listing the contents explicitly rather than excluding things is deliberate:
 * with an exclude list, every new file is published by default and a mistake is
 * silent. With an include list, a forgotten file fails loudly at the next step.
 */

import {
  cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync, readdirSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(ROOT, 'dist');

/** Individual files the site needs. */
const FILES = [
  'index.html',
  'styles.css',
  'sw.js',
  'favicon.svg',
  // Ignored by GitHub Pages, honoured by Cloudflare and Netlify. Kept so the
  // policy travels with the site if it is ever moved to a host that can set
  // real headers.
  '_headers',
];

/** Directories copied whole. */
const DIRS = [
  'src',      // the application itself, including turtle.py and harness.py
  'vendor',   // Pyodide and the CodeMirror bundle, both version-pinned
];

/** Largest single file GitHub Pages / Cloudflare Pages will accept. */
const FILE_CAP = 25 * 1024 * 1024;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const missing = [...FILES, ...DIRS].filter((p) => !existsSync(join(ROOT, p)));
if (missing.length) {
  console.error(`\nCannot build — these are missing:\n  ${missing.join('\n  ')}\n`);
  if (missing.includes('vendor')) {
    console.error('vendor/ holds Pyodide and the CodeMirror bundle. See BUILD-CODEMIRROR.md.\n');
  }
  process.exit(1);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

for (const file of FILES) cpSync(join(ROOT, file), join(DIST, file));
for (const dir of DIRS) cpSync(join(ROOT, dir), join(DIST, dir), { recursive: true });

// GitHub Pages runs Jekyll unless told not to, and Jekyll silently drops files
// and folders whose names begin with an underscore -- `_headers`, here. The
// Actions deploy path does not run Jekyll, but this costs nothing and removes a
// whole category of "why is that file missing" confusion.
writeFileSync(join(DIST, '.nojekyll'), '');

/* ------------------------------------------------------------- reporting */

const built = walk(DIST);
const total = built.reduce((sum, f) => sum + statSync(f).size, 0);
const oversized = built.filter((f) => statSync(f).size > FILE_CAP);

const required = [
  'index.html', 'styles.css', 'sw.js', 'favicon.svg',
  join('src', 'main.js'),
  join('src', 'runner', 'worker.js'),
  join('src', 'runner', 'sandbox.js'),
  join('src', 'runner', 'harness.py'),
  join('src', 'turtle', 'turtle.py'),
  join('vendor', 'pyodide', 'pyodide.mjs'),
  join('vendor', 'pyodide', 'pyodide.asm.wasm'),
  join('vendor', 'pyodide', 'python_stdlib.zip'),
  join('vendor', 'codemirror', 'codemirror.bundle.js'),
];
const absent = required.filter((f) => !existsSync(join(DIST, f)));

console.log(`\ndist/  ${built.length} files, ${(total / 1048576).toFixed(1)} MB`);
console.log(`       largest: ${(Math.max(...built.map((f) => statSync(f).size)) / 1048576).toFixed(1)} MB`);

// A test suite or a screenshot in dist/ means the include list has drifted.
const strays = built.filter((f) => {
  const rel = relative(DIST, f);
  return rel.startsWith(`test${sep}`) || rel.endsWith('.md') || rel.includes('node_modules');
});

let bad = false;
if (absent.length) { console.error(`\nMISSING from dist: ${absent.join(', ')}`); bad = true; }
if (oversized.length) {
  console.error(`\nToo large for the host (>25 MiB): ${oversized.map((f) => relative(DIST, f)).join(', ')}`);
  bad = true;
}
if (strays.length) {
  console.error(`\nShould not be published: ${strays.map((f) => relative(DIST, f)).join(', ')}`);
  bad = true;
}

if (bad) process.exit(1);
console.log('       ready to deploy\n');
