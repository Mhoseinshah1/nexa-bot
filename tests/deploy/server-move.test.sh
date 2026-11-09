#!/usr/bin/env bash
# `botctl move export|import|verify|abort` (Phase 6B PR-4, ADR-0039 § 8), against the fake
# docker of harness.sh: the freeze and its marker, the password on stdin only (asked twice,
# hidden, on a real pty), the bundle copied out through its SHA-256, the container's work
# directory removed on every exit, provisioner and monitor off before an import, and a
# frozen server refusing restart, update and rollback until `move abort`.

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

# botctl reads the password from /dev/tty: a pty answers each prompt (a line ending in ": ")
# once the terminal is silent, as a person typing would.
tty_botctl_answers() {
  local answers_file="${NEXA_ROOT}/tty-answers" out_file="${NEXA_ROOT}/tty-out"
  : >"$answers_file"
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
    printf '%s\n' "$1" >>"$answers_file"
    shift
  done
  shift
  python3 - "$answers_file" "$out_file" "$BOTCTL" "$@" <<'PTY'
import os, pty, select, sys, termios, time
answers = open(sys.argv[1], encoding="utf-8").read().splitlines()
out_path, argv = sys.argv[2], sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(argv[0], argv)
buf = b""
typed = 0
while True:
    ready, _, _ = select.select([fd], [], [], 60)
    if not ready:
        os.kill(pid, 9)
        break
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    buf += chunk
    prompts = buf.count(b": ")
    while typed < min(prompts, len(answers)):
        deadline = time.time() + 10
        while time.time() < deadline and termios.tcgetattr(fd)[3] & termios.ECHO:
            time.sleep(0.01)
        os.write(fd, (answers[typed] + "\n").encode())
        typed += 1
_, status = os.waitpid(pid, 0)
open(out_path, "wb").write(buf)
sys.exit(os.waitstatus_to_exitcode(status))
PTY
  BOTCTL_STATUS=$?
  BOTCTL_OUTPUT="$(cat "$out_file" 2>/dev/null)"
  return 0
}

printf 'botctl move\n'

PW='move-bundle-password-77'
OUT=""

fresh() {
  setup_root
  setup_fake_docker
  seed_release "vA" "$DIGEST_A"
  seed_nexa_env canonical
  OUT="${NEXA_ROOT}/out/nexa-move.7z"
  mkdir -p "${NEXA_ROOT}/out"
}

fresh

test_case "move export freezes, passes the password on stdin only, and writes the verified bundle"
reset_docker_log
tty_botctl_answers "$PW" "$PW" -- move export --out "$OUT" --allow-foreground
assert_equals "move export failed: ${BOTCTL_OUTPUT}" 0 "$BOTCTL_STATUS"
assert_contains "the roles were not stopped (the freeze)" "$(docker_log)" "stop api worker monitor recovery"
assert_not_contains "the freeze stopped a data store" "$(docker_log)" "stop api worker monitor recovery postgres"
assert_equals "the freeze marker does not name what was stopped" \
  "api worker monitor recovery" "$(cat "${NEXA_CONFIG_DIR}/move-frozen" 2>/dev/null)"
assert_contains "the export CLI was not run" "$(docker_log)" "dist/move.cli.js export --password-stdin"
assert_equals "the container did not receive the password on stdin" \
  "$PW" "$(cat "${FAKE_DIR}/move_password_stdin" 2>/dev/null)"
assert_not_contains "the password is in a compose argv" "$(docker_log)" "$PW"
assert_not_contains "the password was echoed" "$BOTCTL_OUTPUT" "$PW"
assert_equals "the bundle is not the bytes the export sealed" "FAKEBUNDLE" "$(cat "$OUT" 2>/dev/null)"
assert_file_mode "the bundle is readable by others" "$OUT" 600
assert_fails "a .partial file was left behind" test -e "${OUT}.partial"
assert_contains "the container's work directory was not removed" \
  "$(cat "${FAKE_DIR}/move_removed" 2>/dev/null)" "/var/lib/nexa/backups/.cli-move-fake1"
assert_contains "the next steps are not printed in Persian" "$BOTCTL_OUTPUT" "sudo botctl move import /root/nexa-move.7z"
assert_contains "the size is not printed" "$BOTCTL_OUTPUT" "اندازه"
assert_contains "the freeze is not said" "$BOTCTL_OUTPUT" "منجمد"

