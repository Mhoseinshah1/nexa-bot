#!/usr/bin/env bash
# The isolated Mirza → NEXA rehearsal kit (deploy/rehearsal/), actually run under Docker.
#
# CI only (the Deployment smoke job): builds the image from this checkout through the kit,
# brings the rehearsal up — migrations, the tenant, the api, worker, `migration` role, the
# read-only RickPanel stand-in and the loopback HTTPS edge — and proves what the unit test
# can only read in YAML: the isolation preflight passes (no NEXA process reaches the
# internet), the stand-in answers the roles that may reach it and refuses and COUNTS a write,
# the `migration` role is healthy, the independent SQL check runs, a standard backup is taken,
# and `down` keeps the volumes. No package is imported here (a synthetic one is refused on a
# production-like target by design); the import itself is the integration suite's.
set -euo pipefail

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
KIT="${REPO}/deploy/rehearsal/mirza-rehearsal.sh"
WORK="$(mktemp -d)"
R="${WORK}/rehearsal"
PORT=18543
OCTET=200
STANDIN="172.30.$((OCTET + 3)).10"

compose() {
  docker compose -p nexa-mirza-rehearsal --env-file "${R}/deploy.env" \
    -f "${REPO}/deploy/compose.yml" -f "${REPO}/deploy/rehearsal/compose.mirza-rehearsal.yml" "$@"
}
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }
fail() {
  printf '\033[31mFAIL\033[0m  %s\n' "$1" >&2
  compose ps >&2 || true
  compose logs --no-color --tail 60 >&2 || true
  exit 1
}
cleanup() {
  # CI's own teardown: a runner keeps nothing. The kit itself never removes a volume.
  if [ -f "${R}/deploy.env" ]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
  docker image rm nexa-mirza-rehearsal:local >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Runs JavaScript in a service; prints what it prints.
js() {
  local service="$1" code="$2"
  compose exec -T "$service" node -e "$code"
}

bash "$KIT" init --dir "$R" --https-port "$PORT" --subnet-octet "$OCTET"
bash "$KIT" build --dir "$R"
# `up` ends with the isolation preflight and exits non-zero if any check fails.
bash "$KIT" up --dir "$R" || fail "the rehearsal did not come up isolated"
pass "up: migrated, provisioned, every role healthy, isolation preflight passed"

for service in provisioner monitor assistant recovery; do
  if compose ps --services --status running | grep -qx "$service"; then fail "${service} is running"; fi
done
pass "provisioner, monitor, assistant and recovery are not running"

code="$(curl -sk -o /dev/null -w '%{http_code}' "https://localhost:${PORT}/health/live" || true)"
[ "$code" = "200" ] || fail "the HTTPS edge on 127.0.0.1:${PORT} answered ${code}"
pass "the admin edge answers on https://localhost:${PORT}"
published="$(docker ps --filter label=com.docker.compose.project=nexa-mirza-rehearsal --format '{{.Ports}}' | tr ',' '\n' | grep -- '->' || true)"
if printf '%s\n' "$published" | grep -v '^ *127\.0\.0\.1:' | grep -q .; then
  fail "a port is published beyond 127.0.0.1: ${published}"
fi
pass "the only published port is on 127.0.0.1"

# The stand-in: reachable from api and migration (panelsim), not from the worker.
probe="fetch('http://${STANDIN}:8000/api/system',{signal:AbortSignal.timeout(5000)}).then(r=>console.log(r.status)).catch(()=>console.log('unreachable'))"
[ "$(js api "$probe")" = "401" ] || fail "api cannot reach the stand-in"
[ "$(js migration "$probe")" = "401" ] || fail "migration cannot reach the stand-in"
[ "$(js worker "$probe")" = "unreachable" ] || fail "the worker can reach the panel network"
pass "the stand-in is reachable from api and migration only"

[ "$(compose ps --format '{{.Health}}' migration)" = "healthy" ] || fail "the migration role is not healthy"
pass "the migration role is healthy (heartbeat)"

# A write is refused (405), and standin-check sees it and fails.
user="$(grep '^RICKPANEL_STANDIN_USERNAME=' "${R}/standin.env" | cut -d= -f2-)"
secret="$(grep '^RICKPANEL_STANDIN_PASSWORD=' "${R}/standin.env" | cut -d= -f2-)"
bash "$KIT" standin-check --dir "$R" >/dev/null || fail "standin-check failed before any write"
write_status="$(compose exec -T -e U="$user" -e P="$secret" api node -e "
const b='http://${STANDIN}:8000';
(async()=>{const t=await fetch(b+'/api/admin/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:process.env.U,password:process.env.P,grant_type:'password'})});
const tok=(await t.json()).access_token;
const w=await fetch(b+'/api/user',{method:'POST',headers:{authorization:'Bearer '+tok,'content-type':'application/json'},body:'{}'});
console.log(w.status);})().catch(()=>console.log('error'));")"
[ "$write_status" = "405" ] || fail "the stand-in answered a write with ${write_status}"
if bash "$KIT" standin-check --dir "$R" >/dev/null; then fail "standin-check missed a write attempt"; fi
pass "a write is refused (405) and standin-check reports it"

out="$(bash "$KIT" verify --dir "$R")" || fail "the independent SQL check did not run"
printf '%s\n' "$out" | grep -qx $'customers\t0\t' || fail "verify: customers is not 0 on a fresh rehearsal"
printf '%s\n' "$out" | grep -qx $'payments\t0\t' || fail "verify: payments is not 0"
pass "the independent SQL check runs (fresh: 0 customers, 0 payments)"

bash "$KIT" backup-run --dir "$R" >/dev/null || fail "the standard backup failed inside the rehearsal"
bash "$KIT" backup-list --dir "$R" | grep -q 'SUCCEEDED' || fail "backup-list shows no SUCCEEDED run"
pass "a standard NEXA backup is taken and listed"

bash "$KIT" down --dir "$R" >/dev/null
docker volume inspect nexa-mirza-rehearsal_pgdata >/dev/null 2>&1 || fail "down removed the database volume"
pass "down keeps the rehearsal database volume"

printf '\nmirza rehearsal smoke: all checks passed\n'
