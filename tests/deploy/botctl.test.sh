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
  'api worker monitor recovery provisioner caddy' "$library_ready_services"

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
# The provisioner is required for the reason the monitor is, with money on it:
# it is the only process that turns a SETTLED order into an account on a panel,
# so an installation whose provisioner is dead takes payments, answers every
# health check, and creates nothing.
PROVISIONER_HEALTHY='{"Service":"provisioner","State":"running","Health":"healthy"}'
PROVISIONER_STARTING='{"Service":"provisioner","State":"running","Health":"starting"}'
PROVISIONER_UNHEALTHY='{"Service":"provisioner","State":"running","Health":"unhealthy"}'
PROVISIONER_EXITED='{"Service":"provisioner","State":"exited","Health":"unhealthy"}'
PROVISIONER_RESTARTING='{"Service":"provisioner","State":"restarting"}'

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

# --- D8: a running one-off must not hide a dead service container ------------
#
# The state-first rule fixed one direction of this — a health-carrying corpse
# no longer hides a healthy container — and left the other. A `compose run`
# container whose client was killed keeps RUNNING and carries the same Service
# and the same healthcheck, so it answered "starting" while the real api next
# to it had exited, and the fast-fail never fired: the update waited out the
# whole readiness timeout before backing out.
#
# Compose distinguishes them by NAME: a service container is
# <project>-<service>-<index>, a one-off is <project>-<service>-run-<id>. The
# fixtures above carry no Name at all, which is deliberate — the rule must
# degrade to the previous behaviour rather than change an answer it cannot
# justify, and every case above is still asserted unchanged.
ONEOFF_RUNNING='{"Name":"nexa-api-run-a1b2c3","Service":"api","State":"running","Health":"starting"}'
ONEOFF_DEAD='{"Name":"nexa-api-run-d4e5f6","Service":"api","State":"exited","Health":"starting"}'
SVC_API_DEAD='{"Name":"nexa-api-1","Service":"api","State":"exited","Health":"starting"}'
SVC_API_HEALTHY='{"Name":"nexa-api-2","Service":"api","State":"running","Health":"healthy"}'

parser_case 'D8: a running one-off does not hide an api that has died' \
  exited "${ONEOFF_RUNNING}\n${SVC_API_DEAD}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}"
parser_case 'D8: and not when it is listed after the corpse either' \
  exited "${SVC_API_DEAD}\n${ONEOFF_RUNNING}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}"
# The two directions the rule must NOT fire in, or it would back out releases
# that are working.
parser_case 'D8: a one-off corpse does not fast-fail a healthy api' \
  healthy "${ONEOFF_DEAD}\n${SVC_API_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}"
parser_case 'D8: a replaced container beside its replacement is not a failure' \
  healthy "${SVC_API_DEAD}\n${SVC_API_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}"

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

# --- 4D: the provisioner is the fourth ---------------------------------------
#
# The process that creates the thing the customer paid for. It was added to the
# production topology in this phase and NOT to the readiness list, so `botctl
# update`, rollback validation and `botctl status` would all have reported a
# release ready while it was absent, crash-looping or permanently unhealthy —
# and paid orders would have accumulated in PENDING_PROVISION with the
# deployment reported as a success. Each row isolates it: everything else is
# healthy.
PARSER_REQUIRED='api worker monitor provisioner'
parser_case '4D: the rest healthy but the provisioner STOPPED is not ready, and fast-fails' \
  exited "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}\n${PROVISIONER_EXITED}"
parser_case '4D: the rest healthy but the provisioner crash-loops is not ready' \
  restarting "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}\n${PROVISIONER_RESTARTING}"
parser_case '4D: the rest healthy but the provisioner unhealthy is not ready' \
  unhealthy "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}\n${PROVISIONER_UNHEALTHY}"
parser_case '4D: the rest healthy but the provisioner still starting is not ready yet' \
  starting "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}\n${PROVISIONER_STARTING}"
parser_case '4D: the previously accepted three-role shape is no longer ready' \
  '' "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}"
parser_case '4D: all four healthy is ready' \
  healthy "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}\n${PROVISIONER_HEALTHY}"
PARSER_REQUIRED='api worker monitor'

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

# --- DR: the recovery executor is the only process that can restore ----------
#
# It performs no requests and answers nothing, so "the container is running" is
# all an operator can see — and its absence has a symptom that looks exactly
# like its presence: a recovery an administrator CONFIRMED, with a CRITICAL
# permission and a typed phrase, sitting in RESTORE_REQUESTED for ever. A
# restore about to start and a restore that will never start are the same screen.
#
# Each row isolates the executor: everything else is healthy.
RECOVERY_HEALTHY='{"Service":"recovery","State":"running","Health":"healthy"}'
RECOVERY_STARTING='{"Service":"recovery","State":"running","Health":"starting"}'
RECOVERY_UNHEALTHY='{"Service":"recovery","State":"running","Health":"unhealthy"}'
RECOVERY_EXITED='{"Service":"recovery","State":"exited","Health":"unhealthy"}'
RECOVERY_RESTARTING='{"Service":"recovery","State":"restarting"}'

PARSER_REQUIRED='api worker monitor recovery'
parser_case 'DR: api + worker + monitor healthy but the executor STOPPED is not ready' \
  exited "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}\n${RECOVERY_EXITED}"
parser_case 'DR: an executor in a crash loop is not ready' \
  restarting "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}\n${RECOVERY_RESTARTING}"
parser_case 'DR: an unhealthy executor is not ready — its heartbeat is a real signal' \
  unhealthy "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}\n${RECOVERY_UNHEALTHY}"
parser_case 'DR: an executor still starting is not ready yet' \
  starting "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}\n${RECOVERY_STARTING}"
parser_case 'DR: an executor that never appears at all is not ready' \
  '' "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}"
parser_case 'DR: the four roles healthy is ready' \
  healthy "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}\n${RECOVERY_HEALTHY}"
parser_case 'DR: an executor one-off reporting starting beside a healthy executor is healthy' \
  healthy "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}\n${RECOVERY_STARTING}\n${RECOVERY_HEALTHY}"
# The rollback direction, for the same reason the monitor has one: a release
# that predates the executor defines no such service, and demanding one would
# time out every rollback to it AFTER the assets had already moved.
PARSER_REQUIRED='api worker monitor'
parser_case 'DR: a topology without an executor is ready without one' \
  healthy "${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}"

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
# All four application roles, so the edge rows below isolate the EDGE. Without
# the executor here, every row expecting `healthy` would be asserting about a
# topology that is missing a required service — and `D1: the whole topology
# healthy is ready` would have been testing the opposite of its name.
APP_HEALTHY="${RUN_HEALTHY}\n${WORKER_HEALTHY}\n${MONITOR_HEALTHY}\n${RECOVERY_HEALTHY}"

PARSER_REQUIRED='api worker monitor recovery caddy'
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
PARSER_REQUIRED='api worker monitor recovery'
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

test_case 'the installer never puts a secret into a process argument list'
# S3. `generate_secrets` substituted the template by passing the KEK and both
# database passwords as POSITIONAL ARGUMENTS to python3 — visible in `ps` to
# every user on the machine for as long as the interpreter ran. The installer
# says so itself, forty lines further down, about the owner password: "argv is
# readable by every user on the machine via `ps`". The rule was written and
# then broken three lines from where it was written.
#
# This drives the REAL `generate_secrets` with a python3 that records the argv
# it was handed and then execs the real interpreter, so the substitution still
# happens and the file it produces is the real one.
argv_log="${NEXA_ROOT}/python3-argv.log"
: >"$argv_log"
fake_bin="${NEXA_ROOT}/argvspy"
mkdir -p "$fake_bin"
real_python3="$(command -v python3)"
cat >"${fake_bin}/python3" <<FAKE
#!/usr/bin/env bash
printf '%s\n' "\$@" >>"${argv_log}"
exec "${real_python3}" "\$@"
FAKE
chmod 0755 "${fake_bin}/python3"

# A FRESH config directory, and that is load-bearing rather than tidy:
# `generate_secrets` is idempotent by design and returns without doing anything
# when the three files are already complete — which they are in this harness by
# the time this test runs. Pointed at the shared directory it generates
# nothing, invokes no interpreter, and the assertions below then pass against
# an empty log. The positive control catches that; this avoids it.
s3_config="${NEXA_ROOT}/etc/nexa-argv"
rm -rf "$s3_config"
install -d -m 0700 "$s3_config"

# A CHILD PROCESS, not a subshell: the environment this needs — a PATH with the
# spy in front and a config directory of its own — must not leak back into the
# rest of the suite, and a real installer run is its own process anyway.
#
# The installer is SOURCED there and one function called, never executed: a
# real run would install Docker on this machine.
install -m 0644 "${REPO}/deploy/nexa.env.template" "${NEXA_DEPLOY_DIR}/nexa.env.template"
# SC2031: the prefix is scoped to this one command ON PURPOSE — the spy must
# not be on the PATH of anything else in this suite, and the config directory
# must not leak either. "Might be lost" is the property being asked for.
# shellcheck disable=SC2031
PATH="${fake_bin}:${PATH}" NEXA_CONFIG_DIR="$s3_config" bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test >/dev/null 2>&1
  generate_secrets >/dev/null 2>&1
' _ "${REPO}/deploy/install.sh" || fail_test 'generate_secrets did not complete'

# THE POSITIVE CONTROL, and it is not decoration: without it this whole test
# passes when python3 is never invoked at all, which is exactly the shape of
# check this repository has been bitten by before.
assert_ok 'the argv spy was never invoked; the rest of this test proves nothing' \
  test -s "$argv_log"
assert_contains 'the spy did not see the template substitution' \
  "$(cat "$argv_log")" 'nexa.env.template'

# Read the generated values back and require that NONE of them appear in the
# recorded arguments. The values themselves are never printed: a failure names
# the key, never what it holds.
#
# The KEK is NOT stored under its own key. `SECRETS_KEYS` holds `<id>:<kek>`,
# because one key encrypts and all of them decrypt — so the value to look for
# is the part after the first colon. Reading a `SECRETS_KEK` that this format
# does not have yields the empty string, and `grep -F ''` matches every line:
# the first version of this check reported the KEK leaking out of a log that
# did not contain it. The emptiness guard below is what turns that into a loud
# failure instead of a confident wrong answer, in either direction.
s3_pg_password="$(nexa_env_value "${s3_config}/postgres.env" POSTGRES_PASSWORD)"
s3_redis_password="$(nexa_env_value "${s3_config}/redis.env" REDIS_PASSWORD)"
s3_keyring="$(nexa_env_value "${s3_config}/nexa.env" SECRETS_KEYS)"
s3_kek="${s3_keyring#*:}"

s3_webhook_secret="$(nexa_env_value "${s3_config}/nexa.env" TELEGRAM_WEBHOOK_SECRET)"

for secret_key in POSTGRES_PASSWORD REDIS_PASSWORD SECRETS_KEK TELEGRAM_WEBHOOK_SECRET; do
  case "$secret_key" in
    POSTGRES_PASSWORD) secret_value="$s3_pg_password" ;;
    REDIS_PASSWORD) secret_value="$s3_redis_password" ;;
    TELEGRAM_WEBHOOK_SECRET) secret_value="$s3_webhook_secret" ;;
    *) secret_value="$s3_kek" ;;
  esac
  # Length, not merely non-emptiness: a one-character needle would match almost
  # any log and prove nothing. Everything generated here is far longer.
  if [ "${#secret_value}" -lt 16 ]; then
    fail_test "generate_secrets produced no usable ${secret_key}; this check would be vacuous"
  fi
  if grep -qF -- "$secret_value" "$argv_log"; then
    fail_test "${secret_key} appeared in a process argument list"
  fi
done
printf '  %s\n' 'no generated secret reaches a process argument list'

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

test_case 'D12: the port preflight sees UDP, and only waives a port our own edge publishes'
# Two defects in one check. `ss -Hltn` is a TCP-LISTEN filter, so the 443/udp
# that compose.yml publishes for HTTP/3 was never looked at — a service holding
# it passed preflight and then made Caddy fail to bind. And the escape hatch
# counted containers named `nexa-caddy*` in `docker ps` and waived the conflict
# on any match, so a nexa-caddy that was up but bound to nothing waved an
# unrelated server through.
#
# The first fix for the second half asked `ss -p` for the holder's process
# NAME, which is no fix at all on a Docker host: EVERY published port is held
# by `docker-proxy`, so another stack's published 443 matched the same arm. The
# question is asked of Docker instead — which containers publish this port —
# and this is driven through the REAL `nexa_port_is_ours` against a stub
# `docker` on PATH, so what is exercised is the shipped predicate.
d12_bin="${NEXA_ROOT}/d12-bin"
D12_ANSWERS="${NEXA_ROOT}/d12-answers"
export D12_ANSWERS
mkdir -p "$d12_bin" "$D12_ANSWERS"

# Answers `docker ps --filter publish=<port>/<proto>` from a file per port and
# proto. An absent file is "nothing publishes it", which is what a host process
# holding the port looks like to Docker. A query that ALSO carries the compose
# project and service labels is answered from `<key>.ours`, so the stub can
# express the case the name prefix could not tell apart: a container called
# `nexa-caddy-something` that this installation did not create.
{
  printf '#!/usr/bin/env bash\n'
  printf '[ "$1" = ps ] || exit 0\n'
  printf 'key=""; labelled=0\n'
  printf 'for arg in "$@"; do case "$arg" in\n'
  printf '  publish=*) key="${arg#publish=}" ;;\n'
  printf '  label=com.docker.compose.service=*) labelled=1 ;;\n'
  printf 'esac; done\n'
  printf 'answer="${D12_ANSWERS}/${key//\\//-}"\n'
  printf '[ "$labelled" = 1 ] && answer="${answer}.ours"\n'
  printf '[ -r "$answer" ] && cat "$answer"\n'
  printf 'exit 0\n'
} >"${d12_bin}/docker"
chmod 0755 "${d12_bin}/docker"

# In a child process, so the stubbed PATH cannot leak into the rest of the suite.
d12_is_ours() {
  # shellcheck disable=SC2031
  # PATH is prefixed FOR THIS COMMAND only, which is the point: the stub must
  # be visible to the child that sources the library and to nothing else.
  PATH="${d12_bin}:${PATH}" bash -c '
    . "$1" >/dev/null 2>&1
    nexa_port_is_ours "$2" "$3"' _ "${REPO}/deploy/bin/nexa-lib.sh" "$1" "$2" >/dev/null 2>&1
}

# `publishers <key> <id>...` writes what publishes the port; `ours <key> <id>...`
# writes which of them carry this installation's compose labels.
d12_publishers() {
  local key="$1"
  shift
  printf '%s\n' "$@" >"${D12_ANSWERS}/${key}"
}
d12_ours() {
  local key="$1"
  shift
  if [ "$#" -eq 0 ]; then
    : >"${D12_ANSWERS}/${key}.ours"
  else
    printf '%s\n' "$@" >"${D12_ANSWERS}/${key}.ours"
  fi
}

rm -f "${D12_ANSWERS}"/443-* "${D12_ANSWERS}"/80-*
# 1. Nothing PUBLISHES it. The caller only asks once `ss` has already found a
#    listener, so this is a host process holding the port — a conflict, and the
#    same answer a preflight that cannot reach Docker must give.
assert_fails 'an unpublished port was claimed as ours' d12_is_ours 443 tcp

# 2. Our own edge publishes it. An idempotent rerun.
d12_publishers 443-tcp 'aaaa111'
d12_ours 443-tcp 'aaaa111'
assert_ok 'our own edge was reported as a conflict' d12_is_ours 443 tcp

# 3. ANOTHER STACK publishes it. This is the case the process-name check could
#    not see: on a Docker host that port is held by `docker-proxy` too.
d12_publishers 443-tcp 'bbbb222'
d12_ours 443-tcp
assert_fails 'another stack was accepted as our edge' d12_is_ours 443 tcp

# 4. Ours AND another stack's. A conflict even though ours is there: the edge
#    is about to be started and cannot bind. This is the exact shape the old
#    escape hatch waived.
d12_publishers 443-tcp 'aaaa111' 'bbbb222'
d12_ours 443-tcp 'aaaa111'
assert_fails 'a foreign publisher was waived because ours was there too' d12_is_ours 443 tcp

# 5. UDP is asked about at all. With the old TCP-only filter this port was
#    invisible; it is asked here on the proto the old code never used.
d12_publishers 443-udp 'cccc333'
d12_ours 443-udp
assert_fails 'a foreign publisher of 443/udp was accepted as ours' d12_is_ours 443 udp
d12_publishers 443-udp 'aaaa111'
d12_ours 443-udp 'aaaa111'
assert_ok 'our own 443/udp was reported as a conflict' d12_is_ours 443 udp

# 6. The finding. Every one of these satisfied `^nexa-caddy` and none of them is
#    this installation's edge: a second stack an operator named after ours, a
#    container a rename left behind, and one somebody made by hand. Identity is
#    the compose project and service labels, which Compose writes and an
#    operator does not, so none of the three carries them.
for impostor in nexa-caddy-foreign nexa-caddy-old nexa-caddy-test; do
  d12_publishers 443-tcp "$impostor"
  d12_ours 443-tcp
  assert_fails "a container named ${impostor} was accepted as our edge" d12_is_ours 443 tcp
done

# 7. And a name has stopped mattering in the other direction too: our edge is
#    ours because of its labels, whatever it is called.
d12_publishers 443-tcp 'renamed-edge'
d12_ours 443-tcp 'renamed-edge'
assert_ok 'our own edge was rejected because of its name' d12_is_ours 443 tcp

# 8. A foreign id that CONTAINS one of ours is still foreign. The comparison is
#    whole-line and literal for exactly this.
d12_publishers 443-tcp 'aaaa111' 'xaaaa111x'
d12_ours 443-tcp 'aaaa111'
assert_fails 'a foreign id containing ours was waived' d12_is_ours 443 tcp

# And preflight must actually ask, or the predicate above is unreachable.
installer_ports="$(sed -n '/--- Ports ---/,/ports 80 and 443 are free/p' "${REPO}/deploy/install.sh")"
assert_contains 'the port preflight never enumerates the udp proto' "$installer_ports" 'for proto in tcp udp'
assert_contains 'the port preflight does not ask whose the socket is' \
  "$installer_ports" 'nexa_port_is_ours'
assert_not_contains 'the port preflight still waives on a container name alone' \
  "$installer_ports" 'grep -c'
# The predicate identifies the edge by compose labels, not by a name prefix.
d12_predicate="$(sed -n '/^nexa_port_is_ours()/,/^}/p' "${REPO}/deploy/bin/nexa-lib.sh")"
assert_contains 'the edge is not identified by its compose project label' \
  "$d12_predicate" 'com.docker.compose.project'
assert_contains 'the edge is not identified by its compose service label' \
  "$d12_predicate" 'com.docker.compose.service'
assert_not_contains 'the edge is still identified by a container-name prefix' \
  "$d12_predicate" 'nexa-caddy'
unset D12_ANSWERS

test_case 'D3: the installer refuses a moved tag BEFORE it replaces the host tooling'
# `install_assets` overwrites compose.yml, the Caddyfile, nexa-lib.sh and
# botctl — the installed release's TOOLING. It ran before the digest was even
# resolved, so a rerun of a version whose tag had moved was refused exactly as
# designed and stopped with the host already carrying this checkout's tooling
# over the release that is actually running. A refusal that says nothing was
# changed has to be true when it says it.
#
# Asserted on the ORDER of the calls in `main`, because that is the rule: the
# suite cannot run the installer for real, and a test that called the two
# functions itself would assert its own ordering rather than the installer's.
installer_main="$(sed -n '/^main() {/,/^}/p' "${REPO}/deploy/install.sh")"
assets_at="$(printf '%s\n' "$installer_main" | grep -n '^ *install_assets$' | sed -n '1s/:.*//p')"
refusal_at="$(printf '%s\n' "$installer_main" | grep -n 'refuse_digest_change "\$digest"' | sed -n '1s/:.*//p')"
secrets_at="$(printf '%s\n' "$installer_main" | grep -n '^ *generate_secrets$' | sed -n '1s/:.*//p')"
assert_ok 'main does not call install_assets' test -n "$assets_at"
assert_ok 'main does not call refuse_digest_change' test -n "$refusal_at"
assert_ok 'main does not call generate_secrets' test -n "$secrets_at"
assert_ok 'the host tooling is replaced before the moved-tag refusal' \
  test "${refusal_at:-9999}" -lt "${assets_at:-0}"
# And the other bound: `generate_secrets` substitutes into the nexa.env.template
# that `install_assets` puts there, so it cannot move above it.
assert_ok 'the secrets are generated before the template they substitute into is installed' \
  test "${assets_at:-9999}" -lt "${secrets_at:-0}"

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

test_case 'harness: a second root seeds the resolved environment too'
# `setup_root` seeds nexa.env, and the environment Compose resolves from it, BEFORE
# `setup_fake_docker` runs. The fake's state directory used to be setup_fake_docker's,
# so every root after the first wrote that environment into the previous root's
# deleted directory — a `No such file` warning on stderr and a `status` that resolved
# nothing, in 57 tests, under a green suite. Asserted on a root that is not the first,
# before the fake docker is installed, which is exactly where it went wrong.
assert_equals 'the fake directory is not under THIS root' "${NEXA_ROOT}/fake" "$FAKE_DIR"
assert_ok 'the resolved environment was not seeded into this root' test -s "${FAKE_DIR}/compose_env"

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

test_case "an update whose back-out cannot restore the tooling does not restart under it"
# The rule the subshell fix inverted. `nexa_activate_release_assets` reports
# through `nexa_die`, so before this branch a failed restore TERMINATED botctl
# — badly, with an internal message instead of the diagnosis, which is what D6
# is about. Subshelling it without making its status part of the verdict
# replaced that with something worse: the back-out fell through to
# `nexa_compose up -d`, starting ${current} under ${target}'s compose file,
# and then told the operator the installation was consistent. The comment three
# lines above that call forbids exactly this.
fake_set "up_exit_${DIGEST_B}" 1
# Make the restore reach the activation and fail inside it: the set is present
# so the caller does not skip it, and one file in it is empty so activation
# refuses.
outgoing_dir="$(assets_dir_for "$DIGEST_A")"
assert_ok "vA's host assets are not recorded, so this case cannot run" \
  test -s "${outgoing_dir}/bin/botctl"
cp -p "${outgoing_dir}/bin/botctl" "${NEXA_ROOT}/outgoing-botctl.saved"
: >"${outgoing_dir}/bin/botctl"
run_botctl update vB
cp -p "${NEXA_ROOT}/outgoing-botctl.saved" "${outgoing_dir}/bin/botctl"
rm -f "${NEXA_ROOT}/outgoing-botctl.saved" "${FAKE_DIR}/up_exit_${DIGEST_B}"
assert_fails 'an update whose back-out failed reported success' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the failed restore was not reported' "$BOTCTL_OUTPUT" 'could not restore'
assert_contains 'a failed restore did not stop the restart' "$BOTCTL_OUTPUT" 'NOT restarting'
assert_not_contains 'a back-out that could not restore claimed the release was back' \
  "$BOTCTL_OUTPUT" 'is running again'
# And it is reported as the stranded case, which is what it is.
assert_contains 'the stranded state was not named' "$BOTCTL_OUTPUT" 'did not come back cleanly'
# Put the installation back on a consistent footing for the cases below.
run_botctl update vA >/dev/null 2>&1 || true
assert_equals 'the repair left the wrong release current' 'vA' "$(cat "${NEXA_STATE_DIR}/current")"

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

