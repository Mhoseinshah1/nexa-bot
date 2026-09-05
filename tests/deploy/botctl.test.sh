#!/usr/bin/env bash
# botctl and its library, driven through their success AND failure branches.
#
# Every failure state in ADR-0022 is asserted here, because those are the paths
# that never run on a good day and therefore never get exercised by hand:
#
#   - a target that cannot be resolved or pulled leaves the current release
#   - a failed backup stops the update before it migrates
#   - a failed migration does not let the target become current
#   - a target that starts but never becomes ready is backed out
#   - the previous release survives the update that replaced it
#   - rollback switches the image and does not touch the database
#   - the lock refuses a second writer
#
# No Docker daemon, no registry, no database: a fake `docker` on PATH records
# what was asked and answers from a scripted state. That makes it possible to
# assert things a smoke test cannot, such as "the migration used the TARGET
# image" and "nothing in the update path ever ran git".

set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "${HERE}/../.." && pwd)"
# shellcheck source=harness.sh
. "${HERE}/harness.sh"

BOTCTL="${REPO}/deploy/bin/botctl"
export NEXA_LIB="${REPO}/deploy/bin/nexa-lib.sh"

DIGEST_A="sha256:$(printf 'a%.0s' {1..64})"
DIGEST_B="sha256:$(printf 'b%.0s' {1..64})"
DIGEST_C="sha256:$(printf 'c%.0s' {1..64})"

# Run botctl and capture its combined output; never let a failure abort the run.
# This file deliberately does NOT run under `set -e`: a test that stops at the
# first failure hides every failure behind it. An earlier version restored
# `set -e` here — turning on an option the file never had — and the whole suite
# ended at the first red assertion.
run_botctl() {
  BOTCTL_OUTPUT="$("$BOTCTL" "$@" 2>&1)"
  BOTCTL_STATUS=$?
  return 0
}

printf 'botctl\n'

# =============================================================================
# Validation — every value that reaches a path or an image reference
# =============================================================================
setup_root
setup_fake_docker
# shellcheck source=../../deploy/bin/nexa-lib.sh
. "$NEXA_LIB"

test_case 'refuses a version containing a path traversal'
# The version becomes a filename under /var/lib/nexa/releases and a tag in an
# image reference. `..` must be impossible by construction, not by stripping.
assert_fails 'accepted ../../etc/passwd' nexa_valid_version '../../etc/passwd'
assert_fails 'accepted a version with a slash' nexa_valid_version 'v1/../../x'
assert_fails 'accepted a version with a dot-dot' nexa_valid_version 'v1..2'
assert_fails 'accepted an empty version' nexa_valid_version ''
assert_fails 'accepted a version with a space' nexa_valid_version 'v1 2'
assert_fails 'accepted a shell metacharacter' nexa_valid_version 'v1;rm -rf /'
assert_fails 'accepted a command substitution' nexa_valid_version 'v$(id)'
assert_ok 'rejected an ordinary version' nexa_valid_version 'v1.2.3'
assert_ok 'rejected a pre-release version' nexa_valid_version '1.2.3-rc.1'

test_case 'refuses a domain that is not a bare hostname'
assert_fails 'accepted a scheme' nexa_valid_domain 'https://admin.example.com'
assert_fails 'accepted a path' nexa_valid_domain 'admin.example.com/panel'
assert_fails 'accepted a port' nexa_valid_domain 'admin.example.com:8443'
assert_fails 'accepted a space' nexa_valid_domain 'admin example.com'
assert_fails 'accepted a bare label' nexa_valid_domain 'localhost'
assert_ok 'rejected a real hostname' nexa_valid_domain 'admin.example.com'

test_case 'refuses a malformed digest'
assert_fails 'accepted a short digest' nexa_valid_digest 'sha256:abc'
assert_fails 'accepted an unprefixed digest' nexa_valid_digest "$(printf 'a%.0s' {1..64})"
assert_fails 'accepted uppercase hex' nexa_valid_digest "sha256:$(printf 'A%.0s' {1..64})"
assert_ok 'rejected a well-formed digest' nexa_valid_digest "$DIGEST_A"

test_case 'a sudo invocation cannot supply botctl its own paths or registry'
# `%ops ALL=(root) NOPASSWD: /usr/local/bin/botctl` is the obvious way to let a
# colleague run an update. With it, `NEXA_LIB=/tmp/mine.sh sudo botctl status`
# executed /tmp/mine.sh as root, and `NEXA_IMAGE_REPO=evil.example sudo botctl
# update v1` pulled the next release from somebody else's registry. sudo's
# env_reset normally strips these, but a security property that holds only
# while somebody else's sudoers file is untouched is not one worth claiming.
printf 'printf pwned\n' >"${NEXA_ROOT}/evil-lib.sh"
# The harness exports several of these itself, so each variable is tested
# alone against an otherwise clean environment — otherwise the loop reports
# whichever one the harness happened to set first.
sudo_botctl() {
  local var="$1" value="$2"
  env -u NEXA_ROOT -u NEXA_DEPLOY_DIR -u NEXA_LIB_DIR -u NEXA_CONFIG_DIR \
    -u NEXA_STATE_DIR -u NEXA_BACKUP_DIR -u NEXA_LOCK_FILE -u NEXA_IMAGE_REPO \
    -u NEXA_BIN_DIR -u NEXA_LIB -u NEXA_IMAGE \
    SUDO_USER=someone "$var=$value" "$BOTCTL" version 2>&1 || true
}
sudo_output="$(sudo_botctl NEXA_LIB "${NEXA_ROOT}/evil-lib.sh")"
assert_not_contains 'a sudo invocation loaded a caller-supplied library' "$sudo_output" 'pwned'
assert_contains 'the refusal did not name NEXA_LIB' "$sudo_output" 'NEXA_LIB is set in the environment'
sudo_output="$(sudo_botctl NEXA_IMAGE_REPO evil.example/nexa)"
assert_contains 'a sudo invocation chose the registry' \
  "$sudo_output" 'NEXA_IMAGE_REPO is set in the environment'
# Every NEXA_* variable, not an enumerated list. The list exempted by omission:
# NEXA_KEEP_RELEASES and NEXA_READY_TIMEOUT are read by the library and were
# not on it, and the next variable added would not have been either.
sudo_output="$(sudo_botctl NEXA_KEEP_RELEASES 0)"
assert_contains 'a variable outside the old list was allowed through' \
  "$sudo_output" 'NEXA_KEEP_RELEASES is set in the environment'
assert_contains 'the operator was not told env_reset is the real defence' \
  "$sudo_output" 'env_reset'

test_case 'a direct root invocation is unaffected'
# The refusal is keyed on SUDO_USER, which is present exactly in the delegated
# case. An operator with a root shell, and this suite, must still work — this
# fixture has no release, so `version` fails, but it must fail for THAT reason.
run_botctl version
assert_not_contains 'a direct invocation hit the sudo refusal' \
  "$BOTCTL_OUTPUT" 'set in the environment'
assert_contains 'a direct invocation failed for the wrong reason' \
  "$BOTCTL_OUTPUT" 'no current release is recorded'

test_case 'the readiness parser answers correctly for every container shape'
# The parser has been rewritten THREE times, and each time the suite could not
# tell the new version from the old one — because the fake docker only ever
# emits shapes the current rule happens to get right. Two inversions shipped
# that way: one preferring an exited one-off over the healthy api, and one
# preferring a RUNNING one-off reporting `starting` over the healthy api beside
# it.
#
# So the rule is tested directly, as a table, against the real embedded Python
# lifted out of the library. Compose builds a one-off from the same service
# config, so a leftover carries the same healthcheck and can report `starting`
# or `unhealthy` — but never `healthy`, because it serves nothing.
parser="${NEXA_ROOT}/parser.py"
python3 - "$NEXA_LIB" "$parser" <<'EXTRACT'
import sys
source = open(sys.argv[1], encoding="utf-8").read()
start = source.index("import json, sys\nraw = sys.stdin.read().strip()")
end = source.index("' 2>/dev/null || true)\"", start)
open(sys.argv[2], "w", encoding="utf-8").write(source[start:end])
EXTRACT
assert_ok 'the readiness parser could not be extracted' test -s "$parser"

# The required list is data the library resolves per wait — the intersection of
# what readiness demands with what the ACTIVE compose file defines — and the
# parser reads it from the environment. Tests set `PARSER_REQUIRED` to model a
# topology; the default is the current one.
# What readiness requires today, stated ONCE and checked against the library.
#
# The blocks below narrow it deliberately to isolate one service at a time, so
# they do not each carry a row for every other service. This guard is what
# stops that from turning into a model of a topology that used to be current:
# the edge joined readiness long after these fixtures were written, and without
# it they would have gone on proving things about the old three-service shape.
# When this fails, the answer is a block of cases for the new service, not a
# new string here.
library_ready_services="$(env -u NEXA_ROOT -u NEXA_STATE_DIR -u NEXA_LOCK_FILE \
  bash -c '. "$1" >/dev/null 2>&1; printf "%s" "$NEXA_READY_SERVICES"' _ "$NEXA_LIB")"
assert_equals 'readiness requires a service these fixtures do not model' \
  'api worker monitor caddy' "$library_ready_services"

# The three application roles. The edge has its own block at the end, where the
# required list is the whole of the library's.
PARSER_REQUIRED='api worker monitor'
parser_says() {
  printf '%b' "$1" | NEXA_REQUIRED_SERVICES="$PARSER_REQUIRED" python3 "$parser"
}
parser_case() {
  local description="$1" expected="$2" shape="$3"
  assert_equals "$description" "$expected" "$(parser_says "$shape")"
  # Both JSON forms. `docker compose ps --format json` emits one object per
  # line on some versions and a single array on others, and the parser must
  # not answer differently depending on which.
  local array
  array="[$(printf '%b' "$shape" | paste -sd, -)]"
  assert_equals "$description (array form)" "$expected" "$(parser_says "$array")"
}

RUN_STARTING='{"Service":"api","State":"running","Health":"starting"}'
RUN_HEALTHY='{"Service":"api","State":"running","Health":"healthy"}'
RUN_UNHEALTHY='{"Service":"api","State":"running","Health":"unhealthy"}'
DEAD_STARTING='{"Service":"api","State":"exited","Health":"starting"}'
# The worker is REQUIRED (C8). Every shape below that expects `healthy` carries
# a healthy worker; the api-only shapes that used to answer healthy now do not,
# and that is the finding: a release whose worker is missing or dead was
# accepted.
WORKER_HEALTHY='{"Service":"worker","State":"running","Health":"healthy"}'
WORKER_STARTING='{"Service":"worker","State":"running","Health":"starting"}'
WORKER_UNHEALTHY='{"Service":"worker","State":"running","Health":"unhealthy"}'
WORKER_EXITED='{"Service":"worker","State":"exited","Health":"unhealthy"}'
WORKER_RESTARTING='{"Service":"worker","State":"restarting"}'
# The monitor is required too, and for a reason the worker's does not cover:
# panel health is written by that process and nowhere else, so an installation
# whose monitor is dead shows every panel's health frozen at its last value —
# a stale answer indistinguishable from a fresh one.
MONITOR_HEALTHY='{"Service":"monitor","State":"running","Health":"healthy"}'
MONITOR_STARTING='{"Service":"monitor","State":"running","Health":"starting"}'
MONITOR_UNHEALTHY='{"Service":"monitor","State":"running","Health":"unhealthy"}'
MONITOR_EXITED='{"Service":"monitor","State":"exited","Health":"unhealthy"}'
MONITOR_RESTARTING='{"Service":"monitor","State":"restarting"}'

parser_case 'a running one-off ahead of the healthy api hides it' \
  healthy "${RUN_STARTING}\n${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}"
parser_case 'order decides the answer' \
  healthy "${RUN_HEALTHY}\n${RUN_STARTING}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}"
parser_case 'an unhealthy api beside a starting one is not healthy' \
  unhealthy "${RUN_UNHEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}"
parser_case 'a corpse beside an api that is still created fast-fails it' \
  created "${DEAD_STARTING}\n{\"Service\":\"api\",\"State\":\"created\"}\n${WORKER_HEALTHY}"
parser_case 'an api that only exited is not waited out' exited "${DEAD_STARTING}\n${WORKER_HEALTHY}"
parser_case 'a dead api is not waited out' dead "{\"Service\":\"api\",\"State\":\"dead\"}\n${WORKER_HEALTHY}"
parser_case 'a restarting api is still coming up' restarting "{\"Service\":\"api\",\"State\":\"restarting\"}\n${WORKER_HEALTHY}"
parser_case 'a running api with no health yet is not healthy' running "{\"Service\":\"api\",\"State\":\"running\"}\n${WORKER_HEALTHY}"
# The rule the previous commit changed, and the one row the table did not have
# — so that commit could not tell its own change from its predecessor. An entry
# with no State at all is not evidence of life; treating "" as alive let one
# malformed entry beside a dead api suppress the fast-fail and burn two full
# readiness timeouts.
NO_STATE='{"Service":"api","Health":"starting"}'
parser_case 'an entry with no State does not suppress the fast-fail' \
  exited "${NO_STATE}\n${DEAD_STARTING}\n${WORKER_HEALTHY}"
parser_case 'a State-less entry after a corpse is not read as life' \
  exited "${DEAD_STARTING}\n${NO_STATE}\n${WORKER_HEALTHY}"

# --- C8: the worker is half of the application -------------------------------
parser_case 'C8: api healthy + worker healthy is ready' \
  healthy "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}"
parser_case 'C8: api healthy + worker STOPPED is not ready, and fast-fails' \
  exited "${RUN_HEALTHY}\n${WORKER_EXITED}\n${MONITOR_HEALTHY}"
parser_case 'C8: api healthy + worker in a crash loop is not ready' \
  restarting "${RUN_HEALTHY}\n${WORKER_RESTARTING}\n${MONITOR_HEALTHY}"
parser_case 'C8: api healthy + worker unhealthy is not ready' \
  unhealthy "${RUN_HEALTHY}\n${WORKER_UNHEALTHY}\n${MONITOR_HEALTHY}"
parser_case 'C8: api healthy + worker still starting is not ready yet' \
  starting "${RUN_HEALTHY}\n${WORKER_STARTING}\n${MONITOR_HEALTHY}"
parser_case 'C8: worker healthy + api unhealthy is not ready' \
  unhealthy "${RUN_UNHEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}"
parser_case 'C8: worker healthy + api dead fast-fails' \
  dead "{\"Service\":\"api\",\"State\":\"dead\"}\n${WORKER_HEALTHY}"
parser_case 'C8: an api alone — the old accepted shape — is not ready' \
  '' "${RUN_HEALTHY}\n"
parser_case 'C8: a worker alone is not ready either' \
  '' "${WORKER_HEALTHY}\n"
parser_case 'C8: a healthy worker one-off beside a dead worker still fast-fails' \
  exited "${RUN_HEALTHY}\n${WORKER_EXITED}\n${MONITOR_HEALTHY}"
parser_case 'C8: a worker one-off reporting starting beside a healthy worker is healthy' \
  healthy "${RUN_HEALTHY}\n${WORKER_STARTING}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}"
# `postgres`, not `caddy`. The edge became a REQUIRED service (D1), so using it
# as the example of an ignored one would have read as a statement about the
# edge that is no longer true — while still passing, because the required list
# this block models does not name it.
parser_case 'C8: a service outside the required list is ignored' \
  healthy "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}\n{\"Service\":\"postgres\",\"State\":\"exited\"}"

# --- 3C: the monitor is the third half of the application --------------------
#
# Panel health has exactly one writer. A release whose api and worker are both
# healthy while its monitor is dead serves every request correctly and stops
# telling the truth about panels — health stays frozen at whatever it was, with
# nothing in the response to say so. So it is required, and each row below
# isolates the monitor: everything else is healthy.
parser_case '3C: api + worker healthy but the monitor STOPPED is not ready, and fast-fails' \
  exited "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_EXITED}"
parser_case '3C: api + worker healthy but the monitor crash-loops is not ready' \
  restarting "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_RESTARTING}"
parser_case '3C: api + worker healthy but the monitor unhealthy is not ready' \
  unhealthy "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_UNHEALTHY}"
parser_case '3C: api + worker healthy but the monitor still starting is not ready yet' \
  starting "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_STARTING}"
parser_case '3C: the previously accepted api + worker shape is no longer ready' \
  '' "${RUN_HEALTHY}\n${WORKER_HEALTHY}"
parser_case '3C: a monitor one-off reporting starting beside a healthy monitor is healthy' \
  healthy "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_STARTING}\n${MONITOR_HEALTHY}"

# The rollback direction, and it is the reason the required list is resolved
# from the compose file rather than hardcoded. Host assets are
# release-versioned: a rollback activates the TARGET release's compose.yml and
# then waits for readiness while this library is still the one in memory. A
# release that predates the monitor defines no such service, and demanding one
# would time out every rollback to it — after the assets had already moved.
PARSER_REQUIRED='api worker'
parser_case '3C: a topology without a monitor is ready on api + worker alone' \
  healthy "${RUN_HEALTHY}\n${WORKER_HEALTHY}"
parser_case '3C: a topology without a monitor still requires its worker' \
  exited "${RUN_HEALTHY}\n${WORKER_EXITED}"
PARSER_REQUIRED='api worker monitor'

# --- D1: the edge is the service an operator meets first ---------------------
#
# Caddy is the only container that publishes a port. A release whose api,
# worker and monitor are all healthy behind an edge that never started is an
# installation nobody can reach, and readiness said READY — it never asked.
#
# Not hypothetical: the edge depends on the Web Admin publisher COMPLETING
# SUCCESSFULLY, so a failed asset publication leaves exactly this shape, and
# the failure has no other symptom. `botctl update` would have accepted it.
CADDY_HEALTHY='{"Service":"caddy","State":"running","Health":"healthy"}'
CADDY_STARTING='{"Service":"caddy","State":"running","Health":"starting"}'
CADDY_UNHEALTHY='{"Service":"caddy","State":"running","Health":"unhealthy"}'
CADDY_EXITED='{"Service":"caddy","State":"exited","Health":"unhealthy"}'
CADDY_RESTARTING='{"Service":"caddy","State":"restarting"}'
APP_HEALTHY="${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}"

