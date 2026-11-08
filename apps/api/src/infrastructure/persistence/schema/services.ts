/**
 * Database schema — services: the service, reminders, usage, locations, commercial actions.
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
  SERVICE_EXPIRY_CAUSES,
  CURRENCY_CODES,
  COMMERCIAL_ORDER_PURPOSES,
  SERVICE_DELIVERY_STATES,
  SERVICE_STATES,
  SERVICE_REMINDER_KINDS,
  SERVICE_LOCATION_KEY_MAX_LENGTH,
  SERVICE_LOCATION_LABEL_MAX_LENGTH,
  SERVICE_LOCATION_COOLDOWN_HOURS_MAX,
  SERVICE_LOCATION_MAX_CHANGES_MAX,
  SERVICE_LOCATION_PERIOD_DAYS_MAX,
  SERVICE_LAST_SEEN_STATES,
  SERVICE_NOTE_MAX_LENGTH,
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
import { tenants } from './tenancy.js';
import { panels } from './panels.js';
import { customers } from './customers.js';
import { products, serviceAddons } from './catalogue.js';
import { orders } from './orders.js';

/**
 * A service — what the customer is entitled to, as Nexa knows it.
 *
 * Nexa is the authority on the entitlement; the provider holds external reality that
 * is RECONCILED into `traffic_used_bytes` and `usage_synced_at`. Both halves matter: a
 * provider treated as authoritative means a panel outage deletes an entitlement, and a
 * provider ignored means billing for something that does not exist.
 *
 * `provider_username` is the name the ORDER reserved — chosen or drawn under
 * `service-username.ts` and frozen before the money moved — and is unique per PANEL,
 * which is the constraint that makes adoption after an unknown outcome safe: a
 * reconcile asks the panel for the name THIS ROW carries, and the index guarantees at
 * most one service claims it. It used to be derived from the service id, which cannot
 * work once a name has to exist before the service does.
 *
 * `usage_synced_at` is nullable and is rendered to the customer beside the figure,
 * because a usage number with no "as of" is a number a customer reads as live.
 */
