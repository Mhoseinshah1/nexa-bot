/**
 * Database schema — wallet: the ledger, history imports, receipt credits, threshold alerts, gift cards.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  CURRENCY_CODES,
  WALLET_HISTORY_IMPORT_ORIGINS,
  WALLET_HISTORY_IMPORT_TEXT_MAX_LENGTH,
  RECEIPT_REVIEW_PUSH_STATES,
  RECEIPT_CREDIT_NOTE_MAX_LENGTH,
  LEDGER_DIRECTIONS,
  LEDGER_REASONS,
  GIFT_CARD_BATCH_STATES,
  GIFT_CARD_CODE_STATES,
  GIFT_CARD_REJECTIONS,
} from '@nexa/contracts';
import { enumCheck, nullableEnumCheck, timestamptz } from './_shared.js';
import { botInstances, tenants } from './tenancy.js';
import { admins } from './identity.js';
import { customers } from './customers.js';
import { orders } from './orders.js';
import { paymentReceipts, payments } from './payments.js';

/**
 * The wallet ledger — append-only, and the only authority on a balance.
 *
 * There is no balance column anywhere in this schema. A balance is
 * `SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)` over a customer's
 * entries, and the index below is what makes that a single ranged scan. The legacy
 * system's mutable balance column with no ledger is what produces its unexplained
 * 916,550 residual.
 *
 * `amount` is always POSITIVE and `direction` carries the sign, which `ledger.ts`
 * fixes. A signed amount column would let a CREDIT of -500 express a debit, and then
 * two representations of one movement exist.
 *
 * `reference` is the idempotency identity of a MOVEMENT, unique per tenant. It is what
 * makes a double debit impossible under a retried command: the second insert violates
 * the index and the whole transaction rolls back.
 *
 * The table is append-only by trigger, like `audit_logs` — see the migration. A reversal
 * is a new entry naming the original in `reverses_entry_id`, never an edit.
 */
