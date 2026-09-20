import { and, eq, ne, sql } from 'drizzle-orm';
import { errors, PANEL_ERROR_CODES, type ProviderType } from '@nexa/contracts';
import type { ServiceUsernameMode, TenantContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import {
  serviceUsernameReservations,
  services,
} from '../../../../infrastructure/persistence/schema.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PanelNamespaceRebinder } from '../../../platform/panels/application/ports.js';
import { namespaceKeyFor } from '../application/username-allocator.js';
import type {
  ReserveUsernameInput,
  ReserveUsernameOutcome,
  ServiceUsernameRepository,
  UsernameReservation,
} from '../application/username-ports.js';

/**
 * A PostgreSQL unique violation, however deep the driver wrapped it.
 *
 * `23505` arrives on the pg error, and drizzle wraps that in a `DrizzleQueryError`
 * carrying the SQL and its parameters — so reading `.code` off what was thrown finds
 * `undefined` and the translation below never happens. The chain is walked rather
 * than assumed to be one link, because the depth is the driver's business and this
 * rule is not: a violation is a violation at any depth.
 *
 * Bounded, so a cyclic `cause` cannot spin here.
 */
function isUniqueViolation(error: unknown): boolean {
  let at: unknown = error;
  for (let depth = 0; depth < 5 && at !== null && typeof at === 'object'; depth += 1) {
    if ((at as { code?: unknown }).code === '23505') return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

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
export class DrizzleServiceUsernameRepository
  implements ServiceUsernameRepository, PanelNamespaceRebinder
{
  constructor(private readonly db: Database) {}

  async findByOrder(
    scope: TenantContext,
    orderId: string,
    tx?: TransactionScope,
  ): Promise<UsernameReservation | null> {
    const [row] = await (tx?.tx ?? this.db)
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

  async releaseUnfunded(
    scope: TenantContext,
    orderId: string,
    tx: TransactionScope,
  ): Promise<boolean> {
    const rows = await tx.tx
      .delete(serviceUsernameReservations)
      .where(
        and(
          eq(serviceUsernameReservations.tenantId, scope.tenantId),
          eq(serviceUsernameReservations.orderId, orderId),
          // The predicate, not a read followed by a delete. A settlement committing
          // between the two would be a funded name deleted by a cancellation that
          // saw it unfunded.
          sql`${serviceUsernameReservations.fundedAt} IS NULL`,
        ),
      )
      .returning({ id: serviceUsernameReservations.id });
    return rows.length > 0;
  }

  async sweepExpiredHolds(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<number> {
    /*
     * The bound is a subselect rather than a `LIMIT` on the DELETE, because
     * PostgreSQL has no `DELETE ... LIMIT`. `FOR UPDATE SKIP LOCKED` inside it is the
     * same shape the outbox relay's claim uses and for the same reason: two worker
     * replicas is the normal case on every rolling update, and a sweeper waiting on
     * the other's rows would serialise for no gain.
     */
    const rows = await tx.tx
      .delete(serviceUsernameReservations)
      .where(
        sql`${serviceUsernameReservations.id} IN (
          SELECT r.id
            FROM ${serviceUsernameReservations} AS r
           WHERE r.tenant_id = ${scope.tenantId}
             AND r.funded_at IS NULL
             AND r.expires_at < ${now}
           ORDER BY r.expires_at
           LIMIT ${limit}
             FOR UPDATE SKIP LOCKED)`,
      )
      .returning({ id: serviceUsernameReservations.id });
    return rows.length;
  }

  /**
   * `PanelNamespaceRebinder`. Moves this panel's holds to the namespace of a new
   * address, or refuses the move.
   *
   * The port's docblock says why an address change has to touch these rows at all.
   * Three things about HOW:
   *
   *   - `ne(namespaceKey, next)` makes it a no-op when the key does not actually
   *     change, which is the ordinary case for an edit that renames a panel while
   *     resubmitting the address it already had;
   *   - no `funded_at` predicate, deliberately: a funded name is one an account
   *     exists under, and the conservative reading is that nobody else may take it
   *     at the destination either;
   *   - a unique violation is translated rather than propagated. `23505` here means
   *     exactly one thing — a name this panel holds is already held at the
   *     destination — and the operator needs that sentence, not a 500. The
   *     transaction is the caller's and unwinds with the panel row it was about to
   *     write, which is the point: the address change and the rebind are one commit
   *     or neither.
   */
  async rebind(
    scope: TenantContext,
    input: {
      readonly panelId: string;
      readonly providerType: ProviderType;
      readonly baseUrl: string;
    },
    tx: TransactionScope,
  ): Promise<number> {
    const next = namespaceKeyFor(input.providerType, input.baseUrl);
    try {
      const rows = await tx.tx
        .update(serviceUsernameReservations)
        .set({ namespaceKey: next })
        .where(
          and(
            eq(serviceUsernameReservations.tenantId, scope.tenantId),
            eq(serviceUsernameReservations.panelId, input.panelId),
            ne(serviceUsernameReservations.namespaceKey, next),
          ),
        )
        .returning({ id: serviceUsernameReservations.id });
      return rows.length;
    } catch (cause) {
      if (!isUniqueViolation(cause)) throw cause;
      throw errors.conflict(
        PANEL_ERROR_CODES.PANEL_NAMESPACE_CONFLICT,
        'A username this panel is holding is already reserved at that address.',
      );
    }
  }
}