test_case "a frozen server refuses restart, update and rollback"
run_botctl restart
assert_fails "a frozen server restarted" test "$BOTCTL_STATUS" -eq 0
assert_contains "the refusal does not name move abort" "$BOTCTL_OUTPUT" "botctl move abort"
run_botctl update v9.9.9
assert_fails "a frozen server updated" test "$BOTCTL_STATUS" -eq 0
assert_contains "update was not refused for the freeze" "$BOTCTL_OUTPUT" "FROZEN"
run_botctl rollback --allow-foreground </dev/null
assert_fails "a frozen server rolled back" test "$BOTCTL_STATUS" -eq 0
assert_contains "rollback was not refused for the freeze" "$BOTCTL_OUTPUT" "FROZEN"

test_case "move abort starts exactly what the freeze stopped and lifts the marker"
reset_docker_log
run_botctl move abort
assert_equals "move abort failed: ${BOTCTL_OUTPUT}" 0 "$BOTCTL_STATUS"
assert_contains "the stopped roles were not started" "$(docker_log)" "start api worker monitor recovery"
assert_fails "the marker survived the abort" test -e "${NEXA_CONFIG_DIR}/move-frozen"
run_botctl move abort
assert_fails "abort on a server that is not frozen succeeded" test "$BOTCTL_STATUS" -eq 0
teardown_root

fresh
test_case "move export refuses different or short passwords and starts nothing"
reset_docker_log
tty_botctl_answers "first-password-123" "second-password-123" -- move export --out "$OUT" --allow-foreground
assert_fails "different passwords were accepted" test "$BOTCTL_STATUS" -eq 0
assert_contains "the mismatch was not said in Persian" "$BOTCTL_OUTPUT" "یکسان نیستند"
assert_not_contains "the export ran on a mismatch" "$(docker_log)" "move.cli.js"
assert_not_contains "the server was frozen on a mismatch" "$(docker_log)" " stop "
assert_fails "a marker was written on a mismatch" test -e "${NEXA_CONFIG_DIR}/move-frozen"
tty_botctl_answers "short" "short" -- move export --out "$OUT" --allow-foreground
assert_fails "a short password was accepted" test "$BOTCTL_STATUS" -eq 0
assert_contains "the length rule was not said" "$BOTCTL_OUTPUT" "۱۲"
assert_not_contains "the export ran with a short password" "$(docker_log)" "move.cli.js"

test_case "move export refuses an existing output and a missing --out before anything"
: >"$OUT"
run_botctl move export --out "$OUT" --allow-foreground </dev/null
assert_fails "an existing output was overwritten" test "$BOTCTL_STATUS" -eq 0
rm -f "$OUT"
run_botctl move export --allow-foreground </dev/null
assert_fails "move export ran without --out" test "$BOTCTL_STATUS" -eq 0
assert_not_contains "something was stopped" "$(docker_log)" " stop "

test_case "a failed export writes no file, keeps the server frozen and says how to go back"
fake_set move_export_exit 1
reset_docker_log
tty_botctl_answers "$PW" "$PW" -- move export --out "$OUT" --allow-foreground
assert_fails "a failed export exited zero" test "$BOTCTL_STATUS" -eq 0
assert_fails "a failed export wrote the bundle" test -e "$OUT"
assert_fails "a failed export left a .partial" test -e "${OUT}.partial"
assert_contains "a failed export did not keep the freeze" "$(cat "${NEXA_CONFIG_DIR}/move-frozen" 2>/dev/null)" "api"
assert_contains "the way back is not named" "$BOTCTL_OUTPUT" "move abort"
fake_set move_export_exit 0

test_case "a bundle whose copy does not hash to the sealed SHA-256 is refused"
fake_set move_bundle_reported OTHERBYTES
reset_docker_log
tty_botctl_answers "$PW" "$PW" -- move export --out "$OUT" --allow-foreground
assert_fails "a mismatching copy was accepted" test "$BOTCTL_STATUS" -eq 0
assert_fails "a mismatching copy was kept" test -e "$OUT"
assert_fails "a mismatching copy left a .partial" test -e "${OUT}.partial"
assert_contains "the work directory was not removed after the refusal" \
  "$(cat "${FAKE_DIR}/move_removed" 2>/dev/null)" ".cli-move-fake1"
fake_set move_bundle_reported FAKEBUNDLE
teardown_root

fresh
test_case "move import switches provisioner and monitor off first, then restores, then verifies"
printf 'BUNDLEBYTES' >"${NEXA_ROOT}/bundle.7z"
reset_docker_log
tty_botctl_answers "$PW" -- move import "${NEXA_ROOT}/bundle.7z" --allow-foreground
assert_equals "move import failed: ${BOTCTL_OUTPUT}" 0 "$BOTCTL_STATUS"
log="$(docker_log)"
assert_contains "provisioner and monitor were not disabled" \
  "$(cat "${NEXA_CONFIG_DIR}/nexa.env")" "NEXA_DISABLED_ROLES=monitor,provisioner"
