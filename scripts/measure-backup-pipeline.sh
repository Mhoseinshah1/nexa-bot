#!/usr/bin/env bash
# Times the stages of one backup on a real database and prints peak RSS and archive size.
#
#   DATABASE_URL=postgres://... scripts/measure-backup-pipeline.sh [mx:md:mmt ...]
#
# Stages, as the pipeline runs them (docs/backup.md § Speed):
#   dump    pg_dump --format=custom --compress=0 (the dump 7-Zip compresses; no gzip first)
#   seal    7z a -t7z -m0=lzma2 -mx -md -mmt -ms=off -mhe=on, password on the command line (a
#           measurement only: the pipeline sends it on stdin)
#   verify  7z t, then pg_restore into a scratch database (a scratch database with a unique name, created by
#           this run and dropped by it; an existing database is never touched)
#   deliver not measurable here (it is Telegram / S3 network time); printed as N/A
# Each level is "mx:md:mmt", default the pipeline's levels. Needs python3 (peak RSS and CPU), 7z, pg_dump, pg_restore.
# The scratch directory needs free space of about the database size plus the archive.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to the database to dump}"
VERIFY_DB="nexa_measure_$(date +%s)_$$"
CREATED_DB=""
BASE_URL="${DATABASE_URL%/*}"
LEVELS=("$@")
if [ "${#LEVELS[@]}" -eq 0 ]; then LEVELS=("9:64m:1" "5:16m:4"); fi
for tool in 7z pg_dump pg_restore psql python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is not installed" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/nexa-backup-measure.XXXXXX")"
cleanup() {
  rm -rf "$WORK"
  if [ -n "$CREATED_DB" ]; then
    psql "$BASE_URL/postgres" -q -c "drop database if exists $CREATED_DB" || true
  fi
}
trap cleanup EXIT
now() { date +%s.%N; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.1f", b - a }'; }

echo "cores visible: $(nproc)" >&2
t0=$(now)
pg_dump --format=custom --compress=0 --no-owner --file="$WORK/dump.pgc" "$DATABASE_URL"
t1=$(now)
dump_mb=$(( $(stat -c %s "$WORK/dump.pgc") / 1048576 ))
printf 'dump:   %8s s   (%d MiB uncompressed custom format)\n' "$(secs "$t0" "$t1")" "$dump_mb"

printf '%-14s %9s %9s %11s %9s %9s\n' "mx:md:mmt" "seal_s" "peak_MiB" "archive_MiB" "verify_s" "cpu_pct"
for level in "${LEVELS[@]}"; do
  IFS=: read -r mx md mmt <<<"$level"
  rm -f "$WORK/out.7z"
  s0=$(now)
  # python3 reports the child's peak RSS and CPU seconds (GNU time is not in every image).
  python3 -I - "$WORK/time.txt" 7z a -t7z -m0=lzma2 "-mx=$mx" "-md=$md" "-mmt=$mmt" -ms=off -mhe=on \
    -pmeasure -bd -y -- "$WORK/out.7z" "$WORK/dump.pgc" >/dev/null <<'PY'
import resource, subprocess, sys, time
t = time.time()
subprocess.run(sys.argv[2:], check=True, stdout=subprocess.DEVNULL)
u = resource.getrusage(resource.RUSAGE_CHILDREN)
open(sys.argv[1], "w").write("%d %.0f\n" % (u.ru_maxrss, 100 * (u.ru_utime + u.ru_stime) / max(time.time() - t, 0.001)))
PY
  s1=$(now)
  read -r rss_kb cpu <"$WORK/time.txt"
  cpu="${cpu}%"
  size_mb=$(( $(stat -c %s "$WORK/out.7z") / 1048576 ))
  v0=$(now)
  7z t -pmeasure -bd -y -- "$WORK/out.7z" >/dev/null
  7z x -pmeasure -bd -y "-o$WORK/x" -- "$WORK/out.7z" >/dev/null
  psql "$DATABASE_URL" -qAt -c "select 1" >/dev/null
  # No prior DROP: a name that already exists makes CREATE fail and the run stops.
  psql "$BASE_URL/postgres" -q -c "create database $VERIFY_DB"
  CREATED_DB="$VERIFY_DB"
  pg_restore --no-owner --exit-on-error --dbname="$BASE_URL/$VERIFY_DB" "$WORK/x/dump.pgc"
  psql "$BASE_URL/postgres" -q -c "drop database $VERIFY_DB"
  CREATED_DB=""
  VERIFY_DB="nexa_measure_$(date +%s)_$$_$RANDOM"
  rm -rf "$WORK/x"
  v1=$(now)
  printf '%-14s %9s %9d %11d %9s %9s\n' "$level" "$(secs "$s0" "$s1")" $((rss_kb / 1024)) "$size_mb" "$(secs "$v0" "$v1")" "$cpu"
done
echo "deliver: N/A (network time, not measurable here)"
