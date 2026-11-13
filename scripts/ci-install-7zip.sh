#!/usr/bin/env bash
# Install a pinned, checksum-verified 7-Zip for CI, without apt.
#
#   scripts/ci-install-7zip.sh [DEST]      DEST defaults to $HOME/.cache/nexa-ci-tools/7zip
#
# Why not `apt-get install 7zip`: that reaches *.ubuntu.com, and when Canonical's DNS
# was down (2026-11-11) every job that did so went red for hours. This downloads the
# official static build from the 7-Zip project's GitHub release (github.com is already
# a hard dependency of every job), verifies its sha256 against the value pinned below,
# and puts `7z` (a link to the release's `7zz`, which is what BACKUP_SEVEN_ZIP_BIN
# defaults to) first on PATH for the rest of the job.
#
# DEST holds the tarball, so a job can actions/cache it: a cache hit skips the
# download, and the checksum is verified either way. A tarball that fails the check
# is deleted and fetched again once; a second mismatch fails the step.
#
# Bumping 7-Zip: change VERSION and SHA256 together (sha256sum of the downloaded
# 7z<ver>-linux-x64.tar.xz) — tests/unit/ci-workflow.test.ts pins both.
set -euo pipefail

VERSION="25.01"
ARCHIVE="7z${VERSION//./}-linux-x64.tar.xz"
SHA256="4ca3b7c6f2f67866b92622818b58233dc70367be2f36b498eb0bdeaaa44b53f4"
URL="https://github.com/ip7z/7zip/releases/download/${VERSION}/${ARCHIVE}"

DEST="${1:-${HOME}/.cache/nexa-ci-tools/7zip}"
mkdir -p "$DEST/bin"
TARBALL="$DEST/$ARCHIVE"

verified() {
  [ -f "$TARBALL" ] && printf '%s  %s\n' "$SHA256" "$TARBALL" | sha256sum --check --status
}

if verified; then
  printf '7-Zip %s: using the cached tarball %s\n' "$VERSION" "$TARBALL"
else
  rm -f "$TARBALL"
  printf '7-Zip %s: downloading %s\n' "$VERSION" "$URL"
  curl --fail --silent --show-error --location --retry 5 --retry-delay 3 \
    --retry-all-errors --connect-timeout 20 --max-time 120 --output "$TARBALL" "$URL"
  if ! verified; then
    rm -f "$TARBALL"
    printf 'FAIL  %s does not match the pinned sha256 %s\n' "$ARCHIVE" "$SHA256" >&2
    exit 1
  fi
fi

tar -xf "$TARBALL" -C "$DEST/bin" 7zz
ln -sf 7zz "$DEST/bin/7z"
"$DEST/bin/7z" i >/dev/null
printf '7-Zip %s ready: %s\n' "$VERSION" "$DEST/bin/7z"

if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$DEST/bin" >>"$GITHUB_PATH"
fi
