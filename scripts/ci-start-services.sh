#!/usr/bin/env bash
# Start CI's throwaway PostgreSQL and Redis, retrying a bounded number of times.
#
#   scripts/ci-start-services.sh
#
# Why this is a step and not a `services:` block: a GitHub service container that
# fails to pull or to become healthy fails the whole job at "Initialize
# containers", before any step exists, and nothing can retry it. Measured on main
# that was 2/10 integration shards on one commit and 7/10 and 9/10 on another. The
# same containers started from a step can be pulled, health-waited and, if they
# never answer, removed and started again.
#
# Same images, credentials, ports and health probes as the service blocks this
# replaces. The container NAMES are fixed so the next step can address them
# (nexa-ci-postgres is what scripts/ci-test-postgres.sh is given).
#
# Bounded: ATTEMPTS tries per container, each pull and each health wait has its own
# limit, so a registry that is really down fails the step with a message in about
# the time a human would have waited, never hangs.
set -euo pipefail

if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
  printf 'FAIL  this starts CI disposable services and runs only inside GitHub Actions.\n' >&2
  exit 1
fi

ATTEMPTS="${CI_SERVICE_ATTEMPTS:-4}"
HEALTH_WAIT="${CI_SERVICE_HEALTH_SECONDS:-60}"

pull() {
  local image="$1" try
  for try in 1 2 3 4; do
    timeout 120 docker pull --quiet "$image" >/dev/null && return 0
    printf 'warn  pull of %s failed (try %s/4)\n' "$image" "$try" >&2
    sleep $((try * 5))
  done
  return 1
}

# start <name> <image> <health cmd> <docker run args...>
start() {
  local name="$1" image="$2" health="$3" attempt waited
  shift 3
  pull "$image" || {
    printf 'FAIL  could not pull %s\n' "$image" >&2
    return 1
  }
  for attempt in $(seq 1 "$ATTEMPTS"); do
    docker rm -f "$name" >/dev/null 2>&1 || true
    if docker run -d --name "$name" "$@" "$image" >/dev/null; then
      waited=0
      while [ "$waited" -lt "$HEALTH_WAIT" ]; do
        if docker exec "$name" sh -c "$health" >/dev/null 2>&1; then
          printf 'ok    %s healthy (attempt %s)\n' "$name" "$attempt"
          return 0
        fi
        sleep 2
        waited=$((waited + 2))
      done
    fi
    printf 'warn  %s not healthy (attempt %s/%s)\n' "$name" "$attempt" "$ATTEMPTS" >&2
    docker logs --tail 20 "$name" >&2 2>&1 || true
    sleep $((attempt * 3))
  done
  printf 'FAIL  %s never became healthy\n' "$name" >&2
  return 1
}

start nexa-ci-postgres postgres:16-alpine 'pg_isready -U nexa -d nexa_test' \
  -e POSTGRES_USER=nexa -e POSTGRES_PASSWORD=nexa -e POSTGRES_DB=nexa_test \
  -p 5432:5432

start nexa-ci-redis redis:7-alpine 'redis-cli ping' \
  -p 6379:6379

# pg_isready can answer from the entrypoint's temporary server, which is stopped and
# restarted once initialisation finishes. A real query on the final server is the
# readiness that matters.
for _ in $(seq 1 30); do
  if docker exec nexa-ci-postgres psql -U nexa -d nexa_test -Atc 'SELECT 1' >/dev/null 2>&1; then
    printf 'ok    postgres answers queries\n'
    exit 0
  fi
  sleep 2
done
printf 'FAIL  postgres never answered a query\n' >&2
exit 1
