#!/usr/bin/env bash
# hosting-enter-mutation.sh - the mutation checks of Phase 6B PR-5, «ورود به پنل».
#
#   TEST_DATABASE_URL=... DATABASE_URL=... bash scripts/claude/hosting-enter-mutation.sh [name...]
#
# Each mutation reverts ONE rule of ADR-0039 § 9 in the source, runs the suite that pins it
# against the PRIVATE database the two URLs name, and restores the file. A mutation passes
# when its suite turns RED; the script then runs the untouched suites once and requires them
# GREEN. Exit 0 only when every mutation was red and the restored run green. Each run goes
# through run-gate.sh. Never on a dirty tree: the file is restored with `git checkout`.
set -uo pipefail

if [[ -z "${TEST_DATABASE_URL:-}" || "${TEST_DATABASE_URL}" != "${DATABASE_URL:-}" ]]; then
  echo "hosting-enter-mutation: set TEST_DATABASE_URL and DATABASE_URL to the same private database" >&2
  exit 2
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root" || exit 2
if [[ -n "$(git status --porcelain -- apps/api/src)" ]]; then
  echo "hosting-enter-mutation: apps/api/src has uncommitted changes; commit or stash them first" >&2
  exit 2
fi

H=apps/api/src/modules/platform/hosting
I=apps/api/src/modules/platform/identity
ENTER_SUITE=tests/integration/hosting-enter.test.ts
WRITERS_SUITE=tests/unit/impersonation-secret-writers.test.ts

# name | file | perl substitution (a literal pipe is \x7c) | suite
MUTATIONS=(
  "single-use|$H/infrastructure/drizzle-hosting-enter.repository.ts|s/isNull\\(hostingEnterTokens.usedAt\\),//|$ENTER_SUITE"
  "expiry|$H/infrastructure/drizzle-hosting-enter.repository.ts|s/gt\\(hostingEnterTokens.expiresAt, input.now\\),//|$ENTER_SUITE"
  "audience-domain|$H/infrastructure/drizzle-hosting-enter.repository.ts|s/eq\\(hostingEnterTokens.domain, input.domain\\),//|$ENTER_SUITE"
  "no-hosted-audit|apps/api/src/modules/platform/audit/infrastructure/drizzle-audit-writer.ts|s/tenantId: entered === undefined \\? scopeTenantId\\(scope\\) : entered.installationTenantId,/tenantId: scopeTenantId(scope),/|$ENTER_SUITE"
  "guard-denied-permissions|apps/api/src/modules/platform/access/application/permission-guard.ts|s/for \\(const key of IMPERSONATION_DENIED_PERMISSIONS\\) kept.delete\\(key\\);//|$ENTER_SUITE"
  "secret-writer-gateway|apps/api/src/modules/commerce/payments/application/payment-gateway.service.ts|s/refuseImpersonatedSecretWrite\\(actor, 'payment_gateway.api_key'\\);//|$ENTER_SUITE"
  "secret-writer-bot-token|apps/api/src/modules/platform/tenancy/application/bot-management.service.ts|s/refuseImpersonatedSecretWrite\\(actor, 'bot_instance.token'\\);//|$WRITERS_SUITE"
  "secret-writer-2fa|$I/application/account-security.service.ts|s/refuseImpersonatedSecretWrite\\(actor, 'admin.totp_secret'\\);//|$ENTER_SUITE"
  "password-change|$I/application/admin-management.service.ts|s/refuseImpersonatedAccountChange\\(actor, 'admin.password_change'\\);//|$ENTER_SUITE"
  "owner-session-liveness|$H/infrastructure/drizzle-hosting-enter.repository.ts|s/isNull\\(adminSessions.revokedAt\\),\\n            gt\\(adminSessions.expiresAt, now\\),//|$ENTER_SUITE"
  "section-close-revokes|$H/application/hosting-section.service.ts|s/await this.endEnteredSessions\\(installation, actor.id as string, now\\);//|$ENTER_SUITE"
  "data-export-explicit|apps/api/src/modules/platform/data-export/application/data-export.service.ts|s/refuseImpersonatedHostAction\\(actor, action\\);//|$ENTER_SUITE"
  "data-export-denied-key|packages/contracts/src/permissions.ts|s/'hosting.manage',\\n  'data.export',/'hosting.manage',/|$ENTER_SUITE"
  "host-target|$I/application/admin-management.service.ts|s/if \\(admin.kind === 'HOST'\\) \\{/if (false) {/|$ENTER_SUITE"
  "host-sign-in|$I/infrastructure/drizzle-admin.repository.ts|s/if \\(row === undefined \\x7c\\x7c row.kind !== 'OPERATOR' \\x7c\\x7c row.passwordHash === null\\) return null;/if (row === undefined) return null;/|$ENTER_SUITE"
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
  # the apps import @nexa/contracts from its dist: rebuild after touching the source
  if [[ "$file" == packages/contracts/* ]]; then pnpm --filter @nexa/contracts build >/dev/null; fi
  if run_suite "$suite"; then
    echo "== $name: suite stayed GREEN with the rule reverted; FAILED"
    status=1
  else
    echo "== $name: RED, as it must be"
  fi
  git checkout -- "$file"
  if [[ "$file" == packages/contracts/* ]]; then pnpm --filter @nexa/contracts build >/dev/null; fi
done

echo "== restored: the untouched suites"
if run_suite "$WRITERS_SUITE" && run_suite "$ENTER_SUITE"; then
  echo "== restored: GREEN"
else
  echo "== restored: RED; FAILED"
  status=1
fi
exit "$status"
