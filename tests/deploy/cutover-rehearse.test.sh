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
assert_contains 'usage does not explain the tmux refusal' "$("$BOTCTL" help)" '--allow-foreground'

# =============================================================================
# A dropped SSH session (the incident: SIGHUP killed botctl, its EXIT trap deleted the
# scratch directory while the rehearsal container still read it, and the reconciliation
# failed on ENOENT). botctl runs here as the leader of its own process group — what a shell
# makes of a foreground job — so the hang-up can be delivered the way the kernel delivers it:
# to the whole group.

wait_for_file() {
  local i
  for ((i = 0; i < 200; i++)); do
    [ -e "$1" ] && return 0
    sleep 0.05
  done
  return 1
}

# Wait for botctl, but never for ever: a botctl that does not stop is a failure, not a hang.
wait_held() {
  local i
  for ((i = 0; i < 200; i++)); do
    kill -0 "$HELD_PID" 2>/dev/null || break
    sleep 0.05
  done
  if kill -0 "$HELD_PID" 2>/dev/null; then
    fail_test 'botctl did not exit within 10 seconds'
    kill -KILL -- "-${HELD_PID}" 2>/dev/null
    [ -z "${HELD_CHILD:-}" ] || kill -KILL "$HELD_CHILD" 2>/dev/null
    touch "${FAKE_DIR}/rehearse_release"
  fi
  HELD_STATUS=0
  wait "$HELD_PID" || HELD_STATUS=$?
}

start_held_rehearsal() {
  installation
  fake_set rehearse_hold 1
  setsid "$BOTCTL" cutover rehearse "${WORK}/final.nxpkg" --key-file "${WORK}/final.nxkey" \
    --owner-telegram-id 900000001 >"${WORK}/botctl.out" 2>&1 </dev/null &
  HELD_PID=$!
  wait_for_file "${FAKE_DIR}/rehearse_running" || fail_test 'the rehearsal never started'
  read -r HELD_CHILD HELD_CHILD_PGID <"${FAKE_DIR}/rehearse_running"
  HELD_MOUNT="$(cat "${FAKE_DIR}/rehearse_mount_path" 2>/dev/null)"
}

test_case 'cutover rehearse: a hang-up stops neither botctl nor the rehearsal, and removes nothing it reads'
start_held_rehearsal
assert_equals 'botctl is not the leader of its own process group' "$HELD_PID" \
  "$(ps -o pgid= -p "$HELD_PID" | tr -d ' ')"
assert_fails "the rehearsal runs in botctl's process group, where the hang-up reaches it" \
  test "$HELD_CHILD_PGID" = "$HELD_PID"
kill -HUP -- "-${HELD_PID}" 2>/dev/null # the kernel: the terminal's foreground group
kill -HUP "$HELD_PID" 2>/dev/null       # the login shell and sudo, relaying it
sleep 0.5
assert_ok 'botctl died of the hang-up' kill -0 "$HELD_PID"
assert_ok 'the rehearsal died of the hang-up' kill -0 "$HELD_CHILD"
assert_ok 'the package was removed while the rehearsal still read it' test -f "${HELD_MOUNT}/rehearsal.nxpkg"
touch "${FAKE_DIR}/rehearse_release"
wait_held
assert_equals 'the rehearsal did not complete after the hang-up' 0 "$HELD_STATUS"
assert_equals 'the rehearsal did not find its package after the hang-up' present \
  "$(cat "${FAKE_DIR}/rehearse_mount_after" 2>/dev/null)"
assert_contains 'the report was lost' "$(cat "${WORK}/botctl.out")" 'go/no-go: GO'
assert_fails 'the private directory was left behind after the run' test -e "$HELD_MOUNT"
teardown_root

test_case 'cutover rehearse: TERM stops the rehearsal, waits for it, and only then cleans up'
start_held_rehearsal
kill -TERM "$HELD_PID"
wait_held
assert_equals 'a stopped rehearsal did not exit 143' 143 "$HELD_STATUS"
assert_equals 'the package was gone before the rehearsal had stopped' present \
  "$(cat "${FAKE_DIR}/rehearse_mount_on_term" 2>/dev/null)"
assert_fails 'botctl exited while the rehearsal was still running' kill -0 "$HELD_CHILD"
assert_fails 'the private directory was left behind after a stop' test -e "$HELD_MOUNT"
assert_contains 'the stop was not reported' "$(cat "${WORK}/botctl.out")" 'did not complete (exit 143)'
teardown_root

# Any other signal that ends botctl (USR1 stands for them) runs the EXIT trap mid-run: it must
# stop the rehearsal and wait for it before it removes the package.
test_case 'cutover rehearse: dying of another signal mid-run still waits for the rehearsal before cleaning up'
start_held_rehearsal
kill -USR1 "$HELD_PID"
wait_held
assert_fails 'botctl survived USR1' test "$HELD_STATUS" -eq 0
assert_equals 'the package was gone before the rehearsal had stopped' present \
  "$(cat "${FAKE_DIR}/rehearse_mount_on_term" 2>/dev/null)"
assert_fails 'botctl exited while the rehearsal was still running' kill -0 "$HELD_CHILD"
assert_fails 'the private directory was left behind' test -e "$HELD_MOUNT"
teardown_root

