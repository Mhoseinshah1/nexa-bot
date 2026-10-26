#!/usr/bin/env bash
# Self-test for test-summary.sh against captured/real-shaped outputs.
# Commands are faked with `bash -c 'cat <fixture>; exit N'`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fx="$here/fixtures/test-summary"
ts="${TEST_SUMMARY:-$here/test-summary.sh}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export TEST_SUMMARY_DIR="$work"
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; echo "$2" | sed 's/^/     /'; fail=1; }

# run <fixture> <exit code> -> the summary on stdout, with the script's own exit
# code lost on purpose (callers needing it call bash "$ts" directly).
run() { bash "$ts" bash -c 'cat "$1"; exit "$2"' _ "$fx/$1" "$2" || true; }
from() { bash "$ts" --from "$fx/$1"; }
has() { # description, output, needle
  if grep -qF -- "$3" <<<"$2"; then ok "$1"; else bad "$1" "$2"; fi
}
lacks() {
  if grep -qF -- "$3" <<<"$2"; then bad "$1" "$2"; else ok "$1"; fi
}
eq() { # description, got, want
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (got '$2', want '$3')" ""; fi
}
firstline() { sed -n '1p' <<<"$1"; }
lastline() { tail -n1 <<<"$1" | sed 's/ log=.*//'; }
nlines() { wc -l <<<"$1" | tr -d ' '; }

# --- a passing run: two lines, counts summed over both vitest runs ------------
out="$(run vitest-pass-multi.txt 0)"
eq "pass: counts summed over two projects" "$(firstline "$out")" "passed=64 failed=0 skipped=3"
eq "pass: whole output is two lines" "$(nlines "$out")" "2"
eq "pass: exit line" "$(lastline "$out")" "exit=0"

# --- two failures with long stack traces --------------------------------------
out="$(run vitest-fail-long.txt 1)"
eq "fail: counts" "$(firstline "$out")" "passed=10 failed=2 skipped=3"
has "fail: first test, project label dropped" "$out" "tests/unit/wallet.test.ts › wallet › debit › never overdraws"
has "fail: second test from the other project" "$out" "tests/web/payment-gateways.test.tsx › payment gateways › hides the secret field"
has "fail: error message kept" "$out" "  AssertionError: expected 1n to be 2n // Object.is equality"
eq "fail: no pnpm stage on top of the tests" "$(grep -c '^stage:' <<<"$out" || true)" "0"
w1="$(awk '/^tests\/unit\/wallet/{f=1;next} /^tests\/web/{f=0} f' <<<"$out" | wc -l | tr -d ' ')"
w2="$(awk '/^tests\/web\/payment/{f=1;next} /^exit=/{f=0} f' <<<"$out" | wc -l | tr -d ' ')"
eq "fail: first block cut at 20 lines" "$w1" "20"
eq "fail: second block cut at 20 lines" "$w2" "20"
lacks "fail: line 21 of the first block is gone" "$out" "chunk-5.js"
has "fail: line 20 of the first block is kept" "$out" "chunk-4.js"
lacks "fail: line 21 of the second block is gone" "$out" "stack detail line 20"
lacks "fail: no separator rules leak in" "$out" "⎯⎯⎯"
if grep -q $'\033' <<<"$out"; then bad "fail: no ANSI left" "$out"; else ok "fail: no ANSI left"; fi
eq "fail: exit line" "$(lastline "$out")" "exit=1"

