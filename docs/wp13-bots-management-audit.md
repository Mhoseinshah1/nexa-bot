# WP13 — Bots Management: audit and design

Status: audit written before any implementation. Branch `claude/wp13-bots-management`,
from `origin/main` at `4e6fb39`. It does not depend on WP10G, WP11A or WP12; nothing
here reads a table, a route or a contract those branches add.

No owner specification exists for WP13. Its scope comes from the owner's instruction —
Web Admin management of bot instances, limited to what the architecture can truthfully
support — and from the decisions already recorded in this repository. Where the
instruction and a recorded decision meet, the recorded decision wins, and §2 lists each
one.

---

## 1. What exists

### 1.1 The model

`Tenant ≠ BotInstance` (`packages/contracts/src/tenant.ts`). A tenant is a commercial
boundary; a bot instance is one Telegram bot. One tenant may own several, and a reseller
sales bot is modelled as its own tenant with a parent. This package changes none of it.

`bot_instances` (`schema.ts`) has these columns:

| Column                                 | Meaning                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `id`, `tenant_id`                      | The bot, and the tenant it belongs to. Nothing ever rewrites `tenant_id`.                       |
| `username`                             | The name as last recorded; it goes stale when renamed in BotFather (OQ-TG-02).                  |
| `telegram_bot_id`                      | Telegram's numeric id, from `getMe`, never typed. The identity. Unique across the installation. |
| `status`                               | `ACTIVE`, `STOPPED` or `DISABLED` (`BOT_INSTANCE_STATUSES`, CHECK-pinned).                      |
| `token_ciphertext`, `token_key_id`     | The envelope-encrypted token. Never returned, never logged.                                     |
| `webhook_registered_at`, `webhook_url` | When Telegram last ACCEPTED `setWebhook`, and the URL it took.                                  |
| `webhook_secret_fingerprint`           | SHA-256 of the secret registered with. NULL means unknown, never "matches".                     |
| `commands_revision`                    | A digest of the command menu Telegram was last given. NULL means unknown.                       |
| `created_at`, `updated_at`             | Timestamps.                                                                                     |

There is no token-set-at column, no health column and no settings column on a bot.

### 1.2 What `status` does today

`status` is already a complete kill switch. Nothing in the product can change it,
though: there is no command, CLI flag or route that writes it. The bootstrap tells an
operator "Start the bot and run this again" (`bot-bootstrap.service.ts`,
`botNotActiveReason`), and there is no way to do that except SQL. **That missing remedy
is the most useful thing this package can add.**

Where status is enforced:

- **Inbound.** `webhook.controller.ts` answers 404 for a bot that is not `ACTIVE`, the
  same answer as for an unknown id, so the endpoint does not reveal which bots exist.
- **Customer replies and notifications.** `tokenForBotInstance` resolves `ACTIVE` rows
  only. A reply to a stopped bot's customer is refused and recorded as `NO_BOT`
  (`telegram-customer-messenger.ts`); it is not retried.
- **Operational notifications.** `activeTokenForTenant` resolves `ACTIVE` rows only. With
  none, the notification transport answers `FAILED_PERMANENT`,
  `telegram.no_bot_configured`.
- **Receipt evidence.** `getFile` uses the receiving bot's token, so a stopped bot's
  receipts cannot be opened (`OQ-5R-02`, left in force deliberately).
- **Scope activity.** `scopeIsActive` checks the bot row when a scope names one, which is
  every Telegram-originated write.

`BotInstanceStatusChanged { from, to }` is a declared event (`events.ts`) with a
registered payload schema, and nothing emits it. This package is its first emitter.
`DISABLED` is declared and nothing writes it; its meaning beyond "not ACTIVE" is not
recorded anywhere.

### 1.3 Credentials

- The token is envelope-encrypted by `SecretCipher`, with purpose `bot_instance.token`
  and the tenant and row as associated data. `secret-registry.ts` re-wraps it on key
  rotation.
