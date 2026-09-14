#!/usr/bin/env bash
# `botctl update` and `botctl rollback`, against a real registry and a real
# database.
#
# The fake-docker suite proves the state machine's ORDER and its failure
# branches. It cannot prove that a tag resolves to a digest, that pulling by
# that digest works, that the migration applies against a live PostgreSQL, or
# that a release which starts but never becomes ready is actually backed out.
# This runs a registry container and three real images to show those.
#
# Three transitions, in the order that matters:
#
#   A -> B          a successful update, where A and B carry DIFFERENT edge
#                   configurations: B must be the one the edge is serving
#                   afterwards, read from a response rather than from disk
#   B -> BROKEN     a release that starts and never becomes ready: it must NOT
#                   become current, and B must come back
#   B -> BAD EDGE   a release whose application is byte-identical to B and whose
#                   Caddy configuration cannot be loaded: it must NOT become
#                   current, and B's edge configuration must come back
#   B -> A          a rollback, which must not touch the database, and which
#                   must return the EDGE to A's configuration too
set -euo pipefail

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$REPO"

REGISTRY_PORT="${REGISTRY_PORT:-5000}"
REGISTRY="127.0.0.1:${REGISTRY_PORT}"
IMAGE_REPO="${REGISTRY}/nexa/nexa-bot"
HTTP_PORT="${NEXA_CI_HTTP_PORT:-18081}"

fail() {
  printf '\033[31mFAIL\033[0m  %s\n' "$1" >&2
  compose ps 2>&1 | head -20 || true
  compose logs --tail 40 api 2>&1 | tail -40 || true
  exit 1
}
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }
step() { printf '\n\033[1m==>\033[0m %s\n' "$1"; }

ROOT="$(mktemp -d)"
export NEXA_ROOT="$ROOT"
export NEXA_DEPLOY_DIR="${ROOT}/opt/nexa/deploy"
export NEXA_CONFIG_DIR="${ROOT}/etc/nexa"
export NEXA_STATE_DIR="${ROOT}/var/lib/nexa"
export NEXA_BACKUP_DIR="${ROOT}/var/backups/nexa"
export NEXA_LOCK_FILE="${ROOT}/var/lib/nexa/nexa.lock"
# Explicit, never inherited. Left unset this defaults to ${NEXA_ROOT}/usr/local/bin,
# which is the real /usr/local/bin the moment NEXA_ROOT is empty — and this
# script installs a botctl there.
export NEXA_BIN_DIR="${ROOT}/usr/local/bin"
export NEXA_LIB_DIR="${ROOT}/opt/nexa/lib"
export NEXA_IMAGE_REPO="$IMAGE_REPO"
export NEXA_LIB="${REPO}/deploy/bin/nexa-lib.sh"
# A release that will never be ready must not hold the run for three minutes.
export NEXA_READY_TIMEOUT="${NEXA_READY_TIMEOUT:-60}"
BOTCTL="${REPO}/deploy/bin/botctl"

compose() {
  docker compose \
    --env-file "${NEXA_CONFIG_DIR}/deploy.env" \
    -f "${NEXA_DEPLOY_DIR}/compose.yml" \
    -f "${REPO}/deploy/compose.ci.yml" \
    "$@"
}

# A request THROUGH the edge, from inside the edge container.
#
# Not the published port, and that is not a shortcut. `botctl` runs compose
# with the release's own compose.yml and NOTHING else — no CI override — so the
# moment an update or a rollback recreates the edge, the loopback port this
# script published is gone. Every check here has to survive that, and the
# address that does is the internal health site: plain HTTP on the container's
# own loopback, defined by BOTH Caddyfiles, importing the same `nexa_routes`
# snippet the public site does. So this exercises the real handle order, the
# real SPA fallback, the real asset root and the real pool.
edge_get() {
  compose exec -T caddy wget -q -O - "http://127.0.0.1:8080$1"
}
edge_serves() {
  compose exec -T caddy wget -q -O /dev/null "http://127.0.0.1:8080$1"
}

# Which release's EDGE CONFIGURATION is loaded, as a browser sees it.
#
# Not "is Caddy healthy", and not "is the right bundle on disk". The staging
# defect that this exists for had a healthy Caddy, the new bundle published, the
# new release recorded — and the PREVIOUS release's routing still parsed into the
# running container's memory. The only way to see that is to ask the edge for a
# response and read what the configuration put in it.
#
# Each release's routes snippet carries `X-Nexa-Edge: <version>`, added by this
# script when it builds the release, so the answer names a release rather than
# merely differing.
edge_config_marker() {
  compose exec -T caddy wget -q -S -O /dev/null "http://127.0.0.1:8080/" 2>&1 |
    sed -n 's/.*[Xx]-[Nn]exa-[Ee]dge: *//p' | tr -d '\r' | sed -n '1p'
}

# The Web Admin as a browser gets it: the document, then every hashed asset the
# document names. Both go through the edge, and they go through DIFFERENT roots
# — the document from the activated release, the assets from the pool — which
# is exactly the split that a publication can get wrong.
#
# Prints `bundle=<v1|v2> assets=<n>` and fails if any named asset is not
# served, so a caller asserts on one line.
served_bundle() {
  local document asset count=0 bundle=v1
  document="$(edge_get / || true)"
  case "$document" in
    *'<div id="root">'*) : ;;
    *) fail "the edge is not serving the Web Admin at all" ;;
  esac
  case "$document" in
    *'smoke-v2.js'*) bundle=v2 ;;
  esac
  for asset in $(printf '%s' "$document" | grep -oE '/assets/[A-Za-z0-9._-]+' | sort -u); do
    edge_serves "$asset" ||
      fail "the document names ${asset} and the edge does not serve it"
    count=$((count + 1))
  done
  [ "$count" -gt 0 ] || fail "the served document names no hashed assets"
  printf 'bundle=%s assets=%s\n' "$bundle" "$count"
}

cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f nexa-smoke-registry >/dev/null 2>&1 || true
  rm -rf "$ROOT"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
step "a local registry, so digests are real"
# ---------------------------------------------------------------------------
# Without a registry there is no digest to resolve, and `botctl update` would
# be tested against something other than what it does in production.
docker rm -f nexa-smoke-registry >/dev/null 2>&1 || true
docker run -d --name nexa-smoke-registry -p "127.0.0.1:${REGISTRY_PORT}:5000" \
  registry:2 >/dev/null || fail "the local registry did not start"
for _ in $(seq 1 30); do
  curl -fsS "http://${REGISTRY}/v2/" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://${REGISTRY}/v2/" >/dev/null || fail "the local registry never answered"
pass "a local registry is running"

# ---------------------------------------------------------------------------
step "three releases: A, B, and one that never becomes ready"
# ---------------------------------------------------------------------------
COMMIT="$(git rev-parse HEAD)"
build_release() {
  local version="$1"
  docker build \
    --build-arg "BUILD_VERSION=${version}" \
    --build-arg "BUILD_COMMIT=${COMMIT}" \
    --build-arg "BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    -t "${IMAGE_REPO}:${version}" . >/dev/null || fail "building ${version} failed"
  docker push --quiet "${IMAGE_REPO}:${version}" >/dev/null || fail "pushing ${version} failed"
}
build_release v1.0.0
build_release v2.0.0

# --- Two DIFFERENT edge configurations, which is the whole point ------------
#
# The releases this script built before this point shipped byte-identical Caddy
# configuration, because they are two builds of one commit. So the transition
# between them never changed the edge, and the defect that needs catching — the
# edge NOT adopting the target release's configuration — could not arise. The
# suite was green through the entire staging incident.
#
# v1.0.0 is given the OLD shape, which is what the real staging.9 had:
#
#   * `/assets/*` rooted at the activated release rather than at the pool. That
#     works for a release's own assets and is exactly what breaks across a
#     deployment — which is why the pool exists.
#   * a marker header naming the release, so `edge_config_marker` can say WHICH
#     configuration is loaded rather than only that two differ.
#
# v2.0.0 keeps the shipped routing and gets its own marker. Both configurations
# are functional: a test where the old one is broken would prove that a broken
# edge is noticed, which is not the question.
OLD_ROUTES="${ROOT}/routes.v1.caddy"
NEW_ROUTES="${ROOT}/routes.v2.caddy"
marked_routes() {
  local version="$1" destination="$2"
  cp deploy/caddy/routes.caddy "$destination"
  # The marker, on every response from the snippet.
  python3 - "$destination" "$version" <<'PY'
import sys
path, version = sys.argv[1], sys.argv[2]
text = open(path, encoding='utf-8').read()
needle = '(nexa_routes) {\n\tencode zstd gzip\n'
assert text.count(needle) == 1, 'the routes snippet does not open the way this expects'
text = text.replace(
    needle,
    '(nexa_routes) {\n\tencode zstd gzip\n\theader X-Nexa-Edge "%s"\n' % version,
)
open(path, 'w', encoding='utf-8').write(text)
PY
}
marked_routes v1.0.0 "$OLD_ROUTES"
marked_routes v2.0.0 "$NEW_ROUTES"
# v1.0.0's asset root: the activated release, not the pool. One line, and it is
# the real difference between staging.9 and staging.11.
python3 - "$OLD_ROUTES" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
assert text.count('\t\troot * /srv/web/pool\n') == 1, 'the asset root is not where this expects'
text = text.replace('\t\troot * /srv/web/pool\n', '\t\troot * /srv/web/current\n')
open(path, 'w', encoding='utf-8').write(text)
PY
grep -q 'X-Nexa-Edge "v1.0.0"' "$OLD_ROUTES" || fail "v1.0.0's routes were not marked"
grep -q 'X-Nexa-Edge "v2.0.0"' "$NEW_ROUTES" || fail "v2.0.0's routes were not marked"
grep -q 'root \* /srv/web/pool' "$NEW_ROUTES" || fail "v2.0.0's routes lost the pool"
grep -q 'root \* /srv/web/pool' "$OLD_ROUTES" && fail "v1.0.0's routes still use the pool"
# Baked into each image, so a ROLLBACK recovers v1.0.0's configuration from
# v1.0.0's own immutable image — which is where botctl gets it.
bake_routes() {
  local version="$1" routes="$2"
  docker build -t "${IMAGE_REPO}:${version}" -f - "$(dirname "$routes")" >/dev/null <<DOCKERFILE || fail "baking ${version}'s routes failed"
FROM ${IMAGE_REPO}:${version}
USER root
COPY $(basename "$routes") /app/deploy/caddy/routes.caddy
RUN grep -q 'X-Nexa-Edge' /app/deploy/caddy/routes.caddy
USER node
DOCKERFILE
  docker push --quiet "${IMAGE_REPO}:${version}" >/dev/null || fail "pushing ${version} failed"
}
bake_routes v1.0.0 "$OLD_ROUTES"
bake_routes v2.0.0 "$NEW_ROUTES"
pass "v1.0.0 and v2.0.0 carry DIFFERENT edge configurations"

# A release whose application is perfect and whose EDGE CONFIGURATION cannot be
# served. Derived from v2.0.0 so the api, the worker, the monitor and the
# migrator are byte-identical — the only thing wrong with it is a routes file
# Caddy will not parse.
#
# This is the injected edge failure. It has to back out for the same reason the
# unready release does: an update that cannot put the target's routing in force
# has not updated the installation, whatever the containers report. And it is a
# different branch from v3.0.0-broken, where the API is what fails.
BAD_ROUTES="${ROOT}/routes.bad.caddy"
cp "$NEW_ROUTES" "$BAD_ROUTES"
printf '%s\n' 'this is not a caddy directive {' >>"$BAD_ROUTES"
docker build -t "${IMAGE_REPO}:v5.0.0-badedge" -f - "$ROOT" >/dev/null <<DOCKERFILE || fail "building the bad-edge release failed"
FROM ${IMAGE_REPO}:v2.0.0
USER root
COPY routes.bad.caddy /app/deploy/caddy/routes.caddy
USER node
DOCKERFILE
docker push --quiet "${IMAGE_REPO}:v5.0.0-badedge" >/dev/null ||
  fail "pushing the bad-edge release failed"
