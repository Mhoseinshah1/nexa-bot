#!/usr/bin/env bash
# run-gate.sh - the ONE runner for every test, format, lint, typecheck, db:check
# and verify-stage run in a NEXA round, from every worktree.
#
#   bash scripts/claude/run-gate.sh [--integration] [--priority] [--max-wait <s>] [--raw] [--] <command...>
#   bash scripts/claude/run-gate.sh --hold <name> [--ttl <s>]     # priority marker (lead)
#   bash scripts/claude/run-gate.sh --release <name>
#   bash scripts/claude/run-gate.sh --status
#
# What it enforces, round-wide (the lock directory is shared by every worktree):
#   - at most 2 runs at once: two slot locks;
#   - --integration additionally takes the single integration lock, so only one
#     integration run exists at a time (they share one PostgreSQL server);
#   - the command runs through test-summary.sh, so the digest (passed/failed/
#     skipped, each failure, exit=N log=<path>) is what gets printed, unless
#     --raw; the exit code is the command's own.
#
# There is NO global pause. The lead can instead raise a PRIORITY HOLD:
#   run-gate.sh --hold lead      # runs not marked NEXA_GATE_PRIORITY=lead queue
#   NEXA_GATE_PRIORITY=lead bash scripts/claude/run-gate.sh pnpm verify   # proceeds
#   run-gate.sh --release lead   # queued runs resume by themselves
# A hold is only a marker file with a timestamp and a TTL (default 4 h,
# NEXA_GATE_HOLD_TTL or --ttl), never a pid: a crashed lead cannot wedge the
# round, the hold simply expires and queued runs resume on their own. Nobody ever
# waits for a manual "resume". --priority asserts that NEXA_GATE_PRIORITY is set
# (the name comes from the environment; without the flag the environment alone
# is enough).
#
# Waiting prints at most one line a minute. After --max-wait seconds (default
# 1800) it gives up with exit 75: keep coding, run it again later. A wrapped
# command that itself exits 75 is indistinguishable by code, but the
# "gave up waiting" line is printed only by the gate.
#
# Stale locks cannot exist: a slot or the integration lock is a flock(1) lock on
# a file descriptor held by this process, released by the kernel when the process
# dies, however it dies. The lock files carry no pid and are never removed. The
# wrapped command does NOT inherit the descriptors, so a process it leaves
# behind cannot keep a slot occupied.
#
# Env: NEXA_GATE_DIR (default /tmp/claude-0/nexa-gate), NEXA_GATE_PRIORITY,
# NEXA_GATE_HOLD_TTL (seconds, default 14400), NEXA_GATE_POLL (seconds between
# attempts, default 1), NEXA_GATE_NOTICE (seconds between waiting lines,
# default 60), NEXA_GATE_SLOTS (default 2).
# Exit: the command's code; 75 gave up waiting; 2 usage or environment error.
set -uo pipefail
export LC_ALL=C
umask 000 # the directory is shared between agents; a lock file must be openable by all

here="$(cd "$(dirname "$0")" && pwd)"
GATE="${NEXA_GATE_DIR:-/tmp/claude-0/nexa-gate}"
SLOTS="${NEXA_GATE_SLOTS:-2}"
POLL="${NEXA_GATE_POLL:-1}"
NOTICE="${NEXA_GATE_NOTICE:-60}"
DEFAULT_TTL="${NEXA_GATE_HOLD_TTL:-14400}"
HOLDERS="$GATE/holders"

die() { echo "run-gate: $*" >&2; exit 2; }
usage() { sed -n '2,12p' "$0" >&2; exit 2; }

command -v flock >/dev/null 2>&1 || die "flock(1) is required (util-linux)"
case "$SLOTS" in '' | *[!0-9]*) die "NEXA_GATE_SLOTS must be a number" ;; esac
[ "$SLOTS" -ge 1 ] || die "NEXA_GATE_SLOTS must be at least 1"

is_name() { [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]]; }
is_num() { [[ "$1" =~ ^[0-9]+$ ]]; }
now() { date +%s; }
setup() { mkdir -p "$HOLDERS" 2>/dev/null || die "cannot create $HOLDERS"; }

# holder_field <file> <key>
holder_field() { sed -n "s/^$2=//p" "$1" 2>/dev/null | sed -n '1p'; }

