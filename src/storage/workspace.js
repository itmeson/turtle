/**
 * Autosave, snapshot history and project switching — SPEC.md section 9.
 *
 * The design goal is that "save" is not an event a student can be aware of,
 * fail at, or lose work to. There is no save button, no request, and no moment
 * at which work exists only in the editor. Everything else here follows from
 * that.
 *
 * Three layers of protection, deliberately redundant:
 *   1. autosave to IndexedDB, 400 ms after typing stops
 *   2. a localStorage mirror of the current buffer, in case IndexedDB is
 *      unavailable (Safari private browsing, exhausted quota, a corrupt store)
 *   3. periodic snapshots kept in a rolling history, so a student can get back
 *      to a version from twenty minutes ago after deleting half their program
 */

import {
  openDb, available, getProject, putProject, listProjects, deleteProject,
  addSnapshot, listSnapshots, pruneSnapshots, deleteSnapshotsFor,
  getSetting, setSetting,
} from './db.js';

const AUTOSAVE_DELAY = 400;
const SNAPSHOT_INTERVAL = 30_000;
const SNAPSHOTS_KEPT = 50;
const MIRROR_KEY = 'turtle-editor:buffer';
const MIRROR_META = 'turtle-editor:meta';

const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export class Workspace {
  /**
   * @param {{
   *   onNotice?: (text: string) => void,
   *   onDegraded?: (why: string) => void,
   *   onSaveState?: (state: 'saving'|'durable'|'mirror-only'|'failed') => void,
   * }} [handlers]
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    /**
     * What the last save actually achieved. Never assume; always report.
     *   durable      written to IndexedDB and the transaction committed
     *   mirror-only  IndexedDB refused, but localStorage holds the current text
     *   failed       neither worked -- the work exists only in the editor
     * @type {'saving'|'durable'|'mirror-only'|'failed'}
     */
    this.saveState = 'durable';
    /** @type {import('./db.js').Project|null} */
    this.project = null;
    this.durable = false;         // is IndexedDB actually working?
    this.lastSavedAt = 0;
    this.lastSnapshotCode = null;
    this.saveTimer = 0;
    this.snapshotTimer = 0;
    this.pendingCode = null;
    // What was last written out, so persist() can tell a real edit from a
    // routine flush. See the note on `updatedAt` in persist().
    this.lastWrittenCode = null;
    this.lastWrittenName = null;
  }

  /** Remember a project as the one now open, and as the baseline for edits. */
  adopt(project) {
    this.project = project;
    this.lastSnapshotCode = project.code;
    this.lastWrittenCode = project.code;
    this.lastWrittenName = project.name;
  }

  /* ----------------------------------------------------------- lifecycle */

  /**
   * @param {string} defaultCode used when there is nothing stored yet
   * @returns {Promise<{project: object, recovered: boolean}>}
   */
  async init(defaultCode) {
    await openDb();
    this.durable = available();

    if (!this.durable) {
      this.handlers.onDegraded?.(
        'This browser will not let the editor store work locally, so history is '
        + 'unavailable this session. Use Download .py to keep your program.',
      );
    }

    let project = null;
    let recovered = false;

    if (this.durable) {
      const lastId = await getSetting('lastProjectId');
      if (lastId) project = await getProject(lastId);
      if (!project) {
        // No pointer -- fall back to whatever was edited most recently. The
        // list itself is ordered by creation (see db.listProjects), but "which
        // one was I working on" is a genuinely different question.
        const all = await listProjects();
        project = all.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null;
      }
    }

    // The mirror is the last line of defence: if IndexedDB has nothing but the
    // mirror holds newer text, that text is what the student last typed.
    const mirror = this.readMirror();
    if (mirror && (!project || mirror.at > (project.updatedAt ?? 0))) {
      if (project) {
        project.code = mirror.code;
        recovered = true;
      } else {
        project = this.blankProject(mirror.code, mirror.name ?? 'Recovered program');
        recovered = true;
      }
    }

    if (!project) project = this.blankProject(defaultCode, 'My program');

    this.adopt(project);
    await this.persist(true);
    this.startSnapshots();
    return { project, recovered };
  }

  blankProject(code, name) {
    const now = Date.now();
    return { id: newId(), name, code, createdAt: now, updatedAt: now };
  }

  /* -------------------------------------------------------------- saving */

  /** Called on every edit. Debounced; never awaited by the caller. */
  update(code) {
    if (!this.project) return;
    this.project.code = code;
    this.pendingCode = code;
    this.writeMirror(code);            // synchronous, immediate, cheap

    this.setSaveState('saving');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.persist(); }, AUTOSAVE_DELAY);
  }

  /** @param {'saving'|'durable'|'mirror-only'|'failed'} state */
  setSaveState(state) {
    if (this.saveState === state) return;
    this.saveState = state;
    this.handlers.onSaveState?.(state);
  }

  /**
   * @returns {Promise<string>} the name actually used, which may differ from
   * the one asked for if another program already had it. The caller is expected
   * to put the returned name back on screen, so the student sees what happened
   * rather than discovering two identical rows later.
   */
  async rename(name) {
    if (!this.project) return '';
    const others = (await this.listAll())
      .filter((p) => p.id !== this.project.id)
      .map((p) => p.name);
    this.project.name = uniqueName(name, others);
    await this.persist(true);
    return this.project.name;
  }

  /**
   * Write the project out and report what actually happened.
   *
   * This used to assume success and set the UI to "Saved" regardless. Telling a
   * student their work is safe when the write failed is precisely the failure
   * this project exists to eliminate, so the result is now checked and the
   * status reflects it.
   *
   * @returns {Promise<'durable'|'mirror-only'|'failed'>}
   */
  async persist(force = false) {
    if (!this.project) return this.saveState;
    if (!force && this.pendingCode === null) return this.saveState;

    const code = this.project.code;
    this.pendingCode = null;

    // `updatedAt` moves only when something about the program actually changed.
    //
    // It used to move on every write, and persist(true) is called for reasons
    // that have nothing to do with editing: starting up, switching programs,
    // creating one, deleting one. So a program's "edited" time was really its
    // "last touched by the machinery" time -- untrue on its face, and, back
    // when the list was sorted by it, the reason opening one program appeared
    // to shuffle the others.
    const changed = code !== this.lastWrittenCode || this.project.name !== this.lastWrittenName;
    if (changed) this.project.updatedAt = Date.now();
    this.lastWrittenCode = code;
    this.lastWrittenName = this.project.name;

    let durable = false;
    if (this.durable) {
      durable = await putProject({ ...this.project });
      // The project write is what matters; the pointer is a convenience.
      await setSetting('lastProjectId', this.project.id);
    }

    // Re-check the mirror against the text we actually tried to save, rather
    // than trusting the write that happened during update().
    const mirrored = this.writeMirror(code);

    if (durable) {
      this.lastSavedAt = Date.now();
      this.setSaveState('durable');
    } else if (mirrored) {
      this.lastSavedAt = Date.now();
      this.setSaveState('mirror-only');
    } else {
      this.setSaveState('failed');
    }
    return this.saveState;
  }

  /** True when the buffer may be ahead of anything durable on disk. */
  hasUnsavedWork() {
    if (this.saveState === 'failed') return true;
    return this.pendingCode !== null || (Date.now() - this.lastSavedAt) > 2000;
  }

  /* ----------------------------------------------------------- mirroring */

  /** @returns {boolean} whether the mirror actually holds the current text */
  writeMirror(code) {
    try {
      localStorage.setItem(MIRROR_KEY, code);
      localStorage.setItem(MIRROR_META, JSON.stringify({
        at: Date.now(),
        id: this.project?.id ?? null,
        name: this.project?.name ?? null,
      }));
      return true;
    } catch {
      // Quota exhausted, or private browsing. IndexedDB may still have worked.
      return false;
    }
  }

  readMirror() {
    try {
      const code = localStorage.getItem(MIRROR_KEY);
      if (code == null) return null;
      const meta = JSON.parse(localStorage.getItem(MIRROR_META) ?? '{}');
      return { code, at: meta.at ?? 0, id: meta.id ?? null, name: meta.name ?? null };
    } catch {
      return null;
    }
  }

  /* ----------------------------------------------------------- snapshots */

  startSnapshots() {
    clearInterval(this.snapshotTimer);
    this.snapshotTimer = setInterval(() => { this.snapshot(); }, SNAPSHOT_INTERVAL);
  }

  stopSnapshots() {
    clearInterval(this.snapshotTimer);
  }

  /** Record a snapshot if the code actually changed since the last one. */
  async snapshot(reason = 'auto') {
    if (!this.project || !this.durable) return false;
    const code = this.project.code;
    if (code === this.lastSnapshotCode) return false;
    this.lastSnapshotCode = code;
    await addSnapshot({ projectId: this.project.id, code, at: Date.now(), reason });
    await pruneSnapshots(this.project.id, SNAPSHOTS_KEPT);
    return true;
  }

  async history() {
    if (!this.project || !this.durable) return [];
    return listSnapshots(this.project.id);
  }

  /**
   * Restore a snapshot.
   *
   * Takes a snapshot of the CURRENT text first, so restoring is never
   * destructive -- a student who restores the wrong version can restore back.
   * @returns {Promise<string|null>} the restored code
   */
  async restore(snapshotId) {
    if (!this.project || !this.durable) return null;
    const rows = await listSnapshots(this.project.id);
    const target = rows.find((r) => r.id === snapshotId);
    if (!target) return null;

    await this.snapshot('before-restore');
    this.project.code = target.code;
    this.lastSnapshotCode = target.code;
    this.writeMirror(target.code);
    await this.persist(true);
    return target.code;
  }

  /* ------------------------------------------------------------ projects */

  async listAll() {
    if (!this.durable) return this.project ? [this.project] : [];
    return listProjects();
  }

  async open(projectId) {
    if (!this.durable) return null;
    const project = await getProject(projectId);
    if (!project) return null;
    await this.persist(true);         // flush the outgoing program, unchanged
    this.adopt(project);
    this.writeMirror(project.code);
    await setSetting('lastProjectId', project.id);
    return project;
  }

  /**
   * Create a new program and switch to it.
   *
   * The name is made unique against what is already there. Two programs called
   * "My program" are two programs a student cannot tell apart in a list, and
   * the names that repeat are exactly the ones nobody chose: the default, the
   * starters, "Shared program".
   */
  async create(code, name = 'My program') {
    await this.persist(true);
    const taken = (await this.listAll()).map((p) => p.name);
    this.adopt(this.blankProject(code, uniqueName(name, taken)));
    this.writeMirror(code);
    await this.persist(true);
    return this.project;
  }

  async remove(projectId) {
    if (!this.durable) return;
    await deleteSnapshotsFor(projectId);
    await deleteProject(projectId);
    if (this.project?.id === projectId) {
      const rest = await listProjects();
      this.adopt(rest[0] ?? this.blankProject('', 'My program'));
      await this.persist(true);
    }
  }
}

/**
 * "spiral" beside an existing "spiral" becomes "spiral 2".
 *
 * @param {string} base
 * @param {string[]} taken
 */
export function uniqueName(base, taken) {
  const wanted = (base || '').trim() || 'Untitled program';
  const used = new Set(taken.map((n) => (n || '').trim().toLowerCase()));
  if (!used.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${wanted} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${wanted} ${Date.now()}`;
}

/** "14 minutes ago" — history is unreadable as raw timestamps. */
export function relativeTime(then, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** "+12 / -3 lines" against the current buffer. */
export function lineDelta(snapshotCode, currentCode) {
  const a = snapshotCode.split('\n').length;
  const b = currentCode.split('\n').length;
  const diff = a - b;
  if (diff === 0) return 'same number of lines';
  return diff > 0
    ? `${diff} more line${diff === 1 ? '' : 's'} than now`
    : `${-diff} fewer line${diff === -1 ? '' : 's'} than now`;
}
