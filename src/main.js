/**
 * Application wiring — Phase 3.
 *
 * Three panes: editor and canvas side by side, console underneath.
 * Autosave, share links and lossless export on top.
 */

import { Runner } from './runner/client.js';
import { glossFor } from './runner/glosses.js';
import { CodeMirrorEditor } from './editor/codeMirrorEditor.js';
import { ConsolePane } from './ui/consolePane.js';
import { WorkPanel } from './ui/panel.js';
import { TurtleRenderer } from './turtle/renderCanvas.js';
import { exportSvg } from './turtle/renderSvg.js';
import { exportPng } from './turtle/renderPng.js';
import { Workspace } from './storage/workspace.js';
import { buildShareUrl, readShareFromHash, LENGTH_WARNING } from './storage/share.js';
import {
  downloadBlob, downloadText, slugify, saveToFile, canSaveToFile,
} from './storage/download.js';
import { STARTERS, starterById, FIRST_RUN } from './starters.js';


const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const consolePane = new ConsolePane(el('console'));
const editor = new CodeMirrorEditor(el('editor'), {
  onNotice: (text) => consolePane.append(text, 'notice'),
  onRun: () => { if (!runBtn.disabled) doRun(); },
  // No optimistic "Saved" here: the workspace reports what actually happened
  // through onSaveState below.
  onChange: (code) => workspace.update(code),
});

const runBtn = /** @type {HTMLButtonElement} */ (el('run'));
const stopBtn = /** @type {HTMLButtonElement} */ (el('stop'));
const skipBtn = /** @type {HTMLButtonElement} */ (el('skip'));
const wsBtn = /** @type {HTMLButtonElement} */ (el('ws'));
const normalizeBtn = /** @type {HTMLButtonElement} */ (el('normalize'));
const workBtn = /** @type {HTMLButtonElement} */ (el('work'));
const shareBtn = /** @type {HTMLButtonElement} */ (el('share'));
const saveMenuBtn = /** @type {HTMLButtonElement} */ (el('save-menu'));
const saveList = el('save-list');
const examplesBtn = /** @type {HTMLButtonElement} */ (el('examples-menu'));
const examplesList = el('examples-list');
const nameField = /** @type {HTMLInputElement} */ (el('name'));
const savedHint = el('saved');
const statusEl = el('status');
const canvas = /** @type {HTMLCanvasElement} */ (el('canvas'));
const placeholder = el('canvas-placeholder');
const banner = el('banner');
const bannerText = el('banner-text');

/**
 * Render the real outcome of the last save.
 *
 * This used to be a 600 ms timer that said "Saved" no matter what. A tool that
 * claims to have saved when it has not is the exact failure this project was
 * built to replace, so each state now says something true and, where it
 * matters, something the student can act on.
 */
let warnedAboutSaving = false;
function renderSaveState(state) {
  const view = {
    saving: { text: 'Saving…', cls: '' },
    durable: { text: 'Saved', cls: 'ok' },
    'mirror-only': { text: 'Saved (this browser only)', cls: 'warn' },
    failed: { text: 'NOT SAVED', cls: 'bad' },
  }[state] ?? { text: '', cls: '' };

  savedHint.textContent = view.text;
  savedHint.className = `saved-hint ${view.cls}`;
  savedHint.title = {
    durable: 'Your work is stored on this computer.',
    'mirror-only': 'History is unavailable, but your current program is kept in this browser.',
    failed: 'This browser refused to store your work. Use Save… to download it.',
  }[state] ?? '';

  if ((state === 'failed' || state === 'mirror-only') && !warnedAboutSaving) {
    warnedAboutSaving = true;
    consolePane.append(
      state === 'failed'
        ? 'This browser will not let the editor store your work. Nothing has been saved — '
          + 'use Save… → Download .py to keep your program.'
        : 'Version history is unavailable in this browser, but your current program is '
          + 'still kept here. Use Save… → Download .py if you want a copy.',
      'notice',
    );
  }
}

/* --------------------------------------------------------------- storage */

const workspace = new Workspace({
  onDegraded: (why) => consolePane.append(why, 'notice'),
  onSaveState: renderSaveState,
});

const panel = new WorkPanel(el('panel'), {
  currentCode: () => editor.value,
  onOpenProject: async (id) => {
    const project = await workspace.open(id);
    if (!project) return;
    loadProject(project);
    await refreshPanel();
  },
  onNewProject: async (name) => {
    const project = await workspace.create('', name);
    loadProject(project);
    await refreshPanel();
    panel.close();
    editor.focus();
  },
  onDeleteProject: async (id) => {
    await workspace.remove(id);
    if (workspace.project) loadProject(workspace.project);
    await refreshPanel();
  },
  onRestore: async (snapshotId) => {
    const code = await workspace.restore(snapshotId);
    if (code == null) return;
    editor.value = code;
    panel.close();
    consolePane.append('Restored an earlier version. Your current text was saved to history first.', 'notice');
    editor.focus();
  },
});

