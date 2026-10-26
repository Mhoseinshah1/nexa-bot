#!/usr/bin/env bash
# Self-test for renumber-migration.sh: throwaway git repos built from
# fixtures/renumber-migration/{base,main,branch}, a fake drizzle-kit generator.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fx="$here/fixtures/renumber-migration"
script="${RENUMBER_MIGRATION:-$here/renumber-migration.sh}"
root="$(mktemp -d)"
mkdir "$root/tmp" # the script's own mktemp goes here, so a leak is visible
trap 'rm -rf "$root"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; echo "$2" | sed 's/^/     /'; fail=1; }
check() { # description, condition result (0 = pass), context
  if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1" "${3:-}"; fi
}
D=apps/api/drizzle

git_() { git -c user.email=t@example.com -c user.name=test -c commit.gpgsign=false "$@"; }

# mkrepo <dir> <conflict|committed|clean>
#   conflict  - origin/main added a colliding 0002 and the merge is left conflicted
#   committed - same, merge committed with the branch's journal/snapshots kept
#   clean     - origin/main did not move; the branch numbers after its head
mkrepo() {
  local dir="$1" mode="$2"
  mkdir -p "$dir"
  (
    cd "$dir"
    git init -q -b main .
    cp -R "$fx/base/." .
    git add -A && git_ commit -q -m base
    git checkout -q -b feature
    cp -R "$fx/branch/." .
    git add -A && git_ commit -q -m branch
    git checkout -q main
    if [ "$mode" != clean ]; then
      cp -R "$fx/main/." .
      git add -A && git_ commit -q -m "main moves"
    fi
    git update-ref refs/remotes/origin/main main
    git checkout -q feature
    if [ "$mode" = clean ]; then
      # the branch's migrations number 0002/0003 after base's 0001: no collision
      :
    else
      git_ merge origin/main >/dev/null 2>&1 || true
      if [ "$mode" = committed ]; then
        git checkout --ours -- $D/meta
        git add -A && git_ commit -q -m "merge main"
      fi
    fi
  )
}

run() { # dir [args...]; sets OUT and RC
  local dir="$1"; shift
  RC=0
  OUT="$(cd "$dir" && TMPDIR="$root/tmp" RENUMBER_GENERATE_CMD="bash $fx/fake-generate.sh" FAKE_SQL_SRC="$fx/branch/$D" bash "$script" "$@" 2>&1)" || RC=$?
}
snapshot() { # dir -> hash of status + every file
  (cd "$1" && { git status --porcelain; git ls-files -s; find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 sha256sum; } | sha256sum)
}
journal_ok() { # dir; prints idx|tag|when lines
  node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1] + "/'$D'/meta/_journal.json", "utf8"));
for (const e of j.entries) console.log(e.idx + "|" + e.tag + "|" + e.when + "|" + e.version + "|" + e.breakpoints);' "$1"
}

for mode in conflict committed; do
  repo="$root/$mode"
  mkrepo "$repo" "$mode"
  before_ms="$(node -e 'console.log(Date.now())')"
  run "$repo"
  after_ms="$(node -e 'console.log(Date.now())')"
  p="$mode:"
  check "$p exits 0" "$RC" "$OUT"
  [[ "$(tail -n1 <<<"$OUT")" == "renumbered=2 identical=yes" ]] && r=0 || r=1
  check "$p last line is renumbered=2 identical=yes" "$r" "$OUT"
  if [ "$mode" = conflict ]; then
    grep -qF "conflicted: taking origin/main's version" <<<"$OUT" && r=0 || r=1
    check "$p says the conflicted journal/snapshots were taken from base" "$r" "$OUT"
  fi
  [ -f "$repo/$D/0003_add_widgets.sql" ] && [ -f "$repo/$D/0004_widgets_guard.sql" ] &&
    [ ! -e "$repo/$D/0002_add_widgets.sql" ] && [ ! -e "$repo/$D/0003_widgets_guard.sql" ] && r=0 || r=1
  check "$p new numbers 0003_add_widgets / 0004_widgets_guard, old files gone" "$r" "$(ls "$repo/$D")"
  [ -f "$repo/$D/0002_main_feature.sql" ] && cmp -s "$repo/$D/0002_main_feature.sql" "$fx/main/$D/0002_main_feature.sql" && r=0 || r=1
  check "$p main's 0002 is untouched" "$r"
  cmp -s "$repo/$D/0003_add_widgets.sql" "$fx/branch/$D/0002_add_widgets.sql" && r=0 || r=1
  check "$p generated SQL byte-identical" "$r"
  cmp -s "$repo/$D/0004_widgets_guard.sql" "$fx/branch/$D/0003_widgets_guard.sql" && r=0 || r=1
  check "$p hand-written SQL byte-identical" "$r"

  want="0|0000_init|1700000000000|7|true
