import { and, eq, ne, sql } from 'drizzle-orm';
import type { ServiceUsernameMode, TenantContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import {
  serviceUsernameReservations,
  services,
} from '../../../../infrastructure/persistence/schema.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  ReserveUsernameInput,
  ReserveUsernameOutcome,
  ServiceUsernameRepository,
  UsernameReservation,
} from '../application/username-ports.js';

type Row = typeof serviceUsernameReservations.$inferSelect;

function toRecord(row: Row): UsernameReservation {
  return {
    id: row.id,
    namespaceKey: row.namespaceKey,
    username: row.username,
    panelId: row.panelId,
    orderId: row.orderId,
    customerId: row.customerId,
    // Narrowed from `text`; the CHECK constraint built from SERVICE_USERNAME_MODES is
    // what makes this safe, exactly as the panel repository narrows `provider_type`.
    mode: row.mode as ServiceUsernameMode,
    fundedAt: row.fundedAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Username reservations, in PostgreSQL.
 *
 * Every interesting thing in this file is a unique index doing the deciding. There is
 * no read-then-write anywhere in it, because a question issued before an insert sees
 * the state the loser started from — and the loser here is a second customer who is
 * told they have a name they do not have.
 */
export class DrizzleServiceUsernameRepository implements ServiceUsernameRepository {
  constructor(private readonly db: Database) {}

  async findByOrder(
    scope: TenantContext,
    orderId: string,
    tx: TransactionScope,
  ): Promise<UsernameReservation | null> {
    const [row] = await tx.tx
      .select()
      .from(serviceUsernameReservations)
      .where(
        and(
          eq(serviceUsernameReservations.tenantId, scope.tenantId),
          eq(serviceUsernameReservations.orderId, orderId),
        ),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  /**
   * ONE conditional insert, and the two conflicts are told apart AFTERWARDS.
   *
   * `onConflictDoNothing` with no target covers both unique indexes, so a lost insert
   * returns no row and says nothing about which index refused it. The follow-up read is
   * by ORDER: a row for this order means `ORDER_ALREADY_HELD` and the held name is what
   * the caller gets; no row means the NAME went to somebody else.
   *
   * Getting that the other way round — reading by name — would report another order's
   * reservation as this order's, which is the one mistake in this file that would hand
   * two customers the same account.
   */
  async reserve(
    scope: TenantContext,
    input: ReserveUsernameInput,
    tx: TransactionScope,
  ): Promise<ReserveUsernameOutcome> {
    const [row] = await tx.tx
      .insert(serviceUsernameReservations)
      .values({
        id: input.id,
        tenantId: scope.tenantId,
        namespaceKey: input.namespaceKey,
        username: input.username,
        panelId: input.panelId,
        orderId: input.orderId,
        customerId: input.customerId,
        mode: input.mode,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing()
      .returning();
    if (row !== undefined) return { outcome: 'RESERVED', reservation: toRecord(row) };

    const held = await this.findByOrder(scope, input.orderId, tx);
    if (held !== null) return { outcome: 'ORDER_ALREADY_HELD', reservation: held };
    return { outcome: 'NAME_TAKEN' };
  }

  /**
   * Is a live service on this panel already called this?
   *
   * TERMINATED is excluded: a terminated service's account is gone from the panel, and
   * refusing its name for ever would leak the fact that somebody once had it while
   * shrinking the namespace with every cancellation.
   */
  async usernameInUseOnPanel(
    scope: TenantContext,
    panelId: string,
    username: string,
    tx: TransactionScope,
  ): Promise<boolean> {
    const [row] = await tx.tx
      .select({ one: sql<number>`1` })
      .from(services)
      .where(
        and(
          eq(services.tenantId, scope.tenantId),
          eq(services.panelId, panelId),
          eq(services.providerUsername, username),
          ne(services.state, 'TERMINATED'),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * Stamp `funded_at`, once.
   *
   * `IS NULL` in the predicate rather than an unconditional SET: a settlement replayed
   * an hour later must not move the timestamp forward, because that timestamp is the
   * evidence of WHEN this name stopped being reapable.
   */
  async markFunded(
    scope: TenantContext,
    orderId: string,
    at: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const rows = await tx.tx
      .update(serviceUsernameReservations)
      .set({ fundedAt: at })
      .where(
        and(
          eq(serviceUsernameReservations.tenantId, scope.tenantId),
          eq(serviceUsernameReservations.orderId, orderId),
          sql`${serviceUsernameReservations.fundedAt} IS NULL`,
        ),
      )
      .returning({ id: serviceUsernameReservations.id });
    return rows.length > 0;
  }

  async release(scope: TenantContext, orderId: string, tx: TransactionScope): Promise<boolean> {
    const rows = await tx.tx
      .delete(serviceUsernameReservations)
      .where(
        and(
          eq(serviceUsernameReservations.tenantId, scope.tenantId),
          eq(serviceUsernameReservations.orderId, orderId),
        ),
      )
      .returning({ id: serviceUsernameReservations.id });
    return rows.length > 0;
  }
}
