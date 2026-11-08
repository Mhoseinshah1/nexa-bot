/**
 * Database schema — resellers: tiers, grants, resellers, overrides, order terms, reseller requests.
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
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  CURRENCY_CODES,
  RESELLER_STATUSES,
  RESELLER_PRICING_MODES,
  RESELLER_OVERRIDE_MODES,
  RESELLER_GRANT_KINDS,
  RESELLER_GRANTABLE_OPERATIONS,
  RESELLER_ENTITLEMENT_DIMENSIONS,
  RESELLER_MINIMUM_NOTICE_KINDS,
  RESELLER_PRICE_LAYERS,
  RESELLER_REQUEST_ANSWER_CEILING,
  RESELLER_REQUEST_ANSWER_DEFAULT_MAX,
  RESELLER_REQUEST_ATTACHMENT_KINDS,
  RESELLER_REQUEST_MESSAGE_MAX,
  RESELLER_REQUEST_QUESTION_TEXT_MAX,
  RESELLER_REQUEST_REASON_MAX,
  RESELLER_REQUEST_MESSAGE_SENDERS,
  RESELLER_REQUEST_STATUSES,
} from '@nexa/contracts';
import {
  enumCheck,
  nullableEnumCheck,
  recordSourceChecks,
  recordSourceColumns,
  timestamptz,
} from './_shared.js';
import { botInstances, tenants } from './tenancy.js';
import { admins } from './identity.js';
import { customers } from './customers.js';
import { products } from './catalogue.js';
import { orders } from './orders.js';

/**
 * A reseller tier: the pricing policy, the credit policy and — in `reseller_tier_grants` —
 * the entitlements every reseller on it shares (`docs/wp9-reseller-audit.md` R2, R3, R5).
 *
 * Its own table and never a customer attribute: the legacy tier was one enum read by four
 * subsystems, and that is the failure this keeps out. Edited in place, never deleted while
 * a reseller points at it (the foreign key refuses).
 */
