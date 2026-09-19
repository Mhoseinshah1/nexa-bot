import { and, eq, sql } from 'drizzle-orm';
import { SERVICE_CAPACITY_STATES, type TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  panelCapacityReservations,
  panels,
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
 * The states that occupy a slot.
 *
 * The contract's own array rather than a list written out here, so the schema's
 * CHECK constraint, the TypeScript predicate and this query cannot describe
 * three different sets. A literal list is the second opinion that makes a newly
 * added state silently free.
 */
const OCCUPYING_STATES = SERVICE_CAPACITY_STATES;

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
   * ONE statement, and the reason is the snapshot rather than the round trip.
   *
   * Under READ COMMITTED every statement gets a FRESH snapshot, so three
   * queries read three instants: a settlement committing between the service
   * count and the hold count is seen by neither — the service did not exist
   * when the first ran and the hold was gone when the second did — and `used`
   * comes back one too low. That is a panel reported as having room it does
   * not have, offered in the catalogue, and refused at confirmation. Found by
   * the Codex review of this branch.
   *
   * Raw SQL rather than the query builder, deliberately: the drizzle version of
   * this shape was wrong in a way a green `psql` session did not show — two
   * un-aliased aggregate subqueries in a `select()` object returned zeros,
   * because they do not survive the driver's column mapping. Written out, every
   * column is named and the mapping is the one written here.
   *
   * Still bounded by the PAGE rather than by the row count: one statement whose
   * two subqueries are indexed lookups per panel, for the panels asked about.
   *
   * A panel with no services and no holds lands on zero rather than dropping
   * out, because the counts are subqueries of the panel row rather than joins.
   */
  async readMany(
    scope: TenantContext,
    panelIds: readonly string[],
    now: Date,
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, PanelCapacity>> {
    const found = new Map<string, PanelCapacity>();
    const unique = [...new Set(panelIds)];
    if (unique.length === 0) return found;
    const exec = executorOf(this.db, tx);

    const ids = sql.join(
      unique.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const occupying = sql.join(
      OCCUPYING_STATES.map((state) => sql`${state}`),
      sql`, `,
    );
    const result = (await exec.execute(sql`
      SELECT p.id AS id,
             p.max_services AS max_services,
             (SELECT count(*) FROM services s
               WHERE s.tenant_id = p.tenant_id
                 AND s.panel_id = p.id
                 AND s.state IN (${occupying})) AS services,
             (SELECT count(*) FROM panel_capacity_reservations r
               WHERE r.tenant_id = p.tenant_id
                 AND r.panel_id = p.id
                 AND r.expires_at > ${now}) AS reservations
        FROM panels p
       WHERE p.tenant_id = ${scope.tenantId}::uuid
         AND p.id IN (${ids})
    `)) as unknown as {
      rows: {
        id: string;
        max_services: number | null;
        // `count(*)` is `bigint`, which this driver hands back as a STRING
        // rather than a number. `Number` below is what makes the arithmetic
        // arithmetic; without it `used` was string concatenation.
        services: string | number;
        reservations: string | number;
      }[];
    };

    for (const row of result.rows) {
      found.set(
        row.id,
        capacityOf(row.max_services, Number(row.services), Number(row.reservations)),
      );
    }
    return found;
  }

  /**
   * Take one slot, under the panel's row lock.
   *
   * FOUR statements, in this order, and the order is the correctness argument:
   *
   *   1. `SELECT ... FOR UPDATE` on the panel. Every other reserver of this
   *      panel — and every operator changing its cap — queues here.
   *   1b. The replay check, described below: read under the lock, before the
   *      arithmetic, because an order that already holds a slot is not asking
   *      for one.
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