export const walletEntries = pgTable(
  'wallet_entries',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    direction: text('direction').notNull(),
    reason: text('reason').notNull(),
    /** Always positive. The sign lives in `direction`. */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The movement's idempotency identity, unique per tenant. */
    reference: text('reference').notNull(),
    /** Set for a `REVERSAL_REASONS` entry, naming the entry it reverses. */
    reversesEntryId: uuid('reverses_entry_id'),
    orderId: uuid('order_id'),
    paymentId: uuid('payment_id'),
    /** Who caused it, when that was an administrator rather than a flow. */
    actorAdminId: uuid('actor_admin_id').references(() => admins.id),
    /** Bounded operator note. Never customer text. */
    note: text('note'),
    /**
     * R4 A5: «نمایش دلیل به مشتری» — the administrator chose, when writing an ADMIN_CREDIT or
     * ADMIN_DEBIT, that the customer's adjustment message quotes `note` as its reason.
     * FALSE for every other entry and for every entry written before the column existed,
     * so no note ever reaches a customer that was not written to be shown. Written with the
     * entry and never changed (the table is append-only).
     */
    noteShownToCustomer: boolean('note_shown_to_customer').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'wallet_entries_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'wallet_entries_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'wallet_entries_payment_fk',
    }),
    /** The one thing that makes a double debit impossible rather than unlikely. */
    uniqueIndex('wallet_entries_tenant_reference_key').on(table.tenantId, table.reference),
    /**
     * The balance scan, and the history page, in one index.
     *
     * `(customer_id, created_at, id)` — the sum reads the whole of a customer's slice
     * and the page reads the tail of it, so one index serves both and neither needs a
     * sort.
     */
    index('wallet_entries_customer_created_idx').on(table.customerId, table.createdAt, table.id),
    index('wallet_entries_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    check('wallet_entries_direction_check', enumCheck('direction', LEDGER_DIRECTIONS)),
    check('wallet_entries_reason_check', enumCheck('reason', LEDGER_REASONS)),
    check('wallet_entries_currency_check', enumCheck('currency', CURRENCY_CODES)),
    /** Positive, always. This is the invariant the whole ledger rests on. */
    check('wallet_entries_amount_check', sql`amount > 0`),
    /**
     * A top-up credit names the payment that funded it.
     *
     * `TOPUP_RECEIPT` is the ledger's answer to "where did this money come from", and
     * without the payment it answers "a transfer, some time, decided by somebody". The
     * column has existed since 4C; this is what makes it required for the one reason
     * whose whole meaning is the payment.
     */
    check(
      'wallet_entries_topup_payment_check',
      sql`reason <> 'TOPUP_RECEIPT' OR payment_id IS NOT NULL`,
    ),
    /**
     * ONE top-up credit per payment, decided by the database.
     *
     * The rule 5B rests on, and it is keyed on the PAYMENT rather than on the
     * confirming command: two operators pressing approve together, a redelivered
     * request, a retry after a crash between the confirm and the append — and a future
     * gateway callback funding the same top-up — all name the same payment, so all but
     * one of them conflict here. The derived reference in `WalletTopupService` produces
     * the same guarantee from the other direction; this is the one a convenience
     * refactor cannot remove by accident.
     */
    uniqueIndex('wallet_entries_topup_payment_key')
      .on(table.tenantId, table.paymentId)
      .where(sql`reason = 'TOPUP_RECEIPT'`),
    /**
     * A receipt credit names the payment whose receipt it disposed of (Payment File 02
     * §12, D2). The top-up rule above, for the second reason whose whole meaning is a
     * payment.
     */
    check(
      'wallet_entries_receipt_credit_payment_check',
      sql`reason <> 'RECEIPT_CREDIT' OR payment_id IS NOT NULL`,
    ),
    /**
     * ONE receipt credit per payment, decided by the database — invariant 8 of Payment
     * File 02 §23, held here on its own and again by `receipt_credits`' primary key. Two
     * reviewers crediting together, a retry, and a writer that forgot the disposition row
     * all name the same payment. `<paymentId>:receipt-credit` gives the same guarantee
     * through the reference key; this is the one a change to the reference cannot remove.
     */
    uniqueIndex('wallet_entries_receipt_credit_payment_key')
      .on(table.tenantId, table.paymentId)
      .where(sql`reason = 'RECEIPT_CREDIT'`),
    /**
     * A top-up gift names the top-up that earned it (D5), and there is ONE per payment:
     * invariant 11. A replayed confirmation, a racing one and a future gateway callback
     * all name the same payment, so all but one conflict here.
     */
    check(
      'wallet_entries_topup_cashback_payment_check',
      sql`reason <> 'CASHBACK_TOPUP' OR payment_id IS NOT NULL`,
    ),
    uniqueIndex('wallet_entries_topup_cashback_payment_key')
      .on(table.tenantId, table.paymentId)
      .where(sql`reason = 'CASHBACK_TOPUP'`),
    /**
     * A GATEWAY top-up credit (WP11A) names its payment and is once per payment: the
     * `TOPUP_RECEIPT` pair, for the reason whose whole meaning is a gateway's payment. A
     * webhook, an inquiry and a racing settlement all name the same payment, so all but
     * one conflict here.
     */
    check(
      'wallet_entries_topup_gateway_payment_check',
      sql`reason <> 'TOPUP_GATEWAY' OR payment_id IS NOT NULL`,
    ),
    uniqueIndex('wallet_entries_topup_gateway_payment_key')
      .on(table.tenantId, table.paymentId)
      .where(sql`reason = 'TOPUP_GATEWAY'`),
    /**
     * R5A item 4: a LATE gateway approval's credit names its payment and is once per payment,
     * decided by the database. The reference key (`<paymentId>:late-credit`) is the primary
     * rule; the partial unique index `wallet_entries_gateway_late_credit_payment_key` is the
     * backstop a change to the reference cannot remove, built concurrently in
     * `online-indexes.ts` (it is not declared here). A webhook, a
     * repeated inquiry, a polling pass and a replica racing another all name the same payment,
     * so all but one conflict here.
     */
    check(
      'wallet_entries_gateway_late_credit_payment_check',
      sql`reason <> 'GATEWAY_LATE_CREDIT' OR payment_id IS NOT NULL`,
    ),
    /**
     * Migration P2: a legacy opening balance and its reference prefix are ONE thing.
     *
     * In both directions. A `MIGRATION_OPENING_BALANCE` entry is written under
     * `legacy:opening:<telegram_user_id>` and nothing else, so its idempotency identity is
     * the legacy identity; and the prefix belongs to that reason alone, so no other writer
     * can occupy the reference a rerun of the import would conflict on and turn the
     * opening into a silent no-op. It names no order, payment, reversal or administrator:
     * it is an inherited balance, not a sale, a top-up, an undo or an operator's grant.
     * `left(...)` rather than `LIKE`, whose `_` would be a wildcard.
     */
    /**
     * R10 D4: a gift card redemption and its reference prefix are ONE thing, in both
     * directions, like the opening balance below. A `GIFT_CARD_REDEMPTION` entry is written
     * under `giftcard:<codeId>` and nothing else, so `wallet_entries_tenant_reference_key`
     * allows ONE credit per code whoever writes it; and the prefix belongs to that reason
     * alone, so no other writer can occupy a code's reference. It is a CREDIT that names no
     * order, payment, reversal or administrator: no operator decided this credit and no
     * payment arrived with it. `left(...)` rather than `LIKE`, whose `_` is a wildcard.
     */
    check(
      'wallet_entries_gift_card_shape_check',
      sql`(reason = 'GIFT_CARD_REDEMPTION') = (left(reference, 9) = 'giftcard:')
        AND (reason <> 'GIFT_CARD_REDEMPTION' OR (direction = 'CREDIT' AND order_id IS NULL
          AND payment_id IS NULL AND reverses_entry_id IS NULL AND actor_admin_id IS NULL))`,
    ),
    /**
     * Reseller-phase PR-6: a dedicated bot's fee and its reference prefix are ONE thing, in both
     * directions. A `HOSTED_BOT_FEE` entry is written under `hosted-bot-fee:<request>:<period>`
     * and nothing else, so `wallet_entries_tenant_reference_key` allows ONE debit per period
     * whoever writes it; and the prefix belongs to that reason alone. It is a DEBIT naming no
     * order, payment, reversal or administrator. `left(...)` rather than `LIKE`.
     */
    check(
      'wallet_entries_hosted_bot_fee_shape_check',
      sql`(reason = 'HOSTED_BOT_FEE') = (left(reference, 15) = 'hosted-bot-fee:')
        AND (reason <> 'HOSTED_BOT_FEE' OR (direction = 'DEBIT' AND order_id IS NULL
          AND payment_id IS NULL AND reverses_entry_id IS NULL AND actor_admin_id IS NULL))`,
    ),
    check(
      'wallet_entries_migration_opening_shape_check',
      sql`(reason = 'MIGRATION_OPENING_BALANCE') = (left(reference, 15) = 'legacy:opening:')
        AND (reason <> 'MIGRATION_OPENING_BALANCE' OR (order_id IS NULL AND payment_id IS NULL
          AND reverses_entry_id IS NULL AND actor_admin_id IS NULL))`,
    ),
    /**
     * ONE opening balance per customer, decided by the database. The reference key above
     * already makes one per Telegram id; this is the rule stated about the CUSTOMER, so a
     * writer that derived the reference from anything else still cannot open a wallet twice.
     */
    uniqueIndex('wallet_entries_migration_opening_customer_key')
      .on(table.tenantId, table.customerId)
      .where(sql`reason = 'MIGRATION_OPENING_BALANCE'`),
    unique('wallet_entries_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * Mirza wallet history carried by the one-time import (`docs/migration/mirza-import-plan-fa.md`
 * §5-3): the movement log (`wallet_transaction`) and the wheel results.
 *
 * A SISTER of `wallet_entries`, never a part of it. The customer's balance is `user.Balance`,
 * written once as the opening entry; these rows are what Mirza LOGGED on the way there, so
 * summing them into the balance would count the same money twice, and writing them to the
 * ledger would need a compensating row — touching money twice. Nothing derives a balance from
 * this table, and `WalletRepository.balanceOf` does not read it. Append-only (migration
 * triggers), keyed by `(tenant_id, source_ref)` so a rerun finds its row.
 *
 * `amount_minor` is the magnitude and `signed_amount_minor` the figure exactly as Mirza stored
 * it; `direction` is null when Mirza's own arithmetic does not say which way the money moved.
 */
export const walletHistoryImports = pgTable(
  'wallet_history_imports',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    source: text('source').notNull().default('MIRZA'),
    /** `wallet-tx:<id>` or `wheel:<id>`: the Mirza id. Unique per tenant. */
    sourceRef: text('source_ref').notNull(),
    origin: text('origin').notNull(),
    occurredAt: timestamptz('occurred_at').notNull(),
    direction: text('direction'),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    signedAmountMinor: bigint('signed_amount_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    rawKind: text('raw_kind'),
    note: text('note'),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'wallet_history_imports_customer_fk',
    }),
    uniqueIndex('wallet_history_imports_tenant_source_ref_key').on(table.tenantId, table.sourceRef),
    /** The customer's history page: newest first over the immutable `(occurred_at, id)`. */
    index('wallet_history_imports_customer_idx').on(
      table.tenantId,
      table.customerId,
      table.occurredAt,
      table.id,
    ),
    check('wallet_history_imports_source_check', sql`source = 'MIRZA'`),
    check(
      'wallet_history_imports_origin_check',
      enumCheck('origin', WALLET_HISTORY_IMPORT_ORIGINS),
    ),
    check(
      'wallet_history_imports_direction_check',
      nullableEnumCheck('direction', LEDGER_DIRECTIONS),
    ),
    check('wallet_history_imports_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check(
      'wallet_history_imports_amount_check',
      sql`amount_minor >= 0 AND amount_minor = abs(signed_amount_minor)`,
    ),
    check(
      'wallet_history_imports_text_check',
      sql`length(source_ref) BETWEEN 1 AND 128 AND (raw_kind IS NULL OR length(raw_kind) <= ${sql.raw(String(WALLET_HISTORY_IMPORT_TEXT_MAX_LENGTH))}) AND (note IS NULL OR length(note) <= ${sql.raw(String(WALLET_HISTORY_IMPORT_TEXT_MAX_LENGTH))})`,
    ),
  ],
);

