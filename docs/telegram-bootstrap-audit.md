# Fresh-install Telegram bootstrap — what exists, and what a fresh install actually gets

Written before any code, against `origin/main` at `39ae0c4`. Every claim below was
checked in the source; where something is absent, the absence was verified by listing
what IS there rather than by failing to find it.

CLAUDE.md and the Phase 4C runbook both name this as the known post-4C follow-up, and
both deliberately kept it out of the wallet branch.

## The short version

A fresh production install today produces a working Web Admin, a provisioned tenant, a
first owner — **and a Telegram bot that cannot receive or send a single message.** Not
a degraded one: there is no `bot_instances` row, no webhook secret, no registered
webhook, and no code path anywhere that would create any of them.

Nothing is broken. The pieces were built in an order that assumed a bot instance already
existed, and the step that makes one exist was never written.

## What the running system expects

**`bot_instances` is the anchor for everything Telegram.**
`apps/api/src/infrastructure/persistence/schema.ts:209-229` — `id`, `tenant_id`,
`username`, `status` (`ACTIVE|STOPPED|DISABLED`, CHECK-constrained from the frozen
`BOT_INSTANCE_STATUSES`), `token_ciphertext`, `token_key_id`. The comment on the
ciphertext column is already the rule this workstream has to keep: _"Envelope-encrypted.
Never returned by any API, never logged."_

**The webhook route is keyed by a bot instance id.**
`apps/api/src/surfaces/telegram/webhook.controller.ts:79` —
`POST /telegram/webhook/:botInstanceId`, and `:111` refuses anything that is not an
`ACTIVE` row. So the URL Telegram must be told about cannot even be COMPUTED until a
row exists: the id is in the path.

**The frozen contract already names the shape.** `packages/contracts/src/tenant.ts:44-54`
declares `BotInstance` with `tokenSecretRef` and the comment _"The bot token is never
held in plaintext and never returned by any API."_ Nothing in the contract needs to
change for a bootstrap to exist — which is the right starting position.

## The four things a fresh install does not get

### 1. No `bot_instances` row is ever created outside the development seed

`grep -rln botInstances apps/api/src scripts/` finds six files. Exactly one INSERTs:
`apps/api/src/infrastructure/persistence/seed.ts`, the development seed, which writes
two fictional stores and two fake tokens. The repository
(`drizzle-tenant.repository.ts`) only ever reads them.

`provision-installation.cli.ts` — the CLI whose entire purpose is making a fresh
database usable — creates a **tenant and nothing else**. Its own docblock (`:7-28`)
records that it exists because `bootstrap-owner` had nowhere to put an owner, and that
the only code that had ever created a tenant was the development seed. The same sentence
is now true one level down, about bot instances, and this workstream is the same fix
applied to the next missing row.

### 2. The production env template sets no Telegram variables at all

`deploy/nexa.env.template` sets twelve keys — `NODE_ENV`, `LOG_LEVEL`, `API_HOST`,
`API_PORT`, `DATABASE_URL`, `REDIS_URL`, `SECRETS_KEYS`, `SECRETS_ACTIVE_KEY_ID`,
`WEB_ADMIN_ORIGINS`, `DEPLOYMENT_TOPOLOGY`, `TRUSTED_PROXY_IPS`,
`NOTIFICATION_TRANSPORT`. Not one is Telegram.

So on a fresh install the defaults stand: `TELEGRAM_WEBHOOK_ENABLED` is `false`
(`config.schema.ts:233`) and `TELEGRAM_WEBHOOK_SECRET` is `''` (`:237`). The webhook
route therefore refuses every request at `webhook.controller.ts:89`, before it parses
the bot id — correctly, because an empty expected secret must never match.

`generate_secrets` in `deploy/install.sh:421` mints the database password, the Redis
password and the secrets keyring. It does not mint a webhook secret, because nothing
consumes one.

### 3. Nothing ever calls Telegram to REGISTER the webhook

