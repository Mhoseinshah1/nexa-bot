#!/usr/bin/env bash
# What must be true of the production image, checked against a built image
# rather than against the Dockerfile that claims it.
#
# The distinction matters. `scripts/check-runtime-cli.sh` proves the compiled
# entrypoints work in the REPOSITORY's node_modules — a tree that also contains
# every devDependency, so it cannot show that they would load without them.
# This runs the same question inside the artefact that actually ships.
#
# Requires a Docker daemon and an image reference. Cloud sessions without a
# daemon skip this; the Ubuntu CI job does not.
set -euo pipefail

IMAGE="${1:?usage: check-image.sh <image-ref> [expected-version] [expected-commit]}"
EXPECT_VERSION="${2:-}"
EXPECT_COMMIT="${3:-}"

fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1" >&2; exit 1; }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

# Every run below is `--entrypoint` + a fixed argv, never a shell string built
# from a variable. The image reference is the only external input and it is
# quoted everywhere it appears.
run() { docker run --rm --network none --entrypoint "$1" "$IMAGE" "${@:2}"; }

# --- 1. The compiled entrypoints exist ---------------------------------------
ENTRYPOINTS=(
  dist/main.js
  dist/main.worker.js
  dist/infrastructure/persistence/migrate.js
  dist/infrastructure/persistence/seed.js
  dist/bootstrap-owner.cli.js
  dist/provision-installation.cli.js
)
missing=""
for entry in "${ENTRYPOINTS[@]}"; do
  run test -f "/app/$entry" 2>/dev/null || missing="$missing $entry"
done
[ -z "$missing" ] || fail "missing entrypoints in the image:$missing"
pass "every compiled entrypoint is in the image"

# --- 2. They LOAD, with their whole import graph ------------------------------
#
# The image carries production dependencies only, so this is the assertion the
# repository-level check cannot make: if anything reachable from these modules
# is a devDependency, the import throws here.
#
# None of them runs its `main` — each guards it behind an
# `import.meta.url === argv[1]` check — so no database, secret or terminal is
# needed. `--network none` proves it too.
run node --input-type=module -e "
  const migrate = await import('/app/dist/infrastructure/persistence/migrate.js');
  const seed = await import('/app/dist/infrastructure/persistence/seed.js');
  const provision = await import('/app/dist/provision-installation.cli.js');
  await import('/app/dist/bootstrap-owner.cli.js');
  const api = await import('/app/dist/bootstrap.js');
  const worker = await import('/app/dist/container.js');

  const problems = [];
  if (typeof migrate.runMigrations !== 'function') problems.push('migrate.runMigrations');
  if (typeof migrate.migrationsFolder !== 'function') problems.push('migrate.migrationsFolder');
  if (typeof seed.seed !== 'function') problems.push('seed.seed');
  if (typeof provision.provisionInstallation !== 'function') problems.push('provisionInstallation');
  if (typeof api.createApiApp !== 'function') problems.push('bootstrap.createApiApp');
  if (typeof worker.createContainer !== 'function') problems.push('container.createContainer');

  // The migrations must be reachable FROM THE IMAGE'S LAYOUT. migrate.js
  // resolves them relative to itself, so a COPY that nests one level
  // differently points at nothing and the runner applies zero migrations
  // while reporting success — the worst possible way for this to be wrong.
  const { existsSync, readdirSync } = await import('node:fs');
  const folder = migrate.migrationsFolder();
  if (!existsSync(folder)) problems.push('migrations folder missing at ' + folder);
  else if (!readdirSync(folder).some((f) => f.endsWith('.sql')))
    problems.push('no .sql migrations under ' + folder);

  if (problems.length) { console.error('problems: ' + problems.join(', ')); process.exit(1); }
" >/dev/null || fail "an entrypoint does not load inside the image"
pass "every entrypoint loads, with migrations reachable from the image layout"

# --- 3. No development tooling ------------------------------------------------
#
# Named individually rather than by a wildcard, because a wildcard that matches
# nothing looks exactly like a wildcard that found nothing.
FORBIDDEN=(tsx typescript drizzle-kit vitest @nestjs/testing @vitejs/plugin-react vite eslint prettier)
present=""
for pkg in "${FORBIDDEN[@]}"; do
  if run test -d "/app/node_modules/$pkg" 2>/dev/null; then present="$present $pkg"; fi
done
[ -z "$present" ] || fail "development tooling shipped in the runtime image:$present"

# The .bin directory is the other way these arrive — a transitive dependency can
# install a binary without a top-level directory of its own.
BINS=$(run sh -c 'ls /app/node_modules/.bin 2>/dev/null || true')
for bad in tsc tsx drizzle-kit vitest eslint prettier vite; do
  # Matched in the shell, not through `printf | grep -q`. Under `pipefail` a
  # `grep -q` that matches exits early and the writer ahead of it dies of
  # SIGPIPE, so the pipeline reports failure exactly when the pattern is found.
  case "
$BINS
" in
    *"
