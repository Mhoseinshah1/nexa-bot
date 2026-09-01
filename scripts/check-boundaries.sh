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

# --- Money is never a float or a bare number -------------------------------
# A float that reaches production is very expensive to find.
if grep -rnE "(amount|price|balance|total)\s*:\s*number" \
     packages/contracts/src apps/api/src 2>/dev/null >/dev/null; then
  fail "A monetary field is typed as number" \
       "$(grep -rnE "(amount|price|balance|total)\s*:\s*number" packages/contracts/src apps/api/src 2>/dev/null)" \
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
if [ -d docs/research ]; then
  if grep -rnE "([0-9]{8,10}:AA[A-Za-z0-9_-]{30,})" docs/research >/dev/null 2>&1; then
    fail "A Telegram bot token appears in docs/research"
  elif grep -rnE "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" docs/research \
       | grep -vE "\b(0\.0\.0\.0|127\.0\.0\.1|255\.255|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)" >/dev/null 2>&1; then
    fail "An IP address appears in docs/research" \
         "$(grep -rnE "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" docs/research | grep -vE "\b(0\.0\.0\.0|127\.0\.0\.1|255\.255|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)" | head -5)"
  else
    pass "docs/research contains no tokens or IP addresses"
  fi
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "Boundary checks failed."
  exit 1
fi
echo "All boundary checks passed."
