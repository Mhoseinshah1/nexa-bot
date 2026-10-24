#!/usr/bin/env bash
# log-digest.sh - reduce tool output (stdin) to the failures only, max 40 lines.
# Understands vitest, tsc, eslint (stylish), prettier --check, drizzle-kit check
# and the concatenation of them that `pnpm verify` prints.
#   failing test  -> "file › title", then its first error message and file:line
#   tsc           -> "file:line TSxxxx message"
#   eslint        -> "file:line rule message"
#   prettier      -> "prettier path"
# Last line is always "failed=N passed=N". Over the cap: "… K more" before it.
# failed = vitest "N failed" summed + other distinct errors (a test is counted
# once); if vitest printed nothing, failed = distinct errors, passed = 0.
set -euo pipefail
export LC_ALL=C
MAX=40

sed -e $'s/\r//g' -e $'s/\x1b\\[[0-9;?]*[A-Za-z]//g' | awk -v max="$MAX" '
function addrec(k, istest) {
  if (!(k in seen)) { seen[k] = 1; order[++n] = k; if (istest) tests++; else others++ }
}
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function testkey(rest,   f, t, p) {
  # rest = "path/x.test.ts > describe > test"
  p = index(rest, " > ")
  if (p == 0) return ""
  f = substr(rest, 1, p - 1); t = substr(rest, p + 3)
  sub(/[ \t]+[0-9]+(\.[0-9]+)?m?s$/, "", t)
  return trim(f) " › " trim(t)
}
BEGIN { cur = ""; file = ""; esl = "" }
/^[ \t]*(FAIL|FAILED)[ \t]+[^ ]+ > / {
  s = $0; sub(/^[ \t]*(FAIL|FAILED)[ \t]+/, "", s)
  sub(/[ \t]+\[.*\]$/, "", s)
  k = testkey(s)
  if (k != "") { addrec(k, 1); cur = k; want = 1 }
  next
}
/^[ \t]*(×|✗|✘)[ \t]+[^ ]/ && vfile != "" {
  s = $0; sub(/^[ \t]*(×|✗|✘)[ \t]+/, "", s)
  k = testkey(vfile " > " s); if (k != "") addrec(k, 1)
  cur = ""; next
}
/^[ \t]*(❯|>)[ \t]+[^ ]+\.(test|spec)\.[cm]?[jt]sx?[ \t]+\([0-9]+ tests?/ {
  s = $0; sub(/^[ \t]*(❯|>)[ \t]+/, "", s); split(s, a, " "); vfile = a[1]; next
}
/^[ \t]*(✓|√)[ \t]+[^ ]+\.(test|spec)\.[cm]?[jt]sx?/ { next }
cur != "" && want == 1 && /^[ \t]*[A-Za-z]*Error[:(]/ {
  if (!(cur in msg)) msg[cur] = "  " trim($0)
  want = 2; next
}
cur != "" && /^[ \t]*(❯|>)[ \t]+[^ ]+:[0-9]+:[0-9]+/ {
  s = trim($0); sub(/^(❯|>)[ \t]+/, "", s); split(s, a, " ")
  l = a[1]; sub(/:[0-9]+$/, "", l)
  if (!(cur in loc) && l ~ /:[0-9]+$/) loc[cur] = "  " l
  next
}
/^[ \t]*Tests[ \t]+[0-9]/ {
  vsum = 1
  s = $0
  if (match(s, /[0-9]+ failed/)) vf += substr(s, RSTART, RLENGTH - 7)
  if (match(s, /[0-9]+ passed/)) vp += substr(s, RSTART, RLENGTH - 7)
  next
}
# tsc, plain
/^[^ ()]+\([0-9]+,[0-9]+\): error TS[0-9]+: / {
  s = $0; i = index(s, "("); f = substr(s, 1, i - 1)
  match(s, /\([0-9]+,/); ln = substr(s, RSTART + 1, RLENGTH - 2)
  match(s, /TS[0-9]+/); code = substr(s, RSTART, RLENGTH)
  m = s; sub(/^.*error TS[0-9]+: /, "", m)
  addrec(f ":" ln " " code " " m, 0); next
}
# tsc, pretty
/^[^ ]+:[0-9]+:[0-9]+ - error TS[0-9]+: / {
  s = $0; split(s, a, ":"); f = a[1]; ln = a[2]
  match(s, /TS[0-9]+/); code = substr(s, RSTART, RLENGTH)
  m = s; sub(/^.*error TS[0-9]+: /, "", m)
  addrec(f ":" ln " " code " " m, 0); next
}
# eslint stylish: file header, then "  12:5  error  msg  rule"
/^[^ ]+\.(ts|tsx|js|jsx|mjs|cjs|vue)$/ { file = $0; next }
file != "" && /^[ \t]+[0-9]+:[0-9]+[ \t]+error[ \t]+/ {
  s = trim($0); split(s, a, ":"); ln = a[1]
  sub(/^[0-9]+:[0-9]+[ \t]+error[ \t]+/, "", s)
  gsub(/[ \t][ \t]+/, " ", s)
  addrec(file ":" ln " " s, 0); next
}
/^[ \t]*✖ [0-9]+ problems?/ { next }
# prettier
/^\[warn\][ \t]+(Code style|Checking formatting|Run )/ { next }
/^\[warn\][ \t]+[^ ]+$/ { s = $0; sub(/^\[warn\][ \t]+/, "", s); addrec("prettier " s, 0); next }
# drizzle-kit and any other top-level Error:
/^(\[[^]]*\][ \t]*)?(Error|error): / || /drizzle-kit.*(collision|conflict|non-commutative|error)/ {
  addrec(trim($0), 0); next
}
/ELIFECYCLE|Command failed|ERR_PNPM_/ { life = 1; next }
END {
  nf = tests + others
  if (nf == 0 && life) nf = 1
  failed = nf
  passed = 0
  if (vsum) { failed = vf + others; passed = vp; if (failed == 0 && nf > 0) failed = nf }
  # body lines
  b = 0
  for (i = 1; i <= n; i++) {
    k = order[i]; body[++b] = k
    if (k in msg) body[++b] = msg[k]
    if (k in loc) body[++b] = loc[k]
  }
  if (life) body[++b] = "pnpm: command failed (ELIFECYCLE)"
  lim = max - 1
  if (b > lim) {
    shown = lim - 1
    for (i = 1; i <= shown; i++) print body[i]
    print "… " (b - shown) " more"
  } else {
    for (i = 1; i <= b; i++) print body[i]
  }
  print "failed=" failed " passed=" passed
}'
