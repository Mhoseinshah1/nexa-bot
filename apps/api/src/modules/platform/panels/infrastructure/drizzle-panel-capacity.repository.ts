import { and, eq, inArray, sql } from 'drizzle-orm';
import { SERVICE_CAPACITY_STATES, type TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  panelCapacityReservations,
  panels,
  services,
} from '../../../../infrastructure/persistence/schema.js';
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { capacityOf } from '../application/panel-capacity.js';
import type {
  CapacityAcquisition,
  PanelCapacity,
  PanelCapacityRepository,
  ReserveCapacityInput,
} from '../application/capacity-ports.js';

function executorOf(db: Database, tx?: TransactionScope): Executor {
  return tx?.tx ?? db;
}

/**
 * The states that occupy a slot, as a SQL list.
 *
 * Built from the contract's own array rather than written out, so the schema's
 * CHECK constraint, the TypeScript predicate and this predicate cannot describe
 * three different sets. A literal list here is the second opinion that makes a
 * newly added state silently free.
 *
 * Expanded one placeholder per element with `sql.join`, NOT interpolated as an
 * array: a JavaScript array interpolated into a `sql` template becomes ONE
 * parameter, so `state IN ($1)` is compared against an array value and matches
 * nothing. The same expansion `dueForTenants` does, for the same reason.
 */
const OCCUPYING_STATES = sql.join(
  SERVICE_CAPACITY_STATES.map((state) => sql`${state}`),
  sql`, `,
);

/**
 * Panel capacity, in PostgreSQL.
 *
 * Two counts and a cap, and the ONLY interesting thing in the file is the order
 * of the statements in `reserve`. Everything else is bookkeeping.
 */
export class DrizzlePanelCapacityRepository implements PanelCapacityRepository {
  constructor(private readonly db: Database) {}

  async read(
    scope: TenantContext,
    panelId: string,
    now: Date,
    tx?: TransactionScope,
  ): Promise<PanelCapacity | null> {
    const found = await this.readMany(scope, [panelId], now, tx);
    return found.get(panelId) ?? null;
  }

