#!/usr/bin/env bash
# Self-test for branch-check.sh, in a throwaway repository (never this one).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail=0
check() { # description, expected exit, needle, actual exit, output
  if [[ "$4" == "$2" ]] && grep -qF -- "$3" <<<"$5"; then echo "ok   $1"; else echo "FAIL $1 (exit $4)"; echo "$5" | sed 's/^/     /'; fail=1; fi
}
cd "$tmp"
git init -q -b main repo && cd repo
git config user.email t@example.invalid && git config user.name t
mkdir -p apps/api/drizzle packages/contracts/src
echo a >apps/api/drizzle/0001_a.sql; echo b >apps/api/drizzle/0002_b.sql; echo x >f.txt
git add -A && git commit -qm base
git branch feature

echo c >apps/api/drizzle/0003_main.sql; echo y >f.txt; git add -A && git commit -qm main-moves

git checkout -q feature
echo d >apps/api/drizzle/0004_new.sql; git add -A && git commit -qm ok-migration
set +e; out="$(bash "$here/branch-check.sh" main)"; rc=$?; set -e
check "a migration above the base max is ok" 0 "ok        apps/api/drizzle/0004_new.sql" "$rc" "$out"

echo e >apps/api/drizzle/0003_mine.sql; git add -A && git commit -qm colliding
set +e; out="$(bash "$here/branch-check.sh" main)"; rc=$?; set -e
check "a number the base already has is a collision" 1 "COLLISION apps/api/drizzle/0003_mine.sql" "$rc" "$out"
git reset -q --hard HEAD~1

echo z >f.txt; git add -A && git commit -qm conflicting
set +e; out="$(bash "$here/branch-check.sh" main)"; rc=$?; set -e
check "a conflicting path is reported" 1 "f.txt" "$rc" "$out"
git reset -q --hard HEAD~1

echo k >packages/contracts/src/k.ts; git add -A && git commit -qm contract
set +e; out="$(bash "$here/branch-check.sh" main)"; rc=$?; set -e
check "a contracts change is flagged" 0 "NOTE packages/contracts changed" "$rc" "$out"

echo dirt >>f.txt
set +e; out="$(bash "$here/branch-check.sh" main)"; rc=$?; set -e
check "a dirty tree is flagged" 1 "WARN working tree is dirty" "$rc" "$out"
exit "$fail"