PARSER_REQUIRED='api worker monitor caddy'
parser_case 'D1: the whole application healthy behind a STOPPED edge is not ready' \
  exited "${APP_HEALTHY}\n${CADDY_EXITED}"
parser_case 'D1: the whole application healthy behind a crash-looping edge is not ready' \
  restarting "${APP_HEALTHY}\n${CADDY_RESTARTING}"
parser_case 'D1: an unhealthy edge is not ready — the SPA root is part of that check' \
  unhealthy "${APP_HEALTHY}\n${CADDY_UNHEALTHY}"
parser_case 'D1: an edge still starting is not ready yet' \
  starting "${APP_HEALTHY}\n${CADDY_STARTING}"
parser_case 'D1: an edge that never appears at all is not ready' \
  '' "${APP_HEALTHY}"
parser_case 'D1: the whole topology healthy is ready' \
  healthy "${APP_HEALTHY}\n${CADDY_HEALTHY}"
# The rollback direction again, and the reason the list is an intersection: the
# CI topology and any release whose compose does not define an edge must still
# be able to become ready.
PARSER_REQUIRED='api worker monitor'
parser_case 'D1: a topology that defines no edge is ready without one' \
  healthy "${APP_HEALTHY}"

test_case 'the update lock does not live in a world-writable directory'
# Read out of the library with a CLEAN environment, so this asserts the
# DEFAULT and not whatever the harness exported.
default_lock="$(env -u NEXA_ROOT -u NEXA_STATE_DIR -u NEXA_LOCK_FILE \
  bash -c '. "$1" >/dev/null 2>&1; printf "%s" "$NEXA_LOCK_FILE"' _ "$NEXA_LIB")"
assert_equals 'the default lock moved out of the state directory' \
  '/var/lib/nexa/nexa.lock' "$default_lock"
# /var/lock is /run/lock on Ubuntu: mode 1777. A lock there is a local
# denial of service — any user can create the file first and hold flock on
# it, and every later `botctl update` refuses with nothing actually running.
# And the installer would have had to `install -d` a shared host directory,
# which changes its mode.
assert_not_contains 'the lock is under a world-writable directory' "$default_lock" '/var/lock'
assert_fails 'the installer creates a directory under /var/lock' \
  grep -q 'install -d .*var/lock' "${REPO}/deploy/install.sh"

test_case 'an interrupted commit never reports a release it did not start'
# The ordering rule, driven through every interruption point.
#
# A completed commit ends in the same state whichever order the three files are
# written in, so only an interruption can distinguish them — and the earlier
# test could not, which is why reverting to the old order left the suite green.
#
# No hook in the production code: `nexa_write_atomic` is overridden here to
# fail on the Nth call, which is what a power cut looks like from inside
# `nexa_commit_release`.
# BOTH writers are counted. deploy.env is written by `nexa_set_deploy_image`,
# not by `nexa_write_atomic`, so counting only the latter made the one
# interruption that matters — after `current`, before deploy.env — unreachable.
# The buggy ordering `previous; current; deploy.env` survived this test for
# exactly that reason.
nexa_write_atomic_source="$(declare -f nexa_write_atomic)"
eval "nexa_write_atomic_real${nexa_write_atomic_source#nexa_write_atomic}"
assert_ok 'the real writer was not captured' declare -F nexa_write_atomic_real
nexa_set_deploy_image_source="$(declare -f nexa_set_deploy_image)"
eval "nexa_set_deploy_image_real${nexa_set_deploy_image_source#nexa_set_deploy_image}"
assert_ok 'the real image writer was not captured' declare -F nexa_set_deploy_image_real

# `exit`, not `return`: this file runs without `set -e`, so a stub that merely
# returns non-zero lets `nexa_commit_release` carry on to the next write and
# the commit completes anyway — which is why an earlier version of this test
# passed under the OLD write order too. The call below is in a subshell, so
# exiting there is precisely a process killed mid-commit.
commit_writes=0
# SC2317: this body is reached only through `nexa_commit_release`. The override
# happens at runtime, so static analysis cannot see the call — and that
# indirect call is the entire mechanism.
# (A comment line may not BEGIN with the tool's name, or it is parsed as a
# directive rather than as prose.)
# shellcheck disable=SC2317
nexa_write_atomic() {
  commit_writes=$((commit_writes + 1))
  [ "$commit_writes" -le "${COMMIT_ALLOW:-99}" ] || exit 9
  nexa_write_atomic_real "$@"
}
# shellcheck disable=SC2317
nexa_set_deploy_image() {
  commit_writes=$((commit_writes + 1))
  [ "$commit_writes" -le "${COMMIT_ALLOW:-99}" ] || exit 9
  nexa_set_deploy_image_real "$@"
}

seed_release 'v1.0.0' "$DIGEST_A"
for allow in 0 1 2 3; do
  printf 'v1.0.0\n' >"${NEXA_STATE_DIR}/current"
  rm -f "${NEXA_STATE_DIR}/previous"
  set_deploy_image "registry.test/nexa@${DIGEST_A}"
  commit_writes=0
  (COMMIT_ALLOW="$allow" nexa_commit_release v2.0.0 v1.0.0 "registry.test/nexa@${DIGEST_B}") \
    >/dev/null 2>&1 || true

  reported="$(cat "${NEXA_STATE_DIR}/current" 2>/dev/null || printf 'none')"
  started="$(nexa_env_value "${NEXA_CONFIG_DIR}/deploy.env" NEXA_IMAGE)"
  # The invariant. Reporting the OLD release while starting the new one is
  # recoverable by re-running the update. Reporting the NEW release while
  # starting the old one is the state nothing can detect from the inside and
  # every command lies about — and it is exactly what writing `current` first
  # produces.
  if [ "$reported" = "v2.0.0" ]; then
    assert_equals "interrupted after ${allow} writes: reports v2.0.0 but would start something else" \
      "registry.test/nexa@${DIGEST_B}" "$started"
  fi
done
# RESTORED from the saved source, not `unset -f`. Unsetting removes the
# override and leaves nothing behind — the library's original was overwritten
# by the stub, so every later test calling it silently exercised a missing
# function instead.
eval "$nexa_write_atomic_source"
eval "$nexa_set_deploy_image_source"
COMMIT_ALLOW=99

test_case 'a deploy.env rewrite that goes wrong changes nothing'
# `grep -v ... || true` swallowed grep's exit 2 as happily as its exit 1, and
# exit 2 is a read error, an I/O error or ENOSPC. What landed was a deploy.env
# holding only NEXA_IMAGE — no NEXA_DOMAIN, so compose refuses to start
# anything, so the installation could not be started, restarted, updated,
# rolled back, backed up or logged. And the update reported success.
env_file="${NEXA_CONFIG_DIR}/deploy.env"
before="$(cat "$env_file")"
mkdir -p "${NEXA_ROOT}/stub"
printf '#!/bin/sh\nexit 2\n' >"${NEXA_ROOT}/stub/grep"
chmod +x "${NEXA_ROOT}/stub/grep"
(
  # SC2030: modifying PATH only inside this subshell is deliberate — the stub
  # grep must not survive into the rest of the suite.
  # shellcheck disable=SC2030
  PATH="${NEXA_ROOT}/stub:${PATH}"
  nexa_set_deploy_image "registry.test/nexa@${DIGEST_B}"
) >/dev/null 2>&1 && fail_test 'a failed read reported success'
assert_equals 'deploy.env was rewritten from a failed read' "$before" "$(cat "$env_file")"
# The MESSAGE, not just the outcome. Downstream the NEXA_DOMAIN check catches
# this too, so the file is safe either way — but an operator whose /var is full
# is then told "the rewritten deploy.env lost NEXA_DOMAIN", which sends them
# looking in entirely the wrong place.
sudo_probe="$(
  # shellcheck disable=SC2030,SC2031
  PATH="${NEXA_ROOT}/stub:${PATH}"
  (nexa_set_deploy_image "registry.test/nexa@${DIGEST_B}") 2>&1 || true
)"
assert_contains 'the read failure was not diagnosed' "$sudo_probe" 'grep exited 2'
assert_contains 'the operator was not pointed at disk space' "$sudo_probe" 'free space' 
assert_fails 'a temporary file was left behind' \
  test -n "$(find "$NEXA_CONFIG_DIR" -name 'deploy.env.*' -print -quit)"

test_case 'a deploy.env that would not start anything is refused'
# The rename is atomic with respect to other processes. That says nothing about
# whether the CONTENT is usable, which is the part that was never checked.
printf 'NEXA_IMAGE=registry.test/nexa@%s\n' "$DIGEST_A" >"$env_file"
chmod 0600 "$env_file"
# In a subshell: `nexa_die` exits, and this file must survive its own
# failure cases to report them.
(nexa_set_deploy_image "registry.test/nexa@${DIGEST_B}") >/dev/null 2>&1 &&
  fail_test 'accepted a deploy.env with no NEXA_DOMAIN'
printf '%s\n' "$before" >"$env_file"
chmod 0600 "$env_file"

test_case 'readiness ignores a leftover one-off container'
# `docker compose run` containers carry Service == "api", and — because compose
# builds a one-off from the same service config — the same HEALTHCHECK. So the
# corpse reports Health "starting", exactly like an api that is still coming
# up. Neither "the first api entry" nor "the first entry that reports a health"
# can tell them apart; only "is it running" can. Getting this wrong backs out a
# release that is perfectly healthy.
fake_set stale_run 1
assert_ok 'a leftover run container was mistaken for the api' nexa_wait_ready 5
fake_set stale_run 0

test_case 'the installer refuses to be used as an updater'
# It takes no backup, never writes `previous`, and repoints deploy.env at the
# new image before anything is pulled, migrated or started — so a failed
# migration left the old release running and reporting itself as current while
# deploy.env named the new one, and the next reboot started an un-migrated
# image. It also destroyed the rollback relationship silently.
printf 'v1.0.0\n' >"${NEXA_STATE_DIR}/current"
# SOURCED and driven through the one guard, never executed: an installer run
# for real on a build machine would install Docker on it. And the guard is
# called directly rather than through `preflight`, whose FIRST check is that
# the caller is root — CI's runner is not, so going through preflight tested
# the root check and reported this one green.
installer_output="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test --version "$2" >/dev/null 2>&1
  refuse_version_change 2>&1' _ "${REPO}/deploy/install.sh" v2.0.0 || true)"
assert_contains 'the installer did not refuse a version change' \
  "$installer_output" 'the installer is not an updater'
assert_contains 'the refusal did not point at botctl update' \
  "$installer_output" 'botctl update v2.0.0'

test_case 'the installer accepts a rerun of the version it already installed'
# Idempotency is the documented behaviour and it must survive the guard above.
# It gets past the version check and fails later, on something else.
installer_output="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test --version "$2" >/dev/null 2>&1
  refuse_version_change 2>&1' _ "${REPO}/deploy/install.sh" v1.0.0 || true)"
assert_not_contains 'a rerun of the same version was refused' \
  "$installer_output" 'the installer is not an updater'

test_case 'a rerun of the same version is refused when its tag has been moved'
# The version guard above compares STRINGS, and a version is a tag. If v1.0.0
# has been repointed at different bytes — a mirror, a private registry, a
# compromised one — a rerun resolves the new digest, rewrites deploy.env and
# migrates and starts it: the unannounced update the guard exists to prevent,
# under a name that made it look like a no-op.
nexa_write_manifest 'v1.0.0' 'c0ffee' "$DIGEST_A"
digest_probe() {
  bash -c '
    . "$1" --domain admin.example.test --acme-email ops@example.test --version v1.0.0 >/dev/null 2>&1
    refuse_digest_change "$2" 2>&1' _ "${REPO}/deploy/install.sh" "$2"
}
installer_output="$(digest_probe _ "$DIGEST_B" || true)"
assert_contains 'a moved tag was accepted as a rerun' \
  "$installer_output" 'that tag has been moved'
assert_contains 'the refusal did not name the digest now recorded' \
  "$installer_output" "$DIGEST_A"

test_case 'a rerun of the same version and the same digest is still accepted'
# The guard must not turn idempotency off: an interrupted install rerun by the
# operator resolves the SAME digest and has to get through.
installer_output="$(digest_probe _ "$DIGEST_A" || true)"
assert_not_contains 'an unchanged digest was refused' \
  "$installer_output" 'that tag has been moved'

test_case 'the installer actually calls the moved-tag refusal'
# The rule above is only reachable if the installer calls it, and the probe
# calls it directly — so deleting the call site left both tests green. This is
# the check that notices. It must run AFTER the digest is resolved (there is
# nothing to compare before) and BEFORE deploy.env is rewritten (which is the
# act being refused).
installer_flow="$(sed -n '/nexa_resolve_digest "\$VERSION"/,/write_deploy_env/p' "${REPO}/deploy/install.sh")"
assert_contains 'nothing calls refuse_digest_change between resolving the digest and writing deploy.env' \
  "$installer_flow" 'refuse_digest_change "$digest"'

rm -f "${NEXA_STATE_DIR}/current"

# ---------------------------------------------------------------------------
# The interruption that a real Ubuntu 24.04 staging host produced.
#
# The owner is committed several steps before the release manifest and the
# `current` pointer are written. That install stopped in the gap — the bootstrap
# CLI created the owner, printed that it had, and then never exited — leaving a
# HEALTHY installation whose `botctl version` said "no current release is
# recorded" permanently, because the documented remedy is a rerun and a rerun
# died at `bootstrap_owner` with BOOTSTRAP_ALREADY_DONE.
# ---------------------------------------------------------------------------
bootstrap_probe() {
  bash -c '
    . "$1" --domain admin.example.test --acme-email ops@example.test --version v1.0.0 >/dev/null 2>&1
    bootstrap_owner 2>&1
    printf "EXIT=%s\n" "$?"' _ "${REPO}/deploy/install.sh"
}

# The same, with --skip-owner. A separate driver rather than a flag, because the
# installer reads SKIP_OWNER while being SOURCED and the two invocations differ
# only in that argument.
skip_owner_probe() {
  bash -c '
    . "$1" --domain admin.example.test --acme-email ops@example.test --version v1.0.0 --skip-owner >/dev/null 2>&1
    bootstrap_owner 2>&1
    printf "EXIT=%s\n" "$?"' _ "${REPO}/deploy/install.sh"
}

# ---------------------------------------------------------------------------
# --skip-owner says "do not create one", not "there is not one".
#
# Real-VPS acceptance found the installer telling an operator that nobody could
# log in, on an installation that had a working owner — and pointing them at a
# bootstrap command that would have refused them. The warning is true on a fresh
# host and false on a rerun, so it is now conditional on the same owner state
# every other decision here uses.
# ---------------------------------------------------------------------------
test_case 'skip-owner on a fresh installation still warns that nobody can log in'
fake_set owner_state none
probe="$(skip_owner_probe)"
assert_contains 'the fresh-host warning was lost' "$probe" 'Nobody can log in'
assert_contains 'the operator was not told how to bootstrap' "$probe" 'bootstrap-owner.cli.js'
assert_contains 'skip-owner did not succeed on a fresh host' "$probe" 'EXIT=0'

test_case 'skip-owner on a bootstrapped installation says so, and does not lie'
fake_set owner_state bootstrapped
reset_docker_log
probe="$(skip_owner_probe)"
assert_contains 'the truthful message is missing' \
  "$probe" 'an existing owner is already present'
assert_not_contains 'the installer claimed nobody could log in when an owner exists' \
  "$probe" 'Nobody can log in'
assert_contains 'skip-owner did not succeed on a bootstrapped host' "$probe" 'EXIT=0'
# And it still created nothing: the only bootstrap-owner invocation is the read.
assert_not_contains 'skip-owner ran the bootstrap CLI' \
  "$(docker_log | grep -F 'bootstrap-owner.cli.js' | grep -vF -- '--status' || true)" \
  'bootstrap-owner.cli.js'

test_case 'skip-owner fails closed on a foreign database, exactly as bootstrap does'
# The refusal must not be softer just because --skip-owner was passed, and it
# must terminate the installer rather than print in red and carry on: `nexa_die`
# calls `exit`, and an `exit` inside `$( )` would end only the substitution.
fake_set owner_state foreign
probe="$(skip_owner_probe)"
assert_contains 'a foreign database was skipped past instead of refused' \
  "$probe" 'did not create'
assert_fails 'the installer continued past a foreign database under --skip-owner' \
  test "${probe#*EXIT=}" -eq 0

test_case 'skip-owner fails closed on an unreadable owner state'
fake_set owner_state_exit 1
probe="$(skip_owner_probe)"
assert_contains 'an unreadable owner state was guessed at under --skip-owner' \
  "$probe" 'could not determine whether'
assert_fails 'the installer continued past an unreadable state under --skip-owner' \
  test "${probe#*EXIT=}" -eq 0
fake_set owner_state_exit 0

test_case 'a rerun after a successful bootstrap continues instead of dying'
fake_set owner_state bootstrapped
reset_docker_log
probe="$(bootstrap_probe)"
assert_contains 'the rerun did not recognise its own completed bootstrap' \
  "$probe" 'already exists from an earlier run'
assert_contains 'the rerun did not succeed' "$probe" 'EXIT=0'
# And it asked nobody for a password: the only bootstrap-owner invocation is the
# read. An interactive `run` here would be a second prompt for a credential the
# installation already has.
assert_not_contains 'the installer prompted for an owner it had already created' \
  "$(docker_log | grep -F 'bootstrap-owner.cli.js' | grep -vF -- '--status' || true)" \
  'bootstrap-owner.cli.js'

test_case 'a database administered by somebody else is refused, not adopted'
# The fence this must never become: "there is an administrator, so the bootstrap
# must have worked". An administered database with no record of THIS
# installation bootstrapping it is not a rerun — it is somebody else's data, and
# writing a release manifest for it would attach this host's release identity
# to it.
fake_set owner_state foreign
probe="$(bootstrap_probe)"
assert_contains 'a foreign administered database was adopted' \
  "$probe" 'did not create'
assert_fails 'the installer continued past a foreign database' \
  test "${probe#*EXIT=}" -eq 0