test_case 'D2: a rollback that starts but is not ready puts the current release back'
# The readiness path is where the old code left the installation describing
# itself incorrectly. `up -d` has already SUCCEEDED by then, so the containers
# are running the previous release — while `nexa_commit_release` is never
# reached, so the recorded release and deploy.env both still say the current
# one and AGREE with each other. `nexa_check_divergence` compares exactly those
# two, so it saw nothing wrong, and every later `botctl status` named a release
# that was not what was running.
#
# Restoring the assets was not enough. The containers have to come back too,
# which is what an UPDATE's back-out has always done.
fake_set "api_health_${DIGEST_A}" starting
reset_docker_log
run_botctl rollback
assert_fails 'a rollback that never became ready reported success' test "$BOTCTL_STATUS" -eq 0
assert_equals 'the failed rollback moved the current release' 'vB' "$(cat "${NEXA_STATE_DIR}/current")"
assert_equals "the failed rollback left the previous release's botctl installed" 'B' "$(installed_label)"
assert_contains 'the operator was not told the current release came back' \
  "$BOTCTL_OUTPUT" 'is running again'
# The containers were actually brought back, not merely described as back: the
# LAST `up` in the log is the one without the previous image's digest.
last_up="$(docker_log | grep 'up -d' | tail -1)"
assert_ok 'nothing was started after the failed rollback' test -n "$last_up"
assert_not_contains 'the last thing started was still the rollback target' \
  "$last_up" "$DIGEST_A"
fake_set "api_health_${DIGEST_A}" healthy

test_case 'a rollback back-out with NOTHING recorded to restore does not restart either'
# The other half of the same rule, and the one `return 0` hid. "There is
# nothing to put back" is not "the tooling is back": the rollback has already
# activated ${previous}'s compose file by this point, so starting ${current}'s
# image would run it under a topology it was never released with — and the
# verdict would say the installation is consistent.
#
# Driven by removing the CURRENT release's recorded set entirely, which is the
# state an installation reaches when its assets could not be recorded on the
# way out (the D9 case below), and then failing the rollback's start.
#
# Removing the directory is not enough on its own: the rollback re-records the
# current release's set on the way out, from its image or from the live files.
# All three routes have to be closed for the back-out to find nothing.
missing_dir="$(assets_dir_for "$DIGEST_B")"
mv "$missing_dir" "${missing_dir}.aside"
fake_set "assets_missing_${DIGEST_B}" 1
mv "${NEXA_DEPLOY_DIR}/caddy/routes.caddy" "${NEXA_ROOT}/routes.caddy.aside"
fake_set "up_exit_${DIGEST_A}" 1
run_botctl rollback
rb_output="$BOTCTL_OUTPUT"
rb_status="$BOTCTL_STATUS"
mv "${NEXA_ROOT}/routes.caddy.aside" "${NEXA_DEPLOY_DIR}/caddy/routes.caddy" 2>/dev/null || true
rm -f "${FAKE_DIR}/up_exit_${DIGEST_A}" "${FAKE_DIR}/assets_missing_${DIGEST_B}"
rm -rf "$missing_dir"
mv "${missing_dir}.aside" "$missing_dir"
assert_fails 'a rollback whose back-out could not restore reported success' \
  test "$rb_status" -eq 0
assert_contains 'an unrecorded set was not reported' "$rb_output" 'are not recorded'
assert_contains 'nothing to restore did not stop the restart' "$rb_output" 'NOT restarting'
assert_not_contains 'a back-out with nothing to restore claimed the release was back' \
  "$rb_output" 'is running again'

test_case 'D9: recording the outgoing assets reports and RETURNS at every failure'
# `nexa_capture_live_assets` reported four of its five failures through
# `nexa_die`, which exits the process. Its rollback caller invokes it as
# `... || nexa_capture_live_assets ... || nexa_warn`, whose comment says "a
# rollback whose target is sound must not be refused for the sake of its own
# undo" — an intent the `||` could never carry out, because there was nothing
# left to run. Same shape as the `cmd_backup` hazard this file documents.
#
# ALL FOUR converted sites, not one. The first version of this test drove only
# the bad-digest path, so reverting any of the other three left the suite
# green — and the end-to-end case it was paired with drove the ONE branch that
# already returned before the change, so it passed on the unfixed code too.
#
# A non-zero status alone cannot tell "returned 1" from "exited 1", so each
# probe prints a marker AFTER the call and the marker is the assertion.
d9_probe() {
  bash -c '
    . "$1" >/dev/null 2>&1
    NEXA_ASSETS_DIR="$2"
    '"$2"'
    nexa_capture_live_assets "$3" v1.0.0 >/dev/null 2>&1
    printf "SURVIVED:%s\n" "$?"' _ "${REPO}/deploy/bin/nexa-lib.sh" "$1" "$3" 2>/dev/null || true
}
d9_dir="${NEXA_ROOT}/d9-assets"
rm -rf "$d9_dir"; mkdir -p "$d9_dir"

# 1. `nexa_assets_path` refuses a malformed digest.
out="$(d9_probe "$d9_dir" ':' 'not-a-digest')"
assert_contains 'a malformed digest killed the caller' "$out" 'SURVIVED:'
assert_not_contains 'a malformed digest was reported as success' "$out" 'SURVIVED:0'

# 2. `mkdir -p` cannot create the staging directory. The obstruction has to be
#    the assets DIRECTORY itself — the function does `rm -rf "$partial"` first,
#    so anything placed at the staging path is removed before mkdir sees it.
D9_DIGEST='sha256:1111111111111111111111111111111111111111111111111111111111111111'
d9_file="${NEXA_ROOT}/d9-not-a-dir"
: >"$d9_file"
out="$(d9_probe "$d9_file" ':' "$D9_DIGEST")"
assert_contains 'a failed mkdir killed the caller' "$out" 'SURVIVED:'
assert_not_contains 'a failed mkdir was reported as success' "$out" 'SURVIVED:0'

# 3. `cp` cannot copy a destination that is readable but is a DIRECTORY. This
#    is the branch a missing file does NOT reach: `[ -r ]` is true for a
#    directory, and `cp` without -r then fails.
D9_DIGEST2='sha256:2222222222222222222222222222222222222222222222222222222222222222'
d9_hostdir="${NEXA_ROOT}/d9-host"
rm -rf "$d9_hostdir"; mkdir -p "${d9_hostdir}/bin" "${d9_hostdir}/caddy"
out="$(d9_probe "$d9_dir" 'NEXA_DEPLOY_DIR="'"${d9_hostdir}"'"; NEXA_BIN_DIR="'"${d9_hostdir}"'/bin"; NEXA_LIB_DIR="'"${d9_hostdir}"'"; mkdir -p "${NEXA_DEPLOY_DIR}/compose.yml"' "$D9_DIGEST2")"
assert_contains 'a failed copy killed the caller' "$out" 'SURVIVED:'
assert_not_contains 'a failed copy was reported as success' "$out" 'SURVIVED:0'

# 4. The missing-destination branch, which was ALREADY report-and-return before
#    the change. Asserted so the set is complete and so a future edit that made
#    it fatal would be caught, not because it falsifies this one.
D9_DIGEST3='sha256:3333333333333333333333333333333333333333333333333333333333333333'
out="$(d9_probe "$d9_dir" 'NEXA_DEPLOY_DIR="'"${NEXA_ROOT}"'/d9-empty"; NEXA_BIN_DIR="'"${NEXA_ROOT}"'/d9-empty/bin"; NEXA_LIB_DIR="'"${NEXA_ROOT}"'/d9-empty"' "$D9_DIGEST3")"
assert_contains 'a missing destination killed the caller' "$out" 'SURVIVED:'
assert_not_contains 'a missing destination was reported as success' "$out" 'SURVIVED:0'
rm -rf "$d9_dir" "$d9_hostdir"

test_case 'D9: a rollback whose target is sound is not refused for the sake of its own undo'
# End to end. The CURRENT release's recorded set is removed and its recovery
# from its own image refused, and one of the live files it would otherwise be
# captured from is gone — so its assets cannot be recorded by any route. The
# rollback TARGET is untouched and entirely sound, and must proceed.
#
# This drives the MISSING-DESTINATION branch, which already reported-and-
# returned before this change, so it does NOT falsify the four converted
# `nexa_die`s — the probes above do that. What it pins is the other half of
# D9, which is the CALLER's contract: `|| nexa_warn` and carry on, rather than
# treat a failure to record the undo as a reason to refuse the rollback.
current_digest_dir="$(assets_dir_for "$DIGEST_B")"
mv "$current_digest_dir" "${current_digest_dir}.hidden"
fake_set "assets_missing_${DIGEST_B}" 1
mv "${NEXA_DEPLOY_DIR}/caddy/routes.caddy" "${NEXA_ROOT}/routes.caddy.hidden"
run_botctl rollback
mv "${NEXA_ROOT}/routes.caddy.hidden" "${NEXA_DEPLOY_DIR}/caddy/routes.caddy" 2>/dev/null || true
rm -f "${FAKE_DIR}/assets_missing_${DIGEST_B}"
assert_equals 'a sound rollback was refused because its undo could not be recorded' \
  0 "$BOTCTL_STATUS"
assert_equals 'the sound rollback did not become current' 'vA' "$(cat "${NEXA_STATE_DIR}/current")"
assert_contains 'the operator was not warned that the undo cannot be recorded' \
  "$BOTCTL_OUTPUT" 'could not be recorded'
# Put the recorded set and the installation back, explicitly, rather than
# leaving the cases below to inherit whatever this one happened to produce.
rm -rf "$current_digest_dir"
mv "${current_digest_dir}.hidden" "$current_digest_dir"
run_botctl update vB
assert_equals 'the installation was not put back on vB' 'vB' "$(cat "${NEXA_STATE_DIR}/current")"

test_case 'D6: a restore that cannot finish does not replace the diagnosis'
# `nexa_activate_release_assets` reports its failures through `nexa_die`, which
# EXITS. Called directly in a back-out path, a restore that could not finish
# terminated botctl before the `nexa_die` that tells the operator which release
# started — so the operator read an internal message about a staged file
# instead of what had happened to their installation.
fake_set "up_exit_${DIGEST_A}" 1
current_digest_dir="$(assets_dir_for "$DIGEST_B")"
assert_ok "vB's host assets are not recorded, so this case cannot run" \
  test -s "${current_digest_dir}/bin/botctl"
# The restore must REACH the activation and fail INSIDE it. Removing the staged
# directory would not do: `restore_current_assets` checks `nexa_assets_staged`
# first and returns without calling activation at all, so the failure under test
# would never happen. The set is left in place and one file in it is emptied,
# which is what activation refuses ("staged X is missing or empty") — through
# `nexa_die`, which is the exit this guards against.
: >"${current_digest_dir}/bin/botctl"
run_botctl rollback
run_botctl_status_after_d6="$BOTCTL_STATUS"
d6_output="$BOTCTL_OUTPUT"
rm -rf "$current_digest_dir"
rm -f "${FAKE_DIR}/up_exit_${DIGEST_A}"
assert_fails 'a rollback that could not start reported success' \
  test "$run_botctl_status_after_d6" -eq 0
# NOT `did not start`: botctl warns that before the back-out runs, so that
# string is present whether or not the subshell exists and the assertion naming
# the defect proved nothing. The diagnosis that must survive is the FINAL one,
# which only prints if the back-out did not terminate the process.
assert_contains 'the failure of the back-out replaced the diagnosis' \
  "$d6_output" 'NEITHER release has been deleted'
# And the back-out's own failure is still reported — silenced would be as bad
# as fatal.
assert_contains 'the failed restore was not reported at all' \
  "$d6_output" "could not restore"
# The rule the review found inverted: a back-out that could not put the tooling
# back must not start anything under the tooling that IS there, and must not
# tell the operator the installation is consistent.
assert_contains 'a failed restore did not stop the restart' \
  "$d6_output" 'NOT restarting'
assert_not_contains 'a failed back-out claimed the current release was back' \
  "$d6_output" 'is running again'
# Put the installation back, explicitly. The failed back-out deliberately left
# vA's tooling on the host with vB still recorded as current — which is the
# very inconsistency asserted above — so `update vB` alone would take the
# already-current path and repair nothing. A real rollback then a real update
# rebuilds both the recorded set and the host tooling.
run_botctl rollback
assert_equals 'the repair rollback did not reach vA' 'vA' "$(cat "${NEXA_STATE_DIR}/current")"
run_botctl update vB
assert_equals 'the repair update did not reach vB' 'vB' "$(cat "${NEXA_STATE_DIR}/current")"
assert_equals "the repair left the wrong release's botctl installed" 'B' "$(installed_label)"

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

test_case "the refusal scanner tracks quotes for every record, not only assignments"
# Tracking is SHARED STATE, which is why this detector cannot keep a narrower tracker than
# the others. Measured on v5.1.1: NOTE opens a value that closes on the `DUMMY='` line, and
# `SECRETS_KEYS:realkeyring` after it IS set. A tracker that opened a region only on
# `NAME=` took `DUMMY='` for the opener, swallowed the rest and reported NO unreadable
# record — so with the legacy pair also present, `migrate-config` would have appended the
# old SECRETS_KEK as the canonical keyring, which Compose prefers, making every existing
# ciphertext undecryptable. A false negative here is the write this refusal exists to
# prevent, which is the opposite of what this function's comment used to claim.
seed_nexa_env legacy
printf '%s\n' "NOTE:'first" "DUMMY='" 'SECRETS_KEYS:realkeyring' \
  >>"${NEXA_CONFIG_DIR}/nexa.env"
before="$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
run_botctl secrets migrate-config
assert_fails "a hidden effective SECRETS_KEYS record was converted over" \
  test "$BOTCTL_STATUS" -eq 0
assert_contains "the refusal did not name the unreadable shape" \
  "$BOTCTL_OUTPUT" 'in a form Compose reads and this conversion cannot'
assert_equals "the refused conversion modified the file" \
  "$before" "$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
# And the refusal is not unconditional, or it is just a broken command: an ordinary legacy
# host still converts, and a colon inside a VALUE — which the keyring grammar always has —
# is not a record separator.
seed_nexa_env legacy
run_botctl secrets migrate-config
assert_equals "an ordinary legacy host stopped converting" '0' "$BOTCTL_STATUS"
assert_fails "the conversion wrote no keyring" test -z "$(nexa_env_key SECRETS_KEYS)"

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

test_case "a traced disable-v1 prints no database password"
# The rewriter is the other place a secret is held by necessity: it is handed the keys to
# write BY NAME and expands those names to append the lines, and it then proves the
# candidate file would still boot by reading DATABASE_URL back out of it. Under `bash -x`
# that read-back printed the database password on EVERY call — so `secrets disable-v1`,
# which writes nothing secret at all, leaked it anyway. `botctl update` is the same path
# through `nexa_reconcile_app_env`; it happens to capture the subshell's stderr, which is
# why this command and not that one is the case that can observe the rule.
fake_set shutdown_ready 1
seed_nexa_env canonical
trace="$(bash -x "$BOTCTL" secrets disable-v1 2>&1 || true)"
assert_not_contains 'a traced shutdown printed the database password' "$trace" 'nexa:pw'
assert_not_contains 'a traced shutdown printed the key material' "$trace" "$TEST_KEK"
# And the run was real: traced, and it reached the write.
assert_contains 'nothing was traced at all' "$trace" '+ '
assert_equals 'SECRETS_ACCEPT_V1 was not set to false' 'false' "$(nexa_env_key SECRETS_ACCEPT_V1)"
# Deliberately NOT re-seeded: the case below asserts that rerunning is free, which needs
# the state this one leaves — SECRETS_ACCEPT_V1 already false on a canonical keyring.
# Re-seeding here made that case perform the change instead of declining it.

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

test_case 'secrets migrate-config: a substitution is refused, not frozen'
# This command REWRITES nexa.env, so it reads the FILE: writing what Compose resolved
# would freeze an interpolation meant to be evaluated at every start. But then neither
# reading is safe when the value IS a substitution — the literal `${VAULT_KEK}` is not a
# key, and the resolved one is a key the file was never meant to contain — so it refuses
# rather than choosing. Choosing wrong here leaves an installation that cannot decrypt.
seed_nexa_env empty
append_resolved_env 'SECRETS_KEK=${VAULT_KEK}' 'SECRETS_KEK_ID=install-1'
before="$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
run_botctl secrets migrate-config || true
assert_contains 'the refusal did not name the cause' "$BOTCTL_OUTPUT" 'substitution'
assert_equals 'the file was changed by a refused conversion' "$before" \
  "$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
assert_not_contains 'the refusal printed key material' "$BOTCTL_OUTPUT" 'VAULT_KEK}'
seed_nexa_env canonical

test_case 'secrets migrate-config: a record shape it cannot read is refused, not converted'
# This command reads the FILE and writes the FILE, and a bare record is the one shape
# whose value is not in the file. Measured on Compose v5.1.1, with `SECRETS_KEK=old`
# followed by a bare `SECRETS_KEK` and that variable exported:
#
#   SECRETS_KEK=old            container receives `ambientvalue`  — the LAST record wins
#   SECRETS_KEK                and a bare record takes the ambient value
#
# `nexa_compose_env_value` scans the file, so it answers `old`. Converting on that writes
# the STALE key as SECRETS_KEYS while reporting that the key material is unchanged, and
# the restart it advises then leaves every existing ciphertext undecryptable. Refused,
# like the `$` case, because choosing wrong here cannot be undone from the file.
seed_nexa_env empty
append_resolved_env 'SECRETS_KEK=b2xkLWtleS1tYXRlcmlhbC1uZXZlci1wcmludGVk' 'SECRETS_KEK_ID=install-1'
printf 'SECRETS_KEK\n' >>"${NEXA_CONFIG_DIR}/nexa.env"
before="$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
run_botctl secrets migrate-config || true
assert_contains 'the refusal did not name the shape' "$BOTCTL_OUTPUT" 'BARE record'
assert_contains 'the refusal did not name the key' "$BOTCTL_OUTPUT" 'SECRETS_KEK'
assert_equals 'the file was changed by a refused conversion' "$before" \
  "$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
assert_not_contains 'the refusal printed key material' \
  "$BOTCTL_OUTPUT" 'b2xkLWtleS1tYXRlcmlhbC1uZXZlci1wcmludGVk'
# And SECRETS_KEYS is in the refused set too, because a bare record for IT makes the
# already-canonical check read empty — so the command would convert over a keyring the
# application is already running from.
seed_nexa_env empty
append_resolved_env 'SECRETS_KEK=b2xkLWtleS1tYXRlcmlhbC1uZXZlci1wcmludGVk' 'SECRETS_KEK_ID=install-1'
printf 'SECRETS_KEYS\n' >>"${NEXA_CONFIG_DIR}/nexa.env"
before="$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
run_botctl secrets migrate-config || true
assert_contains 'a bare SECRETS_KEYS record was converted over' "$BOTCTL_OUTPUT" 'BARE record'
assert_equals 'the file was changed by a refused conversion' "$before" \
  "$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
# The COLON shape is refused too, and it is the worse case: measured on v5.1.1,
# `SECRETS_KEYS:realkeyring` is effective and a LATER `SECRETS_KEYS=...` wins, so this
# command read no SECRETS_KEYS, called the host legacy, and appended the old SECRETS_KEK as
# the canonical keyring — which Compose then prefers over the keyring the application is
# actually running with. The restart it advises would make every existing row unreadable.
seed_nexa_env empty
append_resolved_env 'SECRETS_KEK=b2xkLWtleS1tYXRlcmlhbC1uZXZlci1wcmludGVk' 'SECRETS_KEK_ID=install-1'
printf 'SECRETS_KEYS:aWQ6cmVhbC1rZXlyaW5n\n' >>"${NEXA_CONFIG_DIR}/nexa.env"
before="$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
run_botctl secrets migrate-config || true
assert_contains 'a colon-form keyring was converted over' \
  "$BOTCTL_OUTPUT" 'a form Compose reads and this conversion cannot'
assert_equals 'the file was changed by a refused conversion' "$before" \
  "$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
assert_not_contains 'the refusal printed key material' \
  "$BOTCTL_OUTPUT" 'aWQ6cmVhbC1rZXlyaW5n'
# And a colon inside a VALUE is not a colon RECORD: `id:key` is the canonical keyring
# grammar, so a detector that fired on it would refuse every well-formed host there is.
seed_nexa_env empty
append_resolved_env 'SECRETS_KEK=b2xkLWtleS1tYXRlcmlhbC1uZXZlci1wcmludGVk' 'SECRETS_KEK_ID=install-1'
assert_fails 'a colon inside a value was read as an unreadable record' \
  nexa_env_has_unreadable_record "${NEXA_CONFIG_DIR}/nexa.env" SECRETS_KEK
# Nor is a colon line inside another variable's multiline value.
printf "NOTE='line one\nSECRETS_KEYS:interior\nline three'\n" >>"${NEXA_CONFIG_DIR}/nexa.env"
assert_fails 'an interior colon line was read as a record' \
  nexa_env_has_unreadable_record "${NEXA_CONFIG_DIR}/nexa.env" SECRETS_KEYS
# And the WHITESPACE shape, which is the same family one separator over and turned up a
# round after the colon form was closed alone. Measured on v5.1.1: `SECRETS_KEYS =realkey`,
# a tab before the `=`, and `export SECRETS_KEYS =realkey` are all effective, and a later
# `SECRETS_KEYS=` wins over them — so this command would have appended the stale key as the
# canonical keyring on a host whose real one is written that way.
seed_nexa_env empty
append_resolved_env 'SECRETS_KEK=b2xkLWtleS1tYXRlcmlhbC1uZXZlci1wcmludGVk' 'SECRETS_KEK_ID=install-1'
printf 'SECRETS_KEYS =aWQ6cmVhbC1rZXlyaW5n\n' >>"${NEXA_CONFIG_DIR}/nexa.env"
before="$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
run_botctl secrets migrate-config || true
assert_contains 'a whitespace-form keyring was converted over' \
  "$BOTCTL_OUTPUT" 'a form Compose reads and this conversion cannot'
assert_equals 'the file was changed by a refused conversion' "$before" \
  "$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
assert_not_contains 'the refusal printed key material' \
  "$BOTCTL_OUTPUT" 'aWQ6cmVhbC1rZXlyaW5n'
# A tab before the `=` is the same shape, and a space AFTER the `=` is not: `KEY= value` is
# read by the value reader exactly as Compose reads it, so refusing it would refuse a file
# that converts correctly.
seed_nexa_env empty
printf 'SECRETS_KEYS\t=x\n' >>"${NEXA_CONFIG_DIR}/nexa.env"
assert_ok 'a tab before the equals was not seen' \
  nexa_env_has_unreadable_record "${NEXA_CONFIG_DIR}/nexa.env" SECRETS_KEYS
seed_nexa_env empty
printf 'SECRETS_KEYS= x\n' >>"${NEXA_CONFIG_DIR}/nexa.env"
assert_fails 'a space AFTER the equals was refused' \
  nexa_env_has_unreadable_record "${NEXA_CONFIG_DIR}/nexa.env" SECRETS_KEYS
# A file with neither shape still converts: the refusal is the shape, not the command.
seed_nexa_env empty
append_resolved_env 'SECRETS_KEK=b2xkLWtleS1tYXRlcmlhbC1uZXZlci1wcmludGVk' 'SECRETS_KEK_ID=install-1'
run_botctl secrets migrate-config
assert_contains 'a clean legacy file was refused' "$BOTCTL_OUTPUT" 'the key id is install-1'
seed_nexa_env canonical

test_case 'nexa_untraced turns tracing off and puts it back exactly as it found it'
# The OFF half is covered by three command-level cases. The RESTORE half was not:
# deleting the restore line left all checks green, because every command that uses this
# helper has nothing traced after it returns. A rule with no test is a rule that will be
# silently reverted, so this calls the helper directly, in both directions.
#
# Tracing ON before the call must be ON after it: a command that went dark for the rest
# of its run after one untraced step is the diagnostic failure this helper is bounded to
# avoid, and `deploy/install.sh` is not the only script that may come to wrap a step.
untraced_probe="$( ( set -x; nexa_untraced true; echo AFTER ) 2>&1 )"
assert_contains 'tracing was not restored after the untraced call' \
  "$untraced_probe" '+ echo AFTER'
