#!/usr/bin/env bash
# handoff-facts.sh [base-ref]   (default origin/main)
#
# Prints the mechanical half of a handoff as Markdown: branch, HEAD, position
# against the base, uncommitted files, this branch's commits, migrations it
# adds, and the newest migration on the base. Read-only; fetches nothing.
# The judgement half (PR/CI state, decisions, open problems, next step) is
# written by the session — see SKILL.md.
set -euo pipefail
base="${1:-origin/main}"
cd "$(git rev-parse --show-toplevel)"

branch="$(git branch --show-current)"
head="$(git rev-parse --short HEAD)"
echo "## Facts (generated $(date -u +%Y-%m-%dT%H:%MZ))"
echo
echo "- Branch: \`${branch:-detached}\` @ \`$head\` — $(git log -1 --format=%s)"
if git rev-parse --verify -q "$base" >/dev/null; then
  read -r behind ahead < <(git rev-list --left-right --count "$base...HEAD")
  echo "- Base: \`$base\` @ \`$(git rev-parse --short "$base")\` — ahead $ahead, behind $behind"
  mb="$(git merge-base HEAD "$base")"
  last_mig="$(git ls-tree --name-only "$base" apps/api/drizzle/ | grep -E '/[0-9]{4}_.*\.sql$' | sort | tail -1 || true)"
  [[ -n "$last_mig" ]] && echo "- Newest migration on base: \`$(basename "$last_mig")\`"
  mapfile -t mine < <(git diff --name-only --diff-filter=A "$mb" HEAD -- apps/api/drizzle/ | grep -E '\.sql$' || true)
  if [[ ${#mine[@]} -gt 0 ]]; then
    echo "- Migrations added here: $(printf '`%s` ' "${mine[@]##*/}")"
  fi
  # -n inside git, not `| head`: under pipefail a closed pipe fails the script.
  commits="$(git log -n 15 --format='  - `%h` %s' "$mb..HEAD")"
  if [[ -n "$commits" ]]; then echo "- Commits on this branch:"; echo "$commits"; fi
else
  echo "- Base \`$base\` not available locally (git fetch origin main)"
fi
dirty="$(git status --porcelain | wc -l | tr -d ' ')"
if [[ "$dirty" != "0" ]]; then
  echo "- Uncommitted: $dirty path(s) — commit and push, or they are lost with the container"
  git status --porcelain | sed -n '1,10{s/^/  - `/; s/$/`/; p;}'
else
  echo "- Working tree clean"
fi
up="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [[ -n "$up" ]]; then
  read -r ub ua < <(git rev-list --left-right --count "$up...HEAD")
  echo "- Upstream \`$up\`: $ua unpushed, $ub not pulled"
else
  echo "- No upstream: the branch has never been pushed"
fi
