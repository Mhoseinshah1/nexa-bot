# Package A (Telegram Stars) — falsification record

Each rule below was reverted against the Package A branch, and the named test file was
run: integration files against their own test database and Redis database, unit files in
the unit project. Each mutation was reverted with `git checkout` before the next one ran.
A mutation of `packages/contracts` rebuilds the package before its test and again after
the restore, because the tests import its `dist`. A-09 is a rule held by the database, so
its row drops the trigger before the run and re-creates it afterwards through the driver's
SQL pair. Every row is driven by `scripts/mutate-package-a.py`, which is committed.

The first pass left one mutation alive.

- **A-30.** `gatewayPayment` picks the route the customer tapped (`gp:<order>.<provider>`).
  Dropping the provider filter survived, because every gateway test offered one route, so
  the first route offered was always the one tapped. The new test activates Stars and
  TonPays together — Stars is offered first — taps TonPays, and asserts the attempt is a
  TonPays one. The tap only records the attempt; no worker runs, so nothing is sent to
  TonPays.

Every row is killed.

Not falsified here, because no code path exists to mutate: nothing in the codebase calls
`refundStarPayment`. That absence is asserted by the static scan
`integration/telegram-stars.test.ts` › has no code path that asks Telegram to refund Stars,
and, over every case of that file, by its `afterAll`.

| #    | rule                                                                                                                      | tests that die                                                                                                                                         | result |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| A-01 | Stars are `ceil(payable / rate)`, never the floor                                                                         | `unit/telegram-stars.test.ts` › is ceil(payable / rate) in bigint, and a positive payable is at least one Star                                         | KILLED |
| A-02 | The adapter converts only with a rate; no rate is no amount                                                               | `unit/telegram-stars.test.ts` › the adapter converts only with a rate                                                                                  | KILLED |
| A-03 | A FIXED_RATE route cannot be switched on without a rate                                                                   | `integration/telegram-stars.test.ts` › starts disabled, and cannot be switched on without a rate                                                       | KILLED |
| A-04 | The rate of an ACTIVE route cannot be cleared                                                                             | `integration/telegram-stars.test.ts` › refuses clearing the rate of an enabled route, and a rate on a route that has no conversion                     | KILLED |
| A-05 | A rate is refused on a route that has no conversion                                                                       | `integration/telegram-stars.test.ts` › refuses clearing the rate of an enabled route, and a rate on a route that has no conversion                     | KILLED |
| A-06 | The boot reconcile creates the Stars route DISABLED                                                                       | `integration/telegram-stars.test.ts` › is created DISABLED by the boot reconcile for a tenant that has no row                                          | KILLED |
| A-07 | The seed creates the Stars route DISABLED                                                                                 | `integration/telegram-stars.test.ts` › starts disabled, and cannot be switched on without a rate                                                       | KILLED |
| A-08 | An invoice snapshots the rate it was issued at                                                                            | `integration/telegram-stars.test.ts` › keeps an open invoice at the rate it was issued at when the rate changes, and the row refuses a rewrite         | KILLED |
| A-09 | The snapshot trigger refuses a rewrite of an issued invoice (`nexa_gateway_invoices_snapshot_guard`, dropped for the run) | `integration/telegram-stars.test.ts` › keeps an open invoice at the rate it was issued at when the rate changes, and the row refuses a rewrite         | KILLED |
| A-10 | An open attempt is handed back only in the bot it was sent through                                                        | `integration/telegram-stars.test.ts` › hands back an open attempt only in the bot it was sent through                                                  | KILLED |
| A-11 | A BOT_TOKEN route is refused outside a bot                                                                                | `integration/telegram-stars.test.ts` › is refused outside a bot: there is no chat to send the invoice to                                               | KILLED |
| A-12 | Only a GATEWAY_KEY route needs a stored credential                                                                        | `integration/telegram-stars.test.ts` › asks for ceil(payable / rate) Stars, snapshots the rate and bot, and sends one XTR price with no provider token | KILLED |
| A-13 | `sendInvoice` carries an empty `provider_token`                                                                           | `unit/telegram-stars.test.ts` › sends XTR, one price, an empty provider token, and nothing a customer could adjust                                     | KILLED |
| A-14 | Only a 429 is RATE_LIMITED; every other retryable failure is UNKNOWN                                                      | `unit/telegram-stars.test.ts` › keeps a rate limit, a refusal and an unknown answer apart                                                              | KILLED |
| A-15 | A Stars invoice is sent with the attempt's bot token, never a stored credential                                           | `integration/telegram-stars.test.ts` › asks for ceil(payable / rate) Stars, snapshots the rate and bot, and sends one XTR price with no provider token | KILLED |
| A-16 | Pre-checkout refuses an attempt inside its last two minutes                                                               | `integration/telegram-stars.test.ts` › refuses an attempt inside its last two minutes, a closed one, and a payload nobody issued                       | KILLED |
| A-17 | Pre-checkout refuses the wrong bot of the same tenant                                                                     | `integration/telegram-stars.test.ts` › refuses %s with the one fixed sentence                                                                          | KILLED |
| A-18 | Pre-checkout refuses the wrong payer                                                                                      | `integration/telegram-stars.test.ts` › refuses %s with the one fixed sentence                                                                          | KILLED |
| A-19 | Pre-checkout refuses a total that is not the snapshotted Stars                                                            | `integration/telegram-stars.test.ts` › refuses a total that is not the snapshotted Stars                                                               | KILLED |
| A-20 | Pre-checkout refuses a blocked customer                                                                                   | `integration/telegram-stars.test.ts` › refuses a blocked customer                                                                                      | KILLED |
| A-21 | Every pre-checkout refusal carries the one rendered sentence                                                              | `integration/telegram-stars.test.ts` › refuses %s with the one fixed sentence (the wrong payer, the wrong currency and the wrong bot all die)          | KILLED |
| A-22 | One charge id is never attached to a second attempt                                                                       | `integration/telegram-stars.test.ts` › never attaches one charge id to a second attempt                                                                | KILLED |
| A-23 | The invoice lookup for a charge is tenant-scoped                                                                          | `integration/telegram-stars.test.ts` › does not settle tenant A’s attempt from tenant B’s bot                                                          | KILLED |
| A-24 | The worker settles a RECORDED_PAYMENT row from the record, never by inquiry                                               | `integration/telegram-stars.test.ts` › lets the worker settle a recorded payment whose settlement did not finish, without calling Telegram             | KILLED |
| A-25 | A recorded charge settles even when the create answer was lost                                                            | `integration/telegram-stars.test.ts` › settles a charge on an invoice whose create answer was lost                                                     | KILLED |
| A-26 | A charge that could not be recorded fails the webhook, so Telegram redelivers it                                          | `telegram-stars-webhook.test.ts` › fails the request when the charge could not be recorded, so Telegram redelivers it                                  | KILLED |
| A-27 | `successful_payment` is handled before the customer turn                                                                  | `telegram-stars-webhook.test.ts` › records a successful payment, never handing it to the customer turn                                                 | KILLED |
| A-28 | The financial log carries the Stars and the rate for a converted payment                                                  | `integration/telegram-stars.test.ts` › logs the Stars payment with principal, fee, payable, the Stars and the charge id — never the token or payload   | KILLED |
| A-29 | `/paysupport` answers the support screen                                                                                  | `unit/telegram-stars.test.ts` › answers /paysupport as the support screen, and lists it in the menu and in help                                        | KILLED |
| A-30 | The attempt opens on the route the customer tapped                                                                        | `integration/telegram-stars.test.ts` › opens the attempt on the route the customer tapped, not the first one offered                                   | KILLED |
