# WP20 messaging reliability and anti-spam — falsification record

Each rule was reverted against the WP20 branch, and the named test file was run:

- integration files against their own test database, and on their own Redis database
  (`REDIS_URL=redis://127.0.0.1:6379/1`), because the anti-spam windows live in Redis and
  another suite's reset would otherwise clear them mid-test;
- the unit and web files in their own projects.

Each mutation was reverted with `git checkout` before the next one ran. A mutation of
`packages/contracts` rebuilds the package before its test and again after the restore,
because the tests import its `dist`. Every row is driven by `scripts/mutate-wp20.py`, which
is committed.

The pre-review of the branch found four defects, fixed with W20-38..45: the exhaustion
announcement was recorded with a bare transaction, so its operator notification was refused;
exhaustion was inferred from a count the release before WP20 could grow without announcing
anything; the anti-spam degradation condition shared one key across bots; and `/ping` was
answered before anti-spam counted it. W20-07, W20-11, W20-12 and W20-36 were re-anchored on
the code those fixes changed, and killed again. The whole driver was re-run after the fixes:
every row but W20-31 and W20-37, below, is killed.

The branch was then restacked onto WP19's later review rounds, which moved the anti-spam
counter's `update_id` read into the runtime's one shared reader. W20-28 was re-anchored on
that line and run on its own; the rest of the driver was re-run on the restacked head
(`e10c5a9`). Every row but W20-31 and W20-37 is killed.

The first pass left four mutations alive.

