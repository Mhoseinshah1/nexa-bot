#!/usr/bin/env bash
# The deployment, actually run.
#
# `tests/deploy/botctl.test.sh` proves the update and rollback LOGIC against a
# fake docker; `tests/unit/deployment-*.test.ts` prove the topology's structure.
# Neither can show that the image builds, that the containers come up, that
# migrations apply, or that the edge serves the panel. This does, on a runner
# with a real Docker daemon.
#
# It uses the PRODUCTION compose file with `deploy/compose.ci.yml` layered on
# top. That overlay changes exactly three things CI cannot have — a public DNS
# name, an ACME certificate, and the world's port 80 — and nothing else. If a
# check here passes only because of the overlay, it is not testing the
# deployment.
set -euo pipefail

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$REPO"

VERSION_A="${VERSION_A:-v0.0.1-smoke}"
VERSION_B="${VERSION_B:-v0.0.2-smoke}"
IMAGE_REPO="${IMAGE_REPO:-nexa-smoke/nexa-bot}"
HTTP_PORT="${NEXA_CI_HTTP_PORT:-18080}"

fail() {
  printf '\033[31mFAIL\033[0m  %s\n' "$1" >&2
  dump_diagnostics
  exit 1
}
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }
step() { printf '\n\033[1m==>\033[0m %s\n' "$1"; }

# A temporary host layout. The library and botctl take every path from the
# environment for exactly this, so the smoke test never writes to /etc or /opt.
ROOT="$(mktemp -d)"
export NEXA_ROOT="$ROOT"
export NEXA_DEPLOY_DIR="${ROOT}/opt/nexa/deploy"
export NEXA_LIB_DIR="${ROOT}/opt/nexa/lib"
export NEXA_CONFIG_DIR="${ROOT}/etc/nexa"
export NEXA_STATE_DIR="${ROOT}/var/lib/nexa"
export NEXA_BACKUP_DIR="${ROOT}/var/backups/nexa"
export NEXA_LOCK_FILE="${ROOT}/var/lib/nexa/nexa.lock"
export NEXA_IMAGE_REPO="$IMAGE_REPO"
export NEXA_LIB="${REPO}/deploy/bin/nexa-lib.sh"
BOTCTL="${REPO}/deploy/bin/botctl"

compose() {
  docker compose \
    --env-file "${NEXA_CONFIG_DIR}/deploy.env" \
    -f "${NEXA_DEPLOY_DIR}/compose.yml" \
    -f "${REPO}/deploy/compose.ci.yml" \
    "$@"
}

dump_diagnostics() {
  printf '\n--- container state ---\n'
  compose ps 2>&1 | head -30 || true
  printf '\n--- api ---\n'
  compose logs --tail 60 api 2>&1 | tail -60 || true
  printf '\n--- caddy ---\n'
  compose logs --tail 20 caddy 2>&1 | tail -20 || true
  # The one-shot that publishes the Web Admin bundle. It exits, so its failure
  # shows up as "the stack did not start" with nothing else to look at unless
  # its log is dumped here too — which is exactly how its first failure
  # presented.
  printf '\n--- web-assets ---\n'
  compose logs --tail 20 web-assets 2>&1 | tail -20 || true
}

cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$ROOT"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
step "1. the production image builds"
# ---------------------------------------------------------------------------
COMMIT_A="$(git rev-parse HEAD)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker build \
  --build-arg "BUILD_VERSION=${VERSION_A}" \
  --build-arg "BUILD_COMMIT=${COMMIT_A}" \
  --build-arg "BUILD_TIME=${BUILT_AT}" \
  -t "${IMAGE_REPO}:${VERSION_A}" . >/dev/null ||
  fail "the production image did not build"
pass "the production image builds"

# ---------------------------------------------------------------------------
step "2. the runtime image is what it claims to be"
# ---------------------------------------------------------------------------
# Entrypoints present and loading under production dependencies only, no dev
# tooling, no source tree, no web source maps, non-root, stamped metadata that
# matches what was asked for.
bash scripts/check-image.sh "${IMAGE_REPO}:${VERSION_A}" "$VERSION_A" "$COMMIT_A" ||
  fail "the runtime image failed its assertions"

