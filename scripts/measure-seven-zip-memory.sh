#!/usr/bin/env bash
# Measures the real peak resident memory of `7z a` for each backup compression level.
#
#   scripts/measure-seven-zip-memory.sh [size_mb] [mx:md:mmt ...]
#
# SIZE MATTERS, and is the usual way to under-measure. 7-Zip shrinks the dictionary to the input
# when the input is smaller, and LZMA2 only runs a second thread once there is a second block
# of 4x the dictionary to give it. So a level is measured on an input of at least
# max(2 x dict, threads x 4 x dict) - 150 MB for the 64m one-thread level, 600 MB for the 64m
# two-thread level - and a smaller input prints a figure that is TOO LOW for the real thing.
# (A first attempt that forced small blocks measured 96 MB for a 64m dictionary: the encoder
# had clamped the dictionary to the block. Do not do that.)
#
# The levels in apps/api/src/modules/platform/backup/infrastructure/seven-zip-levels.ts carry an
# `estimatedPeakMb` per level. That number is a measurement, not a guess: run this script on a
# machine like the production host and update the table when the figures move.
#
# It writes ~size_mb of pg_dump-like text (COPY rows: uuids, timestamps, jsonb, integers) into a
# scratch directory it creates and removes, so the disk needs about size_mb of free space plus
# the archive (a few percent of it). Peak RSS is read from GNU time (`/usr/bin/time -v`).
set -euo pipefail

SIZE_MB="${1:-150}"
shift || true
LEVELS=("$@")
if [ "${#LEVELS[@]}" -eq 0 ]; then
  LEVELS=("9:64m:1" "7:32m:1" "5:16m:1" "3:4m:1")
fi

if ! command -v 7z >/dev/null 2>&1; then
  echo "7z is not installed; nothing to measure" >&2
  exit 2
fi
if [ ! -x /usr/bin/time ]; then
  echo "GNU time (/usr/bin/time) is not installed" >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/nexa-7z-measure.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "generating ~${SIZE_MB} MB of dump-like text in ${WORK}" >&2
node - "$WORK/dump.sql" "$SIZE_MB" <<'JS'
const fs = require('node:fs');
const crypto = require('node:crypto');
const [, , path, mb] = process.argv;
const target = Number(mb) * 1024 * 1024;
const fd = fs.openSync(path, 'w');
const words = ['wallet', 'order', 'service', 'panel', 'refund', 'telegram', 'customer', 'ledger', 'renew'];
let written = 0;
let n = 0;
while (written < target) {
  let chunk = '';
  for (let i = 0; i < 2000; i += 1) {
    n += 1;
    const id = crypto.randomUUID();
    const ts = new Date(1_700_000_000_000 + n * 977).toISOString();
    const w = words[(n * 7) % words.length];
    chunk += `${id}\t${id.slice(0, 8)}-tenant\t${ts}\t${n % 5000}\t{"kind":"${w}","n":${n},"note":"${w} ${crypto.randomBytes(6).toString('hex')}"}\n`;
  }
  written += fs.writeSync(fd, chunk);
}
fs.closeSync(fd);
JS

printf '%-12s %10s %10s %12s\n' "mx:md:mmt" "peak_MB" "seconds" "archive_MB"
for level in "${LEVELS[@]}"; do
  IFS=: read -r mx md mmt <<<"$level"
  rm -f "$WORK/out.7z"
  /usr/bin/time -v -o "$WORK/time.txt" \
    7z a -t7z -m0=lzma2 "-mx=$mx" "-md=$md" "-mmt=$mmt" -ms=off -mhe=on -pmeasure -bd -y -- \
    "$WORK/out.7z" "$WORK/dump.sql" >/dev/null
  rss_kb="$(awk -F': ' '/Maximum resident set size/ {print $2}' "$WORK/time.txt")"
  wall="$(awk -F': ' '/Elapsed \(wall clock\)/ {print $2}' "$WORK/time.txt")"
  size="$(stat -c %s "$WORK/out.7z")"
  printf '%-12s %10d %10s %12d\n' "$level" $((rss_kb / 1024)) "$wall" $((size / 1048576))
done
