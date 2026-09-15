# Phase 4F falsification — buying something for a service you already own

Every rule Phase 4F introduced, reverted one at a time, with the committed test
that fails as a result. `scripts/falsify.sh` applies the mutation, runs the named
file, restores the tree and refuses to report anything if the restore is not
byte-identical.

**Nine rows SURVIVED when first run, and seven of those became KILLED only after
a test was written or repaired.** That is the finding of this pass rather than a
footnote: seven load-bearing rules — including the check that reads the panel's
own record back, the condition that keeps a terminated service from being
revived by a late renewal, and the one that refuses to charge in a currency the
installation no longer sells — had no test at all, and two more had a test that
could not fail. Each repair is its own commit, and each cites the row that found
it.

The two rows that are still SURVIVED and one that has no test at all are in
**"The three that stay survived"** below, with the reading that makes each a
finding rather than a gap.

## The contract — what a purchase means arithmetically

| #      | Rule                                                                  | Mutation                                                   | Named test                                                                                            | Result |
| ------ | --------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ |
| F4F-02 | A bought period extends what REMAINS, so renewing early is not a loss | `max(currentExpiry, now)` → `now`                          | `commercial-contracts.test.ts` › adds to what remains when the service has not expired                | KILLED |
| F4F-03 | A bought period starts from NOW when the window already closed        | `max(currentExpiry, now)` → `currentExpiry`                | `commercial-contracts.test.ts` › starts from now when the service has already expired                 | KILLED |
| F4F-04 | An allowance is strictly ADDITIVE, and consumption is never touched   | `currentLimitBytes + purchasedBytes` → `currentLimitBytes` | `commercial-contracts.test.ts` › adds the purchased amount to the allowance in force                  | KILLED |
| F4F-05 | Zero — unlimited — is absorbing in BOTH directions                    | the zero guard → `if (false as boolean)`                   | `commercial-contracts.test.ts` › leaves an already-unlimited allowance unlimited                      | KILLED |
| F4F-06 | The three commercial types are `IDEMPOTENT_MUTATIONS`                 | `'RENEW'` removed from the constant                        | `commercial-contracts.test.ts` › replays safely, for every type that carries one                      | KILLED |
| F4F-07 | A target is legal on exactly the three types that buy an allowance    | `'SUSPEND'` appended to `TARGETED_OPERATION_TYPES`         | `commercial-contracts.test.ts` › is legal on exactly the three types that buy an allowance            | KILLED |
| F4F-08 | An add-on carries exactly the amount its kind can read                | `serviceAddonAmountMatchesKind` → "either field is set"    | `commercial-contracts.test.ts` › refuses an amount in the field its kind does not read                | KILLED |
| F4F-09 | `COMMERCIAL_ORDER_PURPOSES` is derived by exclusion, never listed     | derived filter → a literal list missing `ADD_TIME`         | `commercial-contracts.test.ts` › treats every purpose that is not the original purchase as commercial | KILLED |

## The adapter — what Marzban is actually asked for

| #      | Rule                                                           | Mutation                                                        | Named test                                                                                           | Result   |
| ------ | -------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------- |
| F4F-10 | A plan that asks for nothing is refused BEFORE the socket      | the empty-plan guard → `if (false as boolean)`                  | `marzban-service.test.ts` › refuses a plan that asks for nothing, without calling the panel          | KILLED   |
| F4F-11 | An omitted field is NOT SENT, because absent means "no change" | `expire` always sent, `0` for the field the plan did not buy    | `marzban-service.test.ts` › leaves a field the plan did not buy exactly as it was                    | KILLED\* |
| F4F-12 | The panel's own returned record is read, not the status code   | `if (!appliedPlan(record, plan))` → `if (false as boolean)`     | `marzban-service.test.ts` › refuses a 200 whose record did not move, rather than reporting a renewal | KILLED\* |
| F4F-13 | A 404 after a good token exchange is "not held", not an error  | `404 → { ok: true, found: false }` → `PROVIDER_ERROR`           | `marzban-service.test.ts` › reports an absent account as absent, and creates nothing                 | KILLED   |
| F4F-17 | The same omission rule, in the `data_limit` direction          | the `data_limit` guard → `!== undefined`, so `0` is always sent | `service-management.test.ts` › adds time without touching the allowance                              | KILLED\* |

\* KILLED only after the repair commit the row names. F4F-11's case compared a
record against ITSELF — `panel.users.get` hands back the live object — so it
could not fail for any implementation. F4F-12 had no case at all, and the
comment beside the nearest one claimed the real-panel acceptance covered it,
which was false: a faithful panel cannot produce a 200 that changed nothing, so
the fake gained `modify-ignores-allowance` to ask for one. F4F-17's case read
only Nexa's own row, and an `ADD_TIME` target carries `null` in that field — so
the customer's cap on the panel was gone and the assertion could not see it.

## The capability gate — and the three refusals nobody designed as three

