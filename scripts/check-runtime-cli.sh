#!/usr/bin/env bash
# The maintenance commands must run from a production runtime.
#
# `db:migrate`, `db:seed` and `admin:bootstrap` used to execute TypeScript
# source through `tsx`, which is a devDependency. A runtime image carries built
# output and production dependencies and nothing else, so those commands could
# not run in the one place they matter most: a fresh install, before first
# boot, and every upgrade after it.
#
# This checks four things. The first three are about that packaging claim, and
# the first two alone have both been true of a broken build: the file existing
# does not mean it loads, and loading it under a node_modules tree that also
# contains devDependencies does not mean it would load without them. The fourth
# is a different artifact concern that belongs with the other build assertions
# — the Web Admin must not publish its own source maps.
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1" >&2; exit 1; }
pass() { printf '\033[32mok\033[0m    %s\n' "$1"; }

ENTRYPOINTS=(
  "apps/api/dist/infrastructure/persistence/migrate.js"
  "apps/api/dist/infrastructure/persistence/seed.js"
  "apps/api/dist/bootstrap-owner.cli.js"
)

# 1. The compiled entrypoints exist.
for entry in "${ENTRYPOINTS[@]}"; do
  [ -f "$entry" ] || fail "$entry is missing. Run pnpm build first."
done
pass "the maintenance entrypoints are in dist"

# 2. They LOAD, with their whole import graph, and expose what they should.
#
# Importing is the point: a missing runtime import is invisible to tsc under
# ESM. None of these runs its `main` — each guards it behind an
# `import.meta.url === process.argv[1]` check — so this needs no database, no
# secret key and no terminal.
node --input-type=module -e "
  const migrate = await import('./apps/api/dist/infrastructure/persistence/migrate.js');
  const seed = await import('./apps/api/dist/infrastructure/persistence/seed.js');
  await import('./apps/api/dist/bootstrap-owner.cli.js');

  const problems = [];
  if (typeof migrate.runMigrations !== 'function') problems.push('migrate.runMigrations');
  if (typeof migrate.migrationsFolder !== 'function') problems.push('migrate.migrationsFolder');
  if (typeof seed.seed !== 'function') problems.push('seed.seed');

  // The migrations have to be reachable FROM DIST. The folder is resolved
  // relative to the module, so a compiled layout that nests one level deeper
  // than the source would point at nothing and the runner would cheerfully
  // apply zero migrations.
  const { existsSync, readdirSync } = await import('node:fs');
  const folder = migrate.migrationsFolder();
  if (!existsSync(folder)) problems.push('migrations folder missing at ' + folder);
  else if (!readdirSync(folder).some((f) => f.endsWith('.sql')))
    problems.push('no .sql migrations under ' + folder);

  if (problems.length) {
    console.error('unusable from dist: ' + problems.join(', '));
    process.exit(1);
  }
" || fail "the compiled maintenance entrypoints do not load"
pass "they load and expose their entrypoints, with migrations reachable from dist"

# 3. Nothing in the built output imports a devDependency.
#
# The check that actually proves the packaging claim. `tsx` is the one that
# caused this, but any devDependency reached from dist is the same defect: it
# resolves here because the workspace has everything installed, and fails in an
# image built with `--prod`.
DEV_DEPS=$(node -e "
  // Every devDependency that could reach dist, not just the api's own. A root
  // devDependency — vitest, eslint, typescript — is just as absent from an
  // image built with --prod, and the first version of this check scanned only
  // apps/api/package.json.
  const manifests = [
    './package.json',
    './apps/api/package.json',
    './packages/contracts/package.json',
    './packages/i18n/package.json',
  ];
  const names = new Set();
  for (const m of manifests) {
    let pkg;
    try { pkg = require(m); } catch { continue; }
    for (const name of Object.keys(pkg.devDependencies ?? {})) names.add(name);
    // A devDependency of one workspace is a production dependency of another
    // only if that workspace declares it, so subtract what api ships with.
  }
  const prod = new Set(Object.keys(require('./apps/api/package.json').dependencies ?? {}));
  console.log([...names].filter((n) => !prod.has(n)).join('\n'));
")
LEAKED=""
for dep in $DEV_DEPS; do
  # ALL FOUR import forms. The first version matched `from '…'`, `require(…)`
  # and `import '…'` but not `import('…')`, so any dynamic import of a
  # devDependency was invisible — found by injecting one and watching the check
  # stay green. Single quotes only is safe because `format:check` enforces
  # Prettier's `singleQuote` on everything that compiles into dist.
  if grep -rqE "from '${dep}(/[^']*)?'|require\('${dep}(/[^']*)?'\)|import '${dep}(/[^']*)?'|import\('${dep}(/[^']*)?'\)" \
      apps/api/dist packages/contracts/dist packages/i18n/dist 2>/dev/null; then
    LEAKED="${LEAKED} ${dep}"
  fi
done
[ -z "$LEAKED" ] || fail "the built output imports devDependencies:${LEAKED}"
pass "the built output imports no devDependency"

# 4. No browser source maps in the deployable Web Admin artifact.
#
# A production `.map` publishes the original TypeScript of the surface that
# administers the installation. The default was `sourcemap: true`, so they
# shipped without anyone deciding they should; `NEXA_WEB_SOURCEMAP=1` is the
# deliberate opt-in, and this refuses to let the default come back by accident.
if [ -d apps/web/dist ]; then
  MAPS=$(find apps/web/dist -name '*.map' 2>/dev/null | head -5)
  if [ -n "$MAPS" ] && [ "${NEXA_WEB_SOURCEMAP:-}" != "1" ]; then
    fail "the Web Admin build published source maps:
$MAPS"
  fi
  pass "the Web Admin build published no source maps"
else
  pass "no Web Admin build to check (run pnpm build first to include it)"
fi

printf '\nThe maintenance commands run from a production runtime.\n'
