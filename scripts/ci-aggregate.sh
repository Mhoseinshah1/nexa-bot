#!/usr/bin/env bash
# The decision of CI's aggregate check, "Unit and integration tests"
# (.github/workflows/ci.yml, job `test`): exit 0 only when every test job either
# succeeded or was skipped because `changes` (scripts/ci-scope.sh) said this
# pull request does not need it.
#
# Reads, from the environment:
#   EVENT                     github.event_name
#   CHANGES                   the `changes` job's result
#   FULL                      its `full` output
#   BUILD_RESULT              the build's result (required on every event)
#   <JOB>_RESULT, <JOB>_SCOPE for every scoped job below: its result, and the
#                             scope output that decides whether it runs
#
# A job's result is accepted when it is `success`, or when it is `skipped` AND
# all of these hold:
#   - the event is `pull_request` — a push to main, a dispatch and the nightly
#     are the release evidence and full runs, so they never accept a skip;
#   - `changes` succeeded, said full=false, and said that job's scope is false.
# Anything else is a failure: a job that should have run and was skipped, a
# cancelled job, a failed or timed-out job, a result or scope that is missing.
set -uo pipefail

JOBS=(UNIT WEB INTEGRATION LEGACY_MYSQL LEGACY_REHEARSAL DEPLOY_LOGIC DEPLOY DEPLOY_UPDATE)

failed=0
event="${EVENT:-}"
changes="${CHANGES:-}"
full="${FULL:-}"

check() {
  local label="$1" result="$2" scope="$3"
  printf '%s: %s (in scope: %s)\n' "$label" "${result:-<none>}" "${scope:-<none>}"
  if [ "$result" = "success" ]; then
    return 0
  fi
  if [ "$result" = "skipped" ] && [ "$event" = "pull_request" ] && [ "$changes" = "success" ] &&
    [ "$full" = "false" ] && [ "$scope" = "false" ]; then
    echo "  (skipped: this pull request changes nothing it reads)"
    return 0
  fi
  echo "::error::$label did not succeed (${result:-no result}; in scope: ${scope:-unknown})"
  failed=1
}

# Required to succeed on every event.
check 'changed paths' "$changes" true
check 'build' "${BUILD_RESULT:-}" true

for job in "${JOBS[@]}"; do
  result_var="${job}_RESULT"
  scope_var="${job}_SCOPE"
  label="$(printf '%s' "$job" | tr 'A-Z_' 'a-z ')"
  check "$label" "${!result_var:-}" "${!scope_var:-}"
done

exit "$failed"