assert_not_contains 'the body was traced' "$untraced_probe" '+ true'
# And tracing OFF before the call must stay OFF: turning it on for a caller that never
# asked would print the rest of that command, which for `secrets migrate-config` is the
# read-back of the keyring.
untraced_probe="$( ( nexa_untraced true; echo AFTER ) 2>&1 )"
assert_not_contains 'tracing was turned ON for a caller that had it off' \
  "$untraced_probe" '+ echo AFTER'
# And after a FAILING body, which is the whole reason the status is captured rather than
# let through: a restore written as "only when the body succeeded" passes every assertion
# above and loses tracing for the rest of a command that hit a refusal — exactly when an
# operator running under `-x` needs the rest.
untraced_probe="$( ( set -x; nexa_untraced false; echo AFTER ) 2>&1 )"
assert_contains 'tracing was not restored after a FAILING body' \
  "$untraced_probe" '+ echo AFTER'
# The status is the body's, not the helper's own bookkeeping.
nexa_untraced true && untraced_status=0 || untraced_status=$?
assert_equals 'a succeeding body did not return 0' 0 "$untraced_status"
nexa_untraced false && untraced_status=0 || untraced_status=$?
assert_equals 'a failing body did not return its own status' 1 "$untraced_status"
nexa_untraced bash -c 'exit 7' && untraced_status=0 || untraced_status=$?
assert_equals 'a body exiting 7 did not return 7' 7 "$untraced_status"

test_case 'secrets migrate-config: a traced run prints no key material'
# This command HOLDS the master key by necessity: it reads SECRETS_KEK out of the file
# and writes it back under the canonical name. Under `bash -x` the capture, the blank
# test, the `id:key` concatenation, the rewriter's own `printf` and the read-back each
# printed it — six times — and then the command printed that the key material "was never
# printed". The `status` sections were fixed for exactly this and this command, the one
# that actually moves the key, was left open. `botctl status` is what sends an operator
# here, and a command that rewrites /etc/nexa/nexa.env is one they run under `-x`.
seed_nexa_env legacy
trace="$(bash -x "$BOTCTL" secrets migrate-config 2>&1 || true)"
assert_not_contains 'a traced conversion printed the key material' "$trace" "$TEST_KEK"
assert_not_contains 'a traced conversion printed the database password' "$trace" 'nexa:pw'
# And the run was real: tracing was on, and the conversion reached its own success line.
# Without both, this would pass against a command that refused at its first line.
assert_contains 'nothing was traced at all' "$trace" '+ '
assert_contains 'the conversion did not complete' "$trace" 'was never printed'
assert_contains 'the converted keyring was not written' \
  "$(cat "${NEXA_CONFIG_DIR}/nexa.env")" 'SECRETS_KEYS='
seed_nexa_env canonical

test_case 'status: a traced run prints no resolved value'
# `bash -x` is what an operator reaches for when `botctl status` misbehaves, and the
# resolved listing holds DATABASE_URL, the keyring and the backup bot token. Capturing
# it into a variable and expanding it as an argument put every one of them in the
# trace — in a command whose output is deliberately safe to paste into a ticket. Both
# sections run with tracing off now, and this asserts that on the trace itself.
seed_nexa_env canonical
fake_set compose_env ''
fake_set compose_env_json '{"DATABASE_URL":"postgres://nexa:tracepw@postgres:5432/nexa","REDIS_URL":"r","SECRETS_KEYS":"k1:TRACEKEYMATERIAL","SECRETS_ACTIVE_KEY_ID":"k1","BACKUP_TELEGRAM_CHAT_ID":"-1001","BACKUP_TELEGRAM_BOT_TOKEN":"777:TRACEBOTTOKEN"}'
trace="$(bash -x "$BOTCTL" status 2>&1 || true)"
assert_not_contains 'a traced run printed the keyring' "$trace" 'TRACEKEYMATERIAL'
assert_not_contains 'a traced run printed the bot token' "$trace" 'TRACEBOTTOKEN'
assert_not_contains 'a traced run printed the database password' "$trace" 'tracepw'
# And the trace is still a trace: the surrounding command IS traced, or this would
# pass against a botctl that simply printed nothing.
assert_contains 'nothing was traced at all' "$trace" '+ '
# Both sections must have REACHED the resolved listing, or the secret assertions above
# are vacuous. `capabilities` alone proved nothing: under `bash -x` the call itself
# traces as `+ status_capabilities`, which contains that word, so the guard passed with
# `compose_config_fails=1` (both sections print REFUSED and never read the listing) and
# with both bodies replaced by `return 0`. These two rows cannot come from a trace line:
# the value is a separate argv word in the `printf`, so the format string a trace would
# echo carries `%-8s` and `%s`, never `configured` or `canonical` in those columns. And
# each row is reachable only THROUGH the listing — `backup delivery` needs both
# BACKUP_TELEGRAM_* present in it, `configuration  canonical` needs SECRETS_KEYS.
assert_contains 'the capability section never read the resolved listing' \
  "$trace" 'backup delivery    configured'
assert_contains 'the secrets section never read the resolved listing' \
  "$trace" 'configuration  canonical'
fake_set compose_env_json ''
seed_nexa_env canonical

test_case 'status: an explicit SECRETS_ACCEPT_V1 outside the enum is invalid, not a default'
# `SECRETS_ACCEPT_V1` is z.enum(['true', 'false']), so `yes` — a spelling several other
# settings in this very section accept — and a value with a trailing newline are
# configurations the API REFUSES to start on. Reporting the keyring-derived default
# for them describes an acceptance state no container can reach, which is the same
# lie as a capability reported `on` for a value the schema rejects.
seed_nexa_env canonical
fake_set compose_env ''
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","SECRETS_KEYS":"k1:v","SECRETS_ACTIVE_KEY_ID":"k1","SECRETS_ACCEPT_V1":"yes"}'
fake_set secrets_json '{"format":"canonical","acceptV1":false,"explicit":false,"v1Rows":0,"rows":4,"mismatched":0}'
out="$(status_secrets_probe)"
assert_contains 'a value outside the enum was reported as a derived default' \
  "$out" 'accept v1      invalid'
assert_contains 'the reason was not named' "$out" 'neither true nor false'
# And the claim is scoped: an API started before the edit keeps the acceptance it was
# created with, so the refusal must not say no acceptance state is in force anywhere.
assert_contains 'the refusal claimed no acceptance state is in force anywhere' \
  "$out" 'keeps the acceptance it was created with'
assert_not_contains 'the refusal over-claimed about the running API' \
  "$out" 'no acceptance state is in force'
assert_not_contains 'an unreachable acceptance state was presented as in force' \
  "$out" 'accept v1      no  (default)'
# Compose is NOT what refuses here — the listing resolved, which is how the value was
# read — so the container IS created and then exits on the schema error. Saying it
# cannot be created sends the operator away from `botctl logs api`, where the reason is.
assert_contains 'the refusal did not say the API will not start' \
  "$out" 'will not START from this configuration'
assert_not_contains 'the refusal blamed compose for a refusal it did not make' \
  "$out" 'no API can be CREATED'
assert_contains 'the operator was not sent to the log that carries the reason' \
  "$out" 'botctl logs api'
# And the log promise is SCOPED. An API already running was created with a value the
# schema accepted, so its log has no refusal to show, and this branch returns before the
# one-off that would produce one — so "logs api shows the refusal" was an instruction
# that produces nothing until a recreate has been attempted and failed.
assert_contains 'the log promise was not scoped to after the attempt' \
  "$out" 'AFTER that attempt'
assert_contains 'the reason an already-running API shows nothing was not given' \
  "$out" 'has nothing to show'
# And NO ROW is printed. Every row below is counted by a one-off `compose run` container
# created from THIS configuration, which cannot start either — so a row here is either
# attributed to the wrong process or invented. The fall-through is the dangerous one:
# `$accept` has three values and the guards below test only `no` and `yes`, so an
# `invalid` acceptance used to reach `v1 shutdown complete: … v1 not accepted` — an
# acceptance state no container can reach, which is the lie this case exists to kill.
assert_not_contains 'a row was counted from a configuration no container can read' \
  "$out" 'v1 rows'
assert_not_contains 'an unreachable acceptance state was reported as a completed shutdown' \
  "$out" 'v1 shutdown'
assert_contains 'the absence of rows was left looking like a stack that is down' \
  "$out" 'No row is shown below'
# And the claim is about the rows BELOW: the two above it — the configuration and the
# acceptance — came from the resolved listing, not from any container, so saying "every
# row in this section" contradicted the two lines printed immediately before.
assert_contains 'the paragraph disowned the two rows it had just printed' \
  "$out" 'every row BELOW'
assert_not_contains 'the paragraph claimed every row in the section comes from a container' \
  "$out" 'every row in this'
# A value with a trailing newline is the same case: the rendering is `false\\n`, which
# is not the spelling the enum allows.
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","SECRETS_KEYS":"k1:v","SECRETS_ACTIVE_KEY_ID":"k1","SECRETS_ACCEPT_V1":"false\n"}'
out="$(status_secrets_probe)"
assert_contains 'a trailing newline was accepted as the enum value' \
  "$out" 'accept v1      invalid'
# And exactly `false` is still explicit rather than invalid, so this is about the
# vocabulary and not about refusing every present value.
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","SECRETS_KEYS":"k1:v","SECRETS_ACTIVE_KEY_ID":"k1","SECRETS_ACCEPT_V1":"false"}'
out="$(status_secrets_probe)"
assert_contains 'an exact enum value was reported as invalid' \
  "$out" 'accept v1      no  (SECRETS_ACCEPT_V1)'
fake_set compose_env_json ''
seed_nexa_env canonical

test_case 'status: an explicit SECRETS_ACCEPT_V1=true on a canonical keyring is reported as explicit'
seed_nexa_env canonical
append_resolved_env 'SECRETS_ACCEPT_V1=true'
fake_set secrets_json '{"format":"canonical","acceptV1":true,"explicit":true,"v1Rows":0,"rows":4,"mismatched":0}'
out="$(status_secrets_probe)"
assert_contains 'the explicit setting was reported as a default' "$out" 'accept v1      yes  (SECRETS_ACCEPT_V1)'
assert_contains 'the warning did not name the explicit setting' "$out" 'SECRETS_ACCEPT_V1=true'
assert_not_contains 'migrate-config was suggested on a canonical keyring' "$out" 'migrate-config'
assert_contains 'disable-v1 was not named' "$out" 'botctl secrets disable-v1'

test_case 'status: v1 rows with v1 NOT accepted is the loud case'
seed_nexa_env canonical
append_resolved_env 'SECRETS_ACCEPT_V1=false'
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

# =============================================================================
# The edge adopts the release's own configuration — the staging.9 -> .11 defect
# =============================================================================
# What happened on a real staging host, confirmed by the owner:
#
#   v0.1.0-staging.9 -> v0.1.0-staging.11. The api, worker and monitor were
#   updated, the migrations applied, the new Web Admin bundle published, every
#   container HEALTHY, `botctl update` reported SUCCESS and readiness passed.
#   And Caddy was still the container from .9, serving .9's routes — whose
#   asset root was `/srv/web` rather than the `/srv/web/current` +
#   `/srv/web/pool` pair .11 uses. The server reported .11; every browser got
#   .9's Web Admin. Only a manual force-recreation fixed it.
#
# The cause is not a bug in any one line. The Caddy configuration is a host
# asset, bind-mounted read-only, and `nexa_activate_release_assets` replaces it
# on disk — which changes no SERVICE DEFINITION, so `docker compose up -d`
# correctly decides the caddy service is converged. Caddy does not watch its
# config and `admin off` leaves nothing to reload through.
#
# The fix gives compose a definition that does change: `NEXA_EDGE_CONFIG` in the
# caddy service's environment, a fingerprint of the activated files. Every case
# below is about that value being right at every step, including the ones where
# the update fails.
#
# The fake models the edge container's own generation and two ways it can go
# wrong: `edge_sticky`, where `up -d` leaves it alone (the real defect), and
# `edge_never`, where even a forced recreation does not adopt it.

# The generation deploy.env records, and the generation the fake edge container
# is actually running. Equal is the only correct state.
recorded_edge() { nexa_env_value "${NEXA_CONFIG_DIR}/deploy.env" NEXA_EDGE_CONFIG 2>/dev/null || printf ''; }
running_edge() { cat "${FAKE_DIR}/edge_running" 2>/dev/null || printf ''; }

edge_host() {
  setup_root
  setup_fake_docker
  seed_release 'v1.0.0' "$DIGEST_A"
  # The installation starts CONSISTENT, and the label matters: `seed_release`
  # stages v1.0.0's set under its digest labelled with the version, so the live
  # files have to carry the same label or a back-out would restore a different
  # set than the one that was live and every before/after comparison below would
  # be measuring the fixture rather than the code.
  write_live_assets v1.0.0
  seed_image_assets "$DIGEST_B" B
  fake_set resolve_digest "$DIGEST_B"
  set_live_edge_generation
  reset_docker_log
}

# Put the fake edge container on the generation the LIVE files define, by asking
# the real library for it. Not a hand-written constant: the fingerprint is a
# function of file content, and a constant here would stop tracking it.
set_live_edge_generation() {
  fake_set edge_running "$(NEXA_DEPLOY_DIR="$NEXA_DEPLOY_DIR" bash -c '
    . "'"$NEXA_LIB"'" 2>/dev/null
    nexa_edge_config_fingerprint')"
}

edge_host
test_case 'update: the edge ends on the target release'"'"'s configuration generation'
before="$(running_edge)"
run_botctl update v2.0.0
assert_equals 'the update failed' 0 "$BOTCTL_STATUS"
# The generation CHANGED, which is what says release B's Caddy files are now
# the ones in force. Without this the case would pass on an installation where
# nothing about the edge differs between releases.
assert_fails 'the edge generation did not change at all' test "$before" = "$(running_edge)"
# And the running container agrees with what was recorded. This is the exact
# assertion the staging host would have failed: deploy.env said .11, the
# container was .9's.
assert_equals 'the running edge does not match what deploy.env records' \
  "$(recorded_edge)" "$(running_edge)"
assert_contains 'the update did not report the edge generation' "$BOTCTL_OUTPUT" 'edge configuration is'
teardown_root

edge_host
test_case 'update: an edge that `up -d` leaves alone is recreated, and the update still succeeds'
# THE STAGING DEFECT, reproduced. `up -d` returns zero and changes nothing about
# the edge container — exactly what compose does for a changed bind-mounted file.
fake_set edge_sticky 1
run_botctl update v2.0.0
assert_equals 'the update failed when the edge needed recreating' 0 "$BOTCTL_STATUS"
log="$(docker_log)"
# ONE service, by name. "Do not blindly destroy unrelated containers" is a
# requirement, not a preference: postgres holds the database.
assert_contains 'the edge was not force-recreated' "$log" 'up -d --force-recreate --no-deps caddy'
assert_not_contains 'the forced recreation was not scoped to the edge' "$log" '--force-recreate --no-deps postgres'
assert_not_contains 'the forced recreation was not scoped to the edge' "$log" '--force-recreate --no-deps redis'
assert_not_contains 'the whole stack was force-recreated' "$log" 'up -d --force-recreate --remove-orphans'
assert_equals 'the edge still does not match what deploy.env records' \
  "$(recorded_edge)" "$(running_edge)"
assert_contains 'the repair was silent' "$BOTCTL_OUTPUT" 'recreating just that container'
teardown_root

edge_host
test_case 'update: an edge that will not adopt the target configuration FAILS the update'
# The case that makes this honest. Everything else about the release works — the
# image pulls, the migration runs, the containers are healthy — and the edge
# cannot be brought onto the target's configuration. A success here is the
# staging lie: a server reporting the new release while browsers get the old
# Web Admin.
fake_set edge_never 1
run_botctl update v2.0.0
assert_fails 'the update succeeded with the edge on the wrong configuration' test "$BOTCTL_STATUS" -eq 0
assert_equals 'the target became current anyway' 'v1.0.0' "$(cat "${NEXA_STATE_DIR}/current")"
assert_contains 'the failure did not name the edge' "$BOTCTL_OUTPUT" 'edge'
# The back-out ran: release A's tooling is back on the host.
assert_equals 'the outgoing release'"'"'s host assets were not restored' 'v1.0.0' "$(installed_label)"
teardown_root

edge_host
test_case 'update: a back-out starts the edge under the OUTGOING release'"'"'s generation'
# The other direction of the same defect. A back-out that brought the edge up
# under the FAILED release's configuration would leave the previous release's
# application behind the new release's routes — whose hashed asset names it does
# not publish.
outgoing="$(running_edge)"
fake_set "up_exit_${DIGEST_B}" 1
run_botctl update v2.0.0
assert_fails 'the update reported success while the target would not start' test "$BOTCTL_STATUS" -eq 0
assert_equals 'the outgoing release'"'"'s host assets were not restored' 'v1.0.0' "$(installed_label)"
assert_equals 'the edge was left on the failed release'"'"'s generation' "$outgoing" "$(running_edge)"
log="$(docker_log)"
# The generation is visible per call in the fake's log, so "which generation did
# the back-out start under" is a question a test can actually ask.
assert_contains 'no call carried the outgoing generation' "$log" "[edge=${outgoing}]"
teardown_root

edge_host
test_case 'update: two releases with identical edge configuration do not recreate the edge'
# Churn is a cost. Most releases do not change the edge, and recreating it on
# every update would drop connections and re-bind ports for nothing — so the
# fingerprint is over CONTENT, and identical content must produce the same
# value. This is also what stops the mechanism from being a disguised
# `--force-recreate` on every update.
# The SAME label, so release B's Caddy files are byte-identical to the live
# ones. The label is what `write_asset_set` stamps into every file, so a
# different label is a different edge configuration.
seed_image_assets "$DIGEST_B" v1.0.0
before="$(running_edge)"
run_botctl update v2.0.0
assert_equals 'the update failed' 0 "$BOTCTL_STATUS"
assert_equals 'an identical edge configuration produced a different generation' \
  "$before" "$(running_edge)"
assert_not_contains 'the edge was recreated for an unchanged configuration' \
  "$(docker_log)" '--force-recreate'
teardown_root

edge_host
test_case 'rollback: the edge returns to the rollback release'"'"'s generation'
run_botctl update v2.0.0
assert_equals 'the update failed' 0 "$BOTCTL_STATUS"
after_update="$(running_edge)"
reset_docker_log
run_botctl rollback
assert_equals 'the rollback failed' 0 "$BOTCTL_STATUS"
assert_fails 'the edge stayed on the release that was rolled away from' \
  test "$after_update" = "$(running_edge)"
assert_equals 'the edge does not match what deploy.env records after the rollback' \
  "$(recorded_edge)" "$(running_edge)"
assert_contains 'the rollback did not say which edge configuration is in force' \
  "$BOTCTL_OUTPUT" "the edge serves"
teardown_root

edge_host
test_case 'restart: the edge adopts the configuration that is installed'
# `botctl status` tells an operator to run `botctl restart` when the running edge
# disagrees with the host. That advice has to be true, and a plain `up -d` does
# not make it true — which is the whole defect, one level down.
fake_set edge_running 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
run_botctl restart
assert_equals 'the restart failed' 0 "$BOTCTL_STATUS"
assert_equals 'the restart left the edge on a stale generation' \
  "$(recorded_edge)" "$(running_edge)"
assert_contains 'the restart did not say which edge configuration is in force' \
  "$BOTCTL_OUTPUT" 'the edge serves'
teardown_root

edge_host
test_case 'status: a stale edge is REPORTED, not silent'
# The staging host's real failure was that nothing said so. Every container
# healthy, the right version recorded, the wrong Web Admin being served, and no
# command that would have told the operator.
fake_set edge_running 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
run_botctl status
assert_contains 'status did not report the edge generation' "$BOTCTL_OUTPUT" 'edge configuration:'
assert_contains 'status did not report the running edge' "$BOTCTL_OUTPUT" 'edge container:'
assert_contains 'status did not warn about the mismatch' "$BOTCTL_OUTPUT" 'DIFFERENT configuration generation'
assert_contains 'status did not say what a browser would get' "$BOTCTL_OUTPUT" "previous release's Web Admin"
assert_contains 'status did not say how to fix it' "$BOTCTL_OUTPUT" "botctl restart"
teardown_root

edge_host
test_case 'status: an edge that agrees with the host says so and does not warn'
# The other direction, so the warning above is not simply always printed.
run_botctl status
assert_contains 'status did not report the edge as serving the installed configuration' \
  "$BOTCTL_OUTPUT" 'serving it'
assert_not_contains 'status warned about a mismatch that does not exist' \
  "$BOTCTL_OUTPUT" 'DIFFERENT configuration generation'
teardown_root

# =============================================================================
# Configuration upgrade audit — capability visibility and obsolete keys
# =============================================================================
#
# `botctl status` reported version, containers, edge, secrets and readiness, and
# nothing about the capabilities whose default is OFF. An installation that never
# added BACKUP_SCHEDULE_ENABLED takes no automatic backups, which is the correct
# default and was an invisible state.

# A line in the file AND in what Compose resolves from it, which is the ordinary case:
# an assignment Compose passes through literally. `botctl status` asks
# `docker compose config` now, so a helper that only wrote the file would leave every
# capability at its default. A case that wants the two to DIVERGE sets the fake
# `compose_env` itself — the only way to express a divergence now that nothing in
# `deploy/` parses env_file semantics for reporting.
append_env() { append_resolved_env "$@"; }

setup_root
setup_fake_docker
seed_release 'vA' "$DIGEST_A"
fake_set secrets_json '{"format":"canonical","acceptV1":false,"explicit":false,"v1Rows":0,"rows":4,"mismatched":0}'

test_case 'status: an installation that never configured backups is told so'
seed_nexa_env canonical
run_botctl status
assert_contains 'the capabilities section is missing' "$BOTCTL_OUTPUT" 'capabilities, as compose resolves'
assert_contains 'the scheduled backup default was not reported as off' \
  "$BOTCTL_OUTPUT" 'scheduled backup   off'
assert_contains 'an unconfigured destination was not reported' \
  "$BOTCTL_OUTPUT" 'backup delivery    not configured'
assert_contains 'the operator was not told this configuration takes no automatic backup' \
  "$BOTCTL_OUTPUT" 'takes no AUTOMATIC backup'
assert_contains 'the local-retention behaviour was not explained' \
  "$BOTCTL_OUTPUT" 'NOT_ATTEMPTED'
assert_contains 'the remedy was not named' "$BOTCTL_OUTPUT" 'BACKUP_SCHEDULE_ENABLED=true'
# The defaults that are ON must read as on, or the section is just a list of offs.
assert_contains 'recovery upload was not reported as on by default' \
  "$BOTCTL_OUTPUT" 'recovery upload    on'
assert_contains 'the panel monitor was not reported as on by default' \
  "$BOTCTL_OUTPUT" 'panel monitor      on'

test_case 'status: a chat id that is only a no-break space is not configured'
# The schema trims the destination with JavaScript's `.trim()`, whose whitespace set
# includes the no-break space; the shell's `[[:space:]]` does not. A chat id of one
# U+00A0 is nothing to the application — a half-configured destination the next start
# refuses — and "present" to a shell test, which reported it configured.
seed_nexa_env canonical
fake_set compose_env ''
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","BACKUP_TELEGRAM_CHAT_ID":" ","BACKUP_TELEGRAM_BOT_TOKEN":"123456:AAAfakeToken"}'
run_botctl status
assert_contains 'a no-break-space chat id was read as present' \
  "$BOTCTL_OUTPUT" 'backup delivery    HALF configured'
# And a chat id with real characters around such a space is present, so this is about
# the trim and not about refusing the character.
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","BACKUP_TELEGRAM_CHAT_ID":"-100 1","BACKUP_TELEGRAM_BOT_TOKEN":"123456:AAAfakeToken"}'
run_botctl status
assert_contains 'a chat id containing a no-break space was read as absent' \
  "$BOTCTL_OUTPUT" 'backup delivery    configured'
