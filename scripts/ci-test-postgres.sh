#!/usr/bin/env bash
# Turn off durability in CI's THROWAWAY PostgreSQL service container.
#
#   scripts/ci-test-postgres.sh <service container id>
#
# Why: every integration test resets the database with one TRUNCATE over ~150
# tables, and a TRUNCATE replaces each table's files — with fsync on, that is
# hundreds of synced file creations per test. Measured on PostgreSQL 16 against
# this schema: ~650 ms per reset with fsync on, ~145 ms with it off; the
# rbac + orders suites went from 65.7 s of test time to 19.3 s. Across ~3,000
# integration tests that was most of the 60–90 minute CI integration step.
#
# What it does NOT change: any query, any isolation level, any lock, any
# constraint, any result. fsync, full_page_writes and synchronous_commit decide
# only whether a committed write survives an OS crash or power loss, and the
# container is discarded when the job ends. No test kills the server.
#
# Refuses to run outside GitHub Actions, and only ever touches the container it
# is given, so it cannot be pointed at a database anybody keeps.
set -euo pipefail

fail() {
  printf '\033[31mFAIL\033[0m  %s\n' "$1" >&2
  exit 1
}

[ "${GITHUB_ACTIONS:-}" = "true" ] ||
  fail "this tunes CI's disposable database and runs only inside GitHub Actions."
[ "$#" -eq 1 ] && [ -n "$1" ] || fail "usage: $0 <postgres service container id>"
container="$1"

sql() {
  docker exec "$container" psql -U nexa -d postgres -v ON_ERROR_STOP=1 -Atc "$1"
}

# ALTER SYSTEM cannot run inside a transaction block, so one statement each.
# All three are reloadable (sighup or user context): no restart, no wait.
sql "ALTER SYSTEM SET fsync = off" >/dev/null
sql "ALTER SYSTEM SET full_page_writes = off" >/dev/null
sql "ALTER SYSTEM SET synchronous_commit = off" >/dev/null
sql "SELECT pg_reload_conf()" >/dev/null

# Read back rather than trust the reload: a setting that did not take is a
# job that is quietly three times slower, and nobody would know why.
for setting in fsync full_page_writes synchronous_commit; do
  value="$(sql "SHOW ${setting}")"
  [ "$value" = "off" ] || fail "${setting} is ${value} after reload."
  printf 'ok    %s = off\n' "$setting"
done