1|0001_users|1700000100000|7|true
2|0002_main_feature|1700000300000|7|true
3|0003_add_widgets"
  # the first four lines, with the "when" of the new entry masked
  masked="$(journal_ok "$repo" | sed -n '1,3p'; journal_ok "$repo" | sed -n '4p' | cut -d'|' -f1,2)"
  [[ "$masked" == "$(sed -n '1,3p' <<<"$want"; sed -n '4p' <<<"$want")" ]] && r=0 || r=1
  check "$p journal restarts from main's (idx 0-2) then idx 3 0003_add_widgets" "$r" "$(journal_ok "$repo")"
  mapfile -t jlines < <(journal_ok "$repo")
  node -e '
const [before, after, ...lines] = process.argv.slice(1);
const e = lines.map((l) => l.split("|"));
const bad = [];
if (e.length !== 5) bad.push("expected 5 entries, got " + e.length);
e.forEach((x, i) => { if (Number(x[0]) !== i) bad.push("idx " + x[0] + " at position " + i); });
for (let i = 1; i < e.length; i++) if (!(Number(e[i][2]) > Number(e[i - 1][2]))) bad.push("when does not advance at idx " + i);
if (e[4][1] !== "0004_widgets_guard") bad.push("tag " + e[4][1]);
if (e[3][1] !== "0003_add_widgets") bad.push("tag " + e[3][1]);
if (!(Number(e[4][2]) >= Number(before) && Number(e[4][2]) <= Number(after))) bad.push("hand-written when " + e[4][2] + " is not now (" + before + ".." + after + ")");
if (!(Number(e[3][2]) <= Number(after))) bad.push("generated when is in the future");
if (e[4][3] !== "7" || e[4][4] !== "true") bad.push("fields differ from neighbours");
if (bad.length) { console.log(bad.join("\n")); process.exit(1); }
' "$before_ms" "$after_ms" "${jlines[@]}" >"$root/jcheck.txt" 2>&1 && r=0 || r=1
  check "$p journal: idx sequential, when advances, hand-written when = now, <= now" "$r" "$(cat "$root/jcheck.txt")"
  [ -f "$repo/$D/meta/0002_snapshot.json" ] && cmp -s "$repo/$D/meta/0002_snapshot.json" "$fx/main/$D/meta/0002_snapshot.json" &&
    [ -f "$repo/$D/meta/0003_snapshot.json" ] && [ ! -e "$repo/$D/meta/0004_snapshot.json" ] && r=0 || r=1
  check "$p snapshots: main's 0002 kept, regenerated 0003, none for the hand-written" "$r" "$(ls "$repo/$D/meta")"
  grep -qF 'arrive in 0003_add_widgets; the guard trigger is 0004_widgets_guard.' "$repo/docs/notes.md" &&
    grep -qF '`0003_add_widgets.sql` and `0004_widgets_guard.sql`' "$repo/docs/notes.md" && r=0 || r=1
  check "$p references updated (old tag -> new tag)" "$r" "$(cat "$repo/docs/notes.md")"
  grep -qF '0002_add_widgets_v2' "$repo/docs/notes.md" && r=0 || r=1
  check "$p a longer tag sharing the prefix is left alone" "$r" "$(cat "$repo/docs/notes.md")"
  grep -qF 'reference updated: docs/notes.md' <<<"$OUT" && r=0 || r=1
  check "$p output lists the changed reference file" "$r" "$OUT"
  grep -qF 'reminder: run pnpm db:check' <<<"$OUT" && r=0 || r=1
  check "$p output carries the db:check reminder" "$r" "$OUT"
  [ -z "$(git -C "$repo" ls-files -u)" ] && r=0 || r=1
  check "$p nothing left unmerged" "$r" "$(git -C "$repo" status --short)"
  [ -z "$(ls -A "$root/tmp")" ] && r=0 || r=1
  check "$p no temp dir left behind" "$r" "$(ls -A "$root/tmp")"
