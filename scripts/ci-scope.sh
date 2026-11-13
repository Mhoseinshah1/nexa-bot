#!/usr/bin/env bash
# Decides which of CI's jobs a run needs, and prints the answer for
# $GITHUB_OUTPUT (.github/workflows/ci.yml, job `changes`). docs/ci.md § "Which
# jobs a pull request runs" is the long form.
#
#   bash scripts/ci-scope.sh <event>            the merge commit's own diff
#   bash scripts/ci-scope.sh <event> --stdin    the changed paths on stdin
#
# Outputs, one `key=value` line each:
#   full            true: every job runs. Always on push, dispatch, schedule and
#                   any other event that is not `pull_request`; on a pull request
#                   when ANY changed path is unclassified or fail-safe below, or
#                   the diff could not be read.
#   unit web integration legacy deploy deploy_logic
#                   true: that job (legacy = legacy-mysql AND legacy-rehearsal;
#                   deploy = the deployment smoke AND the update/rollback smoke)
#                   runs. All true when full=true; unit is true on every run.
#   audit           true: the dependency audit runs. On a pull request only when
#                   the dependency graph changed (the lockfile, a package.json,
#                   pnpm-workspace.yaml, .npmrc) or the diff could not be read —
#                   even when full=true, because the audit reads nothing else.
#                   Always true on any other event.
#   legacy_engines  the legacy-mysql matrix, JSON. A pull request runs MySQL 8.0
#                   (MirzaBot's production engine) only; every other event also
#                   runs MariaDB 10.11.
#
# The rule fails towards running MORE: every changed path must be classified,
# one unclassified path makes the whole run full, and the fail-safe paths
# (contracts, migrations, the lockfile, any package.json, .github/, the ci-*
# scripts) are full whatever else changed. Static and build are not outputs:
# they run on every run.
#
# Each class below names the jobs that READ its files. A job left out of a
# class is skipped for that file, so a class may leave out a job only when that
# job cannot read the file — `tests/unit/ci-workflow.test.ts` scans what each
# skippable job reads and fails when a path it reads does not select it.
set -euo pipefail

event="${1:-}"
source="${2:-}"

# Stdin is read before anything is decided, so a caller writing it never meets
# a closed pipe (EPIPE) because the event alone settled the answer.
paths=''
if [ "$source" = "--stdin" ]; then
  paths="$(cat)"
fi

ENGINE_MARIADB='{"label":"mariadb-10.11","image":"mariadb:10.11","health":"healthcheck.sh --connect --innodb_initialized"}'
ENGINE_MYSQL='{"label":"mysql-8.0","image":"mysql:8.0","health":"mysqladmin ping -h 127.0.0.1 -proot"}'

full=false audit=false
unit=false web=false integration=false legacy=false deploy=false deploy_logic=false

emit() {
  local engines="[$ENGINE_MYSQL]"
  if [ "$event" != "pull_request" ]; then
    full=true
    audit=true
    engines="[$ENGINE_MARIADB,$ENGINE_MYSQL]"
  fi
  if [ "$full" = "true" ]; then
    web=true integration=true legacy=true deploy=true deploy_logic=true
  fi
  # The unit project reads files of every class (apps/web and apps/miniapp
  # sources, deploy/, the Dockerfile, tests/legacy-mysql, tests/integration,
  # scripts/, docs/), so no class can show it does not: it runs on every run.
  # The classes below still name it, so each reads as the jobs that read it.
  unit=true
  printf 'full=%s\n' "$full"
  printf 'unit=%s\n' "$unit"
  printf 'web=%s\n' "$web"
  printf 'integration=%s\n' "$integration"
  printf 'legacy=%s\n' "$legacy"
  printf 'deploy=%s\n' "$deploy"
  printf 'deploy_logic=%s\n' "$deploy_logic"
  printf 'audit=%s\n' "$audit"
  printf 'legacy_engines=%s\n' "$engines"
  exit 0
}

# Unreadable: run everything, the audit included (whether the lockfile changed
# is exactly what is unknown).
everything() {
  full=true
  audit=true
  emit
}

[ "$event" = "pull_request" ] || emit

if [ "$source" != "--stdin" ]; then
  # The merge commit against its first parent, the base it is tested on. Only a
  # real two-parent merge: against any other commit, HEAD^1 would be the PR's
  # previous commit and the diff would show only its last one.
  parents="$(git rev-list --parents -n 1 HEAD 2>/dev/null | wc -w)" || everything
  [ "$parents" -eq 3 ] || everything
  # --no-renames lists both sides of a rename, so `x.ts -> x.md` counts as x.ts.
  paths="$(git -c core.quotepath=off diff --name-only --no-renames HEAD^1 HEAD 2>/dev/null)" ||
    everything
fi

[ -n "$paths" ] || everything

# Adds jobs to the run. `api` is the application set: unit, integration and web.
add() {
  local job
  matched=true
  for job in "$@"; do
    case "$job" in
      api) unit=true integration=true web=true ;; # tests/web scans apps/api/src
      unit) unit=true ;;
      web) web=true ;;
      integration) integration=true ;;
      legacy) legacy=true ;;
      deploy) deploy=true ;;
      deploy_logic) deploy_logic=true ;;
      *)
        echo "ci-scope.sh: unknown job $job" >&2
        exit 2
        ;;
    esac
  done
}

