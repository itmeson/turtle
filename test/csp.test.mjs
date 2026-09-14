/**
 * Deployment safety checks — SPEC.md section 12.
 *
 *   node test/csp.test.mjs
 *
 * The review brief tells Technology Services that student code cannot leave the
 * machine, and cites the Content-Security-Policy as the reason. That claim is
 * only worth anything if something checks it. This is that something.
 *
 * It runs without a browser so it can sit in front of any deploy.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};

/**
 * fileURLToPath, NOT `.pathname`.
 *
 * On Windows a file URL's pathname is "/C:/Users/..." -- with a leading slash --
 * so join() produces "C:\\C:\\Users\\..." and every read fails with a raw
 * ENOENT. It happens to work on macOS and Linux, which is exactly why it
 * survived development and broke on the first Windows run.
 */
const root = fileURLToPath(new URL('..', import.meta.url));

if (!existsSync(join(root, 'index.html'))) {
  console.error(
    `\nCould not find the project.\n  Looked in: ${root}\n\n`
    + 'Run this from the project folder:  node test/csp.test.mjs\n',
  );
  process.exit(2);
}

const read = (p) => readFileSync(join(root, p), 'utf8');

console.log('\nContent-Security-Policy');
const headers = read('_headers');
const cspLine = headers.split('\n').find((l) => l.includes('Content-Security-Policy'));

check('_headers declares a CSP', Boolean(cspLine));
check("connect-src is 'self' — no other origin is reachable",
  /connect-src 'self'(;|$)/.test(cspLine), cspLine);
check("connect-src is NOT 'none' (that breaks Pyodide's own wasm fetch)",
  !/connect-src 'none'/.test(cspLine));
check('no unsafe-eval', !cspLine.includes("'unsafe-eval'"), cspLine);
check("wasm-unsafe-eval IS present (WebAssembly needs it)",
  cspLine.includes("'wasm-unsafe-eval'"));