export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    /** The order that created it. A renewal is a NEW order against the SAME service. */
    orderId: uuid('order_id').notNull(),
    panelId: uuid('panel_id').notNull(),
    /**
     * Navigation and reporting. The snapshot of what was bought is on the order.
     *
     * NULL exactly when the order that created the service is a `CUSTOM_SERVICE` one
     * (Package D). `nexa_service_requires_purchase_order` pins that pairing, because a
     * CHECK cannot see the order row.
     */
    productId: uuid('product_id'),
    /**
     * R1: this service is a free trial. The database's own answer, not the application's:
     * `nexa_service_requires_purchase_order` sets it on INSERT from the creating order's
     * purpose — whatever the writer passed — and `nexa_services_trial_frozen` refuses to
     * change it afterwards. The DEFAULT is the rollback window: the release before this
     * one inserts without the column, and the trigger still marks its trials.
     */
    isTrial: boolean('is_trial').notNull().default(false),
    state: text('state').notNull().default('PENDING_PROVISION'),
    /** The order's reserved name, frozen before payment. Unique per panel, for adoption. */
    providerUsername: text('provider_username').notNull(),
    /**
     * The `subId` the panel serves this customer's configuration under. A CAPABILITY.
     *
     * Random, 128 bits, chosen HERE and written in the settling transaction. The
     * username beside it is stored in the same transaction but is a different kind of
     * thing, and the distinction is the whole reason this column exists: the username
     * appears in an operator's client list and may be a name the customer picked, while
     * anybody holding this value can fetch the customer's configuration from
     * `https://<subscription domain>/sub/<this>` with no authentication at all.
     *
     * It was derived, through an unkeyed SHA-256 of the service id — and the service id
     * travels in `operational_events.context`, in `audit_logs.entity_id` and in
     * `outbox_messages.aggregate_id`, none of which are places for a credential. Worse,
     * the username was then a reversible encoding of the id rather than a hash, so
     * reading a name off a panel screen recovered the id and therefore the link. The
     * docblocks claimed the opposite in both directions.
     *
     * Stored rather than derived loses nothing: it is written BEFORE any provider call,
     * so a create whose answer was lost can still be reconciled against it — which is
     * the only property the derivation was there to provide.
     *
     * The DEFAULT is the rollback window, not a convenience. `NOT NULL` with no default
     * would narrow what the release before this one can write, which
     * `migration-compatibility.test.ts` forbids by name — so a release rolled back onto
     * this schema keeps inserting, and any row it writes gets a distinct random value
     * rather than a null or a shared sentinel. `ServiceDraft` requires both fields, so
     * nothing in THIS release ever relies on the default.
     */
    subscriptionRef: text('subscription_ref')
      .notNull()
      .default(sql`md5(gen_random_uuid()::text)`),
    /**
     * The client UUID a panel that keys clients by one assigns this service. A
     * CREDENTIAL.
     *
     * 3X-UI's VLESS client id, which the customer's configuration authenticates with.
     * Random and stored for exactly the reasons above; formatted as a v4 UUID because
     * that is what the panels validate.
     */
    providerClientId: uuid('provider_client_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    /** The provider's own identifier, once a provider has told us one. */
    providerUserId: text('provider_user_id'),
    /**
     * The subscription URL the customer receives.
     *
     * Delivered to its owner by design, so it is stored in the clear — but it is a
     * bearer capability for that one service, which is why no list endpoint returns it
     * and only the owner's own detail view does.
     */
    subscriptionUrl: text('subscription_url'),
    expiresAt: timestamptz('expires_at'),
    /** 0 means unlimited, matching the product snapshot it came from. */
    trafficLimitBytes: bigint('traffic_limit_bytes', { mode: 'bigint' }).notNull(),
    trafficUsedBytes: bigint('traffic_used_bytes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /**
     * The device / connection limit this service is entitled to (WP-A5), or NULL when none
     * is recorded — unlimited, or a plan that set none.
     *
     * Seeded from the order's frozen `line_device_limit` when the service is made, and
     * raised ONLY by an `ADD_DEVICES` operation the panel applied, written from the absolute
     * target that operation persisted. It is what the next extra-users purchase is computed
     * from, which is why a purchase is never offered against a NULL: there is no number to
     * add devices to.
     */
    deviceLimit: integer('device_limit'),
    /**
     * Where the service's account sits on its panel, as the panel last reported it (WP-A6),
     * or NULL for a service that has never moved — which is in its panel's INITIAL location,
     * whatever that is configured as today.
     *
     * The adapter-defined key and the customer-facing name, written TOGETHER and only by a
     * `CHANGE_LOCATION` the panel applied: the key from the operation's absolute target, the
     * name from the change request's snapshot. The name is a snapshot for the reason every
     * other one is — an operator renaming a location must not rewrite what a customer's
     * card says their service moved to.
     */
    locationKey: text('location_key'),
    locationLabel: text('location_label'),
    usageSyncedAt: timestamptz('usage_synced_at'),
    /**
     * R4 A2: when a live panel check found this service's account MISSING on its panel —
     * the panel answered, twice and authenticated, that it does not exist — or NULL.
     *
     * A FLAG beside the state machine, deliberately not a `SERVICE_STATES` member. A state
     * would be read by every money rule that names states — the refund lanes, the expiry
     * and usage sweeps, renewal, suspend, the reminders — and "the panel no longer lists
     * it" decides none of those: no refund, no suspension, no customer message follows from
     * it, and an operator decides what happens to the service. The flag changes exactly two
     * things: the customer's own list («سرویس‌های من», its count and its pages) leaves the
     * service out, and the operator's list shows «روی پنل نیست».
     *
     * Set by a conditional UPDATE (`IS NULL`, so the first finding is kept) in the live
     * check's own transaction; cleared by EVERY successful usage read (`recordUsage`), the
     * same writer that closes the operational condition, so a service found again comes
     * back by itself. Never set by a migration.
     */
    missingOnPanelAt: timestamptz('missing_on_panel_at'),
    /**
     * R3 item 7: a customer's on-tap usage read is in flight, since when — or NULL.
     *
     * The reservation that serialises the refresh button: set by a conditional UPDATE
     * (not in flight, or in flight longer than the read can take; and not read within the
     * minimum interval) in the transaction that takes the panel budget, BEFORE the panel
     * is dialled, and cleared when the read ends. Two taps, or a redelivered update, find
     * one of them holding it and the other redraws the card without dialling.
     */
    usageRefreshStartedAt: timestamptz('usage_refresh_started_at'),
    /**
     * Last connection, as a provider PROVED it (customer UX completion §H). `AT` with a
     * time, or `NEVER`; NULL is "no provider has said" — which is every row today, since
     * every adapter answers UNSUPPORTED and UNSUPPORTED is never stored. The card renders
     * NULL as unavailable and never as «متصل نشده».
     */
    lastSeenAt: timestamptz('last_seen_at'),
    lastSeenState: text('last_seen_state'),
    /** The customer's own note on their service. Display only; never provider identity. */
    customerNote: text('customer_note'),
    /**
     * Whether the customer has been told. A separate axis from `state`, deliberately.
     *
     * A failed Telegram send must leave a paid-for, provider-side account `ACTIVE`;
     * anything else invites re-provisioning a service that already exists.
     */
    deliveryState: text('delivery_state').notNull().default('PENDING'),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    deliveredAt: timestamptz('delivered_at'),
    /** When the delivery sweep may next try. Null means it may try now. */
    deliveryNextAttemptAt: timestamptz('delivery_next_attempt_at'),
    /**
     * When a send was handed to Telegram and no outcome has been recorded yet.
     *
     * `provisioning_operations.call_started_at` for the announcement half, and it exists
     * for the same reason: it is the one fact that distinguishes "this process died
     * before sending" from "this process died after sending", and only the second must
     * never be repeated automatically.
     *
     * Without it a sweep that was killed between the send and `recordDelivery` left the
     * row `PENDING` behind nothing but a lease — so when the lease expired the automatic
     * lane announced again, which is precisely the duplicate the `UNCONFIRMED` state was
     * introduced to prevent. An ordinary container restart was enough.
     *
     * Cleared by every recorded outcome, so a set value always means an unresolved send.
     */
    deliverySendStartedAt: timestamptz('delivery_send_started_at'),
    provisionedAt: timestamptz('provisioned_at'),
    terminatedAt: timestamptz('terminated_at'),
    /**
     * A Mirza TEST invoice carried as an ended service (the one-time import, owner decision
     * 2026-10-17): the account was a legacy trial. Only an imported row can be one
     * (`services_is_test_source_check`); every NEXA service is `false`, and a trial of this
     * installation is `is_trial`, a different fact. DEFAULT false keeps the migration
     * expand-only for the release running beside this one.
     */
    isTest: boolean('is_test').notNull().default(false),
    /**
     * When the service was ORIGINALLY bought, where that differs from `created_at` (Track 3 §3),
     * or NULL. The services list orders by `COALESCE(original_started_at, created_at)`, newest
     * first, so an imported service sits at its own purchase date rather than at the import.
     *
     * NULL for every service this installation made: its `created_at` IS its purchase, and a
     * copy would be a second thing to keep in step. For a row the one-time import wrote it is
     * the purchase date the previous bot recorded — the import's order's `settled_at` —
     * filled by `nexa_services_original_started` on INSERT when the writer leaves it out, so
     * no importer has to remember it, and backfilled for the rows already imported. Nullable
     * and unwritten by the application, so the release running beside this one inserts as
     * before. The keyset's indexes are built online (`online-indexes.ts`).
     */
    originalStartedAt: timestamptz('original_started_at'),
    /**
     * NEXA-OWNER-BATCH-1 PR-3: when the service entered its CURRENT state, as this installation
     * knows it — written by the transition that moved it, from the Clock. NULL is "not known":
     * a row that predates the column, or one an import wrote. The automatic deletion stamps
     * such an EXPIRED or SUSPENDED row with the moment it first sees it, and never back-dates
     * it, so nothing is due the instant the column exists.
     */
    stateSince: timestamptz('state_since'),
    /**
     * PR-3: why an EXPIRED service expired (`SERVICE_EXPIRY_CAUSES`), written by the expiry
     * that moved it: its traffic used had reached a finite limit → TRAFFIC, otherwise TIME.
     * Read only while the state is EXPIRED; NULL for a row that expired before the column.
     */
    expiryCause: text('expiry_cause'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    ...recordSourceColumns(),
    ...publicCodeColumns(),
  },
  (table) => [
    ...recordSourceChecks('services', table),
    ...publicCodeChecks('services'),
    check('services_is_test_source_check', sql`NOT is_test OR source = 'MIRZA'`),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'services_customer_fk',
    }),
    /**
     * The order that bought the service. Two columns since Package F: a service's customer
     * is its order's at CREATION — `nexa_services_ownership_guard` refuses an insert that
     * disagrees — and afterwards changes only through a `service_ownership_transfers` row,
     * which the same trigger requires. The three-column form made the order's customer the
     * owner for ever, which is what a transfer is not (`docs/package-f-service-transfer-audit.md`).
     */
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'services_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'services_panel_fk',
    }),
    /**
     * One provider user per panel.
     *
     * Not per tenant: two tenants may legitimately use the same panel, and the name
     * they would collide on is derived from a service id, so a collision here means two
     * services claim one provider account — which is the duplicate that makes usage
     * figures meaningless.
     *
     * Partial: a TERMINATED service's account is gone (or, for a Mirza account that was never
     * on the panel, never existed here), so its name is free again. The application already
     * said so (`usernameInUseOnPanel` excludes TERMINATED); the index now agrees, which is
     * also what lets the Mirza import record an ended service beside a live one that has
     * since taken the name. No live state is ever left by TERMINATED, so a name cannot be
     * un-freed.
     */
    uniqueIndex('services_panel_provider_username_key')
      .on(table.panelId, table.providerUsername)
      .where(sql`state <> 'TERMINATED'`),
    /**
     * And the subscription reference, for the same reason one step further along.
     *
     * 128 random bits will not collide, and an index is what makes that a guarantee
     * rather than an expectation: two services sharing a `subId` would serve one
     * customer the other's configuration, which is the worst outcome this table has.
     */
    uniqueIndex('services_panel_subscription_ref_key').on(table.panelId, table.subscriptionRef),
    index('services_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('services_tenant_state_idx').on(table.tenantId, table.state),
    index('services_customer_created_idx').on(table.customerId, table.createdAt, table.id),
    /** The expiry sweeper, and the reconciliation queue, each their own partial index. */
    index('services_expiry_idx')
      .on(table.expiresAt)
      .where(sql`state = 'ACTIVE' OR state = 'SUSPENDED'`),
    index('services_unreconciled_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`state = 'UNRECONCILED'`),
    check('services_state_check', enumCheck('state', SERVICE_STATES)),
    check('services_expiry_cause_check', nullableEnumCheck('expiry_cause', SERVICE_EXPIRY_CAUSES)),

    check('services_traffic_check', sql`traffic_limit_bytes >= 0 AND traffic_used_bytes >= 0`),
    check(
      'services_device_limit_check',
      sql`device_limit IS NULL OR (device_limit >= 1 AND device_limit <= 1000)`,
    ),
    /** WP-A6: a location is a key AND a name, or neither. */
    check('services_location_check', sql`(location_key IS NULL) = (location_label IS NULL)`),
    /** The format the panels accept, pinned so a bad generator fails at the write. */
    check('services_subscription_ref_check', sql`subscription_ref ~ '^[0-9a-f]{32}$'`),
    /**
     * A provisioned service has a time; one that never was does not — and a
     * TERMINATED one may be either.
     *
     * The equality without that third clause is a rule `SERVICE_MACHINE`
     * contradicts. The machine has `PENDING_PROVISION -> TERMINATED` and
     * `UNRECONCILED -> TERMINATED`, and `OPERATION_LEGAL_FROM.TERMINATE` names both
     * states deliberately — "a service an operator or a customer has decided to end
     * must be endable whatever went wrong on the way, including one stuck in
     * `UNRECONCILED` after a lost create". Both of those states have a null
     * `provisioned_at` by this very check, so taking either edge moved the state to
     * one side of the equality and left the timestamp on the other, and the UPDATE
     * raised.
     *
     * Nothing had taken those edges. The automatic refund is the first caller: a
     * create that definitively failed leaves a `PENDING_PROVISION` row occupying a
     * capacity slot, and terminating it is how the panel gets the slot back. The
     * suite found this on the first full run, which is the argument for running it.
     *
     * The clause is a carve-out for TERMINATED rather than a loosening of the whole
     * rule: for every state a service can be USED in, the equality still holds, and
     * `services_terminated_at_check` still forces `terminated_at`. What a terminated
     * service's null `provisioned_at` now says is true and worth saying — this one
     * never reached a panel.
     */
    check(
      'services_provisioned_at_check',
      sql`state = 'TERMINATED'
          OR (state = 'PENDING_PROVISION' OR state = 'UNRECONCILED') = (provisioned_at IS NULL)`,
    ),
    check(
      'services_terminated_at_check',
      sql`(state = 'TERMINATED') = (terminated_at IS NOT NULL)`,
    ),
    check(
      'services_last_seen_state_check',
      nullableEnumCheck('last_seen_state', SERVICE_LAST_SEEN_STATES),
    ),
    check(
      'services_last_seen_pair_check',
      sql`(last_seen_state IS NOT DISTINCT FROM 'AT') = (last_seen_at IS NOT NULL)`,
    ),
    check(
      'services_customer_note_check',
      sql`customer_note IS NULL OR length(btrim(customer_note)) BETWEEN 1 AND ${sql.raw(String(SERVICE_NOTE_MAX_LENGTH))}`,
    ),
    /** A usage figure and its "as of" travel together, or the figure is a lie. */
    check(
      'services_usage_synced_check',
      sql`traffic_used_bytes = 0 OR usage_synced_at IS NOT NULL`,
    ),
    check('services_delivery_state_check', enumCheck('delivery_state', SERVICE_DELIVERY_STATES)),
    check(
      'services_delivery_attempts_check',
      sql`delivery_attempts >= 0 AND delivery_attempts <= 100`,
    ),
    /** A delivery time and the state that claims one travel together, or neither is true. */
    check(
      'services_delivered_at_check',
      sql`(delivery_state = 'DELIVERED') = (delivered_at IS NOT NULL)`,
    ),
    /**
     * ONE service per order, as a constraint rather than as worker discipline.
     *
     * This is the exactly-once rule. The service row is written inside the SAME
     * transaction that takes `SETTLE`, so an order settles once and this index says an
     * order produces at most one service — two workers, a replayed command and a
     * double-tapped button all lose here rather than each creating a provider account
     * the customer pays for once and occupies twice.
     *
     * On `(tenant_id, order_id)` and NOT on `(tenant_id, customer_id, product_id)`,
     * because a renewal is a NEW order against the SAME service: a customer may hold
     * two services bought from one product, and must.
     */
    uniqueIndex('services_tenant_order_key').on(table.tenantId, table.orderId),
    /** The delivery sweep: undelivered services whose backoff has elapsed. */
    index('services_delivery_due_idx')
      .on(table.deliveryNextAttemptAt)
      .where(sql`delivery_state = 'PENDING'`),
    unique('services_tenant_id_key').on(table.tenantId, table.id),
    /**
     * Redundant against the primary key. It was the target of the three-column reference
     * `service_commercial_actions` held until Package F, which now references the service
     * by two columns and checks the owner with a trigger at insert.
     *
     * Kept, and not for a reference: `customer_id` being in a unique key is what makes an
     * UPDATE of it take `FOR UPDATE` rather than `FOR NO KEY UPDATE`. So a transfer's
     * reassignment waits for a foreign-key check already in flight on the row — a
     * commercial draft's — and one arriving after it waits for the transfer and then reads
     * the new owner, instead of the two interleaving.
     */
    unique('services_tenant_id_customer_key').on(table.tenantId, table.id, table.customerId),
  ],
);

