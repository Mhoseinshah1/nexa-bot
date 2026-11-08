/**
 * Database schema — orders: the order, its panel placement, capacity and username reservations.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  bigint,
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
  PANEL_BALANCING_STRATEGIES,
  PANEL_PLACEMENT_DECIDERS,
  SOURCE_SURFACES,
  ORDER_ORIGINS,
  ORDER_PURPOSES,
  ORDER_SETTLED_STATES,
  ORDER_STATES,
  SERVICE_USERNAME_MODES,
  USERNAME_CAPTURE_CLOSE_REASONS,
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
import { panels } from './panels.js';
import { customers } from './customers.js';
import { products } from './catalogue.js';

/**
 * A slot on a panel, held for one order while the customer decides whether to pay.
 *
 * Phase 6B. The alternative — counting services and comparing against the cap —
 * is wrong in exactly one place and it is the place that matters: between a
 * customer confirming an order and their payment settling there is no service
 * row, so two customers reaching for the last slot both count the same n-1 and
 * are both sold it. The row is what makes the last slot exclusive, and it exists
 * for precisely the window in which nothing else represents that customer's
 * claim on the panel.
 *
 * It is released the moment something else does represent it. Settlement writes
 * the service inside the same transaction that deletes this row, so the slot is
 * held continuously and counted once, never twice and never briefly by nobody.
 * Every other exit — the payment expiring, being rejected, the order cancelled —
 * deletes it and gives the slot back.
 *
 * DELETED rather than marked, and that is the design. A `RELEASED` state would
 * make the capacity query filter on it, and a query that must exclude rows is a
 * query one caller will forget to write that way; a row that is gone cannot be
 * counted by accident. What the release MEANT is in the audit trail and the
 * order's own history, which is where a reader looks for it anyway.
 */
export const panelCapacityReservations = pgTable(
  'panel_capacity_reservations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    panelId: uuid('panel_id').notNull(),
    /**
     * The order this slot is being held for. UNIQUE, and that is the idempotency.
     *
     * A confirmation replayed by a retry, a double-tapped button or a second
     * replica collides here rather than taking a second slot from a panel that
     * may only have one left.
     */
    orderId: uuid('order_id').notNull(),
    /**
     * When this hold stops counting, whatever else has happened.
     *
     * The backstop for the release that never ran — a process killed between the
     * payment and the delete, a lane that lost its work. Without it an abandoned
     * checkout holds somebody else's slot until an operator notices, which on a
     * single-slot panel means the panel is full and nothing says why.
     *
     * The capacity query filters on this rather than a sweep deleting rows,
     * because a sweep is a process and this must be true without one running.
     */
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    /** A child row may not name another tenant's panel. */
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'panel_capacity_reservations_tenant_panel_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'panel_capacity_reservations_order_fk',
    }),
    /** One slot per order. The collision IS the replay defence. */
    uniqueIndex('panel_capacity_reservations_order_key').on(table.tenantId, table.orderId),
    /**
     * The counting scan: for ONE panel, the holds that have not expired.
     *
     * Leads with the panel because that is what capacity is asked about, and
     * carries `expires_at` so the predicate is served by the same index rather
     * than by a filter over every hold the panel has ever taken.
     */
    index('panel_capacity_reservations_panel_idx').on(
      table.tenantId,
      table.panelId,
      table.expiresAt,
    ),
  ],
);

/**
 * A service username somebody is in the middle of buying.
 *
 * The hold that stops two customers paying for one name. It exists because the
 * decision moved: a username used to be derived from the service id — minted after the
 * money, unique by construction, impossible to contend for — and a customer-chosen or
 * template-rendered name is none of those things. It is chosen BEFORE the payment, and
 * between that choice and the provider account there is a window in which the name
 * belongs to nobody unless a row says otherwise.
 *
 * ## Why this is not `panel_capacity_reservations` with a different column
 *
 * The lifecycles differ where it matters most, and `docs/phase6c-audit.md` A-6 records
 * the difference: capacity is freed by `expires_at` so an abandoned checkout cannot
 * hold a slot for ever, and **a funded username must never be freed that way**. A TTL
 * that expired a paid name would let a second customer reserve a name the first already
 * has an account for on the panel — two services, one provider account, and the usage
 * figures of both meaningless.
 *
 * So `funded_at` is the switch. While it is null the row is an abandoned checkout and
 * `expires_at` may reap it; once it is set the row is protected until the order reaches
 * a terminal outcome — FULFILLED, which consumes the name into
 * `services.provider_username`, or REFUNDED, which releases it. An `UNRECONCILED`
 * service is neither: the remote account may exist, so the name stays held.
 *
 * ## Why the key is a namespace rather than a panel
 *
 * `services_panel_provider_username_key` is per panel, and two panel rows may point at
 * the same provider host — `panels` constrains only the name, never `base_url`. Those
 * panels share one account namespace, so a per-panel hold would let two customers
 * reserve one name on one real panel. `namespace_key` is derived from the provider type
 * and the normalised host and port, so they contend as they should.
 *
 * A definitive conflict that survives both — an account an operator made by hand — is a
 * definitive non-delivery and follows the money rules. It is never adopted.
 */
