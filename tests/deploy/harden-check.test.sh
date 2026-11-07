#!/usr/bin/env bash
# `botctl harden check` (Phase 6A D0) — the read-only host review. Driven against fixture
# files under NEXA_HOST_ROOT and fake `ufw` / `ss`, never the machine running the suite.
#
# Asserted for every item: it prints WARN when its condition is broken and PASS when it is
# not (a check that cannot WARN proves nothing); the exit code stays 0 either way; and the
# command changes nothing — no docker call, no lock, every file byte for byte as it was.
#
# Also here: `botctl backup offsite test`, the off-site copy's test upload, which reaches the
# backup CLI and nothing else.
#
# shellcheck shell=bash

set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "${HERE}/../.." && pwd)"
# shellcheck source=harness.sh
. "${HERE}/harness.sh"

BOTCTL="${REPO}/deploy/bin/botctl"
export NEXA_LIB="${REPO}/deploy/bin/nexa-lib.sh"

run_botctl() {
  BOTCTL_OUTPUT="$("$BOTCTL" "$@" 2>&1)"
  BOTCTL_STATUS=$?
  return 0
}

# The line an item printed, e.g. `item_line ssh-password`.
item_line() { printf '%s\n' "$BOTCTL_OUTPUT" | awk -v c="$1" '$2 == c { print; exit }'; }

expect_item() {
  # $1 PASS|WARN, $2 item, $3 what the line must say (optional)
  local line
  line="$(item_line "$2")"
  assert_equals "the ${2} line" "$1" "${line%% *}"
  [ -z "${3:-}" ] || assert_contains "the ${2} line does not say why" "$line" "$3"
  assert_equals "harden check exited non-zero with ${2} ${1}" 0 "$BOTCTL_STATUS"
}

