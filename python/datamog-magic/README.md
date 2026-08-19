# datamog-magic

IPython cell magic for running [Datamog](https://github.com/xiemaisi/datamog) programs from a Jupyter notebook.

The magic talks to the Datamog CLI in its `--repl --json` mode over stdin/stdout: the same long-lived subprocess persists across notebook cells, so declarations, rules, and queries accumulate just like they do in the interactive REPL.

## Install

Modern pip refuses to install into the system Python (PEP 668), so use
a virtualenv. From a checkout of the Datamog repo:

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e 'python/datamog-magic[pandas]' jupyter ipykernel
python -m ipykernel install --user --name datamog --display-name "Python (datamog)"
```

The `[pandas]` extra is recommended — query results render as
DataFrames. Without it the magic falls back to a plain text table.

The `ipykernel install` step registers this venv as a selectable
Jupyter kernel — pick **Python (datamog)** when you open a notebook.
Skip it and JupyterLab silently uses some other Python that doesn't
have `datamog-magic` installed, so `%load_ext datamog_magic` fails
with `ModuleNotFoundError`.

The magic shells out to `bun run datamog`, so a working [Bun](https://bun.sh) install on `PATH` is required. If you run Jupyter from outside the repo, point the magic at the right invocation via `DATAMOG_CMD`:

```bash
export DATAMOG_CMD="bun run --cwd /path/to/datamog datamog"
```

## Use

```python
%load_ext datamog_magic
```

```
%%datamog
input predicate parent(p: string, c: string).
ancestor(X, Y) :- parent(X, Y).
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
```

```
%%datamog
?- ancestor(X, Y).
```

The query result renders as a pandas DataFrame when pandas is installed; otherwise as a plain text table.

### Capturing a result as a DataFrame

Add `--df NAME` to the cell magic to bind the cell's last query result
to a Python name (still rendering it inline):

```
%%datamog --df ancestors
?- ancestor(X, Y).
```

```python
ancestors.head()
ancestors.to_csv("/tmp/ancestors.csv", index=False)
```

If the cell has multiple `?-` queries, `--df` binds the last one and
prints a small warning. If it has none, it tells you the binding was
skipped.

### Configuration

`%datamog_init` (line magic) reconfigures the underlying subprocess. Calling it shuts down any existing one and applies the new flags on the next cell:

```
%datamog_init --backend sqlite --data-dir ./data
```

Recognised flags:

| Flag | Effect |
|---|---|
| `--backend NAME` | Backend to launch (`sqlite`, `postgres`, `sqljs`, `native`, `seminaive`). |
| `--data-dir PATH` | Directory file-based loaders read from. |
| `--cwd PATH` | Working directory the subprocess runs in. |
| `--cmd 'bun run datamog'` | Override the launch command. |
| `--input name=source` | Map an input predicate to a file or URL (`.csv`, `.jsonl`, `.json`, `.mmd`, a Google Sheets URL, or a `gh:` shorthand). Repeatable; forwarded to the CLI verbatim. |

### Other line magics

| Magic | Effect |
|---|---|
| `%datamog_reset` | Send `:reset` to the REPL — discards all accumulated declarations, rules, and queries. |
| `%datamog_close` | Stop the subprocess. The next `%%datamog` cell will spawn a fresh one. |

## How it works

Each `%%datamog` cell is treated as one *chunk* sent over stdin to `datamog --repl --json`. The CLI parses the chunk, applies it incrementally to its accumulated session, and emits one ndjson event per declaration / rule / query result / error. The magic reads events until a `done` sentinel, then renders them: results as DataFrames, errors as red HTML, declarations as terse status lines.

The same redefinition rule applies as in the bare CLI: a predicate's rule set is locked once it's been committed, so put every rule for the same predicate in one cell. `%datamog_reset` is the way back if you want to redefine.
