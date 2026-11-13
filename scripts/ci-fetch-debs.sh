#!/usr/bin/env bash
# Download Ubuntu .deb files for CI without depending on Canonical's DNS.
#
#   scripts/ci-fetch-debs.sh DEST PACKAGE...
#
# Why: `apt-get update && apt-get download` against the runner's default sources reaches
# azure.archive.ubuntu.com / security.ubuntu.com; during Canonical's DNS outage on
# 2026-11-11 the legacy-rehearsal job (MySQL 8.0's server and client) was red for hours.
#
# The job caches DEST (actions/cache, keyed by the package list), so this runs only on a
# cache miss: when DEST already holds a .deb for every package it does nothing. On a miss
# it tries, in order, archive.ubuntu.com and then mirrors.edge.kernel.org/ubuntu — a
# mirror served from kernel.org's own DNS and CDN. Both are checked the SAME way a
# default install checks them: the suites are signed (`signed-by` is the runner's
# ubuntu-archive keyring; no `trusted=yes`, no unsigned downloads), through a temporary
# apt tree, so the runner's own /etc/apt and /var/lib/apt are never touched and no sudo
# is needed.
#
# CI_FETCH_DEBS_MIRRORS overrides the mirror list (space-separated base URLs) — for the
# unit test of the fallback order, never needed in CI.
set -euo pipefail

DEST="${1:?usage: ci-fetch-debs.sh DEST PACKAGE...}"
shift
[ "$#" -gt 0 ] || { printf 'FAIL  no packages named.\n' >&2; exit 2; }

KEYRING="${CI_FETCH_DEBS_KEYRING:-/usr/share/keyrings/ubuntu-archive-keyring.gpg}"
SUITE="${CI_FETCH_DEBS_SUITE:-noble}"
# shellcheck disable=SC2206 # word-splitting the URL list is the point
MIRRORS=(${CI_FETCH_DEBS_MIRRORS:-http://archive.ubuntu.com/ubuntu https://mirrors.edge.kernel.org/ubuntu})

[ -r "$KEYRING" ] || { printf 'FAIL  keyring %s is missing; refusing to download unsigned.\n' "$KEYRING" >&2; exit 1; }

mkdir -p "$DEST"

have_all() {
  local pkg
  for pkg in "$@"; do
    compgen -G "$DEST/${pkg}_*.deb" >/dev/null || return 1
  done
}

if have_all "$@"; then
  printf 'debs: cache hit, %s already holds %s\n' "$DEST" "$*"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/state/lists/partial" "$WORK/cache/archives/partial" "$WORK/etc/empty"

try_mirror() {
  local mirror="$1" list="$WORK/etc/sources.list"
  shift
  {
    local pocket
    for pocket in "$SUITE" "$SUITE-updates" "$SUITE-security"; do
      printf 'deb [arch=amd64 signed-by=%s] %s %s main universe\n' "$KEYRING" "$mirror" "$pocket"
    done
  } >"$list"
  local apt=(
    -o "Dir::Etc::sourcelist=$list" -o "Dir::Etc::sourceparts=$WORK/etc/empty"
    -o "Dir::State=$WORK/state" -o "Dir::Cache=$WORK/cache"
    -o "Dir::State::status=/var/lib/dpkg/status"
    -o "Acquire::Retries=2" -o "Acquire::http::Timeout=20" -o "Acquire::https::Timeout=20"
    -o "Debug::NoLocking=1" -o "APT::Sandbox::User=$(id -un)"
  )
  rm -f "$WORK"/dl/*.deb 2>/dev/null || true
  mkdir -p "$WORK/dl"
  apt-get "${apt[@]}" update -qq || return 1
  (cd "$WORK/dl" && apt-get "${apt[@]}" download "$@") || return 1
  cp "$WORK"/dl/*.deb "$DEST"/
}

for mirror in "${MIRRORS[@]}"; do
  printf 'debs: cache miss, fetching %s from %s\n' "$*" "$mirror"
  if try_mirror "$mirror" "$@"; then
    printf 'debs: fetched from %s\n' "$mirror"
    exit 0
  fi
  printf 'debs: %s failed, trying the next mirror\n' "$mirror" >&2
done

printf 'FAIL  no mirror could supply %s\n' "$*" >&2
exit 1
