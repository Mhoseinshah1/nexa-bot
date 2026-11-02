#!/usr/bin/env bash
# The release's install.sh, downloaded alone, on a clean Ubuntu 24.04.
#
# tests/deploy/standalone-installer.test.sh proves the logic on the build
# machine; this proves the same path on the operating system an operator runs
# it on, with nothing installed but what the documentation tells them to have:
# curl and ca-certificates. No clone, no pnpm, no Node.
#
# It builds the release assets from HEAD exactly as release.yml does, mounts
# them read-only into a fresh `ubuntu:24.04` container as the "release", copies
# install.sh and install.sh.sha256 into an empty directory, runs the documented
# `sha256sum -c`, and runs `bash install.sh --help` as root — which downloads
# the bundle (file:// via NEXA_INSTALL_BUNDLE_BASE_URL, the only difference
# from production, and one the stamped hash makes irrelevant), verifies it,
# unpacks it and runs the bundle's installer. Then the same with a tampered
# bundle, which must be refused. The transcript is printed.
#
# Needs Docker and network access for the base image and apt.
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

IMAGE="ubuntu:24.04"
TAG="v0.0.0-standalone-smoke"
REPO_NAME="${GITHUB_REPOSITORY:-Mhoseinshah1/nexa-bot}"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

printf '==> building the release assets from %s\n' "$(git rev-parse HEAD)"
bash scripts/release-installer-assets.sh build "$TAG" "$REPO_NAME" "$(git rev-parse HEAD)" "${work}/release"

# A second "release" whose bundle is not the one install.sh was stamped with.
mkdir -p "${work}/tampered"
cp "${work}/release/install.sh" "${work}/release/install.sh.sha256" "${work}/tampered/"
printf 'tampered\n' | cat "${work}/release/nexa-deploy-${TAG}.tar.gz" - >"${work}/tampered/nexa-deploy-${TAG}.tar.gz"

# shellcheck disable=SC2016 # expanded inside the container, not here.
inside='
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null
printf "\n--- %s, as root, with only curl and ca-certificates added ---\n" "$(. /etc/os-release && printf %s "$PRETTY_NAME")"

mkdir /download && cd /download
cp /release/install.sh /release/install.sh.sha256 .
set -x
ls -A
sha256sum -c install.sh.sha256
NEXA_INSTALL_BUNDLE_BASE_URL=file:///release bash install.sh --help
set +x

printf "\n--- a tampered bundle ---\n"
set +e
NEXA_INSTALL_BUNDLE_BASE_URL=file:///tampered bash install.sh --help
status=$?
set -e
if [ "$status" -eq 0 ]; then
  printf "FAIL: the tampered bundle was accepted\n" >&2
  exit 1
fi
printf "refused, exit %s\n" "$status"
if ls -A /tmp | grep -E "^nexa-install\\." >/dev/null; then
  printf "FAIL: a working directory was left behind\n" >&2
  exit 1
fi
'

printf '==> running install.sh alone in a clean %s container\n' "$IMAGE"
docker run --rm \
  -v "${work}/release:/release:ro" \
  -v "${work}/tampered:/tampered:ro" \
  "$IMAGE" bash -c "$inside"
printf '\033[32mok\033[0m    the standalone installer verified and ran its bundle on a clean %s, and refused a tampered one\n' "$IMAGE"