/**
 * One row per (service, reminder kind, period): "we told them this, about that period".
 *
 * A FACT, not a flag, and the distinction is what makes renewal work. The row records
 * the BASIS the reminder was raised against — both the deadline and the allowance the
 * service had at that moment — and the lane skips a service whose stored basis still
 * equals its current one. A RENEW moves `expires_at`, an ADD_TRAFFIC moves
 * `traffic_limit_bytes`, either makes the bases differ, and the reminder is due again.
 * Nothing is deleted to re-arm anything, which matters: deleting rows to make a reminder
 * fire again is how an audit trail loses the record of what a customer was actually
 * told. A row is written once and never updated: an occurrence keeps the id the
 * notification named it by.
 *
 * The two columns are read by DIFFERENT kinds. An expiry reminder compares the deadline
 * alone, so buying extra traffic does not re-send "expires in three days". A usage
 * reminder compares both, because a renewal is what resets the panel's usage counter and
 * therefore starts the allowance over even when the allowance itself is unchanged.
 *
 * It is also the SUBJECT of the notification this reminder produces. Every other kind
 * in `CUSTOMER_NOTIFICATION_KINDS` names an order, a payment or a service, and
 * `customer_notifications_subject_key` then guarantees one delivery per subject for
 * ever — right for a rejection, fatal for a reminder. Naming this row instead makes
 * each occurrence its own subject and keeps the guarantee exactly where it belongs.
 */
