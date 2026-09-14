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

## Decision 1 — the token is asked for, interactively, with no echo

The normal fresh install prompts:

```
==> configuring Telegram bot
Telegram Bot Token:
```

Read through the same `Prompter.secret` the first owner's password already uses, which
puts the terminal in raw mode and echoes nothing. Never argv, never an environment
variable, never printed, never logged, never plaintext on disk.

`--bot-token-file PATH` exists as an OPTIONAL, documented automation path for
unattended installs, the way `--owner-password-file` does. It is not the normal UX and
the installer does not steer anyone towards it.

`install.sh` already states the argv half of this rule twice for the owner's password,
with both reasons: _"argv is readable by every user on the machine via `ps`, and an
environment variable would be readable through `docker inspect`."_ A bot token is a
bearer credential for the same installation. What that rule did not settle, and this
decision does, is that the ordinary human install should simply **ask** — the same way
it asks for the owner's password — rather than require the operator to have staged a
file first.

The confirmation prompt the password gets is deliberately NOT copied. A password is
typed blind and creates a row that cannot be re-created; a token is pasted, and
`getMe` validates it against Telegram before anything is written, so a mistyped one is
rejected with a specific reason rather than silently stored.

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

## Decision 3 — an install rerun reconciles; it never rotates a credential

_(This supersedes an earlier version of this decision, which had a rerun re-encrypt and
replace the token whenever `telegram_bot_id` matched. That made an ordinary
reconciliation into a credential operation, and it is wrong.)_

A rerun of `install.sh` is **reconciliation**. When a usable bot instance already
exists, the installer:

- does not ask for a token again;
- does not rotate, replace or re-encrypt the stored one;
- preserves the bot identity and the webhook secret;
- re-registers the webhook if that is the step still outstanding.

A different token supplied during an ordinary rerun does **not** repoint or rotate
anything. There is no path through the normal installer that changes a credential.

If the stored token has since been revoked, `getMe` says so and the installer reports
an explicit configuration problem naming the token — it does not quietly accept a new
one to route around the failure. An operator who wants to change the token is
performing a deliberate, separate act, and that belongs to an explicit operator command
or the later Web Admin management workflow, not to a rerun somebody performed to fix
something else.

`bot_instances.telegram_bot_id` is still recorded, and still comes from `getMe` rather
than from anything an operator types. Its job is now identity and truthful reporting
rather than deciding a rotation: it is how the installation knows which bot it is bound
to, and how a disagreement is described precisely instead of as a generic failure.

## Decision 4 — durable state survives a webhook failure, and the install does not claim success

Two halves, and the earlier version of this decision only had the first.

**Nothing is rolled back.** The tenant, the owner, the validated and encrypted token and
the `bot_instances` row all stay. They are correct, they were expensive to produce, and
a DNS record that has not propagated is no reason to destroy them. The installer's own
history carries the matching lesson: an install interrupted between the owner and the
release manifest left a healthy installation `botctl version` refused to describe, and
the fix was to make the rerun work rather than to make the failure louder.

**But the install does not report success.** A Telegram-enabled installation whose bot
cannot receive updates is not a completed installation, and saying otherwise is the
silent-success pattern this codebase exists to avoid. So the installer reports the
Telegram bootstrap as INCOMPLETE, names the outstanding step, and exits non-zero.

The two halves are compatible because the state is recoverable and the rerun is the
recovery: it resumes from the stored encrypted token **without asking for it again**,
retries `setWebhook`, and converges to success when registration succeeds.

The invariant, stated once so it can be checked: _a fresh install may leave recoverable
local state after an external failure, but it must never report full install success
while the bot still cannot receive updates._

## Consequences

- A new column, `bot_instances.telegram_bot_id`, and the migration that adds it. It
  records identity and makes a disagreement describable; it does not authorise a
  rotation.
- The bootstrap is therefore **create-or-reconcile**, never update-in-place of a
  credential. Its outcomes are: created, already configured and reconciled, webhook
  registration still outstanding, or a named configuration problem.
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