- `tokenForBotInstance` and `activeTokenForTenant` decrypt on every call. Nothing caches
  a token in a process, so a replaced token takes effect on the next send.
- ADR-0029 decision 3: an install rerun reconciles and never rotates a credential.
  "An operator who wants to change the token is performing a deliberate, separate act,
  and that belongs to an explicit operator command **or the later Web Admin management
  workflow**." That is this package.

### 1.4 Webhook

- **Route.** `POST /telegram/webhook/:botInstanceId`, registered only when
  `TELEGRAM_WEBHOOK_ENABLED` is true.
- **Secret.** `TELEGRAM_WEBHOOK_SECRET` is installation-wide (ADR-0029 decision 2) and is
  checked before the bot id is parsed.
- **Registration** is the bootstrap's `setWebhook`, reachable only from
  `bootstrap-bot.cli.ts` and `botctl telegram register`. `scripts/check-boundaries.sh`
  fails the build if a surface imports the bootstrap service.
- **The API cannot compose the webhook URL.** The public origin is a CLI argument
  (`--public-base-url`) that `botctl` derives from its own configuration, and it is
  deliberately not taken from `WEB_ADMIN_ORIGINS` (ADR-0029, "What the implementation
  settled"). The API process can therefore compare against the URL that was RECORDED,
  and against the URL Telegram REPORTS, but not against the URL it would register now.

### 1.5 Telegram calls available

`infrastructure/telegram/send-message.ts` is the one call core. It owns the abort
timeout, `redirect: 'error'`, never throwing, and `assertOutsideTransaction`. It exposes
`getMe`, `setWebhook` and `setMyCommands`. `getWebhookInfo` is a documented Bot API
method that is not yet wrapped.

### 1.6 Permissions and the Web Admin

- There is no `bots.*` permission. The planned `/bots` route is gated on `settings.view`.
- `settings.view` is seeded to owner, operator and technical. `settings.edit` and
  `settings.destructive` are seeded to owner alone. `settings.destructive` is CRITICAL
  and charged today by the global trial reset only.
- `panels.credentials.rotate` is the precedent for a CRITICAL permission separate from
  the edit one. Adding a `bots.*` permission would need a backfill migration, because
  role permissions are stored rows (compare `0031`).
- `/bots` renders `PlannedPage`, with the owner decision recorded as
  `web.planned_bots_add_flow`. It says, in Persian: "In adding a bot there will be no
  'primary bot'. The only future option is 'reseller sales bot', which is currently
  disabled and cannot be created."

---

## 2. Decisions

Each decision below is conservative and reversible. None of them needs a migration.

### D1 — No "add bot" in the Web Admin

The recorded owner decision (`web.planned_bots_add_flow`) says there is no "add primary
bot". `CLAUDE.md` says reseller sub-bots are unbuilt and must not be added without an
explicit instruction. The primary bot is created by the installer's bootstrap, which is
fenced from every surface on purpose: exposed over HTTP, it would be a route that accepts
a new bot token and creates a row.

So the page has no add button, not even a disabled one. The planned page's own rule is
that a disabled button means "exists, but you may not", and that would be false here. A
card says how a bot comes to exist (the installer; `botctl telegram register` to retry)
and that a reseller sales bot is not built.

### D2 — Tenant binding is shown, never changed

ADR-0029 refuses repointing a bot, because every stored `telegram_user_id` belongs to
conversations that bot had. `bot_instances_telegram_bot_id_key` refuses one bot in two
tenants. The page shows the owning tenant (display name, slug, kind) and says the binding
is fixed. There is no endpoint that writes `tenant_id`.

### D3 — Stop and start, in the existing state machine

- The operator transitions are **ACTIVE → STOPPED** and **STOPPED → ACTIVE**.
- **`DISABLED` is not operator-managed.** Nothing in this codebase writes it and its
  meaning is not recorded, so starting a DISABLED bot is refused with
  `bot.status_not_managed` rather than guessed at. Recorded as `OQ-WP13-01`.
- **The write** takes an idempotency key, `ScopeActivityReader` inside the transaction
  and the bot row `FOR UPDATE`. It is a conditional UPDATE naming the `from` state, and
  writes an audit row and `BotInstanceStatusChanged` in the same transaction. No
  operational-event code is added: a code is part of the schema (`CLAUDE.md`, Phase 3C),
  and the audit row and the declared event already record the act.
- **A request for the state the bot is already in** writes nothing and answers
  `changed: false`. That is true: the bot IS in the state asked for, and the response
  says nothing was changed. It is remembered under its key, so a redelivery after
  somebody else's change cannot re-apply it (the rule `admin-management.service.ts`
  records for the same shape).