# A host in the state the owner is asked for: key-only SSH, no root login, ufw active with
# 80/443/22, nothing else listening publicly, the docker socket root-only, /etc/nexa 0600 and
# unattended upgrades on.
green_host() {
  setup_root
  setup_fake_docker
  export NEXA_HOST_ROOT="${NEXA_ROOT}/host"
  local h="$NEXA_HOST_ROOT"
  mkdir -p "$h/etc/ssh/sshd_config.d" "$h/var/run" "$h/etc/docker" "$h/etc/apt/apt.conf.d" \
    "$h/usr/bin" "$h/etc/systemd/system" "$h/lib/systemd/system"
  cat >"$h/etc/ssh/sshd_config" <<'EOF'
# Ubuntu's own shape: the drop-ins first, so THEIR values win (first match wins).
Include /etc/ssh/sshd_config.d/*.conf
Port 22
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
EOF
  : >"$h/etc/ssh/sshd_config.d/10-empty.conf"
  : >"$h/var/run/docker.sock"
  chmod 0660 "$h/var/run/docker.sock"
  printf '%s:x:999:\n' "$(stat -c '%G' "$h/var/run/docker.sock")" >"$h/etc/group"
  printf '{ "log-driver": "json-file" }\n' >"$h/etc/docker/daemon.json"
  printf '[Service]\nExecStart=/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock\n' \
    >"$h/lib/systemd/system/docker.service"
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
    >"$h/etc/apt/apt.conf.d/20auto-upgrades"
  printf '#!/bin/sh\n' >"$h/usr/bin/unattended-upgrade"
  chmod +x "$h/usr/bin/unattended-upgrade"
  find "$NEXA_CONFIG_DIR" -type f -exec chmod 0600 {} +
  chmod 0700 "$NEXA_CONFIG_DIR"
  printf 'services:\n  api:\n    image: x\n' >"${NEXA_DEPLOY_DIR}/compose.yml"

  fake_set ufw_status "$(printf 'Status: active\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW       Anywhere\n80,443/tcp                 ALLOW       Anywhere\n22/tcp (v6)                ALLOW       Anywhere (v6)\n')"
  fake_set ss_listen "$(printf 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:443 0.0.0.0:*\nLISTEN 0 4096 [::]:80 [::]:*\nLISTEN 0 244 127.0.0.1:5432 0.0.0.0:*\nLISTEN 0 4096 127.0.0.53%%lo:53 0.0.0.0:*\n')"
  cat >"${FAKE_DIR}/bin/ufw" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "ufw $*" >>"${FAKE_DIR}/host.log"
[ "${1:-}" = status ] || exit 1
cat "${FAKE_DIR}/ufw_status"
FAKE
  cat >"${FAKE_DIR}/bin/ss" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "ss $*" >>"${FAKE_DIR}/host.log"
cat "${FAKE_DIR}/ss_listen"
FAKE
  chmod +x "${FAKE_DIR}/bin/ufw" "${FAKE_DIR}/bin/ss"
  hash -r
}

host_digest() { find "$NEXA_ROOT" -path "$FAKE_DIR" -prune -o -type f -print0 | sort -z | xargs -0 sha256sum; }

printf 'botctl harden check\n'

# =============================================================================
test_case 'harden check: a hardened host passes every item, in Persian, and exits 0'
green_host
before="$(host_digest)"
reset_docker_log
run_botctl harden check
assert_equals 'harden check exited non-zero' 0 "$BOTCTL_STATUS"
for item in ssh-password ssh-root firewall open-ports docker-socket config-modes upgrades; do
  expect_item PASS "$item"
done
assert_contains 'the summary is missing' "$BOTCTL_OUTPUT" 'harden: 7 PASS, 0 WARN'
assert_contains 'the header does not say it only reads' "$BOTCTL_OUTPUT" 'فقط خوانده می‌شود'

test_case 'harden check: changes nothing — no docker call, no lock, no file touched'
assert_equals 'harden check called docker' '' "$(docker_log)"
assert_fails 'harden check took the installation lock' test -e "$NEXA_LOCK_FILE"
assert_equals 'harden check changed a file' "$before" "$(host_digest)"
assert_not_contains 'harden check asked ufw to change something' "$(cat "${FAKE_DIR}/host.log")" 'ufw enable'
assert_equals 'harden check ran something other than ufw status / ss' \
  'ss -Hltn|ss -Hltn|ufw status' "$(sort "${FAKE_DIR}/host.log" | paste -sd'|')"
teardown_root

# =============================================================================
test_case 'harden check: a cloud-init drop-in that enables password login wins (first match)'
green_host
printf 'PasswordAuthentication yes\n' >"${NEXA_HOST_ROOT}/etc/ssh/sshd_config.d/50-cloud-init.conf"
run_botctl harden check
expect_item WARN ssh-password 'PasswordAuthentication yes'
expect_item PASS ssh-root
assert_contains 'the summary does not count the WARN' "$BOTCTL_OUTPUT" 'harden: 6 PASS, 1 WARN'
teardown_root

test_case 'harden check: password login is the default when nothing sets it'
green_host
sed -i '/^PasswordAuthentication/d' "${NEXA_HOST_ROOT}/etc/ssh/sshd_config"
run_botctl harden check
expect_item WARN ssh-password 'PasswordAuthentication yes'
teardown_root

test_case 'harden check: keyboard-interactive still takes a password through PAM'
green_host
sed -i 's/^KbdInteractiveAuthentication no/KbdInteractiveAuthentication yes/' "${NEXA_HOST_ROOT}/etc/ssh/sshd_config"
run_botctl harden check
expect_item WARN ssh-password 'KbdInteractiveAuthentication'
teardown_root

test_case 'harden check: root login — the default, yes, and a Match block that does not count'
green_host
sed -i '/^PermitRootLogin/d' "${NEXA_HOST_ROOT}/etc/ssh/sshd_config"
run_botctl harden check
expect_item WARN ssh-root 'prohibit-password'
printf 'PermitRootLogin=yes\n' >>"${NEXA_HOST_ROOT}/etc/ssh/sshd_config.d/10-empty.conf"
run_botctl harden check
expect_item WARN ssh-root 'PermitRootLogin yes'
printf 'PermitRootLogin no\n' >"${NEXA_HOST_ROOT}/etc/ssh/sshd_config.d/10-empty.conf"
printf 'Match User deploy\n  PermitRootLogin yes\n  PasswordAuthentication yes\n' >>"${NEXA_HOST_ROOT}/etc/ssh/sshd_config"
run_botctl harden check
expect_item PASS ssh-root
expect_item PASS ssh-password
teardown_root

test_case 'harden check: no sshd_config is a WARN, not a crash'
green_host
rm "${NEXA_HOST_ROOT}/etc/ssh/sshd_config"
run_botctl harden check
expect_item WARN ssh-password 'خوانده نشد'
expect_item WARN ssh-root
teardown_root

# =============================================================================
test_case 'harden check: ufw inactive, or allowing more than 80/443/SSH'
green_host
fake_set ufw_status 'Status: inactive'
run_botctl harden check
expect_item WARN firewall 'خاموش'
fake_set ufw_status "$(printf 'Status: active\n\n22/tcp ALLOW Anywhere\n80,443/tcp ALLOW Anywhere\n3306/tcp ALLOW Anywhere\n')"
run_botctl harden check
expect_item WARN firewall '3306'
teardown_root

test_case 'harden check: a moved SSH port is the SSH port'
green_host
sed -i 's/^Port 22/Port 2222/' "${NEXA_HOST_ROOT}/etc/ssh/sshd_config"
fake_set ufw_status "$(printf 'Status: active\n\n2222/tcp ALLOW Anywhere\n80/tcp ALLOW Anywhere\n443 ALLOW Anywhere\n')"
fake_set ss_listen "$(printf 'LISTEN 0 4096 0.0.0.0:2222 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:443 0.0.0.0:*\n')"
run_botctl harden check
expect_item PASS firewall '2222'
expect_item PASS open-ports
fake_set ss_listen "$(printf 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\n')"
run_botctl harden check
expect_item WARN open-ports '22'
teardown_root

test_case 'harden check: a port Docker published around ufw is a WARN; loopback is not'
green_host
fake_set ss_listen "$(printf 'LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:5432 0.0.0.0:*\nLISTEN 0 4096 [::]:6379 [::]:*\n')"
run_botctl harden check
expect_item WARN open-ports '5432، 6379'
expect_item PASS firewall
teardown_root

# =============================================================================
test_case 'harden check: a world-writable docker socket'
green_host
chmod 0666 "${NEXA_HOST_ROOT}/var/run/docker.sock"
run_botctl harden check
expect_item WARN docker-socket '666'
teardown_root

test_case 'harden check: a docker group with members is root by another name'
green_host
printf '%s:x:999:ubuntu,ci\n' "$(stat -c '%G' "${NEXA_HOST_ROOT}/var/run/docker.sock")" >"${NEXA_HOST_ROOT}/etc/group"
run_botctl harden check
expect_item WARN docker-socket 'ubuntu، ci'
teardown_root

test_case 'harden check: the docker daemon on TCP, from daemon.json, a drop-in or a listener'
green_host
printf '{ "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2375"] }\n' >"${NEXA_HOST_ROOT}/etc/docker/daemon.json"
run_botctl harden check
expect_item WARN docker-socket 'TCP'
teardown_root
green_host
mkdir -p "${NEXA_HOST_ROOT}/etc/systemd/system/docker.service.d"
printf '[Service]\nExecStart=\nExecStart=/usr/bin/dockerd -H tcp://0.0.0.0:2376\n' \
  >"${NEXA_HOST_ROOT}/etc/systemd/system/docker.service.d/override.conf"
run_botctl harden check
expect_item WARN docker-socket 'override.conf'
teardown_root
green_host
fake_set ss_listen "$(printf 'LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:2375 0.0.0.0:*\n')"
run_botctl harden check
expect_item WARN docker-socket '2375'
teardown_root

test_case 'harden check: the docker socket mounted into an application container'
green_host
printf 'services:\n  api:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n' >"${NEXA_DEPLOY_DIR}/compose.yml"
run_botctl harden check
expect_item WARN docker-socket 'compose.yml'
teardown_root

# =============================================================================
test_case 'harden check: a secret file group- or world-readable, named but never shown'
green_host
chmod 0644 "${NEXA_CONFIG_DIR}/postgres.env"
run_botctl harden check
expect_item WARN config-modes 'postgres.env (644)'
assert_not_contains 'harden check printed a secret' "$BOTCTL_OUTPUT" 'not-a-real-password'
chmod 0640 "${NEXA_CONFIG_DIR}/postgres.env"
run_botctl harden check
expect_item WARN config-modes 'postgres.env (640)'
chmod 0600 "${NEXA_CONFIG_DIR}/postgres.env"
chmod 0755 "$NEXA_CONFIG_DIR"
run_botctl harden check
expect_item WARN config-modes '(755)'
teardown_root

# =============================================================================
test_case 'harden check: unattended upgrades not installed, or installed and off'
green_host
rm "${NEXA_HOST_ROOT}/usr/bin/unattended-upgrade"
run_botctl harden check
expect_item WARN upgrades 'نصب نیست'
teardown_root
green_host
printf 'APT::Periodic::Unattended-Upgrade "0";\n' >"${NEXA_HOST_ROOT}/etc/apt/apt.conf.d/20auto-upgrades"
run_botctl harden check
expect_item WARN upgrades 'روشن نیست'
teardown_root

# =============================================================================
test_case 'harden check: every item WARN is still exit 0'
green_host
rm -rf "${NEXA_HOST_ROOT:?}/etc" "${NEXA_HOST_ROOT:?}/usr"
chmod 0666 "${NEXA_HOST_ROOT}/var/run/docker.sock"
chmod 0644 "${NEXA_CONFIG_DIR}/nexa.env"
fake_set ufw_status 'Status: inactive'
fake_set ss_listen "$(printf 'LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:*\n')"
run_botctl harden check
assert_equals 'harden check failed on WARNs alone' 0 "$BOTCTL_STATUS"
assert_contains 'not every item warned' "$BOTCTL_OUTPUT" 'harden: 0 PASS, 7 WARN'
teardown_root

test_case 'harden check: refuses an unknown argument, and usage lists the command'
green_host
run_botctl harden check --fix
assert_fails 'an extra argument was accepted' test "$BOTCTL_STATUS" -eq 0
run_botctl harden
assert_fails 'harden without check was accepted' test "$BOTCTL_STATUS" -eq 0
assert_contains 'usage does not list harden check' "$("$BOTCTL" help)" 'botctl harden check'
teardown_root

# =============================================================================
printf '\nbotctl backup offsite test\n'

test_case 'backup offsite test: reaches the backup CLI once, read-only, with no argument'
green_host
before="$(sha256sum "${NEXA_CONFIG_DIR}/nexa.env")"
reset_docker_log
run_botctl backup offsite test
assert_equals 'backup offsite test failed' 0 "$BOTCTL_STATUS"
assert_contains 'the test did not reach the CLI' "$(docker_log)" 'dist/backup.cli.js offsite-test'
assert_not_contains 'the test took a pg_dump' "$(docker_log)" 'pg_dump'
assert_fails 'the test took the installation lock' test -e "$NEXA_LOCK_FILE"
assert_equals 'the test edited nexa.env' "$before" "$(sha256sum "${NEXA_CONFIG_DIR}/nexa.env")"
assert_equals 'the test wrote a backup file' '' "$(find "$NEXA_BACKUP_DIR" -type f)"

test_case 'backup offsite test: refuses anything else without repeating it'
reset_docker_log
run_botctl backup offsite test --secret AKIA-NOT-REAL
assert_fails 'an extra argument was accepted' test "$BOTCTL_STATUS" -eq 0
assert_not_contains 'the refusal repeated what was typed' "$BOTCTL_OUTPUT" 'AKIA-NOT-REAL'
assert_equals 'a refused test still called docker' '' "$(docker_log)"
run_botctl backup offsite upload
assert_fails 'an unknown offsite action was accepted' test "$BOTCTL_STATUS" -eq 0
assert_contains 'usage does not list backup offsite test' "$("$BOTCTL" help)" 'botctl backup offsite test'
teardown_root

report