export const resellerTiers = pgTable(
  'reseller_tiers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    pricingMode: text('pricing_mode').notNull(),
    /** Whole percent off list. Null unless the mode is PERCENTAGE_DISCOUNT. */
    discountPercentage: integer('discount_percentage'),
    /**
     * Kept, not dropped: reseller credit was removed (owner decision, 2026-10-01). Writes can
     * store only zero; a positive value stored before the decision grants nothing.
     */
    creditLimitAmount: bigint('credit_limit_amount', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    creditLimitCurrency: text('credit_limit_currency').notNull(),
    /**
     * Round N, package D: the monthly minimum sales every reseller on this tier inherits, or
     * null — and zero — for none. Tracking only: nothing happens to a reseller below it
     * (`docs/round-n-reseller-audit.md` §3.5).
     */
    monthlyMinimumAmount: bigint('monthly_minimum_amount', { mode: 'bigint' }),
    monthlyMinimumCurrency: text('monthly_minimum_currency'),
    /**
     * Round 4 PR-G, «قیمت عادی برای محصولات بدون قیمت»: under `FIXED_PRICE_TABLE`, a product
     * `reseller_tier_product_prices` does not price is sold at its list price (true) or not
     * sold to the tier at all (false, the default). Read by no other mode.
     */
    unpricedListFallback: boolean('unpriced_list_fallback').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    /** The composite key the tenant-scoped foreign keys below point at. */
    uniqueIndex('reseller_tiers_tenant_id_key').on(table.tenantId, table.id),
    check(
      'reseller_tiers_minimum_pair_check',
      sql`(monthly_minimum_amount IS NULL) = (monthly_minimum_currency IS NULL)`,
    ),
    check(
      'reseller_tiers_minimum_check',
      sql`monthly_minimum_amount IS NULL OR monthly_minimum_amount >= 0`,
    ),
    check(
      'reseller_tiers_minimum_currency_check',
      sql`monthly_minimum_currency IS NULL OR ${enumCheck('monthly_minimum_currency', CURRENCY_CODES)}`,
    ),
    uniqueIndex('reseller_tiers_tenant_name_key').on(table.tenantId, sql`lower(${table.name})`),
    index('reseller_tiers_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    check('reseller_tiers_pricing_mode_check', enumCheck('pricing_mode', RESELLER_PRICING_MODES)),
    check(
      'reseller_tiers_credit_currency_check',
      enumCheck('credit_limit_currency', CURRENCY_CODES),
    ),
    check('reseller_tiers_credit_limit_check', sql`credit_limit_amount >= 0`),
    check(
      'reseller_tiers_discount_mode_check',
      sql`(pricing_mode = 'PERCENTAGE_DISCOUNT') = (discount_percentage IS NOT NULL)`,
    ),
    check(
      'reseller_tiers_discount_range_check',
      sql`discount_percentage IS NULL OR (discount_percentage >= 1 AND discount_percentage <= 100)`,
    ),
  ],
);

/**
 * Round 4 PR-G: a `FIXED_PRICE_TABLE` tier's exact price for one product — the price the
 * `TIER_PRICE` step replaces the list subtotal with, for the purposes in
 * `RESELLER_TIER_PRICE_PURPOSES`. At most one row per (tier, product): no priority, no
 * date scope, nothing to overlap. No row is "not priced for this tier", which the tier's
 * `unpriced_list_fallback` decides.
 *
 * Written only under the tier's `FOR UPDATE` (`ResellerAdminService.setProductPrices`), so a
 * confirmation reading the tier `FOR SHARE` and then this row sees the price its quote was
 * compared with, or waits for the change. The currency is the product's own list currency
 * at write time; a row whose currency no longer matches the product is read as no price.
 */
export const resellerTierProductPrices = pgTable(
  'reseller_tier_product_prices',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    tierId: uuid('tier_id').notNull(),
    productId: uuid('product_id').notNull(),
    priceAmount: bigint('price_amount', { mode: 'bigint' }).notNull(),
    priceCurrency: text('price_currency').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.tierId, table.productId],
      name: 'reseller_tier_product_prices_pkey',
    }),
    foreignKey({
      columns: [table.tenantId, table.tierId],
      foreignColumns: [resellerTiers.tenantId, resellerTiers.id],
      name: 'reseller_tier_product_prices_tier_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'reseller_tier_product_prices_product_fk',
    }).onDelete('cascade'),
    /** A product's prices across tiers: the cascade's and an operator's "who prices this". */
    index('reseller_tier_product_prices_product_idx').on(table.tenantId, table.productId),
    check(
      'reseller_tier_product_prices_currency_check',
      enumCheck('price_currency', CURRENCY_CODES),
    ),
    /** Never zero: a zero-cost order is one nobody can pay (`resellerReductionMinor`). */
    check('reseller_tier_product_prices_amount_check', sql`price_amount > 0`),
  ],
);

/**
 * One entitlement a tier grants (R5). Deny by default, per kind: a kind with no row grants
 * nothing. `subject = '*'` grants every subject of its kind — the wire's null; an
 * `OPERATION` subject is an order purpose, every other subject an id of that kind.
 *
 * Replaced as a set, in one transaction, by the operator's grants write.
 */
export const resellerTierGrants = pgTable(
  'reseller_tier_grants',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    tierId: uuid('tier_id').notNull(),
    kind: text('kind').notNull(),
    subject: text('subject').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.tierId, table.kind, table.subject],
      name: 'reseller_tier_grants_pkey',
    }),
    foreignKey({
      columns: [table.tenantId, table.tierId],
      foreignColumns: [resellerTiers.tenantId, resellerTiers.id],
      name: 'reseller_tier_grants_tier_fk',
    }).onDelete('cascade'),
    check('reseller_tier_grants_kind_check', enumCheck('kind', RESELLER_GRANT_KINDS)),
    check(
      'reseller_tier_grants_subject_check',
      sql`subject = '*' OR (kind = 'OPERATION' AND subject IN (${sql.raw(
        RESELLER_GRANTABLE_OPERATIONS.map((o) => `'${o}'`).join(', '),
      )})) OR (kind <> 'OPERATION' AND subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')`,
    ),
  ],
);