stop_at="$(grep -n 'stop ' <<<"$log" | head -n1 | cut -d: -f1)"
restore_at="$(grep -n 'import-installation' <<<"$log" | head -n1 | cut -d: -f1)"
hosted_at="$(grep -n 'import-hosted' <<<"$log" | head -n1 | cut -d: -f1)"
assert_ok "the roles were not stopped before the restore" test "${stop_at:-999}" -lt "${restore_at:-0}"
assert_ok "the hosted bots were verified before the installation was restored" \
  test "${restore_at:-999}" -lt "${hosted_at:-0}"
assert_equals "the bundle did not reach the container intact" "BUNDLEBYTES" \
  "$(cat "${FAKE_DIR}/move_bundle_in" 2>/dev/null)"
assert_equals "the restore did not get the password on stdin" "$PW" \
  "$(cat "${FAKE_DIR}/move_import_password" 2>/dev/null)"
assert_equals "the hosted step did not get the password on stdin" "$PW" \
  "$(cat "${FAKE_DIR}/move_hosted_password" 2>/dev/null)"
assert_not_contains "the password is in a compose argv" "$log" "$PW"
assert_contains "the workspace was not handed over" "$log" "--workspace /var/lib/nexa/backups/.cli-move-fake2"
assert_contains "the hosted step was not given the owner's domain" "$log" \
  "import-hosted --workspace /var/lib/nexa/backups/.cli-move-fake2 --password-stdin --domain admin.example.test"
assert_contains "the checklist was not printed" "$BOTCTL_OUTPUT" "CHECKLIST-FA"
assert_contains "the work directory was not removed" \
  "$(cat "${FAKE_DIR}/move_removed" 2>/dev/null)" ".cli-move-fake2"

test_case "a failed installation restore stops before the hosted bots, roles still off"
fake_set move_import_exit 1
reset_docker_log
: >"${FAKE_DIR}/move_removed"
tty_botctl_answers "$PW" -- move import "${NEXA_ROOT}/bundle.7z" --allow-foreground
assert_fails "a failed restore exited zero" test "$BOTCTL_STATUS" -eq 0
assert_not_contains "the hosted step ran after a failed restore" "$(docker_log)" "import-hosted"
assert_contains "the failure does not say the roles stayed off" "$BOTCTL_OUTPUT" "خاموش ماندند"
assert_contains "the work directory was not removed on failure" \
  "$(cat "${FAKE_DIR}/move_removed" 2>/dev/null)" ".cli-move-fake2"
fake_set move_import_exit 0

test_case "a hosted mismatch fails the import"
fake_set move_hosted_exit 1
tty_botctl_answers "$PW" -- move import "${NEXA_ROOT}/bundle.7z" --allow-foreground
assert_fails "a hosted mismatch exited zero" test "$BOTCTL_STATUS" -eq 0
fake_set move_hosted_exit 0

test_case "move import refuses on the frozen old server and without a file"
printf 'api\n' >"${NEXA_CONFIG_DIR}/move-frozen"
reset_docker_log
run_botctl move import "${NEXA_ROOT}/bundle.7z" --allow-foreground </dev/null
assert_fails "an import ran on a frozen server" test "$BOTCTL_STATUS" -eq 0
assert_not_contains "something ran" "$(docker_log)" "move.cli.js"
rm -f "${NEXA_CONFIG_DIR}/move-frozen"
run_botctl move import "${NEXA_ROOT}/missing.7z" --allow-foreground </dev/null
assert_fails "an import ran without its file" test "$BOTCTL_STATUS" -eq 0

test_case "move verify passes the domain and reports the CLI's verdict"
reset_docker_log
run_botctl move verify
assert_equals "move verify failed" 0 "$BOTCTL_STATUS"
assert_contains "verify did not name the owner's domain" "$(docker_log)" "dist/move.cli.js verify --domain admin.example.test"
assert_contains "the table was not printed" "$BOTCTL_OUTPUT" "VERIFY-TABLE"
fake_set move_verify_exit 2
run_botctl move verify
assert_equals "a not-ready verify exited zero" 2 "$BOTCTL_STATUS"
fake_set move_verify_exit 0

test_case "move with no action prints its usage"
run_botctl move
assert_fails "a bare move succeeded" test "$BOTCTL_STATUS" -eq 0
assert_contains "the usage does not name export" "$BOTCTL_OUTPUT" "export --out FILE"
teardown_root

report
