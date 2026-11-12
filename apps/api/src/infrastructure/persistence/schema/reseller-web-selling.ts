/**
 * Database schema — the reseller web panel's selling half (PR-5 §5.5–§5.8): the clients book,
 * the purchase batches that group the orders of one «خرید», the daily reports the reseller's
 * notification preferences ask for, and the tier targets the progress card shows.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 *
 * Every table belongs to a tenant (row-level security confines it like every other) and names
 * the reseller through the composite `(tenant_id, customer_id)` key. None of them holds money
 * that decides anything: a batch only GROUPS orders the checkout made and charged; a client is
 * a label; a tier target is a figure to display.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
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
import {
  CURRENCY_CODES,
  RESELLER_DAILY_REPORT_KINDS,
  RESELLER_TIER_TARGET_KINDS,
  RESELLER_USERNAME_MODES,
} from '@nexa/contracts';
import { enumCheck, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';
import { customers } from './customers.js';
import { orders } from './orders.js';
import { services } from './services.js';
import { resellerTiers } from './resellers.js';

/**
 * «مشتری‌ها»: one client in ONE reseller's clients book. Never hard-deleted — archived. Every
 * read is filtered by the owning reseller (`customer_id`), in the application and here by the
 * composite key the assignments point at.
 */
export const resellerClients = pgTable(
  'reseller_clients',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The reseller's customer id: the book's owner. */
    customerId: uuid('customer_id').notNull(),
    name: text('name').notNull(),
    contact: text('contact'),
    note: text('note'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
    archivedAt: timestamptz('archived_at'),
  },
  (table) => [
    unique('reseller_clients_tenant_id_owner_key').on(table.tenantId, table.id, table.customerId),
    index('reseller_clients_owner_idx').on(table.tenantId, table.customerId, table.createdAt),
    foreignKey({
      name: 'reseller_clients_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    check(
      'reseller_clients_text_check',
      sql`char_length(name) BETWEEN 1 AND 80
          AND (contact IS NULL OR char_length(contact) <= 80)
          AND (note IS NULL OR char_length(note) <= 500)`,
    ),
  ],
);

/**
 * A service in a client's list. The service is the key: one client at most. The owner is
 * carried and bound to the CLIENT's owner by the composite foreign key, so an assignment can
 * never put a service under another reseller's client. Whether the service is still the
 * reseller's own (a transfer moves it) is the read's join, never assumed.
 */
export const resellerClientServices = pgTable(
  'reseller_client_services',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    serviceId: uuid('service_id').notNull(),
    clientId: uuid('client_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    assignedAt: timestamptz('assigned_at').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'reseller_client_services_pkey',
      columns: [table.tenantId, table.serviceId],
    }),
    index('reseller_client_services_client_idx').on(table.tenantId, table.clientId),
    foreignKey({
      name: 'reseller_client_services_client_fk',
      columns: [table.tenantId, table.clientId, table.customerId],
      foreignColumns: [resellerClients.tenantId, resellerClients.id, resellerClients.customerId],
    }),
    foreignKey({
      name: 'reseller_client_services_service_fk',
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }),
  ],
);

/**
 * One «خرید» of N services: what was asked (the plan or the custom terms, the quantity, the
 * username mode, the client and the note). It GROUPS the N orders for the result screen and
 * never decides money: each order was priced, confirmed and paid by the ordinary checkout under
 * its own key `(batch key, index)`. `confirmed_at` records that the batch's wallet pre-check
 * passed (under the wallet lock) — a replay does not pre-check again.
 */
