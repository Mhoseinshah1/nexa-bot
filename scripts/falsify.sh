#!/usr/bin/env bash
# Applies one mutation, runs one test file, restores the tree, reports.
#
# Restore is by `git checkout --` of the exact paths, and the run FAILS if the
# tree is not byte-identical afterwards: a falsification harness that leaves a
# mutation behind is how a reverted production rule reaches a commit.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

LABEL="$1"; FILE="$2"; FROM="$3"; TO="$4"; TEST="$5"; PROJECT="${6:-unit}"

# The PROJECT must be one vitest actually defines, or `shell`.
#
# This check exists because its absence manufactured evidence. `--project api`
# is not a project — `vitest.config.mts` defines unit, web, exhaustive and
# integration — so vitest matched no files, exited non-zero, and every mutation
# run that way was reported KILLED without a single test having been executed.
# Seven rules were "falsified" against it in one session before a mutation that
# genuinely survived was checked by hand and found to pass.
#
# A harness whose failure mode is reporting success is worse than no harness:
# the record it produces reads exactly like a real one. So an unknown project is
# a hard refusal, and the message names the valid ones rather than making the
# next person read this file to find them.
case "$PROJECT" in
  unit|web|exhaustive|integration|shell) ;;
  *)
    echo "$LABEL  SETUP-FAILED: unknown project '$PROJECT'" >&2
    echo "         valid: unit, web, exhaustive, integration, shell" >&2
    exit 1
    ;;
esac

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

# A workspace package is consumed as its BUILD OUTPUT, so mutating its source
# and running a test proves nothing.
#
# `packages/contracts/package.json` exports `./dist/index.js`, and
# `node_modules/@nexa/contracts` links to the package directory. Nothing aliases
# `@nexa/contracts` to `src` — not `vitest.config.mts`, not any tsconfig at
# runtime — so a test importing `MAX_REQUESTS_PER_PROBE` reads the COMPILED file.
# Mutating `packages/contracts/src/provider.ts` leaves that file untouched, the
# test passes, and this harness reports SURVIVED for a rule that is in fact
# tested. Measured: two such mutations reported SURVIVED here, and the same two
# die immediately once dist is rebuilt.
#
# `docs/phase3d-falsification.md` already recorded this trap as something the
# author has to remember. Remembering is not a mechanism — so a mutation under
# `packages/` now rebuilds that package before the test, and rebuilds it again
# from the restored source afterwards. Both builds are required: skipping the
# second leaves a MUTATED dist on disk beside clean source, which is the same
# class of failure as leaving a mutated file behind and worse, because
# `git diff` cannot see it.
PACKAGE=""
case "$FILE" in
  packages/*) PACKAGE="@nexa/$(printf '%s' "$FILE" | cut -d/ -f2)" ;;
esac

rebuild() {
  [ -n "$PACKAGE" ] || return 0
  pnpm --filter "$PACKAGE" build >/dev/null 2>&1
}

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

# A mutation that does not COMPILE is not a falsification: the test would fail
# because the package is broken rather than because the rule is enforced, and
# that reads as KILLED. Report it as a setup failure instead.
if ! rebuild; then
  echo "$LABEL  SETUP-FAILED: $PACKAGE does not build with this mutation applied"
  git checkout -- "$FILE"
  rebuild
  exit 1
fi

# The sixth argument is the vitest PROJECT — or the literal `shell`, which runs
# the named file with bash instead.
#
# Without that, every rule whose only behavioural test is a shell suite had to be
# falsified by HAND: copy the file aside, edit it, run the suite, copy it back.
# That is the procedure this harness exists to replace, and doing it by hand is
# how a mutation gets left in the tree — the failure mode the restore check at
# the bottom was added for. The deployment state machine's tests are a shell
# suite (`tests/deploy/botctl.test.sh`), and the edge-configuration rules live
# there, so "falsifiable" had to include them.
if [ "$PROJECT" = "shell" ]; then
  OUT=$(bash "$TEST" 2>&1)
else
  OUT=$(pnpm exec vitest run --project "$PROJECT" "$TEST" 2>&1)
fi
STATUS=$?

git checkout -- "$FILE"
if ! git diff --quiet -- "$FILE"; then
  echo "$LABEL  RESTORE-FAILED: $FILE differs after checkout"
  exit 1
fi
if ! rebuild; then
  echo "$LABEL  RESTORE-FAILED: $PACKAGE does not build from restored source"
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
