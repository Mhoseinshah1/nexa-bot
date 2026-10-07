#!/usr/bin/env bash
# Legacy migration: VALIDATES the output of scripts/legacy-freeze-checksum.sql, and compares
# two of them (docs/legacy-migration/cutover-runbook.md steps 7 and 9, rollback R5).
#
#   bash legacy-freeze-checksum-verify.sh FILE              # one run is well-formed evidence
#   bash legacy-freeze-checksum-verify.sh FROZEN RESTORED   # both are, and they are equal
#
# A freeze proof is only as good as the files it compares. A client that failed (wrong
# password, missing grant, unknown database, a truncated statement) leaves an empty or
# partial file, and `diff` of two empty files is "equal". So a file is accepted only when:
#   - it is non-empty and is exactly the two result sets the script prints: `base_tables`
#     with one positive integer, then `Table<TAB>Checksum`;
#   - it has exactly `base_tables` checksum lines — one per base table, none missing;
#   - every line is `<db>.<table><TAB><non-negative integer>`: a NULL checksum (a table that
#     vanished or could not be read) is refused, and so is a table named twice.
# Two files are compared after removing each line's `<db>.` prefix, so a restored copy
# under another database name compares by table. Prints counts and table names only —
# never a row. Exit 0 accepted (and equal), 1 refused, 64 usage.
set -o nounset -o pipefail

usage() {
  echo "usage: $0 FILE [RESTORED_FILE]" >&2
  exit 64
}

# Prints the normalised `<table><TAB><checksum>` lines of a valid file; refuses otherwise.
normalised() {
  local file="$1"
  if [[ ! -s "$file" ]]; then
    echo "REFUSED: $file is missing or empty (did the client exit 0?)" >&2
    return 1
  fi
  awk -v file="$file" '
    function refuse(why) { print "REFUSED: " file ": " why > "/dev/stderr"; bad = 1; exit 1 }
    NR == 1 { if ($0 != "base_tables") refuse("line 1 is not the base_tables header"); next }
    NR == 2 {
      if ($0 !~ /^[1-9][0-9]*$/) refuse("line 2 is not a positive base table count")
      expected = $0 + 0; next
    }
    NR == 3 { if ($0 != "Table\tChecksum") refuse("line 3 is not the Table/Checksum header"); next }
    {
      tab = 0
      for (i = length($0); i > 0; i--) if (substr($0, i, 1) == "\t") { tab = i; break }
      if (tab == 0) refuse("line " NR " is not <table><TAB><checksum>")
      name = substr($0, 1, tab - 1); sum = substr($0, tab + 1)
      if (sum !~ /^[0-9]+$/) refuse("line " NR ": checksum of " name " is " sum ", not a number")
      dot = index(name, ".")
      if (dot < 2 || dot == length(name)) refuse("line " NR ": " name " is not <db>.<table>")
      table = substr(name, dot + 1)
      if (table in seen) refuse("table " table " is listed twice")
      seen[table] = 1; rows++
      out[rows] = table "\t" sum
    }
    END {
      if (bad) exit 1
      if (NR < 3) refuse("it ends before the Table/Checksum header")
      if (rows != expected) refuse(rows " checksum lines, but base_tables is " expected)
      for (i = 1; i <= rows; i++) print out[i]
    }
  ' "$file"
}

[[ $# -eq 1 || $# -eq 2 ]] || usage

first="$(normalised "$1")" || exit 1
echo "accepted: $1 ($(printf '%s\n' "$first" | wc -l | tr -d ' ') base tables)"
[[ $# -eq 2 ]] || exit 0

second="$(normalised "$2")" || exit 1
echo "accepted: $2 ($(printf '%s\n' "$second" | wc -l | tr -d ' ') base tables)"
if [[ "$first" != "$second" ]]; then
  echo "DIFFERENT: the restored copy is not the frozen database. Tables that differ:" >&2
  diff <(printf '%s\n' "$first") <(printf '%s\n' "$second") | awk -F'\t' '/^[<>]/ { sub(/^[<>] /, ""); print "  " $1 }' | sort -u >&2
  exit 1
fi
echo "EQUAL: every base table has the same checksum in both files"