/**
 * The window in which an ordinary message means "this is my username".
 *
 * Modelled on `receipt_captures` deliberately, down to the partial unique index,
 * because it answers the same dangerous question: when may a plain message the customer
 * typed be read as an answer rather than as conversation? The legacy system answered it
 * with a stateful prompt that outlived its question and overwrote a production gateway
 * setting with somebody's ordinary message (INCIDENT-FIN-001).
 *
 * Two things bound the damage, and neither is the deadline. First, the window is a ROW:
 * it is explicit, it has an owner, and a redelivered message either finds it or does
 * not. Second, and more important, the only thing an open window can DO is validate a
 * name against the one draft order it names, for the one customer it names. There is no
 * branch in which it reaches a setting, a payment or another order — so even a window
 * that outlived its question is confined to the question.
 */
export const usernameCaptures = pgTable(
  'username_captures',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** WHICH bot, for the reason `receipt_captures.bot_instance_id` states. */
    botInstanceId: uuid('bot_instance_id')
      .notNull()
      .references(() => botInstances.id),
    customerId: uuid('customer_id').notNull(),
    orderId: uuid('order_id').notNull(),
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
      name: 'username_captures_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'username_captures_order_fk',
    }),
    /**
     * ONE open window per customer per bot, decided by the database.
     *
     * Two taps on two different drafts arriving together both read "nothing open", and
     * the name the customer then types attaches to whichever row the planner returns
     * first — a username reserved against an order they were not looking at, on a panel
     * they were not buying from.
     */
    uniqueIndex('username_captures_open_key')
      .on(table.tenantId, table.botInstanceId, table.customerId)
      .where(sql`closed_at IS NULL`),
    /** The sweep's index: windows past their deadline that nobody has closed. */
    index('username_captures_due_idx')
      .on(table.tenantId, table.expiresAt)
      .where(sql`closed_at IS NULL`),
    check(
      'username_captures_close_reason_check',
      nullableEnumCheck('close_reason', USERNAME_CAPTURE_CLOSE_REASONS),
    ),
    /** A closed window has a reason, and an open one has neither. Both halves. */
    check('username_captures_closed_check', sql`(closed_at IS NULL) = (close_reason IS NULL)`),
    check('username_captures_expiry_check', sql`expires_at > opened_at`),
  ],
);

export const serviceUsernameReservations = pgTable(
  'service_username_reservations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * The provider account namespace this name is held in.
     *
     * Derived, not entered: `<provider_type>:<host>[:<port>]`, lowercased. Stored rather
     * than computed at query time so the unique index below can be a plain index on a
     * column, and so a panel whose address is later edited does not silently move every
     * hold it took.
     */
    namespaceKey: text('namespace_key').notNull(),
    username: text('username').notNull(),
    panelId: uuid('panel_id').notNull(),
    orderId: uuid('order_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    /** Which mode produced it, so an audit can tell a typed name from a rendered one. */
    mode: text('mode').notNull(),
    /**
     * When the money for this name committed, or null while the checkout is unfunded.
     *
     * The single field that decides whether `expires_at` may reap this row. See the
     * table docblock: a TTL that frees a funded name is two services on one account.
     */
    fundedAt: timestamptz('funded_at'),
    /**
     * The backstop for an abandoned checkout, and ONLY for one.
     *
     * Every query that treats a row as held must also require `funded_at IS NOT NULL OR
     * expires_at > now()`. Expiry alone is not release: a funded row past its expiry is
     * still held, which is the whole difference from the capacity table.
     */
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.panelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'service_username_reservations_tenant_panel_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'service_username_reservations_order_fk',
    }),
    /**
     * One name per namespace, and the collision IS the refusal.
     *
     * Deliberately NOT scoped by tenant: two tenants pointing at one provider host
     * share its account namespace whether or not they know about each other, and a name
     * one of them created is a name the other cannot have. The row exposes nothing
     * across the boundary — a caller learns only that the name is unavailable, which is
     * the same answer the provider would eventually give.
     */
    uniqueIndex('service_username_reservations_name_key').on(table.namespaceKey, table.username),
    /** One name per order. A duplicate callback finds its own row rather than taking a second. */
    uniqueIndex('service_username_reservations_order_key').on(table.tenantId, table.orderId),
    /** The reaper's scan: unfunded holds that have run out. */
    index('service_username_reservations_expiry_idx').on(table.fundedAt, table.expiresAt),
    check('service_username_reservations_mode_check', enumCheck('mode', SERVICE_USERNAME_MODES)),
  ],
);

