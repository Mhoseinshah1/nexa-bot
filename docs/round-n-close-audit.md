# Round N close — frozen audiences, pause/resume, forward/copy/pin, the promotional opt-out

The fourth package of the post-round-N brief (`docs/…/p-brief.md`, "PACKAGE ROUND-N-CLOSE").
It closes what the round N audits recorded as safe-but-not-live, and adds the three
Broadcast behaviours the owner asked for as Nexa features. Written against `39c5d53` (the
head of PR #118, which contains #117) and merged with `origin/main` `d4f00df` once both had
landed; the merge brought history only.

Sections: §1 what existed and what was wrong with it; §2 the Bot API, cited; §A–§D one per
requirement; §5 the regressions and the mutation evidence; §6 what still needs real
acceptance; §7 what is deliberately not built.

## 1. What existed before this package

| Piece                                    | State on `39c5d53`                                                                                                                                                                                                                                                                                            | What this package does                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The shared audience (`audience-sql.ts`)  | One query builder; a definition selects "whoever matches now". A consumer freezes recipient IDENTITY by materialising its own rows (`broadcast_recipients`, `bulk_operation_items`) in its confirming transaction. `customerIds` is capped at 100 (`AUDIENCE_CUSTOMER_IDS_MAX`) because it is a request body. | A durable, id-addressed member set a confirmation can freeze and every engine can copy from (§A). The cap stays: it protects a request body, and a frozen audience is a row set. |
| Campaign hand-over (`CampaignService`)   | The confirmation commits, then each engine is called with the campaign's DEFINITION and the binding (count, fingerprint). A retry after the live set moved refuses `audience.changed`; the page says "cancel and re-make" (OQ-C1-04, §5.3 of the campaigns audit).                                            | The confirmation freezes the set in its own transaction; the hand-over seeds the engines from it; the retry succeeds with exactly the confirmed members (§A).                    |
| Mass operations (`BulkOperationService`) | `RUNNING → COMPLETED \| CANCELLED`; no pause. The campaigns audit §5.4/§5.5 records "a PAUSED campaign's gift keeps processing".                                                                                                                                                                              | `PAUSED`, with a machine, and a campaign pause that reaches its gifts (§B).                                                                                                      |
| Broadcast content                        | TEXT, PHOTO, VIDEO, DOCUMENT composed by the operator; one purpose (none declared); no pin.                                                                                                                                                                                                                   | FORWARD and COPY of an existing Telegram message; a per-recipient pin; a declared purpose (§C, §D).                                                                              |
| Customer preferences                     | None. Every customer of an audience is a recipient; only a BLOCKED status is re-read at send time.                                                                                                                                                                                                            | A persisted, tenant-scoped promotional opt-out the customer sets on Telegram (§D).                                                                                               |

## 2. The Bot API, as cited

`core.telegram.org` is not reachable from this container (the egress proxy refuses the
host). The text below is Bot API **10.3** (release date 24 August 2026) as published in
PaulSonOfLars' machine-readable mirror of the official page
(`https://raw.githubusercontent.com/PaulSonOfLars/telegram-bot-api-spec/main/api.json`,
fetched on 2026-09-30) and cross-read against grammY's typed copy of the same text. Live
behaviour on a real bot is still owed (§6).

- **`forwardMessage`** — "Use this method to forward messages of any kind. Service messages
  and messages with protected content can't be forwarded. On success, the sent Message is
  returned." Required: `chat_id`, `from_chat_id` ("Unique identifier for the chat where the
  original message was sent (or username of the target bot, supergroup or channel in the
  format @username)"), `message_id` ("Message identifier in the chat specified in
  from_chat_id"). Optional: `message_thread_id`, `direct_messages_topic_id`,
  `video_start_timestamp`, `disable_notification`, `protect_content`, `message_effect_id`,
  `suggested_post_parameters`. There is **no `reply_markup`**: a forward cannot carry
  buttons. A forwarded message keeps its "forwarded from" attribution; that is the
  difference the next method states.
- **`copyMessage`** — "Use this method to copy messages of any kind. Service messages, paid
  media messages, giveaway messages, giveaway winners messages, and invoice messages can't be
  copied. A quiz poll can be copied only if the value of the field correct_option_ids is
  known to the bot. The method is analogous to the method forwardMessage, but the copied
  message doesn't have a link to the original message. Returns the MessageId of the sent
  message on success." Required: `chat_id`, `from_chat_id`, `message_id`. Optional among
  others: `caption` ("If not specified, the original caption is kept."), `parse_mode`,
  `caption_entities`, `show_caption_above_media`, `disable_notification`, `protect_content`,
  `allow_paid_broadcast`, `reply_parameters`, `reply_markup` (InlineKeyboardMarkup …).
- **`pinChatMessage`** — "Use this method to add a message to the list of pinned messages in
  a chat. In private chats and channel direct messages chats, all non-service messages can be
  pinned. Conversely, the bot must be an administrator with the 'can_pin_messages' right or
  the 'can_edit_messages' right to pin messages in groups and channels respectively. Returns
  True on success." Required: `chat_id`, `message_id`. Optional: `business_connection_id`,
  `disable_notification` ("Pass True if it is not necessary to send a notification to all
  chat members about the new pinned message. Notifications are always disabled in channels
  and private chats.").
- **`unpinChatMessage`** — "Use this method to remove a message from the list of pinned
  messages in a chat. In private chats and channel direct messages chats, all messages can be
  unpinned. Conversely, the bot must be an administrator with the 'can_pin_messages' right or
  the 'can_edit_messages' right … Returns True on success." Optional `message_id`: "If not
  specified, the most recent pinned message (by sending date) will be unpinned." Not called
  by this package (§7).
- **Reading a message by id.** The Bot API has no method that returns a message by chat and
  id. So a source is validated the only way the API offers: by performing the send the
  broadcast will perform, to the operator's own chat (§C).
- **Broadcasting limits.** The one sentence the spec itself carries is on `copyMessage`'s
  `allow_paid_broadcast`: "Pass True to allow up to 1000 messages per second, ignoring
  broadcasting limits for a fee of 0.1 Telegram Stars per message." The lane keeps
  `BROADCAST_SENDS_PER_SECOND` (20 per bot, under the ~30/s the Bot API FAQ documents) and
  never passes `allow_paid_broadcast`.

Every recipient of a broadcast is a **private chat** (`chat_id` is the customer's Telegram
user id), so the pin needs no right the bot does not already have wherever it can send.

## A. The durable frozen audience (closes OQ-C1-04)

**Tables.** `frozen_audiences` (header: `kind` CUSTOMERS \| SERVICES, `definition`,
`definition_hash`, `as_of`, `member_count`, `fingerprint`, `created_by_admin_id`,
`released_at`) and `frozen_audience_members` (customer, service or null, the bot the customer
would be messaged through, the chat). Members are written by ONE `INSERT … SELECT` over the
same audience query the preview counted, in the CONFIRMING transaction, and the header's
count and fingerprint are computed from the rows written — never from a second evaluation.
After the commit nothing updates a member. Tenant-scoped everywhere; the header carries the
tenant and every reference joins on it.

**Who freezes.** `CampaignService.schedule` freezes the CUSTOMERS the campaign confirmed by
the same query at the same instant its `audience.changed` comparison read, and refuses if
the rows written differ from the count and fingerprint just confirmed. The one customer set
is shared by the announcement and the wallet gift. A traffic or time gift freezes its own
SERVICES set through `BulkOperationService.freezeServiceAudience`, which writes the members
from the mass-action engine's own eligibility query (ACTIVE, finite allowance, operable
panel), compared with the binding the gift's preview produced. Each launched action stores
its `frozen_audience_id` beside its binding (`campaign_actions.frozen_audience_id`).

**Who copies.** `BulkOperationService.create` and `BroadcastService.create` take a
`frozenAudienceId`. The items or recipients are COPIED from the members — a customer who
joined the definition since is not one, one who left it still is — with no size cap, and
the rows written must equal the frozen header's count and fingerprint or the transaction
rolls back (`audience.frozen_released`). The confirmation must still name the frozen header's
own hash, count and fingerprint, and the frozen audience must be this tenant's, of the kind
the grant needs, and still held (`audience.frozen_not_found` / `frozen_released` /
`frozen_kind_mismatch`). The record stores the id (`bulk_operations.frozen_audience_id`,
`broadcasts.frozen_audience_id`).

A SERVICES set is bound to the GRANT it was selected for (`frozen_audiences.grant_kind`,
`SERVICE_TRAFFIC` or `SERVICE_TIME`, NOT NULL exactly for SERVICES by CHECK): its members
were written by that grant's own eligibility rule — the panels that can `ADD_TRAFFIC` are
not the panels that can `ADD_TIME` — so a set frozen for a traffic grant seeds no time
grant, and the reverse, `frozen_kind_mismatch` (review finding 6). A frozen draft's preview
reports the set's `reachable` part from the member rows held (a member with a bot
recorded), not its count, because the launch writes the rest `UNREACHABLE` and the
confirmation should say so first (finding 3).

