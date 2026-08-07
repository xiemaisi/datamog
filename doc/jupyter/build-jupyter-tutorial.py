"""Build doc/jupyter/datamog-jupyter.ipynb from a structured cell list.

A standalone .ipynb is the natural source of truth for a Jupyter
tutorial — readers can browse it on GitHub *and* run it interactively,
without the "cell input vs cell output" formatting acrobatics that the
markdown version needed. We build the notebook structurally rather
than hand-escaping JSON to keep the source readable and round-trip-
safe through any future regeneration.
"""

from __future__ import annotations

import json
from pathlib import Path


def md(*lines: str) -> dict:
    return {
        "cell_type": "markdown",
        "metadata": {},
        "source": [ln + "\n" for ln in lines[:-1]] + [lines[-1]] if lines else [],
    }


def code(*lines: str) -> dict:
    return {
        "cell_type": "code",
        "metadata": {},
        "execution_count": None,
        "outputs": [],
        "source": [ln + "\n" for ln in lines[:-1]] + [lines[-1]] if lines else [],
    }


CELLS: list[dict] = [
    md(
        "# Datamog in a Jupyter notebook",
        "",
        "A Jupyter notebook is a great surface for working with Datamog interactively: you can keep declarations and rules in one cell, query results in the next, and have them render as pandas DataFrames you can chart, filter, or copy into a follow-up cell. Datamog ships a small Python package — `datamog-magic` — that hooks `bun run datamog --repl --json` into IPython as a `%%datamog` cell magic.",
        "",
        "This notebook walks through using it on the Titanic CSV that the playground already exposes as a built-in example. Run cells with **Shift-Enter**.",
    ),
    md(
        "## Install",
        "",
        "**If you're in the repo's devcontainer**, the venv, the kernel, and `datamog-magic` itself are all pre-set-up. Run `jupyter lab --no-browser --ip=0.0.0.0` from a terminal, follow the forwarded URL, and pick **Python (datamog)** as the kernel — skip the rest of this section.",
        "",
        "**Otherwise**, the magic shells out to a long-lived `datamog` REPL subprocess, so you need [Bun](https://bun.sh) on `PATH` and a checkout of this repo. Modern pip refuses to touch the system Python (PEP 668), so install into a virtualenv:",
        "",
        "```bash",
        "python3 -m venv .venv",
        "source .venv/bin/activate          # Windows: .venv\\Scripts\\activate",
        "pip install -e 'python/datamog-magic[pandas]' jupyter ipykernel matplotlib",
        "python -m ipykernel install --user --name datamog --display-name \"Python (datamog)\"",
        "```",
        "",
        "Open this notebook with the **Python (datamog)** kernel — without the `ipykernel install` step, JupyterLab silently uses some other Python that doesn't have `datamog-magic` and `%load_ext` would fail with `ModuleNotFoundError`.",
        "",
        "Sanity-check the kernel is the venv's Python:",
    ),
    code("import sys", "print(sys.executable)"),
    md(
        "The path should point inside a virtualenv, not the system Python — `.venv/bin/` for the manual install above, or `/opt/datamog-venv/bin/` in the repo's devcontainer (on Windows, the equivalent `Scripts\\` location).",
        "",
        "Now load the magic. You only need to do this once per kernel:",
    ),
    code("%load_ext datamog_magic"),
    md(
        "## Hello, Datamog",
        "",
        "Every Datamog cell starts with `%%datamog` on its very first line — that's the IPython *cell magic* header that tells Jupyter to send the whole cell to Datamog instead of trying to parse it as Python. Skip the header and you'll see a Python `SyntaxError` on the first `.`.",
        "",
        "A tiny one-cell program:",
    ),
    code(
        "%%datamog",
        "input predicate greeting(message: string).",
        "loud(M) :- greeting(M), length(M) > 0.",
    ),
    md(
        "The cell declares an EDB and an IDB. Datamog knows the EDB has no rows because we didn't wire up a loader yet. Querying still works — it just returns an empty table:",
    ),
    code("%%datamog", "?- loud(M)."),
    md(
        "## Working with Titanic",
        "",
        "The playground has a built-in Titanic example that pulls the CSV straight from pandas' GitHub raw URL. We can wire the same data into a notebook with `%datamog_init` (a *line* magic — one `%`, fits on a single line). We use the `gh:OWNER/REPO/PATH` shorthand, which Datamog expands to the `raw.githubusercontent.com` URL (the ref defaults to the repo's default branch):",
    ),
    code(
        "%datamog_init --backend sqlite --input passenger=gh:pandas-dev/pandas/doc/data/titanic.csv",
    ),
    md(
        "`%datamog_init` shuts down any existing subprocess and queues a fresh one with the new flags. The next `%%datamog` cell spawns it.",
        "",
        "Now declare the schema for the CSV and define a few aggregates:",
    ),
    code(
        "%%datamog",
        "input predicate passenger(",
        "    PassengerId: integer,",
        "    Survived:    integer,",
        "    Pclass:      integer,",
        "    Name:        string,",
        "    Sex:         string,",
        "    Age:         float?,",
        "    SibSp:       integer,",
        "    Parch:       integer,",
        "    Ticket:      string,",
        "    Fare:        float,",
        "    Cabin:       string?,",
        "    Embarked:    string?",
        ").",
        "",
        "survival_by_sex(Sex, avg(Survived), count(*)) :-",
        "    passenger(_, Survived, _, _, Sex, _, _, _, _, _, _, _).",
        "",
        "survival_by_class(Class, avg(Survived), count(*)) :-",
        "    passenger(_, Survived, Class, _, _, _, _, _, _, _, _, _).",
        "",
        "fare_by_class(Class, avg(Fare)) :-",
        "    passenger(_, _, Class, _, _, _, _, _, _, Fare, _, _).",
    ),
    md("Queries run as soon as you press Shift-Enter:"),
    code("%%datamog", "?- survival_by_sex(Sex, Rate, N)."),
    code("%%datamog", "?- survival_by_class(Class, Rate, N)."),
    code("%%datamog", "?- fare_by_class(Class, AverageFare)."),
    md(
        "Each result is a real pandas `DataFrame`, so anything you'd reach for afterwards — `.plot.bar()`, `.to_csv(...)`, joining against another DataFrame — Just Works on the displayed value.",
        "",
        "If you want to keep the result around for follow-up cells, add `--df NAME` to the cell magic. The cell still renders the result, *and* binds it as `NAME` in the user namespace:",
    ),
    code(
        "%%datamog --df survival_df",
        "?- survival_by_sex(Sex, Rate, N).",
    ),
    md(
        "Now `survival_df` is a regular pandas DataFrame — chart it, filter it, join it against anything else in the kernel:",
    ),
    code("survival_df.plot.bar(x='Sex', y='Rate', title='Titanic survival rate by sex')"),
    md(
        "If a cell has more than one query, `--df` binds the *last* result and prints a small warning. If it has none (just declarations or rules), the binding is a no-op and the magic tells you why.",
    ),
    md(
        "## Multi-cell sessions",
        "",
        "The magic keeps one long-lived subprocess across cells, so every `%%datamog` cell builds on the same accumulated session. The same rule the bare REPL enforces applies here: **a predicate's rule set is locked once committed**. Trying to add another rule for `survival_by_sex` in a later cell is rejected:",
    ),
    code(
        "%%datamog",
        "survival_by_sex(Sex, max(Survived)) :-",
        "    passenger(_, Survived, _, _, Sex, _, _, _, _, _, _, _).",
    ),
    md(
        "Two ways out:",
        "",
        "1. **Define every rule for one predicate in one cell.** This is the normal pattern — Datalog rules are usually grouped by head anyway.",
        "2. **`%datamog_reset`** wipes all accumulated state (declarations, rules, EDB tables) in the running subprocess. You'll lose loaded data, so you'll need to re-declare anything you want to keep.",
    ),
    code("%datamog_reset"),
    md(
        "## Other line magics",
        "",
        "| Magic | What it does |",
        "| ----- | ------------ |",
        "| `%datamog_init [flags]` | Shut down the existing subprocess (if any), reconfigure, and queue a fresh one. Flags: `--backend`, `--data-dir`, `--cwd`, `--cmd`, `--input name=source` (repeatable). |",
        "| `%datamog_reset` | Send `:reset` to the REPL — discards all accumulated declarations / rules / data without restarting the subprocess. |",
        "| `%datamog_close` | Terminate the subprocess. The next `%%datamog` cell will spawn a fresh one with the most recent `_init` config. |",
    ),
    md(
        "## What's actually happening",
        "",
        "`%%datamog` writes the cell's contents to the subprocess's stdin, followed by a blank line that signals \"end of chunk.\" The CLI parses the chunk, applies it incrementally to its in-memory session, and emits one ndjson event per declaration / rule / query result / error on stdout. The magic reads those events until it sees a `done` sentinel, then renders them — DataFrames for results, red HTML for errors, terse status lines for declarations.",
        "",
        "You can see the same wire format directly:",
    ),
    code(
        "!echo 'input predicate p(x: integer).' "
        "| bun run datamog --repl --json --backend sqlite"
    ),
    md(
        "This is the same channel a future Jupyter kernel could speak; the magic is the smallest possible adapter on top.",
    ),
    md(
        "## Limits",
        "",
        "`datamog-magic` is early. Known rough edges:",
        "",
        "- **Predicate redefinition isn't supported.** The underlying `IncrementalSession` forbids extending a predicate's rule set across chunks; `:reset` is the only way back. A finer-grained \"drop and recreate\" mode could relax this.",
        "- **One subprocess per kernel.** No multi-session support yet — every `%%datamog` cell shares the same backend.",
        "- **Subprocess overhead.** Each cell pays one stdin / stdout round-trip. For tutorial-sized programs this is well under a second; for large EDB loads (millions of rows) the SQL backends still do the bulk of the work, but the round-trip is no longer free.",
        "",
        "If you hit a bug or want a feature, file an issue at [github.com/max-schaefer/datamog/issues](https://github.com/max-schaefer/datamog/issues).",
    ),
]


NOTEBOOK = {
    "cells": CELLS,
    "metadata": {
        "kernelspec": {
            "display_name": "Python (datamog)",
            "language": "python",
            "name": "datamog",
        },
        "language_info": {
            "name": "python",
            "pygments_lexer": "ipython3",
        },
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}


def main() -> None:
    # Write next to this script so the builder works from any checkout
    # location, not just an absolute `/work` path.
    out = Path(__file__).resolve().parent / "datamog-jupyter.ipynb"
    out.write_text(json.dumps(NOTEBOOK, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {out} ({len(CELLS)} cells)")


if __name__ == "__main__":
    main()