pass "v5.0.0-badedge carries an edge configuration Caddy cannot load"

# v2.0.0's HOST ASSETS have to differ from v1.0.0's, or "the update installed
# the target release's botctl" is unfalsifiable: two builds of the same commit
# ship byte-identical ones, and the check would pass without the update having
# moved anything. One appended comment is enough to tell them apart, and leaves
# the script itself working.
#
# Its WEB BUNDLE has to differ for the same reason, and it is a separate mark:
# the asset publisher names a release after the bundle's own content, so two
# releases shipping byte-identical bundles publish to ONE release directory.
# Every assertion below about which bundle the edge is serving would then hold
# no matter what the publisher, the symlink or the rollback did.
docker build -t "${IMAGE_REPO}:v2.0.0" -f - . >/dev/null <<DOCKERFILE || fail "marking v2.0.0's host assets failed"
FROM ${IMAGE_REPO}:v2.0.0
USER root
RUN printf '%s\n' '# nexa-smoke: v2.0.0 host assets' >> /app/deploy/bin/botctl
RUN set -e; \
    mkdir -p /app/web/assets; \
    printf '%s\n' 'globalThis.NEXA_SMOKE_BUNDLE = "v2.0.0";' > /app/web/assets/smoke-v2.js; \
    sed -i 's|</head>|<script type="module" src="/assets/smoke-v2.js"></script></head>|' /app/web/index.html; \
    grep -q 'smoke-v2.js' /app/web/index.html
USER node
DOCKERFILE
docker push --quiet "${IMAGE_REPO}:v2.0.0" >/dev/null || fail "pushing the marked v2.0.0 failed"

# A release that starts and never passes its readiness probe. Derived from a
# real one so everything else about it is identical: same layers, same
# entrypoints, same migrator. Only the API's answer changes.
#
# This is the case a smoke test usually cannot reach, and the one where an
# updater is most likely to be wrong: the container is running, so anything
# that checks "did it start" says yes.
docker build -t "${IMAGE_REPO}:v3.0.0-broken" -f - . >/dev/null <<DOCKERFILE || fail "building the broken release failed"
FROM ${IMAGE_REPO}:v2.0.0
USER root
RUN printf '%s\n' \
  "import { createServer } from 'node:http';" \
  "createServer((_req, res) => { res.statusCode = 503; res.end('not ready'); }).listen(3000);" \
  > /app/dist/main.js
USER node
DOCKERFILE
docker push --quiet "${IMAGE_REPO}:v3.0.0-broken" >/dev/null || fail "pushing the broken release failed"

# A release whose API and worker are perfect and whose MONITOR never becomes
# healthy. Same layers, same migrator, same everything else — only the monitor
# entrypoint changes, to a process that idles for ever and writes no heartbeat.
#
# This is the Phase 3C shape of the same trap: the containers all start, the
# API answers every request correctly, and the one thing that stops is panel
# health being written. An operator then reads a health frozen at whatever it
# last was, with nothing in the response to say so. If readiness did not
# require the monitor, this release would go current and nothing would notice.
docker build -t "${IMAGE_REPO}:v4.0.0-nomonitor" -f - . >/dev/null <<DOCKERFILE || fail "building the monitor-less release failed"
FROM ${IMAGE_REPO}:v2.0.0
USER root
RUN printf '%s\n' "setInterval(() => {}, 60000);" > /app/dist/main.monitor.js
USER node
DOCKERFILE
docker push --quiet "${IMAGE_REPO}:v4.0.0-nomonitor" >/dev/null ||
  fail "pushing the monitor-less release failed"
pass "v1.0.0, v2.0.0, an unready v3.0.0-broken and a monitor-dead v4.0.0-nomonitor are published"

# ---------------------------------------------------------------------------
step "install at v1.0.0"
# ---------------------------------------------------------------------------
install -d -m 0700 "$NEXA_CONFIG_DIR"
install -d -m 0755 "$NEXA_DEPLOY_DIR" "${NEXA_DEPLOY_DIR}/caddy" "$NEXA_LIB_DIR" "$NEXA_BIN_DIR"
install -d -m 0750 "$NEXA_STATE_DIR" "${NEXA_STATE_DIR}/releases"
install -d -m 0700 "$NEXA_BACKUP_DIR"
install -m 0644 deploy/compose.yml "${NEXA_DEPLOY_DIR}/compose.yml"
install -m 0644 deploy/caddy/Caddyfile deploy/caddy/Caddyfile.ci "${NEXA_DEPLOY_DIR}/caddy/"
# v1.0.0's OWN routes, which are not the repository's. An installation runs one
# release's tooling, and this one is installed at v1.0.0 — so the edge
# configuration on the host has to be v1.0.0's, or the update below would start
# from an inconsistency rather than from a working installation.
install -m 0644 "$OLD_ROUTES" "${NEXA_DEPLOY_DIR}/caddy/routes.caddy"
# The rest of the host-asset set, exactly as `install.sh` lays it down. Without
# it there is nothing for the update to capture under v1.0.0, and nothing for
# the rollback to put back.
install -m 0644 deploy/nexa.env.template "${NEXA_DEPLOY_DIR}/nexa.env.template"
install -m 0644 deploy/bin/nexa-lib.sh "${NEXA_LIB_DIR}/nexa-lib.sh"
install -m 0755 deploy/bin/botctl "${NEXA_BIN_DIR}/botctl"

