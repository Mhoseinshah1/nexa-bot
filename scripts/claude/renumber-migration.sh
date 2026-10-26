#!/usr/bin/env bash
# renumber-migration.sh - move this branch's migrations after the base's head.
#
#   bash scripts/claude/renumber-migration.sh [--base <ref>] [--dry-run]
#
# Automates nexa-migrations § "Renumbering when two PRs claim the same number".
# Run on the branch checkout AFTER `git merge <base>` (conflicted or committed).
#
#   1. branch migrations = .sql under apps/api/drizzle in HEAD but not in <base>
#   2. GENERATED if the branch added meta/NNNN_snapshot.json for it, else
#      HAND-WRITTEN
#   3. journal + snapshots restart from <base>'s (a conflicted merge is resolved
#      that way; the output says so)
#   4. in original order: generated -> regenerate with drizzle-kit under the same
#      name; hand-written -> git mv + a journal entry with when = now
#   5. every new .sql must be byte-identical to the saved one (diff printed, exit 1)
#   6. the old tag is replaced by the new one in tracked files outside drizzle/
#
# RENUMBER_GENERATE_CMD overrides the generator. The migration name is appended
# as its last argument, so the default ends in `--name`:
#   pnpm --filter @nexa/api exec drizzle-kit generate --name
# Last line: renumbered=N identical=yes|no. Exit 0 ok, 1 not identical, 2 error.
set -euo pipefail
export LC_ALL=C

BASE=origin/main
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      [ $# -ge 2 ] || { echo "error: --base needs a ref" >&2; exit 2; }
      BASE="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "error: unknown argument $1" >&2; exit 2 ;;
  esac
done
die() { echo "error: $*" >&2; exit 2; }

cd "$(git rev-parse --show-toplevel)"
DR=apps/api/drizzle
META=$DR/meta
JOURNAL=$META/_journal.json
GEN="${RENUMBER_GENERATE_CMD:-pnpm --filter @nexa/api exec drizzle-kit generate --name}"

git rev-parse --verify -q "$BASE^{commit}" >/dev/null || die "base ref $BASE not found"
if ! git merge-base --is-ancestor "$BASE" HEAD && [ ! -f "$(git rev-parse --git-path MERGE_HEAD)" ]; then
  die "$BASE is not merged into HEAD; run: git merge $BASE"
fi

# Unmerged paths: the journal and snapshots are ours to resolve, nothing else is.
unmerged="$(git ls-files -u | cut -f2 | sort -u)"
conflicted_meta=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  case "$p" in
    "$META"/*) conflicted_meta=1 ;;
    *) die "unresolved conflict outside the journal/snapshots: $p" ;;
  esac
done <<<"$unmerged"

tags_of() { # ref -> sorted migration tags (NNNN_name) in apps/api/drizzle
  git ls-tree -r --name-only "$1" -- "$DR" |
    sed -n -E "s#^$DR/([0-9]{4}_[^/]+)\\.sql\$#\\1#p" | sort
}
base_tags="$(tags_of "$BASE")"
mapfile -t BR < <(comm -13 <(printf '%s\n' "$base_tags") <(tags_of HEAD) | grep -v '^$' || true)

base_max=-1
if [ -n "$base_tags" ]; then
  last="$(printf '%s\n' "$base_tags" | tail -n1)"
  base_max=$((10#${last%%_*}))
fi

# Nothing to do: no branch migration, or all of them number after base's head
# with no number used twice.
need=0
if [ "${#BR[@]}" -gt 0 ]; then
  prev=-1
  for t in "${BR[@]}"; do
    n=$((10#${t%%_*}))
    if [ "$n" -le "$base_max" ] || [ "$n" -eq "$prev" ]; then need=1; fi
    prev=$n
  done
fi
if [ "$need" -eq 0 ]; then
  echo "nothing to renumber (base head ${base_max}, branch migrations: ${#BR[@]})"
  exit 0
fi

# Which migrations did the branch generate? It added their snapshot.
branch_added="$(git log --no-renames --diff-filter=A --name-only --format= "$BASE..HEAD" -- "$META" | sort -u)"
declare -a KIND=() NEWTAG=()
NEXT=$((base_max + 1))
for i in "${!BR[@]}"; do
  t="${BR[$i]}"
  num="${t%%_*}"
  if grep -qxF "$META/${num}_snapshot.json" <<<"$branch_added"; then KIND[i]=generated; else KIND[i]=hand-written; fi
  NEWTAG[i]="$(printf '%04d' "$NEXT")_${t#*_}"
  NEXT=$((NEXT + 1))
done

# Tracked files outside drizzle/ that name an old tag.
ref_files() {
  local i
  for i in "${!BR[@]}"; do
    [ "${BR[$i]}" != "${NEWTAG[$i]}" ] || continue
    git grep -l -I -F -w -e "${BR[$i]}" -- . ":(exclude)$DR" || true
  done | sort -u
}

if [ "$DRY" -eq 1 ]; then
  echo "dry-run: base=$BASE head=${base_max}; nothing is changed"
  if [ "$conflicted_meta" -eq 1 ]; then echo "would take $BASE's version of the conflicted journal/snapshots"; fi
  for i in "${!BR[@]}"; do echo "plan: ${BR[$i]} -> ${NEWTAG[$i]} (${KIND[$i]})"; done
  while IFS= read -r f; do [ -z "$f" ] || echo "would update references in: $f"; done < <(ref_files)
  echo "renumbered=0 identical=yes"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for t in "${BR[@]}"; do git show "HEAD:$DR/$t.sql" >"$tmp/$t.sql"; done

# Journal and snapshots restart from base's; the branch's own snapshots go.
if [ "$conflicted_meta" -eq 1 ]; then
  echo "journal/snapshots conflicted: taking $BASE's version"
else
  echo "journal/snapshots: restarting from $BASE's"
fi
git checkout "$BASE" -- "$META"
comm -13 <(git ls-tree -r --name-only "$BASE" -- "$META" | sort) \
  <(git ls-tree -r --name-only HEAD -- "$META" | sort) |
  while IFS= read -r p; do
    [ -z "$p" ] || git rm -q -f --ignore-unmatch -- "$p"
  done
for i in "${!BR[@]}"; do
  if [ "${KIND[$i]}" = generated ]; then git rm -q -f --ignore-unmatch -- "$DR/${BR[$i]}.sql"; fi
done

for i in "${!BR[@]}"; do
  old="${BR[$i]}"
  new="${NEWTAG[$i]}"
  if [ "${KIND[$i]}" = generated ]; then
    if ! bash -c "$GEN \"\$1\"" renumber-generate "${old#*_}" >"$tmp/generate.log" 2>&1; then
      tail -n 8 "$tmp/generate.log" >&2
      die "generate failed for $old"
    fi
    [ -f "$DR/$new.sql" ] || {
      tail -n 8 "$tmp/generate.log" >&2
      die "generate did not write $new.sql (nothing to migrate, or a different number)"
    }
    echo "regenerated $old -> $new"
  else
    [ "$old" = "$new" ] || git mv -f "$DR/$old.sql" "$DR/$new.sql"
    node -e '
const fs = require("fs");
const [f, idx, tag] = process.argv.slice(1);
const raw = fs.readFileSync(f, "utf8");
const j = JSON.parse(raw);
const last = j.entries[j.entries.length - 1];
if (last.idx + 1 !== Number(idx)) {
  console.error("error: journal head is idx " + last.idx + ", expected " + (Number(idx) - 1));
  process.exit(2);
}
const start = Date.now();
while (Date.now() <= last.when && Date.now() - start < 100) { /* wait out a same-millisecond stamp */ }
const when = Date.now();
if (when <= last.when) {
  console.error("error: clock is not past the previous journal stamp " + last.when);
  process.exit(2);
}
j.entries.push({ idx: last.idx + 1, version: last.version, when, tag, breakpoints: last.breakpoints });
fs.writeFileSync(f, JSON.stringify(j, null, 2) + (raw.endsWith("\n") ? "\n" : ""));
' "$JOURNAL" "$((10#${new%%_*}))" "$new" || exit 2
    echo "registered $old -> $new (journal entry, when=now)"
  fi
