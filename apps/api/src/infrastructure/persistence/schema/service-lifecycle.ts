/**
 * Database schema — service lifecycle: service and account transfers, location changes, auto-renew and auto-delete, trials.
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
  ACTOR_TYPES,
  AUTO_RENEW_PREFERENCE_SOURCES,
  AUTO_RENEW_REFUSALS,
  AUTO_RENEW_RUN_STATES,
  AUTO_DELETE_CAUSES,
  AUTO_DELETE_RUN_STATES,
  AUTO_DELETE_SERVICE_STATES,
  CURRENCY_CODES,
  TRIAL_LIMIT_MAX,
  TRIAL_LIMIT_MIN,
} from '@nexa/contracts';
import { enumCheck, timestamptz } from './_shared.js';
import { botInstances, tenants } from './tenancy.js';
import { admins } from './identity.js';
import { panels } from './panels.js';
import { products } from './catalogue.js';
import { customers } from './customers.js';
import { orders } from './orders.js';
import { walletEntries } from './wallet.js';
import { serviceLocations, services } from './services.js';
import { provisioningOperations } from './provisioning.js';

/**
 * A global trial reset, as it ran (ADR-0010 step 5, `docs/wp6-audit.md` B3).
 *
 * The recorded result of the one bulk operation trials have: who, why, when, and how
 * many grants and customers it covered. Every grant it stamped carries its id in
 * `trial_grants.reset_id`, so "which trials did this reset" is answered by the rows
 * themselves rather than by a timestamp comparison that a clock skew could disagree
 * with. Nothing updates or deletes a row here; a reset is history.
 */
