# Round N — Broadcast, safe mass actions and the shared audience: audit and design

This document covers Agent E's package in the owner's post-v0.3.6 brief:

- B1: Broadcast, «ارسال همگانی»;
- B2: safe mass wallet credit and mass traffic/time, «عملیات گروهی»;
- the shared audience foundation that Broadcast, the mass actions and Campaigns (C1) all use.

It records four things:

- what existed before;
- what the Mirza research makes parity and what it leaves UNKNOWN;
- each design decision and the reason for it;
- each required regression and the test that holds it.

## 1. What existed before this package

| Piece                                 | State on `main` (a578d16)                                                                                                                                                                                                                                                                                          | Consequence for this package                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer notification lane (ADR-0030) | A closed set of kinds, pinned by a CHECK. Each kind renders one frozen template, and no kind carries a payload. Per-row claim, stamp-before-send, reaper to `UNCONFIRMED`, and a 429 put back with no attempt spent.                                                                                               | A broadcast's content is written by the operator. Carrying it on this lane would need the parameterised payload that ADR-0030 §1 refuses. The broadcast therefore gets **its own lane**, built to the same rules (§4). The two mass-action notices ARE facts with a subject, so they are two new kinds on this lane (§6). |
| Telegram transport (`telegramSend`)   | One HTTP call with an abort timeout and `redirect: 'error'`. Outcomes are retryable or permanent. A 429 carries `retry_after`.                                                                                                                                                                                     | Reused as is. Two additive lines: `sendVideo` uploads, and reading a video's `file_id`.                                                                                                                                                                                                                                   |
| WP20 retry and anti-spam              | Retry schedules per lane. `retry_after` is a floor. There is no cross-process Telegram limiter (WP20 §4 lists it as not done).                                                                                                                                                                                     | A broadcast is the first sender that needs a cross-process limiter. It is added as a per-bot pacing row (§4).                                                                                                                                                                                                             |
| Outbox and worker loops               | `LoopProgress` health, conditional-UPDATE claims, `FOR UPDATE SKIP LOCKED`, leases.                                                                                                                                                                                                                                | The same patterns throughout.                                                                                                                                                                                                                                                                                             |
| Wallet (`WalletRepository.append`)    | Append-only, with an idempotency reference unique per tenant. A `MASS_CREDIT` ledger reason was declared in Phase 0 and never used.                                                                                                                                                                                | One `MASS_CREDIT` entry per customer, with reference `bulk:<operation>:<customer>`.                                                                                                                                                                                                                                       |
| Commercial operations                 | Paid `ADD_TRAFFIC` / `ADD_TIME` are planned at settlement with an absolute target computed once. They are refused by `prepareCommercialAction`, executed by the provisioner, verified by a READ when uncertain, and never re-planned. `CHANGE_LOCATION` already had a free, orderless path (`planLocationChange`). | The mass grant plans a free `ADD_TRAFFIC` / `ADD_TIME` through a new `ProvisioningService.planGrant`, built on the same refusals and the same `plan()`. There is no new provider write path.                                                                                                                              |
| Permissions                           | `broadcasts.send` (HIGH) and `users.wallet.mass` (CRITICAL) were declared and charged by nothing.                                                                                                                                                                                                                  | Both are now charged. The package adds `broadcasts.view`, `bulk_operations.view` and `services.mass.grant`, and backfills them to the system roles.                                                                                                                                                                       |
| File staging (HF-A7)                  | Verified bytes are held in a table only until Telegram has them. Size is bounded per type and per tenant. A retention sweep clears old bytes.                                                                                                                                                                      | Broadcast media uses the same shape (§5).                                                                                                                                                                                                                                                                                 |
| Reporting's "buyer"                   | WP12 counts a customer as a buyer when they have a `PAID` order with a purpose in `SALE_ORDER_PURPOSES`.                                                                                                                                                                                                           | The audience's "purchased" uses the SAME predicate (§3).                                                                                                                                                                                                                                                                  |

## 2. Mirza parity

Source: `scratchpad/mirza-audit.md` §2 (B1 and B2) and §3. Only VERIFIED behaviour is claimed as parity.

**Kept as parity (VERIFIED):**

