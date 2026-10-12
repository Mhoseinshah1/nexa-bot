#!/usr/bin/env bash
# Self-test for select-tests.sh. Run: bash .claude/skills/nexa-test-selection/scripts/select-tests.test.sh
# Asserts against real files in this repository, so a rename that breaks a
# selection rule fails here instead of silently selecting nothing.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sel="$here/select-tests.sh"
fail=0
expect() { # description, needle, output
  if grep -qF -- "$2" <<<"$3"; then echo "ok   $1"; else echo "FAIL $1 (missing: $2)"; fail=1; fi
}
reject() {
  if grep -qF -- "$2" <<<"$3"; then echo "FAIL $1 (unexpected: $2)"; fail=1; else echo "ok   $1"; fi
}

out="$(bash "$sel" --files tests/unit/gateway-health.test.ts)"
expect "a changed test selects itself" "--project unit tests/unit/gateway-health.test.ts" "$out"
reject "a test-only change adds no integration" "--project integration" "$out"

out="$(bash "$sel" --files apps/api/src/modules/commerce/payments/application/gateway-payment-loop.ts)"
expect "a source file selects its direct unit importer" "tests/unit/gateway-payment-loop.test.ts" "$out"
expect "payments is a money change" "# money:" "$out"
expect "payments keeps the refund suite" "tests/integration/refunds.test.ts" "$out"

out="$(bash "$sel" --files apps/api/drizzle/0247_gateway_row_failures.sql)"
expect "a migration asks for db:check" "pnpm db:check" "$out"
expect "a migration runs migration-* suites" "tests/integration/migration-ordering.test.ts" "$out"
reject "a NEXA migration does not pull the legacy importer suites" "legacy-migration.test.ts" "$out"

out="$(bash "$sel" --files deploy/bin/botctl)"
expect "deploy runs the shell and botctl logic" "pnpm check:shell && pnpm test:deploy" "$out"

out="$(bash "$sel" --files packages/contracts/src/payments.ts)"
expect "contracts run the whole unit project" "pnpm check:i18n && pnpm test" "$out"

out="$(bash "$sel" --files apps/api/src/modules/platform/recovery/application/recovery.service.ts)"
expect "recovery is a security change" "# security/recovery" "$out"
expect "recovery keeps the executor suite" "tests/integration/recovery-executor.test.ts" "$out"

out="$(bash "$sel" --files apps/web/src/theme.ts)"
expect "web runs check:i18n" "pnpm check:i18n" "$out"

out="$(bash "$sel" --files README.md)"
expect "every selection ends with the full gate" "pnpm verify" "$out"

exit "$fail"