# Remove expired holders (a marker nobody released), print the live names.
live_holders() {
  local f n exp t
  t="$(now)"
  for f in "$HOLDERS"/*; do
    [ -f "$f" ] || continue
    n="$(basename "$f")"
    exp="$(holder_field "$f" expires)"
    if ! is_num "${exp:-x}" || [ "$exp" -le "$t" ]; then
      rm -f -- "$f"
      continue
    fi
    printf '%s\n' "$n"
  done
}

cmd_hold() {
  local name="$1" ttl="$2" t
  is_name "$name" || die "hold name must match [A-Za-z0-9._-]+"
  is_num "$ttl" && [ "$ttl" -ge 1 ] || die "--ttl must be a positive number of seconds"
  setup
  t="$(now)"
  printf 'name=%s\ncreated=%s\nexpires=%s\n' "$name" "$t" "$((t + ttl))" >"$HOLDERS/.$name.$$"
  mv -f -- "$HOLDERS/.$name.$$" "$HOLDERS/$name"
  echo "run-gate: hold '$name' set for ${ttl}s; runs without NEXA_GATE_PRIORITY=$name queue until it is released or expires"
}

cmd_release() {
  local name="$1"
  is_name "$name" || die "hold name must match [A-Za-z0-9._-]+"
  setup
  if [ -f "$HOLDERS/$name" ]; then
    rm -f -- "$HOLDERS/$name"
    echo "run-gate: hold '$name' released; queued runs resume by themselves"
  else
    echo "run-gate: no hold '$name' (already released or expired)"
  fi
}

# busy <lockfile>: 0 when somebody holds it. Probes with a non-blocking flock.
busy() {
  local fd
  [ -e "$1" ] || return 1
  exec {fd}>>"$1" || return 1
  if flock -n "$fd"; then
    exec {fd}>&-
    return 1
  fi
  exec {fd}>&-
  return 0
}

cmd_status() {
  local i busy_n=0 t f n exp left any=0
  setup
  t="$(now)"
  for i in $(seq 1 "$SLOTS"); do
    if busy "$GATE/slot.$i.lock"; then busy_n=$((busy_n + 1)); fi
  done
  echo "slots: $busy_n/$SLOTS busy"
  if busy "$GATE/integration.lock"; then echo "integration: running"; else echo "integration: free"; fi
  for f in "$HOLDERS"/*; do
    [ -f "$f" ] || continue
    n="$(basename "$f")"
    exp="$(holder_field "$f" expires)"
    if is_num "${exp:-x}" && [ "$exp" -gt "$t" ]; then
      left=$((exp - t))
      echo "hold: $n (expires in ${left}s)"
      any=1
    fi
  done
  [ "$any" -eq 1 ] || echo "hold: none"
}

# --- argument parsing --------------------------------------------------------
MODE=run
INTEGRATION=0
PRIORITY_FLAG=0
RAW=0
MAX_WAIT=1800
HOLD_NAME=""
HOLD_TTL="$DEFAULT_TTL"
while [ $# -gt 0 ]; do
  case "$1" in
    --integration) INTEGRATION=1; shift ;;
    --priority) PRIORITY_FLAG=1; shift ;;
    --raw) RAW=1; shift ;;
    --max-wait)
      [ $# -ge 2 ] || die "--max-wait needs seconds"
      is_num "$2" || die "--max-wait must be a number of seconds"
      MAX_WAIT="$2"; shift 2 ;;
    --ttl)
      [ $# -ge 2 ] || die "--ttl needs seconds"
      HOLD_TTL="$2"; shift 2 ;;
    --hold)
      [ $# -ge 2 ] || die "--hold needs a name"
      MODE=hold; HOLD_NAME="$2"; shift 2 ;;
    --release)
      [ $# -ge 2 ] || die "--release needs a name"
      MODE=release; HOLD_NAME="$2"; shift 2 ;;
    --status) MODE=status; shift ;;
    -h | --help) usage ;;
    --) shift; break ;;
    -*) die "unknown option $1" ;;
    *) break ;;
  esac
done

case "$MODE" in
  hold) [ $# -eq 0 ] || die "--hold takes no command"; cmd_hold "$HOLD_NAME" "$HOLD_TTL"; exit 0 ;;
  release) [ $# -eq 0 ] || die "--release takes no command"; cmd_release "$HOLD_NAME"; exit 0 ;;
  status) [ $# -eq 0 ] || die "--status takes no command"; cmd_status; exit 0 ;;
esac

[ $# -gt 0 ] || usage
ME="${NEXA_GATE_PRIORITY:-}"
if [ "$PRIORITY_FLAG" -eq 1 ] && [ -z "$ME" ]; then die "--priority needs NEXA_GATE_PRIORITY=<hold name>"; fi
if [ -n "$ME" ]; then is_name "$ME" || die "NEXA_GATE_PRIORITY must match [A-Za-z0-9._-]+"; fi
setup

# --- queue -------------------------------------------------------------------
INT_FD=""
SLOT_FD=""
SLOT_N=0
# shellcheck disable=SC2329 # runs from the EXIT trap
release_all() {
  if [ -n "$INT_FD" ]; then exec {INT_FD}>&-; INT_FD=""; fi
  if [ -n "$SLOT_FD" ]; then exec {SLOT_FD}>&-; SLOT_FD=""; fi
}
trap 'release_all' EXIT

try_slot() {
  local i fd
  for i in $(seq 1 "$SLOTS"); do
    exec {fd}>>"$GATE/slot.$i.lock" || continue
    if flock -n "$fd"; then SLOT_FD="$fd"; SLOT_N="$i"; return 0; fi
    exec {fd}>&-
  done
  return 1
}

start=$SECONDS
last_notice=-"$NOTICE"
why=""
while :; do
  why=""
  held="$(live_holders)"
  blocker=""
  if [ -n "$held" ]; then
    if [ -z "$ME" ] || ! grep -qxF -- "$ME" <<<"$held"; then blocker="$(sed -n '1p' <<<"$held")"; fi
  fi
  if [ -n "$blocker" ]; then
    why="priority hold '$blocker' (resumes when it is released or expires)"
    # do not sit on the integration lock a priority run may need
    if [ -n "$INT_FD" ]; then exec {INT_FD}>&-; INT_FD=""; fi
  else
    if [ "$INTEGRATION" -eq 1 ] && [ -z "$INT_FD" ]; then
      exec {fd}>>"$GATE/integration.lock" || die "cannot open $GATE/integration.lock"
      if flock -n "$fd"; then INT_FD="$fd"; else exec {fd}>&-; fi
    fi
    if [ "$INTEGRATION" -eq 1 ] && [ -z "$INT_FD" ]; then
      why="another integration run is in progress"
    elif try_slot; then
      break
    else
      why="all $SLOTS slots are busy"
    fi
  fi
  waited=$((SECONDS - start))
  if [ "$waited" -ge "$MAX_WAIT" ]; then
    echo "run-gate: gave up waiting after ${waited}s ($why); keep coding and run it again later (exit 75)" >&2
    exit 75
  fi
  if [ $((waited - last_notice)) -ge "$NOTICE" ]; then
    echo "run-gate: waiting ${waited}s: $why; gives up at ${MAX_WAIT}s" >&2
    last_notice=$waited
  fi
  sleep "$POLL"
done

kind=""
[ "$INTEGRATION" -eq 1 ] && kind=" integration"
echo "run-gate: start slot=$SLOT_N$kind waited=$((SECONDS - start))s: $*" >&2

# --- run ---------------------------------------------------------------------
# Background + wait so a TERM/INT/HUP to the gate stops the command too; the
# command gets the descriptors closed so it cannot keep a lock alive.
if [ "$RAW" -eq 1 ]; then
  CMD=("$@")
else
  CMD=(bash "$here/test-summary.sh" "$@")
fi
child=0
# shellcheck disable=SC2329 # runs from the TERM/INT/HUP trap
stop_child() {
  [ "$child" -gt 1 ] || return 0
  pkill -TERM -P "$child" 2>/dev/null || true
  kill -TERM "$child" 2>/dev/null || true
}
trap stop_child TERM INT HUP
if [ -n "$INT_FD" ]; then
  "${CMD[@]}" {SLOT_FD}>&- {INT_FD}>&- &
else
  "${CMD[@]}" {SLOT_FD}>&- &
fi
child=$!
rc=0
wait "$child" || rc=$?
while kill -0 "$child" 2>/dev/null; do wait "$child" || rc=$?; done
trap - TERM INT HUP
exit "$rc"
