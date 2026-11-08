/**
 * Database schema — payments: payments, receipts, destinations.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  CURRENCY_CODES,
  SOURCE_SURFACES,
  PAYMENT_GATEWAY_PROVIDERS,
  PROVIDER_REVIEW_GATEWAY_PROVIDERS,
  TONPAYS_TELEGRAM_REVIEW_WINDOW_HOURS,
  PAYMENT_RECEIPT_KINDS,
  RECEIPT_CAPTURE_CLOSE_REASONS,
  PAYMENT_STATES,
  PAYMENT_METHODS,
  PAYMENT_EVIDENCE_KINDS,
  PAYMENT_RESOLVED_STATES,
  PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MAX,
  CUSTOMER_FEE_BASIS_POINTS_MAX,
  CUSTOMER_FEE_BASIS_POINTS_MIN,
  PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MIN,
  RECEIPT_CAPTION_MAX_LENGTH,
} from '@nexa/contracts';
import {
  enumCheck,
  nullableEnumCheck,
  publicCodeChecks,
  publicCodeColumns,
  recordSourceChecks,
  recordSourceColumns,
  timestamptz,
} from './_shared.js';
import { botInstances, tenants } from './tenancy.js';
import { admins } from './identity.js';
import { customers } from './customers.js';
import { orders } from './orders.js';
import { paymentAccounts } from './gateways.js';

/**
 * A payment — one attempt to settle money.
 *
 * `reference` is the string a customer quotes and an operator searches, unique per
 * tenant, and it is what makes a manual transfer reconcilable at all. It is generated,
 * never customer-supplied.
 *
 * `external_reference` holds a gateway's own identifier. There is no gateway adapter in
 * this release, so the column is empty — and it is here rather than added later because
 * a payment without a place to record external identity is a payment that cannot be
 * reconciled, and the first gateway would have to migrate live rows to get one.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** Null for a wallet top-up, which settles no order. */
    orderId: uuid('order_id'),
    state: text('state').notNull().default('PENDING'),
    method: text('method').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** Generated, unique per tenant, quoted by the customer. Never customer-supplied. */
    reference: text('reference').notNull(),
    /** What a confirmation rests on. Null until confirmed. */
    evidenceKind: text('evidence_kind'),
    /**
     * An operator's note about the evidence, bounded.
     *
     * Never the customer's own message text and never a gateway response body: the
     * first is arbitrary third-party text and the second routinely carries a token.
     */
    evidenceNote: text('evidence_note'),
    /** The gateway's own id. Unused in this release; see the docblock. */
    externalReference: text('external_reference'),
    confirmedAt: timestamptz('confirmed_at'),
    /** Which administrator confirmed it, for an `OPERATOR_REVIEW`. */
    confirmedByAdminId: uuid('confirmed_by_admin_id').references(() => admins.id),
    /**
     * When the payment ended WITHOUT money: rejected, withdrawn or expired.
     *
     * The mirror of `confirmed_at` and deliberately a SECOND column rather than a
     * reuse of it. `payments_confirmed_check` binds `confirmed_at` to CONFIRMED, so a
     * rejection written there could not commit — and a schema that made it commit
     * would be one where a query for "when did the money arrive" answers with the
     * moment somebody decided it never would.
     */
    resolvedAt: timestamptz('resolved_at'),
    /**
     * Which administrator resolved it, when a person did.
     *
     * Null for an expiry, because nobody decided that — a deadline did — and null for
     * a customer's own withdrawal. `payments_resolution_reviewer_check` holds the
     * narrower half of that: an admin id may appear only on a FAILED payment, which is
     * the only human-made resolution this release can produce.
     */
    resolvedByAdminId: uuid('resolved_by_admin_id').references(() => admins.id),
    /**
     * Why, in the operator's own words. Same rules as `evidence_note`: never the
     * customer's own message text and never a gateway response body.
     */
    resolutionNote: text('resolution_note'),
    /**
     * When the customer said they had sent the transfer. Their CLAIM, never evidence.
     *
     * `docs/phase4h-audit.md` §4 measured the gap: the bot hands out a reference and
     * bank details and the flow is then silent in both directions, so an operator
     * learns of a transfer from their bank rather than from the product.
     *
     * A separate column rather than a state, and that is the load-bearing decision.
     * `PAYMENT_STATES` classifies what this installation KNOWS about the money, and a
     * customer saying they paid is not knowledge — `PAYMENT_EVIDENCE_KINDS` stays
     * `OPERATOR_REVIEW` and confirmation is unchanged. A `SIGNALLED` state would put a
     * customer's assertion on the same axis as a reviewed one, which is the legacy
     * receipt review's defect (`PRBR-004`) with a new name.
     *
     * Stamped ONCE. The conditional UPDATE that writes it requires it to be null, so a
     * customer tapping twice does not move the moment they first claimed to have paid.
     */
    customerSignalledAt: timestamptz('customer_signalled_at'),
    /**
     * Until when an APPROVED Telegram Stars pre-checkout holds this payment (Package A,
     * Codex review of #85). Telegram charges right after the approval, so until then the
     * payment is money in flight: every cancel, withdraw and wallet-replacement predicate
     * excludes a row whose hold has not lapsed, in the same statement that moves it — a
     * row-local predicate, so a cancellation that waited on the approval's row lock
     * re-reads it rather than acting on what it saw before.
     */
    checkoutHeldUntil: timestamptz('checkout_held_until'),
    expiresAt: timestamptz('expires_at'),
    /**
     * The route the payment was offered through, snapshotted when it was created
     * (Payment File 02 §21, `docs/payments-file02-design.md` D5 and D7).
     *
     * Nullable: a wallet settlement goes through no route, and every payment created
     * before this column existed has none recorded. Frozen after insert by
     * `nexa_payments_confirmation_guard` (0114), in every state.
     */
    gatewayProvider: text('gateway_provider'),
    /**
     * The top-up gift this payment PROMISED, snapshotted from its route's
     * `topup_cashback_percent` when it was created (D5).
     *
     * Null for an order payment — an order earns no top-up gift — and for a payment
     * created before this column existed; `0` for a top-up through a route that offered
     * none. Frozen after insert, so an operator changing the route's percentage later
     * cannot change a promise already made: Payment File 02 §17's snapshot rule.
     */
    topupCashbackPercent: integer('topup_cashback_percent'),
    /**
     * The customer's gateway fee this attempt was created with (WP18), snapshotted from
     * its route's `customer_fee_basis_points`: the rate, the fee it produced on `amount`,
     * and the payable the invoice asked for. `amount` stays the PRINCIPAL — every reader
     * of it (settlement, the top-up credit and gift, the refund ceiling, the reversals,
     * the reports) keeps its meaning, and the fee is none of those things.
     *
     * All three null, or all three set on a `GATEWAY` payment with
     * `payable = amount + fee` (`payments_customer_fee_check`). Null is every other
     * method, and a gateway attempt created before WP18, which is read as no fee. Frozen
     * after insert in every state (0124), like the route snapshot beside it.
     */
    customerFeeBasisPoints: integer('customer_fee_basis_points'),
    customerFeeAmount: bigint('customer_fee_amount', { mode: 'bigint' }),
    payableAmount: bigint('payable_amount', { mode: 'bigint' }),
    /**
     * The provider review window (`docs/tonpays-telegram-gateway-audit.md` §7.0, §9.6; the
     * owner's decision of 2026-10-01): when Nexa observed an external gateway's
     * ACKNOWLEDGEMENT of the customer's receipt, and the settlement deadline that opened —
     * 24 hours later, written in the SAME statement.
     *
     * Provider-neutral in name and meaning, and on the payment row for the reason
     * `checkout_held_until` is: the expiry sweep's exclusion must be ROW-LOCAL. A sweep
     * that waited on this row's lock re-reads this row's own columns (EvalPlanQual) and
     * nothing else, so an acknowledgement kept on another table would be invisible to a
     * sweep whose snapshot predates it, and a payment TonPays is reviewing would expire.
     *
     * `payments_provider_review_check` binds both columns to each other, to a GATEWAY
     * payment of a route whose descriptor says `providerReview`, to an acknowledgement
     * strictly before `expires_at`, and to exactly the window's length.
     * `nexa_payments_confirmation_guard` freezes them once set, and allows setting them
     * only on a PENDING payment: a repeated or later acknowledgement never moves the
     * deadline, whoever writes it.
     */
    providerReviewStartedAt: timestamptz('provider_review_started_at'),
    providerReviewUntil: timestamptz('provider_review_until'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    /**
     * Round 9, C5: the surface whose actor created this row (`SOURCE_SURFACES`), so the
     * operations log can say «منبع: مینی‌اپ» for what the Mini App created. Null for every row
     * written before the column existed: unknown, never guessed — not backfilled.
     */
    sourceSurface: text('source_surface'),
    ...recordSourceColumns(),
    ...publicCodeColumns(),
  },
  (table) => [
    ...recordSourceChecks('payments', table),
    ...publicCodeChecks('payments'),
    check(
      'payments_source_surface_check',
      sql`source_surface IS NULL OR ${enumCheck('source_surface', SOURCE_SURFACES)}`,
    ),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'payments_customer_fk',
    }),
    /*
     * The customer travels WITH the order.
     *
     * `order_id` is nullable — a wallet top-up settles no order — and a MATCH SIMPLE
     * composite foreign key is not enforced when any of its columns is NULL, which is
     * exactly the behaviour wanted here: a top-up has no order to agree with, and every
     * payment that names one must name its owner too. Without the third column a wallet
     * debit could settle another customer's order.
     */
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'payments_order_fk',
    }),
    uniqueIndex('payments_tenant_reference_key').on(table.tenantId, table.reference),
    index('payments_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('payments_tenant_state_idx').on(table.tenantId, table.state),
    index('payments_customer_created_idx').on(table.customerId, table.createdAt, table.id),
    /**
     * At most ONE confirmed payment per order.
     *
     * A partial unique index rather than an application check, because two concurrent
     * confirmations both read "no confirmed payment yet". This is the constraint that
     * makes a double charge impossible rather than unlikely.
     */
    uniqueIndex('payments_order_confirmed_key')
      .on(table.orderId)
      .where(sql`state = 'CONFIRMED' AND order_id IS NOT NULL`),
    /**
     * At most ONE open top-up per customer, and for the same reason as the index above.
     *
     * `requestWalletTopup` reads `findOpenTopup`, finds none, and inserts. Two callbacks
     * carrying DIFFERENT idempotency keys — a double tap, or two Telegram clients — both
     * read null inside their own transaction and both insert; the idempotency store has
     * nothing to replay because the keys differ. The customer then holds two live
     * references, each independently confirmable, and one bank transfer is credited
     * twice.
     *
     * The service takes a per-customer lock so the ordinary racing pair serialises and
     * neither sees an error. This is what holds when a lock is bypassed, forgotten, or
     * outlived by a new code path — and two api replicas is the normal case on every
     * rolling update, so the database is the only place both of them share.
     *
     * The predicate is `findOpenTopup`'s WHERE clause exactly. The two must stay in step.
     */
    uniqueIndex('payments_open_topup_key')
      .on(table.tenantId, table.customerId)
      .where(sql`state = 'PENDING' AND order_id IS NULL AND method = 'MANUAL_TRANSFER'`),
    /** The reconciliation queue: payments whose outcome nobody knows. */
    index('payments_unknown_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`state = 'UNKNOWN'`),
    /**
     * The expiry sweep's own index, and the counterpart of `orders_expiry_idx`.
     *
     * That one has existed since 0032 with NO reader — a partial index is a statement
     * about a query somebody meant to write, and `docs/phase4g-audit.md` records that
     * nothing was ever written against it. This one arrives WITH its reader.
     *
     * Leading with `tenant_id` where the orders index does not, because this sweep is
     * tenant-scoped like every other write path here and a scan ordered by deadline
     * across all tenants would be one tenant's backlog delaying another's.
     */
    index('payments_pending_expiry_idx')
      .on(table.tenantId, table.expiresAt)
      .where(sql`state = 'PENDING'`),
    /**
     * The review sweep's own index (§9.6.3 e), shipped WITH its reader: PENDING payments in
     * a provider review, by the moment their review ends.
     */
    index('payments_provider_review_idx')
      .on(table.tenantId, table.providerReviewUntil)
      .where(sql`state = 'PENDING' AND provider_review_until IS NOT NULL`),
    check('payments_state_check', enumCheck('state', PAYMENT_STATES)),
    check('payments_method_check', enumCheck('method', PAYMENT_METHODS)),
    check('payments_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check(
      'payments_evidence_kind_check',
      nullableEnumCheck('evidence_kind', PAYMENT_EVIDENCE_KINDS),
    ),
    // A LEGACY_IMPORT confirmation is history carried from Mirza, and only the import writes
    // one: the kind can never be claimed by a NEXA payment.
    check(
      'payments_legacy_import_source_check',
      sql`evidence_kind IS DISTINCT FROM 'LEGACY_IMPORT' OR source = 'MIRZA'`,
    ),
    check('payments_amount_check', sql`amount > 0`),
    /**
     * A confirmed payment has a time AND evidence. Both, together.
     *
     * A confirmation with no recorded evidence is the legacy receipt review, which
     * records neither reviewer nor time (UNK-PR-010) — so "was this approved by a
     * human" is unanswerable there.
     */
    check(
      'payments_confirmed_check',
      sql`(state = 'CONFIRMED') = (confirmed_at IS NOT NULL AND evidence_kind IS NOT NULL)`,
    ),
    /**
     * A payment that ended without money has a time. The mirror of the check above.
     *
     * Both halves, as an equality rather than an implication, for the reason that one
     * gives: an implication lets a CONFIRMED payment also carry a resolution time, and
     * then "was this rejected" is answered by two columns that can disagree.
     *
     * The state list is `PAYMENT_RESOLVED_STATES` rendered by the same helper every
     * other status check here uses, so adding a state to the contract and forgetting
     * this constraint is a drift the generator catches rather than a silent hole.
     */
    check(
      'payments_resolved_check',
      sql`(state IN (${sql.join(
        PAYMENT_RESOLVED_STATES.map((state) => sql.raw(`'${state}'`)),
        sql`, `,
      )})) = (resolved_at IS NOT NULL)`,
    ),
    /**
     * An administrator may appear only on a rejection.
     *
     * `FAILED` is the only resolution a person makes in this release: an expiry is a
     * deadline and a cancellation is the customer's own. Writing an admin id onto
     * either would make "who decided this" answerable with somebody who did not, which
     * is the failure 0035 exists to prevent one state later.
     *
     * The release that adds a gateway keeps this constraint unchanged and relies on
     * its other half: a gateway-driven FAILED carries a null admin id, which is how the
     * two are told apart without a parallel enum.
     */
    check(
      'payments_resolution_reviewer_check',
      sql`resolved_by_admin_id IS NULL OR state = 'FAILED'`,
    ),
    /** A note about a resolution that did not happen is not evidence of anything. */
    check(
      'payments_resolution_note_check',
      sql`resolution_note IS NULL OR resolved_at IS NOT NULL`,
    ),
    /**
     * Only an out-of-band transfer can be claimed as sent.
     *
     * A wallet settlement commits its debit in the same transaction and a gateway is
     * reached over the wire; in neither case is there anything for a customer to assert
     * that this installation does not already know. The constraint says so where a
     * later surface cannot disagree with it.
     */
    check(
      'payments_customer_signal_check',
      sql`customer_signalled_at IS NULL OR method = 'MANUAL_TRANSFER'`,
    ),
    check('payments_checkout_hold_check', sql`checkout_held_until IS NULL OR method = 'GATEWAY'`),
    check(
      'payments_gateway_provider_check',
      nullableEnumCheck('gateway_provider', PAYMENT_GATEWAY_PROVIDERS),
    ),
    check(
      'payments_topup_cashback_percent_check',
      sql`topup_cashback_percent IS NULL OR topup_cashback_percent BETWEEN ${sql.raw(String(PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MIN))} AND ${sql.raw(String(PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MAX))}`,
    ),
    /*
     * WP18: the fee snapshot is all-or-nothing, only on a gateway payment (and, since R6
     * item 4, a manual card-to-card one), and its arithmetic is the database's too — a
     * payable that is not principal plus fee is a figure nobody quoted.
     */
    check(
      'payments_customer_fee_check',
      sql`(customer_fee_basis_points IS NULL AND customer_fee_amount IS NULL AND payable_amount IS NULL) OR (method IN ('GATEWAY', 'MANUAL_TRANSFER') AND customer_fee_basis_points BETWEEN ${sql.raw(String(CUSTOMER_FEE_BASIS_POINTS_MIN))} AND ${sql.raw(String(CUSTOMER_FEE_BASIS_POINTS_MAX))} AND customer_fee_amount >= 0 AND payable_amount = amount + customer_fee_amount)`,
    ),
    /*
     * The provider review window (§7.0), row-local and generated from the contract: both
     * columns or neither; only on a GATEWAY payment of a route that reviews; acknowledged
     * strictly BEFORE the payment's own deadline (half-open — an acknowledgement at exactly
     * minute 70 opens nothing); and exactly the window's length.
     */
    check(
      'payments_provider_review_check',
      sql`(provider_review_started_at IS NULL) = (provider_review_until IS NULL) AND (provider_review_until IS NULL OR (method = 'GATEWAY' AND gateway_provider IN (${sql.join(
        PROVIDER_REVIEW_GATEWAY_PROVIDERS.map((provider) => sql.raw(`'${provider}'`)),
        sql`, `,
      )}) AND expires_at IS NOT NULL AND provider_review_started_at < expires_at AND provider_review_until = provider_review_started_at + interval '${sql.raw(String(TONPAYS_TELEGRAM_REVIEW_WINDOW_HOURS))} hours'))`,
    ),
    unique('payments_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * The window in which a photo from this customer attaches to a payment.
 *
 * A ROW rather than a column on `payments`, and that is the load-bearing choice: a
 * customer may hold several pending payments, so "which payment does this image belong
 * to" has to be answerable from the CUSTOMER — which is what an inbound Telegram photo
 * identifies — rather than from a payment somebody guessed.
 *
 * ## Why this is not the prompt capture that destroyed a production setting
 *
 * `INCIDENT-FIN-001` records an ADMIN prompt that swallowed a typed navigation string
 * and overwrote a gateway's tutorial text, and earlier directives forbade conversational
 * prompt capture in its general form. They still do. Four properties make this narrower,
 * and all four are in the schema rather than in a docstring:
 *
 * 1. it names ONE payment, stored here, so there is no "current prompt" a later message
 *    can land in;
 * 2. it can attach a PHOTO or a DOCUMENT and nothing else — the routing never consults
 *    it for a text message, so `/start`, the menu labels and every other typed thing
 *    route exactly as they do today;
 * 3. it is customer-side: the only thing it can write is a `payment_receipts` row;
 * 4. it EXPIRES, and `receipt_captures_expiry_check` refuses a window that outlives its
 *    own opening.
 *
 * One open window per customer per bot is a partial unique index, not a service rule.
 * Opening a second closes the first as SUPERSEDED in the same transaction.
 */
export const receiptCaptures = pgTable(
  'receipt_captures',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * WHICH bot the customer is talking to.
     *
     * A tenant may run a public bot and a reseller bot, and a window opened in one must
     * not be filled by a photo sent to the other: the customer is a different chat there
     * and the file id belongs to a different bot.
     */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    openedAt: timestamptz('opened_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    /** Null while open. The partial unique index below is keyed on exactly this. */
    closedAt: timestamptz('closed_at'),
    closeReason: text('close_reason'),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'receipt_captures_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'receipt_captures_payment_fk',
    }),
    /**
     * ONE open window per customer per bot, decided by the database.
     *
     * Two taps on two different invoices arriving together both read "nothing open". A
     * service check answers both yes and the second photo attaches to whichever row the
     * planner returns first, which is a receipt filed against a payment the customer was
     * not looking at.
     */
    uniqueIndex('receipt_captures_open_key')
      .on(table.tenantId, table.botInstanceId, table.customerId)
      .where(sql`closed_at IS NULL`),
    /** The sweep's index: windows past their deadline that nobody has closed. */
    index('receipt_captures_due_idx')
      .on(table.tenantId, table.expiresAt)
      .where(sql`closed_at IS NULL`),
    check(
      'receipt_captures_close_reason_check',
      nullableEnumCheck('close_reason', RECEIPT_CAPTURE_CLOSE_REASONS),
    ),
    /** A closed window has a reason, and an open one has neither. Both halves. */
    check('receipt_captures_closed_check', sql`(closed_at IS NULL) = (close_reason IS NULL)`),
    check('receipt_captures_expiry_check', sql`expires_at > opened_at`),
    unique('receipt_captures_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * One receipt a customer sent, bound to exactly one payment.
 *
 * The BINDING lives here; the bytes live at Telegram. This installation stores the two
 * identifiers Telegram gives it — `file_id`, which `getFile` takes and which is scoped to
 * one bot, and `file_unique_id`, which is stable and is what the dedupe is keyed on — and
 * the Web Admin fetches the image through the API, which holds the bot token.
 *
 * That is a real limitation written down rather than discovered: a backup carries this
 * row and not the image, and a revoked bot token makes an old file unfetchable. The
 * alternative is a blob store this deployment does not have.
 *
 * Append-only by trigger. A receipt is evidence somebody will look at when deciding
 * whether money arrived, and evidence that can be edited afterwards is the legacy
 * `/admin/logs` with a picture attached.
 */
export const paymentReceipts = pgTable(
  'payment_receipts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    kind: text('kind').notNull(),
    /** What `getFile` takes. Bot-scoped, and never returned to a browser. */
    fileId: text('file_id').notNull(),
    /** Stable across re-sends of the same file, and the dedupe key. */
    fileUniqueId: text('file_unique_id').notNull(),
    mimeType: text('mime_type'),
    fileSize: bigint('file_size', { mode: 'bigint' }),
    fileName: text('file_name'),
    /** Which message carried it, so an operator can find it in the chat if they must. */
    telegramMessageId: bigint('telegram_message_id', { mode: 'bigint' }),
    /**
     * The caption the customer sent with the file, trimmed, or NULL for none (Payment
     * File 02 §10, D3). CUSTOMER text: rendered into the reviewer's Telegram caption and
     * nowhere else, never logged, and never returned to a browser.
     */
    caption: text('caption'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'payment_receipts_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'payment_receipts_payment_fk',
    }),
    /**
     * The SAME file attaches once.
     *
     * Telegram redelivers an update whose reply this installation did not acknowledge in
     * time, and a customer who taps forward twice sends the same file twice.
     * `file_unique_id` is stable across both, so this is what makes an upload
     * effectively-once without a second idempotency mechanism.
     */
    uniqueIndex('payment_receipts_file_key').on(
      table.tenantId,
      table.paymentId,
      table.fileUniqueId,
    ),
    /** The reviewer's read: everything filed against one payment, oldest first. */
    index('payment_receipts_payment_idx').on(table.tenantId, table.paymentId, table.createdAt),
    check('payment_receipts_kind_check', enumCheck('kind', PAYMENT_RECEIPT_KINDS)),
    check('payment_receipts_size_check', sql`file_size IS NULL OR file_size > 0`),
    check(
      'payment_receipts_caption_check',
      sql`caption IS NULL OR length(caption) BETWEEN 1 AND ${sql.raw(String(RECEIPT_CAPTION_MAX_LENGTH))}`,
    ),
    unique('payment_receipts_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * What ONE customer was told, frozen at the moment the payment was issued.
 *
 * A separate table rather than columns on `payments`, and not by taste. A CHECK binding a
 * destination to `method = 'MANUAL_TRANSFER'` would have to be an IMPLICATION rather than
 * an equality, because every manual-transfer payment issued before this migration has no
 * destination — and an implication is exactly the "two columns that can disagree" shape
 * `payments_confirmed_check` exists to refuse. Here the absence is the absence of a row.
 *
 * Append-only by trigger, like `audit_logs` (see the migration). A destination that could
 * be edited after issuance is the defect this whole subphase removes, reintroduced one
 * layer down.
 *
 * `account_id` is provenance and nothing else. Every field a customer needs is COPIED
 * here, so the rendering never joins back to a row an operator may since have changed.
 */
export const paymentDestinations = pgTable(
  'payment_destinations',
  {
    /** One destination per payment. The payment IS the identity. */
    paymentId: uuid('payment_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Which account this was taken from. Never read to render; read to reconcile. */
    accountId: uuid('account_id').notNull(),
    label: text('label').notNull(),
    bankName: text('bank_name').notNull(),
    holderName: text('holder_name').notNull(),
    cardNumber: text('card_number').notNull(),
    iban: text('iban'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    /*
     * The payment travels WITH its tenant, and so does the account.
     *
     * Two composite foreign keys rather than two plain ones, for the reason
     * `payments_order_fk` gives: without the tenant column in the key, a destination row
     * could name one tenant's payment and another tenant's account, and the render would
     * print a card number belonging to somebody else's installation.
     */
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'payment_destinations_payment_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.accountId],
      foreignColumns: [paymentAccounts.tenantId, paymentAccounts.id],
      name: 'payment_destinations_account_fk',
    }),
    /** The operator's question: which payments were issued against this account? */
    index('payment_destinations_account_idx').on(table.tenantId, table.accountId),
    check('payment_destinations_card_number_check', sql`card_number ~ '^[0-9]{16}$'`),
    check('payment_destinations_iban_check', sql`iban IS NULL OR iban ~ '^IR[0-9]{24}$'`),
  ],
);

/**
 * R4 A1: every press of «🔄 تغییر شماره کارت» on a card-to-card invoice — the card the
 * customer was shown NEXT, frozen exactly as `payment_destinations` freezes the first one.
 *
 * Append-only by trigger, like `payment_destinations`: what a customer was told about where
 * to send money never changes afterwards, and a switch is a second thing they were told.
 * The card a payment's customer saw LAST — the one a receipt reviewer must compare against
 * — is the row with the greatest `sequence`, or `payment_destinations` when there is none.
 *
 * `sequence` is 1, 2, 3… per payment, and the unique key is what makes a switch a
 * compare-and-set: a tap carries the sequence it was drawn at, the service inserts
 * `sequence + 1` under the payment's row lock, and a second tap of the same keyboard (a
 * double tap, a redelivered update) finds the sequence moved and switches nothing.
 */
export const paymentDestinationSwitches = pgTable(
  'payment_destination_switches',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paymentId: uuid('payment_id').notNull(),
    sequence: integer('sequence').notNull(),
    /** The account the customer was shown before this press. */
    fromAccountId: uuid('from_account_id').notNull(),
    /** The account shown by this press, and every field of it the customer needs. */
    accountId: uuid('account_id').notNull(),
    label: text('label').notNull(),
    bankName: text('bank_name').notNull(),
    holderName: text('holder_name').notNull(),
    cardNumber: text('card_number').notNull(),
    iban: text('iban'),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'payment_destination_switches_payment_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.accountId],
      foreignColumns: [paymentAccounts.tenantId, paymentAccounts.id],
      name: 'payment_destination_switches_account_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.fromAccountId],
      foreignColumns: [paymentAccounts.tenantId, paymentAccounts.id],
      name: 'payment_destination_switches_from_account_fk',
    }),
    unique('payment_destination_switches_sequence_key').on(
      table.tenantId,
      table.paymentId,
      table.sequence,
    ),
    check('payment_destination_switches_sequence_check', sql`sequence >= 1`),
    check('payment_destination_switches_card_number_check', sql`card_number ~ '^[0-9]{16}$'`),
    check('payment_destination_switches_iban_check', sql`iban IS NULL OR iban ~ '^IR[0-9]{24}$'`),
  ],
);
