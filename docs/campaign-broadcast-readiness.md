# Campaign & Broadcast readiness (roadmap items 3–4, workstream C)

This record covers the roadmap's Campaign & Broadcast workstream, C1–C5. It extends the round N
lane (`docs/round-n-broadcast-audit.md`, `docs/round-n-campaigns-audit.md`,
`docs/round-n-close-audit.md`, `docs/broadcast-v2.md`). It does not replace it.

- C1/C2 are on `roadmap/campaign-broadcast-readiness`.
- C3/C4 (and the D2-F1 fix) are on `roadmap/campaign-advanced-safe` (sections below).
- No migration was added. No permission, state, event or template key was added. The contract
  change is additive and has its own commit (`contracts(broadcasts): per-bot delivery, history,
and a recipient's next attempt`).

## C1 — automated readiness

The audit-first rule applied: most of C1 was already covered. The table maps each item to the
tests that pin it. The "added" column says what this round contributed.

| C1 item                 | Pinned by (already there)                                                                                                                                          | Added here (`tests/integration/broadcast-readiness.test.ts` unless named)                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| source verification     | round-n-close «a forward or copy names its source, is verified by the real preview…», «a verification names the kind it was sent as and the draft that was tested» | the test goes through the operator's own bot (asserted). The web shows the stamp's time and says the stamp proves one bot only                                                                                                                                    |
| FORWARD                 | round-n-close (same test); `tests/unit/broadcast-transport.test.ts`                                                                                                | —                                                                                                                                                                                                                                                                 |
| COPY                    | round-n-close; transport unit                                                                                                                                      | COPY + PIN to two bots: «sends and pins each recipient through its own FROZEN bot…»                                                                                                                                                                               |
| PIN                     | round-n-close «records the pin apart from the send…»                                                                                                               | pin through the recipient's own bot (same test)                                                                                                                                                                                                                   |
| pause / resume / cancel | broadcasts.test «pauses, resumes and cancels safely…», «cancelling mid-send…»                                                                                      | across two bots: «a pause stops both bots at the stamp; cancel ends what is left on both and recalls nothing»                                                                                                                                                     |
| frozen audience         | broadcasts.test «freezes exactly the previewed audience…»; round-n-close §A                                                                                        | frozen bot identity: a customer whose bot changes after launch is still sent through the frozen bot                                                                                                                                                               |
| multi-bot routing       | none (it was OQ-NC-01, manual only)                                                                                                                                | «…its own FROZEN bot…», «a source one bot cannot reach fails that bot's recipients only…», «a 429 holds the bot that got it and no other…», «one bot that cannot send pauses the broadcast; resumed, nobody on the other bot is sent twice»                       |
| per-recipient failure   | broadcasts.test «records a customer who blocked the bot…»; broadcast-v2 «reports failures by reason…»                                                              | a failure on one bot never touches the other bot's recipients                                                                                                                                                                                                     |
| requeue                 | broadcast-v2 «…retries only the refusals»                                                                                                                          | «re-sends only the refusals: never a delivered, unconfirmed, unreachable, skipped or in-flight recipient» (a re-queue fired while the re-send is in flight moves nothing); «a stamped send whose worker died is reaped UNCONFIRMED and no re-queue ever sends it» |
| promotional opt-out     | round-n-close §D (count, materialisation, stamp, policy on/off, frozen)                                                                                            | «a refused recipient who opts out before the re-queue is SKIPPED by the stamp, never sent» (the preference itself is untouched); «a service announcement still reaches an opted-out customer, through their own bot»                                              |

No defect was found in the server lane. Each new case passed against the existing code, and the
mutation table below shows each one is not vacuous.

The web layer had one defect. Broadcast steer buttons and campaign run buttons stayed enabled
while their request was pending, so a double click could submit twice. Agent 2a found it and
it is fixed here (CB-07, CB-08).

### Decisions recorded, not changed

- **A bot that cannot send pauses the whole broadcast, even when other bots are healthy.** This
  covers `BOT_UNAVAILABLE`: no token, or a 401/404 from Telegram.
  - It is the existing design: "every recipient of that bot would fail the same way until an
    operator fixes the bot and resumes".
  - It stays, because a per-bot pause would be a new state on the broadcast machine, and that
    is not in this scope.
  - The cost is that the healthy bot also waits. The test proves that, once resumed, nobody on
    the healthy bot is sent twice.
  - The per-bot card names the bot at fault: its status, and its recipients waiting for a
    retry.
- **Source verification proves one bot.** The Bot API cannot read a message by id, so a test
  through the operator's bot is the only proof there is.
  - A recipient on another bot that cannot reach the source is `FAILED telegram.rejected.400`
    for that bot's recipients only.
  - That failure is visible per bot and can be re-queued.
  - Recording which bot verified would need a column. It is not added: no migration where none
    is needed.
