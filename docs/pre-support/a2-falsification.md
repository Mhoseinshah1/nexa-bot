# Pre-support A2 — refresh on open: falsification

Item A2 of the pre-support remaining-fixes audit (2026-10-05): opening a service card
(`s:` → `SERVICE`, `sv:` → `SERVICE_CARD`) makes the same bounded live read the «♻️» button
makes, before the card is drawn. The rule lives in `BotRuntime.openServiceCard`
(`apps/api/src/surfaces/telegram/bot-runtime.ts`) and calls `ServiceRefreshService.refresh`
and nothing else, so the 60 s minimum interval, the one-read-in-flight reservation, the
tenant's single probe budget and the panel client's timeout all apply unchanged. No second
budget is added.

Only `NOT_FOUND` is an answer on open. `FAILED`, `RECENT`, `NOT_READ` and a thrown refresh
draw the stored card with no toast. The «♻️» button stays. The «working» card is drawn by an
action's own turn and is not refreshed.

## Tests

In `tests/integration/customer-ux-services.test.ts`, under "opening a card refreshes it,
inside the refresh button's bounds":

- opening a card makes one panel read and shows the fresh figure (and keeps `rs:`)
- opening from the list (`sv:`) reads too, and edits the list message with the answer
- opening twice within 60 s makes ONE panel read
- opening while a tap's read is in flight makes no second read
- a panel failure draws the stored card, with no error and no notice
- an exhausted probe budget draws the stored card and dials nothing
- a refresh that throws still opens the stored card
- a service that is not theirs is answered not-found, and dials nothing

"keeps unlimited and unread apart from zero" now makes the panel unable to answer, so the
unread state it draws is still reachable after an open reads the panel.

## Mutants

Driver: `python3 scripts/mutate-a2.py` (needs a clean `apps/`; set `TEST_DATABASE_URL` to a
database of your own).

| Id    | Reverted rule                                            | Killed by                                         |
| ----- | -------------------------------------------------------- | ------------------------------------------------- |
| A2-01 | `SERVICE` draws the stored card without the refresh      | opening a card makes one panel read               |
| A2-02 | `SERVICE_CARD` draws the stored card without the refresh | opening from the list (`sv:`) reads too           |
| A2-03 | `FAILED` on open answers with the refresh-failed toast   | a panel failure draws the stored card             |
| A2-04 | same mutant, reached through an exhausted budget         | an exhausted probe budget draws the stored card   |
| A2-05 | a refresh that throws fails the open                     | a refresh that throws still opens the stored card |

Result on 2026-10-05: 5 of 5 killed.

Ignoring `NOT_FOUND` is an equivalent mutant: the stored card answers the same
`bot.service.not_found` for a service that is not the customer's, so the branch only saves
the second read. It is not listed.
