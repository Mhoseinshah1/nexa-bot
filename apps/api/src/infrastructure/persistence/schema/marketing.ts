/**
 * Database schema — marketing: discounts, cashback, campaigns.
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
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  CURRENCY_CODES,
  DISCOUNT_TYPES,
  DISCOUNT_STATUSES,
  DISCOUNT_KINDS,
  DISCOUNTABLE_PURPOSES,
  DISCOUNT_CODE_CAPTURE_CLOSE_REASONS,
  DISCOUNT_LABEL_MAX_LENGTH,
  DISCOUNT_PRIORITY_MIN,
  DISCOUNT_PRIORITY_MAX,
  CASHBACK_RULE_STATUSES,
  CAMPAIGN_ACTION_KINDS,
  CAMPAIGN_ACTION_STATES,
  CAMPAIGN_DESCRIPTION_MAX_LENGTH,
  CAMPAIGN_NAME_MAX_LENGTH,
  CAMPAIGN_STATES,
  CASHBACK_STATES,
  CASHBACK_PERCENT_MIN,
  CASHBACK_PERCENT_MAX,
} from '@nexa/contracts';
import {
  enumCheck,
  enumSubsetCheck,
  nullableEnumCheck,
  recordSourceChecks,
  recordSourceColumns,
  timestamptz,
} from './_shared.js';
import { botInstances, tenants } from './tenancy.js';
import { admins } from './identity.js';
import { customers } from './customers.js';
import { productCategories, products } from './catalogue.js';
import { orders } from './orders.js';
import { refunds } from './refunds.js';
import { walletEntries } from './wallet.js';
import { broadcasts, bulkOperations, frozenAudiences } from './broadcasts.js';

/**
 * A discount rule (`docs/wp8-pricing-audit.md` P3).
 *
 * A `CODE` rule applies when a customer enters its code; an `AUTOMATIC` rule applies to
 * every order it is eligible for. `code` is required for the first and forbidden for the
 * second, and `discounts_code_kind_check` says so in the database as well.
 *
 * `value` is whole percent for `PERCENTAGE` and minor units for `FIXED_AMOUNT`, and
 * `currency` is required for the second and forbidden for the first — a percentage with
 * a currency is a category error that would eventually be read as an amount.
 *
 * There is no counter. The limits are decided by counting LIVE redemptions — rows whose
 * order is `AWAITING_PAYMENT` or `PAID` — under this row's lock, at confirmation (P6).
 * The `redemption_count` column this table had until WP8 claimed "the conditional UPDATE
 * that increments it" was the authority; no such UPDATE ever existed, nothing ever wrote
 * it, and a counter the limit does not read is a second answer to "how many".
 */