$bad
"*) fail "development binary in the runtime image: $bad" ;;
  esac
done
pass "no development tooling in the runtime image"

# --- 4. No source tree, no build config ---------------------------------------
#
# `pnpm deploy` copies src/ and the tsconfigs because apps/api declares no
# `files` field. Shipping them is how "no TypeScript in production" quietly
# stops being true.
for path in /app/src /app/tsconfig.json /app/tsconfig.build.json /app/drizzle.config.ts; do
  if run test -e "$path" 2>/dev/null; then fail "the runtime image ships $path"; fi
done
pass "no source tree or build configuration in the runtime image"

# --- 5. The Web Admin bundle, without its source maps -------------------------
run test -f /app/web/index.html 2>/dev/null || fail "the Web Admin bundle is missing from /app/web"
# `-print -quit` rather than `| head -5`. The pipeline runs inside the
# container's `sh`, which has no `pipefail`, so it was safe — but "safe because
# the inner shell lacks an option" is not a property the next edit preserves,
# and a bundle with several maps is exactly when it would bite.
MAPS=$(run sh -c 'find /app/web -name "*.map" -print -quit 2>/dev/null')
[ -z "$MAPS" ] || fail "the Web Admin bundle ships source maps: $MAPS"
pass "the Web Admin bundle is present and publishes no source maps"

# --- 6. The runtime user is not root ------------------------------------------
UID_OUT=$(run id -u)
[ "$UID_OUT" != "0" ] || fail "the image runs as root (uid 0)"
pass "the image runs as a non-root user (uid $UID_OUT)"

# --- 7. Build metadata is stamped and matches the release identity ------------
VERSION=$(run printenv BUILD_VERSION)
COMMIT=$(run printenv BUILD_COMMIT)
BUILT=$(run printenv BUILD_TIME)
# Spelled as `if`, not `A && B || C`: the latter runs C when A succeeds and B
# fails AND when A fails, which happens to be right here and reads as though it
# were an if-then-else. In a script that gates a release, "happens to be right"
# is not the standard.
for pair in "BUILD_VERSION=$VERSION" "BUILD_COMMIT=$COMMIT" "BUILD_TIME=$BUILT"; do
  name="${pair%%=*}"
  value="${pair#*=}"
  if [ -z "$value" ] || [ "$value" = "unknown" ]; then
    fail "$name is not stamped (got '${value}')"
  fi
done

# When the caller knows what it built, the image must agree. A release whose
# metadata names a different commit is a release nobody can trace.
if [ -n "$EXPECT_VERSION" ] && [ "$VERSION" != "$EXPECT_VERSION" ]; then
  fail "BUILD_VERSION is '$VERSION', expected '$EXPECT_VERSION'"
fi
if [ -n "$EXPECT_COMMIT" ] && [ "$COMMIT" != "$EXPECT_COMMIT" ]; then
  fail "BUILD_COMMIT is '$COMMIT', expected '$EXPECT_COMMIT'"
fi
pass "build metadata is stamped ($VERSION / ${COMMIT:0:12} / $BUILT)"

# --- 8. NODE_ENV is production ------------------------------------------------
#
# The application's own schema refuses a development-only transport, an
# AUTH_MODE of none and a direct topology only when NODE_ENV says production.
# Defaulting it in the image means an operator cannot forget it.
NODE_ENV_OUT=$(run printenv NODE_ENV)
[ "$NODE_ENV_OUT" = "production" ] || fail "NODE_ENV is '$NODE_ENV_OUT', expected production"
pass "NODE_ENV defaults to production in the image"

# --- 9. The host assets the release must carry --------------------------------
#
# `botctl update` installs the TARGET release's botctl, library, compose file,
# env template and Caddy configuration out of its image — that is the only
# source that is immutable, digest-addressed and available on a host with no
# git. A release built without them cannot be updated to, and the failure would
# appear on somebody's production host rather than here.
#
# `tar` is what the update actually uses to read them, so this checks the exact
# capability, not a proxy for it.
HOST_ASSETS=(
  deploy/bin/botctl
  deploy/bin/nexa-lib.sh
  deploy/compose.yml
  deploy/nexa.env.template
  deploy/caddy/Caddyfile
  deploy/caddy/routes.caddy
)
missing=""
for asset in "${HOST_ASSETS[@]}"; do
  run test -s "/app/$asset" 2>/dev/null || missing="$missing $asset"
done
[ -z "$missing" ] || fail "the image does not carry its host assets:$missing"

# And they must be readable THROUGH tar, in one stream, exactly as the update
# reads them. `test -s` would still pass on a layout tar cannot walk.
EXTRACTED=$(docker run --rm --network none --entrypoint tar "$IMAGE" \
  -cf - -C /app deploy | tar -tf - | grep -c 'deploy/bin/botctl$' || true)
[ "$EXTRACTED" = "1" ] || fail "the host assets cannot be read out of the image with tar"
pass "the image carries the host assets an update installs"

printf '\nThe production image carries artefacts and production dependencies, and nothing else.\n'