# --- On a terminal: refused outside tmux/screen, unless --allow-foreground ----------------
#
# `script` gives botctl a real pseudo-terminal. TTY_ENV adds to its environment; TMUX and STY
# are cleared otherwise, so the suite means the same thing when it is itself run in tmux.
TTY_ENV=()
TTY_RUNNER="$(command -v script)"
tty_botctl() {
  local line
  line="$(printf '%q ' "$BOTCTL" "$@")"
  BOTCTL_OUTPUT="$(env -u TMUX -u STY SHELL=/bin/bash "${TTY_ENV[@]}" \
    "$TTY_RUNNER" -qec "$line" /dev/null </dev/null 2>&1)"
  BOTCTL_STATUS=$?
  BOTCTL_OUTPUT="$(printf '%s' "$BOTCTL_OUTPUT" | tr -d '\r')"
}
tty_rehearse() { tty_botctl cutover rehearse "${WORK}/final.nxpkg" --key-file "${WORK}/final.nxkey" --owner-telegram-id 900000001 "$@"; }

test_case 'cutover rehearse: on a terminal outside tmux it refuses, and prints the tmux line'
assert_ok 'script(1) is needed for the terminal tests' test -x "$TTY_RUNNER"
installation
reset_docker_log
tty_rehearse
assert_fails 'a rehearsal on a bare SSH terminal was started' test "$BOTCTL_STATUS" -eq 0
assert_contains 'the refusal does not give the tmux line' "$BOTCTL_OUTPUT" \
  "tmux new -s nexa-cutover-rehearse 'botctl cutover rehearse ${WORK}/final.nxpkg --key-file ${WORK}/final.nxkey --owner-telegram-id 900000001'"
assert_contains 'the refusal does not say how to reattach' "$BOTCTL_OUTPUT" 'tmux attach -t nexa-cutover-rehearse'
assert_equals 'a refused rehearsal still started a container' '' "$(rehearse_call)"
assert_fails 'a refused rehearsal left a private directory' test -e "$(cat "${FAKE_DIR}/rehearse_mount_path" 2>/dev/null || printf '/nonexistent')"

test_case 'cutover rehearse: --allow-foreground runs it here, with the output in a log file'
tty_rehearse --allow-foreground
assert_equals 'an allowed foreground rehearsal did not exit 0' 0 "$BOTCTL_STATUS"
assert_contains 'the report was not printed' "$BOTCTL_OUTPUT" 'go/no-go: GO'
assert_not_contains '--allow-foreground reached the rehearsal CLI' "$(rehearse_call)" 'allow-foreground'
log_file="$(find "${NEXA_ROOT}/var/log/nexa" -name 'botctl-cutover-rehearse-*.log' 2>/dev/null | sed -n 1p)"
assert_contains 'the log file is not named' "$BOTCTL_OUTPUT" "$log_file"
assert_contains 'the log file does not hold the report' "$(cat "$log_file" 2>/dev/null)" 'go/no-go: GO'
assert_file_mode 'the log file is not private' "$log_file" 600
assert_file_mode 'the log directory is not private' "${NEXA_ROOT}/var/log/nexa" 700

test_case 'cutover rehearse: inside tmux it runs without --allow-foreground'
TTY_ENV=(TMUX=/tmp/tmux-0/default,1,0)
tty_rehearse
assert_equals 'a rehearsal with TMUX set was refused' 0 "$BOTCTL_STATUS"
TTY_ENV=()
# sudo's env_reset strips TMUX and STY, so the terminal's owner is found by walking the
# process tree. A pseudo-terminal owned by a program called tmux stands in for tmux here.
ln -s "$TTY_RUNNER" "${FAKE_DIR}/tmux"
TTY_RUNNER="${FAKE_DIR}/tmux"
tty_rehearse
assert_equals 'a rehearsal on a terminal tmux owns was refused' 0 "$BOTCTL_STATUS"
assert_not_contains 'a rehearsal inside tmux wrote a foreground log' "$BOTCTL_OUTPUT" 'also written to'
TTY_RUNNER="$(command -v script)"
teardown_root

test_case 'the other long commands refuse on a bare terminal too; short ones do not'
installation
reset_docker_log
tty_botctl backup
assert_contains 'backup was not refused' "$BOTCTL_OUTPUT" "tmux new -s nexa-backup 'botctl backup'"
tty_botctl update v1.0.1
assert_contains 'update was not refused' "$BOTCTL_OUTPUT" "tmux new -s nexa-update 'botctl update v1.0.1'"
tty_botctl rollback
assert_contains 'rollback was not refused' "$BOTCTL_OUTPUT" "tmux new -s nexa-rollback 'botctl rollback'"
tty_botctl restore --target nexa_restore_test "${WORK}/final.nxpkg"
assert_contains 'restore was not refused' "$BOTCTL_OUTPUT" 'tmux new -s nexa-restore'
tty_botctl secrets rewrap
assert_contains 'secrets rewrap was not refused' "$BOTCTL_OUTPUT" "tmux new -s nexa-secrets-rewrap 'botctl secrets rewrap'"
assert_equals 'a refused long command still ran docker' '' "$(docker_log)"
assert_fails 'a refused long command took the lock' test -e "$NEXA_LOCK_FILE"
tty_botctl version
assert_not_contains 'a short command was refused' "$BOTCTL_OUTPUT" 'tmux new'
teardown_root

report
