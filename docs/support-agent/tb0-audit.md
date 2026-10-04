# TB0 — Intelligent Support Agent: feasibility and architecture audit

**Status: audit, no implementation.** Program: _NEXA Intelligent Support Agent —
Telegram Business + NEXA Context + AI + Human Takeover + Controlled Learning_
(2026-10-04). Starting `main`: `751a85d3` (CI green on every job, no open PRs, latest
release `v0.4.5`).

This document is the TB0 deliverable. It decides nothing that an ADR does not also
decide. The three decisions it depends on are:

- [ADR-0033](../adr/0033-telegram-business-conversations-and-human-takeover.md) covers
  Telegram Business conversations, the transport and human takeover.
- [ADR-0034](../adr/0034-support-ai-provider-abstraction.md) covers the AI provider
  abstraction, the structured decision and the authority boundary.
- [ADR-0035](../adr/0035-support-knowledge-and-controlled-learning.md) covers support
  knowledge, controlled learning and the one-click build from NEXA data.

Open points are under `OQ-TB` in `docs/open-questions.md`. None of them is resolved
here by guessing.

---

## 1. Official Telegram Business capability map

### 1.1 Provenance — read this first

This session's egress proxy refuses `core.telegram.org` and `telegram.org` (403
`EGRESS_BLOCKED`). The map was therefore built from **`@grammyjs/types@5.0.0`**
(npm, 2026-08-25). Its JSDoc copies the Bot API reference word for word, and its `?:`
markers mirror the reference's "Optional." markers. Two secondary sources fill gaps:

- The current Bot API version is **10.3 (24 August 2026)**, taken from secondary
  reporting. The changelog header was **not** read directly.
- The Premium availability rule comes from the Telegram Business blog, through
  search snippets only.

**Product Owner re-check (TB0 amendment, 2026-10-04).** The Product Owner checked
the official Telegram documentation and confirmed two things:

- business bot updates include **both incoming and outgoing messages** in the
  connected user's chats;
- messages sent by the business bot carry **bot attribution fields**.

In the Bot API these are `sender_business_bot`; in MTProto, `via_business_bot_id`.
Search snippets of the official
<https://core.telegram.org/api/bots/connected-business-bots> page corroborate the
connection-update half: "Connecting or disconnecting a business bot or changing the
connection settings will emit an updateBotBusinessConnect update". This session's
egress still refuses `core.telegram.org`, so the confirmation is recorded as the
Product Owner's and was not re-fetched here.

`OQ-TB-01` is therefore resolved for the points above. Real-Telegram acceptance in TB1
remains **required**. Whatever the TB1 acceptance on a real Business account observes is recorded
in `docs/support-agent/telegram-business-observations.md`, and that record overrides
this section.

### 1.2 What the reference states

