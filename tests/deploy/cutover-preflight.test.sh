#!/usr/bin/env bash
# `botctl cutover preflight` — the MirzaBot -> Nexa cutover's read-only checklist
# (docs/cutover/). Driven against the same fake docker and temporary root as botctl.test.sh.
#
# Two things are asserted, and the second matters as much as the first:
#
#   - every check prints FAIL when its condition is broken, and the verdict and the exit code
#     follow — a check that cannot FAIL is a check that proves nothing;
#   - the command changes nothing: no `up`, `stop`, `restart`, no migration, no lock, and
#     nexa.env byte for byte as it was.

set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "${HERE}/../.." && pwd)"
# shellcheck source=harness.sh
. "${HERE}/harness.sh"

BOTCTL="${REPO}/deploy/bin/botctl"
export NEXA_LIB="${REPO}/deploy/bin/nexa-lib.sh"
DIGEST_A="sha256:$(printf 'a%.0s' {1..64})"

run_botctl() {
  BOTCTL_OUTPUT="$("$BOTCTL" "$@" 2>&1)"
  BOTCTL_STATUS=$?
  return 0
}

# A line from the backup CLI's `list`, started `$1` ago (a `date -d` phrase).
backup_line() {
  printf '%s  019600ab-cdef-7012-8345-6789abcde001  MANUAL  %s  %s  NOT_ATTEMPTED%s' \
    "$(date -u -d "$1" +%Y-%m-%dT%H:%M:%S.000Z)" "${2:-SUCCEEDED}" "${3:-verified}" "${4:-}"
}

# An installation in the state the cutover expects before the freeze: every role but the two
# background roles up and healthy, those two disabled and stopped, a backup an hour old,
# migrations current, no bot registered yet.
green_installation() {
  setup_root
  setup_fake_docker
  seed_release 'v1.0.0' "$DIGEST_A"
  fake_set compose_services 'api worker monitor provisioner recovery postgres redis caddy'
  printf 'NEXA_DISABLED_ROLES=monitor,provisioner\n' >>"${NEXA_CONFIG_DIR}/nexa.env"
  fake_set monitor_state absent
  fake_set provisioner_state absent
  fake_set backup_list "$(backup_line '1 hour ago')"
  fake_set migrate_check current
  fake_set owner_state none
  mkdir -p "${NEXA_ROOT}/var/lib/docker/volumes"
  fake_set docker_root_dir "${NEXA_ROOT}/var/lib/docker"
  setup_fake_df
}

# A fake `df`, so the disk line is decided by what a test says each filesystem holds rather
# than by the free space of whatever machine runs the suite. Every directory reads 100 GiB
# free; `df_small` names one that reads 1 MiB, `df_unreadable` one df cannot answer for.
# Each call is logged, so a test can see WHICH directories were measured.
setup_fake_df() {
  : >"${FAKE_DIR}/df.log"
  cat >"${FAKE_DIR}/bin/df" <<'FAKE'
#!/usr/bin/env bash
set -uo pipefail
read_state() { cat "${FAKE_DIR}/$1" 2>/dev/null || printf '%s' "$2"; }
dir="${*: -1}"
printf '%s\n' "$dir" >>"${FAKE_DIR}/df.log"
[ "$dir" != "$(read_state df_unreadable '')" ] || exit 1
avail=104857600
[ "$dir" != "$(read_state df_small '')" ] || avail=1024
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf 'fake 209715200 0 %s 1%% /\n' "$avail"
FAKE
  chmod +x "${FAKE_DIR}/bin/df"
  hash -r
}

preflight() { run_botctl cutover preflight --min-free-gib 0 "$@"; }

# The line a check printed, e.g. `check_line backup`.
check_line() { printf '%s\n' "$BOTCTL_OUTPUT" | awk -v c="$1" '$2 == c { print; exit }'; }

expect_fail() {
  # $1 check, $2 what the detail must say
  assert_equals "preflight passed with ${1} broken" 1 "$BOTCTL_STATUS"
  assert_contains "the ${1} line is not FAIL" "$(check_line "$1")" 'FAIL'
  assert_contains "the ${1} line does not say why" "$(check_line "$1")" "$2"
  assert_contains 'the verdict is not FAIL' "$BOTCTL_OUTPUT" 'preflight: FAIL (1 of 8 checks failed)'
}

printf 'botctl cutover preflight\n'

# =============================================================================
test_case 'cutover preflight: a ready installation passes every check'
green_installation
env_before="$(sha256sum "${NEXA_CONFIG_DIR}/nexa.env")"
deploy_before="$(sha256sum "${NEXA_CONFIG_DIR}/deploy.env")"
reset_docker_log
preflight --expect-version v1.0.0
assert_equals 'a ready installation failed the preflight' 0 "$BOTCTL_STATUS"
assert_contains 'the verdict is not PASS' "$BOTCTL_OUTPUT" 'preflight: PASS (8 checks)'
for check in release readiness recovery background-roles migrations backup disk telegram; do
  assert_contains "the ${check} line is not PASS" "$(check_line "$check")" 'PASS'