# --- exit code propagation -----------------------------------------------------
rc=0; bash "$ts" bash -c 'cat "$1"; exit 1' _ "$fx/vitest-fail-long.txt" >/dev/null || rc=$?
eq "exit code 1 propagates" "$rc" "1"
rc=0; out="$(bash "$ts" bash -c 'cat "$1"; exit 7' _ "$fx/vitest-fail-long.txt")" || rc=$?
eq "exit code 7 propagates" "$rc" "7"
eq "exit line shows 7" "$(lastline "$out")" "exit=7"
rc=0; bash "$ts" bash -c 'cat "$1"; exit 0' _ "$fx/vitest-pass-multi.txt" >/dev/null || rc=$?
eq "exit code 0 propagates" "$rc" "0"
rc=0; out="$(bash "$ts" no-such-command-xyz)" || rc=$?
eq "missing command: 127 propagates" "$rc" "127"
has "missing command: reported as a failed command stage" "$out" "stage: command"
rc=0; out="$(bash "$ts" bash -c 'echo some output; echo boom >&2; exit 3')" || rc=$?
eq "unrecognised failure: exit 3 propagates" "$rc" "3"
has "unrecognised failure: stage command" "$out" "stage: command"
has "unrecognised failure: tail of the log shown" "$out" "  boom"
eq "unrecognised failure: counted once" "$(firstline "$out")" "passed=0 failed=1 skipped=0"
rc=0; bash "$ts" >/dev/null 2>&1 || rc=$?
eq "no arguments: usage, exit 2" "$rc" "2"