| Primitive                          | Reference text (verbatim where quoted)                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Update.business_connection`       | `BusinessConnection` — "The bot was connected to or disconnected from a business account, or a user edited an existing connection with the bot"                                                                                                                                                                                                   |
| `Update.business_message`          | `Message` — "New message from a connected business account"                                                                                                                                                                                                                                                                                       |
| `Update.edited_business_message`   | `Message` — "New version of a message from a connected business account"                                                                                                                                                                                                                                                                          |
| `Update.deleted_business_messages` | `BusinessMessagesDeleted` — "Messages were deleted from a connected business account"                                                                                                                                                                                                                                                             |
| Default delivery                   | `allowed_updates`: "Specify an empty list to receive all update types except chat_member, message_reaction, and message_reaction_count (default)". The four business types are in the default set.                                                                                                                                                |
| `BusinessConnection`               | `id` String; `user` User ("Business account user that created the business connection"); `user_chat_id` Integer; `date` Integer; `rights` BusinessBotRights, **optional**; `is_enabled` Boolean ("True, if the connection is active").                                                                                                            |
| `BusinessBotRights`                | All optional `True`: `can_reply` ("send and edit messages in the private chats that had incoming messages in the last 24 hours"), `can_read_messages`, `can_delete_outgoing_messages`, `can_delete_all_messages`, plus profile, gift, star and story rights that this program never needs. Replaced `can_reply` on the connection in Bot API 9.0. |
| `getBusinessConnection`            | `business_connection_id` → `BusinessConnection`.                                                                                                                                                                                                                                                                                                  |
| `BusinessMessagesDeleted`          | `business_connection_id`, `chat` (private; "The bot may not have access to the chat or the corresponding user."), `message_ids`.                                                                                                                                                                                                                  |
| `Message.business_connection_id`   | "…the message belongs to a chat of the corresponding business account that is independent from any potential bot chat which might share the same identifier."                                                                                                                                                                                     |
| `Message.sender_business_bot`      | "The bot that actually sent the message on behalf of the business account. Available only for outgoing messages sent on behalf of the connected business account."                                                                                                                                                                                |
| `Message.is_from_offline`          | "True, if the message was sent by an implicit action, for example, as an away or a greeting business message, or as a scheduled message"                                                                                                                                                                                                          |
| Send on behalf                     | `business_connection_id` is accepted by `sendMessage`, `sendPhoto`, `sendDocument`, `sendMediaGroup`, `sendChatAction`, `editMessageText`/`Caption`/`Media`/`ReplyMarkup` and others. `copyMessage`, `forwardMessage` and `deleteMessage` do **not** accept it.                                                                                   |
| Reply parameters                   | `ReplyParameters.chat_id` is "Not supported for messages sent on behalf of a business account". `allow_sending_without_reply` is "Always True" for them.                                                                                                                                                                                          |
| Edit limit                         | "business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within 48 hours"                                                                                                                                                                                                                        |
| Delete                             | `deleteBusinessMessages(business_connection_id, message_ids[1..100])` needs `can_delete_outgoing_messages` (the bot's own messages) or `can_delete_all_messages`.                                                                                                                                                                                 |
| Read                               | `readBusinessMessage` needs `can_read_messages`; "The chat must have been active in the last 24 hours."                                                                                                                                                                                                                                           |
| Files                              | `getFile`: up to 20 MB; the link is valid for at least an hour.                                                                                                                                                                                                                                                                                   |
| Flood control                      | `ResponseParameters.retry_after`. No business-specific limit is documented.                                                                                                                                                                                                                                                                       |
| Send idempotency                   | **None.** No send method takes a deduplication key.                                                                                                                                                                                                                                                                                               |
| Enablement                         | Business Mode is switched on per bot in @BotFather. `getMe` returns `can_connect_to_business`. The Business account needs Telegram Premium.                                                                                                                                                                                                       |

### 1.3 What the reference does not state

Each item below is an `OQ-TB` entry and an item on the real-Telegram acceptance list.
The designs in ADR-0033 are built to stay **safe whichever way each one resolves**.

| #   | Unknown                                                                       | Design posture until observed                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | Is `BusinessConnection.id` stable across a disconnect and reconnect?          | Key the row on `(bot_instance_id, connection_id)`. Identify the **owner** by `user.id`. A new id for the same owner supersedes the old row: the old row is marked replaced and its conversations re-point. Nothing is ever keyed only on the id string.                                                                                     |
| U2  | Does a disconnect arrive as `business_connection` with `is_enabled: false`?   | Treat `is_enabled !== true` as disabled. Also treat a send refused with a connection-class error as evidence of invalidity, and confirm it with `getBusinessConnection` before re-enabling anything.                                                                                                                                        |
| U3  | Do messages the **owner types by hand** arrive as `business_message` updates? | **Documented (Product Owner re-check):** business updates include outgoing messages in connected chats. Still verified by TB1 acceptance. `AUTO_REPLY_SAFE` is no longer blocked by missing documentation, only by a contrary _observation_, should acceptance produce one.                                                                 |
| U4  | Do the bot's **own** sends echo back as `business_message`?                   | **Attribution documented** (bot messages carry bot attribution fields). Every message the bot sends is also recorded with the `message_id` Telegram returned. An echo carrying our `sender_business_bot` **or** a recorded `message_id` is ours. Anything else outgoing that we cannot attribute is treated as human (fail toward silence). |
| U5  | Which chats does the connection cover?                                        | The Bot API does not expose this. NEXA acts only on chats it receives updates for.                                                                                                                                                                                                                                                          |
| U6  | Does `getFile` work on media from a `business_message`?                       | TB6 checks this at acceptance. If it does not, vision is unavailable for business chats and the agent asks for a text description.                                                                                                                                                                                                          |
| U7  | What error does a send outside the 24-hour window return?                     | Any 4xx is `REFUSED` and is never retried. The conversation goes to `HANDOFF_REQUIRED` with the reason `TRANSPORT_REFUSED`.                                                                                                                                                                                                                 |
| U8  | Are there business-specific rate limits?                                      | The existing 429/`retry_after` handling applies unchanged.                                                                                                                                                                                                                                                                                  |

### 1.4 Classifying a `business_message` (the takeover primitive)

Let `C` be the stored connection, `me` our bot's `telegram_bot_id`, and `m` the message.

| Case | Predicate (evaluated in this order)                                                    | Meaning                             | Effect on the conversation                           |
| ---- | -------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| 1    | `m.from.id ≠ C.owner_user_id`                                                          | **Inbound**, from the customer      | May enqueue AI work, subject to the state            |
| 2    | `m.sender_business_bot.id = me`, **or** `(chat, message_id)` is in our outbound record | **Our own echo**                    | None (marks our outbound row as observed)            |
| 3    | `m.is_from_offline = true`                                                             | Away, greeting or scheduled message | None. It is **not** a human entering.                |
| 4    | `m.sender_business_bot` present and `≠ me`                                             | **Another business bot**            | Treated as human: `HUMAN_ACTIVE`, reason `OTHER_BOT` |
| 5    | otherwise (`from = owner`, no business bot, not offline)                               | **Owner typed it by hand**          | `HUMAN_ACTIVE`                                       |

The inputs are documented: outgoing messages are delivered, and bot messages carry
attribution. The _ordering_ of the cases is NEXA's own rule, **kept deliberately
conservative** (TB0 amendment 2): any outgoing message not positively attributable to
our own business bot is human. It is the first thing the TB1/TB2 acceptance
verifies (`OQ-TB-03`). Every ambiguity resolves to case 5, because a silent AI
costs a delay and an AI talking over a human costs trust.

---

## 2. NEXA reuse map

The audits found **no existing AI, LLM, knowledge or Telegram Business code** and no
AI dependency in any `package.json`. Everything below is reuse of existing
mechanisms. No existing source of truth is duplicated.

| Need                       | Existing mechanism (path)                                                                                                                                                                                                                            | How the program uses it                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook ingress            | `apps/api/src/surfaces/telegram/webhook.controller.ts` (secret header, per-bot route `/telegram/webhook/:botInstanceId`, tenant/bot ACTIVE checks, 64 KiB limit, ADR-0026)                                                                           | Business updates are dispatched **before** `botRuntime.handle`, to a new `surfaces/telegram/business-updates.ts`, following the `stars-updates.ts` / `ops-group-updates.ts` precedent.                                                                                                                                                                                     |
| Update typing              | `telegramUpdateSchema` in `packages/contracts/src/http.ts` (minimal, passthrough)                                                                                                                                                                    | The business shapes get **strict** zod schemas, because identity is read from them.                                                                                                                                                                                                                                                                                        |
| Update dedupe              | `request_idempotency` via `telegramUpdateKey()` → `telegram:<bot>:update:<id>`                                                                                                                                                                       | The same key. Per-message rows add their own unique `(conversation, telegram_message_id, version)`.                                                                                                                                                                                                                                                                        |
| `allowed_updates`          | `TELEGRAM_HANDLED_UPDATE_TYPES` and `allowedUpdatesNarrowed()` in `tenancy/domain/webhook-url.ts`. Registration resets to Telegram's default set, which already includes the business types.                                                         | Add the four business types to `TELEGRAM_HANDLED_UPDATE_TYPES` so a narrowed registration is reported. No registration change is needed.                                                                                                                                                                                                                                   |
| **Current behaviour risk** | A `business_message` reaches `botRuntime.handle` today, with `telegramUserIdOf()` null, because `telegramFromOf()` reads only `message` and `callback_query`.                                                                                        | TB1's **first test** pins that a business update never reaches the bot runtime and never resolves or creates a customer.                                                                                                                                                                                                                                                   |
| Bot tokens                 | `bot_instances.token_ciphertext`, `DrizzleBotInstanceRepository.tokenForBotInstance` (ACTIVE only, tenant-scoped)                                                                                                                                    | A business send uses the token of the bot instance the connection belongs to, and no other.                                                                                                                                                                                                                                                                                |
| Outbound Telegram          | `infrastructure/telegram/send-message.ts`: `telegramSend()`, with the never-throw outcome taxonomy (`SUCCEEDED` / `FAILED_RETRYABLE` with 429 `retryAfterMs` / `FAILED_PERMANENT`)                                                                   | Body builders gain an optional `business_connection_id`. The outcome mapping is `TelegramCustomerMessenger`'s: 429 → `RATE_LIMITED`, other retryable → `UNKNOWN`, 4xx → `REFUSED`.                                                                                                                                                                                         |
| Customer identity          | `customers` with unique `(tenant_id, telegram_user_id)`; `CustomerService.resolveFromUpdate` is the **only creator**                                                                                                                                 | Business messages **look up only**, exact `(tenant_id, telegram_user_id)`, through a new read-only port. They never create a customer and never match by username (§3).                                                                                                                                                                                                    |
| Durable lanes              | Per-feature lane tables: `bot_command_syncs` (cleanest `claimDue`), `customer_notifications` (`send_started_at` → `UNCONFIRMED`, never resent), `provisioning_operations` (`call_started_at`)                                                        | Two new lanes. `business_outbound_messages` copies the notification lane's send discipline. `support_ai_jobs` copies `bot_command_syncs`' claim (§6).                                                                                                                                                                                                                      |
| Outbox                     | `outbox-relay.ts`, consumers (no network in `handle`), `processed_messages`                                                                                                                                                                          | Domain events for connection and conversation changes. A consumer enqueues lane rows; it never calls a provider.                                                                                                                                                                                                                                                           |
| Idempotency                | `request_idempotency`, `rememberOnce`, `hashRequest`; the per-row key pattern on tickets                                                                                                                                                             | Every operator command (send, resume, approve…) takes a key.                                                                                                                                                                                                                                                                                                               |
| Secrets                    | `AesGcmSecretCipher` (AAD `purpose\|tenant\|entity`), `SECRET_PURPOSES`, `SECRET_COLUMNS` registry, set-at-only projections (ADR-0023). Template: `payments/infrastructure/drizzle-gateway-credentials.ts`.                                          | New purpose `support_ai_provider.api_key` and a table copied from `payment_gateway_credentials`. Values are never re-displayed and there is no masked stand-in.                                                                                                                                                                                                            |
| RBAC                       | `permissions.ts` (`p()`, `ROLE_SEEDS`, `PERMISSION_REQUIRES`), `runAuthorizedMutation`, `rbac-labels.ts`. Existing keys: `tickets.view\|reply\|assign\|close`.                                                                                       | Seven new keys (§7), as their own contract commit.                                                                                                                                                                                                                                                                                                                         |
| Settings and flags         | `SETTINGS` (settings.ts), `FEATURE_FLAGS` (features.ts), with a total web presentation map                                                                                                                                                           | **Not used for AI configuration.** Mode has a stronger permission than `settings.edit` and is changed with optimistic versioning (ADR-0021), so it gets a dedicated table. A feature flag `support_agent` gates the surfaces (§5).                                                                                                                                         |
| Operator alerts            | `OperationalEventRecorder.record` (dedupe by code), Notification Center rules. There is no SUPPORT category.                                                                                                                                         | New codes: `support.business_connection.disabled`, `.rights_insufficient`, `support.ai_provider.unavailable`, `support.ai_provider.credential_rejected` (deduped per tenant and provider), `support.handoff_required`. A new `SUPPORT` Notification Center category mapped to `business_chats.view`. Codes are schema (CLAUDE.md), so they are named once, in TB1/TB4/TB7. |
| Audit                      | `AuditWriter.record` inside the transaction, with redaction                                                                                                                                                                                          | Every configuration change, takeover, resume and knowledge decision. Customer text is never stored in an audit row.                                                                                                                                                                                                                                                        |
| Tickets                    | `TicketService` (`openByCustomer`, `reply`, `setLinks`…), `tickets.opening_key`, statuses OPEN / WAITING_FOR_* / CLOSED, `ticket_messages`, `drizzle-ticket-context.reader.ts`                                                                       | The canonical escalation. A conversation links at most one active ticket. Creation is idempotent on `business-conversation:<id>:escalation:<n>`. Tickets gain an additive `origin` column (`BOT` default, `BUSINESS_CHAT`).                                                                                                                                                |
| Customer context           | `CustomerInsightReader` (orders, payments, services), `ProvisioningService.listForCustomer`/`getForCustomer`, `services` (`expires_at`, `traffic_limit_bytes`, `traffic_used_bytes`, `usage_synced_at`), `PaymentService.pendingTransferForCustomer` | The TB3 support context reads **through these application services**, behind one allowlisted payload builder. It never reads tables directly and never adds a second calculation.                                                                                                                                                                                          |
| Knowledge seeds            | `support_faqs`, `client_apps` (`guide`, `help_url`), `terms_versions`, incidents (`title`, `customer_message` customer-safe; `description` **internal**), the `CATALOGUE_FA` `bot.*` strings, `template_overrides`, catalogue products               | The TB9 sources, through an explicit allowlist (ADR-0035 §5).                                                                                                                                                                                                                                                                                                              |
| Web Admin                  | `apps/web` (home-grown router `router.ts`/`app.tsx`, `nav.ts`, `ui/kit.tsx`, RTL tokens), `pages/tickets.tsx`                                                                                                                                        | New pages under a "پشتیبانی هوشمند" nav group, built from the same kit.                                                                                                                                                                                                                                                                                                    |
| Process roles              | `api`, `worker` (internal work and Telegram sends), `provisioner`, `monitor`, `recovery`                                                                                                                                                             | LLM calls are outbound HTTPS with decrypted third-party keys and multi-second latency. ADR-0034 puts them in a **new `assistant` process role**, for the same reason panels are isolated in `provisioner` (§6).                                                                                                                                                            |
| Retention                  | ADR-0027 sweepers                                                                                                                                                                                                                                    | Message text in business conversations has a bounded retention (§5).                                                                                                                                                                                                                                                                                                       |

---

## 3. Customer identity design

1. **The tenant comes from the route, never from the message.** The webhook path names
   the bot instance. The bot instance names the tenant. The connection row is looked up
   by `(bot_instance_id, connection_id)`. A connection id that arrives on a different
   bot's route does not match.
2. **The peer is `message.from.id`, case 1 of §1.4 only.** The chat is private. The
   inbound sender's `from.id` is Telegram's own identity for the customer and arrives
   on a request authenticated by the webhook secret.
3. **The lookup is exact:** `customers WHERE tenant_id = :tenant AND telegram_user_id
= :from_id`. This is a new read-only port, `CustomerByTelegramIdReader`. It never
   matches by username: a username is mutable and reusable, and two customers can have
   held the same one.
4. **A business message never creates a customer.** `resolveFromUpdate` stays the only
   creator. A business chat is not a `/start`, and creating rows from it would register
   every person who ever messages the owner.
5. **An unlinked peer gets public support only.** The context builder receives
   `customer: null` and has **no** account-scoped tools. Any intent needing account
   facts is answered with how to open the NEXA bot, or hands off with the reason
   `IDENTITY_UNVERIFIED`.
6. **A blocked customer** (`customers.status`) is handed off and never auto-answered
   (`CUSTOMER_BLOCKED`).
7. **Customer-supplied identifiers are never authority.** A service id, username or
   order number in the text is at most a search hint _inside_ the resolved customer's
   own rows. Ownership is decided by the existing readers' `customerId` filter, which
   the model never chooses (ADR-0034 §4).
8. The connection **owner** writing in their own chat is never a customer turn
   (case 5).

Tests required (TB2/TB3): exact match; unknown id; the same username with a different
id; the same Telegram id under another tenant; a service id in the text that belongs to
another customer; the owner's own message.

---

## 4. Human takeover design (summary; ADR-0033 decides)

- A **conversation row** carries `state` and a monotonically increasing
  `control_epoch`. Every human signal increments the epoch under the conversation's
  row lock: the owner's message (§1.4 case 5), another bot (case 4), and an operator
  pressing "take over" in the Web Admin.
- Every AI job **captures the epoch** when it is created and **re-checks it twice**:
  before calling the provider (to save cost), and again inside the transaction that
  stamps `send_started_at`, under the same row lock. A mismatch, or a state other than
  `AI_ACTIVE`, cancels the job as `SUPERSEDED_BY_HUMAN`. Nothing is sent.
- **The human wins** whenever their message's update commits before the send stamp.
  Two residual windows remain, and they are stated rather than hidden:
  1. a human message typed after the stamp commits and before Telegram accepts our
     request (milliseconds);
  2. a human message Telegram has not yet _delivered_ to our webhook.

  Telegram has no conditional send, so no design closes either window. Mitigation:
  `AUTO_REPLY_SAFE` waits a settle delay before the final check. The default is **6 s**;
  a tenant may set it within **3–30 s**, bounded by a CHECK and the schema
  (`OQ-TB-04`). The delay is **mitigation only**. The epoch and state re-check under
  the row lock remains the authority, and no code path may treat an elapsed delay as
  permission to send.

- **Resume is explicit:** the Web Admin action «سپردن دوباره به هوش مصنوعی», with its
  own permission, idempotency key and audit row. An optional inactivity timeout is a
  later, visible, cancellable setting. It is **off** by default.
- An **UNKNOWN send outcome is never retried.** The row becomes `UNCONFIRMED` and the
  conversation goes to `HANDOFF_REQUIRED` (`SEND_OUTCOME_UNKNOWN`), because a resend
  could double-message a customer and Telegram offers no send idempotency.

---

## 5. Schema plan (additive; migrations from `0196`)

Every table has `tenant_id`, composite FKs to tenant-scoped parents, `timestamptz`
UTC, bounded text (CHECK on length) and enum CHECKs generated from contracts.

| Phase   | Table                                                       | Purpose and key columns                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TB1     | `telegram_business_connections`                             | `bot_instance_id`, `connection_id` (text, unique per bot), `owner_telegram_user_id`, `owner_user_chat_id`, `is_enabled`, `rights` (text[] of granted right names, CHECK ⊆ known set), `connected_at`, `last_update_at`, `superseded_by` (U1), `version`. Status (`ACTIVE` / `DISABLED` / `RIGHTS_INSUFFICIENT` / `SUPERSEDED`) is **projected**, never stored. No secrets.                                                                                                      |
| TB1     | `business_outbound_messages`                                | The send lane: `conversation_id`, `origin` (`OPERATOR` / `ASSIST` / `AUTO`), `body` (≤ 4096), `idempotency_key` (unique per tenant), `request_hash`, `state` (`PENDING` / `DELIVERED` / `UNCONFIRMED` / `FAILED` / `SUPERSEDED`), `attempts`, `next_attempt_at`, `send_started_at`, `control_epoch_at_creation`, `telegram_message_id`, `failure_code`, `ai_run_id` (nullable).                                                                                                 |
| TB2     | `business_conversations`                                    | `connection_id` FK, `chat_id`, `peer_telegram_user_id`, `customer_id` (nullable FK), `state` (`AI_ACTIVE` / `HUMAN_ACTIVE` / `HANDOFF_REQUIRED` / `PAUSED`), `control_epoch`, `handoff_reason`, `ticket_id` (nullable), `last_inbound_at`, `last_ai_at`, `last_human_at`, `consecutive_ai_replies`, `cooldown_until`, `summary` (≤ 2000), `summary_version`, `version`. Unique `(connection, chat_id)`. `DISABLED` is projected from the configuration mode and the connection. |
| TB2     | `business_messages`                                         | A minimal transcript: `conversation_id`, `telegram_message_id`, `direction` (`INBOUND` / `OUTBOUND_BOT` / `OUTBOUND_HUMAN` / `OUTBOUND_OFFLINE` / `OUTBOUND_OTHER_BOT`), `kind` (`TEXT` / `PHOTO` / `OTHER`), `text` (≤ 4096, nullable), `content_version`, `edited_at`, `deleted_at`, `photo_file_unique_id` (never shown to the browser). **Text is purged after 30 days** (an ADR-0027 sweeper) and on delete. Unique `(conversation, telegram_message_id)`.                 |
| TB4     | `support_ai_configs`                                        | One row per tenant: `mode` (`OFF` / `ASSIST_ONLY` / `AUTO_REPLY_SAFE`, default **OFF**), `primary_provider`, `primary_model`, `fallback` (ordered, ≤ 2), `vision_enabled`, `auto_topics` (text[] ⊆ the safe-topic catalogue), `max_consecutive_replies`, `cooldown_seconds`, `settle_delay_seconds` (default 6, CHECK 3–30), `timeout_ms`, `max_output_chars`, `daily_budget_minor` + `currency`, `tone_instructions` (≤ 2000), `version`.                                      |
| TB4     | `support_ai_provider_credentials`                           | Copies `payment_gateway_credentials`: `(tenant, provider)` unique, `api_key_ciphertext` / `_key_id` / `_set_at`, `base_url_override` (validated, for GLM regions). Registered in `SECRET_COLUMNS`.                                                                                                                                                                                                                                                                              |
| TB4     | `support_ai_runs`                                           | Telemetry, one row per provider call: `conversation_id`, `ticket_id`, `operation` (`ASSIST_DRAFT` / `AUTO_DECISION` / `SUMMARY` / `LEARNING_EXTRACT` / `CONNECTION_TEST`), `provider`, `model`, `attempt_index` (fallback position), `latency_ms`, `input_tokens`, `output_tokens`, `cost_minor` + `currency` (nullable when not calculable), `result`, `failure_category`, `decision`, `handoff_reason`, `policy_version`. **No prompt and no response text.**                 |
| TB5     | `support_ai_jobs`                                           | The AI lane: `kind` (`ASSIST_DRAFT` / `AUTO_DECISION` / `LEARNING_EXTRACT`), `conversation_id`, `trigger_message_id`, `trigger_content_version`, `control_epoch_at_creation`, `state`, `attempts`, `next_attempt_at`, `claimed_until`, `not_before` (settle delay), `result_ref`. Unique `(kind, conversation_id, trigger_message_id)` for automatic kinds, and the operator's idempotency key for `ASSIST_DRAFT`.                                                              |
| TB3/TB8 | `support_knowledge_articles`, `support_knowledge_revisions` | `title`, `body`, `category`, `tags`, `enabled`, `state` (`DRAFT` / `APPROVED` / `RETIRED`), `source` (`MANUAL` / `LEARNED` / `NEXA_BUILD`), `source_ref`, `current_revision`, plus reviewer and timestamps. Revisions are append-only.                                                                                                                                                                                                                                          |
| TB8     | `support_learning_candidates`                               | `proposed_title`, `proposed_body`, `category`, `tags`, `rationale`, `confidence`, `source_conversation_id` / `source_ticket_id`, `state` (`PENDING` / `APPROVED` / `REJECTED`), `reviewer_admin_id`, `reviewed_at`, `published_article_id`.                                                                                                                                                                                                                                     |
| TB9     | `support_knowledge_builds`                                  | `requested_by`, `state`, and a `proposals` jsonb change-set (adds and updates, each with a base revision for conflict detection). Never applied without review.                                                                                                                                                                                                                                                                                                                 |
| TB7     | `tickets.origin`                                            | Additive column, `BOT` (default) or `BUSINESS_CHAT`. The conversation → ticket link lives on the conversation.                                                                                                                                                                                                                                                                                                                                                                  |

**Deliberately absent:** any column that copies a customer, service, order, payment or
ticket fact; a balance; a stored prompt; a stored model response; and a raw Telegram
`file_id` reachable by the browser.

---

## 6. Queue and orchestrator plan

```
webhook (api) ─▶ business-updates.ts
                  ├─ business_connection ─▶ upsert connection (tx) ─▶ outbox event ─▶ ops alert if disabled/insufficient
                  ├─ business_message     ─▶ classify (§1.4) ─▶ conversation tx:
                  │                               INBOUND: store message, and if mode=AUTO and state=AI_ACTIVE → insert support_ai_jobs (not_before = now + settle)
                  │                               HUMAN:   state=HUMAN_ACTIVE, epoch++, cancel pending jobs + outbound rows (SUPERSEDED)
                  ├─ edited_business_message ─▶ content_version++; a pending job on that message is superseded and ONE new job is enqueued
                  └─ deleted_business_messages ─▶ mark deleted, purge text, supersede jobs on it
