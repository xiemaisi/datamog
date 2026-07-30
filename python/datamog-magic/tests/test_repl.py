"""End-to-end tests for ``DatamogProcess`` against a real subprocess.

Tests are skipped automatically when ``bun`` isn't available (or when
``DATAMOG_REPO`` doesn't point at a usable Datamog checkout). Run from
the repo root with::

    DATAMOG_REPO=$PWD pytest python/datamog-magic
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from datamog_magic.repl import DatamogError, DatamogProcess, _count_blank_lines


def _repo_root() -> str | None:
    # Honour an explicit override; otherwise fall back to the path that
    # would work when running pytest from the repo root.
    explicit = os.environ.get("DATAMOG_REPO")
    if explicit:
        return explicit
    candidate = Path(__file__).resolve().parents[3]
    if (candidate / "package.json").exists():
        return str(candidate)
    return None


REPO = _repo_root()
HAS_BUN = shutil.which("bun") is not None

needs_subprocess = pytest.mark.skipif(
    REPO is None or not HAS_BUN,
    reason="needs `bun` and a Datamog repo checkout (set DATAMOG_REPO=)",
)


# --- pure helpers ----------------------------------------------------------


@pytest.mark.parametrize(
    "body,expected",
    [
        ("p(1).", 0),
        ("p(1).\n\np(2).", 1),
        ("p(1).\n\n\np(2).", 2),
        ("\n\np(1).", 2),
        ("", 1),
    ],
)
def test_count_blank_lines(body: str, expected: int) -> None:
    assert _count_blank_lines(body) == expected


# --- subprocess-backed tests ----------------------------------------------


@pytest.fixture
def proc() -> DatamogProcess:
    p = DatamogProcess(cwd=REPO, backend="sqlite", data_dir="/tmp")
    yield p
    p.close()


@needs_subprocess
def test_input_predicate_declaration(proc: DatamogProcess) -> None:
    events = proc.send_chunk("input predicate q(x: integer).")
    assert events == [{"kind": "declared", "predicate": "q", "arity": 1, "rowsLoaded": 0}]


@needs_subprocess
def test_rule_then_query(proc: DatamogProcess) -> None:
    proc.send_chunk("input predicate q(x: integer).")
    events = proc.send_chunk("p(X) :- q(X).\n?- p(X).")
    kinds = [e["kind"] for e in events]
    assert kinds == ["rule", "result"]
    result = events[1]
    assert result["columns"] == ["X"]
    assert result["types"] == ["integer"]
    assert result["rows"] == []


@needs_subprocess
def test_internal_blank_lines_are_part_of_one_chunk(proc: DatamogProcess) -> None:
    # An internal blank line splits the cell into two CLI-side chunks; the
    # wrapper must still drain both `done` sentinels and return all events
    # together — the user's mental model is "one cell = one send_chunk".
    events = proc.send_chunk(
        "input predicate r(y: string).\n\ninput predicate s(z: integer)."
    )
    kinds = [e["kind"] for e in events]
    assert kinds == ["declared", "declared"]
    assert events[0]["predicate"] == "r"
    assert events[1]["predicate"] == "s"


@needs_subprocess
def test_redefinition_across_chunks_yields_error(proc: DatamogProcess) -> None:
    proc.send_chunk("input predicate p(x: integer).")
    events = proc.send_chunk("input predicate p(y: string).")
    assert len(events) == 1
    err = events[0]
    assert err["kind"] == "error"
    assert err["phase"] == "analyze"
    assert "earlier chunk" in err["message"]
    assert err["line"] == 1


@needs_subprocess
def test_reset_allows_redefinition(proc: DatamogProcess) -> None:
    proc.send_chunk("input predicate p(x: integer).")
    reset = proc.reset()
    assert any(e.get("kind") == "info" for e in reset)
    again = proc.send_chunk("input predicate p(y: string).")
    assert again[0]["kind"] == "declared"


@needs_subprocess
def test_empty_chunk_is_a_noop(proc: DatamogProcess) -> None:
    # Spawn the process up front: an empty `send_chunk` returns early
    # without starting it, so without this the liveness check below would
    # observe a process that was never launched rather than one that
    # survived the no-ops.
    proc.start()
    assert proc.send_chunk("") == []
    assert proc.send_chunk("   \n  \n") == []
    # The subprocess should still be alive after no-ops.
    assert proc.is_alive() is True


@needs_subprocess
def test_close_is_idempotent() -> None:
    p = DatamogProcess(cwd=REPO, backend="sqlite", data_dir="/tmp")
    p.send_chunk("input predicate p(x: integer).")
    p.close()
    p.close()  # second close must not raise
    assert p.is_alive() is False


@needs_subprocess
def test_send_after_close_respawns() -> None:
    p = DatamogProcess(cwd=REPO, backend="sqlite", data_dir="/tmp")
    p.send_chunk("input predicate p(x: integer).")
    p.close()
    # `start()` is idempotent and `send_chunk` calls it; sending again
    # should bring up a fresh subprocess (with fresh state — `p` is
    # available again because it's a new session).
    events = p.send_chunk("input predicate p(y: string).")
    assert events[0]["kind"] == "declared"
    p.close()
