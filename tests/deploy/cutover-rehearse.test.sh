#!/usr/bin/env bash
# `botctl cutover rehearse` — the cutover runbook against a disposable database
# (docs/cutover/12-rehearsal.md). Driven against the same fake docker and temporary root as
# botctl.test.sh. The rehearsal itself (the refusals, the import, the reconciliation, the
# silence) is the application's and is tested there: tests/integration/cutover-rehearsal.test.ts.
# What is asserted here is botctl's half:
#
#   - it runs exactly the rehearsal CLI, in a one-off api container, with the package (and the
#     inventory) mounted read-only from a private directory it removes afterwards;
#   - the key reaches that container through its environment, never on a command line;
#   - the CLI's exit code (GO / GO_WITH_HELD / NO_GO) is botctl's;
#   - it changes nothing on the installation: no `up`, `stop`, `restart`, `exec`, migration,
#     lock, Telegram command or edit of nexa.env.

set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "${HERE}/../.." && pwd)"
# shellcheck source=harness.sh
. "${HERE}/harness.sh"

BOTCTL="${REPO}/deploy/bin/botctl"
export NEXA_LIB="${REPO}/deploy/bin/nexa-lib.sh"
DIGEST_A="sha256:$(printf 'a%.0s' {1..64})"
KEY_TEXT='NXPKG-KEY-V1:rehearsal-test-key-0123456789abcdef'

run_botctl() {
  BOTCTL_OUTPUT="$("$BOTCTL" "$@" 2>&1)"
  BOTCTL_STATUS=$?
  return 0
}

installation() {
  setup_root
  setup_fake_docker
  seed_release 'v1.0.0' "$DIGEST_A"
  WORK="${NEXA_ROOT}/operator"
  mkdir -p "$WORK"
  printf 'NXPKG package bytes\n' >"${WORK}/final.nxpkg"
  printf '%s' "$KEY_TEXT" >"${WORK}/final.nxkey"
  printf '{"rp1":[]}\n' >"${WORK}/inventory.json"
  chmod 0600 "${WORK}/final.nxpkg" "${WORK}/final.nxkey"
}

rehearse() { run_botctl cutover rehearse "${WORK}/final.nxpkg" "$@"; }

# The compose call that ran the rehearsal, as the docker log recorded it.
rehearse_call() { docker_log | sed -n '/cutover-rehearse\.cli\.js/{p;q}'; }

printf 'botctl cutover rehearse\n'

# =============================================================================
test_case 'cutover rehearse: runs the rehearsal CLI in a one-off api container'
installation
env_before="$(sha256sum "${NEXA_CONFIG_DIR}/nexa.env")"
deploy_before="$(sha256sum "${NEXA_CONFIG_DIR}/deploy.env")"
reset_docker_log
rehearse --key-file "${WORK}/final.nxkey" --owner-telegram-id 900000001
assert_equals 'a GO rehearsal did not exit 0' 0 "$BOTCTL_STATUS"
call="$(rehearse_call)"
assert_contains 'not a one-off container without dependencies' "$call" 'compose'
assert_contains 'not run --rm --no-deps -T' "$call" 'run --rm --no-deps -T'
assert_contains 'the key variable is not passed by name' "$call" '-e NEXA_REHEARSAL_PACKAGE_KEY'
assert_contains 'the package is not mounted read-only at /cutover' "$call" ':/cutover:ro'
assert_contains 'not the api image with node as entrypoint' "$call" '--entrypoint node api dist/cutover-rehearse.cli.js'
assert_contains 'the package path is not the mounted copy' "$call" '--package /cutover/rehearsal.nxpkg'
assert_contains 'the key is not named by its variable' "$call" '--package-key-env NEXA_REHEARSAL_PACKAGE_KEY'
assert_contains 'the owner id is not forwarded' "$call" '--owner-telegram-id 900000001'
assert_not_contains 'a database was named although none was asked for' "$call" '--database'
assert_not_contains 'the database is kept although that was not asked' "$call" '--keep-database'
assert_contains 'the report was not printed' "$BOTCTL_OUTPUT" 'go/no-go: GO'
assert_contains 'botctl does not say what the rehearsal never touches' "$BOTCTL_OUTPUT" 'never the live one'

test_case 'cutover rehearse: the key travels in the environment, never on a command line'
assert_not_contains 'the key text is on the docker command line' "$(docker_log)" "$KEY_TEXT"
assert_not_contains 'the key text was printed' "$BOTCTL_OUTPUT" "$KEY_TEXT"
assert_equals 'the container did not receive the key in its environment' "$KEY_TEXT" \
  "$(cat "${FAKE_DIR}/rehearse_secret" 2>/dev/null)"

test_case 'cutover rehearse: the package is copied into a private directory, then removed'
assert_equals 'the mounted directory did not hold exactly the package, read-only' \
  'rehearsal.nxpkg 400' "$(cat "${FAKE_DIR}/rehearse_mount" 2>/dev/null)"
assert_equals 'the mounted directory is not private' 700 "$(cat "${FAKE_DIR}/rehearse_mount_mode" 2>/dev/null)"
mount_path="$(cat "${FAKE_DIR}/rehearse_mount_path" 2>/dev/null)"
assert_fails 'the private directory was left behind' test -e "$mount_path"
assert_ok 'the operator package was moved or deleted' test -f "${WORK}/final.nxpkg"

