#!/usr/bin/env bash
# Shared by the installer and by botctl. Installed to /opt/nexa/lib/nexa-lib.sh.
#
# Everything here assumes every external string is hostile: a version an
# operator typed, a domain pasted from a ticket, a value read out of a file.
# Nothing is ever `eval`ed, nothing is interpolated into a shell string that is
# then re-parsed, and every expansion is quoted.
#
# shellcheck shell=bash

# --- Where things live -------------------------------------------------------
#
# Four locations with four different lifetimes, which is the whole point of
# separating them:
#
#   /opt/nexa      deployment assets that belong to a release. Replaced.
#   /etc/nexa      configuration and secrets. Survives every update. 0700.
#   /var/lib/nexa  release manifests and the current/previous pointers.
#   /var/backups   database dumps. Survives everything.
#
# Overridable ONLY so the test harness can run against a temporary root. A
# production install never sets these.
NEXA_ROOT="${NEXA_ROOT:-}"
NEXA_DEPLOY_DIR="${NEXA_DEPLOY_DIR:-${NEXA_ROOT}/opt/nexa/deploy}"
NEXA_LIB_DIR="${NEXA_LIB_DIR:-${NEXA_ROOT}/opt/nexa/lib}"
NEXA_CONFIG_DIR="${NEXA_CONFIG_DIR:-${NEXA_ROOT}/etc/nexa}"
NEXA_STATE_DIR="${NEXA_STATE_DIR:-${NEXA_ROOT}/var/lib/nexa}"
NEXA_BACKUP_DIR="${NEXA_BACKUP_DIR:-${NEXA_ROOT}/var/backups/nexa}"
NEXA_BIN_DIR="${NEXA_BIN_DIR:-${NEXA_ROOT}/usr/local/bin}"
# The lock lives in the state directory, NOT in /var/lock.
#
# On Ubuntu /var/lock is a symlink to /run/lock, which is mode 1777. Two things
# follow. The installer would have to create a directory there, and `install -d`
# on an existing one CHANGES ITS MODE — so installing Nexa would have dropped
# the sticky bit off a host directory the rest of the system shares. And any
# local user could create nexa.lock first and hold flock on it, so every future
# `botctl update` would refuse with "another operation is already running" and
# no operation would be running. Neither needs privilege to arrange.
#
# /var/lib/nexa is 0750 and root-owned. The lock has the same reachability as
# the release state it protects, which is the correct answer to both.
NEXA_LOCK_FILE="${NEXA_LOCK_FILE:-${NEXA_STATE_DIR}/nexa.lock}"

NEXA_RELEASES_DIR="${NEXA_STATE_DIR}/releases"
NEXA_CURRENT_FILE="${NEXA_STATE_DIR}/current"
NEXA_PREVIOUS_FILE="${NEXA_STATE_DIR}/previous"

# Host assets, staged per release.
#
# `botctl` itself, its library, the compose file, the env template and the
# Caddy configuration live on the HOST, outside the immutable image. They are
# release-versioned behaviour — `botctl secrets` exists in one release and not
# the previous one — so a release that moves the image without moving them
# leaves an installation running B and operated by A's tooling. That is exactly
# what a real staging host showed: `botctl version` reported v0.1.0-staging.5
# while `botctl secrets status` answered `unknown command "secrets"`.
#
# Each release's set is staged here under its version, so an update can install
# the target's assets and a rollback can put the previous release's back.
NEXA_ASSETS_DIR="${NEXA_STATE_DIR}/assets"

# The image repository. A release is `${NEXA_IMAGE_REPO}@sha256:...`.
NEXA_IMAGE_REPO="${NEXA_IMAGE_REPO:-ghcr.io/mhoseinshah1/nexa-bot}"

# How many previous releases' manifests are kept. Bounded and stated, rather
# than growing without limit — one is the minimum that makes rollback possible,
# and five leaves room to look back at what changed.
NEXA_KEEP_RELEASES="${NEXA_KEEP_RELEASES:-5}"

# --- Output ------------------------------------------------------------------
#
# Nothing in this file ever prints a value read out of a secret file. The
# functions that touch secrets say what they DID, never what they saw.
nexa_log() { printf '%s\n' "$*"; }
nexa_step() { printf '\033[1m==>\033[0m %s\n' "$*"; }
nexa_ok() { printf '\033[32mok\033[0m    %s\n' "$*"; }
nexa_warn() { printf '\033[33mwarn\033[0m  %s\n' "$*" >&2; }
nexa_die() {
  printf '\033[31merror\033[0m %s\n' "$*" >&2
  exit 1
}

# --- Validation --------------------------------------------------------------
#
# Every one of these is a value that reaches a filesystem path, a container
# image reference or a compose invocation. A rejected value is better than a
# quoted one, because quoting protects this script and says nothing about what
# the value would do three layers down.

# A release version. Deliberately narrow: it becomes part of a filename and of
# an image tag. `..` and `/` are impossible by construction rather than by
# stripping, so no path traversal is reachable from a version string.
nexa_valid_version() {
  [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] && [[ $1 != *..* ]]
}

