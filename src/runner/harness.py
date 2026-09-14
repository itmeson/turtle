"""Execution harness — SPEC.md sections 7a and 7b.

Runs inside Pyodide, in the worker. Two jobs:

1. Compile before executing, so syntax and indentation errors are reported with
   an exact character range instead of a traceback. (Section 7a.)
2. Strip every traceback frame that is not the student's own code, so a runtime
   error shows their program and nothing else. (Section 7b.)

The filename below is what students see in tracebacks, so it is deliberately
plain English rather than something like "<stdin>" or "main.py".
"""

import json
import linecache
import traceback

USER_FILENAME = "<your program>"


def _register_source(source):
    """Make the student's source retrievable by the traceback machinery.

    compile() does not put source into linecache, so without this every
    traceback frame prints a bare "File ... line N" with no source line and,
    worse, no ^^^^ anchors. Those anchors are a large part of why this project
    runs real CPython instead of a JavaScript reimplementation, so losing them
    silently would defeat the point.

    The tuple shape is linecache's internal cache entry:
    (size, mtime, lines, fullname). mtime None marks it as never-stale.
    """
    linecache.cache[USER_FILENAME] = (
        len(source),
        None,
        source.splitlines(keepends=True),
        USER_FILENAME,
    )


def _filter_stack(te):
    """Drop non-student frames, recursively through exception chaining.

    Mutates te.stack in place rather than rebuilding it, because
    StackSummary.from_list() discards the fine-grained column anchors that
    produce Python's ^^^^ markers -- the single most useful part of a
    modern traceback.
    """
    te.stack[:] = [f for f in te.stack if f.filename == USER_FILENAME]
    if te.__cause__ is not None:
        _filter_stack(te.__cause__)
    if te.__context__ is not None:
        _filter_stack(te.__context__)


def _syntax_payload(exc):
    return {
        "kind": "syntax",
        "type": type(exc).__name__,          # SyntaxError / IndentationError / TabError
        "msg": exc.msg,
        "lineno": exc.lineno,
        "offset": exc.offset,
        "endLineno": exc.end_lineno,
        "endOffset": exc.end_offset,
        "text": exc.text,
    }


def _turtle_begin(width, height):
    """Reset the turtle screen for a new run and tell it the canvas size."""
    import turtle
    turtle._editor_configure(width, height)


def _turtle_end():
    """Flush any buffered ops.

    Always called, including after an exception, so a program that crashes
    half-way still shows the part of the drawing it completed. Students debug
    from that picture.
    """
    import turtle
    try:
        turtle._editor_finish()
    except Exception:
        pass


def run_source(source, width=600, height=600):
    """Compile and run student source. Returns a JSON string."""

    _register_source(source)
    _turtle_begin(width, height)

    # --- pass 1: compile ------------------------------------------------
    try:
        code = compile(source, USER_FILENAME, "exec")
    except SyntaxError as exc:
        return json.dumps(_syntax_payload(exc))
    except ValueError as exc:
        # Source containing a null byte, and similar. No position available.
        return json.dumps({
            "kind": "syntax",
            "type": "ValueError",
            "msg": str(exc),
            "lineno": 1, "offset": 1, "endLineno": 1, "endOffset": 1,
            "text": None,
        })

    # --- pass 2: execute ------------------------------------------------
    namespace = {"__name__": "__main__", "__doc__": None}
    try:
        exec(code, namespace)
    except SystemExit:
        # sys.exit() is a normal way for a program to finish.
        _turtle_end()
        return json.dumps({"kind": "ok"})
    except BaseException as exc:
        _turtle_end()
        te = traceback.TracebackException.from_exception(exc, lookup_lines=True)
        frames_before = len(te.stack)
        _filter_stack(te)
        student_frames = len(te.stack)

        return json.dumps({
            "kind": "runtime",
            "type": type(exc).__name__,
            "msg": str(exc),
            "traceback": "".join(te.format()),
            # No student frames at all means the error was raised entirely
            # inside our own code. That is a bug in the editor, not in the
            # student's program, and the UI says so.
            "internalOnly": student_frames == 0 and frames_before > 0,
            "lineno": te.stack[-1].lineno if te.stack else None,
        })

    _turtle_end()
    return json.dumps({"kind": "ok"})


def versions():
    import sys
    return json.dumps({
        "python": sys.version.split()[0],
        "pythonFull": sys.version,
    })