export const serviceReminders = pgTable(
  'service_reminders',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    serviceId: uuid('service_id').notNull(),
    /** One of `SERVICE_REMINDER_KINDS`. */
    kind: text('kind').notNull(),
    /**
     * The deadline the service had when this reminder was raised. Null means unlimited
     * validity, which is a real answer and not a missing one.
     *
     * Written on EVERY row, expiry and usage alike, because it is what a RENEW moves and
     * a renewal is the event that starts a new usage period too. Kept apart from
     * `basis_traffic_limit_bytes` rather than folded into one opaque column, because the
     * two are compared against different columns of `services` and a single `basis text`
     * would be a value whose meaning depends on the row's kind — which is the shape
     * `subject_type` was refused for on `customer_notifications`.
     */
    basisExpiresAt: timestamptz('basis_expires_at'),
    /**
     * The allowance the service had when this reminder was raised. Zero is unlimited,
     * the sentinel `services.traffic_limit_bytes` already uses.
     *
     * NOT NULL, and written on every row for the same reason the column above is: an
     * ADD_TRAFFIC moves it, and a reminder raised against fifty gigabytes says nothing
     * about a service that now has eighty.
     */
    basisTrafficLimitBytes: bigint('basis_traffic_limit_bytes', { mode: 'bigint' }).notNull(),
    /*
     * WHAT THE CUSTOMER IS TOLD, frozen at the moment the reminder was raised.
     *
     * The three columns below are the only reason this table has a snapshot at all, and
     * the alternative is what makes them necessary: rendering the message from
     * `services` at SEND time. The two moments are minutes apart on a good day and a
     * queue-length apart on a bad one, and in between a renewal moves the deadline, a
     * usage sync moves the figure, and the customer reads a sentence whose numbers
     * contradict the threshold that produced it. `docs/conventions.md` already requires
     * a snapshot for anything that will appear in a historical report; a message to a
     * customer is one.
     *
     * `snapshot_used_bytes` is NOT NULL and is never a stand-in for a figure nobody has
     * read: the usage sweep refuses a service whose `usage_synced_at` is NULL, and the
     * three expiry kinds render no traffic at all. Zero here means the panel said zero.
     */
    snapshotServiceLabel: text('snapshot_service_label').notNull(),
    /** Whole days left when it was raised. NULL for the usage kinds, which render none. */
    snapshotRemainingDays: integer('snapshot_remaining_days'),
    snapshotUsedBytes: bigint('snapshot_used_bytes', { mode: 'bigint' }).notNull(),
    raisedAt: timestamptz('raised_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_reminders_service_fk',
    }),
    /**
     * ONE row per service per kind PER PERIOD, and the insert on it is what makes the
     * pass safe.
     *
     * Two worker replicas is the normal case on every rolling update, and both will
     * find the same due service. The conditional insert is the decision: the winner
     * writes the row and enqueues the notification in the same transaction, the loser's
     * `ON CONFLICT DO NOTHING` returns nothing and it enqueues nothing.
     *
     * The BASIS is in the key, which is what makes a row an occurrence rather than a
     * slot. An occurrence keeps its id for ever, so the `customer_notifications` row
     * that names it as its subject still resolves years later; a per-kind slot rewritten
     * on each renewal would have to change its own primary key to earn a fresh subject,
     * and every earlier notification would then point at nothing.
     *
     * NULLS NOT DISTINCT, because `basis_expires_at` is NULL for unlimited validity and
     * Postgres treats NULLs in a unique key as distinct by default — which would let
     * every pass insert another row for the same service and send the same reminder for
     * ever. It is a UNIQUE CONSTRAINT rather than a unique index only because that is
     * where drizzle exposes the option.
     *
     * Both basis columns are in the key, so an ADD_TRAFFIC re-arms the three EXPIRY
     * kinds as well as the three usage ones. That is a deliberate, stated cost: the
     * customer may be told "expires soon" once more after buying traffic. Splitting it
     * into two partial unique indexes would avoid the extra message and would make the
     * arbiter of every insert depend on which kind it carries. This lane exists to speak
     * up, and an extra true sentence is the failure to prefer over a missed one.
     */
    unique('service_reminders_period_key')
      .on(
        table.tenantId,
        table.serviceId,
        table.kind,
        table.basisExpiresAt,
        table.basisTrafficLimitBytes,
      )
      .nullsNotDistinct(),
    /** The sweep reads by tenant and orders by when it last spoke. */
    index('service_reminders_raised_idx').on(table.tenantId, table.raisedAt),
    check('service_reminders_kind_check', enumCheck('kind', SERVICE_REMINDER_KINDS)),
    /**
     * Exactly one basis, and which one is decided by the kind.
     *
     * A row with neither could never be compared against anything and would suppress
     * its reminder for ever; a row with both would be two answers to "what was this
     * about". The CHECK is the only thing standing between a future caller and either.
     */
    /**
     * An allowance is a size, and a negative one is not a size.
     *
     * This replaces an exclusive `(expires_at IS NULL) <> (limit IS NULL)` that migration
     * 0090 shipped and 0091 removes. That constraint encoded a wrong model: it made each
     * reminder carry exactly ONE basis, expiry or allowance, and a usage reminder whose
     * only basis was the allowance is a usage reminder a renewal cannot re-arm. A
     * customer who renews a fifty-gigabyte plan, has their usage reset on the panel and
     * climbs back past eighty percent would never be told again, for the life of the
     * service — which is precisely the silence this whole lane exists to break.
     */
    check('service_reminders_basis_check', sql`${table.basisTrafficLimitBytes} >= 0`),
  ],
);