/* --------------------------------------------------------------- naming */

/**
 * Names nobody chose.
 *
 * A student only ends up with one of these because the editor had to call the
 * program something before they had said what it was: the very first program,
 * a recovered buffer, a program made from a shared link. Every other route now
 * asks for a name first. These are the ones worth nudging about.
 */
const UNCHOSEN_NAME = /^(my program|untitled program|recovered program|shared program)( \d+)?$/i;

/** Projects already nudged this session — asked once, then dropped. */
const nudged = new Set();

function needsName() {
  return UNCHOSEN_NAME.test((nameField.value ?? '').trim());
}

/** Amber outline on the name field while the program is still unnamed. */
function markNamed() {
  nameField.classList.toggle('needs-name', needsName());
}

/**
 * Ask once, after a run that produced something, and never again.
 *
 * Deliberately after the run rather than before: interrupting a student on the
 * way to seeing their drawing is how a tool teaches people to dismiss its
 * messages without reading them.
 */
function nudgeForName() {
  const id = workspace.project?.id;
  if (!id || nudged.has(id) || !needsName()) return;
  if (editor.value.split('\n').filter((l) => l.trim()).length < 2) return;
  nudged.add(id);
  consolePane.append(
    `This program is still called "${nameField.value}". Give it a name at the top `
    + 'so you can find it in Your work later.', 'notice',
  );
}

function loadProject(project) {
  editor.value = project.code ?? '';
  nameField.value = project.name ?? 'My program';
  markNamed();
  clearBanner();
  renderSaveState(workspace.saveState);

  // Clear the canvas as well. Leaving the previous program's drawing up would
  // let a student export one program's picture under another's name, which is
  // exactly the kind of quiet mix-up that erodes trust in a tool.
  const { width, height } = canvasSize();
  renderer.reset({ llx: -width / 2, lly: -height / 2, urx: width / 2, ury: height / 2 });
  placeholder.hidden = false;
  editor.clearErrors();
  setStatus('Ready', 'good');
}

async function refreshPanel() {
  panel.renderProjects(await workspace.listAll(), workspace.project?.id ?? null);
  panel.renderSnapshots(await workspace.history(), workspace.project?.name ?? '');
}

/* ---------------------------------------------------------------- banner */

let sharedOrigin = false;

function showSharedBanner() {
  sharedOrigin = true;
  bannerText.textContent =
    "You opened someone else's program. Edits here are yours and are saved separately.";
  banner.hidden = false;
}

function clearBanner() {
  sharedOrigin = false;
  banner.hidden = true;
}

/**
 * Turn a shared program into a NEW program of the student's own.
 *
 * The fragment is stripped straight afterwards. Otherwise reloading the page
 * would import the same shared program again, and a student who left the tab
 * open overnight would come back to a pile of duplicates.
 */
async function importShared(code) {
  const fresh = await workspace.create(code, 'Shared program');
  loadProject(fresh);
  showSharedBanner();
  history.replaceState(null, '', location.pathname + location.search);
}

// Pasting a share link into the address bar of an already-open editor changes
// only the fragment, which does NOT reload the page. Without this the link
// would appear to do nothing at all.
window.addEventListener('hashchange', async () => {
  try {
    const shared = await readShareFromHash(location.hash);
    if (shared != null) await importShared(shared);
  } catch (err) {
    consolePane.append(`That share link could not be read: ${err.message}`, 'notice');
  }
});

el('banner-fork').addEventListener('click', async () => {
  const project = await workspace.create(editor.value, `${nameField.value} (my copy)`);
  loadProject(project);
  consolePane.append('Made your own copy.', 'notice');
});
el('banner-close').addEventListener('click', clearBanner);

/* ------------------------------------------------------------------ canvas */

let fastForwardNoticed = false;

const renderer = new TurtleRenderer(canvas, {
  onFastForward: () => {
    if (fastForwardNoticed) return;
    fastForwardNoticed = true;
    consolePane.append('That is a lot of drawing — skipping the animation to catch up.', 'notice');
  },
});

new ResizeObserver(() => renderer.handleResize()).observe(canvas.parentElement);

function canvasSize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  return {
    width: Math.max(100, Math.round(rect.width)),
    height: Math.max(100, Math.round(rect.height)),
  };
}

