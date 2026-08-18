"""Render a stream of REPL events to whatever the surrounding host
understands.

Hosts split into three rough tiers:

  * Plain Python — write to stdout/stderr.
  * IPython without pandas — use ``IPython.display`` for rich text/HTML.
  * IPython with pandas — render result rows as a ``DataFrame`` so the
    notebook gets the full ``_repr_html_`` table treatment.

The dispatch is best-effort: missing optional deps quietly fall back to
the next tier down, so a user can drop the magic into a minimal Python
environment and still see usable output.
"""

from __future__ import annotations

import importlib
import sys
from typing import Any, Optional

from .repl import Event


def _try_import(name: str) -> Optional[Any]:
    """Import ``name`` and return the module, or ``None`` if it isn't installed.

    Goes through ``importlib.import_module`` rather than ``__import__``
    because the latter returns the *top-level* package for a dotted
    name — ``__import__("IPython.display")`` hands back ``IPython``,
    not the ``display`` submodule, and a subsequent ``.display(...)``
    call resolves to the submodule object (which isn't callable).
    """
    try:
        return importlib.import_module(name)
    except ImportError:
        return None


_pd = _try_import("pandas")
_ipydisplay = _try_import("IPython.display")


def render_event(event: Event) -> None:
    """Render a single event to the current host (notebook or terminal)."""
    kind = event.get("kind")
    if kind == "result":
        _render_result(event)
    elif kind == "error":
        _render_error(event)
    elif kind == "declared":
        _print_status(_format_declared(event))
    elif kind == "rule":
        _print_status(_format_rule(event))
    elif kind == "schema":
        _render_schema(event)
    elif kind == "sql":
        _render_sql(event)
    elif kind == "info":
        _print_status(event.get("message", ""))
    else:
        # Unknown event kind: forward as a JSON-ish dump so the user can
        # still see what came through.
        _print_status(repr(event))


def render_events(events: list[Event]) -> None:
    for ev in events:
        render_event(ev)


# --- per-kind renderers -----------------------------------------------------


def _render_result(event: Event) -> None:
    columns: list[str] = event.get("columns") or []
    rows: list[dict[str, Any]] = event.get("rows") or []

    if _pd is not None and _ipydisplay is not None:
        # Using `columns=...` even on an empty rows list ensures the
        # DataFrame keeps the column order from the SELECT — rather than
        # sorting alphabetically or coming out with no columns at all.
        df = _pd.DataFrame(rows, columns=columns) if columns else _pd.DataFrame(rows)
        _ipydisplay.display(df)
        return

    # No pandas / no IPython: a plain text table is more useful than a
    # bare repr. Right-pad each column's values to its widest content.
    if not rows:
        if columns:
            print(" | ".join(columns))
            print("(no rows)")
        else:
            print("(no rows)")
        return
    cols = columns or list(rows[0].keys())
    widths = [len(c) for c in cols]
    for row in rows:
        for i, c in enumerate(cols):
            widths[i] = max(widths[i], len(str(row.get(c, ""))))
    line = " | ".join(c.ljust(widths[i]) for i, c in enumerate(cols))
    print(line)
    print("-+-".join("-" * widths[i] for i, _ in enumerate(cols)))
    for row in rows:
        print(" | ".join(str(row.get(c, "")).ljust(widths[i]) for i, c in enumerate(cols)))


def _render_error(event: Event) -> None:
    phase = event.get("phase", "error")
    msg = event.get("message", "")
    line = event.get("line")
    column = event.get("column")
    location = (
        f" at line {line}, column {column}"
        if line is not None and column is not None
        else ""
    )
    text = f"datamog {phase} error: {msg}{location}"
    if _ipydisplay is not None:
        # `display(HTML(...))` renders inline in the notebook with the
        # right colour cue, and avoids the cell-status "ERR" decoration
        # we'd get from raising — we want the cell to be "completed
        # with errors", not "failed", since later events in the same
        # chunk may still be useful to surface.
        from IPython.display import HTML, display

        safe = (
            text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        )
        display(HTML(f"<pre style='color:#b00020;margin:0'>{safe}</pre>"))
        return
    print(text, file=sys.stderr)


def _render_schema(event: Event) -> None:
    predicates = event.get("predicates") or []
    if not predicates:
        _print_status("(no predicates)")
        return
    lines: list[str] = []
    for p in predicates:
        # The `?` suffix is half the declared type: it decides whether a NULL in that
        # column is the `null` value or an absence.
        cols = ", ".join(
            f"{c.get('name', '?')}: {c.get('type') or '?'}{'?' if c.get('nullable') else ''}"
            for c in p.get("columns") or []
        )
        kind = p.get("predicateKind", "?")
        lines.append(f"{kind} {p.get('name', '?')}({cols})")
    _print_status("\n".join(lines))


def _render_sql(event: Event) -> None:
    sql = event.get("sql", "")
    if _ipydisplay is not None:
        try:
            from IPython.display import Code, display

            display(Code(sql, language="sql"))
            return
        except Exception:
            pass
    print(sql)


# --- shared formatting ------------------------------------------------------


def _format_declared(event: Event) -> str:
    pred = event.get("predicate", "?")
    arity = event.get("arity", 0)
    rows = event.get("rowsLoaded")
    if rows is None:
        return f"declared {pred}/{arity}"
    return f"declared {pred}/{arity} ({rows} rows)"


def _format_rule(event: Event) -> str:
    pred = event.get("predicate", "?")
    arity = event.get("arity", 0)
    return f"added rule for {pred}/{arity}"


def _print_status(message: str) -> None:
    """Print a one-line-ish status message.

    Notebook hosts get a non-shouty stdout write through IPython's
    display layer; plain-Python hosts get ``print``. We avoid
    ``display(Markdown(...))`` here because the messages are already
    plain text and shouldn't be re-styled.
    """
    if not message:
        return
    print(message)