/**
 * Round 4 PR-H (post-import safety): what an imported service already WAS when the import
 * created it — one row per service, written by the reminder seed inside the adoption's own
 * transaction, never updated.
 *
 * The seed (`ServiceReminderService.seedPassedThresholds`) records every reminder already
 * behind the service as raised, under the thresholds in force at that moment. That is not
 * enough on its own: an operator who moves a threshold after the import (seven days to ten,
 * eighty percent to seventy) makes a crossing the seed never recorded, and the next sweep
 * would announce it — to every imported service at once, about a period the previous bot
 * already handled. So the sweep also asks THIS row: a kind that was already behind the
 * service at `baseline_at`, under the thresholds in force NOW, is history, recorded and
 * never sent. Customers are told only of a state change observed after their import.
 *
 * The basis is the period the baseline describes, compared the way `service_reminders`
 * compares it: a renewal (a new deadline) or added traffic (a new allowance) starts a new
 * period this row says nothing about, and every reminder of that period is sent as usual.
 * `used_bytes` is the figure the import read from the panel; NULL means nothing was
 * measured and the usage half has no baseline. A native service has no row and the rule
 * never applies to it.
 */
export const serviceReminderBaselines = pgTable(
  'service_reminder_baselines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    serviceId: uuid('service_id').notNull(),
    baselineAt: timestamptz('baseline_at').notNull(),
    basisExpiresAt: timestamptz('basis_expires_at'),
    basisTrafficLimitBytes: bigint('basis_traffic_limit_bytes', { mode: 'bigint' }).notNull(),
    usedBytes: bigint('used_bytes', { mode: 'bigint' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'service_reminder_baselines_pk',
      columns: [table.tenantId, table.serviceId],
    }),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_reminder_baselines_service_fk',
    }),
    check(
      'service_reminder_baselines_figures_check',
      sql`${table.basisTrafficLimitBytes} >= 0 AND (${table.usedBytes} IS NULL OR ${table.usedBytes} >= 0)`,
    ),
  ],
);

