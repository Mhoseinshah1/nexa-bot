#!/usr/bin/env bash
#
# Boundary and convention checks that a type system cannot express.
#
# These fail the build outright rather than warning. Every one of them exists
# because the legacy system demonstrates the failure it prevents; the comment on
# each check names it.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

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
  apps/api/src/modules/platform/providers \
  apps/web/src \
  docs/research; do
  require_dir "$dir" || true
done

# Same rule for the single files a check scans. The two Phase 3 checks below
# were written as a bare `if [ -f ]` with no else — the exact shape the
# `docs/research` note above records as already having cost this script a
# silently skipped rule once.
require_file() {
  [ -f "$1" ] && return 0
  fail "a checked file has moved: $1" "" \
       "The check that scans it would pass vacuously. Update the path here and in the check."
}
require_file apps/api/src/modules/platform/panels/application/panel-monitor.service.ts || true

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
# Two ways in, and the check used to know only one of them.
#
# A surface that imports `pg` is caught by the first pattern. A surface that
# reaches the pool through the container it is already handed is not — and one
# did: the readiness probe held a `SELECT` against the migration ledger and a
# `client.query('SELECT 1')`, in `apps/api/src/surfaces/web`, while this line
# printed `ok surfaces contain no data access` on every build. The rule is that
# surfaces hold no SQL and open no checkout; both halves are now asserted.
SURFACE_DATA=$(scan_source \
  "(from '(drizzle-orm|pg)'|\.withClient\(|\.withExecutor\(|\.query\(|\bsql\`)" \
  apps/api/src/surfaces)
if [ -n "$SURFACE_DATA" ]; then
  fail "A surface reaches the database" "$SURFACE_DATA" \
       "Surfaces call application services. Holding a statement or a checkout is not one."
else
  pass "surfaces hold no statement and open no checkout"
fi

# And the DIRECTION, which the rule above cannot see.
#
# The fix for that finding moved the SQL out of the readiness probe and left it
# holding `container.database`, `container.redis` and `container.relay` under
# purpose-named methods — `ping`, `appliedMigrations`, `lagMsWithin`. No
# statement, no checkout, and exactly the same dependency inversion: a surface
# reaching past the application layer into infrastructure, so a second surface
# or a replaced adapter would have to import the same handles. The check that
# was supposed to catch the violation had been satisfied by renaming it.
#
# The rule is the direction, so this asks about the direction. A surface may
# hold application services; the handles the composition root builds them from
# are not for it.
SURFACE_HANDLES=$(scan_source \
  "(\.(database|redis|relay)\b|from '.*infrastructure/persistence/)" \
  apps/api/src/surfaces)
if [ -n "$SURFACE_HANDLES" ]; then
  fail "A surface holds an infrastructure handle" "$SURFACE_HANDLES" \
       "Declare an application service and a port for what the surface needs, and compose the adapter in container.ts."
else
  pass "surfaces hold no database, cache or relay handle"
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

# --- The Telegram bot bootstrap is not reachable from a surface -------------
# The same argument, for the same reason, about a different credential.
# `BotBootstrapService` accepts a bot token and writes it encrypted without
# authorizing a caller, because provisioning has no caller. Reachable over HTTP
# it would be an unauthenticated route that accepts a bearer credential for this
# installation's bot and repoints where Telegram delivers.
#
# It is a separate check rather than an extra pattern on the one above so that a
# failure names WHICH provisioning path leaked, and so that removing one never
# quietly removes the other.
BOT_BOOTSTRAP_LEAK=$(grep -rn "bot-bootstrap.service\|bootstrapBot" apps/api/src/surfaces 2>/dev/null || true)
if [ -n "$BOT_BOOTSTRAP_LEAK" ]; then
  fail "A surface reaches the Telegram bot bootstrap" "$BOT_BOOTSTRAP_LEAK" \
       "The bot bootstrap is a CLI provisioning step (src/bootstrap-bot.cli.ts), not an endpoint."