# ---------------------------------------------------------------------------
step "3. the compose definitions parse, and publish nothing they should not"
# ---------------------------------------------------------------------------
install -d -m 0700 "$NEXA_CONFIG_DIR"
install -d -m 0755 "$NEXA_DEPLOY_DIR" "$NEXA_LIB_DIR" "${NEXA_DEPLOY_DIR}/caddy"
install -d -m 0750 "$NEXA_STATE_DIR" "${NEXA_STATE_DIR}/releases"
install -d -m 0700 "$NEXA_BACKUP_DIR"
install -m 0644 deploy/compose.yml "${NEXA_DEPLOY_DIR}/compose.yml"
install -m 0644 deploy/caddy/Caddyfile deploy/caddy/Caddyfile.ci deploy/caddy/routes.caddy \
  "${NEXA_DEPLOY_DIR}/caddy/"
install -m 0644 deploy/nexa.env.template "${NEXA_DEPLOY_DIR}/nexa.env.template"

# Generated the way the installer generates them, so the smoke test exercises
# the real template substitution rather than a hand-written file.
PG_PASSWORD="$(head -c 24 /dev/urandom | base64 -w0 | tr -d '=+/' | cut -c1-32)"
REDIS_PASSWORD="$(head -c 24 /dev/urandom | base64 -w0 | tr -d '=+/' | cut -c1-32)"
KEK="$(head -c 32 /dev/urandom | base64 -w0)"

umask 077
printf 'POSTGRES_USER=nexa\nPOSTGRES_DB=nexa\nPOSTGRES_PASSWORD=%s\n' "$PG_PASSWORD" \
  >"${NEXA_CONFIG_DIR}/postgres.env"
printf 'REDIS_PASSWORD=%s\n' "$REDIS_PASSWORD" >"${NEXA_CONFIG_DIR}/redis.env"
python3 -c '
import sys
source, target = sys.argv[1], sys.argv[2]
text = open(source, "r", encoding="utf-8").read()
for pair in sys.argv[3:]:
    token, value = pair.split("=", 1)
    text = text.replace(token, value)
open(target, "w", encoding="utf-8").write(text)
' "${NEXA_DEPLOY_DIR}/nexa.env.template" "${NEXA_CONFIG_DIR}/nexa.env" \
  "__POSTGRES_PASSWORD__=${PG_PASSWORD}" \
  "__REDIS_PASSWORD__=${REDIS_PASSWORD}" \
  "__SECRETS_KEK__=${KEK}" \
  "__SECRETS_ACTIVE_KEY_ID__=smoke-1" \
  "__DOMAIN__=localhost" \
  "__EDGE_SUBNET__=172.29.0.0/24"

# The one production value CI must override: the schema requires a canonical
# https admin origin, and CI has no certificate. Changed HERE, in the smoke
# test, rather than by weakening the template that ships.
sed -i 's|^WEB_ADMIN_ORIGINS=.*|WEB_ADMIN_ORIGINS=https://localhost|' "${NEXA_CONFIG_DIR}/nexa.env"

{
  printf 'NEXA_IMAGE=%s:%s\n' "$IMAGE_REPO" "$VERSION_A"
  printf 'NEXA_DOMAIN=localhost\n'
  printf 'NEXA_ACME_EMAIL=ci@localhost\n'
  printf 'NEXA_CONFIG_DIR=%s\n' "$NEXA_CONFIG_DIR"
  printf 'NEXA_DEPLOY_DIR=%s\n' "$NEXA_DEPLOY_DIR"
  printf 'NEXA_EDGE_SUBNET=172.29.0.0/24\n'
  printf 'NEXA_DATA_SUBNET=172.29.1.0/24\n'
  printf 'NEXA_CI_HTTP_PORT=%s\n' "$HTTP_PORT"
} >"${NEXA_CONFIG_DIR}/deploy.env"
umask 022