test_case 'an unreadable owner state is refused rather than guessed'
# Both guesses are wrong: creating an owner would be a second one, and skipping
# would leave an installation nobody can log in to.
fake_set owner_state_exit 1
probe="$(bootstrap_probe)"
assert_contains 'an unreadable owner state was guessed at' \
  "$probe" 'could not determine whether'
fake_set owner_state_exit 0

test_case 'a fresh installation still bootstraps normally'
fake_set owner_state none
reset_docker_log
probe="$(bootstrap_probe)"
assert_contains 'a fresh install did not create the first owner' "$probe" 'first owner created'
assert_contains 'the bootstrap CLI was never run' \
  "$(docker_log)" 'bootstrap-owner.cli.js'

test_case 'the recognised rerun reaches the release-state commit'
# The behavioural tests above prove `bootstrap_owner` returns 0. This is what
# makes that worth anything: main() writes the manifest and `current` AFTER it,
# so a rerun that gets past it is a rerun that finishes recording the release.
installer_tail="$(sed -n '/^  bootstrap_owner$/,/NEXA_CURRENT_FILE/p' "${REPO}/deploy/install.sh")"
assert_contains 'the manifest is not written after the owner step' \
  "$installer_tail" 'nexa_write_manifest'
assert_contains 'the current pointer is not written after the owner step' \
  "$installer_tail" 'NEXA_CURRENT_FILE'

test_case 'a truncated secret file is not mistaken for a finished one'
# `[ -s "$file" ]` blessed a postgres.env with a user and a database and no
# password, and a nexa.env truncated part-way — which is exactly what ENOSPC or
# EIO during the write leaves, because `set -e` aborts with the partial file
# already under its final name. The install then proceeded: Postgres cannot
# initialise without a password and sat out the entire 180s health wait, a long
# way from the cause.
secrets_probe() {
  bash -c '
    . "$1" --domain admin.example.test --acme-email ops@example.test --version v1.0.0 >/dev/null 2>&1
    generate_secrets 2>&1' _ "${REPO}/deploy/install.sh"
}
printf 'POSTGRES_USER=nexa\nPOSTGRES_DB=nexa\n' >"${NEXA_CONFIG_DIR}/postgres.env"
printf 'REDIS_PASSWORD=x\n' >"${NEXA_CONFIG_DIR}/redis.env"
write_full_app_env() {
  cat >"${NEXA_CONFIG_DIR}/nexa.env" <<'ENV'
SECRETS_KEYS=install-1:k
SECRETS_ACTIVE_KEY_ID=install-1
DATABASE_URL=d
REDIS_URL=r
WEB_ADMIN_ORIGINS=https://admin.example.test
DEPLOYMENT_TOPOLOGY=single-host
NOTIFICATION_TRANSPORT=telegram
ENV
}

# The same file as an installation made BEFORE the keyring release still has it.
write_legacy_app_env() {
  cat >"${NEXA_CONFIG_DIR}/nexa.env" <<'ENV'
SECRETS_KEK=k
SECRETS_KEK_ID=i
DATABASE_URL=d
REDIS_URL=r
WEB_ADMIN_ORIGINS=https://admin.example.test
DEPLOYMENT_TOPOLOGY=single-host
NOTIFICATION_TRANSPORT=telegram
ENV
}
write_full_app_env
probe="$(secrets_probe || true)"
assert_not_contains 'a postgres.env with no password was accepted as complete' \
  "$probe" 'secrets already exist'
assert_contains 'the operator was not told the configuration is incomplete' \
  "$probe" 'incomplete'

test_case 'a nexa.env truncated two thirds of the way through is not complete'
# The keys the check used to look for all sit in the FIRST HALF of a 76-line
# template, so a write that died late satisfied every one of them. Losing
# DEPLOYMENT_TOPOLOGY is the dangerous one: it has a schema default, so its
# absence silently stops TRUSTED_PROXY_IPS being required and the API boots
# ignoring X-Forwarded-For.
printf 'POSTGRES_USER=nexa\nPOSTGRES_DB=nexa\nPOSTGRES_PASSWORD=p\n' >"${NEXA_CONFIG_DIR}/postgres.env"
printf 'SECRETS_KEYS=install-1:k\nSECRETS_ACTIVE_KEY_ID=install-1\nDATABASE_URL=d\nREDIS_URL=r\n' >"${NEXA_CONFIG_DIR}/nexa.env"
probe="$(secrets_probe || true)"
assert_not_contains 'a truncated nexa.env was accepted as complete' \
  "$probe" 'secrets already exist'

test_case 'a value that is only whitespace is not a value'
write_full_app_env
printf 'POSTGRES_USER=nexa\nPOSTGRES_DB=nexa\nPOSTGRES_PASSWORD=   \n' >"${NEXA_CONFIG_DIR}/postgres.env"
probe="$(secrets_probe || true)"
assert_not_contains 'a whitespace-only password was accepted' "$probe" 'secrets already exist'

test_case 'an installation made before the keyring release is still complete'
# The regression this exists to stop: after `secrets_complete` was taught the
# new key names, a rerun on a host whose nexa.env still says SECRETS_KEK decided
# its own configuration was half-written and refused to continue. An installer
# that breaks the installations it already made is worse than one that cannot
# adopt a new format.
write_legacy_app_env
printf 'POSTGRES_USER=nexa\nPOSTGRES_DB=nexa\nPOSTGRES_PASSWORD=p\n' >"${NEXA_CONFIG_DIR}/postgres.env"
printf 'REDIS_PASSWORD=r\n' >"${NEXA_CONFIG_DIR}/redis.env"
probe="$(secrets_probe || true)"
assert_contains 'a legacy single-KEK installation was called incomplete' \
  "$probe" 'secrets already exist'
write_full_app_env

test_case 'a complete set of secrets is left alone'
printf 'POSTGRES_USER=nexa\nPOSTGRES_DB=nexa\nPOSTGRES_PASSWORD=p\n' >"${NEXA_CONFIG_DIR}/postgres.env"
probe="$(secrets_probe || true)"
assert_contains 'a complete configuration was not recognised' "$probe" 'secrets already exist'
rm -f "${NEXA_CONFIG_DIR}/postgres.env" "${NEXA_CONFIG_DIR}/redis.env" "${NEXA_CONFIG_DIR}/nexa.env"

test_case 'reads a config value without executing the file'
# `source` would run this. A maintenance CLI that executes its own
# configuration is one editing mistake away from being a shell injection.
printf 'INNOCENT=value\nEVIL=$(touch %s/pwned)\n' "$NEXA_ROOT" >"${NEXA_ROOT}/probe.env"
value="$(nexa_env_value "${NEXA_ROOT}/probe.env" INNOCENT)"
assert_equals 'did not read a plain value' 'value' "$value"
nexa_env_value "${NEXA_ROOT}/probe.env" EVIL >/dev/null 2>&1 || true
assert_fails 'the config file was EXECUTED' test -e "${NEXA_ROOT}/pwned"

teardown_root

# =============================================================================
# version and status
# =============================================================================
setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"

test_case 'version reports the release identity and no secrets'
run_botctl version
assert_equals 'version exited non-zero' 0 "$BOTCTL_STATUS"
assert_contains 'no version' "$BOTCTL_OUTPUT" 'v1.0.0'
assert_contains 'no commit' "$BOTCTL_OUTPUT" 'c0ffee'
assert_contains 'no digest' "$BOTCTL_OUTPUT" "$DIGEST_A"
assert_not_contains 'leaked the database password' "$BOTCTL_OUTPUT" 'not-a-real-password'

test_case 'status reports readiness without dumping the environment'
run_botctl status
assert_contains 'status did not report the version' "$BOTCTL_OUTPUT" 'v1.0.0'
assert_contains 'status did not report readiness' "$BOTCTL_OUTPUT" 'ready'
assert_not_contains 'status leaked the database password' "$BOTCTL_OUTPUT" 'not-a-real-password'
assert_not_contains 'status leaked a KEK' "$BOTCTL_OUTPUT" 'SECRETS_KEK'

test_case 'status reports NOT READY when the api is unhealthy'
fake_set api_health 'starting'
run_botctl status
assert_contains 'an unhealthy api was reported as ready' "$BOTCTL_OUTPUT" 'NOT READY'
assert_fails 'status exited zero with an unhealthy api' test "$BOTCTL_STATUS" -eq 0
fake_set api_health 'healthy'

test_case 'an inherited NEXA_IMAGE does not decide which image compose starts'
# Compose gives a process-environment variable precedence over `--env-file`, so
# before botctl cleared it, `NEXA_IMAGE=other botctl restart` started `other`
# while `botctl version` and `botctl status` — which read deploy.env — reported
# agreement. The divergence check was blind to precisely the disagreement it
# exists to find. deploy.env is the installation's image; a caller does not get
# to substitute one.
reset_docker_log
NEXA_IMAGE="registry.test/evil@${DIGEST_C}" run_botctl restart
assert_equals 'restart exited non-zero' 0 "$BOTCTL_STATUS"
assert_not_contains 'compose was given the image from the caller environment' \
  "$(docker_log)" 'registry.test/evil'
assert_contains 'compose was not given the image from deploy.env' \
  "$(docker_log)" "[image=registry.test/nexa@${DIGEST_A}]"

teardown_root

# =============================================================================
# backup
# =============================================================================
setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"

test_case 'backup writes a timestamped 0600 dump and verifies it'
run_botctl backup
assert_equals 'backup failed' 0 "$BOTCTL_STATUS"
backup_file="$(find "$NEXA_BACKUP_DIR" -name 'nexa-v1.0.0-*.sql.gz' -print -quit)"
assert_ok 'no backup file was written' test -n "$backup_file"
if [ -n "$backup_file" ]; then
  assert_file_mode 'the backup is not 0600' "$backup_file" '600'
  assert_ok 'the backup is not valid gzip' gzip -t "$backup_file"
fi
assert_file_mode 'the backup directory is not 0700' "$NEXA_BACKUP_DIR" '700'
assert_not_contains 'the backup log leaked a password' "$BOTCTL_OUTPUT" 'not-a-real-password'

