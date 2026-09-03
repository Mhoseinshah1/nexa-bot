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
  export NEXA_LOCK_FILE="${NEXA_STATE_DIR}/nexa.lock"
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
  printf '0' >"${FAKE_DIR}/stale_run"
  printf '0' >"${FAKE_DIR}/api_gone"
  printf 'sha256:%s' "$(printf 'a%.0s' {1..64})" >"${FAKE_DIR}/resolve_digest"
  printf '0' >"${FAKE_DIR}/resolve_exit"

  cat >"${FAKE_DIR}/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# Fake docker. Records what it was asked and answers from FAKE_DIR.
set -uo pipefail

# The image compose would use: the environment override if botctl set one,
# otherwise whatever deploy.env names — exactly as the real client resolves it.
#
# Reading the --env-file is not decoration. Without it no test can observe
# which image a back-out or a `botctl restart` would ACTUALLY start, and the
# whole point of the commit-ordering rule is that deploy.env decides that. With
# the fake taking the image only from the environment, reverting the ordering
# to the buggy one left the suite green.
NEXA_IMAGE="${NEXA_IMAGE:-}"
if [ -z "$NEXA_IMAGE" ]; then
  _env_file=""
  _prev=""
  for _arg in "$@"; do
    [ "$_prev" = "--env-file" ] && _env_file="$_arg"
    _prev="$_arg"
  done
  if [ -n "$_env_file" ] && [ -r "$_env_file" ]; then
    NEXA_IMAGE="$(sed -n 's/^NEXA_IMAGE=//p' -- "$_env_file" | sed -n '1p')"
  fi
fi
printf '%s [image=%s]\n' "$*" "$NEXA_IMAGE" >>"$DOCKER_LOG"

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
        # A `case` rather than `printf | grep -q`: the pipeline form takes the
        # WRONG BRANCH if printf is killed by SIGPIPE when grep matches early,
        # which would make the fake answer with the table format where JSON was
        # asked for — and readiness would silently never be detected.
        case "$*" in
          *'--format json'*)
            # A leftover `compose run` container, if a test asked for one.
            #
            # It reports Health "starting", and that detail is the entire
            # point. Compose builds a one-off from the SAME service config, so
            # it carries the same HEALTHCHECK and its health monitor records
            # `starting` before it exits — and Docker retains the last status
            # after exit. An earlier version of this fixture emitted no Health
            # field at all, which is the one shape under which a "prefer an
            # entry that reports a Health" rule looks correct. It was a fixture
            # chosen to make the test pass rather than to model reality, and it
            # concealed a parser that preferred the corpse over the running
            # container.
            #
            # And, like real compose, an EXITED container is listed only with
            # `--all`. Without modelling that, the caller's `--all` is
            # decorative and the fast-fail it makes reachable is untestable.
            if [ "$(read_state stale_run 0)" != "0" ]; then
              case "$*" in
                *--all*) printf '{"Service":"api","State":"exited","Health":"starting"}\n' ;;
              esac
            fi
            # The api container itself having DIED is a different fixture from
            # a leftover one-off: compose lists no running entry at all, only
            # the corpse, and only with `--all`. Emitting a running api
            # alongside it would model nothing that happens.
            if [ "$(read_state api_gone 0)" != "0" ]; then
              case "$*" in
                *--all*) printf '{"Service":"api","State":"exited","Health":"starting"}\n' ;;
              esac
              exit 0
            fi
            # Health is per-IMAGE when a test asks for it. Without that, the
            # fake has one global health and "the target is unhealthy but the
            # previous release is healthy" cannot be expressed — so the test
            # named for the back-out branch actually landed on the panic
            # branch, and the branch the documentation promises had no
            # coverage at all.
            printf '{"Service":"api","State":"running","Health":"%s"}\n' \
              "$(read_state "api_health_${NEXA_IMAGE##*@}" "$(read_state api_health healthy)")"
            ;;
          *)
            printf 'api running healthy\npostgres running healthy\nredis running healthy\n'
            ;;
        esac
        exit 0
        ;;
      # Per-image, like health, so "the target will not start but the previous
      # release does" is expressible. With one global value the back-out could
      # never succeed, and the branch that reports it had no coverage.
      up) exit "$(read_state "up_exit_${NEXA_IMAGE##*@}" "$(read_state up_exit 0)")" ;;
      run)
        # `--status` is a READ, and the only thing it puts on stdout is one
        # word. Modelled here rather than stubbed at the shell level, so the
        # installer's own `owner_state` — the pipeline included — is what the
        # tests exercise.
        case "$*" in
          *--status*)
            [ "$(read_state owner_state_exit 0)" = "0" ] || exit 1
            printf '%s\n' "$(read_state owner_state none)"
            exit 0
            ;;
        esac
        exit "$(read_state run_exit 0)" ;;
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

# Read one field out of a release manifest under the CURRENT fake root.
#
# Deliberately not `nexa_manifest_field`: the library is sourced once, so its
# `NEXA_RELEASES_DIR` is frozen to whichever root existed at source time and
# would answer about a directory that was deleted three tests ago.
manifest_field() {
  local version="$1" field="$2"
  python3 -c '
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        data = json.load(handle)
except OSError:
    sys.exit(1)
value = data.get(sys.argv[2])
if value is None:
    sys.exit(1)
print(value)
' "${NEXA_STATE_DIR}/releases/${version}.json" "$field"
}

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
  # deploy.env has to agree with the manifest, because a real installation's
  # does: they are written together by the same commit. A fixture where they
  # disagree is an installation mid-interrupted-update, which is a state worth
  # testing deliberately and not worth every other test starting from.
  set_deploy_image "registry.test/nexa@${digest}"
}

# Rewrite deploy.env's NEXA_IMAGE without going through the library, so a test
# can construct a state the library would refuse to write.
set_deploy_image() {
  local image="$1" file="${NEXA_CONFIG_DIR}/deploy.env"
  grep -v '^NEXA_IMAGE=' -- "$file" >"${file}.new" || true
  printf 'NEXA_IMAGE=%s\n' "$image" >>"${file}.new"
  mv -f "${file}.new" "$file"
  chmod 0600 "$file"
}