compose config >/dev/null || fail "the production compose definition does not parse"
pass "the compose definitions parse"

# Read back from the RENDERED configuration, which is what Docker acts on —
# not from the source file, where a later override could change the answer.
RENDERED="$(compose config)"
printf '%s' "$RENDERED" | python3 -c '
import sys, json
text = sys.stdin.read()
problems = []
service = None
published = {}
for line in text.splitlines():
    if line.startswith("  ") and not line.startswith("   ") and line.rstrip().endswith(":"):
        service = line.strip().rstrip(":")
    if "published:" in line and service:
        published.setdefault(service, []).append(line.strip())
for name in ("postgres", "redis", "api", "worker", "monitor"):
    if published.get(name):
        problems.append(f"{name} publishes a host port: {published[name]}")
if not published.get("caddy"):
    problems.append("caddy publishes nothing; the check cannot be seeing ports at all")
if problems:
    print("\n".join(problems))
    sys.exit(1)
' || fail "a service other than the edge publishes a host port"
pass "only the edge publishes host ports"

# ---------------------------------------------------------------------------
step "4. the stack comes up and the API becomes ready"
# ---------------------------------------------------------------------------
compose up -d postgres redis >/dev/null || fail "the data services did not start"

waited=0
# `awk '$2 == "healthy"'`, not `grep -c healthy`: "healthy" is a SUBSTRING of
# "unhealthy", so the count reached two the moment BOTH services were reporting
# unhealthy — and this loop then exited and migrated against them.
until [ "$(compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null |
  awk '$2 == "healthy" { n += 1 } END { print n + 0 }')" -ge 2 ]; do
  [ "$waited" -lt 120 ] || fail "PostgreSQL and Redis never became healthy"
  sleep 3
  waited=$((waited + 3))
done
pass "PostgreSQL and Redis are healthy"

# The migration runs from the RELEASE IMAGE's compiled migrator — the whole
# reason the maintenance CLIs live in the image.
compose run --rm --no-deps --entrypoint node api \
  dist/infrastructure/persistence/migrate.js >/dev/null ||
  fail "migrations did not apply from the release image"
pass "migrations apply from the release image"

compose run --rm --no-deps --entrypoint node api \
  dist/provision-installation.cli.js --slug smoke --display-name Smoke >/dev/null ||
  fail "provisioning the installation failed"
# Idempotent: a rerun must change nothing. This is what an installer rerun does.
compose run --rm --no-deps --entrypoint node api \
  dist/provision-installation.cli.js --slug smoke --display-name Smoke >/dev/null ||
  fail "provisioning is not idempotent"
pass "the installation provisions, and reruns cleanly"

# The first owner, with the password on stdin and nowhere else.
printf 'a-long-enough-smoke-password\n' |
  compose run --rm --no-deps -T --entrypoint node api \
    dist/bootstrap-owner.cli.js --username owner --display-name Owner >/dev/null ||
  fail "the first owner could not be created"
pass "the first owner is created from stdin"

# The bootstrap CLI, on a REAL Docker TTY, must exit.
#
# This is the defect a fresh Ubuntu 24.04 staging install found, and the step
# above cannot see it: `-T` means no TTY, so the CLI takes its buffered path and
# the terminal reader never runs. On a TTY it did run, and it left stdin resumed
# after the last prompt — the process stayed alive with its work finished,
# `docker compose run --rm` never returned, and the install stopped one step
# before writing the release manifest. The owner was created; `botctl version`
# said "no current release is recorded" for good.
#
# So: allocate a real terminal — no `-T`, and `script` so compose has a TTY of
# its own to allocate from — answer the prompts, and require the process to END.
# An owner already exists, so the fence refuses this one, and that is fine: the
# refusal lands AFTER the answers are read and the reader is closed, so a stdin
# still resumed hangs here exactly as it hung on the host. What is asserted is
# that the command RETURNS, not what it decided.
owner_tty_log="${ROOT}/bootstrap-tty.log"
owner_tty_command="docker compose --env-file ${NEXA_CONFIG_DIR}/deploy.env"
owner_tty_command="${owner_tty_command} -f ${NEXA_DEPLOY_DIR}/compose.yml -f ${REPO}/deploy/compose.ci.yml"
owner_tty_command="${owner_tty_command} run --rm --no-deps --entrypoint node api dist/bootstrap-owner.cli.js"

