#!/usr/bin/env bash
# The release gate: has CI passed for EXACTLY this commit?
#
#   scripts/release-ci-gate.sh <owner/repo> <40-hex sha>
#
# Asks GitHub for every workflow run whose head is this commit, and hands the
# whole listing to `release-ci-gate.mjs`, which decides. Exit 0 means a push or
# workflow_dispatch run of .github/workflows/ci.yml completed with conclusion
# `success` for this SHA — including a run that only got there on a re-run.
# Anything else exits non-zero with the reason and the runs it saw.
#
# Every status is fetched, not just `completed`, so a run still in progress is
# reported as "still running, wait" rather than as "no CI exists", which is the
# message that sent people looking for a CI run that was about to finish.
#
# Requires `gh` (authenticated through GH_TOKEN) and `node`. The test,
# tests/deploy/release-ci-gate.test.sh, replaces `gh` with a fake that serves
# recorded API pages.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [ "$#" -ne 2 ]; then
  printf 'usage: %s <owner/repo> <40-hex sha>\n' "$0" >&2
  exit 2
fi
repo="$1"
sha="$2"

# Exact, full, lowercase. `head_sha` is a prefix-free equality filter on the
# API side, and the decision compares exactly as well — but an abbreviated SHA
# would match nothing there, and "no CI exists" is the wrong thing to say.
if [[ ! $sha =~ ^[0-9a-f]{40}$ ]]; then
  printf 'refusing: "%s" is not a full 40-character commit SHA.\n' "$sha" >&2
  exit 1
fi
if [[ ! $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  printf 'refusing: "%s" is not an owner/repo name.\n' "$repo" >&2
  exit 1
fi

listing="$(mktemp)"
trap 'rm -f "$listing"' EXIT

# One JSON object per line. `tojson` rather than relying on how the jq output
# of an object is printed, so the decision parses exactly one run per line.
# `--paginate` follows every page: a commit with many re-runs and dispatches
# must not have its one success on page two.
if ! gh api --paginate \
  "repos/${repo}/actions/runs?head_sha=${sha}&per_page=100" \
  --jq '.workflow_runs[] | tojson' >"$listing"; then
  printf 'refusing: the workflow-run listing for %s could not be read.\n' "$sha" >&2
  printf 'An unreadable answer is not evidence that CI passed. Re-run the release once the API answers.\n' >&2
  exit 1
fi

node "${HERE}/release-ci-gate.mjs" --sha "$sha" --runs "$listing"