- **The history is read on `broadcasts.view`; who did what needs `audit.view` too** (PR #237
  review N1).
  - With `audit.view`, the card shows refused attempts and operator names. Without it, it shows
    successful facts only and no names. Who did it, and who was refused, are audit signals,
    which is the reseller-history precedent.
  - The card stays useful to a role that only reads broadcasts.
  - The facts are always closed: action, result, time, test outcome, re-queued count, and
    from/to state. The raw `before`/`after` never leave (pinned by «carries no raw audit
    payload»).
  - The card shows the newest 50 rows and says when older ones exist (`truncated`, review N4).
    The full trail is in the audit log.
- **Rolling update** (review B1). `nextAttemptAt` is optional in the contract, so the
  recipients card still reads an older API replica's rows. The two new cards answer an error
  until the update completes (`docs/deployment.md`).

## C2 — operator UX

All of it is on the existing broadcast page, built with existing kit components and no inline
style.

| C2 item                            | What the page does now                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| source selection                   | unchanged composer (chat id + message number, forward/copy note)                                                                                                                                                                                                                                                                                    |
| test send                          | each outcome in its own words. `UNCONFIRMED` says "may have arrived, not verified" and `RATE_LIMITED` says "try shortly"; before, both read as "not sent". The last answer stays on the card. Test and count are **withheld while the composer has unsaved edits**: both read the saved draft, so a test would verify a draft that is not on screen |
| verification stamp                 | shows when; a sourced draft states that each recipient's own bot sends it                                                                                                                                                                                                                                                                           |
| preview                            | unchanged (the bot's renderer)                                                                                                                                                                                                                                                                                                                      |
| audience summary / recipient count | count, reachable, and the members **with no bot** counted apart (they are frozen and recorded UNREACHABLE at once)                                                                                                                                                                                                                                  |
| pause / resume / cancel            | buttons disabled while a command is in flight (no double submit); same on the campaign page's run buttons                                                                                                                                                                                                                                           |
| failure visibility                 | every transport code has a Persian sentence beside the code; an unknown code is shown as is. `SKIPPED` no longer reads "user is blocked" for an opted-out customer                                                                                                                                                                                  |
| retry / requeue visibility         | the re-queue is asked first, with the count, and says UNCONFIRMED is never re-sent. A waiting recipient shows its **next attempt** time. The history card lists each re-queue with how many it moved                                                                                                                                                |
| multi-bot delivery status          | the **delivery per bot** card: bot, status, sent/total, pending, waiting retry, failed (+unconfirmed), unreachable/skipped, and the 429 hold "until"                                                                                                                                                                                                |

Web tests: `tests/web/broadcast-readiness.test.tsx` (9), plus the changed cases in
`tests/web/broadcast-v2.test.tsx` and `tests/web/campaigns.test.tsx` («takes a run command
once…»).

## D2-F1 — a "chat not found" on a forward or copy

The Telegram agent found this. A `forwardMessage` or `copyMessage` request names two chats:
`chat_id` (the recipient) and `from_chat_id` (the source). Telegram's
`Bad Request: chat not found` and `PEER_ID_INVALID` do not say which one is meant.

Before the fix, `classify` read these as the recipient's UNREACHABLE. That outcome is final and
never re-queued. So a source that one bot cannot reach was reported as every one of that bot's
recipients being unreachable.

The description cannot tell the two apart, so the **request's shape** decides:

- On a sourced send, these two answers are REFUSED, which is recorded as `FAILED` with the
  transport's code (`telegram.rejected.400`).
  - The page shows it per bot, with the sentence "Telegram did not accept (e.g. the bot cannot
    reach the source)".
  - It can be re-queued once the bot can reach the source.
- Answers that can only be about the recipient stay UNREACHABLE: blocked, deactivated, never
  started.
- A composed message names one chat, so for it nothing changes.

It is not routed to the broadcast-wide `BOT_UNAVAILABLE` pause. The bot works; it lacks access
to one chat. Pausing every bot for that is the over-reach this record already notes.

## C3 — advanced, only where it composes