PG_PASSWORD="$(head -c 24 /dev/urandom | base64 -w0 | tr -d '=+/' | cut -c1-32)"
REDIS_PASSWORD="$(head -c 24 /dev/urandom | base64 -w0 | tr -d '=+/' | cut -c1-32)"
umask 077
printf 'POSTGRES_USER=nexa\nPOSTGRES_DB=nexa\nPOSTGRES_PASSWORD=%s\n' "$PG_PASSWORD" \
  >"${NEXA_CONFIG_DIR}/postgres.env"
printf 'REDIS_PASSWORD=%s\n' "$REDIS_PASSWORD" >"${NEXA_CONFIG_DIR}/redis.env"
python3 -c '
import sys
text = open(sys.argv[1], "r", encoding="utf-8").read()
for pair in sys.argv[3:]:
    token, value = pair.split("=", 1)
    text = text.replace(token, value)
open(sys.argv[2], "w", encoding="utf-8").write(text)
' deploy/nexa.env.template "${NEXA_CONFIG_DIR}/nexa.env" \
  "__POSTGRES_PASSWORD__=${PG_PASSWORD}" \
  "__REDIS_PASSWORD__=${REDIS_PASSWORD}" \
  "__SECRETS_KEK__=$(head -c 32 /dev/urandom | base64 -w0)" \
  "__SECRETS_ACTIVE_KEY_ID__=smoke-1" \
  "__DOMAIN__=localhost" \
  "__EDGE_SUBNET__=172.29.0.0/24" \
  "__TELEGRAM_WEBHOOK_SECRET__=smoke-webhook-secret-not-a-real-one"
sed -i 's|^WEB_ADMIN_ORIGINS=.*|WEB_ADMIN_ORIGINS=https://localhost|' "${NEXA_CONFIG_DIR}/nexa.env"
# An nexa.env that predates the policy: no data-subnet key of any kind.
sed -i '/^PANEL_HTTP_DENIED_SUBNETS=/d; /^NEXA_DATA_SUBNET=/d' "${NEXA_CONFIG_DIR}/nexa.env"

DIGEST_A="$(docker buildx imagetools inspect "${IMAGE_REPO}:v1.0.0" --format '{{.Manifest.Digest}}')"
{
  printf 'NEXA_IMAGE=%s@%s\n' "$IMAGE_REPO" "$DIGEST_A"
  printf 'NEXA_DOMAIN=localhost\n'
  printf 'NEXA_ACME_EMAIL=ci@localhost\n'
  printf 'NEXA_CONFIG_DIR=%s\n' "$NEXA_CONFIG_DIR"
  printf 'NEXA_DEPLOY_DIR=%s\n' "$NEXA_DEPLOY_DIR"
  printf 'NEXA_EDGE_SUBNET=172.29.0.0/24\n'
  # NOT the default. The installation's data network must be refused by the
  # panel HTTP policy because deploy.env names it — the real staging host had
  # no PANEL_HTTP_DENIED_SUBNETS in its upgraded nexa.env and was protected
  # only because its subnet happened to equal the application's default.
  printf 'NEXA_DATA_SUBNET=172.31.44.0/24\n'
  printf 'NEXA_CI_HTTP_PORT=%s\n' "$HTTP_PORT"
  # The edge generation, as `install.sh` records it. Computed by the library
  # itself rather than restated here, so the value this installation starts
  # from is the one botctl will compare against.
  printf 'NEXA_EDGE_CONFIG=%s\n' "$(
    NEXA_DEPLOY_DIR="$NEXA_DEPLOY_DIR" bash -c ". \"${NEXA_LIB}\"; nexa_edge_config_fingerprint"
  )"
} >"${NEXA_CONFIG_DIR}/deploy.env"
umask 022

compose up -d postgres redis >/dev/null || fail "the data services did not start"
waited=0
# `awk '$2 == "healthy"'`, not `grep -c healthy`: "healthy" is a SUBSTRING of
# "unhealthy", so the count reached two the moment BOTH services were reporting
# unhealthy — and this loop then exited and migrated against them.
until [ "$(compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null |
  awk '$2 == "healthy" { n += 1 } END { print n + 0 }')" -ge 2 ]; do
  [ "$waited" -lt 120 ] || fail "the data services never became healthy"
  sleep 3
  waited=$((waited + 3))
done
compose run --rm --no-deps --entrypoint node api \
  dist/infrastructure/persistence/migrate.js >/dev/null || fail "the initial migration failed"
compose run --rm --no-deps --entrypoint node api \
  dist/provision-installation.cli.js --slug smoke --display-name Smoke >/dev/null ||
  fail "provisioning failed"
compose up -d --remove-orphans >/dev/null || fail "the stack did not start"

python3 -c '
import json, sys
json.dump({"version": "v1.0.0", "commit": sys.argv[2], "digest": sys.argv[3],
           "image": sys.argv[4] + "@" + sys.argv[3], "recordedAt": "smoke"},
          open(sys.argv[1], "w"))
' "${NEXA_STATE_DIR}/releases/v1.0.0.json" "$COMMIT" "$DIGEST_A" "$IMAGE_REPO"
printf 'v1.0.0\n' >"${NEXA_STATE_DIR}/current"

# A bounded WAIT, not a single probe.
#
# `botctl status` uses a deliberately quick five-second readiness check — a
# status command that hangs is one nobody runs while something is wrong — and
# the stack has only just been started here. The three application containers
# come healthy at their own pace: the api answers `/health/ready` at once, and
# the worker and the monitor are judged on a heartbeat file their container
# checks read on a ten-second interval. Asserting readiness on the first probe
# was asserting that every check had already fired.
waited=0
until "$BOTCTL" status >/dev/null 2>&1; do
  [ "$waited" -lt 180 ] || {
    "$BOTCTL" status || true
    compose ps || true
    fail "the installation never became ready at v1.0.0"
  }
  sleep 3
  waited=$((waited + 3))