  /**
   * One query for any number of panels.
   *
   * Two LATERAL-free scalar subqueries per row rather than two LEFT JOINs with
   * GROUP BY: the counts are over different tables with different predicates,
   * and joining both before aggregating multiplies them — the classic
   * fan-out that makes a panel with two services and three holds report six of
   * each. The subqueries are served by `services_tenant_panel_idx` and
   * `panel_capacity_reservations_panel_idx`.
   */
  async readMany(
    scope: TenantContext,
    panelIds: readonly string[],
    now: Date,
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, PanelCapacity>> {
    const found = new Map<string, PanelCapacity>();
    if (panelIds.length === 0) return found;

    const rows = await executorOf(this.db, tx)
      .select({
        id: panels.id,
        maxServices: panels.maxServices,
        services: sql<number>`(
          SELECT count(*) FROM ${services}
          WHERE ${services.tenantId} = ${panels.tenantId}
            AND ${services.panelId} = ${panels.id}
            AND ${services.state} IN (${OCCUPYING_STATES})
        )`,
        reservations: sql<number>`(
          SELECT count(*) FROM ${panelCapacityReservations}
          WHERE ${panelCapacityReservations.tenantId} = ${panels.tenantId}
            AND ${panelCapacityReservations.panelId} = ${panels.id}
            AND ${panelCapacityReservations.expiresAt} > ${now}::timestamptz
        )`,
      })
      .from(panels)
      .where(and(eq(panels.tenantId, scope.tenantId), inArray(panels.id, [...panelIds])));

    for (const row of rows) {
      // `count(*)` is `bigint`, and the driver hands `bigint` back as a STRING.
      // `Number()` rather than a cast that types the lie away: a panel with more
      // than 2^53 services is not a case this installation has, and a string
      // compared against a number with `>=` would be compared lexically.
      found.set(row.id, capacityOf(row.maxServices, Number(row.services), Number(row.reservations)));
    }
    return found;
  }

  /**
   * Take one slot, under the panel's row lock.
   *
   * THREE statements, in this order, and the order is the correctness argument:
   *
   *   1. `SELECT ... FOR UPDATE` on the panel. Every other reserver of this
   *      panel — and every operator changing its cap — queues here.
   *   2. The counts. Issued AFTER the lock was granted, so under READ COMMITTED
   *      its snapshot includes whatever the transaction we waited for committed.
   *      This is the step a single-statement `INSERT ... SELECT` cannot do: that
   *      statement's subqueries are planned against the snapshot taken when it
   *      started, which for the loser of a race is the state before the winner's
   *      row existed.
   *   3. The INSERT, which by then is arithmetic somebody else has been excluded
   *      from.
   *
   * `ON CONFLICT DO NOTHING` on `(tenant_id, order_id)` makes a replay find its
   * own hold rather than take a second one — and it is checked BEFORE the
   * capacity arithmetic, because an order that already holds a slot is not
   * asking for one and must not be refused by a panel that filled up since.
   */
  async reserve(
    scope: TenantContext,
    input: ReserveCapacityInput,
    now: Date,
    tx: TransactionScope,
  ): Promise<CapacityAcquisition> {
    const locked = await tx.tx
      .select({ id: panels.id, maxServices: panels.maxServices })
      .from(panels)
      .where(and(eq(panels.id, input.panelId), eq(panels.tenantId, scope.tenantId)))
      .for('update');

    const panel = locked[0];
    if (panel === undefined) return { outcome: 'PANEL_GONE' };

    /*
     * The replay check, before the capacity check.
     *
     * A hold this order already owns is the slot it is owed; refusing it because
     * the panel has since filled would let a retry fail an order that succeeded,
     * and the customer would be refused at a step they had already passed. Read
     * under the lock, so it cannot be taken between this and the insert.
     */
    const held = await tx.tx
      .select({ id: panelCapacityReservations.id })
      .from(panelCapacityReservations)
      .where(
        and(
          eq(panelCapacityReservations.tenantId, scope.tenantId),
          eq(panelCapacityReservations.orderId, input.orderId),
        ),
      );
    if (held.length > 0) return { outcome: 'ALREADY_HELD' };

    const counted = await this.readMany(scope, [input.panelId], now, tx);
    const capacity = counted.get(input.panelId);
    if (capacity === undefined) return { outcome: 'PANEL_GONE' };
    if (capacity.maxServices !== null && capacity.used >= capacity.maxServices) {
      return { outcome: 'AT_CAPACITY', capacity };
    }

    try {
      await tx.tx.insert(panelCapacityReservations).values({
        id: input.id,
        tenantId: scope.tenantId,
        panelId: input.panelId,
        orderId: input.orderId,
        expiresAt: input.expiresAt,
      });
    } catch (error) {
      /*
       * The index, not the pre-check, is the rule.
       *
       * The read above cannot see an uncommitted hold, and two reservations for
       * ONE order can only come from two transactions started before either
       * committed — a double-tap across two replicas. The unique index refuses
       * the second, and this is how that refusal reaches the caller as the
       * success it is rather than as a 500.
       */
      if (isUniqueViolation(error, 'panel_capacity_reservations_order_key')) {
        return { outcome: 'ALREADY_HELD' };
      }
      throw error;
    }

    return { outcome: 'RESERVED' };
  }

  async release(scope: TenantContext, orderId: string, tx: TransactionScope): Promise<boolean> {
    const deleted = await tx.tx
      .delete(panelCapacityReservations)
      .where(
        and(
          eq(panelCapacityReservations.tenantId, scope.tenantId),
          eq(panelCapacityReservations.orderId, orderId),
        ),
      )
      .returning({ id: panelCapacityReservations.id });
    return deleted.length > 0;
  }
}