/**
 * A reseller — a customer with a tier and, possibly, their own pricing override and credit
 * limit (`docs/wp9-reseller-audit.md` R1–R3, R8).
 *
 * `pricing_mode = 'TIER'` is "no override": the tier prices. A null credit limit is "the
 * tier's". The limit, wherever it comes from, is stored POSITIVE and means "the balance may
 * reach minus this", so no comparison is a double negative, and it defaults to ZERO on the
 * tier — a credit feature defaults to no credit.
 */
export const resellers = pgTable(
  'resellers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    tierId: uuid('tier_id').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    pricingMode: text('pricing_mode').notNull().default('TIER'),
    /** Whole percent off list. Null unless the mode is PERCENTAGE_DISCOUNT. */
    discountPercentage: integer('discount_percentage'),
    /**
     * The reseller's own limit, or null for the tier's. Reseller credit was removed (owner
     * decision, 2026-10-01): writes store only zero or null, and a positive value stored
     * before the decision grants nothing. Kept, not dropped.
     *
     * The `DEFAULT 0` is the column's pre-WP9-B default, KEPT: dropping it is a
     * narrowing the rollback window forbids (`migration-compatibility.test.ts`). It
     * decides nothing — every write here states the amount, and an insert that omitted
     * both columns would take 0 with a NULL currency, which the pair CHECK refuses.
     */
    creditLimitAmount: bigint('credit_limit_amount', { mode: 'bigint' }).default(sql`0`),
    creditLimitCurrency: text('credit_limit_currency'),
    /**
     * Round N, package D: the reseller's own monthly minimum. NULL inherits the tier's; ZERO
     * is an explicit "no minimum for this reseller"; positive is theirs. Tracking only.
     */
    monthlyMinimumAmount: bigint('monthly_minimum_amount', { mode: 'bigint' }),
    monthlyMinimumCurrency: text('monthly_minimum_currency'),
    /**
     * Round 11, C2: when this reseller's standing ends. NULL (every existing row) is "never":
     * the expiry sweep looks at no row without a date. It lives on the RESELLER row, not on
     * the tier, because a tier is shared and expiring it would suspend everyone in it.
     */
    expiresAt: timestamptz('expires_at'),
    /**
     * Round 11, C2: set by the expiry sweep, in the same statement that suspends the
     * reseller, and cleared by every other status write. Non-null means "the CURRENT
     * suspension was made by the expiry": only such a suspension is lifted by setting a
     * later `expires_at`; an administrator's suspension never is.
     */
    expirySuspendedAt: timestamptz('expiry_suspended_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    ...recordSourceColumns(),
    /**
     * DEPRECATED, written by nothing and read by nothing: drop in the next release
     * (expand/contract — a column is never dropped in the release that stops writing it).
     *
     * It held the legacy agent's `maxbuyagent`. That is a credit/limit concept and reseller
     * credit is removed (owner decision, 2026-10-01), so the cap is no NEXA field at all: it
     * lives only in the import's history — the package rows and `source_detail.purchaseCap`.
     */
    importedPurchaseCapMinor: bigint('imported_purchase_cap_minor', { mode: 'bigint' }),
    importedPurchaseCapCurrency: text('imported_purchase_cap_currency'),
    /**
     * What the import knew and NEXA has no column for: the tier price levels and the
     * per-user discount as Mirza stored them, and whether each was applied. NULL unless
     * `source = 'MIRZA'`.
     */
    sourceDetail: jsonb('source_detail'),
  },
  (table) => [
    ...recordSourceChecks('resellers', table),
    check('resellers_source_detail_check', sql`source_detail IS NULL OR source = 'MIRZA'`),
    check(
      'resellers_imported_cap_check',
      sql`(imported_purchase_cap_minor IS NULL) = (imported_purchase_cap_currency IS NULL)
        AND (imported_purchase_cap_minor IS NULL OR (source = 'MIRZA' AND imported_purchase_cap_minor >= 0))`,
    ),
    check(
      'resellers_imported_cap_currency_check',
      sql`imported_purchase_cap_currency IS NULL OR ${enumCheck('imported_purchase_cap_currency', CURRENCY_CODES)}`,
    ),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'resellers_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.tierId],
      foreignColumns: [resellerTiers.tenantId, resellerTiers.id],
      name: 'resellers_tier_fk',
    }),
    /** A customer is a reseller once, or not at all. */
    uniqueIndex('resellers_customer_key').on(table.tenantId, table.customerId),
    index('resellers_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('resellers_tenant_tier_idx').on(table.tenantId, table.tierId),
    /** The expiry sweep's lookup: only ACTIVE rows with a date, soonest first. */
    index('resellers_expiry_idx')
      .on(table.tenantId, table.expiresAt)
      .where(sql`status = 'ACTIVE' AND expires_at IS NOT NULL`),
    check('resellers_status_check', enumCheck('status', RESELLER_STATUSES)),
    check('resellers_pricing_mode_check', enumCheck('pricing_mode', RESELLER_OVERRIDE_MODES)),
    check(
      'resellers_credit_currency_check',
      sql`credit_limit_currency IS NULL OR ${enumCheck('credit_limit_currency', CURRENCY_CODES)}`,
    ),
    /** Both halves of the override, or neither. */
    check(
      'resellers_credit_pair_check',
      sql`(credit_limit_amount IS NULL) = (credit_limit_currency IS NULL)`,
    ),
    /** Stored positive, so every comparison against it reads forwards. */
    check(
      'resellers_credit_limit_check',
      sql`credit_limit_amount IS NULL OR credit_limit_amount >= 0`,
    ),
    check(
      'resellers_discount_mode_check',
      sql`(pricing_mode = 'PERCENTAGE_DISCOUNT') = (discount_percentage IS NOT NULL)`,
    ),
    check(
      'resellers_discount_range_check',
      sql`discount_percentage IS NULL OR (discount_percentage >= 1 AND discount_percentage <= 100)`,
    ),
    check(
      'resellers_minimum_pair_check',
      sql`(monthly_minimum_amount IS NULL) = (monthly_minimum_currency IS NULL)`,
    ),
    check(
      'resellers_minimum_check',
      sql`monthly_minimum_amount IS NULL OR monthly_minimum_amount >= 0`,
    ),
    check(
      'resellers_minimum_currency_check',
      sql`monthly_minimum_currency IS NULL OR ${enumCheck('monthly_minimum_currency', CURRENCY_CODES)}`,
    ),
  ],
);