owner_tty_status=0
printf 'someone\nSomeone Else\nanother-long-smoke-password\nanother-long-smoke-password\n' |
  timeout 120 script -qec "$owner_tty_command" /dev/null >"$owner_tty_log" 2>&1 ||
  owner_tty_status=$?

# 124 is `timeout` reporting that it had to kill the command. That is the whole
# assertion: any other status means the process decided something and left.
[ "$owner_tty_status" -ne 124 ] ||
  fail "the bootstrap CLI never exited on a terminal (see ${owner_tty_log}); an install would hang here"
[ "$owner_tty_status" -ne 0 ] ||
  fail "a second bootstrap on a terminal SUCCEEDED; the first-owner fence is gone"
grep -q 'bootstrap.already_completed' "$owner_tty_log" ||
  fail "a second bootstrap on a terminal did not reach the first-owner fence (see ${owner_tty_log})"
pass "the bootstrap CLI exits on a real terminal instead of hanging the install"

compose up -d --remove-orphans >/dev/null || fail "the full stack did not start"

waited=0
until [ "$(compose ps --format json api 2>/dev/null | python3 -c '
import json, sys
raw = sys.stdin.read().strip()
entries = []
try:
    parsed = json.loads(raw)
    entries = parsed if isinstance(parsed, list) else [parsed]
except Exception:
    entries = [json.loads(line) for line in raw.splitlines() if line.strip()]
# The same rule as nexa_wait_ready, and for the same reason: the first api
# entry may be a leftover one-off carrying the same healthcheck, which
# reports starting. Only a RUNNING container has a health worth reading.
running = [e for e in entries if e.get("Service") == "api" and e.get("State") == "running"]
print("healthy" if "healthy" in [e.get("Health") or "" for e in running] else "")
' 2>/dev/null)" = "healthy" ]; do
  [ "$waited" -lt 180 ] || fail "the API never became ready"
  sleep 3
  waited=$((waited + 3))
done
pass "the API is ready"

# The worker AND the monitor, not the API alone.
#
# Both write a heartbeat file that their container healthcheck reads, and the
# monitor's proves more than existence: it is written only when a round trip to
# PostgreSQL succeeds AND the monitoring loop has completed an iteration. A
# monitor that comes up healthy here is the whole Phase 3C pipeline working end
# to end in a real container — config parsed, container built, discovery query
# planned and executed, heartbeat written — which no unit test can assert.
#
# This is also the signal `botctl` waits on, so a failure here is a release
# that `nexa_wait_ready` would refuse.
for service in worker monitor; do
  waited=0
  until [ "$(compose ps --format json "$service" 2>/dev/null | SERVICE="$service" python3 -c '
import json, os, sys
raw = sys.stdin.read().strip()
entries = []
try:
    parsed = json.loads(raw)
    entries = parsed if isinstance(parsed, list) else [parsed]
except Exception:
    entries = [json.loads(line) for line in raw.splitlines() if line.strip()]
name = os.environ["SERVICE"]
running = [e for e in entries if e.get("Service") == name and e.get("State") == "running"]
print("healthy" if "healthy" in [e.get("Health") or "" for e in running] else "")
' 2>/dev/null)" = "healthy" ]; do
    [ "$waited" -lt 180 ] || fail "the ${service} never became healthy"
    sleep 3
    waited=$((waited + 3))
  done
  pass "the ${service} is healthy"
done

# ---------------------------------------------------------------------------
step "5. the database and Redis are not reachable from the host"
# ---------------------------------------------------------------------------
# The structural assertion is in the unit tests; this is the behavioural one.
# A published port would answer here.
for port in 5432 6379; do
  if timeout 3 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/${port}" 2>/dev/null; then
    fail "something is listening on 127.0.0.1:${port}; the data services must not be reachable from the host"
  fi
done
pass "PostgreSQL and Redis are not reachable from the host"

# ---------------------------------------------------------------------------
step "6. the edge serves the panel and proxies the API"
# ---------------------------------------------------------------------------
base="http://127.0.0.1:${HTTP_PORT}"

# Matched in the shell rather than through a pipe, for the same SIGPIPE
# reason as above and because these strings are already in memory.
health="$(curl -fsS "${base}/health/live" || true)"
case "$health" in
  *'"status":"ok"'*) : ;;
  *) fail "the edge does not proxy /health/live (got: ${health})" ;;
