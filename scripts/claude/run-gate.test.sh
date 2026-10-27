#!/usr/bin/env bash
# Self-test for run-gate.sh: real flock locks in a throwaway NEXA_GATE_DIR, jobs
# that block on marker files so concurrency is observed, not assumed.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
gate="${RUN_GATE:-$here/run-gate.sh}"
root="$(mktemp -d)"
W="$root/w" # job markers
mkdir -p "$W" "$root/sum"
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; echo "$2" | sed 's/^/     /'; fail=1; }
check() { if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1" "${3:-}"; fi; }

# shellcheck disable=SC2329 # runs from the EXIT trap
cleanup() {
  local p
  for p in $(jobs -p); do kill -9 "$p" 2>/dev/null || true; done
  pkill -9 -f "$root/job.sh" 2>/dev/null || true
  pkill -9 -f "sleep 31337" 2>/dev/null || true
  rm -rf "$root"
}
trap cleanup EXIT

export NEXA_GATE_POLL=0.1
export NEXA_GATE_NOTICE=60
export TEST_SUMMARY_DIR="$root/sum"
unset NEXA_GATE_PRIORITY NEXA_GATE_SLOTS NEXA_GATE_HOLD_TTL

# job.sh <name>: marks started, blocks until go.<name> exists, marks finished.
cat >"$root/job.sh" <<'JOB'
#!/usr/bin/env bash
W="$1"; n="$2"
touch "$W/started.$n"
while [ ! -e "$W/go.$n" ]; do sleep 0.05; done
touch "$W/finished.$n"
JOB

newgate() { export NEXA_GATE_DIR="$root/gate.$1"; rm -rf "$NEXA_GATE_DIR"; rm -f "$W"/*; }
# launch <name> [gate args...]: a gated job in the background, output in $W/out.<name>
launch() {
  local n="$1"; shift
  bash "$gate" "$@" --raw bash "$root/job.sh" "$W" "$n" >"$W/out.$n" 2>&1 &
  LAST_PID=$!
}
started() { [ -e "$W/started.$1" ]; }
go() { touch "$W/go.$1"; }
waitfor() { # <seconds> <cmd...>
  local t="$1" i; shift
  for ((i = 0; i < t * 20; i++)); do "$@" && return 0; sleep 0.05; done
  return 1
}
settle() { sleep 0.8; } # long enough for a queued job to have started if it could
running() { # count of started-but-not-finished jobs
  local n c=0
  for f in "$W"/started.*; do
    [ -e "$f" ] || continue
    n="${f##*/started.}"
    [ -e "$W/finished.$n" ] || c=$((c + 1))
  done
  echo "$c"
}
drain() { # let every job finish and be reaped
  local f
  local i p
  for f in "$W"/started.*; do [ -e "$f" ] && touch "$W/go.${f##*/started.}"; done
  for ((i = 0; i < 100; i++)); do [ -z "$(jobs -r)" ] && break; sleep 0.05; done
  for p in $(jobs -p); do kill -9 "$p" 2>/dev/null; done # a run that never started is a failure above, not a hang
  { wait; } 2>/dev/null
}

# --- exit code of the wrapped command is the gate's, with and without the digest
newgate codes
bash "$gate" --raw bash -c 'exit 7' >/dev/null 2>&1; rc=$?
[ "$rc" -eq 7 ] && r=0 || r=1
check "exit code propagated (--raw)" "$r" "rc=$rc"
bash "$gate" bash -c 'echo " Tests  1 failed | 2 passed (3)"; exit 3' >"$root/o" 2>&1; rc=$?
[ "$rc" -eq 3 ] && r=0 || r=1
check "exit code propagated (through test-summary)" "$r" "rc=$rc"
bash "$gate" bash -c 'echo " Tests  2 passed (2)"' >"$root/o" 2>&1
grep -q '^passed=2 failed=0 skipped=0$' "$root/o" && grep -q '^exit=0 log=' "$root/o" && r=0 || r=1
check "the test-summary digest is printed" "$r" "$(cat "$root/o")"
bash "$gate" --raw bash -c 'echo " Tests  2 passed (2)"' >"$root/o" 2>&1
grep -q '^passed=' "$root/o" && r=1 || r=0
check "--raw prints the command's own output, no digest" "$r" "$(cat "$root/o")"

