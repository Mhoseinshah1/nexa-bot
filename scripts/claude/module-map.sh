#!/usr/bin/env bash
# module-map.sh --all | <module> | --who-writes <table> | --who-calls <symbol>
#               | --bot [<handler>] | -h
#
# A compact map of apps/api/src/modules, built from grep/find/awk alone (no
# LLM, no node), so "what does this module own" costs tens of lines, not a tree
# read. Read-only.
#
# Module = a directory under apps/api/src/modules that directly holds an
# application/, domain/ or infrastructure/ directory. The repo nests them one
# level (modules/<group>/<module>); the key is the path below modules/, e.g.
# commerce/orders. <module> accepts the key or the bare name when unambiguous.
#
# services = *.service.ts files under application/ (the repo's real naming).
# writes   = SQL tables named by .insert(X) / .update(X) / .delete(X) (also
#            tx.insert(...), multi-line calls), X mapped to its SQL name through
#            `export const X = pgTable('sql_name'` in schema.ts. An identifier
#            that is not a schema table (a Map.delete(key)) is dropped.
# tests    = files under tests/ that import modules/<key>/..., or whose file
#            name contains the module name as a whole -/./_-delimited word.
#
# --bot    = the Telegram surface since the R9 split: the router
#            (surfaces/telegram/bot-runtime.ts) and every surfaces/telegram/runtime/
#            file with its line count and exported functions. With a handler name,
#            the file:line that defines it and the lines that call it, so a bot
#            screen is found without opening the router.
#
# Root: git toplevel, or $MODULE_MAP_ROOT. Exit 2: usage error, unknown module.
set -euo pipefail
export LC_ALL=C

TESTS_CAP=8
CONTRACTS_CAP=16
SERVICES_CAP=12

usage() {
  cat <<'USAGE'
usage: module-map.sh --all
       module-map.sh <module>            (commerce/orders, or just orders)
       module-map.sh --who-writes <table> (SQL name or schema identifier)
       module-map.sh --who-calls <symbol>
       module-map.sh --bot               (the Telegram router and runtime/ files)
       module-map.sh --bot <handler>     (where a bot handler is defined, who calls it)
       module-map.sh -h
env:   MODULE_MAP_ROOT  repository root (default: git toplevel)
USAGE
}

