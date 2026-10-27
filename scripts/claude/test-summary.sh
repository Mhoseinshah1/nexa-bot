#!/usr/bin/env bash
# test-summary.sh - run a test/verify command, keep its raw output in a log
# file, and print only what a reader needs: the counts, each failing test, and
# the first lines of each failure. Where log-digest.sh gives the <=40-line
# digest (name + first message), this gives the per-failure detail.
#
#   bash scripts/claude/test-summary.sh pnpm verify
#   bash scripts/claude/test-summary.sh pnpm exec vitest run --project integration tests/integration/foo.test.ts
#   (never `pnpm test:integration -- <files>`: it ignores the file list and runs the WHOLE suite)
#   bash scripts/claude/test-summary.sh --from run.log        # summarise a saved log
#   some-command 2>&1 | bash scripts/claude/test-summary.sh --from -
#
# Output (a clean run is two lines):
#   passed=N failed=N skipped=N        vitest "Tests" lines summed over every
#                                      project/run, failed also counts failed
#                                      suites and failed non-vitest stages
#   file › describe › test             one per failing test, then up to 20 lines
#     <error block>                    of its vitest FAIL detail (indented)
#   stage: <name>                      a pnpm script that failed without a vitest
#     <error lines>                    failure (tsc, eslint, prettier, boundaries,
#                                      i18n, citations, shellcheck, deploy, build);
#                                      tsc/eslint/prettier error lines, else the
#                                      last 20 lines of the stage
#   … K more failures                  only when the 200-line cap is hit
#   exit=N log=<path>                  last line; N is the command's exit code
#
# The script exits with the command's exit code. With --from there is no
# command: N is 1 when any failure was found, else 0.
# Env: TEST_SUMMARY_MAX (total line cap, default 200), TEST_SUMMARY_DIR (where
# the log goes, default $TMPDIR or /tmp).
set -uo pipefail
export LC_ALL=C
MAX="${TEST_SUMMARY_MAX:-200}"
BLOCK=20

usage() {
  echo "usage: test-summary.sh <command...> | --from <logfile|->" >&2
  exit 2
}

[ $# -gt 0 ] || usage
case "$1" in -h | --help) usage ;; esac

dir="${TEST_SUMMARY_DIR:-${TMPDIR:-/tmp}}"
rc=-1
if [ "$1" = "--from" ]; then
  [ $# -eq 2 ] || usage
  if [ "$2" = "-" ]; then
    log="$(mktemp "$dir/test-summary.XXXXXX")" || exit 2
    cat >"$log"
  else
    log="$2"
    [ -r "$log" ] || { echo "test-summary: cannot read $log" >&2; exit 2; }
  fi
else
  log="$(mktemp "$dir/test-summary.XXXXXX")" || exit 2
  "$@" >"$log" 2>&1 </dev/null
  rc=$?
fi

# Same ANSI/CR stripping as log-digest.sh.
sed -e $'s/\r//g' -e $'s/\x1b\\[[0-9;?]*[A-Za-z]//g' "$log" | awk -v max="$MAX" -v blk="$BLOCK" -v rc="$rc" -v logpath="$log" '
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function clip(s) { return (length(s) > 240) ? substr(s, 1, 239) "…" : s }
function closeblock() {
  if (open == 0) return
  while (uc[open] > 0 && ul[open, uc[open]] ~ /^[ \t]*$/) uc[open]--
  open = 0
}
function newunit(name, kind) {
  n++; uname[n] = name; uc[n] = 0; ukind[n] = kind
  return n
}
function addline(u, s) { uc[u]++; ul[u, uc[u]] = "  " clip(s) }
# Turn the buffered lines of the current stage into a failure unit.
function stageunit(name,   u, i, k) {
  u = newunit("stage: " name, "stage")
  if (errn > 0) {
    for (i = 1; i <= errn && i <= blk; i++) addline(u, errl[i])
  } else {
    k = (sn < blk) ? sn : blk
    for (i = sn - k + 1; i <= sn; i++) addline(u, sl[i])
  }
  stages++
}
function nalso(u) { return (ugrp[u] > ALSO) ? ALSO + 1 : ugrp[u] + 0 }
function resetstage() { sn = 0; errn = 0; efile = "" }
BEGIN { stage = ""; resetstage(); ALSO = 9 }

# pnpm script header: "> nexa-bot@0.0.0 check:citations /path"
/^>[ \t]+[^ ]+@[^ ]+[ \t]+[^ ]+/ {
  closeblock()
  s = $0; sub(/^>[ \t]+[^ ]+@[^ ]+[ \t]+/, "", s); split(s, a, " ")
  stage = a[1]; resetstage(); next
}

# Vitest failure header, with or without a |project| label.
/^[ \t]*FAIL[ \t]+[^ ]/ {
  s = $0; sub(/^[ \t]*FAIL[ \t]+/, "", s)
  sub(/^\|[A-Za-z0-9_.-]+\|[ \t]+/, "", s)
  p = index(s, " > ")
  name = ""; kind = ""
  if (p > 0) {
    f = substr(s, 1, p - 1); t = substr(s, p + 3)
    gsub(/ > /, " › ", t)
    sub(/[ \t]+\[[^]]*\]$/, "", t)
    name = trim(f) " › " trim(t); kind = "test"
  } else if (s ~ /\.(test|spec)\.[cm]?[jt]sx?([ \t]+\[.*\])?[ \t]*$/) {
    split(s, a, " "); name = a[1]; kind = "suite"
  }
  if (name != "") {
    # Vitest prints one error for a run of suites that failed identically, after
    # all their FAIL lines. Fold them into the first so the name list stays short.
    if (kind == "suite" && open > 0 && ukind[open] == "suite" && uc[open] == 0 && !(name in seen)) {
      seen[name] = 1; suites++; ugrp[open]++
      if (ugrp[open] <= ALSO) ualso[open, ugrp[open]] = name
      next
    }
    closeblock()
    if (!(name in seen)) {
      seen[name] = 1
      u = newunit(name, kind)
      open = u; svf[stage]++
      if (kind == "test") tests++; else suites++
    }
    next
  }
}