test_case 'a dump of an empty database is refused'
# The dangerous case, and the one a size check alone cannot catch: pg_dump
# against a database that exists and has no tables produces about a kilobyte of
# SET statements and comments, ends with the completion marker, and looks
# entirely normal. It is a backup of the wrong thing.
fake_set empty_dump 1
rm -f "$NEXA_BACKUP_DIR"/*.sql.gz
run_botctl backup
assert_fails 'an empty-database dump was accepted' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the refusal did not name the real problem' "$BOTCTL_OUTPUT" 'no tables'
assert_equals 'an empty dump was kept' '' "$(find "$NEXA_BACKUP_DIR" -name '*.sql.gz*' -print -quit)"
fake_set empty_dump 0

test_case 'a failed dump is loud and leaves no file behind'
fake_set exec_exit 1
rm -f "$NEXA_BACKUP_DIR"/*.sql.gz
run_botctl backup
assert_fails 'a failed backup exited zero' test "$BOTCTL_STATUS" -eq 0
assert_contains 'a failed backup was not reported' "$BOTCTL_OUTPUT" 'FAILED'
leftover="$(find "$NEXA_BACKUP_DIR" -name '*.sql.gz*' -print -quit)"
assert_equals 'a failed backup left a file behind' '' "$leftover"
fake_set exec_exit 0

teardown_root

# =============================================================================
# update — the success path, and what it asked Docker to do
# =============================================================================
setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"
fake_set resolve_digest "$DIGEST_B"

test_case 'update resolves, pulls by digest, backs up, migrates and activates'
reset_docker_log
run_botctl update v2.0.0
assert_equals 'the update failed' 0 "$BOTCTL_STATUS"
log="$(docker_log)"

assert_contains 'never resolved the tag to a digest' "$log" 'imagetools inspect registry.test/nexa:v2.0.0'
assert_contains 'did not pull by digest' "$log" "pull --quiet registry.test/nexa@${DIGEST_B}"
assert_contains 'did not run the migrator' "$log" 'dist/infrastructure/persistence/migrate.js'

# The migration must run from the TARGET release's own image. Running the
# outgoing release's migrator would apply the schema the outgoing code expects,
# which is the wrong schema by definition.
migrate_line="$(printf '%s\n' "$log" | grep 'migrate.js' | sed -n '1p')"
assert_contains 'the migration did not run --no-deps' "$migrate_line" '--no-deps'

# NEVER git. The legacy updater is `git pull`, and this checkpoint exists
# because that cannot be reasoned about or undone.
assert_not_contains 'the update shelled out to git' "$log" 'git '

test_case 'the new release becomes current and the old one becomes the rollback target'
assert_equals 'current was not advanced' 'v2.0.0' "$(cat "${NEXA_STATE_DIR}/current")"
assert_equals 'previous was not recorded' 'v1.0.0' "$(cat "${NEXA_STATE_DIR}/previous")"
assert_ok 'the previous release manifest was deleted' test -f "${NEXA_STATE_DIR}/releases/v1.0.0.json"
assert_equals 'deploy.env does not name the new digest' \
  "registry.test/nexa@${DIGEST_B}" \
  "$(nexa_env_value "${NEXA_CONFIG_DIR}/deploy.env" NEXA_IMAGE)"
assert_file_mode 'deploy.env lost its restrictive mode' "${NEXA_CONFIG_DIR}/deploy.env" '600'

test_case 'the update records a manifest for the release it activated'
# The three facts that identify a release must be recorded by the update, not
# only by the installer. Without this, an updated installation has a `current`
# pointer to a release with no manifest: `botctl version` reports `unknown`,
# and the NEXT update makes that release the rollback target — so `rollback`
# then refuses, because it will not guess what a release ran. That is how a
# working rollback disappears on the second update rather than the first.
target_manifest="${NEXA_STATE_DIR}/releases/v2.0.0.json"
assert_ok 'the update wrote no manifest for the release it activated' test -f "$target_manifest"
assert_equals 'the manifest does not record the activated digest' \
  "$DIGEST_B" "$(manifest_field v2.0.0 digest)"
assert_equals 'the manifest does not record the version' \
  'v2.0.0' "$(manifest_field v2.0.0 version)"
# Read out of the image's OCI label, not assumed: the fake image is labelled
# `cafebabe`. A manifest that records a commit nobody can check is decoration.
assert_equals 'the manifest does not record the commit from the image' \
  'cafebabe' "$(manifest_field v2.0.0 commit)"

test_case 'botctl version reports the release the update installed'
run_botctl version
assert_equals 'version failed after an update' 0 "$BOTCTL_STATUS"
assert_contains 'version does not report the new release' "$BOTCTL_OUTPUT" 'v2.0.0'
assert_contains 'version does not report the commit' "$BOTCTL_OUTPUT" 'cafebabe'
assert_contains 'version does not report the digest' "$BOTCTL_OUTPUT" "$DIGEST_B"
assert_not_contains 'version reports an unknown fact after an update' "$BOTCTL_OUTPUT" 'unknown'

test_case "the update's backup names both releases"
# It is taken after v1.0.0's schema and before v2.0.0's. A file named for
# either one alone is a claim about which schema it holds that nobody can
# check later — and `botctl backup` takes no lock, so this dump really can be
# the one an operator reaches for.
dump="$(find "$NEXA_BACKUP_DIR" -name '*.sql.gz' -print -quit)"
assert_contains 'the backup does not name the outgoing release' "$dump" 'v1.0.0'
assert_contains 'the backup does not name the incoming release' "$dump" 'v2.0.0'

test_case 'a backup was taken before the migration'
# Order matters: the backup must precede the migration, because the migration
# is the step that switching an image back cannot undo.
backup_at="$(printf '%s\n' "$log" | grep -n 'exec -T postgres pg_dump' | sed -n '1p' | cut -d: -f1)"
migrate_at="$(printf '%s\n' "$log" | grep -n 'migrate.js' | sed -n '1p' | cut -d: -f1)"
assert_ok 'no backup was taken during the update' test -n "$backup_at"
assert_ok 'the migration ran before the backup' test "${backup_at:-9999}" -lt "${migrate_at:-0}"

teardown_root

# =============================================================================
# update — every failure state leaves the current release alone
# =============================================================================

# --- the target cannot be resolved -------------------------------------------
setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"
test_case 'an unresolvable target leaves the current release current'
fake_set resolve_exit 1
run_botctl update v2.0.0
assert_fails 'an unresolvable update exited zero' test "$BOTCTL_STATUS" -eq 0
assert_equals 'current changed on a failed resolve' 'v1.0.0' "$(cat "${NEXA_STATE_DIR}/current")"
assert_fails 'a rollback target was invented' test -f "${NEXA_STATE_DIR}/previous"
teardown_root

# --- the target cannot be pulled ---------------------------------------------
setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"
test_case 'an unpullable target leaves the current release current'
fake_set resolve_digest "$DIGEST_B"
fake_set pull_exit 1
reset_docker_log
run_botctl update v2.0.0
assert_fails 'an unpullable update exited zero' test "$BOTCTL_STATUS" -eq 0
assert_equals 'current changed on a failed pull' 'v1.0.0' "$(cat "${NEXA_STATE_DIR}/current")"
# And nothing destructive happened first.
assert_not_contains 'migrated despite a failed pull' "$(docker_log)" 'migrate.js'
teardown_root

# --- the backup fails ---------------------------------------------------------
setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"
test_case 'a failed backup stops the update before it migrates'
fake_set resolve_digest "$DIGEST_B"
fake_set exec_exit 1
reset_docker_log
run_botctl update v2.0.0
assert_fails 'the update proceeded after a failed backup' test "$BOTCTL_STATUS" -eq 0
assert_equals 'current changed after a failed backup' 'v1.0.0' "$(cat "${NEXA_STATE_DIR}/current")"
assert_not_contains 'MIGRATED after a failed backup' "$(docker_log)" 'migrate.js'
# The UPDATE's own message, not just the backup's. Deleting the guard in
# cmd_update left every other assertion here green, because cmd_backup exits
# on its own — so the operator was told the backup failed and never told the
# update had been abandoned. This is the assertion that fails without it.
assert_contains 'the operator was not told the update was abandoned' \
  "$BOTCTL_OUTPUT" 'the update did NOT proceed'
teardown_root

# --- the migration fails ------------------------------------------------------
setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"
test_case 'a failed migration does not let the target become current'
fake_set resolve_digest "$DIGEST_B"
fake_set run_exit 1
run_botctl update v2.0.0
assert_fails 'a failed migration exited zero' test "$BOTCTL_STATUS" -eq 0
assert_equals 'a failed migration still advanced current' 'v1.0.0' "$(cat "${NEXA_STATE_DIR}/current")"
assert_contains 'the failure did not name the migration' "$BOTCTL_OUTPUT" 'migration'
# The operator is told where the pre-migration backup is.
assert_contains 'the failure did not point at the backup' "$BOTCTL_OUTPUT" 'backup'
teardown_root

# --- the target starts but never becomes ready --------------------------------
setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"
test_case 'a target that never becomes ready does not become current'
fake_set resolve_digest "$DIGEST_B"
# ONLY the target is unhealthy. That distinction is the whole test: with one
# global health value the previous release could not come back either, so this
# landed on the panic branch ("NEITHER came back cleanly") and silently proved
# something else. The branch below is the one docs/deployment.md promises —
# "The previous release is restarted; it remains current" — and it had no
# coverage at all.
fake_set "api_health_${DIGEST_B}" 'starting'
# The readiness wait is bounded; shorten it so the test is not.
NEXA_READY_TIMEOUT=6 run_botctl update v2.0.0
assert_fails 'an unready target exited zero' test "$BOTCTL_STATUS" -eq 0
assert_equals 'an unready target became current' 'v1.0.0' "$(cat "${NEXA_STATE_DIR}/current")"
assert_equals 'deploy.env was repointed at an unready release' \
  "registry.test/nexa@${DIGEST_A}" \
  "$(nexa_env_value "${NEXA_CONFIG_DIR}/deploy.env" NEXA_IMAGE)"
# The documented outcome, in the operator's words, not the panic one.
assert_contains 'the operator was not told the previous release came back' \
  "$BOTCTL_OUTPUT" 'is running again and is still the current release'
assert_not_contains 'the back-out landed on the panic branch' \
  "$BOTCTL_OUTPUT" 'did not come back cleanly'

test_case 'a target that will not start is backed out, and the back-out is verified'
fake_set "up_exit_${DIGEST_B}" 1
NEXA_READY_TIMEOUT=6 run_botctl update v2.0.0
fake_set "up_exit_${DIGEST_B}" 0
assert_fails 'a target that would not start exited zero' test "$BOTCTL_STATUS" -eq 0
assert_equals 'a target that would not start became current' 'v1.0.0' "$(cat "${NEXA_STATE_DIR}/current")"
# `up -d` returning zero says containers were created, not that the application
# works. The message used to say "is running again" on that basis alone, which
# is a reassuring thing to read about an installation that is down.
assert_contains 'the back-out was not verified before being announced' \
  "$BOTCTL_OUTPUT" 'is ready'

test_case 'a back-out that does NOT come back is reported as the emergency it is'
# The case that distinguishes the two branches, and the reason the earlier
# assertion could not fail: `is ready` is a substring of the reassuring
# message, which is printed whenever `compose up` returns zero — with or
# without the readiness check. Only a previous release that starts and is NOT
# ready tells the two apart.
fake_set "up_exit_${DIGEST_B}" 1
fake_set api_health 'starting'
NEXA_READY_TIMEOUT=6 run_botctl update v2.0.0
fake_set "up_exit_${DIGEST_B}" 0
fake_set api_health 'healthy'
assert_fails 'a failed back-out exited zero' test "$BOTCTL_STATUS" -eq 0
assert_contains 'an unhealthy back-out was announced as recovered' \
  "$BOTCTL_OUTPUT" 'did not come back cleanly'
assert_not_contains 'an unhealthy back-out claimed readiness' "$BOTCTL_OUTPUT" 'is ready'

test_case 'a readiness back-out that does not come back is reported too'
# The step-6 counterpart: the target starts but never becomes ready, and
# neither does the release it falls back to.
fake_set api_health 'starting'
fake_set "api_health_${DIGEST_B}" 'starting'
NEXA_READY_TIMEOUT=6 run_botctl update v2.0.0
fake_set api_health 'healthy'
fake_set "api_health_${DIGEST_B}" 'healthy'
assert_fails 'a failed readiness back-out exited zero' test "$BOTCTL_STATUS" -eq 0
assert_contains 'an unhealthy readiness back-out was announced as recovered' \
  "$BOTCTL_OUTPUT" 'did not come back cleanly'

test_case 'a post-migration back-out says the database was NOT reverted'
# The most dangerous moment in the whole flow. The migration has run, so the
# schema has already moved; the application is being put back. An operator who
# reads "reverted to v1.0.0" and assumes the database went with it will reach
# for the backup — which predates the migration and would discard every write
# since. They have to be told, at the moment it happens, that reverting the
# database is a separate and destructive step.
fake_set "api_health_${DIGEST_B}" 'starting'
NEXA_READY_TIMEOUT=6 run_botctl update v2.0.0
fake_set "api_health_${DIGEST_B}" 'healthy'
assert_fails 'an unready target exited zero' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the operator was not told the migration already ran' \
  "$BOTCTL_OUTPUT" 'ALREADY RAN'
assert_contains 'the operator was not told the database is not reverted' \
  "$BOTCTL_OUTPUT" 'DATABASE IS NOT REVERTED'
assert_contains 'the operator was not warned about restoring the backup' \
  "$BOTCTL_OUTPUT" 'discard every write made since'
# It came back, so saying so is correct HERE.
assert_contains 'the successful back-out did not say the application was reverted' \
  "$BOTCTL_OUTPUT" 'APPLICATION has been reverted'

test_case 'a post-migration back-out that FAILS does not claim a revert'
# The panic branch, and the one place wording matters most: the migration has
# run, the target will not start, AND the previous release did not come back.
# Telling an operator "Nexa has reverted the application" here — while the next
# line says it did not come back cleanly — is a contradiction at the exact
# moment they are deciding whether to restore a backup that would discard every
# write since the update.
fake_set api_health 'starting'
fake_set "api_health_${DIGEST_B}" 'starting'
NEXA_READY_TIMEOUT=6 run_botctl update v2.0.0
fake_set api_health 'healthy'
fake_set "api_health_${DIGEST_B}" 'healthy'
assert_fails 'a stranded update exited zero' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the stranded operator was not told the database is untouched' \
  "$BOTCTL_OUTPUT" 'DATABASE IS NOT REVERTED'
assert_contains 'the stranded operator was not told nothing was reverted' \
  "$BOTCTL_OUTPUT" 'NOTHING has been reverted'
assert_not_contains 'a failed back-out claimed the application was reverted' \
  "$BOTCTL_OUTPUT" 'APPLICATION has been reverted'

test_case 'a target that dies is backed out without waiting out the timeout'
# An api container that EXITED is not listed by `docker compose ps` without
# --all, so the readiness parse yielded nothing, that read as "not ready yet",
# and the update waited out the whole timeout — twice, counting the back-out's
# own wait — for a container that was already gone.
#
# The corpse reports Health "starting", because Docker retains the last health
# status after a container exits. A parser that reads health before state
# therefore sees "starting" and keeps waiting; only one that asks "is anything
# RUNNING" sees that the answer is no.
fake_set api_gone 1
started="$(date +%s)"
NEXA_READY_TIMEOUT=60 run_botctl update v2.0.0
elapsed=$(( $(date +%s) - started ))
fake_set api_gone 0
assert_fails 'a dead target exited zero' test "$BOTCTL_STATUS" -eq 0
assert_equals 'a dead target became current' 'v1.0.0' "$(cat "${NEXA_STATE_DIR}/current")"
assert_ok 'the update waited out the readiness timeout for a dead container' \
  test "$elapsed" -lt 30
teardown_root

# =============================================================================
# an interrupted commit is visible, not silent
# =============================================================================
setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"

test_case 'the commit writes what RUNS before what is REPORTED'
# The ordering rule, asserted rather than described. deploy.env decides what a
# restart or a reboot starts; `current` decides what every command says. If
# `current` is written first, an interruption between them leaves the tool
# reporting the new release while quietly starting the old one — and no test
# could see that until the fake started resolving its image from deploy.env
# the way the real client does.
reset_docker_log
fake_set resolve_digest "$DIGEST_B"
run_botctl update v2.0.0
assert_equals 'the update failed' 0 "$BOTCTL_STATUS"
reset_docker_log
run_botctl restart
assert_equals 'restart failed' 0 "$BOTCTL_STATUS"
assert_contains 'a restart did not start the release the update committed' \
  "$(docker_log)" "$DIGEST_B"
assert_not_contains 'a restart started the release the update replaced' \
  "$(docker_log)" "$DIGEST_A"

test_case 'a recorded release that disagrees with deploy.env is REPORTED'
# The state a power cut in the middle of the commit block leaves. It used to be
# undetectable: `version` reads the manifests, `status` reads the containers,
# and neither reads what compose would actually start. So `botctl version`
# answered with one release while `botctl restart` started another — against a
# schema that had already been migrated for the first.
seed_release 'v2.0.0' "$DIGEST_B"
printf 'v1.0.0\n' >"${NEXA_STATE_DIR}/current"
set_deploy_image "registry.test/nexa@${DIGEST_B}"
run_botctl version
assert_fails 'a divergent installation reported success' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the divergence was not named' "$BOTCTL_OUTPUT" 'DIVERGENCE'
assert_contains 'the operator was not told what would actually start' \
  "$BOTCTL_OUTPUT" "$DIGEST_B"
# The RELEASE that would start, not just its digest — and therefore advice that
# does something. Naming the CURRENT version here made the advice a guaranteed
# no-op: `botctl update <current>` short-circuits with "already running".
assert_contains 'the advice does not name the release that would start' \
  "$BOTCTL_OUTPUT" 'botctl update v2.0.0'
# `status` is the one the smoke scripts gate on, and it was the one caller
# whose failure on a REAL disagreement nothing asserted.
run_botctl status
assert_fails 'status reported success on a divergent installation' \
  test "$BOTCTL_STATUS" -eq 0

test_case 'a divergence is only detected against the WHOLE image reference'
# `*"@${digest}"` also matched a different repository carrying the same digest
# — a reference this installation would never pull from, reported as agreement.
set_deploy_image "evil.example/nexa@${DIGEST_A}"
run_botctl version
assert_fails 'a foreign repository was accepted as agreement' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the foreign repository was not reported' "$BOTCTL_OUTPUT" 'evil.example'

test_case 'restart refuses to act on a divergence'
# `version` and `status` report it; restart is the command that would ACT on
# it, starting the image deploy.env names. That is a silent downgrade onto a
# schema that has already moved on.
set_deploy_image "registry.test/nexa@${DIGEST_B}"
run_botctl restart
assert_fails 'restart started a divergent installation' test "$BOTCTL_STATUS" -eq 0
assert_contains 'restart did not say why it refused' "$BOTCTL_OUTPUT" 'disagree'

test_case 'the advice the divergence gives actually resolves it'
# The whole point. Following the message must change the state.
fake_set resolve_digest "$DIGEST_B"
run_botctl update v2.0.0
assert_equals 'the advised update failed' 0 "$BOTCTL_STATUS"
run_botctl version
assert_equals 'the installation is still divergent afterwards' 0 "$BOTCTL_STATUS"
assert_not_contains 'a divergence survived the advised update' "$BOTCTL_OUTPUT" 'DIVERGENCE'

test_case 'an update for the CURRENT version repairs a divergence rather than declining'
# `botctl update <current>` used to return "already running. Nothing to do."
# unconditionally — so on a divergent installation, the most natural repair an
# operator would try did nothing at all and reported success.
set_deploy_image "registry.test/nexa@${DIGEST_A}"
run_botctl version
assert_fails 'the fixture is not divergent' test "$BOTCTL_STATUS" -eq 0
run_botctl update v2.0.0
assert_equals 'an update for the current version failed' 0 "$BOTCTL_STATUS"
assert_contains 'the repair was not reported' "$BOTCTL_OUTPUT" 'now names v2.0.0'
# And it must not claim more than it did. The CONTAINERS were not touched, so
# "already running" on its own is an assertion about a thing this command did
# not look at.
assert_contains 'the operator was told nothing about the running containers' \
  "$BOTCTL_OUTPUT" 'running containers were not changed'
run_botctl version
assert_equals 'the divergence survived' 0 "$BOTCTL_STATUS"

teardown_root

# =============================================================================
# an installation with no release manifest
# =============================================================================
#
# What every installation updated before `botctl update` learned to write one
# looks like. It is not divergent — there is simply nothing to compare against
# — and the difference has to survive all the way to each caller. Reported as a
# disagreement, it refused to restart the stack, said the release and deploy.env
# "disagree" when they may agree perfectly, and offered a repair that then died.
setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"
rm -f "${NEXA_STATE_DIR}/releases/v1.0.0.json"

test_case 'a missing manifest is a warning, not a failure'
run_botctl version
assert_equals 'version failed on an installation that simply predates manifests' \
  0 "$BOTCTL_STATUS"
assert_contains 'the operator was not told why the facts are missing' \
  "$BOTCTL_OUTPUT" 'no release manifest'
assert_not_contains 'an absent manifest was reported as a disagreement' \
  "$BOTCTL_OUTPUT" 'DIVERGENCE'
run_botctl status
assert_equals 'status failed on a healthy installation with no manifest' 0 "$BOTCTL_STATUS"

test_case 'a missing manifest does not hide a divergence that IS provable'
# The other half. deploy.env may name a DIFFERENT release whose manifest
# resolves perfectly — an update interrupted between the image pointer and the
# `current` write, on exactly this pre-manifest population. Reporting that as
# merely "unconfirmable" let `botctl restart` go ahead and start the other one.
seed_release 'v2.0.0' "$DIGEST_B"
printf 'v1.0.0\n' >"${NEXA_STATE_DIR}/current"
set_deploy_image "registry.test/nexa@${DIGEST_B}"
run_botctl version
assert_fails 'a provable divergence was reported as merely unknown' \
  test "$BOTCTL_STATUS" -eq 0
assert_contains 'the divergence was not named' "$BOTCTL_OUTPUT" 'DIVERGENCE'
assert_contains 'the release that would start was not named' "$BOTCTL_OUTPUT" 'v2.0.0'
run_botctl restart
assert_fails 'restart started the other release' test "$BOTCTL_STATUS" -eq 0
# Back to the plain no-manifest fixture for the tests below.
rm -f "${NEXA_STATE_DIR}/releases/v2.0.0.json"
set_deploy_image "registry.test/nexa@${DIGEST_A}"

test_case 'restart is not refused for want of a manifest'
# `botctl restart` is refused only for a real disagreement, where a restart is
# what would act on it. Refusing here left an installation that could not be
# restarted at all until somebody hand-wrote JSON into /var/lib/nexa.
reset_docker_log
run_botctl restart
assert_equals 'restart refused an installation with nothing wrong with it' 0 "$BOTCTL_STATUS"
assert_not_contains 'restart claimed a disagreement that does not exist' \
  "$BOTCTL_OUTPUT" 'disagree'

test_case 're-recording says so when it leaves the two pointers equal'
# The repair deliberately does not touch `previous`, so an interrupted rollback
# that made the pointers equal survives it — and the next `botctl rollback`
# refuses. Better said here than discovered then.
printf 'v1.0.0\n' >"${NEXA_STATE_DIR}/previous"
fake_set resolve_digest "$DIGEST_A"
run_botctl update v1.0.0
assert_equals 'the repair failed with equal pointers' 0 "$BOTCTL_STATUS"
assert_contains 'the operator was not warned that rollback will refuse' \
  "$BOTCTL_OUTPUT" 'rollback target is also'
rm -f "${NEXA_STATE_DIR}/previous" "${NEXA_STATE_DIR}/releases/v1.0.0.json"

test_case 'the advised repair records the manifest and does not invent a rollback target'
# The warning says `botctl update <current>` records one, so it must. It used
# to take a backup, run the migration, recreate the containers and THEN die on
# the equal-pointer guard — because re-recording was routed through the
# function that rotates the rollback pointer, which refuses to set `previous`
# equal to `current`. deploy.env was left naming the old image.
fake_set resolve_digest "$DIGEST_A"
run_botctl update v1.0.0
assert_equals 'the advised repair failed' 0 "$BOTCTL_STATUS"
assert_ok 'the repair recorded no manifest' test -f "${NEXA_STATE_DIR}/releases/v1.0.0.json"
assert_equals 'the repair did not repoint deploy.env' \
  "registry.test/nexa@${DIGEST_A}" \
  "$(nexa_env_value "${NEXA_CONFIG_DIR}/deploy.env" NEXA_IMAGE)"
assert_fails 'the repair invented a rollback target pointing at itself' \
  test -f "${NEXA_STATE_DIR}/previous"
run_botctl version
assert_equals 'version still fails after the repair' 0 "$BOTCTL_STATUS"
assert_not_contains 'the repair left a fact unknown' "$BOTCTL_OUTPUT" 'unknown'

teardown_root

# =============================================================================
# two consecutive updates, then rollback
# =============================================================================
#
# The case a single update cannot catch. After one update, the rollback target
# is the release the INSTALLER recorded, so a manifest the update failed to
# write is never read. It is the second update that promotes the first
# update's release to rollback target — and only then does the missing
# manifest surface, as a rollback that refuses on an installation whose
# rollback worked yesterday.
setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"

test_case 'rollback still works after two consecutive updates'
fake_set resolve_digest "$DIGEST_B"
run_botctl update v2.0.0
assert_equals 'the first update failed' 0 "$BOTCTL_STATUS"

fake_set resolve_digest "$DIGEST_C"
run_botctl update v3.0.0
assert_equals 'the second update failed' 0 "$BOTCTL_STATUS"
assert_equals 'current is not the second target' 'v3.0.0' "$(cat "${NEXA_STATE_DIR}/current")"
assert_equals 'the rollback target is not the first target' 'v2.0.0' "$(cat "${NEXA_STATE_DIR}/previous")"

run_botctl rollback
assert_equals 'rollback failed after two updates' 0 "$BOTCTL_STATUS"
assert_equals 'rollback did not return to v2.0.0' 'v2.0.0' "$(cat "${NEXA_STATE_DIR}/current")"
# By DIGEST, not by tag: the rollback must run the exact image that release
# ran, which is only knowable from its manifest.
assert_equals 'rollback did not repoint at the first target digest' \
  "registry.test/nexa@${DIGEST_B}" \
  "$(nexa_env_value "${NEXA_CONFIG_DIR}/deploy.env" NEXA_IMAGE)"

test_case 'every release the installation passed through kept its manifest'
assert_ok 'v1.0.0 lost its manifest' test -f "${NEXA_STATE_DIR}/releases/v1.0.0.json"
assert_ok 'v2.0.0 lost its manifest' test -f "${NEXA_STATE_DIR}/releases/v2.0.0.json"
assert_ok 'v3.0.0 lost its manifest' test -f "${NEXA_STATE_DIR}/releases/v3.0.0.json"

teardown_root

# =============================================================================
# rollback
# =============================================================================
setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"
seed_release 'v2.0.0' "$DIGEST_B"
printf 'v1.0.0\n' >"${NEXA_STATE_DIR}/previous"
printf 'v2.0.0\n' >"${NEXA_STATE_DIR}/current"

test_case 'rollback returns to the previous release by digest'
reset_docker_log
run_botctl rollback
assert_equals 'the rollback failed' 0 "$BOTCTL_STATUS"
assert_equals 'current was not returned to the previous release' 'v1.0.0' "$(cat "${NEXA_STATE_DIR}/current")"
assert_equals 'the rollback did not become undoable' 'v2.0.0' "$(cat "${NEXA_STATE_DIR}/previous")"
assert_equals 'deploy.env does not name the rolled-back digest' \
  "registry.test/nexa@${DIGEST_A}" \
  "$(nexa_env_value "${NEXA_CONFIG_DIR}/deploy.env" NEXA_IMAGE)"

test_case 'rollback does NOT restore the database'
# The most important assertion in this file. The backup predates the
# migration, so restoring it during a routine rollback would discard every
# write made since — an outage turned into data loss by the tool meant to fix
# it. Restoring is a separate, explicitly destructive action.
log="$(docker_log)"
assert_not_contains 'the rollback ran pg_restore' "$log" 'pg_restore'
assert_not_contains 'the rollback ran psql' "$log" 'psql'
assert_not_contains 'the rollback dropped anything' "$log" 'DROP'
assert_contains 'the rollback did not say the database was untouched' \
  "$BOTCTL_OUTPUT" 'database was not touched'

teardown_root

setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"
test_case 'rollback refuses when the two pointers are the same release'
# What an interrupted ROLLBACK leaves: the commit writes deploy.env, then
# `previous`, then `current`, and a cut between the last two makes them equal.
# Accepting it was worse than a stall — the rollback rolled back onto itself,
# reported success, and repointed deploy.env AWAY from the release the operator
# was trying to reach, so the real target became unreachable through the tool
# and was eventually pruned. Every later attempt printed "rolled back" too.
printf 'v1.0.0\n' >"${NEXA_STATE_DIR}/previous"
printf 'v1.0.0\n' >"${NEXA_STATE_DIR}/current"
run_botctl rollback
assert_fails 'a rollback onto itself reported success' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the equal pointers were not named' "$BOTCTL_OUTPUT" 'both'
assert_equals 'a refused rollback still repointed deploy.env' \
  "registry.test/nexa@${DIGEST_A}" \
  "$(nexa_env_value "${NEXA_CONFIG_DIR}/deploy.env" NEXA_IMAGE)"

test_case 'the library refuses to record one release as both pointers'
# The second of the two equal-pointer guards, asserted on its OWN wording.
# `cmd_rollback` has one too, and each caught the other's mutation while the
# suite stayed green — so neither was individually falsifiable and the update
# path's use of this one went unnoticed for two rounds.
probe="$( (nexa_commit_release v1.0.0 v1.0.0 "registry.test/nexa@${DIGEST_A}") 2>&1 || true)"
assert_contains 'the library recorded a release as its own rollback target' \
  "$probe" 'both the current release and the rollback target'

test_case 'rollback refuses when no current release is recorded'
# The other way the equal pair used to be built — deliberately, by a
# `${current:-$previous}` fallback, on an installation whose `current` file was
# missing because an install or an update was interrupted before it was written.
rm -f "${NEXA_STATE_DIR}/current"
printf 'v1.0.0\n' >"${NEXA_STATE_DIR}/previous"
run_botctl rollback
assert_fails 'rolled back from nothing' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the refusal did not say what was missing' \
  "$BOTCTL_OUTPUT" 'nothing to roll back FROM'
assert_fails 'a refused rollback invented a current release' \
  test -f "${NEXA_STATE_DIR}/current"
rm -f "${NEXA_STATE_DIR}/previous"
printf 'v1.0.0\n' >"${NEXA_STATE_DIR}/current"

test_case 'rollback refuses when there is nothing to roll back to'
run_botctl rollback
assert_fails 'rolled back with no previous release' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the refusal was not explained' "$BOTCTL_OUTPUT" 'nothing to roll back'
teardown_root

setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"
printf 'v9.9.9\n' >"${NEXA_STATE_DIR}/previous"
test_case 'rollback refuses to guess when the previous manifest is missing'
run_botctl rollback
assert_fails 'rolled back to a release with no manifest' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the refusal did not mention the manifest' "$BOTCTL_OUTPUT" 'manifest'
teardown_root

# =============================================================================
# the lock
# =============================================================================
setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"

test_case 'a second writer is refused while the lock is held'
# Held by an unrelated process, exactly as a long update would hold it. Without
# this, two updates interleave their migrations and their current-release
# writes, and the installation runs one release while claiming another.
exec 9>>"$NEXA_LOCK_FILE"
flock -x 9
run_botctl update v2.0.0
assert_fails 'a second update ran while the lock was held' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the lock refusal was not explained' "$BOTCTL_OUTPUT" 'already running'
# A rollback TARGET, without which this proves nothing: an unseeded fixture
# makes rollback fail with "nothing to roll back to" whether the lock is held
# or not, and deleting `nexa_acquire_lock` from cmd_rollback left the whole
# suite green.
seed_release 'v0.9.0' "$DIGEST_C"
printf 'v0.9.0\n' >"${NEXA_STATE_DIR}/previous"
printf 'v1.0.0\n' >"${NEXA_STATE_DIR}/current"
set_deploy_image "registry.test/nexa@${DIGEST_A}"
run_botctl rollback
assert_fails 'a rollback ran while the lock was held' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the rollback refusal was not about the lock' \
  "$BOTCTL_OUTPUT" 'already running'
assert_equals 'a locked-out rollback still moved current' 'v1.0.0' \
  "$(cat "${NEXA_STATE_DIR}/current")"
rm -f "${NEXA_STATE_DIR}/previous"
flock -u 9
exec 9>&-

test_case 'the lock is released when the operation finishes'
fake_set resolve_digest "$DIGEST_B"
run_botctl update v2.0.0
assert_equals 'the update failed after the lock was released' 0 "$BOTCTL_STATUS"

teardown_root

# =============================================================================
# release retention
# =============================================================================
setup_root
setup_fake_docker

test_case 'pruning never removes the current or the rollback target'
# shellcheck source=../../deploy/bin/nexa-lib.sh
. "$NEXA_LIB"
for i in 1 2 3 4 5 6 7 8; do
  seed_release "v0.0.${i}" "sha256:$(printf "%064d" "$i")"
done
printf 'v0.0.8\n' >"${NEXA_STATE_DIR}/current"
printf 'v0.0.1\n' >"${NEXA_STATE_DIR}/previous"
NEXA_KEEP_RELEASES=3 nexa_prune_releases
assert_ok 'the current release manifest was pruned' test -f "${NEXA_STATE_DIR}/releases/v0.0.8.json"
assert_ok 'the ROLLBACK TARGET manifest was pruned' test -f "${NEXA_STATE_DIR}/releases/v0.0.1.json"
remaining="$(find "${NEXA_STATE_DIR}/releases" -name '*.json' | wc -l)"
assert_ok 'retention is unbounded' test "$remaining" -lt 8
# Exactly what it says: KEEP unpinned manifests, plus current and previous.
# `kept >= keep` deleted the KEEPth too, so a retention of five kept four and
# the documentation said five.
assert_equals 'retention does not keep the number it says' 5 "$remaining"
teardown_root

# =============================================================================
# The host assets move with the release
# =============================================================================
#
# The defect this section exists for was found on a real host, not in review.
# After a successful `botctl update` to v0.1.0-staging.5, `botctl version`
# reported staging.5 and `botctl secrets status` answered
# `error unknown command "secrets"` — because the update moved the IMAGE and
# left /usr/local/bin/botctl exactly as the previous release had installed it.
# The same was true of the library it sources, the compose file that decides
# the topology, the env template and the Caddy configuration.
#
# The fixtures below give release A a botctl without `secrets` and release B
# one with it, and the assertions RUN the installed script rather than grepping
# it. A test that greps proves the bytes changed; running it proves the
# operator's command works.

setup_root
setup_fake_docker
seed_release 'vA' "$DIGEST_A"
# The live set is release A's: no `secrets`, exactly like the real host.
write_live_assets A
rm -rf "$(assets_dir_for "$DIGEST_A")"
seed_image_assets "$DIGEST_A" A
seed_image_assets "$DIGEST_B" B
fake_set resolve_digest "$DIGEST_B"

test_case 'the real-host failure: the installed botctl gains the subcommand the release added'
BOTCTL_INODE_BEFORE="$(stat -c '%i' "${NEXA_BIN_DIR}/botctl")"
# Before: the exact symptom, reproduced.
before="$("${NEXA_BIN_DIR}/botctl" secrets 2>&1 || true)"
assert_contains 'the fixture did not reproduce the real-host symptom' \
  "$before" 'unknown command "secrets"'

run_botctl update vB
assert_equals 'the update failed' 0 "$BOTCTL_STATUS"

# After: the operator's command works, established by running it.
after="$("${NEXA_BIN_DIR}/botctl" secrets 2>&1 || printf 'FAILED')"
assert_contains 'the installed botctl did not gain `secrets` with the release' "$after" 'secrets ok (B)'
assert_equals 'the installed botctl is not the target release' 'B' "$(installed_label)"

test_case 'every coupled host asset moves too, not just botctl'
# Each of these can drift independently, and each one that drifts is a
# different failure: a stale library is a botctl calling functions that no
# longer mean what it thinks; a stale compose.yml runs the new image under the
# old topology; stale Caddy files route the new surfaces to the old paths.
assert_equals 'nexa-lib.sh did not move with the release' \
  'B' "$(asset_label "${NEXA_LIB_DIR}/nexa-lib.sh")"
assert_equals 'compose.yml did not move with the release' \
  'B' "$(asset_label "${NEXA_DEPLOY_DIR}/compose.yml")"
assert_equals 'nexa.env.template did not move with the release' \
  'B' "$(asset_label "${NEXA_DEPLOY_DIR}/nexa.env.template")"
assert_equals 'the Caddyfile did not move with the release' \
  'B' "$(asset_label "${NEXA_DEPLOY_DIR}/caddy/Caddyfile")"
assert_equals 'the Caddy routes did not move with the release' \
  'B' "$(asset_label "${NEXA_DEPLOY_DIR}/caddy/routes.caddy")"

test_case 'the assets come from the target IMAGE, never from a checkout'
log="$(docker_log)"
assert_contains 'the assets were not extracted from the target image' \
  "$log" "--entrypoint tar registry.test/nexa@${DIGEST_B}"
assert_not_contains 'the update reached for git' "$log" 'git'
# The repository this suite runs from is a checkout, and the installed files
# must not be its.
assert_not_contains 'an installed asset came from the repository checkout' \
  "$(cat "${NEXA_DEPLOY_DIR}/compose.yml")" 'services:'

test_case 'modes and ownership survive the replacement'
assert_file_mode 'botctl is not executable' "${NEXA_BIN_DIR}/botctl" 755
assert_file_mode 'the library is not 0644' "${NEXA_LIB_DIR}/nexa-lib.sh" 644
assert_file_mode 'compose.yml is not 0644' "${NEXA_DEPLOY_DIR}/compose.yml" 644
assert_file_mode 'the Caddyfile is not 0644' "${NEXA_DEPLOY_DIR}/caddy/Caddyfile" 644
assert_equals 'the installed botctl changed owner' \
  "$(stat -c '%u:%g' "${NEXA_BIN_DIR}/botctl")" "$(stat -c '%u:%g' "$(assets_dir_for "$DIGEST_B")/bin/botctl")"

test_case 'the replacement is a rename, not a write over the running script'
# botctl replaces ITSELF while bash is still reading it. A rename swaps the
# directory entry and leaves the running process's open inode alone; writing
# over the same inode rewrites the script under the interpreter mid-execution,
# and bash resumes at a byte offset into different text.
#
# The inode is how the two are told apart: `cp` over an existing file keeps it,
# `mv` replaces it. Without this assertion the activation could be a plain `cp`
# and every other check in this section would still pass.
assert_fails 'the installed botctl kept its inode, so it was written in place' \
  test "$(stat -c '%i' "${NEXA_BIN_DIR}/botctl")" -eq "$BOTCTL_INODE_BEFORE"

test_case 'no temporary file is left beside a destination'
leftovers="$(find "$NEXA_BIN_DIR" "$NEXA_LIB_DIR" "$NEXA_DEPLOY_DIR" -name 'botctl.??????' -o -name '*.partial' | wc -l)"
assert_equals 'the activation left a temporary file behind' 0 "$leftovers"

teardown_root

# --- a failed update leaves the outgoing release's tooling usable -------------
setup_root
setup_fake_docker
seed_release 'vA' "$DIGEST_A"
write_live_assets A
rm -rf "$(assets_dir_for "$DIGEST_A")"
seed_image_assets "$DIGEST_B" B
fake_set resolve_digest "$DIGEST_B"

test_case "a migration that fails puts the outgoing release's host assets back"
# The update replaces the assets BEFORE the migration, so that the target runs
# under its own compose file. That makes the failure paths load-bearing: an
# update abandoned after the swap must not leave an installation running A and
# operated by B's tooling.
fake_set run_exit 1
run_botctl update vB
assert_fails 'a failed migration reported success' test "$BOTCTL_STATUS" -eq 0
assert_equals "the failed update left the target release's botctl installed" 'A' "$(installed_label)"
assert_equals "the failed update left the target release's compose file" \
  'A' "$(asset_label "${NEXA_DEPLOY_DIR}/compose.yml")"
assert_contains 'the installed botctl is not usable after the failed update' \
  "$("${NEXA_BIN_DIR}/botctl" version 2>&1)" 'A'
fake_set run_exit 0

test_case "a target that will not start leaves the outgoing release's tooling"
fake_set "up_exit_${DIGEST_B}" 1
run_botctl update vB
assert_fails 'a target that would not start reported success' test "$BOTCTL_STATUS" -eq 0
assert_equals "a failed start left the target's botctl installed" 'A' "$(installed_label)"
assert_equals "a failed start left the target's compose file installed" \
  'A' "$(asset_label "${NEXA_DEPLOY_DIR}/compose.yml")"
# The order matters and is asserted, not assumed: the outgoing release must be
# restarted under ITS OWN compose file, so the restore has to happen before the
# back-out `up`.
assert_contains 'the outgoing release was not brought back' "$BOTCTL_OUTPUT" 'is running again'
rm -f "${FAKE_DIR}/up_exit_${DIGEST_B}"

test_case "a target that never becomes ready leaves the outgoing release's tooling"
fake_set "api_health_${DIGEST_B}" starting
NEXA_READY_TIMEOUT=6 run_botctl update vB
assert_fails 'an unready target reported success' test "$BOTCTL_STATUS" -eq 0
assert_equals 'an unready target left its botctl installed' 'A' "$(installed_label)"
rm -f "${FAKE_DIR}/api_health_${DIGEST_B}"

test_case 'a release that does not carry its host assets is refused before anything changes'
# The earlier attempts staged vB before failing, and re-using a complete
# staged set is deliberate. Clear it so the extraction actually runs.
rm -rf "$(assets_dir_for "$DIGEST_B")"
fake_set assets_missing 1
run_botctl update vB
assert_fails 'a release without host assets was accepted' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the refusal did not say what was missing' "$BOTCTL_OUTPUT" 'host assets'
assert_equals 'a refused update still replaced the botctl' 'A' "$(installed_label)"
assert_equals 'a refused update changed the current release' 'vA' "$(cat "${NEXA_STATE_DIR}/current")"
fake_set assets_missing 0

test_case 'an interrupted extraction installs nothing and leaves no partial directory'
rm -rf "$(assets_dir_for "$DIGEST_B")"
fake_set assets_truncated 1
run_botctl update vB
assert_fails 'a truncated extraction was accepted' test "$BOTCTL_STATUS" -eq 0
assert_equals 'a truncated extraction replaced the botctl' 'A' "$(installed_label)"
assert_fails 'a truncated extraction left a version directory behind' \
  test -d "$(assets_dir_for "$DIGEST_B")"
assert_fails 'a truncated extraction left a .partial directory behind' \
  test -d "$(assets_dir_for "$DIGEST_B").partial"
# And the next attempt, with the fault removed, must succeed rather than find
# a half-staged directory and skip the extraction.
fake_set assets_truncated 0
run_botctl update vB
assert_equals 'the retry after a truncated extraction failed' 0 "$BOTCTL_STATUS"
assert_equals "the retry did not install the target release's botctl" 'B' "$(installed_label)"

teardown_root

# --- rollback -----------------------------------------------------------------
setup_root
setup_fake_docker
seed_release 'vA' "$DIGEST_A"
write_live_assets A
rm -rf "$(assets_dir_for "$DIGEST_A")"
seed_image_assets "$DIGEST_B" B
fake_set resolve_digest "$DIGEST_B"
run_botctl update vB

test_case 'rollback returns the host assets to the release it returns the image to'
assert_equals 'the fixture did not reach the target release' 'B' "$(installed_label)"
run_botctl rollback
assert_equals 'the rollback failed' 0 "$BOTCTL_STATUS"
assert_equals 'the rollback left the newer botctl operating the older image' 'A' "$(installed_label)"
assert_equals 'the rollback left the newer compose file' \
  'A' "$(asset_label "${NEXA_DEPLOY_DIR}/compose.yml")"
assert_contains 'the rolled-back botctl still answers a command it never had' \
  "$("${NEXA_BIN_DIR}/botctl" secrets 2>&1 || true)" 'unknown command "secrets"'
assert_equals 'the rollback did not move the current pointer' 'vA' "$(cat "${NEXA_STATE_DIR}/current")"

test_case "a rollback that does not come back leaves the current release's tooling"
run_botctl update vB
assert_equals 'the second update failed' 0 "$BOTCTL_STATUS"
fake_set "up_exit_${DIGEST_A}" 1
run_botctl rollback
assert_fails 'a rollback that could not start reported success' test "$BOTCTL_STATUS" -eq 0
assert_equals "a failed rollback left the previous release's botctl installed" 'B' "$(installed_label)"
rm -f "${FAKE_DIR}/up_exit_${DIGEST_A}"

test_case "rollback refuses when the previous release's assets were never recorded"
# An installation that predates this mechanism: its pointers were written by a
# botctl that staged nothing. Rolling the IMAGE back there would leave the
# current release's compose file describing a topology the older image was
# never released with, which is a contract nothing here proves.
rm -rf "$(assets_dir_for "$DIGEST_A")"
run_botctl rollback
assert_fails 'a rollback without recorded assets was performed anyway' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the refusal did not say why' "$BOTCTL_OUTPUT" 'no host assets are recorded'
assert_equals 'the refused rollback changed the current release' 'vB' "$(cat "${NEXA_STATE_DIR}/current")"
assert_equals 'the refused rollback changed the installed botctl' 'B' "$(installed_label)"

teardown_root

# --- the installations that already exist -------------------------------------
setup_root
setup_fake_docker
seed_release 'vA' "$DIGEST_A"
# staging.1 through staging.4 staged nothing: the mechanism did not exist. The
# first update on such a host must still work, and must still leave something
# to roll back to.
rm -rf "${NEXA_STATE_DIR}/assets"
write_live_assets A
seed_image_assets "$DIGEST_B" B
fake_set resolve_digest "$DIGEST_B"

test_case 'an installation that staged nothing is upgradeable without reinstalling'
run_botctl update vB
assert_equals 'the update failed on an installation with no staged assets' 0 "$BOTCTL_STATUS"
assert_equals "the upgrade did not install the target release's botctl" 'B' "$(installed_label)"
assert_ok "the outgoing release's assets were not captured" \
  test -f "$(assets_dir_for "$DIGEST_A")/bin/botctl"
assert_equals 'what was captured is not what was live' \
  'A' "$(asset_label "$(assets_dir_for "$DIGEST_A")/bin/botctl")"

test_case 'and the rollback that upgrade made possible works'
run_botctl rollback
assert_equals 'the rollback after the first upgrade failed' 0 "$BOTCTL_STATUS"
assert_equals 'the rollback did not restore the captured botctl' 'A' "$(installed_label)"

test_case 'an installation missing a host asset is not silently half-captured'
# If what is live cannot be recorded in full, there is nothing to put back, and
# an update that proceeded anyway would be an update with no way home.
run_botctl update vB
rm -f "${NEXA_DEPLOY_DIR}/caddy/routes.caddy"
rm -rf "$(assets_dir_for "$DIGEST_B")"
fake_set resolve_digest "$DIGEST_C"
seed_image_assets "$DIGEST_C" C
run_botctl update vC
assert_fails 'an incomplete capture was accepted' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the refusal did not name the reason' "$BOTCTL_OUTPUT" 'cannot be recorded'
assert_fails 'a refused capture left a partial directory behind' \
  test -d "$(assets_dir_for "$DIGEST_B").partial"
assert_equals 'a refused capture still replaced the botctl' 'B' "$(installed_label)"

teardown_root

# --- the lock -----------------------------------------------------------------
setup_root
setup_fake_docker
seed_release 'vA' "$DIGEST_A"
seed_image_assets "$DIGEST_B" B
fake_set resolve_digest "$DIGEST_B"

test_case 'the asset swap happens under the existing exclusive lock'
# Two updates replacing /usr/local/bin/botctl at once is the one race that can
# leave an operator with neither release's tooling. The lock that already
# covers the migration must cover this too — asserted by holding it and
# watching the update refuse before it touches anything.
exec 9>"$NEXA_LOCK_FILE"
flock -n 9
run_botctl update vB
assert_fails 'a second writer was admitted' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the refusal was not the lock' "$BOTCTL_OUTPUT" 'already running'
assert_fails 'a locked-out update staged assets anyway' test -d "$(assets_dir_for "$DIGEST_B")"
assert_equals 'a locked-out update replaced the botctl' 'A' "$(installed_label)"
exec 9>&-

teardown_root

# =============================================================================
# The secret configuration: migrating it, and switching v1 off
# =============================================================================
#
# Two commands edit /etc/nexa/nexa.env, and that file holds the key that
# decrypts every stored credential. So these tests care about three things in
# roughly equal measure: that the conversion is exact, that it is safe to
# interrupt or repeat, and that the key material does not appear anywhere
# except the file.

setup_root
setup_fake_docker
seed_release "vA" "$DIGEST_A"

test_case "migrate-config converts the legacy spelling, preserving the id and the key"
seed_nexa_env legacy
run_botctl secrets migrate-config
assert_equals "the migration failed" 0 "$BOTCTL_STATUS"
assert_equals "SECRETS_KEYS is not the id:key pair" \
  "${TEST_KEY_ID}:${TEST_KEK}" "$(nexa_env_key SECRETS_KEYS)"
assert_equals "the active key id was not preserved" "$TEST_KEY_ID" "$(nexa_env_key SECRETS_ACTIVE_KEY_ID)"
# The exact bytes, not merely something base64-shaped. A migration that
# regenerated the key would leave an installation that cannot read a single
# stored secret, and every other assertion here would still pass.
written_keys="$(nexa_env_key SECRETS_KEYS)"
assert_equals "the key bytes changed" "$TEST_KEK" "${written_keys#*:}"

test_case "the legacy pair is gone, and nothing else was lost"
assert_equals "SECRETS_KEK survived the migration" "" "$(nexa_env_key SECRETS_KEK)"
assert_equals "SECRETS_KEK_ID survived the migration" "" "$(nexa_env_key SECRETS_KEK_ID)"
assert_equals "DATABASE_URL was lost" \
  "postgres://nexa:pw@postgres:5432/nexa" "$(nexa_env_key DATABASE_URL)"
assert_equals "an unrelated key was lost" "telegram" "$(nexa_env_key NOTIFICATION_TRANSPORT)"
assert_file_mode "the converted file is not 0600" "${NEXA_CONFIG_DIR}/nexa.env" 600

test_case "the migration never prints the key material"
# The assertion this file exists for. The command reads the KEK, concatenates
# it and writes it — and must not put it in its own output, where it would land
# in a terminal scrollback, a CI log or an operator's paste into a ticket.
assert_not_contains "the key appeared in the migration output" "$BOTCTL_OUTPUT" "$TEST_KEK"
# Nor a recognisable prefix of it: a truncated secret is still a secret.
assert_not_contains "a prefix of the key appeared in the output" "$BOTCTL_OUTPUT" "${TEST_KEK:0:16}"
assert_contains "the migration did not report the key id it used" "$BOTCTL_OUTPUT" "$TEST_KEY_ID"

test_case "the key material never reaches the process table either"
# `nexa_env_rewrite` takes VARIABLE NAMES and reads them by reference, so no
# value is ever an argument. Checked against the fake docker log, which records
# every argv this command line produced.
assert_not_contains "the key reached a docker invocation" "$(docker_log)" "$TEST_KEK"

test_case "rerunning the migration on a converted host changes nothing"
before="$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
run_botctl secrets migrate-config
assert_equals "the rerun failed" 0 "$BOTCTL_STATUS"
assert_equals "the rerun rewrote the file" "$before" "$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
assert_contains "the rerun did not say it had nothing to do" "$BOTCTL_OUTPUT" "already canonical"

teardown_root

setup_root
setup_fake_docker
seed_release "vA" "$DIGEST_A"

test_case "a host that is canonical but still carries the dead legacy pair is told so"
# The parser prefers SECRETS_KEYS, so those two lines are ignored — which makes
# them worse than useless: they read like configuration and are not.
seed_nexa_env canonical-with-stale-legacy
run_botctl secrets migrate-config
assert_equals "the command failed on a canonical host" 0 "$BOTCTL_STATUS"
assert_contains "the dead legacy pair was not reported" "$BOTCTL_OUTPUT" "IGNORED"
assert_equals "the command removed lines it only meant to report" \
  "$TEST_KEK" "$(nexa_env_key SECRETS_KEK)"

test_case "a half-configured host is refused rather than guessed at"
seed_nexa_env id-without-key
run_botctl secrets migrate-config
assert_fails "an id with no key was accepted" test "$BOTCTL_STATUS" -eq 0
assert_contains "the refusal did not say what was missing" "$BOTCTL_OUTPUT" "no SECRETS_KEK"
assert_equals "the refused migration wrote a keyring anyway" "" "$(nexa_env_key SECRETS_KEYS)"

test_case "a rewrite that would leave an unbootable file is refused"
# Found by falsification: removing the DATABASE_URL guard from
# `nexa_env_rewrite` left the whole suite green, which meant the guard was a
# claim rather than a rule. The state it protects against is real — a nexa.env
# truncated part-way through a write keeps its first lines and loses the rest —
# and rewriting one would produce a file that parses and cannot boot.
seed_nexa_env legacy-truncated
before="$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
run_botctl secrets migrate-config
assert_fails "a rewrite that loses DATABASE_URL was accepted" test "$BOTCTL_STATUS" -eq 0
assert_contains "the refusal did not say what would have been lost" "$BOTCTL_OUTPUT" "DATABASE_URL"
assert_contains "the refusal did not say the original was untouched" "$BOTCTL_OUTPUT" "UNCHANGED"
assert_equals "the refused rewrite modified the file" "$before" "$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
assert_fails "the refused rewrite left a temporary file behind" \
  test -n "$(find "$NEXA_CONFIG_DIR" -name 'nexa.env.??????' -print -quit)"

test_case "a host with no key configuration at all is refused"
seed_nexa_env empty
run_botctl secrets migrate-config
assert_fails "an empty configuration was accepted" test "$BOTCTL_STATUS" -eq 0
assert_contains "the refusal did not say there was nothing to convert" \
  "$BOTCTL_OUTPUT" "nothing to convert"

teardown_root

# --- switching v1 off ---------------------------------------------------------
setup_root
setup_fake_docker
seed_release "vA" "$DIGEST_A"
seed_nexa_env canonical

test_case "disable-v1 refuses when the installation is not ready, and changes nothing"
fake_set shutdown_ready 0
before="$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
run_botctl secrets disable-v1
assert_fails "an unready installation was allowed to disable v1" test "$BOTCTL_STATUS" -eq 0
assert_contains "the refusal did not carry the check's own reason" \
  "$BOTCTL_OUTPUT" "still hold a v1 envelope"
assert_contains "the refusal did not say nothing had changed" "$BOTCTL_OUTPUT" "Nothing was changed"
assert_equals "a refused shutdown edited nexa.env" "$before" "$(cat "${NEXA_CONFIG_DIR}/nexa.env")"

test_case "disable-v1 writes the setting and restarts once the check passes"
fake_set shutdown_ready 1
reset_docker_log
run_botctl secrets disable-v1
assert_equals "the shutdown failed" 0 "$BOTCTL_STATUS"
assert_equals "SECRETS_ACCEPT_V1 was not set to false" "false" "$(nexa_env_key SECRETS_ACCEPT_V1)"
# Written is not applied. A setting the running process has not loaded is an
# operator believing v1 is off while it is on, which is the exact failure this
# command exists to prevent.
assert_contains "the stack was not restarted" "$(docker_log)" "up -d"
assert_equals "the keyring was disturbed" "${TEST_KEY_ID}:${TEST_KEK}" "$(nexa_env_key SECRETS_KEYS)"
assert_not_contains "the key appeared in the shutdown output" "$BOTCTL_OUTPUT" "$TEST_KEK"
assert_contains "the backup rule was not restated at the moment it starts to matter" \
  "$BOTCTL_OUTPUT" "BACKUPS"

test_case "rerunning disable-v1 is free"
run_botctl secrets disable-v1
assert_equals "the rerun failed" 0 "$BOTCTL_STATUS"
assert_contains "the rerun did not say it had nothing to do" "$BOTCTL_OUTPUT" "already false"

teardown_root

setup_root
setup_fake_docker
seed_release "vA" "$DIGEST_A"
seed_nexa_env canonical

test_case "a stack that does not come back restores the previous setting"
# The one path where writing the file is not the end of the story. An
# installation that will not start is worse than one that still reads v1, and
# the operator must not be left to work out which of the two they have.
fake_set shutdown_ready 1
fake_set api_health starting
NEXA_READY_TIMEOUT=6 run_botctl secrets disable-v1
assert_fails "a stack that never became ready reported success" test "$BOTCTL_STATUS" -eq 0
assert_equals "the setting was left disabled on a stack that would not come back" \
  "true" "$(nexa_env_key SECRETS_ACCEPT_V1)"
assert_contains "the operator was not told the setting had been restored" \
  "$BOTCTL_OUTPUT" "restored"
assert_equals "the keyring was damaged by the back-out" \
  "${TEST_KEY_ID}:${TEST_KEK}" "$(nexa_env_key SECRETS_KEYS)"
fake_set api_health healthy

teardown_root

# --- the rest of the secrets surface, and the update path ---------------------
setup_root
setup_fake_docker
seed_release "vA" "$DIGEST_A"
seed_nexa_env canonical

test_case "the read-only secrets subcommands still run, and take no lock"
for action in status retire-check shutdown-check; do
  reset_docker_log
  if [ "$action" = "retire-check" ]; then
    run_botctl secrets "$action" --key old
  else
    run_botctl secrets "$action"
  fi
  assert_equals "botctl secrets ${action} failed" 0 "$BOTCTL_STATUS"
  assert_contains "botctl secrets ${action} did not reach the CLI" \
    "$(docker_log)" "dist/secrets.cli.js ${action}"
done

test_case "an unknown secrets subcommand is refused with the full list"
run_botctl secrets nonsense
assert_fails "an unknown subcommand was accepted" test "$BOTCTL_STATUS" -eq 0
for action in status rewrap retire-check shutdown-check migrate-config disable-v1; do
  assert_contains "the usage does not name ${action}" "$BOTCTL_OUTPUT" "$action"
done

test_case "an update does not touch the secret configuration"
# /etc/nexa survives an update by design — the layout table says so, and the
# key that decrypts every stored credential is in there. This is the assertion
# that keeps the host-asset mechanism away from it.
seed_image_assets "$DIGEST_B" B
fake_set resolve_digest "$DIGEST_B"
before="$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
run_botctl update vB
assert_equals "the update failed" 0 "$BOTCTL_STATUS"
assert_equals "the update rewrote nexa.env" "$before" "$(cat "${NEXA_CONFIG_DIR}/nexa.env")"

test_case "and neither does a rollback"
# Which is the compatibility hazard worth stating rather than hiding: the
# CONFIG does not roll back with the release, so a host migrated to the
# canonical keyring keeps it when the image goes back.
before="$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
run_botctl rollback
assert_equals "the rollback failed" 0 "$BOTCTL_STATUS"
assert_equals "the rollback rewrote nexa.env" "$before" "$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
assert_equals "the rollback reverted the keyring format" \
  "${TEST_KEY_ID}:${TEST_KEK}" "$(nexa_env_key SECRETS_KEYS)"

teardown_root

# =============================================================================
# C8 — the worker is half of the application, and readiness knows it
# =============================================================================
setup_root
setup_fake_docker
seed_release 'vA' "$DIGEST_A"
write_live_assets A
# What is recorded under the running digest IS what is live, as on any
# installation the installer or an update made.
stage_release_assets "$DIGEST_A" A
seed_image_assets "$DIGEST_B" B
fake_set resolve_digest "$DIGEST_B"

test_case 'C8: a target whose worker stays exited is backed out, without waiting out the timeout'
fake_set "worker_state_${DIGEST_B}" exited
started=$(date +%s)
NEXA_READY_TIMEOUT=60 run_botctl update vB
elapsed=$(( $(date +%s) - started ))
assert_fails 'a target with a dead worker became current' test "$BOTCTL_STATUS" -eq 0
assert_equals 'a dead worker advanced the current release' 'vA' "$(cat "${NEXA_STATE_DIR}/current")"
assert_equals 'deploy.env was repointed at a release whose worker died' \
  "registry.test/nexa@${DIGEST_A}" "$(nexa_env_value "${NEXA_CONFIG_DIR}/deploy.env" NEXA_IMAGE)"
assert_contains 'the previous release was not brought back' "$BOTCTL_OUTPUT" 'is running again and is still the current release'
assert_ok 'an exited worker was waited out rather than fast-failed' test "$elapsed" -lt 40
assert_equals "the back-out left the target's tooling installed" 'A' "$(installed_label)"
rm -f "${FAKE_DIR}/worker_state_${DIGEST_B}"

test_case 'C8: a target whose worker crash-loops is not accepted'
fake_set "worker_state_${DIGEST_B}" restarting
NEXA_READY_TIMEOUT=6 run_botctl update vB
assert_fails 'a crash-looping worker was accepted as ready' test "$BOTCTL_STATUS" -eq 0
assert_equals 'a crash-looping worker advanced the current release' 'vA' "$(cat "${NEXA_STATE_DIR}/current")"
rm -f "${FAKE_DIR}/worker_state_${DIGEST_B}"

test_case 'C8: a worker that never becomes healthy is not accepted'
fake_set "worker_health_${DIGEST_B}" starting
NEXA_READY_TIMEOUT=6 run_botctl update vB
assert_fails 'an unhealthy worker was accepted as ready' test "$BOTCTL_STATUS" -eq 0
assert_equals 'an unhealthy worker advanced the current release' 'vA' "$(cat "${NEXA_STATE_DIR}/current")"
rm -f "${FAKE_DIR}/worker_health_${DIGEST_B}"

test_case 'C8: a healthy worker does not excuse an unhealthy api'
fake_set "api_health_${DIGEST_B}" unhealthy
NEXA_READY_TIMEOUT=6 run_botctl update vB
assert_fails 'an unhealthy api was accepted because the worker was fine' test "$BOTCTL_STATUS" -eq 0
assert_equals 'an unhealthy api advanced the current release' 'vA' "$(cat "${NEXA_STATE_DIR}/current")"
rm -f "${FAKE_DIR}/api_health_${DIGEST_B}"

test_case 'C8: both healthy is ready, and the update completes'
run_botctl update vB
assert_equals 'a healthy api and worker were not accepted' 0 "$BOTCTL_STATUS"
assert_equals 'the update did not advance' 'vB' "$(cat "${NEXA_STATE_DIR}/current")"

test_case 'C8: status reports NOT READY when the worker is down and the api is fine'
fake_set worker_state exited
run_botctl status
assert_contains 'a dead worker was reported as ready' "$BOTCTL_OUTPUT" 'NOT READY'
assert_fails 'status exited zero with a dead worker' test "$BOTCTL_STATUS" -eq 0
fake_set worker_state running
run_botctl status
assert_contains 'a healthy worker was not reported as ready' "$BOTCTL_OUTPUT" 'readiness: ready'

test_case 'C8: rollback is gated on the worker too'
fake_set "worker_state_${DIGEST_A}" exited
NEXA_READY_TIMEOUT=6 run_botctl rollback
assert_fails 'a rollback whose worker died reported success' test "$BOTCTL_STATUS" -eq 0
assert_equals 'a failed rollback moved the current pointer' 'vB' "$(cat "${NEXA_STATE_DIR}/current")"
assert_equals "a failed rollback left the previous release's tooling" 'B' "$(installed_label)"
rm -f "${FAKE_DIR}/worker_state_${DIGEST_A}"

teardown_root

# =============================================================================
# 3C — the monitor is required, and a topology without one still rolls back
# =============================================================================
setup_root
setup_fake_docker
seed_release 'vA' "$DIGEST_A"
write_live_assets A
stage_release_assets "$DIGEST_A" A
seed_image_assets "$DIGEST_B" B
fake_set resolve_digest "$DIGEST_B"

test_case '3C: a target whose monitor stays exited is backed out'
# The failure this catches has no other symptom. Every request is served
# correctly by a release with a dead monitor; what stops is panel health being
# written, so an operator reads a health that is frozen at whatever it was and
# has no way to tell.
fake_set "monitor_state_${DIGEST_B}" exited
NEXA_READY_TIMEOUT=60 run_botctl update vB
assert_fails 'a target with a dead monitor became current' test "$BOTCTL_STATUS" -eq 0
assert_equals 'a dead monitor advanced the current release' 'vA' "$(cat "${NEXA_STATE_DIR}/current")"
assert_equals 'deploy.env was repointed at a release whose monitor died' \
  "registry.test/nexa@${DIGEST_A}" "$(nexa_env_value "${NEXA_CONFIG_DIR}/deploy.env" NEXA_IMAGE)"
rm -f "${FAKE_DIR}/monitor_state_${DIGEST_B}"

test_case '3C: a monitor that never becomes healthy is not accepted'
fake_set "monitor_health_${DIGEST_B}" starting
NEXA_READY_TIMEOUT=6 run_botctl update vB
assert_fails 'an unhealthy monitor was accepted as ready' test "$BOTCTL_STATUS" -eq 0
assert_equals 'an unhealthy monitor advanced the current release' 'vA' "$(cat "${NEXA_STATE_DIR}/current")"
rm -f "${FAKE_DIR}/monitor_health_${DIGEST_B}"

test_case '3C: api and worker healthy do not excuse a crash-looping monitor'
fake_set "monitor_state_${DIGEST_B}" restarting
NEXA_READY_TIMEOUT=6 run_botctl update vB
assert_fails 'a crash-looping monitor was accepted as ready' test "$BOTCTL_STATUS" -eq 0
assert_equals 'a crash-looping monitor advanced the current release' 'vA' "$(cat "${NEXA_STATE_DIR}/current")"
rm -f "${FAKE_DIR}/monitor_state_${DIGEST_B}"

test_case '3C: all three healthy is ready, and the update completes'
run_botctl update vB
assert_equals 'a healthy api, worker and monitor were not accepted' 0 "$BOTCTL_STATUS"
assert_equals 'the update did not advance' 'vB' "$(cat "${NEXA_STATE_DIR}/current")"

test_case '3C: status reports NOT READY when only the monitor is down'
fake_set monitor_state exited
run_botctl status
assert_contains 'a dead monitor was reported as ready' "$BOTCTL_OUTPUT" 'NOT READY'
assert_fails 'status exited zero with a dead monitor' test "$BOTCTL_STATUS" -eq 0
fake_set monitor_state running
run_botctl status
assert_contains 'a healthy monitor was not reported as ready' "$BOTCTL_OUTPUT" 'readiness: ready'

test_case '3C: a rollback to a release with no monitor service is still valid'
# The compatibility requirement, and the reason readiness intersects what it
# requires with what the ACTIVE compose file defines rather than hardcoding
# three services.
#
# Host assets are release-versioned. A rollback activates the target release's
# compose.yml and then waits for readiness while THIS library is still the one
# in memory. vA predates the monitor, so its topology has no such service and
# its containers never report one. A hardcoded requirement would wait out the
# whole timeout and report a rollback failure — after the assets had already
# moved, which is the worst moment to be wrong.
fake_set compose_services 'api worker postgres redis caddy'
fake_set monitor_state absent
NEXA_READY_TIMEOUT=30 run_botctl rollback
assert_equals 'a rollback to a monitor-less topology was refused' 0 "$BOTCTL_STATUS"
assert_equals 'the rollback did not move the current pointer' 'vA' "$(cat "${NEXA_STATE_DIR}/current")"

test_case '3C: a monitor-less topology still requires its api and worker'
# The relaxation is exactly one service wide. Dropping the monitor from the
# topology must not drop the two that were always required — otherwise the
# intersection would be a way to make any release ready by shipping a compose
# file that defines nothing.
fake_set worker_state exited
NEXA_READY_TIMEOUT=6 run_botctl status
assert_contains 'a monitor-less topology with a dead worker was reported ready' \
  "$BOTCTL_OUTPUT" 'NOT READY'
fake_set worker_state running
fake_set compose_services 'api worker monitor postgres redis caddy'
fake_set monitor_state running

teardown_root

# =============================================================================
# C9 — host assets are keyed by digest, never by version
# =============================================================================
setup_root
setup_fake_docker
seed_release 'vA' "$DIGEST_A"
write_live_assets A
stage_release_assets "$DIGEST_A" A
seed_image_assets "$DIGEST_B" B
seed_image_assets "$DIGEST_C" C

test_case 'C9: a tag that moved between attempts stages the NEW digest, never the old'
# 1. vX resolves to B; 2. B is staged; 3. the update is interrupted after
# staging (the migration fails); 4. vX now resolves to C; 5. the retry must
# stage and install C. Keyed by version, "vX is already staged" would have
# installed B's files under C's image.
fake_set resolve_digest "$DIGEST_B"
fake_set run_exit 1
run_botctl update vX
assert_fails 'the interrupted update reported success' test "$BOTCTL_STATUS" -eq 0
assert_ok 'the first attempt did not stage the digest it resolved' test -d "$(assets_dir_for "$DIGEST_B")"
assert_equals 'the interrupted update left the target tooling live' 'A' "$(installed_label)"
fake_set run_exit 0
fake_set resolve_digest "$DIGEST_C"
reset_docker_log
run_botctl update vX
assert_equals 'the retry failed' 0 "$BOTCTL_STATUS"
assert_equals 'the retry installed the OLD digest'"'"'s tooling' 'C' "$(installed_label)"
assert_equals 'the retry installed the old compose file' 'C' "$(asset_label "${NEXA_DEPLOY_DIR}/compose.yml")"
assert_contains 'the retry did not read its assets out of the new digest' \
  "$(docker_log)" "--entrypoint tar registry.test/nexa@${DIGEST_C}"
assert_ok 'the new digest was not staged' test -d "$(assets_dir_for "$DIGEST_C")"
assert_equals 'the manifest does not record the digest that was installed' \
  "$DIGEST_C" "$(manifest_field vX digest)"
assert_fails 'a version-keyed directory appeared' test -e "${NEXA_STATE_DIR}/assets/vX"

test_case 'C9: the same digest reuses its staged set rather than extracting again'
run_botctl rollback
assert_equals 'the rollback to vA failed' 0 "$BOTCTL_STATUS"
reset_docker_log
run_botctl update vY
assert_equals 'the second update to the same digest failed' 0 "$BOTCTL_STATUS"
assert_not_contains 'a digest already staged was extracted again' \
  "$(docker_log)" "--entrypoint tar registry.test/nexa@${DIGEST_C}"
assert_equals 'the reused set is not the digest'"'"'s' 'C' "$(installed_label)"

test_case 'C9: rollback puts back the set recorded under the outgoing DIGEST'
run_botctl rollback
assert_equals 'the rollback failed' 0 "$BOTCTL_STATUS"
assert_equals 'the rollback did not restore the previous digest'"'"'s tooling' 'A' "$(installed_label)"

teardown_root

# =============================================================================
# C12 — activation is one unit: every injected failure restores the whole set
# =============================================================================
c12_fixture() {
  setup_root
  setup_fake_docker
  seed_release 'vA' "$DIGEST_A"
  write_live_assets A
  stage_release_assets "$DIGEST_A" A
  seed_image_assets "$DIGEST_B" B
  fake_set resolve_digest "$DIGEST_B"
}
c12_assert_intact() {
  local label="$1" why="$2" path
  assert_equals "${why}: botctl" "$label" "$(installed_label)"
  for path in "${NEXA_LIB_DIR}/nexa-lib.sh" "${NEXA_DEPLOY_DIR}/compose.yml" \
    "${NEXA_DEPLOY_DIR}/nexa.env.template" "${NEXA_DEPLOY_DIR}/caddy/Caddyfile" \
    "${NEXA_DEPLOY_DIR}/caddy/routes.caddy"; do
    assert_equals "${why}: ${path##*/}" "$label" "$(asset_label "$path")"
  done
  assert_fails "${why}: an activation generation was left behind" test -d "${NEXA_STATE_DIR}/assets/.activating"
  assert_equals "${why}: a temporary file was left beside a destination" '' \
    "$(find "$NEXA_BIN_DIR" "$NEXA_LIB_DIR" "$NEXA_DEPLOY_DIR" -name '*.??????' -newer "${NEXA_CONFIG_DIR}/deploy.env" 2>/dev/null | grep -v '\.partial$' || true)"
}

