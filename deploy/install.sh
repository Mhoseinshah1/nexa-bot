#!/usr/bin/env bash
# Install Nexa on a fresh Ubuntu server.
#
# Idempotent and resumable: every step checks whether it has already been done,
# and a run that fails half-way can be repeated without undoing what worked.
# Secrets in particular are generated ONCE — a rerun that minted a new database
# password would lock the installation out of its own data.
#
# One state is refused rather than resumed: a secrets directory that is PARTLY
# written, which only a kill between two of the three files can produce. See
# `generate_secrets`. Nothing has started when that happens, so the remedy is to
# move the directory aside and rerun.
#
# It needs root, because it installs packages, writes under /etc and /opt, and
# manages Docker. What it will NOT do:
#
#   - touch the host firewall. If 80 and 443 are blocked, it says so and stops;
#     opening ports on somebody's server without asking is not an installer's
#     decision to make.
#   - replace an existing incompatible Docker installation.
#   - pipe a remote script into a shell, or source anything it downloaded.
#   - print, log or store the first owner's password.
#
# Usage:
#   sudo ./install.sh --domain admin.example.com --acme-email ops@example.com \
#                     --version v1.0.0 [--owner-username owner] \
#                     [--owner-password-file /path/to/file]

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/nexa-lib.sh
. "${SCRIPT_DIR}/bin/nexa-lib.sh"

# --- Supported platforms ------------------------------------------------------
#
# Named explicitly rather than "any recent Ubuntu". Both are LTS releases with
# a Docker apt repository; this is what the CI smoke test runs and what the
# acceptance checklist is written against.
SUPPORTED_UBUNTU=("22.04" "24.04")
SUPPORTED_ARCH=("x86_64" "aarch64")

# --- Arguments ----------------------------------------------------------------
DOMAIN=""
ACME_EMAIL=""
VERSION=""
TENANT_SLUG="nexa"
TENANT_NAME="Nexa"
TENANT_TIMEZONE="Asia/Tehran"
TENANT_CURRENCY="IRT"
OWNER_USERNAME=""
OWNER_DISPLAY_NAME=""
OWNER_PASSWORD_FILE=""
# Set by `require_owner_state`: "none" or "bootstrapped". Anything else dies.
OWNER_STATE=""
SKIP_OWNER="no"
BOT_TOKEN_FILE=""
SKIP_TELEGRAM="no"
# Set by `configure_telegram_bot` when it could not finish. The install then
# reports INCOMPLETE and exits non-zero — ADR-0029 decision 4: a
# Telegram-enabled installation whose bot cannot receive updates is not a
# completed installation, whatever else went right.
TELEGRAM_INCOMPLETE=""
# The state AFTER a failed Telegram step, which decides what the summary tells
# the operator to run. `none` means nothing was written and the retry needs a
# token source; anything else means the credential is stored and the retry does
# not.
TELEGRAM_RETRY=""

usage() {
  cat <<'USAGE'
Install Nexa.

Required:
  --domain DOMAIN              the admin panel's hostname, already pointing here
  --acme-email EMAIL           for Let's Encrypt expiry notices
  --version VERSION            the release to install, e.g. v1.0.0

Optional:
  --slug SLUG                  installation slug        (default: nexa)
  --display-name NAME          installation name        (default: Nexa)
  --timezone TZ                IANA time zone           (default: Asia/Tehran)
  --currency CODE              IRT, IRR, USD, EUR, USDT (default: IRT)
  --owner-username NAME        first owner's username
  --owner-display-name NAME    first owner's display name
  --owner-password-file PATH   read the first owner's password from PATH
                               (the file is never copied and never logged)
  --skip-owner                 do not create the first owner in this run
  --bot-token-file PATH        read the Telegram bot token from PATH, for an
                               unattended install (the file is never copied and
                               never logged). Without it the installer ASKS,
                               hiding what you type.
  --skip-telegram              do not configure the Telegram bot in this run
  -h, --help                   this text

Neither the owner's password nor the bot token is ever accepted as a
command-line argument: argv is readable by every user on the machine and lands
in shell history.

A rerun of this installer does not ask for the bot token again and never
replaces a stored one. Changing the token is a separate, deliberate act.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)
      DOMAIN="${2:-}"
      shift 2
      ;;
    --acme-email)
      ACME_EMAIL="${2:-}"
      shift 2
      ;;
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --slug)
      TENANT_SLUG="${2:-}"
      shift 2
      ;;
    --display-name)
      TENANT_NAME="${2:-}"
      shift 2
      ;;
    --timezone)
      TENANT_TIMEZONE="${2:-}"
      shift 2
      ;;
    --currency)
      TENANT_CURRENCY="${2:-}"
      shift 2
      ;;
    --owner-username)
      OWNER_USERNAME="${2:-}"
      shift 2
      ;;
    --owner-display-name)
      OWNER_DISPLAY_NAME="${2:-}"
      shift 2
      ;;
    --owner-password-file)
      OWNER_PASSWORD_FILE="${2:-}"
      shift 2
      ;;
    --skip-owner)
      SKIP_OWNER="yes"
      shift
      ;;
    --bot-token-file)
      BOT_TOKEN_FILE="${2:-}"
      shift 2
      ;;
    --skip-telegram)
      SKIP_TELEGRAM="yes"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) nexa_die "unknown argument \"$1\". Run with --help." ;;
  esac
done

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
#
# Everything that can be known before anything is changed is checked before
# anything is changed. An installer that fails on step nine having already
# written six files is an installer people are afraid to run.
# A rerun of the installer is supported and documented; a rerun with a DIFFERENT
# --version is not, and it used to be accepted. The installer takes no backup,
# never writes `previous`, and repoints deploy.env at the new image BEFORE
# anything is pulled, migrated or started. So a failed migration left the
# installation still running and still reporting the old release, with
# deploy.env naming the new one — and the next restart or reboot started an
# un-migrated image. It also silently destroyed the rollback relationship
# `botctl rollback` depends on.
#
# Its own function, and not because preflight is long: this is the one refusal
# the suite must be able to drive without being root, and preflight's first
# check is that the caller IS root.
refuse_version_change() {
  local installed
  installed="$(nexa_current_version || true)"
  [ -n "$installed" ] || return 0
  [ "$installed" != "$VERSION" ] || return 0
  nexa_die "this host already runs ${installed}, and the installer is not an updater: it takes no backup, records no rollback target, and would repoint the deployment at ${VERSION} before anything had been migrated or started. Run instead: botctl update ${VERSION}"
}

# The same refusal, for the case the version string cannot see.
#
# A rerun with the SAME --version is supported, and it was accepted on the
# strength of the version STRING alone. But a version is a tag, and a tag can be
# moved: if `v1.2.0` has been repointed at different bytes, a rerun resolves the
# new digest, rewrites deploy.env to it, and migrates and starts it — the exact
# unannounced update `refuse_version_change` exists to prevent, wearing a name
# that made it look like a no-op.
#
# The release workflow makes this impossible for images it publishes; a private
# registry, a mirror, or a compromised one is where it happens. The digest is
# the identity everywhere else in this deployment, so it is the identity here.
#
# Runs after the digest is resolved, because there is nothing to compare before
# then. If no manifest was recorded for the installed version the check cannot
# decide and does not pretend to — `nexa_check_divergence` reports that state
# separately.
refuse_digest_change() {
  local resolved="$1" installed recorded
  installed="$(nexa_current_version || true)"
  [ -n "$installed" ] || return 0
  # A DIFFERENT installed version already died in preflight; reaching here with
  # one would mean this ran in the wrong order.
  [ "$installed" = "$VERSION" ] || return 0
  recorded="$(nexa_manifest_field "$VERSION" digest 2>/dev/null || true)"
  [ -n "$recorded" ] || return 0
  [ "$recorded" != "$resolved" ] || return 0
  nexa_die "this host already runs ${VERSION}, but ${NEXA_IMAGE_REPO}:${VERSION} now resolves to ${resolved} while the installed release records ${recorded}. A published version is immutable, so that tag has been moved. The installer would migrate and start the new bytes with no backup and no rollback target. Find out why the tag moved; if the new image is the one you want, publish it as a NEW version and run: botctl update <that version>"
}