export const trialResets = pgTable(
  'trial_resets',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    actorAdminId: uuid('actor_admin_id').notNull(),
    reason: text('reason').notNull(),
    affectedGrants: integer('affected_grants').notNull(),
    affectedCustomers: integer('affected_customers').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    /** The target of `trial_grants.reset_id`'s tenant-bearing foreign key. */
    uniqueIndex('trial_resets_tenant_id_key').on(table.tenantId, table.id),
    index('trial_resets_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    foreignKey({
      name: 'trial_resets_actor_fk',
      columns: [table.tenantId, table.actorAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    /** A reset that covered nothing is refused (`TRIAL_RESET_NOTHING`), never recorded. */
    check(
      'trial_resets_counts_check',
      sql`affected_grants > 0 AND affected_customers > 0 AND affected_customers <= affected_grants`,
    ),
    check('trial_resets_reason_check', sql`length(btrim(reason)) > 0`),
  ],
);

/**
 * A customer's persistent custom trial limit (ADR-0015, `docs/wp6-audit.md` B2).
 *
 * A row per customer, or no row. No row means the customer inherits
 * `trial.limit_per_customer`; removing an override DELETES the row rather than copying
 * the default into it, so a later change to the default applies to them again. `0` is a
 * legal limit and means no trials, never unlimited.
 */
export const trialLimitOverrides = pgTable(
  'trial_limit_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    trialLimit: integer('trial_limit').notNull(),
    setAt: timestamptz('set_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'trial_limit_overrides_pkey', columns: [table.tenantId, table.customerId] }),
    foreignKey({
      name: 'trial_limit_overrides_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    index('trial_limit_overrides_tenant_set_idx').on(table.tenantId, table.setAt, table.customerId),
    check(
      'trial_limit_overrides_limit_check',
      sql`trial_limit >= ${sql.raw(String(TRIAL_LIMIT_MIN))} AND trial_limit <= ${sql.raw(String(TRIAL_LIMIT_MAX))}`,
    ),
  ],
);

/**
 * A trial grant: one row per trial ORDER, and the record that a customer used one.
 *
 * ADR-0015 makes a trial allowance a LIMIT and a USED count, stored separately. This
 * table is the used count: a customer's used is the number of their rows with
 * `released_at` NULL, and the limit is `trial.limit_per_customer`. The count is taken
 * under the customer's row lock (`TrialService.claim`), because a count is a read
 * followed by a write and two concurrent claims would otherwise both read zero.
 *
 * Until WP6-A this table was one row per customer, ever — `trial_grants_customer_key`
 * — with a docblock saying a failed provisioning must still consume the grant. Both
 * were overridden: ADR-0015 is accepted policy and allows a limit above one, and plan
 * §7.1 requires that a provider create which definitively FAILED does not consume
 * eligibility. `released_at` is that: stamped in the same transaction that gives the
 * trial order back (`UndeliverableOrderRefunder`), and never for an UNKNOWN outcome,
 * which keeps the grant — the account may exist. `docs/wp6-audit.md` A3, A4.
 *
 * Nothing wrote this table before this migration, so the NOT NULL `order_id` it adds
 * met no rows.
 */
export const trialGrants = pgTable(
  'trial_grants',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** The trial order. Its line is the snapshot of what the trial was. */
    orderId: uuid('order_id').notNull(),
    /**
     * The product configured as the trial when the grant was made. Navigation only, and
     * NULL for every grant since R1: a trial is issued from a panel's trial configuration,
     * and the panel is on the order.
     */
    productId: uuid('product_id'),
    /** The service the grant produced. Set in the granting transaction. */
    serviceId: uuid('service_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /**
     * When the grant was given back because its service definitively could not be
     * created. NULL means it counts against the customer's limit.
     */
    releasedAt: timestamptz('released_at'),
    /**
     * When a global reset stopped this grant counting, and which one. Both or neither
     * (`trial_grants_reset_pair_check`). Independent of `released_at`: a grant carrying
     * either stamp does not count, so a reset and a release of the same grant can land
     * in either order and it counts zero times, never minus one.
     */
    resetAt: timestamptz('reset_at'),
    resetId: uuid('reset_id'),
    /**
     * PR-5 §5.7: a reseller's «سرویس تست» from the web panel. Counted against the reseller's
     * daily quota (`reseller.trial_daily_quota`), never against their own trial allowance.
     */
    resellerTrial: boolean('reseller_trial').notNull().default(false),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'trial_grants_customer_fk',
    }),
    /**
     * CUSTOMER-bearing, like every other child of `orders`: a grant cannot name one
     * customer's order while counting against another customer.
     */
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'trial_grants_order_fk',
    }),
    /** One grant per trial order: a replayed claim cannot count twice. */
    uniqueIndex('trial_grants_order_key').on(table.tenantId, table.orderId),
    /**
     * The limit check's only query, and the reset's: grants that still count. Replaces
     * `trial_grants_customer_counting_idx`, whose predicate did not know about resets.
     */
    index('trial_grants_counting_idx')
      .on(table.tenantId, table.customerId)
      .where(sql`released_at IS NULL AND reset_at IS NULL`),
    foreignKey({
      columns: [table.tenantId, table.resetId],
      foreignColumns: [trialResets.tenantId, trialResets.id],
      name: 'trial_grants_reset_fk',
    }),
    check('trial_grants_reset_pair_check', sql`(reset_at IS NULL) = (reset_id IS NULL)`),
    index('trial_grants_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    /**
     * Round N: "has this customer ever had a trial", whatever became of it — the audience's
     * trial criterion. `trial_grants_counting_idx` covers only the grants that still count.
     */
    index('trial_grants_customer_idx').on(table.tenantId, table.customerId),
  ],
);

/**
 * Package F — one row per change of a service's owner (`docs/package-f-service-transfer-audit.md`).
 *
 * Append-only: `nexa_reject_mutation` refuses an UPDATE or a DELETE, like the audit log.
 * It is the evidence `services.customer_id` moved legitimately, and more than evidence:
 * `nexa_services_ownership_guard` refuses a change of that column unless the NEWEST row
 * here for the service names exactly the old owner and the new one. So no writer — a
 * refactor, a script, an operator's SQL — can hand a service over without leaving this
 * row, in the same transaction.
 *
 * Nothing financial is here, deliberately. The order, its payment and every ledger entry
 * stay the payer's; this records only who owned the service before and after.
 */
