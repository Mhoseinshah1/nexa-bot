#!/usr/bin/env bash
# scripts/legacy-rehearsal.sh — the MirzaBot -> NEXA migration rehearsal harness (Item 11).
#
# One command that runs the whole migration against COPIES and times it:
#
#   1. an isolated NEXA database — restored from a NEXA backup archive through the real
#      `backup restore` CLI, or freshly migrated and provisioned;
#   2. a throwaway MariaDB this script starts itself, loaded from a legacy dump (on a
#      developer machine: the SYNTHETIC fixture under tests/fixtures/legacy/);
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
#   - reach the live MirzaBot database: the legacy side is ALWAYS a MariaDB this script
#     started on a scratch data directory, bound to 127.0.0.1. There is no flag that
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
CHECKS_SQL="$ROOT/scripts/legacy-rehearsal-checks.sql"
SOURCE_SQL="$ROOT/scripts/legacy-rehearsal-source.sql"
BACKUP_CLI="$ROOT/apps/api/dist/backup.cli.js"
MIGRATE_JS="$ROOT/apps/api/dist/infrastructure/persistence/migrate.js"
PROVISION_CLI="$ROOT/apps/api/dist/provision-installation.cli.js"

# --- The P7 CLI contract ------------------------------------------------------------------
#
# Written against the program's mode names (PROGRAM_4 §14) before the importer existed.
# Every assumption about its flags is HERE and nowhere else, overridable from the
# environment, so reconciling with `node apps/api/dist/legacy-import.cli.js --help` is an
# edit to this block (or an export), never a hunt through the script.
LEGACY_IMPORT_CLI="${LEGACY_IMPORT_CLI:-$ROOT/apps/api/dist/legacy-import.cli.js}"
P7_MODES=(audit dry-run import resume reconcile report)
P7_FLAG_TENANT="${P7_FLAG_TENANT:---tenant}"
P7_FLAG_SOURCE="${P7_FLAG_SOURCE:---source}"
P7_FLAG_TARGET="${P7_FLAG_TARGET:---target}"
P7_FLAG_PANEL_MAP="${P7_FLAG_PANEL_MAP:---panel-map}"
# What makes `report` print the machine-readable report on stdout.
read -r -a P7_REPORT_ARGS <<<"${P7_REPORT_ARGS:---format json}"

# --- Output helpers -----------------------------------------------------------------------

log() { printf '[rehearsal %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() {
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
  --legacy-dump PATH     MySQL/MariaDB dump (.sql or .sql.gz) of the MirzaBot schema
  --tenant SLUG          the NEXA tenant to import into
  --panel-map PATH       the explicit legacy code_panel -> NEXA panel map P7 reads
  --nexa-env FILE        shell-sourceable KEY=VALUE config for the NEXA CLIs
                         (SECRETS_KEYS, REDIS_URL, ...). DATABASE_URL in it is IGNORED:
                         the harness always points the CLIs at its own database.
  --pg-url URL           postgres://USER:PASS@HOST:PORT — a server, no database path
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
  --legacy-schema NAME   schema the dump loads into (default oldbot)
  --mariadb-port N       port of the throwaway MariaDB (default 33099)
  --pg-admin-db NAME     maintenance database for CREATE/RENAME (default postgres)
  --importer-arg ARG     extra argument for every P7 call (repeatable)
  --keep-legacy-copy     keep the throwaway MariaDB data directory afterwards
  --check-only           run every guard, print the plan, touch nothing
USAGE
}

# --- Arguments ----------------------------------------------------------------------------

EVIDENCE_CLASS=""
LEGACY_DUMP=""
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

need_value() {
  [ "$#" -ge 2 ] && [ -n "$2" ] && [ "${2#--}" = "$2" ] || die "$1 needs a value."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --evidence-class) need_value "$@"; EVIDENCE_CLASS="$2"; shift 2 ;;
    --legacy-dump) need_value "$@"; LEGACY_DUMP="$2"; shift 2 ;;
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

