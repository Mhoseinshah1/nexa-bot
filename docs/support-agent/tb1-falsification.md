# TB1 — falsification

Each rule below was reverted on its own by the committed `scripts/mutate-tb1.py`, and the
named test was run against the mutant. A test that stays green under the mutation of the
rule it names is not a test (CLAUDE.md, "Reviewing with agents").

Run on 2026-10-04 against the TB1 head. 9 of 9 killed.

| Id     | Rule reverted                                                              | Killed by                                                                                       |
| ------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| TB1-01 | The webhook dispatches business updates before the customer turn           | `business-webhook.test.ts` › routes a customer’s business message …, never the customer turn    |
| TB1-02 | A message with no `from` is never INBOUND                                  | `business-chats.test.ts` › a message with no sender never counts as a customer starting AI work |
| TB1-03 | Another business bot is OTHER_BOT (human), not our echo                    | `business-chats.test.ts` › another business bot speaking for the owner takes the conversation   |
| TB1-04 | A connection without `can_reply` is RIGHTS_INSUFFICIENT                    | `business-chats.test.ts` › fails closed on every other combination                              |
| TB1-05 | A connection that is not ACTIVE is refused before any request              | `business-transport.test.ts` › refuses before any request when the connection is … (×3)         |
| TB1-06 | Only `telegram.rate_limited` is RATE_LIMITED; other retryables are UNKNOWN | `business-transport.test.ts` › reports … as UNKNOWN (×3)                                        |
| TB1-07 | An absent or non-true right grants nothing                                 | `business-chats.test.ts` › reads an absent rights object as NO rights                           |
| TB1-08 | A new connection id supersedes the owner's older rows                      | `business-connections.test.ts` (integration) › supersedes an owner’s older connection …         |
| TB1-09 | A failed connection report propagates, so Telegram redelivers it           | `business-webhook.test.ts` › fails the request when a connection report could not be applied    |