/* ------------------------------------------------------------------ status */

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

/* ------------------------------------------------------------------ runner */

const runner = new Runner({
  onStdout: (text) => consolePane.append(text, 'stdout'),
  onStderr: (text) => consolePane.append(text, 'stderr'),
  onOps: (batch) => renderer.enqueue(batch),
  onFatal: (message) => {
    setStatus('Python failed to start', 'bad');
    consolePane.appendBlock('error', 'The Python runtime failed to start', message,
      'This is a problem with the editor itself, not with your program.');
  },
  onState: (state) => {
    const running = state === 'running';
    runBtn.disabled = running || state === 'booting';
    stopBtn.disabled = !running;
    if (state === 'booting') setStatus('Starting Python...', 'busy');
    else if (state === 'running') setStatus('Running', 'busy');
  },
});

function report(result, elapsedMs) {
  if (result.kind === 'ok') {
    editor.clearErrors();
    setStatus(`Finished in ${elapsedMs} ms`, 'good');
    return;
  }

  if (result.kind === 'stopped') {
    editor.clearErrors();
    consolePane.append('Stopped.', 'system');
    setStatus('Stopped', '');
    return;
  }

  if (result.kind === 'syntax') {
    const where = result.lineno ? ` (line ${result.lineno})` : '';
    const gloss = glossFor('syntax', result.msg);

    let body = '';
    if (result.text) {
      const line = result.text.replace(/\n$/, '');
      body = `${line}\n`;
      const start = Math.max(0, (result.offset ?? 1) - 1);
      const end = Math.max(start + 1, (result.endOffset ?? (result.offset ?? 1) + 1) - 1);
      body += ' '.repeat(start) + '^'.repeat(Math.max(1, end - start));
    }

    consolePane.appendBlock('error', `${result.type}: ${result.msg}${where}`, body, gloss?.text);
    editor.showError({
      lineno: result.lineno,
      offset: result.offset,
      endLineno: result.endLineno,
      endOffset: result.endOffset,
      message: `${result.type}: ${result.msg}`,
      fix: gloss?.fix,
    });
    setStatus(`${result.type} on line ${result.lineno}`, 'bad');
    return;
  }

  if (result.kind === 'runtime') {
    if (result.internalOnly) {
      consolePane.appendBlock('error', `${result.type}: ${result.msg}`, result.traceback,
        'This error came from inside the editor rather than from your program. Please report it.');
      setStatus('Editor error', 'bad');
      return;
    }

    if (result.type === 'NotSupportedHere') {
      consolePane.appendBlock('notice', 'Not available in this editor', null, result.msg);
      editor.showError({ lineno: result.lineno, message: result.msg });
      setStatus(`Line ${result.lineno ?? '?'}: not supported here`, 'busy');
      return;
    }

    const gloss = glossFor('runtime', result.msg);
    consolePane.appendBlock('error', `${result.type}: ${result.msg}`, result.traceback.trimEnd(), gloss?.text);
    editor.showError({ lineno: result.lineno, message: `${result.type}: ${result.msg}` });
    setStatus(`${result.type} on line ${result.lineno ?? '?'}`, 'bad');
  }
}

async function doRun() {
  consolePane.clear();
  editor.clearErrors();
  fastForwardNoticed = false;

  // A run is a natural checkpoint: snapshot before the student changes tack.
  workspace.snapshot('before-run');

  const { width, height } = canvasSize();
  placeholder.hidden = true;
  renderer.reset({ llx: -width / 2, lly: -height / 2, urx: width / 2, ury: height / 2 });

  try {
    const { result, elapsedMs } = await runner.run(editor.value, { width, height });

    // Deliberately NOT renderer.flushAll(). A program that draws for eight
    // seconds at speed(1) executes in under ten milliseconds.
    report(result, elapsedMs);

    if (renderer.hasPending()) {
      const finished = statusEl.textContent;
      const finishedKind = statusEl.className.replace('status', '').trim();
      setStatus('Drawing...', 'busy');
      skipBtn.hidden = false;
      await renderer.whenIdle();
      skipBtn.hidden = true;
      setStatus(finished, finishedKind);
    }

    nudgeForName();
  } catch (err) {
    consolePane.appendBlock('error', 'Could not run', String(err?.message ?? err), null);
    setStatus('Could not run', 'bad');
  }
}

/* ------------------------------------------------------------------ export */

function currentWorld() {
  return renderer.world;
}

function hasDrawing() {
  return renderer.committed.some((o) => o.op !== 'bgcolor' && o.op !== 'setworld');
}