[ -n "$LEGACY_DUMP" ] || die "--legacy-dump is required."
[ -f "$LEGACY_DUMP" ] && [ -r "$LEGACY_DUMP" ] || die "--legacy-dump $LEGACY_DUMP is not a readable file."
LEGACY_DUMP="$(cd "$(dirname "$LEGACY_DUMP")" && pwd)/$(basename "$LEGACY_DUMP")"
case "$LEGACY_DUMP" in
  */tests/fixtures/*)
    [ "$EVIDENCE_CLASS" = "synthetic" ] ||
      die "the dump is under tests/fixtures/ — that is SYNTHETIC data, and a run on it is never staging evidence. Use --evidence-class synthetic."
    ;;
esac

[[ "$TENANT" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "--tenant must be a tenant slug ([a-z0-9-], got '$TENANT')."
[ -n "$PANEL_MAP" ] && [ -f "$PANEL_MAP" ] && [ -r "$PANEL_MAP" ] ||
  die "--panel-map must be a readable file: the code_panel -> panel map is explicit, never inferred."
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
  die "--pg-url must be postgres://USER:PASS@HOST[:PORT] with no database path."
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
  legacy dump      $LEGACY_DUMP (loaded into a throwaway MariaDB on 127.0.0.1:$MARIADB_PORT)
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
for mode in "${P7_MODES[@]}"; do
  grep -qw -- "$mode" <<<"$P7_HELP" ||
    die "the P7 CLI's --help does not mention mode '$mode'. Reconcile the CLI contract block at the top of this script with its --help."
done

for tool in node psql pg_dump pg_restore mariadbd mariadb mariadb-install-db mariadb-admin sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool '$tool' is not on PATH."
done
[ -f "$CHECKS_SQL" ] && [ -f "$SOURCE_SQL" ] || die "the reconciliation SQL files are missing from scripts/."
[ -f "$BACKUP_CLI" ] && [ -f "$MIGRATE_JS" ] && [ -f "$PROVISION_CLI" ] ||
  die "apps/api/dist is not built. Run: pnpm build"

# --- Workspace ----------------------------------------------------------------------------

mkdir -p "$OUT/logs" "$OUT/snapshots"
OUT="$(cd "$OUT" && pwd)"
printf 'cycle\tstage\tseconds\texit\tload_before\tload_after\n' >"$OUT/durations.tsv"
printf 'cycle\tcheck\tresult\texpected\tactual\n' >"$OUT/checks.tsv"
# A file, not an array: databases are created inside stages, which run in subshells.
CREATED_DBS_FILE="$OUT/databases-created.txt"
: >"$CREATED_DBS_FILE"

# A socket path is limited to ~108 bytes, so the MariaDB runtime lives under a short
# private temporary directory; the data directory lives under it too and is removed on
# exit unless --keep-legacy-copy (it is a copy of customer data).
MDB_RUN="$(mktemp -d "${TMPDIR:-/tmp}/nexa-rh.XXXXXX")"
MDB_DATA="$MDB_RUN/data"
MDB_SOCK="$MDB_RUN/mysqld.sock"
MDB_ROOT_CNF="$MDB_RUN/root.cnf"
MDB_PID=""

cleanup() {
  local rc=$?
  if [ -n "$MDB_PID" ] && kill -0 "$MDB_PID" 2>/dev/null; then
    mariadb-admin --defaults-extra-file="$MDB_ROOT_CNF" --socket="$MDB_SOCK" shutdown >/dev/null 2>&1 ||
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
  "$@" >"$log_file" 2>&1 &
  if wait "$!"; then rc=0; else rc=$?; fi
  record_duration "$cycle" "$name" "$((SECONDS - t0))" "$rc" "$load0"
  [ "$rc" -eq 0 ] || die "stage '$name' (cycle $cycle) failed with exit $rc; see $log_file"
}

FAILED_CHECKS=0
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

rename_db() {
  assert_rehearsal_db "$1"
  assert_rehearsal_db "$2"
  pg_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$1' AND pid <> pg_backend_pid()" >/dev/null
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
    exec "$@"
  )
}

# --- MariaDB: the throwaway legacy source -------------------------------------------------

mdb_root() { mariadb --defaults-extra-file="$MDB_ROOT_CNF" --socket="$MDB_SOCK" "$@"; }

start_legacy() {
  local me
  me="$(id -un)"
  mariadb-install-db --no-defaults --user="$me" --datadir="$MDB_DATA" \
    --auth-root-authentication-method=normal --skip-test-db >/dev/null
  mariadbd --no-defaults --user="$me" --datadir="$MDB_DATA" --socket="$MDB_SOCK" \
    --port="$MARIADB_PORT" --bind-address=127.0.0.1 --pid-file="$MDB_RUN/mysqld.pid" \
    --log-error="$OUT/logs/mariadb.err" &
  MDB_PID=$!
  local i
  for i in $(seq 1 60); do
    if mariadb-admin --no-defaults --socket="$MDB_SOCK" --user=root ping >/dev/null 2>&1; then
      break
    fi
    kill -0 "$MDB_PID" 2>/dev/null || die "the throwaway MariaDB exited; see $OUT/logs/mariadb.err"
    sleep 1
    [ "$i" -lt 60 ] || die "the throwaway MariaDB did not answer within 60s."
  done
  # Lock root to a random password kept in a 0600 file, and drop any TCP root account:
  # the instance is local and temporary, but it holds a copy of customer data.
  local root_pw
  root_pw="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  mariadb --no-defaults --socket="$MDB_SOCK" --user=root -e "
    ALTER USER 'root'@'localhost' IDENTIFIED BY '$root_pw';
    DROP USER IF EXISTS 'root'@'127.0.0.1', 'root'@'::1';"
  printf '[client]\nuser=root\npassword=%s\n' "$root_pw" >"$MDB_ROOT_CNF"
}

load_legacy() {
  mdb_root -e "CREATE DATABASE IF NOT EXISTS \`$LEGACY_SCHEMA\` CHARACTER SET utf8mb4"
  case "$LEGACY_DUMP" in
    *.gz) gzip -dc "$LEGACY_DUMP" | mdb_root "$LEGACY_SCHEMA" ;;
    *) mdb_root "$LEGACY_SCHEMA" <"$LEGACY_DUMP" ;;
  esac
  local tables
  tables="$(mdb_root -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$LEGACY_SCHEMA' AND table_name IN ('user', 'invoice')")"
  [ "$tables" = "2" ] ||
    die "the dump did not create \`user\` and \`invoice\` in schema '$LEGACY_SCHEMA'. If it carries its own USE statement, pass --legacy-schema <that name>."
  # The SELECT-only account P7 reads through: the same wall sql-evidence.md requires.
  LEGACY_RO_PW="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  mdb_root -e "
    CREATE USER 'legacy_ro'@'127.0.0.1' IDENTIFIED BY '$LEGACY_RO_PW';
    CREATE USER 'legacy_ro'@'localhost' IDENTIFIED BY '$LEGACY_RO_PW';
    GRANT SELECT ON \`$LEGACY_SCHEMA\`.* TO 'legacy_ro'@'127.0.0.1';
    GRANT SELECT ON \`$LEGACY_SCHEMA\`.* TO 'legacy_ro'@'localhost';"
  printf '%s' "$LEGACY_RO_PW" >"$MDB_RUN/legacy_ro.pw"
  printf '[client]\nuser=legacy_ro\npassword=%s\n' "$LEGACY_RO_PW" >"$MDB_RUN/legacy_ro.cnf"
}

legacy_aggregates() {
  mariadb --defaults-extra-file="$MDB_RUN/legacy_ro.cnf" --socket="$MDB_SOCK" \
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
               CREATE TABLE nexa_reconcile.imported (legacy_id VARCHAR(20) PRIMARY KEY)"
  pg_nexa -c "SELECT m.legacy_id FROM legacy_import_map m JOIN tenants t ON t.id = m.tenant_id
              WHERE t.slug = '$TENANT' AND m.legacy_table = 'user' AND m.status = 'IMPORTED'" |
    # "0" is a sentinel that keeps the statement valid when nothing was imported; it can
    # never match, because a legacy user id is ^[1-9][0-9]*$.
    awk 'BEGIN { print "INSERT INTO nexa_reconcile.imported VALUES (\"0\")" } NF { printf ",(\"%s\")", $1 } END { print ";" }' |
    mdb_root
  mdb_root -N -B -e "
    SELECT 'imported_balance_sum', CAST(COALESCE(SUM(CAST(u.Balance AS DECIMAL(24,4))), 0) AS CHAR)
      FROM \`$LEGACY_SCHEMA\`.user u JOIN nexa_reconcile.imported i ON i.legacy_id = CAST(u.id AS CHAR)
    UNION ALL
    SELECT 'imported_nonzero_users', CAST(COUNT(*) AS CHAR)
      FROM \`$LEGACY_SCHEMA\`.user u JOIN nexa_reconcile.imported i ON i.legacy_id = CAST(u.id AS CHAR)
     WHERE CAST(u.Balance AS DECIMAL(24,4)) <> 0" >"$OUT/snapshots/c${cycle}-legacy-imported.tsv"
  mdb_root -e "DROP DATABASE nexa_reconcile"
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
  CLI_DATABASE_URL="$PG_URL/$NEXA_DB" with_nexa_env node "$LEGACY_IMPORT_CLI" "$mode" \
    "$P7_FLAG_TENANT" "$TENANT" \
    "$P7_FLAG_SOURCE" "mysql://legacy_ro:$(cat "$MDB_RUN/legacy_ro.pw")@127.0.0.1:$MARIADB_PORT/$LEGACY_SCHEMA" \
    "$P7_FLAG_TARGET" "$NEXA_DB" \
    "$P7_FLAG_PANEL_MAP" "$PANEL_MAP" \
    "${IMPORTER_ARGS[@]+"${IMPORTER_ARGS[@]}"}" "$@"
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
  importer import >"$log_file" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    seen="$(running_rows_seen 2>/dev/null || printf -- '-1')"
    if [ "$seen" -ge "$KILL_AFTER_ROWS" ]; then
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      record_duration "$cycle" import-interrupted "$((SECONDS - t0))" killed -
      log "cycle $cycle: import killed after its run saw $seen rows"
      return 0
    fi
    sleep 0.2
  done
  wait "$pid" 2>/dev/null || true
  die "cycle $cycle: the import finished before its run reached $KILL_AFTER_ROWS rows, so the interrupt was NOT exercised. Lower --kill-after-rows, or give P7 a smaller batch size with --importer-arg."
}

report_json() {
  importer report "${P7_REPORT_ARGS[@]}" >"$OUT/c$1-report.json"
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const writes = r && r.provider && r.provider.writes;
    if (writes !== 0) {
      console.error("report.provider.writes must be 0 (docs/legacy-migration/final-report.schema.json); got " + JSON.stringify(writes));
      process.exit(1);
    }' "$OUT/c$1-report.json"
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

run_direct 0 legacy-start start_legacy
run_stage 0 legacy-load load_legacy
run_stage 0 legacy-aggregates legacy_aggregates
sha256sum "$LEGACY_DUMP" | cut -d' ' -f1 >"$OUT/snapshots/legacy-dump.sha256"
run_stage 0 nexa-prepare prepare_nexa

LEGACY_SRC="$OUT/snapshots/legacy-source.tsv"
FINGERPRINT_FIRST=""

for cycle in $(seq 1 "$CYCLES"); do
  S="$OUT/snapshots/c${cycle}"
  run_stage "$cycle" snapshot-pre snapshot "c${cycle}-pre-import"
  run_stage "$cycle" pg-dump-pre pg_dump_snapshot "$cycle"

  run_stage "$cycle" p7-audit importer audit
  run_stage "$cycle" p7-dry-run importer dry-run
  run_stage "$cycle" snapshot-after-dry-run snapshot "c${cycle}-after-dry-run"
  # Audit and dry-run decide and count; they write no business row. Only run metadata
  # (the dry run's own legacy_import_runs row) may differ.
  check "$cycle" dry_run_no_business_mutation \
    "$(snapshot_without "$S-pre-import.tsv" legacy_import_runs | sha256sum | cut -d' ' -f1)" \
    "$(snapshot_without "$S-after-dry-run.tsv" legacy_import_runs | sha256sum | cut -d' ' -f1)"

  interrupted_import "$cycle"
  run_stage "$cycle" snapshot-after-kill snapshot "c${cycle}-after-kill"
  check "$cycle" interrupted_run_left_running 1 "$(metric "$S-after-kill.tsv" legacy_import_runs_running)"

  run_stage "$cycle" p7-resume importer resume
  run_stage "$cycle" p7-reconcile importer reconcile
  run_stage "$cycle" p7-report report_json "$cycle"
  run_stage "$cycle" snapshot-post snapshot "c${cycle}-post-import"
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

  # Customers: every legacy user has exactly one decision.
  check "$cycle" customer_closure "$(metric "$LEGACY_SRC" users_total)" "$(metric_sum "$POST" 'map:user:')"
  # Services: every live legacy invoice has exactly one decision.
  check "$cycle" service_candidate_closure "$(metric "$LEGACY_SRC" live_invoices_total)" "$(metric_sum "$POST" 'map:invoice:')"

  # Wallet: only openings moved the wallet; one per customer; derived from the right id.
  check "$cycle" wallet_moved_only_by_openings "$(delta opening_signed_total_minor)" "$(delta wallet_signed_total_minor)"
  check "$cycle" wallet_entries_only_openings "$(delta opening_entries_total)" "$(delta wallet_entries_total)"
  check "$cycle" no_duplicate_openings 0 "$(metric "$POST" opening_customers_with_duplicates)"
  check "$cycle" opening_reference_matches_customer 0 "$(metric "$POST" opening_reference_mismatch)"
  check "$cycle" opening_links_no_money 0 "$(metric "$POST" opening_linked_to_money)"
  # The equation: Σ openings = Σ legacy Balance over imported users (exact, decimal-safe),
  # and one opening per imported user with a non-zero balance.
  IMPORTED_SUM="$(metric "$S-legacy-imported.tsv" imported_balance_sum)"
  check "$cycle" wallet_equation_imported_balance "$IMPORTED_SUM" "$(printf '%.4f' "$(delta opening_signed_total_minor)")"
  check "$cycle" openings_one_per_nonzero_user "$(metric "$S-legacy-imported.tsv" imported_nonzero_users)" "$(delta opening_entries_total)"

  # Not revenue, and no money moved.
  for k in sale_orders_paid sale_orders_paid_total_minor payments_total wallet_topup_signed_total_minor; do
    check "$cycle" "unchanged_$k" "$(metric "$PRE" "$k")" "$(metric "$POST" "$k")"
  done
  check "$cycle" adoption_orders_zero_total 0 "$(metric "$POST" adoption_orders_nonzero_total)"
  check "$cycle" one_service_per_adoption "$(delta adoption_orders)" "$(delta adopted_services)"

  # Provider writes = 0, and nothing was sent to a customer.
  check "$cycle" provider_writes_zero 0 "$(delta provisioning_operations_total)"
  check "$cycle" adopted_services_without_operations 0 "$(metric "$POST" adopted_services_with_provisioning_operation)"
  check "$cycle" no_customer_messages 0 "$(delta customer_notifications)"

  # Rollback rehearsal, then the restored database must BE the pre-import database.
  run_stage "$cycle" rollback-restore rollback_rehearsal "$cycle"
  run_stage "$cycle" snapshot-after-rollback snapshot "c${cycle}-after-rollback"
  check "$cycle" rollback_restores_pre_import \
    "$(sha256sum <"$PRE" | cut -d' ' -f1)" "$(sha256sum <"$S-after-rollback.tsv" | cut -d' ' -f1)"

  # Repeat from clean restore: cycle N must reproduce cycle 1 exactly.
  if [ "$cycle" -gt 1 ]; then
    check "$cycle" repeat_reproduces_cycle_1 \
      "$(sha256sum <"$OUT/snapshots/c1-post-import.tsv" | cut -d' ' -f1)" "$(sha256sum <"$POST" | cut -d' ' -f1)"
  fi
done

# --- Summary ------------------------------------------------------------------------------

node -e '
  const fs = require("fs");
  const [out, cls, cycles, failed, dumpSha] = process.argv.slice(1);
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
    checksFailed: +failed,
    checks,
    durations,
  };
  fs.writeFileSync(out + "/summary.json", JSON.stringify(summary, null, 2) + "\n");
' "$OUT" "$EVIDENCE_CLASS" "$CYCLES" "$FAILED_CHECKS" "$(cat "$OUT/snapshots/legacy-dump.sha256")"

if [ "$FAILED_CHECKS" -ne 0 ]; then
  die "$FAILED_CHECKS check(s) failed; see $OUT/checks.tsv. The rehearsal did NOT pass."
fi
log "all checks passed over $CYCLES cycle(s); results in $OUT"
[ "$EVIDENCE_CLASS" = "staging" ] || log "SYNTHETIC RUN — not legacy evidence."