assistant role ─▶ SupportAiLoop.claimDue (SKIP LOCKED, lease) ─▶ re-read state/epoch ─▶ context (TB3) ─▶ guards ─▶ provider (TB4, fallback)
                  ─▶ validate decision ─▶ tx{ re-check epoch/state/eligibility, insert business_outbound_messages, record run }
worker role    ─▶ BusinessOutboundLoop.claimDue ─▶ tx{ re-check epoch+state, stamp send_started_at } ─▶ telegramSend(business_connection_id)
                  ─▶ DELIVERED (store message_id) | RATE_LIMITED (requeue at retry_after, no attempt spent) | REFUSED (FAILED, handoff) | UNKNOWN (UNCONFIRMED, handoff, never resent)
```

- **The webhook never waits on an AI provider.** It writes rows and returns.
- **Two lanes, two roles.** The decision (`assistant`) and the send (`worker`) are
  separate, so a slow provider cannot delay a send and the send discipline is the
  existing proven one. The epoch check runs in **both** lanes.
- **Assist Mode uses the same lane, a different kind.** An operator's request for a
  draft inserts a `support_ai_jobs` row of kind `ASSIST_DRAFT`, and the Web Admin polls
  for its result. The `api` role never calls a provider, so a slow provider cannot hold
  an HTTP request or an API replica. Sending a draft inserts a
  `business_outbound_messages` row with `origin = ASSIST`. That is the same transport,
  the same epoch check and nothing sent silently.
- The **circuit breaker** is a per-tenant, per-provider condition: an
  `operational_events` code with a `next_probe_at`. A tripped primary goes to fallback,
  and a tripped chain goes to handoff.

---

## 7. Permissions plan (contract change, its own commit in TB1/TB2)

| Key                        | Risk     | Grants                                                                                                                 | Requires                   | Seeded to             |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------- |
| `business_chats.view`      | LOW      | the conversation list and detail, connection status, AI run summaries for a conversation                               | —                          | support, admin, owner |
| `business_chats.reply`     | MEDIUM   | send as the business account, take over, resume to AI, link or create a ticket                                         | `business_chats.view`      | support, admin, owner |
| `support_ai.assist`        | MEDIUM   | request summaries and drafts (spends provider budget)                                                                  | `business_chats.view`      | support, admin, owner |
| `support_ai.configure`     | HIGH     | provider, model, fallback, limits, tone, mode `OFF`↔`ASSIST_ONLY`; set, replace and delete credentials; usage and cost | —                          | admin, owner          |
| `support_ai.auto_reply`    | CRITICAL | move the mode **into** `AUTO_REPLY_SAFE` (leaving it needs only `configure`), and edit the auto-topic allowlist        | `support_ai.configure`     | owner                 |
| `support_knowledge.manage` | MEDIUM   | create, edit and retire articles; request a NEXA build                                                                 | —                          | support, admin, owner |
| `support_knowledge.review` | HIGH     | approve or reject learning candidates and build proposals (publishing what auto-reply may say)                         | `support_knowledge.manage` | admin, owner          |

Seven keys. Usage and cost are folded into `support_ai.configure` rather than given
an eighth key, because no audited role needs cost without configuration. The
`assistant` loop acts as `SYSTEM_JOB`. It needs **no** new system-job permission,
because it writes only lane and telemetry rows through services that check scope
activity. It is the decision maker for nothing privileged.

---

## 8. Package and dependency map

```
TB0 ──▶ TB1 (connection + transport) ──▶ TB2 (conversation + takeover + basic Web list) ──┐
                                                                                          ├─▶ TB5 (assist) ─▶ TB6 (vision) ─▶ TB7 (auto + handoff + tickets) ─▶ TB8 (learning) ─▶ TB10