export const discounts = pgTable(
  'discounts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    /** Normalised to upper case before storage, so case cannot split a rule. Null for `AUTOMATIC`. */
    code: text('code'),
    /** The operator's name for the rule, and the quote trace's `ruleLabel`. */
    label: text('label').notNull(),
    type: text('type').notNull(),
    status: text('status').notNull().default('INACTIVE'),
    /** Whole percent, or minor units. See the docblock. */
    value: bigint('value', { mode: 'bigint' }).notNull(),
    currency: text('currency'),
    /** A non-empty subset of `DISCOUNTABLE_PURPOSES`. */
    appliesTo: text('applies_to').array().notNull(),
    /** At most one of the two scopes; neither means every product and every add-on. */
    productId: uuid('product_id'),
    categoryId: uuid('category_id'),
    /** When set, only this customer is eligible — the legacy per-user discount, as a rule. */
    customerId: uuid('customer_id'),
    firstPurchaseOnly: boolean('first_purchase_only').notNull().default(false),
    startsAt: timestamptz('starts_at'),
    endsAt: timestamptz('ends_at'),
    /** Null means unlimited. Two limits, because "100 uses" and "1 each" differ. */
    totalRedemptionsLimit: integer('total_redemptions_limit'),
    perCustomerLimit: integer('per_customer_limit'),
    minimumSubtotalAmount: bigint('minimum_subtotal_amount', { mode: 'bigint' }),
    /** Higher applies first; ties go to the older rule (P4). */
    priority: integer('priority').notNull().default(0),
    stackable: boolean('stackable').notNull().default(false),
    /**
     * RETAINED FOR ONE RELEASE, and read by nothing in this one.
     *
     * The counter the limits never trusted; they count LIVE redemptions instead (P6). It
     * is not dropped here because the release before this one may still be running during
     * the rollback window, and a column dropped under it is the narrowing
     * `migration-compatibility.test.ts` refuses. The next release drops it, once nothing
     * that could be rolled back to still knows it exists.
     */
    redemptionCount: integer('redemption_count').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    ...recordSourceColumns(),
    /**
     * What the one-time Mirza import knew about this code and NEXA has no column for: the
     * original code text when it had to be normalised, the Mirza kind (a wallet "gift" code has
     * no NEXA equivalent), the counters and the scope fields as Mirza stored them. Reversible
     * evidence, read by nothing that prices or redeems. NULL unless `source = 'MIRZA'`.
     */
    sourceDetail: jsonb('source_detail'),
  },
  (table) => [
    ...recordSourceChecks('discounts', table),
    check('discounts_source_detail_check', sql`source_detail IS NULL OR source = 'MIRZA'`),
    uniqueIndex('discounts_tenant_code_key').on(table.tenantId, table.code),
    index('discounts_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    /** The candidates the engine reads for every quote: live automatic rules. */
    index('discounts_tenant_live_idx').on(table.tenantId, table.kind, table.status),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'discounts_product_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [productCategories.tenantId, productCategories.id],
      name: 'discounts_category_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'discounts_customer_fk',
    }),
    check('discounts_kind_check', enumCheck('kind', DISCOUNT_KINDS)),
    check('discounts_type_check', enumCheck('type', DISCOUNT_TYPES)),
    check('discounts_status_check', enumCheck('status', DISCOUNT_STATUSES)),
    check('discounts_currency_check', nullableEnumCheck('currency', CURRENCY_CODES)),
    check('discounts_value_check', sql`value > 0`),
    check('discounts_count_check', sql`redemption_count >= 0`),
    /** A code rule carries a code and an automatic one carries none. Both halves. */
    check('discounts_code_kind_check', sql`(kind = 'CODE') = (code IS NOT NULL)`),
    /** A percentage is 1..100 and carries no currency; a fixed amount carries one. */
    check(
      'discounts_percentage_check',
      sql`type <> 'PERCENTAGE' OR (value <= 100 AND currency IS NULL)`,
    ),
    check('discounts_fixed_check', sql`type <> 'FIXED_AMOUNT' OR currency IS NOT NULL`),
    check(
      'discounts_window_check',
      sql`starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at`,
    ),
    check(
      'discounts_limits_check',
      sql`(total_redemptions_limit IS NULL OR total_redemptions_limit > 0) AND (per_customer_limit IS NULL OR per_customer_limit > 0)`,
    ),
    check(
      'discounts_minimum_check',
      sql`minimum_subtotal_amount IS NULL OR minimum_subtotal_amount >= 0`,
    ),
    /** The code is ASCII and upper case in the database, not only in the application. */
    check('discounts_code_shape_check', sql`code ~ '^[A-Z0-9_-]{3,40}$'`),
    check(
      'discounts_label_check',
      sql`char_length(label) BETWEEN 1 AND ${sql.raw(String(DISCOUNT_LABEL_MAX_LENGTH))}`,
    ),
    /**
     * A non-empty subset of the discountable purposes. `TRIAL` is never a member: a
     * discount on a free order is a discount of nothing.
     */
    check('discounts_applies_to_check', enumSubsetCheck('applies_to', DISCOUNTABLE_PURPOSES)),
    check('discounts_scope_check', sql`product_id IS NULL OR category_id IS NULL`),
    /** "First purchase" is a question about new purchases, and only about them. */
    check(
      'discounts_first_purchase_check',
      sql`NOT first_purchase_only OR applies_to = ARRAY['NEW_SERVICE']::text[]`,
    ),
    check(
      'discounts_priority_check',
      sql`priority BETWEEN ${sql.raw(String(DISCOUNT_PRIORITY_MIN))} AND ${sql.raw(String(DISCOUNT_PRIORITY_MAX))}`,
    ),
    unique('discounts_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * One redemption — the fact that a rule was applied to a confirmed order.
 *
 * Written at confirmation, under the rule's row lock, with the amount the quote trace
 * took off (P6). Unique on `(tenant_id, order_id, discount_id)`: a stacked order redeems
 * more than one rule, and no order redeems the same rule twice, however often a retry
 * re-enters the step.
 *
 * A redemption is LIVE while its order is `AWAITING_PAYMENT` or `PAID`. A cancelled,
 * expired or refunded order frees its use without anything having to run, which is why
 * there is no released-at column to forget to write.
 */
export const discountRedemptions = pgTable(
  'discount_redemptions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    discountId: uuid('discount_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    orderId: uuid('order_id').notNull(),
    /** What it actually took off, snapshotted — the rule may be re-tuned later. */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.discountId],
      foreignColumns: [discounts.tenantId, discounts.id],
      name: 'discount_redemptions_discount_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'discount_redemptions_customer_fk',
    }),
    /**
     * The customer travels with the order.
     *
     * This is the one the review found. The per-customer redemption limit is counted over
     * `(discount_id, customer_id)`, so a row whose customer does not own its order makes
     * the limit advisory — a customer could redeem a once-per-person code repeatedly by
     * attributing each redemption elsewhere.
     */
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'discount_redemptions_order_fk',
    }),
    /** One redemption per rule per order, as a constraint rather than a check-then-write. */
    uniqueIndex('discount_redemptions_order_discount_key').on(
      table.tenantId,
      table.orderId,
      table.discountId,
    ),
    index('discount_redemptions_discount_customer_idx').on(table.discountId, table.customerId),
    check('discount_redemptions_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('discount_redemptions_amount_check', sql`amount > 0`),
  ],
);

