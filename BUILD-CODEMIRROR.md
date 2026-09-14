# Building the CodeMirror bundle

**DONE — the bundle is built and committed at `vendor/codemirror/codemirror.bundle.js`.**
These instructions are kept for rebuilding it: upgrading CodeMirror, or setting
the project up again on a fresh machine.

**Run this on a machine with internet.** It is the only step in the whole
project that needs npm.

The app has no build step. This produces a single self-contained ES module —
`vendor/codemirror/codemirror.bundle.js` — which the app then imports like any
other local file. After this, `node serve.mjs` is still the entire toolchain,
and `node_modules/` can be deleted if you want.

---

## The commands

Open a terminal in the project folder:

```
cd C:\Users\SAAS_User\Documents\Projects\online-python
```

**1. Install the build tool and CodeMirror packages**

```
npm install --save-dev esbuild @codemirror/state @codemirror/view @codemirror/commands @codemirror/language @codemirror/lang-python @codemirror/lint @codemirror/search @lezer/highlight
```

**2. Build the bundle**

```
npx esbuild vendor-src/codemirror-entry.js --bundle --format=esm --target=es2022 --outfile=vendor/codemirror/codemirror.bundle.js
```

**3. Check it worked**

```
node -e "const s=require('fs').statSync('vendor/codemirror/codemirror.bundle.js');console.log('bundle OK,',Math.round(s.size/1024),'KB')"
```

Expect somewhere around 800 KB–1.2 MB. That is the unminified build, which is
deliberate: it is readable and debuggable, it gzips to roughly a fifth of that
over the wire, and it is trivial next to Pyodide's 6 MB. If you would rather
have it small on disk, add `--minify` to step 2.

---

## That's it

Tell me it's done and I'll wire the editor up. Nothing needs to be sent
anywhere — the bundle is in the project folder, which I can read.

If a command fails, paste the error and I'll sort it out. The most likely
snag is a corporate proxy blocking the npm registry, in which case
`npm config set registry` or an `HTTPS_PROXY` setting may be needed — your IT
folks will know.

---

## If the bundle ever goes missing

The app will not start: the editor imports it directly, the same way it imports
Pyodide. Treat `vendor/codemirror/codemirror.bundle.js` as a required build
artifact and keep it in the project folder (and in git, if the project is ever
versioned). Rebuilding it is the two commands above.

The interim textarea editor that stood in before the bundle existed has been
removed, because dead code that nothing imports is worse than no code.

---

## Optional: keep the repo tidy

`npm install` creates `node_modules/` and `package-lock.json` in the project
folder. Neither is needed to run the app. If the project is ever put under git:

```
node_modules/
package-lock.json
```

The bundle in `vendor/codemirror/` **should** be committed — it is a build
output the app depends on at runtime, exactly like `vendor/pyodide/`.