- **Tier × purchase history on the mass credit** (`👥 شارژ همگانی`, UBR-021 and UBR-022).
  - The tier options are all users, `f`, `n` and `n2`. The purchase options are all, with purchases, and without purchases.
  - The audience has both as independent dimensions: `segment` and `purchase`. The Web Admin draws them first, and they apply to every consumer.
  - Nexa's model of the tiers:
    - an ordinary customer is one without an ACTIVE reseller row (`f`);
    - a reseller is an ACTIVE reseller in one of the chosen tiers (`n`, `n2`, and any other tier the tenant has).
- **The mass credit's steps.** Amount per user (UBR-020) → tier → purchase history → notify or not (UBR-023). Nexa inserts the steps Mirza lacks between them: a counted preview, the total liability, a typed confirmation and a reason.
- **An asynchronous send with a cancel control that stops only messages** (UBR-023).
  - Cancelling a broadcast moves only the unattempted recipients to `CANCELLED`.
  - A mass operation's cancel moves only PENDING items. A credit already written is never reversed.
  - The broadcast and the mass credit are separate records. Cancelling one never touches the other's money or messages.
- **A one-recipient send, as on the Mirza web admin**: the audience's `customerIds` (hand-picked customers).
- **Mirza's own count-preview precedent** (the bulk price tool, SBR-029 and SBR-031). It is followed for every mass action here.

**Recorded, not claimed (UNKNOWN in the research):**

1. All of `📨 بخش ارسال پیام` (UNK-UM-018): targets, content types, confirmation, forward, pin, schedule, pause and progress. Everything in B1 beyond the points above is a Nexa addition.
2. Whether tier and purchase filters exist inside `📨 بخش ارسال پیام`. They are verified only on the mass credit.
3. Mirza's "buyer" predicate (UNK-RSV2-001: two definitions, 29,060 apart). Nexa defines its own (§3).
4. Broadcast delivery in Mirza: rate limiting, blocked-bot handling, retry, completion report and opt-out.
5. Mass-credit bookkeeping in Mirza: ledger reason, audit granularity, idempotency, crash behaviour and role gating (UNK-ADM-011).
6. Every behaviour of `🔋 حجم یا زمان همگانی` (UNK-UM-014). The whole mass traffic/time design comes from the brief and Nexa's provider rules. None of it is parity.

Mirza's absence of a count, a total and a confirmation is recorded in the research, and it is deliberately NOT copied.

## 3. The shared audience

`packages/contracts/src/audience.ts` holds the definition. `apps/api/src/modules/commerce/audience/infrastructure/audience-sql.ts` holds the ONE query builder.

**Dimensions.** Each is a predicate on an indexed fact, evaluated by PostgreSQL and bound to the tenant.

| Dimension                                                    | Fact                                                              | Index                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------- |
| hand-picked customers                                        | `customers.id`                                                    | primary key                                       |
| account status (default ACTIVE)                              | `customers.status`                                                | the row                                           |
| ordinary / reseller tiers                                    | ACTIVE `resellers` row, `tier_id`                                 | `resellers_customer_key`                          |
| purchased / never purchased                                  | `orders`: `state = 'PAID'` and `purpose` in `SALE_ORDER_PURPOSES` | `orders_customer_created_idx`                     |
| registration range, account age                              | `customers.first_seen_at`                                         | the row                                           |
| last-purchase range                                          | `max(settled_at)` of those orders                                 | `orders_customer_created_idx`                     |
| no purchase for N days                                       | no such order settled in `[asOf − N d, asOf)`                     | the same                                          |
| wallet balance range, in one currency                        | the SUM of the ledger (never a column)                            | `wallet_entries_customer_created_idx`             |
| trial used / not used                                        | any `trial_grants` row                                            | `trial_grants_customer_idx` (added)               |
| referral: referrer / referred / either / neither             | `referrals`                                                       | `referrals_referrer_idx`, `referrals_referee_key` |
| service: product, panel, state, expiring within N h, expired | ONE service matching all the given parts together                 | `services_customer_created_idx`                   |

**"Purchased"** means at least one order `PAID` with a sale purpose. This is Nexa's predicate, and it matches the business reports.

- A trial is not a purchase.
- A wallet top-up is not a purchase.
- An order refunded to the wallet is `REFUNDED`, so it no longer counts.
- An unpaid order does not count.

**Determinism.**

