# Campaign & Broadcast readiness (roadmap items 3–4, workstream C)

This record covers the roadmap's Campaign & Broadcast workstream, C1–C5. It extends the round N
lane (`docs/round-n-broadcast-audit.md`, `docs/round-n-campaigns-audit.md`,
`docs/round-n-close-audit.md`, `docs/broadcast-v2.md`). It does not replace it.

- C1/C2 are on `roadmap/campaign-broadcast-readiness`.
- C3/C4 are on `roadmap/campaign-advanced-safe` (§C3 and §C4 below).
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
- **The history is read on `broadcasts.view`, not `audit.view`.** It is this broadcast's own
  rows, reduced to closed facts: action, result, actor label, time, test outcome, re-queued
  count, and from/to state. The page already shows `createdBy`/`launchedBy` on the same key.
  The raw `before`/`after` never leave (pinned by «carries no raw audit payload»).

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

## Mutations

The driver is `scripts/mutate-campaign-broadcast.py`. It reverts each rule in place, runs the
named test, and restores the file from the copy it read. Every mutant below was KILLED.

| #     | Rule reverted                                                              | Test that failed                                         |
| ----- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| CB-01 | the stamp's in-transaction opt-out read (`if (input.marketing)` → `false`) | refused recipient who opts out before the re-queue       |
| CB-02 | the claim returns the customer's CURRENT bot instead of the frozen one     | sends and pins each recipient through its own FROZEN bot |
| CB-03 | the re-queue also moves UNCONFIRMED                                        | re-sends only the refusals                               |
| CB-04 | the re-queue also moves an in-flight SENDING row                           | re-sends only the refusals                               |
| CB-05 | a 429 hold applied to every bot of the tenant                              | a 429 holds the bot that got it and no other             |
| CB-06 | the per-bot read loses the bot's own row                                   | …counts the delivery per bot                             |
| CB-07 | broadcast pause button not disabled while pending                          | web: takes a steer once                                  |
| CB-08 | campaign pause button not disabled while pending                           | web: takes a run command once                            |
| CB-09 | test enabled with unsaved edits                                            | web: withholds the test and the count                    |
| CB-10 | re-queue without asking                                                    | web: asks before a re-queue                              |
| CB-11 | the launch's count/fingerprint comparison removed (frozen audience)        | broadcasts.test: freezes exactly the previewed audience  |

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
