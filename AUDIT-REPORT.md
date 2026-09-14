# Online Python Turtle Editor — Project & Deployment Audit Report

**Audit Date:** September 13, 2026  
**Auditor:** Antigravity AI (Google DeepMind)  
**Scope Evaluated:** `BRIEF.md`, `SPEC.md`, `DEPLOY.md`, application source code (`src/`), worker execution harness, service worker (`sw.js`), static server (`serve.mjs`), HTTP headers configuration (`_headers`), package metadata, and automated test suite (`test/`).  
**Constraint:** No code changes made to project source files; project evaluation and creation of this report only.

---

## 1. Executive Summary & Verdict

### Verdict: **CONDITIONAL APPROVAL (Remediation Required Before Deployment)**

The **Online Python Turtle Editor** is a well-designed, highly targeted educational web application. It successfully achieves its primary instructional goals:
- Runs real **CPython 3.14.2** in the browser via Pyodide and Web Workers.
- Shadows standard `turtle.py` with a custom op-stream display engine.
- Provides superior Python indentation repair and visible whitespace tooling via CodeMirror 6.
- Preserves accurate CPython syntax error positions and filtered tracebacks.
- Operates offline via Service Worker precaching after initial load.

However, **the proposed deployment should NOT be approved in its current state** until key security, privacy, and caching issues are remediated. The central privacy assertion in `BRIEF.md`—that student code execution is technically incapable of sending data over the network—is not fully enforced by the current runtime environment. Furthermore, the caching policy for vendor assets risks serving stale runtime binaries to students indefinitely.

---

## 2. Adherence to Brief (`BRIEF.md`) and Specification (`SPEC.md`)

| Feature / Requirement | Brief / Spec Requirement | Implementation Status | Technical Details & Findings |
|---|---|---|---|
| **Architecture** | Single-page static app; no app server, database, or accounts | **MET** | 100% static files. Execution occurs entirely in client-side Web Worker. |
| **Python Runtime** | Real CPython 3.14 (Pyodide), `import turtle` support | **MET** | Pyodide 314.0.6 (Python 3.14.2) vendored locally. Custom `turtle.py` shim shadows stdlib. |
| **Error Handling** | CPython real syntax error lines/columns, glosses, filtered tracebacks | **MET** | Pre-compiles source via `compile()`, uses `linecache` to preserve `^^^^` anchors, filters non-student stack frames. |
| **Indentation Tooling** | Tab-to-space conversion, string-aware paste sanitizer, visible spaces/tabs | **MET** | `sanitize.js` parses Python string spans (`stringSpans()`) to prevent code corruption. CodeMirror displays whitespace dots & tab markers. |
| **Worker Execution & Stop** | Execution in Web Worker; Instant Stop via `worker.terminate()` & pre-warmed spare | **MET** | `client.js` manages worker lifecycle, pre-warms a spare worker on run completion, terminates worker on Stop in ~30 ms. |
| **Local Persistence** | Autosave to IndexedDB, localStorage mirror, rolling 50 snapshots | **PARTIALLY MET** | Storage implemented (`db.js`, `workspace.js`). However, `Workspace.persist()` displays "Saved" without verifying write success, masking quota or storage errors. |
| **Share Links** | Deflate-raw base64url URL fragment (`#c=...`); never sent to server | **MET** | Codec implemented in `share.js`. URL fragments are standard client-only (not sent in HTTP request). |
| **Image Export** | Lossless SVG & PNG export from op-stream at 1x, 2x, 4x scales | **PARTIALLY MET** | SVG and PNG render from display list. Spec gaps: custom PNG width UI, transparent BG toggle, and cursor default-off setting are not exposed in UI. |
| **Offline Support** | Service Worker precaching after first load | **MET** | `sw.js` precaches app shell and vendor assets. |
| **Runaway Watchdog** | 8-second non-modal notice ("Your program is still running") | **NOT MET** | 8s watchdog bar specified in `SPEC.md` Section 7c is missing in `client.js` / `main.js`. |
| **Op Stream Batching** | Batching flush triggers | **SPEC CONTRADICTION** | `SPEC.md` Section 5 specifies 256 ops or 16 ms; `turtle.py:180` implements 128 ops. `SPEC.md` text should be harmonized. |

