#!/usr/bin/env bash
# server-move-mutation.sh - the mutation checks of the Phase 6B PR-4 server move (ADR-0039 § 8).
#
#   TEST_DATABASE_URL=... DATABASE_URL=... bash scripts/claude/server-move-mutation.sh [name...]
#
# Each mutation reverts ONE rule in the source, runs the suite that pins it (unit, integration
# against the PRIVATE database the two URLs name, or the fake-docker deploy suite) and restores
# the file with `git checkout`. A mutation passes when its suite turns RED; the untouched suites
# must then be GREEN. Every run goes through run-gate.sh. Never on a dirty tree.
set -uo pipefail

if [[ -z "${TEST_DATABASE_URL:-}" || "${TEST_DATABASE_URL}" != "${DATABASE_URL:-}" ]]; then
  echo "server-move-mutation: set TEST_DATABASE_URL and DATABASE_URL to the same private database" >&2
  exit 2
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root" || exit 2
if [[ -n "$(git status --porcelain -- apps/api/src deploy/bin)" ]]; then
  echo "server-move-mutation: apps/api/src or deploy/bin has uncommitted changes; commit them first" >&2
  exit 2
fi

B=apps/api/src/modules/platform/backup
UNIT=tests/unit/server-move.test.ts
INTEGRATION=tests/integration/isolation-proof/server-move.test.ts
DEPLOY=tests/deploy/server-move.test.sh

# name | file | perl substitution (a literal pipe is \x7c) | suite
MUTATIONS=(
  "member-verified|$B/infrastructure/server-move.ts|s/run.verifiedAt !== null &&//|$UNIT"
  "member-checksum|$B/infrastructure/move-bundle.ts|s/if \\(got.sha256 !== member.sha256 \\x7c\\x7c got.bytes !== member.bytes\\) \\{/if (false) {/|$UNIT"
  "head-newer|$B/infrastructure/server-move.ts|s/if \\(verdict === 'NEWER'\\)/if (false)/|$UNIT"
  "hosted-digest|$B/infrastructure/server-move.ts|s/actual !== expected \\x7c\\x7c //|$UNIT"
  "hosted-extra|$B/infrastructure/server-move.ts|s/if \\(live.extraTables.length > 0\\)/if (false)/|$UNIT"
  "secret-names|$B/infrastructure/move-bundle.ts|s/secretNames: z.array\\(z.enum\\(MOVE_ENVIRONMENT_SECRET_NAMES\\)\\)/secretNames: z.array(z.string())/|$UNIT"
  "move-not-delivered|$B/application/tenant-archive.service.ts|s/ && input.trigger !== 'MOVE'//|$UNIT"
  "seal-with-bundle-password|$B/infrastructure/archiver.ts|s/input.password === undefined\\n/true\\n/|$INTEGRATION"
  "verify-with-bundle-password|$B/application/backup.service.ts|s/\\.\\.\\.\\(sealPassword === undefined \\? \\{\\} : \\{ passwords: \\[sealPassword\\] \\}\\),//|$INTEGRATION"
  "recovery-source-move|apps/api/src/modules/platform/recovery/application/recovery.service.ts|s/source: 'MOVE',\\n      stage: 'RECEIVE_UPLOAD'/source: 'UPLOAD',\\n      stage: 'RECEIVE_UPLOAD'/|$INTEGRATION"
  "freeze-refusal|deploy/bin/botctl|s/\\[ ! -e \"\\\$\\(move_frozen_file\\)\" \\] && return 0/return 0/|$DEPLOY"
  "bundle-sha-check|deploy/bin/botctl|s/\\[ \"\\\$got\" = \"\\\$sha\" \\] \\x7c\\x7c/true \\x7c\\x7c/|$DEPLOY"
)

run_suite() {
  local status
  if [[ "$1" == tests/unit/* ]]; then
    bash scripts/claude/run-gate.sh pnpm exec vitest run --project unit "$@" | grep -E '^(passed=|exit=)'
  elif [[ "$1" == tests/deploy/* ]]; then
    bash scripts/claude/run-gate.sh bash "$1" | grep -E '^(passed=|exit=)'
  else
    bash scripts/claude/run-gate.sh --integration pnpm exec vitest run --project integration "$@" |
      grep -E '^(passed=|exit=)'
  fi
  status="${PIPESTATUS[0]}"
  return "$status"
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
if run_suite "$UNIT" && run_suite "$DEPLOY" && run_suite "$INTEGRATION"; then
  echo "== restored: GREEN"
else
  echo "== restored: RED; FAILED"
  status=1
fi
exit "$status"
