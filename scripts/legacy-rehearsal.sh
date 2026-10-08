#!/usr/bin/env bash
# scripts/legacy-rehearsal.sh — the MirzaBot -> NEXA migration rehearsal harness (Item 11).
#
# One command that runs the whole migration against COPIES and times it:
#
#   1. an isolated NEXA database — restored from a NEXA backup archive through the real
#      `backup restore` CLI, or freshly migrated and provisioned;
#   2. a throwaway MariaDB — or MySQL 8.0, `--legacy-engine mysql8` — this script starts
#      itself, loaded from a legacy dump or a MirzaBot backup zip that
#      scripts/legacy-archive-inspect.mjs validated first (on a developer machine: the
#      SYNTHETIC fixture under tests/fixtures/legacy/);
#   3. per cycle: pre-import snapshot -> P7 audit -> dry-run -> import, killed mid-run ->
#      resume -> reconcile -> report -> independent reconciliation checks -> rollback
#      rehearsal (restore the pre-import snapshot into a candidate, validate, cut over by
#      two renames, keep the displaced database) -> post-restore validation;
#   4. cycle 2 repeats from the clean restore and must reproduce cycle 1 exactly.
#
# Everything is recorded under --out: durations.tsv (seconds and load per stage),
# checks.tsv (PASS/FAIL per assertion), the snapshots, the P7 report, and summary.json.
#
# What it can NEVER do, by construction rather than by care:
#   - reach the live MirzaBot database: the legacy side is ALWAYS a MariaDB or MySQL this
#     script started on a scratch data directory, bound to 127.0.0.1. There is no flag that
#     points it at an existing MySQL server.
#   - write to a NEXA database it did not create: every name it creates, renames or
#     connects to for writing is `nexa_rehearsal_<stamp>[_suffix]`, asserted before use.
#   - drop anything. Displaced databases are kept, as ADR-0028 keeps
#     `nexa_pre_restore_<id>`; the cleanup commands are printed for a human.
#   - pass the P7 CLI's production guard: an importer argument containing "production"
#     is refused.
#   - call a provider write: it calls only P7 modes and `backup restore`; P7 holds the
#     read-only RickPanel inventory surface (#169), and the harness checks afterwards that
#     no provisioning operation was written.
#
# A SYNTHETIC run proves the CODE and the harness work. It is never legacy evidence, never
# a Q1-Q7 / C1 / C3 result, and never a rehearsal on real data — summary.json and every
# banner say so, and `--evidence-class staging` refuses a dump from tests/fixtures/.
#
# Usage: scripts/legacy-rehearsal.sh --help

set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE_INSPECT="$ROOT/scripts/legacy-archive-inspect.mjs"
CHECKS_SQL="$ROOT/scripts/legacy-rehearsal-checks.sql"
SOURCE_SQL="$ROOT/scripts/legacy-rehearsal-source.sql"
TABLE_HASHES_SQL="$ROOT/scripts/legacy-rehearsal-table-hashes.sql"
BACKUP_CLI="$ROOT/apps/api/dist/backup.cli.js"
MIGRATE_JS="$ROOT/apps/api/dist/infrastructure/persistence/migrate.js"
PROVISION_CLI="$ROOT/apps/api/dist/provision-installation.cli.js"

# --- The P7 CLI contract ------------------------------------------------------------------
#
# As built on wp4/p7-importer (docs/legacy-migration/importer.md §1):
#
#   legacy-import MODE --tenant T --source SOURCE --target TARGET --panel-map FILE
#                 [--format md|json] [--out DIR] [--source-password-env NAME] ...
#
# - SOURCE: a password-less `mysql://USER@HOST:PORT/DB`; the password travels in the
#   variable named by --source-password-env. A password on argv is refused (exit 64).
# - TARGET: the bare database name, which must equal DATABASE_URL's database — the harness
#   always sets DATABASE_URL to its own rehearsal database. A `nexa_rehearsal_<stamp>` name
#   carries the token `rehearsal`, so P7's production guard does not refuse it, and the
#   harness never passes --allow-production-target (an importer argument naming
#   production is refused below).
# - --evidence-class (required by P7 for import, resume and report; passed to every mode):
#   the harness's own class. P7 checks it against the source — a SYNTHETIC-marked source
#   is synthetic and nothing else.
# - Exit codes: 0 done; 3 done but a person must decide (audit BLOCKED, reconcile
#   DISCREPANCY, import/resume with adoption pending P6, report with a failed equation);
#   4 import interrupted (run left RUNNING); 64 usage or guard refusal; 65 mapping or
#   source refused; 73 report computed but its --out not written (the harness passes no
#   P7 --out); 1 anything else. The harness accepts 0 and 3, and records every 3 as
#   PENDING — done, not passed.
# - --inventory-page-size: omitted, P7 walks RickPanel with 200-row pages (the reader's
#   maximum, importer.md §1.1). The harness passes none; --importer-arg can.
LEGACY_IMPORT_CLI="${LEGACY_IMPORT_CLI:-$ROOT/apps/api/dist/legacy-import.cli.js}"
P7_MODES=(audit dry-run import resume reconcile report)
P7_EXIT_NEEDS_DECISION=3
# The technical half of the owner gate (importer.md §2.1): import/resume refuse, before any
# write and with exit 65, a source or panel map whose fingerprint is not the approved one.
# The harness passes the fingerprints of its OWN audit, so a source that changed between
# audit and import is refused, exactly as production's approved fingerprints would be.
P7_EXPECTED_FP_FLAG="--expected-fingerprint"
P7_EXPECTED_MAP_FP_FLAG="--expected-panel-map-fingerprint"
P7_SOURCE_PASSWORD_ENV=NEXA_REHEARSAL_LEGACY_PASSWORD
REPORT_SCHEMA="$ROOT/docs/legacy-migration/final-report.schema.json"
REPORT_CHECK="$ROOT/scripts/legacy-rehearsal-report-check.mjs"
RECONCILIATION="$ROOT/scripts/legacy-rehearsal-reconciliation.mjs"
SYNTHETIC_PANELS_HELPER="$ROOT/tests/support/legacy-rehearsal-synthetic-panels.ts"
PANEL_STATE_HELPER="$ROOT/tests/support/legacy-rehearsal-panel-state.ts"
TSX_BIN="$ROOT/apps/api/node_modules/.bin/tsx"

# --- Output helpers -----------------------------------------------------------------------

log() { printf '[rehearsal %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
# The operator's stderr, kept on fd 3: a stage's own stderr goes to its log, and a refusal
# raised inside one (run_direct, run_stage) must still reach the terminal — before this, a
# helper that died inside run_direct ended the rehearsal with no word on the screen.
exec 3>&2
die() {
  { printf '\033[31mREFUSED/FAILED\033[0m %s\n' "$*" >&3; } 2>/dev/null ||
    printf '\033[31mREFUSED/FAILED\033[0m %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
scripts/legacy-rehearsal.sh — rehearse the MirzaBot -> NEXA migration on copies.

Required:
  --evidence-class synthetic|staging
                         synthetic: a fixture dump; proves code, NEVER evidence.
                         staging:   a real legacy dump on an isolated staging copy.
  and exactly one of:
  --legacy-dump PATH     MySQL/MariaDB dump (.sql or .sql.gz) of the MirzaBot schema
  --legacy-archive PATH  MirzaBot's backup_YYYY-MM-DD.zip (one entry, plain or AES-256);
                         decrypted by scripts/legacy-archive-inspect.mjs into the private
                         scratch directory, never into --out
  Either is inspected BEFORE it is loaded (header, required tables, collations,
  completeness, sha256 of archive and inner dump); a blocker stops the rehearsal.
  --tenant SLUG          the NEXA tenant to import into
  --panel-map PATH       the explicit legacy code_panel -> NEXA panel map P7 reads
                         (format nexa-legacy-panel-map/v1; omit with --synthetic-panels)
  --nexa-env FILE        shell-sourceable KEY=VALUE config for the NEXA CLIs
                         (SECRETS_KEYS, REDIS_URL, ...). DATABASE_URL in it is IGNORED:
                         the harness always points the CLIs at its own database.
  --pg-url URL           postgres://USER@HOST:PORT — a server, no database path and NO
                         password (refused: argv is world-readable); the password comes
                         from PGPASSWORD or a PGPASSFILE
  --out DIR              results directory; must not exist
  and exactly one of:
  --nexa-archive PATH    restore this NEXA backup (.nxb) with `backup restore`
  --fresh-migrate        migrate an empty database and provision --tenant

Optional:
  --allow-pg-host HOST   required when the PostgreSQL host is not loopback
  --installed-host-is-not-production
                         required on a host with an installed NEXA (/etc/nexa/deploy.env)
  --cycles N             import+rollback cycles (default 2; cycle 2 repeats from the
                         clean restore and must reproduce cycle 1)
  --kill-after-rows N    interrupt the import once its run has seen N rows (default 1)
  --legacy-archive-password-env NAME
                         the environment variable holding the zip's password (never argv)
  --legacy-engine mariadb|mysql8
                         the throwaway legacy engine (default mariadb). MirzaBot's server
                         is MySQL 8: a dump carrying utf8mb4_0900_* collations, or taken
                         from a MySQL >= 8 server, is refused on mariadb (never rewritten)
  --mysql-bin-dir DIR    mysql8 only: where mysqld, mysql and mysqladmin of MySQL 8.0 are
                         (default: PATH; refused if they are MariaDB's)
  --legacy-schema NAME   schema the dump loads into (default oldbot)
  --mariadb-port N       port of the throwaway legacy engine, either one (default 33099)
  --pg-admin-db NAME     maintenance database for CREATE/RENAME (default postgres)
  --importer-arg ARG     extra argument for every P7 call (repeatable)
  --keep-legacy-copy     keep the throwaway engine's data directory afterwards
  --synthetic-panels     synthetic only: stand up the two fake RickPanels the fixture
                         assumes, register them in the rehearsal database and write the
                         panel map (tests/support/legacy-rehearsal-synthetic-panels.ts)
  --check-only           run every guard, print the plan, touch nothing

Exit: 0 every check PASSED; 3 no check failed but some are PENDING (a person must decide,
e.g. services awaiting P6 adoption) — done, NOT passed; 1 a check failed or a stage broke.
USAGE
}

# mysql8_server_version_ok "$(mysqld --version)" — MySQL 8.0 and not MariaDB.
mysql8_server_version_ok() {
  case "$1" in
    *MariaDB* | *mariadb*) return 1 ;;
  esac
  [[ "$1" =~ Ver[[:space:]]+8\.0\.[0-9]+ ]]
}

# --- Arguments ----------------------------------------------------------------------------

EVIDENCE_CLASS=""
LEGACY_DUMP=""
LEGACY_ARCHIVE=""
LEGACY_ARCHIVE_PASSWORD_ENV=""
LEGACY_ENGINE="mariadb"
MYSQL_BIN_DIR=""
TENANT=""
PANEL_MAP=""
NEXA_ENV=""
PG_URL=""
OUT=""
NEXA_ARCHIVE=""
FRESH_MIGRATE=0
ALLOW_PG_HOST=""
INSTALLED_HOST_ACK=0
CYCLES=2
KILL_AFTER_ROWS=1
LEGACY_SCHEMA="oldbot"
MARIADB_PORT=33099
PG_ADMIN_DB="postgres"
IMPORTER_ARGS=()
KEEP_LEGACY_COPY=0
CHECK_ONLY=0
SYNTHETIC_PANELS=0

need_value() {
  [ "$#" -ge 2 ] && [ -n "$2" ] && [ "${2#--}" = "$2" ] || die "$1 needs a value."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --evidence-class) need_value "$@"; EVIDENCE_CLASS="$2"; shift 2 ;;
    --legacy-dump) need_value "$@"; LEGACY_DUMP="$2"; shift 2 ;;
    --legacy-archive) need_value "$@"; LEGACY_ARCHIVE="$2"; shift 2 ;;
    --legacy-archive-password-env) need_value "$@"; LEGACY_ARCHIVE_PASSWORD_ENV="$2"; shift 2 ;;
    --legacy-archive-password | --legacy-archive-password=* | --password | --password=*)
      die "a password is never accepted on the command line (argv is world-readable). Put it in an environment variable and pass --legacy-archive-password-env NAME." ;;
    --legacy-engine) need_value "$@"; LEGACY_ENGINE="$2"; shift 2 ;;
    --mysql-bin-dir) need_value "$@"; MYSQL_BIN_DIR="$2"; shift 2 ;;
    --tenant) need_value "$@"; TENANT="$2"; shift 2 ;;
    --panel-map) need_value "$@"; PANEL_MAP="$2"; shift 2 ;;
    --nexa-env) need_value "$@"; NEXA_ENV="$2"; shift 2 ;;
    --pg-url) need_value "$@"; PG_URL="$2"; shift 2 ;;
    --out) need_value "$@"; OUT="$2"; shift 2 ;;
    --nexa-archive) need_value "$@"; NEXA_ARCHIVE="$2"; shift 2 ;;
    --fresh-migrate) FRESH_MIGRATE=1; shift ;;
    --allow-pg-host) need_value "$@"; ALLOW_PG_HOST="$2"; shift 2 ;;
    --installed-host-is-not-production) INSTALLED_HOST_ACK=1; shift ;;
    --cycles) need_value "$@"; CYCLES="$2"; shift 2 ;;
    --kill-after-rows) need_value "$@"; KILL_AFTER_ROWS="$2"; shift 2 ;;
    --legacy-schema) need_value "$@"; LEGACY_SCHEMA="$2"; shift 2 ;;
    --mariadb-port) need_value "$@"; MARIADB_PORT="$2"; shift 2 ;;
    --pg-admin-db) need_value "$@"; PG_ADMIN_DB="$2"; shift 2 ;;
    --importer-arg)
      # An importer argument may legitimately start with `--`, so not need_value.
      [ "$#" -ge 2 ] && [ -n "$2" ] || die "--importer-arg needs a value."
      IMPORTER_ARGS+=("$2"); shift 2 ;;
    --keep-legacy-copy) KEEP_LEGACY_COPY=1; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --synthetic-panels) SYNTHETIC_PANELS=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