done
pass "installed and ready at v1.0.0"

step "the edge serves v1.0.0's bundle, coherently"
serving="$(served_bundle)"
case "$serving" in
  'bundle=v1 '*) : ;;
  *) fail "a fresh install at v1.0.0 serves ${serving}" ;;
esac
pass "the edge serves v1.0.0's document and every asset it names (${serving})"

step "the edge is running v1.0.0's own configuration"
EDGE_MARKER_V1="$(edge_config_marker)"
[ "$EDGE_MARKER_V1" = "v1.0.0" ] ||
  fail "the edge reports configuration [${EDGE_MARKER_V1}] at a fresh v1.0.0 install"
pass "the edge answers with X-Nexa-Edge: ${EDGE_MARKER_V1}"

# The assets v1.0.0's document names, captured NOW. They are re-fetched after
# the update below: a browser that has the old document and has not asked for
# its scripts yet is what every page load open at the moment of a deployment
# looks like, and rooting /assets/* at the activated release turns all of them
# into 404s.
V1_ASSETS="$(edge_get / | grep -oE '/assets/[A-Za-z0-9._-]+' | sort -u)"
[ -n "$V1_ASSETS" ] || fail "v1.0.0's document names no hashed assets"

# Something to notice if a rollback ever restored the database. A routine
# rollback must leave this row exactly where it is.
compose exec -T postgres psql -U nexa -d nexa -q -c \
  "CREATE TABLE IF NOT EXISTS smoke_marker (note text); INSERT INTO smoke_marker VALUES ('written-under-v1');" \
  >/dev/null || fail "could not write the marker row"

# ---------------------------------------------------------------------------
step "update v1.0.0 -> v2.0.0"
# ---------------------------------------------------------------------------
BOTCTL_OWNER_BEFORE="$(stat -c '%U:%G' "${NEXA_BIN_DIR}/botctl")"
BOTCTL_INODE_BEFORE="$(stat -c '%i' "${NEXA_BIN_DIR}/botctl")"
"$BOTCTL" update v2.0.0 || fail "the update to v2.0.0 failed"
[ "$(cat "${NEXA_STATE_DIR}/current")" = "v2.0.0" ] || fail "v2.0.0 did not become current"
[ "$(cat "${NEXA_STATE_DIR}/previous")" = "v1.0.0" ] || fail "v1.0.0 is not the rollback target"
[ -f "${NEXA_STATE_DIR}/releases/v1.0.0.json" ] ||
  fail "the update deleted the release it replaced"
# Counted, not `| grep -q`: a `grep -q` that matches exits at once and `find`
# dies of SIGPIPE, so under `pipefail` the check fails exactly when it passes.
backups="$(find "$NEXA_BACKUP_DIR" -name '*.sql.gz' | wc -l)"
[ "${backups:-0}" -gt 0 ] || fail "the update did not take a backup"

DIGEST_B="$(docker buildx imagetools inspect "${IMAGE_REPO}:v2.0.0" --format '{{.Manifest.Digest}}')"
grep -qF "NEXA_IMAGE=${IMAGE_REPO}@${DIGEST_B}" "${NEXA_CONFIG_DIR}/deploy.env" ||
  fail "deploy.env does not name v2.0.0's digest; the release would not survive a reboot"
# The manifest is what makes the three release facts survive the update. The
# installer writes one; for a long time the UPDATER did not, and this is where
# that showed up — `botctl version` reporting a version with `unknown` for the
# commit and the digest, on an installation that was running perfectly.
[ -f "${NEXA_STATE_DIR}/releases/v2.0.0.json" ] ||
  fail "the update activated v2.0.0 without recording a release manifest for it"
version_output="$("$BOTCTL" version)"
case "$version_output" in
  *"$DIGEST_B"*) : ;;
  *) fail "botctl version does not report the new digest" ;;
esac
case "$version_output" in
  *unknown*) fail "botctl version reports an unknown fact about a release it just installed" ;;
esac
# The host assets move with the release. This is the real-host defect: an
# installation reporting v0.1.0-staging.5 from `botctl version` while
# `botctl secrets status` answered `unknown command "secrets"`, because the
# update moved the image and left /usr/local/bin/botctl alone.
grep -qF '# nexa-smoke: v2.0.0 host assets' "${NEXA_BIN_DIR}/botctl" ||
  fail "the update did not install v2.0.0's botctl; the host is running v2.0.0 with v1.0.0's tooling"
[ "$(stat -c '%a' "${NEXA_BIN_DIR}/botctl")" = "755" ] ||
  fail "the installed botctl is not executable after the update"
[ "$(stat -c '%U:%G' "${NEXA_BIN_DIR}/botctl")" = "$BOTCTL_OWNER_BEFORE" ] ||
  fail "the installed botctl changed owner during the update"
[ "$(stat -c '%i' "${NEXA_BIN_DIR}/botctl")" != "$BOTCTL_INODE_BEFORE" ] ||
  fail "the installed botctl kept its inode; it was written in place rather than renamed over"
[ -s "${NEXA_LIB_DIR}/nexa-lib.sh" ] || fail "the update left no library beside the botctl it installed"
[ -s "${NEXA_DEPLOY_DIR}/compose.yml" ] || fail "the update left no compose file"
# What was replaced is recoverable: the outgoing release's set was recorded —
# under the DIGEST it runs, never the version (C9). A version-keyed directory
# would be the moved-tag bug coming back.
[ -s "${NEXA_STATE_DIR}/assets/${DIGEST_A#sha256:}/bin/botctl" ] ||
  fail "the update replaced the host assets without recording the ones it replaced under their digest"
