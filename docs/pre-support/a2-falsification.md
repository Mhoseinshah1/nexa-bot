# Pre-support A2 — refresh on open: falsification

Item A2 of the pre-support remaining-fixes audit (2026-10-05). Opening a service card
(`s:` → `SERVICE`, `sv:` → `SERVICE_CARD`) now makes a bounded live read before the card is
drawn. The rule lives in `BotRuntime.openServiceCard`
(`apps/api/src/surfaces/telegram/bot-runtime.ts`). It calls `ServiceRefreshService.refresh`
in its `onOpen` mode.

The bounds the «♻️» button already had apply unchanged:

- the 60 s minimum interval;
- the one-read-in-flight reservation;
- the tenant's single probe bucket;
- the panel client's timeout.

## The open's own bounds (review B1)

The interval does not hold during a panel outage. A failed read writes no `usage_synced_at`
and gives its reservation back. Without more bounds, every open would dial again, hold the
turn for the client's timeout and spend a token at reserve 0. So `onOpen`, and only
`onOpen`, adds two bounds:

- **A panel the monitor has confirmed unusable is not dialled.** The check is
  `isConfirmedUnusable`, the same predicate eligibility uses: an unusable state, a streak at
  `PANEL_UNHEALTHY_AFTER_FAILURES`, and a fresh check.
- **The token is taken above the background floor, never from it.** The floor is the usage
  sweep's `usageSyncBudgetReserveFor` value on the same bucket. It is one const in the
  container, shared by the provisioner and the refresh. No second budget is added.

The «♻️» button (`rs:`) passes no options and behaves exactly as before.

## Outcomes and errors on open

- `NOT_FOUND` is the only outcome that changes the reply.
- `FAILED`, `RECENT` and `NOT_READ` draw the stored card with no toast.
- Anything the refresh throws draws the stored card. An opportunistic read on open must
  never cost the customer the card; this is an owner decision taken after #211.
  - An expected typed refusal is silent: recovery quiesced, `PERMISSION_DENIED`, or a
    retryable error (`isExpectedRefreshRefusal`).
  - Anything else is reported through `BotRuntime`'s optional `logger` dep, with context
    `{ err, serviceId, tenantId }`. The dep has the same name and shape as PR #208's, and
    the container passes the process logger.
  - The real case is a panel whose stored credential cannot be decrypted
    (`SECRET_VERSION_UNSUPPORTED`, INTERNAL, not retryable), as #211's
    `presupport-a6-location-label` fixture seeds. Before the read on open, that card opened
    fine. The second review round made it propagate, and #211's test caught the
    regression.
- A service with a change in progress (`changeInProgress`, the «working» card) is drawn
  without a read.

## Tests

In `tests/integration/customer-ux-services.test.ts`, under "opening a card refreshes it,
inside the refresh button's bounds":

- `s:` makes one panel read, shows the fresh figure and keeps `rs:`.
- `sv:` makes one read and edits the list message with the fresh figure.
- Two opens within 60 s make one read.
- An open during a tap's in-flight read makes no second read.
- A panel failure draws the stored card, with no error and no notice.
- An exhausted budget draws the stored card and makes no read.
- An expected refusal thrown by the refresh draws the stored card, and nothing is logged.
- An unexpected error thrown by the refresh draws the stored card, and is logged once with
  `{ err, serviceId, tenantId }`.
- A panel whose stored credential cannot be decrypted opens the stored card, with no panel
  read.
- A panel confirmed `UNREACHABLE` (fresh, streak at the threshold): `s:` makes 0 reads and
  draws the stored card, while `rs:` makes 1.
- A bucket exactly at the background floor: `s:` makes 0 reads, while `rs:` makes 1.
- A service with a SUSPEND in flight is drawn without a read.
- A DISABLED panel and a SUSPENDED service make 0 reads on open.
- Another customer's service answers not-found and makes no read.

One existing test also changed. "Keeps unlimited and unread apart from zero" now makes the
panel unable to answer, so the unread state it draws is still reachable after an open reads
the panel.

## Mutants

Driver: `python3 scripts/mutate-a2.py`. It needs a clean `apps/`; set `TEST_DATABASE_URL` to
a database of your own. Each write and restore is wrapped in `try`/`finally`.

| Id    | Reverted rule                                                 | Killed by                                      |
| ----- | ------------------------------------------------------------- | ---------------------------------------------- |
| A2-01 | `SERVICE` draws the stored card without the refresh           | one panel read on `s:`                         |
| A2-02 | `SERVICE_CARD` draws the stored card without the refresh      | `sv:` reads too                                |
| A2-03 | `FAILED` on open answers with the refresh-failed toast        | panel failure; exhausted budget (2 tests)      |
| A2-04 | an unexpected error is not reported                           | unexpected error; undecryptable credential (2) |
| A2-05 | an expected refusal is reported too                           | expected refusal (logs nothing)                |
| A2-12 | an unexpected error propagates (the second round's behaviour) | unexpected error; undecryptable credential (2) |
| A2-06 | the open does not ask for `onOpen`                            | confirmed unreachable; at the floor (2 tests)  |
| A2-07 | the confirmed-unusable guard removed                          | confirmed unreachable                          |
| A2-08 | the confirmed-unusable guard also applied to ♻️               | confirmed unreachable (`rs:` must read)        |
| A2-09 | the open takes its token at reserve 0                         | at the floor                                   |
| A2-10 | ♻️ also takes its token above the floor                       | at the floor (`rs:` must read)                 |
| A2-11 | the change-in-progress skip removed                           | SUSPEND in flight                              |

Result on 2026-10-05: 12 mutants, 12 killed, 16 failing tests in all. A2-03, A2-04, A2-06
and A2-12 are one edit each and fail two tests.

Earlier rounds:

- The first record listed A2-03 and A2-04 as two mutants. They were one edit run against
  two tests, so that record was 4 mutants and 5 kills.
- The second round was 11 of 11 killed. There, A2-04 and A2-05 tested an error that
  propagates. The current rule replaces that behaviour.

Ignoring `NOT_FOUND` is an equivalent mutant: the stored card answers the same
`bot.service.not_found` for a service that is not the customer's, so the branch only saves
the second read. It is not listed.