**The hand-over retry.** `CampaignService.handOver` passes the action's frozen id, so a retry
after an interruption — the confirmation replayed, or «سپردن دوبارهٔ اقدامات در انتظار» —
seeds the engine from the same members whatever the live audience did in between. An action
confirmed by the release before this one carries no frozen id and keeps the old path.

**Live safety at the write, unchanged.** A frozen set decides WHO. Whether money or a
provider write is still safe is decided at the item: a blocked customer (when the audience
asked for ACTIVE) → `SKIPPED CUSTOMER_BLOCKED`; a service no longer ACTIVE, not owned, or on
an inoperable panel → `planGrant`'s refusal → `SKIPPED`, never a plan; a customer who opted
out of promotions → `SKIPPED broadcast.marketing_opted_out` (§D). A skip is a recorded
outcome with a reason and never a credit.

**Cleanup.** Every reference to a header is `ON DELETE RESTRICT`, so no cleanup can drop a
header something names. The member rows are released by a sweep (`releaseUnreferenced`, run
by the campaign lane beside its two edges as `releaseOnce`) only when EVERY campaign action's
campaign, mass operation and broadcast naming the audience has ended (COMPLETED/CANCELLED)
and the audience is at least `FROZEN_AUDIENCE_RELEASE_AFTER_DAYS` (1) old. A DRAFT
broadcast holds nothing: the hand-over creates the announcement's draft and launches it in
two commits, and a draft the process died between (or one an operator abandoned) would
otherwise hold its members for ever once the campaign ended (finding 7). The launch reads
the header again and refuses a released set (`frozen_released`), so a draft that outlived
its set is refused, never sent blind. Never by age
alone: a campaign confirmed fifty-nine days ahead keeps its members. The header, with its
count, fingerprint, definition and hash, is never deleted: it is the record of what was
confirmed. A released audience seeds nothing (`frozen_released`).

