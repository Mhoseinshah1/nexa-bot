#!/usr/bin/env bash
# Self-test for ci-status.sh: a fake `gh` (fixtures/ci-status/gh) first on PATH
# serves synthetic fixtures by endpoint and logs every invocation.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fx="$here/fixtures/ci-status"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"; cp "$fx/gh" "$tmp/bin/gh"; chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH" CI_STATUS_REPO=acme/widgets FAKE_LOG="$tmp/gh.log"
fail=0
check() { # description, expected exit, needle, actual exit, output
  if [[ "$4" == "$2" ]] && grep -qF -- "$3" <<<"$5"; then echo "ok   $1"; else echo "FAIL $1 (exit $4, wanted $2)"; echo "$5" | sed 's/^/     /'; fail=1; fi
}
assert() { # description, condition result (0 = pass), output
  if [[ "$2" == 0 ]]; then echo "ok   $1"; else echo "FAIL $1"; echo "$3" | sed 's/^/     /'; fail=1; fi
}
run() { # scenario, args...  -> sets out, rc
  local sc="$1"; shift
  export FAKE_DIR="$fx/$sc" FAKE_STATE="$tmp/state-$sc-$RANDOM"; mkdir -p "$FAKE_STATE"
  set +e; out="$(bash "$here/ci-status.sh" "$@" 2>&1)"; rc=$?; set -e
}
: >"$FAKE_LOG"

run green 315
check "all green exits 0 with counts" 0 "abcdef01 green=2 pending=0 red=0 skipped=1" "$rc" "$out"
run pending 315
check "pending exits 2" 2 "green=1 pending=2 red=0 skipped=0" "$rc" "$out"
run nochecks 315
check "no check run yet is pending, never green" 2 "green=0 pending=0 red=0 skipped=0" "$rc" "$out"
run red 315
check "red beats pending: exit 1, names listed" 1 "red=2 skipped=0 [red: unit, build]" "$rc" "$out"
: >"$FAKE_LOG"
run green abcdef0123456789abcdef0123456789abcdef01
check "a sha is used directly" 0 "abcdef01 green=2" "$rc" "$out"
assert "a sha costs no pulls call" "$(grep -q pulls/ "$FAKE_LOG" && echo 1 || echo 0)" "$(cat "$FAKE_LOG")"

run gate 315 --gate
check "gate-only red prints the exact rerun command" 1 "gate-only-red: rerun with gh api -X POST repos/acme/widgets/actions/runs/987654/rerun-failed-jobs" "$rc" "$out"
assert "the rerun is printed, never executed" "$(grep -c -- '-X POST' "$FAKE_LOG" || true)" ""
run red 315 --gate
check "a non-gate red is not gate-only" 1 "gate-only-red: no" "$rc" "$out"
CI_STATUS_GATE_NAME='^nothing$' run gate 315 --gate
check "CI_STATUS_GATE_NAME overrides the match" 1 "gate-only-red: no" "$rc" "$out"

run logs 315 --fail-logs
check "fail-logs names the job" 1 "--- unit (12)" "$rc" "$out"
check "fail-logs shows the marker line" 1 "##[error]Process completed" "$rc" "$out"
body="$(sed -n '/^--- unit (12)/,/^--- build/p' <<<"$out" | grep -c '^line ' || true)"
assert "fail-logs cap: at most 20 lines from a 200-line log (got $body)" "$(((body >= 1 && body <= 20) ? 0 : 1))" "$out"
assert "fail-logs never prints the whole log" "$(grep -qF 'line 200 ' <<<"$out" && echo 1 || echo 0)" "$out"
check "blob redirect falls back to the MCP call" 1 "use MCP: mcp__github__get_job_logs owner=acme repo=widgets job_id=14 return_content=true tail_lines=200" "$rc" "$out"

run codex --codex 315
check "codex summary line" 0 "codex comments=2 unresolved=1 reviewed=abcdef01 head=abcdef01" "$rc" "$out"
check "codex P1 finding with first sentence" 0 "P1 src/a.ts:42 — Refund twice on retry" "$rc" "$out"
check "codex P2 falls back to original_line" 0 "P2 src/b.ts:7 — Missing await on the lookup." "$rc" "$out"
assert "a human comment is not reported" "$(grep -q 'src/c.ts' <<<"$out" && echo 1 || echo 0)" "$out"
run codex-nothreads --codex 315
check "a failing threads endpoint reports threads=unknown" 0 "threads=unknown" "$rc" "$out"

# Codex posts nothing inline when it finds nothing: its verdict is the hidden
# codex-review-state marker in the "Codex Review Summary" ISSUE comment.
run codex-clean --codex 315
check "codex marker: reviewed is the marker's commit_sha, not none" 0 "codex comments=0 threads=unknown reviewed=abcdef01 head=abcdef01 findings=none status=completed" "$rc" "$out"
run codex-findings --codex 315
check "codex marker with findings: findings=yes" 0 "reviewed=abcdef01 head=abcdef01 findings=yes" "$rc" "$out"
check "codex marker: inline findings are still listed" 0 "P1 src/a.ts:42 — Refund twice on retry" "$rc" "$out"
run codex --codex 315
assert "no marker: no findings= claim is made" "$(grep -q 'findings=' <<<"$out" && echo 1 || echo 0)" "$out"

