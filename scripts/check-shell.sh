#!/usr/bin/env bash
# Static analysis for shell, in two tiers.
#
# The installer runs as root and the updater decides what code an installation
# executes. Both are supply-chain surfaces, and both are shell — a language
# where an unquoted expansion is a vulnerability rather than a style problem.
# So `deploy/` is held to shellcheck's INFO level, which includes the unquoted-
# variable and word-splitting findings.
#
# `scripts/` are development and CI helpers: they run with the privileges of
# whoever is already running the build. They are held to WARNING, which is
# where the genuine robustness findings live.
#
# Two exclusions apply to both tiers, and each is a deliberate judgement:
#
#   SC1091  "not following" a sourced file. Every sourced file here is checked
#           as a file in its own right, so following it would report the same
#           findings twice; and the paths are variables, which shellcheck
#           cannot resolve statically.
#   SC2016  "expressions don't expand in single quotes". Several scripts embed
#           Python source or prose containing `$` and backticks, where NOT
#           expanding is the entire point. The individual sites carry a
#           `# shellcheck disable` with the reason; this keeps the tier clean
#           without hiding anything a reader cannot see at the site.
#
# Skipped with a clear message when shellcheck is absent, because a check that
# silently passes when its tool is missing is worse than no check at all.
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

if ! command -v shellcheck >/dev/null 2>&1; then
  printf '\033[33mskip\033[0m  shellcheck is not installed; the CI job runs it.\n'
  printf '      install it locally with: apt-get install shellcheck\n'
  exit 0
fi

fail() {
  printf '\033[31mFAIL\033[0m  %s\n' "$1" >&2
  exit 1
}

# --- Tier 1: the privileged deployment shell ---------------------------------
mapfile -t PRIVILEGED < <(
  find deploy tests/deploy -type f \( -name '*.sh' -o -name 'botctl' \) 2>/dev/null | sort
)
[ ${#PRIVILEGED[@]} -gt 0 ] || fail "no deployment scripts found; the glob is wrong."

shellcheck -x -s bash --severity=info --exclude=SC1091,SC2016 "${PRIVILEGED[@]}" ||
  fail "the privileged deployment shell has findings at INFO or above."
printf '\033[32mok\033[0m    %d privileged scripts clean at shellcheck info\n' "${#PRIVILEGED[@]}"

# --- Tier 2: development and CI helpers --------------------------------------
mapfile -t HELPERS < <(find scripts -type f -name '*.sh' 2>/dev/null | sort)
[ ${#HELPERS[@]} -gt 0 ] || fail "no helper scripts found; the glob is wrong."

shellcheck -x -s bash --severity=warning --exclude=SC1091,SC2016 "${HELPERS[@]}" ||
  fail "a helper script has findings at WARNING or above."
printf '\033[32mok\033[0m    %d helper scripts clean at shellcheck warning\n' "${#HELPERS[@]}"
