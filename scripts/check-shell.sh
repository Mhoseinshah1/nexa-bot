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

# --- Tier 3: one pattern shellcheck does not catch ---------------------------
#
# A pipeline that ends in a consumer which EXITS EARLY, under `set -o pipefail`.
#
# `grep -q` exits on its first match. `head -n N` exits after N lines. Either
# way the producer ahead of it then dies of SIGPIPE writing the rest, `pipefail`
# makes the pipeline return 141, and — this is the sharp part — with `set -e`
# an assignment from that substitution ABORTS THE SCRIPT. So the check fails
# exactly when it should pass, and the script dies exactly when it found what
# it was looking for.
#
# This is not theoretical, in either spelling. `grep -q` cost two CI runs here:
# a backup assertion that announced "the backup contains no schema" about a
# perfectly good dump, and a version assertion that announced a missing digest
# that was present. Both were invisible locally and both looked like real
# product failures. `| head -n 1` was then found by this very check being too
# narrow — `find "$BACKUP_DIR" -name '*.sql.gz' | head -n 1` in the smoke test
# returns 141 the moment a second backup exists, which is to say on the second
# run of a real installation.
#
# The fixes are all cheap and all remove the pipe rather than working around it:
# `case`/`[[ ]]` for strings already in memory, `grep -c` or `wc -l` when a
# stream must be read to the end, `find -print -quit` when one path is wanted,
# `sed -n '1,5p'` where `head -5` was.
#
# A line ending in `|| true` is exempt: it has already decided the exit status
# does not matter, which is the correct answer for a diagnostic dump.
#
# Multi-line pipelines count. A pipeline may be broken after its `|`, and the
# original offender in check-boundaries.sh was written exactly that way — so a
# one-line regex reported the tree clean while the spelling most likely to recur
# sat in it. The awk below joins any line whose last character is `|` or `\` to
# the next before matching, and reports the line the pipeline STARTED on.
#
# `.github` is in the scan set because the release workflow is shell too, and it
# is the one that holds a token able to publish.
# The awk program lives in a quoted heredoc rather than inside a single-quoted
# `awk '...'`, so it can contain both kinds of quote without escaping. That is
# not cosmetic: this program has to reason ABOUT quotes, and writing it inline
# is how the previous three versions ended up guessing instead.
read -r -d '' TIER3_AWK <<'AWK' || true
# Reduce a line to the shell CODE on it: no quoted strings, no trailing
# comment. Everything this check asks — does a heredoc open here, does a
# pipeline end in an early-exiting consumer — is a question about code, and
# asking it of prose is what produced every previous defect in this check.
#
# Three versions of this rule tried to tell an operator from prose by where it
# sat on the line: "not in a comment", then "the tag ends the line", then "the
# tag ends the line or is followed by a pipe". Each admitted a spelling the one
# before it excluded, and the last one SILENTLY skipped the rest of a file
# whenever a real heredoc later closed the false one. Removing the strings is
# the property they were all approximating.
# A quoted run is dropped ONLY when it holds no `$`. A command substitution is
# code — `v="$(find . | head -n 1)"` is exactly the pipeline this check exists
# to find — so anything that could expand is kept rather than guessed at.
function code(s,   out, run, i, c, q, n, prev) {
  out = ""; run = ""; q = ""; n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (q == "") {
      if (c == "\\") { i++; continue }
      if (c == "'" || c == "\"") { q = c; run = ""; continue }
      prev = (out == "") ? " " : substr(out, length(out))
      if (c == "#" && prev ~ /[[:space:]]/) break
      out = out c
    } else {
      if (c == "\\" && q == "\"") { i++; continue }
      if (c == q) { q = ""; if (index(run, "$") > 0) out = out run; continue }
      run = run c
    }
  }
  if (q != "" && index(run, "$") > 0) out = out run
  return out
}