# Seven interruption points: each of the three tools, at the first, a middle
# and the last asset. The destination is resolved AFTER the fixture creates the
# root, from the asset's table entry.
for fault in \
  "cp|bin/botctl" \
  "chmod|compose.yml" \
  "mv|caddy/routes.caddy" \
  "mv|bin/nexa-lib.sh" \
  "cp|nexa.env.template" \
  "chmod|caddy/Caddyfile" \
  "mv|bin/botctl"; do
  c12_fixture
  cmd="${fault%%|*}"
  source_asset="${fault#*|}"
  case "$source_asset" in
    bin/botctl) dest="${NEXA_BIN_DIR}/botctl" ;;
    bin/nexa-lib.sh) dest="${NEXA_LIB_DIR}/nexa-lib.sh" ;;
    *) dest="${NEXA_DEPLOY_DIR}/${source_asset}" ;;
  esac
  test_case "C12: a failed ${cmd} on ${dest##*/} restores the previous complete set"
  inject_activation_fault "$cmd" "$dest"
  run_botctl update vB
  clear_activation_fault
  assert_fails "a failed ${cmd} on ${dest##*/} reported success" test "$BOTCTL_STATUS" -eq 0
  assert_contains 'the operator was not told the set was put back' "$BOTCTL_OUTPUT" 'put back'
  c12_assert_intact A "after a failed ${cmd} on ${dest##*/}"
  assert_equals "a failed ${cmd} advanced the current release" 'vA' "$(cat "${NEXA_STATE_DIR}/current")"
  assert_not_contains "a failed activation went on to migrate" "$(docker_log)" 'migrate.js --preflight-never'
  # And with the fault gone the same update succeeds: nothing about the
  # failure poisoned the staged set or the host.
  run_botctl update vB
  assert_equals "the retry after a failed ${cmd} failed" 0 "$BOTCTL_STATUS"
  c12_assert_intact B "after the retry following a failed ${cmd} on ${dest##*/}"
  teardown_root