/**
 * The window in which a customer's next plain message is read as a discount code (P11).
 *
 * `username_captures`, again, down to the partial unique index and for the same reason:
 * an open window is the only thing that lets an ordinary message be read as an answer,
 * so it is a ROW with an owner, a draft and a deadline. The only thing it can DO is
 * re-quote the one draft it names, for the one customer it names.
 */
export const discountCodeCaptures = pgTable(
  'discount_code_captures',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    orderId: uuid('order_id').notNull(),
    openedAt: timestamptz('opened_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    closedAt: timestamptz('closed_at'),
    closeReason: text('close_reason'),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'discount_code_captures_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'discount_code_captures_order_fk',
    }),
    /** ONE open window per customer per bot, decided by the database. */
    uniqueIndex('discount_code_captures_open_key')
      .on(table.tenantId, table.botInstanceId, table.customerId)
      .where(sql`closed_at IS NULL`),
    check(
      'discount_code_captures_close_reason_check',
      nullableEnumCheck('close_reason', DISCOUNT_CODE_CAPTURE_CLOSE_REASONS),
    ),
    check('discount_code_captures_closed_check', sql`(closed_at IS NULL) = (close_reason IS NULL)`),
    check('discount_code_captures_expiry_check', sql`expires_at > opened_at`),
  ],
);

/**
 * A cashback rule (P8). Not a discount: it never changes what the customer pays.
 *
 * Among the eligible rules for a quote, the highest `percent` wins, then the older rule
 * (`O-6`'s fallback, "max wins"); cashback rules never stack.
 */
