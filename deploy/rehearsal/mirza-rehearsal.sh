#!/usr/bin/env bash
# The ISOLATED Mirza → NEXA migration rehearsal: one NEXA, on its own Docker project, its
# own empty database, no route to the internet, no Telegram, no real panel.
#
#   docs/legacy-migration/nxpkg-real-rehearsal.md is the runbook; read it first.
#
# It never touches an installation: it refuses to run on a host that carries one
# (/etc/nexa, /opt/nexa, or a Docker Compose project named `nexa`), it never deletes a
# volume or a database (there is no `destroy`; `down` keeps every volume), and every
# secret it generates belongs to the rehearsal alone and is written 0600, never printed.
#
# Commands (every one takes --dir DIR, the rehearsal directory `init` creates):
#   init     [--image REF] [--https-port N] [--subnet-octet N]   write the configuration
#   build                      build the NEXA image from THIS checkout; record its id
#   up                         start, migrate, provision the tenant, run the preflight
#   owner    --telegram-id N   create the first owner (interactive password prompt)
#   preflight                  the isolation checks (exit 1 on any failure)
#   status                     containers, the admin URL, the stand-in address
#   standin-credentials        the stand-in's address, username and password (rehearsal only)
#   set-target-ack VALUE       NEXA_LEGACY_IMPORT_TARGET_ACK for the migration role
#   standin-check              the stand-in's request counts (exit 1 on any refused write)
#   verify                     independent counts from the database (verify-import.sql)
#   backup-run | backup-list   the standard NEXA backup CLI, inside the rehearsal
#   logs     SERVICE           the last 200 lines of one service
#   down                       stop and remove the containers; KEEPS every volume
set -euo pipefail
umask 077

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "${HERE}/.." && pwd)"
REPO_DIR="$(cd -- "${DEPLOY_DIR}/.." && pwd)"
PROJECT="nexa-mirza-rehearsal"
DB_NAME="nexa_mirza_rehearsal"
TENANT_SLUG="mirza-rehearsal"
STANDIN_USER="rehearsal-admin"
# Overridable for the unit test only (a fake docker, a fake installation layout).
DOCKER="${MIRZA_REHEARSAL_DOCKER:-docker}"
ETC_NEXA="${MIRZA_REHEARSAL_ETC_NEXA:-/etc/nexa}"
OPT_NEXA="${MIRZA_REHEARSAL_OPT_NEXA:-/opt/nexa}"

FAILED=0
die() {
  printf 'mirza-rehearsal: %s\n' "$*" >&2
  exit 1
}
step() { printf '\n==> %s\n' "$*"; }
ok() { printf 'ok    %s\n' "$*"; }
bad() {
  printf 'FAIL  %s\n' "$*"
  FAILED=$((FAILED + 1))
}

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------------------
COMMAND="${1:-}"
[ -n "$COMMAND" ] || {
  usage
  exit 64
}
shift
DIR=""
IMAGE=""
HTTPS_PORT="18443"
SUBNET_OCTET="240"
TELEGRAM_ID=""
POSITIONAL=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      DIR="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE="${2:-}"
      shift 2
      ;;
    --https-port)
      HTTPS_PORT="${2:-}"
      shift 2
      ;;
    --subnet-octet)
      SUBNET_OCTET="${2:-}"
      shift 2
      ;;
    --telegram-id)
      TELEGRAM_ID="${2:-}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --*) die "unknown option $1" ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done
