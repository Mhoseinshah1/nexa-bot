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
NEXA_LOCK_FILE="${NEXA_LOCK_FILE:-${NEXA_ROOT}/var/lock/nexa.lock}"

NEXA_RELEASES_DIR="${NEXA_STATE_DIR}/releases"
NEXA_CURRENT_FILE="${NEXA_STATE_DIR}/current"
NEXA_PREVIOUS_FILE="${NEXA_STATE_DIR}/previous"

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
  python3 -c '
import json, sys
manifest = {
    "version": sys.argv[2],
    "commit": sys.argv[3],
    "digest": sys.argv[4],
    "image": sys.argv[5] + "@" + sys.argv[4],
    "recordedAt": sys.argv[6],
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2, sort_keys=True)
    handle.write("\n")
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
    digest="$(docker manifest inspect -v "$reference" 2>/dev/null |
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
nexa_wait_ready() {
  # The caller names a timeout; NEXA_READY_TIMEOUT overrides it. An operator on
  # a slow host can raise it without editing a script, and the test harness
  # lowers it so a failure case does not take three minutes to prove.
  local timeout="${NEXA_READY_TIMEOUT:-${1:-180}}" waited=0 state
  while [ "$waited" -lt "$timeout" ]; do
    # SC2016: the single quotes are the point. This is Python source, and the
    # shell must not expand anything inside it — an interpolated value here
    # would be code, not data.
    # shellcheck disable=SC2016
    state="$(nexa_compose ps --format json api 2>/dev/null |
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
for entry in entries:
    if entry.get("Service") == "api":
        print(entry.get("Health") or entry.get("State") or "")
        break
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
  mkdir -p "$(dirname "$NEXA_LOCK_FILE")"
  exec {NEXA_LOCK_FD}>>"$NEXA_LOCK_FILE" ||
    nexa_die "cannot open the lock file at ${NEXA_LOCK_FILE}."
  if ! flock -w "$timeout" -x "$NEXA_LOCK_FD"; then
    nexa_die "another install, update or rollback is already running (lock: ${NEXA_LOCK_FILE})."
  fi
}

# --- The current-image pointer -----------------------------------------------
#
# `deploy.env` names the image compose runs when nobody overrides it, so this
# is what makes a release survive a reboot: Docker restarts the containers, and
# any later `docker compose up` without an override starts the same digest.
#
# Written atomically. A partially-rewritten deploy.env is an installation that
# cannot start at all, and this runs immediately after an update has been
# proven healthy — the worst possible moment to leave a truncated file.
nexa_set_deploy_image() {
  local image="$1" file="${NEXA_CONFIG_DIR}/deploy.env" tmp
  [ -n "$image" ] || nexa_die "refusing to record an empty image reference."
  case "$image" in
    *@sha256:*) : ;;
    *) nexa_die "refusing to record an image reference that is not a digest: ${image}" ;;
  esac
  tmp="$(mktemp "${file}.XXXXXX")"
  # Same ownership and mode as the file being replaced, set BEFORE any content
  # is written into place.
  chmod 0600 "$tmp"
  { grep -v '^NEXA_IMAGE=' -- "$file" || true; } >"$tmp"
  printf 'NEXA_IMAGE=%s\n' "$image" >>"$tmp"
  mv -f "$tmp" "$file"
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
  # that go.
  while IFS= read -r name; do
    version="$(basename "$name" .json)"
    if [ "$version" = "$current" ] || [ "$version" = "$previous" ]; then
      continue
    fi
    kept=$((kept + 1))
    if [ "$kept" -ge "$keep" ]; then
      rm -f -- "$name"
    fi
  done < <(ls -1t -- "$NEXA_RELEASES_DIR"/*.json 2>/dev/null || true)
}
