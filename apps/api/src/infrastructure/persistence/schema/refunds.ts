/**
 * Database schema — refunds: refunds, service refund requests, admin amount captures.
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
  REFUND_CHANNELS,
  REFUND_STATES,
  ADMIN_AMOUNT_CAPTURE_CLOSE_REASONS,
  ADMIN_CAPTURE_PURPOSES,
  ADMIN_CAPTURE_REASON_MAX_LENGTH,
  RECEIPT_REVIEW_PUSH_STATES,
  SERVICE_REFUND_REASON_MAX_LENGTH,
  SERVICE_REFUND_REASON_MIN_LENGTH,
  SERVICE_REFUND_REQUEST_ORIGINS,
  SERVICE_REFUND_REQUEST_STATES,
} from '@nexa/contracts';
import { enumCheck, nullableEnumCheck, timestamptz } from './_shared.js';
import { botInstances, tenants } from './tenancy.js';
import { admins } from './identity.js';
import { customers } from './customers.js';
import { clientApps } from './catalogue.js';
import { orders } from './orders.js';
import { payments } from './payments.js';
import { services } from './services.js';
import { provisioningOperations } from './provisioning.js';

/**
 * Money going back, as a row with a lifecycle.
 *
 * ## Why this is a table and not a column on `payments`
 *
 * A payment can be refunded MORE THAN ONCE — partially, by different operators, at
 * different times — so "was this refunded" is a sum rather than a flag. A boolean would
 * answer it wrongly the first time somebody refunds half.
 *
 * ## The refundable balance is derived, never stored
 *
 * There is no `refunded_amount` column on `payments`, deliberately, and it is the same
 * rule `CLAUDE.md` states about a wallet balance: the amount consumed is
 * `SUM(amount) WHERE state IN REFUND_CONSUMING_STATES`, computed inside the transaction
 * that needs it. A cached total is a second place for the truth to live, and the legacy
 * system's mutable balance column is the failure that rule exists to prevent.
 *
 * ## What the append-only guard allows and forbids
 *
 * A refund's state DOES change — that is its whole life — so this table is not
 * `payment_receipts`, which forbids UPDATE outright. `nexa_refunds_guard` freezes
 * everything that says WHAT was refunded (the payment, the customer, the amount, the
 * currency, the channel, the requester) and lets the lifecycle columns move. A refund
 * whose amount could be edited after the fact is a reviewer's evidence changing
 * underneath the decision made on it.
 */