/**
 * Round N, package D (R1): one row per entitlement DIMENSION a reseller overrides. The
 * reseller's grants of that dimension — `reseller_grant_overrides` — REPLACE the tier's
 * grants of the whole dimension; a dimension with no row here inherits the tier's. A row
 * with no grants beneath it overrides the dimension with nothing: deny by default.
 *
 * Replaced as a set, with its grants, under the reseller row's `FOR UPDATE` — the row
 * `ResellerService.standing` reads `FOR SHARE` — so a withdrawal and a sale serialise.
 */
export const resellerEntitlementOverrides = pgTable(
  'reseller_entitlement_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    dimension: text('dimension').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.customerId, table.dimension],
      name: 'reseller_entitlement_overrides_pkey',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [resellers.tenantId, resellers.customerId],
      name: 'reseller_entitlement_overrides_reseller_fk',
    }).onDelete('cascade'),
    check(
      'reseller_entitlement_overrides_dimension_check',
      enumCheck('dimension', RESELLER_ENTITLEMENT_DIMENSIONS),
    ),
  ],
);

/**
 * One grant of a reseller's override (R1): `reseller_tier_grants`' shape and subject rule,
 * under the dimension row it belongs to. `dimension` is the kind's own
 * (`RESELLER_GRANT_DIMENSION`), pinned by a CHECK so a grant cannot sit under another
 * dimension's override and be read as part of it.
 */