export const serviceOwnershipTransfers = pgTable(
  'service_ownership_transfers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * The order the rows were written in, per service. "Newest" is decided by this and not
     * by `created_at`: two transfers of one service a clock tick apart — or on two replicas
     * whose clocks disagree — must still have one newest row, and the row lock that
     * serialises them makes this sequence their commit order.
     */
    seq: bigint('seq', { mode: 'bigint' }).generatedAlwaysAsIdentity().notNull(),
    serviceId: uuid('service_id').notNull(),
    fromCustomerId: uuid('from_customer_id').notNull(),
    toCustomerId: uuid('to_customer_id').notNull(),
    /**
     * The bot the sender confirmed through. NULL only for a move no customer confirmed — a
     * Web Admin operator's account transfer (Customer 360), which happens on no bot. Every
     * other actor's transfer names one (`service_ownership_transfers_bot_check`).
     */
    botInstanceId: uuid('bot_instance_id').references(() => botInstances.id),
    /**
     * The confirmation's idempotency key — the Telegram update that carried the tap. Unique
     * for ever, so a redelivered update answers with this row and never transfers again.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    /** Who asked, as the audit row records it: captured at action time. */
    actorType: text('actor_type').notNull(),
    actorLabel: text('actor_label'),
    correlationId: text('correlation_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('service_ownership_transfers_tenant_id_key').on(table.tenantId, table.id),
    unique('service_ownership_transfers_key').on(table.tenantId, table.idempotencyKey),
    /** The newest transfer of a service: the ownership guard's read, and the replay's. */
    index('service_ownership_transfers_service_idx').on(table.tenantId, table.serviceId, table.seq),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_ownership_transfers_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.fromCustomerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'service_ownership_transfers_from_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.toCustomerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'service_ownership_transfers_to_fk',
    }),
    /** A service is never "transferred" to the customer who already has it. */
    check('service_ownership_transfers_parties_check', sql`from_customer_id <> to_customer_id`),
    check('service_ownership_transfers_actor_type_check', enumCheck('actor_type', ACTOR_TYPES)),
    check('service_ownership_transfers_key_check', sql`length(idempotency_key) BETWEEN 1 AND 200`),
    check(
      'service_ownership_transfers_bot_check',
      sql`bot_instance_id IS NOT NULL OR actor_type = 'WEB_ADMIN'`,
    ),
  ],
);

/**
 * One operator account transfer (Customer 360, §11.5, `docs/customer-account-transfer-audit.md`).
 *
 * Append-only (`nexa_reject_mutation`), written in the transaction that moves the services
 * and the balance. It is the record a replay answers from — `(tenant_id, idempotency_key)`
 * is unique for ever — and the evidence of what moved: the service ids, the amount, and the
 * two wallet entries. Each moved service ALSO has its own `service_ownership_transfers` row,
 * because that row is what `nexa_services_ownership_guard` admits a change of owner on.
 */
