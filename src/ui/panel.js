/**
 * The Programs / History overlay — SPEC.md section 9.
 *
 * One panel with two jobs:
 *   - list saved programs, so a student who follows a shared link can get back
 *     to their own work
 *   - list snapshots of the current program, with a read-only preview and a
 *     Restore that is itself undoable
 *
 * Deliberate simplification: the preview shows the snapshot's text plus a
 * line-count comparison, not a character-level diff. A real diff is a pile of
 * code for a feature whose job is answering "is this the version I want?", and
 * reading the text answers that.
 */

import { relativeTime, lineDelta } from '../storage/workspace.js';

export class WorkPanel {
  /**
   * @param {HTMLElement} mount
   * @param {{
   *   onOpenProject: (id: string) => void,
   *   onNewProject: () => void,
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
            <ul class="panel-list" data-projects></ul>
          </section>
          <section class="panel-col">
            <div class="panel-col-head"><h3>History</h3></div>
            <ul class="panel-list" data-snapshots></ul>
          </section>
          <section class="panel-col panel-preview-col">
            <div class="panel-col-head"><h3>Preview</h3></div>
            <p class="panel-hint" data-preview-hint>Pick a version on the left to see it.</p>
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

    mount.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      if (target.hasAttribute('data-close')) this.close();
      if (target.hasAttribute('data-new')) this.handlers.onNewProject();
    });

    this.restoreBtn.addEventListener('click', () => {
      if (this.selectedSnapshot != null) this.handlers.onRestore(this.selectedSnapshot);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !mount.hidden) this.close();
    });
  }

  get isOpen() { return !this.root.hidden; }

  open() { this.root.hidden = false; }

  close() {
    this.root.hidden = true;
    this.clearPreview();
  }

  clearPreview() {
    this.selectedSnapshot = null;
    this.previewEl.hidden = true;
    this.restoreBtn.hidden = true;
    this.previewHint.hidden = false;
  }

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

  /** @param {Array<{id:number,code:string,at:number}>} snapshots */
  renderSnapshots(snapshots) {
    this.snapshotsEl.innerHTML = '';
    this.clearPreview();

    if (!snapshots.length) {
      this.snapshotsEl.innerHTML =
        '<li class="panel-empty">No earlier versions yet. One is kept every 30 seconds while you work.</li>';
      return;
    }

    const current = this.handlers.currentCode();
    for (const snap of snapshots) {
      const li = document.createElement('li');
      li.className = 'panel-item';
      li.innerHTML = `
        <button class="panel-item-main" data-snap="${snap.id}">
          <span class="panel-item-name"></span>
          <span class="panel-item-meta"></span>
        </button>
      `;
      li.querySelector('.panel-item-name').textContent = relativeTime(snap.at);
      li.querySelector('.panel-item-meta').textContent = lineDelta(snap.code, current);
      li.querySelector('.panel-item-main').addEventListener('click', () => {
        this.selectedSnapshot = snap.id;
        this.previewEl.textContent = snap.code;
        this.previewEl.hidden = false;
        this.previewHint.hidden = true;
        this.restoreBtn.hidden = false;
        for (const el of this.snapshotsEl.querySelectorAll('.panel-item')) {
          el.classList.remove('is-current');
        }
        li.classList.add('is-current');
      });
      this.snapshotsEl.appendChild(li);
    }
  }
}