export const resellerGrantOverrides = pgTable(
  'reseller_grant_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    dimension: text('dimension').notNull(),
    kind: text('kind').notNull(),
    subject: text('subject').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.customerId, table.kind, table.subject],
      name: 'reseller_grant_overrides_pkey',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId, table.dimension],
      foreignColumns: [
        resellerEntitlementOverrides.tenantId,
        resellerEntitlementOverrides.customerId,
        resellerEntitlementOverrides.dimension,
      ],
      name: 'reseller_grant_overrides_dimension_fk',
    }).onDelete('cascade'),
    check('reseller_grant_overrides_kind_check', enumCheck('kind', RESELLER_GRANT_KINDS)),
    check(
      'reseller_grant_overrides_dimension_check',
      sql`(kind = 'OPERATION' AND dimension = 'OPERATION')
          OR (kind IN ('PRODUCT', 'CATEGORY') AND dimension = 'CATALOGUE')
          OR (kind = 'PANEL' AND dimension = 'PANEL')
          OR (kind = 'BOT' AND dimension = 'BOT')`,
    ),
    check(
      'reseller_grant_overrides_subject_check',
      sql`subject = '*' OR (kind = 'OPERATION' AND subject IN (${sql.raw(
        RESELLER_GRANTABLE_OPERATIONS.map((o) => `'${o}'`).join(', '),
      )})) OR (kind <> 'OPERATION' AND subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')`,
    ),
  ],
);

/**
 * Round N, package D (R2): one thing the lane told — or will tell — a reseller about one
 * month's minimum. The SUBJECT of `RESELLER_MINIMUM_REMINDER` and `_ACHIEVED`, for the
 * reason `wallet_threshold_alerts` is one: keyed on the customer, the lane's own subject
 * key would let a reseller be reminded once for ever.
 *
 * Unique per (reseller, kind, month): two worker replicas, a restart and every later pass
 * of the sweep write at most one reminder and one achievement per reseller per month.
 * Nothing else is written by the sweep: this row is not a debt, a fee or a status.
 */
export const resellerMinimumNotices = pgTable(
  'reseller_minimum_notices',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    kind: text('kind').notNull(),
    /** The month, half-open `[period_start, period_end)`, in the tenant's calendar. */
    periodStart: timestamptz('period_start').notNull(),
    periodEnd: timestamptz('period_end').notNull(),
    /** The effective minimum when the notice was raised: what the send-time re-check compares. */
    minimumAmount: bigint('minimum_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The month's sales when the notice was raised. */
    achievedAmount: bigint('achieved_amount', { mode: 'bigint' }).notNull(),
    raisedAt: timestamptz('raised_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [resellers.tenantId, resellers.customerId],
      name: 'reseller_minimum_notices_reseller_fk',
    }),
    /** At most one of each kind per reseller per month: the arbiter of every insert. */
    unique('reseller_minimum_notices_period_key').on(
      table.tenantId,
      table.customerId,
      table.kind,
      table.periodStart,
    ),
    check('reseller_minimum_notices_kind_check', enumCheck('kind', RESELLER_MINIMUM_NOTICE_KINDS)),
    check('reseller_minimum_notices_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('reseller_minimum_notices_period_check', sql`period_end > period_start`),
    check(
      'reseller_minimum_notices_amounts_check',
      sql`minimum_amount > 0 AND achieved_amount >= 0`,
    ),
  ],
);

/**
 * What a reseller's purchase was, frozen at confirmation (R9). One row per order,
 * append-only (migration guard), written in the transaction that confirms the order.
 *
 * The margin is `list − cost` and is never a discount; the promotion discount is WP8's,
 * taken off the cost. `sale = cost − promotion` is the order's total.
 */
