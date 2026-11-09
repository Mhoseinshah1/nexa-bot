#!/usr/bin/env bash
# hosted-backup-mutation.sh - the mutation checks of Phase 6B PR-2 (hosted-bot backups).
#
#   TEST_DATABASE_URL=... DATABASE_URL=... bash scripts/claude/hosted-backup-mutation.sh [name...]
#
# Each mutation reverts ONE rule of ADR-0039 § 4/§ 7 as built here, runs the suite that pins it
# against the PRIVATE database the two URLs name, and restores the file. A mutation passes when
# its suite turns RED; the script then runs the untouched suites once and requires them GREEN.
# Each run goes through run-gate.sh. Never on a dirty tree: the file is restored with
# `git checkout`.
set -uo pipefail

if [[ -z "${TEST_DATABASE_URL:-}" || "${TEST_DATABASE_URL}" != "${DATABASE_URL:-}" ]]; then
  echo "hosted-backup-mutation: set TEST_DATABASE_URL and DATABASE_URL to the same private database" >&2
  exit 2
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root" || exit 2
if [[ -n "$(git status --porcelain -- apps/api/src)" ]]; then
  echo "hosted-backup-mutation: apps/api/src has uncommitted changes; commit or stash them first" >&2
  exit 2
fi

H=apps/api/src/modules/platform/hosting
B=apps/api/src/modules/platform/backup
UNIT=tests/unit/hosted-backups.test.ts
INT=tests/integration/hosted-backups.test.ts

# name | file | perl substitution (-0: may span lines) | suite
MUTATIONS=(
  "slot-due|$H/application/hosted-backup.service.ts|s/if \\(last !== null && last.getTime\\(\\) >= latestDailySlot\\(now, policy.dailyTime\\).getTime\\(\\)\\)/if (false)/|$UNIT"
  "one-pass-at-a-time|$H/application/hosted-backup-loop.ts|s/if \\(this.running\\) return;//|$UNIT"
  "no-group-kept|$B/application/hosted-group-delivery.ts|s/if \\(route.kind === 'NOT_CONNECTED'\\) \\{/if (false) {/|$UNIT"
  "dry-run-expiry|$H/application/tenant-restore-admin.service.ts|s/now.getTime\\(\\) - TENANT_RESTORE_DRY_RUN_TTL_MS\\)/now.getTime() - 1000 * TENANT_RESTORE_DRY_RUN_TTL_MS)/|$UNIT"
  "a3-orphan|$H/application/tenant-restore-admin.service.ts|s/now.getTime\\(\\) - entry.lastWrittenAt.getTime\\(\\) >= TENANT_RESTORE_DRY_RUN_TTL_MS/false/|$UNIT"
  "password-owner-only|$H/application/hosted-backup.service.ts|s/await this.deps.section.requireSection\\(\\s+scope,\\s+actor,\\s+token,\\s+'hosting.backup_password_set',\\s+hostedTenantId,\\s+\\)/(scope as TenantContext)/|$INT"
  "retention-newest|$B/infrastructure/drizzle-hosted-archive-runs.ts|s/.offset\\(Math.max\\(1, keep\\)\\)/.offset(0)/|$INT"
  "installation-history|apps/api/src/modules/platform/recovery/application/backup-admin.service.ts|s/if \\(run === null \\x7c\\x7c \\(run.subjectTenantId \\?\\? null\\) !== null\\)/if (run === null)/|$INT"
)

run_suite() {
  if [[ "$1" == tests/unit/* ]]; then
    bash scripts/claude/run-gate.sh pnpm exec vitest run --project unit "$@" |
      grep -E '^(passed=|exit=)'
  else
    bash scripts/claude/run-gate.sh --integration pnpm exec vitest run --project integration "$@" |
      grep -E '^(passed=|exit=)'
  fi
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

echo "== restored: the untouched suites"
if run_suite "$UNIT" && run_suite "$INT"; then
  echo "== restored: GREEN"
else
  echo "== restored: RED; FAILED"
  status=1
fi
exit "$status"
