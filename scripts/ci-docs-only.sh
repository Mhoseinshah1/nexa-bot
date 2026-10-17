#!/usr/bin/env bash
# Decides whether CI's heavy jobs run, and prints `heavy=true` or `heavy=false`
# for $GITHUB_OUTPUT (.github/workflows/ci.yml, job `changes`).
#
#   bash scripts/ci-docs-only.sh <event>            the merge commit's own diff
#   bash scripts/ci-docs-only.sh <event> --stdin    the changed paths on stdin
#
# `heavy=false` needs ALL of:
#   - the event is `pull_request`. A push to main and a dispatched run are the
#     release evidence (release.yml) and always run everything;
#   - the list of changed paths could be read and is not empty;
#   - every path is documentation no heavy job reads: Markdown under docs/, or
#     one of the three root notes .dockerignore keeps out of the image.
# Anything else — an unreadable diff included — is `heavy=true`. The rule fails
# towards running more, never less.
set -euo pipefail

event="${1:-}"
source="${2:-}"

heavy() {
  printf 'heavy=%s\n' "$1"
  exit 0
}

[ "$event" = "pull_request" ] || heavy true

if [ "$source" = "--stdin" ]; then
  paths="$(cat)"
else
  # The merge commit against its first parent, the base it is tested on.
  # --no-renames lists both sides of a rename, so `x.ts -> x.md` counts as x.ts.
  paths="$(git diff --name-only --no-renames HEAD^1 HEAD 2>/dev/null)" || heavy true
fi

[ -n "$paths" ] || heavy true

while IFS= read -r path; do
  case "$path" in
    README.md | CLAUDE.md | PROGRESS.md) ;;
    docs/*.md) ;;
    *) heavy true ;;
  esac
done <<<"$paths"

heavy false