export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The CONFIRMED payment this reverses. A refund with no payment has nothing to bound it. */
    paymentId: uuid('payment_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    /** Copied from the payment, so a refund report needs no join to say what was bought. */
    orderId: uuid('order_id'),
    state: text('state').notNull().default('REQUESTED'),
    /** Derived from the payment's method by `REFUND_METHOD_SUPPORT`, never operator-chosen. */
    channel: text('channel').notNull(),
    /**
     * Minor units, positive, with its currency beside it.
     *
     * The currency is STORED rather than joined from the payment, and that is the
     * money-convention rule rather than denormalisation for speed: `CLAUDE.md` says
     * never an amount without a currency, and a refund row that had to reach for one
     * could be read in isolation and misunderstood.
     */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The operator's own words. Required — a refund with no reason is unreviewable. */
    reason: text('reason').notNull(),
    /** Who decided. Null only for a refund no administrator requested, which nothing produces. */
    requestedByAdminId: uuid('requested_by_admin_id'),
    /**
     * Who recorded that the money actually left, and when.
     *
     * For the manual channel these two are the ONLY evidence the transfer happened, and
     * they are why `AWAITING_EXTERNAL` exists: this installation has no bank API, so a
     * person is the mechanism and their name and the time are the record of it.
     */
    completedByAdminId: uuid('completed_by_admin_id'),
    completedAt: timestamptz('completed_at'),
    /** The bank reference, when there is one. A cash refund across a counter has none. */
    externalReference: text('external_reference'),
    /** What the completing operator wrote, or why a refund was abandoned. */
    completionNote: text('completion_note'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** The payment's refund history, and the SUM the refundable balance is derived from. */
    index('refunds_tenant_payment_idx').on(table.tenantId, table.paymentId, table.createdAt),
    /** A customer's refunds, for the account view. */
    index('refunds_tenant_customer_idx').on(table.tenantId, table.customerId, table.createdAt),
    check('refunds_state_check', enumCheck('state', REFUND_STATES)),
    check('refunds_channel_check', enumCheck('channel', REFUND_CHANNELS)),
    check('refunds_currency_check', enumCheck('currency', CURRENCY_CODES)),
    /**
     * A refund is for a POSITIVE amount. Zero is not a refund and negative is a charge.
     *
     * `refundFitsWithin` refuses both at the boundary; this is the same rule where a
     * hand-written UPDATE meets it, which is the argument `payment_accounts` makes about
     * a repair script run at 3am.
     */
    check('refunds_amount_check', sql`amount > 0`),
    check('refunds_reason_check', sql`length(btrim(reason)) BETWEEN 3 AND 500`),
    check(
      'refunds_external_reference_check',
      sql`external_reference IS NULL OR length(btrim(external_reference)) BETWEEN 1 AND 140`,
    ),
    /**
     * COMPLETED means completed AT a time. Always.
     *
     * The rule `payments_confirmed_check` states for a confirmation, applied to the one
     * transition that means money is gone: a row cannot claim COMPLETED with no
     * timestamp, which is the "money marked returned because a refund was requested"
     * defect this whole lifecycle exists to prevent.
     */
    check('refunds_completed_check', sql`(state = 'COMPLETED') = (completed_at IS NOT NULL)`),
    /**
     * And BY somebody, when somebody asked for it.
     *
     * Split from the check above, because the two halves stopped being one rule.
     * A refund an OPERATOR requested is completed by an operator, and naming them is
     * the whole audit value — that half is unchanged and is enforced here.
     *
     * An AUTOMATIC refund has no operator on either side. Nobody requested it: a
     * settlement or a provisioner discovered that what a customer paid for cannot be
     * delivered, and the money went back in that transaction.
     * `requested_by_admin_id IS NULL` is what identifies one, and it cannot be an
     * operator's refund with the field forgotten — `RefundService.request` is guarded
     * by `refunds.issue`, which `SYSTEM_JOB_PERMISSIONS` does not carry, so every
     * operator refund has an administrator behind it by construction.
     *
     * Writing an admin id into an automatic refund to satisfy the old single check
     * was the alternative, and it is the one this codebase forbids outright: a
     * fabricated actor on a money record, attributing a decision to whoever happened
     * to press approve on an unrelated transfer.
     */
    check(
      'refunds_operator_completion_check',
      sql`(state = 'COMPLETED' AND requested_by_admin_id IS NOT NULL) = (completed_by_admin_id IS NOT NULL)`,
    ),
    foreignKey({
      name: 'refunds_payment_fk',
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
    }),
    unique('refunds_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * The window in which ONE administrator's next plain message is read as an amount to credit
 * from ONE receipt (Payment File 02 §12, `docs/payments-file02-design.md` D3).
 *
 * `receipt_captures`, turned round to face the reviewer. `INCIDENT-FIN-001` is an ADMIN
 * prompt that swallowed a typed navigation string and overwrote a production setting, and
 * credit-to-wallet genuinely needs a typed amount, so the prompt is a ROW with the four
 * properties that one lacked, all of them here rather than in a docstring:
 *
 * 1. it names ONE administrator, ONE bot and ONE payment, so there is no "current prompt"
 *    another person's message, or a message about another payment, can land in;
 * 2. it reads ONE amount: once `amount_minor` is set it no longer reads messages, so a
 *    second number typed after the confirmation was drawn cannot change what the button
 *    confirms — to change the figure, the reviewer cancels and starts again;
 * 3. the amount moves nothing by itself: a separate confirm, carrying this row's id,
 *    calls `ReceiptDispositionService.creditToWallet` under a key derived from the id;
 * 4. it EXPIRES, and the CHECK refuses a window that outlives its own opening.
 *
 * One open capture per administrator per bot is a partial unique index. Opening another
 * closes the first as SUPERSEDED in the same transaction.
 */
export const adminAmountCaptures = pgTable(
  'admin_amount_captures',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** WHICH bot the administrator is talking to, for `receipt_captures`' reason. */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    adminId: uuid('admin_id').notNull(),
    /**
     * WHAT the capture is about — a payment for the three receipt purposes, a customer for
     * `CUSTOMER_BLOCK_REASON` (WP10G). Exactly one is set, per purpose, and the target CHECK
     * below says which; the composite foreign keys keep both inside the tenant. `payment_id`
     * was NOT NULL until 0121, when the customers section's block joined this table rather
     * than open a sibling one: the partial unique index on (tenant, bot, admin) is what makes
     * "one open prompt per administrator per bot" a database fact, and only one table can
     * carry it.
     */
    paymentId: uuid('payment_id'),
    customerId: uuid('customer_id'),
    /**
     * WP19: the customer's service refund request an approval amount or a rejection reason
     * is for. Set for exactly the two `SERVICE_REFUND_*` purposes, and for nothing else.
     */
    serviceRefundRequestId: uuid('service_refund_request_id'),
    /**
     * The amount the administrator typed, in minor units of the PAYMENT's currency. Null
     * until they have typed one; set once. Not money on its own — nothing is credited
     * until the confirm, and the credit's own row carries its currency.
     */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }),
    /**
     * WHAT the capture reads (WP10 follow-up §4): the credit's amount, Block User's mandatory
     * reason, a rejection's mandatory reason (File 01 §7), or the mandatory reason of a block
     * from the customers section (WP10G). One table for all of them, because the partial unique
     * index below is what makes "one open prompt per administrator per bot" a database fact
     * across every purpose. Defaulted, so every row written before the column existed is a
     * credit's.
     */
    purpose: text('purpose').notNull().default('RECEIPT_CREDIT_AMOUNT'),
    /**
     * The block's or the rejection's reason as the administrator typed it, trimmed. Set once,
     * like `amount_minor`; null for a credit capture. It becomes the customer's
     * `blocked_reason` or the payment's `resolution_note`, and the customer is shown it.
     */
    reason: text('reason'),
    openedAt: timestamptz('opened_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    closedAt: timestamptz('closed_at'),
    closeReason: text('close_reason'),
    /**
     * WP19: the Telegram `update_id` of the tap that opened the prompt, for the two
     * `SERVICE_REFUND_*` purposes. A prompt reads only messages NEWER than it: update ids
     * increase per bot, so a redelivered message typed before the tap — for this prompt's
     * predecessor or for any other kind of prompt — cannot become this one's reason, and a
     * rejection is decided on its reason at once (Codex review of #83, round 5). Null for
     * every other purpose, and for a prompt opened with no update behind it.
     */
    openedUpdateId: bigint('opened_update_id', { mode: 'bigint' }),
    /**
     * Spec §7: the client app whose tutorial video a `CLIENT_APP_VIDEO` prompt reads, and
     * set for that purpose only. Deleting the app deletes its open prompt with it.
     */
    clientAppId: uuid('client_app_id'),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'admin_amount_captures_admin_fk',
    }),
    // Declared further down this file; the builder runs lazily, after it exists.
    foreignKey({
      columns: [table.tenantId, table.clientAppId],
      foreignColumns: [clientApps.tenantId, clientApps.id],
      name: 'admin_amount_captures_client_app_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'admin_amount_captures_payment_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'admin_amount_captures_customer_fk',
    }),
    // Declared at the end of this file; the builder runs lazily, after it exists.
    foreignKey({
      columns: [table.tenantId, table.serviceRefundRequestId],
      foreignColumns: [serviceRefundRequests.tenantId, serviceRefundRequests.id],
      name: 'admin_amount_captures_refund_request_fk',
    }),
    /**
     * Each purpose names exactly its own target: a receipt purpose a payment and never a
     * customer, the customers section's block a customer and never a payment. Every row written
     * before 0121 is a receipt purpose with a payment, so the constraint held on arrival.
     */
    check(
      'admin_amount_captures_target_check',
      sql`(purpose IN ('RECEIPT_CREDIT_AMOUNT', 'RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON')
            AND payment_id IS NOT NULL AND customer_id IS NULL AND service_refund_request_id IS NULL
            AND client_app_id IS NULL)
          OR (purpose = 'CUSTOMER_BLOCK_REASON' AND customer_id IS NOT NULL AND payment_id IS NULL
            AND service_refund_request_id IS NULL AND client_app_id IS NULL)
          OR (purpose IN ('SERVICE_REFUND_AMOUNT', 'SERVICE_REFUND_REJECT_REASON')
            AND service_refund_request_id IS NOT NULL AND payment_id IS NULL AND customer_id IS NULL
            AND client_app_id IS NULL)
          OR (purpose = 'CLIENT_APP_VIDEO' AND client_app_id IS NOT NULL AND payment_id IS NULL
            AND customer_id IS NULL AND service_refund_request_id IS NULL)`,
    ),
    /**
     * ONE open capture per administrator per bot, decided by the database — among the
     * prompts that read a typed amount or reason. The tutorial video prompt has its own
     * one-open slot (PR #185 review): the Web Admin opens it beside an amount the
     * administrator may be typing in Telegram, and must not close that amount silently.
     * A Telegram tap still closes every open prompt of the administrator on that bot.
     */
    uniqueIndex('admin_amount_captures_open_key')
      .on(table.tenantId, table.botInstanceId, table.adminId)
      .where(sql`closed_at IS NULL AND purpose <> 'CLIENT_APP_VIDEO'`),
    uniqueIndex('admin_amount_captures_open_video_key')
      .on(table.tenantId, table.botInstanceId, table.adminId)
      .where(sql`closed_at IS NULL AND purpose = 'CLIENT_APP_VIDEO'`),
    check(
      'admin_amount_captures_close_reason_check',
      nullableEnumCheck('close_reason', ADMIN_AMOUNT_CAPTURE_CLOSE_REASONS),
    ),
    check('admin_amount_captures_closed_check', sql`(closed_at IS NULL) = (close_reason IS NULL)`),
    check('admin_amount_captures_expiry_check', sql`expires_at > opened_at`),
    check('admin_amount_captures_amount_check', sql`amount_minor IS NULL OR amount_minor > 0`),
    /**
     * A confirmation confirms what the capture read: an amount for a credit, a reason for a
     * block or a rejection. There is no CONFIRMED row without it — and for those two that is
     * the database half of "the reason is mandatory".
     */
    check(
      'admin_amount_captures_confirmed_check',
      sql`close_reason IS DISTINCT FROM 'CONFIRMED'
          OR (purpose IN ('RECEIPT_CREDIT_AMOUNT', 'SERVICE_REFUND_AMOUNT') AND amount_minor IS NOT NULL)
          OR (purpose IN ('RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON', 'CUSTOMER_BLOCK_REASON', 'SERVICE_REFUND_REJECT_REASON') AND reason IS NOT NULL)
          OR purpose = 'CLIENT_APP_VIDEO'`,
    ),
    check('admin_amount_captures_purpose_check', enumCheck('purpose', ADMIN_CAPTURE_PURPOSES)),
    /** Each purpose reads its own column and never the other's. */
    check(
      'admin_amount_captures_purpose_column_check',
      sql`(purpose IN ('RECEIPT_CREDIT_AMOUNT', 'SERVICE_REFUND_AMOUNT') AND reason IS NULL)
          OR (purpose IN ('RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON', 'CUSTOMER_BLOCK_REASON', 'SERVICE_REFUND_REJECT_REASON') AND amount_minor IS NULL)
          OR (purpose = 'CLIENT_APP_VIDEO' AND amount_minor IS NULL AND reason IS NULL)`,
    ),
    check(
      'admin_amount_captures_reason_check',
      sql`reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND ${sql.raw(String(ADMIN_CAPTURE_REASON_MAX_LENGTH))}`,
    ),
  ],
);

