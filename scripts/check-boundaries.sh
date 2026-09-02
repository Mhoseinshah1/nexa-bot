#!/usr/bin/env bash
#
# Boundary and convention checks that a type system cannot express.
#
# These fail the build outright rather than warning. Every one of them exists
# because the legacy system demonstrates the failure it prevents; the comment on
# each check names it.

set -uo pipefail
cd "$(dirname "$0")/.."

FAILED=0

fail() {
  echo "FAIL  $1"
  shift
  while [ "$#" -gt 0 ]; do
    echo "      $1"
    shift
  done
  FAILED=1
}

pass() {
  echo "ok    $1"
}

# A directory a check below assumes exists.
#
# Without this a rename makes `grep -r` on a missing path return nothing, which
# reads as "no violations" and passes. A check that cannot fail is worse than no
# check, because it is on the CI report saying the rule holds.
require_dir() {
  if [ ! -d "$1" ]; then
    fail "Expected directory $1 does not exist" \
         "Every check over it would pass vacuously. Update this script for the new layout."
    return 1
  fi
  return 0
}

# Source lines with comment lines removed.
#
# `grep -r` matches a rule's own documentation: the money check fired on a
# comment reading `amount: number` that was EXPLAINING why that is banned, and
# the only way past it was to reword the comment. Prose about a rule is not a
# violation of it.
scan_source() {
  local pattern="$1"
  shift
  grep -rnE "$pattern" "$@" --include=*.ts 2>/dev/null \
    | grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)' || true
}

# EVERY root a check below scans, not a sample of them. The first version
# listed five and left four unasserted — including `apps/api/drizzle`, which
# carries the balance-column rule, one of CLAUDE.md's non-negotiables, and
# `docs/research`, whose sanitization scan was wrapped in an `if [ -d ]` with no
# else, so a rename skipped it and printed nothing at all.
for dir in \
  packages/contracts/src \
  packages/i18n/src \
  apps/api/src \
  apps/api/src/surfaces \
  apps/api/src/modules \
  apps/api/drizzle \
  apps/web/src \
  docs/research; do
  require_dir "$dir" || true
done

# --- @nexa/contracts is the root of the dependency graph --------------------
# It holds declarations only. A framework import here means an implementation
# has leaked into the specification.
if grep -rnE "from '(@nestjs|drizzle-orm|pg|grammy|bullmq|fastify|ioredis|pino)" packages/contracts/src >/dev/null 2>&1; then
  fail "@nexa/contracts imports a framework or I/O library" \
       "$(grep -rnE "from '(@nestjs|drizzle-orm|pg|grammy|bullmq|fastify|ioredis|pino)" packages/contracts/src)"
else
  pass "@nexa/contracts has no framework or I/O imports"
fi

if grep -rnE "from '@nexa/" packages/contracts/src >/dev/null 2>&1; then
  fail "@nexa/contracts imports another workspace package" \
       "It is the root of the dependency graph and must depend on nothing."
else
  pass "@nexa/contracts depends on no workspace package"
fi

# --- Dependency inversion ---------------------------------------------------
# Domain and application layers declare ports; infrastructure implements them
# and depends inward. A domain module importing an infrastructure ADAPTER
# inverts that. Importing a shared persistence TYPE (the transaction handle) is
# allowed and is why the exclusion below is narrow rather than absolute.
INNER_DIRS=$(find apps/api/src/modules -type d \( -name domain -o -name application \) 2>/dev/null)
if [ -z "$INNER_DIRS" ]; then
  fail "No domain or application directories found" \
       "The dependency-inversion check would pass vacuously. Check the module layout."
else
  INVERSIONS=$(grep -rnE "from '.*/surfaces/" $INNER_DIRS 2>/dev/null || true)
  if [ -n "$INVERSIONS" ]; then
    fail "A domain or application file imports a surface" "$INVERSIONS"
  else
    pass "domain and application layers do not import surfaces ($(echo "$INNER_DIRS" | wc -l) directories checked)"
  fi

  FRAMEWORKS=$(grep -rnE "from '(@nestjs|drizzle-orm|pg|grammy|bullmq|fastify|ioredis|pino)" $INNER_DIRS 2>/dev/null || true)
  if [ -n "$FRAMEWORKS" ]; then
    fail "A domain or application file imports a framework or I/O library" "$FRAMEWORKS" \
         "Declare a port and implement it in infrastructure."
  else
    pass "domain and application layers import no framework or I/O library"
  fi
fi

# --- Surfaces contain no data access ---------------------------------------
# Two surfaces each owning their own version of a shared concept is the root
# cause of the legacy split brain: four admin roles in one surface, seven in the
# other; 36 editable texts in one, 608 in the other.
if grep -rnE "from '(drizzle-orm|pg)'" apps/api/src/surfaces >/dev/null 2>&1; then
  fail "A surface imports a database library" \
       "Surfaces call application services. They do not read the database."
