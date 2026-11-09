#!/usr/bin/env bash
# tenant-archive-mutation.sh - the mutation checks of the Phase 6B PR-1 tenant archive.
#
#   TEST_DATABASE_URL=... DATABASE_URL=... bash scripts/claude/tenant-archive-mutation.sh [name...]
#
# Phase 6B replace adds two kinds: source mutations of the REPLACE flow (as below), and SQL
# mutations of the tenant rewrite allowance (0337): the migration's SQL, edited, is applied to
# the private database with psql, the allowance suite must turn RED, and the original file is
# applied again (every statement in it is idempotent).
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
REPLACE_SUITE=tests/integration/isolation-proof/tenant-replace.test.ts
ALLOWANCE_SUITE=tests/integration/tenant-rewrite-allowance.test.ts
ALLOWANCE_SQL=apps/api/drizzle/0337_tenant_rewrite_allowance.sql

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
  "outbox-not-relayed|$B/infrastructure/tenant-archive-apply.ts|s/holdUnpublished\\(columns, rows, input.now\\);//|$ARCHIVE_SUITE"
  "shared-renumber|$B/infrastructure/tenant-archive-apply.ts|s/if \\(table === 'outbox_messages'\\) await renumberShared/if (false) await renumberShared/|$ARCHIVE_SUITE"
  # The security review of PR #447 (fix/6b-tenant-archive-review), each fix reverted.
  "stored-failure|$B/application/tenant-archive.service.ts|s/failureMessage: storedFailureMessage\\(error\\)/failureMessage: error instanceof Error ? error.message : String(error)/|$ARCHIVE_SUITE"
  "stored-failure-run|$B/application/tenant-archive.service.ts|s/const failureMessage = storedFailureMessage\\(error\\);/const failureMessage = error instanceof Error ? error.message : String(error);/|tests/unit/tenant-archive-stored-failure.test.ts"
  "hosted-orphan-sweep|$B/infrastructure/run-directories.ts|s/await readdir\\(hosted\\)\\.catch\\(\\(\\) => \\[\\] as string\\[\\]\\)/[] as string[]/|tests/unit/backup-orphan-sweep.test.ts"
  "hosted-orphan-row|$B/application/backup-orphan-sweep.ts|s/if \\(row.subjectTenantId !== directory.subjectTenantId\\) return 'KEEP';//|tests/unit/backup-orphan-sweep.test.ts"
  "hosted-debris|$B/infrastructure/workspace.ts|s/if \\(entry === HOSTED_DIRECTORY\\) \\{/if (false) {/|tests/unit/backup-housekeeping.test.ts"
  "scratch-sweep|$B/infrastructure/pg-tools.ts|s/\\x60DROP DATABASE IF EXISTS \\\$\\{quoteIdent\\(name\\)\\}\\x60\\]/\\x60SELECT 1\\x60]/|$ARCHIVE_SUITE"
  "scratch-sweep-force|$B/infrastructure/pg-tools.ts|s/\\x60DROP DATABASE IF EXISTS \\\$\\{quoteIdent\\(name\\)\\}\\x60\\]/\\x60DROP DATABASE IF EXISTS \\\$\\{quoteIdent(name)\\} WITH (FORCE)\\x60]/|$ARCHIVE_SUITE"
  "restore-lease|$B/infrastructure/drizzle-tenant-restore.repository.ts|s/IN \\('REQUESTED', 'VERIFYING', 'APPLYING'\\)/IN ('REQUESTED')/|$ARCHIVE_SUITE"
  "restore-rls|$B/infrastructure/tenant-archive-engine.ts|s/\\!== 'enforcing'\\)/=== 'never')/|$ARCHIVE_SUITE"
  "artifact-binding|$B/infrastructure/tenant-archive-engine.ts|s/if \\(copied !== input.expectedSha256\\)/if (false)/|$ARCHIVE_SUITE"
  # Phase 6B replace (ADR-0039 § 4), each rule reverted.
  "replace-pre-archive|$B/application/tenant-archive.service.ts|s/const runId = await replace.preReplace\\(confirmedTenant\\);/const runId = null as unknown as string;/|$REPLACE_SUITE"
  "replace-hold|$B/application/tenant-archive.service.ts|s/await replace.hold\\(input.installationTenantId, confirmedTenant\\);//|$REPLACE_SUITE"
  "replace-release|$B/application/tenant-archive.service.ts|s/await replace\\?.release\\(input.installationTenantId, held\\).catch\\(\\(\\) => undefined\\);//|$REPLACE_SUITE"
  "replace-delete-scope|$B/infrastructure/tenant-archive-replace.ts|s/WHERE \\$\\{predicateFor\\(table, tenantId\\)\\}\\x60;/WHERE true\\x60;/|$REPLACE_SUITE"
  "replace-claim|$B/infrastructure/tenant-archive-replace.ts|s/set_config\\('nexa.tenant_rewrite', \\$\\{input.requestId\\}, true\\)/set_config('nexa.tenant_rewrite', '', true)/|$REPLACE_SUITE"
  # Every migration run re-asserts the grants (a --no-acl restore loses them): the lookup's
  # EXECUTE must stay the system path's alone there too.
  "allowed-grant-app|apps/api/src/infrastructure/persistence/row-level-security.ts|s/    REVOKE ALL ON FUNCTION nexa_tenant_rewrite_allowed\\(uuid\\) FROM \\$\\{APP_ROLE\\};\\n    GRANT EXECUTE ON FUNCTION nexa_tenant_rewrite_allowed\\(uuid\\) TO \\$\\{SYSTEM_ROLE\\};/    GRANT EXECUTE ON FUNCTION nexa_tenant_rewrite_allowed(uuid) TO \\\${APP_ROLE}, \\\${SYSTEM_ROLE};/|$ALLOWANCE_SUITE"
  "replace-apply-mode|apps/api/src/modules/platform/hosting/application/tenant-restore-admin.service.ts|s/mode: row.mode === 'REPLACE' \\? 'REPLACE' : 'NEW',/mode: 'NEW',/|tests/unit/hosted-backups.test.ts"
)