/**
 * A card-to-card receipt's credit-to-wallet disposition (Payment File 02 §12,
 * `docs/payments-file02-design.md` D2).
 *
 * One of a receipt's three mutually exclusive final dispositions — approve, reject, or
 * this — and the only one that needs its own row: approve and reject are the payment's
 * own CONFIRMED and FAILED. A credit moves the payment `PENDING -> FAILED` through the
 * same conditional UPDATE a rejection uses, and this row records what that FAILED
 * meant: the reviewer judged `amount` arrived and put exactly that on the wallet under
 * `RECEIPT_CREDIT`.
 *
 * Keyed by `(tenant_id, payment_id)`: at most one per payment, which is invariant 8, and
 * held again on its own by `wallet_entries_receipt_credit_payment_key` on the money.
 *
 * Append-only (0114): no UPDATE and no DELETE. The same migration refuses a row whose
 * payment is not a FAILED manual transfer, or whose entry is not that payment's
 * `RECEIPT_CREDIT` CREDIT of the same amount and currency — facts about other tables a
 * CHECK cannot read.
 */
export const receiptCredits = pgTable(
  'receipt_credits',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paymentId: uuid('payment_id').notNull(),
    /**
     * What was credited: the reviewer's figure, in the PAYMENT's currency. Stored rather
     * than joined, for the rule `refunds` states — never an amount without its currency,
     * readable on its own — and checked against the ledger entry by 0114.
     */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The `RECEIPT_CREDIT` ledger entry this disposition wrote. */
    walletEntryId: uuid('wallet_entry_id').notNull(),
    /** The reviewer. NOT NULL: a decision about somebody's money with nobody named is not one. */
    decidedByAdminId: uuid('decided_by_admin_id')
      .notNull()
      .references(() => admins.id),
    decidedAt: timestamptz('decided_at').notNull(),
    /** The reviewer's own words, bounded. Never customer text. */
    note: text('note'),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.paymentId],
      name: 'receipt_credits_pkey',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'receipt_credits_payment_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.walletEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
      name: 'receipt_credits_entry_fk',
    }),
    check('receipt_credits_amount_check', sql`amount > 0`),
    check('receipt_credits_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check(
      'receipt_credits_note_check',
      sql`note IS NULL OR length(btrim(note)) BETWEEN 1 AND ${sql.raw(String(RECEIPT_CREDIT_NOTE_MAX_LENGTH))}`,
    ),
  ],
);