export const cashbackRules = pgTable(
  'cashback_rules',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    label: text('label').notNull(),
    status: text('status').notNull().default('INACTIVE'),
    percent: integer('percent').notNull(),
    appliesTo: text('applies_to').array().notNull(),
    productId: uuid('product_id'),
    categoryId: uuid('category_id'),
    startsAt: timestamptz('starts_at'),
    endsAt: timestamptz('ends_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('cashback_rules_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('cashback_rules_tenant_status_idx').on(table.tenantId, table.status),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'cashback_rules_product_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [productCategories.tenantId, productCategories.id],
      name: 'cashback_rules_category_fk',
    }),
    check('cashback_rules_status_check', enumCheck('status', CASHBACK_RULE_STATUSES)),
    check(
      'cashback_rules_percent_check',
      sql`percent BETWEEN ${sql.raw(String(CASHBACK_PERCENT_MIN))} AND ${sql.raw(String(CASHBACK_PERCENT_MAX))}`,
    ),
    check(
      'cashback_rules_label_check',
      sql`char_length(label) BETWEEN 1 AND ${sql.raw(String(DISCOUNT_LABEL_MAX_LENGTH))}`,
    ),
    check('cashback_rules_applies_to_check', enumSubsetCheck('applies_to', DISCOUNTABLE_PURPOSES)),
    check('cashback_rules_scope_check', sql`product_id IS NULL OR category_id IS NULL`),
    check(
      'cashback_rules_window_check',
      sql`starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at`,
    ),
    unique('cashback_rules_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * An order's cashback, from confirmation to its end (P8, P9).
 *
 * Written at confirmation from the quote's `cashback`, `PENDING`. Moves ONCE: to `EARNED`
 * when the order is delivered, with the credit it wrote, or to `VOID` when the order ends
 * without delivery. Everything the quote promised is frozen here by
 * `nexa_order_cashback_guard`, so a rule retuned after the sale cannot change a promise
 * already made.
 *
 * `earned_amount` may be less than `amount` — a refund that completed before delivery
 * reduces what is earned rather than having to be reversed — and may be ZERO when the
 * whole payment went back first. A zero earning writes no wallet entry, and the check
 * below says both halves of that.
 */
export const orderCashback = pgTable(
  'order_cashback',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    ruleId: uuid('rule_id').notNull(),
    ruleLabel: text('rule_label').notNull(),
    percent: integer('percent').notNull(),
    /** What the quote promised, on the order's final total. */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    state: text('state').notNull().default('PENDING'),
    earnedAmount: bigint('earned_amount', { mode: 'bigint' }),
    earnedEntryId: uuid('earned_entry_id'),
    earnedAt: timestamptz('earned_at'),
    voidedAt: timestamptz('voided_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'order_cashback_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.ruleId],
      foreignColumns: [cashbackRules.tenantId, cashbackRules.id],
      name: 'order_cashback_rule_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.earnedEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
      name: 'order_cashback_earned_entry_fk',
    }),
    /** One promise per order. */
    uniqueIndex('order_cashback_tenant_order_key').on(table.tenantId, table.orderId),
    /** The earner's discovery index: promises still waiting on their order. */
    index('order_cashback_pending_idx')
      .on(table.tenantId, table.createdAt, table.id)
      .where(sql`state = 'PENDING'`),
    check('order_cashback_state_check', enumCheck('state', CASHBACK_STATES)),
    check('order_cashback_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('order_cashback_amount_check', sql`amount > 0`),
    check(
      'order_cashback_percent_check',
      sql`percent BETWEEN ${sql.raw(String(CASHBACK_PERCENT_MIN))} AND ${sql.raw(String(CASHBACK_PERCENT_MAX))}`,
    ),
    /** Earned exactly when stamped earned, with an amount never above the promise. */
    check(
      'order_cashback_earned_check',
      sql`(state = 'EARNED') = (earned_at IS NOT NULL) AND (state = 'EARNED') = (earned_amount IS NOT NULL) AND (earned_amount IS NULL OR (earned_amount >= 0 AND earned_amount <= amount))`,
    ),
    /** A credit was written exactly when something was earned. */
    check(
      'order_cashback_entry_check',
      sql`(earned_entry_id IS NOT NULL) = (earned_amount IS NOT NULL AND earned_amount > 0)`,
    ),
    check('order_cashback_void_check', sql`(state = 'VOID') = (voided_at IS NOT NULL)`),
    unique('order_cashback_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * One reversal of earned cashback, caused by one completed refund (P9). Append-only.
 *
 * `due` is what the refund made owed back, from the cumulative formula; `recovered` is
 * what the wallet balance could give, as a `CASHBACK_REVERSAL` debit; `unrecovered` is
 * the rest — the explicit liability rule: the balance never goes negative and history is
 * never edited, so what cannot be taken is RECORDED here and shown to the operator.
 */
export const cashbackReversals = pgTable(
  'cashback_reversals',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderCashbackId: uuid('order_cashback_id').notNull(),
    orderId: uuid('order_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    refundId: uuid('refund_id').notNull(),
    dueAmount: bigint('due_amount', { mode: 'bigint' }).notNull(),
    recoveredAmount: bigint('recovered_amount', { mode: 'bigint' }).notNull(),
    unrecoveredAmount: bigint('unrecovered_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    walletEntryId: uuid('wallet_entry_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.orderCashbackId],
      foreignColumns: [orderCashback.tenantId, orderCashback.id],
      name: 'cashback_reversals_cashback_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'cashback_reversals_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.refundId],
      foreignColumns: [refunds.tenantId, refunds.id],
      name: 'cashback_reversals_refund_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.walletEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
      name: 'cashback_reversals_entry_fk',
    }),
    /** One reversal per refund: a replayed completion reverses nothing twice. */
    uniqueIndex('cashback_reversals_tenant_refund_key').on(table.tenantId, table.refundId),
    index('cashback_reversals_cashback_idx').on(table.tenantId, table.orderCashbackId),
    check('cashback_reversals_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check(
      'cashback_reversals_amounts_check',
      sql`due_amount > 0 AND recovered_amount >= 0 AND unrecovered_amount >= 0 AND due_amount = recovered_amount + unrecovered_amount`,
    ),
    check(
      'cashback_reversals_entry_check',
      sql`(wallet_entry_id IS NOT NULL) = (recovered_amount > 0)`,
    ),
  ],
);

