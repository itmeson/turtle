/**
 * Console pane — program output and errors.
 *
 * Error presentation follows SPEC.md section 7: CPython's own message is always
 * shown first and verbatim. Anything we add is clearly secondary, so students
 * learn to read real Python errors rather than learning to read ours.
 */

export class ConsolePane {
  /** @param {HTMLElement} mount */
  constructor(mount) {
    mount.classList.add('console');
    mount.innerHTML = '<div class="console-lines" role="log" aria-live="polite"></div>';
    /** @type {HTMLElement} */
    this.lines = mount.querySelector('.console-lines');
    this.empty = true;
    this.showPlaceholder();
  }

  showPlaceholder() {
    this.lines.innerHTML = '<div class="console-placeholder">Output appears here when you run your program.</div>';
  }

  clear() {
    this.lines.innerHTML = '';
    this.empty = true;
  }

  /**
   * @param {string} text
   * @param {'stdout'|'stderr'|'system'|'error'|'notice'} kind
   */
  append(text, kind = 'stdout') {
    if (this.empty) {
      this.lines.innerHTML = '';
      this.empty = false;
    }
    const el = document.createElement('div');
    el.className = `console-line console-${kind}`;
    el.textContent = text;
    this.lines.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  /** A block with a heading and pre-formatted body. */
  appendBlock(kind, heading, body, gloss) {
    if (this.empty) {
      this.lines.innerHTML = '';
      this.empty = false;
    }
    const el = document.createElement('div');
    el.className = `console-block console-${kind}`;

    const h = document.createElement('div');
    h.className = 'console-block-heading';
    h.textContent = heading;
    el.appendChild(h);

    if (body) {
      const pre = document.createElement('pre');
      pre.className = 'console-block-body';
      pre.textContent = body;
      el.appendChild(pre);
    }

    if (gloss) {
      const g = document.createElement('div');
      g.className = 'console-gloss';
      g.innerHTML = '<span class="console-gloss-label">What this usually means</span>';
      const p = document.createElement('p');
      p.textContent = gloss;
      g.appendChild(p);
      el.appendChild(g);
    }

    this.lines.appendChild(el);
    this.scrollToBottom();
    return el;
  }

  scrollToBottom() {
    this.lines.scrollTop = this.lines.scrollHeight;
  }
}
