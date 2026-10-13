#!/usr/bin/env bash
# branch-check.sh [base-ref]   (default origin/main)
#
# Read-only pre-PR / pre-merge check for the current branch:
#   - ahead/behind against the base, and whether the branch is dirty
#   - migrations this branch adds (apps/api/drizzle/NNNN_*.sql) that collide
#     with a number the base already has, or that sit at or below the base's
#     highest number (a merge would need renumbering + a regenerated journal)
#   - whether the branch touches packages/contracts (its own commit, per CLAUDE.md)
#   - a trial merge in a throwaway index to report conflicting paths
# Exit 0 = nothing found, 1 = something needs attention, 2 = usage error.
# It fetches nothing; run `git fetch origin main` first.
set -euo pipefail
base="${1:-origin/main}"
cd "$(git rev-parse --show-toplevel)"
git rev-parse --verify -q "$base" >/dev/null || { echo "unknown base: $base" >&2; exit 2; }

status=0
mb="$(git merge-base HEAD "$base")"
read -r behind ahead < <(git rev-list --left-right --count "$base...HEAD")
echo "branch:  $(git branch --show-current) @ $(git rev-parse --short HEAD)"
echo "base:    $base @ $(git rev-parse --short "$base")   ahead $ahead, behind $behind"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "WARN working tree is dirty"; status=1
fi

mig_re='^apps/api/drizzle/([0-9]{4})_.*\.sql$'
base_max="$(git ls-tree --name-only "$base" apps/api/drizzle/ | sed -nE 's#^apps/api/drizzle/([0-9]{4})_.*\.sql$#\1#p' | sort -n | tail -1)"
mapfile -t added < <(git diff --name-only --diff-filter=A "$mb" HEAD -- apps/api/drizzle/ | grep -E "$mig_re" || true)
if [[ ${#added[@]} -gt 0 ]]; then
  echo "migrations added on this branch (base max ${base_max:-none}):"
  for f in "${added[@]}"; do
    n="$(sed -nE "s#$mig_re#\\1#p" <<<"$f")"
    clash="$(git ls-tree --name-only "$base" apps/api/drizzle/ | grep -E "^apps/api/drizzle/${n}_.*\.sql$" | grep -vxF "$f" || true)"
    if [[ -n "$clash" ]]; then
      echo "  COLLISION $f  vs base $clash"; status=1
    elif [[ -n "$base_max" && "$((10#$n))" -le "$((10#$base_max))" ]]; then
      echo "  RENUMBER  $f  (base already reaches $base_max)"; status=1
    else
      echo "  ok        $f"
    fi
  done
fi

if git diff --name-only "$mb" HEAD -- packages/contracts | grep -q .; then
  echo "NOTE packages/contracts changed: keep the contract change in its own commit, with the reason in the message"
fi

# Trial merge without touching the index or the working tree.
if out="$(git merge-tree --write-tree --name-only --no-messages HEAD "$base" 2>/dev/null)"; then
  echo "merge:   clean against $base"
else
  conflicts="$(tail -n +2 <<<"$out" | sed '/^$/d')"
  if [[ -n "$conflicts" ]]; then
    echo "merge:   CONFLICTS against $base:"; sed 's/^/  /' <<<"$conflicts"; status=1
  else
    echo "merge:   could not trial-merge (git >= 2.38 needed for merge-tree --write-tree)"
  fi
fi
exit "$status"