async function doExport(kind) {
  const base = slugify(nameField.value);

  if (kind === 'py') {
    downloadText(editor.value, `${base}.py`, 'text/x-python;charset=utf-8');
    consolePane.append(`Downloaded ${base}.py`, 'notice');
    return;
  }

  if (kind === 'file') {
    const result = await saveToFile(editor.value, `${base}.py`);
    if (result.saved) consolePane.append(`Saved to ${result.name}.`, 'notice');
    else if (result.reason && result.reason !== 'cancelled') {
      consolePane.append(`Could not save to a file: ${result.reason}`, 'notice');
    }
    return;
  }

  if (!hasDrawing()) {
    consolePane.append('There is no drawing to save yet — press Run first.', 'notice');
    return;
  }

  // Exports come from the display list, never from the visible canvas, so the
  // result is independent of the pane size and loses nothing.
  if (kind === 'svg') {
    const svg = exportSvg(renderer.committed, currentWorld(), {
      background: renderer.bg,
      turtles: renderer.turtles.filter((t) => t.visible),
      title: nameField.value || 'Turtle drawing',
    });
    downloadText(svg, `${base}.svg`, 'image/svg+xml;charset=utf-8');
    consolePane.append(`Downloaded ${base}.svg — vector, scales to any size.`, 'notice');
    return;
  }

  const scale = kind === 'png1' ? 1 : kind === 'png4' ? 4 : 2;
  const blob = await exportPng(renderer.committed, currentWorld(), {
    scale,
    turtles: renderer.turtles.filter((t) => t.visible),
  });
  const suffix = scale === 1 ? '' : `@${scale}x`;
  downloadBlob(blob, `${base}${suffix}.png`);
  const world = currentWorld();
  const w = Math.round((world.urx - world.llx) * scale);
  const h = Math.round((world.ury - world.lly) * scale);
  consolePane.append(`Downloaded ${base}${suffix}.png — ${w}x${h} pixels.`, 'notice');
}

/* ------------------------------------------------------------------- share */

async function doShare() {
  try {
    const url = await buildShareUrl(editor.value, location.href.split('#')[0]);
    const payloadLength = url.length;

    try {
      await navigator.clipboard.writeText(url);
      consolePane.append('Share link copied to the clipboard.', 'notice');
    } catch {
      consolePane.appendBlock('notice', 'Share link (copy this)', url, null);
    }

    if (payloadLength > LENGTH_WARNING) {
      consolePane.append(
        `This link is ${payloadLength} characters long. Google Classroom and email `
        + 'often cut long links off — send the .py file instead for a program this big.',
        'notice',
      );
    }
  } catch (err) {
    consolePane.append(`Could not build a share link: ${err.message}`, 'notice');
  }
}

/* ------------------------------------------------------------------ events */

runBtn.addEventListener('click', doRun);
stopBtn.addEventListener('click', () => {
  skipBtn.hidden = true;
  renderer.stop();
  const interrupted = runner.stop();
  if (!interrupted) consolePane.append('Nothing was running.', 'system');
});
skipBtn.addEventListener('click', () => renderer.flushAll());
normalizeBtn.addEventListener('click', () => editor.normalize());
shareBtn.addEventListener('click', doShare);

workBtn.addEventListener('click', async () => {
  await workspace.snapshot('open-panel');
  await refreshPanel();
  panel.open();
});

function closeMenus() {
  saveList.hidden = true;
  examplesList.hidden = true;
  saveMenuBtn.setAttribute('aria-expanded', 'false');
  examplesBtn.setAttribute('aria-expanded', 'false');
}

/**
 * Place a fixed-position dropdown under its button.
 *
 * The menus are position:fixed so they escape the toolbar's horizontal
 * overflow, which would otherwise clip them. That means their coordinates have
 * to be set by hand each time they open.
 */
function placeMenu(list, button) {
  const rect = button.getBoundingClientRect();
  list.style.top = `${rect.bottom + 4}px`;
  // Keep the menu on screen when its button is near the right edge.
  const width = list.offsetWidth || 240;
  const left = Math.min(rect.left, window.innerWidth - width - 8);
  list.style.left = `${Math.max(8, left)}px`;
}

saveMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = saveList.hidden;
  closeMenus();
  saveList.hidden = !open;
  if (open) placeMenu(saveList, saveMenuBtn);
  saveMenuBtn.setAttribute('aria-expanded', String(open));
});
examplesBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = examplesList.hidden;
  closeMenus();
  examplesList.hidden = !open;
  if (open) placeMenu(examplesList, examplesBtn);
  examplesBtn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', closeMenus);