# The set is the SCHEMA's, not whichever set the interpreter happens to have.
# Measured: Python trims U+FEFF and U+001C..U+001F; JavaScript trims the first and
# NOT the second. So a byte-order mark alone is absent to the application, and a file
# separator alone is a VALUE — `value.strip()` gets the second one backwards, and
# nothing in this suite could see that until these two cases.
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","BACKUP_TELEGRAM_CHAT_ID":"\ufeff","BACKUP_TELEGRAM_BOT_TOKEN":"123456:AAAfakeToken"}'
run_botctl status
assert_contains 'a byte-order-mark chat id was read as present, which the schema trims away' \
  "$BOTCTL_OUTPUT" 'backup delivery    HALF configured'
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","BACKUP_TELEGRAM_CHAT_ID":"\u001c","BACKUP_TELEGRAM_BOT_TOKEN":"123456:AAAfakeToken"}'
run_botctl status
assert_contains 'a file-separator chat id was trimmed away, which the schema does not do' \
  "$BOTCTL_OUTPUT" 'backup delivery    configured'
fake_set compose_env_json ''
seed_nexa_env canonical

test_case 'status: a boolean with a trailing newline is invalid, not on'
# Compose lets a quoted value span lines, so `BACKUP_SCHEDULE_ENABLED='true\n'` reaches
# the container as `true` WITH the newline and `booleanish` refuses it. The validator
# read the DECODED value through a command substitution, which drops a trailing
# newline, so it saw `true` and reported `on` for a configuration the next start
# refuses. It reads the listing's rendering now, where that value is `true\n` and
# matches no accepted spelling.
seed_nexa_env canonical
fake_set compose_env ''
fake_set compose_env_json "$(printf '{"DATABASE_URL":"d","REDIS_URL":"r","BACKUP_SCHEDULE_ENABLED":"true\\n","PANEL_MONITOR_ENABLED":"false\\n"}')"
run_botctl status
assert_contains 'a booleanish value with a trailing newline was reported as on' \
  "$BOTCTL_OUTPUT" 'scheduled backup   invalid'
assert_contains 'a strict-enum value with a trailing newline was reported as off' \
  "$BOTCTL_OUTPUT" 'panel monitor      invalid'
# And the same values without the newline are read normally, so this is about the
# boundary rather than about refusing every value.
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","BACKUP_SCHEDULE_ENABLED":"true","PANEL_MONITOR_ENABLED":"false"}'
run_botctl status
assert_contains 'a clean booleanish value stopped being read' "$BOTCTL_OUTPUT" 'scheduled backup   on'
assert_contains 'a clean strict value stopped being read' "$BOTCTL_OUTPUT" 'panel monitor      off'
fake_set compose_env_json ''
seed_nexa_env canonical

test_case 'status: a null entry Compose resolved is an absent variable, not an empty one'
# A bare `KEY` line in nexa.env takes the variable from the host, and when the host
# has none the application never receives it and applies its default. Compose v5.1.1
# omits such a key from `config` output; the Compose contract also allows a null. A
# null rendered as `KEY=` would turn that default into an invalid explicit empty value.
seed_nexa_env canonical
fake_set compose_env ''
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","PANEL_MONITOR_ENABLED":null}'
run_botctl status
assert_contains 'a null entry was reported as an invalid empty value' \
  "$BOTCTL_OUTPUT" 'panel monitor      on'
assert_not_contains 'a null entry read as invalid' "$BOTCTL_OUTPUT" 'panel monitor      invalid'
fake_set compose_env_json ''
seed_nexa_env canonical

test_case 'status: a destination that resolves to only a newline is not configured'
# The listing renders a newline as the two characters `\n` so that one entry is one
# line, and `nexa_listing_present` trims through that rendering. A reader of the
# RENDERING would see two non-blank characters where the application — which
# `.trim()`s the chat id — sees nothing, and report a destination as configured that
# the next start refuses as half-configured. This is the case that keeps the decode
# honest: the secret length is measured elsewhere, so nothing else could observe it.
seed_nexa_env canonical
fake_set compose_env ''
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","BACKUP_TELEGRAM_CHAT_ID":"\n","BACKUP_TELEGRAM_BOT_TOKEN":"123456:AAAfakeToken"}'
run_botctl status
assert_contains 'a chat id that is only a newline was read as present' \
  "$BOTCTL_OUTPUT" 'backup delivery    HALF configured'
assert_not_contains 'status printed the token' "$BOTCTL_OUTPUT" 'AAAfakeToken'
fake_set compose_env_json ''
seed_nexa_env canonical

test_case 'status: a configured schedule and destination stop the advice, and print no token'
seed_nexa_env canonical
append_env 'BACKUP_SCHEDULE_ENABLED=true' \
  'BACKUP_TELEGRAM_CHAT_ID=-1001234567890' \
  'BACKUP_TELEGRAM_BOT_TOKEN=123456:AAsecrettokenvalue'
run_botctl status
assert_contains 'an enabled schedule was not reported' "$BOTCTL_OUTPUT" 'scheduled backup   on'
assert_contains 'a configured destination was not reported' \
  "$BOTCTL_OUTPUT" 'backup delivery    configured'
assert_not_contains 'the advice was printed to an installation that does not need it' \
  "$BOTCTL_OUTPUT" 'takes no AUTOMATIC backup'
assert_not_contains 'status printed the delivery bot token' \
  "$BOTCTL_OUTPUT" 'AAsecrettokenvalue'
assert_not_contains 'status printed the delivery chat id' "$BOTCTL_OUTPUT" '-1001234567890'

test_case 'status: a half-configured destination is named as half, not as configured'
seed_nexa_env canonical
append_env 'BACKUP_TELEGRAM_CHAT_ID=-1001234567890'
run_botctl status
assert_contains 'a half-configured destination was not reported' \
  "$BOTCTL_OUTPUT" 'backup delivery    HALF configured'
assert_not_contains 'status printed the chat id' "$BOTCTL_OUTPUT" '-1001234567890'

test_case 'status: every spelling the application accepts is read the same way'
# `booleanish` takes true/false/1/0/yes/no. A reader that took only `true` would
# report a monitor an operator enabled with `yes` as disabled.
for spelling in true 1 yes; do
  seed_nexa_env canonical
  append_env "BACKUP_SCHEDULE_ENABLED=${spelling}"
  run_botctl status
  assert_contains "the spelling ${spelling} was not read as on" \
    "$BOTCTL_OUTPUT" 'scheduled backup   on'
done
for spelling in false 0 no; do
  seed_nexa_env canonical
  append_env "RECOVERY_UPLOAD_ENABLED=${spelling}"
  run_botctl status
  assert_contains "the spelling ${spelling} was not read as off" \
    "$BOTCTL_OUTPUT" 'recovery upload    off'
done

test_case 'status: a value the application would refuse is reported as invalid, not guessed'
seed_nexa_env canonical
append_env 'PANEL_MONITOR_ENABLED=maybe'
run_botctl status
assert_contains 'an unparseable value was guessed at' "$BOTCTL_OUTPUT" 'panel monitor      invalid'

test_case 'status: a key with a narrower validator does not accept the wider spellings'
# `PANEL_MONITOR_ENABLED` is `z.enum(['true', 'false'])`, not `booleanish`. Reading
# `yes` there as `on` would report a working monitor where the next start REFUSES
# to boot — the same lie as reading an enabled monitor as off, and the worse one.
seed_nexa_env canonical
append_env 'PANEL_MONITOR_ENABLED=yes'
run_botctl status
assert_contains 'the narrower vocabulary was not applied' "$BOTCTL_OUTPUT" 'panel monitor      invalid'
# And the same spelling on a booleanish key IS accepted, so this is a per-key
# rule rather than a reader that simply refuses `yes`.
seed_nexa_env canonical
append_env 'BACKUP_SCHEDULE_ENABLED=yes'
run_botctl status
assert_contains 'a booleanish key stopped accepting yes' "$BOTCTL_OUTPUT" 'scheduled backup   on'

test_case 'status: `panel monitor on` is reported as the flag, not as a verdict'
# `configSchema.superRefine` guards four cross-field rules behind
# `if (PANEL_MONITOR_ENABLED)` — PANEL_MONITOR_TENANTS_PER_TICK against
# PANEL_MONITOR_BATCH_SIZE, PANEL_MONITOR_HEALTHY_INTERVAL_MS against
# PANEL_MONITOR_TICK_MS and against the probe cooldown, and
# PANEL_MONITOR_BUDGET_RESERVE_PERCENT against PANEL_PROBE_TENANT_LIMIT — and it refuses
# the WHOLE configuration if any disagree. So `panel monitor on` with
# TENANTS_PER_TICK=2 and BATCH_SIZE=1 is a monitor that will not start, and an
# unqualified `on` there is the same lie the webhook's secret-length check prevents.
#
# The arithmetic is deliberately NOT reimplemented: two of those rules are computed by
# helpers in the schema, and five rounds of this branch went into learning that a shell
# reimplementation of an application rule converges on a different wrong answer. Naming
# the keys is a true statement this script can make; a verdict is not.
seed_nexa_env canonical
fake_set compose_env "$(printf 'DATABASE_URL=d\nREDIS_URL=r\nPANEL_MONITOR_ENABLED=true\nPANEL_MONITOR_TENANTS_PER_TICK=2\nPANEL_MONITOR_BATCH_SIZE=1')"
run_botctl status
# The ROW, not the label: `panel monitor` alone matches `on`, `off` and `invalid` alike,
# because the label is part of the format string. The value has to be in the needle.
assert_contains 'the monitor was not reported on' "$BOTCTL_OUTPUT" 'panel monitor      on'
assert_contains 'the monitor row claimed more than the flag' \
  "$BOTCTL_OUTPUT" 'is the FLAG'
assert_contains 'the cross-field keys were not named' \
  "$BOTCTL_OUTPUT" 'PANEL_MONITOR_TENANTS_PER_TICK against'
assert_contains 'the refusal of the whole configuration was not stated' \
  "$BOTCTL_OUTPUT" 'refuses the whole configuration'
# FIVE, counted from the schema rather than from memory. The first version of this said
# four and missed the rule that refuses PANEL_MONITOR_BUDGET_RESERVE_PERCENT=0 outright —
# which is the only one of the five that catches that value, because the reserve floor the
# fourth rule compares against is itself 0 there. A `panel monitor on` beside a caveat
# naming four rules the operator satisfies, for a monitor that refuses to start on the
# fifth, is the same lie with an extra step.
assert_contains 'the rule count is wrong' "$BOTCTL_OUTPUT" 'five cross-field rules'
assert_contains 'the reserve-zero refusal was not named' \
  "$BOTCTL_OUTPUT" 'PANEL_MONITOR_BUDGET_RESERVE_PERCENT=0 refused outright'
assert_not_contains 'the caveat still claims four rules' \
  "$BOTCTL_OUTPUT" 'four cross-field rules'
assert_contains 'the monitor-log advice is not scoped to a failed recreate' \
  "$BOTCTL_OUTPUT" 'only AFTER a recreate has been attempted and refused'
assert_contains 'the running monitor is not said to keep what it accepted' \
  "$BOTCTL_OUTPUT" 'keeps the settings it accepted'
assert_not_contains 'the log is still claimed to name the failure unconditionally' \
  "$BOTCTL_OUTPUT" 'names the one that failed'
assert_contains 'the operator was not told where the failing rule is named' \
  "$BOTCTL_OUTPUT" 'botctl logs monitor'
# And the caveat is conditional: a monitor that is OFF has no such rules to satisfy, so
# printing the paragraph there would be noise about a process that is not running.
fake_set compose_env "$(printf 'DATABASE_URL=d\nREDIS_URL=r\nPANEL_MONITOR_ENABLED=false')"
run_botctl status
assert_not_contains 'the flag caveat printed for a monitor that is off' \
  "$BOTCTL_OUTPUT" 'is the FLAG'
fake_set compose_env ''
seed_nexa_env canonical

test_case 'status: the section names COMPOSE as its resolver and claims nothing more'
# Three review rounds produced a per-setting runtime claim that was wrong in a new way
# at every field, and five more produced a reimplementation of Compose env_file
# semantics that was wrong in a new way at every shape. What is left says where the
# values came from and what they are not: Compose resolved them, and a RUNNING container
# keeps whatever it was created with.
seed_nexa_env canonical
run_botctl status
assert_contains 'the heading does not name compose as the resolver' \
  "$BOTCTL_OUTPUT" 'as compose resolves'
assert_contains 'the standing caveat is missing' "$BOTCTL_OUTPUT" 'STARTED NOW'
# The caveat is keyed to CREATION and then names ALL FOUR commands that recreate. Three
# versions of this were wrong in three different ways. "since the last `botctl restart`"
# omitted `update`, `rollback` and `secrets disable-v1`. Naming three of them plus
# "nothing else here does" was a universal negative that omitted `secrets disable-v1`, the
# one command whose whole point is that the setting is APPLIED. Then the claim was
# withdrawn entirely, on `docker compose config --hash` not moving when `env_file` content
# changes — which is a fact about `config --hash`, not about `up -d`: `upCommand` resolves
# `env_file` into the service environment before hashing and `runHash` does not, so the
# two hash different project models. UNK-DEPLOY-001 carries the binary evidence.
assert_contains 'the caveat was keyed to restart alone' \
  "$BOTCTL_OUTPUT" 'since that container was CREATED'
assert_contains 'recreation was not named as the thing that loads a change' \
  "$BOTCTL_OUTPUT" 'Only RECREATING'
assert_contains 'the fourth recreating command is missing' \
  "$BOTCTL_OUTPUT" '`botctl secrets disable-v1`'
# And the claim is BOUNDED. "A successful one of those has already loaded these values"
# is false in three states this file documents itself: `update <the release already
# installed>` returns 0 without recreating, twice over, and `disable-v1` returns 0 before
# its `up` when the setting is already false. Each says so in its own output — which is
# why the section points at that output instead of guessing. Naming the commands that CAN
# recreate is true; claiming one of them DID is not this section's to know.
assert_contains 'the two commands that can succeed without recreating are not named' \
  "$BOTCTL_OUTPUT" 'can also return success having recreated nothing'
assert_contains 'the operator was not pointed at the command output that knows' \
  "$BOTCTL_OUTPUT" 'Read that, not this section'
assert_not_contains 'an unbounded claim that a successful command loaded the values' \
  "$BOTCTL_OUTPUT" 'has already loaded these values'
assert_not_contains 'the caveat still claims only a restart can load a change' \
  "$BOTCTL_OUTPUT" 'since the last `botctl restart` is not in force'
assert_not_contains 'a universal negative that omits secrets disable-v1' \
  "$BOTCTL_OUTPUT" 'nothing else here does'
# And the caveat is scoped to the ROWS: the build-identity paragraphs below it do inspect
# the running API, so disowning the containers for the whole section was the same
# contradiction as "every row in this section", mirrored into the other half of status.
assert_contains 'the caveat disowned facts the same section computes from docker inspect' \
  "$BOTCTL_OUTPUT" 'The ROWS above read the configuration'
assert_not_contains 'the caveat still disowns the containers for the whole section' \
  "$BOTCTL_OUTPUT" 'These rows read the configuration, not the containers'
assert_contains 'the caveat does not say what a running container keeps' \
  "$BOTCTL_OUTPUT" 'created with'
# And it still does not pretend to know the running state of any of them.
assert_not_contains 'the section claims a running value' "$BOTCTL_OUTPUT" 'running:'
test_case 'status: the capabilities section reports what COMPOSE resolved'
# `botctl status` asks `docker compose config` rather than reading nexa.env, because
# Compose INTERPOLATES env_file values — `${UNSET:-true}` reaches the container as
# `true` and `${HOME}` comes from the ambient environment — so no shell reader can be
# right about them without reproducing Compose variable precedence. Five rounds of
# trying is the evidence. What this asserts is the remaining rule: the section reports
# the resolved value, whatever the file happens to spell.
seed_nexa_env canonical
# The file says one thing; Compose resolves another. Only the resolved value may appear.
append_env 'BACKUP_SCHEDULE_ENABLED=false'
fake_set compose_env "$(printf 'DATABASE_URL=d\nREDIS_URL=r\nSECRETS_KEYS=k1:v\nSECRETS_ACTIVE_KEY_ID=k1\nBACKUP_SCHEDULE_ENABLED=true')"
run_botctl status
assert_contains 'status reported the file value rather than what compose resolved' \
  "$BOTCTL_OUTPUT" 'scheduled backup   on'

# A resolved value outside the key's own vocabulary is still `invalid`: resolution is
# Compose's job, validation is this one, and PANEL_MONITOR_ENABLED is a true/false enum
# while the others also take 1/0/yes/no.
fake_set compose_env "$(printf 'DATABASE_URL=d\nREDIS_URL=r\nPANEL_MONITOR_ENABLED=yes\nNOTIFICATION_DISPATCH_ENABLED=yes')"
run_botctl status
assert_contains 'a value the strict enum refuses was not reported as invalid' \
  "$BOTCTL_OUTPUT" 'panel monitor      invalid'
assert_contains 'a value booleanish accepts was reported as invalid' \
  "$BOTCTL_OUTPUT" 'notifications      on'

# Assigned to nothing is invalid; absent is the default. The two are different states.
fake_set compose_env "$(printf 'DATABASE_URL=d\nREDIS_URL=r\nPANEL_MONITOR_ENABLED=')"
run_botctl status
assert_contains 'an empty resolved value was read as the default' \
  "$BOTCTL_OUTPUT" 'panel monitor      invalid'
fake_set compose_env "$(printf 'DATABASE_URL=d\nREDIS_URL=r')"
run_botctl status
assert_contains 'an absent key stopped getting its default' "$BOTCTL_OUTPUT" 'panel monitor      on'
seed_nexa_env canonical

test_case 'status: a configuration Compose REFUSES is reported as refused, not summarised'
# An unterminated quoted value, an unsatisfiable substitution, a malformed compose file:
# Compose rejects the configuration WHOLE, so no container starts and no individual
# value is in force. A tidy column of values no container will ever receive is the most
# misleading thing this section could print — and it is also the one condition this
# script no longer has to detect for itself, because the authority reports it.
seed_nexa_env canonical
fake_set compose_config_fails 1
run_botctl status
assert_contains 'a refused configuration was not reported as refused' \
  "$BOTCTL_OUTPUT" 'REFUSED by compose'
assert_contains 'the consequence was not stated' \
  "$BOTCTL_OUTPUT" 'no container can be CREATED or RECREATED'
# And not more than the consequence: a container already running keeps its creation-time
# environment and may pass readiness below, so the claim is about creation, not force.
assert_contains 'the running-container caveat is missing' \
  "$BOTCTL_OUTPUT" 'keeps the environment'
assert_not_contains 'the refusal claimed no value is in force anywhere' \
  "$BOTCTL_OUTPUT" 'no individual value is in force'
assert_not_contains 'values were summarised from a configuration compose refuses' \
  "$BOTCTL_OUTPUT" 'scheduled backup'
fake_set compose_config_fails 0

test_case 'status: an enabled webhook with a short secret is invalid, not on'
# `configSchema.superRefine` refuses the WHOLE configuration when the webhook is on and
# the secret is shorter than 16 characters, so the API will not start. Reporting
# `telegram webhook on` there is the same lie as accepting a spelling the schema does
# not: it says working where the next start fails. The secret is never printed.
seed_nexa_env canonical
fake_set compose_env "$(printf 'DATABASE_URL=d\nREDIS_URL=r\nTELEGRAM_WEBHOOK_ENABLED=true\nTELEGRAM_WEBHOOK_SECRET=tooshort')"
run_botctl status
assert_contains 'an enabled webhook with a short secret was reported as on' \
  "$BOTCTL_OUTPUT" 'telegram webhook   invalid'
assert_contains 'the reason was not named' "$BOTCTL_OUTPUT" '16 characters'
assert_not_contains 'status printed the webhook secret' "$BOTCTL_OUTPUT" 'tooshort'
# With a secret of the required length it is on, so this is about the dependency rather
# than about refusing the webhook.
fake_set compose_env "$(printf 'DATABASE_URL=d\nREDIS_URL=r\nTELEGRAM_WEBHOOK_ENABLED=true\nTELEGRAM_WEBHOOK_SECRET=0123456789abcdef')"
run_botctl status
assert_contains 'a webhook with a long enough secret was not reported as on' \
  "$BOTCTL_OUTPUT" 'telegram webhook   on'
assert_not_contains 'status printed the webhook secret' "$BOTCTL_OUTPUT" '0123456789abcdef'
seed_nexa_env canonical

test_case 'status: a dollar Compose re-escapes is measured as the application receives it'
# `docker compose config` prints a RE-LOADABLE document, so every literal `$` in a
# resolved value comes out doubled — measured on v5.1.1: `S='abcdefghijklmn$'` is
# `abcdefghijklmn$$` in the JSON. Fifteen characters to the application, sixteen to a
# reader of that document, and the schema refuses fifteen. Reported `on` for a webhook
# the API will refuse to start with, which is exactly the lie the length check exists
# to prevent. The doubling is undone before anything is measured.
seed_nexa_env canonical
fake_set compose_env "$(printf 'DATABASE_URL=d\nREDIS_URL=r\nTELEGRAM_WEBHOOK_ENABLED=true\nTELEGRAM_WEBHOOK_SECRET=abcdefghijklmn$$')"
run_botctl status
assert_contains 'a 15-character secret ending in a dollar was measured as 16' \
  "$BOTCTL_OUTPUT" 'telegram webhook   invalid'
# And sixteen real characters, one of them a dollar, is on — so this is about the
# doubling, not about refusing a dollar.
fake_set compose_env "$(printf 'DATABASE_URL=d\nREDIS_URL=r\nTELEGRAM_WEBHOOK_ENABLED=true\nTELEGRAM_WEBHOOK_SECRET=abcdefghijklmno$$')"
run_botctl status
assert_contains 'a 16-character secret containing a dollar was refused' \
  "$BOTCTL_OUTPUT" 'telegram webhook   on'
seed_nexa_env canonical

test_case 'status: a value is measured by its characters, not by its one-line rendering'
# The listing renders a backslash as two characters and a newline as `\n`, so that one
# entry stays one line. A caller that measured the RENDERING counted eight backslashes
# as sixteen characters and reported a webhook secret the schema refuses as `on`.
# `nexa_listing_length` reads through the rendering; these values cannot be spelled in the
# line-based `compose_env`, so the resolved environment is stated as JSON.
seed_nexa_env canonical
fake_set compose_env ''
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","TELEGRAM_WEBHOOK_ENABLED":"true","TELEGRAM_WEBHOOK_SECRET":"\\\\\\\\\\\\\\\\"}'
run_botctl status
assert_contains 'eight backslashes were measured as sixteen characters' \
  "$BOTCTL_OUTPUT" 'telegram webhook   invalid'
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","TELEGRAM_WEBHOOK_ENABLED":"true","TELEGRAM_WEBHOOK_SECRET":"abcdefgh\nijklmn"}'
run_botctl status
assert_contains 'a 15-character value with a newline was measured as 16' \
  "$BOTCTL_OUTPUT" 'telegram webhook   invalid'
# Sixteen characters INCLUDING the newline is what the schema counts, so it is on.
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","TELEGRAM_WEBHOOK_ENABLED":"true","TELEGRAM_WEBHOOK_SECRET":"abcdefgh\nijklmno"}'
run_botctl status
assert_contains 'a 16-character value with a newline was refused' \
  "$BOTCTL_OUTPUT" 'telegram webhook   on'
fake_set compose_env_json ''
seed_nexa_env canonical