# --- at most 2 concurrent runs
newgate cap
launch a; launch b; waitfor 5 started a && waitfor 5 started b
check "two runs start at once" "$?"
launch c; settle
started c && r=1 || r=0
check "a third run queues while two are running" "$r" "running=$(running)"
grep -q 'waiting .*slots are busy' "$W/out.c" && r=0 || r=1
check "the queued run says why it waits" "$r" "$(cat "$W/out.c")"
bash "$gate" --status >"$root/o"; grep -q '^slots: 2/2 busy' "$root/o" && r=0 || r=1
check "--status shows both slots busy" "$r" "$(cat "$root/o")"
go a
waitfor 5 started c
check "the queued run starts by itself when a slot frees" "$?" "$(cat "$W/out.c")"
[ "$(running)" -le 2 ] && r=0 || r=1
check "never more than 2 running" "$r" "running=$(running)"
drain

# --- a lock-less state has nothing stale: kill -9 the gate, the slot is free again
newgate stale
export NEXA_GATE_SLOTS=1
launch a; waitfor 5 started a
kill -9 "$LAST_PID"; pkill -9 -f "$root/job.sh" 2>/dev/null; { wait "$LAST_PID"; } 2>/dev/null
bash "$gate" --max-wait 3 --raw true >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && r=0 || r=1
check "a SIGKILLed run leaves no stale slot (flock dies with the process)" "$r" "rc=$rc"
[ -z "$(find "$NEXA_GATE_DIR" -name '*pid*')" ] && r=0 || r=1
check "no pid files in the lock directory" "$r" "$(find "$NEXA_GATE_DIR")"
# a process the command leaves behind does not keep the slot
newgate leak
bash "$gate" --raw bash -c 'sleep 31337 >/dev/null 2>&1 & disown' >/dev/null 2>&1
bash "$gate" --max-wait 3 --raw true >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && r=0 || r=1
check "a daemon left behind by the command does not hold the slot" "$r" "rc=$rc"
pkill -9 -f "sleep 31337" 2>/dev/null
unset NEXA_GATE_SLOTS

# --- integration exclusivity
newgate int
launch i1 --integration; waitfor 5 started i1
launch i2 --integration; settle
started i2 && r=1 || r=0
check "a second integration run queues although a slot is free" "$r"
grep -q 'another integration run' "$W/out.i2" && r=0 || r=1
check "the queued integration run says why" "$r" "$(cat "$W/out.i2")"
launch p1; waitfor 5 started p1
check "a plain run still takes the free slot beside an integration run" "$?"
go i1
waitfor 5 started i2
check "the second integration run starts when the first ends" "$?" "$(cat "$W/out.i2")"
drain
# integration waiting for a slot does not deadlock plain runs
newgate int2
launch a; launch b; waitfor 5 started a && waitfor 5 started b
launch i1 --integration; settle
started i1 && r=1 || r=0
check "an integration run waits for a slot too" "$r"
go a; waitfor 5 started i1
check "and runs when one frees" "$?"
drain

