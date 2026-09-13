# Phase 4 audit — what already exists, and what Phase 4 may therefore not invent

Written before any Phase 4 code, for the reason `CLAUDE.md` gives: `packages/contracts`
is the frozen specification, and the cheapest way to corrupt it is to add a second
vocabulary for something it already names. Everything below was read out of the
repository rather than recalled.

## Already frozen, and Phase 4 builds on it rather than beside it

| Artefact                 | What it fixes                                                                                                                                                                                                                             | Consequence for Phase 4                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ids.ts`                 | `UserId`, `OrderId`, `ServiceId`, `PaymentId`, `ReceiptId`, `RefundId`, `WalletEntryId`, `ProductId`, `PanelId` are already branded UUIDv7 types                                                                                          | **No new branded id for a customer.** The canonical customer identifier is `UserId`. Inventing a `CustomerId` beside it would give one entity two names                         |
| `ledger.ts`              | `LEDGER_DIRECTIONS` (CREDIT/DEBIT) and 27 `LEDGER_REASONS`, plus `ADMINISTRATIVE_REASONS` and `REVERSAL_REASONS`                                                                                                                          | The wallet uses these reasons exactly. `PURCHASE`, `REFUND`, `REFERRAL_SIGNUP_GIFT`, `RESELLER_SETTLEMENT` and the rest already exist; 4C and 4F add no reason                  |
| `operation.ts`           | `OperationId` is 16 hex characters **derived** from the idempotency key under a namespace (`provider`, `payment`, `telegram`, `backup`) by `operationIdFrom`                                                                              | Provisioning does not generate operation ids. Two replicas retrying one command derive the same id with no lookup, which is the property 4D's unknown-outcome handling rests on |
| `pricing.ts`             | `PRICING_PRECEDENCE` — six ordered steps with REPLACES/ADJUSTS effects — `PriceQuote` with a **mandatory** trace, and `MAX_DISCOUNT_CODES_PER_ORDER = 1`                                                                                  | The pricing engine implements this order. The quote is snapshotted onto the order and never recomputed. Discount stacking is already answered: one code                         |
| `provider-note.ts`       | `formatProviderNote` — `TG: … \| Service: … \| LastOrder: … \| LastOp: …`, 500-character cap, refuses rather than truncates                                                                                                               | 4D writes exactly this. The format was already specified and does not get re-derived                                                                                            |
| `provider.ts`            | 16 `PROVIDER_CAPABILITIES`, 5 auth shapes, and the full `PROVIDER_FAILURE_KINDS` taxonomy including `RATE_LIMITED` and `AUTHENTICATION_REQUIRES_INTERACTION`                                                                              | 4D maps adapter outcomes onto **this** taxonomy. A new failure kind would be a contract change, and none is needed                                                              |
| `permissions.ts`         | Every Phase 4 permission is already declared: `users.*` (view/search/edit/block/tier.change/wallet.*), `catalog.*`, `orders.*`, `payments.*`, `receipts.*`, `refunds.*`, `services.*`, `resellers.*`, `reports.*`                         | No permission is invented. The Web Admin surfaces gate on the keys that already exist                                                                                           |
| `money.ts`               | `IRT` with `CURRENCY_EXPONENT.IRT = 0` — "Toman is quoted in whole units in this product"                                                                                                                                                 | Integer Toman is `Money { amountMinor, currency: 'IRT' }`. There is no second money type and no float anywhere                                                                  |
| `state-machine.ts`       | `validateStateMachine`, `canTransition`, `nextState`, and a `STATE_MACHINES` registry that a test walks                                                                                                                                   | Every Phase 4 machine is declared **and registered**, or nothing validates it                                                                                                   |
| `webhook.controller.ts`  | Secret-token auth before the bot id is parsed, bot `status !== 'ACTIVE'` refused, tenant `status !== 'ACTIVE'` refused, body parsed by `telegramUpdateSchema`, idempotency keyed `telegram:<botInstanceId>:update:<updateId>`, always 200 | 4A extends this path. The identity `(bot_instance_id, update_id)` is already correct and is not re-derived                                                                      |
| `authorized-mutation.ts` | `runAuthorizedMutation` re-checks the session and the permission **inside** the committing transaction, and records the denial after unwinding                                                                                            | Every Phase 4 mutation goes through it. Nothing checks a permission only in a controller                                                                                        |
| `remember-once.ts`       | `rememberOnce` treats the losing insert as a CONFLICT so the loser's transaction rolls back                                                                                                                                               | Concurrent duplicates are handled by this, not by a new mechanism                                                                                                               |

## Absent, and therefore a contract change with its own commit

No table exists for any Phase 4 entity — the 31 tables are tenancy, outbox,
idempotency, audit, ops events, identity/RBAC, templates, settings, features,
notifications, panels and backup/recovery. `STATE_MACHINES` registers exactly one
machine, `RECOVERY_MACHINE`. The template catalogue has four bot-facing keys
(`bot.ping.reply`, `bot.unknown_command`, `error.internal`,
`error.permission_denied`) and nothing commercial.

So Phase 4 adds: customer status vocabulary; order, payment, service and
provisioning-operation state machines; catalogue and promotion vocabularies;
customer-facing template keys; domain event types; error codes; HTTP shapes; and
the tables behind them. Each as a contract commit, separate from the feature that
uses it, per `CLAUDE.md`.

## Values this audit refuses to invent

The owner's instruction and `docs/open-questions.md` agree on these, and the
research corpus does not contain them. Each becomes an explicit operator setting
whose absence leaves the feature **disabled**, never a guessed default:

- every product price (`PRICING_PRECEDENCE` says how prices combine, not what they are)
- discount rates and caps
- referral reward amounts
- trial duration and traffic
- reseller credit limits and reseller pricing policy
- payment gateway credentials and endpoints

`PRICING_PRECEDENCE` itself is recorded in `pricing.ts` as **pending owner
sign-off** (O-1, `PRICING_PRECEDENCE = UNKNOWN`, SBR-033). Phase 4 implements the
declared order because it is the only one in the repository, and the engine reads it
from the contract rather than hard-coding the sequence — so a sign-off that changes
the order is a data change with a visible test diff.

## A correction to this branch's own record

Commit `d8d7cb4` renamed three constraints inside migration `0034`, and its message
said the file "had never applied anywhere, so this is not an edit to an applied
migration". **That claim was false**, and the false half matters.

It had never applied to any _release_ — true, and the reason the edit is acceptable.
It had already applied to the developer databases on this machine, and drizzle hashes
the migration's content. So the readiness probe did exactly what it exists for: it
reported

```
diverged: 0034_phase4_cross_entity_customer_agreement was applied with
          different content than this release ships
```

and fourteen integration tests across three suites failed, because readiness says
`down` and they assert `up`. CI was green on the same commit throughout — it starts
from an empty database — which is precisely the shape of a local-only failure that
reads like a product defect.

Two things to carry forward:

- **The mechanism worked.** A migration edited after it applied is detected rather
  than silently tolerated, and the detection names the file. That check earns its
  keep; the failure was the claim, not the code.
- **"Never applied anywhere" needs a scope.** The honest sentence is "never applied
  to a release, and every developer database carrying the old content must be
  recreated" — which is what fixed it here (`DROP DATABASE nexa_test`, re-migrate,
  38 readiness cases green).

Migration `0034` is **not** edited again to add this note: changing a byte of it
would re-diverge every database that has now applied the current content, including
the one this was just fixed on. A doc costs nothing and a migration file costs that.
