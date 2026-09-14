# Deploying

`node build.mjs` produces `dist/` — **34 files, 13.9 MB**, largest single file
9.2 MB. That folder is the whole site. There is no compilation step and no
server; deployment is publishing a folder.

`dist/` is built from an explicit include list rather than an exclude list, so
the tests, the planning documents, `serve.mjs` and `node_modules/` are not in it
and cannot become live by accident.

Run the checks first — two of them exist specifically to stop a broken promise
reaching students:

```
npm test          # everything, including the animation-timing suites
npm run test:dist # builds dist/ and checks it the way a host will serve it
```

---

## GitHub Pages (what we use)

**`GITHUB-SETUP.md` is the step-by-step version, from empty folder to live
URL.** The short form:

1. Push the project to a **public** GitHub repository on `main`.
2. **Settings → Pages → Source → GitHub Actions.**
3. `.github/workflows/deploy.yml` runs the tests, runs `build.mjs`, and
   publishes `dist/` — never the repository root.

Every push to `main` redeploys, and a failed test stops the deploy rather than
replacing a working site with a broken one.

### The one thing to understand about GitHub Pages

**It cannot set HTTP headers**, so `_headers` is inert there and the
Content-Security-Policy arrives only as the `<meta>` tag in `index.html`.

That matters more than it sounds like it should: **a `<meta>` CSP does not apply
to Web Workers**, and the worker is where student Python runs. This was measured,
not assumed — see `RECOMMENDATION.md` §1.

The defence that actually holds on this host is `src/runner/sandbox.js`, which
removes `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`,
`Worker`, `BroadcastChannel`, `indexedDB` and `caches` from the worker after
Pyodide boots. That is enforced by the runtime itself and is independent of the
host. `test/security.browser.mjs` proves it by attacking a real listener, and it
gates every deploy.

So: the CSP is defence in depth here, not the load-bearing claim. On a host that
can set headers, both layers apply.

---

## Cloudflare Pages (alternative)

Free, no bandwidth cap on static assets, and it reads the `_headers` file in
this folder automatically.

### Once, to set it up

1. Sign in at <https://dash.cloudflare.com> → **Workers & Pages** → **Create** →
   **Pages** → **Upload assets**.
2. Name the project (this becomes `your-name.pages.dev`).
3. Run `node build.mjs`, then drag **`dist/`** in — not the project folder.
   `dist/` is the published site and nothing else.
4. **Deploy.**

Give it a minute, then open the URL.

### To update it later

Same page → **Create new deployment** → drag the folder again. Or connect the
folder to a git repository and Cloudflare will redeploy on every push.

### Verify the deployment

Open the site and check three things:

1. **It runs.** Press Run on the starter program; a turtle should draw.
2. **The CSP arrived.** Open DevTools → Network → click the document request →
   Response Headers. `content-security-policy` should be there and should
   contain `connect-src 'self'`. This is the header the review brief cites; if
   it is missing, `_headers` did not get uploaded.
3. **It works offline.** Load it once, then DevTools → Network → **Offline**,
   and reload. The editor should start and run Python with no network at all.
   That is the service worker doing its job.

---

## Other hosts

Anything that serves static files works, provided it:

- serves `.wasm` as `application/wasm` (most do; if Pyodide fails to start with
  a MIME error, this is why)
- serves the headers in `_headers`, or has its own way to set them

Netlify uses the same `_headers` format. A host that can set headers gives you
both layers; a host that cannot — GitHub Pages — gives you the sandbox, which is
the one that restrains student code either way. See the GitHub Pages section
above.

---

## What Technology Services needs

One thing: **allowlist the domain** on the content filter. Nothing else — no
server, no accounts, no integration, no software on student machines.

`BRIEF.md` is written to be forwarded as-is.

---

## Cost

| | |
|---|---|
| Cloudflare Pages, free tier | $0 |
| A custom domain (optional; `*.pages.dev` works) | $0–15/year |
| Compute | $0 — it runs on student devices |

It does not scale with enrolment. Five sections and five hundred cost the same,
because the school is serving static files and nothing else.

---

## Updating Pyodide or CodeMirror later

Both are pinned and vendored, so nothing changes until you choose to change it.

- **Pyodide**: download a new `pyodide-core-<version>.tar.bz2` from
  <https://github.com/pyodide/pyodide/releases>, replace `vendor/pyodide/`,
  keeping only `pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm`,
  `python_stdlib.zip` and `pyodide-lock.json`.
- **CodeMirror**: see `BUILD-CODEMIRROR.md`.

**After either, bump `CACHE_VERSION` in `sw.js`.** The service worker caches
`vendor/` forever by design, so without a version bump returning students keep
the old runtime. Then run the full test suite before deploying.
