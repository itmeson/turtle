/**
 * Bundle entry point for CodeMirror 6.
 *
 * Everything CodeMirror-related is re-exported from here and bundled into ONE
 * ES module at vendor/codemirror/codemirror.bundle.js, which the app imports
 * like any other local file. That keeps the app itself build-free: this is the
 * only thing that ever needs npm, and it is run once.
 *
 * NOTE ON AUTOCOMPLETION. @codemirror/autocomplete is a transitive dependency
 * of @codemirror/lang-python and will end up inside the bundle. That is fine
 * and unavoidable: nothing here exports it, and the editor never registers a
 * completion extension or a completion source, so no completion UI can appear.
 * Autocompletion in CodeMirror is local token matching, not AI, but this
 * project wants neither. See SPEC.md section 12.
 */

export {
  EditorState,
  EditorSelection,
  Compartment,
  StateEffect,
  StateField,
  Transaction,
  Text,
} from '@codemirror/state';

export {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  gutter,
  GutterMarker,
  Decoration,
  ViewPlugin,
  WidgetType,
  placeholder,
  tooltips,
} from '@codemirror/view';

export {
  defaultKeymap,
  history,
  historyKeymap,
  indentMore,
  indentLess,
  insertNewlineAndIndent,
  undo,
  redo,
} from '@codemirror/commands';

export {
  indentUnit,
  syntaxHighlighting,
  HighlightStyle,
  defaultHighlightStyle,
  bracketMatching,
  indentOnInput,
  foldGutter,
  foldKeymap,
  StreamLanguage,
} from '@codemirror/language';

export { python, pythonLanguage } from '@codemirror/lang-python';

export {
  linter,
  lintGutter,
  setDiagnostics,
  forceLinting,
} from '@codemirror/lint';

export {
  search,
  searchKeymap,
  highlightSelectionMatches,
} from '@codemirror/search';

export { tags } from '@lezer/highlight';