/**
 * One administrator's push of one card-to-card receipt (WP10 follow-up, ADR-0031).
 *
 * File 01 §3: a receipt is sent to the authorized administrators in Telegram, as ONE message
 * — the file, the context in its caption, the decisions as its buttons. The pull queue stays;
 * this is the push beside it, and the queue is where a lost push is recovered.
 *
 * A row per (receipt, administrator), written by the `PaymentReceiptSubmitted` consumer in the
 * relay's transaction — never in the transaction that filed the receipt, so no failure here can
 * roll a receipt back. The unique key is the idempotency of the whole lane: an outbox
 * redelivery, a replayed consumer and two worker replicas all land on the row that exists.
 *
 * Neither the customer lane nor the operator lane: `customer_notifications` is one row per
 * SUBJECT addressed to a customer, and `notifications` has no UNKNOWN outcome and re-sends a
 * timeout — a second copy of a receipt with live buttons is the spam the owner forbade. So the
 * customer lane's outcome table (ADR-0030 §2) is taken here, for an administrator.
 */
export const receiptReviewPushes = pgTable(
  'receipt_review_pushes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paymentId: uuid('payment_id').notNull(),
    receiptId: uuid('receipt_id').notNull(),
    adminId: uuid('admin_id').notNull(),
    /**
     * The bot that RECEIVED the receipt, copied from its row: a `file_id` belongs to that
     * bot, and the push must come from it.
     */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    state: text('state').notNull().default('PENDING'),
    /** Definite refusals spent. A rate limit spends none. */
    attempts: integer('attempts').notNull().default(0),
    /** When the dispatcher may next try; also the claim's lease. Null means now. */
    nextAttemptAt: timestamptz('next_attempt_at'),
    /**
     * Set just before the send and cleared by every recorded outcome, so a set value is a
     * send whose process may have died after Telegram took it. The reaper turns such a row
     * UNKNOWN — never recorded as delivered, and nothing re-sends it.
     */
    sendStartedAt: timestamptz('send_started_at'),
    /** The chat actually addressed, stamped at send from the binding current THEN. */
    chatId: text('chat_id'),
    /** Why the row is not SENT, as a machine code. Never a sentence, never customer text. */
    lastErrorCode: text('last_error_code'),
    resolvedAt: timestamptz('resolved_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** One push per receipt per administrator, for ever. */
    unique('receipt_review_pushes_receipt_admin_key').on(
      table.tenantId,
      table.receiptId,
      table.adminId,
    ),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'receipt_review_pushes_payment_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.receiptId],
      foreignColumns: [paymentReceipts.tenantId, paymentReceipts.id],
      name: 'receipt_review_pushes_receipt_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'receipt_review_pushes_admin_fk',
    }),
    /** The dispatcher's claim: queued rows, oldest first. */
    index('receipt_review_pushes_due_idx')
      .on(table.tenantId, table.nextAttemptAt)
      .where(sql`state = 'PENDING'`),
    check('receipt_review_pushes_state_check', enumCheck('state', RECEIPT_REVIEW_PUSH_STATES)),
    check(
      'receipt_review_pushes_resolved_check',
      sql`(state <> 'PENDING') = (resolved_at IS NOT NULL)`,
    ),
    check('receipt_review_pushes_attempts_check', sql`attempts >= 0`),
  ],
);

