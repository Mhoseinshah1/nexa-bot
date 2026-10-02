# Customer 360 — account transfer: audit and design

Spec §11.5: `انتقال حساب کاربری` — move a customer's holdings from one Telegram identity
to another, with a preview, collision detection, an explicit confirmation, audit,
idempotency and a single transaction. **Not** a Telegram-id `UPDATE`.

Implementation: `CustomerAccountTransferService`
(`apps/api/src/modules/commerce/customers/application/customer-account-transfer.service.ts`),
its repository, migration `0158_customer_360` / `0159_customer_360_guards`, and
`tests/integration/customer-360.test.ts` (`account transfer`).

## 1. Why the identity does not move

`customers.telegram_user_id` is the identity (`customers_tenant_telegram_key`). Re-pointing
it would silently re-attribute every row that names the customer — orders, payments,
referral attribution, audit — to a different person, and would collide with the
destination's own row. So the **customer row stays**. What moves is what a customer
HOLDS: live services and wallet balance. History stays with the identity that made it.

## 2. Every table that references a customer

Found from `pg_constraint` (every FK to `customers`) plus every `*customer*`, `referrer_id`,
`referee_id` column. "Moves" means the transfer writes it; "Stays" means it is left alone;
"Blocks" means a live row of that kind refuses the transfer.

