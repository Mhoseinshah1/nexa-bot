/**
 * Database schema — custom services: their locations, price rules and the terms an order took.
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  CURRENCY_CODES,
  CUSTOM_SERVICE_LABEL_MAX_LENGTH,
  CUSTOM_SERVICE_RULE_DIMENSIONS,
  CUSTOM_SERVICE_RULE_LEVELS,
} from '@nexa/contracts';
import { enumCheck, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';
import { panels } from './panels.js';
import { customers } from './customers.js';
import { orders } from './orders.js';
import { resellerTiers } from './resellers.js';

// --- Package D: the custom service (docs/package-d-custom-service-audit.md) -----------

/**
 * A panel offered for custom service, and the name a customer sees it by.
 *
 * An explicit opt-in: a panel's `name` is the operator's internal label, so it is never
 * shown to a customer, and a panel with no row here is not a custom-service location.
 * Whether the panel can take a new service right now is still `PanelSalesGate`'s answer.
 */
export const customServiceLocations = pgTable(
  'custom_service_locations',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    panelId: uuid('panel_id').notNull(),
    label: text('label').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.panelId], name: 'custom_service_locations_pk' }),
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'custom_service_locations_panel_fk',
    }),
    check(
      'custom_service_locations_label_check',
      sql`length(btrim(label)) BETWEEN 1 AND ${sql.raw(String(CUSTOM_SERVICE_LABEL_MAX_LENGTH))}`,
    ),
  ],
);

/**
 * One custom-service price rule (brief D2).
 *
 * `min_units`/`max_units` are inclusive, in the dimension's unit: hundredths of a GB for
 * VOLUME, days for TIME. The price is per GB or per day. Specificity is the triple
 * (customer, tier, panel): a customer rule names no tier; a rule with neither is the
 * ordinary customers'; a null panel is every panel.
 *
 * Overlap between enabled rules of one dimension at one specificity is refused by the
 * service under a per-tenant advisory lock, not here: an exclusion constraint would need
 * `btree_gist`, which this schema has never required.
 */
export const customServicePriceRules = pgTable(
  'custom_service_price_rules',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    dimension: text('dimension').notNull(),
    label: text('label'),
    minUnits: bigint('min_units', { mode: 'bigint' }).notNull(),
    maxUnits: bigint('max_units', { mode: 'bigint' }).notNull(),
    unitPriceAmount: bigint('unit_price_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    customerId: uuid('customer_id'),
    resellerTierId: uuid('reseller_tier_id'),
    panelId: uuid('panel_id'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('custom_service_price_rules_tenant_id_key').on(table.tenantId, table.id),
    index('custom_service_price_rules_tenant_dimension_idx').on(
      table.tenantId,
      table.dimension,
      table.enabled,
    ),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'custom_service_price_rules_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.resellerTierId],
      foreignColumns: [resellerTiers.tenantId, resellerTiers.id],
      name: 'custom_service_price_rules_tier_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'custom_service_price_rules_panel_fk',
    }),
    check(
      'custom_service_price_rules_dimension_check',
      enumCheck('dimension', CUSTOM_SERVICE_RULE_DIMENSIONS),
    ),
    check('custom_service_price_rules_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('custom_service_price_rules_range_check', sql`min_units >= 1 AND max_units >= min_units`),
    check('custom_service_price_rules_price_check', sql`unit_price_amount > 0`),
    check(
      'custom_service_price_rules_specificity_check',
      sql`customer_id IS NULL OR reseller_tier_id IS NULL`,
    ),
    check(
      'custom_service_price_rules_label_check',
      sql`label IS NULL OR length(btrim(label)) BETWEEN 1 AND ${sql.raw(String(CUSTOM_SERVICE_LABEL_MAX_LENGTH))}`,
    ),
  ],
);

export const orderCustomServiceTerms = pgTable(
  'order_custom_service_terms',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    panelId: uuid('panel_id').notNull(),
    locationLabel: text('location_label').notNull(),
    volumeUnits: bigint('volume_units', { mode: 'bigint' }).notNull(),
    trafficBytes: bigint('traffic_bytes', { mode: 'bigint' }).notNull(),
    durationDays: integer('duration_days').notNull(),
    volumeRuleId: uuid('volume_rule_id').notNull(),
    volumeRuleLevel: text('volume_rule_level').notNull(),
    pricePerGbAmount: bigint('price_per_gb_amount', { mode: 'bigint' }).notNull(),
    volumeAmount: bigint('volume_amount', { mode: 'bigint' }).notNull(),
    timeRuleId: uuid('time_rule_id').notNull(),
    timeRuleLevel: text('time_rule_level').notNull(),
    pricePerDayAmount: bigint('price_per_day_amount', { mode: 'bigint' }).notNull(),
    timeAmount: bigint('time_amount', { mode: 'bigint' }).notNull(),
    baseAmount: bigint('base_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.orderId], name: 'order_custom_service_terms_pk' }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'order_custom_service_terms_order_fk',
    }),
    check('order_custom_service_terms_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check(
      'order_custom_service_terms_volume_level_check',
      enumCheck('volume_rule_level', CUSTOM_SERVICE_RULE_LEVELS),
    ),
    check(
      'order_custom_service_terms_time_level_check',
      enumCheck('time_rule_level', CUSTOM_SERVICE_RULE_LEVELS),
    ),
    check(
      'order_custom_service_terms_positive_check',
      sql`volume_units > 0 AND traffic_bytes > 0 AND duration_days > 0
          AND price_per_gb_amount > 0 AND price_per_day_amount > 0`,
    ),
    /** The arithmetic, as the brief states it: half-up to the minor unit, then a sum. */
    check(
      'order_custom_service_terms_volume_amount_check',
      sql`volume_amount = (volume_units * price_per_gb_amount + 50) / 100`,
    ),
    check(
      'order_custom_service_terms_time_amount_check',
      sql`time_amount = duration_days * price_per_day_amount`,
    ),
    check(
      'order_custom_service_terms_base_amount_check',
      sql`base_amount = volume_amount + time_amount`,
    ),
  ],
);