**Contracts.** `FROZEN_AUDIENCE_KINDS`, `frozenAudienceSchema`, three error codes,
`frozenAudienceId` on the two create requests and on the bulk operation, broadcast and
campaign action views (`cff1d59`, `cd88eee`, `7c2440e`).

## B. Pause and resume on a mass operation, and from a campaign

`BULK_OPERATION_MACHINE`: `RUNNING → PAUSED` (PAUSE), `PAUSED → RUNNING` (RESUME),
`RUNNING → COMPLETED` (COMPLETE), `RUNNING | PAUSED → CANCELLED` (CANCEL); COMPLETED and
CANCELLED terminal; registered with `STATE_MACHINES`. Every edge is a conditional UPDATE
naming its `from` states (`transition`, `cancel`).

- **A paused operation claims no new PENDING item.** The processor's claim query names
  `o.state = 'RUNNING'` (unchanged); PAUSED is simply not RUNNING.
- **Completed effects are never rolled back.** Cancel moves PENDING items only, from either
  running state; a credit written or a grant planned stays.
- **An ambiguous provider write finishes its reconciliation while paused.** `settlePlanned`
  reads PLANNED items against the provisioning operation's authoritative end regardless of
  the operation's state — a reconciliation READ is not new work — and `completeFinished`
  closes RUNNING operations only, so a paused operation whose last item settles is not closed
  under the operator who meant to resume it.