// --- R11 B2: usage snapshots behind the mini app's chart ---------------------------------

/**
 * One usage figure of one service, kept for the mini app's chart (R11 B2).
 *
 * WRITTEN BESIDE A READ THAT ALREADY HAPPENS, never by a read of its own: the scheduled
 * `SYNC_USAGE`, a renewal whose answer carries usage and a card's live check each call
 * `recordUsage`, and the snapshot is recorded in that same transaction when it returned true
 * and `service_usage_chart` is on. There is no polling loop and no panel call behind this
 * table (RickPanel load protection).
 *
 * `bucket_at` is `taken_at` floored to `USAGE_SNAPSHOT_BUCKET_MINUTES` and is part of the
 * primary key: a second read inside the same hour inserts nothing (`ON CONFLICT DO NOTHING`),
 * so the first figure of a bucket is the one kept and a burst of live checks cannot grow the
 * table. `total_bytes` is NULL for an unlimited allowance, `expires_at` NULL for a service
 * with no deadline -- the values the service row held when the figure was recorded.
 * Rows older than `USAGE_SNAPSHOT_RETENTION_DAYS` are deleted by the provisioner's tick,
 * through `(tenant_id, taken_at)`.
 */
export const serviceUsageSnapshots = pgTable(
  'service_usage_snapshots',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    serviceId: uuid('service_id').notNull(),
    bucketAt: timestamptz('bucket_at').notNull(),
    takenAt: timestamptz('taken_at').notNull(),
    usedBytes: bigint('used_bytes', { mode: 'bigint' }).notNull(),
    totalBytes: bigint('total_bytes', { mode: 'bigint' }),
    expiresAt: timestamptz('expires_at'),
  },
  (table) => [
    primaryKey({
      name: 'service_usage_snapshots_pk',
      columns: [table.tenantId, table.serviceId, table.bucketAt],
    }),
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_usage_snapshots_service_fk',
    }),
    index('service_usage_snapshots_taken_idx').on(table.tenantId, table.takenAt),
    check(
      'service_usage_snapshots_figures_check',
      sql`${table.usedBytes} >= 0 AND (${table.totalBytes} IS NULL OR ${table.totalBytes} > 0)`,
    ),
  ],
);

// --- WP-A6: the configured locations a service may be moved to -------------------------

/**
 * One location of one panel, as an operator configured it (WP-A6).
 *
 * A row is two things at once, because they are one thing to an operator: a NAME for a
 * place the panel's own management domain can put an account (`location_key`, which only
 * the adapter interprets), and — when enabled and priced — an OFFER to move a service
 * there. No row, a disabled row or an unpriced row is unavailable; a price of zero is free
 * and is the only free. There is no target-panel column: a move keeps the account on the
 * panel it is on, so a cross-panel or cross-provider move cannot even be written.
 *
 * `initial` marks where the panel's new accounts are created. It is how a service that
 * has never moved knows its current location, and therefore how "the target is where it
 * already is" is refused; one per panel, and never product-scoped, because a panel places
 * every new account the same way.
 *
 * `product_id` scopes an offer to one product's services — the most specific row for a
 * key wins, exactly as a per-device rate's scope does. `version` is bumped by every edit,
 * and a change request snapshots the version it was quoted from.
 */