/**
 * WP19 — a customer's request to cancel a service and have money returned
 * (`docs/wp19-service-refund-request-audit.md`).
 *
 * The row IS the record, independently of any Telegram message: a review card that is
 * never delivered loses nothing, because the Web Admin reads this table. Every state change
 * is a conditional UPDATE naming its `from` (`SERVICE_REFUND_REQUEST_TRANSITIONS`).
 *
 * The money is NOT here. The approved amount is RESERVED by a `REQUESTED` refund row
 * (`refund_id`) the moment an administrator confirms, and CREDITED only when the `TERMINATE`
 * operation (`operation_id`) has definitively deleted the provider account. This row links
 * the two and carries what neither of them does: the customer's reason and the decision.
 */
export const serviceRefundRequests = pgTable(
  'service_refund_requests',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    serviceId: uuid('service_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    /** The service's own NEW_SERVICE order, and the CONFIRMED payment that paid for it. */
    orderId: uuid('order_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    /**
     * The bot the customer filed through: the review cards and replies come from it. NULL
     * only for an operator's delete-and-refund (item 11), which no bot carried.
     */
    botInstanceId: uuid('bot_instance_id').references(() => botInstances.id),
    state: text('state').notNull().default('OPEN'),
    /**
     * Item 11: who started it — the customer from the bot, or an operator's own
     * «حذف سرویس و بازگشت وجه» from the Web Admin (`docs/ux1-delete-service-refund.md`).
     */
    origin: text('origin').notNull().default('CUSTOMER'),
    /** The customer's reason, trimmed, as they typed it. NULL only for an operator's. */
    reason: text('reason'),
    /**
     * The filing's idempotency key: the Telegram update that carried the reason. Unique for
     * ever, not just while the request is live — a redelivered update after the request was
     * rejected or failed is answered with that request, never filed a second time.
     */
    filingKey: text('filing_key').notNull(),
    /** The source payment's principal (never the gateway fee), in its currency. A snapshot. */
    principalMinor: bigint('principal_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** Set by the approval, with the three below; null while OPEN and on a rejection. */
    approvedAmountMinor: bigint('approved_amount_minor', { mode: 'bigint' }),
    refundId: uuid('refund_id'),
    operationId: uuid('operation_id'),
    /** Who decided — an approval or a rejection — and when. */
    decidedByAdminId: uuid('decided_by_admin_id'),
    decidedAt: timestamptz('decided_at'),
    /** A rejection's mandatory reason, which the customer is told. */
    rejectionReason: text('rejection_reason'),
    /** Why the deletion failed, as the operation recorded it: a code, never provider text. */
    failureKind: text('failure_kind'),
    resolvedAt: timestamptz('resolved_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('service_refund_requests_tenant_id_key').on(table.tenantId, table.id),
    /** A refund row reserves money for at most one request. */
    unique('service_refund_requests_refund_key').on(table.tenantId, table.refundId),
    /** One request per filing, whatever became of it. */
    unique('service_refund_requests_filing_key').on(table.tenantId, table.filingKey),
    /**
     * ONE open request per service, decided by the database: a double tap, a replayed
     * update and two concurrent filings all meet this index, whatever the code forgot.
     */
    uniqueIndex('service_refund_requests_active_key')
      .on(table.tenantId, table.serviceId)
      .where(sql`state IN ('OPEN', 'EXECUTING')`),
    /** The sweep's read: executing requests, oldest first. */
    index('service_refund_requests_state_idx').on(table.tenantId, table.state, table.createdAt),
    /*
     * The attention stream's read: every request still needing an administrator, newest
     * first by `(created_at, id)` across all three states (Codex review of #83, round 11).
     * The state index groups by state and has no tie-breaker, so a page there collects and
     * sorts the whole matching history first — and FAILED is terminal and only grows.
     * Ascending on purpose: scanned backwards it is `DESC NULLS FIRST`, which is what
     * `ORDER BY ... DESC` means. Drizzle's `.desc()` writes `DESC NULLS LAST`, an order the
     * query never asks for, and PostgreSQL then sorts after all.
     */
    index('service_refund_requests_attention_idx')
      .on(table.tenantId, table.createdAt, table.id)
      .where(sql`state IN ('OPEN', 'EXECUTING', 'FAILED')`),
    index('service_refund_requests_service_idx').on(
      table.tenantId,
      table.serviceId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_refund_requests_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'service_refund_requests_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'service_refund_requests_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.id],
      name: 'service_refund_requests_payment_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.refundId],
      foreignColumns: [refunds.tenantId, refunds.id],
      name: 'service_refund_requests_refund_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.operationId],
      foreignColumns: [provisioningOperations.tenantId, provisioningOperations.id],
      name: 'service_refund_requests_operation_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.decidedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'service_refund_requests_admin_fk',
    }),
    check('service_refund_requests_state_check', enumCheck('state', SERVICE_REFUND_REQUEST_STATES)),
    check('service_refund_requests_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check(
      'service_refund_requests_reason_check',
      sql`reason = btrim(reason) AND char_length(reason) BETWEEN ${sql.raw(String(SERVICE_REFUND_REASON_MIN_LENGTH))} AND ${sql.raw(String(SERVICE_REFUND_REASON_MAX_LENGTH))}`,
    ),
    check(
      'service_refund_requests_origin_check',
      enumCheck('origin', SERVICE_REFUND_REQUEST_ORIGINS),
    ),
    /**
     * What each origin carries (item 11). A customer's filing has its reason and its bot; an
     * operator's delete-and-refund has neither, and is never OPEN — it is created and
     * approved in one transaction, so no review card, prompt or rejection can reach it.
     */
    check(
      'service_refund_requests_origin_shape_check',
      sql`(origin = 'CUSTOMER' AND reason IS NOT NULL AND bot_instance_id IS NOT NULL)
          OR (origin = 'OPERATOR' AND reason IS NULL AND bot_instance_id IS NULL
              AND state <> 'REJECTED')`,
    ),
    check('service_refund_requests_principal_check', sql`principal_minor > 0`),
    /**
     * What each state must carry. An OPEN request has decided nothing; one that was
     * approved carries the amount, the reservation, the deletion and the administrator; a
     * rejection carries its reason and its administrator. Written as the state's
     * consequences so a writer that forgets one fails here.
     */
    check(
      'service_refund_requests_open_check',
      sql`state <> 'OPEN' OR (approved_amount_minor IS NULL AND refund_id IS NULL
          AND operation_id IS NULL AND decided_by_admin_id IS NULL AND decided_at IS NULL
          AND rejection_reason IS NULL)`,
    ),
    check(
      'service_refund_requests_approved_check',
      sql`state NOT IN ('EXECUTING', 'COMPLETED', 'FAILED') OR (approved_amount_minor > 0
          AND approved_amount_minor <= principal_minor AND refund_id IS NOT NULL
          AND operation_id IS NOT NULL AND decided_by_admin_id IS NOT NULL
          AND decided_at IS NOT NULL AND rejection_reason IS NULL)`,
    ),
    check(
      'service_refund_requests_rejected_check',
      sql`state <> 'REJECTED' OR (rejection_reason IS NOT NULL
          AND length(btrim(rejection_reason)) BETWEEN 1 AND 500
          AND decided_by_admin_id IS NOT NULL AND decided_at IS NOT NULL
          AND approved_amount_minor IS NULL AND refund_id IS NULL AND operation_id IS NULL)`,
    ),
    check(
      'service_refund_requests_resolved_check',
      sql`(state IN ('COMPLETED', 'REJECTED', 'FAILED')) = (resolved_at IS NOT NULL)`,
    ),
  ],
);

/**
 * WP19 — one administrator's review card for one refund request: the receipt push's shape
 * (ADR-0031) and its outcome table, applied to a different subject. Text only — there is no
 * file to send.
 */
export const serviceRefundRequestPushes = pgTable(
  'service_refund_request_pushes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    requestId: uuid('request_id').notNull(),
    adminId: uuid('admin_id').notNull(),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    state: text('state').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at'),
    sendStartedAt: timestamptz('send_started_at'),
    chatId: text('chat_id'),
    lastErrorCode: text('last_error_code'),
    resolvedAt: timestamptz('resolved_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** One card per request per administrator, for ever. */
    unique('service_refund_request_pushes_request_admin_key').on(
      table.tenantId,
      table.requestId,
      table.adminId,
    ),
    foreignKey({
      columns: [table.tenantId, table.requestId],
      foreignColumns: [serviceRefundRequests.tenantId, serviceRefundRequests.id],
      name: 'service_refund_request_pushes_request_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'service_refund_request_pushes_admin_fk',
    }),
    index('service_refund_request_pushes_due_idx')
      .on(table.tenantId, table.nextAttemptAt)
      .where(sql`state = 'PENDING'`),
    check(
      'service_refund_request_pushes_state_check',
      enumCheck('state', RECEIPT_REVIEW_PUSH_STATES),
    ),
    check(
      'service_refund_request_pushes_resolved_check',
      sql`(state <> 'PENDING') = (resolved_at IS NOT NULL)`,
    ),
    check('service_refund_request_pushes_attempts_check', sql`attempts >= 0`),
  ],
);