/**
 * An order — one commercial intent and its snapshot of what was bought.
 *
 * Every `line_*` column is a snapshot taken at confirmation. `product_id` and
 * `panel_id` are kept so an operator can navigate, and are explicitly NOT how the
 * purchase is reconstructed.
 *
 * `quote` is the full `PriceQuote` including its mandatory trace, so the order can
 * always answer "why this number" — the question the legacy system cannot answer for
 * any of its prices. It is `jsonb` because it is a document read as a whole and never
 * queried by its parts.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    state: text('state').notNull().default('DRAFT'),
    /**
     * What this order is FOR, and the column settlement dispatches on.
     *
     * `PaymentService.confirmAndSettle` used to end in an unconditional
     * `planForSettledOrder`, so every settled order wrote a service and a `PROVISION`.
     * A renewal is a NEW order against the SAME service — `services.order_id` says so —
     * and through that path it would have settled and then created a SECOND provider
     * account. `services_tenant_order_key` does not catch it: the index is unique on
     * `(tenant_id, order_id)` and a renewal has its own order id.
     *
     * The DEFAULT is what makes this expand-only. The release running beside this one
     * during a rolling update writes orders without the column and gets `NEW_SERVICE`,
     * which is exactly the behaviour it already had —
     * `migration-compatibility.test.ts` requires that and would fail a NOT NULL with no
     * default.
     *
     * WHICH service a commercial order acts on is not here. It is on
     * `service_commercial_actions`, one row per commercial order, declared after
     * `services` so that it can carry the CUSTOMER in both of its references — an order
     * that named service A while claiming customer B is the bypass
     * `orders_tenant_id_customer_key` describes, in the direction that puts a renewal
     * somebody paid for onto another account. A column here could not express that: it
     * would have to point back at a table that already points at this one, and a
     * composite foreign key cannot be written in either direction of a cycle.
     */
    purpose: text('purpose').notNull().default('NEW_SERVICE'),
    /**
     * Where the order came from (Migration P3, `ORDER_ORIGINS`). Orthogonal to `purpose`.
     *
     * `STANDARD` by default, so every row that existed before the column, and every writer
     * that does not name it, is an ordinary order — the backfill is the default itself.
     * `LEGACY_ADOPTION` represents a provider account the legacy bot sold, adopted into
     * NEXA; `orders_legacy_adoption_shape_check` pins what such an order may be, and
     * migration 0188 makes the column immutable once written. Never a sale (see
     * `SALE_ORDER_ORIGINS`).
     */
    origin: text('origin').notNull().default('STANDARD'),

    /**
     * Navigation only. The snapshot below is the truth about this purchase.
     *
     * NULL for a `CUSTOM_SERVICE` order and only for one (Package D,
     * `orders_product_purpose_check`): a custom service is bought from a location and
     * the operator's range rules, never from a product, and naming one would be the
     * invisible product the brief forbids.
     */
    productId: uuid('product_id'),
    panelId: uuid('panel_id').notNull(),
    lineTitle: text('line_title').notNull(),
    lineDurationDays: integer('line_duration_days').notNull(),
    /**
     * R1: a trial's length in HOURS, and set on a `TRIAL` order only
     * (`orders_trial_hours_check`).
     *
     * A per-panel trial is configured in hours — 72, or 12 — and a day count cannot say
     * 12. When present it is what the provisioner computes the expiry from;
     * `line_duration_days` beside it carries the same length rounded UP to whole days,
     * so every reader that knows only days — a report, the release before this one
     * picking up a trial during a rolling update — reads a limited plan of about the
     * right size rather than a zero that means unlimited. Frozen at confirmation with
     * the rest of the line (`nexa_orders_snapshot_guard`).
     */
    lineDurationHours: integer('line_duration_hours'),
    lineTrafficBytes: bigint('line_traffic_bytes', { mode: 'bigint' }).notNull(),
    lineDeviceLimit: integer('line_device_limit'),
    lineUnitPriceAmount: bigint('line_unit_price_amount', { mode: 'bigint' }).notNull(),
    lineQuantity: integer('line_quantity').notNull().default(1),

    /*
     * The category this order was bought from, snapshotted — and NULLABLE, where every
     * other `line_*` column is NOT NULL.
     *
     * The nullability is the whole point and it is a decision, not a convenience. Orders
     * placed before categories existed have no category, and the owner's instruction is
     * that they must not be given one: a product's category TODAY is not evidence of
     * what a customer browsed months ago, so migration 0097 adds these columns and
     * backfills NOTHING. A null here means UNKNOWN, never "uncategorised".
     *
     * That is also why there is no `line_category_id` foreign key. The category may
     * since have been deleted — deletion is permitted for an EMPTY category — and a
     * reference would either block that deletion or cascade the order's history away.
     * The id is kept for navigation on the same terms as `product_id`: the name and
     * emoji beside it are the truth about the purchase.
     *
     * No CHECK ties the three together. A half-written snapshot is impossible because
     * one statement writes all three at confirmation, and a CHECK requiring
     * `(id IS NULL) = (name IS NULL)` would have to be satisfied by every pre-existing
     * row — which it is, all three being null — but would then forbid the only shape a
     * future reader might legitimately need: an id whose display text was redacted.
     */
    lineCategoryId: uuid('line_category_id'),
    /** The category's name as it read at confirmation. Null on a pre-WP5 order. */
    lineCategoryName: text('line_category_name'),
    /** Its emoji as it read at confirmation. Null when absent AND when unknown. */
    lineCategoryEmoji: text('line_category_emoji'),

    subtotalAmount: bigint('subtotal_amount', { mode: 'bigint' }).notNull(),
    discountAmount: bigint('discount_amount', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    totalAmount: bigint('total_amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    /** The full quote with its trace. A quote without one is refused by the contract. */
    quote: jsonb('quote').notNull(),
    /** Normalised upper case, or null. At most one per order (`MAX_DISCOUNT_CODES_PER_ORDER`). */
    discountCode: text('discount_code'),

    expiresAt: timestamptz('expires_at'),
    confirmedAt: timestamptz('confirmed_at'),
    settledAt: timestamptz('settled_at'),
    cancelledAt: timestamptz('cancelled_at'),
    refundedAt: timestamptz('refunded_at'),
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
    ...recordSourceChecks('orders', table),
    ...publicCodeChecks('orders'),
    check(
      'orders_source_surface_check',
      sql`source_surface IS NULL OR ${enumCheck('source_surface', SOURCE_SURFACES)}`,
    ),
    /** A child row may not name a customer of another tenant. */
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'orders_customer_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
      name: 'orders_product_fk',
    }),
    index('orders_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
    index('orders_tenant_state_idx').on(table.tenantId, table.state),
    index('orders_customer_created_idx').on(table.customerId, table.createdAt, table.id),
    /** The expiry sweeper's only path: unpaid orders, oldest deadline first. */
    index('orders_expiry_idx')
      .on(table.expiresAt)
      .where(sql`state = 'AWAITING_PAYMENT'`),
    check('orders_state_check', enumCheck('state', ORDER_STATES)),
    check('orders_currency_check', enumCheck('currency', CURRENCY_CODES)),
    check('orders_purpose_check', enumCheck('purpose', ORDER_PURPOSES)),
    check('orders_origin_check', enumCheck('origin', ORDER_ORIGINS)),
    /**
     * A legacy adoption (Migration P3) is a NEW_SERVICE that is already PAID, for nothing,
     * with no code.
     *
     * NEW_SERVICE is the registered decision (no invented purpose). PAID and only PAID:
     * the service exists already, so the order is settled at birth and can never become
     * REFUNDED — there is no money of this installation's to give back. Free: the legacy
     * bot took the money, so no amount here can surface in any total, whichever query
     * forgets the origin. No discount code: nothing was quoted. The half of the rule that
     * survives a direct write, as `orders_trial_is_free_check` is for a trial.
     */
    check(
      'orders_legacy_adoption_shape_check',
      sql`origin <> 'LEGACY_ADOPTION' OR (purpose = 'NEW_SERVICE' AND state = 'PAID'
          AND subtotal_amount = 0 AND discount_amount = 0 AND total_amount = 0
          AND discount_code IS NULL)`,
    ),
    /**
     * A Mirza invoice carried as history (owner decision 2026-10-17) is a Mirza row, with no
     * NEXA code, and ended (PAID, CANCELLED, EXPIRED or REFUNDED), so no lane ever settles,
     * expires or refunds it.
     */
    check(
      'orders_legacy_history_shape_check',
      sql`origin <> 'LEGACY_HISTORY' OR (source = 'MIRZA' AND discount_code IS NULL
          AND state IN ('PAID', 'CANCELLED', 'EXPIRED', 'REFUNDED'))`,
    ),
    /**
     * What the line snapshot MEANS, per purpose, as a constraint rather than a comment.
     *
     * Zero is `UNLIMITED_TRAFFIC_BYTES` and `UNLIMITED_DURATION_DAYS` on a product
     * snapshot, and on a quantity purchase the same zero has to mean "no time was
     * bought" instead. That overload is a real trap for a reader, so the shape is
     * pinned: an `ADD_TRAFFIC` order carries positive bytes and zero days, an `ADD_TIME`
     * order the reverse, and neither can be written the other way round. `NEW_SERVICE`
     * and `RENEW` are unconstrained here — both carry a product specification, where
     * zero keeps its usual meaning.
     */
    /**
     * A trial is free, in the database too.
     *
     * The order machine's `GRANT` edge admits only a zero-total `TRIAL`
     * (`orderIsFreeTrial`), and that guard lives in the application. This is the half
     * that survives a direct write: no `TRIAL` order can carry a price, so no code path
     * — present or future — can turn the free edge into a way to charge somebody.
     */
    check('orders_trial_is_free_check', sql`purpose <> 'TRIAL' OR total_amount = 0`),
    /**
     * A custom service names no product, and every other purpose names one (Package D) —
     * except a trial, which names one when the release before R1 issued it from
     * `trial.product_id` and none when it was issued from a panel's trial configuration.
     */
    check(
      'orders_product_purpose_check',
      sql`purpose = 'TRIAL' OR (product_id IS NULL) = (purpose = 'CUSTOM_SERVICE')`,
    ),
    /** R1: hours are a trial's, positive and bounded; no other purpose carries them. */
    check(
      'orders_trial_hours_check',
      sql`line_duration_hours IS NULL OR (purpose = 'TRIAL' AND line_duration_hours BETWEEN 1 AND 720)`,
    ),
    /**
     * A custom service is a positive volume for a positive number of days, bought once.
     * Zero means "unlimited" on a product snapshot; a customer cannot type an unlimited
     * custom service, so the overload is refused here rather than read.
     */
    check(
      'orders_custom_service_line_check',
      sql`purpose <> 'CUSTOM_SERVICE'
          OR (line_traffic_bytes > 0 AND line_duration_days > 0 AND line_quantity = 1)`,
    ),
    /*
     * `CHANGE_LOCATION` (WP-A6) buys neither bytes nor days nor devices — one move, at the
     * configured target's price; the zeros are "nothing of this was bought", never the
     * product snapshot's "unlimited".
     *
     * `ADD_DEVICES` (WP-A5) buys neither bytes nor days: its line is `line_quantity`
     * devices at `line_unit_price_amount` each, and `line_device_limit` is the TARGET the
     * quote promised — the limit then in force plus the quantity, so always above it.
     */
    check(
      'orders_quantity_line_check',
      sql`purpose NOT IN ('ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION')
          OR (purpose = 'ADD_TRAFFIC' AND line_traffic_bytes > 0 AND line_duration_days = 0)
          OR (purpose = 'ADD_TIME' AND line_duration_days > 0 AND line_traffic_bytes = 0)
          OR (purpose = 'ADD_DEVICES' AND line_traffic_bytes = 0 AND line_duration_days = 0
              AND line_device_limit IS NOT NULL AND line_device_limit > line_quantity)
          OR (purpose = 'CHANGE_LOCATION' AND line_traffic_bytes = 0 AND line_duration_days = 0
              AND line_device_limit IS NULL AND line_quantity = 1)`,
    ),
    /**
     * A total is never negative, and the parts agree with the whole.
     *
     * `clampDiscount` enforces the first in the application; this is the half that
     * survives a direct write and a future code path that forgets.
     */
    check(
      'orders_amounts_check',
      sql`subtotal_amount >= 0 AND discount_amount >= 0 AND total_amount >= 0`,
    ),
    check('orders_total_consistent_check', sql`total_amount = subtotal_amount - discount_amount`),
    check('orders_discount_bounded_check', sql`discount_amount <= subtotal_amount`),
    check('orders_quantity_check', sql`line_quantity >= 1`),
    /** Each lifecycle timestamp exists exactly when its state has been reached. */
    /*
     * Built from `ORDER_SETTLED_STATES`, not from a list typed out here.
     *
     * The contract's own predicate for "the money for this order arrived", so a
     * reconciliation query and this constraint cannot come to disagree about which
     * states that is — and a state added to one without the other fails the drift
     * check rather than quietly excluding revenue from a report.
     */
    check(
      'orders_settled_at_check',
      // Through `enumCheck`, which is the codebase's one `sql.raw` and the only
      // form that reaches the generated migration as LITERALS. A `sql` template
      // with parameters generates `state IN ($1, $2, $3)` into the DDL, which is
      // a constraint no database will ever evaluate the way it reads.
      sql`(${enumCheck('state', ORDER_SETTLED_STATES)}) = (settled_at IS NOT NULL)`,
    ),
    check('orders_refunded_at_check', sql`(state = 'REFUNDED') = (refunded_at IS NOT NULL)`),
    check('orders_cancelled_at_check', sql`(state = 'CANCELLED') = (cancelled_at IS NOT NULL)`),
    unique('orders_tenant_id_key').on(table.tenantId, table.id),
    /**
     * Redundant against the primary key, and the target of a CUSTOMER-bearing
     * composite reference.
     *
     * `payments`, `services` and `discount_redemptions` each carry their own
     * `customer_id` beside an `order_id`, and a two-column `(tenant_id, order_id)`
     * foreign key lets a child row name order A while claiming customer B. Every one of
     * those is a real bypass: a payment that settles another customer's order, a service
     * that appears in the wrong customer's list, and — the one that motivated this — a
     * discount redemption whose `(discount_id, customer_id)` pair is a fiction, which
     * makes a per-customer redemption limit advisory rather than enforced.
     *
     * So the children reference `(tenant_id, id, customer_id)` and the agreement becomes
     * impossible to express rather than merely unlikely. Found by the automated security
     * review of the schema commit, which is exactly the class of thing a reviewer sees
     * and an author does not: each FK looked correct on its own.
     */
    unique('orders_tenant_id_customer_key').on(table.tenantId, table.id, table.customerId),
  ],
);

