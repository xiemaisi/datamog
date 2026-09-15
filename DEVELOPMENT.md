# Development

Datamog is a Bun/TypeScript monorepo with a small Python package for the
Jupyter magic. Most TypeScript work should be done from the repository root so
Bun can resolve workspace packages.

The TypeScript packages are Bun-only when consumed directly: package entry
points target Bun's TypeScript runtime and some packages use Bun APIs directly.
Do not assume Node.js runtime compatibility unless a future package adds a
compiled Node build. The VS Code extension is built from this Bun workspace, but
the packaged extension runs as bundled JavaScript inside VS Code's extension
host and should not require Bun from end users.

## Agent Instructions and Implementation Reference

[AGENTS.md](AGENTS.md) holds the shared coding-agent instructions. Root
[CLAUDE.md](CLAUDE.md) imports it using Claude Code's `@AGENTS.md` syntax. Update
AGENTS.md for shared rules; keep CLAUDE.md as the small tool-specific entry point.
The [development reference](doc/development-reference.md) contains detailed
architecture, runtime, backend, editor, and documentation maintenance notes.

For investigation techniques, recurring bug patterns, and historical caveats, see
[Bug Hunting in Datamog](doc/bug-hunting.md).

## Prerequisites

- Bun 1.3 or newer.
- Node.js/npm for commands that invoke `node`, `npx`, or VS Code packaging.
- Python 3.10 or newer, only for `python/datamog-magic`.
- PostgreSQL, only when developing or testing the Postgres backend.

Install TypeScript workspace dependencies with:

```bash
bun install
```

For reproducible CI-style installs, use:

```bash
bun install --frozen-lockfile
```

## Repository Layout

- `packages/parser`: Langium grammar, generated parser, and AST types.
- `packages/core`: analyzer, type inference, safety checks, completions, and
  shared language logic.
- `packages/engine`: SQL translation, execution orchestration, loaders, and
  result coercion.
- `packages/backend/*`: Postgres, SQLite, sql.js, native, and seminaive
  backends.
- `packages/loader/*`: CSV, JSON, JSONL, Google Sheets, and Mermaid loaders.
- `packages/repl`: incremental REPL support used by the CLI and notebook magic.
- `packages/cli`: command-line interface and examples.
- `packages/playground`: browser playground built with Vite, Preact, CodeMirror,
  and sql.js.
- `packages/vscode-extension`: VS Code language extension.
- `python/datamog-magic`: IPython/Jupyter integration.
- `doc`: language spec, tutorial chapters, slides, and tutorial tooling.

## Common Commands

Run these from the repository root:

```bash
bun test                 # TypeScript tests across packages
bun run test:coverage    # TypeScript tests with coverage
bun run typecheck        # TypeScript project-reference build
bun run check            # Biome lint/format check
bun run check:fix        # Biome lint/format autofix
bun run build:cli        # compile the CLI to a standalone binary (dist/datamog)
```

Run a single test file with:

```bash
bun test packages/core/test/analyzer.test.ts
```

Run a Datamog program through the CLI:

```bash
bun run datamog packages/cli/examples/family/family.dl
bun run datamog --dry-run packages/cli/examples/family/family.dl
```

Select a backend explicitly:

```bash
bun run datamog --backend sqlite packages/cli/examples/family/family.dl
bun run datamog --backend sqljs packages/cli/examples/family/family.dl
bun run datamog --backend native packages/cli/examples/family/family.dl
bun run datamog --backend seminaive packages/cli/examples/family/family.dl
DATABASE_URL=postgres://localhost:5432/datamog_test bun run datamog --backend postgres program.dl
```

## Testing Notes

`bun test` runs the TypeScript unit tests recursively. The Postgres backend tests
are skipped unless `DATABASE_URL` is set. Point `DATABASE_URL` only at a
dedicated development or test database because those tests create and drop their
own tables.

Codespaces and the devcontainer include Z3 and a Postgres sidecar. Setup creates
separate test databases and enables the Postgres environment guards, so ordinary
`bun test` runs the solver and database suites. After updating the container
configuration, rebuild the container to install the tools and run setup. Only
examples unsupported by SQL backends remain intentionally skipped.

The playground end-to-end tests use Playwright:

```bash
bun run e2e
bun run e2e:ui
```

The e2e script installs Chromium on first run and starts the playground dev
server through Playwright's `webServer` configuration.

