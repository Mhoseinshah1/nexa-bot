#!/usr/bin/env bash
# A tiny harness for testing botctl and the installer library.
#
# The point is to exercise the REAL scripts — the ones that ship — against a
# fake `docker` and a temporary filesystem root, so the update and rollback
# state machines can be driven through their failure branches without a Docker
# daemon, a registry or a database. The branches that matter most are the ones
# that never run on a good day.
#
# A fake docker is not a substitute for the Ubuntu smoke test, and neither is a
# substitute for the other: this proves the logic, that proves the wiring.
#
# shellcheck shell=bash

set -uo pipefail

TESTS_RUN=0
TESTS_FAILED=0
CURRENT_TEST=""

# --- Assertions ---------------------------------------------------------------

fail_test() {
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf '\033[31m  FAIL\033[0m %s\n       %s\n' "$CURRENT_TEST" "$1" >&2
}

assert_ok() {
  # $1: description, $@: command
  local description="$1"
  shift
  if ! "$@" >/dev/null 2>&1; then
    fail_test "$description (command failed: $*)"
    return 1
  fi
  return 0
}

assert_fails() {
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    fail_test "$description (command unexpectedly succeeded: $*)"
    return 1
  fi
  return 0
}

assert_equals() {
  local description="$1" expected="$2" actual="$3"
  if [ "$expected" != "$actual" ]; then
    fail_test "$description: expected [$expected], got [$actual]"
    return 1
  fi
  return 0
}

assert_contains() {
  local description="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*) return 0 ;;
    *)
      fail_test "$description: [$needle] not found in output"
      return 1
      ;;
  esac
}

assert_not_contains() {
  local description="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*)
      fail_test "$description: [$needle] WAS present in output"
      return 1
      ;;
    *) return 0 ;;
  esac
}

assert_file_mode() {
  local description="$1" path="$2" expected="$3" actual
  actual="$(stat -c '%a' "$path" 2>/dev/null || printf 'missing')"
  if [ "$actual" != "$expected" ]; then
    fail_test "$description: $path is mode $actual, expected $expected"
    return 1
  fi
  return 0
}

test_case() {
  CURRENT_TEST="$1"
  TESTS_RUN=$((TESTS_RUN + 1))
  printf '  %s\n' "$CURRENT_TEST"
}

report() {
  printf '\n'
  if [ "$TESTS_FAILED" -eq 0 ]; then
    printf '\033[32mok\033[0m    %d checks passed\n' "$TESTS_RUN"
    return 0
  fi
  printf '\033[31mFAIL\033[0m  %d of %d checks failed\n' "$TESTS_FAILED" "$TESTS_RUN" >&2
  return 1
}

# --- A fake filesystem root ---------------------------------------------------
#
# Every path the library uses is overridable for exactly this. A production
# install never sets them.
setup_root() {
  NEXA_ROOT="$(mktemp -d)"
  export NEXA_ROOT
  export NEXA_DEPLOY_DIR="${NEXA_ROOT}/opt/nexa/deploy"
  export NEXA_LIB_DIR="${NEXA_ROOT}/opt/nexa/lib"
  export NEXA_CONFIG_DIR="${NEXA_ROOT}/etc/nexa"
  export NEXA_STATE_DIR="${NEXA_ROOT}/var/lib/nexa"
  export NEXA_BACKUP_DIR="${NEXA_ROOT}/var/backups/nexa"
  export NEXA_LOCK_FILE="${NEXA_ROOT}/var/lock/nexa.lock"
  export NEXA_IMAGE_REPO="registry.test/nexa"

  mkdir -p "$NEXA_DEPLOY_DIR" "$NEXA_LIB_DIR" "$NEXA_STATE_DIR/releases" \
    "$NEXA_BACKUP_DIR" "$(dirname "$NEXA_LOCK_FILE")"
  chmod 0700 "$NEXA_BACKUP_DIR"
  install -d -m 0700 "$NEXA_CONFIG_DIR"

  # A minimal installed state: enough for `require_installed` and for the
  # compose wrapper to have a file to point at.
  cat >"${NEXA_CONFIG_DIR}/deploy.env" <<EOF
NEXA_IMAGE=registry.test/nexa@sha256:$(printf '1%.0s' {1..64})
NEXA_DOMAIN=admin.example.test
NEXA_CONFIG_DIR=${NEXA_CONFIG_DIR}
NEXA_DEPLOY_DIR=${NEXA_DEPLOY_DIR}
EOF
  chmod 0600 "${NEXA_CONFIG_DIR}/deploy.env"

  cat >"${NEXA_CONFIG_DIR}/postgres.env" <<'EOF'
POSTGRES_USER=nexa
POSTGRES_DB=nexa
POSTGRES_PASSWORD=not-a-real-password
EOF
  chmod 0600 "${NEXA_CONFIG_DIR}/postgres.env"

  : >"${NEXA_DEPLOY_DIR}/compose.yml"
}

teardown_root() {
  [ -n "${NEXA_ROOT:-}" ] && [ -d "$NEXA_ROOT" ] && rm -rf "$NEXA_ROOT"
  return 0
}

