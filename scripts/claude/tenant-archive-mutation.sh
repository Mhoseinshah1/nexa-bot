#!/usr/bin/env bash
# tenant-archive-mutation.sh - the mutation checks of the Phase 6B PR-1 tenant archive.
#
#   TEST_DATABASE_URL=... DATABASE_URL=... bash scripts/claude/tenant-archive-mutation.sh [name...]
#
# Each mutation reverts ONE rule of ADR-0039 in the source, runs the suite that pins it
# against the PRIVATE database the two URLs name, and restores the file. A mutation passes
# when its suite turns RED; the script then runs the untouched suites once and requires them
# GREEN. Exit 0 only when every mutation was red and the restored run green. Each run goes
# through run-gate.sh (one integration run at a time, round-wide). Never on a dirty tree:
# the file is restored with `git checkout`.
set -uo pipefail

if [[ -z "${TEST_DATABASE_URL:-}" || "${TEST_DATABASE_URL}" != "${DATABASE_URL:-}" ]]; then
  echo "tenant-archive-mutation: set TEST_DATABASE_URL and DATABASE_URL to the same private database" >&2
  exit 2
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root" || exit 2
if [[ -n "$(git status --porcelain -- apps/api/src)" ]]; then
  echo "tenant-archive-mutation: apps/api/src has uncommitted changes; commit or stash them first" >&2
  exit 2
fi

B=apps/api/src/modules/platform/backup
ARCHIVE_SUITE=tests/integration/isolation-proof/tenant-archive.test.ts
QUEUE_SUITE=tests/integration/capacity-guards.test.ts

# name | file | perl substitution (a literal pipe is \x7c: `|` separates the fields) | suite
# A suite under tests/unit/ runs in the unit project, any other in the integration project.
MUTATIONS=(
  "rls-refusal|$B/infrastructure/tenant-archive-export.ts|s/\\!== 'enforcing'\\)/=== 'never'\\)/|$ARCHIVE_SUITE"
  "aggregate-join|$B/application/tenant-archive-inventory.ts|s/\\(aggregate_type, aggregate_id\\) IN \\(SELECT o.aggregate_type, o.aggregate_id FROM outbox_messages o WHERE o.tenant_id = \\\$1\\)/true OR \\\$1::uuid IS NULL/|$ARCHIVE_SUITE"
  "part-checksum|$B/infrastructure/tenant-archive-restore.ts|s/got.sha256 !== table.sha256 \\x7c\\x7c //|$ARCHIVE_SUITE"
  "verify-before-deliver|$B/application/tenant-archive.service.ts|s/const verified = await this.deps.engine.verify\\(/const verified = { tables: 0, rows: 0 }; void (/|$ARCHIVE_SUITE"
  "head-newer|$B/infrastructure/tenant-archive-restore.ts|s/if \\(head.count > expected.length\\) return 'NEWER';/if (head.count > expected.length) return 'OLDER';/|$ARCHIVE_SUITE"
  "tenant-exists|$B/infrastructure/tenant-archive-apply.ts|s/if \\(\\(exists\\[0\\]\\?.n \\?\\? 0\\) > 0\\)/if (false)/|$ARCHIVE_SUITE"
  "target-key|$B/infrastructure/tenant-archive-apply.ts|s/resealRow\\(row, slots, input.archiveCipher, input.targetCipher\\)/resealRow(row, slots, input.archiveCipher, input.archiveCipher)/|$ARCHIVE_SUITE"
  "exclusive-heavy-job|apps/api/src/modules/platform/capacity/infrastructure/drizzle-capacity.repository.ts|s/!running.some\\(\\(row\\) => exclusive\\(row.kind\\)\\) &&//|$QUEUE_SUITE"
  # The security review's fixes, each reverted.
  "owner-admin|$B/infrastructure/tenant-archive-apply.ts|s/if \\(\\(owners\\[0\\]\\?.n \\?\\? 0\\) !== 1\\)/if (false)/|$ARCHIVE_SUITE"
  "tenant-kind|$B/infrastructure/tenant-archive-apply.ts|s/out\\[at\\('kind'\\)\\] = 'HOSTED';//|$ARCHIVE_SUITE"
  "register-expiry|$B/infrastructure/tenant-archive-apply.ts|s/NULL, \\\$\\{host.ownerAdminId\\}/\\\${host.expiresAt}::timestamptz, \\\${host.ownerAdminId}/|$ARCHIVE_SUITE"
  "register-limits|$B/infrastructure/tenant-archive-apply.ts|s/(\\/\\/ the manifest's values are informational only.)/\\1\\n      for (const limit of host.capacityLimits) await tx.execute(sql\\x60INSERT INTO tenant_capacity_limits (tenant_id, resource, mode, value, updated_at) VALUES (\\\${tenantId}::uuid, \\\${limit.resource}, \\\${limit.mode}, \\\${limit.value}, \\\${input.now})\\x60);/|$ARCHIVE_SUITE"
  "identity-bound|$B/infrastructure/tenant-archive-apply.ts|s/if \\(top > last \\+ IDENTITY_RESTORE_HEADROOM \\x7c\\x7c top > typeMax \\/ 2n\\)/if (false)/|$ARCHIVE_SUITE"
  "extract-cap|$B/infrastructure/tenant-archive-restore.ts|s/if \\(declared > input.limits.maxExtractedBytes\\)/if (false)/|$ARCHIVE_SUITE"
  "buffer-cap|$B/infrastructure/tenant-archive-copy.ts|s/if \\(buffer.length > limits.rows \\x7c\\x7c state.bytes > limits.bytes\\)/if (false)/|tests/unit/tenant-archive-copy.test.ts"
  "shared-renumber|$B/infrastructure/tenant-archive-apply.ts|s/if \\(table === 'outbox_messages'\\) await renumberShared/if (false) await renumberShared/|$ARCHIVE_SUITE"
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
if run_suite "$ARCHIVE_SUITE" "$QUEUE_SUITE"; then
  echo "== restored: GREEN"
else
  echo "== restored: RED; FAILED"
  status=1
fi
exit "$status"