| #      | Rule                                                          | Mutation                                           | Named test                                                                                                 | Result   |
| ------ | ------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| F4F-14 | `canRenewUser` requires the CAPABILITY, not just the method   | `&& adapter.supports('RENEW_USER')` removed        | `provisioning-delivery.test.ts` › refuses each commercial operation on a 3X-UI panel, before contacting it | SURVIVED |
| F4F-15 | A capability is declared only after the acceptance proves it  | `'RENEW_USER'` removed from the Marzban descriptor | `registries.test.ts` › lets no provider advertise an operation this release cannot execute                 | KILLED   |
| F4F-16 | `OPERATION_REQUIRED_CAPABILITIES` refuses before operability  | `RENEW: ['RENEW_USER']` → `RENEW: []`              | `provisioning-delivery.test.ts` › refuses each commercial operation on a 3X-UI panel, before contacting it | SURVIVED |
| F4F-30 | `PERFORMABLE_OPERATION_TYPES` names exactly what has a branch | the three commercial types removed                 | `registries.test.ts` › names exactly the nine types this release performs, and no more                     | KILLED   |

### Why F4F-14 and F4F-16 survive, measured rather than asserted

Three independent refusals stand between a 3X-UI panel and a renewal, and any
one of them is enough — so no single mutation can fail that case, and neither
can the obvious pair.

1. `decideOperability` reads `OPERATION_REQUIRED_CAPABILITIES` against the
   descriptor (F4F-16).
2. `canRenewUser` asks the descriptor again through `supports()` (F4F-14).
3. `canRenewUser` also asks whether the method EXISTS — and `SanaeiAdapter` has
   no `applyAllowance` at all.

Measured: F4F-14 alone SURVIVED. F4F-16 alone SURVIVED. Both together, still
SURVIVED — 37 passed — because the third refusal caught it. With all three gone
(`RENEW: []`, and `canRenewUser` reduced to `return true`) the same case FAILED:

```
× refuses each commercial operation on a 3X-UI panel, before contacting it
AssertionError: RENEW: expected 'IN_FLIGHT' to be 'FAILED'
```

The restore afterwards was verified byte-identical against copies taken first,
and `git status` was clean.

The third refusal is the one that is an accident. It holds only while no adapter
implements `applyAllowance` without declaring the capability, and the day a
provider gains the method for one operation and not another is the day it stops
covering the rest. That is exactly why the other two exist, and why removing
either as "already covered" would be wrong.

## Settlement and the commercial order

| #      | Rule                                                                        | Mutation                                                        | Named test                                                                                                          | Result   |
| ------ | --------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------- |
| F4F-01 | Settlement dispatches on the order's PURPOSE, not on "always provision"     | `if (orderPurposeNeedsService(settled.purpose))` → `if (false)` | `service-management.test.ts` › settles a renewal without creating a second service                                  | KILLED   |
| F4F-18 | The lifecycle is re-checked at SETTLEMENT, and the refusal rolls money back | the `OPERATION_LEGAL_FROM` re-check → `if (false as boolean)`   | `service-management.test.ts` › refuses a renewal of a terminated service at settlement, and the money does not move | KILLED   |
| F4F-19 | An add-on's kind must be the one the button asked for                       | `if (addon.kind !== kind)` → `if (false as boolean)`            | `service-management.test.ts` › refuses a package of the wrong kind on the extra-traffic path                        | KILLED   |
| F4F-20 | A service belongs to the customer who asks for it                           | ownership check → "exists" only                                 | `service-management.test.ts` › refuses another tenant’s customer, with the answer an absent service gets            | KILLED   |
| F4F-21 | A withdrawn or unpriced package is unsellable, never free                   | the purchasability check → `if (false as boolean)`              | `service-management.test.ts` › refuses a package the operator has withdrawn since the button was drawn              | KILLED\* |
| F4F-24 | The operation id is derived from the ORDER, so a replay plans the same row  | `${order.id}` → a fresh uuid                                    | `service-management.test.ts` › charges and plans once when the same paid order is settled again                     | SURVIVED |
| F4F-25 | A losing insert on the action's unique index is a null, not an exception    | `.onConflictDoNothing()` removed                                | `service-management.test.ts` › does not double-buy when the customer taps the quote button twice                    | SURVIVED |
| F4F-32 | A quote is denominated in `sales.currency`, re-checked where money moves    | `if (price.currency !== selling)` → `if (false as boolean)`     | `service-management.test.ts` › refuses to quote a package priced in a currency this installation no longer sells    | KILLED\* |

## Executing the operation and writing the result