# --- Guards: everything that can refuse runs before anything is touched --------------------

[ "${NODE_ENV:-}" != "production" ] ||
  die "NODE_ENV=production in this shell. A rehearsal never runs in a production environment."

case "$EVIDENCE_CLASS" in
  synthetic | staging) ;;
  "") die "--evidence-class is required: synthetic (a fixture; never evidence) or staging." ;;
  *) die "--evidence-class must be synthetic or staging, not '$EVIDENCE_CLASS'." ;;
esac

if [ -n "$LEGACY_DUMP" ] && [ -n "$LEGACY_ARCHIVE" ]; then
  die "pass --legacy-dump OR --legacy-archive, not both."
fi
[ -n "$LEGACY_DUMP" ] || [ -n "$LEGACY_ARCHIVE" ] ||
  die "--legacy-dump PATH or --legacy-archive PATH is required."
if [ -n "$LEGACY_ARCHIVE" ]; then
  [ -f "$LEGACY_ARCHIVE" ] && [ -r "$LEGACY_ARCHIVE" ] || die "--legacy-archive $LEGACY_ARCHIVE is not a readable file."
  LEGACY_INPUT="$(cd "$(dirname "$LEGACY_ARCHIVE")" && pwd)/$(basename "$LEGACY_ARCHIVE")"
  LEGACY_INPUT_FLAG=--legacy-archive
else
  [ -z "$LEGACY_ARCHIVE_PASSWORD_ENV" ] ||
    die "--legacy-archive-password-env is for --legacy-archive; a plain dump carries no password."
  [ -f "$LEGACY_DUMP" ] && [ -r "$LEGACY_DUMP" ] || die "--legacy-dump $LEGACY_DUMP is not a readable file."
  LEGACY_INPUT="$(cd "$(dirname "$LEGACY_DUMP")" && pwd)/$(basename "$LEGACY_DUMP")"
  LEGACY_INPUT_FLAG=--legacy-dump