- **The Web Admin confirms before stopping** and names what stopping does, taken from
  §1.2 and nothing more: updates are refused, customer replies and operational
  notifications are not sent, and receipt evidence from this bot cannot be opened.
- **Permission:** `settings.edit`, owner-only by seed. Stopping the bot is the
  installation's inbound kill switch, and a role an owner deliberately grants
  `settings.edit` is the owner's decision.

### D4 — Token replacement, never a repoint

This is the Web Admin workflow ADR-0029 decision 3 anticipates.

- **Permission:** `settings.destructive`, CRITICAL and owner-only by seed. It is the
  bot's counterpart of the separate CRITICAL `panels.credentials.rotate`, and it needs no
  backfill. The permission's docblock gains a sentence naming its second charger; that
  goes in the contracts commit.
- **The permission before the value.** The surface hands the token over unparsed; the
  service charges `settings.destructive` first and only then checks its length, so a
  caller who may not replace it is answered 403 — and the refusal recorded — whatever it
  sent.
- **Before any network call:** the new token must parse as `<digits>:<secret>`. Its
  claimed id (the part before the colon, the same local claim ADR-0029 uses to refuse a
  different bot) must equal the stored `telegram_bot_id`.
  - A different id is refused with `bot.token_different_bot` and nothing is sent to
    Telegram.
  - A row with no recorded identity is refused with `bot.identity_unknown`; its remedy is
    `botctl telegram register`, which fills the identity from `getMe`.
- **`getMe`, outside any transaction.**
  - `IDENTIFIED` with the same id continues.
  - `REJECTED` gives `bot.token_rejected`.
  - `NOT_TELEGRAM` gives `bot.telegram_api_invalid`.
  - `UNREACHABLE` gives `bot.telegram_unreachable`.
  - An identified id that differs from the stored one gives `bot.token_different_bot`.
  - Nothing is written on any refusal.
- **Then one transaction:** the permission is re-checked inside it, then scope activity,
  then the bot row `FOR UPDATE`. The stored identity is re-compared under the lock, the
  token is encrypted with the same purpose and associated data the bootstrap uses, and
  the row is updated. An audit row names the action and never the value.
- **A stopped bot may have its token replaced.** Replacing the leaked token of a bot
  that was stopped because it leaked is exactly the case.
- **The same token as the one stored** is answered `changed: false` and nothing is
  written. The stored value is decrypted for that comparison and never leaves the
  service. The comparison is made again under the bot's row lock: a replacement that
  committed after the first read makes this request a replacement, never a no-op.
- **A replay answers with the first result.** The bot view, the installation and
  `changed` are snapshotted with the key in the mutating transaction, as settings and
  feature flags do, so a retried stop never comes back beside a bot started since.
- **The token is not in the idempotency request hash.** This follows `PanelService`: a
  hash would put a value derived from the secret in a table nothing else protects.
- **The webhook, secret and command menu are not touched.** Whether Telegram keeps a
  bot's webhook registration across a BotFather token revocation is not established in
  this repository and is not guessed (`OQ-WP13-02`). The live check (D5) reads the
  registration with the new token and reports what Telegram says, and
  `botctl telegram register` re-registers if it is gone.
- **Nothing else changes:** no event (the panel credential rotation writes none either),
  no username rewrite, no status change.

### D5 — Diagnostics: recorded state, and a live check on request