test_case 'cutover rehearse: changes nothing on the installation'
log="$(docker_log)"
assert_not_contains 'the rehearsal ran compose up' "$log" ' up '
assert_not_contains 'the rehearsal stopped a container' "$log" ' stop '
assert_not_contains 'the rehearsal restarted a container' "$log" ' restart '
assert_not_contains 'the rehearsal ran a command in a running container' "$log" ' exec '
assert_not_contains 'the rehearsal migrated the live database' "$log" 'migrate.js'
assert_not_contains 'the rehearsal touched the Telegram registration' "$log" 'bootstrap-bot.cli.js'
assert_equals 'the rehearsal edited nexa.env' "$env_before" "$(sha256sum "${NEXA_CONFIG_DIR}/nexa.env")"
assert_equals 'the rehearsal edited deploy.env' "$deploy_before" "$(sha256sum "${NEXA_CONFIG_DIR}/deploy.env")"
assert_fails 'the rehearsal took the installation lock' test -e "$NEXA_LOCK_FILE"
teardown_root

# =============================================================================
test_case 'cutover rehearse: forwards the database, keep, inventory, json and the differences flag'
installation
reset_docker_log
rehearse --key-file "${WORK}/final.nxkey" --owner-telegram-id 900000001 \
  --database nexa_cutover_rehearsal_owner --keep-database \
  --panel-inventory "${WORK}/inventory.json" --json --list-differences
assert_equals 'the rehearsal failed' 0 "$BOTCTL_STATUS"
call="$(rehearse_call)"
assert_contains 'the database is not forwarded' "$call" '--database nexa_cutover_rehearsal_owner'
assert_contains 'keep is not forwarded' "$call" '--keep-database'
assert_contains 'the inventory is not the mounted copy' "$call" '--panel-inventory /cutover/inventory.json'
assert_contains 'json is not forwarded' "$call" '--json'
assert_contains 'list-differences is not forwarded' "$call" '--list-differences'
assert_equals 'the inventory was not mounted beside the package' \
  "$(printf 'inventory.json 400\nrehearsal.nxpkg 400')" "$(cat "${FAKE_DIR}/rehearse_mount" 2>/dev/null)"
teardown_root

# =============================================================================
test_case 'cutover rehearse: GO_WITH_HELD and NO_GO are botctl exit codes 2 and 3'
installation
fake_set rehearse_exit 2
fake_set rehearse_verdict GO_WITH_HELD
rehearse --key-file "${WORK}/final.nxkey" --owner-telegram-id 900000001
assert_equals 'GO_WITH_HELD was not exit 2' 2 "$BOTCTL_STATUS"
assert_contains 'the held classes are not called out' "$BOTCTL_OUTPUT" 'sign each held class off by name'
fake_set rehearse_exit 3
fake_set rehearse_verdict NO_GO
rehearse --key-file "${WORK}/final.nxkey" --owner-telegram-id 900000001
assert_equals 'NO_GO was not exit 3' 3 "$BOTCTL_STATUS"
assert_contains 'NO_GO does not say the installation is unchanged' "$BOTCTL_OUTPUT" 'nothing on the installation changed'
fake_set rehearse_exit 65
rehearse --key-file "${WORK}/final.nxkey" --owner-telegram-id 900000001
assert_equals 'a refused target was not relayed' 65 "$BOTCTL_STATUS"
teardown_root

# =============================================================================
test_case 'cutover rehearse: refuses before it runs anything'
installation
reset_docker_log
rehearse --owner-telegram-id 900000001
assert_fails 'a rehearsal without the key was accepted' test "$BOTCTL_STATUS" -eq 0
rehearse --key-file "${WORK}/final.nxkey" --passphrase --owner-telegram-id 900000001
assert_fails 'a key file AND a passphrase were accepted' test "$BOTCTL_STATUS" -eq 0
rehearse --key-file "${WORK}/final.nxkey"
assert_fails 'a rehearsal without the owner id was accepted' test "$BOTCTL_STATUS" -eq 0
rehearse --key-file "${WORK}/final.nxkey" --owner-telegram-id @owner
assert_fails 'a non-numeric owner id was accepted' test "$BOTCTL_STATUS" -eq 0
rehearse --key-file "${WORK}/final.nxkey" --owner-telegram-id 900000001 --database 'Nexa;drop'
assert_fails 'a database name that is not plain was accepted' test "$BOTCTL_STATUS" -eq 0
run_botctl cutover rehearse "${WORK}/missing.nxpkg" --key-file "${WORK}/final.nxkey" --owner-telegram-id 900000001
assert_fails 'a missing package was accepted' test "$BOTCTL_STATUS" -eq 0
rehearse --key-file "${WORK}/final.nxkey" --owner-telegram-id 900000001 --token "$KEY_TEXT"
assert_fails 'an unknown option was accepted' test "$BOTCTL_STATUS" -eq 0
assert_not_contains 'the refusal repeated what was typed' "$BOTCTL_OUTPUT" "$KEY_TEXT"
assert_equals 'a refused rehearsal still started a container' '' "$(rehearse_call)"
teardown_root

test_case 'cutover rehearse: usage lists the command'
assert_contains 'usage does not list cutover rehearse' "$("$BOTCTL" help)" 'botctl cutover rehearse PACKAGE'

report
