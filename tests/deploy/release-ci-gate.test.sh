#!/usr/bin/env bash
# The release gate, run as the release workflow runs it, against a fake `gh`.
#
# `release.yml` cannot run on a pull request and a tag runs it once, so the
# only place its CI gate can be exercised before it matters is here. The fake
# serves recorded `actions/runs` API pages from tests/fixtures/release-gate/
# and applies the REAL `--jq` filter the script passes, with real jq, so the
# extraction is tested as well as the decision.
#
# The fake deliberately IGNORES the `head_sha` query filter and returns every
# run in the fixture: the gate must compare the SHA itself, and a fixture with
# a green run for another commit proves it does.
#
# shellcheck shell=bash

set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "${HERE}/../.." && pwd)"
# shellcheck source=harness.sh
. "${HERE}/harness.sh"

GATE="${REPO}/scripts/release-ci-gate.sh"
FIXTURES="${REPO}/tests/fixtures/release-gate"
SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

printf 'release CI gate\n'

if ! command -v jq >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  if [ "${CI:-}" = "true" ]; then
    printf '\033[31mFAIL\033[0m  jq and node are required in CI to test the release gate.\n' >&2
    exit 1
  fi
  printf '\033[33mskip\033[0m  jq or node is not installed; the CI job runs this.\n'
  exit 0
fi

FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN"' EXIT

# The fake gh. Serves every page of $FAKE_GH_FIXTURE through the filter given
# with --jq, records its arguments, and fails when $FAKE_GH_FAIL is set — an
# API that does not answer must stop the release, not read as "no runs".
cat >"${FAKE_BIN}/gh" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_GH_LOG}"
if [ -n "${FAKE_GH_FAIL:-}" ]; then
  printf 'gh: HTTP 502\n' >&2
  exit 1
fi
filter='.'
paginate=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --jq) filter="$2"; shift 2 ;;
    --paginate) paginate=1; shift ;;
    *) shift ;;
  esac
done
for page in "${FAKE_GH_FIXTURE}"/page-*.json; do
  jq -r "$filter" "$page"
  [ "$paginate" -eq 1 ] || break
done
FAKE
chmod +x "${FAKE_BIN}/gh"

export FAKE_GH_LOG="${FAKE_BIN}/gh.log"
OUTPUT=""
STATUS=0

run_gate() {
  # $1: fixture name, $2: sha (optional)
  : >"$FAKE_GH_LOG"
  STATUS=0
  OUTPUT="$(PATH="${FAKE_BIN}:${PATH}" FAKE_GH_FIXTURE="${FIXTURES}/$1" \
    bash "$GATE" example/nexa-bot "${2:-$SHA}" 2>&1)" || STATUS=$?
}

test_case 'a run that passed on a RE-RUN (attempt 2) is accepted'
run_gate rerun-success
assert_equals 'exit status' 0 "$STATUS"
assert_contains 'names the passing run' "$OUTPUT" 'actions/runs/101'
assert_contains 'says which attempt' "$OUTPUT" 'attempt 2'

test_case 'the query names the exact SHA and follows every page'
assert_contains 'exact head_sha filter' "$(cat "$FAKE_GH_LOG")" "head_sha=${SHA}&"
assert_contains 'paginates' "$(cat "$FAKE_GH_LOG")" '--paginate'

test_case 'a success on the second page is found'
run_gate success-on-second-page
assert_equals 'exit status' 0 "$STATUS"
assert_contains 'names the page-two run' "$OUTPUT" 'actions/runs/111'

test_case 'a successful workflow_dispatch run of the exact SHA is accepted'
run_gate dispatch-success
assert_equals 'exit status' 0 "$STATUS"

test_case 'a CANCELLED run is not a pass'
run_gate cancelled
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'says cancelled' "$OUTPUT" 'concluded cancelled'
assert_not_contains 'never reports a pass' "$OUTPUT" 'PASS'

test_case 'a FAILED run is not a pass'
run_gate failure
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'says failure' "$OUTPUT" 'concluded failure'

test_case 'a run still IN PROGRESS is not a pass, and says to wait'
run_gate in-progress
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'says it is still running' "$OUTPUT" 'still running'

test_case 'a green run of ANOTHER commit is not a pass'
run_gate other-sha-green
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'says it is another commit' "$OUTPUT" 'another commit'

test_case 'a green PULL_REQUEST run is not a pass: it tested a merge, not this commit'
run_gate pull-request-green
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'explains why' "$OUTPUT" 'pull_request run does not test this exact commit'

test_case 'a green run of ANOTHER workflow is not a pass'
run_gate other-workflow-green
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'names the workflow it ignored' "$OUTPUT" 'exhaustive.yml'

test_case 'no runs at all is not a pass'
run_gate no-runs
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'says none exists' "$OUTPUT" 'no push or workflow_dispatch run'

test_case 'an API that does not answer stops the release'
FAKE_GH_FAIL=1 run_gate rerun-success
assert_equals 'exit status' 1 "$STATUS"
assert_contains 'says it could not read' "$OUTPUT" 'could not be read'

test_case 'an abbreviated SHA is refused before any query'
run_gate rerun-success aaaaaaa
assert_equals 'exit status' 1 "$STATUS"
assert_equals 'no API call was made' '' "$(cat "$FAKE_GH_LOG")"

report
