/**
 * CodeMirror 6 editor — SPEC.md sections 8 and 12.
 *
 * Replaces the Phase 0 textarea. Three things it provides that a textarea
 * cannot, all of which matter for this project specifically:
 *
 *   1. Python syntax highlighting, so an unterminated string visibly bleeds
 *      into the rest of the file.
 *   2. Inline error ranges. compile() already gives us lineno/offset/end_offset;
 *      this is what finally uses them, underlining the exact characters.
 *   3. Visible whitespace. The original complaint driving this whole project was
 *      code that LOOKS correctly indented. A textarea cannot draw a dot per
 *      leading space or flag a tab. This can.
 *
 * DELIBERATELY ABSENT: autocompletion of any kind. @codemirror/autocomplete is
 * a transitive dependency of the Python language package and is inside the
 * bundle, but no completion extension is registered and no completion source is
 * attached, so no completion UI can exist. See SPEC.md section 12.
 *
 * The whitespace logic itself lives in sanitize.js and is shared with the old
 * editor -- this file is the mounting, not the rules.
 */

import {
  EditorState, EditorView, Compartment,
  keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, Decoration, ViewPlugin,
  defaultKeymap, history, historyKeymap, indentMore, indentLess,
  insertNewlineAndIndent, undo, redo,
  indentUnit, syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput,
  python, lintGutter, setDiagnostics, tags,
} from '../../vendor/codemirror/codemirror.bundle.js';

import { sanitize, describeReport, expandTabs, DEFAULT_TAB_SIZE } from './sanitize.js';

/* ------------------------------------------------------------ highlighting */

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#7c3aed', fontWeight: '600' },
  { tag: tags.controlKeyword, color: '#7c3aed', fontWeight: '600' },
  { tag: tags.definitionKeyword, color: '#7c3aed', fontWeight: '600' },
  { tag: tags.operatorKeyword, color: '#7c3aed' },
  { tag: tags.string, color: '#0f7b35' },
  { tag: tags.special(tags.string), color: '#0f7b35' },
  { tag: tags.number, color: '#b45309' },
  { tag: tags.bool, color: '#b45309', fontWeight: '600' },
  { tag: tags.null, color: '#b45309', fontWeight: '600' },
  { tag: tags.comment, color: '#6b7280', fontStyle: 'italic' },
  { tag: tags.function(tags.variableName), color: '#1d4ed8' },
  { tag: tags.definition(tags.variableName), color: '#1c2024' },
  { tag: tags.function(tags.propertyName), color: '#1d4ed8' },
  { tag: tags.propertyName, color: '#1c2024' },
  { tag: tags.operator, color: '#374151' },
  { tag: tags.punctuation, color: '#6b7280' },
  { tag: tags.bracket, color: '#6b7280' },
  { tag: tags.self, color: '#7c3aed', fontStyle: 'italic' },
  { tag: tags.atom, color: '#b45309' },
]);

/* -------------------------------------------------------- whitespace marks */

const INDENT_SPACES = Decoration.mark({ class: 'cm-ws-indent' });
const TAB_MARK = Decoration.mark({ class: 'cm-ws-tab' });

/**
 * Decorate whitespace on visible lines.
 *
 * Tabs are marked ALWAYS, whether or not the "show whitespace" toggle is on:
 * a tab in Python source is a latent bug and should never be invisible. Leading
 * spaces are only dotted when the toggle is on, because dotting every line all
 * the time is visual noise.
 *
 * @param {() => boolean} showSpaces
 */