fi
case "$LEGACY_INPUT" in
  */tests/fixtures/*)
    [ "$EVIDENCE_CLASS" = "synthetic" ] ||
      die "the $LEGACY_INPUT_FLAG input is under tests/fixtures/ — that is SYNTHETIC data, and a run on it is never staging evidence. Use --evidence-class synthetic."
    ;;
esac
if [ -n "$LEGACY_ARCHIVE_PASSWORD_ENV" ]; then
  [[ "$LEGACY_ARCHIVE_PASSWORD_ENV" =~ ^[A-Z_][A-Z0-9_]{0,63}$ ]] ||
    die "--legacy-archive-password-env must name an environment variable ([A-Z_][A-Z0-9_]*)."
  [ -n "${!LEGACY_ARCHIVE_PASSWORD_ENV:-}" ] ||
    die "--legacy-archive-password-env $LEGACY_ARCHIVE_PASSWORD_ENV: that environment variable is not set or is empty."
fi
case "$LEGACY_ENGINE" in
  mariadb) [ -z "$MYSQL_BIN_DIR" ] || die "--mysql-bin-dir is for --legacy-engine mysql8." ;;
  mysql8) ;;
  *) die "--legacy-engine must be mariadb or mysql8, not '$LEGACY_ENGINE'." ;;
esac

[[ "$TENANT" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "--tenant must be a tenant slug ([a-z0-9-], got '$TENANT')."
if [ "$SYNTHETIC_PANELS" -eq 1 ]; then
  [ "$EVIDENCE_CLASS" = "synthetic" ] ||
    die "--synthetic-panels stands up FAKE RickPanels; it is for --evidence-class synthetic only."
  [ -z "$PANEL_MAP" ] ||
    die "--synthetic-panels writes its own panel map; do not also pass --panel-map."
else
  [ -n "$PANEL_MAP" ] && [ -f "$PANEL_MAP" ] && [ -r "$PANEL_MAP" ] ||
    die "--panel-map must be a readable file: the code_panel -> panel map is explicit, never inferred."
fi
[ -n "$NEXA_ENV" ] && [ -f "$NEXA_ENV" ] && [ -r "$NEXA_ENV" ] || die "--nexa-env must be a readable file."

if [ "$FRESH_MIGRATE" -eq 1 ] && [ -n "$NEXA_ARCHIVE" ]; then
  die "pass --nexa-archive OR --fresh-migrate, not both."
fi
if [ "$FRESH_MIGRATE" -eq 0 ] && [ -z "$NEXA_ARCHIVE" ]; then
  die "pass --nexa-archive PATH (a production-like backup) or --fresh-migrate."
fi
if [ -n "$NEXA_ARCHIVE" ]; then
  [ -f "$NEXA_ARCHIVE" ] && [ -r "$NEXA_ARCHIVE" ] || die "--nexa-archive $NEXA_ARCHIVE is not a readable file."
fi

[[ "$CYCLES" =~ ^[1-5]$ ]] || die "--cycles must be 1..5."
[[ "$KILL_AFTER_ROWS" =~ ^[1-9][0-9]{0,8}$ ]] || die "--kill-after-rows must be a positive integer."
[[ "$MARIADB_PORT" =~ ^[0-9]{4,5}$ ]] || die "--mariadb-port must be a port number."
[[ "$LEGACY_SCHEMA" =~ ^[A-Za-z0-9_]{1,64}$ ]] || die "--legacy-schema must be [A-Za-z0-9_]."
[[ "$PG_ADMIN_DB" =~ ^[A-Za-z0-9_]{1,63}$ ]] || die "--pg-admin-db must be [A-Za-z0-9_]."

for arg in "${IMPORTER_ARGS[@]+"${IMPORTER_ARGS[@]}"}"; do
  case "$(printf '%s' "$arg" | tr '[:upper:]' '[:lower:]')" in
    *production* | *prod-*)
      die "--importer-arg '$arg' names production. The rehearsal never passes the P7 production guard."
      ;;
  esac
done

# The PostgreSQL server. A URL with a database path is refused: the harness names every
# database it touches, so a path could only be a way to aim it at one it did not create.
PG_RE='^postgres(ql)?://([^:@/]+)(:[^@/]*)?@([^:/?#]+)(:([0-9]{1,5}))?/?$'
[[ "$PG_URL" =~ $PG_RE ]] ||
  die "--pg-url must be postgres://USER@HOST[:PORT] with no database path."
# No password on argv: /proc/<pid>/cmdline is world-readable. psql, pg_dump, pg_restore and
# the NEXA CLIs (node-postgres) all read PGPASSWORD or a PGPASSFILE from the environment.
[ -z "${BASH_REMATCH[3]}" ] ||
  die "--pg-url carries a password, and argv is world-readable. Pass postgres://USER@HOST[:PORT] and put the password in PGPASSWORD or a PGPASSFILE."
PG_HOST="${BASH_REMATCH[4]}"
PG_URL="${PG_URL%/}"
case "$PG_HOST" in
  postgres | redis | nexa-postgres*)
    die "--pg-url host '$PG_HOST' is a deployment's own service name. A rehearsal never runs inside an installation's network."
    ;;
  127.0.0.1 | localhost | ::1 | '[::1]') ;;
  *)
    [ "$ALLOW_PG_HOST" = "$PG_HOST" ] ||
      die "--pg-url host '$PG_HOST' is not loopback. Pass --allow-pg-host $PG_HOST if this is an isolated staging server."
    ;;
esac

if [ -e /etc/nexa/deploy.env ] && [ "$INSTALLED_HOST_ACK" -ne 1 ]; then
  die "this host has an installed NEXA (/etc/nexa/deploy.env). Run the rehearsal on a staging host and pass --installed-host-is-not-production to say so."
fi

[ -n "$OUT" ] || die "--out is required."
[ ! -e "$OUT" ] || die "--out $OUT already exists; every rehearsal writes a fresh directory."

STAMP="$(date -u +%Y%m%d%H%M%S)"
NEXA_DB="nexa_rehearsal_${STAMP}"

assert_rehearsal_db() {
  [[ "$1" =~ ^nexa_rehearsal_[0-9]{14}(_[a-z0-9_]{1,20})?$ ]] ||
    die "internal guard: '$1' is not a rehearsal database name; refusing to touch it."
}
assert_rehearsal_db "$NEXA_DB"

if [ "$CHECK_ONLY" -eq 1 ]; then
  cat <<PLAN
guards passed (check only; nothing was touched)
  evidence class   $EVIDENCE_CLASS$([ "$EVIDENCE_CLASS" = synthetic ] && printf ' — NOT legacy evidence')
  legacy input     $LEGACY_INPUT ($LEGACY_INPUT_FLAG; inspected, then loaded into a throwaway $LEGACY_ENGINE on 127.0.0.1:$MARIADB_PORT)
  NEXA database    $NEXA_DB on $PG_HOST ($([ -n "$NEXA_ARCHIVE" ] && printf 'restored from archive' || printf 'fresh migrate'))
  tenant           $TENANT
  cycles           $CYCLES (interrupt after $KILL_AFTER_ROWS rows)
  P7 CLI           $LEGACY_IMPORT_CLI
PLAN
  exit 0
fi

# --- The importer, then the tooling ------------------------------------------------------

# The importer. Absent is a precise refusal, not a skipped stage: a rehearsal that skipped
# the import would report every check about the import as vacuously true.
if [ ! -f "$LEGACY_IMPORT_CLI" ]; then
  die "the P7 importer CLI is not at $LEGACY_IMPORT_CLI.
       It is built from apps/api/src/legacy-import.cli.ts (branch wp4/p7-importer): merge or
       check out that branch and run 'pnpm build', or export LEGACY_IMPORT_CLI=<path>."
fi
command -v node >/dev/null 2>&1 || die "node is not on PATH."
P7_HELP="$(node "$LEGACY_IMPORT_CLI" --help 2>&1 || true)"
for flag in "$P7_EXPECTED_FP_FLAG" "$P7_EXPECTED_MAP_FP_FLAG"; do
  grep -qF -- "$flag" <<<"$P7_HELP" ||
    die "the P7 CLI's --help does not offer $flag: the importer predates the approved-source binding (#183 @ 9942263f). Build a current one."
done
for mode in "${P7_MODES[@]}"; do
  grep -qw -- "$mode" <<<"$P7_HELP" ||
    die "the P7 CLI's --help does not mention mode '$mode'. Reconcile the CLI contract block at the top of this script with its --help."
done

for tool in node psql pg_dump pg_restore sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool '$tool' is not on PATH."
done
[ -f "$ARCHIVE_INSPECT" ] || die "the archive inspector is missing from scripts/."

# The legacy engine's binaries. mysql8 is MySQL's own mysqld 8.0 — on many hosts `mysqld`
# is a MariaDB symlink, so the version string decides, not the name.
if [ "$LEGACY_ENGINE" = "mariadb" ]; then
  for tool in mariadbd mariadb mariadb-install-db mariadb-admin; do
    command -v "$tool" >/dev/null 2>&1 || die "required tool '$tool' is not on PATH."
  done
  LEGACY_SERVER=mariadbd
  LEGACY_CLIENT=mariadb
  LEGACY_ADMIN=mariadb-admin
else
  if [ -n "$MYSQL_BIN_DIR" ]; then
    LEGACY_SERVER="$MYSQL_BIN_DIR/mysqld"
    LEGACY_CLIENT="$MYSQL_BIN_DIR/mysql"
    LEGACY_ADMIN="$MYSQL_BIN_DIR/mysqladmin"
  else
    LEGACY_SERVER="$(command -v mysqld || true)"
    LEGACY_CLIENT="$(command -v mysql || true)"
    LEGACY_ADMIN="$(command -v mysqladmin || true)"
  fi
  for tool in "$LEGACY_SERVER" "$LEGACY_CLIENT" "$LEGACY_ADMIN"; do
    [ -n "$tool" ] && [ -x "$tool" ] ||
      die "--legacy-engine mysql8 needs MySQL 8.0's mysqld, mysql and mysqladmin (pass --mysql-bin-dir DIR); '${tool:-mysqld/mysql/mysqladmin}' is not executable."
  done
  LEGACY_SERVER_VERSION="$("$LEGACY_SERVER" --version 2>&1 || true)"
  mysql8_server_version_ok "$LEGACY_SERVER_VERSION" ||
    die "--legacy-engine mysql8: '$LEGACY_SERVER' is not MySQL 8.0 ($LEGACY_SERVER_VERSION). Pass --mysql-bin-dir with MySQL 8.0's binaries."
fi
[ -f "$CHECKS_SQL" ] && [ -f "$SOURCE_SQL" ] && [ -f "$TABLE_HASHES_SQL" ] ||
  die "the reconciliation SQL files are missing from scripts/."
[ -f "$BACKUP_CLI" ] && [ -f "$MIGRATE_JS" ] && [ -f "$PROVISION_CLI" ] ||
  die "apps/api/dist is not built. Run: pnpm build"
[ -f "$REPORT_SCHEMA" ] && [ -f "$REPORT_CHECK" ] || die "the report schema or its checker is missing."
[ -f "$RECONCILIATION" ] || die "the reconciliation table generator is missing from scripts/."
if [ "$SYNTHETIC_PANELS" -eq 1 ]; then
  [ -f "$SYNTHETIC_PANELS_HELPER" ] && [ -x "$TSX_BIN" ] ||
    die "--synthetic-panels needs $SYNTHETIC_PANELS_HELPER and tsx (pnpm install)."
fi
# Equation P4 walks the production panels read-only before and after every import.
[ -f "$PANEL_STATE_HELPER" ] && [ -x "$TSX_BIN" ] ||
  die "the panel-state walk (P4) needs $PANEL_STATE_HELPER and tsx: run pnpm install (with dev dependencies)."

# --- Workspace ----------------------------------------------------------------------------

mkdir -p "$OUT/logs" "$OUT/snapshots"
OUT="$(cd "$OUT" && pwd)"
printf 'cycle\tstage\tseconds\texit\tload_before\tload_after\n' >"$OUT/durations.tsv"
printf 'cycle\tcheck\tresult\texpected\tactual\n' >"$OUT/checks.tsv"
# A file, not an array: databases are created inside stages, which run in subshells.
CREATED_DBS_FILE="$OUT/databases-created.txt"
: >"$CREATED_DBS_FILE"

# A socket path is limited to ~108 bytes, so the legacy engine's runtime lives under a short
# private temporary directory; the data directory lives under it too and is removed on
# exit unless --keep-legacy-copy (it is a copy of customer data).
MDB_RUN="$(mktemp -d "${TMPDIR:-/tmp}/nexa-rh.XXXXXX")"
MDB_DATA="$MDB_RUN/data"
MDB_SOCK="$MDB_RUN/mysqld.sock"
MDB_ROOT_CNF="$MDB_RUN/root.cnf"
MDB_PID=""
# The per-run key P4's account digests are HMACed with. It lives and dies with the private
# scratch directory, so the digests under --out are unlinkable to any username afterwards.
od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$MDB_RUN/panel-state.key"

# The process group of the stage running now. Every stage starts in its own group (job
# control on for that one launch), so stopping it reaches the node process at the end of
# the subshell chain, not just the first subshell.
STAGE_PGID=""

kill_stage_group() {
  [ -n "${STAGE_PGID:-}" ] || return 0
  kill -TERM -- "-$STAGE_PGID" 2>/dev/null || true
  sleep 1
  kill -KILL -- "-$STAGE_PGID" 2>/dev/null || true
  STAGE_PGID=""
}

# INT/TERM: stop the running stage's whole tree, then exit through the EXIT trap (cleanup).
on_signal() {
  log "interrupted: stopping the running stage and everything it started"
  kill_stage_group
  exit 130
}

cleanup() {
  local rc=$?
  kill_stage_group
  if [ -n "${PANELS_PID:-}" ]; then kill -TERM -- "-$PANELS_PID" 2>/dev/null || kill -TERM "$PANELS_PID" 2>/dev/null || true; fi
  if [ -n "$MDB_PID" ] && kill -0 "$MDB_PID" 2>/dev/null; then
    "$LEGACY_ADMIN" --defaults-extra-file="$MDB_ROOT_CNF" --socket="$MDB_SOCK" shutdown >/dev/null 2>&1 ||
      kill "$MDB_PID" 2>/dev/null || true
    wait "$MDB_PID" 2>/dev/null || true
  fi
  if [ "$KEEP_LEGACY_COPY" -eq 1 ]; then
    log "legacy copy kept at $MDB_DATA (it holds customer data: remove it when done)"
  else
    rm -rf "$MDB_RUN"
  fi
  if [ -s "${CREATED_DBS_FILE:-/nonexistent}" ]; then
    log "databases left in place (nothing here drops a database):"
    while IFS= read -r db; do log "  $db"; done <"$CREATED_DBS_FILE"
    log "remove them deliberately when done: psql <server>/$PG_ADMIN_DB -c 'DROP DATABASE <name>'"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap on_signal INT TERM

loadavg() { cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || printf 'n/a'; }

record_duration() { # CYCLE NAME SECONDS EXIT LOAD_BEFORE
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$(loadavg)" >>"$OUT/durations.tsv"
}

# run_direct CYCLE NAME CMD... — for the stages that must run in THIS shell because they
# leave something behind it has to manage (the MariaDB process). Not called from a
# conditional, so errexit holds inside CMD; a failure ends the rehearsal through the trap.
run_direct() {
  local cycle="$1" name="$2" t0 load0
  shift 2
  t0=$SECONDS
  load0="$(loadavg)"
  log "cycle $cycle: $name"
  "$@" >"$OUT/logs/c${cycle}-${name}.log" 2>&1
  record_duration "$cycle" "$name" "$((SECONDS - t0))" 0 "$load0"
}

# run_stage CYCLE NAME CMD... — runs CMD with its own errexit (in the background and
# waited for, so `set -e` is NOT suspended inside it the way an `if` would suspend it),
# times it, records it, and stops the rehearsal on failure.
run_stage() {
  local cycle="$1" name="$2"
  shift 2
  local log_file="$OUT/logs/c${cycle}-${name}.log" t0 load0 rc
  t0=$SECONDS
  load0="$(loadavg)"
  log "cycle $cycle: $name"
  set -m
  "$@" >"$log_file" 2>&1 &
  STAGE_PGID=$!
  set +m
  if wait "$STAGE_PGID"; then rc=0; else rc=$?; fi
  STAGE_PGID=""
  record_duration "$cycle" "$name" "$((SECONDS - t0))" "$rc" "$load0"
  [ "$rc" -eq 0 ] || die "stage '$name' (cycle $cycle) failed with exit $rc; see $log_file"
}

# run_p7 CYCLE NAME MODE [args...] — a P7 call as a stage. Exit 0 is done; exit 3 is
# done-but-a-person-must-decide, recorded as a PENDING check naming the mode (P7's
# markdown report in the log says why); anything else stops the rehearsal.
run_p7() {
  local cycle="$1" name="$2"
  shift 2
  local log_file="$OUT/logs/c${cycle}-${name}.log" t0 load0 rc
  t0=$SECONDS
  load0="$(loadavg)"
  log "cycle $cycle: $name"
  # stdout and stderr apart: under --format json, stdout IS the document, and a runtime
  # warning on stderr (node prints deprecations there) must not corrupt it.
  set -m
  importer "$@" >"$log_file" 2>"${log_file%.log}.stderr.log" &
  STAGE_PGID=$!
  set +m
  if wait "$STAGE_PGID"; then rc=0; else rc=$?; fi
  STAGE_PGID=""
  record_duration "$cycle" "$name" "$((SECONDS - t0))" "$rc" "$load0"
  case "$rc" in
    0) ;;
    "$P7_EXIT_NEEDS_DECISION") pending "$cycle" "${name}_needs_decision" "exit 0" "exit 3 (see logs/c${cycle}-${name}.log)" ;;
    *) die "stage '$name' (cycle $cycle) failed with exit $rc; see $log_file and ${log_file%.log}.stderr.log" ;;
  esac
}

# json_get FILE PATH — one value from a P7 JSON document, or a precise stop. Never a bare
# substitution in an assignment: under `set -e` a failed one ends the harness with no word.
json_get() {
  local value
  value="$(node "$REPORT_CHECK" get "$1" "$2" 2>/dev/null)" ||
    die "cannot read $2 from $1 (not a JSON document?)"
  printf '%s\n' "$value"
}

FAILED_CHECKS=0
PENDING_CHECKS=0
# pending CYCLE NAME EXPECTED ACTUAL — not a failure and not a pass: a fact a person must
# decide (services awaiting P6, a population only the owner can rule on). Recorded so the
# summary can never present it as success.
pending() {
  PENDING_CHECKS=$((PENDING_CHECKS + 1))
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" PENDING "$3" "$4" >>"$OUT/checks.tsv"
  log "PENDING cycle $1: $2 ($4)"
}

# check CYCLE NAME EXPECTED ACTUAL — exact string equality, recorded either way.
check() {
  local result=PASS
  [ "$3" = "$4" ] || { result=FAIL; FAILED_CHECKS=$((FAILED_CHECKS + 1)); }
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$result" "$3" "$4" >>"$OUT/checks.tsv"
  [ "$result" = PASS ] || log "CHECK FAILED cycle $1: $2 (expected $3, got $4)"
}

# --- PostgreSQL helpers -------------------------------------------------------------------

pg_admin() { psql -X -q -At -v ON_ERROR_STOP=1 "$PG_URL/$PG_ADMIN_DB" "$@"; }
pg_nexa() { psql -X -q -At -v ON_ERROR_STOP=1 "$PG_URL/$NEXA_DB" "$@"; }

create_db() {
  assert_rehearsal_db "$1"
  pg_admin -c "CREATE DATABASE \"$1\""
  printf '%s\n' "$1" >>"$CREATED_DBS_FILE"
}

# rename_db FROM TO — ends the CLIENT sessions on FROM, then renames it. Client sessions
# only: an autovacuum worker on a freshly restored candidate runs as the bootstrap
# superuser, and a non-superuser's pg_terminate_backend on it fails ("permission denied
# to terminate process") — which ended a synthetic rehearsal at the cutover. The server's
# own RENAME signals autovacuum workers in that database itself and waits for them.
rename_db() {
  assert_rehearsal_db "$1"
  assert_rehearsal_db "$2"
  pg_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                WHERE datname = '$1' AND pid <> pg_backend_pid() AND backend_type = 'client backend'" >/dev/null
  pg_admin -c "ALTER DATABASE \"$1\" RENAME TO \"$2\""
}

# snapshot LABEL — the NEXA-side aggregate snapshot, from the same SQL the runbooks use.
snapshot() {
  pg_nexa -F "$(printf '\t')" -v tenant="$TENANT" -f "$CHECKS_SQL" >"$OUT/snapshots/$1.tsv"
}

metric() { # metric FILE KEY — the value, or the literal "absent"
  awk -F '\t' -v k="$2" '$1 == k { print $2; found = 1 } END { if (!found) print "absent" }' "$1"
}

# delta KEY — POST minus PRE for an integer metric, or "absent". Never arithmetic on a
# missing value: bash would read the word `absent` as an unset variable, which is 0, and a
# missing figure would pass every "unchanged" check.
delta() {
  local before after
  before="$(metric "$PRE" "$1")"
  after="$(metric "$POST" "$1")"
  if [[ "$before" =~ ^-?[0-9]+$ ]] && [[ "$after" =~ ^-?[0-9]+$ ]]; then
    printf '%s\n' "$((after - before))"
  else
    printf 'absent\n'
  fi
}

# le_holds A B — "holds" when both are integers and A <= B; otherwise what failed. For
# the equations that are an inequality (C2), still recorded as one exact string.
le_holds() {
  if [[ "$1" =~ ^-?[0-9]+$ ]] && [[ "$2" =~ ^-?[0-9]+$ ]]; then
    if [ "$1" -le "$2" ]; then printf 'holds\n'; else printf 'fails: %s > %s\n' "$1" "$2"; fi
  else
    printf 'absent: %s / %s\n' "$1" "$2"
  fi
}

# Sum of every `prefix*` line's value (e.g. all map:user:* decisions).
metric_sum() {
  awk -F '\t' -v p="$2" 'index($1, p) == 1 { s += $2 } END { print s + 0 }' "$1"
}

# Every line except the excluded prefixes — for "nothing else changed" comparisons.
snapshot_without() {
  local file="$1"
  shift
  local pattern
  pattern="$(printf '%s|' "$@")"
  grep -Ev "^(${pattern%|})" "$file" || true
}

# Runs a NEXA CLI with the operator's config, but ALWAYS against the harness's database.
with_nexa_env() {
  (
    set -a
    # shellcheck disable=SC1090
    . "$NEXA_ENV"
    set +a
    DATABASE_URL="$CLI_DATABASE_URL"
    export DATABASE_URL
    # The synthetic fake panels listen on 127.0.0.2/3; NEVER set for a staging run.
    if [ "$SYNTHETIC_PANELS" -eq 1 ]; then
      PANEL_HTTP_ALLOW_LOOPBACK=true
      export PANEL_HTTP_ALLOW_LOOPBACK
    fi
    exec "$@"
  )
}

# --- The throwaway legacy source (MariaDB, or MySQL 8.0) ----------------------------------

mdb_root() { "$LEGACY_CLIENT" --defaults-extra-file="$MDB_ROOT_CNF" --socket="$MDB_SOCK" "$@"; }

start_legacy() {
  local me
  me="$(id -un)"
  if [ "$LEGACY_ENGINE" = "mariadb" ]; then
    mariadb-install-db --no-defaults --user="$me" --datadir="$MDB_DATA" \
      --auth-root-authentication-method=normal --skip-test-db >/dev/null
    mariadbd --no-defaults --user="$me" --datadir="$MDB_DATA" --socket="$MDB_SOCK" \
      --port="$MARIADB_PORT" --bind-address=127.0.0.1 --pid-file="$MDB_RUN/mysqld.pid" \
      --log-error="$OUT/logs/mariadb.err" &
  else
    # MySQL 8.0: root@localhost without a password until the ALTER USER below; the X
    # Protocol listener is off so it can never collide with another instance's port.
    # secure_file_priv=NULL: no LOAD DATA / INTO OUTFILE at all — the instance reads its
    # dump on stdin and never touches a file path.
    "$LEGACY_SERVER" --no-defaults --initialize-insecure --user="$me" --datadir="$MDB_DATA" \
      --secure-file-priv=NULL --log-error="$OUT/logs/mysql8-init.err"
    "$LEGACY_SERVER" --no-defaults --user="$me" --datadir="$MDB_DATA" --socket="$MDB_SOCK" \
      --port="$MARIADB_PORT" --bind-address=127.0.0.1 --mysqlx=OFF --secure-file-priv=NULL \
      --pid-file="$MDB_RUN/mysqld.pid" --log-error="$OUT/logs/mysql8.err" &
  fi
  MDB_PID=$!
  local i
  for i in $(seq 1 120); do
    if "$LEGACY_ADMIN" --no-defaults --socket="$MDB_SOCK" --user=root ping >/dev/null 2>&1; then
      break
    fi
    kill -0 "$MDB_PID" 2>/dev/null || die "the throwaway $LEGACY_ENGINE exited; see $OUT/logs/"
    sleep 1
    [ "$i" -lt 120 ] || die "the throwaway $LEGACY_ENGINE did not answer within 120s."
  done
  # Lock root to a random password kept in a 0600 file, and drop any TCP root account:
  # the instance is local and temporary, but it holds a copy of customer data.
  local root_pw
  root_pw="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  # On stdin, never -e: a password in argv is readable by every local user.
  "$LEGACY_CLIENT" --no-defaults --socket="$MDB_SOCK" --user=root <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED BY '$root_pw';
DROP USER IF EXISTS 'root'@'127.0.0.1', 'root'@'::1';
SQL
  printf '[client]\nuser=root\npassword=%s\n' "$root_pw" >"$MDB_ROOT_CNF"
}

load_legacy() {
  mdb_root -e "CREATE DATABASE IF NOT EXISTS \`$LEGACY_SCHEMA\` CHARACTER SET utf8mb4"
  case "$LEGACY_LOAD_FILE" in
    *.gz) gzip -dc "$LEGACY_LOAD_FILE" | mdb_root "$LEGACY_SCHEMA" ;;
    *) mdb_root "$LEGACY_SCHEMA" <"$LEGACY_LOAD_FILE" ;;
  esac
  local tables
  tables="$(mdb_root -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$LEGACY_SCHEMA' AND table_name IN ('user', 'invoice')")"
  [ "$tables" = "2" ] ||
    die "the dump did not create \`user\` and \`invoice\` in schema '$LEGACY_SCHEMA'. If it carries its own USE statement, pass --legacy-schema <that name>."
  # The SELECT-only account P7 reads through: the same wall sql-evidence.md requires.
  LEGACY_RO_PW="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  mdb_root <<SQL
CREATE USER 'legacy_ro'@'127.0.0.1' IDENTIFIED BY '$LEGACY_RO_PW';
CREATE USER 'legacy_ro'@'localhost' IDENTIFIED BY '$LEGACY_RO_PW';
GRANT SELECT ON \`$LEGACY_SCHEMA\`.* TO 'legacy_ro'@'127.0.0.1';
GRANT SELECT ON \`$LEGACY_SCHEMA\`.* TO 'legacy_ro'@'localhost';
SQL
  printf '%s' "$LEGACY_RO_PW" >"$MDB_RUN/legacy_ro.pw"
  printf '[client]\nuser=legacy_ro\npassword=%s\n' "$LEGACY_RO_PW" >"$MDB_RUN/legacy_ro.cnf"
}

legacy_aggregates() {
  "$LEGACY_CLIENT" --defaults-extra-file="$MDB_RUN/legacy_ro.cnf" --socket="$MDB_SOCK" \
    --database="$LEGACY_SCHEMA" --batch --skip-column-names --safe-updates \
    <"$SOURCE_SQL" >"$OUT/snapshots/legacy-source.tsv"
}

# The exact wallet closure: Σ legacy Balance over the users NEXA recorded as IMPORTED.
# Their keys move from the NEXA map into a SEPARATE scratch schema of the throwaway
# instance through a pipe — never a file, never stdout — and the legacy schema itself is
# only read.
imported_balance() {
  local cycle="$1"
  mdb_root -e "DROP DATABASE IF EXISTS nexa_reconcile; CREATE DATABASE nexa_reconcile;
               CREATE TABLE nexa_reconcile.imported (legacy_id VARCHAR(20) PRIMARY KEY);
               CREATE TABLE nexa_reconcile.customer_missing (legacy_id VARCHAR(64) PRIMARY KEY)"
  pg_nexa -c "SELECT m.legacy_id FROM legacy_import_map m JOIN tenants t ON t.id = m.tenant_id
              WHERE t.slug = '$TENANT' AND m.legacy_table = 'user' AND m.status = 'IMPORTED'" |
    # "0" is a sentinel that keeps the statement valid when nothing was imported; it can
    # never match, because a legacy user id is ^[1-9][0-9]*$.
    awk 'BEGIN { print "INSERT INTO nexa_reconcile.imported VALUES (\"0\")" } NF { printf ",(\"%s\")", $1 } END { print ";" }' |
    mdb_root
  # S4: the live invoices NEXA recorded as CUSTOMER_MISSING review. An invoice key is the
  # map's evidenced shape (hex, digits), checked again here before it reaches SQL.
  pg_nexa -c "SELECT m.legacy_id FROM legacy_import_map m JOIN tenants t ON t.id = m.tenant_id
              WHERE t.slug = '$TENANT' AND m.legacy_table = 'invoice' AND m.status = 'MANUAL_REVIEW'
                AND m.reason_code = 'CUSTOMER_MISSING'" |
    awk 'BEGIN { print "INSERT INTO nexa_reconcile.customer_missing VALUES (\"-\")" } $1 ~ /^[0-9a-f]+$/ { printf ",(\"%s\")", $1 } END { print ";" }' |
    mdb_root
  mdb_root -N -B -e "
    -- Mirza PR4 (owner decision 6): only POSITIVE balances become ledger openings; a
    -- negative one is a legacy debt of its magnitude, beside the ledger.
    SELECT 'imported_balance_sum', CAST(COALESCE(SUM(CAST(u.Balance AS DECIMAL(24,4))), 0) AS CHAR)
      FROM \`$LEGACY_SCHEMA\`.user u JOIN nexa_reconcile.imported i ON i.legacy_id = CAST(u.id AS CHAR)
     WHERE CAST(u.Balance AS DECIMAL(24,4)) > 0
    UNION ALL
    SELECT 'imported_nonzero_users', CAST(COUNT(*) AS CHAR)
      FROM \`$LEGACY_SCHEMA\`.user u JOIN nexa_reconcile.imported i ON i.legacy_id = CAST(u.id AS CHAR)
     WHERE CAST(u.Balance AS DECIMAL(24,4)) > 0
    UNION ALL
    SELECT 'imported_negative_users', CAST(COUNT(*) AS CHAR)
      FROM \`$LEGACY_SCHEMA\`.user u JOIN nexa_reconcile.imported i ON i.legacy_id = CAST(u.id AS CHAR)
     WHERE CAST(u.Balance AS DECIMAL(24,4)) < 0
    UNION ALL
    SELECT 'imported_negative_magnitude', CAST(COALESCE(-SUM(CAST(u.Balance AS DECIMAL(24,4))), 0) AS CHAR)
      FROM \`$LEGACY_SCHEMA\`.user u JOIN nexa_reconcile.imported i ON i.legacy_id = CAST(u.id AS CHAR)
     WHERE CAST(u.Balance AS DECIMAL(24,4)) < 0
    UNION ALL
    -- W8: a fractional Toman balance is never imported (IRT has no minor digits): it is held
    -- for review, never rounded.
    SELECT 'imported_fractional_users', CAST(COUNT(*) AS CHAR)
      FROM \`$LEGACY_SCHEMA\`.user u JOIN nexa_reconcile.imported i ON i.legacy_id = CAST(u.id AS CHAR)
     WHERE CAST(u.Balance AS DECIMAL(24,4)) <> FLOOR(CAST(u.Balance AS DECIMAL(24,4)))
    UNION ALL
    -- S4: every live REAL invoice with no owning user is in the CUSTOMER_MISSING review set.
    SELECT 'orphans_outside_customer_missing', CAST(COUNT(*) AS CHAR)
      FROM \`$LEGACY_SCHEMA\`.invoice i LEFT JOIN \`$LEGACY_SCHEMA\`.user u ON u.id = i.id_user
     WHERE i.Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume') AND i.is_test = 0
       AND u.id IS NULL
       AND NOT EXISTS (SELECT 1 FROM nexa_reconcile.customer_missing c
                        WHERE c.legacy_id = CAST(i.id_invoice AS CHAR))" >"$OUT/snapshots/c${cycle}-legacy-imported.tsv"
  mdb_root -e "DROP DATABASE nexa_reconcile"
}

# inspect_legacy — WP-D1a's inspector on the legacy input, BEFORE the engine sees it. A zip is
# decrypted into the private scratch directory (removed on exit, like the engine's data);
# the report — hashes and shapes, no row content — is kept as $OUT/archive.json. Runs in
# THIS shell (run_direct): it sets the file the load reads.
inspect_legacy() {
  local args=(--archive "$LEGACY_INPUT" --engine "$LEGACY_ENGINE" --require-class "$EVIDENCE_CLASS"
    --out "$MDB_RUN/inspect")
  [ -z "$LEGACY_ARCHIVE" ] || args+=(--extract)
  [ -z "$LEGACY_ARCHIVE_PASSWORD_ENV" ] || args+=(--password-env "$LEGACY_ARCHIVE_PASSWORD_ENV")
  local rc=0
  (
    # The password reaches the inspector through its environment, never through argv.
    if [ -n "$LEGACY_ARCHIVE_PASSWORD_ENV" ]; then export "${LEGACY_ARCHIVE_PASSWORD_ENV?}"; fi
    exec node "$ARCHIVE_INSPECT" "${args[@]}"
  ) >"$OUT/archive.json" || rc=$?
  case "$rc" in
    0) ;;
    2) die "the legacy input is BLOCKED by the archive inspector: $(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.blockers.map((b)=>b.code+": "+b.detail).join(" | "))' "$OUT/archive.json")" ;;
    *) die "the archive inspector failed (exit $rc); see $OUT/logs/c0-legacy-inspect.log" ;;
  esac
  if [ -n "$LEGACY_ARCHIVE" ]; then
    LEGACY_LOAD_FILE="$(json_get "$OUT/archive.json" extracted)"
    [ -f "$LEGACY_LOAD_FILE" ] || die "the archive inspector accepted the zip but extracted nothing."
  else
    LEGACY_LOAD_FILE="$LEGACY_INPUT"
  fi
  # A dump that selects its own database loads there, not into --legacy-schema.
  local selects
  selects="$(node -e 'console.log((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).dump.selectsDatabase||[]).join(","))' "$OUT/archive.json")"
  [ -z "$selects" ] || [ "$selects" = "$LEGACY_SCHEMA" ] ||
    die "the dump selects database '$selects' with USE; pass --legacy-schema $selects."
  json_get "$OUT/archive.json" archive.sha256 >"$OUT/snapshots/legacy-archive.sha256"
  json_get "$OUT/archive.json" dump.sha256 >"$OUT/snapshots/legacy-dump.sha256"
}

# --- NEXA: the isolated destination -------------------------------------------------------

prepare_nexa() {
  create_db "$NEXA_DB"
  if [ -n "$NEXA_ARCHIVE" ]; then
    # The real restore CLI: decrypts with the keyring in --nexa-env, refuses a non-empty
    # target. DATABASE_URL names the maintenance database, so the "live database" the CLI
    # protects is never the target.
    CLI_DATABASE_URL="$PG_URL/$PG_ADMIN_DB" with_nexa_env node "$BACKUP_CLI" restore \
      --archive "$NEXA_ARCHIVE" --target "$NEXA_DB"
    CLI_DATABASE_URL="$PG_URL/$NEXA_DB" with_nexa_env node "$MIGRATE_JS"
  else
    CLI_DATABASE_URL="$PG_URL/$NEXA_DB" with_nexa_env node "$MIGRATE_JS"
    CLI_DATABASE_URL="$PG_URL/$NEXA_DB" with_nexa_env node "$PROVISION_CLI" --slug "$TENANT"
  fi
  local found
  found="$(pg_nexa -c "SELECT count(*) FROM tenants WHERE slug = '$TENANT'")"
  [ "$found" = "1" ] || die "tenant '$TENANT' does not exist in the prepared database."
}

importer() { # importer MODE [args...]
  local mode="$1"
  shift
  (
    # The password never reaches argv (P7 refuses one there): it travels in the variable
    # --source-password-env names, set for this one child only.
    NEXA_REHEARSAL_LEGACY_PASSWORD="$(cat "$MDB_RUN/legacy_ro.pw")"
    export NEXA_REHEARSAL_LEGACY_PASSWORD
    CLI_DATABASE_URL="$PG_URL/$NEXA_DB" with_nexa_env node "$LEGACY_IMPORT_CLI" "$mode" \
      --tenant "$TENANT" \
      --source "mysql://legacy_ro@127.0.0.1:$MARIADB_PORT/$LEGACY_SCHEMA" \
      --source-password-env "$P7_SOURCE_PASSWORD_ENV" \
      --target "$NEXA_DB" \
      --panel-map "$PANEL_MAP" \
      --evidence-class "$EVIDENCE_CLASS" \
      "${IMPORTER_ARGS[@]+"${IMPORTER_ARGS[@]}"}" "$@"
  )
}

# revenue_snapshot LABEL — R3: PAID orders by origin, exactly as the revenue reports group
# them (reconciliation.md §2): origin, orders, total minor units.
revenue_snapshot() {
  pg_nexa -F "$(printf '\t')" -c "SELECT o.origin, count(*), COALESCE(SUM(o.total_amount), 0)
      FROM orders o JOIN tenants t ON t.id = o.tenant_id
     WHERE t.slug = '$TENANT' AND o.state = 'PAID' GROUP BY o.origin ORDER BY o.origin" \
    >"$OUT/snapshots/$1.tsv"
}

revenue_view() { # ORIGIN FILE — "orders/total" for that origin, "0/0" when it has none
  awk -F '\t' -v o="$1" '$1 == o { n = $2; s = $3 } END { printf "%d/%s\n", n, (s == "" ? 0 : s) }' "$2"
}

# R3: the wallet by report group over the import window — from the APPLY run's start (the
# interrupted import's, which the resume continued) to now. Openings only.
wallet_window_groups() {
  pg_nexa -c "SELECT COALESCE(string_agg(g, ',' ORDER BY g), 'none') FROM (
      SELECT DISTINCT CASE WHEN w.reason = 'MIGRATION_OPENING_BALANCE' THEN 'OPENING_BALANCE'
                           WHEN w.reason LIKE 'TOPUP_%' THEN 'TOPUP' ELSE 'OTHER' END AS g
        FROM wallet_entries w JOIN tenants t ON t.id = w.tenant_id
       WHERE t.slug = '$TENANT'
         AND w.created_at >= (SELECT r.started_at FROM legacy_import_runs r
                               WHERE r.tenant_id = t.id AND r.mode = 'APPLY')) groups"
}

wallet_window_expected() { # OPENING_BALANCE when the import posted any opening, else none
  if [ "$(delta opening_entries_total)" = "0" ]; then printf 'none\n'; else printf 'OPENING_BALANCE\n'; fi
}

# panel_state LABEL — P4: every production panel of the map, walked through the importer's
# own read-only inventory port; aggregates and keyed digests only (no username, no link).
panel_state() {
  CLI_DATABASE_URL="$PG_URL/$NEXA_DB" with_nexa_env "$TSX_BIN" "$PANEL_STATE_HELPER" snapshot \
    --tenant "$TENANT" --panel-map "$PANEL_MAP" --key-file "$MDB_RUN/panel-state.key" \
    --out "$OUT/snapshots/$1.json"
}

panel_state_compare() { # PRE POST — "unchanged", or what changed (counts only)
  "$TSX_BIN" "$PANEL_STATE_HELPER" compare "$1" "$2" 2>&1 || printf 'compare-failed\n'
}

# --- Synthetic only: the fake RickPanels the fixture assumes ------------------------------

PANELS_PID=""
start_synthetic_panels() {
  PANEL_MAP="$OUT/panel-map.json"
  set -m
  CLI_DATABASE_URL="$PG_URL/$NEXA_DB" with_nexa_env "$TSX_BIN" \
    "$SYNTHETIC_PANELS_HELPER" --tenant "$TENANT" --mapping-out "$PANEL_MAP" \
    --ready-file "$OUT/synthetic-panels.ready" --requests-out "$OUT/synthetic-panel-requests.json" \
    --stop-file "$OUT/synthetic-panels.stop" \
    >"$OUT/logs/c0-synthetic-panels-helper.log" 2>&1 &
  PANELS_PID=$!
  set +m
  local i
  for i in $(seq 1 120); do
    [ ! -f "$OUT/synthetic-panels.ready" ] || return 0
    kill -0 "$PANELS_PID" 2>/dev/null || die "the synthetic panels helper exited; see logs/c0-synthetic-panels-helper.log"
    sleep 0.5
  done
  die "the synthetic panels helper was not ready within 60s."
}

stop_synthetic_panels() {
  [ -n "$PANELS_PID" ] || return 0
  : >"$OUT/synthetic-panels.stop"
  local i
  for i in $(seq 1 60); do
    [ ! -s "$OUT/synthetic-panel-requests.json" ] || break
    sleep 0.5
  done
  kill -TERM "$PANELS_PID" 2>/dev/null || true
  wait "$PANELS_PID" 2>/dev/null || true
  PANELS_PID=""
  [ -s "$OUT/synthetic-panel-requests.json" ] ||
    printf '{"synthetic":true,"total":"absent","reads":"absent","writes":"absent"}\n' >"$OUT/synthetic-panel-requests.json"
}

running_rows_seen() {
  pg_nexa -c "SELECT COALESCE(max(r.rows_seen), -1) FROM legacy_import_runs r JOIN tenants t ON t.id = r.tenant_id
              WHERE t.slug = '$TENANT' AND r.mode = 'APPLY' AND r.status = 'RUNNING'"
}

# The interrupt: start `import`, kill -9 it once its run has checkpointed enough rows,
# and require that it was really interrupted (the run is left RUNNING).
interrupted_import() {
  local cycle="$1" log_file t0 seen pid
  log_file="$OUT/logs/c${cycle}-import-interrupted.log"
  t0=$SECONDS
  # Its OWN process group (job control on for this one launch), so the kill reaches the
  # node process: `importer` is a chain of subshells, and a kill -9 of the first one alone
  # leaves node running to completion — an "interrupt" that interrupted nothing.
  set -m
  importer import "${FP_ARGS[@]+"${FP_ARGS[@]}"}" >"$log_file" 2>&1 &
  pid=$!
  STAGE_PGID=$pid
  set +m
  while kill -0 "$pid" 2>/dev/null; do
    seen="$(running_rows_seen 2>/dev/null || printf -- '-1')"
    if [ "$seen" -ge "$KILL_AFTER_ROWS" ]; then
      kill -9 -- "-$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      STAGE_PGID=""
      record_duration "$cycle" import-interrupted "$((SECONDS - t0))" killed -
      log "cycle $cycle: import killed after its run saw $seen rows"
      # Prove it is dead: the run's progress must not move afterwards.
      local before after progress_sql
      progress_sql="SELECT COALESCE(r.rows_seen::text, 'NULL') || '/' || COALESCE(r.last_progress_at::text, 'NULL')
                      FROM legacy_import_runs r JOIN tenants t ON t.id = r.tenant_id
                     WHERE t.slug = '$TENANT' AND r.mode = 'APPLY'"
      before="$(pg_nexa -c "$progress_sql" || true)"
      sleep 3
      after="$(pg_nexa -c "$progress_sql" || true)"
      check "$cycle" interrupted_import_stopped_writing stopped "$(progress_stopped "$before" "$after")"
      return 0
    fi
    sleep 0.05
  done
  local rc=0
  wait "$pid" 2>/dev/null || rc=$?
  STAGE_PGID=""
  die "cycle $cycle: the import exited (code $rc) before its run reached $KILL_AFTER_ROWS rows, so the interrupt was NOT exercised; see $log_file. If it simply finished, lower --kill-after-rows or give P7 a smaller batch size with --importer-arg."
}

report_json() {
  local rc=0
  importer report --format json >"$OUT/c$1-report.json" || rc=$?
  # 3 is "an equation failed" — the per-equation checks below record which; the document
  # itself must still be there and valid.
  [ "$rc" -eq 0 ] || [ "$rc" -eq "$P7_EXIT_NEEDS_DECISION" ] || exit "$rc"
  report_schema_verdict "$REPORT_SCHEMA" "$OUT/c$1-report.json" "$OUT/c$1-report.schema-violations.txt" \
    >"$OUT/c$1-report.schema-verdict.txt"
}

# classify_apply_verdict VERDICT — pass | pending | fail. Only COMPLETED passes: the
# P6-less COMPLETED_ADOPTION_PENDING_P6 waits on a person; COMPLETED_WITH_FAILURES, an
# absent verdict and anything this harness does not know are failures.
classify_apply_verdict() {
  case "$1" in
    COMPLETED) printf 'pass\n' ;;
    COMPLETED_ADOPTION_PENDING_P6) printf 'pending\n' ;;
    *) printf 'fail\n' ;;
  esac
}

# progress_stopped BEFORE AFTER — two "rows_seen/last_progress_at" readings of the killed
# run. Stopped only when both EXIST and agree: a NULL or absent reading proves nothing, and
# two empty strings are equal, which is how the first version of this check passed on a
# run that recorded no progress at all.
progress_stopped() {
  case "$1$2" in
    *NULL*)
      printf 'no-progress-recorded\n'
      return 0
      ;;
  esac
  if [ -z "$1" ] || [ -z "$2" ]; then
    printf 'no-progress-recorded\n'
  elif [ "$1" = "$2" ]; then
    printf 'stopped\n'
  else
    printf 'still-writing\n'
  fi
}

# report_schema_verdict SCHEMA REPORT OUTFILE — "valid" only when the checker EXITS 0 and
# prints nothing; its stdout AND stderr go to OUTFILE. A checker that crashed (an
# unsupported schema keyword, a report that is not JSON) used to leave an empty file,
# which read as "no violations".
report_schema_verdict() {
  local rc=0
  node "$REPORT_CHECK" validate "$1" "$2" >"$3" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ] && [ ! -s "$3" ]; then
    printf 'valid\n'
  else
    printf 'invalid (exit %s)\n' "$rc"
  fi
}

report_get() { node "$REPORT_CHECK" get "$OUT/c$1-report.json" "$2"; }

# How many files under --out (the pg_dump archives aside: they ARE the database) contain
# any adopted service's subscription link. The links travel from psql to grep as patterns
# on a pipe and are never printed.
links_in_artifacts() {
  pg_nexa -c "SELECT s.subscription_url FROM services s JOIN orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id
               JOIN tenants t ON t.id = s.tenant_id
              WHERE t.slug = '$TENANT' AND o.origin = 'LEGACY_ADOPTION' AND s.subscription_url IS NOT NULL" |
    { grep -rlF --exclude='*.pgcustom' -f - "$OUT" 2>/dev/null || true; } | wc -l | tr -d ' '
}

# table_hashes DATABASE LABEL — the EXACT per-table fingerprint (WP-D8): rows and a hash
# of every row of every table, read-only. What "restored = PRE" and "the displaced database
# is the post-import state" are compared on; the aggregate snapshot compares only figures.
table_hashes() {
  assert_rehearsal_db "$1"
  psql -X -q -At -F "$(printf '\t')" -v ON_ERROR_STOP=1 "$PG_URL/$1" -f "$TABLE_HASHES_SQL" \
    >"$OUT/snapshots/$2.tsv"
}

# same_tables A B — "identical", or how many tables differ and the first few names.
same_tables() {
  if [ ! -s "$1" ] || [ ! -s "$2" ]; then
    printf 'missing\n'
  elif cmp -s "$1" "$2"; then
    printf 'identical\n'
  else
    printf 'differ: %s\n' "$(diff <(cut -f1-3 "$1") <(cut -f1-3 "$2") | awk '/^[<>]/ { print $2 }' | sort -u |
      awk 'NR <= 5 { printf "%s%s", (NR > 1 ? "," : ""), $0 } END { if (NR > 5) printf ",+%d more", NR - 5 }')"
  fi
}

pg_dump_snapshot() {
  pg_dump -Fc --no-owner -d "$PG_URL/$NEXA_DB" -f "$OUT/snapshots/c$1-pre-import.pgcustom"
  sha256sum "$OUT/snapshots/c$1-pre-import.pgcustom" | cut -d' ' -f1 >"$OUT/snapshots/c$1-pre-import.sha256"
}

# The rollback rehearsal: ADR-0028's mechanism on the harness's own databases — a
# candidate restored from the pre-import snapshot and validated, then two renames, and
# the displaced database KEPT. (The Web Admin recovery lane itself is rehearsed by hand on
# staging: docs/legacy-migration/rollback-runbook.md.)
rollback_rehearsal() {
  local cycle="$1" cand="${NEXA_DB}_cand_c$1" displaced="${NEXA_DB}_pre_restore_c$1"
  create_db "$cand"
  pg_restore --no-owner --exit-on-error -d "$PG_URL/$cand" "$OUT/snapshots/c${cycle}-pre-import.pgcustom"
  # Validate the candidate BEFORE production (here: the rehearsal database) changes.
  psql -X -q -At -v ON_ERROR_STOP=1 "$PG_URL/$cand" -F "$(printf '\t')" -v tenant="$TENANT" \
    -f "$CHECKS_SQL" >"$OUT/snapshots/c${cycle}-candidate.tsv"
  cmp -s "$OUT/snapshots/c${cycle}-candidate.tsv" "$OUT/snapshots/c${cycle}-pre-import.tsv" ||
    die "cycle $cycle: the candidate does not match the pre-import snapshot; NOT cutting over (diff the two .tsv files)."
  rename_db "$NEXA_DB" "$displaced"
  rename_db "$cand" "$NEXA_DB"
  # The candidate's name is gone (it IS the rehearsal database now); the displaced one is new.
  grep -vxF "$cand" "$CREATED_DBS_FILE" >"$CREATED_DBS_FILE.tmp" || true
  mv "$CREATED_DBS_FILE.tmp" "$CREATED_DBS_FILE"
  printf '%s (displaced: the post-import state, kept as ADR-0028 keeps it)\n' "$displaced" >>"$CREATED_DBS_FILE"
}

# --- The rehearsal ------------------------------------------------------------------------

log "evidence class: $EVIDENCE_CLASS"
[ "$EVIDENCE_CLASS" = "staging" ] || log "SYNTHETIC RUN — proves code and harness only; NEVER legacy evidence."

run_direct 0 legacy-inspect inspect_legacy
run_direct 0 legacy-start start_legacy
run_stage 0 legacy-load load_legacy
run_stage 0 legacy-aggregates legacy_aggregates
run_stage 0 nexa-prepare prepare_nexa
if [ "$SYNTHETIC_PANELS" -eq 1 ]; then
  run_direct 0 synthetic-panels start_synthetic_panels
  PANEL_MAP="$OUT/panel-map.json"
fi

LEGACY_SRC="$OUT/snapshots/legacy-source.tsv"
FINGERPRINT_FIRST=""

for cycle in $(seq 1 "$CYCLES"); do
  S="$OUT/snapshots/c${cycle}"
  run_stage "$cycle" snapshot-pre snapshot "c${cycle}-pre-import"
  run_stage "$cycle" pg-dump-pre pg_dump_snapshot "$cycle"
  run_stage "$cycle" tables-pre table_hashes "$NEXA_DB" "c${cycle}-tables-pre-import"
  run_stage "$cycle" panel-state-pre panel_state "c${cycle}-panel-state-pre"
  run_stage "$cycle" revenue-pre revenue_snapshot "c${cycle}-revenue-pre"

  run_p7 "$cycle" p7-audit audit --format json
  cp "$OUT/logs/c${cycle}-p7-audit.log" "$OUT/c${cycle}-audit.json"
  AUDIT_FP="$(json_get "$OUT/c${cycle}-audit.json" sections.source.fingerprint)"
  AUDIT_MAP_FP="$(json_get "$OUT/c${cycle}-audit.json" sections.panelMapping.fingerprint)"
  [[ "$AUDIT_FP" =~ ^[0-9a-f]{64}$ ]] && [[ "$AUDIT_MAP_FP" =~ ^[0-9a-f]{64}$ ]] ||
    die "cycle $cycle: the audit report carries no source or panel-map fingerprint; see $OUT/c${cycle}-audit.json"
  FP_ARGS=("$P7_EXPECTED_FP_FLAG" "$AUDIT_FP" "$P7_EXPECTED_MAP_FP_FLAG" "$AUDIT_MAP_FP")
  # G10 (WP-D2): every live real code_panel is mapped, a test panel, declared missing or
  # declared unresolved with a reason. The unmapped codes and counts are in the audit JSON.
  check "$cycle" panel_map_complete "true unmapped={}" \
    "$(json_get "$OUT/c${cycle}-audit.json" sections.panelMapping.completeness.complete) unmapped=$(json_get "$OUT/c${cycle}-audit.json" sections.panelMapping.completeness.unmapped)"
  run_p7 "$cycle" p7-dry-run dry-run --format json
  cp "$OUT/logs/c${cycle}-p7-dry-run.log" "$OUT/c${cycle}-dry-run.json"
  run_stage "$cycle" snapshot-after-dry-run snapshot "c${cycle}-after-dry-run"
  # Audit and dry-run decide and count; they write no business row. Only run metadata
  # (the dry run's own legacy_import_runs row) may differ.
  check "$cycle" dry_run_no_business_mutation \
    "$(snapshot_without "$S-pre-import.tsv" legacy_import_runs | sha256sum | cut -d' ' -f1)" \
    "$(snapshot_without "$S-after-dry-run.tsv" legacy_import_runs | sha256sum | cut -d' ' -f1)"

  interrupted_import "$cycle"
  run_stage "$cycle" snapshot-after-kill snapshot "c${cycle}-after-kill"
  check "$cycle" interrupted_run_left_running 1 "$(metric "$S-after-kill.tsv" legacy_import_runs_running)"

  run_p7 "$cycle" p7-resume resume --format json "${FP_ARGS[@]+"${FP_ARGS[@]}"}"
  cp "$OUT/logs/c${cycle}-p7-resume.log" "$OUT/c${cycle}-resume.json"
  # The APPLY run's verdict: COMPLETED passes; COMPLETED_WITH_FAILURES (money, a trial or a
  # service left undone — the report's `attention` counts say which) FAILS; the P6-less
  # verdict is PENDING; anything else fails.
  APPLY_VERDICT="$(json_get "$OUT/c${cycle}-resume.json" verdict)"
  case "$(classify_apply_verdict "$APPLY_VERDICT")" in
    pass) check "$cycle" apply_verdict COMPLETED "$APPLY_VERDICT" ;;
    pending) pending "$cycle" apply_verdict COMPLETED "$APPLY_VERDICT" ;;
    *) check "$cycle" apply_verdict COMPLETED "$APPLY_VERDICT attention=$(node "$REPORT_CHECK" get "$OUT/c${cycle}-resume.json" sections.attention)" ;;
  esac
  run_p7 "$cycle" p7-reconcile reconcile
  run_stage "$cycle" p7-report report_json "$cycle"
  run_stage "$cycle" snapshot-post snapshot "c${cycle}-post-import"
  run_stage "$cycle" tables-post table_hashes "$NEXA_DB" "c${cycle}-tables-post-import"
  run_stage "$cycle" revenue-post revenue_snapshot "c${cycle}-revenue-post"
  run_stage "$cycle" legacy-imported-balance imported_balance "$cycle"

  PRE="$S-pre-import.tsv"
  POST="$S-post-import.tsv"

  # Run lifecycle: one APPLY run, resumed rather than restarted, finished.
  check "$cycle" no_run_left_running 0 "$(metric "$POST" legacy_import_runs_running)"
  check "$cycle" one_apply_run_resumed 1 "$(pg_nexa -c "SELECT count(*) FROM legacy_import_runs r JOIN tenants t ON t.id = r.tenant_id WHERE t.slug = '$TENANT' AND r.mode = 'APPLY'")"
  check "$cycle" apply_run_completed 1 "$(pg_nexa -c "SELECT count(*) FROM legacy_import_runs r JOIN tenants t ON t.id = r.tenant_id WHERE t.slug = '$TENANT' AND r.mode = 'APPLY' AND r.status = 'COMPLETED'")"
  FINGERPRINT="$(pg_nexa -c "SELECT r.source_fingerprint FROM legacy_import_runs r JOIN tenants t ON t.id = r.tenant_id WHERE t.slug = '$TENANT' AND r.mode = 'APPLY'")"
  printf '%s\n' "$FINGERPRINT" >"$S-source-fingerprint.txt"
  [ -n "$FINGERPRINT_FIRST" ] || FINGERPRINT_FIRST="$FINGERPRINT"
  check "$cycle" source_fingerprint_stable "$FINGERPRINT_FIRST" "$FINGERPRINT"
  # What was imported is what the audit (the stand-in for the owner's approval) saw.
  check "$cycle" apply_fingerprint_equals_audit "$AUDIT_FP" "$FINGERPRINT"

  # Customers: every legacy user with a valid key has exactly one map decision. A user id
  # that is not a Telegram id can carry no map row at all (P7 counts it as `blocked`).
  check "$cycle" customer_closure "$(metric "$LEGACY_SRC" users_id_valid)" "$(metric_sum "$POST" 'map:user:')"
  INVALID_IDS=$(($(metric "$LEGACY_SRC" users_total) - $(metric "$LEGACY_SRC" users_id_valid)))
  check "$cycle" blocked_equals_invalid_ids "$INVALID_IDS" "$(report_get "$cycle" customers.blocked)"
  # Services: with P6 wired, every live invoice has exactly one map row EXCEPT those whose
  # key is outside the evidenced shape — the map's CHECK cannot hold them (OQ-P4-01), P7
  # counts them as INVOICE_KEY_INVALID, and only an owner can decide them (PENDING).
  CANDIDATES="$(metric "$LEGACY_SRC" live_invoices_total)"
  KEY_INVALID="$(metric "$LEGACY_SRC" live_invoices_key_unmappable)"
  check "$cycle" report_candidates_equal_source "$CANDIDATES" "$(report_get "$cycle" services.candidates)"
  check "$cycle" service_closure_map_plus_invalid_keys "$CANDIDATES" \
    "$(($(metric_sum "$POST" 'map:invoice:') + KEY_INVALID))"
  if [ "$KEY_INVALID" != "0" ]; then
    pending "$cycle" invoice_keys_outside_evidenced_shape 0 "$KEY_INVALID live invoice(s); owner decision (OQ-P4-01)"
  else
    check "$cycle" invoice_keys_outside_evidenced_shape 0 "$KEY_INVALID"
  fi
  ADOPTION_PENDING="$(report_get "$cycle" manualReview.byReason.ADOPTION_PENDING_P6)"
  if [ "$ADOPTION_PENDING" != "absent" ] && [ "$ADOPTION_PENDING" != "0" ]; then
    pending "$cycle" adoption_pending_p6 0 "$ADOPTION_PENDING eligible service(s) await P6 adoption"
  fi

  # P7's report: valid against the schema, the right evidence class, and its equations.
  check "$cycle" report_schema_valid valid "$(cat "$OUT/c$cycle-report.schema-verdict.txt")"
  check "$cycle" report_evidence_class "$EVIDENCE_CLASS" "$(report_get "$cycle" evidenceClass)"
  check "$cycle" report_provider_writes_zero 0 "$(report_get "$cycle" provider.writes)"
  check "$cycle" report_run_is_this_run "$(pg_nexa -c "SELECT r.id FROM legacy_import_runs r JOIN tenants t ON t.id = r.tenant_id WHERE t.slug = '$TENANT' AND r.mode = 'APPLY'")" "$(report_get "$cycle" run.runId)"
  check "$cycle" report_resumes_counted 1 "$(report_get "$cycle" run.resumes)"
  for eq in C1 C3 W1 W4 W5 S3 P3; do
    HOLDS="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const e=(r.reconciliation||[]).find((x)=>x.id===process.argv[2]);console.log(e===undefined?"absent":String(e.holds)+" "+e.expected+" / "+e.actual)' "$OUT/c$cycle-report.json" "$eq")"
    case "$HOLDS" in
      true*) check "$cycle" "report_equation_$eq" true true ;;
      # C3 false means user ids that are not Telegram ids: a population the owner must
      # rule on, not an importer failure (the synthetic fixture carries one on purpose).
      false*) if [ "$eq" = C3 ]; then pending "$cycle" "report_equation_$eq" true "$HOLDS"; else check "$cycle" "report_equation_$eq" true "$HOLDS"; fi ;;
      *) check "$cycle" "report_equation_$eq" true "$HOLDS" ;;
    esac
  done

  # C2: a customer is created only by an import decision.
  check "$cycle" customers_created_le_imported holds \
    "$(le_holds "$(delta customers_total)" "$(($(metric_sum "$POST" 'map:user:IMPORTED:') - $(metric_sum "$PRE" 'map:user:IMPORTED:')))")"
  # S4: an invoice with no owning user is CUSTOMER_MISSING review, exactly — never adopted.
  check "$cycle" orphans_in_customer_missing 0 "$(metric "$S-legacy-imported.tsv" orphans_outside_customer_missing)"
  # W8: IRT has no minor digits. A fractional legacy balance is never imported (rounded);
  # it is held for review, and the population itself is the owner's to decide. A NULL
  # balance must be explained by the owner too.
  check "$cycle" fractional_balances_never_imported 0 "$(metric "$S-legacy-imported.tsv" imported_fractional_users)"
  for w8 in balance_fractional_users balance_null_users; do
    W8_N="$(metric "$LEGACY_SRC" "$w8")"
    if [ "$W8_N" = "0" ]; then
      check "$cycle" "legacy_$w8" 0 "$W8_N"
    elif [[ "$W8_N" =~ ^[0-9]+$ ]]; then
      pending "$cycle" "legacy_$w8" 0 "$W8_N legacy user(s); held for review, owner decision (W8)"
    else
      check "$cycle" "legacy_$w8" 0 "$W8_N"
    fi
  done
  # The import gives no trial (reconciliation.md §5).
  check "$cycle" no_trial_grants 0 "$(delta trial_grants)"
  # R3, machine half: the revenue view the reports use (PAID orders by origin) and the
  # wallet by report group inside the import window. Sales untouched; adoption orders
  # total zero; the window's wallet movement is openings and nothing else. (The manual
  # half — the Web Admin financial report read by eye — is in manual-acceptance.)
  check "$cycle" revenue_view_standard_unchanged "$(revenue_view STANDARD "$S-revenue-pre.tsv")" "$(revenue_view STANDARD "$S-revenue-post.tsv")"
  check "$cycle" revenue_view_adoption_zero 0 "$(awk -F '\t' '$1 == "LEGACY_ADOPTION" { s += $3 } END { print s + 0 }' "$S-revenue-post.tsv")"
  check "$cycle" wallet_window_openings_only "$(wallet_window_expected)" "$(wallet_window_groups)"

  # Wallet: only openings moved the wallet; one per customer; derived from the right id.
  check "$cycle" wallet_moved_only_by_openings "$(delta opening_signed_total_minor)" "$(delta wallet_signed_total_minor)"
  check "$cycle" wallet_entries_only_openings "$(delta opening_entries_total)" "$(delta wallet_entries_total)"
  check "$cycle" no_duplicate_openings 0 "$(metric "$POST" opening_customers_with_duplicates)"
  check "$cycle" opening_reference_matches_customer 0 "$(metric "$POST" opening_reference_mismatch)"
  check "$cycle" opening_links_no_money 0 "$(metric "$POST" opening_linked_to_money)"
  # The equation: Σ openings = Σ POSITIVE legacy Balance over imported users (exact,
  # decimal-safe), and one opening per imported user with a positive balance. Mirza PR4
  # (owner decision 6): a negative balance is a legacy debt, never a ledger DEBIT — so no
  # DEBIT opening exists, and the debts equal the negative population exactly.
  IMPORTED_SUM="$(metric "$S-legacy-imported.tsv" imported_balance_sum)"
  check "$cycle" wallet_equation_imported_balance "$IMPORTED_SUM" "$(printf '%.4f' "$(delta opening_signed_total_minor)")"
  check "$cycle" openings_one_per_nonzero_user "$(metric "$S-legacy-imported.tsv" imported_nonzero_users)" "$(delta opening_entries_total)"
  check "$cycle" no_debit_openings 0 "$(metric "$POST" opening_debit_entries)"
  check "$cycle" legacy_debts_one_per_negative_user "$(metric "$S-legacy-imported.tsv" imported_negative_users)" "$(delta legacy_debts_total)"
  check "$cycle" legacy_debts_equal_negative_magnitude "$(metric "$S-legacy-imported.tsv" imported_negative_magnitude)" "$(printf '%.4f' "$(delta legacy_debts_sum_minor)")"

  # Not revenue, and no money moved.
  for k in sale_orders_paid sale_orders_paid_total_minor payments_total wallet_topup_signed_total_minor; do
    check "$cycle" "unchanged_$k" "$(metric "$PRE" "$k")" "$(metric "$POST" "$k")"
  done
  check "$cycle" adoption_orders_zero_total 0 "$(metric "$POST" adoption_orders_nonzero_total)"
  check "$cycle" one_service_per_adoption "$(delta adoption_orders)" "$(delta adopted_services)"
  # Every adoption order is NEW_SERVICE + LEGACY_ADOPTION, PAID, zero totals — the shape the
  # reports exclude from revenue by origin (and the unchanged_sale_* checks above prove it).
  check "$cycle" adoption_orders_shape 0 "$(pg_nexa -c "SELECT count(*) FROM orders o JOIN tenants t ON t.id = o.tenant_id
      WHERE t.slug = '$TENANT' AND o.origin = 'LEGACY_ADOPTION'
        AND NOT (o.purpose = 'NEW_SERVICE' AND o.state = 'PAID' AND o.total_amount = 0
                 AND o.subtotal_amount = 0 AND o.discount_amount = 0)")"

  # P6: every eligible candidate adopted. Eligible is P7's own dry-run decision; adopted is
  # P7's report AND the services that appeared in NEXA.
  ELIGIBLE="$(json_get "$OUT/c${cycle}-dry-run.json" sections.plan.services.categories.ADOPTION_ELIGIBLE)"
  check "$cycle" adopted_equals_eligible "$ELIGIBLE" "$(report_get "$cycle" services.adopted)"
  check "$cycle" adopted_services_appeared "$ELIGIBLE" "$(delta adopted_services)"

  # The reminder seed (Item 8) records thresholds already passed and SENDS NOTHING.
  printf 'service_reminders seeded: %s\n' "$(delta service_reminders)" >>"$OUT/logs/c${cycle}-reminder-seed.log"
  check "$cycle" reminder_seed_sent_no_messages 0 "$(delta customer_notifications)"

  # The subscription link: stored on every adopted service whose panel row carried one,
  # and in NO report, log or snapshot this rehearsal wrote, nor in any audit row, outbox
  # event or operational event. The links stay in the database and this shell's pipe.
  check "$cycle" adopted_services_link_stored 0 "$(metric "$POST" adopted_services_without_subscription_url)"
  check "$cycle" link_never_in_artifacts 0 "$(links_in_artifacts)"
  check "$cycle" link_never_in_audit_outbox_events 0 "$(pg_nexa -c "
    WITH links AS (
      SELECT s.subscription_url AS url FROM services s JOIN orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id
        JOIN tenants t ON t.id = s.tenant_id
       WHERE t.slug = '$TENANT' AND o.origin = 'LEGACY_ADOPTION' AND s.subscription_url IS NOT NULL)
    SELECT (SELECT count(*) FROM audit_logs a, links l WHERE strpos(concat(a.before::text, a.after::text, a.reason), l.url) > 0)
         + (SELECT count(*) FROM outbox_messages m, links l WHERE strpos(m.payload::text, l.url) > 0)
         + (SELECT count(*) FROM operational_events e, links l WHERE strpos(concat(e.message, e.context::text), l.url) > 0)")"

  # Provider writes = 0, and nothing was sent to a customer.
  check "$cycle" provider_writes_zero 0 "$(delta provisioning_operations_total)"
  # P4 (WP-D4): the panels themselves, walked read-only before and after — the staging
  # equivalent of wire_provider_writes_zero, which only a fake panel can count.
  run_stage "$cycle" panel-state-post panel_state "c${cycle}-panel-state-post"
  check "$cycle" panel_state_unchanged unchanged \
    "$(panel_state_compare "$S-panel-state-pre.json" "$S-panel-state-post.json")"
  check "$cycle" panel_state_walk_reads_only 0 \
    "$(json_get "$S-panel-state-post.json" requests.refusedWrites)"
  check "$cycle" adopted_services_without_operations 0 "$(metric "$POST" adopted_services_with_provisioning_operation)"
  check "$cycle" no_customer_messages 0 "$(delta customer_notifications)"

  # Rollback rehearsal, then the restored database must BE the pre-import database.
  run_stage "$cycle" rollback-restore rollback_rehearsal "$cycle"
  run_stage "$cycle" snapshot-after-rollback snapshot "c${cycle}-after-rollback"
  check "$cycle" rollback_restores_pre_import \
    "$(sha256sum <"$PRE" | cut -d' ' -f1)" "$(sha256sum <"$S-after-rollback.tsv" | cut -d' ' -f1)"
  # WP-D8: exactly, table by table and row by row — not only the aggregate figures.
  run_stage "$cycle" tables-after-rollback table_hashes "$NEXA_DB" "c${cycle}-tables-after-rollback"
  check "$cycle" rollback_restores_pre_import_exact identical \
    "$(same_tables "$S-tables-pre-import.tsv" "$S-tables-after-rollback.tsv")"
  # The displaced database is KEPT (ADR-0028), and it IS the post-import state: the
  # forensic copy of what the import did, and the way back if the rollback was wrong.
  DISPLACED="${NEXA_DB}_pre_restore_c${cycle}"
  check "$cycle" rollback_displaced_exists 1 \
    "$(pg_admin -c "SELECT count(*) FROM pg_database WHERE datname = '$DISPLACED'")"
  run_stage "$cycle" tables-displaced table_hashes "$DISPLACED" "c${cycle}-tables-displaced"
  check "$cycle" rollback_displaced_preserved identical \
    "$(same_tables "$S-tables-post-import.tsv" "$S-tables-displaced.tsv")"

  # Repeat from clean restore: cycle N must reproduce cycle 1 exactly.
  if [ "$cycle" -gt 1 ]; then
    check "$cycle" repeat_reproduces_cycle_1 \
      "$(sha256sum <"$OUT/snapshots/c1-post-import.tsv" | cut -d' ' -f1)" "$(sha256sum <"$POST" | cut -d' ' -f1)"
  fi
done

# --- Summary ------------------------------------------------------------------------------

if [ "$SYNTHETIC_PANELS" -eq 1 ]; then
  stop_synthetic_panels
  # What the fake panels RECEIVED after setup, over every cycle: an independent
  # "provider writes = 0", on the wire rather than in anybody's counter.
  check 0 wire_provider_writes_zero 0 "$(node "$REPORT_CHECK" get "$OUT/synthetic-panel-requests.json" writes)"
  check 0 wire_provider_reads_seen true "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).reads>0)' "$OUT/synthetic-panel-requests.json")"
fi

node -e '
  const fs = require("fs");
  const [out, cls, cycles, failed, pendingN, dumpSha, archiveSha, engine, inputFlag] = process.argv.slice(1);
  const archive = JSON.parse(fs.readFileSync(out + "/archive.json", "utf8"));
  const rows = (f) => fs.readFileSync(f, "utf8").trim().split("\n").slice(1).map((l) => l.split("\t"));
  const checks = rows(out + "/checks.tsv").map(([cycle, check, result, expected, actual]) => ({ cycle: +cycle, check, result, expected, actual }));
  const durations = rows(out + "/durations.tsv").map(([cycle, stage, seconds, exit, loadBefore, loadAfter]) => ({ cycle: +cycle, stage, seconds: +seconds, exit, loadBefore, loadAfter }));
  const summary = {
    evidenceClass: cls,
    notEvidence: cls === "synthetic",
    notice: cls === "synthetic"
      ? "SYNTHETIC fixture run: proves the importer code and this harness only. Never legacy evidence, never a Q1-Q7, C1 or C3 result, never a rehearsal on real data."
      : "Staging rehearsal on a real legacy dump and an isolated NEXA copy.",
    cycles: +cycles,
    legacyDumpSha256: dumpSha,
    legacyArchiveSha256: archiveSha,
    legacyEngine: engine,
    legacyInput: {
      flag: inputFlag,
      container: archive.archive.container,
      encryption: archive.zip === null ? null : archive.zip.encryption,
      format: archive.dump.format,
      serverVersion: archive.dump.serverVersion,
      collations: archive.dump.collations,
    },
    checksFailed: +failed,
    checksPending: +pendingN,
    verdict: +failed > 0 ? "FAILED" : +pendingN > 0 ? "DONE_PENDING_DECISIONS (not passed)" : "PASSED",
    // G11: every PENDING check, in the shape the readiness record accepts one by name.
    // The harness never decides: decision, decidedBy and decidedAt stay null until the
    // owner records them in docs/legacy-migration/readiness-record.md.
    pendingDecisions: checks
      .filter((c) => c.result === "PENDING")
      .map((c) => ({ cycle: c.cycle, check: c.check, expected: c.expected, actual: c.actual, decision: null, decidedBy: null, decidedAt: null })),
    checks,
    durations,
  };
  fs.writeFileSync(out + "/summary.json", JSON.stringify(summary, null, 2) + "\n");
 ' "$OUT" "$EVIDENCE_CLASS" "$CYCLES" "$FAILED_CHECKS" "$PENDING_CHECKS" "$(cat "$OUT/snapshots/legacy-dump.sha256")" \
  "$(cat "$OUT/snapshots/legacy-archive.sha256")" "$LEGACY_ENGINE" "$LEGACY_INPUT_FLAG"

# The reconciliation.md result table, generated from the checks rather than transcribed.
node "$RECONCILIATION" "$OUT/summary.json" >"$OUT/reconciliation.md" ||
  die "could not generate $OUT/reconciliation.md from summary.json"

if [ "$FAILED_CHECKS" -ne 0 ]; then
  die "$FAILED_CHECKS check(s) failed ($PENDING_CHECKS pending); see $OUT/checks.tsv. The rehearsal did NOT pass."
fi
[ "$EVIDENCE_CLASS" = "staging" ] || log "SYNTHETIC RUN — not legacy evidence."
if [ "$PENDING_CHECKS" -ne 0 ]; then
  log "no check failed, but $PENDING_CHECKS are PENDING a person's decision (see checks.tsv)."
  log "This is NOT a passed rehearsal: the import is done and waits on those decisions."
  exit 3
fi
log "all checks passed over $CYCLES cycle(s); results in $OUT"