export const orderResellerTerms = pgTable(
  'order_reseller_terms',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    resellerCustomerId: uuid('reseller_customer_id').notNull(),
    tierId: uuid('tier_id').notNull(),
    tierName: text('tier_name').notNull(),
    layer: text('layer').notNull(),
    percent: integer('percent'),
    listAmount: bigint('list_amount', { mode: 'bigint' }).notNull(),
    costAmount: bigint('cost_amount', { mode: 'bigint' }).notNull(),
    promotionAmount: bigint('promotion_amount', { mode: 'bigint' }).notNull(),
    saleAmount: bigint('sale_amount', { mode: 'bigint' }).notNull(),
    marginAmount: bigint('margin_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    botInstanceId: uuid('bot_instance_id'),
    /**
     * Round 4 PR-G: the cost is a `FIXED_PRICE_TABLE` tier's price for the product (layer
     * `TIER`, no percent), not a rate. False on every row written before the table existed.
     */
    fixedPrice: boolean('fixed_price').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.orderId], name: 'order_reseller_terms_pkey' }),
    foreignKey({
      columns: [table.tenantId, table.orderId, table.resellerCustomerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'order_reseller_terms_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.tierId],
      foreignColumns: [resellerTiers.tenantId, resellerTiers.id],
      name: 'order_reseller_terms_tier_fk',
    }),
    index('order_reseller_terms_tenant_reseller_idx').on(
      table.tenantId,
      table.resellerCustomerId,
      table.createdAt,
    ),
    check('order_reseller_terms_layer_check', enumCheck('layer', RESELLER_PRICE_LAYERS)),
    check('order_reseller_terms_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check(
      'order_reseller_terms_amounts_check',
      sql`list_amount >= 0 AND cost_amount >= 0 AND promotion_amount >= 0 AND sale_amount >= 0
          AND cost_amount <= list_amount
          AND sale_amount = cost_amount - promotion_amount
          AND margin_amount = list_amount - cost_amount`,
    ),
    check(
      'order_reseller_terms_percent_check',
      sql`(percent IS NULL OR (percent >= 1 AND percent <= 100))
          AND (layer <> 'TIER' OR percent IS NOT NULL OR fixed_price)
          AND (layer <> 'LIST' OR (percent IS NULL AND cost_amount = list_amount))`,
    ),
    /** A table price is the tier's, has no percent, and took something off the list. */
    check(
      'order_reseller_terms_fixed_price_check',
      sql`NOT fixed_price OR (layer = 'TIER' AND percent IS NULL AND cost_amount < list_amount AND cost_amount > 0)`,
    ),
  ],
);

// --- Owner batch 1, PR-2: «درخواست نمایندگی» --------------------------------------------------

/**
 * The questions the owner asks an applicant, in order. Edited as a whole list from the Web
 * Admin; a question the list drops is made `active = false` rather than deleted, so the row
 * stays as the record of what was once asked. Changing a question NEVER changes a request
 * already filed: a request stores the questions as they were asked (`reseller_requests.answers`).
 */
export const resellerRequestQuestions = pgTable(
  'reseller_request_questions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    required: boolean('required').notNull(),
    maxLength: integer('max_length').notNull().default(RESELLER_REQUEST_ANSWER_DEFAULT_MAX),
    active: boolean('active').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('reseller_request_questions_tenant_id_key').on(table.tenantId, table.id),
    index('reseller_request_questions_order_idx').on(table.tenantId, table.position, table.id),
    check('reseller_request_questions_position_check', sql`position >= 0`),
    check(
      'reseller_request_questions_text_check',
      sql`length(btrim(text)) BETWEEN 1 AND ${sql.raw(String(RESELLER_REQUEST_QUESTION_TEXT_MAX))}`,
    ),
    check(
      'reseller_request_questions_max_length_check',
      sql`max_length BETWEEN 1 AND ${sql.raw(String(RESELLER_REQUEST_ANSWER_CEILING))}`,
    ),
  ],
);