function whitespaceDecorations(showSpaces) {
  const build = (view) => {
    /** @type {Array<{from:number,to:number,value:any}>} */
    const marks = [];
    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = view.state.doc.lineAt(pos);
        const text = line.text;
        const indentLen = /^[ \t]*/.exec(text)[0].length;

        if (showSpaces() && indentLen > 0) {
          // One mark for the whole run; the dot pattern is a CSS background
          // repeating every 1ch, so it lines up with the characters.
          const spacesOnly = /^ +/.exec(text);
          if (spacesOnly) {
            marks.push({ from: line.from, to: line.from + spacesOnly[0].length, value: INDENT_SPACES });
          }
        }

        // Tabs anywhere on the line, always.
        for (let i = 0; i < text.length; i++) {
          if (text[i] === '\t') {
            marks.push({ from: line.from + i, to: line.from + i + 1, value: TAB_MARK });
          }
        }

        if (line.to >= to) break;
        pos = line.to + 1;
      }
    }
    marks.sort((a, b) => a.from - b.from || a.to - b.to);
    return Decoration.set(marks.map((m) => m.value.range(m.from, m.to)), true);
  };

  return ViewPlugin.fromClass(
    class {
      constructor(view) { this.decorations = build(view); }
      update(u) {
        if (u.docChanged || u.viewportChanged || u.transactions.length) {
          this.decorations = build(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/* -------------------------------------------------------------- the editor */

export class CodeMirrorEditor {
  /**
   * @param {HTMLElement} mount
   * @param {{onChange?: (code: string) => void, onNotice?: (text: string) => void,
   *          onRun?: () => void}} [handlers]
   */
  constructor(mount, handlers = {}) {
    this.handlers = handlers;
    this.showSpaces = this.loadWhitespacePreference();
    this.whitespaceCompartment = new Compartment();

    mount.classList.add('editor', 'editor-cm');

    const pasteHandler = EditorView.domEventHandlers({
      paste: (event, view) => this.handlePaste(event, view),
    });

    const runKeymap = keymap.of([
      {
        key: 'Mod-Enter',
        preventDefault: true,
        run: () => { this.handlers.onRun?.(); return true; },
      },
      // Tab indents by a level; it can never insert a literal tab character.
      { key: 'Tab', preventDefault: true, run: indentMore },
      { key: 'Shift-Tab', preventDefault: true, run: indentLess },
      { key: 'Enter', run: insertNewlineAndIndent },
      { key: 'Mod-z', run: undo, preventDefault: true },
      { key: 'Mod-y', run: redo, preventDefault: true },
      { key: 'Mod-Shift-z', run: redo, preventDefault: true },
    ]);

    this.view = new EditorView({
      parent: mount,
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          lintGutter(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          bracketMatching(),
          indentOnInput(),
          python(),
          syntaxHighlighting(highlightStyle),
          indentUnit.of(' '.repeat(DEFAULT_TAB_SIZE)),
          EditorState.tabSize.of(DEFAULT_TAB_SIZE),
          // NO linter() source. Diagnostics come from CPython's compile(), not
          // from a JS analyser, and setDiagnostics() installs the lint state
          // field on its own. Registering a source that returns [] would wipe
          // our diagnostics every time it ran -- which is exactly what happened
          // in the first draft.
          runKeymap,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          pasteHandler,
          this.whitespaceCompartment.of(whitespaceDecorations(() => this.showSpaces)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) this.handlers.onChange?.(this.value);
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: 'var(--code-size)' },
            '.cm-scroller': {
              fontFamily: 'var(--mono)',
              lineHeight: 'var(--code-line)',
              overflow: 'auto',
            },
            '.cm-content': { padding: '10px 0' },
            '.cm-gutters': {
              background: '#fafbfc',
              border: 'none',
              borderRight: '1px solid var(--line)',
              color: '#9aa4af',
            },
            '.cm-activeLineGutter': { background: '#eef1f5' },
            '.cm-activeLine': { background: '#f7f9fc' },
            '&.cm-focused': { outline: 'none' },
          }),
        ],
      }),
    });
  }

  /* ------------------------------------------------------------- content */

  get value() {
    return this.view.state.doc.toString();
  }

  set value(text) {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor: 0 },
    });
  }

  focus() {
    this.view.focus();
  }

  /* --------------------------------------------------------------- paste */

  /**
   * Sanitise on paste — the single highest-value behaviour in the editor.
   * @param {ClipboardEvent} event
   * @param {any} view
   */
  handlePaste(event, view) {
    const raw = event.clipboardData?.getData('text/plain');
    if (raw == null) return false;
    event.preventDefault();

    const { from, to } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    const startCol = from - line.from;

    // Column-aware tab expansion only makes sense for a single-line paste;
    // a multi-line paste starts each line at column 0.
    const prepared = raw.includes('\n') ? raw : expandTabs(raw, DEFAULT_TAB_SIZE, startCol);
    const { text, report } = sanitize(prepared, { stripTrailing: false });

    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: 'input.paste',
      scrollIntoView: true,
    });

    const notice = describeReport(report);
    if (notice) this.handlers.onNotice?.(notice);
    return true;
  }

  /* --------------------------------------------------------- diagnostics */

  clearErrors() {
    this.lastDiagnostics = [];
    this.view.dispatch(setDiagnostics(this.view.state, []));
  }

  /**
   * Underline exactly the characters CPython complained about.
   * @param {{lineno: number|null, offset?: number|null, endLineno?: number|null,
   *          endOffset?: number|null, message: string, fix?: string}} info
   */
  showError(info) {
    const doc = this.view.state.doc;
    if (!info.lineno || info.lineno < 1 || info.lineno > doc.lines) {
      this.clearErrors();
      return;
    }

    const startLine = doc.line(Math.min(info.lineno, doc.lines));
    const endLineNo = (info.endLineno && info.endLineno >= info.lineno
      && info.endLineno <= doc.lines) ? info.endLineno : info.lineno;
    const endLine = doc.line(endLineNo);

    let from = startLine.from + Math.max(0, (info.offset ?? 1) - 1);
    let to = info.endOffset != null
      ? endLine.from + Math.max(0, info.endOffset - 1)
      : endLine.to;

    // Keep the range inside the actual text of those lines.
    from = Math.min(Math.max(from, startLine.from), startLine.to);
    to = Math.min(Math.max(to, endLine.from), endLine.to);

    if (to <= from) {
      // CPython frequently points just PAST the end of a line -- a missing
      // colon, an unclosed bracket. A zero-width range renders as an invisible
      // point marker, so back up one character and underline the last token
      // instead. There has to be something on screen for a student to see.
      if (from > startLine.from) {
        from -= 1;
        to = from + 1;
      } else {
        to = Math.min(startLine.to, from + 1);
      }
    }

    const diagnostic = {
      from, to, severity: 'error', message: info.message,
    };

    if (info.fix === 'normalize') {
      diagnostic.actions = [{
        name: 'Clean up indentation',
        apply: () => this.normalize(),
      }];
    }

    // Kept for the verification suite, which cannot hover a lint tooltip.
    this.lastDiagnostics = [diagnostic];

    // setDiagnostics() returns a spec whose payload lives in `effects`.
    // Spreading it and then assigning `effects` again would overwrite that
    // payload with the scroll effect and silently show no diagnostic at all,
    // so the two effect lists have to be concatenated.
    const spec = setDiagnostics(this.view.state, [diagnostic]);
    this.view.dispatch({
      ...spec,
      effects: [].concat(
        spec.effects ?? [],
        EditorView.scrollIntoView(from, { y: 'center' }),
      ),
    });
  }

  /* ---------------------------------------------------------- whitespace */

  loadWhitespacePreference() {
    try {
      return localStorage.getItem('showWhitespace') === '1';
    } catch {
      return false;
    }
  }

  setShowWhitespace(on) {
    this.showSpaces = !!on;
    try {
      localStorage.setItem('showWhitespace', this.showSpaces ? '1' : '0');
    } catch {
      /* private browsing: the toggle still works, it just will not persist */
    }
    this.view.dispatch({
      effects: this.whitespaceCompartment.reconfigure(
        whitespaceDecorations(() => this.showSpaces),
      ),
    });
  }

  getShowWhitespace() {
    return this.showSpaces;
  }

  /* ------------------------------------------------------------ normalise */

  /** Whole-document cleanup, offered from the toolbar and as a quick fix. */
  normalize() {
    const before = this.value;
    const { text, report } = sanitize(before, { stripTrailing: true });
    if (!report.changed) {
      this.handlers.onNotice?.(
        'Indentation is already clean: no tabs, no invisible characters.',
      );
      return;
    }
    const cursor = Math.min(this.view.state.selection.main.head, text.length);
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor: cursor },
      userEvent: 'input.normalize',
    });
    this.handlers.onNotice?.(describeReport(report) ?? 'Cleaned up indentation.');
  }
}
