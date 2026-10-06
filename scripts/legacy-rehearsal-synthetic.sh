#!/usr/bin/env bash
# scripts/legacy-rehearsal-synthetic.sh — the SYNTHETIC rehearsal, run and asserted (WP-D6).
#
# Runs scripts/legacy-rehearsal.sh on the committed synthetic fixture — through its AES-256
# zip (tests/fixtures/legacy/archive/, a TEST-ONLY password), with the fake RickPanels and a
# freshly migrated database — and then requires 0 FAIL and EXACTLY the fixture's known
# PENDING checks (scripts/legacy-rehearsal-synthetic-assert.mjs). Proves the importer and
# the harness on this commit; never evidence about the legacy archive. CI runs it on MySQL
# 8.0 (job legacy-rehearsal); `pnpm rehearsal:synthetic` runs it locally.
#
#   scripts/legacy-rehearsal-synthetic.sh [--engine mariadb|mysql8] [--mysql-bin-dir DIR]
#       [--pg-url postgres://USER@HOST:PORT] [--port N] [--out DIR] [--nexa-env FILE]
#
# The PostgreSQL password comes from PGPASSWORD / PGPASSFILE (never argv). It creates
# nexa_rehearsal_<stamp>* databases and drops nothing; it prints their names at the end.

set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE=mariadb
BIN_DIR=""
PG_URL="postgres://nexa@127.0.0.1:5432"
PORT=33099
OUT=""
NEXA_ENV=""

die() {
  printf 'legacy-rehearsal-synthetic: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --engine) ENGINE="${2:?--engine needs a value}"; shift 2 ;;
    --mysql-bin-dir) BIN_DIR="${2:?--mysql-bin-dir needs a value}"; shift 2 ;;
    --pg-url) PG_URL="${2:?--pg-url needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    --nexa-env) NEXA_ENV="${2:?--nexa-env needs a value}"; shift 2 ;;
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/nexa-synthetic-rehearsal.XXXXXX")"
[ -n "$OUT" ] || OUT="$SCRATCH/out"

if [ -z "$NEXA_ENV" ]; then
  # The example configuration with a fresh throwaway keyring; blank values dropped (an
  # empty optional setting is refused by the config schema, an absent one is defaulted).
  NEXA_ENV="$SCRATCH/nexa.env"
  key="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
  grep -vE '^[A-Z0-9_]+=$' "$ROOT/.env.example" |
    sed "s#^SECRETS_KEYS=.*#SECRETS_KEYS=dev-1:${key}#" >"$NEXA_ENV"
fi

# The fixture zip's TEST-ONLY password (tests/fixtures/legacy/archive/make-fixtures.php);
# through the environment, as an operator passes the real one.
NEXA_SYNTHETIC_ZIP_PASSWORD='nexa-synthetic-archive-test-only'
export NEXA_SYNTHETIC_ZIP_PASSWORD

args=(
  --evidence-class synthetic
  --legacy-archive "$ROOT/tests/fixtures/legacy/archive/backup_2026-01-01.zip"
  --legacy-archive-password-env NEXA_SYNTHETIC_ZIP_PASSWORD
  --legacy-engine "$ENGINE"
  --tenant rehearsal
  --synthetic-panels
  --nexa-env "$NEXA_ENV"
  --pg-url "$PG_URL"
  --fresh-migrate
  --mariadb-port "$PORT"
  --out "$OUT"
)
[ -z "$BIN_DIR" ] || args+=(--mysql-bin-dir "$BIN_DIR")

rc=0
"$ROOT/scripts/legacy-rehearsal.sh" "${args[@]}" || rc=$?
# 3 is "no check failed, some are PENDING" — the expected shape; the assertion decides.
[ "$rc" -eq 0 ] || [ "$rc" -eq 3 ] || die "the rehearsal failed (exit $rc); see $OUT"
[ -f "$OUT/reconciliation.md" ] || die "the rehearsal wrote no reconciliation.md"
node "$ROOT/scripts/legacy-rehearsal-synthetic-assert.mjs" "$OUT/summary.json"
printf 'results: %s\n' "$OUT"
