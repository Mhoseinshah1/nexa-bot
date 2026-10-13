#!/usr/bin/env bash
# select-tests.sh [--base <ref>] [--files <path>...]
#
# Prints the targeted test commands for a change, plus the guard checks its
# risk class requires. It only PRINTS commands; it runs nothing.
#
# Changed files come from git (committed since the merge-base with <ref>,
# default origin/main, plus staged, unstaged and untracked), or from --files.
#
# Selection, in order:
#   1. a changed test file selects itself;
#   2. a changed source file selects every test that imports it by path
#      (one hop — indirect consumers are caught by typecheck and the full gate);
#   3. a risk class (money, migration, security/recovery, legacy import,
#      deploy, contracts/i18n, web) adds its standing guard suites.
# It never removes anything from `pnpm verify`; that gate still runs before a
# PR is marked ready and before any release.
set -euo pipefail

base="origin/main"
files=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) base="$2"; shift 2 ;;
    --files) shift; while [[ $# -gt 0 && "$1" != --* ]]; do files+=("$1"); shift; done ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

root="$(git rev-parse --show-toplevel)"
cd "$root"

if [[ ${#files[@]} -eq 0 ]]; then
  # An unresolvable base must not read as "nothing changed": that would
  # silently select no tests for a branch whose changes are all committed.
  if ! mb="$(git merge-base HEAD "$base" 2>/dev/null)"; then
    echo "cannot find a merge-base with '$base' (git fetch origin main, or pass --base/--files)" >&2
    exit 2
  fi
  mapfile -t files < <(
    {
      git diff --name-only "$mb" HEAD
      git diff --name-only HEAD
      git ls-files --others --exclude-standard
    } | sort -u
  )
fi

if [[ ${#files[@]} -eq 0 ]]; then
  echo "no changed files"
  exit 0
fi

declare -A unit=() web=() integ=() checks=() whole=()
grep_tests() { # $1 = fixed string, $2 = dir
  if command -v rg >/dev/null 2>&1; then
    rg -l --fixed-strings -- "$1" "$2" 2>/dev/null || true
  else
    grep -rl --fixed-strings -- "$1" "$2" 2>/dev/null || true
  fi
}
add_test() {
  case "$1" in
    tests/unit/*.test.ts) unit["$1"]=1 ;;
    tests/web/*.test.tsx|tests/web/*.test.ts) web["$1"]=1 ;;
    tests/integration/*.test.ts) integ["$1"]=1 ;;
  esac
}
add_integ_matching() { # file-name glob, e.g. '*refund*' or 'migration-*'
  local f
  for f in tests/integration/$1.test.ts; do [[ -e "$f" ]] && integ["$f"]=1; done
}

for f in "${files[@]}"; do
  case "$f" in
    tests/unit/*.test.ts|tests/web/*.test.tsx|tests/web/*.test.ts|tests/integration/*.test.ts)
      add_test "$f"; continue ;;
    # A helper, harness or fixture is imported by many tests, often relatively,
    # so it selects its whole project rather than nothing.
    tests/unit/*) whole[unit]=1; continue ;;
    tests/web/*) whole[web]=1; continue ;;
    tests/integration/*) whole[integration]=1; continue ;;
    tests/support/*|tests/fixtures/*) whole[unit]=1; whole[web]=1; whole[integration]=1; continue ;;
    tests/deploy/*) checks[deploy]=1; continue ;;
    tests/*) continue ;;
  esac

  # 2. direct importers (repo paths behind ../../, extensionless or NodeNext .js)
  case "$f" in
    *.ts|*.tsx|*.mts)
      stem="${f%.*}"
      for d in tests/unit tests/web tests/integration; do
        while IFS= read -r t; do [[ -n "$t" ]] && add_test "$t"; done \
          < <(grep_tests "$stem'" "$d"; grep_tests "$stem\"" "$d"
              grep_tests "$stem.js'" "$d"; grep_tests "$stem.js\"" "$d")
      done
      ;;
  esac

  # 3. risk classes
  case "$f" in
    apps/api/src/modules/commerce/payments/*)
      checks[money]=1; add_integ_matching '*payment*'; add_integ_matching '*refund*'; add_integ_matching '*gateway*' ;;
    apps/api/src/modules/commerce/wallet/*|apps/api/src/modules/commerce/orders/*)
      checks[money]=1; add_integ_matching '*wallet*'; add_integ_matching '*refund*'; add_integ_matching '*order*' ;;
    apps/api/src/modules/commerce/pricing/*|apps/api/src/modules/commerce/resellers/*|apps/api/src/modules/commerce/referrals/*)
      checks[money]=1; add_integ_matching '*pricing*'; add_integ_matching '*cashback*'; add_integ_matching '*discount*'
      add_integ_matching '*reseller*'; add_integ_matching '*referral*' ;;
    apps/api/src/modules/commerce/provisioning/*)
      checks[money]=1; add_integ_matching '*provision*'; add_integ_matching '*refund*' ;;
  esac
  case "$f" in
    apps/api/drizzle/*|apps/api/src/infrastructure/persistence/schema.ts|apps/api/src/infrastructure/persistence/migrat*|apps/api/src/infrastructure/persistence/online-indexes.ts)
      checks[migration]=1; add_integ_matching 'migration-*' ;;
  esac
  case "$f" in
    apps/api/src/modules/platform/identity/*|apps/api/src/modules/platform/access/*|apps/api/src/surfaces/web/auth*|apps/api/src/surfaces/web/account-security*|apps/api/src/surfaces/web/admins*|apps/api/src/infrastructure/crypto/*|apps/api/src/infrastructure/redaction.ts)
      checks[security]=1; add_integ_matching '*auth*'; add_integ_matching '*admin-security*' ;;
    apps/api/src/modules/platform/backup/*|apps/api/src/modules/platform/recovery/*|apps/api/src/main.recovery.ts)
      checks[security]=1; add_integ_matching '*backup*'; add_integ_matching '*recovery*' ;;
    apps/api/src/modules/platform/legacy-*|apps/api/src/infrastructure/nxpkg/*|apps/api/src/main.migration.ts)
      checks[legacy]=1; add_integ_matching 'legacy-migration*' ;;
  esac
  case "$f" in
    deploy/*|scripts/*.sh|Dockerfile|tests/deploy/*) checks[deploy]=1 ;;
    packages/contracts/*|packages/i18n/*) checks[contracts]=1 ;;
    apps/web/*) checks[web]=1 ;;
    .github/workflows/*) checks[ci]=1 ;;
  esac
done

keys_line() { # assoc-array name -> " k1 k2 ..." sorted
  local -n arr=$1
  local k
  while IFS= read -r k; do printf ' %s' "$k"; done < <(printf '%s\n' "${!arr[@]}" | sort)
}

echo "# changed files: ${#files[@]}"
echo "# always, while iterating:"
echo "pnpm typecheck"
# A whole project supersedes its file list.
if [[ -n "${whole[unit]:-}" ]]; then
  unit=()
  echo "pnpm test   # a shared unit helper changed: the whole unit project"
fi
if [[ -n "${whole[web]:-}" ]]; then
  web=()
  echo "pnpm test:web   # a shared web helper changed: the whole web project"
fi
if [[ -n "${whole[integration]:-}" ]]; then
  integ=()
  echo "# a shared integration helper changed: the whole integration project (needs postgres+redis)"
  echo "pnpm test:integration"
fi
if [[ ${#unit[@]} -gt 0 ]]; then
  echo "pnpm exec vitest run --project unit$(keys_line unit)"
fi
if [[ ${#web[@]} -gt 0 ]]; then
  echo "pnpm exec vitest run --project web$(keys_line web)"
fi
if [[ ${#integ[@]} -gt 0 ]]; then
  echo "# integration needs postgres+redis (bash scripts/dev-services.sh); one suite at a time per database"
  echo "pnpm exec vitest run --project integration$(keys_line integ)"
fi
[[ -n "${checks[money]:-}" ]]     && echo "# money: keep every refund/ledger/settlement suite above; never narrow them"
[[ -n "${checks[migration]:-}" ]] && echo "pnpm db:check   # migration drift; see the nexa-migrations skill"
[[ -n "${checks[security]:-}" ]]  && echo "# security/recovery: run the selected auth/backup/recovery suites in full"
[[ -n "${checks[legacy]:-}" ]]    && echo "# legacy import: legacy-migration-* integration suites; CI also runs legacy-mysql and the synthetic rehearsal"
[[ -n "${checks[deploy]:-}" ]]    && echo "pnpm check:shell && pnpm test:deploy"
[[ -n "${checks[contracts]:-}" ]] && echo "pnpm check:i18n && pnpm test   # contracts/i18n are imported everywhere: run the whole unit project"
[[ -n "${checks[web]:-}" ]]       && echo "pnpm check:i18n"
[[ -n "${checks[ci]:-}" ]]        && echo "# workflow change: bash tests/deploy/release-ci-gate.test.sh, and let CI run it"
echo "# before marking a PR ready, and before any release: pnpm verify (+ pnpm test:integration when the change can reach the database)"
