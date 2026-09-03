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
OFFENDERS="$(find deploy scripts tests/deploy .github -type f \
  \( -name '*.sh' -o -name 'botctl' -o -name '*.yml' -o -name '*.yaml' \) 2>/dev/null |
  # The check and its test both contain the pattern as DATA — one in its
  # explanation, one in its probes. Neither is a pipeline anything executes.
  grep -vE 'check-shell\.(sh|test\.sh)' |
  while IFS= read -r file; do
    awk -v f="$file" '
      # Heredoc bodies are prose or data, not code this check has any business
      # reading. Without this, a troubleshooting heredoc that MENTIONS a
      # pipeline is reported as containing one.
      heredoc != "" {
        if ($0 ~ ("^[[:space:]]*" heredoc "[[:space:]]*$")) heredoc = ""
        next
      }
      # Comments first, so a comment that MENTIONS a heredoc tag does not open
      # one. `botctl` contains a <<REFUSAL block and a sentence about it; with
      # the comment check after this rule, that sentence turned the rest of the
      # file invisible to this check.
      /^[[:space:]]*#/ { next }
      # A real heredoc operator ends the line, apart from an optional closing
      # quote and any further redirections. Prose does not: `echo "documented
      # as <<MARKER in the manual"` has words after the tag, and treating that
      # as an opener swallowed every following line in the file.
      # `cat <<EOF | tee x` is a real opener: the pipe applies to the command,
      # not to the tag. Requiring end-of-line outright meant the heredoc never
      # opened and its BODY was scanned as code.
      match($0, /(^|[[:space:]]|>|\))<<-?[[:space:]]*['"'"'"]?[A-Za-z_][A-Za-z0-9_]*['"'"'"]?[[:space:]]*([0-9]*[<>][^[:space:]]+[[:space:]]*)*([|;&].*)?$/) {
        tag = substr($0, RSTART, RLENGTH)
        gsub(/^.*<<-?[[:space:]]*['"'"'"]?/, "", tag)
        gsub(/['"'"'"].*$/, "", tag)
        gsub(/[[:space:]].*$/, "", tag)
        heredoc = tag
        next
      }

      # A trailing `|` in YAML is a BLOCK SCALAR indicator, not a pipe. Joining
      # there spliced `run: |` onto the first line of the script it introduces,
      # so any step whose first line began `head` or `grep -q` was reported —
      # and the same command on the third line was not. Positional nonsense.
      # The key and its colon are REQUIRED. With both optional, `mount |` and
      # `ls |` — one-word shell producers ending in a pipe — matched this rule
      # and were skipped, so the join never happened and the consumer alone on
      # the next line had no pipe left to match. That silently un-did the
      # multi-line detection this check was widened for.
      # Digits belong in keys: `run2:`, `python3:`, `step2:`. Without them the
      # indicator was joined onto the first body line and that line reported.
      /^[[:space:]]*(-[[:space:]]+)?([A-Za-z0-9_.-]+|"[^"]*"|'"'"'[^'"'"']*'"'"')[[:space:]]*:[[:space:]]*\|[+-]?[[:space:]]*$/ { next }
      /^[[:space:]]*-[[:space:]]*\|[+-]?[[:space:]]*$/ { next }

      { line = $0 }
      joined != "" { line = joined " " $0; joined = "" }
      /[|\\]$/ { joined = line; if (start == 0) start = NR; next }
      {
        n = (start ? start : NR)
        start = 0
        if (line ~ /^[[:space:]]*#/) next
        if (line ~ /\|\|[[:space:]]*true[[:space:]]*$/) next
        # A pipe is required. `grep -q file` with no pipeline is not this bug.
        if (line ~ /\|[[:space:]]*(LC_ALL=[^[:space:]]+[[:space:]]+|command[[:space:]]+)?(grep[^|]*(-[a-zA-Z]*q|-m[[:space:]]*[0-9])|head([[:space:]]|$))/) {
          printf "%s:%d: %s\n", f, n, line
        }
      }
      # The backstop that makes every future spelling of this bug loud.
      #
      # Whatever heuristic decides what opens a heredoc will eventually be
      # fooled — twice already, by a comment and then by a string ending at a
      # tag — and the failure is SILENT: every following line is skipped and
      # the check reports the file clean. Refusing to reach the end of a file
      # while still inside one converts that whole class into a failure with a
      # file and a tag on it.
      END {
        if (heredoc != "") {
          printf "%s:EOF: still inside heredoc <<%s; the rest of this file was NOT checked\n", f, heredoc
        }
      }
    ' "$file"
  done || true)"
if [ -n "$OFFENDERS" ]; then
  printf '%s\n' "$OFFENDERS" >&2
  fail "a pipeline ends in a consumer that exits early ('grep -q' or 'head'). Under pipefail that returns 141 when it SUCCEEDS, because the writer dies of SIGPIPE — and under 'set -e' that aborts the script. Use a case match, grep -c, wc -l, find -print -quit, or sed -n '1,Np'."
fi
printf '\033[32mok\033[0m    no pipeline ends in a consumer that exits early\n'