# --- A fake docker ------------------------------------------------------------
#
# Installed first on PATH. It writes every invocation to a log so a test can
# assert what botctl actually asked Docker to do — which is how "the migration
# ran from the TARGET image" and "the update never used git" become checkable
# rather than assertions about intent.
#
# Behaviour is scripted through files in $FAKE_DIR, so a test can make a pull
# fail, a health check hang, or a migration exit non-zero.
setup_fake_docker() {
  FAKE_DIR="${NEXA_ROOT}/fake"
  export FAKE_DIR
  mkdir -p "$FAKE_DIR/bin"
  export DOCKER_LOG="${FAKE_DIR}/docker.log"
  : >"$DOCKER_LOG"

  # Defaults: everything works, the api is healthy.
  printf '0' >"${FAKE_DIR}/pull_exit"
  printf '0' >"${FAKE_DIR}/up_exit"
  printf '0' >"${FAKE_DIR}/run_exit"
  printf '0' >"${FAKE_DIR}/exec_exit"
  printf '0' >"${FAKE_DIR}/empty_dump"
  printf 'healthy' >"${FAKE_DIR}/api_health"
  printf 'sha256:%s' "$(printf 'a%.0s' {1..64})" >"${FAKE_DIR}/resolve_digest"
  printf '0' >"${FAKE_DIR}/resolve_exit"

  cat >"${FAKE_DIR}/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# Fake docker. Records what it was asked and answers from FAKE_DIR.
set -uo pipefail
printf '%s\n' "$*" >>"$DOCKER_LOG"

read_state() { cat "${FAKE_DIR}/$1" 2>/dev/null || printf '%s' "$2"; }

case "${1:-}" in
  buildx)
    # buildx imagetools inspect <ref> --format ...
    if [ "$(read_state resolve_exit 0)" != "0" ]; then exit 1; fi
    read_state resolve_digest ''
    exit 0
    ;;
  manifest)
    if [ "$(read_state resolve_exit 0)" != "0" ]; then exit 1; fi
    printf '{"Descriptor":{"digest":"%s"}}' "$(read_state resolve_digest '')"
    exit 0
    ;;
  pull)
    exit "$(read_state pull_exit 0)"
    ;;
  image)
    # image inspect <ref> --format ...
    case "$*" in
      *org.opencontainers.image.revision*) printf 'cafebabe\n' ;;
      *) printf 'sha256:deadbeef\n' ;;
    esac
    exit 0
    ;;
  ps)
    exit 0
    ;;
  compose)
    shift
    # Skip the global flags so the subcommand can be found.
    while [ $# -gt 0 ]; do
      case "$1" in
        --env-file | -f | -p | --project-name) shift 2 ;;
        *) break ;;
      esac
    done
    case "${1:-}" in
      ps)
        if printf '%s' "$*" | grep -q -- '--format json'; then
          printf '{"Service":"api","State":"running","Health":"%s"}\n' "$(read_state api_health healthy)"
        else
          printf 'api running healthy\npostgres running healthy\nredis running healthy\n'
        fi
        exit 0
        ;;
      up) exit "$(read_state up_exit 0)" ;;
      run) exit "$(read_state run_exit 0)" ;;
      exec)
        # Stand in for pg_dump: emit something that looks like a real dump so
        # the backup's own integrity checks have something to check.
        if [ "$(read_state exec_exit 0)" != "0" ]; then exit 1; fi
        printf -- '-- PostgreSQL database dump\n'
        if [ "$(read_state empty_dump 0)" != "0" ]; then
          # A database that exists and has no tables: plausible-looking, and
          # worthless.
          for _ in $(seq 1 40); do
            printf 'SET statement_timeout = 0;\n'
          done
          printf -- '-- PostgreSQL database dump complete\n'
          exit 0
        fi
        printf 'CREATE TABLE public.tenants (id uuid NOT NULL);\n'
        printf 'CREATE TABLE public.notifications (id uuid NOT NULL);\n'
        for _ in $(seq 1 80); do
          printf -- '-- padding so the size check has something to measure ------------\n'
        done
        printf -- '-- PostgreSQL database dump complete\n'
        exit 0
        ;;
      logs) exit 0 ;;
      *) exit 0 ;;
    esac
    ;;
  *)
    exit 0
    ;;
esac
FAKE
  chmod +x "${FAKE_DIR}/bin/docker"
  PATH="${FAKE_DIR}/bin:${PATH}"
  export PATH
}

fake_set() { printf '%s' "$2" >"${FAKE_DIR}/$1"; }
docker_log() { cat "$DOCKER_LOG" 2>/dev/null || true; }
reset_docker_log() { : >"$DOCKER_LOG"; }

# Record a release as installed.
seed_release() {
  local version="$1" digest="$2"
  # shellcheck disable=SC2154
  python3 -c '
import json, sys
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump({
        "version": sys.argv[2],
        "commit": "c0ffee",
        "digest": sys.argv[3],
        "image": "registry.test/nexa@" + sys.argv[3],
        "recordedAt": "2026-01-01T00:00:00Z",
    }, handle)
' "${NEXA_STATE_DIR}/releases/${version}.json" "$version" "$digest"
  printf '%s\n' "$version" >"${NEXA_STATE_DIR}/current"
}
