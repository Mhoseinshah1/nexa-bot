#!/usr/bin/env bash
# Self-test for module-map.sh against a small fixture tree.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
script="${MODULE_MAP_SCRIPT:-$here/module-map.sh}"
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
has() { if grep -qxF -- "$2" <<<"$1"; then ok "$3"; else bad "$3 (missing line: $2)"; fi; }

# A throwaway git repo, so trace.sh roots there and not in the real repository.
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cp -R "$here/fixtures/module-map/." "$tmp/"
mkdir -p "$tmp/.claude/skills/nexa-code-navigation/scripts" "$tmp/scripts/claude"
cp "$repo/.claude/skills/nexa-code-navigation/scripts/trace.sh" "$tmp/.claude/skills/nexa-code-navigation/scripts/"
cp "$script" "$tmp/scripts/claude/module-map.sh"
git -C "$tmp" init -q
run() { (cd "$tmp" && MODULE_MAP_ROOT="$tmp" bash scripts/claude/module-map.sh "$@"); }

PAD=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
out="$(run --all)"
m=apps/api/src/modules/shop
has "$out" "$m/alpha services=1 writes=gadget_rows,sprocket_rows_$PAD,widget_rows_$PAD tests=1" "--all alpha line (sql names, tests by import)"
has "$out" "$m/beta services=1 writes=widget_rows_$PAD tests=1" "--all beta line (tests by file name)"
[[ "$(wc -l <<<"$out")" == 2 ]] && ok "--all has one line per module" || bad "--all line count"

one="$(run alpha)"
has "$one" "services: alpha.service.ts" "single: services"
has "$one" "writes: gadget_rows, sprocket_rows_$PAD, widget_rows_$PAD" "single: writes mapped; Map.delete dropped; multi-line delete found"
has "$one" "contracts: @nexa/contracts/errors, ALPHA_CODES, Clock, Money, SomeVeryLongExportedNameNumberOne, SomeVeryLongExportedNameNumberThree, SomeVeryLongExportedNameNumberTwo, WidgetId" "single: contracts (sorted, subpath, type/as stripped)"
has "$one" "tests (1):" "single: test count"
has "$one" "  tests/unit/wiring.test.ts" "single: test path"
has "$(run shop/beta)" "  tests/unit/beta.test.ts" "full key resolves; filename match"
if grep -q unrelated <<<"$(run beta)$one"; then bad "unrelated test leaked in"; else ok "unrelated test excluded"; fi

set +e; run nope >/dev/null 2>&1; rc=$?; set -e
[[ "$rc" == 2 ]] && ok "unknown module exits 2" || bad "unknown module exits $rc"

ww="$(run --who-writes widget_rows_$PAD)"
has "$ww" "$m/alpha/application/alpha.service.ts" "who-writes finds alpha by SQL name"
has "$ww" "$m/beta/application/beta.service.ts" "who-writes finds beta"
if grep -q repository <<<"$ww"; then bad "who-writes matched a non-writer"; else ok "who-writes skips non-writers"; fi
has "$(run --who-writes sprockets)" "$m/alpha/infrastructure/alpha.repository.ts" "who-writes by identifier, schema.-qualified multi-line"
has "$(run --who-calls run)" "$m/beta/application/beta.service.ts:2:  run(db: any) {" "who-calls lists call/def lines"

# The line cap: 12 tests -> 8 listed plus the overflow line.
for i in $(seq 1 11); do echo "export {};" >"$tmp/tests/unit/alpha-extra-$i.test.ts"; done
cap="$(run alpha)"
has "$cap" "tests (12):" "cap: total reported"
has "$cap" "  … 4 more" "cap: overflow line"
[[ "$(wc -l <<<"$cap")" -le 15 ]] && ok "single-module output is at most 15 lines" || bad "single-module output exceeds 15 lines"

tg=apps/api/src/surfaces/telegram
bot="$(run --bot)"
has "$bot" "$tg/bot-runtime.ts lines=7 functions=0" "--bot: the router first"
has "$bot" "$tg/runtime/card-flow.ts lines=6 functions=2" "--bot: a flow with its exported functions"
has "$bot" "$tg/runtime/pay-flow.ts lines=7 functions=1" "--bot: a private function is not counted"
[[ "$(head -1 <<<"$bot")" == "$tg/bot-runtime.ts lines=7 functions=0" ]] && ok "--bot: router on line one" || bad "--bot: router not first"
h="$(run --bot cardScreen)"
has "$h" "  $tg/runtime/card-flow.ts:1:export function cardScreen(rt: unknown, command: string) {" "--bot <handler>: definition"
has "$h" "  $tg/runtime/pay-flow.ts:3:  return cardScreen(rt, command);" "--bot <handler>: a flow caller"
has "$h" "  $tg/runtime/card-flow.ts:5:  return cardScreen(rt, 'back');" "--bot <handler>: a caller in the same file"
[[ "$(grep -c "card-flow.ts:1:" <<<"$h")" == 1 ]] && ok "--bot <handler>: the definition is not listed as a caller" || bad "--bot <handler>: definition listed as a caller"
has "$(run --bot walletPay)" "  $tg/bot-runtime.ts:4:    if (command === 'PAY') return payFlow.walletPay(this, command);" "--bot <handler>: the router's namespaced call"
has "$(run --bot act)" "  $tg/bot-runtime.ts:3:  async act(command: string) {" "--bot <handler>: a router method"
set +e; run --bot nothingHere >/dev/null 2>&1; rc=$?; set -e
[[ "$rc" == 2 ]] && ok "--bot unknown handler exits 2" || bad "--bot unknown handler exits $rc"
set +e; run --bot 'a(b' >/dev/null 2>&1; rc=$?; set -e
[[ "$rc" == 2 ]] && ok "--bot non-identifier exits 2" || bad "--bot non-identifier exits $rc"

run -h >/dev/null && ok "-h exits 0" || bad "-h"
set +e; run >/dev/null 2>&1; rc=$?; set -e
[[ "$rc" == 2 ]] && ok "no argument exits 2" || bad "no argument exits $rc"
exit "$fail"