else
  pass "surfaces contain no data access"
fi

# --- The owner bootstrap is not reachable from a surface -------------------
# BootstrapOwnerService creates an administrator without authorizing a caller,
# because provisioning has no caller. That is only safe while it cannot be
# reached over HTTP or Telegram: exposed on a surface it would be an
# unauthenticated route that creates an owner. The service refuses to run once
# any admin exists; this check is what keeps the other half of the argument
# true.
BOOTSTRAP_LEAK=$(grep -rn "bootstrap-owner.service\|bootstrapOwner" apps/api/src/surfaces 2>/dev/null || true)
if [ -n "$BOOTSTRAP_LEAK" ]; then
  fail "A surface reaches the owner bootstrap" "$BOOTSTRAP_LEAK" \
       "Bootstrap is a CLI provisioning step (src/bootstrap-owner.cli.ts), not an endpoint."
else
  pass "the owner bootstrap is not reachable from any surface"
fi

# --- The application layer names what it needs, not who provides it ---------
# `@nexa/contracts` is the shared specification and may be imported anywhere.
# `@nexa/i18n` is an IMPLEMENTATION of part of it — a catalogue and a renderer —
# and belongs behind a port like any other adapter.
#
# This drifted once already: three application files reached for `CATALOGUE_FA`
# and `renderTemplateBody` directly, and the cost showed up as a `defaultBody`
# that threw for every locale but `fa`, so the second-locale path ADR-0016
# describes could not be exercised by a test.
if [ -n "$INNER_DIRS" ]; then
  # Both quote styles and any subpath. The first version matched the exact
  # string `from '@nexa/i18n'`, so `from "@nexa/i18n"` and
  # `from '@nexa/i18n/catalogue.js'` — the two forms a leak is most likely to
  # take once someone is reaching past a rule — went straight through it.
  I18N_LEAK=$(scan_source "from ['\"]@nexa/i18n(/[^'\"]*)?['\"]" $INNER_DIRS)
  if [ -n "$I18N_LEAK" ]; then
    fail "A domain or application file imports @nexa/i18n directly" "$I18N_LEAK" \
         "Declare a port and bind the catalogue in container.ts."
  else
    pass "domain and application layers reach the catalogue through a port"
  fi
fi

# And the surfaces. A controller that renders from the catalogue itself is a
# second renderer beside `TemplateResolver`, which is how the legacy system came
# to hold 36 editable texts in one surface and 608 in the other.
#
# OUTSIDE the block above, deliberately. It was nested inside `[ -n
# "$INNER_DIRS" ]` — a variable it does not use — so renaming the MODULES tree
# would have silently skipped this check over the SURFACES tree and printed
# neither ok nor FAIL.
SURFACE_I18N=$(scan_source "from ['\"]@nexa/i18n(/[^'\"]*)?['\"]" apps/api/src/surfaces)
if [ -n "$SURFACE_I18N" ]; then
  fail "A surface imports @nexa/i18n directly" "$SURFACE_I18N" \
       "Surfaces send a template KEY. The catalogue is resolved behind the application layer."
else
  pass "surfaces do not render from the catalogue themselves"
fi

# --- Unguarded resolvers stay out of the surfaces ---------------------------
# `SettingsResolver`, `FeatureFlagResolver` and `TemplateResolver` deliberately
# skip the permission guard, because the code that uses them — a worker deciding
# how to behave — has no actor to authorize. That argument holds only while a
# SURFACE cannot reach them: from a controller they are an unauthenticated read
# of every setting in the session's tenant.
#
# `NotificationService.queue` is here for the same reason in the other
# direction: it is an unguarded WRITE, correct for a projection that nobody
# asked for and wrong for anything a request can reach.
#
# Two comments in the codebase claimed this check existed before it did. It does
# now.
#
# `opsLogWriter` is named for the same reason in the other direction. It is the
# recorder WITHOUT the notification projection, exposed on the container so the
# projection's own settings resolver and the dispatcher can avoid being
# producers of the work they consume. A surface reaching it would record a
# condition that never becomes a message — the projector's docblock says the
# projection "cannot be forgotten at a call site", and that is true only while
# nothing a request can reach holds the raw recorder.
#
# `failExhausted`, `claimDue`, `activeTenants` and `releaseClaim` are named too.
# All four are cross-tenant installation housekeeping, and the argument that
# this is safe rests entirely on their being unreachable from a request — an
# argument the check previously made only about the DISPATCHER's name, while
# the repository methods themselves were one `container.notificationRepository`
# away from a controller.
RESOLVER_LEAK=$(grep -rnE "settingsResolver|featureFlagResolver|templateResolver|notifications\.queue\(|notificationDispatcher|NotificationDispatcher|failExhausted|claimDue|activeTenants|releaseClaim|opsLogWriter" \
  apps/api/src/surfaces 2>/dev/null || true)
