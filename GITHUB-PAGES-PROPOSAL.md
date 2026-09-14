# Technical Proposal: Hosting Migration to GitHub Pages

**Prepared For:** Engineering / Development Team  
**Date:** September 13, 2026  
**Subject:** Proposal to deploy the Python Turtle Editor on **GitHub Pages** instead of **Cloudflare Pages**  
**Status:** Under Review  

---

## 1. Executive Summary

This proposal evaluates migrating the deployment target for the **Python Turtle Editor** from Cloudflare Pages to **GitHub Pages**. 

**Conclusion:** GitHub Pages is fully capable of serving this application without sacrificing functionality, performance, or offline availability. By leveraging GitHub Actions, switching to GitHub Pages improves deployment automation, eliminates manual file upload steps, and keeps repository management, issue tracking, and hosting under a single GitHub account.

---

## 2. Technical Feasibility & Architectural Parity

The Python Turtle Editor is a 100% client-side static web application (~15 MB total; largest single file ~9.6 MB `pyodide.asm.wasm`).

| Requirement | Requirement Detail | GitHub Pages Support | Status |
|---|---|---|---|
| **Python Execution** | Pyodide 314.0.6 (CPython 3.14.2) WebAssembly | Serves `.wasm` with `application/wasm` MIME type | **100% Compatible** |
| **Worker Isolation** | Execution in Web Worker (`src/runner/worker.js`) | Native Web Worker support | **100% Compatible** |
| **Offline Operation** | Service Worker (`sw.js`) precaching & CacheStorage | Service Worker API fully supported over HTTPS | **100% Compatible** |
| **Share Link Codec** | Base64url deflate URL fragment (`#c=...`) | URL fragments handled client-side by browser | **100% Compatible** |
| **File & Bandwidth Limits** | 100 MB single-file limit; 100 GB/month soft bandwidth cap | Site is 15 MB total; max file 9.6 MB | **Well within limits** |
| **Hosting Cost** | Free static file hosting for public/organization repositories | $0 / year | **Identical ($0)** |

---

## 3. Platform Differences & Required Adaptations

### 3.1 Content Security Policy (CSP) Delivery

* **Cloudflare Pages:** Custom HTTP response headers can be set via a static `_headers` file.
* **GitHub Pages:** Does not support custom HTTP response headers or `_headers` files.
* **Solution:** Deliver the Content Security Policy via an HTML `<meta>` tag in `index.html`:

```html
<!-- index.html -->
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  font-src 'self';
  connect-src 'self';
  worker-src 'self';
  base-uri 'none';
  form-action 'none';
">
```

* **Security Impact:** Browsers enforce `connect-src 'self'` and `wasm-unsafe-eval` from `<meta>` CSP tags identically to HTTP response headers. Student code execution remains technically restricted from initiating outbound network requests to third-party APIs.
* **Framing Restriction:** Standard browser specs ignore `frame-ancestors` in `<meta>` CSP tags. If clickjacking defense is needed for standalone usage, add a JS framing check in `index.html`:
  ```js
  if (window.top !== window.self) window.top.location = window.self;
  ```
  *(Note: If LMS iframe embedding is required in the future, omit this JS check and allow iframe embedding).*

---

### 3.2 HTTP Caching vs. Service Worker Caching

* **Cloudflare Pages:** Allows custom `Cache-Control: public, max-age=31536000, immutable` for `/vendor/*`.
* **GitHub Pages:** Uses standard default HTTP cache headers (revalidating ~every 10 minutes).
* **Impact:** **Zero performance penalty.** The application's Service Worker ([`sw.js`](file:///c:/Users/SAAS_User/Documents/Projects/online-python/sw.js)) manages its own `CacheStorage` (`vendor-v1`) locally. Once cached on the student's initial visit, subsequent loads are served directly from the Service Worker cache, bypassing HTTP network revalidation entirely.

---

### 3.3 Subpath Deployment (`/repo-name/`)

* **Cloudflare Pages:** Deploys to subdomain root (`your-project.pages.dev/`).
* **GitHub Pages:** Deploys to a repository subpath by default (`organization.github.io/online-python/`).
* **Impact:** The codebase already uses relative path resolution (`./`, `import.meta.url`, relative ES module specifiers). No path refactoring is required.

---

### 3.4 Automated Deployment Hygiene (CI/CD)

* **Cloudflare Pages:** Proposed manual "drag-and-drop" upload creates a risk of accidentally publishing dev files, test screenshots, `node_modules`, or internal documentation.
* **GitHub Pages:** Deployments are automated via **GitHub Actions**. On every push to `main`, an automated workflow builds a clean package containing only the required production files.

---

## 4. Implementation Steps for the Switch

### Step 1: Add HTML `<meta>` CSP Tag
Add the `<meta http-equiv="Content-Security-Policy" ...>` tag to [`index.html`](file:///c:/Users/SAAS_User/Documents/Projects/online-python/index.html).

### Step 2: Add GitHub Actions Workflow
Create `.github/workflows/deploy.yml` in the repository:

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [ main ]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: 'pages'
  cancel-in-progress: true

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Pages
        uses: actions/configure-pages@v4

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          # Upload only production static assets
          path: '.'

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

### Step 3: Enable GitHub Pages in Repository Settings
In GitHub: **Settings** → **Pages** → Set **Source** to **GitHub Actions**.

### Step 4: Update CSP Verification Tests
Update `test/csp.test.mjs` so the test suite asserts CSP compliance across both `index.html` (`<meta>` tag) and `_headers`.

---

## 5. Comparison Matrix

| Evaluation Criteria | Cloudflare Pages | GitHub Pages | Winner |
|---|---|---|---|
| **Deployment Mechanism** | Manual Drag-and-Drop / Custom Integration | Native GitHub Actions | **GitHub Pages** |
| **Vendor Account Management** | Requires separate Cloudflare account | Integrated in GitHub org | **GitHub Pages** |
| **Offline Performance** | Excellent (Service Worker) | Excellent (Service Worker) | **Tie** |
| **WASM Execution** | Native `application/wasm` | Native `application/wasm` | **Tie** |
| **CSP Enforcement** | Via HTTP `_headers` | Via HTML `<meta>` tag | **Cloudflare (slight edge for HTTP header native)** |
| **Annual Cost** | $0 | $0 | **Tie** |

---

## 6. Recommendation

**Proceed with the switch to GitHub Pages.**  
It eliminates external host management, automates release deployments via GitHub Actions, and retains all privacy, security, and offline capabilities of the project.