done

test_case 'C12: an activation interrupted by a crash is restored before the host is changed again'
c12_fixture
# A generation directory as a kill between the third and fourth rename leaves
# it: three destinations already B'"'"'s, the journal naming them, A'"'"'s copies saved.
gen="${NEXA_STATE_DIR}/assets/.activating"
mkdir -p "${gen}/saved/bin" "${gen}/saved/caddy"
cp -p "${NEXA_BIN_DIR}/botctl" "${gen}/saved/bin/botctl"
cp -p "${NEXA_LIB_DIR}/nexa-lib.sh" "${gen}/saved/bin/nexa-lib.sh"
cp -p "${NEXA_DEPLOY_DIR}/compose.yml" "${gen}/saved/compose.yml"
staged_b="$(mktemp -d)"
write_asset_set "$staged_b" B
install -m 0755 "${staged_b}/bin/botctl" "${NEXA_BIN_DIR}/botctl"
install -m 0644 "${staged_b}/bin/nexa-lib.sh" "${NEXA_LIB_DIR}/nexa-lib.sh"
install -m 0644 "${staged_b}/compose.yml" "${NEXA_DEPLOY_DIR}/compose.yml"
rm -rf "$staged_b"
printf 'bin/botctl|%s|1\nbin/nexa-lib.sh|%s|1\ncompose.yml|%s|1\n' \
  "${NEXA_BIN_DIR}/botctl" "${NEXA_LIB_DIR}/nexa-lib.sh" "${NEXA_DEPLOY_DIR}/compose.yml" >"${gen}/journal"