- **W20-30.** The Lua script counts an interaction only when its `update_id` is fresh
  (`SET NX`). Adding every update to the window survived, because the sorted set's member
  is the `update_id`, so a redelivery could not add a second member either. It does refresh
  the member's score, though, which kept a redelivered interaction in the window longer
  than the original. A test now pins exactly that ("does not keep a redelivered update in
  the window longer than the original").
- **W20-32.** The per-bot test counted nothing on the second bot. The seed's second bot is
  `STOPPED`, and a stopped bot's updates are never handled. The test now starts the bot
  first, and asserts that the second bot's own twenty-first interaction blocks.
- **W20-31** survives as an equivalent mutant. The window's key names the tenant, the bot
  and the Telegram user, as the brief asks. A bot instance id is a UUID that belongs to
  exactly one tenant, so dropping the tenant from the key cannot merge two windows. The
  tenant stays in the key because the brief names it and because it keeps a key readable.
  No test is cited for it.
- **W20-37** survives: the runtime's guard is one of two guards. The runtime skips the
  anti-spam block for a customer already BLOCKED. Without it, `CustomerService.setStatus`
  decides, because it changes only an ACTIVE customer. That rule predates WP20, and
  "keeps an administrator's block, and its reason, when anti-spam loses the race" holds
  under either. The runtime guard saves a transaction. No test is cited for it.

| #      | rule                                                                                                         | tests that die                                                                                                            | result |
| ------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------ |
| W20-01 | The relay claims only a message that is due (`next_attempt_at` null or past)                                 | `wp20-outbox-retry.test.ts` › reschedules a failure on its own row, and claims nothing before it is due                   | KILLED |
| W20-02 | A failure schedules the next attempt on the owner's back-off, not now                                        | `wp20-outbox-retry.test.ts` › reschedules a failure on its own row, and claims nothing before it is due                   | KILLED |
| W20-03 | An exhausted message is never claimed again                                                                  | `wp20-outbox-retry.test.ts` › stops after twelve real failures, keeps the message, and says so once                       | KILLED |
| W20-04 | Exhaustion is the twelfth real failure, not the thirteenth                                                   | `wp20-outbox-retry.test.ts` › stops after twelve real failures, keeps the message, and says so once                       | KILLED |
| W20-05 | Exhaustion records `outbox.message_exhausted`                                                                | `wp20-outbox-retry.test.ts` › stops after twelve real failures, keeps the message, and says so once                       | KILLED |
| W20-06 | A message waits behind an earlier one of its aggregate that failed and is backing off                        | `wp20-outbox-retry.test.ts` › holds back a failed message’s own aggregate, and nothing else                               | KILLED |
| W20-07 | An exhausted predecessor holds nothing back                                                                  | `wp20-outbox-retry.test.ts` › stops after twelve real failures, keeps the message, and says so once                       | KILLED |
| W20-08 | A predecessor that never failed does not hold its successors out of the batch                                | `wp20-outbox-retry.test.ts` › drains an aggregate’s queued messages in one batch, in order                                | KILLED |
| W20-09 | A failure in the batch holds the rest of its aggregate in that batch                                         | `wp20-outbox-retry.test.ts` › holds back a failed message’s own aggregate, and nothing else                               | KILLED |
| W20-10 | An exhausted message is not counted as relay lag                                                             | `wp20-outbox-retry.test.ts` › stops after twelve real failures, keeps the message, and says so once                       | KILLED |
| W20-11 | Diagnostics count the exhausted messages                                                                     | `wp20-outbox-retry.test.ts` › stops after twelve real failures, keeps the message, and says so once                       | KILLED |
| W20-12 | Diagnostics mark a sampled message exhausted                                                                 | `wp20-outbox-retry.test.ts` › stops after twelve real failures, keeps the message, and says so once                       | KILLED |
| W20-13 | Web: the exhausted banner is drawn when any message is exhausted                                             | `system-diagnostics.test.tsx` › names the messages no longer retried, and when each other one is tried next (WP20)        | KILLED |
| W20-14 | Web: an exhausted sample says it is no longer retried                                                        | `system-diagnostics.test.tsx` › names the messages no longer retried, and when each other one is tried next (WP20)        | KILLED |
| W20-15 | The ops lane waits the later of `retry_after` and its own back-off                                           | `wp20-retry-schedule.test.ts` › never lets a small retry_after undercut its own back-off                                  | KILLED |
| W20-16 | The customer lane waits the later of `retry_after` and its own back-off                                      | `customer-notifications.test.ts` › a short retry_after never brings a retry earlier than the lane’s own back-off (WP20)   | KILLED |
| W20-17 | The receipt review push waits the later of `retry_after` and its own back-off                                | `receipt-review-push.test.ts` › a 429 waits Telegram’s own retry_after and spends no attempt                              | KILLED |
| W20-18 | The refund-request review push waits the later of `retry_after` and its own back-off                         | `service-refund-requests.test.ts` › waits its own back-off when Telegram asks for less (WP20)                             | KILLED |
| W20-19 | The service delivery lane waits the later of `retry_after` and its own back-off                              | `provisioning-delivery.test.ts` › waits its own back-off when Telegram asks for less (WP20)                               | KILLED |
| W20-20 | The schedule is 5 s, 15 s, 60 s, 5 min, 15 min, then an hour                                                 | `wp20-retry-schedule.test.ts` › waits 5 s, 15 s, 60 s, 5 min, 15 min, then an hour                                        | KILLED |
| W20-21 | The schedule takes the later of the provider's `retry_after` and its own delay                               | `wp20-retry-schedule.test.ts` › takes the LATER of the provider’s retry_after and its own delay, and is never zero        | KILLED |
| W20-22 | Twelve real failures, not thirteen                                                                           | `wp20-retry-schedule.test.ts` › stops after twelve real failures                                                          | KILLED |
| W20-23 | Twenty interactions in the window are allowed                                                                | `wp20-anti-spam.test.ts` › allows exactly twenty interactions in the window                                               | KILLED |
| W20-24 | The twenty-first blocks                                                                                      | `wp20-anti-spam.test.ts` › blocks on the 21st, once, as the system, with the owner’s reason and sentence                  | KILLED |
| W20-25 | Crossing the threshold blocks the customer                                                                   | `wp20-anti-spam.test.ts` › blocks on the 21st, once, as the system, with the owner’s reason and sentence                  | KILLED |
| W20-26 | Past the twenty-first, a flooding blocked customer is sent nothing                                           | `wp20-anti-spam.test.ts` › answers nothing more while the flood lasts, and still answers every button                     | KILLED |
| W20-27 | A bound administrator is never blocked                                                                       | `wp20-anti-spam.test.ts` › never blocks a bound administrator                                                             | KILLED |
| W20-28 | Button presses are counted                                                                                   | `wp20-anti-spam.test.ts` › counts button presses                                                                          | KILLED |
| W20-29 | The spam block answers with the owner's sentence, not the generic blocked one                                | `wp20-anti-spam.test.ts` › blocks on the 21st, once, as the system, with the owner’s reason and sentence                  | KILLED |
| W20-30 | A redelivered update is not counted again, and does not refresh its place in the window                      | `wp20-interaction-counter.test.ts` › does not keep a redelivered update in the window longer than the original            | KILLED |
| W20-32 | The window's key names the bot                                                                               | `wp20-anti-spam.test.ts` › counts per bot                                                                                 | KILLED |
| W20-33 | The window rolls: an interaction older than ten seconds leaves it                                            | `wp20-interaction-counter.test.ts` › is a ROLLING window, not a fixed one                                                 | KILLED |
| W20-34 | A counter still connecting is waited for rather than answered UNAVAILABLE                                    | `wp20-interaction-counter.test.ts` › counts within the window and forgets what is older than it                           | KILLED |
| W20-35 | Redis unavailable fails OPEN                                                                                 | `wp20-anti-spam.test.ts` › blocks nobody, and records that the protection is off                                          | KILLED |
| W20-36 | The degradation is recorded at most once a minute                                                            | `wp20-anti-spam.test.ts` › blocks nobody, and records that the protection is off                                          | KILLED |
| W20-38 | The exhaustion announcement is recorded through a transaction scope, so its operator notification is written | `wp20-outbox-retry.test.ts` › stops after twelve real failures, keeps the message, and says so once                       | KILLED |
| W20-39 | Exhaustion writes the `exhausted_at` mark                                                                    | `wp20-outbox-retry.test.ts` › stops after twelve real failures, keeps the message, and says so once                       | KILLED |
| W20-40 | A message is exhausted by its mark, not by a count an earlier release grew                                   | `wp20-outbox-retry.test.ts` › retries a message whose count grew under the release before, then exhausts and announces it | KILLED |
| W20-41 | The degradation throttle is kept per bot                                                                     | `wp20-anti-spam-conditions.test.ts` › keys the outage by bot, so a second bot’s outage is written, not throttled          | KILLED |
| W20-42 | A recovery is written only for the bot whose outage was recorded                                             | `wp20-anti-spam-conditions.test.ts` › does not resolve one bot’s outage on another bot’s good turn                        | KILLED |
| W20-43 | A recovery is written under its own dedupe key                                                               | `wp20-anti-spam-conditions.test.ts` › resolves the outage under its own key, naming the outage’s key                      | KILLED |
| W20-44 | A recovery names the outage's dedupe key                                                                     | `wp20-anti-spam-conditions.test.ts` › resolves the outage under its own key, naming the outage’s key                      | KILLED |
| W20-45 | A `/ping` past the limit writes nothing                                                                      | `wp20-anti-spam.test.ts` › counts /ping, and writes nothing for one past the limit                                        | KILLED |