# `<<'EOF'` and `<<"EOF"` are heredoc operators whose tag happens to be
# quoted. Unquote the TAG before the strings are removed, or the operator
# disappears with them and the body is read as code.
{
  norm = $0
  while (match(norm, /<<-?[[:space:]]*['"][A-Za-z_][A-Za-z0-9_]*['"]/)) {
    seg = substr(norm, RSTART, RLENGTH)
    gsub(/['"]/, "", seg)
    norm = substr(norm, 1, RSTART - 1) seg substr(norm, RSTART + RLENGTH)
  }
  bare = code(norm)
}

# Inside a heredoc body: data, not code. The terminator is matched against the
# raw line, because a terminator is not code either.
heredoc != "" {
  if ($0 ~ ("^[[:space:]]*" heredoc "[[:space:]]*$")) heredoc = ""
  next
}

# A heredoc opener, now decided on the code alone. `cat <<EOF | tee x` opens
# one; `echo "the form is cat <<EOF | tee"` does not, because the quoted run is
# gone before we look.
match(bare, /<<-?[[:space:]]*[A-Za-z_][A-Za-z0-9_]*/) {
  tag = substr(bare, RSTART, RLENGTH)
  sub(/^<<-?[[:space:]]*/, "", tag)
  heredoc = tag
  next
}

# A trailing `|` in YAML is a block-scalar indicator, not a pipe.
bare ~ /^[[:space:]]*(-[[:space:]]+)?([A-Za-z0-9_.-]+|"[^"]*"|'[^']*')[[:space:]]*:[[:space:]]*\|[+-]?[[:space:]]*$/ { next }
bare ~ /^[[:space:]]*-[[:space:]]*\|[+-]?[[:space:]]*$/ { next }

{ line = bare; raw = $0 }
joined != "" { line = joined " " bare; raw = joined_raw " " $0; joined = "" }
line ~ /[|\\]$/ { joined = line; joined_raw = raw; if (start == 0) start = NR; next }
{
  n = (start ? start : NR)
  start = 0
  # A decided exit status: the caller has already said it does not care.
  if (line ~ /\|\|[[:space:]]*true[[:space:]]*$/) next
  if (line ~ /\|[[:space:]]*(LC_ALL=[^[:space:]]+[[:space:]]+|command[[:space:]]+)?(grep[^|]*(-[a-zA-Z]*q|-m[[:space:]]*[0-9])|head([[:space:]]|$))/) {
    printf "%s:%d: %s\n", f, n, raw
  }
}

# Reaching the end of a file still inside a heredoc means the rules above lost
# track, and every line since was skipped. Loud, rather than a clean report.
END {
  if (heredoc != "") {
    printf "%s:EOF: still inside heredoc <<%s; the rest of this file was NOT checked\n", f, heredoc
  }
}
AWK

OFFENDERS="$(find deploy scripts tests/deploy .github -type f \
  \( -name '*.sh' -o -name 'botctl' -o -name '*.yml' -o -name '*.yaml' \) 2>/dev/null |
  # The check and its test both contain the pattern as DATA — one in its
  # explanation, one in its probes. Anchored on the path separator so a future
  # `deploy/check-shell.sh` is not silently dropped from the privileged scan.
  grep -vE '(^|/)check-shell(\.test)?\.sh$' |
  while IFS= read -r file; do
    awk -v f="$file" "$TIER3_AWK" "$file"
  done || true)"
if [ -n "$OFFENDERS" ]; then
  printf '%s\n' "$OFFENDERS" >&2
  fail "a pipeline ends in a consumer that exits early ('grep -q' or 'head'). Under pipefail that returns 141 when it SUCCEEDS, because the writer dies of SIGPIPE — and under 'set -e' that aborts the script. Use a case match, grep -c, wc -l, find -print -quit, or sed -n '1,Np'."
fi
printf '\033[32mok\033[0m    no pipeline ends in a consumer that exits early\n'