| Item                                                                     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| campaign referral incentive from the existing referral engine            | **Not built.** The engine's terms are three tenant-wide settings read at confirmation (`ReferralProgram.terms`); there is no window and no audience. A campaign could only express an incentive by writing `referral.commission_percent` and writing it back. That rewards every referrer in the tenant, and the write-back is a lost update over an operator's edit made in between. Changing `commission_scope` re-terms everybody who registers in the window for life (it is snapshotted per attribution). A per-recipient `{referralLink}` placeholder is not a cleaner route either: the link comes from `ReferralProgram.invite`, which is a WRITE (it records the code) plus a live `getMe` per bot, so the dispatcher would gain a write path and a Telegram dependency per recipient. Recorded as OQ-C1-02 (unchanged). |
| better audience scoping with existing primitives                         | **Built: the audience by bot** (`botInstanceIds`) — see below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| attribution and analytics from persisted effects and the frozen audience | **Built: `audienceAttribution`** on campaign results — see below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**The audience by bot.**

- A customer is reached through `customers.first_bot_instance_id`. That is the bot a broadcast
  freezes onto each recipient row, and the one it sends through.
- One predicate in the one audience builder, so the preview, a broadcast, a mass action and a
  campaign all read it the same way.
- Canonical form:
  - The key is appended only when it narrows, so every hash stored before it still matches
    (unit test).
  - An empty list is refused rather than read as "every bot".
- An id of another tenant's bot selects nobody, and a customer who never wrote to a bot is
  selected by no bot.
- The options list each bot's id, username and status, and never a token (integration test).
- The builder draws the section only for a tenant with more than one bot.

**Attribution.**

- Built from persisted rows only:
  - the announcement's `broadcast_recipients`, which are its frozen audience. Unlike
    `frozen_audience_members` they are never released, so the figure survives the campaign;
  - the campaign discount's `discount_redemptions`, counted only where the order is PAID.
- Distinct customers: told, delivered, redeemers among those told, redeemers among those
  delivered, and redeemers who were never told. The last group exists because the rule's scope
  is not the audience (OQ-C1-01).
- Null unless the campaign has both an announcement and a discount.
- The page says in words that this is not a cause, and the old pin that the results carry no
  revenue or conversion field still holds.

## C4 — the promotional opt-out

**No override was built.** The customer's `/stop` is authoritative.

- An operator override for a MARKETING send would, by construction, send promotion to someone
  who asked not to receive it.
- Requiring a reason and a permission changes who is accountable. It does not change what the
  customer receives.
- The installation already has two explicit, non-silent controls:
  - the `SERVICE_ANNOUNCEMENT` purpose, for facts about the customer's own service, composed and
    confirmed on the Broadcast page;
  - the owner-level `customer_marketing_opt_out` flag (spec §9), which is tenant-wide and never
    erases a stored preference.

**A silent bypass was found and closed.**

- The campaign form offered "service announcement" for a campaign's announcement.
- Such a campaign is promotional by what it is: an offer or a gift.
- Had the choice been honoured, it would have reached every opted-out customer with no reason
  given.
- In fact the repository never persisted the purpose (`configToJson` dropped it), so every
  campaign announcement already went as MARKETING. The form offered a choice it ignored.
- Now:
  - `SERVICE_ANNOUNCEMENT` on a campaign is refused at create, edit and schedule
    (`campaign.announcement_purpose_invalid`), including a draft stored before the rule.
  - The hand-over sends MARKETING.
  - The form says the announcement is promotional and that a service fact is a Broadcast of
    its own.
- The tests show an opted-out customer SKIPPED on a campaign's announcement, with their
  preference untouched.

## C5 — not built

- No repin or unpin loop: one pin attempt per recipient, as before.
- No paid broadcast: `allow_paid_broadcast` is never passed.
- No opt-out bypass (above).
- No caption rewrite on a COPY.

## Mutations

The driver is `scripts/mutate-campaign-broadcast.py`. It reverts each rule in place, runs the
named test, and restores the file from the copy it read. Every mutant below was KILLED.