# --- priority hold: queue, then resume by itself
newgate prio
bash "$gate" --hold lead >/dev/null
check "--hold writes a marker" "$?"
[ -f "$NEXA_GATE_DIR/holders/lead" ] && grep -q '^expires=' "$NEXA_GATE_DIR/holders/lead" && r=0 || r=1
check "the hold file holds a timestamp and expiry, no pid" "$r" "$(cat "$NEXA_GATE_DIR/holders/lead" 2>/dev/null)"
grep -qi pid "$NEXA_GATE_DIR/holders/lead" && r=1 || r=0
check "the hold file names no pid" "$r"
launch q1; settle
started q1 && r=1 || r=0
check "a run without the priority name queues under a hold" "$r"
grep -q "priority hold 'lead'" "$W/out.q1" && r=0 || r=1
check "the queued run names the hold" "$r" "$(cat "$W/out.q1")"
NEXA_GATE_PRIORITY=lead launch pr1; waitfor 5 started pr1
check "a run with NEXA_GATE_PRIORITY=lead proceeds under the hold" "$?"
NEXA_GATE_PRIORITY=other launch o1; settle
started o1 && r=1 || r=0
check "a run with another priority name queues" "$r"
NEXA_GATE_PRIORITY=lead launch pr2 --priority; waitfor 5 started pr2
check "--priority with the matching env proceeds" "$?"
bash "$gate" --raw --priority true >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && r=0 || r=1
check "--priority without NEXA_GATE_PRIORITY is a usage error (exit 2)" "$r" "rc=$rc"
go pr1; go pr2 # free both slots; the queued runs need one each
bash "$gate" --release lead >/dev/null
waitfor 5 started q1 && waitfor 5 started o1
check "queued runs resume by themselves when the hold is released" "$?" "$(cat "$W/out.q1")"
out="$(bash "$gate" --release lead)"
[[ "$out" == *"no hold"* ]] && r=0 || r=1
check "--release is idempotent" "$r"
drain

# --- the hold expires on its own (a crashed lead cannot wedge the round)
newgate ttl
bash "$gate" --hold lead --ttl 2 >/dev/null
launch t1; settle
started t1 && r=1 || r=0
check "queued under a 2 s hold" "$r"
waitfor 6 started t1
check "queued run resumes by itself once the hold expires (TTL)" "$?" "$(cat "$W/out.t1")"
[ -e "$NEXA_GATE_DIR/holders/lead" ] && r=1 || r=0
check "the expired hold file is purged" "$r"
out="$(bash "$gate" --status)"
[[ "$out" == *"hold: none"* ]] && r=0 || r=1
check "--status shows no hold" "$r"
drain
newgate ttl-env
NEXA_GATE_HOLD_TTL=1 bash "$gate" --hold lead >/dev/null
sleep 1.3
bash "$gate" --max-wait 2 --raw true >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && r=0 || r=1
check "NEXA_GATE_HOLD_TTL sets the default TTL" "$r" "rc=$rc"

# --- exit 75 on timeout, one waiting line per minute at most
newgate to
launch a; launch b; waitfor 5 started a && waitfor 5 started b
t0=$SECONDS
bash "$gate" --max-wait 2 --raw true >"$root/o" 2>&1; rc=$?
dt=$((SECONDS - t0))
[ "$rc" -eq 75 ] && [ "$dt" -le 6 ] && r=0 || r=1
check "gives up with exit 75 after --max-wait" "$r" "rc=$rc after ${dt}s: $(cat "$root/o")"
grep -q 'gave up waiting' "$root/o" && r=0 || r=1
check "and says so" "$r" "$(cat "$root/o")"
[ "$(grep -c 'run-gate: waiting' "$root/o")" -le 1 ] && r=0 || r=1
check "waiting prints at most one line per NOTICE interval" "$r" "$(cat "$root/o")"
bash "$gate" --max-wait 0 --raw true >/dev/null 2>&1; rc=$?
[ "$rc" -eq 75 ] && r=0 || r=1
check "--max-wait 0 tries once and gives up" "$r" "rc=$rc"
drain
newgate to-hold
bash "$gate" --hold lead >/dev/null
bash "$gate" --max-wait 1 --raw true >"$root/o" 2>&1; rc=$?
[ "$rc" -eq 75 ] && grep -q "priority hold 'lead'" "$root/o" && r=0 || r=1
check "exit 75 while a hold blocks" "$r" "rc=$rc $(cat "$root/o")"
bash "$gate" --release lead >/dev/null

# --- usage errors
newgate usage
bash "$gate" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && r=0 || r=1
check "no command: exit 2" "$r" "rc=$rc"
bash "$gate" --hold 'bad name' >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && r=0 || r=1
check "a hold name with a space is refused" "$r" "rc=$rc"
bash "$gate" --max-wait x true >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && r=0 || r=1
check "--max-wait must be a number" "$r" "rc=$rc"

exit "$fail"
