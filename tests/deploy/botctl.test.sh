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
    -u NEXA_LIB -u NEXA_IMAGE \
    SUDO_USER=someone "$var=$value" "$BOTCTL" version 2>&1 || true
}
sudo_output="$(sudo_botctl NEXA_LIB "${NEXA_ROOT}/evil-lib.sh")"
assert_not_contains 'a sudo invocation loaded a caller-supplied library' "$sudo_output" 'pwned'
assert_contains 'the refusal did not name NEXA_LIB' "$sudo_output" 'NEXA_LIB is set in the environment'
sudo_output="$(sudo_botctl NEXA_IMAGE_REPO evil.example/nexa)"
assert_contains 'a sudo invocation chose the registry' \
  "$sudo_output" 'NEXA_IMAGE_REPO is set in the environment'

test_case 'a direct root invocation is unaffected'
# The refusal is keyed on SUDO_USER, which is present exactly in the delegated
# case. An operator with a root shell, and this suite, must still work — this
# fixture has no release, so `version` fails, but it must fail for THAT reason.
run_botctl version
assert_not_contains 'a direct invocation hit the sudo refusal' \
  "$BOTCTL_OUTPUT" 'set in the environment'
assert_contains 'a direct invocation failed for the wrong reason' \
  "$BOTCTL_OUTPUT" 'no current release is recorded'

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
  PATH="${NEXA_ROOT}/stub:${PATH}"
  nexa_set_deploy_image "registry.test/nexa@${DIGEST_B}"
) >/dev/null 2>&1 && fail_test 'a failed read reported success'
assert_equals 'deploy.env was rewritten from a failed read' "$before" "$(cat "$env_file")"
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
rm -f "${NEXA_STATE_DIR}/current"

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
printf 'SECRETS_KEK=k\nSECRETS_KEK_ID=i\nDATABASE_URL=d\nREDIS_URL=r\n' >"${NEXA_CONFIG_DIR}/nexa.env"
probe="$(secrets_probe || true)"
assert_not_contains 'a postgres.env with no password was accepted as complete' \
  "$probe" 'secrets already exist'
assert_contains 'the operator was not told the configuration is incomplete' \
  "$probe" 'incomplete'

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
assert_contains 'the repair was not reported' "$BOTCTL_OUTPUT" 'repaired deploy.env'
run_botctl version
assert_equals 'the divergence survived' 0 "$BOTCTL_STATUS"

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

report