assert_equals 'the fixture is not half-activated' 'B' "$(installed_label)"
assert_equals 'the fixture is not half-activated (routes)' 'A' "$(asset_label "${NEXA_DEPLOY_DIR}/caddy/routes.caddy")"
run_botctl status
assert_contains 'status did not report the interrupted activation' "$BOTCTL_OUTPUT" 'activation was interrupted'
# The next activation replays the restore FIRST, then applies. Driven through
# the library in a fresh shell so the paths are this root'"'"'s.
stage_release_assets "$DIGEST_C" C
recovery="$(bash -c '. "$NEXA_LIB" && nexa_activate_release_assets "$1"' _ "$DIGEST_C" 2>&1 || true)"
assert_contains 'the recovery was silent' "$recovery" 'interrupted'
c12_assert_intact C 'after recovering an interrupted activation and applying a new one'
# And a recovery whose restore is the LAST thing (nothing applied after it):
# rebuild the interruption, then activate A'"'"'s own set, which must first put
# A back from the journal and then re-apply A — the same files either way.
teardown_root

test_case 'C12: a failure after readiness rolls the host assets back with the application'
c12_fixture
fake_set "api_health_${DIGEST_B}" starting
NEXA_READY_TIMEOUT=6 run_botctl update vB
assert_fails 'an unready target reported success' test "$BOTCTL_STATUS" -eq 0
c12_assert_intact A 'after a target that never became ready'
teardown_root

# =============================================================================
# B-EXTRA-1 — the pre-migration preflight
# =============================================================================
setup_root
setup_fake_docker
seed_release 'v1.0.0' "$DIGEST_A"
write_live_assets A
seed_image_assets "$DIGEST_B" B
fake_set resolve_digest "$DIGEST_B"

test_case 'preflight: two PRIMARY tenants stop the update before the migration, after the backup'
fake_set preflight_exit 2
reset_docker_log
run_botctl update v2.0.0
log="$(docker_log)"
assert_fails 'an update that failed preflight reported success' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the preflight did not run from the TARGET image' "$log" "migrate.js --preflight [image=registry.test/nexa@${DIGEST_B}]"
# The migration command was never entered: every migrate.js line is the preflight.
assert_equals 'the migrator was entered after a failed preflight' '' \
  "$(printf '%s\n' "$log" | grep 'migrate.js' | grep -v -- '--preflight' || true)"
backup_at="$(printf '%s\n' "$log" | grep -n 'exec -T postgres pg_dump' | sed -n '1p' | cut -d: -f1)"
preflight_at="$(printf '%s\n' "$log" | grep -n -- '--preflight' | sed -n '1p' | cut -d: -f1)"
assert_ok 'no backup was taken before the preflight' test -n "$backup_at"
assert_ok 'the preflight ran before the backup' test "${backup_at:-9999}" -lt "${preflight_at:-0}"
assert_ok 'no backup file exists' test -n "$(find "$NEXA_BACKUP_DIR" -name '*.sql.gz' -print -quit)"
assert_equals 'the current release changed' 'v1.0.0' "$(cat "${NEXA_STATE_DIR}/current")"
assert_equals 'deploy.env was repointed' "registry.test/nexa@${DIGEST_A}" \
  "$(nexa_env_value "${NEXA_CONFIG_DIR}/deploy.env" NEXA_IMAGE)"
assert_fails 'a rollback target was invented' test -f "${NEXA_STATE_DIR}/previous"
assert_equals 'the host assets were touched before the preflight' 'A' "$(installed_label)"
assert_fails 'the target'"'"'s assets were staged before the preflight' test -d "$(assets_dir_for "$DIGEST_B")"
assert_contains 'the operator was not told the update stopped before migrating' \
  "$BOTCTL_OUTPUT" 'stopped BEFORE migrating'