saveList.addEventListener('click', (e) => {
  const act = /** @type {HTMLElement} */ (e.target).dataset?.act;
  if (!act) return;
  saveList.hidden = true;
  doExport(act);
});

// Examples open as NEW programs, so a student trying one out never loses what
// they were already working on.
for (const starter of STARTERS) {
  const button = document.createElement('button');
  button.dataset.starter = starter.id;
  button.innerHTML = '<span class="menu-name"></span><span class="menu-blurb"></span>';
  button.querySelector('.menu-name').textContent = starter.name;
  button.querySelector('.menu-blurb').textContent = starter.blurb;
  examplesList.appendChild(button);
}

examplesList.addEventListener('click', async (e) => {
  const host = /** @type {HTMLElement} */ (e.target).closest('[data-starter]');
  if (!host) return;
  closeMenus();
  const starter = starterById(host.dataset.starter);
  if (!starter) return;
  const project = await workspace.create(starter.code, starter.name);
  loadProject(project);
  consolePane.append(`Opened the "${starter.name}" example as a new program. Press Run.`, 'notice');
  editor.focus();
});

nameField.addEventListener('change', async () => {
  const used = await workspace.rename(nameField.value);
  // rename() refuses to create a second program with the same name. Put the
  // name it actually used back on screen so the difference is visible now
  // rather than discovered later as two identical rows in the panel.
  if (used && used !== nameField.value) {
    nameField.value = used;
    consolePane.append(
      `You already have a program with that name, so this one is "${used}".`, 'notice',
    );
  }
  markNamed();
});

function syncWhitespaceButton() {
  const on = editor.getShowWhitespace();
  wsBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  wsBtn.textContent = on ? 'Hide spaces' : 'Show spaces';
}
wsBtn.addEventListener('click', () => {
  editor.setShowWhitespace(!editor.getShowWhitespace());
  syncWhitespaceButton();
});
syncWhitespaceButton();

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!runBtn.disabled) doRun();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    doExport(canSaveToFile ? 'file' : 'py');
  }
});

// In normal operation this never fires: autosave lands 400 ms after typing
// stops. It exists for the case where a write failed.
window.addEventListener('beforeunload', (e) => {
  if (workspace.hasUnsavedWork() && editor.value.trim()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

if (!canSaveToFile) el('save-file').hidden = true;

/* -------------------------------------------------------------------- boot */

setStatus('Starting Python...', 'busy');

(async () => {
  // A shared link must never overwrite the student's own work, so it always
  // becomes a NEW program rather than replacing the open one.
  let shared = null;
  try {
    shared = await readShareFromHash(location.hash);
  } catch (err) {
    consolePane.append(`That share link could not be read: ${err.message}`, 'notice');
  }

  const { project, recovered } = await workspace.init(FIRST_RUN);

  if (shared != null) {
    await importShared(shared);
  } else {
    loadProject(project);
    if (recovered) {
      consolePane.append(
        'Recovered the program you were last working on from this browser.',
        'notice',
      );
    }
  }

  window.__workspace = workspace;
  document.body.dataset.storageReady = '1';
})();

runner.start().then((info) => {
  setStatus('Ready', 'good');
  consolePane.append(
    `Python ${info.pythonVersion} (Pyodide ${info.pyodideVersion}) started in ${info.bootMs} ms.`,
    'system',
  );
  document.body.dataset.ready = '1';
  document.body.dataset.pythonVersion = info.pythonVersion;
  document.body.dataset.pyodideVersion = info.pyodideVersion;
  document.body.dataset.bootMs = String(info.bootMs);
  // Verification hook: which globals the worker sandbox actually removed.
  document.body.dataset.sealed = JSON.stringify(info.sealed ?? null);
  editor.focus();
}).catch((err) => {
  setStatus('Python failed to start', 'bad');
  consolePane.appendBlock('error', 'The Python runtime failed to start', String(err?.message ?? err), null);
});

/* --------------------------------------------------------- service worker */

// Registered last so it never competes with the first paint or the Pyodide
// download. `?nosw` disables it, which the test suites use to stay
// deterministic and which is a usable escape hatch if a cache ever misbehaves.
if ('serviceWorker' in navigator
  && location.protocol.startsWith('http')
  && !location.search.includes('nosw')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(() => {
      document.body.dataset.swRegistered = '1';
    }).catch(() => {
      // Not fatal: the app works without it, just without offline start-up.
      document.body.dataset.swRegistered = 'failed';
    });
  });
}

// Exposed for the verification tests only.
window.__editor = editor;
window.__runner = runner;
window.__renderer = renderer;
window.__panel = panel;
window.__export = doExport;