export const customerAccountTransfers = pgTable(
  'customer_account_transfers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    fromCustomerId: uuid('from_customer_id').notNull(),
    toCustomerId: uuid('to_customer_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** The ids of the services that changed hands, in the order they were moved. */
    serviceIds: jsonb('service_ids').notNull(),
    walletAmount: bigint('wallet_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The DEBIT of the source and the CREDIT of the destination; NULL when nothing moved. */
    debitEntryId: uuid('debit_entry_id'),
    creditEntryId: uuid('credit_entry_id'),
    fingerprint: text('fingerprint').notNull(),
    reason: text('reason').notNull(),
    actorAdminId: uuid('actor_admin_id').references(() => admins.id),
    correlationId: text('correlation_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('customer_account_transfers_key').on(table.tenantId, table.idempotencyKey),
    index('customer_account_transfers_from_idx').on(
      table.tenantId,
      table.fromCustomerId,
      table.createdAt,
    ),
    index('customer_account_transfers_to_idx').on(
      table.tenantId,
      table.toCustomerId,
      table.createdAt,
    ),
    foreignKey({
      name: 'customer_account_transfers_from_fk',
      columns: [table.tenantId, table.fromCustomerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'customer_account_transfers_to_fk',
      columns: [table.tenantId, table.toCustomerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'customer_account_transfers_debit_fk',
      columns: [table.tenantId, table.debitEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
    }),
    foreignKey({
      name: 'customer_account_transfers_credit_fk',
      columns: [table.tenantId, table.creditEntryId],
      foreignColumns: [walletEntries.tenantId, walletEntries.id],
    }),
    check('customer_account_transfers_parties_check', sql`from_customer_id <> to_customer_id`),
    check('customer_account_transfers_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('customer_account_transfers_amount_check', sql`wallet_amount >= 0`),
    check(
      'customer_account_transfers_entries_check',
      sql`(wallet_amount = 0) = (debit_entry_id IS NULL) AND (debit_entry_id IS NULL) = (credit_entry_id IS NULL)`,
    ),
    check('customer_account_transfers_key_check', sql`length(idempotency_key) BETWEEN 1 AND 255`),
    check('customer_account_transfers_reason_check', sql`length(reason) BETWEEN 1 AND 500`),
  ],
);

// --- WP-A6: service location change ----------------------------------------------------

/**
 * One requested location change of one service (WP-A6): the snapshot of what was quoted,
 * written once and never edited.
 *
 * It is the history the brief's audit needs and the evidence every later decision reads:
 * where the service was (key and name), where it was going (key and name), which
 * configured target and VERSION priced it, the list price — zero for free — and either
 * the ORDER that paid for it or, for a free change, the OPERATION that carries it out.
 * Its outcome is not stored: it is the operation's state, and for a paid change the
 * order's, read at the time — so there is no second answer to "did it happen".
 *
 * The cooldown and the rolling limit count these rows at decision time, never a counter:
 * a row counts while its order is awaiting payment or paid, or — free — while its
 * operation has not failed.
 */
export const serviceLocationChanges = pgTable(
  'service_location_changes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    serviceId: uuid('service_id').notNull(),
    /** The owner who asked, when they asked. */
    customerId: uuid('customer_id').notNull(),
    locationId: uuid('location_id').notNull(),
    locationVersion: integer('location_version').notNull(),
    /** Where it was: its recorded location, or its panel's initial one. Always known. */
    fromLocationKey: text('from_location_key').notNull(),
    fromLocationLabel: text('from_location_label').notNull(),
    toLocationKey: text('to_location_key').notNull(),
    toLocationLabel: text('to_location_label').notNull(),
    /** The configured list price at quote time. The CHARGED total is the order's. */
    priceAmount: bigint('price_amount', { mode: 'bigint' }).notNull(),
    priceCurrency: text('price_currency').notNull(),
    /**
     * The cooldown and rolling limit the change was quoted under, frozen with it (Codex
     * review #1 on PR #101): a paid move's confirmation decides its window against THESE,
     * never against terms an operator wrote after the customer was shown the quote.
     */
    cooldownHours: integer('cooldown_hours'),
    maxChanges: integer('max_changes'),
    periodDays: integer('period_days'),
    /** A paid change's order. Exactly one of this and `operation_id` is set. */
    orderId: uuid('order_id'),
    /** A free change's operation, planned in the same transaction as this row. */
    operationId: uuid('operation_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('service_location_changes_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('service_location_changes_order_key').on(table.tenantId, table.orderId),
    uniqueIndex('service_location_changes_operation_key').on(table.tenantId, table.operationId),
    /** The cooldown and limit read: one service's changes, newest first. */
    index('service_location_changes_service_idx').on(
      table.tenantId,
      table.serviceId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_location_changes_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'service_location_changes_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.locationId],
      foreignColumns: [serviceLocations.tenantId, serviceLocations.id],
      name: 'service_location_changes_location_fk',
    }),
    /** With the order's customer too, so the money and the move cannot name two people. */
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'service_location_changes_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.operationId],
      foreignColumns: [provisioningOperations.tenantId, provisioningOperations.id],
      name: 'service_location_changes_operation_fk',
    }),
    check(
      'service_location_changes_source_check',
      sql`(order_id IS NULL) <> (operation_id IS NULL)`,
    ),
    /** Free is exactly "no order": a paid change has one, and nothing free is ever paid. */
    check(
      'service_location_changes_price_check',
      sql`price_amount >= 0 AND (price_amount = 0) = (order_id IS NULL)`,
    ),
    check('service_location_changes_currency_check', enumCheck('price_currency', CURRENCY_CODES)),
    check('service_location_changes_moves_check', sql`from_location_key <> to_location_key`),
    check('service_location_changes_version_check', sql`location_version >= 1`),
    check(
      'service_location_changes_limits_check',
      sql`(cooldown_hours IS NULL OR cooldown_hours >= 1)
          AND (max_changes IS NULL) = (period_days IS NULL)
          AND (max_changes IS NULL OR (max_changes >= 1 AND period_days >= 1))`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Round 10, D1 — automatic renewal (تمدید خودکار)
// ---------------------------------------------------------------------------

/**
 * A customer's consent to renew ONE of their services automatically.
 *
 * One row per service. `customer_id` is the customer who GAVE the consent, and every run asks
 * that it still equals `services.customer_id`: a service that changed hands is never renewed
 * on the strength of somebody else's consent. A transfer also switches it off in the very
 * statement's transaction that reassigns the service (`DrizzleServiceTransferRepository.
 * reassign`), so a service handed back does not silently revive an old consent either.
 *
 * `consented_total_minor` / `consented_currency` are the renewal total the customer was shown
 * when they switched it on: a later quote above it is not renewed (`PRICE_ROSE`). Both are
 * present exactly while it is enabled — the CHECK below — so "on, for how much" is never
 * half-answered. Not a balance and not a ledger figure: a ceiling the customer agreed to.
 */
export const serviceAutoRenewPreferences = pgTable(
  'service_auto_renew_preferences',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    serviceId: uuid('service_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    enabled: boolean('enabled').notNull(),
    consentedTotalMinor: bigint('consented_total_minor', { mode: 'bigint' }),
    consentedCurrency: text('consented_currency'),
    /**
     * PR-5 (OQ-R10-D1-01, owner decision): an IMPORTED service's plan to renew into, chosen by
     * a reseller at opt-in from the plans their entitlement allows. Null for a native service
     * (it renews its own product) and whenever the switch is off.
     */
    renewProductId: uuid('renew_product_id'),
    /** One of `AUTO_RENEW_PREFERENCE_SOURCES`: where it last changed. */
    source: text('source').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'service_auto_renew_preferences_pkey',
      columns: [table.tenantId, table.serviceId],
    }),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_auto_renew_preferences_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'service_auto_renew_preferences_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.renewProductId],
      foreignColumns: [products.tenantId, products.id],
      name: 'service_auto_renew_preferences_product_fk',
    }),
    check('service_auto_renew_preferences_plan_check', sql`renew_product_id IS NULL OR enabled`),
    /** The sweep reads the enabled consents of one tenant. */
    index('service_auto_renew_preferences_enabled_idx')
      .on(table.tenantId, table.serviceId)
      .where(sql`enabled`),
    check(
      'service_auto_renew_preferences_source_check',
      enumCheck('source', AUTO_RENEW_PREFERENCE_SOURCES),
    ),
    check(
      'service_auto_renew_preferences_currency_check',
      enumCheck('consented_currency', CURRENCY_CODES),
    ),
    check(
      'service_auto_renew_preferences_consent_check',
      sql`(enabled AND consented_total_minor IS NOT NULL AND consented_currency IS NOT NULL
            AND consented_total_minor >= 0)
          OR (NOT enabled AND consented_total_minor IS NULL AND consented_currency IS NULL)`,
    ),
  ],
);

/**
 * One automatic-renewal PERIOD of one service: "this deadline was (or was not) renewed
 * automatically, and why".
 *
 * UNIQUE on (tenant, service, `basis_expires_at`) — the deadline the run was claimed against —
 * and that is the exactly-once rule: two worker replicas, or a pass that overran, both reach
 * the same due service and only one INSERT claims it. Every idempotency key the renewal's own
 * commands take is derived from this row's id and `attempt`, and the wallet debit's reference
 * is unique on that key. A pass that takes over a lapsed claim (or re-tries a short wallet)
 * does so as the NEXT attempt: the earlier attempt debited nothing, because a debit commits
 * only together with `RENEWED`.
 *
 * `RENEWED` is written INSIDE the settling transaction (the wallet settlement's `inTransaction`
 * hook, with `order_id`), so the debit and this state commit together or not at all — a
 * renewed period that debited nothing, or a debit with the run still `CLAIMED`, cannot exist.
 *
 * The snapshot columns (`service_label`, the consented and quoted totals) are what the two
 * customer notices render at send time (ADR 0030 §1), and `notified_at` is what makes a period
 * produce at most ONE notice of either kind.
 */
export const serviceAutoRenewRuns = pgTable(
  'service_auto_renew_runs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    serviceId: uuid('service_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    /** The deadline this run renews: the period. Copied in SQL from `services.expires_at`. */
    basisExpiresAt: timestamptz('basis_expires_at').notNull(),
    /** Starts at 1; a period found short and later re-tried is attempt 2, 3, … */
    attempt: integer('attempt').notNull(),
    /** One of `AUTO_RENEW_RUN_STATES`. */
    state: text('state').notNull(),
    /** One of `AUTO_RENEW_REFUSALS`; present exactly when `state` is `REFUSED`. */
    refusal: text('refusal'),
    /** The account name on the panel when the run was claimed: what a notice names. */
    serviceLabel: text('service_label').notNull(),
    consentedTotalMinor: bigint('consented_total_minor', { mode: 'bigint' }).notNull(),
    consentedCurrency: text('consented_currency').notNull(),
    /** The renewal total quoted by this attempt, once quoted. */
    quotedTotalMinor: bigint('quoted_total_minor', { mode: 'bigint' }),
    quotedCurrency: text('quoted_currency'),
    /** The renewal order this period paid, when `RENEWED`. */
    orderId: uuid('order_id'),
    /** When the one notice of this period was raised; null while none was. */
    notifiedAt: timestamptz('notified_at'),
    /** A `CLAIMED` run whose lease lapsed is taken over by a later pass. */
    leaseUntil: timestamptz('lease_until'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    unique('service_auto_renew_runs_period_key').on(
      table.tenantId,
      table.serviceId,
      table.basisExpiresAt,
    ),
    /** One period per order: an order renews at most one period. */
    uniqueIndex('service_auto_renew_runs_order_key')
      .on(table.tenantId, table.orderId)
      .where(sql`order_id IS NOT NULL`),
    index('service_auto_renew_runs_state_idx').on(table.tenantId, table.state, table.leaseUntil),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_auto_renew_runs_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'service_auto_renew_runs_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'service_auto_renew_runs_order_fk',
    }),
    check('service_auto_renew_runs_state_check', enumCheck('state', AUTO_RENEW_RUN_STATES)),
    check('service_auto_renew_runs_refusal_check', enumCheck('refusal', AUTO_RENEW_REFUSALS)),
    check(
      'service_auto_renew_runs_refusal_state_check',
      sql`(state = 'REFUSED') = (refusal IS NOT NULL)`,
    ),
    check(
      'service_auto_renew_runs_renewed_check',
      sql`(state = 'RENEWED') = (order_id IS NOT NULL)`,
    ),
    check('service_auto_renew_runs_attempt_check', sql`attempt >= 1`),
    check(
      'service_auto_renew_runs_consented_currency_check',
      enumCheck('consented_currency', CURRENCY_CODES),
    ),
    check(
      'service_auto_renew_runs_quoted_currency_check',
      enumCheck('quoted_currency', CURRENCY_CODES),
    ),
    check(
      'service_auto_renew_runs_quote_check',
      sql`(quoted_total_minor IS NULL) = (quoted_currency IS NULL)
          AND consented_total_minor >= 0
          AND (quoted_total_minor IS NULL OR quoted_total_minor >= 0)`,
    ),
  ],
);

