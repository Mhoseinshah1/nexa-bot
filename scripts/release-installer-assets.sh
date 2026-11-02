#!/usr/bin/env bash
# Builds the installer assets a GitHub release carries, from ONE commit.
#
#   bash scripts/release-installer-assets.sh build <tag> <owner/repo> <commit-sha> <out-dir>
#   bash scripts/release-installer-assets.sh check-stamp <tagged> <stamped> <tag> <owner/repo> <bundle-sha256>
#
# `build` writes three files into <out-dir>, which must not exist yet:
#
#   nexa-deploy-<tag>.tar.gz  the commit's deploy/ tree, from `git archive`:
#                             tracked files only, in tree order, every mtime the
#                             commit's, owner root, gzip without a name or time.
#                             The same commit gives the same bytes.
#   install.sh                the commit's deploy/install.sh with EXACTLY its
#                             three release-stamp lines filled: the tag, the
#                             repository, and the bundle's sha256.
#   install.sh.sha256         `<hash>  install.sh`, which `sha256sum -c
#                             install.sh.sha256` accepts in the download
#                             directory.
#
# Everything is read from git OBJECTS at <commit-sha>, never from the working
# tree, so an uncommitted edit cannot reach a release. The release workflow
# passes the SHA its gate resolved and verified.
#
# `check-stamp` is the assertion `build` ends with, callable on its own: the
# stamped file must differ from the tagged one in the three stamp lines and
# nowhere else, and those lines must carry exactly the given values. A user who
# verifies install.sh is trusting the reviewed, tagged installer; this is what
# makes the attached one that installer.
set -euo pipefail

die() {
  printf 'release-installer-assets: %s\n' "$*" >&2
  exit 1
}

valid_tag() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] && [[ $1 != *..* ]]; }
valid_repo() { [[ $1 =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; }
valid_sha256() { [[ $1 =~ ^[0-9a-f]{64}$ ]]; }

check_stamp() {
  local tagged="$1" stamped="$2" tag="$3" repo="$4" hash="$5" expected actual
  [ -f "$tagged" ] || die "no tagged installer at ${tagged}."
  [ -f "$stamped" ] || die "no stamped installer at ${stamped}."
  valid_tag "$tag" || die "\"${tag}\" is not a release tag."
  valid_repo "$repo" || die "\"${repo}\" is not owner/repo."
  valid_sha256 "$hash" || die "\"${hash}\" is not a sha256."

  expected="$(printf '%s\n' \
    '-NEXA_RELEASE_VERSION=""' \
    '-NEXA_RELEASE_REPO=""' \
    '-NEXA_RELEASE_BUNDLE_SHA256=""' \
    "+NEXA_RELEASE_VERSION=\"${tag}\"" \
    "+NEXA_RELEASE_REPO=\"${repo}\"" \
    "+NEXA_RELEASE_BUNDLE_SHA256=\"${hash}\"")"
  # Every changed line, old ones prefixed `-` and new ones `+`; unchanged lines
  # print nothing. diff exits 1 when the files differ, which is expected here.
  actual="$(diff --unchanged-line-format='' --old-line-format='-%L' --new-line-format='+%L' \
    "$tagged" "$stamped" || [ $? -eq 1 ])" || die "could not compare ${tagged} with ${stamped}."
  if [ "$actual" != "$expected" ]; then
    printf 'expected exactly these changes:\n%s\nfound:\n%s\n' "$expected" "${actual:-<none>}" >&2
    die "the stamped installer differs from the tagged one in more than its release stamp. Refusing to publish it."
  fi
}

stamp() {
  local tagged="$1" stamped="$2" tag="$3" repo="$4" hash="$5" key
  for key in NEXA_RELEASE_VERSION NEXA_RELEASE_REPO NEXA_RELEASE_BUNDLE_SHA256; do
    [ "$(grep -cx "${key}=\"\"" "$tagged" || true)" = 1 ] ||
      die "the tagged installer must hold the line ${key}=\"\" exactly once."
  done
  awk -v tag="$tag" -v repo="$repo" -v hash="$hash" '
    $0 == "NEXA_RELEASE_VERSION=\"\"" { print "NEXA_RELEASE_VERSION=\"" tag "\""; next }
    $0 == "NEXA_RELEASE_REPO=\"\"" { print "NEXA_RELEASE_REPO=\"" repo "\""; next }
    $0 == "NEXA_RELEASE_BUNDLE_SHA256=\"\"" { print "NEXA_RELEASE_BUNDLE_SHA256=\"" hash "\""; next }
    { print }
  ' "$tagged" >"$stamped"
}

build() {
  local tag="$1" repo="$2" commit="$3" out="$4" resolved bundle hash work
  valid_tag "$tag" || die "\"${tag}\" is not a release tag."
  valid_repo "$repo" || die "\"${repo}\" is not owner/repo."
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || die "\"${commit}\" is not a full commit SHA."
  resolved="$(git rev-parse --verify --quiet "${commit}^{commit}")" ||
    die "commit ${commit} is not in this repository."
  [ "$resolved" = "$commit" ] || die "${commit} resolved to ${resolved}."
  [ ! -e "$out" ] || die "${out} already exists; give a fresh output directory."

  work="$(mktemp -d)"
  # shellcheck disable=SC2064 # expanded now: $work is local to this function.
  trap "rm -rf -- '${work}'" EXIT
  mkdir -p "$out"

  bundle="nexa-deploy-${tag}.tar.gz"
  git -c tar.umask=0022 archive --format=tar "$commit" deploy | gzip -n -9 >"${out}/${bundle}"
  hash="$(sha256sum "${out}/${bundle}" | awk '{print $1}')"
  valid_sha256 "$hash" || die "could not hash ${bundle}."

  git show "${commit}:deploy/install.sh" >"${work}/install.sh"
  stamp "${work}/install.sh" "${out}/install.sh" "$tag" "$repo" "$hash"
  check_stamp "${work}/install.sh" "${out}/install.sh" "$tag" "$repo" "$hash"
  chmod 0755 "${out}/install.sh"
  (cd "$out" && sha256sum install.sh >install.sh.sha256)

  printf 'release %s from %s\n' "$tag" "$commit"
  (cd "$out" && sha256sum install.sh "$bundle")
}

case "${1:-}" in
  build)
    [ $# -eq 5 ] || die "usage: build <tag> <owner/repo> <commit-sha> <out-dir>"
    build "$2" "$3" "$4" "$5"
    ;;
  check-stamp)
    [ $# -eq 6 ] || die "usage: check-stamp <tagged> <stamped> <tag> <owner/repo> <bundle-sha256>"
    check_stamp "$2" "$3" "$4" "$5" "$6"
    printf 'the stamped installer differs from the tagged one in its release stamp only\n'
    ;;
  *) die "usage: build <tag> <owner/repo> <commit-sha> <out-dir> | check-stamp <tagged> <stamped> <tag> <owner/repo> <bundle-sha256>" ;;
esac