[ ! -e "${NEXA_STATE_DIR}/assets/v1.0.0" ] && [ ! -e "${NEXA_STATE_DIR}/assets/v2.0.0" ] ||
  fail "the update keyed a host-asset set by version rather than by digest"
[ ! -e "${NEXA_STATE_DIR}/assets/.activating" ] ||
  fail "the update left an activation generation behind after succeeding"
pass "v2.0.0 is current, by digest, with v1.0.0 preserved as the rollback target"
pass "the host assets are v2.0.0's, and v1.0.0's were recorded"

# ---------------------------------------------------------------------------
step "the update published v2.0.0's bundle atomically"
# ---------------------------------------------------------------------------
# The publisher that shipped before this check emptied the directory Caddy was
# serving and then copied into it, so every update had a window where the edge
# answered 404 for index.html and then served an index.html naming assets that
# were not there yet. Three things are asserted, and each fails differently:
serving="$(served_bundle)"
case "$serving" in
  'bundle=v2 '*) : ;;
  *) fail "after the update the edge still serves ${serving}" ;;
esac

# --- The edge adopted v2.0.0's CONFIGURATION, not merely its bundle ---------
#
# This is the assertion the staging incident needed and nobody had. Everything
# above it was true on that host: the new release recorded, the new bundle
# published, every container healthy, readiness passing. What was false is this
# line, and there was no command that would have said so.
#
# Read through the edge, from a response, because that is what a browser gets. A
# container being HEALTHY is not evidence: v1.0.0's configuration answers `/` with
# a 200 and passes the healthcheck perfectly while serving the wrong thing.
EDGE_MARKER_V2="$(edge_config_marker)"
[ "$EDGE_MARKER_V2" = "v2.0.0" ] ||
  fail "the update reported success and the edge is still running configuration [${EDGE_MARKER_V2}]; a browser is being served v1.0.0's routing by a server that reports v2.0.0"
[ "$EDGE_MARKER_V2" != "$EDGE_MARKER_V1" ] ||
  fail "the edge configuration did not change across the update, so this check proves nothing"
# And the generation botctl recorded agrees with what is running. deploy.env is
# what the next `compose up` would start from, so a disagreement here is the
# defect waiting for the next reboot.
grep -q '^NEXA_EDGE_CONFIG=sha256:' "${NEXA_CONFIG_DIR}/deploy.env" ||
  fail "the update did not record an edge configuration generation in deploy.env"
EDGE_RUNNING="$(docker inspect "$(compose ps -q caddy)" \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^NEXA_EDGE_CONFIG=//p' | sed -n '1p')"
EDGE_RECORDED="$(sed -n 's/^NEXA_EDGE_CONFIG=//p' "${NEXA_CONFIG_DIR}/deploy.env" | sed -n '1p')"
[ -n "$EDGE_RUNNING" ] || fail "the running edge carries no configuration generation"
[ "$EDGE_RUNNING" = "$EDGE_RECORDED" ] ||
  fail "the running edge was created for ${EDGE_RUNNING} and deploy.env records ${EDGE_RECORDED}"
# The POOL is what the new configuration added, and it is what the old one did
# not have. A document fetched before the deployment names assets that only the
# pool can still serve, and the loop below already re-fetches them — this states
# the dependency so a reader knows why the two checks are next to each other.
pass "the edge runs v2.0.0's configuration (X-Nexa-Edge: ${EDGE_MARKER_V2}, generation ${EDGE_RECORDED#sha256:})"
pass "the edge serves v2.0.0's document and every asset it names (${serving})"

#   1. `current` is a SYMLINK into releases/. A directory of the same name
#      serves the same bytes and cannot be swapped atomically.
activated="$(compose exec -T caddy readlink /srv/web/current 2>&1 || true)"
case "$activated" in
  releases/*) : ;;
  *) fail "/srv/web/current is not a symlink into releases/ (got: ${activated})" ;;
esac
#   2. Both releases are on disk. The one just replaced is retained on purpose:
#      a request that resolved `current` a moment before the swap may still be
#      reading a file out of it, and a rollback re-activates it without copying.
kept="$(compose exec -T caddy sh -c 'ls -1 /srv/web/releases | wc -l' 2>&1 || true)"
[ "$(printf '%s' "$kept" | tr -d '[:space:]')" = "2" ] ||
  fail "the volume holds ${kept} release directories after one update; it must hold two"
#   3. The pool still carries v1.0.0's assets. This is the case the symlink
#      alone does not cover: a browser that fetched v1.0.0's document a
#      millisecond before the swap asks for its scripts a millisecond after it.
#      Counted exactly against the union over the retained releases, not
#      against a floor: a pool pruned back to the incoming release alone still
#      holds more files than any threshold worth writing, and that is precisely
#      the regression.
counts="$(compose exec -T caddy sh -c \
  'ls -1 /srv/web/pool/assets | wc -l;
   find /srv/web/releases -mindepth 3 -path "*/assets/*" -type f | sed "s|.*/||" | sort -u | wc -l' \
  2>&1 || true)"
pooled="$(printf '%s\n' "$counts" | sed -n 1p | tr -d '[:space:]')"
union="$(printf '%s\n' "$counts" | sed -n 2p | tr -d '[:space:]')"
[ -n "$union" ] && [ "${union:-0}" -gt 0 ] 2>/dev/null ||
  fail "could not count the retained releases' assets (got: ${counts})"
[ "$pooled" = "$union" ] ||
  fail "the pool holds ${pooled} assets and the retained releases own ${union}; it must hold their union"
pass "current is a symlink, both releases are retained, and the pool spans them (${pooled} assets)"

# The captured request, replayed after the swap. This is the assertion the
# pool exists for, and the one a symlink swap alone does not satisfy.
for asset in $V1_ASSETS; do
  edge_serves "$asset" ||
    fail "${asset}, named by the document served before the update, is not served after it"