- `canonicalAudienceDefinition` fills every default, sorts and de-duplicates the lists, normalises instants to UTC and fixes the key order.
- `freezeAudience` stores that JSON and its sha256.
- Every relative criterion reads a bound `asOf` and never `now()`.
- A preview answers four things: the count, the reachable count (customers with a bot to message through), the fingerprint and a sample. The fingerprint is `md5` over the sorted ids.
- A consumer's confirmation carries the hash, the count and the fingerprint.
- The consumer materialises its rows with `INSERT … SELECT` from the SAME builder, in the confirming transaction. It then compares the rows it WROTE with what was confirmed. On a difference, everything rolls back as `audience.changed`.

**Freezing.** Recipient identity is frozen at confirmation. This holds for a scheduled broadcast too: scheduling delays the SENDING, not the selection. Only live safety facts are re-read when an item is processed (§4 and §6).

**API that Agent F reuses:**

- contracts:
  - `audienceDefinitionSchema`, `canonicalAudienceDefinition`, `AudienceDefinition` and `AudienceDefinitionInput`;
  - `audiencePreviewSchema`, `AUDIENCE_ROUTES` and `AUDIENCE_ERROR_CODES`.
- API:
  - `freezeAudience`;
  - `AudienceService.preview(scope, actor, input)`, charged on `users.view`;
  - `AudienceService.evaluate(scope, input, asOf?, tx?)`, with no permission check because the caller charges its own;
  - `AudienceService.sampleOf` and `AudienceService.options`;
  - `audienceCustomersQuery`, `audienceServicesQuery`, `audienceCustomerPredicate`, `audienceServicePredicate` and `fingerprintOf`.
- HTTP: `POST /audience/preview` and `GET /audience/options`.
- Web: `AudienceBuilder` and `describeAudience` (`apps/web/src/pages/audience-builder.tsx`).

## 4. Broadcast (B1)

**Content.**

- Kinds: text, photo (JPEG or PNG), video (MP4) or PDF document, with a caption for the three media kinds.
- Up to six URL buttons, `https://` or `tg://` only.
- The body is stored RAW.
- The placeholder catalogue is explicit (`BROADCAST_BODY_DEFINITION`): `{firstName}`, `{username}` and `{walletBalance}`. Each is a fact about the recipient, read at send time. No placeholder can expand into a link, a token or another customer's data.
- The body is validated by the one `validateTemplateBody` and rendered by the one `renderTemplateBody`.
- The rendered text then travels as `{message}` in the tenant's `bot.broadcast.message` template, so a header or footer is an ordinary template override.
- Plain text only, on purpose. An operator's HTML that Telegram cannot parse would be a 400 for every recipient.

**Media.**

- The HF-A7 shape: the declared type, the extension and the byte signature must agree.
- Each type has its own size bound, held by a CHECK. Staged bytes are capped at 200 MB per tenant, taken under an advisory lock.
- The retention sweep clears bytes 7 days after a broadcast ends, and from a draft left untouched for 30 days.
- The first upload through each bot stores Telegram's `file_id` for that bot (`broadcast_media_handles`). Later recipients are sent by handle.

**Preview.**

- The Web Admin renders the operator's text with the bot's own renderer and a sample name.
- **Real preview:** `POST /broadcasts/:id/test` sends the broadcast to the operator's own linked Telegram account, through the bot that account wrote to. It uses the same render, template and transport as the dispatcher.

**Safety.**

- The affected count, the reachable count and a sample.
- An explicit confirmation checkbox.
- From 1,000 recipients the count must be typed back.
- The permission gate: `broadcasts.send`, which requires `broadcasts.view`.
- An audit row for create, update, media, test, launch, pause, resume, cancel and retry.
- An outbox `BroadcastStateChanged` event on every state change.

**Durable delivery.**

- **Tables.**
  - `broadcasts` holds the frozen definition, hash, `asOf`, count and fingerprint.
  - `broadcast_recipients` holds one row per recipient: customer, bot, chat and state.
  - `broadcast_bot_pacing` holds each bot's send budget.
- **Claim.** A bot's due recipients are claimed `FOR UPDATE SKIP LOCKED`, under that bot's pacing row lock. The limit is `BROADCAST_SENDS_PER_SECOND` (20) per bot, shared by every worker replica. Telegram documents about 30 per second.
- **At most once.** The stamp moves `PENDING → SENDING`. It names the lease that was claimed, and it requires the broadcast to still be `SENDING`. It commits BEFORE the request.
  - The outcome is recorded in a second transaction.
  - A crash between the two leaves a stamped row. The reaper resolves it `UNCONFIRMED`, and it is **never re-sent**.
  - Why at most once: a duplicate promotional message to tens of thousands of chats gets a bot reported and limited, which is worse than one customer missing one message. It is also the repository's standing rule that an UNKNOWN outcome is never retried.
  - Everything that can refuse or throw — rendering, reading the facts, locating the media — happens before the stamp. So a stamped row really had a request.