`apps/api/src/infrastructure/telegram/send-message.ts` is the only outbound Telegram
code. It builds `${apiBaseUrl}/bot${token}/${method ?? 'sendMessage'}` (`:64`), so the
method is parameterised — but no caller passes anything other than a send. There is no
`getMe`, no `setWebhook`, and no code that knows the installation's public URL in a form
Telegram could be given.

An operator today would have to call `setWebhook` by hand, with a bot-instance id they
would have to read out of the database, and a secret they would have to invent and put
in an env file the installer does not write.

### 4. The webhook secret is installation-wide, not per bot

`TELEGRAM_WEBHOOK_SECRET` is a single scalar compared against every request
(`webhook.controller.ts:85-89`), while the URL is per bot instance. One secret across
every bot an installation runs. That is adequate for one bot and is the shape the
code is in; whether it should become per-instance is a real question and is recorded
below rather than answered here.

## What the bootstrap must match

Two existing CLIs establish the pattern, and a third piece of infrastructure
constrains it.

**`provision-installation.cli.ts`** — idempotent by PostgreSQL advisory lock
(`PROVISION_LOCK_KEY = 0x6e78_6131`, `:63`), reads `DATABASE_URL` and nothing else
because _"this runs before the application has ever booted, in a context that
legitimately holds no application secrets"_ (`:26-29`), and treats an
already-provisioned installation as a SUCCESS that says so rather than an error
(`:22-25`). It never modifies an existing tenant.

**`bootstrap-owner.cli.js --status`** — answers one word on stdout (`none`,
`bootstrapped`, `foreign`) and creates nothing in that mode
(`deploy/install.sh:653-661`). The installer reads it through `require_owner_state`
(`:670`), which turns the two non-answers into refusals, and the comment at `:684-697`
records why: a real Ubuntu 24.04 staging host was left with an owner, no recorded
release, and a rerun that died on `BOOTSTRAP_ALREADY_DONE`. **A bootstrap that cannot
be rerun is a bootstrap that strands a half-finished install.**

**The installer's order** (`install.sh:770-826`): preflight → docker → layout → lock →
registry → digest → assets → secrets → env → pull → data services → migrations →
`provision_installation` → `start_everything` → `bootstrap_owner` → manifest. Each step
runs through `nexa_compose run --rm --no-deps --entrypoint node api dist/<cli>.js`.

A bot bootstrap has to slot in after the owner: it needs migrations applied and the
tenant to exist, and — unlike provisioning — it makes an OUTBOUND network call, so it
wants the runtime already up.

## The open questions this raises

Recorded rather than decided, because each is a policy choice and the runbook file that
would have settled them did not reach this session.

- **Where does the token come from on an unattended install?** The owner's password is
  deliberately never an argv value (`install.sh:76-77`: _"argv is readable by every user
  on the machine and lands in shell history"_). A bot token is exactly as sensitive, so
  `--bot-token-file` is the only shape consistent with that rule — never `--bot-token`.
- **Is the webhook secret per-installation or per-bot-instance?** Today it is a scalar
  env var. Moving it into `bot_instances` is a schema change and makes the secret
  survive a config rewrite; leaving it in config keeps one source of truth for the
  comparison. This choice has to be made before the CLI is written, because it decides
  whether the CLI writes a column or the installer writes a file.
- **What does a rerun with a DIFFERENT token mean?** Rotation, or a mistake? The
  provisioning CLI refuses to modify an existing tenant on exactly this reasoning.
- **Is a bot instance without a reachable public URL an error or a deferral?** An
  install behind DNS that has not propagated cannot complete `setWebhook`, and failing
  the whole install for that would be worse than recording the row and retrying.

## What has to be true when this is done

A fresh `install.sh` run against a clean Ubuntu host, given a bot token, ends with: an
`ACTIVE` `bot_instances` row whose token is envelope-encrypted under the installation's
active key; a webhook secret of at least 16 characters that the running API will accept;
`setWebhook` registered against the real public URL with that secret; and a `/start` from
a real Telegram account answered. Rerunning the installer changes none of it. Killing
the installer between any two of those steps and rerunning reaches the same end state.
