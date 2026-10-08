# Migration P2 — the legacy opening balance

Status: built (schema, contracts, service, tests). The importer that calls it (P7) is
**HOLD**; nothing in this repository calls the service outside the tests.

## What it does

Each legacy customer's `user.Balance` (Toman) becomes **one** wallet ledger entry in NEXA:

| Field                              | Value                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `reason`                           | `MIGRATION_OPENING_BALANCE` (contract, `packages/contracts/src/ledger.ts`)  |
| `direction`                        | `CREDIT` — a positive balance only (a negative one is a legacy debt, below) |
| `amount`                           | `                                                                           | legacy Balance | `in minor units;`IRT` has 0 minor digits, so Toman = minor |
| `currency`                         | the tenant's `sales.currency` (refused otherwise)                           |
| `reference`                        | `legacy:opening:<telegram_user_id>` (`migrationOpeningReference`)           |
| order / payment / reversal / admin | all NULL (CHECK-pinned)                                                     |

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
- **Negative** (38 legacy users in the historical staging snapshot — a dated baseline,
  never an expected count; the cutover snapshot is newer): **held for review, never a
  ledger entry** (owner decision 6, 2026-10-07; Mirza PR4). See the next section.

## Negative balances (owner decision 6 — Mirza PR4)

The owner decided on 2026-10-07: a negative legacy balance is HELD FOR REVIEW. Before that
decision this service wrote it as a `DEBIT` of the magnitude without `canCover`, so the
wallet opened negative and the customer's next top-up silently repaid it — the debt was in
effect collected. That path is gone:

| What           | Now                                                                                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ledger         | **No entry.** The NEXA balance is untouched (0 for a new customer).                                                                                                                                                                     |
| Record         | One row in `legacy_wallet_debts` (migration 0226): the MAGNITUDE owed, `IRT`, the legacy user id, the customer, the v1 source fingerprint, the `user:v1` row checksum, the import run, whether the source was synthetic, `recorded_at`. |
| Audit          | `legacy.wallet_debt.recorded` (entity = the debt's id; no Telegram id; `ledgerEntry: null`).                                                                                                                                            |
| Outcome        | `DEBT_RECORDED` (with `amountMinor`); `DEBT_ALREADY_RECORDED` on a rerun.                                                                                                                                                               |
| Map row        | Unchanged: `IMPORTED` / `CUSTOMER` with warning reason `NEGATIVE_BALANCE`.                                                                                                                                                              |
| Collection     | **Never.** No top-up, purchase, refund, clawback, settlement or balance query reads the table (`tests/unit/legacy-wallet-debts-boundary.test.ts`).                                                                                      |
| Owner decision | Per customer in the Web Admin (`/legacy-debts`): `PENDING_REVIEW` → `ACKNOWLEDGED` \| `WAIVED`, and reopen. A label: none of them moves money.                                                                                          |

- **Idempotent like the opening.** One debt per `(tenant, customer)` and per
  `(tenant, legacy user id)` (unique keys). A rerun with the same figure is `DEBT_ALREADY_RECORDED`;
  a different figure — another amount, a non-negative balance after a debt, a negative
  one after a CREDIT opening — is `platform.idempotency_payload_mismatch` (the importer
  counts `CONFLICT`). So is a debt recorded from a SYNTHETIC source met by a real one (or
  the reverse): test data is never taken for a real debt (PR3's review lesson, #232).
- **Immutable facts.** 0227: the amount, currency, legacy user, customer, fingerprint,
  checksum, run, `synthetic` and `recorded_at` are never rewritten, and a debt is never
  deleted, for every role. Only the decision columns move, by a conditional UPDATE at the
  version the operator saw.
- **Provenance is required.** A negative balance without its provenance (`runId`,
  `sourceFingerprint`, `rowChecksum`, `synthetic`) is refused before anything is read.
- **Collecting a debt is OUT OF SCOPE.** It would need a new ledger reason (e.g. a
  `LEGACY_DEBT_COLLECTION` debit — a contract change) and an explicit owner instruction.
  Neither exists; nothing in this release can take money for a legacy debt.

### Rows the code before the decision may already have written

`legacy:opening:<telegram_user_id>` DEBIT rows were written by every APPLY run of the
importer before this change, wherever it ran:

- **CI and local synthetic rehearsals** — certainly: the synthetic fixture has one negative
  user (`100000003`, −20 000). Those databases are throwaway.
- **A real-data rehearsal on a non-production target** — UNKNOWN whether one was run
  (`OQ-LWD-01`); the repository records no real-archive result (readiness G5–G18 open).
- **Production** — none: no production import has ever run.

They are **not rewritten** (the ledger is append-only, and this PR changes no ledger row). A
rerun of the importer on such a target meets the DEBIT and answers `PRIOR_DEBIT_OPENING`:
nothing written, no debt beside it (that would count it twice), counted in the run's
`attention.priorDebitOpening` so the verdict is `COMPLETED_WITH_FAILURES`, and reconcile's
`usersWallets` U6/U7 fail. The remedy is the one the rollback runbook already gives: restore
the target to its pre-import state (the database-rename rollback) and import again with
this code. Never "fix" the ledger by hand.

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

- Collecting, netting or converting a legacy debt (owner instruction + a new ledger reason).
- Making a legacy agent a NEXA reseller (`OQ-LWD-03`).
- Production import and reconciliation (manual acceptance; no legacy DB exists in this
  environment). After a real run on the CUTOVER snapshot — whose figures are new; the
  staging snapshot's (`SUM(user.Balance) = 2,874,365,519` Toman, 60,217 positive and 38
  negative balances, as of the historical staging read) are dated baselines, never
  expected values — `reconcile` must show: Σ `MIGRATION_OPENING_BALANCE` entries = Σ
  POSITIVE legacy balances of imported users, one entry per positive balance, Σ legacy
  debts = Σ |negative| balances, one debt per negative balance, and no DEBIT opening
  (`usersWallets` U2–U6, `docs/legacy-migration/reconciliation.md` §6).