For the Python package:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e 'python/datamog-magic[test]'
python -m pytest python/datamog-magic
```

The notebook magic shells out to `bun run datamog`. If notebooks are launched
outside the repository, set `DATAMOG_CMD`, for example:

```bash
export DATAMOG_CMD="bun run --cwd /path/to/datamog datamog"
```

## Semantic Type Benchmarks

Run `bun run bench:semantic-types > baseline.json` for synthetic inference,
structural relation and input validation measurements. Set
`DATAMOG_BENCH_SAMPLES=11` for more samples. The script checks results and reports
median/min/max timings; it does not impose performance thresholds. See the
[baseline and methodology](doc/design/semantic-types-benchmarks.md) for what is
included in each measurement.

## Playground

Start the playground dev server:

```bash
bun run playground:dev
```

Build the static site:

```bash
bun run playground:build
```

The deployed GitHub Pages workflow installs dependencies with
`bun install --frozen-lockfile` and publishes `packages/playground/dist`.

Both commands first render the docs the site links to. Run them on their own
with:

```bash
bun run spec:html      # doc/spec.md -> packages/playground/public/spec.html
bun run tutorial:html  # doc/embed-tutorials -> packages/playground/tutorial.html
bun run docs:html      # both
```

Both outputs are gitignored build artifacts.

## Parser And Grammar

The grammar lives at `packages/parser/src/datamog.langium`. Generated parser
files live under `packages/parser/src/generated` and are ignored by Biome.

After changing the grammar, regenerate the parser from the repository root:

```bash
bun run generate:parser
```

Parser generation checks that the locally installed Langium CLI and runtime
have matching major/minor versions. If dependencies were installed by another
package manager, run `bun install --frozen-lockfile` to restore the locked
versions. The script also supplies the configuration schema base URI missing
from Langium CLI 4.2.

When adding language syntax, also check the downstream consumers that mirror the
language surface, especially `packages/core/src/keywords.ts`, playground
highlighting/completion code, and the VS Code TextMate grammar.

## VS Code Extension

Build the extension bundle:

```bash
bun --filter datamog-vscode build
```

Build a `.vsix` from the repository root:

```bash
bun run build:vscode
```

For interactive extension development, open `packages/vscode-extension` in VS
Code and start an Extension Development Host.

## Tutorial Slides

Marp slide sources live in `doc/walkthrough/slides`.

```bash
bun run slides:build
bun run slides:watch
```

Generated slide PDFs are written under `doc/walkthrough/slides/pdf`.

## Environment Variables

- `DATABASE_URL`: selects and configures the Postgres backend for the CLI and
  enables Postgres backend tests.
- `DATAMOG_EXAMPLES_DATABASE_URL`: optional second database for the examples
  suite, so it does not share one with the Postgres backend tests. Both drop and
  recreate `public`, which only makes them safe neighbours while `bun test` runs
  files serially. Unset, the examples suite falls back to `DATABASE_URL`.
  The devcontainer sets both URLs to separate test databases.
- `DATAMOG_REQUIRE_POSTGRES`: set to `1` to fail if the Postgres test environment
  is unavailable. Enabled in the devcontainer and Postgres CI job.
- `GOOGLE_API_KEY`: lets the CLI load private Google Sheets through the Google
  Sheets loader.
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY`: alternative Google
  Sheets credentials for service-account access.
- `DATAMOG_CMD`: command used by `datamog-magic` to start the Datamog CLI.
- `DATAMOG_REPO`: checkout the `datamog-magic` subprocess tests launch the CLI
  from. Unset, they derive it from the test file's own location, which is right
  for an in-tree run; set it when the package is installed elsewhere.

## Before Opening A Change

At minimum, run the checks that match the area you changed:

```bash
bun test
bun run typecheck
bun run check
```

Also run `bun run e2e` for playground behavior changes, Postgres tests with
`DATABASE_URL` for Postgres backend changes, and `python -m pytest
python/datamog-magic` for notebook magic changes.

## CI Workflows

- `CI`: required fast gate for linting, typechecking, TypeScript tests, CLI
  executable build, VS Code package build, and playground production build.
- `Postgres Backend`: runs the Postgres backend tests against a GitHub Actions
  Postgres service with `DATABASE_URL` set.
- `Python Magic`: tests `python/datamog-magic` on supported Python versions with
  Bun installed for subprocess-backed CLI tests.
- `Playground E2E`: runs Playwright against the playground and uploads the
  report/test-results artifacts on failure.
- `Deploy to Pages`: builds and deploys the playground (site root) and the
  FLOLAC slide deck (under `/slides/`) to GitHub Pages from `main` or manual
  dispatch.