[ -n "$DIR" ] || die "--dir DIR is required (the rehearsal directory)."
case "$DIR" in
  /*) ;;
  *) DIR="$(pwd)/${DIR}" ;;
esac

# ---------------------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------------------

# A host that carries a NEXA installation is never a rehearsal host: one wrong flag away
# from its database, its Docker project or its bot. There is no override.
refuse_installation_host() {
  if [ -e "$ETC_NEXA" ] || [ -e "$OPT_NEXA" ]; then
    die "this host carries a NEXA installation (${ETC_NEXA} or ${OPT_NEXA} exists). Production and staging must stay untouched: run the rehearsal on a separate machine."
  fi
  if [ -n "$("$DOCKER" ps -a -q --filter label=com.docker.compose.project=nexa 2>/dev/null || true)" ]; then
    die "this Docker host runs a Compose project named 'nexa' (an installation). Run the rehearsal on a separate machine."
  fi
}

env_value() { # FILE KEY → the value of KEY=… (last one wins), or nothing
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2-
}

require_initialised() {
  [ -f "${DIR}/deploy.env" ] || die "${DIR} is not an initialised rehearsal directory (run init first)."
}

require_image() {
  local image
  image="$(env_value "${DIR}/deploy.env" NEXA_IMAGE)"
  case "$image" in
    sha256:[0-9a-f]*) [ "${#image}" -eq 71 ] || die "NEXA_IMAGE is not a full image id." ;;
    *@sha256:*) ;;
    *) die "no NEXA image recorded: run build (or init --image REPO@sha256:…)." ;;
  esac
}

compose() {
  "$DOCKER" compose -p "$PROJECT" --env-file "${DIR}/deploy.env" \
    -f "${DEPLOY_DIR}/compose.yml" -f "${HERE}/compose.mirza-rehearsal.yml" "$@"
}

random_password() { head -c 24 /dev/urandom | base64 -w0 | tr -d '=+/' | cut -c1-32; }
random_base64() { head -c 32 /dev/urandom | base64 -w0; }

write_file() { # PATH, content on stdin; complete or not at all, 0600
  local path="$1"
  cat >"${path}.partial"
  chmod 0600 "${path}.partial"
  mv -f "${path}.partial" "$path"
}

# ---------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------

cmd_init() {
  refuse_installation_host
  if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    die "${DIR} exists and is not empty. A rehearsal directory is written once; choose a new one."
  fi
  case "$HTTPS_PORT" in
    '' | *[!0-9]*) die "--https-port must be a number." ;;
  esac
  [ "$HTTPS_PORT" -ge 1024 ] && [ "$HTTPS_PORT" -le 65535 ] || die "--https-port must be 1024–65535."
  case "$SUBNET_OCTET" in
    '' | *[!0-9]*) die "--subnet-octet must be a number." ;;
  esac
  [ "$SUBNET_OCTET" -le 252 ] || die "--subnet-octet must be 0–252."
  if [ -n "$IMAGE" ]; then
    case "$IMAGE" in
      *@sha256:* | sha256:*) ;;
      *) die "--image must be a digest (REPO@sha256:…) or an image id (sha256:…), never a tag." ;;
    esac
  fi

  local edge data front panel standin_ip
  edge="172.30.${SUBNET_OCTET}.0/24"
  data="172.30.$((SUBNET_OCTET + 1)).0/24"
  front="172.30.$((SUBNET_OCTET + 2)).0/24"
  panel="172.30.$((SUBNET_OCTET + 3)).0/24"
  standin_ip="172.30.$((SUBNET_OCTET + 3)).10"

  mkdir -p "$DIR"
  chmod 0700 "$DIR"

  local pg_password redis_password kek kek_id standin_password
  pg_password="$(random_password)"
  redis_password="$(random_password)"
  kek="$(random_base64)"
  kek_id="rehearsal-$(date -u +%Y%m%d)"
  standin_password="$(random_password)"

  write_file "${DIR}/postgres.env" <<EOF
POSTGRES_USER=nexa
POSTGRES_DB=${DB_NAME}
POSTGRES_PASSWORD=${pg_password}
EOF
  write_file "${DIR}/redis.env" <<EOF
REDIS_PASSWORD=${redis_password}
EOF
  # The template's tokens replaced from STDIN (never argv: `ps` shows argv to every user).
  printf '%s\0' \
    "__POSTGRES_PASSWORD__=${pg_password}" \
    "__REDIS_PASSWORD__=${redis_password}" \
    "__SECRETS_KEK__=${kek}" \
    "__SECRETS_ACTIVE_KEY_ID__=${kek_id}" \
    "__HTTPS_PORT__=${HTTPS_PORT}" \
    "__FRONT_SUBNET__=${front}" |
    python3 -c '
import sys
source, target = sys.argv[1], sys.argv[2]
pairs = [p for p in sys.stdin.buffer.read().decode("utf-8").split("\0") if p]
text = open(source, encoding="utf-8").read()
for pair in pairs:
    token, value = pair.split("=", 1)
    text = text.replace(token, value)
if "__" in "".join(l for l in text.splitlines() if not l.startswith("#")):
    sys.exit("an unsubstituted placeholder is left in the template")
with open(target, "w", encoding="utf-8") as handle:
    handle.write(text)
' "${HERE}/nexa.env.template" "${DIR}/nexa.env.partial"
  chmod 0600 "${DIR}/nexa.env.partial"
  mv -f "${DIR}/nexa.env.partial" "${DIR}/nexa.env"

  write_file "${DIR}/standin.env" <<EOF
RICKPANEL_STANDIN_USERNAME=${STANDIN_USER}
RICKPANEL_STANDIN_PASSWORD=${standin_password}
EOF
  write_file "${DIR}/migration.env" <<EOF
# NEXA_LEGACY_IMPORT_TARGET_ACK=<the 16-hex value the migration page shows>
# Written by: mirza-rehearsal.sh set-target-ack --dir ${DIR} VALUE
EOF
  write_file "${DIR}/deploy.env" <<EOF
NEXA_IMAGE=${IMAGE}
NEXA_CONFIG_DIR=${DIR}
NEXA_DEPLOY_DIR=${DEPLOY_DIR}
NEXA_EDGE_SUBNET=${edge}
NEXA_DATA_SUBNET=${data}
NEXA_REHEARSAL_FRONT_SUBNET=${front}
NEXA_REHEARSAL_PANEL_SUBNET=${panel}
NEXA_REHEARSAL_STANDIN_IP=${standin_ip}
NEXA_REHEARSAL_HTTPS_PORT=${HTTPS_PORT}
NEXA_DOMAIN=localhost
NEXA_ACME_EMAIL=rehearsal@localhost
EOF
  ok "rehearsal directory ${DIR} written (0700; every file 0600; no value printed)"
  printf '      admin URL (after up): https://localhost:%s\n' "$HTTPS_PORT"
  printf '      next: %s build --dir %s   (unless --image was given), then up\n' "$0" "$DIR"
}

cmd_build() {
  refuse_installation_host
  require_initialised
  local commit dirty id
  commit="$(git -C "$REPO_DIR" rev-parse HEAD)"
  dirty=""
  if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then dirty="-dirty"; fi
  step "building the NEXA image from ${REPO_DIR} at ${commit}${dirty}"
  "$DOCKER" build \
    --build-arg "BUILD_VERSION=rehearsal" \
    --build-arg "BUILD_COMMIT=${commit}${dirty}" \
    --build-arg "BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    -t "${PROJECT}:local" "$REPO_DIR"
  id="$("$DOCKER" image inspect --format '{{.Id}}' "${PROJECT}:local")"
  case "$id" in
    sha256:*) ;;
    *) die "could not read the built image's id." ;;
  esac
  python3 -c '
import sys
path, image = sys.argv[1], sys.argv[2]
lines = open(path, encoding="utf-8").read().splitlines()
lines = [f"NEXA_IMAGE={image}" if l.startswith("NEXA_IMAGE=") else l for l in lines]
open(path + ".partial", "w", encoding="utf-8").write("\n".join(lines) + "\n")
' "${DIR}/deploy.env" "$id"
  chmod 0600 "${DIR}/deploy.env.partial"
  mv -f "${DIR}/deploy.env.partial" "${DIR}/deploy.env"
  ok "image ${id} recorded (commit ${commit}${dirty})"
}

wait_healthy() { # SERVICE... ; up to 5 minutes
  local deadline=$((SECONDS + 300)) service health
  for service in "$@"; do
    while :; do
      health="$(compose ps --format '{{.Health}}' "$service" 2>/dev/null | head -n 1 || true)"
      [ "$health" = "healthy" ] && break
      [ "$SECONDS" -lt "$deadline" ] || die "${service} did not become healthy (last: ${health:-none}). See: $0 logs --dir ${DIR} ${service}"
      sleep 3
    done
    ok "${service} healthy"
  done
}

cmd_up() {
  refuse_installation_host
  require_initialised
  require_image
  step "starting PostgreSQL and Redis (the rehearsal's own, on an internal network)"
  compose up -d postgres redis
  wait_healthy postgres redis
  step "applying NEXA's migrations to the NEW database ${DB_NAME}"
  compose run --rm --no-deps --entrypoint node api dist/infrastructure/persistence/migrate.js
  step "provisioning the rehearsal tenant (${TENANT_SLUG}, IRT, Asia/Tehran)"
  compose run --rm --no-deps --entrypoint node api dist/provision-installation.cli.js \
    --slug "$TENANT_SLUG" --display-name "Mirza rehearsal" \
    --timezone "Asia/Tehran" --currency "IRT"
  step "starting the api, worker, migration role, RickPanel stand-in and the local edge"
  compose up -d
  wait_healthy api worker migration rickpanel-standin caddy
  cmd_preflight
}

cmd_owner() {
  refuse_installation_host
  require_initialised
  require_image
  case "$TELEGRAM_ID" in
    '' | *[!0-9]*) die "--telegram-id must be the owner's numeric Telegram id." ;;
  esac
  compose run --rm --no-deps --entrypoint node api dist/bootstrap-owner.cli.js \
    --telegram-id "$TELEGRAM_ID"
}

# Runs JavaScript inside one service; exits 0 when the internet is NOT reachable from it.
no_egress_from() {
  local service="$1"
  compose exec -T "$service" node -e "
fetch('https://api.telegram.org/', { signal: AbortSignal.timeout(5000) })
  .then(() => process.exit(1))
  .catch(() => process.exit(0));" >/dev/null 2>&1
}

psql_rehearsal() { # SQL → one value
  compose exec -T postgres psql -U nexa -d "$DB_NAME" -Atc "$1"
}

cmd_preflight() {
  require_initialised
  refuse_installation_host
  step "isolation preflight"
  FAILED=0
  local env="${DIR}/nexa.env" value running service network standin_ip
  for pair in TELEGRAM_WEBHOOK_ENABLED=false NOTIFICATION_DISPATCH_ENABLED=false \
    BACKUP_SCHEDULE_ENABLED=false PANEL_MONITOR_ENABLED=false PROVISIONER_ENABLED=false \
    RECOVERY_UPLOAD_ENABLED=false LEGACY_MIGRATION_ENABLED=true \
    BACKUP_TELEGRAM_BOT_TOKEN= BACKUP_TELEGRAM_CHAT_ID=; do
    value="$(env_value "$env" "${pair%%=*}")"
    if [ "$value" = "${pair#*=}" ]; then ok "nexa.env ${pair%%=*}=${value}"; else bad "nexa.env ${pair%%=*} is '${value}', expected '${pair#*=}'"; fi
  done
  case "$(env_value "$env" DATABASE_URL)" in
    *"@postgres:5432/${DB_NAME}") ok "the database is the rehearsal's own ${DB_NAME}" ;;
    *) bad "DATABASE_URL does not name the rehearsal's own database" ;;
  esac

  running="$(compose ps --services --status running 2>/dev/null || true)"
  for service in provisioner monitor assistant recovery; do
    if printf '%s\n' "$running" | grep -qx "$service"; then bad "${service} is running"; else ok "${service} is not running"; fi
  done
  for service in api worker migration rickpanel-standin; do
    if printf '%s\n' "$running" | grep -qx "$service"; then ok "${service} is running"; else bad "${service} is not running"; fi
  done

  for network in data front panelsim; do
    value="$("$DOCKER" network inspect -f '{{.Internal}}' "${PROJECT}_${network}" 2>/dev/null || true)"
    if [ "$value" = "true" ]; then ok "network ${network} is internal (no route out)"; else bad "network ${network} is not internal ('${value}')"; fi
  done
  for service in api worker migration; do
    if no_egress_from "$service"; then ok "${service} cannot reach the internet"; else bad "${service} CAN reach the internet"; fi
  done

  value="$(psql_rehearsal "SELECT count(*) FROM bot_instances" 2>/dev/null || echo '?')"
  if [ "$value" = "0" ]; then ok "no Telegram bot is configured"; else bad "bot_instances = ${value} (never connect a bot to a rehearsal)"; fi
  standin_ip="$(env_value "${DIR}/deploy.env" NEXA_REHEARSAL_STANDIN_IP)"
  value="$(psql_rehearsal "SELECT count(*) FROM panels WHERE status <> 'ARCHIVED' AND (provider_type <> 'rickpanel' OR base_url NOT LIKE 'http://${standin_ip}:8000%')" 2>/dev/null || echo '?')"
  if [ "$value" = "0" ]; then ok "every panel is the read-only stand-in (http://${standin_ip}:8000)"; else bad "${value} panel(s) are not the stand-in"; fi

  if [ "$FAILED" -gt 0 ]; then
    printf '\n%s check(s) FAILED: do not upload a package until every check passes.\n' "$FAILED"
    exit 1
  fi
  printf '\nall isolation checks passed\n'
}

cmd_status() {
  require_initialised
  compose ps
  printf '\nadmin URL:        https://localhost:%s\n' "$(env_value "${DIR}/deploy.env" NEXA_REHEARSAL_HTTPS_PORT)"
  printf 'RickPanel stand-in (register it as the panel): http://%s:8000\n' \
    "$(env_value "${DIR}/deploy.env" NEXA_REHEARSAL_STANDIN_IP)"
  printf 'its credentials:  %s standin-credentials --dir %s\n' "$0" "$DIR"
}

cmd_standin_credentials() {
  require_initialised
  printf 'base URL:  http://%s:8000\n' "$(env_value "${DIR}/deploy.env" NEXA_REHEARSAL_STANDIN_IP)"
  printf 'username:  %s\n' "$(env_value "${DIR}/standin.env" RICKPANEL_STANDIN_USERNAME)"
  printf 'password:  %s\n' "$(env_value "${DIR}/standin.env" RICKPANEL_STANDIN_PASSWORD)"
  printf '(the rehearsal stand-in only — it opens nothing else)\n'
}

cmd_set_target_ack() {
  require_initialised
  local value="${POSITIONAL[0]:-}"
  [[ "$value" =~ ^[0-9a-f]{16}$ ]] || die "the target acknowledgement is the 16 hex characters the migration page shows."
  write_file "${DIR}/migration.env" <<EOF
NEXA_LEGACY_IMPORT_TARGET_ACK=${value}
EOF
  compose up -d --no-deps --force-recreate migration
  wait_healthy migration
  ok "the migration role now carries the target acknowledgement"
}

cmd_standin_check() {
  require_initialised
  local log token reads refused unauthorized
  log="$(compose logs --no-color --no-log-prefix rickpanel-standin 2>/dev/null || true)"
  token="$(printf '%s\n' "$log" | grep -c '"kind":"token"' || true)"
  reads="$(printf '%s\n' "$log" | grep -c '"kind":"read"' || true)"
  refused="$(printf '%s\n' "$log" | grep -c '"kind":"refused"' || true)"
  unauthorized="$(printf '%s\n' "$log" | grep -c '"kind":"unauthorized"' || true)"
  printf 'stand-in requests: token=%s read=%s unauthorized=%s refused(write attempts)=%s\n' \
    "$token" "$reads" "$unauthorized" "$refused"
  if [ "$refused" != "0" ]; then
    printf 'FAIL  something tried to WRITE to the panel:\n'
    printf '%s\n' "$log" | grep '"kind":"refused"' | tail -n 20
    exit 1
  fi
  ok "no write was attempted against the panel"
}

cmd_verify() {
  require_initialised
  compose exec -T postgres psql -U nexa -d "$DB_NAME" -q -f - <"${HERE}/verify-import.sql"
}

cmd_backup() {
  require_initialised
  require_image
  compose run --rm --no-deps --entrypoint node api dist/backup.cli.js "$@"
}

cmd_logs() {
  require_initialised
  local service="${POSITIONAL[0]:-}"
  [ -n "$service" ] || die "logs needs a SERVICE (api, worker, migration, rickpanel-standin, caddy, postgres)."
  compose logs --no-color --tail 200 "$service"
}

cmd_down() {
  require_initialised
  # Never `-v`: the rehearsal database is evidence, and deleting it is the owner's call.
  compose down
  ok "containers stopped and removed; every volume (the rehearsal database included) is kept"
}

case "$COMMAND" in
  init) cmd_init ;;
  build) cmd_build ;;
  up) cmd_up ;;
  owner) cmd_owner ;;
  preflight) cmd_preflight ;;
  status) cmd_status ;;
  standin-credentials) cmd_standin_credentials ;;
  set-target-ack) cmd_set_target_ack ;;
  standin-check) cmd_standin_check ;;
  verify) cmd_verify ;;
  backup-run) cmd_backup run ;;
  backup-list) cmd_backup list ;;
  logs) cmd_logs ;;
  down) cmd_down ;;
  -h | --help | help) usage ;;
  *) die "unknown command ${COMMAND} (see --help)" ;;
esac