TB0 ──▶ TB3 (support context; knowledge tables read path) ─────────────────────────────────┤                                                      └─▶ TB9 (NEXA build) ─▶ TB10
TB0 ──▶ TB4 (provider foundation, `assistant` role, config, credentials) ──────────────────┘
```

- TB1, TB3 and TB4 are independent after TB0 and touch disjoint modules. The shared
  files are `schema.ts`, `permissions.ts`, `container.ts` and the migration journal,
  so their **migrations are serialised by the integrator**, never written
  concurrently.
- New module homes:
  - `apps/api/src/modules/commerce/business-chats/` (TB1/TB2)
  - `apps/api/src/modules/commerce/support-context/` (TB3)
  - `apps/api/src/modules/control/support-ai/` (TB4/TB5/TB7)
  - `apps/api/src/modules/control/support-knowledge/` (TB3/TB8/TB9)
  - `apps/api/src/infrastructure/ai/{openai,anthropic,zai}/` (TB4 adapters)
- Contracts: `packages/contracts/src/business-chats.ts`, `support-ai.ts` and
  `support-knowledge.ts`, each introduced in its own contract commit.
- npm dependencies: **none planned.** The three providers are called over `fetch`
  with handwritten request and response schemas, as the payment gateways are. That
  keeps the adapter contract test in charge of the wire shape, and adds no SDK to the
  production image's audit surface (`OQ-TB-08`).

---

## 9. Release defaults (program §49, binding on every package)

Every existing and new tenant starts with mode **OFF**, no credentials, vision off, an
empty auto-topic allowlist and no approved knowledge. Nothing in any migration sets
`AUTO_REPLY_SAFE`. A regression test pins that a fresh `support_ai_configs` row and a
migrated tenant are both `OFF`.

## 10. Process note

The program's §46 asks for a merge after one Codex review and green CI. `CLAUDE.md`
makes merging to `main` the owner's explicit call on a reviewed head. Each TB package
is therefore taken to a green, reviewed PR and **left open with "ready"**, unless the
Product Owner explicitly approves that merge.