assert_contains 'the check'"'"'s own sentence was not relayed' "$BOTCTL_OUTPUT" "kind = 'PRIMARY'"
assert_contains 'the sentence does not name the migration' "$BOTCTL_OUTPUT" '0015_single_primary_tenant'
assert_contains 'the operator was not pointed at the backup' "$BOTCTL_OUTPUT" "$NEXA_BACKUP_DIR"
assert_not_contains 'a stack trace was the explanation' "$BOTCTL_OUTPUT" 'at async'
assert_not_contains 'a raw driver error was the explanation' "$BOTCTL_OUTPUT" '23505'

test_case 'preflight: exactly one PRIMARY tenant lets the update proceed'
fake_set preflight_exit 0
run_botctl update v2.0.0
assert_equals 'a clean preflight did not let the update proceed' 0 "$BOTCTL_STATUS"
assert_equals 'the update did not advance' 'v2.0.0' "$(cat "${NEXA_STATE_DIR}/current")"
assert_contains 'the passing preflight was not reported' "$BOTCTL_OUTPUT" 'can take v2.0.0'"'"'s migrations'

teardown_root

# =============================================================================
# B-EXTRA-2 — v1 visibility in `botctl status`
# =============================================================================
status_secrets_probe() {
  run_botctl status
  printf '%s' "$BOTCTL_OUTPUT"
}

setup_root
setup_fake_docker
seed_release 'vA' "$DIGEST_A"

test_case 'status: a canonical keyring with no v1 rows reports the shutdown complete'
seed_nexa_env canonical
fake_set secrets_json '{"format":"canonical","acceptV1":false,"explicit":false,"v1Rows":0,"rows":4,"mismatched":0}'
out="$(status_secrets_probe)"
assert_contains 'the configuration was not named' "$out" 'configuration  canonical'
assert_contains 'acceptance was not reported as off by default' "$out" 'accept v1      no  (default)'
assert_contains 'the shutdown was not reported complete' "$out" 'v1 shutdown    complete'
assert_not_contains 'a warning was raised with nothing to warn about' "$out" 'WARNING'
assert_contains 'the old-backup caveat was dropped' "$out" 'backups taken before the re-encryption'
assert_contains 'readiness disappeared from status' "$out" 'readiness: ready'
assert_not_contains 'status printed the KEK' "$out" "$TEST_KEK"
assert_not_contains 'status printed a key id it had no need to' "$out" "$TEST_KEY_ID"

test_case 'status: a legacy configuration with v1 rows warns and names every step in order'
seed_nexa_env legacy
fake_set secrets_json '{"format":"legacy","acceptV1":true,"explicit":false,"v1Rows":3,"rows":4,"mismatched":0}'
out="$(status_secrets_probe)"
assert_contains 'the legacy configuration was not named' "$out" 'configuration  legacy'
assert_contains 'the default-on acceptance was not reported' "$out" 'accept v1      yes  (default)'
assert_contains 'the remaining rows were not counted' "$out" 'v1 rows        3 of 4'
assert_contains 'no warning about remaining v1 ciphertext' "$out" 'still hold v1 ciphertext'
for step in 'botctl secrets migrate-config' 'botctl secrets rewrap' 'botctl secrets shutdown-check' 'botctl secrets disable-v1'; do
  assert_contains "the remedy does not name ${step}" "$out" "$step"
done
assert_not_contains 'status printed the KEK' "$out" "$TEST_KEK"

test_case 'status: legacy configuration with NO v1 rows distinguishes compatibility from ciphertext'
fake_set secrets_json '{"format":"legacy","acceptV1":true,"explicit":false,"v1Rows":0,"rows":4,"mismatched":0}'
out="$(status_secrets_probe)"
assert_contains 'rows were not reported as zero' "$out" 'v1 rows        0 of 4'
assert_contains 'the compatibility-only case was not distinguished' "$out" 'no row holds v1 ciphertext, but v1 is still accepted'
assert_contains 'the conversion step was not named' "$out" 'botctl secrets migrate-config'
assert_not_contains 'rewrap was suggested with nothing to rewrap' "$out" 'botctl secrets rewrap'

test_case 'status: an explicit SECRETS_ACCEPT_V1=true on a canonical keyring is reported as explicit'
seed_nexa_env canonical
printf 'SECRETS_ACCEPT_V1=true\n' >>"${NEXA_CONFIG_DIR}/nexa.env"
fake_set secrets_json '{"format":"canonical","acceptV1":true,"explicit":true,"v1Rows":0,"rows":4,"mismatched":0}'
out="$(status_secrets_probe)"
assert_contains 'the explicit setting was reported as a default' "$out" 'accept v1      yes  (SECRETS_ACCEPT_V1)'
assert_contains 'the warning did not name the explicit setting' "$out" 'SECRETS_ACCEPT_V1=true'
assert_not_contains 'migrate-config was suggested on a canonical keyring' "$out" 'migrate-config'
assert_contains 'disable-v1 was not named' "$out" 'botctl secrets disable-v1'

test_case 'status: v1 rows with v1 NOT accepted is the loud case'
seed_nexa_env canonical
printf 'SECRETS_ACCEPT_V1=false\n' >>"${NEXA_CONFIG_DIR}/nexa.env"
fake_set secrets_json '{"format":"canonical","acceptV1":false,"explicit":true,"v1Rows":2,"rows":4,"mismatched":0}'
out="$(status_secrets_probe)"
assert_contains 'unreadable rows were not called out' "$out" 'cannot be read'
assert_contains 'the remedy did not say to re-enable v1 first' "$out" 'SECRETS_ACCEPT_V1=true'
assert_contains 'the remedy did not name rewrap' "$out" 'botctl secrets rewrap'

test_case 'status: when the application cannot answer, the rows are unable to determine, not zero'
seed_nexa_env legacy
fake_set secrets_json_exit 1
out="$(status_secrets_probe)"
assert_contains 'an unanswerable count was reported as a number' "$out" 'v1 rows        unable to determine'
assert_not_contains 'an unanswerable count was reported as zero' "$out" 'v1 rows        0'
assert_not_contains 'shutdown was declared complete without evidence' "$out" 'shutdown    complete'
assert_contains 'the operator was not pointed at the full command' "$out" 'botctl secrets status'
assert_contains 'readiness disappeared when the secrets read failed' "$out" 'readiness:'
fake_set secrets_json_exit 0

teardown_root

# =============================================================================
# Fix A — the real staging.8 host: version-keyed sets, digest-keyed rollback
# =============================================================================
# The exact state the staging host was in after staging.7's botctl performed
# the update to staging.8: both releases have manifests and digests, the
# assets directory holds only VERSION-named sets written by the old botctl,
# and there is no set under either digest. The rollback refused — safely —
# and this is the fixture that must not refuse any more, without trusting
# anything it should not.
DIGEST_S7="$DIGEST_A"
DIGEST_S8="$DIGEST_B"
staging8_host() {
  setup_root
  setup_fake_docker
  seed_release 'v0.1.0-staging.7' "$DIGEST_S7"
  seed_release 'v0.1.0-staging.8' "$DIGEST_S8"
  printf 'v0.1.0-staging.7\n' >"${NEXA_STATE_DIR}/previous"
  # The old botctl keyed by version. What it left is not evidence: staging.7's
  # directory is seeded with a set labelled M — a stale or tampered copy — and
  # the recovery must never install it.
  rm -rf "$(assets_dir_for "$DIGEST_S7")" "$(assets_dir_for "$DIGEST_S8")"
  mkdir -p "${NEXA_STATE_DIR}/assets/v0.1.0-staging.7" "${NEXA_STATE_DIR}/assets/v0.1.0-staging.8"
  write_asset_set "${NEXA_STATE_DIR}/assets/v0.1.0-staging.7" M
  write_asset_set "${NEXA_STATE_DIR}/assets/v0.1.0-staging.8" B
  write_live_assets B
  # The images, addressed by digest, carry their own sets and their own commit.
  seed_image_assets "$DIGEST_S7" A
  seed_image_assets "$DIGEST_S8" B
  fake_set "revision_${DIGEST_S7}" c0ffee
  fake_set "revision_${DIGEST_S8}" c0ffee
  # The staging.7 TAG has since been moved: resolving it would find C, and a
  # rollback that resolved it would install the wrong release.
  seed_image_assets "$DIGEST_C" C
  fake_set resolve_digest "$DIGEST_C"
  reset_docker_log
}

staging8_host
test_case 'Fix A: rollback recovers the previous release'"'"'s assets from its immutable image'
run_botctl rollback
log="$(docker_log)"
assert_equals 'the rollback failed on the real staging shape' 0 "$BOTCTL_STATUS"
assert_equals 'the live botctl is not staging.7'"'"'s' 'A' "$(installed_label)"
assert_equals 'the live compose file is not staging.7'"'"'s' 'A' "$(asset_label "${NEXA_DEPLOY_DIR}/compose.yml")"
assert_contains 'the recovery did not say what it did' "$BOTCTL_OUTPUT" 'recovered from'
assert_contains 'the previous image was not pulled BY DIGEST' "$log" "pull --quiet registry.test/nexa@${DIGEST_S7}"
assert_contains 'the assets were not read out of the previous image' "$log" "--entrypoint tar registry.test/nexa@${DIGEST_S7}"
assert_not_contains 'the previous VERSION tag was resolved' "$log" 'imagetools inspect'
assert_not_contains 'the previous VERSION tag was resolved (manifest)' "$log" 'manifest inspect'
assert_not_contains 'the moved tag'"'"'s digest was used' "$log" "$DIGEST_C"
assert_ok 'no set was recorded under the previous digest' test -s "$(assets_dir_for "$DIGEST_S7")/bin/botctl"
assert_equals 'the recorded set is not from the image' 'A' "$(asset_label "$(assets_dir_for "$DIGEST_S7")/bin/botctl")"
assert_equals 'current did not move' 'v0.1.0-staging.7' "$(cat "${NEXA_STATE_DIR}/current")"
assert_equals 'previous did not move' 'v0.1.0-staging.8' "$(cat "${NEXA_STATE_DIR}/previous")"
assert_equals 'deploy.env does not name the previous digest' \
  "registry.test/nexa@${DIGEST_S7}" "$(nexa_env_value "${NEXA_CONFIG_DIR}/deploy.env" NEXA_IMAGE)"
assert_fails 'an activation generation was left behind' test -d "${NEXA_STATE_DIR}/assets/.activating"
assert_not_contains 'the rollback touched the database' "$log" 'migrate.js'

test_case 'Fix A: the version-named directory was neither trusted nor copied'
for path in "${NEXA_BIN_DIR}/botctl" "${NEXA_LIB_DIR}/nexa-lib.sh" "${NEXA_DEPLOY_DIR}/compose.yml" \
  "${NEXA_DEPLOY_DIR}/nexa.env.template" "${NEXA_DEPLOY_DIR}/caddy/Caddyfile" "${NEXA_DEPLOY_DIR}/caddy/routes.caddy"; do
  assert_not_contains "the stale version directory went live via ${path##*/}" "$(cat "$path")" 'release M'
done
assert_not_contains 'the stale set reached the digest directory' \
  "$(cat "$(assets_dir_for "$DIGEST_S7")/bin/botctl")" 'release M'
# Left where it was, inert.
assert_equals 'the legacy directory was altered' 'M' "$(asset_label "${NEXA_STATE_DIR}/assets/v0.1.0-staging.7/bin/botctl")"

test_case 'Fix A: the current release'"'"'s own set was recovered under its digest too'
assert_ok 'no set was recorded under the current digest' test -s "$(assets_dir_for "$DIGEST_S8")/bin/botctl"
assert_equals 'the current set is not from its image' 'B' "$(asset_label "$(assets_dir_for "$DIGEST_S8")/bin/botctl")"
assert_contains 'the current image was not read by digest' "$log" "--entrypoint tar registry.test/nexa@${DIGEST_S8}"

test_case 'Fix A: the rollback can itself be rolled back, with both sets now recorded'
reset_docker_log
run_botctl rollback
assert_equals 'the second rollback failed' 0 "$BOTCTL_STATUS"
assert_equals 'the second rollback did not restore staging.8'"'"'s tooling' 'B' "$(installed_label)"
assert_not_contains 'a recorded set was extracted again' "$(docker_log)" '--entrypoint tar'
teardown_root

staging8_host
test_case 'Fix A: an unavailable previous image refuses the rollback before anything changes'
fake_set "pull_exit_${DIGEST_S7}" 1
run_botctl rollback
assert_fails 'a rollback without the previous image reported success' test "$BOTCTL_STATUS" -eq 0
# The pull by digest is the first thing a rollback does, and it is what refuses
# here: the image is gone, so the assets cannot be recovered from it either.
assert_contains 'the refusal did not say the image could not be pulled' "$BOTCTL_OUTPUT" "could not pull registry.test/nexa at ${DIGEST_S7}"
assert_contains 'the refusal did not say nothing changed' "$BOTCTL_OUTPUT" 'The current release is untouched'
assert_equals 'the refused rollback changed the live botctl' 'B' "$(installed_label)"
assert_equals 'the refused rollback moved current' 'v0.1.0-staging.8' "$(cat "${NEXA_STATE_DIR}/current")"
assert_fails 'a partial set was left under the previous digest' test -d "$(assets_dir_for "$DIGEST_S7")"
assert_fails 'a .partial directory was left behind' test -d "$(assets_dir_for "$DIGEST_S7").partial"
assert_fails 'an activation generation was left behind' test -d "${NEXA_STATE_DIR}/assets/.activating"
assert_not_contains 'the refused rollback fell back to the version directory' "$(cat "${NEXA_BIN_DIR}/botctl")" 'release M'
teardown_root

staging8_host
test_case 'Fix A: a previous image without a complete host-asset set refuses the rollback'
fake_set "assets_missing_${DIGEST_S7}" 1
run_botctl rollback
assert_fails 'a rollback from an image without assets reported success' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the refusal did not name the recovery' "$BOTCTL_OUTPUT" 'could not be recovered'
assert_contains 'the refusal did not say nothing changed' "$BOTCTL_OUTPUT" 'Nothing has been changed'
# The refusal is the recovery's own, before the rollback went any further:
# the current release's set was not touched, and activation never began.
assert_not_contains 'the rollback went on to the current release after the refusal' \
  "$(docker_log)" "--entrypoint tar registry.test/nexa@${DIGEST_S8}"
assert_not_contains 'activation was reached with nothing staged' "$BOTCTL_OUTPUT" 'no host assets are staged'
assert_equals 'the refused rollback changed the live botctl' 'B' "$(installed_label)"
assert_equals 'the refused rollback moved current' 'v0.1.0-staging.8' "$(cat "${NEXA_STATE_DIR}/current")"
assert_fails 'a set was recorded from an image that had none' test -d "$(assets_dir_for "$DIGEST_S7")"
teardown_root

staging8_host
test_case 'Fix A: an image whose commit disagrees with the manifest is not trusted'
fake_set "revision_${DIGEST_S7}" deadbeef
run_botctl rollback
assert_fails 'a rollback from a disagreeing image reported success' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the disagreement was not named' "$BOTCTL_OUTPUT" 'was built from deadbeef'
assert_contains 'the refusal did not say nothing changed' "$BOTCTL_OUTPUT" 'Nothing has been changed'
assert_not_contains 'a disagreeing image was still read for its assets' \
  "$(docker_log)" "--entrypoint tar registry.test/nexa@${DIGEST_S7}"
assert_not_contains 'the rollback went on to the current release after the refusal' \
  "$(docker_log)" "--entrypoint tar registry.test/nexa@${DIGEST_S8}"
assert_equals 'the refused rollback changed the live botctl' 'B' "$(installed_label)"
assert_fails 'a set was recorded from a disagreeing image' test -d "$(assets_dir_for "$DIGEST_S7")"
teardown_root

staging8_host
test_case 'Fix A: an activation failure during the recovered rollback restores the current set'
inject_activation_fault mv "${NEXA_DEPLOY_DIR}/compose.yml"
run_botctl rollback
clear_activation_fault
assert_fails 'a rollback whose activation failed reported success' test "$BOTCTL_STATUS" -eq 0
assert_equals 'the live botctl is not the current release'"'"'s after the failed activation' 'B' "$(installed_label)"
for path in "${NEXA_LIB_DIR}/nexa-lib.sh" "${NEXA_DEPLOY_DIR}/compose.yml" "${NEXA_DEPLOY_DIR}/nexa.env.template" \
  "${NEXA_DEPLOY_DIR}/caddy/Caddyfile" "${NEXA_DEPLOY_DIR}/caddy/routes.caddy"; do
  assert_equals "a failed activation left ${path##*/} half-applied" 'B' "$(asset_label "$path")"
done
assert_fails 'an activation generation was left behind' test -d "${NEXA_STATE_DIR}/assets/.activating"
assert_equals 'a failed activation moved current' 'v0.1.0-staging.8' "$(cat "${NEXA_STATE_DIR}/current")"
# And the recovered set is still there for the retry, which now succeeds.
run_botctl rollback
assert_equals 'the retry after the failed activation failed' 0 "$BOTCTL_STATUS"
assert_equals 'the retry did not install staging.7'"'"'s tooling' 'A' "$(installed_label)"
teardown_root

# An installation that already keys by digest is unchanged: no pull of the
# assets, no extraction, no recovery message.
setup_root
setup_fake_docker
seed_release 'vA' "$DIGEST_A"
write_live_assets A
stage_release_assets "$DIGEST_A" A
seed_image_assets "$DIGEST_B" B
fake_set resolve_digest "$DIGEST_B"
run_botctl update vB
test_case 'Fix A: an installation already keyed by digest rolls back exactly as before'
reset_docker_log
run_botctl rollback
assert_equals 'the ordinary rollback failed' 0 "$BOTCTL_STATUS"
assert_equals 'the ordinary rollback did not restore the previous tooling' 'A' "$(installed_label)"
assert_not_contains 'a recorded set was extracted again' "$(docker_log)" '--entrypoint tar'
assert_not_contains 'a recovery was announced with nothing to recover' "$BOTCTL_OUTPUT" 'recovering them'
teardown_root

report