if [ -n "$RESOLVER_LEAK" ]; then
  fail "A surface reaches an unguarded resolver, the notification queue, the dispatcher, or cross-tenant housekeeping" \
       "$RESOLVER_LEAK" \
       "Call the guarded service. The resolvers exist for code with no actor to authorize."
else
  pass "surfaces reach no unguarded resolver, queue or dispatcher"
fi

# --- Authorization is not decided in a surface ------------------------------
# UI visibility is not authorization. A controller that resolves permissions
# itself is a controller that can decide differently from the service the
# Telegram surface calls — which is how the legacy system ended up with four
# admin roles in one surface and seven in the other.
SURFACE_AUTHZ=$(grep -rnE "resolveEffectivePermissions|permissionsForAdmin\(|SYSTEM_JOB_PERMISSIONS" apps/api/src/surfaces 2>/dev/null || true)
if [ -n "$SURFACE_AUTHZ" ]; then
  fail "A surface resolves permissions itself" "$SURFACE_AUTHZ" \
       "Call the application service; it checks the permission."
else
  pass "surfaces do not resolve permissions themselves"
fi

# --- No password or session material is logged or persisted raw -------------
# A password reaching a log or an audit column is unrecoverable: it is in the
# backups before anyone notices.
SECRET_LEAK=$(scan_source "(after|before|context):\s*\{[^}]*\b(password|passwordHash|token)\b" apps/api/src \
  | grep -v "tokenSecretRef" || true)
if [ -n "$SECRET_LEAK" ]; then
  fail "A credential is written into an audit or log payload" "$SECRET_LEAK" \
       "Audit the fact of the change, never the material."
else
  pass "no credential is written into an audit or log payload"
fi

# --- Money is never a float or a bare number -------------------------------
# A float that reaches production is very expensive to find.
MONEY_AS_NUMBER=$(scan_source "(amount|price|balance|total)\s*:\s*number" packages/contracts/src apps/api/src)
if [ -n "$MONEY_AS_NUMBER" ]; then
  fail "A monetary field is typed as number" "$MONEY_AS_NUMBER" \
       "Use the branded Money type: bigint minor units plus an explicit currency."
else
  pass "no monetary field is typed as number"
fi

# --- No mutable balance column ---------------------------------------------
# Wallets are an append-only ledger with a derived balance. A mutable balance
# column cannot be audited after the fact: when it disagrees with reality, the
# information needed to explain the disagreement no longer exists.
if grep -rniE "(add|alter).*column.*balance|\"balance\"|balance[[:space:]]+(bigint|numeric|integer)" \
     apps/api/drizzle/*.sql >/dev/null 2>&1; then
  fail "A migration adds a balance column" \
       "Balance is derived from wallet_entries, never stored as a mutable column."
else
  pass "no migration adds a mutable balance column"
fi

# --- Time comes from the Clock port ----------------------------------------
# No module computes its own "now", so tests are deterministic and no module
# invents its own date arithmetic.
CLOCK_VIOLATIONS=""
if [ -n "$INNER_DIRS" ]; then
  CLOCK_VIOLATIONS=$(grep -rnE "new Date\(\)|Date\.now\(\)" $INNER_DIRS 2>/dev/null | grep -vE ":[0-9]+: *(\*|//)" || true)
fi
if [ -n "$CLOCK_VIOLATIONS" ]; then
  fail "Domain or application code reads the wall clock directly" "$CLOCK_VIOLATIONS" \
       "Inject the Clock port instead."
else
  pass "domain and application code uses the Clock port"
fi

# --- No silent failure ------------------------------------------------------
# Three unrelated legacy subsystems report success for writes that changed
# nothing. An empty catch is how that becomes a habit.
EMPTY_CATCH=$(grep -rnE "catch\s*(\([^)]*\))?\s*\{\s*\}" packages/*/src apps/api/src apps/web/src 2>/dev/null \
  | grep -vE ":[0-9]+: *(\*|//)" || true)
if [ -n "$EMPTY_CATCH" ]; then
  fail "An empty catch block swallows a failure" "$EMPTY_CATCH"
else
  pass "no empty catch blocks"
fi

# --- The web bundle carries no server code ---------------------------------
if node -e "
  const pkg = require('./apps/web/package.json');
  const banned = ['@nexa/api'];
  const found = banned.filter((name) => pkg.dependencies?.[name]);
  if (found.length) { console.error(found.join(', ')); process.exit(1); }
