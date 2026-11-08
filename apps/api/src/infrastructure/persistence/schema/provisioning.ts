/**
 * Database schema — provisioning: provisioning operations and their admin cards.
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
  PROVIDER_FAILURE_KINDS,
  OPERATION_STATES,
  OPERATION_TYPES,
  SERVICE_LOCATION_KEY_MAX_LENGTH,
} from '@nexa/contracts';
import { enumCheck, nullableEnumCheck, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';
import { customers } from './customers.js';
import { orders } from './orders.js';
import { services } from './services.js';

/**
 * One attempt at one external effect.
 *
 * `operation_id` is the 16-hex value DERIVED from the idempotency key under the
 * `provider` namespace, and it is unique per tenant. That is what makes the whole design
 * work: two workers retrying one command derive the same id with no lookup, so the
 * second insert loses on this index rather than starting a second provider call.
 *
 * `call_started_at` is the column that decides whether a crashed operation may be
 * released. Set immediately BEFORE the provider call and committed on its own — so if
 * the process dies during the call, the row says a call was started and the lease expiry
 * must not hand it to another worker as though nothing had happened.
 */
export const provisioningOperations = pgTable(
  'provisioning_operations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Derived, never generated. 16 lowercase hex characters. */
    operationId: text('operation_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    /** Null for an operation not caused by an order — a reconcile, a usage sync. */
    orderId: uuid('order_id'),
    /**
     * The customer who ASKED for this, or NULL when nobody did.
     *
     * Phase 6A, and it exists because the customer notification lane needs to tell
     * "the thing you asked for happened" from "an operator changed your service".
     * Before the operator action path there was no difference to record: `SUSPEND`,
     * `RESUME` and `TERMINATE` could only be reached from the customer's own detail
     * screen, so `CUSTOMER_REQUESTABLE_OPERATIONS` could decide the announcement from
     * the TYPE alone. It cannot any more — an operator suspend is the same type —
     * and deciding from the type would tell a customer their own request succeeded
     * when they made none, or invite them to retry a terminate an operator ordered.
     *
     * NULL is the honest value for everything a person did not ask for: a reconcile,
     * a usage sync, the retry of a lost create, and every operator action. An operator
     * IS recorded — in the audit row `planRequestedOperation` writes, where the actor
     * names the person. This column answers a narrower question: is a customer owed a
     * sentence about the outcome.
     */
    requestedByCustomerId: uuid('requested_by_customer_id'),
    panelId: uuid('panel_id').notNull(),
    type: text('type').notNull(),
    state: text('state').notNull().default('PLANNED'),
    attempts: integer('attempts').notNull().default(0),
    /**
     * The earliest a claim may take this row. Null means now.
     *
     * Backoff, and the reason it is a column rather than a sleep: the retry delay has to
     * survive the process that decided it. Without this a `FAILED` attempt is re-claimed
     * on the very next tick, which is a hot loop of authentication attempts against
     * somebody else's panel — and 3X-UI blocks an IP-and-username pair after enough of
     * them, so the loop ends by locking the installation out of its own provider.
     */
    nextAttemptAt: timestamptz('next_attempt_at'),
    /** Who holds the claim, and until when. Both null when unclaimed. */
    claimedBy: text('claimed_by'),
    leaseUntil: timestamptz('lease_until'),
    /**
     * Set before the provider call and committed separately.
     *
     * The one fact that distinguishes "a worker died before calling" from "a worker died
     * during a call", and therefore the one fact that decides whether a release is safe.
     */
    callStartedAt: timestamptz('call_started_at'),
    /**
     * What this operation is trying to make TRUE on the panel.
     *
     * Absolute, and written once — in the transaction that settles the order that bought
     * it — rather than computed when the worker runs. That placement is the whole reason
     * `RENEW`, `ADD_TRAFFIC` and `ADD_TIME` may sit in `IDEMPOTENT_MUTATIONS`: a target
     * derived at execution time from whatever the panel currently holds would differ
     * between the first attempt and its replay, and the arithmetic would compound into a
     * customer receiving two renewals for one payment. A stored target replays to the
     * same two numbers for ever.
     *
     * NULL means this operation did not BUY that field, and the provider call omits the
     * key — which the pinned Marzban treats as no change rather than as a reset
     * (`scripts/marzban-allowance-check.sh`, row 3). So an `ADD_TIME` carries an expiry
     * and no limit, an `ADD_TRAFFIC` the reverse, and a `RENEW` both.
     *
     * NULL is NOT "unlimited". Unlimited traffic is zero, the same sentinel
     * `services.traffic_limit_bytes` and `products.traffic_bytes` already use.
     */
    targetExpiresAt: timestamptz('target_expires_at'),
    targetTrafficLimitBytes: bigint('target_traffic_limit_bytes', { mode: 'bigint' }),
    /**
     * WP-A5: the absolute device / connection limit an `ADD_DEVICES` should leave the
     * account at. Set for that type and only that type, and alone: an `ADD_DEVICES` carries
     * no expiry and no allowance, and nothing else carries a device limit.
     */
    targetDeviceLimit: integer('target_device_limit'),
    /**
     * WP-A6: the adapter-defined location key a `CHANGE_LOCATION` should leave the account
     * in. Set for that type and only that type, and alone — a move buys no time, no
     * allowance and no devices, and nothing else moves an account.
     */
    targetLocationKey: text('target_location_key'),
    /** The provider's own reference for the effect, when it gave one. */
    providerReference: text('provider_reference'),
    /** A kind from the EXISTING provider taxonomy. Never a new vocabulary. */
    failureKind: text('failure_kind'),
    /** Bounded, redacted diagnostic. Never a raw provider response. */
    failureMessage: text('failure_message'),
    completedAt: timestamptz('completed_at'),
    /**
     * When the customer was answered about this operation — or NULL, meaning
     * nobody has answered for it yet.
     *
     * This is the claim surface for the sweep that closes the crash window
     * `docs/phase4j-audit.md` names: the executor terminalises an operation in
     * one transaction and `OperationOutcomeAnnouncer.announce` enqueues the
     * message in the NEXT one, and a process that dies between them leaves an
     * operation that is terminal, un-announced, and that nothing will ever call
     * `announce` for again. The loop has moved on and there is exactly one call
     * site.
     *
     * NULL means UNANSWERED, never "no answer was owed". The announcer stamps
     * this even when it decides the operation says nothing — a `SYNC_USAGE`, a
     * `PROVISION` whose link goes out through `DeliveryService` — because a row
     * left NULL is a row the sweep re-reads for ever. The one exit that must NOT
     * stamp is a state that is not terminal: a `FAILED` with attempts left goes
     * back to `PLANNED`, and marking it answered before it has finished is the
     * same silence from the other direction.
     *
     * Deliberately NOT part of `provisioning_operations_completed_check`. That
     * constraint binds the terminal states to `completed_at`; binding this one
     * too would make the stamp a property of the STATE rather than of whether
     * anybody has spoken, and the whole point is that those are different facts
     * that a crash can separate.
     */
    announcedAt: timestamptz('announced_at'),
    /**
     * When the panel answered THIS PROVISION's create with a success whose follow-up
     * then failed — a read-back lost, a record with no usable link (WP15 G7).
     *
     * The one durable provenance a later RECONCILE may adopt on. A lookup that finds
     * the username proves only that the NAME exists; an account made by somebody else
     * answers it the same way. Null on every other type, and on a create that timed
     * out, 5xx'd or was refused, because none of those says the panel acted.
     */
    createAcceptedAt: timestamptz('create_accepted_at'),
    /**
     * When THIS RECONCILE first read the account as absent (WP15 G3).
     *
     * A panel that accepted a create may not show it on the next read. One absence is
     * therefore UNDECIDED, and only a second one, a backoff later, re-plans the create.
     */
    absenceObservedAt: timestamptz('absence_observed_at'),
    /**
     * How many verification READS an ambiguous commercial write has had (WP15 G2).
     *
     * Bounded, and separate from `attempts`, which counts WRITES: a RENEW whose answer
     * was lost is never sent again by this path, only looked at.
     */
    verificationAttempts: integer('verification_attempts').notNull().default(0),
    /**
     * Migration P1 (H5): this row is SCHEDULED housekeeping — a usage read nobody asked
     * for, planned by the provisioner's own sweep — and nothing else.
     *
     * The claim orders every non-background row ahead of every background one, and the
     * executor spends the tenant budget for a background row only above a floor. Both
     * read THIS column, never `type` plus `requested_by_customer_id`: an operator's sync
     * has no customer either, and inferring "background" from the absence of one demoted
     * an operator's explicit request behind a migration-sized backlog.
     *
     * FALSE by default, which is the safe direction: a writer that forgets the column
     * plans work at full priority, never paid work at housekeeping priority. And the
     * CHECK below makes "a background PROVISION" unrepresentable, so no future writer can
     * demote money-bearing work by setting it.
     */
    background: boolean('background').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
      name: 'provisioning_operations_service_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
      name: 'provisioning_operations_order_fk',
    }),
    /** A child row may not name a customer of another tenant. */
    foreignKey({
      columns: [table.tenantId, table.requestedByCustomerId],
      foreignColumns: [customers.tenantId, customers.id],
      name: 'provisioning_operations_requested_by_fk',
    }),
    /** The derivation's whole purpose: a retry collides here instead of calling twice. */
    uniqueIndex('provisioning_operations_tenant_operation_key').on(
      table.tenantId,
      table.operationId,
    ),
    /**
     * The worker's claim scan: due work, oldest first, nothing else read.
     *
     * Leads with `next_attempt_at` because that is what the scan filters on; a row whose
     * backoff has not elapsed is not due, and ordering by creation date alone would put
     * the oldest permanently-failing operation at the front of every tick.
     */
    /*
     * Migration P1: led by `background`, the claim's FIRST ordering key, so the scan
     * reads interactive work first and reaches the background backlog only when none is
     * due — a backlog of thousands of scheduled reads is never sorted to find one paid
     * create. `next_attempt_at` is NULLS FIRST here because the claim orders it so.
     */
    index('provisioning_operations_due_idx')
      .on(table.tenantId, table.background, table.nextAttemptAt.asc().nullsFirst(), table.createdAt)
      .where(sql`state = 'PLANNED'`),
    /**
     * Migration P1: at most ONE open scheduled usage read per service.
     *
     * The sweep already skips a service with an open read; this is the same rule for two
     * provisioner replicas planning in the same instant, where a read-then-write loses.
     * Only background rows: a customer's or an operator's own read may sit beside a
     * scheduled one, and the executor abandons the scheduled one, unspent, once the
     * figure is fresher than it.
     */
    uniqueIndex('provisioning_operations_open_background_sync_key')
      .on(table.tenantId, table.serviceId)
      .where(sql`background AND state IN ('PLANNED', 'IN_FLIGHT')`),
    /** Expired leases, for the release sweep. */
    index('provisioning_operations_lease_idx')
      .on(table.leaseUntil)
      .where(sql`state = 'IN_FLIGHT'`),
    index('provisioning_operations_service_idx').on(table.serviceId, table.createdAt, table.id),
    /**
     * ONE open PROVISION per service, enforced by the database rather than by a check.
     *
     * "One at a time is a partial unique index, not a process" — the rule CLAUDE.md
     * states about backups, applied to the operation that spends a customer's money on
     * somebody else's panel. Two open creates for one service means two provider calls;
     * the derived username makes the second collide rather than duplicate the account,
     * but a collision is a `PROVIDER_ERROR`, which classifies UNKNOWN on a mutating
     * call, which strands the service in `UNRECONCILED`. So a double-click on the
     * operator's retry button corrupted a service it was meant to rescue.
     *
     * Only the two NON-TERMINAL states, so the ordinary sequence still works: a create
     * that FAILED may be retried, and the re-plan after a provably-absent reconcile is
     * legal because the operation it follows is `UNKNOWN`. `SUCCEEDED` is excluded for
     * the same reason — a renewal is a different operation type.
     */
    uniqueIndex('provisioning_operations_open_provision_key')
      .on(table.tenantId, table.serviceId)
      .where(sql`type = 'PROVISION' AND state IN ('PLANNED', 'IN_FLIGHT')`),
    /**
     * ONE open COMMERCIAL action per service, for the reason the PROVISION index above
     * exists and a different failure than the one it prevents.
     *
     * A commercial target is ABSOLUTE and is computed once, in the transaction that
     * settles the order, from the service as it stood when the money moved. Two
     * purchases that settle before the first reaches the panel therefore read the same
     * allowance and plan the same number: two five-gigabyte packages against a
     * ten-gigabyte service each plan FIFTEEN, both are charged, and the account ends
     * where one purchase would have left it.
     *
     * `claimDue` already refuses to run two operations for one service at once, and
     * that is not this: serialising EXECUTION does not help when both rows were
     * computed from the same reading. The refusal has to be at PLAN time, which is why
     * it is an index rather than a check in a service — two API replicas settling two
     * orders in the same instant is exactly the case a read-then-write loses.
     *
     * All three types together rather than one index each: a renewal's target is
     * computed from the same two columns an add-on's is, so a renewal in flight
     * interferes with a top-up exactly as another top-up would.
     *
     * The two NON-TERMINAL states only, as above. A `FAILED` action has written nothing
     * to the service, so the next purchase reads an unchanged row and is safe.
     */
    /*
     * UNKNOWN is OPEN here (WP15 G2). A commercial write whose answer was lost is being
     * verified, and a second purchase computed from the service's un-updated allowance
     * would target the same absolute value — the customer charged twice for one extension.
     */
    uniqueIndex('provisioning_operations_open_commercial_key')
      .on(table.tenantId, table.serviceId)
      .where(
        sql`type IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION') AND state IN ('PLANNED', 'IN_FLIGHT', 'UNKNOWN')`,
      ),
    index('provisioning_operations_unknown_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`state = 'UNKNOWN'`),
    check('provisioning_operations_state_check', enumCheck('state', OPERATION_STATES)),
    check('provisioning_operations_type_check', enumCheck('type', OPERATION_TYPES)),
    /*
     * Migration P1: only a scheduled usage READ can be background. Paid, commercial,
     * management and reconcile work can never be demoted by this column, and a row a
     * customer asked for can never be treated as nobody's.
     */
    check(
      'provisioning_operations_background_check',
      sql`NOT background OR (type = 'SYNC_USAGE' AND requested_by_customer_id IS NULL)`,
    ),
    check(
      'provisioning_operations_failure_kind_check',
      nullableEnumCheck('failure_kind', PROVIDER_FAILURE_KINDS),
    ),
    check('provisioning_operations_operation_id_check', sql`operation_id ~ '^[0-9a-f]{16}$'`),
    /**
     * Only a commercial operation may carry a target.
     *
     * A `SUSPEND` with a desired expiry is a row nothing reads and the next reviewer has
     * to decide the meaning of — and the reading they would reach for, that the suspend
     * should also set it, is the one that would silently widen what a management action
     * does. Refused here so it cannot be written at all.
     */
    check(
      'provisioning_operations_target_check',
      sql`type IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION')
          OR (target_expires_at IS NULL AND target_traffic_limit_bytes IS NULL AND target_device_limit IS NULL
              AND target_location_key IS NULL)`,
    ),
    /**
     * WP-A5: a device limit is an `ADD_DEVICES` target and only one, and an `ADD_DEVICES`
     * carries nothing else — so a raise can never be read as a renewal, nor a renewal be
     * made to change how many devices an account allows.
     */
    check(
      'provisioning_operations_target_device_check',
      sql`(type = 'ADD_DEVICES'
           AND target_device_limit IS NOT NULL AND target_device_limit >= 1 AND target_device_limit <= 1000
           AND target_expires_at IS NULL AND target_traffic_limit_bytes IS NULL)
          OR (type <> 'ADD_DEVICES' AND target_device_limit IS NULL)`,
    ),
    /**
     * WP-A6: a location key is a `CHANGE_LOCATION` target and only one, and a
     * `CHANGE_LOCATION` carries nothing else — a move can never be read as a renewal, nor a
     * renewal made to move an account.
     */
    check(
      'provisioning_operations_target_location_check',
      sql`(type = 'CHANGE_LOCATION'
           AND target_location_key IS NOT NULL
           AND length(target_location_key) BETWEEN 1 AND ${sql.raw(String(SERVICE_LOCATION_KEY_MAX_LENGTH))}
           AND target_expires_at IS NULL AND target_traffic_limit_bytes IS NULL AND target_device_limit IS NULL)
          OR (type <> 'CHANGE_LOCATION' AND target_location_key IS NULL)`,
    ),
    /**
     * And a commercial operation must carry at least one, or it asks the panel for
     * nothing while an order records that a customer paid for something.
     */
    check(
      'provisioning_operations_target_present_check',
      sql`type NOT IN ('RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION')
          OR target_expires_at IS NOT NULL
          OR target_traffic_limit_bytes IS NOT NULL
          OR target_device_limit IS NOT NULL
          OR target_location_key IS NOT NULL`,
    ),
    check(
      'provisioning_operations_target_traffic_check',
      sql`target_traffic_limit_bytes IS NULL OR target_traffic_limit_bytes >= 0`,
    ),
    check('provisioning_operations_attempts_check', sql`attempts >= 0 AND attempts <= 100`),
    check(
      'provisioning_operations_verification_attempts_check',
      sql`verification_attempts >= 0 AND verification_attempts <= 100`,
    ),
    check(
      'provisioning_operations_create_accepted_check',
      sql`create_accepted_at IS NULL OR type = 'PROVISION'`,
    ),
    check(
      'provisioning_operations_absence_observed_check',
      sql`absence_observed_at IS NULL OR type = 'RECONCILE'`,
    ),
    /** A claim is a holder AND a deadline, together or not at all. */
    check('provisioning_operations_claim_check', sql`(claimed_by IS NULL) = (lease_until IS NULL)`),
    /** Terminal states have a completion time; live ones do not. */
    check(
      'provisioning_operations_completed_check',
      sql`(state IN ('SUCCEEDED', 'FAILED', 'ABANDONED')) = (completed_at IS NOT NULL)`,
    ),
    unique('provisioning_operations_tenant_id_key').on(table.tenantId, table.id),
  ],
);

