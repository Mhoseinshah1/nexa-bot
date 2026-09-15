import { and, asc, eq, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
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
}
