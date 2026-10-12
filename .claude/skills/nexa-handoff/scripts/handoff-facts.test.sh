#!/usr/bin/env bash
# Self-test for handoff-facts.sh, in a throwaway repository (never this one).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail=0
cd "$tmp" && git init -q -b main repo && cd repo
git config user.email t@example.invalid && git config user.name t
mkdir -p apps/api/drizzle && echo a >apps/api/drizzle/0001_a.sql && git add -A && git commit -qm base
git branch feature && git checkout -q feature
# More commits than the list shows, each with a long subject, so a reader that
# stops early would close the pipe on a writer that is still writing.
long="$(printf 'x%.0s' {1..2000})"
for i in $(seq 1 40); do echo "$i" >f.txt; git add -A; git commit -qm "c$i $long"; done
echo b >apps/api/drizzle/0002_b.sql; git add -A; git commit -qm mig
set +e; out="$(bash "$here/handoff-facts.sh" main)"; rc=$?; set -e
check() { if grep -qF -- "$2" <<<"$out"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
if [[ "$rc" == 0 ]]; then echo "ok   a long branch still exits 0"; else echo "FAIL a long branch exits $rc"; fail=1; fi
check "the commit list is capped at 15" "- Commits on this branch:"
check "the facts run to the end" "- No upstream: the branch has never been pushed"
check "an added migration is listed" '`0002_b.sql`'
[[ "$(grep -c '^  - `' <<<"$out")" -le 15 ]] && echo "ok   at most 15 commits listed" || { echo "FAIL more than 15 commits listed"; fail=1; }
exit "$fail"