if [[ $# -lt 1 ]]; then usage >&2; exit 2; fi
case "$1" in -h|--help) usage; exit 0 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
root="${MODULE_MAP_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$root"
mods=apps/api/src/modules
schema=apps/api/src/infrastructure/persistence/schema.ts
trace="$here/../../.claude/skills/nexa-code-navigation/scripts/trace.sh"
if [[ ! -d "$mods" ]]; then echo "module-map: no $mods under $root" >&2; exit 2; fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# identifier -> sql name ("ident<TAB>sql"), name may sit on the line after pgTable(
build_tables() {
  [[ -f "$schema" ]] || { : >"$tmp/tables"; return 0; }
  awk '
    pend != "" { if (match($0, /\047[^\047]+\047/)) { print pend "\t" substr($0, RSTART+1, RLENGTH-2); pend = "" } else if ($0 !~ /^[ \t]*$/) pend = ""; next }
    match($0, /^export const [A-Za-z0-9_]+ = pgTable\(/) {
      s = substr($0, RSTART, RLENGTH); sub(/^export const /, "", s); sub(/ =.*/, "", s)
      rest = substr($0, RSTART + RLENGTH)
      if (match(rest, /\047[^\047]+\047/)) print s "\t" substr(rest, RSTART+1, RLENGTH-2); else pend = s
    }' "$schema" >"$tmp/tables"
}

list_modules() {
  find "$mods" -type d \( -name application -o -name domain -o -name infrastructure \) -prune 2>/dev/null \
    | sed -e 's|/[^/]*$||' -e "s|^$mods/||" | sort -u
}

# tables written by the files of one module key (sorted, comma separated)
writes_of() {
  local dir="$mods/$1"
  find "$dir" -type f -name '*.ts' -print0 2>/dev/null | xargs -0 cat 2>/dev/null | tr '\n' ' ' \
    | grep -oE '\.(insert|update|delete)\( *[A-Za-z_][A-Za-z0-9_.]*' 2>/dev/null \
    | sed -E 's/^[^(]*\( *//; s/.*\.//' | sort -u \
    | awk -F'\t' 'NR==FNR { m[$1] = $2; next } ($0 in m) { print m[$0] }' "$tmp/tables" - \
    | sort -u | paste -sd, - || true
}

services_of() {
  find "$mods/$1/application" -type f -name '*.service.ts' 2>/dev/null | sed 's|.*/||' | sort
}

# "key<TAB>testfile" for every module, once per run
build_tests() {
  local list="$tmp/modules"
  list_modules >"$list"
  [[ -d tests ]] || { : >"$tmp/testmap"; return 0; }
  { grep -rEo --include='*.ts' --include='*.tsx' 'modules/[a-z0-9-]+/[a-z0-9-]+/' tests 2>/dev/null \
      | sed -E 's|^([^:]*):modules/([^/]+/[^/]+)/$|\2\t\1|' || true
    find tests -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) 2>/dev/null \
      | awk -v mf="$list" '
          BEGIN { while ((getline k < mf) > 0) { n = k; sub(/.*\//, "", n); key[n] = k; names[++c] = n } }
          { b = $0; sub(/.*\//, "", b)
            for (i = 1; i <= c; i++) if (("-" b "-") ~ ("[-._]" names[i] "[-._]")) print key[names[i]] "\t" $0 }'
  } | sort -u >"$tmp/testmap"
}

tests_of() { awk -F'\t' -v k="$1" '$1 == k { print $2 }' "$tmp/testmap"; }

contracts_of() {
  find "$mods/$1" -type f -name '*.ts' -print0 2>/dev/null | xargs -0 cat 2>/dev/null | tr '\n' ' ' \
    | grep -oE "\{[^}]*\} *from '@nexa/contracts[^']*'" 2>/dev/null \
    | awk '{
        line = $0; sp = line; sub(/.*from \047/, "", sp); sub(/\047$/, "", sp)
        if (sp != "@nexa/contracts") print sp
        body = line; sub(/^\{/, "", body); sub(/\}.*/, "", body)
        n = split(body, a, ",")
        for (i = 1; i <= n; i++) { s = a[i]; gsub(/^[ \t]+|[ \t]+$/, "", s); sub(/^type[ \t]+/, "", s); sub(/[ \t]+as[ \t]+.*/, "", s); if (s != "") print s }
      }' | sort -u || true
}

capjoin() { # cap, then stdin lines -> "a, b, … N more"
  awk -v cap="$1" '{ if (NR <= cap) { out = out (NR > 1 ? ", " : "") $0 } } END { if (NR > cap) out = out ", … " (NR - cap) " more"; print (NR ? out : "-") }'
}

resolve() { # name -> key, exit 2 when unknown/ambiguous
  local want="$1" hit
  hit="$(list_modules | awk -v w="$want" '$0 == w { print; exit } { n = $0; sub(/.*\//, "", n); if (n == w) print }')"
  local count; count="$(printf '%s' "$hit" | grep -c . || true)"
  if [[ "$count" == 0 ]]; then echo "module-map: unknown module '$want' (try --all)" >&2; exit 2; fi
  if [[ "$count" -gt 1 ]]; then
    # an exact key wins even when its bare name also matches others
    if [[ "$(printf '%s\n' "$hit" | grep -cxF "$want" || true)" != 0 ]]; then printf '%s\n' "$want"; return; fi
    echo "module-map: '$want' is ambiguous: $(printf '%s' "$hit" | paste -sd' ' -)" >&2; exit 2
  fi
  printf '%s\n' "$hit"
}

all() {
  build_tables; build_tests
  local k s w t
  while IFS= read -r k; do
    s="$(services_of "$k" | grep -c . || true)"
    w="$(writes_of "$k")"
    t="$(tests_of "$k" | grep -c . || true)"
    printf '%s services=%s writes=%s tests=%s\n' "$mods/$k" "$s" "$w" "$t"
  done <"$tmp/modules"
}

one() {
  local key; key="$(resolve "$1")"
  build_tables; build_tests
  local w tl total
  printf 'module %s/%s\n' "$mods" "$key"
  printf 'services: %s\n' "$(services_of "$key" | capjoin "$SERVICES_CAP")"
  w="$(writes_of "$key")"
  w="${w//,/, }"
  printf 'writes: %s\n' "${w:--}"
  printf 'contracts: %s\n' "$(contracts_of "$key" | capjoin "$CONTRACTS_CAP")"
  tl="$(tests_of "$key")"
  total="$(printf '%s' "$tl" | grep -c . || true)"
  printf 'tests (%s):\n' "$total"
  [[ "$total" == 0 ]] || printf '%s\n' "$tl" | sed -n "1,${TESTS_CAP}p" | sed 's/^/  /'
  if (( total > TESTS_CAP )); then printf '  … %s more\n' "$((total - TESTS_CAP))"; fi
}

# Both wrappers narrow trace.sh's file list; they add no search of their own
# beyond a match inside those files.
trace_files() { # term -> source files under modules/ (not tests)
  bash "$trace" "$1" 500 | grep -E "^$mods/" || true
}

who_writes() {
  build_tables
  local term="$1" ident
  ident="$(awk -F'\t' -v t="$term" '$1 == t || $2 == t { print $1; exit }' "$tmp/tables")"
  ident="${ident:-$term}"
  local f hits=0
  while IFS= read -r f; do
    [[ -f "$f" ]] || continue
    if [[ "$(tr '\n' ' ' <"$f" | grep -cE "\.(insert|update|delete)\( *([A-Za-z_]+\.)?${ident}[ ,)]" || true)" != 0 ]]; then
      printf '%s\n' "$f"; hits=$((hits + 1))
    fi
  done < <(trace_files "$ident")
  (( hits > 0 )) || echo "no module writes '$term'" >&2
}

who_calls() {
  local sym="$1" f
  while IFS= read -r f; do
    [[ -f "$f" ]] || continue
    grep -nE "(^|[^A-Za-z0-9_])${sym}\(" "$f" | sed "s|^|$f:|" | sed -n '1,3p' || true
  done < <(trace_files "$sym") | sed -n '1,40p'
}

tg=apps/api/src/surfaces/telegram

bot_files() { # the router first, then runtime/ in name order
  [[ -f "$tg/bot-runtime.ts" ]] && printf '%s\n' "$tg/bot-runtime.ts"
  find "$tg/runtime" -maxdepth 1 -type f -name '*.ts' 2>/dev/null | sort
}

bot_map() {
  [[ -d "$tg/runtime" ]] || { echo "module-map: no $tg/runtime under $root" >&2; exit 2; }
  local f lines fns
  while IFS= read -r f; do
    lines="$(wc -l <"$f" | tr -d ' ')"
    fns="$(grep -cE '^export (async )?function ' "$f" || true)"
    printf '%s lines=%s functions=%s\n' "$f" "$lines" "$fns"
  done < <(bot_files)
}

bot_handler() {
  local sym="$1"
  [[ "$sym" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { usage >&2; exit 2; }
  [[ -d "$tg/runtime" ]] || { echo "module-map: no $tg/runtime under $root" >&2; exit 2; }
  local files; files="$(bot_files)"
  local defs
  # a flow's free function, or one of the router's own methods
  defs="$(xargs grep -nE "^(export )?(async )?function ${sym}\(|^  (async )?${sym}\(" <<<"$files" || true)"
  if [[ -z "$defs" ]]; then echo "module-map: no bot handler '$sym'" >&2; exit 2; fi
  printf 'defined:\n%s\n' "$(sed 's/^/  /' <<<"$defs" | cut -c1-160)"
  printf 'called from:\n'
  xargs grep -nE "(^|[^A-Za-z0-9_])${sym}\(" <<<"$files" \
    | grep -vE "^[^:]+:[0-9]+:((export )?(async )?function ${sym}\(|  (async )?${sym}\()" \
    | sed -n '1,12p' | cut -c1-160 | sed 's/^/  /' || true
}

case "$1" in
  --all) all ;;
  --bot) if [[ $# -ge 2 ]]; then bot_handler "$2"; else bot_map; fi ;;
  --who-writes) [[ $# -ge 2 && -n "$2" ]] || { usage >&2; exit 2; }; who_writes "$2" ;;
  --who-calls)  [[ $# -ge 2 && -n "$2" ]] || { usage >&2; exit 2; }; who_calls "$2" ;;
  -*) usage >&2; exit 2 ;;
  *) one "$1" ;;
esac
