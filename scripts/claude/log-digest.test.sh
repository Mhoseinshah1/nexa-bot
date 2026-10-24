#!/usr/bin/env bash
# Self-test for log-digest.sh against synthetic captured outputs.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fx="$here/fixtures/log-digest"
dg="${LOG_DIGEST:-$here/log-digest.sh}"
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; echo "$2" | sed 's/^/     /'; fail=1; }
run() { bash "$dg" <"$fx/$1"; }
has() { # description, fixture, needle
  local out; out="$(run "$2")"
  if grep -qF -- "$3" <<<"$out"; then ok "$1"; else bad "$1" "$out"; fi
}
last_is() { # description, fixture, expected last line
  local out; out="$(run "$2")"
  if [[ "$(tail -n1 <<<"$out")" == "$3" ]]; then ok "$1"; else bad "$1" "$out"; fi
}

last_is "vitest pass: only the summary" vitest-pass.txt "failed=0 passed=16"
[[ "$(run vitest-pass.txt | wc -l)" -eq 1 ]] && ok "vitest pass prints one line" || bad "vitest pass prints one line" "$(run vitest-pass.txt)"
[[ "$(run pass-only.txt)" == "failed=0 passed=0" ]] && ok "pass-only input prints only the summary" || bad "pass-only input prints only the summary" "$(run pass-only.txt)"

has "vitest: first failing test" vitest-fail.txt "tests/unit/wallet.test.ts › wallet > debit > never overdraws"
has "vitest: second failing test" vitest-fail.txt "tests/unit/order.test.ts › order > refund > reverses cashback"
has "vitest: assertion message" vitest-fail.txt "  AssertionError: expected 1 to be 2"
has "vitest: plain Error message" vitest-fail.txt "  Error: ledger entry missing"
has "vitest: location" vitest-fail.txt "  tests/unit/wallet.test.ts:42"
last_is "vitest: summary" vitest-fail.txt "failed=2 passed=6"
has "vitest project label: failing test" vitest-project-fail.txt "tests/unit/delivery-qr-template.test.ts › composing the QR on a background > draws every module as an exact block"
has "vitest project label: second project" vitest-project-fail.txt "tests/web/payment-gateways.test.tsx › payment gateways > hides the secret field"
has "vitest project label: message" vitest-project-fail.txt "  AssertionError: expected 3 to be 4"
has "vitest project label: location" vitest-project-fail.txt "  tests/web/payment-gateways.test.tsx:64"
last_is "vitest project label: summary" vitest-project-fail.txt "failed=2 passed=20"
out="$(run vitest-fail.txt)"
[[ "$(grep -c '›' <<<"$out")" -eq 2 ]] && ok "vitest: each test once (x mark and FAIL deduped)" || bad "vitest: each test once" "$out"
if grep -q $'\033' <<<"$out"; then bad "no ANSI left in output" "$out"; else ok "no ANSI left in output"; fi

has "tsc: file:line CODE msg" tsc-fail.txt "apps/api/src/modules/wallet/wallet.ts:40 TS2345 Argument of type"
out="$(run tsc-fail.txt)"
[[ "$(grep -c 'order.service.ts:12' <<<"$out")" -eq 1 ]] && ok "tsc: duplicate line deduped" || bad "tsc: duplicate line deduped" "$out"
[[ "$(grep -c ELIFECYCLE <<<"$out")" -eq 1 ]] && ok "tsc: ELIFECYCLE summarised once" || bad "tsc: ELIFECYCLE once" "$out"
last_is "tsc: summary" tsc-fail.txt "failed=2 passed=0"

has "eslint: file:line msg rule" eslint-fail.txt "apps/web/src/Page.tsx:7 'x' is defined but never used @typescript-eslint/no-unused-vars"
out="$(run eslint-fail.txt)"
if grep -q 'explicit-function-return-type' <<<"$out"; then bad "eslint: warnings ignored" "$out"; else ok "eslint: warnings ignored"; fi
last_is "eslint: summary" eslint-fail.txt "failed=2 passed=0"

has "prettier: path listed" prettier-fail.txt "prettier apps/web/src/Page.tsx"
out="$(run prettier-fail.txt)"
if grep -q 'Code style' <<<"$out"; then bad "prettier: trailer dropped" "$out"; else ok "prettier: trailer dropped"; fi
last_is "prettier: summary" prettier-fail.txt "failed=2 passed=0"

has "drizzle-kit: error line" drizzle-fail.txt "Error: Migrations 0155_a.sql and 0155_b.sql collide"
last_is "drizzle-kit: summary" drizzle-fail.txt "failed=1 passed=0"

out="$(run verify-long.txt)"
n="$(wc -l <<<"$out")"
[[ "$n" -le 40 ]] && ok "verify (100 errors): at most 40 lines ($n)" || bad "verify: cap" "$out"
[[ "$(tail -n1 <<<"$out")" == "failed=101 passed=9" ]] && ok "verify: summary is last" || bad "verify: summary last" "$out"
grep -qE '^… [0-9]+ more$' <<<"$out" && ok "verify: truncation marker" || bad "verify: truncation marker" "$out"
[[ "$(tail -n2 <<<"$out" | head -n1)" =~ ^…\ 6[0-9]\ more$ ]] && ok "verify: marker directly before summary" || bad "verify: marker position" "$out"
[[ "$out" == "$(run verify-long.txt)" ]] && ok "deterministic" || bad "deterministic" "$out"
exit "$fail"