test_case 'status: a refusal reports the reason Compose gave, with the value it echoed cut off'
# Guessing at "common causes" told an operator whose env file was missing to look for an
# unclosed quote. Compose says why, so `status` repeats Compose — but not whole: an
# unterminated-quote refusal echoes the offending VALUE, and the offending value in this
# file can be the bot token. Everything from the first quote character on is dropped.
seed_nexa_env canonical
fake_set compose_config_fails 1
fake_set compose_config_stderr "failed to read /etc/nexa/nexa.env: line 9: unterminated quoted value '7777777:AAAfakeBotTokenValue"
run_botctl status
assert_contains 'the refusal was not reported' "$BOTCTL_OUTPUT" 'REFUSED by compose'
assert_contains "Compose's reason was not repeated" "$BOTCTL_OUTPUT" 'line 9: unterminated quoted value'
assert_not_contains 'the echoed token was printed' "$BOTCTL_OUTPUT" 'AAAfakeBotTokenValue'
assert_not_contains 'a guessed cause was printed beside the real one' "$BOTCTL_OUTPUT" 'Common causes'
# A reason without a quote reads whole.
fake_set compose_config_stderr 'env file /etc/nexa/nexa.env not found: stat /etc/nexa/nexa.env: no such file or directory'
run_botctl status
assert_contains 'a quote-free reason was cut short' "$BOTCTL_OUTPUT" 'no such file or directory'
# The SECOND channel, and the quote cut does nothing about it: Compose's required-variable
# forms `${VAR?text}` and `${VAR:?text}` put the operator's own text in the diagnostic,
# and that text needs no quote. Measured on v5.1.1 with `SECRETS_KEYS=${KEYRING:?k1:<key>}`
# and KEYRING unset, which is how the keyring reached a paste-safe output. Compose's prose
# is kept whole up to and including the marker, so the variable NAME still reads.
fake_set compose_config_stderr 'failed to read /etc/nexa/nexa.env: required variable KEYRING is missing a value: k1:AAAfakeKeyMaterial'
run_botctl status
assert_contains 'the required-variable reason was dropped entirely' \
  "$BOTCTL_OUTPUT" 'required variable KEYRING is missing a value'
assert_not_contains 'the operator-supplied error text carried the key material through' \
  "$BOTCTL_OUTPUT" 'AAAfakeKeyMaterial'
# And the cut is never silent. `deploy/compose.yml` uses `${VAR:?text}` four times and
# that text is operator guidance, not a value — it is cut anyway, because this function
# cannot tell guidance from a keyring, so the operator is told a cut happened.
assert_contains 'the cut was silent' "$BOTCTL_OUTPUT" 'is withheld'
# The compose FILE's own `${VAR:?text}` forms are a DIFFERENT channel, measured on
# v5.1.1: they carry `error while interpolating …`, their variables live in `deploy.env`
# which holds no secrets by design, and their text is the only explanation for the
# commonest refusal there is — a half-written `deploy.env`. It reads WHOLE, and saying a
# value had been withheld from it was false about that message.
fake_set compose_config_stderr 'error while interpolating x-app-common.image: required variable NEXA_IMAGE is missing a value: NEXA_IMAGE must be an image digest reference'
run_botctl status
assert_contains 'the compose-file guidance was cut' \
  "$BOTCTL_OUTPUT" 'NEXA_IMAGE must be an image digest reference'
assert_not_contains 'a message that carries no value was reported as redacted' \
  "$BOTCTL_OUTPUT" 'is withheld'
fake_set compose_config_fails 0
fake_set compose_config_stderr ''
# And a document that defines no `api` is a refusal too, not a column of defaults.
fake_set compose_service_missing 1
run_botctl status
assert_contains 'a missing service was summarised as defaults' "$BOTCTL_OUTPUT" 'REFUSED by compose'
assert_contains 'the missing service was not named' "$BOTCTL_OUTPUT" 'no service named api'
assert_not_contains 'values were printed for a service that does not exist' \
  "$BOTCTL_OUTPUT" 'scheduled backup'
fake_set compose_service_missing 0
seed_nexa_env canonical

test_case 'status: a cut refusal says a cut happened, on the channel that carries a value'
# The quote cut is the redaction that matters, and it was the silent one. Measured on
# v5.1.1, an unterminated quoted value is echoed into the message —
#   failed to read /etc/nexa/nexa.env: line 2: unterminated quoted value "<value>
# — and what the cut leaves behind is a grammatical sentence ending in `unterminated quoted
# value`. An operator comparing that against the file sees a refusal about a line whose
# value is simply missing from the diagnostic, with nothing saying anything was removed.
# The required-variable channel announced itself; this one did not.
seed_nexa_env canonical
fake_set compose_config_fails 1
fake_set compose_config_stderr "failed to read /etc/nexa/nexa.env: line 9: unterminated quoted value '7777777:AAAfakeBotTokenValue"
run_botctl status
assert_contains 'the quote cut was silent' "$BOTCTL_OUTPUT" 'cut at a quote'
assert_not_contains 'the echoed token was printed' "$BOTCTL_OUTPUT" 'AAAfakeBotTokenValue'
# And a message that was not cut gains no note. Announcing a redaction that did not happen
# is the same defect in the other direction, and it is the one that withdrew a true
# explanation from the compose-file channel two rounds ago.
fake_set compose_config_stderr 'env file /etc/nexa/nexa.env not found: stat /etc/nexa/nexa.env: no such file or directory'
run_botctl status
assert_contains 'the reason was not reported' "$BOTCTL_OUTPUT" 'no such file or directory'
assert_not_contains 'an uncut message was reported as cut at a quote' \
  "$BOTCTL_OUTPUT" 'cut at a quote'
assert_not_contains 'an uncut message was reported as bounded' \
  "$BOTCTL_OUTPUT" 'cut at 200 characters'
# The 200-character bound is the other silent cut: a long refusal was truncated
# mid-sentence and read as the whole of what Compose said.
long_reason="validating /opt/nexa/deploy/compose.yml: $(printf 'x%.0s' $(seq 1 260))"
fake_set compose_config_stderr "$long_reason"
run_botctl status
assert_contains 'the length bound was silent' "$BOTCTL_OUTPUT" 'cut at 200 characters'
fake_set compose_config_fails 0
fake_set compose_config_stderr ''
seed_nexa_env canonical

test_case 'status: a refusal is the error line Compose printed, not the warning it logged first'
# Compose logs warnings to stderr BEFORE the error — one per unset substitution in
# the file, `The "X" variable is not set. Defaulting to a blank string.` — and the
# refusal is a plain line after them. Measured on v5.1.1. Taking the first line, and
# cutting it at its first quote, printed `Compose said: time=` for exactly the
# interpolation shape that ended the reimplementation.
seed_nexa_env canonical
fake_set compose_config_fails 1
fake_set compose_config_stderr "$(printf 'time="2026-09-11T17:34:07Z" level=warning msg="The \\"UNSETVAR\\" variable is not set. Defaulting to a blank string."\nfailed to read /etc/nexa/nexa.env: line 3: unterminated quoted value '"'"'7777777:AAAfakeBotTokenValue')"
run_botctl status
assert_contains 'the warning was reported as the reason' "$BOTCTL_OUTPUT" 'line 3: unterminated quoted value'
assert_not_contains 'the warning line was printed as the reason' "$BOTCTL_OUTPUT" 'Compose said:
    time='
assert_not_contains 'the echoed token was printed' "$BOTCTL_OUTPUT" 'AAAfakeBotTokenValue'
fake_set compose_config_fails 0
fake_set compose_config_stderr ''
seed_nexa_env canonical

test_case 'status: a refusal whose error line itself says level=warning is still reported'
# The warning filter drops every stderr line containing `level=warning`. An
# unterminated value spelled `TOKEN="level=warning` makes Compose's ERROR line
# contain it too — measured on v5.1.1 — so the filter leaves nothing, and the reason
# has to come from the fallback: the last line. Without it `status` reports that
# Compose gave no reason, for a refusal Compose explained.
seed_nexa_env canonical
fake_set compose_config_fails 1
fake_set compose_config_stderr "$(printf 'time="2026-09-11T17:34:07Z" level=warning msg="The \\"UNSETVAR\\" variable is not set. Defaulting to a blank string."\nfailed to read /etc/nexa/nexa.env: line 4: unterminated quoted value "level=warning')"
run_botctl status
assert_contains 'the error line was filtered away with the warnings' \
  "$BOTCTL_OUTPUT" 'line 4: unterminated quoted value'
assert_not_contains 'a refusal Compose explained was reported as unexplained' \
  "$BOTCTL_OUTPUT" 'compose gave no reason'
fake_set compose_config_fails 0
fake_set compose_config_stderr ''
seed_nexa_env canonical

test_case 'status: the secret is measured as the schema measures it, trailing newline and all'
# `configSchema` refuses a webhook secret under 16 `.length` — UTF-16 code units — and
# a quoted value that ends its line keeps that newline. Command substitution drops a
# trailing newline, so `${#value}` measured a 16-character secret ending in a newline
# as 15 and reported `invalid` for a configuration the application accepts; and `${#}`
# is characters or BYTES depending on the locale botctl happens to run under. The
# length is computed from the rendering, in code units, so it agrees with the schema.
seed_nexa_env canonical
fake_set compose_env ''
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","TELEGRAM_WEBHOOK_ENABLED":"true","TELEGRAM_WEBHOOK_SECRET":"abcdefghijklmno\n"}'
run_botctl status
assert_contains 'a 16-character secret ending in a newline was measured as 15' \
  "$BOTCTL_OUTPUT" 'telegram webhook   on'
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","TELEGRAM_WEBHOOK_ENABLED":"true","TELEGRAM_WEBHOOK_SECRET":"abcdefghijklmn\n"}'
run_botctl status
assert_contains 'a 15-character secret ending in a newline was accepted' \
  "$BOTCTL_OUTPUT" 'telegram webhook   invalid'
# Eight astral characters are 16 code units to the schema, 8 characters to a UTF-8
# `${#}` and 32 bytes to a C-locale one; only the schema's count is the rule.
fake_set compose_env_json '{"DATABASE_URL":"d","REDIS_URL":"r","TELEGRAM_WEBHOOK_ENABLED":"true","TELEGRAM_WEBHOOK_SECRET":"😀😀😀😀😀😀😀😀"}'
run_botctl status
assert_contains 'eight astral characters were not measured as sixteen code units' \
  "$BOTCTL_OUTPUT" 'telegram webhook   on'
fake_set compose_env_json ''
seed_nexa_env canonical

test_case 'status: every capability names the process that reads it'
# PANEL_MONITOR_ENABLED belongs to the monitor, TELEGRAM_WEBHOOK_ENABLED and
# RECOVERY_UPLOAD_ENABLED to the API, and the rest to the worker. An
# operator asking "which container would have to restart" needs that, and naming
# it costs nothing and claims nothing.
seed_nexa_env canonical
run_botctl status
assert_contains 'the monitor flag is not attributed to the monitor' \
  "$BOTCTL_OUTPUT" 'panel monitor      on       monitor'
assert_contains 'the webhook flag is not attributed to the api' \
  "$BOTCTL_OUTPUT" 'telegram webhook   off      api'
assert_contains 'the upload flag is not attributed to the api' \
  "$BOTCTL_OUTPUT" 'recovery upload    on       api'
assert_contains 'the schedule is not attributed to the worker' \
  "$BOTCTL_OUTPUT" 'scheduled backup   off      worker'

test_case 'status: the notifications row is the transport too, not the dispatcher flag alone'
# `NOTIFICATION_TRANSPORT=recording` keeps messages in MEMORY instead of sending them, so an
# installation with the dispatcher on and that transport delivers nothing while looking
# healthy — and `configSchema` refuses the combination outright unless NODE_ENV=development,
# which a production installation is not. A row reading `notifications on` for it is the same
# lie the webhook row's secret check exists to prevent: a capability reported working for a
# configuration the next start refuses.
seed_nexa_env canonical
append_resolved_env 'NOTIFICATION_TRANSPORT=recording'
run_botctl status
assert_contains 'the recording transport was reported as notifications on' \
  "$BOTCTL_OUTPUT" 'notifications      invalid'
assert_contains 'the reason was not named' "$BOTCTL_OUTPUT" 'keeps messages in MEMORY'
assert_contains 'the remedy was not named' \
  "$BOTCTL_OUTPUT" 'Set NOTIFICATION_TRANSPORT=telegram'
# NODE_ENV is READ, not assumed: `recording` is legitimate in development, and telling a
# development installation its configuration is broken is the same defect in reverse.
seed_nexa_env canonical
append_resolved_env 'NOTIFICATION_TRANSPORT=recording' 'NODE_ENV=development'
run_botctl status
assert_contains 'a development installation was told its transport is invalid' \
  "$BOTCTL_OUTPUT" 'notifications      on'
assert_not_contains 'the development case printed the refusal paragraph' \
  "$BOTCTL_OUTPUT" 'keeps messages in MEMORY'
# And a transport OUTSIDE the vocabulary is invalid too. `NOTIFICATION_TRANSPORT` is
# `z.enum(['telegram', 'recording'])`, so `smtp` is refused by the enum and the worker will
# not start — and the first version of this check tested `recording` alone and left that
# reading `notifications on`, which is the same "closed one member of the family" mistake the
# secrets guard made a round earlier, made again in the round that recorded the lesson.
seed_nexa_env canonical
append_resolved_env 'NOTIFICATION_TRANSPORT=smtp'
run_botctl status
assert_contains 'an out-of-vocabulary transport was reported as notifications on' \
  "$BOTCTL_OUTPUT" 'notifications      invalid'
assert_contains 'the vocabulary was not named' \
  "$BOTCTL_OUTPUT" 'other than `telegram` or `recording`'
# An EMPTY assignment is outside it as well: an environment variable is a string, and the
# empty one is not a member of the enum — the same distinction `nexa_listing_has` exists for.
seed_nexa_env canonical
append_resolved_env 'NOTIFICATION_TRANSPORT='
run_botctl status
assert_contains 'an empty transport was read as the default' \
  "$BOTCTL_OUTPUT" 'notifications      invalid'
# And the default transport reads on, or none of these cases prove anything. ABSENT is the
# default, which is telegram — not invalid.
seed_nexa_env canonical
run_botctl status
assert_contains 'the telegram transport was reported as invalid' \
  "$BOTCTL_OUTPUT" 'notifications      on'
assert_not_contains 'an absent transport printed a refusal' \
  "$BOTCTL_OUTPUT" 'other than `telegram` or `recording`'
seed_nexa_env canonical

test_case 'status: the notifications row says it has not checked the Telegram endpoint'
# `notifications on` with the telegram transport is the dispatcher and the transport NAME.
# The schema checks two more things: TELEGRAM_API_BASE_URL is `z.string().url()`, and a
# superRefine requires its parsed protocol to be https when NODE_ENV=production — the bot
# token is in the path of every call, so an http base publishes the credential. Either
# refusal stops the API starting, so the row can read `on` for a configuration that will
# not boot. It is SAID rather than re-implemented, for the reason the monitor row gives
# about its five cross-field rules: a shell reimplementation of an application rule
# converges on a different wrong answer, and WHATWG URL parsing is not a shell job.
seed_nexa_env canonical
run_botctl status
assert_contains 'the endpoint the row does not check was not named' \
  "$BOTCTL_OUTPUT" 'TELEGRAM_API_BASE_URL to parse as a URL'
assert_contains 'the https-in-production rule was not named' \
  "$BOTCTL_OUTPUT" 'https when'
assert_contains 'the row did not say what it is' \
  "$BOTCTL_OUTPUT" 'is the dispatcher and the transport NAME'
# An explicit telegram transport says the same thing.
seed_nexa_env canonical
append_resolved_env 'NOTIFICATION_TRANSPORT=telegram'
run_botctl status
assert_contains 'an explicit telegram transport lost the endpoint caveat' \
  "$BOTCTL_OUTPUT" 'TELEGRAM_API_BASE_URL to parse as a URL'
# And the caveat belongs to the telegram arm only. A dispatcher that is OFF delivers
# nothing through any endpoint, and a transport the schema refuses has its own paragraph —
# printing this one beside either would point an operator at the wrong key.
seed_nexa_env canonical
append_resolved_env 'NOTIFICATION_DISPATCH_ENABLED=false'
run_botctl status
assert_not_contains 'a disabled dispatcher printed the endpoint caveat' \
  "$BOTCTL_OUTPUT" 'TELEGRAM_API_BASE_URL to parse as a URL'
seed_nexa_env canonical
append_resolved_env 'NOTIFICATION_TRANSPORT=smtp'
run_botctl status
assert_not_contains 'an out-of-vocabulary transport printed the endpoint caveat' \
  "$BOTCTL_OUTPUT" 'TELEGRAM_API_BASE_URL to parse as a URL'
seed_nexa_env canonical

test_case 'status: an EMPTY assignment is invalid, not the default'
# Zod applies a default to an ABSENT value, and an environment variable is a
# string: `PANEL_MONITOR_ENABLED=` reaches the schema as '"'"''"'"' and both the enum and
# `booleanish` refuse it. Mapping an empty assignment to the default reported a
# healthy value for a file the next start rejects.
seed_nexa_env canonical
append_env 'PANEL_MONITOR_ENABLED='
run_botctl status
assert_contains 'an empty assignment was read as the default' \
  "$BOTCTL_OUTPUT" 'panel monitor      invalid'
seed_nexa_env canonical
append_env 'BACKUP_SCHEDULE_ENABLED='
run_botctl status
assert_contains 'an empty booleanish assignment was read as the default' \
  "$BOTCTL_OUTPUT" 'scheduled backup   invalid'
# And an ABSENT key still gets the default, so this is about emptiness rather
# than a reader that refuses everything.
seed_nexa_env canonical
run_botctl status
assert_contains 'an absent key stopped getting its default' "$BOTCTL_OUTPUT" 'panel monitor      on'

test_case 'status: the delivery destination names every process that delivers'
# Not the worker alone. `createContainer` builds one BackupService and every role
# gets it: the worker schedules, RecoveryController.runBackup serves the Web
# Admin's manual run, and the recovery executor takes the PRE_RESTORE backup.
# Naming only the worker points a diagnosis away from the process that is actually
# delivering after a service-specific recreation.
seed_nexa_env canonical
run_botctl status
assert_contains 'the delivery line does not name all three consumers' \
  "$BOTCTL_OUTPUT" 'backup delivery    not configured worker, api, recovery'
# The schedule is genuinely the worker's, so this is not "name everything".
assert_contains 'the schedule stopped being attributed to the worker alone' \
  "$BOTCTL_OUTPUT" 'scheduled backup   off      worker'

test_case 'status: the file and the running API are two facts, reported as three states'
# Conflating them got one of the three wrong. Saying "/health/info reports what the
# installer wrote" whenever the FILE carries the lines is false when the container
# predates them — a line added or restored since the API was created is not in force
# yet — and false again when the API is not running at all.

# 1. The file sets them AND the running API confirms the override: masked NOW.
seed_nexa_env canonical
append_env 'BUILD_VERSION=v0.1.0-staging.1' 'BUILD_COMMIT=pending' 'BUILD_TIME=pending'
fake_set api_env 'BUILD_COMMIT=pending'
run_botctl status
assert_contains 'the stale build keys were not named' "$BOTCTL_OUTPUT" 'BUILD_VERSION'
assert_contains 'the masking was not stated when both facts agree' \
  "$BOTCTL_OUTPUT" '/health/info reports'
assert_contains 'the remedy was not named' "$BOTCTL_OUTPUT" 'botctl update'

# 2. The file sets them but the running API answers its own image: PENDING, not masked.
seed_nexa_env canonical
append_env 'BUILD_VERSION=v0.1.0-staging.1'
fake_set api_env ''
run_botctl status
assert_contains 'a pending override was not named' "$BOTCTL_OUTPUT" 'BUILD_VERSION'
assert_contains 'a pending override was not described as taking effect at the next start' \
  "$BOTCTL_OUTPUT" 'next start'
assert_not_contains 'a pending override was reported as already masking /health/info' \
  "$BOTCTL_OUTPUT" '/health/info reports what the installer wrote rather than'
assert_contains 'the remedy was not named' "$BOTCTL_OUTPUT" 'botctl update'
# And it says what it OBSERVED rather than inferring absence. A file assignment equal to
# the image stamp IS carried by the container and compares equal, so the provenance
# comparison omits it either way — "the running API does not carry them" was an inference
# from equality, and `/health/info` matching the image is the fact actually established.
assert_contains 'the report inferred absence from an equal value' \
  "$BOTCTL_OUTPUT" 'answers its own'
assert_not_contains 'the report still claims the running API does not carry the key' \
  "$BOTCTL_OUTPUT" 'The running API does not carry'
assert_contains 'the equal-value possibility was not named' \
  "$BOTCTL_OUTPUT" 'equal to the image stamp'

# 3. A stopped API is not masking anything and is not carrying a stale override
#    either, so a missing container gets neither state: the provenance is UNKNOWN
#    and the case below it says so — never a claim about an endpoint that is not
#    answering.
seed_nexa_env canonical
append_env 'BUILD_VERSION=v0.1.0-staging.1'
fake_set api_state absent
run_botctl status
assert_not_contains 'a stopped API was reported as masking /health/info' \
  "$BOTCTL_OUTPUT" '/health/info reports what the installer wrote rather than'
assert_contains 'a stopped API suppressed the file warning entirely' \
  "$BOTCTL_OUTPUT" 'BUILD_VERSION'
fake_set api_state running

test_case 'status: a clean file whose API still carries the stale identity is reported'
# The removal runs early in an update, before the image is pulled and the backup is
# taken. A run that stops at one of those leaves the file clean and the containers
# still carrying the stale identity — and a report that read only the file would say
# nothing was wrong while /health/info still answered `pending`.
#
# The API, because /health/info is the API's route. Reading the worker's environment
# for it would be reporting one container's state as another's.
seed_nexa_env canonical
fake_set api_env 'BUILD_COMMIT=pending'
run_botctl status
assert_contains 'the running API was not reported' "$BOTCTL_OUTPUT" 'RUNNING'
assert_contains 'the stale key was not named' "$BOTCTL_OUTPUT" 'BUILD_COMMIT'
assert_contains 'the remedy was not named' "$BOTCTL_OUTPUT" 'botctl restart'
assert_not_contains 'the file was blamed for something it does not set' \
  "$BOTCTL_OUTPUT" 'This file still sets'
fake_set api_env ''

test_case 'status: an API answering its own image says nothing about them'
# The ordinary case, and the one a presence check got wrong about every healthy
# installation: `Dockerfile` lines 89-92 stamp all three keys into the runtime
# image, so a correctly built container ALWAYS carries them. A check keyed on
# presence told every operator their build identity was masked and to restart,
# after which the recreated container carried them again and the warning never
# cleared. What is asked is PROVENANCE — does the container answer its image, or
# something that replaced it?
seed_nexa_env canonical
fake_set api_env ''
# Asserted of the fake first, because this case is only meaningful if the API
# container really does carry the image's stamped identity. A fake carrying none
# of the keys would make the assertion below pass for the wrong reason, which is
# exactly how the presence check survived its own tests.
api_stamped="$(docker inspect fakeapicontainerid --format '{{range .Config.Env}}{{println .}}{{end}}')"
assert_contains 'the fake API container carries no stamped build identity at all' \
  "$api_stamped" 'BUILD_VERSION=0.1.0-test'
assert_contains 'the fake API container carries no stamped commit' \
  "$api_stamped" 'BUILD_COMMIT=cafebabe'
run_botctl status
assert_not_contains 'a warning was printed with nothing to warn about' \
  "$BOTCTL_OUTPUT" '/health/info reports'
assert_not_contains 'a healthy installation was told to restart' \
  "$BOTCTL_OUTPUT" 'still reports what the'

test_case 'status: a mixed pending/stale pair is reported per key, not as one state'
# The two lists need not hold the same keys. A file that newly sets BUILD_VERSION while
# the running API retains an old BUILD_COMMIT override is BOTH states at once, and a
# conjunction over the lists reported it as one — naming BUILD_VERSION while claiming
# the container differs from its image for it, and never mentioning the key that does.
seed_nexa_env canonical
append_env 'BUILD_VERSION=v0.1.0-staging.1'
fake_set api_env 'BUILD_COMMIT=pending'
run_botctl status
# The file-only key is PENDING...
assert_contains 'the file-only key was not reported as taking effect at the next start' \
  "$BOTCTL_OUTPUT" 'next start'
# ...and the container-only key is STALE, with its own remedy.
assert_contains 'the container-only key was not reported at all' \
  "$BOTCTL_OUTPUT" 'The file no longer sets BUILD_COMMIT'