# Anything that ends a vitest error block.
index($0, "⎯⎯⎯") == 1 { closeblock(); next }
/^[ \t]*Test Files[ \t]/ { closeblock(); next }
/^[ \t]*Tests[ \t]+[0-9].*\([0-9]+\)[ \t]*$/ {
  closeblock(); vsum = 1
  s = $0
  if (match(s, /[0-9]+ failed/))  { x = substr(s, RSTART, RLENGTH - 7) + 0; vf += x; svf[stage] += x }
  if (match(s, /[0-9]+ passed/))  vp += substr(s, RSTART, RLENGTH - 7)
  if (match(s, /[0-9]+ skipped/)) vs += substr(s, RSTART, RLENGTH - 8)
  next
}

# pnpm reporting that the script failed: close it as a stage, unless vitest
# already named its failures (then the stage is its tests, not a second failure).
/^[ \t]*ELIFECYCLE|ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL|^[ \t]*Command failed with exit code/ {
  closeblock()
  if (stage != "" && !(stage in sfail) && svf[stage] == 0) { sfail[stage] = 1; stageunit(stage) }
  next
}

open > 0 { if (uc[open] < blk) addline(open, $0); next }

# Not in a vitest block: keep the lines of the current stage.
/^[ \t]*$/ { next }
/^>[ \t]/ { next }
{
  line = $0
  iserr = 0
  if (line ~ /\([0-9]+,[0-9]+\): error TS[0-9]+:/ || line ~ /:[0-9]+:[0-9]+ - error TS[0-9]+:/) { iserr = 1; intsc = 1; if (kfirst == "") kfirst = "tsc" }
  else if (intsc && line ~ /^[ \t]/) iserr = 1
  else if (line ~ /^\/?[^ ]+\.(ts|tsx|js|jsx|mjs|cjs)$/) { efile = line }
  else if (line ~ /^[ \t]+[0-9]+:[0-9]+[ \t]+error[ \t]/ && efile != "") { iserr = 1; line = efile ":" trim(line); if (kfirst == "") kfirst = "eslint" }
  else if (line ~ /^\[warn\][ \t]+[^ ]+$/) { iserr = 1; if (kfirst == "") kfirst = "prettier" }
  else if (line ~ /^[ \t]*✖/ && errn > 0) iserr = 1
  if (!iserr && line !~ /^[ \t]/) intsc = 0
  sl[++sn] = line
  if (iserr) errl[++errn] = line
}

END {
  closeblock()
  # No vitest failure and no pnpm stage explained the exit code: say what the
  # tail of the log was. With --from (rc < 0) only recognisable tool errors count.
  if (n == 0 && (rc > 0 || kfirst != "")) {
    nm = (kfirst != "") ? kfirst : "command"
    stageunit(nm)
  }
  failed = (vsum ? vf : tests) + suites + stages
  # vitest counted its own failures; failed stages and suites come on top.
  if (vsum && vf < tests) failed = tests + suites + stages
  out = (rc >= 0) ? rc : ((failed > 0) ? 1 : 0)

  head = "passed=" (vp + 0) " failed=" failed " skipped=" (vs + 0)
  tail = "exit=" out " log=" logpath
  total = 0
  for (i = 1; i <= n; i++) total += 1 + nalso(i) + uc[i]
  avail = max - 2
  reserve = (total > avail) ? 1 : 0
  print head
  used = 0; shown = 0
  for (i = 1; i <= n; i++) {
    need = 1 + nalso(i) + uc[i]
    if (used + need > avail - reserve) break
    print uname[i]
    for (j = 1; j <= ugrp[i] && j <= ALSO; j++) print "  also: " ualso[i, j]
    if (ugrp[i] > ALSO) print "  … +" (ugrp[i] - ALSO) " more files with the same error"
    for (j = 1; j <= uc[i]; j++) print ul[i, j]
    used += need; shown++
  }
  if (shown < n) print "… " (n - shown) " more failures"
  print tail
  if (rc < 0) exit out
}'
srt=$?

if [ "$rc" -ge 0 ]; then
  exit "$rc"
fi
exit "$srt"