/**
 * One customer's request to become a reseller.
 *
 * `answers` is the snapshot taken at submit: every question as it was asked (text, required,
 * bound) with the answer, so a later edit of the question list changes nothing here. The
 * status moves only by a conditional UPDATE from PENDING; `decided_at` is stamped exactly when
 * it does, and an APPROVED row names the tier and the administrator. A PENDING row keeps
 * its place in the conversation: the thread is open while the status is PENDING and closed
 * for replies the moment it is not.
 *
 * ONE PENDING REQUEST PER CUSTOMER is the partial unique index below, not a convention: two
 * taps, two bots or two replicas cannot file twice.
 */
export const resellerRequests = pgTable(
  'reseller_requests',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The number the customer and an operator quote. An identity: unique and increasing. */
    number: bigint('number', { mode: 'bigint' }).generatedAlwaysAsIdentity().notNull(),
    customerId: uuid('customer_id').notNull(),
    /** The bot the customer filed through; the conversation continues through it. */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    answers: jsonb('answers').notNull(),
    status: text('status').notNull().default('PENDING'),
    decidedByAdminId: uuid('decided_by_admin_id'),
    tierId: uuid('tier_id'),
    reason: text('reason'),
    /** The key of the submit, unique for ever: a redelivered update answers with this row. */
    openingKey: text('opening_key').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    decidedAt: timestamptz('decided_at'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    lastMessageAt: timestamptz('last_message_at'),
  },
  (table) => [
    unique('reseller_requests_tenant_id_key').on(table.tenantId, table.id),
    unique('reseller_requests_opening_key').on(table.tenantId, table.openingKey),
    uniqueIndex('reseller_requests_one_pending_key')
      .on(table.tenantId, table.customerId)
      .where(sql`status = 'PENDING'`),
    index('reseller_requests_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('reseller_requests_tenant_status_idx').on(table.tenantId, table.status, table.createdAt),
    /** The cooldown: a customer's latest decision. */
    index('reseller_requests_customer_decided_idx').on(
      table.tenantId,
      table.customerId,
      table.decidedAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'reseller_requests_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.decidedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'reseller_requests_decided_by_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.tierId],
      foreignColumns: [resellerTiers.tenantId, resellerTiers.id],
      name: 'reseller_requests_tier_fk',
    }),
    check('reseller_requests_status_check', enumCheck('status', RESELLER_REQUEST_STATUSES)),
    check('reseller_requests_decided_check', sql`(status = 'PENDING') = (decided_at IS NULL)`),
    check(
      'reseller_requests_approved_check',
      sql`status <> 'APPROVED' OR (tier_id IS NOT NULL AND decided_by_admin_id IS NOT NULL)`,
    ),
    check(
      'reseller_requests_tier_only_approved_check',
      sql`status = 'APPROVED' OR tier_id IS NULL`,
    ),
    check(
      'reseller_requests_reason_check',
      sql`reason IS NULL OR (status = 'REJECTED' AND length(reason) BETWEEN 1 AND ${sql.raw(String(RESELLER_REQUEST_REASON_MAX))})`,
    ),
    check('reseller_requests_answers_check', sql`jsonb_typeof(answers) = 'array'`),
    check('reseller_requests_opening_key_check', sql`length(opening_key) BETWEEN 1 AND 300`),
  ],
);

/**
 * One message in a request's conversation, from the applicant or from an operator.
 *
 * The ticket thread's shape without the ticket (see `reseller-requests.ts` for why a ticket
 * does not fit): append-only by convention, a sender, a body or a Telegram photo binding, the
 * command's idempotency key. An operator's message is delivered by a `RESELLER_REQUEST_MESSAGE`
 * row on the customer notification lane whose subject is THIS row.
 */