**The recorded state** is always shown, from the row and the process configuration
alone, with no network:

| Field         | Values                                                                      |
| ------------- | --------------------------------------------------------------------------- |
| Webhook route | `TELEGRAM_WEBHOOK_ENABLED` as this API process read it                      |
| Registration  | `webhook_registered_at` and `webhook_url`, or never registered              |
| Secret        | `MATCHES`, `DIFFERS`, `UNKNOWN` (NULL fingerprint) or `NOT_CONFIGURED`      |
| Command menu  | `CURRENT`, `STALE` or `UNKNOWN`, against the adapter's `commandsRevision()` |
| Readiness     | `REGISTERED`, `NOT_REGISTERED` or `HELD`, with every cause that applies     |

- **Readiness causes:**
  - `WEBHOOK_ROUTE_DISABLED`, `TENANT_INACTIVE` and `BOT_NOT_ACTIVE` make it `HELD`.
  - Otherwise `WEBHOOK_NEVER_REGISTERED`, `WEBHOOK_SECRET_CHANGED` and
    `WEBHOOK_SECRET_UNKNOWN` make it `NOT_REGISTERED`.
  - Otherwise it is `REGISTERED`.
- **The precedence** is the bootstrap's (webhook route, then tenant, then bot), so the
  two surfaces cannot name different first causes.
- **The word is `REGISTERED`, not "receiving".** The API cannot verify the URL's origin
  (§1.4), so a local derivation must not claim more than the row proves.
- **`fingerprintOf` moves** to one small shared module that the bootstrap and this
  package both import. A second SHA-256 of the same secret would be a second answer.

**The live check** (`POST /bots/:id/diagnostics`) is an explicit operator action:

- **Calls:** `getMe`, then `getWebhookInfo` (added to the shared call core), both outside
  any transaction.
- **Result:**
  - the identity outcome, and whether the id and the username match the stored ones;
  - whether Telegram's webhook URL equals the recorded one, and Telegram's URL itself;
  - the pending update count;
  - the last error date and Telegram's last error message, bounded to 512 characters;
  - `max_connections`.
- **Never returned:** transport error text. It names the method and the outcome, and the
  result carries outcome codes instead.
- **Nothing is stored.** Health stays "latest state only", and this package adds no
  health store (no migration, and D5 is a read).
- **Permission:** `settings.edit`, owner-only by seed. It decrypts and uses the
  credential, which is the line `panels.edit` draws for the panel connection test
  (task C2 of Phase 3D).
- **Only an ACTIVE bot is checked** (`bot.not_active` otherwise). `OQ-5R-02` records
  that a stopped bot's credential is not used for reads either, and widening it for a
  diagnostic is the same widening that entry declines.

### D6 — The views carry no secret

- **The list and detail views never select** `token_ciphertext`, `token_key_id` or the
  raw fingerprint. They are projected from a repository method whose SELECT names its
  columns.
- **The secret state is a comparison result,** never a digest.
- **There is no masked token stand-in.** A mask can be resubmitted as the value, which is
  the rule `CLAUDE.md` records for panel credentials.
- **`settings.view`** gives the list, the detail and the recorded diagnostics. Those are
  facts an operator needs to see why customers get no answer, and none of them is a
  credential.

### D7 — Scope

- **Every read and write is tenant-scoped** by the admin's session, and a bot of another
  tenant answers `bot.not_found`.
- **No cross-tenant read.** `tenant.cross_read` exists and is not used: nothing asks for
  it, and a reseller tenant has no bot today.

---

## 3. Surfaces

### HTTP (contracts `bot-management.ts`, controller `surfaces/web/bots.controller.ts`)