export const serviceLocations = pgTable(
  'service_locations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    panelId: uuid('panel_id').notNull(),
    productId: uuid('product_id'),
    locationKey: text('location_key').notNull(),
    label: text('label').notNull(),
    isInitial: boolean('is_initial').notNull().default(false),
    enabled: boolean('enabled').notNull().default(false),
    /** Both halves or neither; null is "not for sale", never free. Zero is free. */
    priceAmount: bigint('price_amount', { mode: 'bigint' }),
    priceCurrency: text('price_currency'),
    cooldownHours: integer('cooldown_hours'),
    maxChanges: integer('max_changes'),
    periodDays: integer('period_days'),
    sortOrder: integer('sort_order').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('service_locations_tenant_id_key').on(table.tenantId, table.id),
    /** One row per key per scope: a panel-wide one, and at most one per product. */
    unique('service_locations_key')
      .on(table.tenantId, table.panelId, table.locationKey, table.productId)
      .nullsNotDistinct(),
    /** One initial location per panel. */
    uniqueIndex('service_locations_initial_key')
      .on(table.tenantId, table.panelId)
      .where(sql`is_initial`),
    index('service_locations_panel_idx').on(table.tenantId, table.panelId, table.sortOrder),
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'service_locations_panel_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'service_locations_product_fk',
    }),
    check(
      'service_locations_key_check',
      sql`length(location_key) BETWEEN 1 AND ${sql.raw(String(SERVICE_LOCATION_KEY_MAX_LENGTH))}`,
    ),
    check(
      'service_locations_label_check',
      sql`length(btrim(label)) BETWEEN 1 AND ${sql.raw(String(SERVICE_LOCATION_LABEL_MAX_LENGTH))}`,
    ),
    check(
      'service_locations_price_check',
      sql`(price_amount IS NULL) = (price_currency IS NULL) AND (price_amount IS NULL OR price_amount >= 0)`,
    ),
    check('service_locations_currency_check', nullableEnumCheck('price_currency', CURRENCY_CODES)),
    /** An enabled target is a priced one: enabled and unpriced would be "free" by omission. */
    check('service_locations_enabled_priced_check', sql`NOT enabled OR price_amount IS NOT NULL`),
    check('service_locations_initial_scope_check', sql`NOT is_initial OR product_id IS NULL`),
    check(
      'service_locations_cooldown_check',
      sql`cooldown_hours IS NULL OR (cooldown_hours >= 1 AND cooldown_hours <= ${sql.raw(String(SERVICE_LOCATION_COOLDOWN_HOURS_MAX))})`,
    ),
    check(
      'service_locations_limit_check',
      sql`(max_changes IS NULL) = (period_days IS NULL)
          AND (max_changes IS NULL OR (max_changes >= 1 AND max_changes <= ${sql.raw(String(SERVICE_LOCATION_MAX_CHANGES_MAX))}))
          AND (period_days IS NULL OR (period_days >= 1 AND period_days <= ${sql.raw(String(SERVICE_LOCATION_PERIOD_DAYS_MAX))}))`,
    ),
    check('service_locations_version_check', sql`version >= 1`),
  ],
);

/**
 * One commercial action bought against a service that already exists.
 *
 * The immutable evidence a renewal, an extra-traffic purchase or an extra-time purchase
 * leaves behind, and the answer to every question an operator or an accountant can ask
 * about one: which tenant, which customer, which service, what kind, what was paid, in
 * what currency, how much was bought, where the price came from, and which order settled
 * it. A row is written in the SAME transaction that confirms the order and is never
 * updated afterwards — `nexa_service_commercial_actions_immutable` is the guard.
 *
 * ## Why a table rather than columns on `orders`
 *
 * Two reasons, and the second is the one that decided it.
 *
 * The legacy system has the same shape: `/invoice/service` is an append-only ancillary
 * ledger with seven operation types, separate from `/invoice/`, and the log topics for
 * purchases and for renewals are disjoint — "orders exclude renewals, add-ons and tests"
 * (`LGR-REC-004`). A renewal produces a new financial record and no new service.
 *
 * And a column on `orders` could not carry the customer. Every child row that names an
 * order also names a customer, and a two-column reference lets the pair disagree —
 * which here would put a renewal one customer paid for onto another customer's account.
 * The three-column form is what makes that unrepresentable, and it needs `services` to
 * be declared already. `services` references `orders`, so a column on `orders` would be
 * the other side of a cycle and a composite key cannot be written in either direction of
 * one.
 *
 * ## What is NOT here
 *
 * The absolute target the panel is asked to make true. That is on the operation row,
 * because it is a different fact: this row says what the customer BOUGHT — thirty days,
 * fifty gigabytes — and the operation says what the account should then READ as. The
 * second is computed from the first plus the service's state at settlement, once, and
 * a replay of the operation must reproduce it exactly.
 */