" 2>/dev/null; then
  pass "the web admin depends on no server package"
else
  fail "The web admin depends on a server package" \
       "It may import @nexa/contracts and @nexa/i18n only, and talks to the API over HTTP."
fi

# --- Research is committed sanitized ---------------------------------------
# The corpus documents a third party's production deployment. Identifiers,
# credentials and endpoints do not belong in this repository.
# `require_dir` above already fails when this is missing, so the guard here is
# about not running a scan over nothing rather than about tolerating its
# absence.
if [ -d docs/research ]; then
  # Every pattern runs. An earlier version used if/elif, so a token hit skipped
  # the remaining scans entirely, and it checked only two of the four patterns
  # the import script enforces.
  RESEARCH_CLEAN=1

  scan_research() {
    local description="$1" pattern="$2" allow="${3:-}"
    local hits
    if [ -n "$allow" ]; then
      hits=$(grep -rnE "$pattern" docs/research 2>/dev/null | grep -vE "$allow" || true)
    else
      hits=$(grep -rnE "$pattern" docs/research 2>/dev/null || true)
    fi
    if [ -n "$hits" ]; then
      fail "$description appears in docs/research" "$(echo "$hits" | head -5)"
      RESEARCH_CLEAN=0
    fi
  }

  scan_research "A Telegram bot token" "[0-9]{8,10}:AA[A-Za-z0-9_-]{20,}"
  scan_research "An email address" "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"
  scan_research "An IP address" "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" \
    "\b(0\.0\.0\.0|127\.0\.0\.1|255\.255|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)"
  scan_research "A payment card number" "\b[0-9]{4}[- ][0-9]{4}[- ][0-9]{4}[- ][0-9]{4}\b"

  if [ "$RESEARCH_CLEAN" -eq 1 ]; then
    pass "docs/research contains no tokens, emails, IP addresses or card numbers"
  fi
fi

# ---------------------------------------------------------------------------
# Every declared error code can actually be produced
# ---------------------------------------------------------------------------
#
# A code in the frozen contracts is a promise the system makes about how it
# fails. Three times on this branch a code was declared and emitted by nothing:
# the failure it named surfaced as a driver error and a 500 instead
# (`admin.telegram_id_taken`), or named a distinction the security model
# forbids (`auth.session_expired`, and the bearer transport before it). An
# unproduced code is not a spare part; it is read as permission by whoever
# comes next.
#
# Only the string-valued *_ERROR_CODES entries are scanned. The ErrorKind
# taxonomy in the same file maps kinds to HTTP statuses and is deliberately
# complete, so a kind with no producer is not a broken promise.
#
# RESERVED codes are exempt, and each must say why here. The list is the point:
# adding a code with no producer now requires deciding, in this file, whether it
# is genuinely reserved.
RESERVED_CODES=""
# Empty, deliberately. Three codes were reserved here for one commit and then
# removed instead: reserving them kept dead names in a FROZEN spec, which is
# what CLAUDE.md means by "no placeholder abstractions". A code arrives when a
# path produces it, and adding one back is a one-line contract commit. Put a
# name here only with a reason that survives being read aloud.

UNPRODUCED=""
while read -r code; do
  [ -n "$code" ] || continue
  case " $RESERVED_CODES " in *" $code "*) continue ;; esac
  # The API's own runtime sources, and nothing else. Two narrowings, both
  # earned: the first version searched tests, where an assertion that the
  # catalogue CONTAINS a code satisfied the search and hid the exact dead
  # contract this rejects; the second still searched apps/web and packages/i18n,
  # which CONSUME codes rather than produce them, so a code named only in a UI
  # error mapping or a translation would have passed. Only the API can emit one.
  # Comment lines are stripped for the same reason — a code named in prose is
  # not a code anything can throw.
  if ! find apps/api/src -name '*.ts' 2>/dev/null \
    | xargs grep -h "$code" 2>/dev/null \
    | grep -vE '^\s*(//|\*|/\*)' \
    | grep -q .; then
    UNPRODUCED="$UNPRODUCED $code"
  fi
done <<EOF
$(grep -oE "^  [A-Z0-9_]+: '[^']+'," packages/contracts/src/errors.ts | cut -d: -f1 | tr -d ' ')
EOF

if [ -n "$UNPRODUCED" ]; then
  fail "every declared error code has a producer" \
    "no code path produces:$UNPRODUCED (add a producer, or reserve it in scripts/check-boundaries.sh with a reason)"
else
  pass "every declared error code has a producer or a stated reservation"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "Boundary checks failed."
  exit 1
fi
echo "All boundary checks passed."