| table                                                                                                                                                                                                                                                                              | decision                             | why                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services`                                                                                                                                                                                                                                                                         | **Moves** (live, non-trial)          | through a `service_ownership_transfers` row each — the only way `nexa_services_ownership_guard` admits a change of `services.customer_id`, and Package F's own evaluator decides each one |
| `service_ownership_transfers`                                                                                                                                                                                                                                                      | **Written**                          | one per moved service, `actor_type` WEB_ADMIN, `bot_instance_id` NULL (0158 makes it nullable; a CHECK keeps it NOT NULL for CUSTOMER rows)                                               |
| `wallet_entries`                                                                                                                                                                                                                                                                   | **Written** (pair)                   | `ACCOUNT_TRANSFER_OUT` DEBIT of the source + `ACCOUNT_TRANSFER_IN` CREDIT of the destination, same amount, same transaction. Never a balance column, never a rewrite of old entries       |
| `customer_account_transfers`                                                                                                                                                                                                                                                       | **Written**                          | the record (append-only, unique key), naming the services, amount and both entries                                                                                                        |
| `orders`, `payments`, `refunds`, `payment_receipts`, `gateway_*`, `receipt_captures`                                                                                                                                                                                               | Stays                                | the payer is a fact; `orders.customer_id` is frozen by `nexa_orders_snapshot_guard` anyway                                                                                                |
| `orders` AWAITING_PAYMENT, or PAID with no service yet                                                                                                                                                                                                                             | **Blocks** `ORDER_IN_PROGRESS`       | it would settle or provision against the source after the move                                                                                                                            |
| `payments` PENDING / UNKNOWN                                                                                                                                                                                                                                                       | **Blocks** `PAYMENT_PENDING`         | money in flight; UNKNOWN is never decided by guessing                                                                                                                                     |
| `order_cashback` PENDING, `order_referral_commissions` PENDING (source as referrer)                                                                                                                                                                                                | **Blocks** `REWARD_PENDING`          | it would be earned into the source's wallet after the balance left                                                                                                                        |
| `bulk_operation_items` PENDING / PLANNED                                                                                                                                                                                                                                           | **Blocks** `BULK_OPERATION_PENDING`  | a mass credit would land on the source                                                                                                                                                    |
| a live non-trial service the evaluator refuses (PENDING_PROVISION, UNRECONCILED, undelivered link, undecided operation, open refund request, renewal awaiting payment)                                                                                                             | **Blocks** `SERVICE_UNSETTLED`       | never moved half-way; same rule as Package F §4                                                                                                                                           |
| `resellers` (source)                                                                                                                                                                                                                                                               | **Blocks** `SOURCE_IS_RESELLER`      | a reseller standing, its terms and `order_reseller_terms` are a per-customer contract an operator must decide on                                                                          |
| wallet balance below zero (legacy debt)                                                                                                                                                                                                                                            | **Blocks** `SOURCE_BALANCE_NEGATIVE` | a debt is never moved or collected                                                                                                                                                        |
| `resellers` (destination)                                                                                                                                                                                                                                                          | Warning                              | moved services are just owned; reseller pricing applies only to future orders                                                                                                             |
| trial services (`services.is_trial`), `trial_grants`, `trial_limit_overrides`                                                                                                                                                                                                      | Stays (warning)                      | a trial counts against its claimant's allowance; moving it would turn any account into a trial for another                                                                                |
| EXPIRED / TERMINATED / refunded-away services                                                                                                                                                                                                                                      | Stays                                | history; Package F's evaluator does not move EXPIRED either                                                                                                                               |
| `referrals`, `referral_codes`, `referral_signup_gifts`, `referral_commission_reversals`                                                                                                                                                                                            | Stays                                | an attribution is made at registration and never changed                                                                                                                                  |
| `customer_location_change_overrides`, channel exemption, verified phone, marketing opt-out                                                                                                                                                                                         | Stays (warning)                      | the source's own settings; the destination keeps its own — nothing of the destination's is overwritten                                                                                    |
| `tickets`                                                                                                                                                                                                                                                                          | Stays (warning when open)            | a conversation with that identity                                                                                                                                                         |
| `discounts.customer_id`, `discount_redemptions`, `custom_service_price_rules.customer_id`                                                                                                                                                                                          | Stays                                | personal pricing granted to that identity; an operator may grant it again                                                                                                                 |
| `service_commercial_actions`, `service_location_changes`, `service_refund_requests`, `provisioning_operations.requested_by_customer_id`, `service_username_reservations`                                                                                                           | Stays                                | history keyed to the order/payer. A source's abandoned DRAFT cannot be paid into a moved service: confirmation and settlement require the payer to own the service (Package F §4)         |
| `customer_notifications`, `wallet_threshold_alerts`, `broadcast_recipients`, `frozen_audience_members`, `customer_text_captures`, `username_captures`, `discount_code_captures`, `admin_amount_captures`, `reseller_*_overrides`, `reseller_minimum_notices`, `cashback_reversals` | Stays                                | messages and windows about the source identity; history                                                                                                                                   |

`wallet_threshold_alerts`: the low-balance sweep skips a crossing whose entry is
`ACCOUNT_TRANSFER_OUT`, so the abandoned account is not told it is running low.

## 3. Collisions

The destination is never overwritten: the transfer only ADDS rows to it (owned services, a
credit). A collision is therefore a state of the pair that makes the move wrong, and each is
a blocker in `CUSTOMER_TRANSFER_BLOCKERS`: `SAME_CUSTOMER`, `DESTINATION_UNKNOWN`
(another tenant's customer is exactly as unknown), `DESTINATION_BLOCKED`, plus every
"Blocks" row above, and `NOTHING_TO_MOVE`.

## 4. The transaction

1. Permission `users.view` + `users.transfer` (owner only), denial audited; a reason is
   required; the operator types the destination's numeric id again
   (`CUSTOMER_TRANSFER_CONFIRMATION_MISMATCH` otherwise).
2. Replay: `customer_account_transfers (tenant, idempotency_key)` is unique; the same key
   answers the row it wrote. A key reused for another source or fingerprint is refused.
3. One `uow.run`: scope activity; the key again (a concurrent duplicate); both customers'
   wallet locks in id order (the canonical `customer -> service` order); each live service's
   row lock then lifecycle lock (the locks terminate, refund requests and commercial
   settlement serialise on); the plan re-derived under them.
4. Any blocker → `CUSTOMER_TRANSFER_REFUSED` with the list; a plan whose fingerprint
   (destination, moved service ids, amount, currency) differs from the confirmed preview →
   `CUSTOMER_TRANSFER_PREVIEW_STALE`. Nothing written.
5. Writes: per service — ownership row, reassignment, `service.transfer` audit,
   `ServiceOwnershipTransferred`; the ledger pair with `wallet.transfer_out/in` audits and
   `WalletEntryRecorded`; the record; `customer.account_transfer` (source) and
   `customer.account_transfer.received` (destination) audits; `CustomerAccountTransferred`.

A deadlock with a concurrent settlement can only abort the transaction (PostgreSQL 40P01),
which writes nothing; the operator previews again.

## 5. What is deliberately not done

- No customer notification: the destination is the same person, told by the operator.
- The source is not blocked automatically; that is the existing block action.
- Only the selling currency's balance moves; an entry in another currency (from before a
  `sales.currency` change) stays.