done
assert_contains 'the release line does not name the approved release' "$(check_line release)" 'v1.0.0 (the approved release)'

test_case 'cutover preflight: changes nothing — no up, stop, restart, migration, lock or edit'
log="$(docker_log)"
assert_not_contains 'the preflight ran compose up' "$log" ' up '
assert_not_contains 'the preflight stopped a container' "$log" ' stop '
assert_not_contains 'the preflight restarted a container' "$log" ' restart '
assert_not_contains 'the preflight ran a migration' "$(printf '%s\n' "$log" | grep 'migrate.js' | grep -v -- '--check')" 'migrate.js'
assert_contains 'the preflight did not ask for the migration check' "$log" 'migrate.js --check'
assert_contains 'the preflight did not read the backup list' "$log" 'backup.cli.js list'
assert_contains 'the preflight did not read the telegram state' "$log" 'bootstrap-bot.cli.js --status'
assert_equals 'the preflight edited nexa.env' "$env_before" "$(sha256sum "${NEXA_CONFIG_DIR}/nexa.env")"
assert_equals 'the preflight edited deploy.env' "$deploy_before" "$(sha256sum "${NEXA_CONFIG_DIR}/deploy.env")"
assert_fails 'the preflight took the installation lock' test -e "$NEXA_LOCK_FILE"
teardown_root

# =============================================================================
# Each check, broken one at a time: FAIL on its line, the verdict FAIL, exit 1.

test_case 'cutover preflight: release — not the approved version'
green_installation
preflight --expect-version v9.9.9
expect_fail release 'the approved release is v9.9.9'
teardown_root

test_case 'cutover preflight: release — the recorded release has no manifest'
green_installation
rm -f "${NEXA_STATE_DIR}/releases/v1.0.0.json"
preflight --expect-version v1.0.0
expect_fail release 'cannot be confirmed against source'
assert_contains 'the diagnostic was suppressed' "$BOTCTL_OUTPUT" 'no release manifest for v1.0.0'
assert_contains 'the diagnostic does not say how to settle it' "$BOTCTL_OUTPUT" "'botctl update v1.0.0' records one"
teardown_root

test_case 'cutover preflight: release — deploy.env would start another image'
green_installation
set_deploy_image "registry.test/nexa@sha256:$(printf 'f%.0s' {1..64})"
preflight
assert_contains 'a divergent release is not FAIL' "$(check_line release)" 'FAIL'
assert_equals 'preflight passed a divergent release' 1 "$BOTCTL_STATUS"
teardown_root

test_case 'cutover preflight: readiness — the api is unhealthy'
green_installation
fake_set api_health unhealthy
preflight
expect_fail readiness 'not ready'
teardown_root

test_case 'cutover preflight: recovery — the role is not running'
green_installation
fake_set recovery_state exited
preflight
# Readiness requires the recovery role too, so both lines fail; the recovery line says which.
assert_equals 'preflight passed with recovery stopped' 1 "$BOTCTL_STATUS"
assert_contains 'the recovery line is not FAIL' "$(check_line recovery)" 'FAIL'
assert_contains 'the recovery line does not say why' "$(check_line recovery)" 'not running'
teardown_root

test_case 'cutover preflight: recovery — the release defines none'
green_installation
fake_set compose_services 'api worker monitor provisioner postgres redis caddy'
preflight
expect_fail recovery 'defines no recovery role'
teardown_root

test_case 'cutover preflight: background roles — not disabled'
green_installation
grep -v '^NEXA_DISABLED_ROLES=' "${NEXA_CONFIG_DIR}/nexa.env" >"${NEXA_CONFIG_DIR}/nexa.env.new"
mv "${NEXA_CONFIG_DIR}/nexa.env.new" "${NEXA_CONFIG_DIR}/nexa.env"
printf 'NEXA_DISABLED_ROLES=monitor\n' >>"${NEXA_CONFIG_DIR}/nexa.env"
fake_set provisioner_state running
preflight
expect_fail background-roles 'provisioner is not disabled'
teardown_root

test_case 'cutover preflight: background roles — disabled but still running'
green_installation
fake_set monitor_state running
preflight
expect_fail background-roles 'monitor is running'
teardown_root

test_case 'cutover preflight: migrations — behind'
green_installation
fake_set migrate_check behind
fake_set migrate_check_exit 1
preflight
expect_fail migrations 'behind'
teardown_root

test_case 'cutover preflight: migrations — a word the check then failed is not a pass'
green_installation
fake_set migrate_check current
fake_set migrate_check_exit 1
preflight
expect_fail migrations 'current'
teardown_root

test_case 'cutover preflight: migrations — the check does not answer'
green_installation
fake_set migrate_check ''
fake_set migrate_check_exit 1
preflight
expect_fail migrations 'did not answer'
teardown_root

