#!/usr/bin/env bash
#
# SessionStart hook.
#
# Claude Code cloud sessions begin with no Docker daemon and no running
# PostgreSQL or Redis. Without this, every session opens by rediscovering that
# it cannot run the integration tests.
#
# Always exits 0: a hook that fails the session start is worse than a hook that
# reports what it could not do.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

echo "==> Nexa Bot session setup"

# Dependencies, only when the lockfile has moved.
if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ pnpm-lock.yaml -nt node_modules ]; then
  echo "    installing dependencies"
  pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1 || true
fi

bash scripts/dev-services.sh || true

# A local .env, so the app and the tests can run without further setup. The
# key-encryption key is generated per environment and never committed.
if [ ! -f .env ]; then
  echo "    writing .env"
  KEK=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" 2>/dev/null || echo '')
  if [ -n "$KEK" ]; then
    cat > .env <<EOF
NODE_ENV=development
LOG_LEVEL=info
API_HOST=127.0.0.1
API_PORT=3000
DATABASE_URL=postgres://nexa:nexa@127.0.0.1:5432/nexa_dev
REDIS_URL=redis://127.0.0.1:6379
SECRETS_KEK=$KEK
SECRETS_KEK_ID=dev-1
AUTH_MODE=none
TELEGRAM_WEBHOOK_ENABLED=false
OUTBOX_RELAY_ENABLED=true
EOF
  fi
fi

# Internal packages must be built before the apps typecheck against them.
pnpm --filter @nexa/contracts build >/dev/null 2>&1 || true
pnpm --filter @nexa/i18n build >/dev/null 2>&1 || true

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
  pnpm db:migrate:dev >/dev/null 2>&1 && echo "    migrations applied" || echo "    migrations skipped"
  DATABASE_URL="${DATABASE_URL%/nexa_dev}/nexa_test" pnpm db:migrate:dev >/dev/null 2>&1 || true
fi

cat <<'EOF'

    pnpm verify            typecheck, lint, boundaries, i18n, unit tests, build
    pnpm test:integration  integration tests (needs the services above)

    Read CLAUDE.md before changing anything under packages/contracts.
EOF

exit 0