# Only the real Codex App speaks for Codex: exact login AND type Bot. codex-clean carries newer
# markers claiming findings from "codex-fan" (User), "chatgpt-codex-connector" (User),
# "codex-impostor[bot]" (Bot) and the exact bot login with type User; none may override the
# real bot's clean verdict.
run codex-clean --codex 315
assert "lookalike logins are not Codex: the real bot's verdict stands" "$(grep -q 'reviewed=abcdef01 head=abcdef01 findings=none' <<<"$out" && echo 0 || echo 1)" "$out"
run codex-findings --codex 315
assert "a lookalike's inline comment is not a Codex finding" "$(grep -qE 'src/z.ts|forged|comments=3' <<<"$out" && echo 1 || echo 0)" "$out"
check "inline: only the real bot's comments are counted" 0 "codex comments=2 " "$rc" "$out"

# The summary on page 2 of the issue comments is found: --paginate, every page.
: >"$FAKE_LOG"
run codex-pages --codex 315
check "a summary only on page 2 is read (reviewed + findings=none)" 0 "reviewed=abcdef01 head=abcdef01 findings=none status=completed" "$rc" "$out"
assert "the issue-comments request is paginated" "$(grep -q -- 'issues/315/comments.*--paginate' "$FAKE_LOG" && echo 0 || echo 1)" "$(cat "$FAKE_LOG")"

# 240 KB of human chatter next to the marker: must not be an env var (E2BIG), must still report.
run codex-big --codex 315
check "a huge issue-comment payload does not break --codex" 0 "reviewed=abcdef01 head=abcdef01 findings=none" "$rc" "$out"

# The receipt comment ("Didn't find any major issues", "Reviewed commit") and Codex's 👍
# reaction. Lookalike logins are ignored; a 👍 older than the head's first check suite (its
# push) is stale.
run codex-receipt --codex 315
check "receipt: clean review of the head, no marker" 0 "reviewed=abcdef01 head=abcdef01 findings=none receipt=abcdef01:clean thumbsup=head" "$rc" "$out"
run codex-stale --codex 315
check "receipt of an older head; the bot's 👍 predates the head's push" 0 "reviewed=11111111 head=abcdef01 findings=none receipt=11111111:clean thumbsup=stale" "$rc" "$out"
run codex-receipt-findings --codex 315
check "a receipt with suggestions is findings, never findings=none" 0 "reviewed=abcdef01 head=abcdef01 receipt=abcdef01:findings" "$rc" "$out"
# Two reviews of the head: the FIRST receipt is the one acted on, even when a later one is clean.
# A 👍 with no check suite for the head cannot be tied to it.
run codex-dup --codex 315
check "two receipts for the head: the first one (findings) is reported" 0 "reviewed=abcdef01 head=abcdef01 receipt=abcdef01:findings thumbsup=unknown" "$rc" "$out"
assert "the later clean receipt does not turn the head clean" "$(grep -q 'findings=none' <<<"$out" && echo 1 || echo 0)" "$out"
run codex --codex 315
assert "no receipt, no reaction: neither is claimed" "$(grep -qE 'receipt=|thumbsup=' <<<"$out" && echo 1 || echo 0)" "$out"

run wait --wait 315 --every 0 --max 5
check "wait polls until nothing is pending, then exits 0" 0 "green=2 pending=0" "$rc" "$out"
assert "wait printed a summary per poll (2)" "$(((  $(grep -c '^abcdef01' <<<"$out") == 2) ? 0 : 1))" "$out"
run pending --wait 315 --every 1 --max 1
check "wait gives up at max with exit 2" 2 "pending=2" "$rc" "$out"

# repo slug from origin, proxy prefix and .git stripped
mkdir "$tmp/r" && git -C "$tmp/r" init -q && git -C "$tmp/r" remote add origin http://local_proxy@127.0.0.1:5555/git/acme/gizmo.git
: >"$FAKE_LOG"
export FAKE_DIR="$fx/green" FAKE_STATE="$tmp/state-slug"; mkdir -p "$FAKE_STATE"
set +e; out="$(cd "$tmp/r" && env -u CI_STATUS_REPO bash "$here/ci-status.sh" 315 2>&1)"; rc=$?; set -e
check "slug derived from a proxied origin" 0 "green=2" "$rc" "$out"
assert "slug is owner/repo only" "$(grep -qF 'api repos/acme/gizmo/pulls/315' "$FAKE_LOG" && echo 0 || echo 1)" "$(cat "$FAKE_LOG")"

# GraphQL-free across everything this run did
: >"$FAKE_LOG"
for sc in green red gate logs codex; do run "$sc" 315 --fail-logs --gate; done
run codex --codex 315
log="$(cat "$FAKE_LOG")"
assert "invocation log is REST-only (no 'pr ', 'run view', 'graphql')" "$(grep -Eq '(^|[^a-z])pr |run view|graphql' <<<"$log" && echo 1 || echo 0)" "$log"
assert "every call is gh api repos/..." "$(grep -vq '^api repos/' <<<"$log" && echo 1 || echo 0)" "$log"
exit "$fail"