export const resellerPurchaseBatches = pgTable(
  'reseller_purchase_batches',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** The browser's key, namespaced to tenant, reseller and operation. */
    idempotencyKey: text('idempotency_key').notNull(),
    productId: uuid('product_id'),
    customPanelId: uuid('custom_panel_id'),
    customVolumeUnits: bigint('custom_volume_units', { mode: 'bigint' }),
    customDays: integer('custom_days'),
    title: text('title').notNull(),
    quantity: integer('quantity').notNull(),
    usernameMode: text('username_mode').notNull(),
    customUsername: text('custom_username'),
    clientId: uuid('client_id'),
    note: text('note'),
    createdAt: timestamptz('created_at').notNull(),
    confirmedAt: timestamptz('confirmed_at'),
  },
  (table) => [
    uniqueIndex('reseller_purchase_batches_key').on(
      table.tenantId,
      table.customerId,
      table.idempotencyKey,
    ),
    unique('reseller_purchase_batches_tenant_id_key').on(table.tenantId, table.id),
    index('reseller_purchase_batches_owner_idx').on(
      table.tenantId,
      table.customerId,
      table.createdAt,
    ),
    foreignKey({
      name: 'reseller_purchase_batches_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    check(
      'reseller_purchase_batches_quantity_check',
      sql`quantity BETWEEN 1 AND 50 AND (custom_username IS NULL OR quantity = 1)`,
    ),
    check(
      'reseller_purchase_batches_mode_check',
      enumCheck('username_mode', RESELLER_USERNAME_MODES),
    ),
    check(
      'reseller_purchase_batches_plan_check',
      sql`(product_id IS NOT NULL AND custom_panel_id IS NULL AND custom_volume_units IS NULL
           AND custom_days IS NULL)
          OR (product_id IS NULL AND custom_panel_id IS NOT NULL
              AND custom_volume_units IS NOT NULL AND custom_days IS NOT NULL)`,
    ),
    check(
      'reseller_purchase_batches_text_check',
      sql`(note IS NULL OR char_length(note) <= 500) AND char_length(title) <= 200`,
    ),
  ],
);

/** The orders of a batch, by index. Each order belongs to the batch's reseller. */
export const resellerPurchaseBatchOrders = pgTable(
  'reseller_purchase_batch_orders',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    batchId: uuid('batch_id').notNull(),
    position: integer('position').notNull(),
    orderId: uuid('order_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    /** When the batch's client and note were put on the order's service (once it existed). */
    appliedAt: timestamptz('applied_at'),
  },
  (table) => [
    primaryKey({
      name: 'reseller_purchase_batch_orders_pkey',
      columns: [table.tenantId, table.batchId, table.position],
    }),
    uniqueIndex('reseller_purchase_batch_orders_order_key').on(table.tenantId, table.orderId),
    foreignKey({
      name: 'reseller_purchase_batch_orders_batch_fk',
      columns: [table.tenantId, table.batchId],
      foreignColumns: [resellerPurchaseBatches.tenantId, resellerPurchaseBatches.id],
    }),
    foreignKey({
      name: 'reseller_purchase_batch_orders_order_fk',
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
    }),
    check('reseller_purchase_batch_orders_position_check', sql`position BETWEEN 0 AND 49`),
  ],
);

/**
 * The reseller's daily reports (their notification preferences): one row per reseller, kind
 * and tenant-local day — the unique key IS the "once a day" rule. `facts` is the frozen
 * snapshot the notice renders (the list of expiring services, or the day's count and sum).
 */
export const resellerWebDailyReports = pgTable(
  'reseller_web_daily_reports',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    kind: text('kind').notNull(),
    /** The tenant-local calendar day the report belongs to. */
    day: date('day', { mode: 'string' }).notNull(),
    facts: jsonb('facts').notNull(),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('reseller_web_daily_reports_day_key').on(
      table.tenantId,
      table.customerId,
      table.kind,
      table.day,
    ),
    foreignKey({
      name: 'reseller_web_daily_reports_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    check('reseller_web_daily_reports_kind_check', enumCheck('kind', RESELLER_DAILY_REPORT_KINDS)),
  ],
);

/**
 * «هدف سطح بعد»: the monthly target a tier's progress card shows — a count of services or an
 * amount (bigint minor units + currency). Display only; no tier ever changes because of it.
 */
export const resellerTierTargets = pgTable(
  'reseller_tier_targets',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    tierId: uuid('tier_id').notNull(),
    kind: text('kind').notNull(),
    targetCount: integer('target_count'),
    targetAmountMinor: bigint('target_amount_minor', { mode: 'bigint' }),
    targetCurrency: text('target_currency'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ name: 'reseller_tier_targets_pkey', columns: [table.tenantId, table.tierId] }),
    foreignKey({
      name: 'reseller_tier_targets_tier_fk',
      columns: [table.tenantId, table.tierId],
      foreignColumns: [resellerTiers.tenantId, resellerTiers.id],
    }).onDelete('cascade'),
    check('reseller_tier_targets_kind_check', enumCheck('kind', RESELLER_TIER_TARGET_KINDS)),
    check(
      'reseller_tier_targets_shape_check',
      sql`(kind = 'COUNT' AND target_count IS NOT NULL AND target_count > 0
           AND target_amount_minor IS NULL AND target_currency IS NULL)
          OR (kind = 'AMOUNT' AND target_count IS NULL AND target_amount_minor IS NOT NULL
              AND target_amount_minor > 0 AND target_currency IS NOT NULL
              AND ${enumCheck('target_currency', CURRENCY_CODES)})`,
    ),
  ],
);
