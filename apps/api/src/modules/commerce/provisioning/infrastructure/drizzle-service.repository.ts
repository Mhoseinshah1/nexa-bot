import { and, asc, eq, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type {
  OrderId,
  PanelId,
  ProductId,
  ServiceDeliveryState,
  ServiceState,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { customers, services } from '../../../../infrastructure/persistence/schema.js';
import type {
  ProvisionOutcome,
  ServiceCursor,
  ServiceDraft,
  ServicePage,
  ServiceRecord,
  ServiceRepository,
  ServiceSearch,
} from '../application/ports.js';

type Row = typeof services.$inferSelect;

function toRecord(row: Row): ServiceRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    customerId: row.customerId as UserId,
    orderId: row.orderId as OrderId,
    panelId: row.panelId as PanelId,
    productId: row.productId as ProductId,
    state: row.state as ServiceState,
    providerUsername: row.providerUsername,
    subscriptionRef: row.subscriptionRef,
    providerClientId: row.providerClientId,
    providerUserId: row.providerUserId,
    subscriptionUrl: row.subscriptionUrl,
    expiresAt: row.expiresAt,
    trafficLimitBytes: row.trafficLimitBytes,
    trafficUsedBytes: row.trafficUsedBytes,
    usageSyncedAt: row.usageSyncedAt,
    deliveryState: row.deliveryState as ServiceDeliveryState,
    deliveryAttempts: row.deliveryAttempts,
    deliveredAt: row.deliveredAt,
    deliveryNextAttemptAt: row.deliveryNextAttemptAt,
    deliverySendStartedAt: row.deliverySendStartedAt,
    provisionedAt: row.provisionedAt,
    terminatedAt: row.terminatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Services, in PostgreSQL.
 *
 * Every query carries `eq(services.tenantId, …)`, primary-key lookups included, for
 * the reason every other repository here states: a lookup without the tenant returns
 * another tenant's row and leaves the caller holding something it should never have
 * seen. On this table that row is a subscription URL, which is a bearer capability.
 */
export class DrizzleServiceRepository implements ServiceRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /**
   * Writes the service a settled order produced, or reports that one already exists.
   *
   * `ON CONFLICT DO NOTHING` against `services_tenant_order_key`, and a null return
   * when it fired. Losing is a NORMAL outcome of a correct system — a replayed
   * settlement, a second replica, a double-tapped button — so it is reported as a
   * value rather than thrown. The caller reads the winner's row; nothing here decides
   * which of them was first, because nothing needs to.
   */
  async create(
    scope: TenantContext,
    draft: ServiceDraft,
    now: Date,
    tx: TransactionScope,
  ): Promise<ServiceRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(services)
      .values({
        id: draft.id,
        tenantId,
        customerId: draft.customerId,
        orderId: draft.orderId,
        panelId: draft.panelId,
        productId: draft.productId,
        state: 'PENDING_PROVISION',
        providerUsername: draft.providerUsername,
        subscriptionRef: draft.subscriptionRef,
        providerClientId: draft.providerClientId,
        trafficLimitBytes: draft.trafficLimitBytes,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findById(scope: TenantContext, id: string, tx?: unknown): Promise<ServiceRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(services)
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findByOrderId(
    scope: TenantContext,
    orderId: OrderId,
    tx?: unknown,
  ): Promise<ServiceRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(services)
      .where(and(eq(services.tenantId, tenantId), eq(services.orderId, orderId)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async list(
    scope: TenantContext,
    search: ServiceSearch,
    limit: number,
    cursor: ServiceCursor | null,
    tx?: unknown,
  ): Promise<ServicePage> {
    const tenantId = requireTenantId(scope);
    const filters: SQL[] = [eq(services.tenantId, tenantId)];
    if (search.customerId !== undefined) filters.push(eq(services.customerId, search.customerId));
    if (search.panelId !== undefined) filters.push(eq(services.panelId, search.panelId));
    if (search.state !== undefined) filters.push(eq(services.state, search.state));
    if (search.deliveryState !== undefined) {
      filters.push(eq(services.deliveryState, search.deliveryState));
    }
    if (cursor !== null) {
      /*
       * Keyset, on `(created_at, id)`.
       *
       * The same shape `/panels` and `/users` already use, and for the same reason:
       * `created_at` alone is not unique, so an offset would skip or repeat a row
       * whenever two services were created in the same millisecond — which is exactly
       * what a batch settlement produces.
       */
      filters.push(
        sql`(${services.createdAt}, ${services.id}) > (${cursor.createdAt}, ${cursor.id})`,
      );
    }
    const rows = await this.exec(tx)
      .select()
      .from(services)
      .where(and(...filters))
      .orderBy(asc(services.createdAt), asc(services.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit).map(toRecord);
    const last = page.at(-1);
    return {
      items: page,
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }

  /**
   * Moves a service between two states, and reports whether the row moved.
   *
   * The outcome fields are written by the SAME statement as the state, because
   * `services_provisioned_at_check` binds them: `(state = 'PENDING_PROVISION' OR
   * state = 'UNRECONCILED') = (provisioned_at IS NULL)`. A transition that set the
   * state alone would be refused by the database, which is the point of the
   * constraint and the reason this takes a struct rather than exposing setters.
   */
  async transition(
    scope: TenantContext,
    id: string,
    from: ServiceState,
    to: ServiceState,
    outcome: ProvisionOutcome | null,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const becomingLive = to === 'ACTIVE';
    const rows = await this.exec(tx)
      .update(services)
      .set({
        state: to,
        ...(outcome === null
          ? {}
          : {
              providerUserId: outcome.providerUserId,
              subscriptionUrl: outcome.subscriptionUrl,
              expiresAt: outcome.expiresAt,
              ...(outcome.trafficUsedBytes === null
                ? {}
                : { trafficUsedBytes: outcome.trafficUsedBytes }),
              ...(outcome.usageSyncedAt === null ? {} : { usageSyncedAt: outcome.usageSyncedAt }),
            }),
        // The constraint's two halves, both written here so neither can be forgotten.
        ...(becomingLive ? { provisionedAt: now } : {}),
        ...(to === 'TERMINATED' ? { terminatedAt: now } : {}),
        updatedAt: now,
      })
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id), eq(services.state, from)))
      .returning({ id: services.id });
    return rows.length > 0;
  }

  /**
   * Records what a delivery attempt did, conditionally on the state it was tried from.
   *
   * The attempt counter advances in the same statement, by SQL rather than by a value
   * the caller computed: two workers that both read `2` and both wrote `3` would leave
   * a service one attempt short of the ceiling for ever.
   */
  async recordDelivery(
    scope: TenantContext,
    id: string,
    from: ServiceDeliveryState,
    to: ServiceDeliveryState,
    stamps: { readonly deliveredAt: Date | null; readonly nextAttemptAt: Date | null },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(services)
      .set({
        deliveryState: to,
        deliveryAttempts: sql`${services.deliveryAttempts} + 1`,
        deliveredAt: stamps.deliveredAt,
        deliveryNextAttemptAt: stamps.nextAttemptAt,
        /*
         * The send is resolved, so the "a send is in flight" stamp goes.
         *
         * Cleared by the SAME statement that records the outcome, so the two can never
         * disagree: a row with a stamp is a send nobody has accounted for, and that is
         * the only thing `reapStrandedSends` is allowed to act on.
         */
        deliverySendStartedAt: null,
        updatedAt: now,
      })
      .where(
        and(eq(services.tenantId, tenantId), eq(services.id, id), eq(services.deliveryState, from)),
      )
      .returning({ id: services.id });
    return rows.length > 0;
  }

  /**
   * Records that a send is about to be handed to Telegram, in the caller's transaction.
   *
   * `markCallStarted` for the announcement half, and the caller's obligation is the
   * same: this must commit BEFORE the send and in a transaction that holds nothing
   * else, because a crash rolling it back is exactly the case it records.
   *
   * Conditional on the delivery state the caller read AND on there being no stamp
   * already, so two sweeps or a sweep racing a customer's own re-request produce one
   * sender: the loser is told `false` and sends nothing.
   */
  async markSendStarted(
    scope: TenantContext,
    id: string,
    from: ServiceDeliveryState,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(services)
      .set({ deliverySendStartedAt: now, updatedAt: now })
      .where(
        and(
          eq(services.tenantId, tenantId),
          eq(services.id, id),
          eq(services.deliveryState, from),
          isNull(services.deliverySendStartedAt),
        ),
      )
      .returning({ id: services.id });
    return rows.length > 0;
  }

  /**
   * Resolves sends that were handed to Telegram by a process that then died.
   *
   * A stamped row whose lease has run out is a message that MAY have arrived, and the
   * rule `deliveryStateAfter` states — an unknown send is never retried automatically —
   * is the whole reason this exists. Before it, such a row stayed `PENDING` behind
   * nothing but a lease, so the next sweep announced again and an ordinary container
   * restart could send a customer their configuration twice.
   *
   * `PENDING` becomes `UNCONFIRMED`: the state that holds the fact where an operator can
   * see it, out of the automatic lane, still reachable by the customer asking. Any other
   * state simply loses the stamp — a re-request that died mid-send left one on a row
   * whose state was already settled, and clearing it is all that is owed, because the
   * automatic lane never looks at those states anyway.
   *
   * No attempt is spent either way. An attempt means an outcome somebody observed, and
   * nobody observed this one.
   */
  async reapStrandedSends(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const stranded = this.exec(tx)
      .select({ id: services.id })
      .from(services)
      .where(
        and(
          eq(services.tenantId, tenantId),
          sql`${services.deliverySendStartedAt} IS NOT NULL`,
          or(isNull(services.deliveryNextAttemptAt), lte(services.deliveryNextAttemptAt, now)),
        ),
      )
      .limit(limit);

    const rows = await this.exec(tx)
      .update(services)
      .set({
        deliveryState: sql`CASE WHEN ${services.deliveryState} = 'PENDING' THEN 'UNCONFIRMED' ELSE ${services.deliveryState} END`,
        deliveryNextAttemptAt: null,
        deliverySendStartedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(services.tenantId, tenantId),
          sql`${services.deliverySendStartedAt} IS NOT NULL`,
          or(isNull(services.deliveryNextAttemptAt), lte(services.deliveryNextAttemptAt, now)),
          sql`${services.id} IN ${stranded}`,
        ),
      )
      .returning({ id: services.id });
    return rows.length;
  }

  /**
   * Takes the services whose announcement is due, and leases them to this sweep.
   *
   * A sub-select of the candidates and a conditional UPDATE that re-checks the same
   * predicates — the shape `OperationRepository.claimDue` already uses, and for the same
   * reason. Two replicas racing the same row produce one winner: the loser blocks on the
   * row lock, re-evaluates `delivery_next_attempt_at` after the winner committed, finds
   * it in the future and updates nothing. No `SKIP LOCKED` and no advisory lock, because
   * nothing about a claim is decided in a process.
   *
   * The lease is the ONLY thing written. `delivery_attempts` is untouched here and
   * advanced by `recordDelivery`, so an attempt always means an outcome somebody saw: a
   * sweep that died holding a lease would otherwise spend one of a service's three
   * attempts on a message that was never submitted.
   *
   * `PENDING` only — `DELIVERY_AUTO_RETRY_STATES` is that one value, and the other
   * three are deliberately never swept: `DELIVERED` is done, and `UNCONFIRMED` and
   * `FAILED` both need a person, for reasons `provisioning.ts` records.
   *
   * Only ACTIVE services, because a service that has no provider account yet has
   * nothing to announce, and announcing one would be the false success this codebase
   * exists to end.
   */
  async claimDeliveryDue(
    scope: TenantContext,
    now: Date,
    leaseUntil: Date,
    limit: number,
    tx?: unknown,
  ): Promise<readonly ServiceRecord[]> {
    const tenantId = requireTenantId(scope);
    const ready = or(
      isNull(services.deliveryNextAttemptAt),
      lte(services.deliveryNextAttemptAt, now),
    );
    const due = this.exec(tx)
      .select({ id: services.id })
      .from(services)
      /*
       * Joined to the customer so a BLOCKED one is not due AT THE QUERY.
       *
       * Not checked in the sweep afterwards, and the difference matters. A service the
       * sweep picked up and then declined would either burn an attempt against the
       * ceiling — punishing a customer for a moderation decision that may be reversed
       * — or be skipped without one, which returns the same row on every tick for ever
       * and crowds out deliveries that could actually be made.
       *
       * Excluding it here means a block pauses delivery and an unblock resumes it, with
       * no attempt spent either way and nothing to remember.
       *
       * An INNER join, so a service whose customer row is somehow absent is not due
       * either: there is nobody to send to, and the composite foreign key says that
       * cannot happen anyway.
       */
      .innerJoin(
        customers,
        and(eq(customers.tenantId, services.tenantId), eq(customers.id, services.customerId)),
      )
      .where(
        and(
          eq(services.tenantId, tenantId),
          eq(services.deliveryState, 'PENDING'),
          eq(services.state, 'ACTIVE'),
          eq(customers.status, 'ACTIVE'),
          /*
           * A send nobody has accounted for is NOT due, whatever its lease says.
           *
           * `reapStrandedSends` is what resolves such a row, to `UNCONFIRMED`, and this
           * predicate is what stops the claim racing it: without it an expired lease
           * would make a row whose message may already have reached Telegram due again,
           * which is the duplicate announcement the stamp exists to prevent.
           */
          isNull(services.deliverySendStartedAt),
          ready,
        ),
      )
      .orderBy(asc(services.createdAt), asc(services.id))
      .limit(limit);

    const rows = await this.exec(tx)
      .update(services)
      .set({ deliveryNextAttemptAt: leaseUntil, updatedAt: now })
      .where(
        and(
          eq(services.tenantId, tenantId),
          // Re-checked in the UPDATE, not only in the sub-select. The sub-select alone
          // is satisfied by a caller whose scan simply found nothing; it is this
          // predicate, evaluated after the row lock is granted, that refuses a row a
          // concurrent sweep leased while this caller was blocked on it.
          eq(services.deliveryState, 'PENDING'),
          ready,
          sql`${services.id} IN ${due}`,
        ),
      )
      .returning();
    return rows.map(toRecord);
  }

  async listUsageSyncDue(
    scope: TenantContext,
    staleBefore: Date,
    limit: number,
    tx?: unknown,
  ): Promise<readonly ServiceRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(services)
      .where(
        and(
          eq(services.tenantId, tenantId),
          /*
           * ACTIVE only, and the predicate is here rather than in the caller.
           *
           * The same rule the panel monitor enforces in its discovery query AND again
           * in the probe core, for the reason CLAUDE.md gives: a background lane that
           * decides in a process what it should be dialling is a lane that will one day
           * dial something an operator turned off. `OPERATION_LEGAL_FROM` says the same
           * thing at the executor, and neither is a substitute for the other — a
           * service can leave ACTIVE between this query and that check.
           */
          eq(services.state, 'ACTIVE'),
          /*
           * Only an account that exists can be read.
           *
           * `provider_user_id` is written by the create and by the adopt path. A row
           * without one has nothing on a panel to ask about, and asking would spend a
           * request to be told so.
           */
          isNotNull(services.providerUserId),
          /*
           * A service that has never been synced is measured from when it was CREATED.
           *
           * `usage_synced_at` is NULL for a service whose create returned no usage, and
           * that is the ordinary case rather than an edge one: 3X-UI's `clients/add`
           * answers `obj: null`, so every Sanaei service starts this way.
           *
           * Treating NULL as "infinitely stale" was the first version and it is wrong
           * in a way worth writing down: it makes every newly provisioned service due
           * on the very next tick, so the executor spends a provider call re-reading an
           * account created seconds earlier by the call before it. `COALESCE` starts
           * the clock at creation instead, which gives the answer an operator would
           * expect from a cadence — the first refresh is one cadence after the service
           * exists — and leaves no row uncovered, because `created_at` is NOT NULL.
           */
          lte(sql`COALESCE(${services.usageSyncedAt}, ${services.createdAt})`, staleBefore),
        ),
      )
      /*
       * Stalest first, NULLs before everything.
       *
       * This ordering is what makes `USAGE_SYNC_PLAN_LIMIT` safe: the next tick resumes
       * where this one stopped, so no service at the back of a large tenant's queue
       * waits for ever. `id` breaks the tie so the order is total and two replicas
       * reading concurrently see the same page.
       */
      .orderBy(
        sql`COALESCE(${services.usageSyncedAt}, ${services.createdAt}) ASC`,
        asc(services.id),
      )
      .limit(limit);
    return rows.map(toRecord);
  }

  async recordUsage(
    scope: TenantContext,
    id: string,
    usage: { readonly usedBytes: bigint; readonly syncedAt: Date },
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(services)
      .set({
        trafficUsedBytes: usage.usedBytes,
        usageSyncedAt: usage.syncedAt,
        updatedAt: usage.syncedAt,
      })
      .where(
        and(
          eq(services.tenantId, tenantId),
          eq(services.id, id),
          /*
           * Conditional on ACTIVE, which is what makes this safe to run after a
           * provider call that took time.
           *
           * A service suspended, expired or terminated while the read was in flight
           * keeps whatever that transition wrote. There is no `setUsage`, for the
           * reason ADR-0028 gives about `setState`: one convenience setter removes the
           * guarantee from every caller at once.
           */
          eq(services.state, 'ACTIVE'),
        ),
      )
      .returning({ id: services.id });
    return rows.length === 1;
  }

  /**
   * The allowance a commercial operation bought, on a service still in the state it was
   * planned from.
   *
   * One UPDATE, naming `from`, so a service suspended, expired or terminated while the
   * provider call was on the wire keeps whatever that transition wrote and this returns
   * false. The caller treats that as a successful operation whose service moved, which
   * it is.
   *
   * A null field is skipped rather than written as null: null on the operation row
   * means "this operation did not buy that", and writing it would clear a window the
   * customer still has. `traffic_limit_bytes` is NOT NULL in any case, so a null there
   * could not be written at all — the skip is what makes the two fields behave the
   * same way rather than one of them throwing.
   */
  async recordAllowance(
    scope: TenantContext,
    id: string,
    from: ServiceState,
    to: ServiceState,
    allowance: {
      readonly expiresAt: Date | null;
      readonly trafficLimitBytes: bigint | null;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const patch: Record<string, unknown> = { state: to, updatedAt: now };
    if (allowance.expiresAt !== null) patch['expiresAt'] = allowance.expiresAt;
    if (allowance.trafficLimitBytes !== null) {
      patch['trafficLimitBytes'] = allowance.trafficLimitBytes;
    }
    const rows = await this.exec(tx)
      .update(services)
      .set(patch)
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id), eq(services.state, from)))
      .returning({ id: services.id });
    return rows.length === 1;
  }

  async expireDue(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly ServiceRecord[]> {
    /*
     * ONE conditional UPDATE PER SOURCE STATE, not one naming a set.
     *
     * `SERVICE_MACHINE` has `EXPIRE` from `ACTIVE` and from `SUSPENDED`, and an audit
     * record has to say which one a service was in. A single UPDATE over both cannot:
     * `RETURNING` hands back the NEW row, so every result would read `EXPIRED` and the
     * `before` would be a record of nothing. `RETURNING OLD.state` would answer it and
     * is PostgreSQL 18; this runs on 16.
     *
     * Reading the candidates first and writing afterwards would answer it too, and
     * would be wrong for the ordinary reason: between the read and the write a service
     * can move from ACTIVE to SUSPENDED and still be expirable, so the `before` would
     * name a state the row had already left. Naming the `from` in each statement makes
     * each one exact by construction — the same discipline `transition` uses, and
     * ADR-0028's reason for there being no `setState`.
     *
     * The bound is shared across the two, so a tenant whose plans all lapse on one
     * midnight still moves at most `limit` rows in a tick.
     */
    const tenantId = requireTenantId(scope);
    const expired: ServiceRecord[] = [];

    for (const from of ['ACTIVE', 'SUSPENDED'] as const) {
      const remaining = limit - expired.length;
      if (remaining <= 0) break;

      const due = this.exec(tx)
        .select({ id: services.id })
        .from(services)
        .where(
          and(
            eq(services.tenantId, tenantId),
            eq(services.state, from),
            /*
             * NULL is an unlimited plan and is never due.
             *
             * This predicate is REDUNDANT and is kept deliberately. `expires_at <= now`
             * is already NULL — not true — for an unlimited plan, so SQL's three-valued
             * logic excludes the row without any help; mutating both copies of this
             * line to TRUE was measured and the unlimited service still survived.
             *
             * It stays because it is the one place the intent is written down, and the
             * predicate that DOES carry it is easy to rewrite: `COALESCE(expires_at,
             * <anything>) <= now` would expire every unlimited service on the next
             * tick, and nothing else in this query would object. Recorded as F4E-14.
             */
            isNotNull(services.expiresAt),
            lte(services.expiresAt, now),
          ),
        )
        .orderBy(asc(services.expiresAt), asc(services.id))
        .limit(remaining);

      const rows = await this.exec(tx)
        .update(services)
        .set({ state: 'EXPIRED', updatedAt: now })
        .where(
          and(
            eq(services.tenantId, tenantId),
            // Re-checked after the row lock is granted, not only in the sub-select:
            // the sub-select alone is satisfied by a scan that found the row before
            // another writer moved it.
            eq(services.state, from),
            // Redundant in the same way and kept for the same reason; see the
            // sub-select above. `lte` is what excludes an unlimited plan.
            isNotNull(services.expiresAt),
            lte(services.expiresAt, now),
            sql`${services.id} IN ${due}`,
          ),
        )
        .returning();

      // The state each row was in is known from the statement that moved it, not read
      // back from a row that now says EXPIRED.
      expired.push(...rows.map((row) => ({ ...toRecord(row), state: from })));
    }

    return expired;
  }
}