check('default-src is self', /default-src 'self'/.test(cspLine));
check('the page cannot be framed', /frame-ancestors 'none'/.test(cspLine));
check('no external origin appears anywhere in the policy',
  !/https?:\/\//.test(cspLine), cspLine);

console.log('\nCaching rules');
check('vendor assets are immutable', /\/vendor\/\*[\s\S]*?immutable/.test(headers));
check('our own code is revalidated, never cached hard',
  /\/src\/\*[\s\S]*?must-revalidate/.test(headers));
check('index.html is revalidated', /\/index\.html[\s\S]*?must-revalidate/.test(headers));
check('the service worker itself is revalidated',
  /\/sw\.js[\s\S]*?must-revalidate/.test(headers));

console.log('\nNo outbound requests in our own source');
{
  /** Walk src/ plus the hand-written root files; vendor/ is third-party. */
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (['.js', '.mjs', '.py', '.html', '.css'].includes(extname(entry))) files.push(rel);
    }
  };
  walk('src');
  for (const f of ['index.html', 'styles.css', 'sw.js']) files.push(f);

  const offenders = [];
  for (const f of files) {
    const text = read(f);
    text.split('\n').forEach((line, i) => {
      // Ignore comments and JSDoc: URLs in prose are documentation, not traffic.
      const code = line.replace(/^\s*(\/\/|\*|#).*$/, '');
      const match = code.match(/https?:\/\/[^\s'"`)]+/);
      if (!match) return;
      // Namespace declarations are not network requests.
      if (match[0].startsWith('http://www.w3.org/')) return;
      offenders.push(`${f}:${i + 1}  ${match[0]}`);
    });
  }
  check('no http(s) URLs outside comments', offenders.length === 0,
    offenders.join('\n         '));

  const fetchesElsewhere = [];
  for (const f of files) {
    if (f === 'sw.js') continue;      // the SW fetches same-origin by design
    const text = read(f);
    if (/fetch\(\s*['"`]https?:/.test(text)) fetchesElsewhere.push(f);
    if (/new\s+(WebSocket|EventSource)\s*\(/.test(text)) fetchesElsewhere.push(`${f} (socket)`);
  }
  check('nothing opens a socket or fetches a remote URL',
    fetchesElsewhere.length === 0, fetchesElsewhere.join(', '));
}

console.log('\nNo autocompletion is wired up');
{
  const editor = read('src/editor/codeMirrorEditor.js');
  check('the autocompletion extension is never imported',
    !/\bautocompletion\b\s*[,}]/.test(editor.replace(/\/\*[\s\S]*?\*\//g, '')),
    'a completion extension would make the "no AI, no suggestions" claim false');
  check('no completion source is registered', !editor.includes('completionSource'));
}

console.log('\nThe <meta> CSP (the only kind GitHub Pages can deliver)');
{
  const html = read('index.html');
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  check('index.html carries a meta CSP', Boolean(meta),
    'GitHub Pages cannot set headers, so the policy must travel in the document');

  if (meta) {
    const metaCsp = meta[1];
    // It must match _headers exactly, minus the one directive <meta> cannot
    // carry. Two hand-maintained copies of a policy drift; this stops that.
    const expected = cspLine.split('Content-Security-Policy:')[1].trim()
      .split(';').map((d) => d.trim())
      .filter((d) => d && !d.startsWith('frame-ancestors'))
      .join('; ');
    check('it matches _headers, minus frame-ancestors', metaCsp === expected,
      `meta:     ${metaCsp}\n         expected: ${expected}`);
    check('frame-ancestors is omitted (browsers ignore it in meta)',
      !metaCsp.includes('frame-ancestors'));
    check("connect-src is still 'self'", /connect-src 'self'(;|$)/.test(metaCsp));

    // A meta CSP only governs content parsed after it appears.
    const head = html.slice(0, html.indexOf(meta[0]));
    check('nothing loads before the policy does',
      !/<script|<link[^>]+stylesheet/i.test(head), head.slice(0, 200));
  }
}

console.log('\nThe worker sandbox is the PRIMARY defence, and must stay wired up');
{
  // A <meta> CSP does not apply to Web Workers -- measured, not assumed -- so
  // on GitHub Pages the policy above protects the document and nothing else.
  // Student Python runs in the worker. If this import ever disappears, the
  // privacy claim in BRIEF.md silently stops being true.
  const worker = read('src/runner/worker.js');
  check('worker.js imports the sandbox',
    /import\s*\{[^}]*sealWorkerGlobals[^}]*\}\s*from\s*'\.\/sandbox\.js'/.test(worker),
    'src/runner/sandbox.js is what actually prevents exfiltration');
  check('and calls it', /sealWorkerGlobals\s*\(/.test(worker));

  const sandbox = read('src/runner/sandbox.js');
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
    'importScripts', 'Worker', 'indexedDB', 'caches']) {
    check(`${name} is on the removal list`, sandbox.includes(`'${name}'`));
  }
  check('postMessage is NOT removed (the turtle op stream needs it)',
    !/'postMessage'/.test(sandbox));
}

console.log('\nDeployment packaging');
{
  const build = read('build.mjs');
  check('build.mjs publishes an explicit list, not an exclude list',
    build.includes('const FILES') && build.includes('const DIRS'),
    'excluding is fail-open; including is fail-loud');
  check('a .nojekyll file is emitted', build.includes('.nojekyll'),
    'Jekyll silently drops files beginning with an underscore, such as _headers');

  const workflow = read('.github/workflows/deploy.yml');
  check('the workflow uploads dist/, not the whole repository',
    /path:\s*dist\b/.test(workflow) && !/path:\s*['"]?\.['"]?\s*$/m.test(workflow),
    'uploading "." publishes tests, screenshots and internal documents');
  check('the security suite gates the deploy',
    workflow.includes('security.browser.mjs'),
    'the deploy must fail if student code can reach the network');
  check('the CSP check gates the deploy', workflow.includes('csp.test.mjs'));

  const ignore = read('.gitignore');
  check('node_modules is ignored', ignore.includes('node_modules'));
  check('dist is ignored', /^dist\/$/m.test(ignore));
}

console.log('\nDev and production must not drift');
{
  const serve = read('serve.mjs');
  check('the dev server reads its CSP from _headers rather than repeating it',
    serve.includes("_headers") && !/'content-security-policy':\s*$/m.test(serve)
      && serve.includes('productionCsp'),
    'a hard-coded copy drifts, and the drift is invisible until production breaks');
  check('no second hard-coded policy is left behind',
    (serve.match(/default-src 'self'/g) || []).length <= 1,
    'the only occurrence should be the fallback used when _headers is unreadable');
}

console.log('\nDeployable files');
{
  const required = [
    'index.html', 'styles.css', 'sw.js', '_headers', 'favicon.svg',
    'vendor/pyodide/pyodide.mjs', 'vendor/pyodide/pyodide.asm.wasm',
    'vendor/pyodide/python_stdlib.zip', 'vendor/codemirror/codemirror.bundle.js',
  ];
  const missing = required.filter((f) => !existsSync(join(root, f)));
  check('every required file is present', missing.length === 0, missing.join(', '));

  // Cloudflare Pages refuses single files over 25 MiB.
  const CAP = 25 * 1024 * 1024;
  const big = [];
  const sizeWalk = (dir) => {
    for (const entry of readdirSync(join(root, dir))) {
      const rel = `${dir}/${entry}`;
      const st = statSync(join(root, rel));
      if (st.isDirectory()) sizeWalk(rel);
      else if (st.size > CAP) big.push(`${rel} (${(st.size / 1048576).toFixed(1)} MB)`);
    }
  };
  sizeWalk('vendor');
  check('no file exceeds the 25 MiB host limit', big.length === 0, big.join(', '));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