preflight() {
  nexa_step "preflight"

  [ "$(id -u)" -eq 0 ] || nexa_die "this installer must run as root (try: sudo $0 ...)."

  # --- The operator's answers ---
  [ -n "$DOMAIN" ] || nexa_die "--domain is required."
  nexa_valid_domain "$DOMAIN" ||
    nexa_die "\"$DOMAIN\" is not a valid hostname. Give a bare name such as admin.example.com — no scheme, no port, no path."
  [ -n "$ACME_EMAIL" ] || nexa_die "--acme-email is required; Let's Encrypt sends expiry warnings to it."
  [[ $ACME_EMAIL =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] ||
    nexa_die "\"$ACME_EMAIL\" does not look like an e-mail address."
  [ -n "$VERSION" ] || nexa_die "--version is required. A deployment without a version is a deployment nobody can support."
  nexa_require_version "$VERSION"

  refuse_version_change

  # --- The platform ---
  local id="" release="" arch
  if [ -r /etc/os-release ]; then
    id="$(nexa_env_value /etc/os-release ID || true)"
    release="$(nexa_env_value /etc/os-release VERSION_ID || true)"
  fi
  [ "$id" = "ubuntu" ] ||
    nexa_die "this installer supports Ubuntu ${SUPPORTED_UBUNTU[*]} and found \"${id:-unknown}\"."
  local supported="no" candidate
  for candidate in "${SUPPORTED_UBUNTU[@]}"; do
    [ "$release" = "$candidate" ] && supported="yes"
  done
  [ "$supported" = "yes" ] ||
    nexa_die "Ubuntu ${release:-unknown} is not supported. Supported: ${SUPPORTED_UBUNTU[*]}."

  arch="$(uname -m)"
  supported="no"
  for candidate in "${SUPPORTED_ARCH[@]}"; do
    [ "$arch" = "$candidate" ] && supported="yes"
  done
  [ "$supported" = "yes" ] ||
    nexa_die "architecture ${arch} is not supported. Supported: ${SUPPORTED_ARCH[*]}."
  nexa_ok "Ubuntu ${release} on ${arch}"

  # --- Disk ---
  #
  # Postgres, four images, backups and room to take one more before an update.
  local free_mb
  free_mb="$(df -Pm /var | awk 'NR==2 {print $4}')"
  [ "${free_mb:-0}" -ge 8192 ] ||
    nexa_die "only ${free_mb:-0} MB free on /var; Nexa needs at least 8192 MB for images, the database and one backup."
  nexa_ok "${free_mb} MB free on /var"

  # --- Ports ---
  #
  # Checked, never opened. A blocked port is reported with what to do about it.
  #
  # Both checks read their command's output into a variable rather than piping
  # into `grep -q`. Under `pipefail` a `grep -q` that MATCHES exits at once,
  # the writer ahead of it can die of SIGPIPE, and the pipeline returns 141 —
  # so the test reports "nothing listening" precisely when something is. On a
  # port preflight that is the wrong answer in the dangerous direction.
  # UDP is checked as well as TCP, and only on 443: `compose.yml` publishes
  # `443:443/udp` for HTTP/3, so a service holding 443/udp is a real conflict
  # that Caddy would fail to bind — and `ss -Hltn` is TCP-listen only, so it
  # saw none of them. Port 80 is TCP alone; nothing here binds 80/udp.
  local port listeners proto flags
  for port in 80 443; do
    for proto in tcp udp; do
      [ "$proto" = tcp ] || [ "$port" = 443 ] || continue
      # `-l` is a TCP-listen filter and means nothing for UDP; a bound UDP
      # socket is simply present, so the sockets are enumerated without it.
      [ "$proto" = tcp ] && flags='-Hltn' || flags='-Huan'
      listeners="$(ss "$flags" "sport = :${port}" 2>/dev/null || true)"
      [ -n "$listeners" ] || continue

      # Our own Caddy holding the port on a rerun is expected, not a conflict.
      #
      # Established by asking Docker which containers PUBLISH this port and
      # whether every one of them carries this installation's own Compose
      # project and service labels — not by a container's name. The first
      # version of this check counted `nexa-caddy*` in `docker ps` and waived
      # the conflict on any match, so a nexa-caddy that was up but bound to
      # nothing waved through an unrelated nginx on the same port; the second
      # matched the same prefix against the publishers, which a container
      # called `nexa-caddy-foreign` satisfies just as well. A name is the
      # operator's; the labels are Compose's.
      if ! nexa_port_is_ours "$port" "$proto"; then
        nexa_die "something is already listening on ${port}/${proto}, and it is not Nexa's edge. Nexa needs 80 (ACME and the redirect) and 443 on both TCP and UDP (HTTP/3). Stop the other service, or install Nexa on a host that is not already serving HTTP."
      fi
    done
  done
  nexa_ok "ports 80 and 443 are free, on TCP and on UDP"

  # --- The owner's password source ---
  if [ "$SKIP_OWNER" = "no" ] && [ -n "$OWNER_PASSWORD_FILE" ]; then
    [ -r "$OWNER_PASSWORD_FILE" ] ||
      nexa_die "cannot read the owner password file at ${OWNER_PASSWORD_FILE}."
    [ -s "$OWNER_PASSWORD_FILE" ] ||
      nexa_die "the owner password file at ${OWNER_PASSWORD_FILE} is empty."
  fi
  if [ "$SKIP_OWNER" = "no" ] && [ -z "$OWNER_PASSWORD_FILE" ] && [ ! -t 0 ]; then
    nexa_die "no terminal and no --owner-password-file: there is no safe way to read the first owner's password. Pass --owner-password-file, or --skip-owner and run the bootstrap later."
  fi

  # --- The bot token's source ---
  #
  # Checked HERE, before anything is created, and not when the step is reached.
  # The Telegram step is the LAST one: discovering there is no way to read a
  # token at that point means a fully installed system that fails on its final
  # command, and the operator reruns the whole thing. The owner password's own
  # check is two lines up for the same reason.
  #
  # A file only has to be readable and non-empty here. Whether it holds a
  # WORKING token is Telegram's to say, and `getMe` asks.
  if [ "$SKIP_TELEGRAM" = "no" ] && [ -n "$BOT_TOKEN_FILE" ]; then
    # ABSOLUTE, and this is not pedantry. The same string is handed to
    # `docker run -v`, where a bare name is a NAMED VOLUME rather than a path:
    # the container would receive an empty directory, the CLI would fail
    # reading a directory as a file, and the operator would see a stack trace
    # about a file they can see on their own disk.
    case "$BOT_TOKEN_FILE" in
      /*) ;;
      *) nexa_die "--bot-token-file must be an absolute path; \"${BOT_TOKEN_FILE}\" is not. Docker reads it as a named volume otherwise, and the container gets an empty directory." ;;
    esac
    # A REGULAR file, and `-r`/`-s` do not say that. A directory such as `/tmp`
    # satisfies both — it is readable and its size is non-zero — so it passed
    # preflight, the whole deployment ran, and the redirection that finally
    # reads it failed at the very end. The installer then recorded an incomplete
    # release and reported that Telegram had rejected or could not be reached
    # for a token it had never managed to read.
    [ -f "$BOT_TOKEN_FILE" ] ||
      nexa_die "--bot-token-file must be a regular file; \"${BOT_TOKEN_FILE}\" is not."
    [ -r "$BOT_TOKEN_FILE" ] ||
      nexa_die "cannot read the bot token file at ${BOT_TOKEN_FILE}."
    [ -s "$BOT_TOKEN_FILE" ] ||
      nexa_die "the bot token file at ${BOT_TOKEN_FILE} is empty."
  fi
  # The "no terminal and no token source" refusal is NOT here, unlike the owner
  # password's. Preflight runs before the stack is up, so it cannot ask whether a
  # token is actually needed — and on a reconcile it is not: the row already
  # carries the encrypted credential. Refusing here broke unattended recovery
  # after a webhook failure whenever the original token file had been removed,
  # which is the case the resume path exists for. It moved to
  # `configure_telegram_bot`, where the state is known.
}

# ---------------------------------------------------------------------------
# Docker
# ---------------------------------------------------------------------------
ensure_docker() {
  nexa_step "docker"

  if docker compose version >/dev/null 2>&1; then
    nexa_ok "Docker Engine and the Compose plugin are present"
    return 0
  fi

  if command -v docker >/dev/null 2>&1; then
    # An existing Docker without the Compose v2 plugin. Adding the plugin is
    # safe; replacing somebody's Docker installation is not, so this stops.
    nexa_die "Docker is installed but 'docker compose' is not available. Install the Compose v2 plugin (apt-get install docker-compose-plugin) and rerun. This installer will not replace an existing Docker installation."
  fi

  nexa_step "installing Docker Engine from Docker's own apt repository"
  # Verified by signature, not by trusting a redirect. Nothing is piped into a
  # shell and nothing is downloaded into a directory on PATH.
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null

  install -m 0755 -d /etc/apt/keyrings
  local keyring=/etc/apt/keyrings/docker.asc
  if [ ! -s "$keyring" ]; then
    curl -fsSL --proto '=https' --tlsv1.2 https://download.docker.com/linux/ubuntu/gpg -o "$keyring" ||
      nexa_die "could not download Docker's signing key. Check outbound HTTPS to download.docker.com."
    chmod a+r "$keyring"
  fi

  local codename dpkg_arch
  codename="$(nexa_env_value /etc/os-release VERSION_CODENAME)" ||
    nexa_die "cannot determine the Ubuntu codename."
  dpkg_arch="$(dpkg --print-architecture)"
  printf 'deb [arch=%s signed-by=%s] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$dpkg_arch" "$keyring" "$codename" >/etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null ||
    nexa_die "installing Docker failed. Nothing else has been changed."

  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 ||
    nexa_die "Docker installed but 'docker compose' still does not work."
  nexa_ok "Docker Engine and the Compose plugin installed"
}

check_registry() {
  nexa_step "checking the release registry"
  # A reachability check before anything is written. A private package with no
  # credentials configured fails HERE rather than after the database exists.
  if ! nexa_resolve_digest "$VERSION" >/dev/null 2>&1; then
    nexa_die "cannot resolve ${NEXA_IMAGE_REPO}:${VERSION}.

Either the version does not exist, or the package is private and this host has
no credentials for it. For a private package, log in first with a token that
has read:packages and nothing else:

  echo \"\$GHCR_TOKEN\" | docker login ghcr.io -u <github-username> --password-stdin

The installer deliberately does not embed a token of its own."
  fi
  nexa_ok "${NEXA_IMAGE_REPO}:${VERSION} is reachable"
}

# ---------------------------------------------------------------------------
# Layout and configuration
# ---------------------------------------------------------------------------
create_layout() {
  nexa_step "creating the filesystem layout"
  # 0700 on the configuration directory: every secret below is 0600, and the
  # directory mode means a non-root user cannot even traverse to them.
  install -d -m 0700 "$NEXA_CONFIG_DIR"
  install -d -m 0755 "$NEXA_DEPLOY_DIR" "$NEXA_LIB_DIR" "$NEXA_BIN_DIR"
  install -d -m 0750 "$NEXA_STATE_DIR" "$NEXA_RELEASES_DIR" "$NEXA_ASSETS_DIR"
  install -d -m 0700 "$NEXA_BACKUP_DIR"
  # No directory is created for the lock: it lives in the state directory
  # above. An earlier version created one under /var/lock, which on Ubuntu is
  # /run/lock — chmodding a shared host directory to 0755 and dropping its
  # sticky bit. See the note on NEXA_LOCK_FILE in nexa-lib.sh.
  nexa_ok "layout created"
}

# 32 bytes of kernel randomness, base64. Used for the KEK, and in a
# URL/shell-safe alphabet for the two database passwords.
random_base64() { head -c 32 /dev/urandom | base64 -w0; }
random_password() { head -c 24 /dev/urandom | base64 -w0 | tr -d '=+/' | cut -c1-32; }

# Telegram's `secret_token` alphabet: `A-Za-z0-9_-` and nothing else.
#
# Base64url with the padding stripped — 32 random bytes become 43 characters,
# comfortably over the 16 the application's schema requires, with no `+`, `/` or
# `=` left in them.
#
# `random_base64` is NOT usable here, and the mistake it caused is worth naming:
# it produces standard base64, so every minted secret contained `+` or `/` and
# always ended in `=`. Telegram answers `setWebhook` with a 400 for any of them,
# which means every fresh installation would have finished with a bot that could
# not receive a message — and the installer's own INCOMPLETE summary would have
# sent the operator to debug DNS. The application's config schema now refuses
# such a value at boot as well, so the two halves cannot drift apart again.
random_webhook_secret() { head -c 32 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '='; }

# Does this file exist AND carry every key it is supposed to carry, each with a
# value? A file that exists is not a file that is finished.
secrets_complete() {
  local file="$1" key
  shift
  [ -s "$file" ] || return 1
  local value
  for key in "$@"; do
    value="$(nexa_env_value "$file" "$key" 2>/dev/null || true)"
    # Trimmed: a key whose value is spaces is not a key with a value, and
    # `POSTGRES_PASSWORD="  "` is a thing a partial write can leave.
    [ -n "${value//[[:space:]]/}" ] || return 1
  done
  return 0
}

# Write, then name. A secret file must never be reachable under its final name
# until it is complete, because the next run decides what to do by looking at
# it — and a rerun that blesses a truncated file is worse than one that
# regenerates.
write_secret_file() {
  local target="$1" tmp
  tmp="$(mktemp "${target}.XXXXXX")" || nexa_die "cannot write ${target}."
  chmod 0600 "$tmp"
  cat >"$tmp" || { rm -f "$tmp"; nexa_die "cannot write ${target} (is /var full?)."; }
  sync "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$target" || {
    rm -f "$tmp"
    nexa_die "cannot install ${target}."
  }
}

generate_secrets() {
  nexa_step "generating secrets"

  local pg_env="${NEXA_CONFIG_DIR}/postgres.env"
  local redis_env="${NEXA_CONFIG_DIR}/redis.env"
  local app_env="${NEXA_CONFIG_DIR}/nexa.env"

  # ONCE. A rerun that regenerated the database password would lock the
  # installation out of its own data, and a rerun that regenerated the KEK
  # would make every stored secret undecryptable. This is the single most
  # important idempotency rule in the file.
  #
  # "Already generated" is decided by the KEYS the files must contain, not by
  # their being non-empty. A non-emptiness test blessed a postgres.env holding
  # a user and a database but no password, and a nexa.env truncated part-way
  # through — both of which are what ENOSPC or EIO during the write leaves
  # behind, because `set -e` aborts with the partial file already named. The
  # install then proceeded: Postgres cannot initialise without a password and
  # sat out the whole health timeout, and a nexa.env without SECRETS_KEK failed
  # the application's config schema at first boot. Both a long way from the
  # cause.
  local have=0 missing=0
  if secrets_complete "$pg_env" POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD; then have=$((have + 1)); else missing=$((missing + 1)); fi
  if secrets_complete "$redis_env" REDIS_PASSWORD; then have=$((have + 1)); else missing=$((missing + 1)); fi
  # NOTIFICATION_TRANSPORT is the last key in the template, and that is why it
  # is in this list. The keys before it sit in the first half of the file, so a
  # write that died two thirds of the way through satisfied all of them — and a
  # nexa.env missing DEPLOYMENT_TOPOLOGY is worse than one missing SECRETS_KEK,
  # because that key HAS a schema default: losing it silently stops
  # TRUSTED_PROXY_IPS being required, and the API boots ignoring
  # X-Forwarded-For. A key from the end is the cheapest true test that the
  # write reached it.
  #
  # It was BUILD_TIME until the build-identity block was removed from the
  # template; if a key is ever appended after this one, this list moves with it,
  # and `deployment-config.test.ts` fails the build if it does not. The Telegram
  # block was deliberately placed ABOVE this key rather than after it, so this
  # stays an end-of-file test — and the newer keys are NOT named here, because
  # requiring them would make a rerun on a host installed before they existed
  # decide its own configuration was half-written and refuse to continue. That
  # is the same installer-breaks-its-own-installations failure the SECRETS_KEK
  # note below describes; `ensure_telegram_config` adds them instead.
  # EITHER spelling of the key configuration counts as complete.
  #
  # A host installed before the keyring release has SECRETS_KEK and
  # SECRETS_KEK_ID in its nexa.env and no SECRETS_KEYS, and the application
  # still accepts that. Requiring the new names here would make a rerun on such
  # a host decide its own configuration was half-written and refuse to
  # continue — an installer that breaks the installations it already made.
  if secrets_complete "$app_env" SECRETS_KEYS SECRETS_ACTIVE_KEY_ID DATABASE_URL REDIS_URL \
    WEB_ADMIN_ORIGINS DEPLOYMENT_TOPOLOGY NOTIFICATION_TRANSPORT ||
    secrets_complete "$app_env" SECRETS_KEK SECRETS_KEK_ID DATABASE_URL REDIS_URL \
      WEB_ADMIN_ORIGINS DEPLOYMENT_TOPOLOGY NOTIFICATION_TRANSPORT; then
    have=$((have + 1))
  else
    missing=$((missing + 1))
  fi

  if [ "$missing" -eq 0 ]; then
    nexa_ok "secrets already exist; leaving them alone"
    return 0
  fi
  if [ "$have" -gt 0 ]; then
    nexa_die "the configuration in ${NEXA_CONFIG_DIR} is incomplete: some files are complete and some are missing or truncated. Refusing to half-generate secrets over it. Inspect the directory and either complete it or move it aside."
  fi

  umask 077

  local pg_password redis_password kek kek_id webhook_secret
  pg_password="$(random_password)"
  redis_password="$(random_password)"
  # Telegram's alphabet, not ours — see `random_webhook_secret`.
  webhook_secret="$(random_webhook_secret)"
  kek="$(random_base64)"
  kek_id="install-$(date -u +%Y%m%d)"

  # Written by redirection, never echoed. Nothing below prints a value. Each
  # file lands complete or not at all — no half-written secret is ever readable.
  #
  # What that does NOT buy is resumption. A kill BETWEEN two of these writes
  # leaves some files complete and some absent, and the check above then dies
  # rather than filling in the rest: the passwords in the finished files are
  # already baked into `nexa.env`'s DATABASE_URL and REDIS_URL, and generating
  # the missing half means reading the existing secrets back and threading them
  # through — more code handling secrets, to rescue a state whose safe remedy
  # is one command. Nothing has started at this point, so moving the directory
  # aside and rerunning loses nothing. The refusal says so.
  write_secret_file "$pg_env" <<EOF
POSTGRES_USER=nexa
POSTGRES_DB=nexa
POSTGRES_PASSWORD=${pg_password}
EOF

  write_secret_file "$redis_env" <<EOF
REDIS_PASSWORD=${redis_password}
EOF

  # The application configuration comes from the template, which the unit tests
  # parse through the application's own schema. Substituted with a Python
  # replace rather than `sed`, so a generated value containing a slash or an
  # ampersand cannot corrupt the output or inject a second assignment.
  #
  # The substitutions arrive on STDIN, and that is the security property, not a
  # style choice. They used to be positional arguments — which put the KEK and
  # both database passwords into a process's argv, where `ps` shows them to
  # every user on the machine for as long as the interpreter runs. This file
  # already says so, forty lines further down, about the owner password: "argv
  # is readable by every user on the machine via `ps`, and an environment
  # variable would be readable through `docker inspect`". The rule was written
  # and then broken three lines from where it was written.
  #
  # `printf` is a shell BUILTIN, so the values never become a process's
  # arguments on this side either — there is no `/usr/bin/printf` to inspect.
  # NUL-separated because a token or a value containing a newline would
  # otherwise re-frame the list; nothing generated here contains one, and a
  # framing that depends on that staying true is a framing that will eventually
  # be wrong.
  printf '%s\0' \
    "__POSTGRES_PASSWORD__=${pg_password}" \
    "__REDIS_PASSWORD__=${redis_password}" \
    "__SECRETS_KEK__=${kek}" \
    "__SECRETS_ACTIVE_KEY_ID__=${kek_id}" \
    "__DOMAIN__=${DOMAIN}" \
    "__EDGE_SUBNET__=${NEXA_EDGE_SUBNET:-172.29.0.0/24}" \
    "__TELEGRAM_WEBHOOK_SECRET__=${webhook_secret}" |
    python3 -c '
import sys
source, target = sys.argv[1], sys.argv[2]
replacements = {}
for pair in sys.stdin.buffer.read().decode("utf-8").split("\0"):
    if pair == "":
        continue
    token, value = pair.split("=", 1)
    replacements[token] = value
with open(source, "r", encoding="utf-8") as handle:
    text = handle.read()
for token, value in replacements.items():
    text = text.replace(token, value)
with open(target, "w", encoding="utf-8") as handle:
    handle.write(text)
' "${NEXA_DEPLOY_DIR}/nexa.env.template" "${app_env}.partial"

  # Same rule for the substituted template: it is complete before it is named.
  chmod 0600 "${app_env}.partial"
  sync "${app_env}.partial" 2>/dev/null || true
  mv -f "${app_env}.partial" "$app_env"

  chmod 0600 "$pg_env" "$redis_env" "$app_env"
  nexa_ok "secrets generated (0600, root-owned, never printed)"
}

# The Telegram webhook configuration, for a file that predates it.
#
# `generate_secrets` runs ONCE and is skipped wholesale on a rerun, which is the
# single most important idempotency rule in this file — so a key introduced
# after an installation was created would never reach it. This is the additive
# half: it adds what is missing and never touches what is there.
#
# NEVER regenerates the secret. Telegram holds the value it was given at
# registration and signs every update with it; minting a new one here would make
# the API reject every update from a bot that is working, silently, until
# somebody re-registered the webhook. An existing value is left exactly alone.
#
# It is NOT the torn-write check: `secrets_complete` above still names the last
# key in the template, and the Telegram block sits above that key precisely so
# that stays true. This handles the other case — a file that is complete for the
# release that wrote it and older than these keys.
ensure_telegram_config() {
  local app_env="${NEXA_CONFIG_DIR}/nexa.env"
  [ -s "$app_env" ] || return 0

  local have_secret have_enabled
  have_secret="$(nexa_env_value "$app_env" TELEGRAM_WEBHOOK_SECRET 2>/dev/null || true)"
  have_enabled="$(nexa_env_value "$app_env" TELEGRAM_WEBHOOK_ENABLED 2>/dev/null || true)"
  if [ -n "${have_secret//[[:space:]]/}" ] && [ -n "${have_enabled//[[:space:]]/}" ]; then
    return 0
  fi

  nexa_step "adding the Telegram webhook configuration"

  # Still only ADDS — this file is the operator's — but through a rename rather
  # than a `>>`, because a partial append is unrecoverable here.
  #
  # A `>>` interrupted by ENOSPC or an I/O error can land
  # `TELEGRAM_WEBHOOK_ENABLED=true` and a TRUNCATED but non-empty
  # `TELEGRAM_WEBHOOK_SECRET`. The next run reads both keys as present and
  # returns without repairing them, while the application refuses a secret below
  # the schema's minimum length — so the installation cannot boot and cannot be
  # resumed without an operator editing the file by hand. The whole file plus the
  # addition is written to a temporary file in the same directory and renamed
  # over the original, so the only two outcomes are the old file and the complete
  # new one. Nothing is echoed, and the temporary file is 0600 before it holds
  # anything.
  local tmp
  tmp="$(mktemp "${app_env}.XXXXXX")" || nexa_die "cannot write ${app_env}."
  chmod 0600 "$tmp"
  {
    cat "$app_env"
    printf '\n# --- The Telegram webhook ---------------------------------------------------\n'
    printf '# Added by the installer: this installation predates these keys.\n'
    if [ -z "${have_enabled//[[:space:]]/}" ]; then
      printf 'TELEGRAM_WEBHOOK_ENABLED=true\n'
    fi
    if [ -z "${have_secret//[[:space:]]/}" ]; then
      printf 'TELEGRAM_WEBHOOK_SECRET=%s\n' "$(random_webhook_secret)"
    fi
  } >"$tmp" || {
    rm -f "$tmp"
    nexa_die "cannot write ${app_env} (is /var full?)."
  }
  # Durable before it is visible: a rename that beats the data to disk would
  # leave a file whose CONTENT is the torn write this whole change is about.
  sync "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$app_env" || {
    rm -f "$tmp"
    nexa_die "cannot replace ${app_env}."
  }
  nexa_ok "the Telegram webhook configuration is present (the secret was not printed)"
}

install_assets() {
  nexa_step "installing deployment assets"
  install -m 0644 "${SCRIPT_DIR}/compose.yml" "${NEXA_DEPLOY_DIR}/compose.yml"
  install -m 0644 "${SCRIPT_DIR}/nexa.env.template" "${NEXA_DEPLOY_DIR}/nexa.env.template"
  install -d -m 0755 "${NEXA_DEPLOY_DIR}/caddy"
  install -m 0644 "${SCRIPT_DIR}/caddy/Caddyfile" "${NEXA_DEPLOY_DIR}/caddy/Caddyfile"
  install -m 0644 "${SCRIPT_DIR}/caddy/routes.caddy" "${NEXA_DEPLOY_DIR}/caddy/routes.caddy"
  install -m 0644 "${SCRIPT_DIR}/bin/nexa-lib.sh" "${NEXA_LIB_DIR}/nexa-lib.sh"
  install -m 0755 "${SCRIPT_DIR}/bin/botctl" "${NEXA_BIN_DIR}/botctl"
  nexa_ok "assets installed; botctl is at ${NEXA_BIN_DIR}/botctl"
}

write_deploy_env() {
  local image="$1"
  local file="${NEXA_CONFIG_DIR}/deploy.env"
  nexa_step "recording the deployment settings"
  umask 077
  # No secrets here. That is not because `docker compose config` would hide
  # them — it reads every env_file itself and prints their contents too — but
  # because this file is interpolated into the compose file, and a value that
  # ends up in `docker inspect`'s Cmd or in a container's labels is exposed
  # more widely than one that only reaches its environment.
  {
    printf '# Written by the Nexa installer. No secrets belong in this file.\n'
    printf 'NEXA_IMAGE=%s\n' "$image"
    printf 'NEXA_DOMAIN=%s\n' "$DOMAIN"
    printf 'NEXA_ACME_EMAIL=%s\n' "$ACME_EMAIL"
    printf 'NEXA_CONFIG_DIR=%s\n' "$NEXA_CONFIG_DIR"
    printf 'NEXA_DEPLOY_DIR=%s\n' "$NEXA_DEPLOY_DIR"
    printf 'NEXA_EDGE_SUBNET=%s\n' "${NEXA_EDGE_SUBNET:-172.29.0.0/24}"
    printf 'NEXA_DATA_SUBNET=%s\n' "${NEXA_DATA_SUBNET:-172.29.1.0/24}"
    # The generation of the edge configuration this installation starts with.
    # `install_assets` has already put the Caddy files on the host, so this is a
    # fingerprint of what the edge container will actually mount. Recorded here
    # so the first `botctl update` compares a real generation rather than the
    # `unset` default, which would recreate the edge for no reason.
    printf 'NEXA_EDGE_CONFIG=%s\n' "$(nexa_edge_config_fingerprint)"
  } >"$file"
  chmod 0600 "$file"
  nexa_ok "deployment settings recorded"
}

# ---------------------------------------------------------------------------
# Bringing it up
# ---------------------------------------------------------------------------
start_data_services() {
  nexa_step "starting PostgreSQL and Redis"
  nexa_compose up -d postgres redis
  # `awk '$2 == "healthy"'`, not `grep -c 'healthy'`. "healthy" is a SUBSTRING
  # of "unhealthy", so the old count reached two the moment BOTH services were
  # reporting unhealthy — and the installer announced them healthy and went on
  # to migrate against a database that was telling it not to.
  local waited=0
  until [ "$(nexa_compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null |
    awk '$2 == "healthy" { n += 1 } END { print n + 0 }')" -ge 2 ]; do
    [ "$waited" -lt 180 ] || nexa_die "PostgreSQL and Redis did not become healthy within 180s. Run 'botctl logs postgres'."
    sleep 3
    waited=$((waited + 3))
  done
  nexa_ok "PostgreSQL and Redis are healthy"
}

run_migrations() {
  nexa_step "applying migrations from the release image"
  # `--no-deps` so this does not start the API; `--rm` so nothing is left
  # behind. The migrator is the TARGET release's own compiled code.
  nexa_compose run --rm --no-deps --entrypoint node api \
    dist/infrastructure/persistence/migrate.js ||
    nexa_die "migrations failed. Nothing else has been started."
  nexa_ok "migrations applied"
}

provision_installation() {
  nexa_step "provisioning the installation"
  # Idempotent in the CLI itself: a second run reports the existing tenant and
  # changes nothing, including its name.
  nexa_compose run --rm --no-deps --entrypoint node api \
    dist/provision-installation.cli.js \
    --slug "$TENANT_SLUG" \
    --display-name "$TENANT_NAME" \
    --timezone "$TENANT_TIMEZONE" \
    --currency "$TENANT_CURRENCY" ||
    nexa_die "provisioning the installation failed."
  nexa_ok "installation provisioned"
}

# Which of the three states this database is in, straight from the application.
#
# `none` | `bootstrapped` | `foreign`, one word on stdout. Read-only: the CLI
# creates nothing in this mode and the fence in BootstrapOwnerService is not
# consulted, let alone relaxed.
owner_state() {
  nexa_compose run --rm --no-deps -T \
    --entrypoint node api dist/bootstrap-owner.cli.js --status 2>/dev/null |
    tr -d '\r' | sed -n '1p'
}

# Which of the three states this database is in, with the two that are not an
# answer turned into a refusal.
#
# Shared by both paths through `bootstrap_owner`, so a foreign or unreadable
# answer is refused identically whether or not --skip-owner was passed. Written
# as one function for exactly that reason: the same decision made in two places
# is the same decision until somebody edits one of them.
#
# Sets a global rather than printing its answer, because `nexa_die` calls `exit`
# and an `exit` inside `$( )` ends the substitution and not the installer. That
# would leave a refusal that prints in red and then carries on.
require_owner_state() {
  local state
  state="$(owner_state)" || state=""
  case "$state" in
    bootstrapped | none) OWNER_STATE="$state" ;;
    foreign)
      nexa_die "this database already has administrators that this installer did not create. Refusing to adopt an installation that was provisioned elsewhere: recording a release for it would attach this host's release identity to somebody else's data. Point NEXA_CONFIG_DIR at the right installation, or start from an empty database."
      ;;
    *)
      nexa_die "could not determine whether this installation already has an owner (the bootstrap CLI answered \"${state}\"). Refusing to guess: creating an owner here would be a second owner if one already exists, and skipping would leave an installation nobody can log in to."
      ;;
  esac
}

bootstrap_owner() {
  # Ask before saying anything, on BOTH paths.
  #
  # The owner is committed here, and the release manifest and `current` pointer
  # are written several steps later. An install interrupted in that gap leaves a
  # HEALTHY installation with a real owner and no recorded release — `botctl
  # version` says "no current release is recorded" and cannot be talked out of
  # it, because the documented remedy is a rerun and a rerun used to die right
  # here with BOOTSTRAP_ALREADY_DONE. That is not a hypothetical: it is what a
  # real Ubuntu 24.04 staging host did.
  #
  # The fix is NOT to accept any administrator as proof of success. It is to ask
  # whether THIS installation's bootstrap created them, which the application
  # answers from the audit record written in the owner's own transaction — so
  # there is no window where the owner exists and the answer is no.
  require_owner_state
  local state="$OWNER_STATE"

  if [ "$SKIP_OWNER" = "yes" ]; then
    # --skip-owner says "do not create one", not "there is not one".
    #
    # It used to print "Nobody can log in until you run ..." unconditionally,
    # which on a rerun of an already-bootstrapped installation was simply false
    # — and false in the direction that sends an operator to run a bootstrap
    # that would refuse them. Real-VPS acceptance found it.
    if [ "$state" = "bootstrapped" ]; then
      nexa_ok "skipping owner bootstrap; an existing owner is already present"
      return 0
    fi
    nexa_warn "skipping the first owner. Nobody can log in until you run:"
    nexa_warn "  docker compose --env-file ${NEXA_CONFIG_DIR}/deploy.env -f ${NEXA_DEPLOY_DIR}/compose.yml run --rm --no-deps --entrypoint node api dist/bootstrap-owner.cli.js"
    return 0
  fi

  nexa_step "creating the first owner"

  if [ "$state" = "bootstrapped" ]; then
    # Already done, by this installation. Nothing to create, nothing to ask,
    # and the release state below still needs writing.
    nexa_ok "the first owner already exists from an earlier run of this installer"
    return 0
  fi

  # The username and display name may be arguments — they are not secret. The
  # PASSWORD may not: argv is readable by every user on the machine via `ps`,
  # and an environment variable would be readable through `docker inspect`. It
  # reaches the CLI on stdin and nowhere else.
  local -a identity=()
  [ -n "$OWNER_USERNAME" ] && identity+=(--username "$OWNER_USERNAME")
  [ -n "$OWNER_DISPLAY_NAME" ] && identity+=(--display-name "$OWNER_DISPLAY_NAME")

  # Two invocations rather than one clever one. They differ in the two things
  # that genuinely differ — whether a pseudo-TTY is allocated, and where stdin
  # comes from — and a single call with `-T` toggled and stdin redirected from
  # `/dev/tty` reads as if it were the same operation when it is not.
  #
  # Non-interactive: `-T` because a file is not a terminal, and the CLI skips
  # its confirmation prompt off a TTY — a piped password was not typed, so
  # asking a script to repeat itself buys nothing.
  local ok=0
  if [ -n "$OWNER_PASSWORD_FILE" ]; then
    nexa_compose run --rm --no-deps -T \
      --entrypoint node api dist/bootstrap-owner.cli.js \
      "${identity[@]+"${identity[@]}"}" \
      <"$OWNER_PASSWORD_FILE" || ok=1
  else
    # Interactive: stdin is left alone. The CLI prompts, hides the input and
    # asks for confirmation, which is the whole reason it reads a terminal.
    nexa_compose run --rm --no-deps \
      --entrypoint node api dist/bootstrap-owner.cli.js \
      "${identity[@]+"${identity[@]}"}" || ok=1
  fi
  if [ "$ok" -ne 0 ]; then
    nexa_die "creating the first owner failed. The installation is up; rerun this installer or run the bootstrap by hand."
  fi
  nexa_ok "first owner created"
}

# ---------------------------------------------------------------------------
# The Telegram bot
# ---------------------------------------------------------------------------

# What this installation's Telegram bootstrap still needs: none, incomplete or
# ready. Asked BEFORE anything is said, on both paths, the way the owner state
# is — the answer decides whether a token is asked for at all, and getting it
# wrong in either direction is the whole failure this step exists to avoid.
telegram_state() {
  nexa_compose run --rm --no-deps -T \
    --entrypoint node api dist/bootstrap-bot.cli.js \
    --status --public-base-url "https://${DOMAIN}" 2>/dev/null |
    tr -d '\r\n'
}

# `--skip-telegram` says "do not configure one", not "there is not one".
#
# The distinction `--skip-owner` had to learn on a real host, where it told an
# already-bootstrapped installation to run a bootstrap that would refuse it. The
# state is read here — and a state that cannot be read is reported rather than
# fatal, because the operator has already said they are not configuring Telegram
# in this run.
skip_telegram_bot() {
  local state
  state="$(telegram_state)" || state=""
  case "$state" in
    ready)
      nexa_ok "skipping the Telegram bot; it is already configured and receiving updates"
      ;;
    none)
      # `botctl telegram register` cannot do this one. It runs the CLI with no
      # token and no terminal, and creating the FIRST bot row needs a token —
      # so naming it here would send the operator to a command that must fail.
      nexa_warn "skipping the Telegram bot. Nothing is configured yet; it cannot receive any"
      nexa_warn "message until you rerun this installer with a token source, for example:"
      nexa_warn "  sudo ./install.sh --domain ${DOMAIN} --acme-email ${ACME_EMAIL} --version ${VERSION} --bot-token-file /path/to/token"
      ;;
    incomplete | unavailable)
      # A credential is already stored, so the retry genuinely needs nothing.
      nexa_warn "skipping the Telegram bot. It cannot receive any message until you run:"
      nexa_warn "  botctl telegram register"
      ;;
    *)
      nexa_warn "skipping the Telegram bot, and its state could not be read. Check with:"
      nexa_warn "  botctl telegram status"
      ;;
  esac
}

configure_telegram_bot() {
  # `--skip-telegram` FIRST, before the state is even asked for.
  #
  # The refusal-to-guess below is right and its position was not: an operator who
  # explicitly asked not to configure Telegram had their install killed by a
  # Telegram CLI that would not answer. Skipping is a decision they already made;
  # it does not need a state to be made against.
  if [ "$SKIP_TELEGRAM" = "yes" ]; then
    skip_telegram_bot
    return 0
  fi

  local state
  state="$(telegram_state)" || state=""

  case "$state" in
    none | incomplete | ready | unavailable) ;;
    *)
      # Not a guess and not a skip. Both readings are wrong in a way the
      # operator pays for: treating an unreadable answer as `none` prompts for
      # a token an installation may already have, and treating it as `ready`
      # reports a working bot that may never have been configured.
      nexa_die "could not determine whether this installation's Telegram bot is configured (the bootstrap CLI answered \"${state}\"). Refusing to guess."
      ;;
  esac

  nexa_step "configuring Telegram bot"

  if [ "$state" = "unavailable" ]; then
    # Still runs the CLI. This used to return here, and returning was wrong for
    # two separate reasons.
    #
    # A supplied token file never reached `refuseRepointing`, so a file naming a
    # DIFFERENT bot was silently ignored in exactly the state an operator is most
    # likely to be reaching for one — the same defect as the `ready`/`incomplete`
    # short-circuit, in the one state the fix for it did not cover.
    #
    # And the reason was never printed. Something OTHER than a missing
    # registration stops this bot receiving updates — the bot instance is not
    # ACTIVE, the tenant has stopped accepting work, or the webhook route is
    # disabled — and this told the operator to run a second command to find out
    # which, when the CLI says so itself and refuses to register. Registering
    # cannot happen from here: `execute` throws before `setWebhook`.
    nexa_log "This installation's bot cannot receive updates for a reason other than registration."
  fi

  # `incomplete` and `ready` BOTH run the CLI, and `ready` is the one that
  # matters.
  #
  # ADR-0029: a rerun asks Telegram whether the stored token still works, every
  # time, because that is the only way the promise to report a REVOKED token as
  # an explicit configuration problem can be kept. The service does that; this
  # step used to short-circuit on `ready` and never invoke it — so the rule was
  # implemented in the layer that cannot be the last word and bypassed in the
  # layer that is, and an installer rerun printed a green "already configured"
  # for an installation whose bot could not authenticate a single call.
  #
  # The CLI is idempotent in that state: it re-checks, registers nothing, and
  # reports ALREADY_COMPLETE. Its exit status decides what is printed here.
  if [ "$state" = "incomplete" ]; then
    nexa_log "A bot is already configured; resuming from the stored token. You will not be asked for it again."
  fi

  # Two invocations rather than one clever one, for the reason the owner
  # bootstrap gives: they differ in whether a pseudo-TTY is allocated and where
  # stdin comes from, and a single call with `-T` toggled reads as if it were
  # the same operation when it is not.
  #
  # The token reaches the CLI on stdin or from a file inside the container, and
  # never as an argument: argv is readable by every user on the machine via
  # `ps`, and an environment variable would be readable through `docker
  # inspect`. The same rule as the owner's password, and the same reasons.
  # A supplied token is passed on EVERY state, not only `none`.
  #
  # The CLI never ASKS on a rerun — that is ADR-0029 decision 3 and it is
  # unchanged — but an operator who explicitly staged a token file has not been
  # asked. Ignoring it silently is how a file naming a DIFFERENT bot slipped past
  # the refusal that exists to catch exactly that, while the installer printed
  # success having changed nothing.
  #
  # STDIN, not a bind mount. The release image runs as `node` (uid 1000) and the
  # file this installer's own documentation tells an operator to create is
  # root-owned and mode 0600, so a mount is unreadable inside the container and
  # the whole unattended path fails with EACCES. The owner's password has always
  # been streamed this way; not copying it was the mistake.
  #
  # The CLI's output is CAPTURED on the two non-interactive paths and echoed
  # unchanged, because its error CODE is the only thing that says what the
  # operator should do next. The local state cannot: `ready` and `incomplete`
  # are equally true of a revoked stored token and of a webhook that was never
  # registered, and those have opposite remedies.
  #
  # A variable, never a file. The CLI is asserted not to print the token, but a
  # captured stream is a new place a credential could land if that ever
  # regressed, and a shell variable never reaches the disk.
  #
  # The interactive path is NOT captured: a prompt delivered after the command
  # has finished is not a prompt. It cannot produce either code that needs one —
  # it runs only at `none`, where nothing is stored to be revoked and no bot id
  # exists to be contradicted.
  local ok=0
  local out=""
  if [ -n "$BOT_TOKEN_FILE" ]; then
    out="$(nexa_compose run --rm --no-deps -T \
      --entrypoint node api dist/bootstrap-bot.cli.js \
      --public-base-url "https://${DOMAIN}" \
      --bot-token-stdin <"$BOT_TOKEN_FILE" 2>&1)" || ok=1
    printf '%s\n' "$out" >&2
  elif [ "$state" = "none" ]; then
    # No token source and no terminal: refused HERE, where the state is known,
    # rather than in preflight where it is not. This is the only state in which
    # a token is needed.
    if [ ! -t 0 ]; then
      nexa_die "no terminal and no --bot-token-file: there is no safe way to read the Telegram bot token for a first configuration. Pass --bot-token-file, or --skip-telegram and configure it later by rerunning this installer with a token source."
    fi
    # Interactive: stdin is left alone, and the CLI prompts with no echo.
    nexa_compose run --rm --no-deps \
      --entrypoint node api dist/bootstrap-bot.cli.js \
      --public-base-url "https://${DOMAIN}" || ok=1
  else
    # Nothing to ask for, so no terminal is needed and none is allocated: `-T`,
    # because allocating a pseudo-TTY for a command in a script is how a
    # non-interactive rerun hangs.
    out="$(nexa_compose run --rm --no-deps -T \
      --entrypoint node api dist/bootstrap-bot.cli.js \
      --public-base-url "https://${DOMAIN}" 2>&1)" || ok=1
    printf '%s\n' "$out" >&2
  fi

  if [ "$ok" -ne 0 ]; then
    # NOT a `nexa_die`. ADR-0029 decision 4, both halves: the tenant, the owner,
    # the validated token and the bot row are all correct and expensive to
    # produce, and a DNS record that has not propagated is no reason to destroy
    # them — so the install finishes writing the release manifest and the
    # `current` pointer, which is what makes the rerun cheap.
    #
    # But it does not report success. `main` reads this and exits non-zero with
    # the outstanding step named.
    TELEGRAM_INCOMPLETE="yes"
    nexa_warn "the Telegram bot is not receiving updates yet. The error above says why."

    # WHICH failure this was decides what the operator is told to run, and the
    # state is asked again rather than assumed.
    #
    # Every failure used to land in one branch and print the resume story: "the
    # token is stored encrypted; `botctl telegram register` will retry without
    # asking". For a rejected token or an unreachable `getMe` on a FIRST attempt
    # that is false in every part — nothing was written, there is no stored
    # token, and that command deliberately supplies neither a token nor a
    # terminal, so the advertised retry cannot work. `getMe` runs before
    # `createFromBootstrap` precisely so no row exists, and the summary has to
    # say so.
    #
    # The state answers "is anything stored". It does NOT answer "did THIS run
    # fail at the webhook", and the summary used to assume it did: a rerun whose
    # stored token had been revoked failed at `getMe`, left the state `ready` or
    # `incomplete`, and was told to run `botctl telegram register` — which reads
    # the same stored token and fails identically. The code refines the answer
    # where the state cannot.
    #
    # `none` is checked FIRST and is never overridden. A rejected token on a
    # first attempt stored nothing, and "nothing was stored" is the whole story
    # there; the remedy is a token source, not a report about a credential that
    # does not exist.
    TELEGRAM_RETRY="$(telegram_state)" || TELEGRAM_RETRY=""
    if [ "$TELEGRAM_RETRY" != "none" ]; then
      case "$out" in
        *telegram.bootstrap_different_bot*) TELEGRAM_RETRY="different-bot" ;;
        *telegram.bootstrap_token_rejected*) TELEGRAM_RETRY="token-rejected" ;;
        # The stored token could not be DECRYPTED, which is not the same failure
        # as Telegram refusing it and does not have the same remedy. `execute`
        # resolves the credential before it calls anything, so a missing key, a
        # key id that no longer matches, or v1 acceptance having been turned off
        # fails here — and the first version of this classifier knew only the two
        # Telegram codes, so every one of them fell through to the webhook
        # summary and was told to run a command that reads the same unreadable
        # ciphertext. Matched by PREFIX: these four codes are one remedy, and a
        # fifth added to the taxonomy belongs with them rather than silently
        # back in the fallback.
        *platform.secret_*) TELEGRAM_RETRY="token-unreadable" ;;
      esac
    fi
    return 0
  fi

  nexa_ok "the Telegram bot is configured and receiving updates"
}

start_everything() {
  nexa_step "starting the full stack"
  nexa_compose up -d --remove-orphans
  nexa_wait_ready 240 || nexa_die "the API did not become ready. Run 'botctl logs api'."
  nexa_ok "the stack is up and the API is ready"
}

# ---------------------------------------------------------------------------
main() {
  # Preflight and the layout come FIRST, and only then the lock.
  #
  # The lock file lives in the state directory, so taking it earlier would
  # create that directory from the umask rather than from `create_layout`'s
  # explicit 0750. Nothing before this line changes what is running: preflight
  # only reads, and creating directories is idempotent. The steps an install
  # and an update must not interleave — migrating, switching the image, writing
  # the release pointers — are all below it.
  preflight
  ensure_docker
  create_layout

  # One writer at a time, exactly as botctl update and rollback take it: an
  # installer racing an update would interleave migrations.
  nexa_acquire_lock 0

  check_registry

  nexa_step "resolving ${VERSION} to an immutable digest"
  local digest image commit
  digest="$(nexa_resolve_digest "$VERSION")" ||
    nexa_die "could not resolve ${NEXA_IMAGE_REPO}:${VERSION}."
  image="${NEXA_IMAGE_REPO}@${digest}"
  refuse_digest_change "$digest"
  nexa_ok "${VERSION} is ${digest}"

  # AFTER the refusal, and that ordering is the whole point of the refusal.
  #
  # This overwrites the host's compose.yml, Caddyfile, nexa-lib.sh and botctl —
  # the installed release's TOOLING. It used to run before the digest was even
  # resolved, so a rerun of a version whose tag had been moved was refused by
  # `refuse_digest_change` as designed, and stopped with the host already
  # carrying this checkout's tooling over the release that is actually running.
  # A refusal that says "nothing was changed" has to be true when it says it.
  #
  # It stays before `generate_secrets`, which substitutes into the
  # `nexa.env.template` installed here.
  install_assets

  generate_secrets
  # Additive, and separate from the once-only generation above: a host installed
  # before these keys existed gets them here, and one that already has them is
  # left exactly alone.
  ensure_telegram_config
  write_deploy_env "$image"

  nexa_step "pulling the release"
  nexa_pull_release "$digest"
  nexa_ok "release image present"

  # The commit the image was built from, read out of the image itself rather
  # than assumed. The manifest is only useful if it is true.
  commit="$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
  [ -n "$commit" ] || commit="unknown"

  start_data_services
  run_migrations
  provision_installation
  start_everything
  bootstrap_owner
  # LAST of the creating steps, and after the stack is up: unlike provisioning
  # it makes an outbound call, so it needs a running API's network and a
  # database that has been migrated.
  configure_telegram_bot

  # What this install put on the host, recorded under the DIGEST it runs.
  #
  # `botctl update` installs the TARGET release's assets and needs somewhere to
  # put the outgoing ones back if the target does not come up. Recording them
  # here means the first update after an install already has that set; an
  # installation made before this mechanism existed gets it captured by the
  # update itself.
  nexa_capture_live_assets "$digest" "$VERSION" ||
    nexa_warn "the host assets for ${VERSION} could not be recorded; the first update will capture them."

  nexa_write_manifest "$VERSION" "$commit" "$digest"
  # Through the same atomic write botctl uses. `printf > file` truncates first,
  # so an interruption here left an EMPTY current — an installation reporting
  # no release at all, which is the one state neither update nor rollback can
  # recover from.
  nexa_write_atomic "$NEXA_CURRENT_FILE" "$VERSION"

  # The release is recorded whatever happened to Telegram, and that ordering is
  # the point of recording it here: an installation whose bot is not yet
  # registered is still an installation, and `botctl version` refusing to
  # describe it is the exact failure a real staging host produced when the owner
  # step was allowed to abandon the manifest.
  if [ -n "$TELEGRAM_INCOMPLETE" ]; then
    # SIX summaries, because there are six failures and they have six different
    # remedies. Saying "the token is stored, the retry resumes from it"
    # is a false statement after a failure that stored NOTHING, and it is equally
    # false after one whose stored token is the thing Telegram refused — both
    # send the operator to a command that cannot work.
    #
    # This started as two and was not exhaustive, and the round that made it
    # five was not either: a stored token that cannot be DECRYPTED fails before
    # Telegram is reached at all, and fell through to the webhook summary. The
    # state alone answers only "is a row there", which is why every one added
    # since is keyed on the CLI's error code or on the `unavailable` state.
    if [ "$TELEGRAM_RETRY" = "none" ]; then
      cat >&2 <<INCOMPLETE_NOTHING_STORED

$(nexa_warn "Nexa ${VERSION} is installed, and its Telegram bot is NOT configured.")

  outstanding   configuring the bot at all — nothing was stored
  retry         rerun this installer with a token source:
                sudo ./install.sh --domain ${DOMAIN} --acme-email ${ACME_EMAIL} --version ${VERSION} --bot-token-file /path/to/token
  why           the error printed above this summary

The token was NOT stored: it is validated with Telegram before anything is
written, so a rejected token or a Telegram this host cannot reach leaves no
credential behind and nothing to resume from. \`botctl telegram register\` cannot
finish this — it supplies no token by design — so the retry is this installer.

  panel      https://${DOMAIN}
  status     botctl telegram status

Configuration and secrets live in ${NEXA_CONFIG_DIR} (0700, root-owned).
INCOMPLETE_NOTHING_STORED
      return 1
    fi

    if [ "$TELEGRAM_RETRY" = "token-rejected" ]; then
      cat >&2 <<INCOMPLETE_TOKEN_REJECTED

$(nexa_warn "Nexa ${VERSION} is installed, and Telegram REFUSED its stored bot token.")

  outstanding   a bot token Telegram accepts
  retry         NOT \`botctl telegram register\` — it reads the same stored token
                and fails the same way. See below.
  why           the error printed above this summary

Nothing was changed and nothing was lost. The stored token is the one Telegram
is refusing, which usually means it was revoked in BotFather — a configuration
problem, not a step to retry.

This release cannot replace a stored token, and rerunning this installer with a
newly issued one does NOT: a supplied token is read only to refuse one naming a
different bot, and the registration itself always uses the credential already in
the row. A rerun with a reissued token for the same bot therefore fails exactly
as this run did. The gap is recorded as OQ-TG-01 in \`docs/open-questions.md\`;
until a release adds an explicit rotation command there is no supported
procedure here, and this summary will not invent one.

  panel      https://${DOMAIN}
  status     botctl telegram status

Configuration and secrets live in ${NEXA_CONFIG_DIR} (0700, root-owned).
INCOMPLETE_TOKEN_REJECTED
      return 1
    fi

    if [ "$TELEGRAM_RETRY" = "token-unreadable" ]; then
      cat >&2 <<INCOMPLETE_TOKEN_UNREADABLE

$(nexa_warn "Nexa ${VERSION} is installed, and its stored bot token cannot be DECRYPTED.")

  outstanding   the secrets configuration that can read the stored token
  retry         NOT \`botctl telegram register\` — it reads the same ciphertext
                and fails before it reaches Telegram. Repair the keys first:
                  botctl secrets status
  why           the error printed above this summary names the key

Nothing was changed and the token is still there. This is a KEY problem, not a
token problem: the stored credential was encrypted with a key this installation
can no longer use — usually SECRETS_KEK or SECRETS_ACTIVE_KEY_ID in
${NEXA_CONFIG_DIR}/nexa.env having changed, or v1 acceptance having been turned
off while a v1 ciphertext is still stored. Restoring the key material makes the
existing token readable again; nothing needs reissuing in BotFather.

  panel      https://${DOMAIN}
  status     botctl telegram status

Configuration and secrets live in ${NEXA_CONFIG_DIR} (0700, root-owned).
INCOMPLETE_TOKEN_UNREADABLE
      return 1
    fi

    if [ "$TELEGRAM_RETRY" = "different-bot" ]; then
      cat >&2 <<INCOMPLETE_DIFFERENT_BOT

$(nexa_warn "Nexa ${VERSION} is installed, and the token you supplied names a DIFFERENT bot.")

  outstanding   nothing, unless you meant to supply that token
  retry         rerun without --bot-token-file, or with a token for the bot this
                installation is already bound to
  why           the error printed above this summary names both bot ids

Nothing was changed. An installer rerun reconciles; it never repoints an
installation at another bot, because every stored Telegram user and chat belongs
to the one it already has. This installation's own bot may well be working — ask
\`botctl telegram status\`. If you genuinely intend to move to another bot, that
is a migration this release does not perform.

  panel      https://${DOMAIN}
  status     botctl telegram status

Configuration and secrets live in ${NEXA_CONFIG_DIR} (0700, root-owned).
INCOMPLETE_DIFFERENT_BOT
      return 1
    fi

    if [ "$TELEGRAM_RETRY" = "unavailable" ]; then
      cat >&2 <<INCOMPLETE_UNAVAILABLE

$(nexa_warn "Nexa ${VERSION} is installed, and its Telegram bot is held back from receiving updates.")

  outstanding   whatever the error above names — NOT the webhook
  retry         fix that first; then: botctl telegram register
  why           the error printed above this summary

Registering a webhook now would point Telegram at an endpoint that refuses every
update it delivers, so nothing was registered. The causes are the bot instance
not being ACTIVE, the tenant having stopped accepting work, or
TELEGRAM_WEBHOOK_ENABLED being false in ${NEXA_CONFIG_DIR}/nexa.env. The token,
if one is stored, is untouched and the retry will not ask for it.

  panel      https://${DOMAIN}
  status     botctl telegram status

Configuration and secrets live in ${NEXA_CONFIG_DIR} (0700, root-owned).
INCOMPLETE_UNAVAILABLE
      return 1
    fi

    cat >&2 <<INCOMPLETE

$(nexa_warn "Nexa ${VERSION} is installed, and its Telegram bot is NOT receiving updates.")

  outstanding   registering the webhook with Telegram
  retry         botctl telegram register
  why           the error printed above this summary

Nothing needs undoing and nothing needs typing again. The bot token is stored,
encrypted, and the retry resumes from it — it will not ask you for it. The
usual causes are DNS for ${DOMAIN} not yet resolving to this host, or a
certificate not yet issued: Telegram will not deliver to an endpoint it cannot
reach over HTTPS.

  panel      https://${DOMAIN}
  status     botctl telegram status

Configuration and secrets live in ${NEXA_CONFIG_DIR} (0700, root-owned).
INCOMPLETE
    # Non-zero, deliberately. ADR-0029 decision 4: a Telegram-enabled
    # installation whose bot cannot receive a single update is not a completed
    # installation, and an installer that exits 0 here is the silent-success
    # pattern this codebase exists to avoid. A script driving this installer
    # must be able to tell the difference without parsing prose.
    return 1
  fi

  cat <<SUMMARY

$(nexa_ok "Nexa ${VERSION} is installed")

  panel      https://${DOMAIN}
  version    botctl version
  status     botctl status
  backup     botctl backup
  update     botctl update <version>
  rollback   botctl rollback

Configuration and secrets live in ${NEXA_CONFIG_DIR} (0700, root-owned).
Backups are written to ${NEXA_BACKUP_DIR}.

The certificate is issued on the first HTTPS request, so give ${DOMAIN} a
moment and make sure its DNS points at this host.
SUMMARY
}

# Executed, not sourced. Sourcing runs the argument parsing above and defines
# the functions without installing anything, which is how the test suite drives
# `preflight` through its refusals without a Docker daemon and without any risk
# of an installer running for real on a build machine.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