# --- the log: path on the last line, raw output kept ---------------------------
out="$(run vitest-fail-long.txt 1)"
logpath="$(tail -n1 <<<"$out" | sed 's/^.* log=//')"
if [[ -f "$logpath" && "$logpath" == "$work"/* ]]; then ok "log: path on the last line exists"; else bad "log: path on the last line exists" "$logpath"; fi
if cmp -s "$logpath" "$fx/vitest-fail-long.txt"; then ok "log: raw output kept verbatim"; else bad "log: raw output kept verbatim" "$logpath"; fi

# --- --from: file, stdin, derived exit code ------------------------------------
rc=0; out="$(from vitest-fail-long.txt)" || rc=$?
eq "--from file: exit 1 when failures" "$rc" "1"
has "--from file: names the failure" "$out" "never overdraws"
rc=0; out="$(from vitest-pass-multi.txt)" || rc=$?
eq "--from file: exit 0 when clean" "$rc" "0"
rc=0; out="$(bash "$ts" --from - <"$fx/tsc-fail.txt")" || rc=$?
eq "--from -: reads stdin, exit 1" "$rc" "1"
has "--from -: summarises it" "$out" "stage: typecheck"
logpath="$(tail -n1 <<<"$out" | sed 's/^.* log=//')"
if cmp -s "$logpath" "$fx/tsc-fail.txt"; then ok "--from -: stdin saved as the log"; else bad "--from -: stdin saved as the log" "$logpath"; fi

# --- a real vitest 4 run (captured, no colour) ---------------------------------
out="$(from vitest-real-v4.txt || true)"
eq "real vitest: counts" "$(firstline "$out")" "passed=6 failed=2 skipped=1"
has "real vitest: assertion test name" "$out" "tests/unit/zz-tmp.test.ts › alpha › beta › adds"
has "real vitest: thrown test name" "$out" "tests/unit/zz-tmp.test.ts › alpha › beta › throws"
has "real vitest: multi-line message kept" "$out" "  second line"
has "real vitest: code frame kept" "$out" "     it('adds', () => { expect(1 + 1).toBe(3); });"

# --- tsc ------------------------------------------------------------------------
out="$(run tsc-fail.txt 2 || true)"
eq "tsc: one failed stage" "$(firstline "$out")" "passed=0 failed=1 skipped=0"
has "tsc: stage named from the pnpm header" "$out" "stage: typecheck"
has "tsc: error line" "$out" "wallet.ts(40,17): error TS2345"
has "tsc: continuation line kept" "$out" "Type 'number' is not assignable to type 'bigint'."
eq "tsc: exit line" "$(lastline "$out")" "exit=2"

# --- pnpm verify stops at lint --------------------------------------------------
out="$(run verify-lint-fail.txt 1 || true)"
eq "verify/lint: one failed stage" "$(firstline "$out")" "passed=0 failed=1 skipped=0"
has "verify/lint: stage is lint" "$out" "stage: lint"
lacks "verify/lint: passed typecheck not reported" "$out" "stage: typecheck"
lacks "verify/lint: parent verify not reported" "$out" "stage: verify"
has "verify/lint: error line with file:line" "$out" "apps/web/src/Page.tsx:7:10  error  'x' is defined but never used"
lacks "verify/lint: warnings ignored" "$out" "Missing return type"
eq "verify/lint: stage reported once" "$(grep -c '^stage:' <<<"$out" || true)" "1"

# --- pnpm verify reaches the tests: the stage is its tests, not an extra failure
out="$(run verify-test-fail.txt 1 || true)"
eq "verify/test: failed counts the test once" "$(firstline "$out")" "passed=4 failed=1 skipped=0"
has "verify/test: test named" "$out" "tests/unit/order.test.ts › order › refund › reverses cashback"
eq "verify/test: no stage line" "$(grep -c '^stage:' <<<"$out" || true)" "0"

# --- a generic stage: the tail of its output ------------------------------------
out="$(run check-shell-fail.txt 1 || true)"
has "generic stage: named" "$out" "stage: check:shell"
has "generic stage: detail lines kept" "$out" "SC2034 (warning): x appears unused"

# --- suites that failed to load share one error (vitest prints it once) -----------
out="$(run vitest-suites-fail.txt 1)"
eq "suites: each failed suite counts" "$(firstline "$out")" "passed=6 failed=3 skipped=0"
has "suites: first suite named" "$out" "tests/web/terms.test.tsx"
has "suites: folded suites listed" "$out" "  also: tests/web/audit-log.test.tsx"
eq "suites: the shared error appears once" "$(grep -c 'Failed to resolve import' <<<"$out" || true)" "1"
eq "suites: no stage on top of them" "$(grep -c '^stage:' <<<"$out" || true)" "0"

# --- the cap ---------------------------------------------------------------------
many="$work/many.txt"
{
  echo "> nexa-bot@0.0.0 test /repo"
  echo " RUN  v4.1.11 /repo"
  echo "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 60 ⎯⎯⎯⎯⎯⎯⎯"
  for i in $(seq 1 60); do
    echo " FAIL  |unit| tests/unit/t$i.test.ts > suite > case $i"
    echo "AssertionError: expected $i to be 0"
    for j in $(seq 1 9); do echo " ❯ frame $j"; done
    echo "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[$i/60]⎯"
  done
  echo " Test Files  60 failed (60)"
  echo "      Tests  60 failed | 5 passed (65)"
} >"$many"
rc=0; out="$(bash "$ts" bash -c 'cat "$1"; exit 1' _ "$many")" || rc=$?
eq "cap: at most 200 lines" "$([ "$(nlines "$out")" -le 200 ] && echo yes || echo no)" "yes"
eq "cap: counts still cover all failures" "$(firstline "$out")" "passed=5 failed=60 skipped=0"
shown="$(grep -c ' › suite › case ' <<<"$out" || true)"
more="$(sed -n 's/^… \([0-9]*\) more failures$/\1/p' <<<"$out")"
eq "cap: '… K more failures' accounts for every hidden failure" "$((shown + more))" "60"
if [ "$shown" -gt 0 ] && [ "$more" -gt 0 ]; then ok "cap: some shown, some hidden ($shown/$more)"; else bad "cap: some shown, some hidden" "$shown/$more"; fi
eq "cap: exit line still last" "$(lastline "$out")" "exit=1"
eq "cap: a failure is never cut in the middle" "$(grep -c 'AssertionError' <<<"$out" || true)" "$shown"
rc=0; out="$(TEST_SUMMARY_MAX=30 bash "$ts" --from "$many")" || rc=$?
eq "cap: TEST_SUMMARY_MAX honoured" "$([ "$(nlines "$out")" -le 30 ] && echo yes || echo no)" "yes"

# --- deterministic ----------------------------------------------------------------
a="$(from vitest-fail-long.txt | sed 's/ log=.*//' || true)"
b="$(from vitest-fail-long.txt | sed 's/ log=.*//' || true)"
eq "deterministic" "$a" "$b"
exit "$fail"
