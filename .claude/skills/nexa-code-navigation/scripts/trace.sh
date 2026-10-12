#!/usr/bin/env bash
# trace.sh <term> [max-per-layer]
#
# Lists the files that mention <term> in each layer of the request path, in
# order: web page -> web API client -> surface (web/telegram/gateway) ->
# application -> domain -> infrastructure -> schema/migrations -> contracts
# -> tests -> docs. File names only, capped per layer, so the answer costs a
# few hundred tokens instead of a directory read.
#
# Read-only. Needs ripgrep (rg) or falls back to grep -rl.
set -euo pipefail

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "usage: trace.sh <term> [max-per-layer]" >&2
  exit 2
fi
term="$1"
max="${2:-8}"
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root"

search() {
  # $1 = path (may not exist), remaining = glob filters for rg
  local path="$1"; shift
  [[ -e "$path" ]] || return 0
  if command -v rg >/dev/null 2>&1; then
    rg -l -i --fixed-strings "$@" -- "$term" "$path" 2>/dev/null || true
  else
    grep -rl -i --fixed-strings -- "$term" "$path" 2>/dev/null || true
  fi
}

layer() {
  local label="$1"; shift
  local hits total
  hits="$(search "$@" | sort)"
  if [[ -z "$hits" ]]; then
    return 0
  fi
  total="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
  printf '## %s (%s)\n' "$label" "$total"
  printf '%s\n' "$hits" | head -n "$max"
  if (( total > max )); then
    printf '  ... %s more (narrow the term or raise the cap)\n' "$((total - max))"
  fi
}

layer "web page"          apps/web/src/pages
layer "web shell/client"  apps/web/src --glob '!**/pages/**'
layer "surface: web"      apps/api/src/surfaces/web
layer "surface: telegram" apps/api/src/surfaces/telegram
layer "surface: gateway"  apps/api/src/surfaces/gateway
layer "application"       apps/api/src/modules --glob '**/application/**'
layer "domain"            apps/api/src/modules --glob '**/domain/**'
layer "module infra"      apps/api/src/modules --glob '**/infrastructure/**'
layer "infrastructure"    apps/api/src/infrastructure --glob '!**/persistence/schema.ts'
layer "schema.ts"         apps/api/src/infrastructure/persistence/schema.ts
layer "migrations"        apps/api/drizzle --glob '*.sql'
layer "contracts"         packages/contracts/src
layer "i18n"              packages/i18n/src
layer "tests: unit"       tests/unit
layer "tests: web"        tests/web
layer "tests: integration" tests/integration
layer "docs"              docs --glob '!**/research/**'