test_case 'cutover preflight: backup — older than the limit'
green_installation
fake_set backup_list "$(backup_line '30 hours ago')"
preflight
expect_fail backup 'limit 24h'
preflight --max-backup-age-hours 48
assert_contains 'a 30-hour backup under a 48-hour limit is not PASS' "$(check_line backup)" 'PASS'
teardown_root

test_case 'cutover preflight: backup — the newest runs are unverified, failed or not cleaned up'
green_installation
fake_set backup_list "$(backup_line '1 hour ago' SUCCEEDED unverified)
$(backup_line '2 hours ago' FAILED unverified)
$(backup_line '3 hours ago' SUCCEEDED verified '  CLEANUP-INCOMPLETE')"
preflight
expect_fail backup 'no SUCCEEDED, verified backup'
teardown_root

test_case 'cutover preflight: backup — no backup ever ran'
green_installation
fake_set backup_list 'No backup has ever run on this installation.'
preflight
expect_fail backup 'no SUCCEEDED, verified backup'
teardown_root

test_case 'cutover preflight: disk — less free than required'
green_installation
run_botctl cutover preflight --min-free-gib 100000000
expect_fail disk 'need 100000000 GiB'
teardown_root

test_case 'cutover preflight: disk — the Docker data root moved to another filesystem'
green_installation
rm -rf "${NEXA_ROOT}/var/lib/docker"
mkdir -p "${NEXA_ROOT}/mnt/docker-data/volumes"
fake_set docker_root_dir "${NEXA_ROOT}/mnt/docker-data"
preflight
assert_equals 'a moved data root failed the preflight' 0 "$BOTCTL_STATUS"
assert_contains 'the disk line does not name the moved root' "$(check_line disk)" "${NEXA_ROOT}/mnt/docker-data/volumes"
assert_contains 'the data root was not asked of the daemon' "$(docker_log)" "info --format {{.DockerRootDir}}"
# The moved root is what is measured: short there is a FAIL, whatever the state directory holds.
fake_set df_small "${NEXA_ROOT}/mnt/docker-data"
run_botctl cutover preflight --min-free-gib 1
expect_fail disk "${NEXA_ROOT}/mnt/docker-data has 0 GiB free"
teardown_root

test_case 'cutover preflight: disk — the volumes directory, on its own filesystem, is short'
green_installation
fake_set df_small "${NEXA_ROOT}/var/lib/docker/volumes"
run_botctl cutover preflight --min-free-gib 1
expect_fail disk "${NEXA_ROOT}/var/lib/docker/volumes has 0 GiB free"
teardown_root

test_case 'cutover preflight: disk — the daemon does not name its data root'
green_installation
fake_set info_exit 1
preflight
expect_fail disk "data root could not be determined"
fake_set info_exit 0
fake_set docker_root_dir ''
preflight
expect_fail disk "data root could not be determined"
teardown_root

test_case 'cutover preflight: disk — the data root the daemon names does not exist'
green_installation
fake_set docker_root_dir "${NEXA_ROOT}/srv/gone"
preflight
expect_fail disk "${NEXA_ROOT}/srv/gone does not exist"
teardown_root

test_case 'cutover preflight: disk — free space on the data root cannot be read'
green_installation
fake_set df_unreadable "${NEXA_ROOT}/var/lib/docker"
preflight
expect_fail disk "${NEXA_ROOT}/var/lib/docker free space unreadable"
teardown_root

test_case 'cutover preflight: telegram — a bot already receives updates before the handover'
green_installation
fake_set owner_state ready
preflight
expect_fail telegram 'ready, expected none'
preflight --expect-telegram ready
assert_equals 'after the handover, ready failed' 0 "$BOTCTL_STATUS"
fake_set owner_state none
preflight --expect-telegram ready
expect_fail telegram 'none, expected ready'
teardown_root

test_case 'cutover preflight: telegram — the state cannot be read'
green_installation
fake_set owner_state_exit 1
preflight
expect_fail telegram 'could not be read'
teardown_root

# =============================================================================
test_case 'cutover preflight: refuses an unknown argument without repeating it'
green_installation
run_botctl cutover preflight --bot-token 123456:SECRET-VALUE
assert_fails 'an unknown argument was accepted' test "$BOTCTL_STATUS" -eq 0
assert_not_contains 'the refusal repeated what was typed' "$BOTCTL_OUTPUT" 'SECRET-VALUE'
run_botctl cutover preflight --expect-telegram maybe
assert_fails 'an unknown telegram state was accepted' test "$BOTCTL_STATUS" -eq 0
run_botctl cutover preflight --max-backup-age-hours 2h
assert_fails 'a non-numeric age was accepted' test "$BOTCTL_STATUS" -eq 0
run_botctl cutover execute
assert_fails 'an unknown cutover subcommand was accepted' test "$BOTCTL_STATUS" -eq 0
teardown_root

test_case 'cutover preflight: usage lists the command'
assert_contains 'usage does not list cutover preflight' "$("$BOTCTL" help)" 'botctl cutover preflight'

report
