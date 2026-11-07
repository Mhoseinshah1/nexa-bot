#!/usr/bin/env bash
# isolation-mutation.sh - the mutation check of the phase 6A PR-5 isolation proof.
#
#   TEST_DATABASE_URL=... DATABASE_URL=... bash scripts/claude/isolation-mutation.sh [table]
#
# Runs tests/integration/isolation-proof/ three times against the PRIVATE database the two
# URLs name (never a shared one: it changes the schema's policies):
#
#   1. with <table>'s tenant policy DROPPED (row-level security still on: deny-all);
#   2. with <table>'s policy dropped AND its row-level security DISABLED (a missing policy
#      on a table that is not locked down: the leak);
#   3. untouched — the migration the suite runs first restores the policy
#      (ensureRowLevelSecurity), so this run is green again.
#
# The hook is the fixture's NEXA_ISOLATION_MUTATION_DROP_POLICY / _DISABLE_RLS (see
# tests/integration/isolation-proof/fixtures.ts); nothing else reads them. Each run goes
# through run-gate.sh (one integration run at a time, round-wide). Exit 0 only when both
# mutated runs are RED and the restored run is GREEN.
set -uo pipefail

table="${1:-customers}"
if [[ ! "$table" =~ ^[a-z_]+$ ]]; then
  echo "isolation-mutation: not a table name: $table" >&2
  exit 2
fi
if [[ -z "${TEST_DATABASE_URL:-}" || "${TEST_DATABASE_URL}" != "${DATABASE_URL:-}" ]]; then
  echo "isolation-mutation: set TEST_DATABASE_URL and DATABASE_URL to the same private database" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root" || exit 2
suite=(pnpm exec vitest run --project integration tests/integration/isolation-proof/)

run() {
  local label="$1"
  shift
  echo "== isolation-mutation: $label"
  env "$@" bash scripts/claude/run-gate.sh --integration "${suite[@]}" | grep -E '^(passed=|exit=)'
  return "${PIPESTATUS[0]}"
}

run "policy dropped on $table (RLS on)" NEXA_ISOLATION_MUTATION_DROP_POLICY="$table"
dropped=$?
run "policy dropped on $table and RLS off" NEXA_ISOLATION_MUTATION_DROP_POLICY="$table" \
  NEXA_ISOLATION_MUTATION_DISABLE_RLS=1
disabled=$?
run "restored (the suite's migration re-applies the policy)" NEXA_ISOLATION_MUTATION_NONE=1
restored=$?

echo "== isolation-mutation: dropped=$dropped disabled=$disabled restored=$restored (want non-zero, non-zero, 0)"
if [[ "$dropped" -ne 0 && "$disabled" -ne 0 && "$restored" -eq 0 ]]; then
  echo "isolation-mutation: OK - the suite turns red without $table's policy, green with it"
  exit 0
fi
echo "isolation-mutation: FAILED - the suite did not react to the mutation as it must" >&2
exit 1