# Every rule that matches a path adds its jobs: a path in two classes runs the
# union (a backup CLI is application code, a maintenance CLI and backup). A path
# no rule matches makes the run full.
classify() {
  local path="$1" matched=false
  # In a shell `case` pattern `*` also matches `/`, so `docs/*.md` is every
  # Markdown file at any depth under docs/, and `apps/web/*` is the whole tree.

  # --- Fail-safe: the specification, the schema history, the dependency graph,
  # the workflows and the scripts that decide what CI runs. Always everything.
  case "$path" in
    packages/contracts/* | apps/api/drizzle/* | pnpm-lock.yaml | package.json | */package.json | \
      .github/* | scripts/ci-*)
      full=true
      matched=true
      ;;
  esac

  # --- Documentation: today's docs-only rule. Static (prettier, citations,
  # boundaries), unit (the runbook tests), web (docs/open-questions.md) and
  # deployment logic (botctl's test greps docs/deployment.md, the deploy
  # harness docs/config-upgrade-falsification.md) READ Markdown. The integration
  # shards, both legacy jobs and both smokes do not.
  case "$path" in
    README.md | CLAUDE.md | PROGRESS.md | docs/*.md) add unit web deploy_logic ;;
  esac

  # --- Session tooling (skills, mutation probes). No CI job but static and
  # unit reads them; deployment logic shellchecks scripts/claude/*.sh.
  case "$path" in
    .claude/* | scripts/mutate-*.py) add unit ;;
    scripts/claude/*) add unit deploy_logic ;;
  esac

  # --- The Web Admin and the Mini App. Their tests are the `web` project
  # (tests/web, the mini-app suites included). Integration reads one file of
  # apps/web: the template copy (r8-payment-outcome-headlines). tests/web runs
  # scripts/web-shots/no-scroll.mjs.
  case "$path" in
    apps/web/* | apps/miniapp/* | tests/web/* | scripts/web-shots/*) add unit web ;;
  esac
  case "$path" in
    apps/web/src/i18n/templates.fa*) add integration ;;
  esac

  # --- Shared text: both the API and the web surfaces import it.
  case "$path" in
    packages/i18n/*) add api ;;
  esac

  # --- Application code. Unit, integration and web (tests/web scans
  # apps/api/src for error codes and refusal text). The smokes and the legacy
  # rehearsal run the built application too; what they add beyond these suites
  # is the packaging and the paths the next two rules name, and a push to main
  # runs them on the merged commit.
  case "$path" in
    apps/api/src/*) add api ;;
  esac

  # --- The legacy importer (the Mirza -> Nexa import) and everything the two
  # legacy jobs run: the importer modules and the .nxpkg reader, the legacy CLI
  # helpers, the MySQL source suite, the synthetic fixture and the rehearsal
  # scripts. Integration reads the fixture and two rehearsal scripts.
  case "$path" in
    apps/api/src/modules/*/legacy* | apps/api/src/infrastructure/nxpkg/* | \
      apps/api/src/legacy-*.ts | apps/api/src/cutover-*) add legacy ;;
    tests/legacy-mysql/*) add unit legacy ;;
    tests/fixtures/legacy/*) add unit integration legacy ;;
    scripts/legacy-*) add unit integration legacy ;;
  esac

  # --- What the deployment smokes and the legacy rehearsal run beyond the
  # application code the integration suite covers: the process roles' entry
  # points, the maintenance CLIs, configuration, the migrator, backup and the
  # recovery role. Botctl's test reads the configuration schema and the bot
  # bootstrap service.
  case "$path" in
    apps/api/src/main*.ts | apps/api/src/*.cli.ts | \
      apps/api/src/infrastructure/persistence/migrat* | \
      apps/api/src/modules/platform/backup/* | apps/api/src/modules/platform/recovery/*)
      add legacy deploy
      ;;
  esac
  case "$path" in
    apps/api/src/infrastructure/config/* | \
      apps/api/src/modules/platform/tenancy/application/bot-bootstrap.service.ts)
      add deploy deploy_logic
      ;;
  esac

  # --- The deployment: the image, the compose files, botctl and the installer,
  # and the scripts the two smokes run. Deployment logic tests botctl, the
  # installer and the shell. The integration (hosted-activation) and web (csp)
  # suites read the Caddy routes.
  case "$path" in
    deploy/* | Dockerfile* | .dockerignore | docker-compose*.yml | compose*.yml | \
      scripts/install* | scripts/*deploy* | scripts/mirza-rehearsal-smoke.sh | \
      scripts/standalone-installer-smoke.sh | scripts/image-build.sh | scripts/check-image.sh | \
      scripts/release-installer-assets.sh)
      add unit deploy deploy_logic
      ;;
    tests/deploy/* | tests/fixtures/release-gate/* | scripts/release-ci-gate.* | scripts/check-shell.sh)
      add unit deploy_logic
      ;;
  esac
  case "$path" in
    deploy/caddy/*) add integration web ;;
  esac

  # --- Test sources of one project.
  case "$path" in
    tests/unit/*) add unit ;;
    tests/integration/*) add unit integration ;;
  esac

  # --- Every shell script under scripts/ is shellchecked by deployment logic.
  # Not a class of its own: a script nothing above names is still unclassified.
  case "$path" in
    scripts/*.sh) deploy_logic=true ;;
  esac

  # --- The dependency graph: the audit's only input.
  case "$path" in
    pnpm-lock.yaml | package.json | */package.json | pnpm-workspace.yaml | .npmrc) audit=true ;;
  esac

  # --- Anything else (tests/support, other fixtures, other scripts, root
  # configuration, apps/api outside src/, a file nobody has classified yet) runs
  # everything.
  [ "$matched" = "true" ] || full=true
}

classified=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  classify "$path"
  classified=$((classified + 1))
done <<<"$paths"

# Nothing but blank lines is as unreadable as nothing at all.
[ "$classified" -gt 0 ] || everything

emit