done

# --- dry-run changes nothing and prints the plan
for mode in conflict committed; do
  repo="$root/dry-$mode"
  mkrepo "$repo" "$mode"
  h0="$(snapshot "$repo")"
  run "$repo" --dry-run
  h1="$(snapshot "$repo")"
  check "dry-run ($mode): exits 0" "$RC" "$OUT"
  [ "$h0" = "$h1" ] && r=0 || r=1
  check "dry-run ($mode): working tree, index and status unchanged" "$r" "$(cd "$repo" && git status --short)"
  grep -qF 'plan: 0002_add_widgets -> 0003_add_widgets (generated)' <<<"$OUT" &&
    grep -qF 'plan: 0003_widgets_guard -> 0004_widgets_guard (hand-written)' <<<"$OUT" && r=0 || r=1
  check "dry-run ($mode): plan lists old -> new and the kind" "$r" "$OUT"
  grep -qF 'would update references in: docs/notes.md' <<<"$OUT" && r=0 || r=1
  check "dry-run ($mode): lists the references it would change" "$r" "$OUT"
done

# --- a generator that emits different SQL fails the run
repo="$root/diverge"
mkrepo "$repo" conflict
RC=0
OUT="$(cd "$repo" && TMPDIR="$root/tmp" RENUMBER_GENERATE_CMD="bash $fx/fake-generate.sh" FAKE_SQL_SRC="$fx/branch/$D" FAKE_SQL_EXTRA='ALTER TABLE "widgets" ADD COLUMN "extra" text;
' bash "$script" 2>&1)" || RC=$?
[ "$RC" -ne 0 ] && r=0 || r=1
check "diverging SQL: exits non-zero" "$r" "$OUT"
[[ "$(tail -n1 <<<"$OUT")" == "renumbered=2 identical=no" ]] && r=0 || r=1
check "diverging SQL: last line says identical=no" "$r" "$OUT"
grep -q '^+ALTER TABLE "widgets" ADD COLUMN "extra"' <<<"$OUT" && r=0 || r=1
check "diverging SQL: the diff is printed" "$r" "$OUT"
[ "$(wc -l <<<"$OUT")" -le 40 ] && r=0 || r=1
check "diverging SQL: output stays short" "$r" "$(wc -l <<<"$OUT") lines"
grep -qF 'ALTER TABLE "widgets" ADD COLUMN "extra"' "$repo/$D/0003_add_widgets.sql" && r=0 || r=1
check "diverging SQL: the file is left as generated, not 'fixed'" "$r"

# --- a generator that writes nothing fails loudly
repo="$root/nogen"
mkrepo "$repo" conflict
RC=0
OUT="$(cd "$repo" && TMPDIR="$root/tmp" RENUMBER_GENERATE_CMD="true" bash "$script" 2>&1)" || RC=$?
[ "$RC" -eq 2 ] && grep -q 'generate did not write 0003_add_widgets.sql' <<<"$OUT" && r=0 || r=1
check "generator that writes nothing: error, exit 2" "$r" "rc=$RC $OUT"

# --- nothing to renumber
repo="$root/clean"
mkrepo "$repo" clean
h0="$(snapshot "$repo")"
run "$repo"
[ "$RC" -eq 0 ] && grep -q '^nothing to renumber' <<<"$OUT" && r=0 || r=1
check "no collision: 'nothing to renumber', exit 0" "$r" "rc=$RC $OUT"
[ "$h0" = "$(snapshot "$repo")" ] && r=0 || r=1
check "no collision: nothing changed" "$r"

# --- base not merged
repo="$root/unmerged"
mkrepo "$repo" conflict
(cd "$repo" && git merge --abort)
run "$repo"
[ "$RC" -eq 2 ] && grep -qF 'is not merged into HEAD' <<<"$OUT" && r=0 || r=1
check "base not merged: refuses (exit 2)" "$r" "rc=$RC $OUT"

exit "$fail"