else
  pass "the Telegram bot bootstrap is not reachable from any surface"
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
RESOLVER_LEAK=$(grep -rnE "settingsResolver|featureFlagResolver|templateResolver|notifications\.queue\(|notificationDispatcher|NotificationDispatcher|failExhausted|claimDue|activeTenants|releaseClaim|opsLogWriter|panelMonitor|PanelMonitorService|claimTenants|dueForTenants|refreshTenantBounds" \
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
      fail "$description appears in docs/research" "$(printf '%s\n' "$hits" | sed -n '1,5p')"
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
  # `-exec +` rather than `| xargs`: a path containing whitespace would be
  # split into two non-existent paths by xargs, and a grep that finds nothing
  # because it looked in the wrong place reports the same thing as a code with
  # no producer.
  # `grep -c`, not `grep -q`: a quiet grep exits on its first match, the
  # `find` ahead of it dies of SIGPIPE, and under `pipefail` the pipeline
  # returns 141 — so a code WITH a producer would be reported as having none.
  producers="$(find apps/api/src -name '*.ts' -exec grep -h "$code" {} + 2>/dev/null \
    | grep -cvE '^\s*(//|\*|/\*)' || true)"
  if [ "${producers:-0}" -eq 0 ]; then
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

# --- A provider adapter reaches the network only through the client it is given
# An adapter is HANDED a `ProviderHttpClient` bound to one panel's base URL, one
# timeout, one response cap and the installation's URL policy. Everything that
# makes an outbound call safe here — the pinned address, the refusal to follow a
# redirect, TLS verification, the private CA, the size cap — lives in
# SafeHttpClient and nowhere else, so an adapter that opened its own socket
# would not be "duplicating" those rules, it would be skipping them.
#
# The type already makes this hard: an adapter cannot construct a client and
# cannot widen one. This check covers the other route, which is an adapter
# importing a network library directly and never mentioning the client at all.
# `scan_source` drops comment lines, so a doc comment naming `fetch(` — the
# adapters explain WHY they do not use it — does not trip the check.
ADAPTER_DIR=apps/api/src/modules/platform/providers
if [ -d "$ADAPTER_DIR" ]; then
  RAW_NETWORK=$(scan_source \
    "(from ['\"](node:)?(http|https|net|tls|undici|axios|got|node-fetch)['\"]|\brequire\(['\"](node:)?(http|https|net|tls|undici|axios)['\"]\)|\bfetch\(|new XMLHttpRequest)" \
    "$ADAPTER_DIR")
  if [ -n "$RAW_NETWORK" ]; then
    fail "A provider adapter reaches the network directly" "$RAW_NETWORK" \
         "Adapters send through the ProviderHttpClient they are handed. SafeHttpClient owns DNS pinning, the URL policy, redirects, TLS and the size cap."
  else
    pass "provider adapters reach the network only through the client they are given"
  fi
fi

# --- Every provider failure kind has a producer -------------------------------
# The same rule as the error-code check above, for the other frozen vocabulary,
# and it was missing. `PROVIDER_FAILURE_KINDS` has ten entries and every existing
# test ITERATES the list to assert that consumers handle each one — which is the
# shape of test that cannot notice a kind nothing produces: remove the one
# producer of `AUTHENTICATION_REQUIRES_INTERACTION` and every consumer test still
# passes, because the list still contains it.
#
# A dead entry in this list is worse than a dead error code. The kinds drive the
# monitor's health mapping, its backoff interval and its retry decision, so one
# that no adapter can produce is a branch nothing exercises in code that dials
# other people's panels unattended — and it reads, to anyone extending the
# taxonomy, as a case that has been thought about.
#
# Searched in the ADAPTERS and the client only, not in `apps/api/src` as a whole.
# A kind named in the monitor's switch or in the retryability map is being
# CONSUMED; only the code that talks to a panel can produce one.
#
# `scan_source` drops comment lines, so this paragraph and the long docblocks in
# `provider.ts` do not count as producers.
PROVIDER_SOURCES="apps/api/src/modules/platform/providers apps/api/src/infrastructure/net"
if require_dir "apps/api/src/modules/platform/providers"; then
  UNPRODUCED_KINDS=""
  while read -r kind; do
    [ -n "$kind" ] || continue
    # shellcheck disable=SC2086
    produced="$(scan_source "'${kind}'" $PROVIDER_SOURCES | wc -l)"
    if [ "${produced:-0}" -eq 0 ]; then
      UNPRODUCED_KINDS="$UNPRODUCED_KINDS $kind"
    fi
  done <<EOF
$(sed -n "/^export const PROVIDER_FAILURE_KINDS = \[/,/^\] as const;/p" packages/contracts/src/provider.ts \
  | grep -oE "^  '[A-Z_]+'," | tr -d " ',")
EOF
  if [ -n "$UNPRODUCED_KINDS" ]; then
    fail "every provider failure kind has a producer" \
      "no adapter or HTTP client produces:$UNPRODUCED_KINDS" \
      "A kind nothing can produce is a branch in the monitor's health mapping, its backoff and its retry decision that nothing exercises."
  else
    pass "every provider failure kind is produced by an adapter or the HTTP client"
  fi
fi

# The list must not be empty, for the reason `require_dir` exists: a `sed` range
# that stops matching reads exactly like a vocabulary with no dead entries.
KIND_COUNT="$(sed -n "/^export const PROVIDER_FAILURE_KINDS = \[/,/^\] as const;/p" \
  packages/contracts/src/provider.ts | grep -cE "^  '[A-Z_]+'," || true)"
if [ "${KIND_COUNT:-0}" -lt 5 ]; then
  fail "The provider failure kinds could not be read from the contract" \
    "found ${KIND_COUNT:-0}; the check above would pass vacuously. Update this script for the new shape."
else
  pass "the provider failure taxonomy was read (${KIND_COUNT} kinds)"
fi

# --- No network or subprocess sink in a domain or application layer ----------
# The rule is no network call inside a database transaction, and this is the
# build-time half of enforcing it. `infrastructure/transaction-boundary.ts` is
# the runtime half; neither covers the other, which is why there are two.
#
# A transaction holds a pooled connection and row locks for its whole duration,
# so an outbound call inside one ties the pool's availability to somebody else's
# server — a panel that stops answering becomes every unrelated write in the
# installation timing out. And a transaction can roll back while a sent request
# cannot, which is an external side effect with no record that it happened.
#
# Application and domain layers declare PORTS; infrastructure implements them.
# A sink imported directly into one of those layers is both a layering violation
# and the only way the transaction rule gets broken by accident — the ports the
# application holds are all implemented by code that now refuses to run inside a
# transaction, so a direct import is how a future author would get past that
# without noticing there was anything to get past.
#
# Scanned: every `domain/` and `application/` directory under the modules tree.
# Not scanned: `infrastructure/`, which is where these imports belong, and the
# surfaces, which are HTTP servers.
#
# `scan_source` drops comment lines, so this paragraph's own vocabulary and the
# explanations in `transaction-boundary.ts` do not trip it.
LAYER_DIRS=$(find apps/api/src/modules -type d \( -name domain -o -name application \) 2>/dev/null)
if [ -n "$LAYER_DIRS" ]; then
  # shellcheck disable=SC2086
  LAYER_SINKS=$(scan_source \
    "(from ['\"](node:)?(http|https|net|tls|dgram|child_process|undici|axios|got|node-fetch)['\"]|\brequire\(['\"](node:)?(http|https|net|tls|child_process)['\"]\)|\bfetch\(|\bspawn\(|\bexecFile\(|new XMLHttpRequest)" \
    $LAYER_DIRS)
  if [ -n "$LAYER_SINKS" ]; then
    fail "A domain or application layer reaches a network or subprocess sink directly" "$LAYER_SINKS" \
         "These layers declare ports; infrastructure implements them. The sinks refuse to run inside a transaction (infrastructure/transaction-boundary.ts) and a direct import is how that gets bypassed."
  else
    pass "no domain or application layer reaches a network or subprocess sink directly"
  fi
else
  fail "No domain or application directories were found under apps/api/src/modules" \
       "The transaction-boundary check would pass vacuously. Update this script for the new layout."
fi

# --- Every network and subprocess sink refuses to run inside a transaction ---
# The runtime guard only works where it is CALLED. A new sink — a second HTTP
# client, an S3 upload, a `pg_basebackup` — would be outside both halves of this
# rule, and nothing would say so.
#
# So the sinks are enumerated here and each is required to call the guard. The
# list is the thing under review: adding a file to it is a deliberate act, and
# adding a sink WITHOUT adding it here leaves the file unasserted, which is why
# the companion check below counts the files that hold a sink at all.
# The guard must be CALLED, not merely imported.
#
# The first version of this grepped for the bare identifier, which the import
# line satisfies — so a file that imported the guard and never called it passed.
# Measured: deleting the call from `telegram-transport.ts` left this check green.
TRANSACTION_GUARD="assertOutsideTransaction("
#
# `telegram-transport.ts` was here and is not any more, and the reason is a
# strengthening rather than a removal: Phase 4 needed a second caller of Telegram
# `sendMessage` — customer-facing replies — and copying the transport's `post` would have
# produced the duplicate CLAUDE.md warns about ("never copy it; the copy that would
# silently keep the old behaviour is the unattended one"). So the `fetch` moved into
# `infrastructure/telegram/send-message.ts`, which calls the guard, and the transport now
# holds no sink at all. One file to assert instead of two, and a third caller inherits the
# assertion instead of needing its own.
SINK_FILES="
apps/api/src/infrastructure/net/safe-http.ts
apps/api/src/infrastructure/telegram/send-message.ts
apps/api/src/modules/platform/backup/infrastructure/telegram-backup-delivery.ts
apps/api/src/modules/platform/backup/infrastructure/pg-tools.ts
"
UNGUARDED=""
for sink in $SINK_FILES; do
  if [ ! -f "$sink" ]; then
    UNGUARDED="$UNGUARDED
$sink (missing — renamed or deleted without updating this check)"
  elif ! grep -q "$TRANSACTION_GUARD" "$sink"; then
    UNGUARDED="$UNGUARDED
$sink"
  fi
done
if [ -n "$UNGUARDED" ]; then
  fail "A network or subprocess sink does not refuse to run inside a transaction" "$UNGUARDED" \
       "Call assertOutsideTransaction() at the entry point. See infrastructure/transaction-boundary.ts."
else
  pass "every enumerated network and subprocess sink refuses to run inside a transaction"
fi

# The other direction: a sink FILE that is not on the list above.
#
# Without this, the list is a list of the files somebody remembered. With it, a
# new file that opens a socket or spawns a process fails the build until it is
# either guarded and listed, or shown not to be a sink.
#
# `node:net` and `node:tls` are the awkward pair, because each exports pure
# predicates alongside the socket constructors. `url-policy.ts` and
# `trusted-proxy.ts` import `isIP` and nothing else — they are what decides
# whether an address may be dialled, so demanding a transaction guard from them
# would be demanding it from the opposite of a sink.
#
# So the exemption is derived from the import itself rather than from a list of
# filenames: a candidate is pure only if EVERY sink-matching line in it binds
# nothing but the names below. `import { isIP, connect }` is not pure, and
# neither is a second import line that is. A filename allowlist would have gone
# stale the first time one of these files grew a socket.
PURE_NET_BINDINGS='isIP|isIPv4|isIPv6|BlockList|SocketAddress'
ALL_SINK_FILES=$(scan_source \
  "(from ['\"](node:)?(http|https|net|tls|dgram|child_process)['\"]|\bopenAsBlob\(|\bfetch\()" \
  apps/api/src \
  | cut -d: -f1 | sort -u)
UNLISTED=""
for found in $ALL_SINK_FILES; do
  case "$SINK_FILES" in
    *"$found"*) continue ;;
  esac
  # The lines that made this file a candidate, and whether they are all pure.
  #
  # The path prefix is OPTIONAL in the sed: `grep -rn` over a single file omits
  # the filename and prints `1:import ...`, while over a directory it prints
  # `path:1:import ...`. A sed that assumed the second shape left `1:` on the
  # front of every line, nothing matched the purity pattern, and both pure files
  # were reported as unguarded sinks.
  CANDIDATE_LINES=$(scan_source \
    "(from ['\"](node:)?(http|https|net|tls|dgram|child_process)['\"]|\bopenAsBlob\(|\bfetch\()" \
    "$found" | sed -E 's/^([^:]+:)?[0-9]+://')
  IMPURE=$(printf '%s\n' "$CANDIDATE_LINES" \
    | grep -vE "^import \{ *($PURE_NET_BINDINGS)( *, *($PURE_NET_BINDINGS))* *\} from '(node:)?(net|tls)';$" \
    || true)
  if [ -n "$IMPURE" ]; then
    UNLISTED="$UNLISTED