---

## 3. Security, Privacy, and Deployment Assessment

### Finding 1: High Risk — Student Python Network & Storage Sandbox Isolation Gap
* **Issue:** `BRIEF.md` asserts: *"No code, no output, and no drawing is ever transmitted anywhere... enforced technically by Content Security Policy `connect-src 'self'`."*
* **Reality:** `loadPyodide()` is called in `src/runner/worker.js` without restricting `jsglobals`. Pyodide exposes JavaScript's `globalThis` (`fetch`, `XMLHttpRequest`, `WebSocket`) and `pyodide.http.open_url()`. Because the CSP contains `connect-src 'self'`, the browser **permits network requests back to the hosting domain**.
* **Impact:** A malicious or experimental Python snippet (e.g., loaded via a shared link) can execute `js.fetch('/?data=' + encodeURIComponent(student_code))` or `pyodide.http.open_url()`. Even if the static host returns 404, the HTTP request, URL query string (containing code), and student IP address are transmitted to and recorded by the web server / Cloudflare logs.
* **Storage Access:** The worker global scope also has access to origin IndexedDB. Code executed from an imported link could theoretically inspect or modify saved programs stored in the host origin's IndexedDB.
* **Remediation:**
  1. Restrict Pyodide's exposed JavaScript scope by removing `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, and `indexedDB` from the worker context after Pyodide boot, or pass a restricted `jsglobals` object.
  2. Override `pyodide.http` module bindings inside `harness.py` to disable network functions.
  3. Add automated browser security unit tests attempting same-origin fetches and storage access from Python code to verify rejection.

---

### Finding 2: High Risk — Invalidation Vulnerability in Vendor Asset Caching Policy
* **Issue:** `_headers` defines `/vendor/*` as `Cache-Control: public, max-age=31536000, immutable`. `DEPLOY.md` instructs maintainers to update Pyodide/CodeMirror by overwriting vendor files and bumping `CACHE_VERSION` in `sw.js`.
* **Reality:** Bumping `CACHE_VERSION` in `sw.js` clears Cache Storage, but **does not invalidate the browser's HTTP cache** for identical asset URLs (`/vendor/pyodide/pyodide.mjs`).
* **Impact:** When a security patch or bug fix is deployed to `vendor/`, returning users' browsers will continue serving the old cached HTTP response for up to one year, creating version mismatches or leaving security vulnerabilities unpatched.
* **Remediation:**
  1. Include version strings or content hashes in vendor URLs/directories (e.g., `/vendor/pyodide-v314.0.6/` or `/vendor/codemirror.bundle.v2.js`).
  2. Alternatively, use `Cache-Control: public, max-age=0, must-revalidate` for mutable vendor paths if unhashed.

---

### Finding 3: High Risk — Misalignment of Cloudflare Privacy & Vendor Governance Claims
* **Issue:** `BRIEF.md` states there is "no PII collected", "no data processing agreement required", and "no vendor relationship".
* **Reality:** Deploying to Cloudflare Pages establishes an institutional vendor relationship with Cloudflare. Cloudflare servers process HTTP connections, logging client IP addresses, User-Agents, and request URIs (per Cloudflare Privacy Policy and Customer DPA).
* **Impact:** School IT governance teams may reject the brief if statements conflict with enterprise IT compliance requirements.
* **Remediation:** Update `BRIEF.md` to accurately state:
  - The application architecture contains no application backend, analytics, or user databases.
  - Cloudflare acts as the static file host and processes standard HTTP connection logs (client IP, URI).
  - Cloudflare Web Analytics must be explicitly disabled in the Pages dashboard.
  - Institutional IT should review Cloudflare's standard Customer Data Processing Addendum (DPA).

---

### Finding 4: Medium Risk — Shared Device Storage & Data Retention Privacy
* **Issue:** Programs and revision snapshots are stored unencrypted in browser `IndexedDB` and `localStorage`.
* **Impact:** In school computer labs where multiple students share a single OS/browser user profile, a student's code, comments, and project names remain visible to subsequent users.
* **Remediation:** Add a clear "Clear All Local Work" button in the "Your work" panel, and document recommended browser profile policies for shared lab environments.