# name | perl substitution over the 0337 SQL. Each must turn the allowance suite RED.
SQL_MUTATIONS=(
  "guard-branch-terms|s/(FUNCTION nexa_terms_version_guard\\(\\)\\nRETURNS trigger\\nLANGUAGE plpgsql\\nAS \\\$function\\\$\\nBEGIN\\n)  IF TG_OP = 'DELETE' THEN\\n    IF nexa_tenant_rewrite_permits\\(OLD.tenant_id\\) THEN\\n      RETURN OLD;\\n    END IF;\\n  END IF;\\n/\\1/"
  "permits-role|s/  IF current_user <> 'nexa_system' THEN\\n    RETURN false;\\n  END IF;\\n//"
  "permits-reason|s/  IF coalesce\\(current_setting\\('app.system_reason', true\\), ''\\)\\n     <> 'tenant archive: replace a hosted tenant''s rows' THEN\\n    RETURN false;\\n  END IF;\\n//"
  "allowed-xact|s/       AND r.rewrite_xact_id = \\(pg_current_xact_id\\(\\)::text\\)::bigint\\n//"
  "allowed-tenant|s/       AND r.hosted_tenant_id = p_tenant\\n//"
  "allowed-applying|s/       AND r.state = 'APPLYING'\\n//"
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

apply_sql() {
  psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$1" >/dev/null
}
for entry in "${SQL_MUTATIONS[@]}"; do
  IFS='|' read -r name expression <<<"$entry"
  if [[ ${#wanted[@]} -gt 0 && ! " ${wanted[*]} " =~ \ $name\  ]]; then continue; fi
  mutated="$(mktemp)"
  perl -0pe "$expression" "$ALLOWANCE_SQL" >"$mutated"
  if cmp -s "$mutated" "$ALLOWANCE_SQL"; then
    echo "== $name: the SQL mutation did not apply (the migration moved); FAILED"
    status=1
    rm -f "$mutated"
    continue
  fi
  # A revoke first, so a grant the mutation adds is the only one there.
  psql "$TEST_DATABASE_URL" -q -c 'REVOKE ALL ON FUNCTION nexa_tenant_rewrite_allowed(uuid) FROM nexa_app' >/dev/null
  apply_sql "$mutated" || { echo "== $name: the mutated SQL did not apply; FAILED"; status=1; }
  echo "== $name: applied the mutated allowance to the private database"
  if run_suite "$ALLOWANCE_SUITE"; then
    echo "== $name: suite stayed GREEN with the rule reverted; FAILED"
    status=1
  else
    echo "== $name: RED, as it must be"
  fi
  psql "$TEST_DATABASE_URL" -q -c 'REVOKE ALL ON FUNCTION nexa_tenant_rewrite_allowed(uuid) FROM nexa_app' >/dev/null
  apply_sql "$ALLOWANCE_SQL"
  rm -f "$mutated"
done

echo "== restored: the untouched suites"
if run_suite "$ARCHIVE_SUITE" "$QUEUE_SUITE" "$REPLACE_SUITE" "$ALLOWANCE_SUITE"; then
  echo "== restored: GREEN"
else
  echo "== restored: RED; FAILED"
  status=1
fi
exit "$status"