/**
 * Round N, C1 — a campaign (`docs/round-n-campaigns-audit.md`).
 *
 * A record that COMPOSES engines and owns none of their decisions: it prices nothing,
 * credits nothing, sends nothing and dials no panel. What it owns is here — a name, the
 * half-open window `[starts_at, ends_at)` resolved from the tenant's own calendar and
 * zone, the audience definition frozen when it is scheduled, and a state whose every
 * change is a conditional UPDATE naming its from-states (`CAMPAIGN_MACHINE`).
 */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    /** Internal only: an operator's note, never shown to a customer. */
    description: text('description').notNull().default(''),
    state: text('state').notNull().default('DRAFT'),
    startsAt: timestamptz('starts_at').notNull(),
    endsAt: timestamptz('ends_at').notNull(),
    /**
     * The shared audience definition (the Broadcast engine's own contract). Editable while
     * DRAFT; frozen by the schedule, which stamps `audience_frozen_at` and the count the
     * operator confirmed.
     */
    audience: jsonb('audience').notNull(),
    /** sha256 of the canonical definition (`freezeAudience`), what a confirmation binds to. */
    audienceHash: text('audience_hash').notNull(),
    audienceFrozenAt: timestamptz('audience_frozen_at'),
    /** The audience count the operator saw in the preview and confirmed. */
    audienceConfirmedCount: integer('audience_confirmed_count'),
    /** The md5 of the confirmed SET of customer ids, as the audience engine computes it. */
    audienceFingerprint: text('audience_fingerprint'),
    createdByAdminId: uuid('created_by_admin_id'),
    scheduledByAdminId: uuid('scheduled_by_admin_id'),
    scheduledAt: timestamptz('scheduled_at'),
    startedAt: timestamptz('started_at'),
    pausedAt: timestamptz('paused_at'),
    completedAt: timestamptz('completed_at'),
    cancelledByAdminId: uuid('cancelled_by_admin_id'),
    cancelledAt: timestamptz('cancelled_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('campaigns_tenant_id_key').on(table.tenantId, table.id),
    index('campaigns_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    /** The worker's two discovery questions: due to start, and due to complete. */
    index('campaigns_due_start_idx')
      .on(table.tenantId, table.startsAt, table.id)
      .where(sql`state = 'SCHEDULED'`),
    index('campaigns_due_end_idx')
      .on(table.tenantId, table.endsAt, table.id)
      .where(sql`state IN ('ACTIVE', 'PAUSED')`),
    foreignKey({
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'campaigns_created_by_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.scheduledByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'campaigns_scheduled_by_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.cancelledByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'campaigns_cancelled_by_fk',
    }),
    check('campaigns_state_check', enumCheck('state', CAMPAIGN_STATES)),
    check('campaigns_window_check', sql`starts_at < ends_at`),
    check(
      'campaigns_name_check',
      sql`char_length(name) BETWEEN 1 AND ${sql.raw(String(CAMPAIGN_NAME_MAX_LENGTH))}`,
    ),
    check(
      'campaigns_description_check',
      sql`char_length(description) <= ${sql.raw(String(CAMPAIGN_DESCRIPTION_MAX_LENGTH))}`,
    ),
    /** Past DRAFT the audience is frozen: every state but DRAFT and a draft's CANCEL. */
    check(
      'campaigns_frozen_check',
      sql`(audience_frozen_at IS NULL) = (scheduled_at IS NULL) AND (scheduled_at IS NULL) = (audience_confirmed_count IS NULL) AND (scheduled_at IS NULL) = (audience_fingerprint IS NULL)`,
    ),
    check(
      'campaigns_scheduled_check',
      sql`state IN ('DRAFT', 'CANCELLED') OR scheduled_at IS NOT NULL`,
    ),
    check(
      'campaigns_started_check',
      sql`state NOT IN ('ACTIVE', 'PAUSED') OR started_at IS NOT NULL`,
    ),
    check('campaigns_completed_check', sql`(state = 'COMPLETED') = (completed_at IS NOT NULL)`),
    check('campaigns_cancelled_check', sql`(state = 'CANCELLED') = (cancelled_at IS NOT NULL)`),
    check('campaigns_paused_check', sql`(state = 'PAUSED') = (paused_at IS NOT NULL)`),
    check('campaigns_audience_hash_check', sql`audience_hash ~ '^[0-9a-f]{64}$'`),
    check(
      'campaigns_audience_fingerprint_check',
      sql`audience_fingerprint IS NULL OR audience_fingerprint ~ '^[0-9a-f]{32}$'`,
    ),
    check(
      'campaigns_confirmed_count_check',
      sql`audience_confirmed_count IS NULL OR audience_confirmed_count >= 0`,
    ),
  ],
);