esac
pass "the edge proxies the health routes"

ready_code="$(curl -s -o /dev/null -w '%{http_code}' "${base}/health/ready")"
[ "$ready_code" = "200" ] || fail "/health/ready answered ${ready_code}"
pass "readiness answers 200 through the edge"

# /health/info requires a session and must NOT describe the deployment to an
# anonymous caller. This is a Phase 2 property the edge must not undo.
info_code="$(curl -s -o /dev/null -w '%{http_code}' "${base}/health/info")"
[ "$info_code" = "401" ] ||
  fail "/health/info answered ${info_code} without a session; it must be 401"
pass "/health/info still requires a session through the edge"

index="$(curl -fsS "${base}/" || true)"
case "$index" in
  *'<div id="root">'*) : ;;
  *) fail "the edge does not serve the Web Admin bundle" ;;
esac
pass "the edge serves the Web Admin"

# A deep link must reach the SPA, not a 404 from the file server.
deep_code="$(curl -s -o /dev/null -w '%{http_code}' "${base}/settings")"
[ "$deep_code" = "200" ] || fail "a deep link answered ${deep_code}; the SPA fallback is not working"
pass "deep links fall back to the SPA"

# The Telegram webhook must reach the API, not the SPA.
#
# This is the failure that has no symptom. The controller lives at
# `/telegram/webhook/:botInstanceId` and there is no global route prefix, so
# the path is not under /api; without its own handle block it lands on the SPA
# fallback, which answers index.html with 200 — and 200 is exactly how
# Telegram is told an update was accepted. Updates would be acknowledged and
# discarded, silently, for as long as the feature stayed on.
#
# TELEGRAM_WEBHOOK_ENABLED is false in this deployment, so the controller is
# not even registered and the API answers 404. That is the point: a 404 from
# the API proves the request REACHED the API. Anything that returns the SPA
# proves the edge swallowed it, and the edge behaves the same way whether the
# feature is on or off.
webhook_body="$(curl -s -X POST -H 'Content-Type: application/json' -d '{}' \
  "${base}/telegram/webhook/01a06426-4d8d-741f-9985-656d51b610bb" || true)"
case "$webhook_body" in
  *'<div id="root">'* | *'<!doctype html'* | *'<!DOCTYPE html'*)
    fail "the edge served the SPA for a Telegram webhook; updates would be acknowledged and thrown away"
    ;;
esac
case "$webhook_body" in
  *'{'*) : ;;
  *) fail "the webhook did not reach the API (got: ${webhook_body})" ;;
esac
pass "the Telegram webhook reaches the API rather than the SPA"

# A malformed bot id must get the API's own answer too, not a page.
malformed_body="$(curl -s -X POST -H 'Content-Type: application/json' -d '{}' \
  "${base}/telegram/webhook/not-a-uuid" || true)"
case "$malformed_body" in
  *'<div id="root">'* | *'<!doctype html'* | *'<!DOCTYPE html'*)
    fail "a malformed webhook id was answered by the SPA"
    ;;
esac
pass "a malformed webhook id is answered by the API"