export const serviceCommercialActions = pgTable(
  'service_commercial_actions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    /** One per order, and the order is what was paid. */
    orderId: uuid('order_id').notNull(),
    /** `RENEW`, `ADD_TRAFFIC` or `ADD_TIME` — the `OrderPurpose` minus `NEW_SERVICE`. */
    kind: text('kind').notNull(),
    /**
     * Where the price came from, as a row id, so the operator can navigate.
     *
     * A renewal names the product it was quoted from; a quantity purchase names the
     * add-on. Exactly one is set, and neither is how the purchase is reconstructed — the
     * amounts below and the order's own quote are.
     */
    productId: uuid('product_id'),
    addonId: uuid('addon_id'),
    /** What was bought. Bytes for traffic, days for time; zero where nothing was. */
    purchasedTrafficBytes: bigint('purchased_traffic_bytes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    purchasedDurationDays: integer('purchased_duration_days').notNull().default(0),
    /** WP-A5: extra users / devices bought. Positive for `ADD_DEVICES`, zero otherwise. */
    purchasedDeviceCount: integer('purchased_device_count').notNull().default(0),
    /**
     * WP-A5: the add-on VERSION the purchase was priced from, beside `addon_id`. Required
     * for `ADD_DEVICES`, whose rate is edited in place; null for every other kind.
     */
    addonVersion: integer('addon_version'),
    /**
     * WP-A6: the configured target a `CHANGE_LOCATION` was priced from, the third place a
     * price may come from. Its VERSION and the names are on the change request, which is
     * the snapshot; this is navigation, like `product_id` and `addon_id`.
     */
    locationId: uuid('location_id'),
    /** What was paid, with its currency. Never an amount without one. */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'service_commercial_actions_customer_fk',
    }),
    /**
     * The service. Two columns since Package F: a row is append-only and outlives a
     * transfer, so it names the customer who OWNED the service when it was written, which
     * `nexa_commercial_action_owner_guard` requires at insert. The three-column form made
     * even an abandoned renewal draft pin the service to its payer for ever.
     */
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'service_commercial_actions_service_fk',
    }),
    /** And with the order, so the money and the effect cannot name two people. */
    foreignKey({
      columns: [table.tenantId, table.orderId, table.customerId],
      foreignColumns: [orders.tenantId, orders.id, orders.customerId],
      name: 'service_commercial_actions_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'service_commercial_actions_product_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.addonId],
      foreignColumns: [serviceAddons.tenantId, serviceAddons.id],
      name: 'service_commercial_actions_addon_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.locationId],
      foreignColumns: [serviceLocations.tenantId, serviceLocations.id],
      name: 'service_commercial_actions_location_fk',
    }),
    /**
     * ONE action per order, as a constraint rather than as worker discipline.
     *
     * The exactly-once rule, in the same shape `services_tenant_order_key` gives the
     * original purchase: the row is written inside the transaction that confirms the
     * order, so a replayed confirmation, a second replica and a double-tapped button all
     * lose here rather than each buying the customer a renewal.
     */
    uniqueIndex('service_commercial_actions_order_key').on(table.tenantId, table.orderId),
    index('service_commercial_actions_service_idx').on(table.serviceId, table.createdAt, table.id),
    index('service_commercial_actions_customer_idx').on(
      table.customerId,
      table.createdAt,
      table.id,
    ),
    check('service_commercial_actions_kind_check', enumCheck('kind', COMMERCIAL_ORDER_PURPOSES)),
    check('service_commercial_actions_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('service_commercial_actions_amount_check', sql`amount >= 0`),
    /**
     * The price came from exactly one place.
     *
     * A row naming both a product and an add-on could be read as either, and the two
     * answer "what did this cost and why" differently. A row naming neither cannot
     * answer it at all — which is the legacy defect where a deleted product collapses a
     * historical line to «محصول حذف‌شده».
     */
    /*
     * WP-A6 made it three places, and still exactly one: a location change names its
     * configured target and neither a product nor an add-on.
     */
    check(
      'service_commercial_actions_source_check',
      sql`(CASE WHEN product_id IS NULL THEN 0 ELSE 1 END
           + CASE WHEN addon_id IS NULL THEN 0 ELSE 1 END
           + CASE WHEN location_id IS NULL THEN 0 ELSE 1 END) = 1
          AND (location_id IS NULL) = (kind <> 'CHANGE_LOCATION')`,
    ),
    /**
     * What each kind may have bought, pinned so the amounts cannot be swapped.
     *
     * A renewal buys a period and an allowance together — the pinned Marzban leaves a
     * traffic-exhausted account exhausted when only time is extended, so a renewal that
     * sent one field would take the money and leave the customer cut off. A quantity
     * purchase buys exactly one of them, and the other is zero.
     */
    check(
      'service_commercial_actions_purchased_check',
      sql`(kind = 'RENEW' AND purchased_device_count = 0)
          OR (kind = 'ADD_TRAFFIC' AND purchased_traffic_bytes > 0 AND purchased_duration_days = 0 AND purchased_device_count = 0)
          OR (kind = 'ADD_TIME' AND purchased_duration_days > 0 AND purchased_traffic_bytes = 0 AND purchased_device_count = 0)
          OR (kind = 'ADD_DEVICES' AND purchased_device_count > 0 AND purchased_traffic_bytes = 0 AND purchased_duration_days = 0
              AND addon_id IS NOT NULL AND addon_version IS NOT NULL)
          OR (kind = 'CHANGE_LOCATION' AND purchased_traffic_bytes = 0 AND purchased_duration_days = 0
              AND purchased_device_count = 0)`,
    ),
    check(
      'service_commercial_actions_addon_version_check',
      sql`addon_version IS NULL OR (kind = 'ADD_DEVICES' AND addon_version >= 1)`,
    ),
    unique('service_commercial_actions_tenant_id_key').on(table.tenantId, table.id),
  ],
);