done
pass "a document fetched before the update can still load every asset it names"

# ---------------------------------------------------------------------------
step "the upgraded installation refuses its own data network, from compose, not from nexa.env"
# ---------------------------------------------------------------------------
# Inside the RUNNING api container, with the environment compose actually
# gave it, through the same function the process built its policy from. The
# nexa.env above has no subnet key at all, and the subnet is not the default.
policy="$(compose exec -T api node --input-type=module -e '
const { loadConfig } = await import("/app/dist/infrastructure/config/load-config.js");
const { panelUrlPolicy } = await import("/app/dist/infrastructure/net/installation-policy.js");
const { checkUrl } = await import("/app/dist/infrastructure/net/url-policy.js");
const config = loadConfig();
const policy = panelUrlPolicy(config);
const say = (name, url) => console.log(name + "=" + (checkUrl(url, policy).allowed ? "allowed" : "denied"));
console.log("subnet=" + (config.NEXA_DATA_SUBNET ?? "unset"));
console.log("extras=" + config.PANEL_HTTP_DENIED_SUBNETS.join(","));
say("data", "https://172.31.44.7:5432");
say("data-other-host", "https://172.31.44.200:2053");
say("postgres-by-name", "https://postgres:5432");
say("redis-by-name", "https://redis:6379");
say("private-panel", "https://10.20.30.40:2053");
say("default-subnet-not-special", "https://172.29.1.5:8443");
say("public-panel", "https://panel.example.com:2096");
' 2>&1)" || fail "the policy could not be read inside the api container: ${policy}"
printf '%s\n' "$policy" | sed 's/^/    /'
grep -qx 'subnet=172.31.44.0/24' <<<"$policy" || fail "the runtime did not receive the installation subnet from compose"
grep -qx 'extras=' <<<"$policy" || fail "the upgraded nexa.env unexpectedly carries extra denied subnets"
grep -qx 'data=denied' <<<"$policy" || fail "the installation's own data network is NOT denied on the upgraded host"
grep -qx 'data-other-host=denied' <<<"$policy" || fail "another address in the data network is not denied"
grep -qx 'postgres-by-name=denied' <<<"$policy" || fail "the database hostname is not denied"
grep -qx 'redis-by-name=denied' <<<"$policy" || fail "the cache hostname is not denied"
grep -qx 'private-panel=allowed' <<<"$policy" || fail "a legitimate private panel is refused: private support was broken"
grep -qx 'default-subnet-not-special=allowed' <<<"$policy" || fail "the application default subnet is still hardcoded as the security property"
grep -qx 'public-panel=allowed' <<<"$policy" || fail "a public panel is refused"
pass "the upgraded installation denies 172.31.44.0/24 because deploy.env names it, and nothing else"

# ---------------------------------------------------------------------------
step "a release that never becomes ready must not become current"
# ---------------------------------------------------------------------------
# The container starts. Anything that checks "did it start" says yes. Only a
# real readiness check catches this, and the update must put v2.0.0 back.
if "$BOTCTL" update v3.0.0-broken; then
  fail "an update to a release that never becomes ready reported success"
fi
[ "$(cat "${NEXA_STATE_DIR}/current")" = "v2.0.0" ] ||
  fail "a release that never became ready became current"
grep -qF "NEXA_IMAGE=${IMAGE_REPO}@${DIGEST_B}" "${NEXA_CONFIG_DIR}/deploy.env" ||
  fail "deploy.env was repointed at a release that never became ready"

waited=0
until "$BOTCTL" status >/dev/null 2>&1; do
  [ "$waited" -lt 120 ] || fail "v2.0.0 did not come back after the failed update"
  sleep 3
  waited=$((waited + 3))
done
pass "the failed release did not become current, and v2.0.0 came back"

serving="$(served_bundle)"
case "$serving" in
  'bundle=v2 '*) : ;;
  *) fail "after a failed update the edge serves ${serving}, not the release that came back" ;;
esac
pass "a failed update leaves v2.0.0's bundle activated and complete (${serving})"

# ---------------------------------------------------------------------------
step "a release whose monitor never becomes healthy must not become current"
# ---------------------------------------------------------------------------
# The api and the worker of this release are byte-identical to v2.0.0's, so
# every previous check in this script would pass on it. What is broken is the
# third process role, and the only thing that can catch it is readiness
# requiring the monitor.
if "$BOTCTL" update v4.0.0-nomonitor; then
  fail "an update to a release whose monitor never becomes healthy reported success"
fi
[ "$(cat "${NEXA_STATE_DIR}/current")" = "v2.0.0" ] ||
  fail "a release with a dead monitor became current"
grep -qF "NEXA_IMAGE=${IMAGE_REPO}@${DIGEST_B}" "${NEXA_CONFIG_DIR}/deploy.env" ||
  fail "deploy.env was repointed at a release whose monitor never became healthy"

waited=0
until "$BOTCTL" status >/dev/null 2>&1; do
  [ "$waited" -lt 120 ] || fail "v2.0.0 did not come back after the monitor-less update"
  sleep 3
  waited=$((waited + 3))
done
pass "a dead monitor backs the release out, and v2.0.0 came back"

# ---------------------------------------------------------------------------
step "a release whose edge configuration cannot be served must not become current"
# ---------------------------------------------------------------------------
# The application half of this release is byte-identical to v2.0.0, so every
# check in this script that looks at the api, the worker, the monitor or the
# migration passes on it. What it cannot do is serve the edge — and an
# installation whose edge cannot serve is one nobody can reach, however healthy
# its containers are.
#
# The host assets are REPLACED before the start, so this also exercises the
# back-out putting the outgoing release's Caddy configuration back.
if "$BOTCTL" update v5.0.0-badedge; then
  fail "an update whose edge configuration cannot be served reported success"
