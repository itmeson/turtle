/**
 * The Programs / History overlay — SPEC.md section 9.
 *
 * One panel with two jobs:
 *   - list saved programs, so a student who follows a shared link can get back
 *     to their own work
 *   - list versions of the current program, with a read-only preview and a
 *     Restore that is itself undoable
 *
 * Deliberate simplification: the preview shows the version's text plus a
 * line-count comparison, not a character-level diff. A real diff is a pile of
 * code for a feature whose job is answering "is this the version I want?", and
 * reading the text answers that.
 *
 * Two rules the panel is built around, both learned from watching it fail:
 *
 *   1. The Programs list never reorders itself while someone is looking at it.
 *      Ordering is by creation (see db.listProjects); opening or editing a
 *      program does not move it.
 *   2. The Preview column is never blank. A program with no earlier versions
 *      still has a current version, and that is the thing a student most needs
 *      to see -- "which one is this?" is the question they came here to answer.
 */

import { relativeTime, lineDelta } from '../storage/workspace.js';

/** The label used for the always-present first row of the History column. */
export const CURRENT_LABEL = 'Current version';

export class WorkPanel {
  /**
   * @param {HTMLElement} mount
   * @param {{
   *   onOpenProject: (id: string) => void,
   *   onNewProject: (name: string) => void,
   *   onDeleteProject: (id: string) => void,
   *   onRestore: (snapshotId: number) => void,
   *   currentCode: () => string,
   * }} handlers
   */
  constructor(mount, handlers) {
    this.handlers = handlers;
    this.root = mount;
    this.selectedSnapshot = null;

    mount.classList.add('panel');
    mount.hidden = true;
    mount.innerHTML = `
      <div class="panel-backdrop" data-close></div>
      <div class="panel-body" role="dialog" aria-label="Programs and history">
        <header class="panel-head">
          <h2>Your work</h2>
          <button class="btn btn-quiet" data-close>Close</button>
        </header>
        <div class="panel-cols">
          <section class="panel-col">
            <div class="panel-col-head">
              <h3>Programs</h3>
              <button class="btn btn-quiet" data-new>New program</button>
            </div>
            <form class="panel-new" data-new-form hidden>
              <label class="panel-new-label" for="panel-new-name">Name this program</label>
              <input id="panel-new-name" class="panel-new-name" data-new-name
                     placeholder="e.g. spiral squares" maxlength="60"
                     spellcheck="false" autocomplete="off">
              <div class="panel-new-actions">
                <button class="btn btn-primary" type="submit" data-new-create disabled>Create</button>
                <button class="btn btn-quiet" type="button" data-new-cancel>Cancel</button>
              </div>
              <p class="panel-hint" data-new-hint>A name is how you will find it again.</p>
            </form>
            <p class="panel-hint panel-order-note">Newest first. Opening one does not move it.</p>
            <ul class="panel-list" data-projects></ul>
          </section>
          <section class="panel-col">
            <div class="panel-col-head"><h3>History</h3></div>
            <ul class="panel-list" data-snapshots></ul>
          </section>
          <section class="panel-col panel-preview-col">
            <div class="panel-col-head"><h3>Preview</h3></div>
            <p class="panel-hint" data-preview-hint hidden></p>
            <pre class="panel-preview" data-preview hidden></pre>
            <button class="btn btn-primary" data-restore hidden>Restore this version</button>
          </section>
        </div>
      </div>
    `;

    this.projectsEl = mount.querySelector('[data-projects]');
    this.snapshotsEl = mount.querySelector('[data-snapshots]');
    this.previewEl = mount.querySelector('[data-preview]');
    this.previewHint = mount.querySelector('[data-preview-hint]');
    this.restoreBtn = mount.querySelector('[data-restore]');

    this.newForm = mount.querySelector('[data-new-form]');
    this.newName = mount.querySelector('[data-new-name]');
    this.newCreate = mount.querySelector('[data-new-create]');
    this.newHint = mount.querySelector('[data-new-hint]');

    mount.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      if (target.hasAttribute('data-close')) this.close();
      if (target.hasAttribute('data-new')) this.startNewProject();
      if (target.hasAttribute('data-new-cancel')) this.cancelNewProject();
    });

    // Naming is required, not encouraged: the Create button stays disabled
    // until there is something to call the program. That is the whole
    // mechanism -- no dialog, no nagging, and no way to end up with a list of
    // identical "My program" rows.
    this.newName.addEventListener('input', () => {
      this.newCreate.disabled = this.newName.value.trim() === '';
    });

    this.newForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = this.newName.value.trim();
      if (!name) {
        this.newHint.textContent = 'Give it a name first — even "squares" is enough.';
        this.newName.focus();
        return;
      }
      this.cancelNewProject();
      this.handlers.onNewProject(name);
    });

    this.restoreBtn.addEventListener('click', () => {
      if (this.selectedSnapshot != null) this.handlers.onRestore(this.selectedSnapshot);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || mount.hidden) return;
      // Escape backs out of naming first, and only then closes the panel.
      if (!this.newForm.hidden) this.cancelNewProject();
      else this.close();
    });
  }

  get isOpen() { return !this.root.hidden; }

  open() { this.root.hidden = false; }

  close() {
    this.root.hidden = true;
    this.cancelNewProject();
  }

  /* ------------------------------------------------------ naming a program */

  startNewProject() {
    this.newForm.hidden = false;
    this.newHint.textContent = 'A name is how you will find it again.';
    this.newName.value = '';
    this.newCreate.disabled = true;
    this.newName.focus();
  }

  cancelNewProject() {
    this.newForm.hidden = true;
    this.newName.value = '';
    this.newCreate.disabled = true;
  }

  /* --------------------------------------------------------------- preview */

  /**
   * @param {string} code
   * @param {string} hint shown above the text
   * @param {number|null} snapshotId null for the current version, which cannot
   *   be restored because it is already what is on screen
   */
  showPreview(code, hint, snapshotId) {
    this.selectedSnapshot = snapshotId;
    this.previewHint.textContent = hint;
    this.previewHint.hidden = false;
    const blank = code.trim() === '';
    this.previewEl.classList.toggle('is-empty', blank);
    this.previewEl.textContent = blank ? 'This program is empty.' : code;
    this.previewEl.hidden = false;
    this.restoreBtn.hidden = snapshotId == null;
  }

  /* ----------------------------------------------------------- the columns */

  /**
   * @param {Array<{id:string,name:string,updatedAt:number}>} projects
   * @param {string|null} currentId
   */
  renderProjects(projects, currentId) {
    this.projectsEl.innerHTML = '';
    if (!projects.length) {
      this.projectsEl.innerHTML = '<li class="panel-empty">No saved programs yet.</li>';
      return;
    }
    for (const p of projects) {
      const li = document.createElement('li');
      li.className = `panel-item${p.id === currentId ? ' is-current' : ''}`;
      li.innerHTML = `
        <button class="panel-item-main" data-id="${p.id}">
          <span class="panel-item-name"></span>
          <span class="panel-item-meta"></span>
        </button>
        <button class="panel-item-del" title="Delete this program" data-del="${p.id}">&times;</button>
      `;
      li.querySelector('.panel-item-name').textContent = p.name || 'Untitled program';
      li.querySelector('.panel-item-meta').textContent =
        `${p.id === currentId ? 'open now' : `edited ${relativeTime(p.updatedAt)}`}`;
      li.querySelector('.panel-item-main').addEventListener('click', () => {
        this.handlers.onOpenProject(p.id);
      });
      li.querySelector('.panel-item-del').addEventListener('click', (e) => {
        e.stopPropagation();
        this.handlers.onDeleteProject(p.id);
      });
      this.projectsEl.appendChild(li);
    }
  }

  /**
   * @param {Array<{id:number,code:string,at:number}>} snapshots
   * @param {string} [projectName]
   */
  renderSnapshots(snapshots, projectName = '') {
    this.snapshotsEl.innerHTML = '';
    this.selectedSnapshot = null;

    const current = this.handlers.currentCode();
    const rows = [];

    // The current text always comes first, and is always selected. Before this
    // existed, a program with no snapshots yet -- which is every new program,
    // and every program a student wrote in one sitting -- showed an empty
    // History and an empty Preview. The panel's answer to "what is this
    // program?" was nothing at all.
    rows.push(this.addRow(
      CURRENT_LABEL,
      `${lineCount(current)} — what is in the editor now`,
      () => this.showPreview(
        current,
        projectName ? `${projectName}, as it is now` : 'As it is now',
        null,
      ),
    ));

    // A snapshot identical to the current text is not an earlier version of
    // anything, and listing it invites the reasonable question of how "just
    // now" differs from "Current version". It stays in the database -- it is
    // cheap insurance -- it just is not a row.
    const earlier = snapshots.filter((s) => s.code !== current);

    for (const snap of earlier) {
      rows.push(this.addRow(
        relativeTime(snap.at),
        lineDelta(snap.code, current),
        () => this.showPreview(snap.code, `Saved ${relativeTime(snap.at)}`, snap.id),
      ));
    }

    if (!earlier.length) {
      const note = document.createElement('li');
      note.className = 'panel-empty';
      note.textContent =
        'No earlier versions yet. One is kept every 30 seconds while you work.';
      this.snapshotsEl.appendChild(note);
    }

    rows[0].select();
  }

  /**
   * Build one History row and return a handle that can select it.
   * @param {string} name
   * @param {string} meta
   * @param {() => void} onSelect
   */
  addRow(name, meta, onSelect) {
    const li = document.createElement('li');
    li.className = 'panel-item';
    li.innerHTML = `
      <button class="panel-item-main" data-snap>
        <span class="panel-item-name"></span>
        <span class="panel-item-meta"></span>
      </button>
    `;
    li.querySelector('.panel-item-name').textContent = name;
    li.querySelector('.panel-item-meta').textContent = meta;

    const select = () => {
      for (const el of this.snapshotsEl.querySelectorAll('.panel-item')) {
        el.classList.remove('is-current');
      }
      li.classList.add('is-current');
      onSelect();
    };

    li.querySelector('.panel-item-main').addEventListener('click', select);
    this.snapshotsEl.appendChild(li);
    return { li, select };
  }
}

function lineCount(code) {
  if (code.trim() === '') return 'empty';
  const n = code.split('\n').length;
  return `${n} line${n === 1 ? '' : 's'}`;
}