| Route                        | Permission             | Body                         | Answer                   |
| ---------------------------- | ---------------------- | ---------------------------- | ------------------------ |
| `GET /bots`                  | `settings.view`        | —                            | `{ bots, installation }` |
| `GET /bots/:id`              | `settings.view`        | —                            | `{ bot }`                |
| `POST /bots/:id/status`      | `settings.edit`        | `{ idempotencyKey, status }` | `{ bot, changed }`       |
| `POST /bots/:id/token`       | `settings.destructive` | `{ idempotencyKey, token }`  | `{ bot, changed }`       |
| `POST /bots/:id/diagnostics` | `settings.edit`        | `{}`                         | `{ diagnostic }`         |

### Web Admin (`/bots`, under Infrastructure)

- **The `PlannedPage` entry is removed**, and its three keys go with it
  (`planned_bots_summary`, `planned_missing_bot_runtime`, and `planned_bots_add_flow`,
  whose decision is restated on the real page).
- **List:** username, status, tenant and readiness per bot.
- **Detail:**
  - tenant binding (read-only, with the reason);
  - recorded webhook state and readiness causes, each with its remedy;
  - the live check button, drawn only with `settings.edit`;
  - stop or start with a confirmation, drawn only with `settings.edit`;
  - the token replacement form, drawn only with `settings.destructive`. It is a password
    input that is cleared after every submit and never pre-filled.
- **The add-flow card:** D1.
- Buttons are drawn from permissions, but that is a courtesy: the server charges every
  permission itself.

### What is NOT offered, and why

| Not offered                          | Why                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| Add a bot                            | D1: owner decision; reseller sub-bots are unbuilt.                                 |
| Re-register the webhook from the web | The bootstrap is fenced from surfaces and the API does not know the public origin. |
| Re-register the command menu         | Same fence. `botctl telegram register` does both.                                  |
| Change the tenant binding            | D2: ADR-0029 refuses repointing.                                                   |
| Delete a bot                         | Customers, receipts and notifications reference it. STOPPED is the reversible off. |
| Per-bot settings                     | None are modelled. Settings are tenant-scoped in the registry.                     |
| A per-bot webhook secret             | ADR-0029 decision 2; reopens only when one installation runs several bots.         |
| Telegram-side admin for bots         | Not asked for; the Web Admin is the management surface.                            |

---

## 4. Contracts (their own commit)

- `bot-management.ts` holds:
  - the vocabulary: operator-settable statuses, secret state, menu state, readiness
    states and causes, and live-check outcomes;
  - the request and response schemas, and `BOT_ROUTES`.
- `errors.ts` gets `BOT_ERROR_CODES`, nine codes, each with a different remedy:
  - `bot.not_found`, `bot.status_not_managed`, `bot.not_active`;
  - `bot.token_malformed`, `bot.token_different_bot`, `bot.identity_unknown`;
  - `bot.token_rejected`, `bot.telegram_unreachable`, `bot.telegram_api_invalid`.
- `permissions.ts` is a docblock only: `settings.destructive` gains its second charger.
- No event, permission, state, ledger reason, metric or template key is added.
  `BotInstanceStatusChanged` already exists.

## 5. Tests (targeted)

- **Unit:** readiness derivation and cause precedence; secret and menu comparison; the
  token claim parser.
- **Integration (service, Telegram stubbed at the port):**
  - tenant isolation;
  - no secret column in any view;
  - stop and start, with the audit row and the outbox event;
  - `DISABLED` refused;
  - a no-op answers `changed: false`, and a replay writes nothing twice;
  - the webhook route 404s after a stop;
  - permission refusals for an operator holding `settings.view` only;
  - token replacement: a different bot is refused before any Telegram call, a rejection
    writes nothing, success decrypts to the new value, and the audit carries no token;
  - live check outcomes and a stopped bot refused.
- **Web:**
  - list and detail render;
  - actions are drawn by permission;
  - the stop confirmation;
  - the token input is empty after a submit;
  - the live check result renders;
  - the planned list no longer has `bots`.

## 6. Open questions added

- **`OQ-WP13-01`** — what `DISABLED` means for a bot, and who may clear it.
- **`OQ-WP13-02`** — whether a BotFather token revocation keeps the bot's webhook
  registration. The live check answers it per installation, from Telegram.