done
git add -A -- "$DR"

# Byte-identical SQL, or stop and say so.
identical=yes
for i in "${!BR[@]}"; do
  old="${BR[$i]}"
  new="${NEWTAG[$i]}"
  if cmp -s "$tmp/$old.sql" "$DR/$new.sql"; then
    echo "identical: $new.sql"
  else
    identical=no
    echo "DIFFERENT: $new.sql differs from the branch's $old.sql (schemas diverged; read it)"
    { diff -u "$tmp/$old.sql" "$DR/$new.sql" || true; } | sed -n '1,40p'
  fi
done

# References: one pass, so a chain (0282 -> 0283, 0283 -> 0284) cannot cascade.
pairs="$tmp/pairs.tsv"
: >"$pairs"
for i in "${!BR[@]}"; do
  if [ "${BR[$i]}" != "${NEWTAG[$i]}" ]; then printf '%s\t%s\n' "${BR[$i]}" "${NEWTAG[$i]}" >>"$pairs"; fi
done
mapfile -t files < <(ref_files)
if [ "${#files[@]}" -gt 0 ]; then
  node -e '
const fs = require("fs");
const pairs = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
const map = new Map(pairs);
const re = new RegExp("(?<![A-Za-z0-9_])(" + pairs.map(([o]) => o).join("|") + ")(?![A-Za-z0-9_])", "g");
for (const f of process.argv.slice(2)) {
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(re, (m) => map.get(m)));
}
' "$pairs" "${files[@]}"
  git add -- "${files[@]}"
  for f in "${files[@]}"; do echo "reference updated: $f"; done
else
  echo "references: none outside $DR/"
fi
echo "reminder: run pnpm db:check and the migration integration suites (nexa-test-selection)"
echo "renumbered=${#BR[@]} identical=$identical"
[ "$identical" = yes ] || exit 1