export const resellerRequestMessages = pgTable(
  'reseller_request_messages',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    requestId: uuid('request_id').notNull(),
    seq: bigint('seq', { mode: 'bigint' }).generatedAlwaysAsIdentity().notNull(),
    senderType: text('sender_type').notNull(),
    authorAdminId: uuid('author_admin_id'),
    body: text('body'),
    attachmentKind: text('attachment_kind'),
    attachmentBotInstanceId: uuid('attachment_bot_instance_id').references(() => botInstances.id),
    attachmentFileId: text('attachment_file_id'),
    attachmentFileUniqueId: text('attachment_file_unique_id'),
    attachmentMimeType: text('attachment_mime_type'),
    attachmentFileSize: bigint('attachment_file_size', { mode: 'bigint' }),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('reseller_request_messages_tenant_id_key').on(table.tenantId, table.id),
    unique('reseller_request_messages_key').on(table.tenantId, table.idempotencyKey),
    index('reseller_request_messages_request_idx').on(table.tenantId, table.requestId, table.seq),
    foreignKey({
      columns: [table.tenantId, table.requestId],
      foreignColumns: [resellerRequests.tenantId, resellerRequests.id],
      name: 'reseller_request_messages_request_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.authorAdminId],
      foreignColumns: [admins.tenantId, admins.id],
      name: 'reseller_request_messages_author_fk',
    }),
    check(
      'reseller_request_messages_sender_check',
      enumCheck('sender_type', RESELLER_REQUEST_MESSAGE_SENDERS),
    ),
    check(
      'reseller_request_messages_attachment_kind_check',
      nullableEnumCheck('attachment_kind', RESELLER_REQUEST_ATTACHMENT_KINDS),
    ),
    check(
      'reseller_request_messages_body_check',
      sql`body IS NULL OR length(body) BETWEEN 1 AND ${sql.raw(String(RESELLER_REQUEST_MESSAGE_MAX))}`,
    ),
    /** An attachment is all of its binding or none of it. */
    check(
      'reseller_request_messages_attachment_check',
      sql`(attachment_kind IS NULL) = (attachment_file_id IS NULL)
          AND (attachment_kind IS NULL) = (attachment_file_unique_id IS NULL)
          AND (attachment_kind IS NULL) = (attachment_bot_instance_id IS NULL)`,
    ),
    /** An operator writes text, signed; the applicant writes text or a photo. */
    check(
      'reseller_request_messages_shape_check',
      sql`CASE sender_type
            WHEN 'ADMIN' THEN author_admin_id IS NOT NULL AND body IS NOT NULL AND attachment_kind IS NULL
            WHEN 'CUSTOMER' THEN author_admin_id IS NULL AND (body IS NOT NULL OR attachment_kind IS NOT NULL)
            ELSE false
          END`,
    ),
    check('reseller_request_messages_key_check', sql`length(idempotency_key) BETWEEN 1 AND 300`),
  ],
);

/**
 * A customer's half-written application: the questions as they were when it began, the
 * answers so far and the question being asked. At most one per customer; filing the request
 * or starting over replaces it. It holds no decision, and the customer's `submit` re-reads
 * the questions it names, never the live list.
 */
export const resellerRequestDrafts = pgTable(
  'reseller_request_drafts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    /** The questions as they were asked: `{questionId, text, required, maxLength}[]`. */
    questions: jsonb('questions').notNull(),
    /** One entry per question, `null` while unanswered or skipped. */
    answers: jsonb('answers').notNull(),
    position: integer('position').notNull().default(0),
    /** The idempotency key of the step that last changed the draft: a redelivery replays. */
    lastStepKey: text('last_step_key'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('reseller_request_drafts_tenant_id_key').on(table.tenantId, table.id),
    unique('reseller_request_drafts_customer_key').on(table.tenantId, table.customerId),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'reseller_request_drafts_customer_fk',
    }),
    check('reseller_request_drafts_questions_check', sql`jsonb_typeof(questions) = 'array'`),
    check('reseller_request_drafts_answers_check', sql`jsonb_typeof(answers) = 'array'`),
    check('reseller_request_drafts_position_check', sql`position >= 0`),
  ],
);