/**
 * WP-A9: one row per time a customer's wallet fell below the tenant's low-balance
 * threshold — "we told them their balance was low, about THIS fall".
 *
 * An OCCURRENCE, like `service_reminders`, and never a flag on the customer: there is no
 * balance column anywhere in this schema and there is none here either. Whether a wallet
 * is low, and whether it has recovered since it was last told, is derived from the ledger
 * on every pass; this row records only what was decided and against which entry.
 *
 * `crossing_entry_id` names the ledger entry that took the running balance from at or
 * above the threshold to below it. That is what makes the alert once-per-crossing:
 *
 *   - two worker replicas derive the same entry and the unique key lets one of them write;
 *   - a wallet that stays low is still the same crossing on every later pass, and the
 *     candidate query skips any wallet with an alert raised since it was last at or above
 *     the threshold — so an idle scan writes nothing;
 *   - a wallet that recovers and falls again crosses at a NEW entry, which is a new row, a
 *     new subject and a new message. Nothing is deleted or updated to re-arm it.
 *
 * It is the SUBJECT of the `WALLET_LOW_BALANCE` notification, for the reason
 * `service_reminders` is: keyed on the customer, `customer_notifications_subject_key`
 * would let a wallet be told it was low exactly once for ever.
 */
export const walletThresholdAlerts = pgTable(
  'wallet_threshold_alerts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** The wallet's currency, which is the threshold's. One wallet per currency. */
    currency: text('currency').notNull(),
    /**
     * The threshold in force when the fall was recorded, in minor units of `currency`.
     *
     * Snapshotted because the send-time re-check compares against THIS figure: an
     * operator moving the threshold after the fact must not turn a true "your balance is
     * low" into a superseded one, nor a false one into a sent one.
     */
    thresholdAmount: bigint('threshold_amount', { mode: 'bigint' }).notNull(),
    /** The ledger entry that took the wallet below the threshold. */
    crossingEntryId: uuid('crossing_entry_id').notNull(),
    /** That entry's `created_at`, copied so the arm test compares two columns of one row. */
    crossedAt: timestamptz('crossed_at').notNull(),
    raisedAt: timestamptz('raised_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'wallet_threshold_alerts_customer_fk',
    }),
    /**
     * The crossing entry travels WITH its tenant: a composite key onto
     * `wallet_entries_tenant_id_key`, so an alert cannot name another tenant's ledger entry
     * (Codex review #2 of PR #100) — the shape every other reference into the ledger has.
     */
    foreignKey({
      columns: [table.tenantId, table.crossingEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
      name: 'wallet_threshold_alerts_crossing_entry_fk',
    }),
    /** Once per crossing: the arbiter of every insert, and why two replicas are safe. */
    unique('wallet_threshold_alerts_crossing_key').on(table.tenantId, table.crossingEntryId),
    /** The candidate query's "told since it was last at or above?" probe. */
    index('wallet_threshold_alerts_wallet_idx').on(
      table.tenantId,
      table.customerId,
      table.currency,
      table.crossedAt,
    ),
    check('wallet_threshold_alerts_currency_check', enumCheck('currency', CURRENCY_CODES)),
    /** A zero threshold sends nothing, so no alert can have been raised against one. */
    check('wallet_threshold_alerts_threshold_check', sql`threshold_amount > 0`),
  ],
);