---

### Finding 5: Medium Risk — Deployment Artifact Hygiene & Direct Upload Limitations
* **Issue:** `DEPLOY.md` instructs dragging the entire project repository (66 files) into Cloudflare Pages, relying on manual exclusion of `node_modules`.
* **Impact:** Development artifacts (test suites, Playwright screenshots, dev servers, `Claude outputs/` folder, source maps) are publicly uploaded. Additionally, Cloudflare Direct Upload projects cannot be converted to Git integration later without recreating the project.
* **Remediation:**
  1. Create an automated deployment packaging script (`dist/` output) containing strictly the required 33 static production files.
  2. Document that Direct Upload projects cannot switch to Git-backed deployment seamlessly.

---

### Finding 6: Medium Risk — Unbounded Decompression in Share Link Reader
* **Issue:** `src/storage/share.js` inflates compressed base64url payloads using `DecompressionStream('deflate-raw')` without checking decompressed size limits.
* **Impact:** A crafted malicious link containing a "zip bomb" pattern could exhaust browser memory and crash the tab when opened.
* **Remediation:** Implement a maximum decompressed byte limit (e.g., 500 KB) in `share.js` during decompression stream reading.

---

### Finding 7: Medium Risk — Persistence Status Reporting Defect
* **Issue:** `src/storage/db.js` catches IndexedDB errors and returns `null`. `Workspace.persist()` in `src/storage/workspace.js` ignores this return value and updates `lastSavedAt`. `src/main.js` displays "Saved" regardless of write outcome.
* **Impact:** If browser storage fails (e.g., quota exceeded, private browsing restrictions), the UI still reports "Saved", misleading the student into thinking their work is secure.
* **Remediation:** Verify promise resolution in `Workspace.persist()` before updating UI status to "Saved".

---

### Finding 8: Medium Risk — LMS Embedding Compatibility (`frame-ancestors 'none'`)
* **Issue:** `_headers` sets `Content-Security-Policy: ... frame-ancestors 'none'`.
* **Impact:** Browsers will refuse to display the application inside an `<iframe>` (e.g., embedded inside Canvas, Moodle, or Google Classroom).
* **Remediation:** If LMS embedding is desired, update `frame-ancestors` in `_headers` to permit specific LMS origins (e.g. `frame-ancestors 'self' https://*.instructure.com`). If standalone tab operation is intended, document `frame-ancestors 'none'` as intended clickjacking defense.

---

## 4. Verification Suite Summary

Automated unit tests verified locally:
* `node test/csp.test.mjs`: **20/20 PASSED** (CSP structure, header formatting, static file checks).
* `node test/sanitize.test.mjs`: **46/46 PASSED** (Tab expansion, NBSP stripping, string literal span protection).
* `node test/share.test.mjs`: **24/24 PASSED** (Base64url deflate fragment codec round-trips).
* **Total Non-Browser Checks:** **90/90 PASSED**.

*Note: Playwright browser tests (`phase0`–`phase4`) require installing Playwright in the dev environment (`npm install --save-dev playwright && npx playwright install chromium`).*

---

## 5. Actionable Remediation Roadmap

To achieve full approval for production deployment:

1. **Sandbox Pyodide Worker:** Strip network global functions (`fetch`, `XMLHttpRequest`, `WebSocket`, `pyodide.http`) in `worker.js` / `harness.py`. Add unit test verifying `urllib.request` or `fetch` fails inside student Python.
2. **Fix Vendor Caching:** Version-folder vendor paths (e.g., `/vendor/pyodide-314.0.6/`) to guarantee HTTP cache invalidation on upgrades.
3. **Clean Build Artifacts:** Add a `build` script to copy only production static assets to a `dist/` directory.
4. **Update `BRIEF.md` Privacy Language:** Align brief wording with Cloudflare hosting realities (HTTP logs, DPA).
5. **Surface Persistence Errors:** Ensure `Workspace.persist()` checks IndexedDB transaction success before updating UI state to "Saved".
6. **Cap Decompression Stream:** Limit max decompressed bytes in `share.js` to 500 KB.
7. **LMS Embedding Policy:** Adjust `frame-ancestors` in `_headers` if iframe embedding in an LMS is required.