$found"
  fi
done
if [ -n "$UNLISTED" ]; then
  fail "A file reaches a network or subprocess sink and is not covered by the transaction guard check" "$UNLISTED" \
       "Either call assertOutsideTransaction() and add the file to SINK_FILES in this script, or stop importing the sink."
else
  pass "every file holding a network or subprocess sink is covered by the guard check"
fi

# --- The background monitor does not know which provider it is probing -------
# The monitor asks a repository which panels are due, hands each to the shared
# probe core, and stores what comes back. Which adapter operates the panel, which
# credential shape it needs and what its answers mean are decided ONCE, in the
# core and the registry, from the descriptor.
#
# A branch here — `if (providerType === 'sanaei')` — would be the first of a
# set that has to be extended for every provider added afterwards, in a file
# whose author is thinking about scheduling rather than about protocols. The
# provider-specific knowledge belongs in the adapter, which is the thing that
# gets tested against a real server.
#
# `scan_source` drops comment lines, so the prose above (and the same argument
# in the service's own docblock) does not trip the check.
MONITOR_FILE=apps/api/src/modules/platform/panels/application/panel-monitor.service.ts
if [ -f "$MONITOR_FILE" ]; then
  PROVIDER_BRANCH=$(scan_source \
    "(providerType|provider_type)\\s*(===|!==|==|!=)|['\"](marzban|sanaei)['\"]" \
    "$MONITOR_FILE")
  if [ -n "$PROVIDER_BRANCH" ]; then
    fail "The panel monitor branches on a provider type" "$PROVIDER_BRANCH" \
         "Provider-specific behaviour belongs in the adapter and the descriptor. The monitor schedules probes; it does not know what a panel speaks."
  else
    pass "the panel monitor does not branch on a provider type"
  fi
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "Boundary checks failed."
  exit 1
fi
echo "All boundary checks passed."