// ---------------------------------------------------------------------------
// R10 D4 — gift cards (wallet top-up codes)
// ---------------------------------------------------------------------------

/**
 * A batch of gift cards an operator minted in the Web Admin: N codes of one face value, one
 * expiry, an optional per-customer limit.
 *
 * The plaintext codes exist ONCE, in `export_ciphertext` (SecretCipher, purpose
 * `gift_card.batch_export`, entity = this row), so the operator can download them until
 * `export_expires_at`; the worker then sets both export columns to NULL and the codes exist
 * only as hashes. `state` moves ACTIVE -> DISABLED once, by a conditional UPDATE; disabling
 * stops the UNREDEEMED codes and touches no money.
 */
export const giftCardBatches = pgTable(
  'gift_card_batches',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    label: text('label').notNull(),
    /** The face value of ONE code, positive minor units. */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    codeCount: integer('code_count').notNull(),
    /** How many codes of this batch one customer may redeem; NULL is no limit. */
    perCustomerLimit: integer('per_customer_limit'),
    /** Redeemable while `now < expires_at`: the interval is half-open. */
    expiresAt: timestamptz('expires_at').notNull(),
    state: text('state').notNull().default('ACTIVE'),
    /** The operator's reason, mandatory, bounded. Never customer text. */
    reason: text('reason').notNull(),
    createdByAdminId: uuid('created_by_admin_id').references(() => admins.id),
    createdAt: timestamptz('created_at').notNull(),
    disabledAt: timestamptz('disabled_at'),
    disabledByAdminId: uuid('disabled_by_admin_id').references(() => admins.id),
    exportCiphertext: text('export_ciphertext'),
    exportKeyId: text('export_key_id'),
    exportExpiresAt: timestamptz('export_expires_at').notNull(),
  },
  (table) => [
    unique('gift_card_batches_tenant_id_key').on(table.tenantId, table.id),
    index('gift_card_batches_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    check('gift_card_batches_state_check', enumCheck('state', GIFT_CARD_BATCH_STATES)),
    check('gift_card_batches_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('gift_card_batches_amount_check', sql`amount_minor > 0`),
    check(
      'gift_card_batches_count_check',
      // `GIFT_CARD_BATCH_MAX_CODES`; a migration test pins the literal to the constant.
      sql`code_count BETWEEN 1 AND 5000`,
    ),
    check(
      'gift_card_batches_limit_check',
      sql`per_customer_limit IS NULL OR per_customer_limit >= 1`,
    ),
    check('gift_card_batches_label_check', sql`char_length(label) BETWEEN 1 AND 80`),
    check('gift_card_batches_reason_check', sql`char_length(reason) BETWEEN 1 AND 300`),
    check('gift_card_batches_window_check', sql`expires_at > created_at`),
    check(
      'gift_card_batches_disabled_check',
      sql`(state = 'DISABLED') = (disabled_at IS NOT NULL)`,
    ),
    check(
      'gift_card_batches_export_check',
      sql`(export_ciphertext IS NULL) = (export_key_id IS NULL)`,
    ),
  ],
);

/**
 * One gift card. Max uses = 1 is the COLUMN, not a counter: a code is redeemed when
 * `redeemed_at` is set, by a conditional UPDATE from "not redeemed, ACTIVE" under the batch's
 * share lock, and the ledger reference `giftcard:<id>` is unique — the second lock.
 *
 * Only `code_hash` is stored: SHA-256 over a domain tag, the tenant and the normalised code
 * (`gift-card-code.ts`), so the same code can never match in another tenant and nothing in the
 * database reveals one. `last4` is the code's last four symbols, for support.
 *
 * `wallet_entry_id` is NOT a foreign key: the code is stamped before its entry is appended, in
 * the same transaction, and the ledger reference is the link the database enforces.
 */
export const giftCardCodes = pgTable(
  'gift_card_codes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    batchId: uuid('batch_id').notNull(),
    codeHash: text('code_hash').notNull(),
    last4: text('last4').notNull(),
    state: text('state').notNull().default('ACTIVE'),
    disabledAt: timestamptz('disabled_at'),
    redeemedAt: timestamptz('redeemed_at'),
    redeemedByCustomerId: uuid('redeemed_by_customer_id'),
    walletEntryId: uuid('wallet_entry_id'),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.batchId],
      foreignColumns: [giftCardBatches.tenantId, giftCardBatches.id],
      name: 'gift_card_codes_batch_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.redeemedByCustomerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'gift_card_codes_customer_fk',
    }),
    /** A code is looked up by its hash, and one hash names one code in a tenant. */
    uniqueIndex('gift_card_codes_tenant_hash_key').on(table.tenantId, table.codeHash),
    /** The per-customer limit and the batch's counts read this slice. */
    index('gift_card_codes_batch_customer_idx').on(
      table.tenantId,
      table.batchId,
      table.redeemedByCustomerId,
    ),
    check('gift_card_codes_state_check', enumCheck('state', GIFT_CARD_CODE_STATES)),
    check('gift_card_codes_hash_check', sql`code_hash ~ '^[0-9a-f]{64}$'`),
    check('gift_card_codes_last4_check', sql`last4 ~ '^[2-9A-HJKMNP-TV-Z]{4}$'`),
    check(
      'gift_card_codes_redeemed_check',
      sql`(redeemed_at IS NULL) = (redeemed_by_customer_id IS NULL)
        AND (redeemed_at IS NULL) = (wallet_entry_id IS NULL)`,
    ),
    check(
      'gift_card_codes_disabled_check',
      sql`(state = 'DISABLED') = (disabled_at IS NOT NULL)
        AND NOT (state = 'DISABLED' AND redeemed_at IS NOT NULL)`,
    ),
  ],
);

/**
 * Every REFUSED redemption, for the failed-attempt limiter and the operator: who, when, why,
 * and the code row it matched when it matched one. Never the code, never its hash. Counted
 * under the customer's wallet lock, so the limit holds without Redis. Rows past
 * `GIFT_CARD_ATTEMPT_RETENTION_MS` are deleted by the worker's gift-card sweep.
 */
export const giftCardRedemptionAttempts = pgTable(
  'gift_card_redemption_attempts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    attemptedAt: timestamptz('attempted_at').notNull(),
    outcome: text('outcome').notNull(),
    codeId: uuid('code_id'),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'gift_card_redemption_attempts_customer_fk',
    }),
    index('gift_card_redemption_attempts_customer_idx').on(
      table.tenantId,
      table.customerId,
      table.attemptedAt,
    ),
    check(
      'gift_card_redemption_attempts_outcome_check',
      enumCheck('outcome', GIFT_CARD_REJECTIONS),
    ),
  ],
);
