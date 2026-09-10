#!/usr/bin/env bash
set -euo pipefail

cd /work

# Run on every container creation, including rebuilds with an existing pgdata
# volume: image init scripts only run when that volume is first initialised.
psql -X --set=ON_ERROR_STOP=1 postgres://app:app@postgres:5432/app <<'SQL'
SELECT format('CREATE DATABASE %I', name)
FROM (VALUES ('datamog_test'), ('datamog_examples')) AS required(name)
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = name)
\gexec
SQL

bun install --frozen-lockfile
/opt/datamog-venv/bin/pip install --no-cache-dir -e /work/python/datamog-magic

# Fail setup if the solver or either test database is unavailable.
z3 --version
psql -X --set=ON_ERROR_STOP=1 "$DATABASE_URL" --command='SELECT 1'
psql -X --set=ON_ERROR_STOP=1 "$DATAMOG_EXAMPLES_DATABASE_URL" --command='SELECT 1'