- **Outcomes.**
  - A 429 puts the recipient back to `PENDING` at the later of `retry_after` and a 5-second floor, with no attempt spent. It also holds the BOT for every replica until then.
  - A timeout, a 5xx or an unreadable 2xx → `UNCONFIRMED`.
  - Blocked the bot, deactivated, or chat not found → `UNREACHABLE`. The batch carries on.
  - A refusal on the message's merits → `FAILED`. The operator may re-queue these ("retry failed"), which re-opens a COMPLETED broadcast. That is the one `COMPLETED → SENDING` edge.
  - No usable token (disabled, or a 401 or 404 from Telegram) → one attempt spent, and the broadcast is `PAUSED` with reason `BOT_UNAVAILABLE` until an operator resumes it.
  - When the audience asked for ACTIVE customers, a customer blocked after launch is `SKIPPED`. This is the one live re-check a message needs.
- **Steering.** Pause, resume and cancel are conditional transitions.
  - A repeated pause, resume or cancel is answered, not refused.
  - Cancel moves every `PENDING` recipient to `CANCELLED` in the same transaction.
  - A recipient already claimed but not yet stamped is stopped by the stamp's broadcast-state condition.
  - Cancelling never claims to recall a delivered message. The report keeps it delivered.

**Reporting.**

- Counts: total, queued, sending, sent, unconfirmed, failed, unreachable, skipped and cancelled.
- Progress: attempted over the total.
- Times: created, launched, started and completed.
- People: created by and launched by.
- The filters, written as sentences, and a content preview.
- A per-recipient page with the transport's error code, never Telegram's description.

**Telegram surface.** Broadcasts are composed and steered in the Web Admin only. Mirza's Telegram flow is UNKNOWN, and the brief names the Web Admin areas.

## 5. Safe mass actions (B2)

**Preview (dry run).**

- Wallet credit: the audience's customers, the exact count, the total liability (amount × count) and a sample.
- Traffic or time grant: the audience's services that are ACTIVE, have a finite limit in the granted dimension, and sit on panels where `ADD_TRAFFIC` or `ADD_TIME` is operable NOW (`decideOperability`, per distinct panel). The preview gives the count of services and of distinct customers, and a sample.

**Confirmation.**

- It must carry the hash, count, fingerprint, the total liability for money, a mandatory reason, and the typed count. The typed count is required for every wallet credit and for any grant of 100 or more items.
- In ONE transaction it creates the operation, materialises the items and compares them.
- An optional `notBefore` defers processing. It was added for Campaigns. The items and the confirmation are frozen at creation all the same.

**Processing: one item, one transaction.**

- The item is locked `FOR UPDATE SKIP LOCKED`. The `not_before` gate is in the claim query itself.
- The item is moved out of `PENDING` beside its effect.
- **Credit.**
  - One `MASS_CREDIT` entry, with reference `bulk:<op>:<customer>` (unique per tenant), and `WalletEntryRecorded`.
  - If the operator chose to notify, `WALLET_MASS_CREDITED` is enqueued in the same transaction.
  - Live re-checks: the scope still accepts work, the customer is not blocked (when the audience asked for ACTIVE customers), and the selling currency is unchanged.
- **Grant.** `ProvisioningService.planGrant`:
  - calls `prepareCommercialAction` as a verdict: owner, state, operability, an open commercial action, a pending deletion or refund request;
  - refuses an unlimited dimension, and a target past what a panel can hold;
  - computes an absolute target once;
  - plans an orderless `ADD_TRAFFIC` / `ADD_TIME` with `requested_by_customer_id` NULL, with an operation id derived from the operation and the service.
  - A refusal becomes `SKIPPED`, with its reason shown.
- **Settlement.**
  - A grant item becomes SUCCEEDED or FAILED only when its provisioning operation is authoritatively `SUCCEEDED`, or `FAILED` / `ABANDONED`.
  - An `UNKNOWN` operation leaves the item `PLANNED`, reported as «در انتظار بررسی نتیجه روی پنل». It is decided by the provisioner's own READ and is never replayed as a new plan.
  - `SERVICE_GIFT_APPLIED` is enqueued only for a success.