/**
 * NEXA-OWNER-BATCH-1 PR-3: one DUE CYCLE of one service's automatic deletion.
 *
 * A cycle is the service's stay in one finished state (`cycle_state`, EXPIRED or SUSPENDED)
 * since one moment (`cycle_since`, the service's `state_since` when the row was written).
 * UNIQUE on (tenant, service, `cycle_since`) among the runs not CANCELLED: two worker replicas,
 * or a pass that overran, both reach the same due service and only one INSERT schedules it — so
 * a cycle is warned at most once per owner. A renewal or a resume moves `services.state_since`,
 * so the old row stops matching and the next stay is a new cycle with a new row. A transfer
 * CANCELS the scheduled run (the warning went to the old owner) without moving the clock; the
 * new owner's run is scheduled with a full warning window of its own.
 *
 * `PLANNED` is written in the transaction that plans the provisioning `TERMINATE`
 * (`operation_id`), conditional on `SCHEDULED`: a cycle's deletion is planned exactly once,
 * and every key the TERMINATE takes derives from this row's id. `planned_at` is what the
 * per-panel rate limit counts. `service_label`, `cause` and `days` are the snapshot the warning
 * and the operations log render (ADR 0030 §1).
 */
export const serviceAutoDeleteRuns = pgTable(
  'service_auto_delete_runs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    serviceId: uuid('service_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    panelId: uuid('panel_id').notNull(),
    /** One of `AUTO_DELETE_SERVICE_STATES`. */
    cycleState: text('cycle_state').notNull(),
    cycleSince: timestamptz('cycle_since').notNull(),
    /** One of `AUTO_DELETE_CAUSES`. */
    cause: text('cause').notNull(),
    /** The day count the cycle was measured by when it was scheduled. */
    days: integer('days').notNull(),
    serviceLabel: text('service_label').notNull(),
    /** The earliest moment the deletion may be planned: the due moment, and the warning's lead. */
    deleteAfter: timestamptz('delete_after').notNull(),
    /** When the one warning was raised; null when none is configured. */
    warnedAt: timestamptz('warned_at'),
    /** One of `AUTO_DELETE_RUN_STATES`. */
    state: text('state').notNull(),
    operationId: uuid('operation_id'),
    plannedAt: timestamptz('planned_at'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    /** One live run per cycle; a CANCELLED one (a transfer) leaves room for the new owner's. */
    uniqueIndex('service_auto_delete_runs_cycle_key')
      .on(table.tenantId, table.serviceId, table.cycleSince)
      .where(sql`state <> 'CANCELLED'`),
    index('service_auto_delete_runs_due_idx')
      .on(table.tenantId, table.deleteAfter)
      .where(sql`state = 'SCHEDULED'`),
    index('service_auto_delete_runs_panel_planned_idx')
      .on(table.tenantId, table.panelId, table.plannedAt)
      .where(sql`state = 'PLANNED'`),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_auto_delete_runs_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'service_auto_delete_runs_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'service_auto_delete_runs_panel_fk',
    }),
    check('service_auto_delete_runs_state_check', enumCheck('state', AUTO_DELETE_RUN_STATES)),
    check('service_auto_delete_runs_cause_check', enumCheck('cause', AUTO_DELETE_CAUSES)),
    check(
      'service_auto_delete_runs_cycle_state_check',
      enumCheck('cycle_state', AUTO_DELETE_SERVICE_STATES),
    ),
    check(
      'service_auto_delete_runs_planned_check',
      sql`(state = 'PLANNED') = (operation_id IS NOT NULL AND planned_at IS NOT NULL)`,
    ),
    check('service_auto_delete_runs_days_check', sql`days >= 1`),
  ],
);