# A DNS name. Length-bounded, label-structured, no scheme, no path, no port.
nexa_valid_domain() {
  [[ $1 =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] &&
    [ ${#1} -le 253 ]
}

# An image digest, as `sha256:` plus exactly 64 lowercase hex characters.
nexa_valid_digest() {
  [[ $1 =~ ^sha256:[0-9a-f]{64}$ ]]
}

nexa_require_version() {
  nexa_valid_version "$1" ||
    nexa_die "\"$1\" is not a usable version: letters, digits, dot, dash and underscore only, up to 64 characters."
}

# --- Reading configuration ---------------------------------------------------

# Read ONE value out of a KEY=VALUE file, without sourcing it.
#
# `source` would execute the file. These files are ours and 0600 root-owned, so
# that is not the threat today — but a maintenance CLI that executes its own
# configuration is one editing mistake away from being a shell injection, and
# the parse costs nothing.
#
# Prints the value; returns 1 when the key is absent.
nexa_env_value() {
  local file="$1" key="$2" line
  [ -r "$file" ] || return 1
  # The LAST assignment wins, matching how a shell would read the file.
  line="$(grep -E "^${key}=" -- "$file" | tail -n 1 || true)"
  [ -n "$line" ] || return 1
  local value="${line#*=}"
  # Strip one layer of surrounding quotes if present.
  if [[ $value == \"*\" ]]; then value="${value:1:${#value}-2}"; fi
  if [[ $value == \'*\' ]]; then value="${value:1:${#value}-2}"; fi
  printf '%s' "$value"
}

# --- Docker Compose ----------------------------------------------------------
#
# One place that knows how the deployment is invoked. `--env-file` supplies the
# non-secret interpolation values; the per-service `env_file:` entries inside
# the compose file supply the application configuration, and the Docker daemon
# reads those as root so no container needs permission to.
nexa_compose() {
  docker compose \
    --env-file "${NEXA_CONFIG_DIR}/deploy.env" \
    -f "${NEXA_DEPLOY_DIR}/compose.yml" \
    "$@"
}

# --- Releases ----------------------------------------------------------------

nexa_current_version() {
  [ -r "$NEXA_CURRENT_FILE" ] || return 1
  tr -d '[:space:]' <"$NEXA_CURRENT_FILE"
}

nexa_previous_version() {
  [ -r "$NEXA_PREVIOUS_FILE" ] || return 1
  tr -d '[:space:]' <"$NEXA_PREVIOUS_FILE"
}

nexa_manifest_path() {
  printf '%s/%s.json' "$NEXA_RELEASES_DIR" "$1"
}

# Read one field out of a release manifest with a real JSON parser.
#
# `grep`-ing JSON is how a digest becomes a substring of something else. Python
# is present on every supported Ubuntu; `jq` is not, and requiring it would be
# another install-time dependency for one field lookup.
nexa_manifest_field() {
  local version="$1" field="$2" path
  path="$(nexa_manifest_path "$version")"
  [ -r "$path" ] || return 1
  python3 -c '
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    data = json.load(handle)
value = data.get(sys.argv[2])
if value is None:
    sys.exit(1)
print(value)
' "$path" "$field"
}

# Write a release manifest. The three facts that identify a release travel
# together: what it is called, what source it came from, and what actually runs.
nexa_write_manifest() {
  local version="$1" commit="$2" digest="$3" path
  nexa_valid_digest "$digest" || nexa_die "refusing to record a release with a malformed digest."
  path="$(nexa_manifest_path "$version")"
  mkdir -p "$NEXA_RELEASES_DIR"
  # Into place, not in place. This is the one file `botctl rollback` cannot
  # proceed without, and `open(path, "w")` truncates before it writes — so an
  # interruption here leaves an empty manifest where a missing one would have
  # been honestly refused.
  python3 -c '
import json, os, sys
manifest = {
    "version": sys.argv[2],
    "commit": sys.argv[3],
    "digest": sys.argv[4],
    "image": sys.argv[5] + "@" + sys.argv[4],
    "recordedAt": sys.argv[6],
}
temporary = sys.argv[1] + ".partial"
with open(temporary, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2, sort_keys=True)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.replace(temporary, sys.argv[1])
' "$path" "$version" "$commit" "$digest" "$NEXA_IMAGE_REPO" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  chmod 0644 "$path"
}

# The image reference a release runs, always by digest.
nexa_release_image() {
  local version="$1" digest
  digest="$(nexa_manifest_field "$version" digest)" || return 1
  nexa_valid_digest "$digest" || return 1
  printf '%s@%s' "$NEXA_IMAGE_REPO" "$digest"
}

# --- Resolving a version to an immutable digest -------------------------------
#
# The step that makes `latest` impossible as a durable identity. The tag is
# consulted ONCE, here, and everything afterwards addresses the image by the
# digest this returned — so a tag repointed a second later cannot change what
# gets installed.
nexa_resolve_digest() {
  local version="$1" reference digest
  nexa_valid_version "$version" || return 1
  reference="${NEXA_IMAGE_REPO}:${version}"

  # `imagetools inspect` reads the registry without downloading layers. The
  # `--format` template is fixed text, not built from input.
  digest="$(docker buildx imagetools inspect "$reference" --format '{{.Manifest.Digest}}' 2>/dev/null || true)"

  if [ -z "$digest" ]; then
    # Older Docker without buildx. `docker manifest inspect -v` reports the
    # descriptor digest for the same reference.
    #
    # `--insecure` ONLY for a loopback registry, and never otherwise. A
    # registry on 127.0.0.1 has no TLS to verify and no network segment to be
    # intercepted on; the deployment smoke test runs one so that digests are
    # real rather than simulated. Any other host keeps TLS verification, which
    # is what makes a digest resolved over the network worth trusting.
    local insecure=()
    case "$NEXA_IMAGE_REPO" in
      127.0.0.1:* | localhost:*) insecure=(--insecure) ;;
    esac
    digest="$(docker manifest inspect "${insecure[@]+"${insecure[@]}"}" -v "$reference" 2>/dev/null |
      python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
# A multi-arch reference reports a list; a single-arch one reports an object.
if isinstance(data, list):
    data = data[0] if data else {}
print(data.get("Descriptor", {}).get("digest", ""))
' 2>/dev/null || true)"
  fi

  digest="$(printf '%s' "$digest" | tr -d '[:space:]')"
  nexa_valid_digest "$digest" || return 1
  printf '%s' "$digest"
}

# Pull BY DIGEST and confirm the daemon holds exactly that image.
#
# Pulling by digest is what makes the resolution above binding: the registry
# cannot substitute a different image for a digest without breaking the digest.
# The verification afterwards is not ceremony — it is the difference between
# "we asked for that" and "that is what is here".
nexa_pull_release() {
  local digest="$1" reference
  nexa_valid_digest "$digest" || nexa_die "refusing to pull a malformed digest."
  reference="${NEXA_IMAGE_REPO}@${digest}"

  docker pull --quiet "$reference" >/dev/null ||
    nexa_die "could not pull ${NEXA_IMAGE_REPO} at ${digest}. The current release is untouched."

  local actual
  actual="$(docker image inspect "$reference" --format '{{.Id}}' 2>/dev/null || true)"
  [ -n "$actual" ] ||
    nexa_die "pulled ${digest} but the daemon does not have it. Refusing to continue."
}

# --- Readiness ---------------------------------------------------------------
#
# Bounded, and it reads the API's OWN health check — the same
# `/health/ready` a load balancer would use, run from inside the container by
# the compose healthcheck. Polling from the host would need the edge, TLS and
# DNS to be working to answer a question about the application.
# Both application services, not the API alone.
#
# The worker is half of the application: the outbox relay, the notification
# dispatcher and the sweepers run there and nowhere else. A release whose API
# answers its probe while its worker is in a crash loop was accepted as
# "ready" — and every domain event queued, every alert stayed unsent, and the
# update reported success. So readiness is the API healthy AND the worker
# healthy, and the worker's health is a real signal: its container check reads
# a heartbeat the process writes only after it has reached the database.
NEXA_READY_SERVICES="api worker"

nexa_wait_ready() {
  # An explicit argument WINS; NEXA_READY_TIMEOUT is the default when there is
  # none. The other way round — the environment overriding the caller — meant
  # an operator who raised the variable for a slow host also made
  # `botctl status`'s deliberately quick five-second probe wait that long, and
  # a status command that hangs is one nobody runs while something is wrong.
  #
  # So: `status` passes 5 and always gets 5; `update` and `rollback` pass
  # nothing and take the variable, which is what the smoke test lowers so a
  # failure case does not take three minutes to prove.
  local timeout="${1:-${NEXA_READY_TIMEOUT:-180}}" waited=0 state
  while [ "$waited" -lt "$timeout" ]; do
    # SC2016: the single quotes are the point. This is Python source, and the
    # shell must not expand anything inside it — an interpolated value here
    # would be code, not data.
    # shellcheck disable=SC2016
    # `--all`, because without it an api container that EXITED is simply not
    # listed: the parse yields nothing, that reads as "not ready yet", and the
    # loop waits out the entire timeout for a container that is gone. With it
    # the `exited | dead` fast-fail below is reachable, which is the difference
    # between a failed release being backed out in seconds and in six minutes
    # (this wait, then the back-out's own).
    # shellcheck disable=SC2086
    state="$(nexa_compose ps --all --format json $NEXA_READY_SERVICES 2>/dev/null |
      python3 -c '
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    sys.exit(0)
# `docker compose ps --format json` emits either one object per line or a
# single array, depending on the version. Both are handled rather than assumed.
entries = []
try:
    parsed = json.loads(raw)
    entries = parsed if isinstance(parsed, list) else [parsed]
except json.JSONDecodeError:
    for line in raw.splitlines():
        line = line.strip()
        if line:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                pass
# STATE first, then health, and that order is the whole correctness argument.
#
# `docker compose run` containers carry Service == "api" too, and — because
# compose builds a one-off from the same service config — they carry the same
# HEALTHCHECK. So a leftover migration container reports Health "starting",
# exactly like a real api that is still coming up. Preferring "an entry that
# reports a Health" therefore picks the CORPSE over the running container, and
# readiness never returns true while a perfectly healthy release is backed out.
#
# The same shape breaks the exited/dead fast-fail: Docker retains the last
# health status after a container exits, so an api that died after its monitor
# had written "starting" is reported as starting, not exited, and the update
# waits out the full timeout it was supposed to short-circuit.
#
# A container that is RUNNING is the only one whose health means anything.
# Among those, prefer one that has a health status; if none is running, report
# the state of the first entry, so `exited` and `dead` are seen and acted on.
# (No apostrophes in this block: it is inside a single-quoted `python3 -c`, and
# one would end the program early.)
def verdict(service):
    mine = [entry for entry in entries if entry.get("Service") == service]
    running = [entry for entry in mine if entry.get("State") == "running"]
    if running:
        # The BEST health among the running entries, not the first one that
        # has a health at all. A `compose run` container whose client was
        # killed keeps RUNNING, and carries the same healthcheck, so it reports
        # starting — and "first entry with a health" then answers starting
        # while the real container next to it is healthy. Which entry comes
        # first is not something compose promises, so that rule was correct
        # only by luck of ordering.
        healths = [entry.get("Health") or "" for entry in running]
        if "healthy" in healths:
            return "healthy"
        return next((health for health in healths if health), "running")
    if mine:
        # Nothing running. Fast-fail only if EVERY entry is terminal: a
        # leftover corpse alongside a container that is still `created` must
        # not be read as it having died, because that backs out a release that
        # was merely slow — after the migration has already run.
        # A missing State is not evidence of life. Treating "" as alive let
        # one malformed entry beside a genuinely dead api suppress the
        # fast-fail.
        states = [entry.get("State") or "" for entry in mine]
        alive = [state for state in states if state and state not in ("exited", "dead")]
        return alive[0] if alive else next((state for state in states if state), "")
    # Not listed at all. Not "healthy", not terminal: the loop keeps waiting,
    # which is what a service that has not been created yet deserves — and a
    # service that is MISSING from a topology that requires it never becomes
    # healthy, so the wait times out rather than passing.
    return ""

# Every required service, and the answer is the WORST of them. A terminal
# state anywhere fast-fails the whole wait: an api that is healthy beside a
# worker that has died is not a release that works, and waiting out the
# timeout for it would only delay the back-out. Anything else reports the
# first service that is not healthy, so the caller sees what it is waiting on.
required = ["api", "worker"]
verdicts = [verdict(service) for service in required]
if any(v in ("exited", "dead") for v in verdicts):
    print(next(v for v in verdicts if v in ("exited", "dead")))
elif all(v == "healthy" for v in verdicts):
    print("healthy")
else:
    print(next((v for v in verdicts if v != "healthy"), ""))
' 2>/dev/null || true)"

    case "$state" in
      healthy) return 0 ;;
      # `exited` and `dead` will not become healthy by waiting.
      exited | dead) return 1 ;;
    esac
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

# --- The update lock ---------------------------------------------------------
#
# One writer at a time across install, update and rollback. Without it, two
# updates can interleave their migrations and their `current` pointer writes,
# and the installation ends up running one release while claiming another.
#
# `flock` on a dedicated file, held for the whole operation by the calling
# shell. `-w` so a stuck operation reports rather than blocking for ever.
nexa_acquire_lock() {
  local timeout="${1:-0}"
  # Mode set explicitly rather than through `mkdir -m`, which applies only to
  # the deepest component created (SC2174) — and only when the directory did
  # not already exist, so a production install's 0750 state directory is not
  # re-chmodded by a lock acquisition.
  local lock_dir
  lock_dir="$(dirname "$NEXA_LOCK_FILE")"
  if [ ! -d "$lock_dir" ]; then
    mkdir -p "$lock_dir" || nexa_die "cannot create ${lock_dir} for the update lock."
    chmod 0750 "$lock_dir"
  fi
  exec {NEXA_LOCK_FD}>>"$NEXA_LOCK_FILE" ||
    nexa_die "cannot open the lock file at ${NEXA_LOCK_FILE}."
  if ! flock -w "$timeout" -x "$NEXA_LOCK_FD"; then
    nexa_die "another install, update or rollback is already running (lock: ${NEXA_LOCK_FILE})."
  fi
}

# --- The current-image pointer -----------------------------------------------
#
# `deploy.env` names the image compose runs when nobody overrides it. It is NOT
# what carries a release across a reboot — Docker restarts the containers that
# already exist, and those carry the image they were created with. What this
# governs is the next `docker compose up`: a restart, another update's back-out
# path, or an operator's own command. Which is exactly why it disagreeing with
# the recorded release is worth detecting: the disagreement is invisible until
# somebody runs one of those.
#
# Written atomically, and — the part that was missing — VERIFIED before the
# rename. A partially-rewritten deploy.env is an installation that cannot start
# at all: every botctl subcommand goes through compose, and compose.yml requires
# NEXA_DOMAIN. This runs immediately after an update has been proven healthy,
# which is the worst possible moment to leave a truncated file.
#
# The rename being atomic was never the whole problem. `grep ... || true` is
# there for grep's exit 1, "no lines selected" — but it swallowed exit 2 just as
# happily, and exit 2 is a read error, an I/O error, or ENOSPC on the write into
# the temporary file. A full /var is the likely trigger, and an update makes one
# likelier by writing a pg_dump just beforehand. The result was a deploy.env
# holding only NEXA_IMAGE, an installation that could not be started, restarted,
# updated, rolled back, backed up or logged, and an update that printed
# "ok updated to ...".
nexa_set_deploy_image() {
  local image="$1" file="${NEXA_CONFIG_DIR}/deploy.env" tmp status
  [ -n "$image" ] || nexa_die "refusing to record an empty image reference."
  case "$image" in
    *@sha256:*) : ;;
    *) nexa_die "refusing to record an image reference that is not a digest: ${image}" ;;
  esac
  tmp="$(mktemp "${file}.XXXXXX")"
  # Same ownership and mode as the file being replaced, set BEFORE any content
  # is written into place.
  chmod 0600 "$tmp"

  # 0 (lines kept) and 1 (none matched) are both fine. Anything else is an
  # error, and the file we would write is not the file we meant to write.
  status=0
  grep -v '^NEXA_IMAGE=' -- "$file" >"$tmp" || status=$?
  if [ "$status" -gt 1 ]; then
    rm -f "$tmp"
    nexa_die "could not read ${file} (grep exited ${status}); deploy.env is UNCHANGED and ${image} was not recorded. Check free space on /var."
  fi
  printf 'NEXA_IMAGE=%s\n' "$image" >>"$tmp" || {
    rm -f "$tmp"
    nexa_die "could not write ${file} (is /var full?); deploy.env is UNCHANGED."
  }

  # The candidate must still be a usable deploy.env. NEXA_DOMAIN is the one
  # compose refuses to start without, so its absence is the cheapest true test
  # of "this file would brick the installation".
  if [ -z "$(nexa_env_value "$tmp" NEXA_DOMAIN)" ]; then
    rm -f "$tmp"
    nexa_die "the rewritten deploy.env lost NEXA_DOMAIN, so it would not start anything. The original is UNCHANGED and ${image} was not recorded."
  fi

  # On disk before the rename: a rename is atomic with respect to other
  # processes, not with respect to power loss.
  sync "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$file"
}

# --- Committing a release ----------------------------------------------------
#
# Three files, and the order they are written in is the whole design. A machine
# can lose power between any two of them, so the question is not "can this be
# interrupted" but "what does each interruption leave, and is it recoverable".
#
# `deploy.env` first, because it is the only one of the three that decides what
# actually RUNS on the next `compose up`. `current` last, because it is what
# every command reports. That ordering makes an interrupted commit fail toward
# "the update has not been recorded yet" rather than toward "the tool believes
# something that is not true":
#
#   interrupted after      current    previous   runs on next `up`   recoverable by
#   ---------------------  ---------  ---------  ------------------  ---------------
#   nothing                previous   —          previous            nothing to do
#   deploy.env             previous   —          TARGET              re-run update
#   previous               previous   previous   TARGET              re-run update
#   (complete)             target     previous   target              —
#
# The old order wrote `current` before `deploy.env`, which produced the one row
# that is not in this table: `botctl version` reporting the target while
# `botctl restart` silently started the PREVIOUS release against the target's
# schema, with nothing anywhere reporting a problem.
#
# `nexa_check_divergence` below detects every non-final row, because "recoverable
# by re-running the update" is only true if somebody is told.
nexa_commit_release() {
  local target="$1" previous="$2" image="$3"
  # `current == previous` is not a state this installation can be in, and the
  # cheapest place to say so is before anything is written. A rollback whose
  # pointers are equal rolls back onto itself, reports success, and repoints
  # deploy.env AWAY from the release the operator was rolling back to — so the
  # real target becomes unreachable through the tool and is eventually pruned.
  [ "$target" != "$previous" ] ||
    nexa_die "refusing to record ${target} as both the current release and the rollback target."
  nexa_set_deploy_image "$image"
  nexa_write_atomic "$NEXA_PREVIOUS_FILE" "$previous"
  nexa_write_atomic "$NEXA_CURRENT_FILE" "$target"
}

# One line, into place, or not at all. `printf > file` truncates first, so an
# interruption mid-write leaves an empty `current` — an installation that
# reports no release at all.
# Rewrite /etc/nexa/nexa.env, setting some keys and removing others.
#
# The one function that edits the application's secret configuration, so the
# rules that make that safe live in exactly one place rather than being
# re-derived by each caller:
#
#   - VALUES NEVER APPEAR IN argv, in a log line, or in an error message. They
#     are read from the caller's named variables here. `nexa.env` holds the key
#     that decrypts every stored credential; a value that reaches `ps`, a shell
#     history or a `set -x` trace has left the file.
#   - The candidate is built beside the destination, given the destination's
#     mode and owner BEFORE any content is written into it, and renamed over it.
#     An interruption leaves the old file, never a half-written one.
#   - The candidate is validated before the rename: every key that was there is
#     still there unless it was named for removal, and every key being set has a
#     non-empty value. A rewrite that silently dropped a line would be an
#     installation that cannot boot, discovered at the restart.
#
# Usage: nexa_env_rewrite FILE REMOVE_CSV NAME1 NAME2 ...
# where each NAME is the name of a shell VARIABLE whose name is the key and
# whose value is the value — passed by reference precisely so no value is ever
# an argument.
nexa_env_rewrite() {
  local file="$1" remove="$2"
  shift 2

  [ -r "$file" ] || nexa_die "cannot read ${file}."

  local tmp
  tmp="$(mktemp "${file}.XXXXXX")" || nexa_die "cannot write beside ${file}."
  # Mode and owner first, while the file is still empty.
  chmod 0600 "$tmp" || { rm -f "$tmp"; nexa_die "cannot set the mode on ${tmp}."; }
  if [ "$(id -u)" -eq 0 ]; then
    chown --reference="$file" "$tmp" 2>/dev/null ||
      { rm -f "$tmp"; nexa_die "cannot set the owner on ${tmp}."; }
  fi

  # Every key this rewrite touches, so the old assignments are dropped exactly
  # once and the new ones are appended in a known order.
  local names=() name key drop_pattern
  for name in "$@"; do names+=("$name"); done

  local removals="${remove}"
  for name in "${names[@]}"; do removals="${removals},${name}"; done

  drop_pattern=""
  local IFS_SAVE="$IFS"
  IFS=','
  for key in $removals; do
    [ -n "$key" ] || continue
    drop_pattern="${drop_pattern}${drop_pattern:+|}^${key}="
  done
  IFS="$IFS_SAVE"

  local status=0
  if [ -n "$drop_pattern" ]; then
    # 0 (lines kept) and 1 (everything matched) are both fine; anything else
    # means the file we would write is not the file we meant to write.
    grep -Ev "$drop_pattern" -- "$file" >"$tmp" || status=$?
  else
    cat -- "$file" >"$tmp" || status=$?
  fi
  if [ "$status" -gt 1 ]; then
    rm -f "$tmp"
    nexa_die "could not read ${file} (grep exited ${status}); it is UNCHANGED. Check free space on /var."
  fi

  for name in "${names[@]}"; do
    # `printf` with the value as an ARGUMENT to this shell's own builtin: it
    # never becomes a process, so it never becomes a line in `ps`.
    printf '%s=%s\n' "$name" "${!name}" >>"$tmp" || {
      rm -f "$tmp"
      nexa_die "could not write ${file} (is /var full?); it is UNCHANGED."
    }
  done

  # Validate the candidate before it becomes the file.
  for name in "${names[@]}"; do
    if [ -z "$(nexa_env_value "$tmp" "$name" 2>/dev/null || true)" ]; then
      rm -f "$tmp"
      nexa_die "the rewritten ${file} has no value for ${name}; the original is UNCHANGED."
    fi
  done
  # Nothing else may have been lost. DATABASE_URL is the cheapest true test that
  # the file would still boot an application.
  if [ -z "$(nexa_env_value "$tmp" DATABASE_URL 2>/dev/null || true)" ]; then
    rm -f "$tmp"
    nexa_die "the rewritten ${file} lost DATABASE_URL, so it would not boot. The original is UNCHANGED."
  fi

  sync "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$file" || nexa_die "cannot install ${file}."
}

nexa_write_atomic() {
  local path="$1" content="$2" tmp
  tmp="$(mktemp "${path}.XXXXXX")" || nexa_die "cannot write ${path}."
  chmod 0644 "$tmp"
  printf '%s\n' "$content" >"$tmp" || {
    rm -f "$tmp"
    nexa_die "cannot write ${path} (is /var full?)."
  }
  sync "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$path"
}

# Does the release the installation CLAIMS match the one it would START?
#
# They can only differ through an interrupted commit or a hand-edited
# deploy.env, and the difference is invisible in every other output: `version`
# reads the manifests, `status` reads the containers, and neither reads the
# other's source. Reported rather than repaired — repairing means choosing which
# of the two is right, and that is the operator's decision, not this script's.
nexa_check_divergence() {
  local version recorded configured expected running
  version="$(nexa_current_version || true)"
  [ -n "$version" ] || return 0
  recorded="$(nexa_manifest_field "$version" digest 2>/dev/null || true)"
  if [ -z "$recorded" ]; then
    # No manifest for the release this installation says it runs. That is what
    # the pre-manifest updater left behind, and those installations are the ones
    # most likely to be divergent — so silence here would fail open on exactly
    # the population that needs the warning.
    #
    # But it is NOT a divergence, and the difference has to survive to the
    # caller. Return 2, not 1: with a single failure code, `botctl restart`
    # refused to start the stack at all, said the release and deploy.env
    # "disagree" when they may agree perfectly, and offered a repair that then
    # died for want of the same manifest. Unknown is a warning; disagreement is
    # a refusal.
    # Before settling for "unconfirmable", take the evidence that IS available.
    # deploy.env may name a different release whose manifest resolves perfectly
    # — that is row 2 of the ordering table above, an update interrupted between
    # the image pointer and the `current` write, on exactly the pre-manifest
    # population this branch exists for. Reporting that as merely unknown let
    # `botctl restart` go ahead and start the other release.
    configured="$(nexa_env_value "${NEXA_CONFIG_DIR}/deploy.env" NEXA_IMAGE 2>/dev/null || true)"
    running="$(nexa_version_for_image "$configured" 2>/dev/null || true)"
    # No `!= $version` test: we are in this branch only because ${version} has
    # no manifest, and `nexa_version_for_image` resolves through the same field,
    # so it can never answer with ${version}. A condition that cannot be false
    # reads as a guard and is not one.
    if [ -n "$running" ]; then
      nexa_warn "DIVERGENCE: this installation records ${version}, which has no manifest, but deploy.env would start ${running}."
      nexa_warn "A restart or a reboot would start ${running}. 'botctl update ${running}' settles it."
      return 1
    fi
    nexa_warn "no release manifest for ${version}, so what this installation runs cannot be confirmed against source."
    nexa_warn "'botctl update ${version}' records one. Until then 'botctl version' cannot report a commit or a digest."
    return 2
  fi
  configured="$(nexa_env_value "${NEXA_CONFIG_DIR}/deploy.env" NEXA_IMAGE 2>/dev/null || true)"
  [ -n "$configured" ] || return 0

  # The WHOLE reference, not the digest suffix. `*"@${recorded}"` also matched
  # `evil.example/nexa@<the right digest>` — a repository this installation
  # would never pull from, reported as agreement.
  expected="$(nexa_release_image "$version" 2>/dev/null || true)"
  [ -n "$expected" ] || return 0
  [ "$configured" != "$expected" ] || return 0

  # Name the release deploy.env would actually start, by looking its digest up
  # among the manifests. The target of an interrupted update has already had
  # its manifest written, so this almost always resolves — and it has to,
  # because the advice below is otherwise a no-op: `botctl update <current>`
  # short-circuits with "already running".
  running="$(nexa_version_for_image "$configured" || true)"

  nexa_warn "DIVERGENCE: this installation records ${version} (${recorded}) as current, but deploy.env would start ${configured}."
  if [ -n "$running" ]; then
    nexa_warn "A restart or a reboot would start ${running}, not ${version}. This is what an interrupted update or rollback leaves; 'botctl update ${running}' resolves it."
  else
    nexa_warn "A restart or a reboot would start that image, not ${version}, and no release manifest matches it. Decide which of the two is correct and run 'botctl update' for that version."
  fi
  return 1
}

# Which recorded release, if any, is this image reference? The manifests are the
# only place the mapping exists on the host.
nexa_version_for_image() {
  local image="$1" path candidate
  [ -d "$NEXA_RELEASES_DIR" ] || return 1
  for path in "$NEXA_RELEASES_DIR"/*.json; do
    [ -e "$path" ] || continue
    candidate="$(basename "$path" .json)"
    [ "$(nexa_release_image "$candidate" 2>/dev/null || true)" = "$image" ] || continue
    printf '%s' "$candidate"
    return 0
  done
  return 1
}

# --- Release retention -------------------------------------------------------
#
# Bounded, and it can never remove the two releases that matter. An unbounded
# cache is a disk that fills silently; a cache that prunes the rollback target
# is worse than either.
nexa_prune_releases() {
  local current previous keep
  current="$(nexa_current_version || true)"
  previous="$(nexa_previous_version || true)"
  keep="$NEXA_KEEP_RELEASES"
  [ -d "$NEXA_RELEASES_DIR" ] || return 0

  local kept=0 name version
  # Newest first by modification time, so the oldest manifests are the ones
  # that go. Two written in the same second tie-break by whatever order `ls`
  # produces — harmless, because the two that must survive are skipped
  # explicitly below rather than by being recent.
  while IFS= read -r name; do
    version="$(basename "$name" .json)"
    if [ "$version" = "$current" ] || [ "$version" = "$previous" ]; then
      continue
    fi
    # `>`, not `>=`. With `>=` the KEEPth manifest was deleted along with
    # everything older, so a retention of five kept four unpinned manifests and
    # the documentation said five.
    kept=$((kept + 1))
    if [ "$kept" -gt "$keep" ]; then
      rm -f -- "$name"
    fi
  done < <(ls -1t -- "$NEXA_RELEASES_DIR"/*.json 2>/dev/null || true)
}

# --- Host assets ------------------------------------------------------------
#
# The files that live on the host rather than in the image, and therefore have
# to be moved deliberately when a release moves.
#
# One table, used by the installer, by `botctl update`, by `botctl rollback`
# and by the tests. A file that is not here is a file that silently keeps its
# old contents for the life of the installation — which is the whole defect.
#
# `compose.ci.yml` is deliberately absent: it is CI's topology, never a
# production host's.
nexa_asset_table() {
  cat <<TABLE
bin/botctl|${NEXA_BIN_DIR}/botctl|0755
bin/nexa-lib.sh|${NEXA_LIB_DIR}/nexa-lib.sh|0644
compose.yml|${NEXA_DEPLOY_DIR}/compose.yml|0644
nexa.env.template|${NEXA_DEPLOY_DIR}/nexa.env.template|0644
caddy/Caddyfile|${NEXA_DEPLOY_DIR}/caddy/Caddyfile|0644
caddy/routes.caddy|${NEXA_DEPLOY_DIR}/caddy/routes.caddy|0644
TABLE
}

# Staged sets are keyed by DIGEST, never by version.
#
# A version is a tag, and a tag is a pointer somebody can move. Keyed by
# version, a set staged from digest A was silently reused for an update that
# had just resolved the same tag to digest B — the image ran B's code under A's
# compose file and A's botctl, and nothing on the host could tell. The digest
# is the identity everything else in this installation already uses (ADR-0022:
# a release is a digest), so the assets use it too, and a moved tag stages a
# new set rather than finding an old one.
#
# The directory carries a `release` marker naming the version for a human
# reading /var/lib/nexa; nothing reads it back.
nexa_assets_path() {
  local digest="$1"
  nexa_valid_digest "$digest" || return 1
  printf '%s/%s' "$NEXA_ASSETS_DIR" "${digest#sha256:}"
}

nexa_assets_staged() {
  local path
  path="$(nexa_assets_path "${1:-}")" || return 1
  [ -d "$path" ]
}

# The digest whose assets are LIVE on this host right now: the current
# release's, from its manifest — or, on an installation whose current release
# has no manifest, from what deploy.env would actually start. Nothing else is
# evidence of what is installed.
nexa_live_digest() {
  local version="${1:-}" digest image
  if [ -n "$version" ]; then
    digest="$(nexa_manifest_field "$version" digest 2>/dev/null || true)"
    if nexa_valid_digest "$digest"; then
      printf '%s' "$digest"
      return 0
    fi
  fi
  image="$(nexa_env_value "${NEXA_CONFIG_DIR}/deploy.env" NEXA_IMAGE 2>/dev/null || true)"
  digest="${image##*@}"
  nexa_valid_digest "$digest" || return 1
  printf '%s' "$digest"
}

# The target release's own copy of the host assets, taken out of its image.
#
# Out of the IMAGE, not out of a git checkout: the checkout is mutable, may be
# a different commit, and a production host is not required to have git at all.
# The image is addressed by digest, so what lands here is what that release
# shipped and nothing else.
#
# Staged under a `.partial` name and renamed only once every file is present,
# so an interrupted extraction leaves no half-populated directory for a later
# activation to install from.
nexa_stage_release_assets() {
  local digest="$1" image="$2" version="${3:-}"
  # These paths are `rm -rf`ed below. A malformed digest would make that the
  # assets directory itself, so it is refused here rather than guarded at each
  # removal.
  local final
  final="$(nexa_assets_path "$digest")" || nexa_die "internal error: staging host assets needs a digest."
  [ -n "$image" ] || nexa_die "internal error: staging host assets needs an image."
  case "$image" in
    *"@${digest}") : ;;
    *) nexa_die "internal error: refusing to stage host assets for ${digest} out of ${image}." ;;
  esac
  local partial="${final}.partial"

  nexa_assets_staged "$digest" && return 0

  rm -rf "$partial"
  mkdir -p "$partial" || nexa_die "cannot create ${partial}."
  # `tar` out of the image and into the staging directory. One command, no
  # container left behind, and nothing written outside ${partial}.
  if ! docker run --rm --entrypoint tar "$image" -cf - -C /app deploy |
    tar -xf - -C "$partial" --strip-components=1 2>/dev/null; then
    rm -rf "$partial"
    nexa_die "could not read the host assets out of ${image}. A release built before this mechanism existed does not carry them; update to a release that does, or reinstall."
  fi

  local source destination mode
  while IFS='|' read -r source destination mode; do
    [ -n "$source" ] || continue
    [ -s "${partial}/${source}" ] || {
      rm -rf "$partial"
      nexa_die "${image} is missing the host asset ${source}. Refusing to install a partial set."
    }
  done <<EOF
$(nexa_asset_table)
EOF
  printf '%s\n' "${version:-unknown}" >"${partial}/release"

  rm -rf "$final"
  mv -f "$partial" "$final" || nexa_die "cannot stage the host assets for ${digest}."
}

# What is installed RIGHT NOW, kept under the digest that is live so a rollback
# has something to put back.
#
# This is what makes an installation created before this mechanism upgradeable
# without reinstalling: staging.1 through staging.4 never staged anything, so
# the first update captures whatever those installs put on disk as the current
# release's set.
nexa_capture_live_assets() {
  local digest="$1" version="${2:-}"
  local final
  final="$(nexa_assets_path "$digest")" || nexa_die "internal error: capturing host assets needs a digest."
  nexa_assets_staged "$digest" && return 0

  local partial="${final}.partial"
  rm -rf "$partial"
  mkdir -p "$partial/bin" "$partial/caddy" || nexa_die "cannot create ${partial}."

  local source destination mode
  while IFS='|' read -r source destination mode; do
    [ -n "$source" ] || continue
    if [ -r "$destination" ]; then
      cp -p "$destination" "${partial}/${source}" || nexa_die "cannot copy ${destination}."
    else
      # An asset the current installation does not have. Recorded as absent
      # rather than invented, so a rollback does not install a file this
      # release never had.
      rm -rf "$partial"
      nexa_warn "cannot capture ${destination}: it is missing, so the live host assets cannot be recorded."
      return 1
    fi
  done <<EOF
$(nexa_asset_table)
EOF
  printf '%s\n' "${version:-unknown}" >"${partial}/release"

  rm -rf "$final"
  mv -f "$partial" "$final" ||
    nexa_die "cannot record the host assets for ${digest}."
}

# The generation directory an activation works in, and its journal.
#
# Activation replaces six files at six fixed paths, and it can fail after any
# of them. The old shape replaced them one by one and stopped at the first
# failure, which left an installation with three of one release's files and
# three of another's — the state nothing was written for, and the one an
# operator finds when `botctl` calls a library function that does not exist.
#
# So an activation is a JOURNALLED unit. Before the first file moves, the live
# copy of every destination is saved under this directory; as each file is
# replaced, one line is appended to the journal; on any failure the journal is
# replayed backwards and every saved copy goes back; on success the directory
# is removed. A directory found here at the START of an activation is an
# activation that was interrupted — by a power cut, a kill — and is replayed
# first, so the host is whole before it is changed again.
NEXA_ACTIVATING_DIR="${NEXA_STATE_DIR}/assets/.activating"

# Undo a journalled activation: every destination the journal names goes back
# to the copy saved beside it, or is removed if there was none.
nexa_restore_activation() {
  local journal="${NEXA_ACTIVATING_DIR}/journal" line source destination existed saved tmp
  [ -r "$journal" ] || { rm -rf "$NEXA_ACTIVATING_DIR"; return 0; }
  local failed=0
  # Backwards, so the most recent replacement is undone first. `tac` is
  # coreutils and present everywhere this runs.
  while IFS='|' read -r source destination existed; do
    [ -n "$destination" ] || continue
    saved="${NEXA_ACTIVATING_DIR}/saved/${source}"
    if [ "$existed" = "1" ]; then
      # Back into place the same way it was put there: beside, then renamed
      # over, so the restore is as atomic as the replacement was.
      if tmp="$(mktemp "${destination}.XXXXXX" 2>/dev/null)" &&
        cp -p "$saved" "$tmp" && mv -f "$tmp" "$destination"; then
        :
      else
        rm -f "${tmp:-}" 2>/dev/null
        nexa_warn "could not put ${destination} back; its previous copy is at ${saved}."
        failed=1
      fi
    else
      rm -f "$destination" || failed=1
    fi
  done < <(tac "$journal")
  if [ "$failed" -eq 0 ]; then
    rm -rf "$NEXA_ACTIVATING_DIR"
  fi
  return "$failed"
}

# Put a staged release's assets into service, as one unit.
#
# Each file is written beside its destination and RENAMED over it. Two reasons,
# and the second is not theoretical:
#
#   - a rename is atomic, so an interruption leaves either the old file or the
#     new one, never a truncated botctl;
#   - `botctl` is replacing ITSELF while bash is still reading it. A rename
#     swaps the directory entry and leaves the running process's open inode
#     alone; copying over the same inode would rewrite the script under the
#     interpreter mid-execution.
#
# And the whole set is validated before the first rename, the live set is saved
# before it, and every failure after it restores every file already replaced —
# see NEXA_ACTIVATING_DIR above.
nexa_activate_release_assets() {
  local digest="$1" staged
  staged="$(nexa_assets_path "$digest")" || nexa_die "internal error: activating host assets needs a digest."
  [ -d "$staged" ] || nexa_die "no host assets are staged for ${digest}."

  # An activation that never finished. Put the host back first; changing it
  # again on top of a half-applied set would lose the copies that make the
  # restore possible.
  if [ -d "$NEXA_ACTIVATING_DIR" ]; then
    nexa_warn "a previous host-asset activation was interrupted; restoring the set it replaced first."
    nexa_restore_activation ||
      nexa_die "could not restore the interrupted activation under ${NEXA_ACTIVATING_DIR}. Inspect it before retrying; nothing has been changed."
  fi

  # 1. VALIDATE everything before touching anything.
  local source destination mode
  while IFS='|' read -r source destination mode; do
    [ -n "$source" ] || continue
    [ -s "${staged}/${source}" ] || nexa_die "${digest}'s staged ${source} is missing or empty."
  done <<EOF
$(nexa_asset_table)
EOF

  # 2. SAVE the live set, and open the journal.
  mkdir -p "${NEXA_ACTIVATING_DIR}/saved/bin" "${NEXA_ACTIVATING_DIR}/saved/caddy" ||
    nexa_die "cannot create ${NEXA_ACTIVATING_DIR}."
  local journal="${NEXA_ACTIVATING_DIR}/journal"
  : >"$journal"
  while IFS='|' read -r source destination mode; do
    [ -n "$source" ] || continue
    if [ -e "$destination" ]; then
      cp -p "$destination" "${NEXA_ACTIVATING_DIR}/saved/${source}" || {
        rm -rf "$NEXA_ACTIVATING_DIR"
        nexa_die "cannot save ${destination} before replacing it; nothing has been changed."
      }
    fi
  done <<EOF
$(nexa_asset_table)
EOF

  # 3. REPLACE, journalling each file, and undo everything on the first failure.
  local tmp existed
  activation_failed() {
    nexa_warn "$1"
    if nexa_restore_activation; then
      nexa_die "the host assets were NOT changed: every file already replaced has been put back."
    fi
    nexa_die "the host assets are in a MIXED state and could not all be put back. The journal and the saved copies are under ${NEXA_ACTIVATING_DIR}; the next activation will retry the restore."
  }
  while IFS='|' read -r source destination mode; do
    [ -n "$source" ] || continue
    mkdir -p "$(dirname "$destination")" || activation_failed "cannot create $(dirname "$destination")."
    tmp="$(mktemp "${destination}.XXXXXX")" || activation_failed "cannot write beside ${destination}."
    if ! cp "${staged}/${source}" "$tmp"; then
      rm -f "$tmp"
      activation_failed "cannot stage ${destination}."
    fi
    if ! chmod "$mode" "$tmp"; then
      rm -f "$tmp"
      activation_failed "cannot set the mode on ${destination}."
    fi
    # Ownership follows the caller, which is root for every path that reaches
    # here; stated rather than assumed, so a non-root caller fails loudly.
    if [ "$(id -u)" -eq 0 ]; then
      if ! chown 0:0 "$tmp"; then
        rm -f "$tmp"
        activation_failed "cannot set the owner on ${destination}."
      fi
    fi
    sync "$tmp" 2>/dev/null || true
    existed=0
    [ ! -e "$destination" ] || existed=1
    # The journal line goes in BEFORE the rename. Written after, a crash
    # between the two would leave a replaced file the restore knows nothing
    # about; written before, the worst case is a restore that puts back a file
    # which was never replaced — which is a copy of itself.
    printf '%s|%s|%s\n' "$source" "$destination" "$existed" >>"$journal"
    if ! mv -f "$tmp" "$destination"; then
      rm -f "$tmp"
      activation_failed "cannot install ${destination}."
    fi
  done <<EOF
$(nexa_asset_table)
EOF

  # 4. DONE. The saved generation is no longer needed; the staged directory
  # under the digest is what a rollback uses.
  rm -rf "$NEXA_ACTIVATING_DIR"
}