/**
 * R3 (v0.3.5 real-test fixes, item 10): the service card a customer's request was made
 * from, so the result can be shown ON that card.
 *
 * A disable or an enable is an operation the provisioner performs later, in another
 * process; the tap that asked for it is long answered by then. This row is how the
 * provisioner knows which Telegram message to edit: the chat and message the tap came
 * from, and the bot that drew it (a `message_id` is only meaningful to that bot, and a
 * reply from a different bot leaks the relationship between them — `CustomerMessage`).
 *
 * One row per operation, written in the SAME transaction that plans it — only when it
 * is newly planned, so a double tap keeps the first card — and never changed except by
 * `answered_at`. Nothing here is a secret: a chat id and a message number.
 *
 * `answered_at` is the told-once claim. Stamped by a conditional UPDATE before the edit
 * is sent, so two provisioner replicas cannot both edit (or both fall back to sending
 * the card); released only for a 429, which is Telegram declining to look at the edit.
 */
export const operationCardMessages = pgTable(
  'operation_card_messages',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** `provisioning_operations.id` — the row, not the derived `operation_id`. */
    operationId: uuid('operation_id').notNull(),
    botInstanceId: uuid('bot_instance_id').notNull(),
    chatId: text('chat_id').notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    answeredAt: timestamptz('answered_at'),
    /**
     * The earliest the card may be claimed again, after Telegram answered 429 — its own
     * `retry_after`, bounded, or a floor when it gave none. NULL means now.
     */
    nextAttemptAt: timestamptz('next_attempt_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'operation_card_messages_pkey',
      columns: [table.tenantId, table.operationId],
    }),
    foreignKey({
      columns: [table.tenantId, table.operationId],
      foreignColumns: [provisioningOperations.tenantId, provisioningOperations.id],
      name: 'operation_card_messages_operation_fk',
    }),
    /** The sweep's claim surface: cards nobody has answered for, oldest first. */
    index('operation_card_messages_unanswered_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`answered_at IS NULL`),
    check('operation_card_messages_message_id_check', sql`message_id > 0`),
    check('operation_card_messages_chat_id_check', sql`chat_id ~ '^-?[0-9]{1,20}$'`),
  ],
);
