# Package B (mandatory channel membership) — falsification record

Each rule below was reverted against the Package B branch, and the named test file was
run: the integration file against its own test database and Redis database, the unit file
in the unit project. The mutations ran in a separate worktree, never the implementation
checkout, and each was reverted with `git checkout` before the next one ran. A mutation of
`packages/contracts` rebuilds the package before its test and again after the restore,
because the tests import its `dist`. Every row is driven by `scripts/mutate-package-b.py`,
which is committed.

The first pass left one mutation alive.

- **B-15.** `telegramChannelIdentity` prefers the chat id to the handle. Preferring the
  handle survived, because the only test that asked by id used a private channel, which has
  no handle, so either order gave the id. The new unit test gives a public channel a chat id
  as well and asserts the id is what Telegram is asked about: a handle can be renamed or
  given away, and the numeric id is the channel.

Every row is killed.

B-22..B-24 falsify the fixes for the Codex review of #86. The whole driver was re-run
against the fixed service, and B-01..B-21 are killed again on it.

| #    | rule                                                                                           | tests that die                                                                                                                  | result |
| ---- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------ |
| B-01 | `restricted` is a member only when Telegram says `is_member`                                   | `unit/channel-membership.test.ts` › reads restricted as a member only when Telegram says is_member                              | KILLED |
| B-02 | `left` and `kicked` are not members                                                            | `unit/channel-membership.test.ts` › reads left and kicked as not a member, and an undocumented status as unknown                | KILLED |
| B-03 | A failed `getChatMember` is UNKNOWN, never NOT_MEMBER                                          | `unit/channel-membership.test.ts` › reads every failed call as unknown, carrying Telegram’s code                                | KILLED |
| B-04 | Only REQUIRED channels are asked about                                                         | `unit/channel-membership.test.ts` › names exactly the required channel that is missing, and never asks about an optional one    | KILLED |
| B-05 | UNKNOWN counts as satisfied: the check fails open                                              | `unit/channel-membership.test.ts` › fails open on a check Telegram could not answer, and records the condition once a minute    | KILLED |
| B-06 | The unavailable condition is written at most once a minute per bot                             | `unit/channel-membership.test.ts` › fails open on a check Telegram could not answer, and records the condition once a minute    | KILLED |
| B-07 | A turn in which every required channel answered records the recovery                           | `unit/channel-membership.test.ts` › recovers the condition on the next answer Telegram gives                                    | KILLED |
| B-08 | An outage another process recorded is looked for at most once a minute                         | `unit/channel-membership.test.ts` › recovers an outage another process recorded, looking at most once a minute                  | KILLED |
| B-09 | A MEMBER answer is kept 60 s, not the 10 s of a non-member                                     | `unit/channel-membership.test.ts` › keeps a member about a minute, and a non-member only ten seconds                            | KILLED |
| B-10 | The check button asks again past a cached NOT_MEMBER or UNKNOWN                                | `unit/channel-membership.test.ts` › asks again for the check button, but keeps a cached member                                  | KILLED |
| B-11 | The check button keeps a cached MEMBER                                                         | `unit/channel-membership.test.ts` › asks again for the check button, but keeps a cached member                                  | KILLED |
| B-12 | The cache key names the bot                                                                    | `unit/channel-membership.test.ts` › never serves one bot’s, tenant’s or customer’s answer to another                            | KILLED |
| B-13 | The cache key names the tenant                                                                 | `unit/channel-membership.test.ts` › never serves one bot’s, tenant’s or customer’s answer to another                            | KILLED |
| B-14 | A required channel needs a handle or a join link                                               | `unit/channel-membership.test.ts` › refuses a required channel a customer could not open                                        | KILLED |
| B-15 | A channel with a chat id is asked about by the id, even beside a handle                        | `unit/channel-membership.test.ts` › asks about a channel by its chat id whenever it has one, even beside a handle               | KILLED |
| B-16 | A join link must be a `https://t.me/` link                                                     | `unit/channel-membership.test.ts` › refuses a join link that is not Telegram, and two channels with one id                      | KILLED |
| B-17 | `BotRuntime.handle` routes a customer turn through the guard                                   | `integration/channel-membership.test.ts` › stops a customer missing one of two required channels, and shows only that one       | KILLED |
| B-18 | SUPPORT and HELP are exempt                                                                    | `integration/channel-membership.test.ts` › runs no business action while a membership is missing, and lets support through      | KILLED |
| B-19 | A bound administrator is never locked out                                                      | `integration/channel-membership.test.ts` › never locks out a bound administrator                                                | KILLED |
| B-20 | A passing check answers the main menu, never the stopped action                                | `integration/channel-membership.test.ts` › answers the check button with the main menu, and never replays the action it stopped | KILLED |
| B-21 | The check button asks fresh                                                                    | `integration/channel-membership.test.ts` › answers the check button with the main menu, and never replays the action it stopped | KILLED |
| B-22 | A recovery never clears the write throttle (Codex review of #86)                               | `unit/channel-membership.test.ts` › writes a flapping channel’s outage at most once a minute (Codex review of #86)              | KILLED |
| B-23 | The condition is keyed per bot, so a corrected channel still recovers it (Codex review of #86) | `unit/channel-membership.test.ts` › recovers the outage once the operator corrects the channel’s id (Codex review of #86)       | KILLED |
| B-24 | Concurrent turns share one read in flight (Codex review of #86)                                | `unit/channel-membership.test.ts` › shares one Telegram read among concurrent turns for the same key (Codex review of #86)      | KILLED |
