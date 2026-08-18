#!/usr/bin/env bash
#
# Run the whole test suite against a throwaway Postgres cluster.
#
# Both Postgres-gated suites skip themselves when DATABASE_URL is unset, which is
# right for a quick `bun test` and means the ~100 tests they hold are easy to never
# run locally. This is the one command that runs them.
#
# The cluster is created fresh and deleted afterwards. That costs a couple of
# seconds of `initdb` per run and buys hermeticity: a reused data directory keeps
# tables, views and rows between runs, and the suites drop and recreate `public`
# on the assumption that nothing else is in there.
#
# Anything after `--` is passed through to `bun test`, so
# `bun run test:pg -- packages/backend/postgres` narrows the run.
#
# Override PGTESTPORT if 55432 is taken.

set -euo pipefail

PORT="${PGTESTPORT:-55432}"

for tool in initdb pg_ctl createdb; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool is not on PATH. Install Postgres client tools (brew install postgresql@16)." >&2
    exit 1
  fi
done

DATADIR="$(mktemp -d "${TMPDIR:-/tmp}/datamog-pg.XXXXXX")"

cleanup() {
  # Best-effort: a failed start leaves nothing to stop, and the trap still has to
  # remove the directory.
  if [ -n "${DATADIR:-}" ] && [ -d "$DATADIR/data" ]; then
    pg_ctl -D "$DATADIR/data" -m immediate stop >/dev/null 2>&1 || true
  fi
  if [ -n "${DATADIR:-}" ]; then
    rm -rf "$DATADIR"
  fi
}
trap cleanup EXIT

echo "==> initdb in $DATADIR"
initdb -D "$DATADIR/data" -U postgres --auth=trust >"$DATADIR/initdb.log" 2>&1 ||
  { cat "$DATADIR/initdb.log" >&2; exit 1; }

echo "==> starting on port $PORT"
# `-k` puts the unix socket inside the throwaway directory so a concurrent cluster
# on the machine's default socket path is untouched.
pg_ctl -D "$DATADIR/data" -l "$DATADIR/server.log" \
  -o "-p $PORT -k $DATADIR" start >/dev/null 2>&1 ||
  { cat "$DATADIR/server.log" >&2
    echo >&2
    echo "error: could not start Postgres on port $PORT." >&2
    echo "       Another cluster is probably using it: PGTESTPORT=55444 bun run test:pg" >&2
    exit 1; }

# Two databases: both suites wipe `public`, so they share one only while `bun test`
# runs files serially. Separate databases make that not a latent trap.
createdb -h 127.0.0.1 -p "$PORT" -U postgres datamog_test
createdb -h 127.0.0.1 -p "$PORT" -U postgres datamog_examples

export DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/datamog_test"
export DATAMOG_EXAMPLES_DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/datamog_examples"
# A skip is a failure here: the whole point of this script is to run those suites,
# so silently skipping them would defeat it. Same guard CI uses.
export DATAMOG_REQUIRE_POSTGRES=1

echo "==> bun test"
# Don't let a test failure trip `set -e` before the trap reports it usefully.
status=0
bun test --recursive "$@" || status=$?

echo "==> stopping and removing $DATADIR"
exit "$status"
