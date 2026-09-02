#!/usr/bin/env bash
# Install Nexa on a fresh Ubuntu server.
#
# Idempotent and resumable: every step checks whether it has already been done,
# and a run that fails half-way can be repeated without undoing what worked.
# Secrets in particular are generated ONCE — a rerun that minted a new database
# password would lock the installation out of its own data.
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
SKIP_OWNER="no"

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
  -h, --help                   this text

The owner's password is never accepted as a command-line argument: argv is
readable by every user on the machine and lands in shell history.
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
  local port listeners names
  for port in 80 443; do
    listeners="$(ss -Hltn "sport = :${port}" 2>/dev/null || true)"
    if [ -n "$listeners" ]; then
      # Our own Caddy holding the port on a rerun is expected, not a conflict.
      # `grep -c` reads to the end of its input, so nothing upstream is ever
      # killed mid-write; `grep -q` would not.
      names="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -c '^nexa-caddy' || true)"
      [ "${names:-0}" -eq 0 ] || continue
      nexa_die "something is already listening on port ${port}. Nexa's edge needs 80 (ACME and the redirect) and 443. Stop the other service, or install Nexa on a host that is not already serving HTTP."
    fi
  done
  nexa_ok "ports 80 and 443 are free"

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
  install -d -m 0755 "$NEXA_DEPLOY_DIR" "$NEXA_LIB_DIR"
  install -d -m 0750 "$NEXA_STATE_DIR" "$NEXA_RELEASES_DIR"
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
  # BUILD_TIME is last in the template, and that is why it is in this list.
  # The keys before it sit in the first half of a 76-line file, so a write that
  # died two thirds of the way through satisfied all of them — and a nexa.env
  # missing DEPLOYMENT_TOPOLOGY is worse than one missing SECRETS_KEK, because
  # that key HAS a schema default: losing it silently stops TRUSTED_PROXY_IPS
  # being required, and the API boots ignoring X-Forwarded-For. A key from the
  # end is the cheapest true test that the write reached it.
  if secrets_complete "$app_env" SECRETS_KEK SECRETS_KEK_ID DATABASE_URL REDIS_URL \
    WEB_ADMIN_ORIGINS DEPLOYMENT_TOPOLOGY BUILD_TIME; then have=$((have + 1)); else missing=$((missing + 1)); fi

  if [ "$missing" -eq 0 ]; then
    nexa_ok "secrets already exist; leaving them alone"
    return 0
  fi
  if [ "$have" -gt 0 ]; then
    nexa_die "the configuration in ${NEXA_CONFIG_DIR} is incomplete: some files are complete and some are missing or truncated. Refusing to half-generate secrets over it. Inspect the directory and either complete it or move it aside."
  fi

  umask 077

  local pg_password redis_password kek kek_id
  pg_password="$(random_password)"
  redis_password="$(random_password)"
  kek="$(random_base64)"
  kek_id="install-$(date -u +%Y%m%d)"

  # Written by redirection, never echoed. Nothing below prints a value. Each
  # file lands complete or not at all, so a kill or an ENOSPC between them
  # leaves a state the next run can read correctly and resume from.
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
  python3 -c '
import sys
source, target = sys.argv[1], sys.argv[2]
replacements = dict(pair.split("=", 1) for pair in sys.argv[3:])
with open(source, "r", encoding="utf-8") as handle:
    text = handle.read()
for token, value in replacements.items():
    text = text.replace(token, value)
with open(target, "w", encoding="utf-8") as handle:
    handle.write(text)
' "${NEXA_DEPLOY_DIR}/nexa.env.template" "${app_env}.partial" \
    "__POSTGRES_PASSWORD__=${pg_password}" \
    "__REDIS_PASSWORD__=${redis_password}" \
    "__SECRETS_KEK__=${kek}" \
    "__SECRETS_KEK_ID__=${kek_id}" \
    "__DOMAIN__=${DOMAIN}" \
    "__EDGE_SUBNET__=${NEXA_EDGE_SUBNET:-172.29.0.0/24}" \
    "__BUILD_VERSION__=${VERSION}" \
    "__BUILD_COMMIT__=pending" \
    "__BUILD_TIME__=pending"

  # Same rule for the substituted template: it is complete before it is named.
  chmod 0600 "${app_env}.partial"
  sync "${app_env}.partial" 2>/dev/null || true
  mv -f "${app_env}.partial" "$app_env"

  chmod 0600 "$pg_env" "$redis_env" "$app_env"
  nexa_ok "secrets generated (0600, root-owned, never printed)"
}

install_assets() {
  nexa_step "installing deployment assets"
  install -m 0644 "${SCRIPT_DIR}/compose.yml" "${NEXA_DEPLOY_DIR}/compose.yml"
  install -m 0644 "${SCRIPT_DIR}/nexa.env.template" "${NEXA_DEPLOY_DIR}/nexa.env.template"
  install -d -m 0755 "${NEXA_DEPLOY_DIR}/caddy"
  install -m 0644 "${SCRIPT_DIR}/caddy/Caddyfile" "${NEXA_DEPLOY_DIR}/caddy/Caddyfile"
  install -m 0644 "${SCRIPT_DIR}/caddy/routes.caddy" "${NEXA_DEPLOY_DIR}/caddy/routes.caddy"
  install -m 0644 "${SCRIPT_DIR}/bin/nexa-lib.sh" "${NEXA_LIB_DIR}/nexa-lib.sh"
  install -m 0755 "${SCRIPT_DIR}/bin/botctl" /usr/local/bin/botctl
  nexa_ok "assets installed; botctl is at /usr/local/bin/botctl"
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

bootstrap_owner() {
  if [ "$SKIP_OWNER" = "yes" ]; then
    nexa_warn "skipping the first owner. Nobody can log in until you run:"
    nexa_warn "  docker compose --env-file ${NEXA_CONFIG_DIR}/deploy.env -f ${NEXA_DEPLOY_DIR}/compose.yml run --rm --no-deps --entrypoint node api dist/bootstrap-owner.cli.js"
    return 0
  fi

  nexa_step "creating the first owner"

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

  install_assets
  check_registry

  nexa_step "resolving ${VERSION} to an immutable digest"
  local digest image commit
  digest="$(nexa_resolve_digest "$VERSION")" ||
    nexa_die "could not resolve ${NEXA_IMAGE_REPO}:${VERSION}."
  image="${NEXA_IMAGE_REPO}@${digest}"
  nexa_ok "${VERSION} is ${digest}"

  generate_secrets
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

  nexa_write_manifest "$VERSION" "$commit" "$digest"
  # Through the same atomic write botctl uses. `printf > file` truncates first,
  # so an interruption here left an EMPTY current — an installation reporting
  # no release at all, which is the one state neither update nor rollback can
  # recover from.
  nexa_write_atomic "$NEXA_CURRENT_FILE" "$VERSION"

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
