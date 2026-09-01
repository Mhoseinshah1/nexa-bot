#!/usr/bin/env bash
#
# Starts PostgreSQL and Redis for development.
#
# Prefers Docker when a daemon is reachable. Falls back to the natively
# installed servers otherwise — Claude Code cloud sessions ship PostgreSQL 16
# and Redis 7 but start without a Docker daemon, and a foundation you cannot
# test in the environment you develop in is not a foundation.
#
# Both paths expose the same DATABASE_URL and REDIS_URL, so one test suite
# covers both. Idempotent: safe to run repeatedly.

set -uo pipefail
cd "$(dirname "$0")/.."

PG_USER="${PGUSER_NEXA:-nexa}"
PG_PASSWORD="${PGPASSWORD_NEXA:-nexa}"
PG_HOST=127.0.0.1
PG_PORT=5432

echo "==> development services"

start_with_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  docker compose up -d >/dev/null 2>&1 || return 1

  for _ in $(seq 1 30); do
    if docker compose exec -T postgres pg_isready -U "$PG_USER" >/dev/null 2>&1; then
      echo "    postgres  up (docker)"
      echo "    redis     up (docker)"
      return 0
    fi
    sleep 1
  done
  return 1
}

start_natively() {
  if command -v pg_isready >/dev/null 2>&1 && pg_isready -q 2>/dev/null; then
    echo "    postgres  already running"
  elif command -v pg_ctlcluster >/dev/null 2>&1; then
    pg_ctlcluster 16 main start >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      pg_isready -q 2>/dev/null && break
      sleep 1
    done
    pg_isready -q 2>/dev/null && echo "    postgres  up (native)" || {
      echo "    postgres  FAILED to start"
      return 1
    }
  else
    echo "    postgres  not available (install PostgreSQL 16 or start Docker)"
    return 1
  fi

  if redis-cli ping >/dev/null 2>&1; then
    echo "    redis     already running"
  elif command -v redis-server >/dev/null 2>&1; then
    redis-server --daemonize yes --save '' --appendonly no >/dev/null 2>&1 || true
    sleep 1
    redis-cli ping >/dev/null 2>&1 && echo "    redis     up (native)" || {
      echo "    redis     FAILED to start"
      return 1
    }
  else
    echo "    redis     not available (install Redis 7 or start Docker)"
    return 1
  fi

  # Role and databases, created only if missing.
  if command -v psql >/dev/null 2>&1; then
    su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}'\"" 2>/dev/null | grep -q 1 ||
      su postgres -c "psql -c \"CREATE ROLE ${PG_USER} LOGIN PASSWORD '${PG_PASSWORD}' SUPERUSER\"" >/dev/null 2>&1
    for db in nexa_dev nexa_test; do
      su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${db}'\"" 2>/dev/null | grep -q 1 ||
        su postgres -c "createdb -O ${PG_USER} ${db}" >/dev/null 2>&1
    done
    echo "    databases nexa_dev, nexa_test ready"
  fi
  return 0
}

if start_with_docker; then
  :
elif start_natively; then
  :
else
  echo "==> could not start the development services"
  exit 1
fi

cat <<EOF

    DATABASE_URL=postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/nexa_dev
    REDIS_URL=redis://127.0.0.1:6379

    Next: pnpm db:migrate && pnpm db:seed
EOF