/**
 * What a custom order was priced by, written ONCE in the draft's transaction (brief D6).
 *
 * Rule ids are copied, not foreign keys, and a trigger refuses UPDATE and DELETE: editing
 * or deleting a rule later rewrites nothing here. The CHECKs pin the arithmetic, so a
 * stored row cannot say one price and mean another.
 */
/**
 * Phase C3: why a new-service order landed on the panel it did.
 *
 * One row per order that automatic balancing CONSIDERED — the flag on and the product's
 * panel in a group — written in the draft's own transaction and never changed (a trigger
 * refuses UPDATE). An order with no row went to its product's own panel by the explicit
 * route. `candidates` is the ranked group as the decision saw it, figures included, so the
 * explanation is what was decided and not a re-reading of today's load.
 */
export const orderPanelPlacements = pgTable(
  'order_panel_placements',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    homePanelId: uuid('home_panel_id').notNull(),
    chosenPanelId: uuid('chosen_panel_id').notNull(),
    balancingGroup: text('balancing_group').notNull(),
    strategy: text('strategy').notNull(),
    decidedBy: text('decided_by').notNull(),
    candidates: jsonb('candidates').notNull(),
    decidedAt: timestamptz('decided_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.orderId], name: 'order_panel_placements_pk' }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'order_panel_placements_order_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.homePanelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'order_panel_placements_home_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.chosenPanelId],
      foreignColumns: [panels.tenantId, panels.id],
      name: 'order_panel_placements_chosen_fk',
    }),
    check(
      'order_panel_placements_strategy_check',
      enumCheck('strategy', PANEL_BALANCING_STRATEGIES),
    ),
    check(
      'order_panel_placements_decided_by_check',
      enumCheck('decided_by', PANEL_PLACEMENT_DECIDERS),
    ),
    check(
      'order_panel_placements_candidates_check',
      sql`jsonb_typeof(${table.candidates}) = 'array'`,
    ),
  ],
);
