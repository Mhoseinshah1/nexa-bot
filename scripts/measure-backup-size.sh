#!/usr/bin/env bash
# Measures what a backup of a database WOULD weigh: the pg_dump and 7-Zip steps of the
# pipeline with the pipeline's own arguments, and nothing else (v0.9.7 PR-2).
#
#   scripts/measure-backup-size.sh DATABASE_URL [--leave-out-data TABLE ...] [--threads N]
#
# The dump is `pg_dump --format=custom --compress=0 --no-owner --no-acl` plus one
# `--exclude-table-data` per table in apps/api/src/modules/platform/backup/infrastructure/
# backup-exclusions.ts (read from that file, so the two cannot drift), exactly as
# PostgresDatabaseTools.dump writes it for a 7-Zip archive. The archive is 7-Zip LZMA2 at the
# strongest level of seven-zip-levels.ts (-mx=9 -md=64m), AES-256 with encrypted headers,
# non-solid — the production seal. --threads (default 1, as production) only changes the wall
# time: LZMA2 at -mmt=2 runs one dictionary on two threads, so the size is the same.
#
# --leave-out-data TABLE adds an `--exclude-table-data` for a SCENARIO, never for production:
# what the archive would weigh once a table is empty (PR-1's post-import cleanup drops
# legacy_import_map, legacy_service_candidates, legacy_trial_eligibility and the staging
# table; E3 removes published outbox history after 7 days). Say which scenario you measured.
#
# Prints the plaintext dump size, the archive size and the number of 45 MiB parts Telegram
# would receive (BACKUP_PART_MAX_BYTES). Reads the database; writes nothing to it. The
# password is a throwaway: the archive is deleted with the scratch directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="${1:?usage: measure-backup-size.sh DATABASE_URL [--leave-out-data TABLE ...] [--threads N]}"
shift
THREADS=1
SCENARIO=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --leave-out-data) SCENARIO+=("${2:?--leave-out-data needs a table}"); shift 2 ;;
    --threads) THREADS="${2:?--threads needs a number}"; shift 2 ;;
    *) printf 'measure-backup-size: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done
command -v 7z >/dev/null 2>&1 || { echo '7z is not installed; nothing to measure' >&2; exit 2; }

PART_BYTES=$((45 * 1024 * 1024))
WORK="$(mktemp -d "${TMPDIR:-/tmp}/nexa-backup-size.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

args=()
while IFS= read -r table; do
  args+=("--exclude-table-data=public.${table}")
done < <(sed -n "s/^    table: '\([a-z_0-9]*\)',$/\1/p" \
  "$ROOT/apps/api/src/modules/platform/backup/infrastructure/backup-exclusions.ts")
[ "${#args[@]}" -gt 0 ] || { echo 'could not read the exclusion list' >&2; exit 1; }
for table in "${SCENARIO[@]}"; do args+=("--exclude-table-data=public.${table}"); done

printf 'excluded data: %s\n' "${args[*]#--exclude-table-data=}"
pg_dump --format=custom --compress=0 --no-owner --no-acl "${args[@]}" \
  --file "$WORK/dump.pgcustom" "$URL"
dump_bytes="$(stat -c %s "$WORK/dump.pgcustom")"
printf '{"manifestVersion":1}\n' >"$WORK/manifest.json"
# A throwaway password in argv is fine HERE (the archive dies with the scratch directory);
# production passes the real one on stdin.
7z a -t7z -m0=lzma2 -mx=9 -md=64m "-mmt=${THREADS}" -ms=off -mhe=on -pmeasure -bd -y -- \
  "$WORK/archive.7z" "$WORK/manifest.json" "$WORK/dump.pgcustom" >/dev/null
archive_bytes="$(stat -c %s "$WORK/archive.7z")"
parts=$(((archive_bytes + PART_BYTES - 1) / PART_BYTES))
printf 'dump      %12d bytes (%d MiB)\n' "$dump_bytes" $((dump_bytes / 1048576))
printf 'archive   %12d bytes (%d MiB)\n' "$archive_bytes" $((archive_bytes / 1048576))
printf 'parts     %12d (of %d MiB each)\n' "$parts" $((PART_BYTES / 1048576))
