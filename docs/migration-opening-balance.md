# Migration P2 — the legacy opening balance

Status: built (schema, contracts, service, tests). The importer that calls it (P7) is
**HOLD**; nothing in this repository calls the service outside the tests.

## What it does

Each legacy customer's `user.Balance` (Toman) becomes **one** wallet ledger entry in NEXA:

| Field                              | Value                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `reason`                           | `MIGRATION_OPENING_BALANCE` (contract, `packages/contracts/src/ledger.ts`) |
| `direction`                        | `CREDIT` for a positive balance, `DEBIT` (of the magnitude) for a negative |
| `amount`                           | `                                                                          | legacy Balance | `in minor units;`IRT` has 0 minor digits, so Toman = minor |
| `currency`                         | the tenant's `sales.currency` (refused otherwise)                          |
| `reference`                        | `legacy:opening:<telegram_user_id>` (`migrationOpeningReference`)          |
| order / payment / reversal / admin | all NULL (CHECK-pinned)                                                    |

`wallet_transaction` is **not** replayed: the legacy balance is the migration-time truth.

## Semantics

- **New NEXA customer:** final balance = legacy balance.
- **Existing NEXA customer** (matched on `(tenant, telegram_user_id)` by the importer):
  final balance = pre-import NEXA balance + legacy balance. The service is additive only;
  there is no set-balance mode.
- **Zero:** no entry is written — `wallet_entries_amount_check` requires `amount > 0`, and
  the balance is already right. The service answers `ZERO_NO_ENTRY` (never a fake
  "posted"); the importer's run metadata (P4) records the decision. A zero after a non-zero
  opening was already posted is a payload mismatch, not a silent no-op.
- **Negative (38 legacy users):** a `DEBIT` written **without** the overdraft check. This is
  the only path that may take a wallet below zero: the debt already exists and is recorded,
  not created. Every ordinary debit (`WalletService.adjust`, purchases, clawbacks) still runs
  `canCover` with a zero allowance, so a wallet that opens negative refuses the next ordinary
  debit until credits bring it to cover (`docs/reseller-phase3-closure.md`: no credit, never
  below zero by an ordinary path). The negative opening is reported as legacy debt.

## Write path

`MigrationOpeningBalanceService.post(scope, actor, command)`
(`apps/api/src/modules/commerce/wallet/application/migration-opening-balance.service.ts`):

1. Actor: `systemJobActor('legacy-import:<run>', …)` — `SYSTEM_JOB`.
2. Permission: `maintenance.run` (the one `SYSTEM_JOB_PERMISSIONS` key), charged before any
   read and audited `DENIED` on refusal. No HTTP, Telegram or web surface exists.
3. Validation: customer uuid, Telegram id (`telegramUserIdSchema`), `|amount| ≤
PAYMENT_AMOUNT_MAX_MINOR`.
4. In ONE transaction: `ScopeActivityReader` (a stopped tenant is refused); the customer
   exists in this tenant **and** its `telegram_user_id` equals the command's legacy id (the
   reference is derived from it); the currency is the selling currency; the customer row is
   locked (`lockCustomer`, the wallet's serialisation point); the reference is looked up;
   the entry is appended; audit `wallet.migration_opening_balance` with the entry and its
   signed amount (no balance); outbox `WalletEntryRecorded`.

Outcomes: `POSTED` (with the entry's `signedAmountMinor`), `ALREADY_POSTED` (identical opening
present — nothing written, no audit, no event), `ZERO_NO_ENTRY`.

**No after-balance is reported or audited.** Ordinary credits do not take the customer
lock (only debits do), so a credit committing while the opening's transaction runs is
missing from any balance read inside it yet present in the wallet afterwards; an
"after" figure would be a snapshot presented as authoritative (Codex review of PR #170).
The outcome and the audit carry only facts of the entry itself; the balance is the ledger.

## Idempotency

The reference **is** the idempotency key — derived from the legacy identity, so a rerun, a
resume after a crash and two racing importers compute the same one without stored state.

- `wallet_entries_tenant_reference_key` (existing): one entry per `(tenant, reference)`.
- `wallet_entries_migration_opening_customer_key` (new, partial unique): one opening per
  `(tenant, customer)` whatever reference a writer derived.
- `wallet_entries_migration_opening_shape_check` (new): the reason and the `legacy:opening:`
  prefix imply each other, and the opening names no order, payment, reversal or admin.
- A rerun with a **different** figure (or sign, or zero) is refused with
  `platform.idempotency_payload_mismatch`, never answered with the first figure.

## Reporting

`WALLET_REPORT_GROUP_OF.MIGRATION_OPENING_BALANCE = 'OPENING_BALANCE'`, a group of its own.
`financial-statement.ts` files it on the wallet section only (the `default` branch), so it
is never sales, revenue, a top-up, cash, a gift or a grant; sales and revenue read
`orders`/`payments` and never the ledger. The wallet liability shows it as its own
movement, and opening + Σ movements = closing still holds. The Web Admin labels it
«موجودی افتتاحیه (انتقال از ربات قبلی)».

## Tests

- `tests/integration/migration-opening-balance.test.ts` — positive, zero, negative,
  ordinary debits still refused after a negative opening, existing-customer additive (both
  signs), retry, changed-figure rerun, six concurrent importers → one entry, tenant
  isolation, wrong legacy id, wrong currency, permission denied + audited, stopped tenant,
  the DB constraints directly, and report classification (financial, wallet, dashboard)
  with the wallet identity against an independent balance read. Mutation-checked: filing
  the reason as `TOPUP`, accepting a changed figure, and dropping the telegram-id match
  each fail it. The outcome and the audit row are pinned by SHAPE to carry the entry's
  signed amount and no balance; re-adding a balance to either (audit `balanceMinor`, outcome
  `balanceAfterMinor`) fails it.
- `tests/unit/financial-statement.test.ts`, `tests/unit/reporting-contracts.test.ts` — the
  filing rule and the reference format, pure.

## Not done here (HOLD or manual)

- The P7 importer (reads legacy MySQL, resolves/creates customers, calls `post`). HOLD.
- Production import and reconciliation against `SUM(user.Balance) = 2,874,365,519` Toman:
  after a real run, `Σ signed MIGRATION_OPENING_BALANCE entries` must equal that sum (minus
  any skipped test users), and the count of entries must equal the number of non-zero
  legacy balances (60,217 + 38). Manual acceptance; no legacy DB exists in this environment.
