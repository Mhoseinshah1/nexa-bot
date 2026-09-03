#!/usr/bin/env bash
# Tier 3 of `scripts/check-shell.sh`, tested rather than described.
#
# Tier 3 bans a pipeline ending in a consumer that exits early — `grep -q`,
# `head` — because under `set -o pipefail` the producer dies of SIGPIPE and the
# pipeline returns 141 when it SUCCEEDS, which under `set -e` aborts the script.
#
# This file exists because that check was rewritten four times and never once
# had a test. Two of those rewrites introduced blind spots that the next review
# found by hand, and a commit message claimed eleven probes that were run and
# thrown away. A check with no test is a check that silently stops checking.
#
# shellcheck shell=bash

set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "${HERE}/../.." && pwd)"
# shellcheck source=harness.sh
. "${HERE}/harness.sh"

printf 'check-shell tier 3\n'

# A throwaway tree with the real script, so probes never touch the repository.
PROBE_ROOT="$(mktemp -d)"
trap 'rm -rf "$PROBE_ROOT"' EXIT
mkdir -p "$PROBE_ROOT/scripts" "$PROBE_ROOT/deploy" "$PROBE_ROOT/tests/deploy" \
  "$PROBE_ROOT/.github/workflows"

# Tier 3 alone, lifted out of the real script — tiers 1 and 2 run shellcheck
# over the whole tree and would report the probe files themselves. Extracted by
# marker rather than copied, so this tests the code that ships; if the marker
# moves, the extraction produces nothing and the first assertion says so.
TIER3="${PROBE_ROOT}/tier3.sh"
{
  printf '#!/usr/bin/env bash\nset -euo pipefail\n'
  printf 'fail() { printf "FAIL %%s\\n" "$1" >&2; exit 1; }\n'
  sed -n '/^# --- Tier 3/,$p' "${REPO}/scripts/check-shell.sh"
} >"$TIER3"
test_case 'the tier-3 check could be extracted'
assert_ok 'tier 3 was not found in check-shell.sh' grep -q 'OFFENDERS=' "$TIER3"

probe() {
  local path="$1" content="$2"
  printf '%s\n' "$content" >"${PROBE_ROOT}/${path}"
  local output status=0
  output="$(cd "$PROBE_ROOT" && bash "$TIER3" 2>&1)" || status=$?
  rm -f "${PROBE_ROOT}/${path}"
  if [ "$status" -eq 0 ]; then
    printf 'clean'
  elif printf '%s' "$output" | grep -q 'exits early'; then
    printf 'flagged'
  else
    printf 'error: %s' "$output"
  fi
}

expect_flagged() {
  local description="$1" path="$2" content="$3" verdict
  verdict="$(probe "$path" "$content")"
  assert_equals "$description" 'flagged' "$verdict"
}

expect_clean() {
  local description="$1" path="$2" content="$3" verdict
  verdict="$(probe "$path" "$content")"
  assert_equals "$description" 'clean' "$verdict"
}

test_case 'an offending pipeline is found however it is spelled'
expect_flagged 'inline grep -q' scripts/p.sh 'printf a | grep -q a'
expect_flagged 'grep --quiet' scripts/p.sh 'printf a | grep --quiet a'
expect_flagged 'head' scripts/p.sh 'v="$(find . | head -n 1)"'
expect_flagged 'grep -m1, which also exits early' scripts/p.sh 'v="$(ls | grep -m1 x)"'
expect_flagged 'a locale prefix' scripts/p.sh 'v="$(ls | LC_ALL=C grep -q x)"'
expect_flagged 'a command prefix' scripts/p.sh 'v="$(ls | command grep -q x)"'

test_case 'a pipeline broken across lines is still a pipeline'
# The original offender in check-boundaries.sh was written this way, and a
# one-line regex reported the tree clean while it sat there.
expect_flagged 'multi-token producer' scripts/p.sh 'docker compose ps |
  grep -q api'
expect_flagged 'ONE-WORD producer' scripts/p.sh 'mount |
  grep -q /var'
expect_flagged 'one-word producer into head' scripts/p.sh 'ls |
  head -n 1'

test_case 'workflows are shell too'
expect_flagged 'inside a run block' .github/workflows/p.yml '      - name: x
        run: |
          set -e
          printf a | grep -q a'

test_case 'prose that merely mentions a heredoc does not blind the file'
# `botctl` contains a <<REFUSAL block and sentences about it. Treating any
# mention as an opener made the rest of the file invisible to this check, with
# no diagnostic at all.
expect_flagged 'after a COMMENT naming a tag' scripts/p.sh '# a comment about the <<REFUSAL block
a | grep -q x'
expect_flagged 'after a STRING naming a tag' scripts/p.sh 'echo "documented as <<MARKER in the manual"
gzip -dc z | grep -q TABLE'
expect_flagged 'after a string ENDING at a tag' scripts/p.sh 'printf "%s\n" "the block tagged <<REFUSAL"
docker ps | grep -q api'

test_case 'an unterminated heredoc is an error, not silence'
# The failure mode this converts: any spelling that opens a heredoc which never
# closes hides every following line. Rather than enumerate the spellings, the
# check refuses to reach the end of a file still inside one.
expect_flagged 'a heredoc with no terminator' scripts/p.sh 'cat <<EOF
some body that never ends'

test_case 'genuine heredoc bodies are data, not code'
expect_clean 'a pipeline inside heredoc prose' scripts/p.sh 'cat <<EOF
docker compose ps | grep -q api
EOF'
expect_clean 'a quoted tag with a redirection after it' scripts/p.sh "cat <<'EOF' >/tmp/x
ls | head -n 1
EOF"
expect_clean 'an indented <<- heredoc' scripts/p.sh 'cat <<-EOF
  find . | head -n 1
	EOF'
expect_clean 'a heredoc piped onward' scripts/p.sh 'cat <<EOF | tee /tmp/log
find . | head -n 1
EOF'

test_case 'a YAML block scalar is not a pipeline'
# `run: |` ends a line with a pipe and means the opposite. Joining there
# spliced the indicator onto the first body line, so a step whose first line
# began `head` was reported and the same command on line three was not.
expect_clean 'head first in run: |' .github/workflows/p.yml '      - name: x
        run: |
          head -n 5 CHANGELOG.md > /tmp/x'
expect_clean 'a key containing a digit' .github/workflows/p.yml '      - name: x
        run2: |
          grep -q foo /etc/mtab'
expect_clean 'a bare sequence item' deploy/p.yml '    command:
      - |
        head -c 32 /dev/urandom > /tmp/s'

test_case 'a decided exit status is respected'
expect_clean 'a diagnostic dump ending in || true' scripts/p.sh 'compose ps 2>&1 | head -20 || true'
expect_clean 'a comment describing the pattern' scripts/p.sh '# never write: producer | grep -q PATTERN'
expect_clean 'grep -q with no pipeline at all' scripts/p.sh 'grep -q foo file || echo no'

report