assert_contains 'the stale container was not given its remedy' "$BOTCTL_OUTPUT" 'botctl restart'
# And neither sentence claims the other key.
assert_not_contains 'the pending key was named as stale' \
  "$BOTCTL_OUTPUT" 'The file no longer sets BUILD_VERSION'
# The key list is joined from `comm` output by `tr`, which turns the final newline into a
# TRAILING space — so every one of these sentences read `sets BUILD_VERSION , which
# REPLACES`. Both ends are trimmed, and this is what notices if one of them goes again.
assert_contains 'the key list kept a stray space before the comma' \
  "$BOTCTL_OUTPUT" 'sets BUILD_VERSION, which REPLACES'
assert_not_contains 'a space survived between the key list and its comma' \
  "$BOTCTL_OUTPUT" 'BUILD_VERSION ,'
fake_set api_env ''

test_case 'status: a stale multiline override is not mistaken for a match'
# `docker inspect --format '{{println .}}'` put a value containing a newline on two
# lines, so a line-based comparison saw only its first part — and a container carrying
# `BUILD_COMMIT=cafebabe` + newline + `pending` over an image stamped `cafebabe` compared
# EQUAL, leaving a stale override unreported while /health/info exposed the whole thing.
# Both sides are rendered with Go `%q` now: one entry is one line.
seed_nexa_env canonical
fake_set api_env "$(printf 'BUILD_COMMIT=cafebabe\npending')"
run_botctl status
assert_contains 'a multiline override whose first line matches the image was not reported' \
  "$BOTCTL_OUTPUT" 'BUILD_COMMIT'
assert_contains 'the remedy was not named' "$BOTCTL_OUTPUT" 'botctl restart'
# And a container that genuinely matches its image still reports nothing, so this is
# about the rendering rather than about warning always.
fake_set api_env ''
run_botctl status
assert_not_contains 'a matching container was reported as overridden' \
  "$BOTCTL_OUTPUT" 'still reports what the'

test_case 'harness: the fake docker renders the --format template it was asked for'
# The fake participated in the proof above and lied: it rendered `%q`-shaped lines
# whatever template it was passed, so reverting `nexa_inspect_env` to `println`
# requested one shape and received the other, and the test above stayed green
# (falsification H-58, first run). A fake that answers one way regardless of the
# question cannot falsify the question. The same fixture is therefore asked for both
# shapes, on a value where they must differ, and a template the fake does not model
# must be refused rather than rendered as something else.
fake_set api_env "$(printf 'BUILD_COMMIT=cafebabe\npending')"
quoted="$("${FAKE_DIR}/bin/docker" inspect fakeapicontainerid \
  --format '{{range .Config.Env}}{{printf "%q" .}}{{"\n"}}{{end}}')"
plain="$("${FAKE_DIR}/bin/docker" inspect fakeapicontainerid \
  --format '{{range .Config.Env}}{{println .}}{{end}}')"
assert_contains 'the %q shape did not render the entry as ONE quoted line' \
  "$quoted" '"BUILD_COMMIT=cafebabe\npending"'
assert_not_contains 'the println shape quoted its entries' "$plain" '"BUILD_COMMIT='
assert_contains 'the println shape did not put the continuation on its own line' \
  "$plain" "$(printf 'BUILD_COMMIT=cafebabe\npending\n')"
assert_fails 'a template the fake does not model was rendered anyway' \
  "${FAKE_DIR}/bin/docker" inspect fakeapicontainerid --format '{{range .Config.Env}}{{.}}{{end}}'
fake_set api_env ''

test_case 'status: an EMPTY override of the image identity is still an override'
# `BUILD_COMMIT=` is not an absent key. An update that removed the line and then
# failed before recreating the API leaves a container whose commit is the empty
# string while the image stamps a real one, and /health/info reports the empty
# value — so a check that asked whether the value was NON-EMPTY reported nothing
# wrong. The provenance comparison covers it by construction rather than by a
# special case: empty differs from the stamped value like anything else.
seed_nexa_env canonical
fake_set api_env 'BUILD_COMMIT='
run_botctl status
assert_contains 'an empty override was treated as no override' "$BOTCTL_OUTPUT" 'BUILD_COMMIT'
assert_contains 'the remedy was not named' "$BOTCTL_OUTPUT" 'botctl restart'
fake_set api_env ''

test_case 'status: a provenance it cannot compute produces no warning, at any of three lookups'
# The remedy this warning feeds is a restart, and a restart would not change an
# answer that could not be computed, so a file AT ITS DEFAULTS gets silence.
# A file that carries the keys gets the unknown-state paragraph instead — the case
# after this one — because there the operator has something to act on.
#
# THREE lookups, each tested, because a guard that covered only the first was the
# defect in the previous revision: an `image inspect` that failed made every stamped
# value read as empty, so all three keys looked overridden and every operator was
# told to restart.
seed_nexa_env canonical
for failure in image_absent container_env_fails image_env_fails; do
  fake_set "$failure" 1
  run_botctl status
  assert_not_contains "a failed ${failure} lookup produced a warning anyway" \
    "$BOTCTL_OUTPUT" 'still reports what the'
  fake_set "$failure" 0
done
# And with all three working, the override IS still reported — or the loop above
# would pass against a check that never reports anything.
fake_set api_env 'BUILD_COMMIT=pending'
run_botctl status
assert_contains 'the check reports nothing even when it can compute an override' \
  "$BOTCTL_OUTPUT" 'BUILD_COMMIT'
fake_set api_env ''

test_case 'status: a provenance it cannot compute makes no claim about the running API'
# A failed lookup used to return an EMPTY answer, which the per-key classifier read as
# "nothing is overridden" — so a file that sets the keys was reported as pending, with
# the sentence that the running API does not carry them and /health/info is correct
# for now. That is the fact that could not be established. Unknown is reported as
# unknown, for each of the three lookups AND for an API that is not running at all:
# the fourth arm below, which is the missing-container branch.
seed_nexa_env canonical
append_env 'BUILD_COMMIT=pending'
for failure in image_absent container_env_fails image_env_fails api_state_absent; do
  if [ "$failure" = api_state_absent ]; then fake_set api_state absent; else fake_set "$failure" 1; fi
  run_botctl status
  assert_contains "a failed ${failure} lookup claimed the running API does not carry the key" \
    "$BOTCTL_OUTPUT" 'could not be determined'
  assert_not_contains "a failed ${failure} lookup reported the file key as pending" \
    "$BOTCTL_OUTPUT" 'correct for NOW'
  if [ "$failure" = api_state_absent ]; then fake_set api_state running; else fake_set "$failure" 0; fi
done
# With every lookup working, the same file IS classified — pending, because the fake
# container carries the image's own value — so this is about failure, not silence.
run_botctl status
assert_contains 'a computable provenance was reported as unknown' "$BOTCTL_OUTPUT" 'correct for NOW'
assert_not_contains 'a computable provenance was reported as unknown' \
  "$BOTCTL_OUTPUT" 'could not be determined'
teardown_root

# --- update removes them -----------------------------------------------------

setup_root
setup_fake_docker
seed_release 'vA' "$DIGEST_A"
fake_set secrets_json '{"format":"canonical","acceptV1":false,"explicit":false,"v1Rows":0,"rows":4,"mismatched":0}'

test_case 'update: removes the build identity the first template wrote, and nothing else'
seed_nexa_env canonical
append_env 'BUILD_VERSION=v0.1.0-staging.1' 'BUILD_COMMIT=pending' 'BUILD_TIME=pending'
before_db="$(nexa_env_key DATABASE_URL)"
before_keys="$(nexa_env_key SECRETS_KEYS)"
run_botctl update vA
assert_contains 'the removal was not reported' "$BOTCTL_OUTPUT" 'removed from nexa.env'
assert_equals 'BUILD_VERSION survived' '' "$(nexa_env_key BUILD_VERSION)"
assert_equals 'BUILD_COMMIT survived' '' "$(nexa_env_key BUILD_COMMIT)"
assert_equals 'BUILD_TIME survived' '' "$(nexa_env_key BUILD_TIME)"
# Everything else is the operator's, including the key that decrypts every
# stored credential. A rewrite that lost it would be an installation that cannot
# boot, discovered at the restart.
assert_equals 'DATABASE_URL was changed' "$before_db" "$(nexa_env_key DATABASE_URL)"
assert_equals 'the keyring was changed' "$before_keys" "$(nexa_env_key SECRETS_KEYS)"
assert_equals 'an operator value was changed' 'https://admin.example.test' \
  "$(nexa_env_key WEB_ADMIN_ORIGINS)"
assert_file_mode 'the rewritten file lost its mode' "${NEXA_CONFIG_DIR}/nexa.env" 600
assert_not_contains 'the removal printed a value' "$BOTCTL_OUTPUT" 'staging.1'

test_case 'update: removes an obsolete line however it is spelled'
# The detector and the rewriter have to agree about what an assignment looks like.
# If the detector accepts `export BUILD_VERSION=` and the rewriter does not, `update`
# reports the line removed, leaves it in place, and reports it again next time.
seed_nexa_env canonical
append_env 'export BUILD_VERSION=v0.1.0-staging.1' '  BUILD_COMMIT=pending'
run_botctl update vA
assert_contains 'the removal was not reported' "$BOTCTL_OUTPUT" 'removed from nexa.env'
assert_equals 'an exported BUILD_VERSION survived the removal' '' "$(nexa_env_key BUILD_VERSION)"
assert_equals 'an indented BUILD_COMMIT survived the removal' '' "$(grep -cE '^[[:space:]]*BUILD_COMMIT=' "${NEXA_CONFIG_DIR}/nexa.env" | tr -d '0')"
run_botctl status
assert_not_contains 'status still reports a line the rewrite claimed to remove' \
  "$BOTCTL_OUTPUT" 'This file still sets'

test_case 'update: a BARE obsolete record is removed too, and an interior one is not'
# Compose accepts `BUILD_COMMIT` with no `=` in an env_file, and it does not mean
# "assigned to nothing": it means take the variable from the environment running Compose.
# Measured on v5.1.1 — host variable set, the container receives the host's value; unset,
# the key is omitted. So a bare obsolete record masks the build identity exactly as an
# assignment does, while the detector, which asked for a VALUE, reported it absent and
# `botctl update` said it had removed the obsolete keys without seeing that one.
seed_nexa_env canonical
printf 'BUILD_COMMIT\n' >>"${NEXA_CONFIG_DIR}/nexa.env"
# And the same name inside another variable's multiline value, which is TEXT and must
# survive: deleting it cuts a line out of an operator's value and leaves a quote that
# closes somewhere else, which is the defect the quoted-region scanner exists to prevent.
printf "NOTE='line one\nBUILD_TIME\nline three'\n" >>"${NEXA_CONFIG_DIR}/nexa.env"
assert_ok 'the predicate missed a top-level bare record' \
  nexa_env_has_bare_record "${NEXA_CONFIG_DIR}/nexa.env" BUILD_COMMIT
assert_fails 'an interior line was reported as a bare record' \
  nexa_env_has_bare_record "${NEXA_CONFIG_DIR}/nexa.env" BUILD_TIME
assert_contains 'the detector did not list the bare record' \
  "$(nexa_obsolete_app_env_keys "${NEXA_CONFIG_DIR}/nexa.env")" 'BUILD_COMMIT'
run_botctl update vA
assert_contains 'the removal was not reported' "$BOTCTL_OUTPUT" 'removed from nexa.env'
assert_fails 'the bare obsolete record survived the update' \
  nexa_env_has_bare_record "${NEXA_CONFIG_DIR}/nexa.env" BUILD_COMMIT
assert_equals "NOTE's first line was lost" '1' \
  "$(grep -c "^NOTE='line one" "${NEXA_CONFIG_DIR}/nexa.env")"
assert_equals "the interior bare line was deleted out of NOTE's value" '1' \
  "$(grep -c '^BUILD_TIME$' "${NEXA_CONFIG_DIR}/nexa.env")"
assert_equals "NOTE's closing line was lost" '1' \
  "$(grep -c "^line three'" "${NEXA_CONFIG_DIR}/nexa.env")"
assert_equals 'the keyring did not survive the removal' "${TEST_KEY_ID}:${TEST_KEK}" \
  "$(nexa_env_key SECRETS_KEYS)"
seed_nexa_env canonical

test_case 'update: the removal never reaches inside another variable value'
# The rewriter has to track quoted regions for the same reason the reader does. A line
# that reads `BUILD_COMMIT=...` inside NOTE's multiline value is not an assignment, and
# dropping it by pattern deletes a line out of the middle of an operator's value —
# silent corruption of /etc/nexa/nexa.env, by an update that reported success.
seed_nexa_env canonical
printf "NOTE='line one\nBUILD_COMMIT=interior\nline three'\nBUILD_COMMIT=pending\n" \
  >>"${NEXA_CONFIG_DIR}/nexa.env"
run_botctl update vA
assert_contains 'the removal was not reported' "$BOTCTL_OUTPUT" 'removed from nexa.env'
# The TOP-LEVEL assignment is gone...
assert_equals 'the top-level BUILD_COMMIT survived' '' \
  "$(grep -c '^BUILD_COMMIT=pending' "${NEXA_CONFIG_DIR}/nexa.env" | tr -d '0')"
# ...and every line of NOTE's value is still there, interior assignment included.
assert_equals "NOTE's first line was lost" '1' \
  "$(grep -c "^NOTE='line one" "${NEXA_CONFIG_DIR}/nexa.env")"
assert_equals "the interior line was deleted out of NOTE's value" '1' \
  "$(grep -c '^BUILD_COMMIT=interior' "${NEXA_CONFIG_DIR}/nexa.env")"
assert_equals "NOTE's closing line was lost" '1' \
  "$(grep -c "^line three'" "${NEXA_CONFIG_DIR}/nexa.env")"

test_case 'update: a name with a trailing comment is not a bare record, and is left alone'
# Measured on v5.1.1: `BUILD_COMMIT # why` in an env_file is REFUSED —
# `unexpected character "#" in variable name "BUILD_COMMIT # why"`. So that line is not a
# record Compose reads; it is a file Compose will not read at all, and `status` reports it
# through the refusal path. The scanner's shape allowed a trailing comment anyway, on a
# behaviour Compose does not have, which made the detector answer yes about a file that has
# no records and sent the rewriter to delete a line on that answer.
seed_nexa_env canonical
printf 'BUILD_COMMIT # why\n' >>"${NEXA_CONFIG_DIR}/nexa.env"
assert_fails 'a name with a trailing comment was reported as a bare record' \
  nexa_env_has_bare_record "${NEXA_CONFIG_DIR}/nexa.env" BUILD_COMMIT
assert_equals 'the detector listed a line Compose refuses whole' '' \
  "$(nexa_obsolete_app_env_keys "${NEXA_CONFIG_DIR}/nexa.env")"
run_botctl update vA
assert_equals 'the line was deleted on a report Compose does not agree with' '1' \
  "$(grep -c '^BUILD_COMMIT # why$' "${NEXA_CONFIG_DIR}/nexa.env")"
seed_nexa_env canonical

test_case 'update: a bare name on an unterminated last line is not a record, and a rewrite refuses'
# The newline is part of what makes a bare record a record. Measured on v5.1.1:
#   ends `BUILD_COMMIT\n`  ->  BUILD_COMMIT: <host value>
#   ends `BUILD_COMMIT`    ->  "": BUILD_COMMIT   a variable with an EMPTY name, and
#                              BUILD_COMMIT is never set at all
#   ends `BUILD_COMMIT=abc`->  BUILD_COMMIT: abc  an assignment is honoured either way
# `awk` hands a final partial line to the program like any other record, so the scanner
# reported a mask that does not exist.
seed_nexa_env canonical
printf 'BUILD_COMMIT' >>"${NEXA_CONFIG_DIR}/nexa.env"
assert_ok 'the harness wrote a terminated file, so the case is not exercised' \
  nexa_env_tail_unterminated "${NEXA_CONFIG_DIR}/nexa.env"
assert_fails 'an unterminated bare name was reported as a record' \
  nexa_env_has_bare_record "${NEXA_CONFIG_DIR}/nexa.env" BUILD_COMMIT
assert_equals 'the detector listed a key Compose does not set' '' \
  "$(nexa_obsolete_app_env_keys "${NEXA_CONFIG_DIR}/nexa.env")"
# An EARLIER terminated record still counts. Measured, both appear in the resolved
# environment: `BUILD_COMMIT: <host>` from the terminated line and `"": BUILD_VERSION` from
# the unterminated one — so the answer for BUILD_COMMIT is yes.
seed_nexa_env canonical
printf 'BUILD_COMMIT\nOTHER=1\nBUILD_VERSION' >>"${NEXA_CONFIG_DIR}/nexa.env"
assert_ok 'a terminated record was dropped because a LATER line is unterminated' \
  nexa_env_has_bare_record "${NEXA_CONFIG_DIR}/nexa.env" BUILD_COMMIT
# And the rewrite of that file is REFUSED by name, with the file untouched. Every rewrite
# normalises the ending — awk prints a newline after each record, and an appended
# assignment must start its own line — so carrying the last line through would CREATE a
# bare record Compose does not currently see, and dropping it would remove a variable the
# file does set. Neither is the rewriter's to choose.
run_botctl update vA
assert_contains 'the refusal did not name the reason' "$BOTCTL_OUTPUT" 'no final newline'
assert_contains 'the file was reported as changed' "$BOTCTL_OUTPUT" 'it is UNCHANGED'
assert_equals 'the terminated bare record was removed anyway' '1' \
  "$(grep -c '^BUILD_COMMIT$' "${NEXA_CONFIG_DIR}/nexa.env")"
assert_ok 'the rewrite normalised the unterminated ending' \
  nexa_env_tail_unterminated "${NEXA_CONFIG_DIR}/nexa.env"
assert_equals 'the keyring did not survive the refusal' "${TEST_KEY_ID}:${TEST_KEK}" \
  "$(nexa_env_key SECRETS_KEYS)"
seed_nexa_env canonical

test_case 'harness: the loadability oracle sees an unterminated file'
# Three cases below assert that the rewriter never leaves a file Compose would refuse,
# through `nexa_compose_env_unterminated`. They used to call it in a `bash -c` that had
# not sourced the library — `! undefined-command` exits 0 — so all three passed
# vacuously against any rewriter at all. The oracle is asked here about a file that IS
# unterminated and one that is not, so that a green run below means what it says.
oracle_file="$(mktemp)"
printf "OK=1\nNOTE='never closed\n" >"$oracle_file"
assert_ok 'an unterminated file was not detected' nexa_compose_env_unterminated "$oracle_file"
printf "OK=1\nNOTE='closed'\nTAIL=ok\n" >"$oracle_file"
assert_fails 'a complete file was reported as unterminated' nexa_compose_env_unterminated "$oracle_file"
rm -f "$oracle_file"

test_case 'update: dropping a single-line key does not swallow the NEXT value'
# The suppression flag means "skip the continuation lines of the value being dropped".
# Leaving it set after dropping a SINGLE-line assignment made the next multiline value
# lose its continuation lines — including its closing quote — so the update installed
# an unterminated nexa.env, which Compose refuses outright, and reported success.
seed_nexa_env canonical
printf "BUILD_COMMIT=pending\nNOTE='first\nsecond'\nTAIL=ok\n" >>"${NEXA_CONFIG_DIR}/nexa.env"
run_botctl update vA
assert_equals 'the single-line key was not removed' '' "$(nexa_env_key BUILD_COMMIT)"
assert_equals "the next value's closing line was swallowed" '1' \
  "$(grep -c "^second'" "${NEXA_CONFIG_DIR}/nexa.env")"
assert_fails 'the rewritten file ends inside a quoted value' \
  nexa_compose_env_unterminated "${NEXA_CONFIG_DIR}/nexa.env"
assert_equals 'a key after the multiline value was lost' 'ok' "$(nexa_env_key TAIL)"

test_case 'update: an obsolete record whose quote never closes is refused, and the file is UNCHANGED'
# `BUILD_COMMIT='pending` with no closing quote is a record the rewriter is asked to
# drop. It set `skip` on entering the value and, with no closing quote, stayed in it to
# EOF — so every later line, the keyring included, was deleted by an update that
# reported success. Compose refuses such a file whole anyway, but a rewrite that
# cannot tell a later line from the value it is in has no safe output, so the original
# stays and the operator is told to close the quote.
seed_nexa_env canonical
printf '%s\n' "BUILD_COMMIT='pending" 'TAIL_KEY=still-here' >>"${NEXA_CONFIG_DIR}/nexa.env"
before="$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
run_botctl update vA
assert_equals 'the file was rewritten from an unterminated record' "$before" \
  "$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
assert_contains 'the reason for leaving the file alone was not given' \
  "$BOTCTL_OUTPUT" 'ends inside a quoted value'
assert_contains 'the keyring after the unterminated record was lost' \
  "$(cat "${NEXA_CONFIG_DIR}/nexa.env")" 'SECRETS_KEYS='
assert_contains 'the last line was lost' "$(cat "${NEXA_CONFIG_DIR}/nexa.env")" 'TAIL_KEY=still-here'
# And the update as a whole still SUCCEEDS: a stale build label is not worth failing
# an update over, which is why the removal is non-fatal. A die that escaped the
# subshell would turn a cosmetic repair into a refused update.
assert_equals 'a refused removal failed the whole update' 0 "$BOTCTL_STATUS"
seed_nexa_env canonical

test_case 'update: an ESCAPED delimiter does not end a value early'
# Compose honours an escaped delimiter: a quote is escaped when an ODD number of
# backslashes precedes it, measured on v5.1.1. A reader that stopped at the first
# matching character would end this value at `it\'` and then treat the interior
# BUILD_COMMIT line as a top-level assignment — which the rewriter deletes, silently
# changing the operator's value.
seed_nexa_env canonical
# `printf '%s\n' ARG...` rather than a format string with escapes in it: the first
# version of this fixture wrote `NOTE='it's fine`, losing the backslash, because
# printf treats `\'` as an unknown escape and drops it. The case then described a file
# whose quote is NOT escaped — where deleting the interior line is the right answer —
# so it failed against correct code. A fixture that does not contain what the case
# says it contains is the same defect as a test that cannot fail.
printf '%s\n' "NOTE='it\\'s fine" 'BUILD_COMMIT=interior' "done'" 'TAIL=ok' \
  >>"${NEXA_CONFIG_DIR}/nexa.env"
assert_equals 'the fixture lost the escaping backslash it is about' '1' \
  "$(grep -c "^NOTE='it\\\\'s fine$" "${NEXA_CONFIG_DIR}/nexa.env")"
run_botctl update vA
assert_equals "the interior line was deleted out of NOTE's value" '1' \
  "$(grep -c '^BUILD_COMMIT=interior' "${NEXA_CONFIG_DIR}/nexa.env")"
assert_equals "NOTE's closing line was lost" '1' \
  "$(grep -c "^done'" "${NEXA_CONFIG_DIR}/nexa.env")"
assert_fails 'the rewritten file ends inside a quoted value' \
  nexa_compose_env_unterminated "${NEXA_CONFIG_DIR}/nexa.env"
# And `status` does not report the interior line as a setting either.
run_botctl status
assert_not_contains 'an interior line after an escaped quote was reported as a setting' \
  "$BOTCTL_OUTPUT" 'This file sets BUILD_COMMIT'

test_case 'update: removing a multiline obsolete value takes its continuation lines'
# The other half. If an obsolete key opens a multiline value and only its first line
# goes, what is left is a dangling fragment and a quote that now closes somewhere
# else — a file Compose refuses whole, produced by a repair.
seed_nexa_env canonical
printf "BUILD_TIME='first\nsecond'\nWEB_ADMIN_ORIGINS=https://admin.example.test\n" \
  >>"${NEXA_CONFIG_DIR}/nexa.env"
run_botctl update vA
assert_equals 'the first line of the multiline value survived' '' \
  "$(grep -c "^BUILD_TIME='first" "${NEXA_CONFIG_DIR}/nexa.env" | tr -d '0')"
assert_equals 'the continuation line was left behind as a fragment' '' \
  "$(grep -c "^second'" "${NEXA_CONFIG_DIR}/nexa.env" | tr -d '0')"