| #     | Rule reverted                                                                               | Test that failed                                                         |
| ----- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| CB-01 | the stamp's in-transaction opt-out read (`if (input.marketing)` → `false`)                  | refused recipient who opts out before the re-queue                       |
| CB-02 | the claim returns the customer's CURRENT bot instead of the frozen one                      | sends and pins each recipient through its own FROZEN bot                 |
| CB-03 | the re-queue also moves UNCONFIRMED                                                         | re-sends only the refusals                                               |
| CB-04 | the re-queue also moves an in-flight SENDING row                                            | re-sends only the refusals                                               |
| CB-05 | a 429 hold applied to every bot of the tenant                                               | a 429 holds the bot that got it and no other                             |
| CB-06 | the per-bot read loses the bot's own row                                                    | …counts the delivery per bot                                             |
| CB-07 | broadcast pause button not disabled while pending                                           | web: takes a steer once                                                  |
| CB-08 | campaign pause button not disabled while pending                                            | web: takes a run command once                                            |
| CB-09 | test enabled with unsaved edits                                                             | web: withholds the test and the count                                    |
| CB-10 | re-queue without asking                                                                     | web: asks before a re-queue                                              |
| CB-11 | the launch's count/fingerprint comparison removed (frozen audience)                         | broadcasts.test: freezes exactly the previewed audience                  |
| CB-17 | a test send no longer refreshes the history (Codex P2 on PR #237)                           | web: reads the history again after a test                                |
| CB-19 | "waiting for a retry" counts every PENDING row (review N2)                                  | a 429 holds the bot that got it and no other                             |
| CB-20 | refused rows shown without `audit.view` (review N1)                                         | without audit.view, shows the successful facts only                      |
| CB-21 | operator names shown without `audit.view` (review N1)                                       | the same                                                                 |
| CB-22 | the history never says it is truncated (review N4)                                          | says when older history rows exist beyond the cap                        |
| CB-12 | the bot predicate dropped from the one audience builder                                     | audience-bots: selects the customers of the named bots only              |
| CB-13 | a campaign announcement may be a service announcement                                       | campaigns: refuses a campaign announcement called a service announcement |
| CB-14 | schedule no longer re-checks a stored announcement's purpose                                | campaigns: refuses to schedule a draft saved before the rule             |
| CB-15 | attribution counts unpaid redemptions                                                       | campaigns: sets the discount's PAID redeemers against who was told       |
| CB-16 | attribution's "delivered" ignores the recipient's state                                     | the same                                                                 |
| CB-18 | a sourced send's "chat not found" read as the recipient's unreachability (D2-F1)            | unit: broadcast-transport, both D2-F1 cases                              |
| CB-23 | a 409 on a campaign run command no longer re-reads the campaign (web foundation `settleOn`) | web: reads the campaign again when a run command is refused as stale     |

## Manual acceptance — NOT RUN

These need a real Telegram bot, so they are written here and not run. Run them on staging only,
never in production.

1. **Two bots, one tenant.**
   - Register customers through bot A and bot B.
   - Compose a TEXT MARKETING broadcast to everyone, test it, count, and launch.
   - Expected: each customer receives the message from the bot they first wrote to.
   - Expected: the delivery-per-bot card shows both bots, and the rows sum to the totals.
2. **COPY from a channel that only bot A administers.**
   - Test it; the stamp appears.
   - Launch to customers of A and B.
   - Expected: A's recipients SENT. B's recipients FAILED, with the sentence "Telegram did not
     accept…" and the code `telegram.rejected.400`.
   - Add bot B to the channel, then press re-queue and confirm.
   - Expected: only B's recipients receive it, once. History shows the re-queue with its count.
3. **FORWARD and PIN.**
   - Forward a channel post with pin on.
   - Expected: each recipient sees the forwarded header and the pin in their private chat.
   - Expected: the pin column reads "pinned".
4. **429.**
   - Send a broadcast to a large staging audience, at least a few thousand.
   - Expected: when Telegram answers 429, that bot's row shows "until …" and its recipients
     "waiting retry".
   - Expected: the other bot keeps sending.
   - Expected: nobody receives twice. Spot-check about 20 chats.
5. **Revoked token on one bot.**
   - Revoke bot B's token in BotFather mid-send.
   - Expected: the broadcast PAUSES with "bot unavailable", and the per-bot card names bot B.
   - Restore the token and resume.
   - Expected: B's recipients are sent; A's are not sent again.
6. **Opt-out.**
   - A customer sends `/stop` mid-broadcast.
   - Expected: their row is SKIPPED with the sentence "opted out of promotional messages".
   - Expected: a SERVICE_ANNOUNCEMENT afterwards still reaches them.
7. **Test outcomes.**
   - Test with the operator's Telegram blocked (expected: "not sent"), and while rate-limited
     (expected: "try shortly").
   - Expected: no verification stamp appears for either.
8. **Double click.**
   - Click pause twice quickly on a sending broadcast, and on an active campaign.
   - Expected: one audit row each in the history.
9. **The audience by bot (C3).**
   - On a tenant with two bots, build an audience with only bot B ticked.
   - Expected: the count equals bot B's customers.
   - Expected: the launched broadcast's per-bot card shows bot B only.
10. **D2-F1.**
    - COPY a post from a channel that bot B is not in.
    - Expected: B's recipients are FAILED with `telegram.rejected.400`, not "unreachable".
    - Add bot B to the channel and re-queue.
    - Expected: they receive it once.
11. **Attribution (C3).**
    - Run a discount + announcement campaign on staging.
    - Pay one order as a told customer and one as a customer registered after the confirmation.
    - Expected: the results card shows 1 told redeemer and 1 not told.
