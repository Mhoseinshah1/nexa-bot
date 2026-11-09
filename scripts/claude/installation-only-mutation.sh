#!/usr/bin/env bash
# installation-only-mutation.sh - the mutation checks of ADR-0039 finding F1 (Phase 6B).
#
#   TEST_DATABASE_URL=... DATABASE_URL=... bash scripts/claude/installation-only-mutation.sh [name...]
#
# Each mutation reverts ONE wall of the fix in the source, runs the suite that pins it against
# the PRIVATE database the two URLs name, and restores the file. A mutation passes when the
# suite turns RED; the script then runs the untouched suite once and requires it GREEN. Each
# run goes through run-gate.sh. Never on a dirty tree: the file is restored with `git checkout`.
set -uo pipefail

if [[ -z "${TEST_DATABASE_URL:-}" || "${TEST_DATABASE_URL}" != "${DATABASE_URL:-}" ]]; then
  echo "installation-only-mutation: set TEST_DATABASE_URL and DATABASE_URL to the same private database" >&2
  exit 2
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root" || exit 2
if [[ -n "$(git status --porcelain -- apps/api/src)" ]]; then
  echo "installation-only-mutation: apps/api/src has uncommitted changes; commit or stash them first" >&2
  exit 2
fi

M=apps/api/src/modules/platform
SUITE=tests/integration/installation-only-scope.test.ts

# name | file | perl substitution | suite
MUTATIONS=(
  "guard-filter|$M/access/application/permission-guard.ts|s/for \\(const key of INSTALLATION_ONLY_PERMISSIONS\\) kept.delete\\(key\\);//|$SUITE"
  "admin-scope|$M/recovery/application/backup-admin.service.ts|s/requireInstallationScope\\(scope, this.deps.installationTenantId\\);//|$SUITE"
  "password-scope|$M/backup/application/backup-password.service.ts|s/requireInstallationScope\\(scope, this.deps.installationTenantId\\);//|$SUITE"
  "recovery-scope|$M/recovery/application/recovery.service.ts|s/requireInstallationScope\\(scope, this.deps.installationTenantId\\);//|$SUITE"
)

run_suite() {
  bash scripts/claude/run-gate.sh --integration pnpm exec vitest run --project integration "$@" |
    grep -E '^(passed=|exit=)'
  return "${PIPESTATUS[0]}"
}

wanted=("$@")
status=0
for entry in "${MUTATIONS[@]}"; do
  IFS='|' read -r name file expression suite <<<"$entry"
  if [[ ${#wanted[@]} -gt 0 && ! " ${wanted[*]} " =~ \ $name\  ]]; then continue; fi
  before="$(sha256sum "$file")"
  perl -0pi -e "$expression" "$file"
  if [[ "$(sha256sum "$file")" == "$before" ]]; then
    echo "== $name: the mutation did not apply (the source moved); FAILED"
    status=1
    continue
  fi
  echo "== $name: mutated $file"
  if run_suite "$suite"; then
    echo "== $name: suite stayed GREEN with the rule reverted; FAILED"
    status=1
  else
    echo "== $name: RED, as it must be"
  fi
  git checkout -- "$file"
done

echo "== restored: the untouched suite"
if run_suite "$SUITE"; then
  echo "== restored: GREEN"
else
  echo "== restored: RED; FAILED"
  status=1
fi
exit "$status"