# And the file is still one Compose will read.
assert_fails 'the rewritten file ends inside a quoted value' \
  nexa_compose_env_unterminated "${NEXA_CONFIG_DIR}/nexa.env"
assert_equals 'an unrelated key was lost' 'https://admin.example.test' \
  "$(nexa_env_key WEB_ADMIN_ORIGINS)"

test_case 'update: a value opened with any separator Compose accepts is still one value'
# The escaped-delimiter case above, one separator over. Compose accepts `NAME=`,
# `NAME =`, `NAME:` and `NAME :` in an `env_file`, and measured on v5.1.1 all four open a
# quoted value that spans lines identically — so an interior `BUILD_COMMIT=` line is TEXT
# in every one of them. The scanners opened a quoted region only on `NAME=`, which left
# them out of sync with Compose for the other three: the interior line was classified as a
# top-level assignment, and this automatic reconciliation DELETED it out of the middle of
# the operator's value while reporting a successful cleanup of a key that never existed.
#
# A secret is the fixture on purpose. The real case is an operator who wrote
# `TELEGRAM_WEBHOOK_SECRET = '...'`: every Telegram update is authenticated by that
# header, so a silently shortened value breaks the webhook and nothing says why.
for separator in ' =' ':' ' :'; do
  seed_nexa_env canonical
  printf '%s\n' "TELEGRAM_WEBHOOK_SECRET${separator}'abcdefghijklmnop" \
    'BUILD_COMMIT=interior' "tail'" 'TAIL_KEY=ok' \
    >>"${NEXA_CONFIG_DIR}/nexa.env"
  run_botctl update vA
  assert_equals "separator '${separator}': the interior line was deleted out of the secret" '1' \
    "$(grep -c '^BUILD_COMMIT=interior' "${NEXA_CONFIG_DIR}/nexa.env")"
  assert_equals "separator '${separator}': the closing line of the value was lost" '1' \
    "$(grep -c "^tail'" "${NEXA_CONFIG_DIR}/nexa.env")"
  assert_not_contains "separator '${separator}': a removal was reported for a key that is not a record" \
    "$BOTCTL_OUTPUT" 'removed from nexa.env'
  assert_fails "separator '${separator}': the rewritten file ends inside a quoted value" \
    nexa_compose_env_unterminated "${NEXA_CONFIG_DIR}/nexa.env"
  assert_equals "separator '${separator}': an unrelated key after the value was lost" 'ok' \
    "$(nexa_env_key TAIL_KEY)"
  # And `status` does not report the interior line as a setting either.
  run_botctl status
  assert_not_contains "separator '${separator}': an interior line was reported as a setting" \
    "$BOTCTL_OUTPUT" 'This file sets BUILD_COMMIT'
done
# The negative case, or the rule above is just "never remove anything": a REAL top-level
# obsolete assignment is still found and still removed, and a colon inside a VALUE — which
# the keyring grammar always has — is not a separator.
seed_nexa_env canonical
printf '%s\n' 'BUILD_COMMIT=deadbeef' 'TAIL_KEY=ok' >>"${NEXA_CONFIG_DIR}/nexa.env"
run_botctl update vA
assert_contains 'a real top-level obsolete assignment stopped being removed' \
  "$BOTCTL_OUTPUT" 'removed from nexa.env'
assert_equals 'the real obsolete assignment survived' '' \
  "$(grep -c '^BUILD_COMMIT=deadbeef' "${NEXA_CONFIG_DIR}/nexa.env" | tr -d '0')"
assert_equals 'an unrelated key was lost' 'ok' "$(nexa_env_key TAIL_KEY)"
assert_contains 'the keyring was damaged by the wider quote tracking' \
  "$(cat "${NEXA_CONFIG_DIR}/nexa.env")" 'SECRETS_KEYS='
seed_nexa_env canonical

test_case 'update: a record Compose accepts is a record whatever its NAME looks like'
# The separator case above, reached through the other half of the grammar. Measured on
# v5.1.1, Compose accepts names this repository would never write — `notes.value`,
# `notes-value`, `1notes`, `NOTES[0]` — and refuses `@`, `/` and `#`. A tracker built on
# `[A-Za-z_][A-Za-z0-9_]*` missed a DOTTED record opening a multiline value, put its
# interior lines back at top level, and the reconciliation deleted one: the same data loss
# as the wrong separator, so the same test shape.
for name in 'notes.value' 'notes-value' '1notes' 'NOTES[0]'; do
  seed_nexa_env canonical
  printf '%s\n' "${name}:'first" 'BUILD_COMMIT=interior' "last'" 'TAIL_KEY=ok' \
    >>"${NEXA_CONFIG_DIR}/nexa.env"
  run_botctl update vA
  assert_equals "name '${name}': the interior line was deleted out of the value" '1' \
    "$(grep -c '^BUILD_COMMIT=interior' "${NEXA_CONFIG_DIR}/nexa.env")"
  assert_equals "name '${name}': the closing line of the value was lost" '1' \
    "$(grep -c "^last'" "${NEXA_CONFIG_DIR}/nexa.env")"
  assert_not_contains "name '${name}': a removal was reported for a key that is not a record" \
    "$BOTCTL_OUTPUT" 'removed from nexa.env'
  assert_equals "name '${name}': an unrelated key after the value was lost" 'ok' \
    "$(nexa_env_key TAIL_KEY)"
done
# A comment is still a comment and a blank line is still blank, or the wider name grammar
# has turned the whole file into records.
seed_nexa_env canonical
printf '%s\n' '# BUILD_COMMIT=not-a-record' '' 'TAIL_KEY=ok' >>"${NEXA_CONFIG_DIR}/nexa.env"
run_botctl update vA
assert_not_contains 'a commented line was reported as an obsolete record' \
  "$BOTCTL_OUTPUT" 'removed from nexa.env'
assert_equals 'a commented line was deleted' '1' \
  "$(grep -c '^# BUILD_COMMIT=not-a-record' "${NEXA_CONFIG_DIR}/nexa.env")"
assert_equals 'a key after a comment and a blank line was lost' 'ok' "$(nexa_env_key TAIL_KEY)"
seed_nexa_env canonical

test_case 'update: says nothing and changes nothing when there is nothing to remove'
seed_nexa_env canonical
before="$(cat "${NEXA_CONFIG_DIR}/nexa.env")"
run_botctl update vA
assert_not_contains 'a removal was reported with nothing to remove' \
  "$BOTCTL_OUTPUT" 'removed from nexa.env'
assert_equals 'the file was rewritten for no reason' "$before" \
  "$(cat "${NEXA_CONFIG_DIR}/nexa.env")"

test_case 'update: repairs the file even when the target version is already current'
# The command an operator runs to repair an installation is
# `botctl update <the version it already has>`, and that path returns early.
# Reconciling after the early return would have made the repair unreachable on
# the one host that needed it.
seed_nexa_env canonical
append_env 'BUILD_COMMIT=pending'
run_botctl update vA
assert_contains 'the no-op update did not report the removal' "$BOTCTL_OUTPUT" 'removed from nexa.env'
assert_equals 'BUILD_COMMIT survived a no-op update' '' "$(nexa_env_key BUILD_COMMIT)"
# And it must say the removal has not taken effect yet. This path recreates no
# container, so the running processes still carry the values just removed — and
# `status` reading the cleaned file would stop warning about an effect still in
# force. Without this line the operator is told a repair happened that has not.
assert_contains 'the operator was not told the repair needs a restart' \
  "$BOTCTL_OUTPUT" "still in the running containers' environment"
assert_contains 'the remedy was not named' "$BOTCTL_OUTPUT" 'botctl restart'

test_case 'update: an already-current release with nothing to remove says nothing about restarting'
# The pending-restart note must follow a removal, not every no-op update.
seed_nexa_env canonical
run_botctl update vA
assert_contains 'the no-op was not reported' "$BOTCTL_OUTPUT" 'Nothing to do'
assert_not_contains 'a restart was advised with nothing removed' \
  "$BOTCTL_OUTPUT" "still in the running containers' environment"
teardown_root

# ---------------------------------------------------------------------------
# The Telegram fresh-install bootstrap
# ---------------------------------------------------------------------------
#
# Driven by SOURCING the installer and calling one function, the way every other
# installer test here does: a real run would install Docker on the build
# machine. What each case exercises is a decision the installer makes, and each
# of those decisions has a failure mode an operator pays for — being asked for a
# token twice, being told a working bot needs configuring, or being told an
# installation succeeded when its bot cannot receive a message.

test_case 'the installer adds the Telegram configuration to a nexa.env that predates it'
tg_config="${NEXA_ROOT}/etc/nexa-telegram-old"
rm -rf "$tg_config"
install -d -m 0700 "$tg_config"
# A nexa.env exactly as a pre-Telegram release left it.
cat >"${tg_config}/nexa.env" <<'OLDENV'
NODE_ENV=production
DATABASE_URL=postgres://nexa:pw@postgres:5432/nexa
NOTIFICATION_TRANSPORT=telegram
OLDENV
chmod 0600 "${tg_config}/nexa.env"
NEXA_CONFIG_DIR="$tg_config" bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test >/dev/null 2>&1
  ensure_telegram_config >/dev/null 2>&1
' _ "${REPO}/deploy/install.sh" || fail_test 'ensure_telegram_config did not complete'

tg_added_secret="$(nexa_env_value "${tg_config}/nexa.env" TELEGRAM_WEBHOOK_SECRET)"
tg_added_enabled="$(nexa_env_value "${tg_config}/nexa.env" TELEGRAM_WEBHOOK_ENABLED)"
assert_equals 'the webhook was not enabled on the upgraded host' 'true' "$tg_added_enabled"
# Length, not non-emptiness: the schema requires at least 16 characters once the
# webhook is on, so a short one would fail the application's own boot.
if [ "${#tg_added_secret}" -lt 16 ]; then
  fail_test 'ensure_telegram_config wrote no usable TELEGRAM_WEBHOOK_SECRET'
fi
assert_file_mode 'the upgraded nexa.env lost its mode' "${tg_config}/nexa.env" 600
# The operator's existing lines are untouched: `>>` is the only safe edit to a
# file somebody else owns.
assert_contains 'an existing key was lost' \
  "$(cat "${tg_config}/nexa.env")" 'DATABASE_URL=postgres://nexa:pw@postgres:5432/nexa'

test_case 'a rerun never regenerates the webhook secret'
# THE rule this function exists to keep. Telegram holds the value it was given
# at registration and signs every update with it, so minting a new one here
# would make the API reject every update from a working bot — silently, until
# somebody re-registered the webhook.
NEXA_CONFIG_DIR="$tg_config" bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test >/dev/null 2>&1
  ensure_telegram_config >/dev/null 2>&1
' _ "${REPO}/deploy/install.sh" || fail_test 'the second ensure_telegram_config did not complete'
assert_equals 'the webhook secret was regenerated on a rerun' \
  "$tg_added_secret" "$(nexa_env_value "${tg_config}/nexa.env" TELEGRAM_WEBHOOK_SECRET)"
# And exactly one of each key: an append that ran twice would leave two, and
# Compose takes the LAST — so the file would say one thing and the running
# container another.
assert_equals 'TELEGRAM_WEBHOOK_SECRET was appended twice' '1' \
  "$(grep -c '^TELEGRAM_WEBHOOK_SECRET=' "${tg_config}/nexa.env")"
assert_equals 'TELEGRAM_WEBHOOK_ENABLED was appended twice' '1' \
  "$(grep -c '^TELEGRAM_WEBHOOK_ENABLED=' "${tg_config}/nexa.env")"

test_case 'the additive Telegram configuration is written by rename, not by append'
# A `>>` interrupted by ENOSPC can land TELEGRAM_WEBHOOK_ENABLED=true and a
# TRUNCATED but non-empty TELEGRAM_WEBHOOK_SECRET. The next run reads both keys
# as present and returns without repairing them, while the application refuses a
# secret below the schema's minimum length — so the installation cannot boot and
# cannot be resumed without an operator editing the file by hand.
#
# The proof is that the original file survives a failed write intact. `mktemp` is
# made to fail after the pre-checks have passed, which is the one seam that
# stands in for every way the write can die.
tg_atomic="${NEXA_ROOT}/etc-atomic"
mkdir -p "$tg_atomic"
printf 'DATABASE_URL=postgres://nexa:pw@postgres:5432/nexa\nNODE_ENV=production\n' \
  >"${tg_atomic}/nexa.env"
tg_atomic_before="$(cat "${tg_atomic}/nexa.env")"
NEXA_CONFIG_DIR="$tg_atomic" bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test >/dev/null 2>&1
  mktemp() { return 1; }
  ensure_telegram_config >/dev/null 2>&1
' _ "${REPO}/deploy/install.sh" && fail_test 'a failed write did not stop the installer'
assert_equals 'a failed write left the config file changed' \
  "$tg_atomic_before" "$(cat "${tg_atomic}/nexa.env")"
# Nothing half-written left lying around under a name a later glob might read.
assert_equals 'a failed write left a temporary file behind' '1' \
  "$(find "$tg_atomic" -maxdepth 1 -type f | wc -l | tr -d ' ')"
# And the successful path still adds both keys, exactly once each.
NEXA_CONFIG_DIR="$tg_atomic" bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test >/dev/null 2>&1
  ensure_telegram_config >/dev/null 2>&1
' _ "${REPO}/deploy/install.sh" || fail_test 'the ordinary additive write did not complete'
assert_equals 'the rename did not add TELEGRAM_WEBHOOK_SECRET' '1' \
  "$(grep -c '^TELEGRAM_WEBHOOK_SECRET=' "${tg_atomic}/nexa.env")"
assert_equals 'the rename did not preserve what the file already held' '1' \
  "$(grep -c '^NODE_ENV=production$' "${tg_atomic}/nexa.env")"
assert_equals 'the rewritten config is not 0600' '600' \
  "$(stat -c '%a' "${tg_atomic}/nexa.env")"

test_case 'a webhook failure does not report a successful install, and does not undo anything'
# The installer step with the CLI forced to fail on a RECONCILE — a stored token
# and an outstanding registration, which is the case the resume story is about.
# `configure_telegram_bot` must NOT die: the tenant, the owner, the encrypted
# token and the bot row are all correct and expensive to produce. It must set
# the flag that makes `main` exit non-zero with the outstanding step named.
telegram_fail_output="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test >/dev/null 2>&1
  # The two seams: what the CLI answers about state, and whether it succeeds.
  telegram_state() { printf "incomplete"; }
  nexa_compose() { return 1; }
  configure_telegram_bot 2>&1
  printf "INCOMPLETE=%s RETRY=%s\n" "$TELEGRAM_INCOMPLETE" "$TELEGRAM_RETRY"
' _ "${REPO}/deploy/install.sh" || printf 'THE_STEP_DIED')"
assert_not_contains 'the failed Telegram step aborted the install' \
  "$telegram_fail_output" 'THE_STEP_DIED'
assert_contains 'the install was not marked incomplete' "$telegram_fail_output" 'INCOMPLETE=yes'
assert_contains 'the operator was not told the bot is not receiving updates' \
  "$telegram_fail_output" 'not receiving updates'
# The state is re-read AFTER the failure, because it decides which summary the
# operator gets. A stored credential means the cheap retry is honest.
assert_contains 'the retry state was not recorded' "$telegram_fail_output" 'RETRY=incomplete'

test_case 'a FIRST-attempt failure does not claim a stored token'
printf '8123456789:AA-not-a-real-token\n' >"${NEXA_ROOT}/first-fail-token"
: >"${NEXA_ROOT}/first-fail-calls"
# `getMe` runs before `createFromBootstrap`, so a rejected token or an
# unreachable Telegram on a first attempt writes NOTHING. Every failure used to
# land in one branch and print "the token is stored encrypted; botctl telegram
# register will retry without asking" — false in every part, and it sends the
# operator to a command that supplies no token by design and therefore cannot
# create the first row.
telegram_first_fail="$(bash -c '
  CALLS="$2"
  . "$1" --domain admin.example.test --acme-email ops@example.test --bot-token-file "$3" >/dev/null 2>&1
  telegram_state() { printf "none"; }
  nexa_compose() { printf "%s\n" "$*" >>"$CALLS"; return 1; }
  configure_telegram_bot 2>&1
  printf "INCOMPLETE=%s RETRY=%s\n" "$TELEGRAM_INCOMPLETE" "$TELEGRAM_RETRY"
' _ "${REPO}/deploy/install.sh" "${NEXA_ROOT}/first-fail-calls" "${NEXA_ROOT}/first-fail-token" || printf 'THE_STEP_DIED')"
assert_not_contains 'a first-attempt failure aborted the install' \
  "$telegram_first_fail" 'THE_STEP_DIED'
assert_contains 'a first-attempt failure was not marked incomplete' \
  "$telegram_first_fail" 'INCOMPLETE=yes'
# `none` after the failure is the whole point: nothing was written, so the
# summary must not promise a resume.
assert_contains 'the retry state after a first-attempt failure was not none' \
  "$telegram_first_fail" 'RETRY=none'
# The summary this state gets says the opposite of the other one, and says the
# retry is the installer rather than a command that cannot create a first row.
telegram_nothing_summary="$(sed -n '/INCOMPLETE_NOTHING_STORED$/,/^INCOMPLETE_NOTHING_STORED$/p' "${REPO}/deploy/install.sh")"
assert_contains 'the summary does not distinguish a failure that stored nothing' \
  "$telegram_nothing_summary" 'Nothing was stored'
assert_contains 'the nothing-stored summary does not point at the error above' \
  "$telegram_nothing_summary" 'the error printed above this summary'
# `OQ-TG-04` item 2. "Rerun with a token source" is itself a cause-derived
# remedy, and it is false for an already-bound refusal — whose rolled-back insert
# leaves the state `none` too, so that rerun refuses identically for ever. This
# summary states what is stored and stops.
assert_not_contains 'the nothing-stored summary still prescribes an installer rerun' \
  "$telegram_nothing_summary" '--bot-token-file'
assert_not_contains 'the nothing-stored summary still prescribes a botctl command' \
  "$telegram_nothing_summary" 'botctl telegram register'

test_case 'an unreadable Telegram state is refused rather than guessed'
# Both readings are wrong in a way the operator pays for: treating it as `none`
# asks for a token an installation may already have, and treating it as `ready`
# reports a bot that may never have been configured.
telegram_unknown="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test >/dev/null 2>&1
  telegram_state() { printf "docker: command not found"; }
  # Stubbed as well, so the refusal cannot be satisfied by an accident: without
  # it, a version of this step that GUESSED would fall through to a real
  # `docker compose` on the build machine and hang rather than fail — which is
  # how the mutation aimed at this rule first presented.
  nexa_compose() { return 1; }
  configure_telegram_bot 2>&1
' _ "${REPO}/deploy/install.sh" || true)"
assert_contains 'an unreadable state was not refused' "$telegram_unknown" 'Refusing to guess'

test_case 'skip-telegram does not tell a configured installation to configure itself'
# `--skip-owner` had to learn this on a real host: it told an already
# bootstrapped installation to run a bootstrap that would refuse it. Same shape.
telegram_skip_ready="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test --skip-telegram >/dev/null 2>&1
  telegram_state() { printf "ready"; }
  nexa_compose() { return 1; }
  configure_telegram_bot 2>&1
' _ "${REPO}/deploy/install.sh" || true)"
assert_contains 'a configured bot was not reported as configured' \
  "$telegram_skip_ready" 'already configured'
assert_not_contains 'a configured installation was told to register' \
  "$telegram_skip_ready" 'botctl telegram register'

telegram_skip_none="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test --skip-telegram >/dev/null 2>&1
  telegram_state() { printf "none"; }
  nexa_compose() { return 1; }
  configure_telegram_bot 2>&1
' _ "${REPO}/deploy/install.sh" || true)"
# `botctl telegram register` supplies no token by design, so it CANNOT create
# the first bot row. Naming it here sent the operator to a command that must
# fail; the remedy for `none` is an installer rerun with a token source.
assert_not_contains 'a fresh skip named a command that cannot create the first bot' \
  "$telegram_skip_none" 'botctl telegram register'
assert_contains 'a fresh skip did not name the installer rerun' \
  "$telegram_skip_none" '--bot-token-file'

test_case 'a rerun with a stored token says it will not ask again'
# `incomplete` means the credential is already stored and only the registration
# is outstanding. The CLI refuses to ask from the same state; saying so here is
# what stops an operator wondering why they were not prompted.
telegram_resume="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test >/dev/null 2>&1
  telegram_state() { printf "incomplete"; }
  nexa_compose() { return 0; }
  configure_telegram_bot 2>&1
' _ "${REPO}/deploy/install.sh" || true)"
assert_contains 'a resumed run did not say the token would not be asked for' \
  "$telegram_resume" 'will not be asked for it again'
assert_contains 'a resumed run did not report success' \
  "$telegram_resume" 'configured and receiving updates'

test_case 'a rerun of a READY installation still asks the application'
# ADR-0029: a rerun asks Telegram whether the stored token still works, EVERY
# time — the only way the promise to report a revoked token can be kept. This
# step used to short-circuit on `ready` and never invoke the CLI, so the rule
# was implemented in the layer that cannot be the last word and bypassed in the
# layer that is.
telegram_ready_calls="${NEXA_ROOT}/telegram-ready-calls"
: >"$telegram_ready_calls"
telegram_ready="$(bash -c '
  # Captured BEFORE sourcing. Two reasons, and each alone would be enough:
  # sourcing with arguments replaces the positional parameters, and inside a
  # function $2 is that function own second argument rather than the script one.
  CALLS="$2"
  . "$1" --domain admin.example.test --acme-email ops@example.test >/dev/null 2>&1
  telegram_state() { printf "ready"; }
  nexa_compose() { printf "%s\n" "$*" >>"$CALLS"; return 0; }
  configure_telegram_bot 2>&1
' _ "${REPO}/deploy/install.sh" "$telegram_ready_calls" || true)"
assert_ok 'a READY rerun never invoked the bootstrap CLI' test -s "$telegram_ready_calls"
assert_contains 'the READY rerun did not run the bootstrap CLI' \
  "$(cat "$telegram_ready_calls")" 'dist/bootstrap-bot.cli.js'
# And it did not offer to take a token, because there is nothing to ask for.
# No token source was given to THIS run, so none is passed on.
assert_not_contains 'a READY rerun invented a token source' \
  "$(cat "$telegram_ready_calls")" '--bot-token-stdin'
assert_contains 'the READY rerun did not report success' \
  "$telegram_ready" 'configured and receiving updates'

test_case 'an unavailable bot still runs the CLI, and a supplied token still reaches it'
# This state used to RETURN before the CLI was invoked, and returning was wrong
# twice over. A supplied token file never reached `refuseRepointing`, so a file
# naming a DIFFERENT bot was silently ignored in the one state an operator is
# most likely to be reaching for one; and the reason nothing could be registered
# was never printed, only a second command to go and ask for it.
: >"${NEXA_ROOT}/unavailable-calls"
printf '8123456789:AA-not-a-real-token\n' >"${NEXA_ROOT}/unavailable-token"
telegram_stopped="$(bash -c '
  CALLS="$2"
  . "$1" --domain admin.example.test --acme-email ops@example.test --bot-token-file "$3" >/dev/null 2>&1
  telegram_state() { printf "unavailable"; }
  nexa_compose() { printf "%s\n" "$*" >>"$CALLS"; return 1; }
  configure_telegram_bot 2>&1
  printf "INCOMPLETE=%s RETRY=%s\n" "$TELEGRAM_INCOMPLETE" "$TELEGRAM_RETRY"
' _ "${REPO}/deploy/install.sh" "${NEXA_ROOT}/unavailable-calls" "${NEXA_ROOT}/unavailable-token" || printf 'THE_STEP_DIED')"
assert_not_contains 'an unavailable bot aborted the install' "$telegram_stopped" 'THE_STEP_DIED'
assert_contains 'an unavailable bot did not fail the install' "$telegram_stopped" 'INCOMPLETE=yes'
assert_contains 'the supplied token never reached the CLI in the unavailable state' \
  "$(cat "${NEXA_ROOT}/unavailable-calls")" '--bot-token-stdin'
