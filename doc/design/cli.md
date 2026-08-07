# Design proposal: CLI runner redesign

Status: implemented (see `packages/cli/src/main.ts`).

Rework the batch CLI so that a program's **input predicates** are supplied as
like-named flags and its **output** is chosen by a positional argument. This is
the CLI face of the functor model in [`imports-as-functors.md`](./imports-as-functors.md):
the flags supply the root program's inputs, and the positional selects which of
its outputs to evaluate.

## Shape

```
datamog [global option]... <program.dl> [output] [--<input> <source>]...
datamog --repl [global option]...
```

- **Global options** come *before* the program.
- **`<program.dl>`** is the first positional.
- **`[output]`** is an optional second positional, immediately after the
  program, naming the output predicate to evaluate. Omitted means the default
  (`?-`) output.
- **`--<input> <source>`** flags follow the output and supply data for the
  program's input predicates.

### Why the order is fixed

An input flag names one of the *program's own* input predicates, and the CLI
only learns those names by parsing the file. So parsing is two-phase: read the
global options and the program path, parse the file to discover its inputs and
outputs, then interpret the trailing tokens (the output name and the `--<input>`
flags) against what the file declares. Global options must precede the program,
otherwise `--output-format` after the file would be indistinguishable from an
input predicate named `output-format`. This is the accepted trade: everything
before the program configures the run; everything after belongs to the program.

## Global options (before the program)

| Option | Meaning |
|---|---|
| `--output-format <fmt>` | `table` (default), `csv`, `jsonl`, `jsonl-flat`, `mermaid`, `ascii-graph` |
| `--backend <name>` | `sqlite` (default), `postgres`, `sqljs`, `native`, `seminaive` |
| `--data-dir <path>` | base directory for input auto-loading (defaults to the program's directory) |
| `--all` | evaluate every output rather than a single one (see *Evaluation*) |
| `--dry-run` | print the compiled SQL instead of running |
| `--warn-finiteness` | run the finiteness analysis and print warnings |
| `--max-iterations <n>` | cap fixed-point passes per stratum on the native/seminaive interpreters; stop with a note instead of looping (see `finiteness-checking.md`) |
| `--csv-no-header` | treat CSV inputs as having no header row |
| `--strict-contracts` | treat refinement-contract advisories as errors (see `refinement-annotations.md`) |
| `--obligations` | print the refinement proof obligations as SMT-LIB 2 instead of evaluating |
| `--verify` | discharge those obligations with the solver named by `$DATAMOG_SMT_SOLVER` (default `z3 -in`) |
| `--repl`, `--json` | start the REPL (the default with no program); `--json` emits ndjson events |
| `--help`, `-h` | usage |

`--backend postgres` still requires `DATABASE_URL`; with no `--backend`, a set
`DATABASE_URL` selects postgres, otherwise sqlite (unchanged).

## The output positional

The token immediately after the program, if it does not start with `-`, is the
output to evaluate. It must name a declared `output predicate` or the literal
`default`; any other name is an error that lists the valid outputs. Omitting it
evaluates the default output.

Only declared outputs (and `default`) are selectable. An internal derived
predicate that is not marked `output predicate` is not addressable from the CLI;
that is deliberate, since outputs are the program's intended interface.

## Input flags (after the output)

For each input predicate `p`, `--p <source>` (or `--p=<source>`) supplies its
data, overriding the default. `<source>` takes four forms:

- a local file path,
- an `http(s)://` URL,
- `gh:OWNER/REPO/PATH` shorthand for a raw GitHub file,
- a Google Sheets URL.

Input flags are **optional**. An input with no flag auto-loads from
`<p>.{csv,jsonl,json,mmd}` in the data directory, exactly as now; the flag only
overrides that. So the common case (data files sitting next to the program)
needs no flags at all.

### Flag-name resolution

Predicate names are conventionally snake_case (`may_alias`, `road_network`).
A flag `--X` after the program resolves to an input predicate as follows:

1. If `X` equals an input predicate name exactly, use it (`--road_network`,
   `--roadNetwork`).
2. Otherwise normalise `X` and each input name by lowercasing and stripping `-`
   and `_`, and match. `--road-network` normalises to `roadnetwork` and so
   matches an input `road_network` (kebab as an alias for the snake or camel
   name).
3. If step 2 matches more than one input (say both `road_network` and
   `roadNetwork` exist), the kebab form is ambiguous and errors; the exact forms
   from step 1 still work.
4. No match is an error that lists the program's input predicates.

### Escape hatch

A predicate can be backtick-quoted with characters no `--flag` can express. For
those, a general `--input <name>=<source>` accepts the exact predicate name. It
also serves as the escape hatch when an input name collides with a global
option. Because it names its own predicate, `--input name=source` is itself a
global option (it may appear before the program) and is the way to supply data
in `--repl` mode, where there is no program to attach `--<input>` flags to.
`--<input>` is sugar over `--input` for the common case; the older
`--extensional name=source` spelling is gone.

## Evaluation

The CLI evaluates a **single** output by default: the positional one, or the
default output, and prints just that. This replaces today's behaviour of running
and printing every query in the file.

Consequences:

- **A program with no default output and no positional is an error.** Some
  programs have only named outputs and no `?-` (for example a set of parallel
  aggregate demos). Running one with no output selected reports an error listing
  the available outputs.
- **`--all` evaluates every output** (the default `?-`, if present, plus every
  named output), printing each under its name. This is the escape hatch for the
  no-default case and recovers the old "show everything" behaviour. `--all` and
  an explicit output positional are mutually exclusive.
- Non-`table` formats require a single result, so they are incompatible with
  `--all` (this generalises the current "non-table format requires exactly one
  query" rule).

`--dry-run` prints the full compiled schema (input tables and rule views) plus
the query for the selected output (or, with `--all`, every output's query).

## REPL

The REPL has no program at launch, so it cannot know the input predicates and
there is no output positional or `--<input>` sugar. It keeps `--data-dir`,
`--backend`, `--json`, and `--input name=source` (the self-describing form,
which datamog-magic uses to supply data); un-mapped inputs load by the directory
convention as declarations arrive.

## What this changed

- `--extensional pred=source` became `--<input> source`, with `--input
  name=source` as the general form.
- The second positional stopped being a data directory (that is `--data-dir`
  only) and became the output name.
- Running a program evaluates one output, not all; `--all` restores all.
- A file with no default output needs an output positional or `--all`. The
  examples that moved to all-named-outputs are the ones this affects, and they
  document their outputs rather than gaining a filler `?-`: `examples/aggregates`
  is the worked case.

## Touch points

- `packages/cli/src/main.ts` holds the two-phase argument loop: global options
  and program path first; parse; then the output positional and the input flags
  resolved against the parsed program.
- The executor already supported selecting one output (each output is a query in
  `analyzed.queries`, keyed by `outputName`); the CLI filters to the chosen one
  rather than running all.
- Usage text, `.claude/CLAUDE.md`, and the walkthrough's `bun run datamog ...`
  invocations track this surface.