fi
[ "$(cat "${NEXA_STATE_DIR}/current")" = "v2.0.0" ] ||
  fail "a release whose edge cannot serve became current"
grep -qF "NEXA_IMAGE=${IMAGE_REPO}@${DIGEST_B}" "${NEXA_CONFIG_DIR}/deploy.env" ||
  fail "deploy.env was repointed at a release whose edge cannot serve"
# v2.0.0's routes are back on the host. A back-out that left the broken file
# there would leave an installation that cannot be restarted.
grep -q 'X-Nexa-Edge "v2.0.0"' "${NEXA_DEPLOY_DIR}/caddy/routes.caddy" ||
  fail "the back-out did not restore v2.0.0's edge configuration to the host"

waited=0
until "$BOTCTL" status >/dev/null 2>&1; do
  [ "$waited" -lt 180 ] || {
    "$BOTCTL" status || true
    fail "v2.0.0 did not come back after the bad-edge update"
  }
  sleep 3
  waited=$((waited + 3))
done
# And the edge is serving v2.0.0's configuration again, read from a response.
EDGE_MARKER_AFTER_BAD="$(edge_config_marker)"
[ "$EDGE_MARKER_AFTER_BAD" = "v2.0.0" ] ||
  fail "after the bad-edge back-out the edge reports configuration [${EDGE_MARKER_AFTER_BAD}]"
serving="$(served_bundle)"
case "$serving" in
  'bundle=v2 '*) : ;;
  *) fail "after the bad-edge back-out the edge serves ${serving}" ;;
esac
pass "a broken edge configuration backs the release out, and v2.0.0's edge came back"

# ---------------------------------------------------------------------------
step "rollback v2.0.0 -> v1.0.0"
# ---------------------------------------------------------------------------
"$BOTCTL" rollback || fail "the rollback failed"
[ "$(cat "${NEXA_STATE_DIR}/current")" = "v1.0.0" ] || fail "the rollback did not return to v1.0.0"
[ "$(cat "${NEXA_STATE_DIR}/previous")" = "v2.0.0" ] || fail "the rollback is not itself undoable"
grep -qF "NEXA_IMAGE=${IMAGE_REPO}@${DIGEST_A}" "${NEXA_CONFIG_DIR}/deploy.env" ||
  fail "deploy.env does not name v1.0.0's digest after the rollback"

# THE assertion. The backup predates the migration, so a rollback that restored
# it would discard every write made since — an outage turned into data loss by
# the tool meant to fix it.
marker="$(compose exec -T postgres psql -U nexa -d nexa -tAc "SELECT note FROM smoke_marker" 2>/dev/null || true)"
[ "$(printf '%s' "$marker" | tr -d '[:space:]')" = "written-under-v1" ] ||
  fail "the rollback lost data written before it; it must not restore the database"
# The tooling rolls back with the application. Leaving v2.0.0's botctl and
# compose file operating v1.0.0's image would be a compatibility contract, and
# nothing here proves one.
if grep -qF '# nexa-smoke: v2.0.0 host assets' "${NEXA_BIN_DIR}/botctl"; then
  fail "the rollback left v2.0.0's botctl operating v1.0.0's image"
fi
pass "the rollback returned to v1.0.0 and left the database untouched"
pass "the rollback returned the host assets to v1.0.0 too"

serving="$(served_bundle)"
case "$serving" in
  'bundle=v1 '*) : ;;
  *) fail "after the rollback the edge serves ${serving}" ;;
esac
# v1.0.0's release directory was never deleted by the update that replaced it,
# so the rollback re-ACTIVATED it rather than copying it back — which is why
# there is nothing here that could have been half restored.
activated="$(compose exec -T caddy readlink /srv/web/current 2>&1 || true)"
case "$activated" in
  releases/*) : ;;
  *) fail "/srv/web/current is not a symlink into releases/ after the rollback (got: ${activated})" ;;
esac
pass "the rollback serves v1.0.0's bundle, coherently (${serving})"

# --- And the edge rolled back too ------------------------------------------
#
# The same defect pointing the other way, and the worse one to ship: the
# application downgraded while the edge keeps serving the newer release's
# routing. A rollback exists to get an installation back to something that
# worked, and "v1.0.0's application behind v2.0.0's routes" is a state that
# never worked and was never tested.
EDGE_MARKER_BACK="$(edge_config_marker)"
[ "$EDGE_MARKER_BACK" = "v1.0.0" ] ||
  fail "the rollback returned the application to v1.0.0 and left the edge running configuration [${EDGE_MARKER_BACK}]"
EDGE_RECORDED_BACK="$(sed -n 's/^NEXA_EDGE_CONFIG=//p' "${NEXA_CONFIG_DIR}/deploy.env" | sed -n '1p')"
EDGE_RUNNING_BACK="$(docker inspect "$(compose ps -q caddy)" \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^NEXA_EDGE_CONFIG=//p' | sed -n '1p')"
[ "$EDGE_RUNNING_BACK" = "$EDGE_RECORDED_BACK" ] ||
  fail "after the rollback the running edge is ${EDGE_RUNNING_BACK} and deploy.env records ${EDGE_RECORDED_BACK}"
[ "$EDGE_RECORDED_BACK" != "$EDGE_RECORDED" ] ||
  fail "the rollback left the edge generation at v2.0.0's value"
pass "the rollback returned the edge to v1.0.0's configuration (X-Nexa-Edge: ${EDGE_MARKER_BACK})"

# ---------------------------------------------------------------------------
step "update again, to prove the installation is not stuck"
# ---------------------------------------------------------------------------
"$BOTCTL" update v2.0.0 || fail "the second update failed"
[ "$(cat "${NEXA_STATE_DIR}/current")" = "v2.0.0" ] || fail "the second update did not take"
pass "the installation updates again after a rollback"

printf '\n\033[32mUpdate, failed-health back-out and rollback all behave.\033[0m\n'