- **Exactly once.** A crash rolls back the item and its effect together. A second transaction for the same customer would meet the unique reference. A replayed confirmation (same key) is the same operation.
- **Cancel.** Only `PENDING` items are cancelled. A cancel waits on an item in flight, then finds it processed. Credits are never reversed. Planned grants run to their own end.

**Audit.** One audit row for the operation (count, liability, reason and hash). Each credit is itself an append-only ledger entry carrying the operator's admin id and the reason. A per-customer audit row would duplicate the ledger.

## 6. Contract changes, in their own commits

- `audience.ts`, `broadcasts.ts` and `bulk-operations.ts`, with their route tables and list queries.
- Permissions: `broadcasts.view`, `bulk_operations.view` and `services.mass.grant`, plus requirements from the send/mass keys to their view keys.
- Events: `BroadcastStateChanged` and `BulkOperationStateChanged`.
- Notification kinds: `WALLET_MASS_CREDITED` and `SERVICE_GIFT_APPLIED`. Their values are read from the bulk item — a reader, not a payload.
- Template keys, with Persian defaults and copy: `bot.broadcast.message`, `bot.wallet.mass_credited` and `bot.service.gift_applied`.
- `BROADCAST_MACHINE`, registered with the state-machine validator.

## 7. Migrations

- `0144_round_n_broadcast`:
  - the seven tables;
  - `trial_grants_customer_idx`;
  - the widened notification-kind CHECK;
  - the role backfill.
- `0145_round_n_bulk_not_before`: one nullable column, added after 0144 was pushed so that stacked branches could apply it in order. It can be folded into 0144 at renumbering.
- Bulk item ids are minted by the database (`gen_random_uuid()`). This is the one deliberate exception to application-generated UUIDv7: an `INSERT … SELECT` over tens of thousands of rows must not ship every id through Node, and nothing needs an item id before its row exists.

## 8. Regressions (brief, "Required validation / Broadcast")

| Requirement                                             | Test                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| preview and execution use the same frozen audience      | `broadcasts.test.ts` «freezes exactly the previewed audience…» (a moved audience is refused and nothing is materialised; a later registrant is not a recipient); `bulk-operations.test.ts` «refuses a confirmation whose audience moved…» |
| no duplicate after worker restart                       | `broadcasts.test.ts` «…a stamped send whose worker died is never sent again». Killed by reverting the reaper to `PENDING`.                                                                                                                |
| pause / resume / cancel safe                            | `broadcasts.test.ts`: «pauses, resumes and cancels safely…» and «cancelling mid-send keeps delivered messages delivered…»                                                                                                                 |
| retry-after does not drop recipient                     | `broadcasts.test.ts` «keeps a rate-limited recipient, holds the bot until retry_after…»                                                                                                                                                   |
| blocked user does not stop batch                        | `broadcasts.test.ts` «records a customer who blocked the bot and carries on…»                                                                                                                                                             |
| mass wallet credit exactly once                         | `bulk-operations.test.ts`: «…credits each customer exactly once» and «survives a crash mid-item…»                                                                                                                                         |
| cancel / resume cannot double credit                    | `bulk-operations.test.ts` «a replayed confirmation is the same operation, and cancel/resume cannot double credit»                                                                                                                         |
| UNKNOWN provider writes not blindly replayed            | `bulk-operations.test.ts` «…leaves an UNKNOWN outcome to reconciliation»; `bulk-grant-provisioner.test.ts` (the real provisioner against the Marzban fake)                                                                                |
| notBefore gate, cancel before notBefore (for Campaigns) | `bulk-operations.test.ts` «processes nothing before notBefore…». Killed by removing the gate from the claim query.                                                                                                                        |

## 9. What still needs real acceptance

- **Telegram:**
  - photo, video and PDF uploads, and reuse by `file_id`;
  - URL buttons;
  - the 429 back-off at real volume;
  - the classification of `403` and `400 chat not found` on a real bot.
- **Provider:** a mass `ADD_TRAFFIC` / `ADD_TIME` against a real Marzban and a real RickPanel. It uses the paid add-on's adapter calls, which are already accepted only where `docs/real-panel-acceptance.md` says so.
- **Operator:**
  - the Web Admin flows at realistic audience sizes;
  - the materialisation time of a very large broadcast inside the launch request, which runs within the 15-second statement timeout.
