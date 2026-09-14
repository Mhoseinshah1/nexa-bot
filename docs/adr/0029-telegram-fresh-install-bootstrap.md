# ADR-0029 — Telegram fresh-install bootstrap

Status: accepted
Date: 2026-09-14

## Context

`docs/telegram-bootstrap-audit.md` establishes the gap: a fresh install reaches a
working Web Admin, a provisioned tenant and a first owner, and a Telegram bot that
cannot receive or send a single message. There is no `bot_instances` row outside the
development seed, no webhook secret in the production env template, and no code
anywhere that calls `getMe` or `setWebhook`.

Four choices had to be made before any of it could be written. Each is recorded here
with the alternative that was rejected, because each is a policy decision rather than a
technical one and the next person will otherwise have to guess which way it went.

## Decision 1 — the token arrives on stdin or by file path, never in argv

`--bot-token-file PATH`, read the same way the first owner's password already is. Never
`--bot-token VALUE`, and never an environment variable.

`deploy/install.sh` already states the rule for the owner's password, twice, and gives
both reasons: _"argv is readable by every user on the machine via `ps`, and an
environment variable would be readable through `docker inspect`."_ A bot token is a
bearer credential for the same installation. It gets the same treatment or the rule
means nothing.

The consequence is that the installer's existing `-T`/no-`-T` split for stdin applies
unchanged, and `deployment-smoke.sh` can drive it exactly as it drives the owner
bootstrap.

## Decision 2 — the webhook secret stays installation-wide, in configuration

Not a new `bot_instances.webhook_secret` column.

This one went the other way from where it started. Per-instance looks obviously better
— it survives a config rewrite, and it limits a leaked secret to one bot. What settles
it is a property the webhook route already has and would have to give up:

```ts
// webhook.controller.ts — authenticated BEFORE the bot id is even parsed, so the
// endpoint cannot be used to probe which bot ids exist.
if (!expected || !secretTokenMatches(secretToken, expected)) { ... }
```

A per-instance secret cannot be compared until the row has been loaded, and the row
cannot be loaded until the path segment has been parsed and looked up. That turns an
unauthenticated request into a database read keyed by attacker-supplied input, and it
makes "unknown bot id" and "wrong secret" distinguishable — which is exactly the probe
the current ordering is written to prevent.

One installation runs one bot today. When it runs several, the question reopens, and
the answer will have to solve the probing problem rather than ignore it.

## Decision 3 — a rerun may rotate the token, but may not repoint the installation at a different bot

This needs an identity for "the same bot", and the username is not one: BotFather lets
it change. The numeric id cannot change, so `bot_instances.telegram_bot_id` is added
and `getMe` is what fills it.

The rule, then:

- **Same `telegram_bot_id`, different token** → the token is re-encrypted and replaced.
  This is rotation, it is a real operation, and there is no other path in the product
  that performs it.
- **Different `telegram_bot_id`** → refused. Repointing an installation at another bot
  would leave every `customers.telegram_user_id` row attached to conversations that bot
  has never had, and every stored `chat_id` addressed to a bot that cannot send to it.
  Nothing about that is recoverable by rerunning anything.
- **Same id, same token** → nothing is written, and it says so. This is the ordinary
  rerun, and it is a success.

`provision-installation` refuses to modify an existing tenant on adjacent reasoning; the
difference is that a tenant has no external identity to check against, and a bot does.

## Decision 4 — an unreachable public URL fails the registration, not the row and not the install

The row is written and the webhook registration is attempted separately. When `setWebhook`
fails — DNS that has not propagated, a certificate not yet issued, Telegram unreachable —
the bot instance stays written and the installer reports the registration as the one
outstanding step, with the command that completes it.

The alternative is to fail the install. That was rejected because it makes a slow DNS
record destroy work that succeeded: the tenant, the owner, the encrypted token and the
recorded release are all correct and none of them should be rolled back because a
propagation delay outlasted the installer. The installer's own history has the matching
lesson recorded at length — an install interrupted between the owner and the release
manifest left a healthy installation that `botctl version` refused to describe, and the
fix was to make the rerun work rather than to make the failure louder.

Registration is therefore idempotent and separately invocable, and a rerun of the whole
installer performs it.

## Consequences

- A new column, `bot_instances.telegram_bot_id`, and the migration that adds it.
- `getMe` and `setWebhook` need a Telegram client that can carry their results.
  `telegramSend` cannot: it extracts `result.message_id` and nothing else. The HTTP
  mechanics — the timeout, `redirect: 'error'`, the retryable/permanent taxonomy — are
  shared rather than copied, for the reason `probe-core.ts` records: the copy that
  silently keeps the old behaviour is the one nobody looks at.
- `TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_WEBHOOK_ENABLED` join
  `deploy/nexa.env.template`, and the secret is minted in `generate_secrets` — which
  runs once and is skipped wholesale on a rerun, so anywhere else would not survive the
  installer's own idempotency story.
- The bootstrap runs after `bootstrap_owner`: it needs migrations, a tenant, and — unlike
  provisioning — an outbound network call, so it needs the stack up.
