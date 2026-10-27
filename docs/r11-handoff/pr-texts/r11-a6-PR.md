# R11 A6 — three Round 10 follow-ups: ops-log customer ids, L8/L9 for imported customers, checkout open items

Branch `fix/r11-r10-followups`, from `origin/main` (20be9734). One commit per item. No migration, no contract change.

## What changed

### 1. A customer UUID that looks like a card number no longer drops out of the ops alert (`64acf492`)

`safeIdentifier()` (`apps/api/src/modules/platform/opslog/application/error-events.ts`) decided whether an id could be printed in the operations log by running it through `redactOperatorText()` and keeping it only if nothing changed. A UUID's hex groups can hold a long digit run. In `01a17a35-657e-7f61-9252-783554496375`, the run `61-9252-783554496375` is 18 Luhn-valid digits. The card rule redacts it, so `safeIdentifier` returned `null`. About one UUIDv7 in a thousand has this shape. For those customers the payment-link alert (L22) silently lost the customer's name, username, Telegram id and USER button, and lost the order-code lookup by `orderId`. The same applied to `serviceId` and `botInstanceId` in the other presenter paths.

- `safeIdentifier` is the only copy of this logic. `commerce/payments/application/payment-link-failure.ts` (the event's context) and `commerce/ops-log/application/event-presenter.ts` (L22, the provisioning stall report and the customer-send report) both call it. Nothing else in the codebase compares a value to its redacted self.
- New rule: a **strict UUID** is accepted by its format, before the redactor test. Strict means:
  - lowercase hex in 8-4-4-4-12 groups;
  - an RFC 9562 version nibble from 1 to 8;
  - the RFC variant: 8, 9, a or b.

  That is the form PostgreSQL renders for the ids this installation mints. The caller's length bound still applies first.

- Everything that is not a strict UUID still goes through the old alphabet check plus "unchanged by the redactor", exactly as before. That covers provider references, tracking codes, upper-case or braced UUIDs, a UUID with text around it, a variant-1 shape, a PAN and a link.

### 2. L8 (referral commission) and L9 (signup gift) are logged for MIRZA-imported customers after the import (`fc9cb7d8`)

R10 B5 (PR #332, f3a8c3fd) applied the v0.8.2-e rule to L18/L20/L21/L23/L24/L26: only records the import created stay silent, and events after the import are logged. But `LedgerLogConsumer` (`commerce/ops-log/application/ledger-log.consumer.ts`) still refused:

- L8 when the **referrer's** customer row was `source = 'MIRZA'`;
- L9 when the **referee's** row was.

After a one-click `.nxpkg` import every pre-existing customer is MIRZA. So every commission paid to an imported referrer, and every gift where the referee was imported, never reached the group, even though this installation paid it from its own ledger after the import.

The import never writes `REFERRAL_COMMISSION` or `REFERRAL_SIGNUP_GIFT`. It writes only `MIGRATION_OPENING_BALANCE`, and a referral it carries is an attribution with no reward entry. The money paths never pay on an imported attribution or order (`referrals.source = 'NEXA'` joins in the settlement and the claim). So the customer's provenance is dropped from both lines. Each line now reads the provenance of the record it is **about**:

- **L8 — the commission's ORDER.** Silent when `origin` is not `STANDARD` (as before). New: also silent when `source` is not `NEXA`, meaning an order the import wrote. This is the same pair `FailureLogConsumer` reads.
- **L9 — the REFERRAL.** Silent when `referrals.source` is not `NEXA`. `OpsLogFacts.referralOf` (port and `drizzle-ops-log-facts.ts`) now also returns the referral row's `source`.
- The nexa-conventions import-silence line now names commissions and gifts (R11 A6).

### 3. B1 open items (checkout) (`00deeb62`)

**(a) Card to card is checked before a DRAFT is confirmed.** `CheckoutService.payByCard` used to confirm the DRAFT through its lane, then call `requestManualTransfer`. That call refused a route that was off, but only after the draft was already AWAITING_PAYMENT, with its reservation held and its discount redeemed, for a payment that could not be made.

For a DRAFT, `payByCard` now first asks `payments.manualTransferOffered(scope)`. That is the exact condition `orderRoutes` uses to draw the card route on the menu: the route is switched on for purchases AND an enabled account exists. If it is not offered, `payByCard` refuses with the payment service's own `PAYMENT_METHOD_UNAVAILABLE`, so each surface answers in the Persian it already uses:

- bot: `bot.payment.unconfigured`;
- mini app: its generic error sentence, as before.

A non-DRAFT order reserves nothing at this step and keeps only the payment service's in-transaction check, unchanged.

**(b) `OrderService.confirm` refuses commercial purposes.** I checked every production caller first:

- `CheckoutService.confirmDraft` sends only `NEW_SERVICE` and `CUSTOM_SERVICE` there, and every commercial purpose goes to `CommercialActionService.confirm` (R10 B1).
- `ManualOrderService` confirms its own `createDraft` of a product, which is `NEW_SERVICE`.
- Auto-renew and the bot's service-actions flow call `commercial.confirm`.
- No test passes a commercial draft to `orders.confirm`. Every test that drafts a commercial action confirms it through `commercialActions.confirm`.

Inside the transaction, after the ownership check, `OrderService.confirm` now refuses any purpose where `orderPurposeTargetsExistingService` is true (RENEW, ADD_TRAFFIC, ADD_TIME, ADD_DEVICES, CHANGE_LOCATION). It refuses in any state, including an already-confirmed commercial order, which is not this lane's success either. TRIAL is not commercial and is not affected. The refusal is a typed `ORDER_STATE_INVALID` with `details: { reason: 'COMMERCIAL_PURPOSE', purpose }`. The reason is exported as `ORDER_CONFIRM_COMMERCIAL_PURPOSE`. Nothing is written: no audit row, no idempotency record.

## Tests

| Suite                                                                                                          | Added | Result |
| -------------------------------------------------------------------------------------------------------------- | ----- | ------ |
| `tests/unit/ops-error-events.test.ts` — "R11 A6: a customer UUID that looks like a card number is still an id" | 3     | 45/45  |
| `tests/integration/imported-customer-ops-logs.test.ts` (the B5 suite, 19 → 29)                                 | 10    | 29/29  |
| `tests/integration/r10-char-checkout-parity.test.ts` (the B1 suite, 9 → 11)                                    | 2     | 11/11  |

**Item 1 tests:**

- the redactor does cut the example id (the bug's premise), and `safeIdentifier` keeps it;
- every non-strict-UUID input is still rejected: the same digits outside a UUID, upper case, braces, text prefix, UUID plus PAN, version 0, variant 1 with a Luhn-valid run, PAN, grouped PAN, link and the length bound. Old non-UUID ids still pass;
- the payment-link event keeps `customerId`/`orderId`, and the presented alert carries the customer's name and the USER button.

**Item 2 tests:**

- `L8 ... (referrer imported × referee imported)`, 4 cases. Each runs through the shipped container: invite, `/start ref-` payload, wallet purchase, provisioner delivery, commission. Each reads what the operations chat received.
- `L8: a commission on an order the import wrote stays silent`.
- `L9 ... each side once (referrer imported × referee imported)`, 4 cases: the referee claims, then the referrer claims, and two L9 messages arrive.
- `L9: a gift of a referral the import carried stays silent; the same gift of this installation's referral is logged`. `referrals` is append-only, so this test writes the import's row the way the referral-history step does. The shipped `ops-log.ledger` consumer is then handed each entry's event, with a NEXA control in the same test.
- The suite's fake Telegram now answers `getMe`, because the invite needs the bot's username.

**Item 3 tests:**

- `refuses card to card before confirming a draft once it is not offered, on both, and confirms nothing`. Both surfaces are refused: bot `bot.payment.unconfigured`; mini app 409 `commerce.payment_method_unavailable`. Both orders stay DRAFT, with no payment, no `order.confirm` audit and no capacity reservation. Switched back on, both drafts are confirmed and issued.
- `OrderService.confirm refuses an order on an existing service, in any state; its own lane confirms it`.
- The 9 existing B1 characterization cases are green and unchanged.

**Mutation checks.** Each mutation was applied, the named tests went red, and the mutation was reverted to green. Mutations that hit disjoint tests were run together.

| Mutation                                                                   | Red                                                                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `safeIdentifier`: the strict-UUID branch removed                           | the two A6 tests that depend on it (premise/keep, alert); the rejection test stays green as it should |
| `LedgerLogConsumer.commission`: `referrer.source !== 'NEXA'` put back      | L8 referrer-imported (2)                                                                              |
| `LedgerLogConsumer.commission`: the order `source` check removed           | L8 import-created                                                                                     |
| `LedgerLogConsumer.gift`: `referee.source !== 'NEXA'` put back             | L9 referee-imported (2), plus the L9 import-created test (its control's referee is imported)          |
| `LedgerLogConsumer.gift`: the referral `source` check removed              | L9 import-created                                                                                     |
| `CheckoutService.payByCard`: the `manualTransferOffered` pre-check removed | the card-refusal case                                                                                 |
| `OrderService.confirm`: the commercial-purpose refusal removed             | the OrderService.confirm case                                                                         |

**Local gate:**

- selected unit suites: ops-log ×8, refusal-coverage, bot-runtime — 282/282;
- the selector's money and ops-log integration suites: chunk 1 188/188, chunk 2 258/258, chunk 3 276/276 (incl. r9-char-checkout-payment, custom-service, service-auto-renew, refunds, payments, referrals, wallet*, imported-customer-ops-logs/ops-log-types/r8-admin-wallet/referral-signup-gift 68/68);
- `pnpm verify`: `passed=13465 failed=0 skipped=0`, exit 0 (the first run failed only in `backup-cli.test.ts`, 5 tests, because `apps/api/dist` did not exist in the fresh worktree; it passed after `pnpm build`).

## Decisions

- **Item 1:** a strict UUID (RFC version and variant, lowercase) is accepted by format inside `safeIdentifier` itself, so every caller gets the fix, including the presenter's re-read. Any other shape keeps the old rule, so no non-UUID value can newly be printed. I did not change the card redactor. It still cuts such a UUID in free-text log lines (its `<hex>-` lookbehind does not cover a run that starts mid-group). That is out of A6's scope and is listed as an open problem.
- **Item 2:** "import-created" is read from the record each line is about: the order for L8, the referral for L9. The import writes no commission or gift entries, so no entry-level provenance column is needed.
- **Item 3a:** "offered" means the menu's rule, `manualTransferOffered(scope)`, which is not per customer (`OQ-5C-01` stands). The check applies only before a DRAFT is confirmed. The refusal reuses `PAYMENT_METHOD_UNAVAILABLE`, so no Persian copy is new or rewritten.
- **Item 3b:** the typed refusal reuses `ORDER_STATE_INVALID` with a `reason` detail instead of adding a contract error code. No caller reaches it, and a new code would need contract, web and bot-copy changes for an unreachable caller bug. If the lead prefers a distinct code, that is a one-line contract commit plus the web, refusal and test updates.

## Migrations

None.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012oQ3P4LLkQ6BD3XRDpbPck
