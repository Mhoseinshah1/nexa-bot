#!/usr/bin/env bash
# Outage drill: make Canonical's hosts unreachable for the rest of the job.
#
#   scripts/ci-block-ubuntu-hosts.sh
#
# Run only when ci.yml is dispatched with `block_ubuntu_hosts: true`. It points every
# Canonical host the runner's apt configuration or the tools it ships can name at
# 0.0.0.0, so a step that still depends on *.ubuntu.com fails the way it did during
# the 2026-11-11 DNS outage — and a step that does not (the 7-Zip and MySQL installs,
# docs/ci.md) is proven not to. It then CHECKS the block took effect and prints it.
set -euo pipefail

if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
  printf 'FAIL  this edits /etc/hosts and runs only inside GitHub Actions.\n' >&2
  exit 1
fi

HOSTS=(
  archive.ubuntu.com azure.archive.ubuntu.com security.ubuntu.com ports.ubuntu.com
  esm.ubuntu.com keyserver.ubuntu.com changelogs.ubuntu.com motd.ubuntu.com
  api.snapcraft.io ppa.launchpadcontent.net ppa.launchpad.net api.launchpad.net
  launchpad.net ubuntu.com
)

for host in "${HOSTS[@]}"; do
  printf '0.0.0.0 %s\n' "$host" | sudo tee -a /etc/hosts >/dev/null
done

for host in archive.ubuntu.com security.ubuntu.com azure.archive.ubuntu.com; do
  if curl --silent --max-time 10 --output /dev/null "http://$host/ubuntu/dists/noble/InRelease"; then
    printf 'FAIL  %s is still reachable; the drill proves nothing.\n' "$host" >&2
    exit 1
  fi
  printf 'blocked: %s is unreachable (as in the 2026-11-11 outage)\n' "$host"
done