| #      | Rule                                                                     | Mutation                                             | Named test                                                                                                      | Result   |
| ------ | ------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| F4F-22 | The revival state is read off `SERVICE_MACHINE`, never written literally | the `RENEW`-from-`EXPIRED` ternary → `from`          | `service-management.test.ts` › takes an EXPIRED service back to ACTIVE, which is the edge this phase exists for | KILLED\* |
| F4F-23 | `RENEW` is legal from `EXPIRED`, which is the whole point of the edge    | `RENEW: ['ACTIVE', 'EXPIRED']` → `RENEW: ['ACTIVE']` | `service-management.test.ts` › takes an EXPIRED service back to ACTIVE, which is the edge this phase exists for | KILLED\* |
| F4F-26 | `recordAllowance` names the state the operation was PLANNED from         | `eq(services.state, from)` removed from the `WHERE`  | `service-management.test.ts` › writes no allowance onto a service that moved while the call was in flight       | KILLED\* |

## The Telegram surface

| #      | Rule                                                             | Mutation                                          | Named test                                                                                        | Result   |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------- |
| F4F-27 | No callback prefix shadows another                               | `SERVICE_ADD_TIME` prefix `'h:'` → `'n:'`         | `bot-runtime.test.ts` › gives every prefix a distinct string that no other prefix begins with     | KILLED\* |
| F4F-28 | A pair payload is exactly 43 base64url characters                | the `/^[A-Za-z0-9_-]{43}$/` guard → `if (false)`  | `bot-runtime.test.ts` › answers a malformed pair rather than casting it at a column               | SURVIVED |
| F4F-29 | BOTH halves of the pair come back, and they are different halves | the second uuid read from the FIRST sixteen bytes | `bot-runtime.test.ts` › carries BOTH ids through the pair-carrying prefixes, and fits in 64 bytes | KILLED\* |

F4F-27's map named eleven of seventeen prefixes: Phase 4F added six and listed
none of them, so the case whose entire purpose is that a carelessly chosen
prefix fails there rather than by ending a customer's service was not looking at
any of this phase's. The repair adds all six, splits out the two that carry an
id PAIR, and asserts the payload still fits in Telegram's 64 bytes.

## The three that stay survived

| #      | What it is                                                       | Why the mutation survives                                                                                                                                                                                                                                                                                                               | What holds it                                                                              |
| ------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| F4F-24 | The operation id derived from `service:kind:order`               | The ORDER STATE MACHINE refuses first. A settled order is not `AWAITING_PAYMENT`, and the refusal holds under a FRESH idempotency key — so no test can reach the derived id by replaying a settlement. The derivation is the refusal that would matter if two replicas ever settled one order at the same instant.                      | `ORDER_MACHINE`, plus `provisioning_operations`' unique operation id                       |
| F4F-25 | `.onConflictDoNothing()` on the commercial-action insert         | The idempotency store refuses first: the double-tap case replays one command with one key and never reaches the repository twice. And the durable guarantee is not this call — it is `service_commercial_actions_order_key`, which refuses the second row either way. The mutation turns a null into an exception, not a duplicate row. | `service_commercial_actions_order_key`, a partial unique index                             |
| F4F-28 | The 43-character shape check on an id pair                       | Two later rules reject every payload that reaches them: `Buffer.from(…, 'base64url')` is lenient and drops invalid characters, so a malformed payload decodes to something that is not 32 bytes — and anything that IS 32 bytes still has to parse as two UUIDv7s. Defence in depth, and the composite refusal IS tested.               | the 32-byte length check and `uuidV7Schema`, proved by the malformed-pair case above       |
| F4F-31 | `planCommercialAction`'s "this purchase changes nothing" refusal | Unreachable from any surface. `quoteRenewal`'s shape check refuses an unlimited-in-both-directions renewal before an order exists, so no test can construct the state. Reached only by a direct call with a hand-built order.                                                                                                           | `provisioning_operations_target_present_check`, a CHECK constraint that rejects such a row |

## Held by a mechanism rather than by a mutation

Rules whose enforcement is a SQL constraint or a trigger. A mutation here would
have to edit an applied migration, which this repository forbids — so each is
listed with what enforces it and the case that exercises it, rather than left
out where "absent from the table" would read as "unchecked".

| Rule                                                                        | What holds it                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A commercial action cannot be edited or deleted after the fact              | `nexa_reject_mutation` triggers in `0048`, exercised by `service-management.test.ts` › leaves the invoice line unchanged, because evidence that can be edited is not evidence |
| One commercial action per order, whatever settles it                        | `service_commercial_actions_order_key`                                                                                                                                        |
| An action names a product XOR an add-on, never both and never neither       | `service_commercial_actions_source_check`                                                                                                                                     |
| A quantity purchase carries its amount in the field its kind reads          | `service_commercial_actions_purchased_check` and `orders_quantity_line_check`                                                                                                 |
| Only the three commercial types may carry a target, and they must carry one | `provisioning_operations_target_check` and `provisioning_operations_target_present_check`                                                                                     |
| An order's purpose is one of four                                           | `orders_purpose_check`                                                                                                                                                        |
| An add-on's amount matches its kind and is never zero                       | `service_addons_amount_matches_kind`, plus `serviceAddonSpecificationSchema` above it                                                                                         |