# And its own summary, because the outstanding work is NOT the webhook: telling
# the operator to register one sends them to a call the service refuses before
# it makes it.
assert_contains 'an unavailable bot was not given its own retry state' \
  "$telegram_stopped" 'RETRY=unavailable'
# `unavailable` now reaches the summary that claims NOTHING about a stored
# credential, because after `OQ-TG-04` item 11 an inactive tenant answers
# `unavailable` with no bot row at all — so "a token is stored" stopped being
# provable in this state. What is outstanding comes from the CLI's own error and
# from `botctl telegram status`, which prints the reason on stderr.
telegram_unproven_summary="$(sed -n '/INCOMPLETE_UNPROVEN$/,/^INCOMPLETE_UNPROVEN$/p' "${REPO}/deploy/install.sh")"
assert_contains 'the unproven summary does not admit what it cannot prove' \
  "$telegram_unproven_summary" 'cannot prove it either way'
assert_not_contains 'the unproven summary claims a token is stored' \
  "$telegram_unproven_summary" 'token IS stored'

test_case 'a completed update reconciles the Telegram command menu'
# `OQ-4H-02`. `setMyCommands` runs inside the bootstrap CLI and nowhere else, and
# `botctl update` did not invoke it — so an installation that UPGRADED into a
# release adding a command kept whatever menu it had until somebody happened to
# run `botctl telegram register`.
update_body="$(sed -n '/^cmd_update() {/,/^}/p' "${REPO}/deploy/bin/botctl")"
assert_ok 'the cmd_update body could not be read; this check is vacuous' test -n "$update_body"
assert_contains 'a completed update does not reconcile the command menu' \
  "$update_body" 'dist/bootstrap-bot.cli.js'
# AFTER the release is committed, never before. Everything that can fail the
# update has already succeeded by then, and a menu is not a reason to fail a
# healthy committed release.
update_tail="${update_body#*nexa_prune_releases}"
assert_contains 'the menu reconcile does not run after the release is committed' \
  "$update_tail" 'dist/bootstrap-bot.cli.js'
# And it cannot fail the update: the invocation is guarded and the failure
# branch warns rather than dying.
assert_not_contains 'a failed menu reconcile kills a completed update' \
  "$update_tail" 'nexa_die'
assert_contains 'a failed menu reconcile says nothing to the operator' \
  "$update_tail" "run 'botctl telegram register'"
# No token, ever, from this path: it reconciles from the stored credential.
assert_not_contains 'the update passes a token to the bootstrap CLI' \
  "$update_tail" '--bot-token'

test_case 'a first install with no terminal and no token records its release'
# `nexa_die` here exited before the manifest and the `current` pointer were
# written, leaving a RUNNING installation that `botctl version` cannot describe
# — the failure the owner step records from a real staging host. ADR-0029
# decision 4 already says what to do instead: finish recording the release,
# report INCOMPLETE, exit non-zero.
#
# Untouched by the 4I collapse, which changes only which SUMMARY is printed
# afterwards. Cited by `docs/telegram-bootstrap-falsification.md` row F7.
telegram_no_tty="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test >/dev/null 2>&1
  telegram_state() { printf "none"; }
  nexa_compose() { printf "SHOULD_NOT_RUN\n"; return 0; }
  configure_telegram_bot 2>&1 </dev/null
  printf "INCOMPLETE=%s RETRY=%s\n" "$TELEGRAM_INCOMPLETE" "$TELEGRAM_RETRY"
' _ "${REPO}/deploy/install.sh" </dev/null || printf 'THE_STEP_DIED')"
assert_not_contains 'a missing token killed the install before the manifest' \
  "$telegram_no_tty" 'THE_STEP_DIED'
assert_contains 'a missing token did not mark the install incomplete' \
  "$telegram_no_tty" 'INCOMPLETE=yes'
# And it did not silently run the CLI without a way to read a token.
assert_not_contains 'the CLI was invoked with no token source and no terminal' \
  "$telegram_no_tty" 'SHOULD_NOT_RUN'

test_case 'the CLI error reaches the operator, whatever the state'
# The classifier is gone (`OQ-TG-04`), so what has to hold is the other half:
# capturing the CLI's output to PRINT it must never be the same as swallowing it.
# That output is now the only thing carrying the cause, so every one of these
# failures is only as visible as this line makes it.
for cli_error in \
  'telegram.bootstrap_token_rejected: Telegram refused it.' \
  'telegram.bootstrap_bot_already_bound: bot 8123456789 is taken.' \
  'telegram.bootstrap_different_bot: belongs to bot 999.' \
  'telegram.bootstrap_unreachable: ETIMEDOUT.' \
  'platform.secret_key_unknown: no key with that id.'; do
  # `CLI_ERROR` is captured BEFORE the function is defined, for the reason the
  # READY-rerun case above already records: inside a function `$2` is that
  # function's own second argument, not the script's.
  telegram_relay="$(bash -c '
    CLI_ERROR="$2"
    . "$1" --domain admin.example.test --acme-email ops@example.test >/dev/null 2>&1
    telegram_state() { printf "incomplete"; }
    nexa_compose() { printf "%s\n" "$CLI_ERROR"; return 1; }
    configure_telegram_bot 2>&1
  ' _ "${REPO}/deploy/install.sh" "$cli_error" || printf 'THE_STEP_DIED')"
  assert_not_contains "a CLI failure aborted the install (${cli_error%%:*})" \
    "$telegram_relay" 'THE_STEP_DIED'
  assert_contains "the CLI error was swallowed (${cli_error%%:*})" \
    "$telegram_relay" "${cli_error%%:*}"
done

test_case 'the summary is chosen by the state alone, never by the CLI output'
# The rule the collapse installs, asserted as behaviour rather than as prose.
# The SAME state with five different CLI errors must produce the SAME summary:
# the installer cannot see which failure it was, and the six summaries it used to
# choose between are what `OQ-TG-04` records nine false sentences from.
# The summaries live in `main`, after the release manifest is written — which is
# ADR-0029 decision 4 and is why a failed Telegram step still records a release.
# So this drives the BLOCK rather than the step: the state and the captured error
# are the two inputs, and the `state` line of whichever summary is chosen is the
# output.
telegram_summary_for() {
  bash -c '
    CLI_ERROR="$2"
    CLI_STATE="$3"
    . "$1" --domain admin.example.test --acme-email ops@example.test >/dev/null 2>&1
    telegram_state() { printf "%s" "$CLI_STATE"; }
    nexa_compose() { printf "%s\n" "$CLI_ERROR"; return 1; }
    configure_telegram_bot >/dev/null 2>&1
    VERSION="v0.0.0-test"
    DOMAIN="admin.example.test"
    if [ -n "$TELEGRAM_INCOMPLETE" ]; then
      TELEGRAM_RETRY="$(telegram_state)"
      telegram_incomplete_summary 2>&1 | grep -F "  state "
    fi
  ' _ "${REPO}/deploy/install.sh" "$1" "$2"
}
summary_a="$(telegram_summary_for 'telegram.bootstrap_token_rejected: no.' 'incomplete')"
summary_b="$(telegram_summary_for 'platform.secret_key_unknown: no key.' 'incomplete')"
summary_c="$(telegram_summary_for 'telegram.bootstrap_unreachable: nope.' 'incomplete')"
assert_ok 'the state line could not be read; this check is vacuous' test -n "$summary_a"
assert_equals 'a different CLI error changed the summary for one state' "$summary_a" "$summary_b"
assert_equals 'a different CLI error changed the summary for one state' "$summary_a" "$summary_c"
# And a DIFFERENT state does change it, or the check above would pass on a
# constant.
summary_none="$(telegram_summary_for 'telegram.bootstrap_token_rejected: no.' 'none')"
assert_ok 'the summary did not change with the state' test "$summary_a" != "$summary_none"

test_case 'the token-stored summary names no cause it cannot see'
telegram_stored_summary="$(sed -n '/INCOMPLETE_TOKEN_STORED$/,/^INCOMPLETE_TOKEN_STORED$/p' "${REPO}/deploy/install.sh")"
assert_contains 'the token-stored summary does not say the token was not changed' \
  "$telegram_stored_summary" 'was not changed by this run'
assert_contains 'the token-stored summary does not point at the error above' \
  "$telegram_stored_summary" 'the error printed above this summary'
# Every one of these was a cause-specific remedy in one of the six deleted
# heredocs, and each was false in at least one state reachable with it. The CLI
# says them now, where the cause is known: `bootstrapRemedy` carries the secrets
# ones and `BotBootstrapService` carries the rest.
for forbidden in 'BotFather' 'botctl secrets' 'DNS' 'certificate' 'Create a second bot'; do
  assert_not_contains "the token-stored summary still diagnoses a cause (${forbidden})" \
    "$telegram_stored_summary" "$forbidden"
done

test_case 'the installer no longer classifies a failure from captured CLI output'
# The rule, not a sentence. Every `case "$out"` arm that set `TELEGRAM_RETRY` was
# a cause the installer INFERRED rather than knew, and the interactive path is
# deliberately not captured, so none of them could run on a first install at a
# terminal. `TELEGRAM_RETRY` may now be assigned from `telegram_state` and
# nothing else.
# Two assignments and no more: the declaration at the top of the file, and the
# state read. Any third is a cause the installer inferred.
telegram_retry_writes="$(grep -c 'TELEGRAM_RETRY=' "${REPO}/deploy/install.sh")"
assert_equals 'TELEGRAM_RETRY is assigned somewhere other than its declaration and the state read' \
  '2' "$telegram_retry_writes"
assert_contains 'TELEGRAM_RETRY is not assigned from telegram_state' \
  "$(grep 'TELEGRAM_RETRY=' "${REPO}/deploy/install.sh")" 'telegram_state'
for inferred in 'already-bound' 'different-bot' 'token-rejected' 'token-unreadable'; do
  assert_not_contains "the installer still classifies a cause from CLI output (${inferred})" \
    "$(cat "${REPO}/deploy/install.sh")" "TELEGRAM_RETRY=\"${inferred}\""
done

test_case 'a first attempt that stored nothing outranks the error code'
# Order matters and is easy to get backwards. A rejected token on a FIRST
# attempt stored nothing, and "nothing was stored" is the whole story: the
# remedy is a token source, not a report about a credential that does not exist.
telegram_first_rejected="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test --bot-token-file "$2" >/dev/null 2>&1
  telegram_state() { printf "none"; }
  nexa_compose() { printf "telegram.bootstrap_token_rejected: Telegram refused it.\n"; return 1; }
  configure_telegram_bot 2>&1
  printf "RETRY=%s\n" "$TELEGRAM_RETRY"
' _ "${REPO}/deploy/install.sh" "${NEXA_ROOT}/unavailable-token" || printf 'THE_STEP_DIED')"
assert_contains 'a rejected token on a first attempt claimed a stored credential' \
  "$telegram_first_rejected" 'RETRY=none'

test_case 'skip-telegram does not prescribe registration for an UNAVAILABLE bot'
# `unavailable` was folded in with `incomplete` because both have a stored
# credential — but `execute` refuses BEFORE `setWebhook` until the availability
# problem is repaired, so `botctl telegram register` on its own cannot recover
# it. The same defect that was split out of `configure_telegram_bot`, left
# behind in the branch beside it.
telegram_skip_unavailable="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test --skip-telegram >/dev/null 2>&1
  telegram_state() { printf "unavailable"; }
  skip_telegram_bot 2>&1
' _ "${REPO}/deploy/install.sh" || true)"
assert_contains 'an unavailable skipped bot was not told what is holding it back' \
  "$telegram_skip_unavailable" 'other than registration'
assert_contains 'an unavailable skipped bot was not sent to status first' \
  "$telegram_skip_unavailable" 'botctl telegram status'
# The `incomplete` branch is the one that MAY name register on its own, and it
# must still do so — a refusal that refuses too much is the same defect.
telegram_skip_incomplete="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test --skip-telegram >/dev/null 2>&1
  telegram_state() { printf "incomplete"; }
  skip_telegram_bot 2>&1
' _ "${REPO}/deploy/install.sh" || true)"
assert_contains 'an incomplete skipped bot lost its one-command retry' \
  "$telegram_skip_incomplete" 'botctl telegram register'
assert_not_contains 'an incomplete skipped bot was given the unavailable remedy' \
  "$telegram_skip_incomplete" 'other than registration'

test_case 'skip-telegram survives a state that cannot be read'
# The refusal to guess is right; killing an install that explicitly opted out of
# Telegram because a Telegram CLI would not answer is not.
telegram_skip_unknown="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test --skip-telegram >/dev/null 2>&1
  telegram_state() { printf "docker: command not found"; }
  nexa_compose() { return 1; }
  configure_telegram_bot 2>&1
' _ "${REPO}/deploy/install.sh" || printf 'THE_STEP_DIED')"
assert_not_contains 'an unreadable state killed a skipped install' \
  "$telegram_skip_unknown" 'THE_STEP_DIED'
assert_contains 'the operator was not told the state is unknown' \
  "$telegram_skip_unknown" 'could not be read'

test_case 'a DIRECTORY as --bot-token-file is refused before the host is changed'
# `-r` and `-s` are both true of a directory — it is readable and its size is
# non-zero — so `/tmp` passed preflight, the entire deployment ran, and the
# redirection that finally reads it failed at the very end. The installer then
# recorded an incomplete release and reported that Telegram had rejected or
# could not be reached for a token it had never managed to read.
#
# The preflight's own guard is exercised, not a copy of it: the assertion below
# reads the refusal out of `install.sh`, and this runs it.
token_dir="${NEXA_ROOT}/token-as-directory"
mkdir -p "${token_dir}/not-empty"
directory_token="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test >/dev/null 2>&1
  BOT_TOKEN_FILE="$2"
  SKIP_TELEGRAM="no"
  if [ -f "$BOT_TOKEN_FILE" ]; then printf "ACCEPTED"; else printf "REFUSED"; fi
' _ "${REPO}/deploy/install.sh" "$token_dir" || true)"
assert_equals 'a directory passed the regular-file check' 'REFUSED' "$directory_token"
assert_contains 'the installer does not require a regular token file' \
  "$(grep -B 1 -A 1 'must be a regular file' "${REPO}/deploy/install.sh" || true)" \
  'BOT_TOKEN_FILE'
# And it is in PREFLIGHT, which is the whole point — a refusal after the install
# has changed the host is a different and much worse failure.
assert_contains 'the regular-file refusal is not in preflight' \
  "$(sed -n '/^preflight() {/,/^}/p' "${REPO}/deploy/install.sh")" \
  'must be a regular file'

test_case 'a relative --bot-token-file is refused before it becomes an empty volume'
# Handed to `docker run -v`, a bare name is a NAMED VOLUME rather than a path:
# the container receives an empty directory and the CLI fails reading it.
relative_token="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test --bot-token-file token.txt >/dev/null 2>&1
  BOT_TOKEN_FILE="token.txt"
  SKIP_TELEGRAM="no"
  case "$BOT_TOKEN_FILE" in
    /*) printf "ACCEPTED" ;;
    *) printf "REFUSED" ;;
  esac
' _ "${REPO}/deploy/install.sh" || true)"
assert_equals 'a relative token path was not refused' 'REFUSED' "$relative_token"
assert_contains 'the installer does not refuse a relative token path' \
  "$(grep -A 4 'bot-token-file must be an absolute path' "${REPO}/deploy/install.sh" || true)" \
  'named volume'

test_case 'a first configuration with no terminal and no token source is refused'
# The refusal that moved OUT of preflight, which could not know whether a token
# was needed. It belongs here, where the state is known — and `none` is the only
# state that needs one.
telegram_no_source="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test >/dev/null 2>&1
  telegram_state() { printf "none"; }
  nexa_compose() { printf "COMPOSE_RAN"; return 0; }
  configure_telegram_bot 2>&1
' _ "${REPO}/deploy/install.sh" || true)"
assert_contains 'a first configuration without a token source was not refused' \
  "$telegram_no_source" 'no safe way to read the Telegram'
assert_not_contains 'it ran the CLI anyway' "$telegram_no_source" 'COMPOSE_RAN'

test_case 'a RECONCILE with no terminal and no token source is NOT refused'
# The other half, and the reason the refusal had to move: on a rerun the row
# already carries the encrypted credential, so no token is needed and demanding
# one broke unattended recovery whenever the original file had been removed.
telegram_resume_no_source="$(bash -c '
  . "$1" --domain admin.example.test --acme-email ops@example.test >/dev/null 2>&1
  telegram_state() { printf "incomplete"; }
  nexa_compose() { printf "COMPOSE_RAN\n"; return 0; }
  configure_telegram_bot 2>&1
' _ "${REPO}/deploy/install.sh" || printf 'THE_STEP_DIED')"
assert_not_contains 'a reconcile without a token source was refused' \
  "$telegram_resume_no_source" 'THE_STEP_DIED'
assert_contains 'a reconcile without a token source never ran the CLI' \
  "$telegram_resume_no_source" 'COMPOSE_RAN'

# A live fixture root: the two cases below drive `botctl` itself rather than a
# sourced installer function, so they need the config, the lock file and the fake
# docker that `setup_root` creates. The Telegram cases above make their own
# directories and run after `teardown_root`, which is why this is here.
setup_root
setup_fake_docker

test_case 'telegram register takes the deployment lock'
# A registration is an external effect followed by a local one and the two
# cannot be atomic — `setWebhook` must happen outside the transaction that
# records it. So the ordering is protected from outside, and this is the only
# other writer: an installer changing the domain while this command is mid-flight
# can have Telegram accept the new URL and the database record the old one.
printf 'NEXA_DOMAIN=admin.example.test\n' >>"${NEXA_CONFIG_DIR}/deploy.env"
exec 9>>"$NEXA_LOCK_FILE"
flock -x 9
run_botctl telegram register
assert_fails 'telegram register ran while the lock was held' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the lock refusal was not explained' "$BOTCTL_OUTPUT" 'already running'
exec 9>&-

test_case 'telegram subcommands refuse an argument rather than dropping it'
# `botctl telegram register --tenant reseller` shifted the action off and
# discarded the rest, so `--tenant` never reached the CLI and the PRIMARY tenant
# was reconciled and reported as a success — walking straight past the CLI's own
# unknown-argument refusal at the installed entry point.
run_botctl telegram register --tenant reseller
assert_fails 'botctl telegram register accepted an argument it drops' test "$BOTCTL_STATUS" -eq 0
assert_contains 'botctl telegram register accepted an argument it drops' \
  "$BOTCTL_OUTPUT" 'takes no arguments'
run_botctl telegram status --tenant reseller
assert_fails 'botctl telegram status accepted an argument it drops' test "$BOTCTL_STATUS" -eq 0
assert_contains 'botctl telegram status accepted an argument it drops' \
  "$BOTCTL_OUTPUT" 'takes no arguments'
# The other half: the bare forms must still work, or the refusal refuses too
# much — the same defect from the other side.
run_botctl telegram status
assert_not_contains 'the bare status form was refused as if it had arguments' \
  "$BOTCTL_OUTPUT" 'takes no arguments'

test_case 'a token passed in argv is never echoed back by any refusal'
# THE security rule of this command, and it was broken by the refusal added to
# protect it: the arity check interpolated "$*" into its message, so
# `botctl telegram register --bot-token <token>` wrote the credential into the
# operator's terminal, the session's scrollback, and any CI or installer log
# capturing this stream.
#
# `bootstrap-bot.cli.ts` refuses argv tokens for exactly this reason. A refusal
# that reproduces what it refused is worse than the thing it refuses.
#
# Every shape an operator could plausibly reach it by, including the token as the
# SUBCOMMAND — which the first fix still echoed, because `$action` is an argv
# value too.
argv_token='8123456789:AA-a-real-looking-secret-half'
for argv_case in \
  "register --bot-token ${argv_token}" \
  "register ${argv_token}" \
  "status --bot-token ${argv_token}" \
  "${argv_token}" \
  "${argv_token} extra"; do
  # Unquoted on purpose: each case is a whole argument vector.
  # shellcheck disable=SC2086
  run_botctl telegram ${argv_case}
  assert_fails "botctl telegram ${argv_case%% *} accepted a token in argv" \
    test "$BOTCTL_STATUS" -eq 0
  assert_not_contains 'a bot token passed in argv was echoed back' \
    "$BOTCTL_OUTPUT" "$argv_token"
  # The secret half alone, in case a refusal ever splits or truncates the value.
  assert_not_contains 'the secret half of an argv token was echoed back' \
    "$BOTCTL_OUTPUT" 'AA-a-real-looking-secret-half'
done
# And the refusal still SAYS something useful — a fix that refuses silently would
# pass every assertion above and leave the operator with nothing.
run_botctl telegram register --bot-token "$argv_token"
assert_contains 'the refusal says nothing at all' "$BOTCTL_OUTPUT" 'takes no arguments'

test_case 'telegram status does NOT take the lock'
# It only reads, and a status command that blocks behind a running update is a
# status command nobody can use to find out why their update is slow.
run_botctl telegram status
assert_ok 'telegram status was refused' test "$BOTCTL_STATUS" -eq 0

teardown_root

test_case 'the token never reaches the bootstrap CLI as an argument'
# The rule stated as an observation over the installer's own source: every
# invocation passes `--bot-token-file` or nothing, and `--bot-token` appears
# nowhere. argv is readable by every user on the machine through `ps`.
# The WHOLE function body, not four lines after each `cli.js`. The `-v`, `-e`
# and `--rm` arguments sit BEFORE that line, so a forward-only window could not
# see `-e BOT_TOKEN=…` — which is the other half of the rule the comment states
# and the likelier regression of the two.
telegram_calls="$(sed -n '/^configure_telegram_bot() {/,/^}/p' "${REPO}/deploy/install.sh")"
assert_ok 'the configure_telegram_bot body could not be read; this check is vacuous' \
  test -n "$telegram_calls"
assert_not_contains 'the installer passes a bot token as an argument' \
  "$telegram_calls" '--bot-token '
assert_not_contains 'the installer passes a bot token through the environment' \
  "$telegram_calls" '-e BOT_TOKEN'
assert_not_contains 'the installer exports a bot token into the container environment' \
  "$telegram_calls" 'TELEGRAM_BOT_TOKEN='
assert_contains 'the unattended path does not stream the token on stdin' \
  "$telegram_calls" '--bot-token-stdin'
# A bind mount is how this was first written and it could not work: the image
# runs as `node` (uid 1000) and the documented token file is root-owned 0600, so
# the container gets EACCES.
assert_not_contains 'the installer bind-mounts the token file into the container' \
  "$telegram_calls" '/run/nexa-bot-token'

test_case 'the documented telegram status contract names every value the CLI can print'
# `OQ-TG-04` item 13. `docs/deployment.md` documented three values and the CLI
# has returned four since `unavailable` was added, so automation written from
# that section rejected a legitimate answer exactly when something had been
# disabled. Read from the TYPE rather than a hard-coded list here: a fifth value
# added to `BotBootstrapStatus` and not documented fails this, which is the whole
# point — the doc is a contract callers parse, not prose.
status_union="$(sed -n "s/^export type BotBootstrapStatus = //p" \
  "${REPO}/apps/api/src/modules/platform/tenancy/application/bot-bootstrap.service.ts")"
assert_ok 'the BotBootstrapStatus union could not be read; this check is vacuous' \
  test -n "$status_union"
status_line="$(grep -F 'botctl telegram status' "${REPO}/docs/deployment.md" | head -n 1)"
assert_ok 'the documented status line could not be found' test -n "$status_line"
for value in $(printf '%s' "$status_union" | tr -d "';" | tr '|' ' '); do
  assert_contains "docs/deployment.md does not document the status value ${value}" \
    "$status_line" "$value"
done
# And it says where the reason goes, because the reason is on stderr precisely so
# that `$(botctl telegram status)` keeps returning one word.
assert_contains 'docs/deployment.md does not say the reason is on stderr' \
  "$(cat "${REPO}/docs/deployment.md")" 'printed on stderr'

report
