#!/usr/bin/env bash
# Reports a red nightly run (.github/workflows/nightly.yml, job `report`): opens
# ONE issue titled «CI شبانه قرمز است» that lists the run's failing jobs and
# links the run, or — when an open issue with exactly that title exists —
# comments the same list on it, so a week of red nights is one issue with seven
# comments rather than seven issues.
#
# REST only (`gh api`), from the environment:
#   REPO     owner/name
#   RUN_ID   this run's id
#   RUN_URL  this run's page
# `gh` authenticates with GH_TOKEN. The job that runs this holds issues: write
# and actions: read; nothing else in the nightly does.
set -euo pipefail

TITLE='CI شبانه قرمز است'

: "${REPO:?REPO is required}"
: "${RUN_ID:?RUN_ID is required}"
: "${RUN_URL:?RUN_URL is required}"

# Every finished job of this run that did not succeed, the called CI's jobs
# included ("CI / Integration tests (3/18)"). A skipped job is listed too: on a
# full run nothing is skipped unless something it needed failed. This job is
# still running (no conclusion) and is left out.
failing="$(
  gh api --paginate "repos/${REPO}/actions/runs/${RUN_ID}/jobs?per_page=100" \
    --jq '.jobs[] | select(.conclusion != null and .conclusion != "success")
          | "- \(.name): \(.conclusion) — \(.html_url)"'
)"
if [ -z "$failing" ]; then
  failing='- (no finished job reported a failure; read the run)'
fi

body="$(printf 'The nightly run on main is red: %s\n\nJobs that did not succeed:\n\n%s\n' "$RUN_URL" "$failing")"

# Open issues only, pull requests excluded (the issues API returns both), and
# the title compared exactly — never a search, which matches words.
existing="$(
  gh api --paginate "repos/${REPO}/issues?state=open&per_page=100" \
    --jq ".[] | select(.pull_request == null and .title == \"${TITLE}\") | .number" |
    sed -n '1p'
)"

if [ -n "$existing" ]; then
  gh api --method POST "repos/${REPO}/issues/${existing}/comments" -f body="$body" >/dev/null
  echo "commented on #${existing}"
else
  number="$(gh api --method POST "repos/${REPO}/issues" -f title="$TITLE" -f body="$body" --jq '.number')"
  echo "opened #${number}"
fi