- **Resume continues exactly once.** `PAUSED → RUNNING` is conditional; a replayed resume
  finds RUNNING and is answered (`if (current.state === to) return`). Nothing is done twice
  because the ITEMS decide: each moves out of PENDING once, whatever the operation did.
- **Campaign propagation.** `CampaignService.pause` and `resume` steer each gift's operation
  from the state it is in (RUNNING → pause, PAUSED → resume) through the same replay-aware
  `steerEngines` the announcement uses (#118), so a replayed campaign command, or an operation
  resumed by hand on its own page, is left alone rather than fought. The campaign page and
  the campaigns audit no longer say a paused campaign's gift keeps processing.
- **A hand-over retried under a paused campaign lands paused.** `launchPending` is
  callable while the campaign is PAUSED, and a pause that committed before the engine record
  existed found nothing to stop. After the link commits, `reconcile` reads the campaign and
  the action AGAIN — only then, so every edge that commits from there on sees the link and
  propagates itself, and every edge that committed before is seen here — and pauses a
  RUNNING operation or a SENDING broadcast exactly as `pause` would, or cancels them for an
  action CANCELLED meanwhile (finding 4; the cancel half is what `compensate` did).

## C. Forward, copy and pin

**Content kinds.** `FORWARD` and `COPY` join `BROADCAST_CONTENT_KINDS`, sourced from
`broadcastSourceSchema` — a chat id (`-100…` for a channel, a negative group id, a private
user id, or a public `@username`) and a message number. No bot token, invite link or secret
is taken: a chat id and a message number identify a message and grant nothing; the bot
sending to each recipient must itself be able to reach the source. A FORWARD carries no text
of ours and no buttons (`forwardMessage` takes no `reply_markup`); a COPY carries no text of
ours (the original caption is kept) and may carry the ordinary URL buttons. The transport
issues `forwardMessage` / `copyMessage` with `chat_id`, `from_chat_id`, `message_id` (and
the inline keyboard for a COPY); `telegramSend` reads `message_id` from both the `Message`
and the `MessageId` answer.

**Validation by a real preview.** There is no read-by-id, so `POST /broadcasts/:id/test`
performs the broadcast's own forward or copy to the operator's linked Telegram through the
bot they wrote to. A test that reached them stamps `source_verified_at` — bound to the draft
that was TESTED: the stamp is a conditional UPDATE naming the version, kind and source the
test read, so an edit committed while the send was in flight leaves the edited draft
unverified (finding 2). A draft edit that changes the source OR the kind clears it — a
COPY turned FORWARD is a different request to Telegram (finding 1); a launch of a sourced
kind refuses `SOURCE_UNVERIFIED` until one has. The page says so, and withholds the launch button until the stamp is there.

**Same lane.** Frozen audience, scheduling, pause, cancel, pacing, the 429 hold, the
blocked-customer and opt-out skips, the report and the recipients page are the ones every
broadcast has; per-recipient **stamp-before-send** is unchanged and a stamped forward whose
worker died is reaped UNCONFIRMED and never sent twice.

**Pin.** `broadcasts.pin`; per recipient: `sent_message_id`, `pin_state`
(`PENDING | PINNED | FAILED | UNCONFIRMED`), `pin_error_code`, `pin_started_at`. The pin is
STAMPED PENDING in the very write that records the send SENT (same instant, same row), the
one `pinChatMessage` request follows that commit, and `recordPin` names the stamp so a row
the reaper resolved meanwhile takes no write. **Bounded attempts: exactly one.** A 429 on a
pin is that attempt's FAILED (`telegram.rate_limited`) and never holds the bot; a timeout or
5xx is UNCONFIRMED; a stamped pin never answered is reaped UNCONFIRMED after the lease. The
send outcome is untouched by any of it: SENT stays SENT, the counts gain `pinned` and
`pinFailed`, and the recipients page shows the pin column beside the state. The composer
states in words what pinning does (private chat, one attempt, recorded apart, replaces the
customer's previous pin).

## D. The promotional opt-out

**The preference.** `customers.marketing_opt_out_at` (tenant-scoped by the row it is on).
`CustomerService.setMarketingOptOut` is the customer's own write from their Telegram turn:
authorised by `maintenance.run` as every customer-initiated write on the webhook path is,
idempotent under the update's key in the actor's own namespace, a conditional UPDATE naming
the state it expects, audited (`customer.marketing_opt_out` / `customer.marketing_opt_in`),
and a `CustomerMarketingOptOutChanged` event in the same transaction.

**The Telegram path.** `/stop` (registered in `BOT_COMMANDS` with `bot.command.stop`, listed
in `bot.help`'s default) and the `mk:out` button opt out; the `mk:in` button on the reply and
on the support screen opts back in; the support screen always shows the reverse of what the
customer holds. Both intents are exempt from the channel-membership guard: a customer who
has not joined must still be able to say stop. `bot.marketing.opted_out` says what still
arrives. Placement is a real command plus a button on an existing customer screen, as
agreed with the MENU package; the only change in its area is the one `BOT_COMMANDS` entry.

**Purpose.** Every broadcast has `purpose` — `MARKETING` (default) or
`SERVICE_ANNOUNCEMENT` — and a campaign's announcement carries one too. For MARKETING the
opted-out are excluded at the COUNT and the MATERIALISATION (`excludeMarketingOptOuts` on
the evaluation, applied to the preview and the launch alike so the count confirmed is the
count frozen); a frozen-seeded MARKETING launch writes an opted-out member `SKIPPED
broadcast.marketing_opted_out` rather than dropping it from the confirmed count; and the
STAMP re-reads the preference — in the stamping transaction, under the customer's row lock
(`FOR SHARE`), so an opt-out in flight commits first and is seen, or waits and lands after
a send already decided; read before the stamp and outside it, the same fact could commit
between the two (finding 5). A SERVICE_ANNOUNCEMENT asks nothing of it. A BLOCKED
customer's `/stop` is still their preference: blocking stops what they can buy, and a
MARKETING send to an audience that admits blocked customers reads this row, so the two
intents are routed past the blocked gate (finding 8). The exclusion is not part of the definition or its hash: it is a fact about the send.

**What it does not touch.** ADR-0030's lane has no dependency on the preference and reads
no such column — a payment, service, ticket or wallet notice is a fact about the customer's
own account and still arrives. Gifts are not messages: a wallet credit reaches the frozen
customers whether they opted out or not, and its transactional notice with it. Proven by
"a transactional notice on ADR-0030's lane still reaches an opted-out customer".

**Web Admin.** The customer page shows the preference and its date, read-only, with the
sentence that the customer decides it. No operator override is built (§7).

## 5. Regressions and mutation evidence

`tests/integration/round-n-close.test.ts` (17 cases), `tests/integration/customer-block-surface.test.ts
› a blocked customer's /stop still records their preference…`, and the rewritten
`tests/integration/campaigns.test.ts › a delayed hand-over gifts exactly the confirmed set,
however the audience moved since`; `tests/unit/broadcast-transport.test.ts` (the Bot API
bodies, `classifyPin`); `tests/unit/marketing-opt-out.test.ts`.

| Brief regression                                      | Pinned by                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| retry after audience change uses the frozen members   | campaigns.test.ts «a delayed hand-over gifts exactly the confirmed set…»; round-n-close «a retried hand-over gifts and messages exactly…»         |
| no gift to a newly-added member                       | the same two, and «a service gift freezes its services; a service eligible only later gets nothing, one no longer active is SKIPPED»              |
| pause stops new claims                                | «a paused operation claims nothing new, resumes exactly once, and a cancel reverses nothing done»                                                 |
| reconciliation may finish safely while paused         | «an ambiguous provider write finishes its reconciliation while paused; a PENDING item waits»                                                      |
| resume exactly once                                   | «…resumes exactly once…»; «a campaign pause and resume propagate to its gift idempotently…»                                                       |
| cancel never reverses completed work                  | «…a cancel reverses nothing done»                                                                                                                 |
| opt-out excludes marketing only                       | «excludes an opted-out customer from MARKETING at the count, the materialisation and the send, and from nothing else»; «…frozen audience…SKIPPED» |
| transactional notifications unaffected                | «a transactional notice on ADR-0030's lane still reaches an opted-out customer»                                                                   |
| forward/copy remains restart-safe (stamp-before-send) | «a forward or copy names its source, is verified by the real preview, and stays send-once across a restart»                                       |
| pin failure separated from the send result            | «records the pin apart from the send…and a pin is attempted once»                                                                                 |
| cleanup only when nothing references the frozen set   | «releases a frozen audience only once nothing live names it, and never its header»                                                                |

**Mutations** (`scratchpad/mutate.py`, `mutate-nc.py`: each rule reverted in place, the
named test run, the file restored with `git checkout`; every row below FAILED under its
mutation and passed restored):

| #   | Rule reverted                                                             | Test that failed                                             |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| M1  | claim query names PAUSED as well as RUNNING                               | claims nothing new                                           |
| M2  | completion sweep closes a PAUSED operation                                | ambiguous provider write (the paused-with-nothing-left tail) |
| M3  | cancel moves every item, credited ones included                           | claims nothing new (…cancel reverses nothing)                |
| M4  | hand-over passes `frozenAudienceId: null`                                 | campaigns: gifts exactly the confirmed set                   |
| M5  | a frozen create re-selects the live definition instead of copying members | never a newcomer                                             |
| M6a | the opt-out predicate dropped from the one audience query                 | excludes an opted-out customer                               |
| M6b | the stamp's in-transaction opt-out read removed (`marketing: false`)      | excludes an opted-out customer; an opt-out that lands after… |
| M7  | a frozen-seeded MARKETING launch writes an opted-out member PENDING       | seeded from a frozen audience                                |
| M8a | `classifyPin` answers PINNED for a refusal                                | unit: three outcomes apart                                   |
| M8b | stranded pins never reaped                                                | records the pin apart                                        |
| M9  | a launch no longer requires a verified source                             | names its source                                             |
| M10 | an edited source keeps its verification                                   | names its source                                             |
| M11 | the release sweep ignores a live campaign                                 | releases a frozen audience                                   |
| M12 | reconciliation waits for a resume (`settlePlanned` restricted to RUNNING) | ambiguous provider write                                     |
| M13 | a campaign pause no longer reaches its gift                               | propagate to its gift                                        |
| M14 | the pin is never requested after the stamp                                | records the pin apart                                        |
| M15 | `updateDraft` keeps a verification when only the kind changes             | a verification names the kind                                |
| M16 | a frozen draft's preview reports the count as reachable                   | counts the reachable part                                    |
| M17 | a SERVICES set seeds a grant of the other kind                            | bound to the grant                                           |
| M18 | the release sweep treats a DRAFT broadcast as live                        | a draft the hand-over left behind                            |
| M19 | a hand-over linked under a PAUSED campaign is not paused                  | lands paused                                                 |
| M20 | `markSourceVerified` stamps whatever draft is there now                   | a verification names the kind (the in-flight edit)           |
| M21 | a blocked customer's `/stop` answered `bot.blocked`, recording nothing    | block-surface: a blocked customer's /stop                    |

M2 and M11 were green on the first run; each named a missing case (a paused operation whose
last item settles; an audience named by a campaign action alone, before its hand-over), and
the cases were added before the rule was counted as tested. M8a is reachable only through the
transport unit test, which the driver now runs.

### 5.1 Review findings on PR #120 (Codex review 5364415850)

Each was validated against the code before anything was changed; all eight were confirmed.

| #   | Finding                                                                      | Verdict and fix                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `updateDraft` kept `source_verified_at` when only `content_kind` changed     | CONFIRMED: the CASE compared chat and message only. Now `content_kind` too (M15).                                                                                 |
| 2   | `markSourceVerified` stamped unconditionally after the test send             | CONFIRMED: an edit committed during the send was verified by a test of the draft before it. The stamp names version, kind and source as tested (M20).             |
| 3   | a frozen draft's preview reported `reachable: frozen.count`                  | CONFIRMED: a member with no bot is written UNREACHABLE by the launch. `reachable` is read from the rows held (M16).                                               |
| 4   | `launchPending` linked an engine under a PAUSED campaign and left it running | CONFIRMED: `pause` had found nothing to stop. `reconcile` re-reads the campaign after the link and pauses, or cancels, what it made (M19).                        |
| 5   | the opt-out re-read ran outside the stamping transaction                     | CONFIRMED: an opt-out committing between the read and the stamp was sent to. The stamp reads it in its own transaction under `FOR SHARE` (M6b, re-cut).           |
| 6   | a frozen SERVICES set was not bound to the grant subtype                     | CONFIRMED: traffic and time eligibility differ per panel. `grant_kind` on the header, CHECKed, refused on mismatch (M17; contract `FROZEN_AUDIENCE_GRANT_KINDS`). |
| 7   | a DRAFT the hand-over left behind held the audience for ever                 | CONFIRMED: `NOT IN ('COMPLETED','CANCELLED')` counted DRAFT as live. A draft holds nothing; the launch refuses a released set (M18).                              |
| 8   | a BLOCKED customer could not opt out                                         | CONFIRMED: the blocked gate answered `bot.blocked` before `act`. The two intents are routed to `marketingPreference` from the gate (M21).                         |

## 6. What still needs real acceptance

- **Telegram, on a real bot:** `forwardMessage` and `copyMessage` from a channel the bot
  administers and from a chat it is in; the exact refusals for a source the bot cannot reach
  (recorded per recipient as `telegram.rejected.400`, `FAILED`, re-queueable); the kinds the
  spec says cannot be copied (service, paid media, giveaway, invoice, quiz); `pinChatMessage`
  in a private chat with no right, and what a customer who had a pinned message sees when the
  pin replaces it; a 429 on a pin.
- **Several bots:** a tenant whose customers wrote to different bots sends each through
  their own bot; a source reachable by one bot and not another fails those recipients only.
  Recorded as OQ-NC-01.
- **Operator:** the composer flow — source, test, verification stamp, launch — on a real
  channel post; the campaign page after a hand-over retry.

## 7. Deliberately not built

- An operator override of a customer's opt-out. The brief asks for an audited privileged
  override "only if such override is implemented"; it is not, so the Web Admin is read-only
  on it (OQ-NC-02).
- `unpinChatMessage`, and any re-pin: one attempt per recipient is the bound.
- A caption of ours on a COPY (`copyMessage.caption`): the source is sent as it is.
- Any change to ADR-0030's lane.