/**
 * One promotional action of a campaign, and the ONE row it made in another engine.
 *
 * `config` is the action's terms as the operator confirmed them, frozen with the
 * campaign. The link columns name what the engine holds: a discount rule, a cashback
 * rule, or the shared engines' bulk operation or broadcast. At most one action of each
 * kind per campaign, and each link is only on the kind it belongs to.
 */
export const campaignActions = pgTable(
  'campaign_actions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    campaignId: uuid('campaign_id').notNull(),
    kind: text('kind').notNull(),
    state: text('state').notNull().default('PENDING'),
    config: jsonb('config').notNull(),
    discountId: uuid('discount_id'),
    cashbackRuleId: uuid('cashback_rule_id'),
    /**
     * A launched action's confirmation binding (count, set, liability, typed count), frozen by
     * the schedule, so an interrupted hand-over is retried with EXACTLY what was confirmed —
     * the engine's idempotency then replays rather than creating a second operation.
     */
    binding: jsonb('binding'),
    /** The announcement: the Broadcast lane's own record. */
    broadcastId: uuid('broadcast_id'),
    /** A wallet, traffic or time gift: the mass-action engine's own record. */
    bulkOperationId: uuid('bulk_operation_id'),
    /**
     * Round N close (§A): the FROZEN audience this action's engine record is seeded from —
     * customers for the announcement and a wallet gift, services for a traffic or time
     * gift — materialised in the confirming transaction. A hand-over retried after the live
     * audience moved copies these members, never re-selects. Null for the standing rules.
     */
    frozenAudienceId: uuid('frozen_audience_id'),
    /** Why the engine refused to take the work, as its error code. Null otherwise. */
    failureCode: text('failure_code'),
    launchedAt: timestamptz('launched_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.frozenAudienceId],
      foreignColumns: [frozenAudiences.tenantId, frozenAudiences.id],
      name: 'campaign_actions_frozen_audience_fk',
    }).onDelete('restrict'),
    check(
      'campaign_actions_frozen_kind_check',
      sql`frozen_audience_id IS NULL OR kind IN ('WALLET_GIFT', 'TRAFFIC_GIFT', 'TIME_GIFT', 'ANNOUNCEMENT')`,
    ),
    uniqueIndex('campaign_actions_campaign_kind_key').on(
      table.tenantId,
      table.campaignId,
      table.kind,
    ),
    /** A rule belongs to at most one campaign. */
    uniqueIndex('campaign_actions_discount_key')
      .on(table.tenantId, table.discountId)
      .where(sql`discount_id IS NOT NULL`),
    uniqueIndex('campaign_actions_cashback_rule_key')
      .on(table.tenantId, table.cashbackRuleId)
      .where(sql`cashback_rule_id IS NOT NULL`),
    foreignKey({
      columns: [table.tenantId, table.campaignId],
      foreignColumns: [campaigns.tenantId, campaigns.id],
      name: 'campaign_actions_campaign_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.discountId],
      foreignColumns: [discounts.tenantId, discounts.id],
      name: 'campaign_actions_discount_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.cashbackRuleId],
      foreignColumns: [cashbackRules.tenantId, cashbackRules.id],
      name: 'campaign_actions_cashback_rule_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.broadcastId],
      foreignColumns: [broadcasts.tenantId, broadcasts.id],
      name: 'campaign_actions_broadcast_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.bulkOperationId],
      foreignColumns: [bulkOperations.tenantId, bulkOperations.id],
      name: 'campaign_actions_bulk_operation_fk',
    }),
    uniqueIndex('campaign_actions_broadcast_key')
      .on(table.tenantId, table.broadcastId)
      .where(sql`broadcast_id IS NOT NULL`),
    uniqueIndex('campaign_actions_bulk_operation_key')
      .on(table.tenantId, table.bulkOperationId)
      .where(sql`bulk_operation_id IS NOT NULL`),
    check(
      'campaign_actions_broadcast_kind_check',
      sql`broadcast_id IS NULL OR kind = 'ANNOUNCEMENT'`,
    ),
    check(
      'campaign_actions_bulk_kind_check',
      sql`bulk_operation_id IS NULL OR kind IN ('WALLET_GIFT', 'TRAFFIC_GIFT', 'TIME_GIFT')`,
    ),
    check('campaign_actions_kind_check', enumCheck('kind', CAMPAIGN_ACTION_KINDS)),
    check('campaign_actions_state_check', enumCheck('state', CAMPAIGN_ACTION_STATES)),
    check('campaign_actions_discount_kind_check', sql`discount_id IS NULL OR kind = 'DISCOUNT'`),
    check(
      'campaign_actions_cashback_kind_check',
      sql`cashback_rule_id IS NULL OR kind = 'CASHBACK'`,
    ),
    check('campaign_actions_launched_check', sql`(state = 'LAUNCHED') = (launched_at IS NOT NULL)`),
    check('campaign_actions_failed_check', sql`(state = 'FAILED') = (failure_code IS NOT NULL)`),
  ],
);
