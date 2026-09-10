#!/usr/bin/env bash
# Applies one mutation, runs one test file, restores the tree, reports.
#
# Restore is by `git checkout --` of the exact paths, and the run FAILS if the
# tree is not byte-identical afterwards: a falsification harness that leaves a
# mutation behind is how a reverted production rule reaches a commit.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

LABEL="$1"; FILE="$2"; FROM="$3"; TO="$4"; TEST="$5"; PROJECT="${6:-unit}"

# The file must be COMMITTED and clean before it is mutated.
#
# Restore below is `git checkout --`, which restores the file as committed — so
# running this against a file with uncommitted edits silently destroys them.
# That is not hypothetical: it ate an unfinished refactor of `backup.cli.ts`
# mid-session, and the only reason it was noticed is that a later grep found the
# old code back. A harness whose failure mode is deleting the author's work has
# to refuse rather than warn.
if ! git diff --quiet -- "$FILE" || ! git diff --cached --quiet -- "$FILE"; then
  echo "$LABEL  SETUP-FAILED: $FILE has uncommitted changes; commit or stash them first"
  exit 1
fi
if ! git ls-files --error-unmatch "$FILE" >/dev/null 2>&1; then
  echo "$LABEL  SETUP-FAILED: $FILE is not tracked, so it cannot be restored"
  exit 1
fi

if ! grep -qF -- "$FROM" "$FILE"; then
  echo "$LABEL  SETUP-FAILED: the text to mutate is not in $FILE"
  exit 1
fi

python3 - "$FILE" "$FROM" "$TO" <<'PY'
import sys
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
assert s.count(frm) == 1, f"expected exactly one occurrence, found {s.count(frm)}"
open(path, 'w').write(s.replace(frm, to, 1))
PY
if [ $? -ne 0 ]; then
  echo "$LABEL  SETUP-FAILED: mutation not unique"
  git checkout -- "$FILE"
  exit 1
fi

OUT=$(pnpm exec vitest run --project "$PROJECT" "$TEST" 2>&1)
STATUS=$?

git checkout -- "$FILE"
if ! git diff --quiet -- "$FILE"; then
  echo "$LABEL  RESTORE-FAILED: $FILE differs after checkout"
  exit 1
fi

if [ "$STATUS" -eq 0 ]; then
  echo "$LABEL  SURVIVED  <-- the rule has no test"
  exit 1
fi
echo "$LABEL  KILLED"
# `sed -n '1,5p'`, not `head`: a pipeline ending in a consumer that exits early
# returns 141 under `pipefail` when it SUCCEEDS, because the writer dies of
# SIGPIPE. `scripts/check-shell.sh` rejects the `head` spelling for exactly
# that reason, and a falsification harness reporting 141 as a failure would be
# the wrong answer in the one place that must not give one.
printf '%s\n' "$OUT" | grep -E "×|FAIL" | sed -n '1,5p'