# The API prefix must reach the API, not the SPA. A 401 is the API answering;
# HTML would mean the fallback swallowed it.
#
# The STATUS is asserted, not merely the absence of HTML. Reading only the body
# meant every non-HTML outcome passed — a reset connection, an empty 502, a
# Caddy error page that is not `<!doctype html>` — so a reverse-proxy upstream
# pointed at a dead port would have printed this line green.
api_status="$(curl -s -o /dev/null -w '%{http_code}' "${base}/api/admin/v1/settings" || true)"
api_body="$(curl -s "${base}/api/admin/v1/settings" || true)"
case "$(printf '%s' "$api_body" | tr '[:upper:]' '[:lower:]')" in
  *'<!doctype html'*) fail "an API request was answered with the SPA; the handle order is wrong" ;;
esac
[ "$api_status" = "401" ] ||
  fail "an API request answered ${api_status}, not the 401 that says the API itself replied"
pass "API requests reach the API, not the SPA (401)"

# ---------------------------------------------------------------------------
step "7. backup"
# ---------------------------------------------------------------------------
printf '%s\n' "$VERSION_A" >"${NEXA_STATE_DIR}/current"
python3 -c '
import json, sys
json.dump({"version": sys.argv[2], "commit": sys.argv[3], "digest": sys.argv[4],
           "image": sys.argv[5], "recordedAt": "smoke"}, open(sys.argv[1], "w"))
' "${NEXA_STATE_DIR}/releases/${VERSION_A}.json" "$VERSION_A" "$COMMIT_A" \
  "sha256:$(printf '0%.0s' {1..64})" "${IMAGE_REPO}:${VERSION_A}"

# botctl invokes compose WITHOUT the CI overlay, and that is fine here: the
# overlay only changes Caddy, while `compose exec postgres` addresses the
# already-running container by project and service label. So this exercises the
# real `botctl backup` against the real database rather than a rehearsal of it.
BOTCTL_OUT="$("$BOTCTL" backup 2>&1)" || fail "botctl backup failed: ${BOTCTL_OUT}"
# `-print -quit`, not `| head -n 1`: find stops by itself, so nothing is ever
# writing into a closed pipe. The pipeline form returns 141 under pipefail as
# soon as a SECOND backup exists — which is to say on the second run of a real
# installation — and `set -e` turns that into an abort.
backup_file="$(find "$NEXA_BACKUP_DIR" -name '*.sql.gz' -print -quit)"
[ -n "$backup_file" ] || fail "botctl backup wrote no file"
[ "$(stat -c '%a' "$backup_file")" = "600" ] || fail "the backup is not 0600"
gzip -t "$backup_file" || fail "the backup is not readable gzip"
# `grep -c`, not `grep -q`. Under `set -o pipefail`, a `grep -q` that finds its
# match exits immediately, `gzip` gets SIGPIPE writing the rest, and the
# pipeline reports 141 — so the assertion FAILS precisely when it succeeds.
# That is what the first CI run of this file did, and the message it printed
# ("the backup contains no schema") was the opposite of the truth. `grep -c`
# reads the whole stream, so there is no early close to be killed by.
schema_count="$(gzip -dc "$backup_file" | grep -c 'CREATE TABLE' || true)"
[ "${schema_count:-0}" -gt 0 ] ||
  fail "the backup contains no schema; it is not a real dump"
pass "botctl backup writes a verified 0600 dump of the real database"

# ---------------------------------------------------------------------------
step "8. no secret appears in normal output"
# ---------------------------------------------------------------------------
# Everything an operator would see or paste into a ticket.
OBSERVABLE="$("$BOTCTL" version 2>&1; "$BOTCTL" status 2>&1; printf '%s' "$BOTCTL_OUT"; compose ps 2>&1)"
for secret in "$PG_PASSWORD" "$REDIS_PASSWORD" "$KEK"; do
  case "$OBSERVABLE" in
    *"$secret"*) fail "a generated secret appeared in normal botctl output" ;;
  esac
done
pass "no generated secret appears in botctl output"

printf '\n\033[32mThe deployment builds, starts, migrates, serves and backs up.\033[0m\n'
