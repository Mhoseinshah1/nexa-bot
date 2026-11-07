import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { errors, type SystemContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';
import {
  adminSessions,
  admins,
  hostedBotActivationLinks,
  hostedBotActivations,
} from '../../../../infrastructure/persistence/schema.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { HostedOwnerActivationSystemPath } from '../application/activation-ports.js';
import { acrossTenants } from './hosting-system-path.js';

function executorOf(db: Database, tx: unknown): Executor {
  return (tx as TransactionScope).tx ?? db;
}

function assertSystem(context: SystemContext): void {
  if (context.kind !== 'SYSTEM' || !context.reason.startsWith('hosting.')) {
    throw errors.internal(
      'platform.tenant_context_missing',
      'The hosting system path needs a SystemContext naming its hosting operation.',
    );
  }
}

/**
 * Phase 6A PR-4 — the redemption's writes (`HostedOwnerActivationSystemPath`), each under an
 * explicit `SystemContext` (`hosting.activate_owner`): spending the link, setting the hosted
 * owner's credentials in the HOSTED tenant, and marking the installation's activation record.
 * All three run in the caller's one transaction, so a redemption either does all of them or
 * none (a username another admin holds rolls the spent link back with it).
 *
 * The transaction is bound to the HOSTED tenant (ADR-0037), so the one write that belongs to
 * the hosted tenant — its owner's credentials and sessions — runs under that binding with no
 * system path at all: row-level security itself keeps it from touching any other tenant,
 * the installation's PRIMARY tenant included. The two writes to the INSTALLATION's rows (the
 * link, the activation record) are the cross-tenant ones, each a single UPDATE on the system
 * path under its own literal reason and a predicate naming exactly the row.
 */
@ScopeBound()
export class DrizzleHostedOwnerActivation implements HostedOwnerActivationSystemPath {
  constructor(private readonly db: Database) {}

  async burnLink(context: SystemContext, linkId: string, now: Date, tx: unknown): Promise<boolean> {
    assertSystem(context);
    // THE single-use guarantee: one conditional UPDATE. Two concurrent redemptions meet at the
    // row lock; the second re-evaluates `used_at IS NULL` and matches nothing.
    const spent = await acrossTenants(tx, 'hosting: spend an activation link', () =>
      executorOf(this.db, tx)
        .update(hostedBotActivationLinks)
        .set({ usedAt: now })
        .where(
          and(
            eq(hostedBotActivationLinks.id, linkId),
            isNull(hostedBotActivationLinks.usedAt),
            isNull(hostedBotActivationLinks.revokedAt),
            gt(hostedBotActivationLinks.expiresAt, now),
          ),
        )
        .returning({ id: hostedBotActivationLinks.id }),
    );
    return spent.length === 1;
  }

  async setOwnerCredentials(
    context: SystemContext,
    input: Parameters<HostedOwnerActivationSystemPath['setOwnerCredentials']>[1],
    tx: unknown,
  ): Promise<'UPDATED' | 'USERNAME_TAKEN' | 'NOT_FOUND'> {
    assertSystem(context);
    const executor = executorOf(this.db, tx);
    const [owner] = await executor
      .select({ id: admins.id })
      .from(admins)
      .where(
        and(
          eq(admins.tenantId, input.hostedTenantId),
          eq(admins.id, input.ownerAdminId),
          eq(admins.status, 'ACTIVE'),
        ),
      )
      .limit(1)
      .for('update');
    if (owner === undefined) return 'NOT_FOUND';
    const [clash] = await executor
      .select({ id: admins.id })
      .from(admins)
      .where(
        and(
          eq(admins.tenantId, input.hostedTenantId),
          eq(admins.username, input.username),
          ne(admins.id, input.ownerAdminId),
        ),
      )
      .limit(1);
    if (clash !== undefined) return 'USERNAME_TAKEN';
    await executor
      .update(admins)
      .set({
        username: input.username,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        passwordHash: input.passwordHash,
        passwordUpdatedAt: input.now,
        updatedAt: input.now,
      })
      .where(and(eq(admins.tenantId, input.hostedTenantId), eq(admins.id, input.ownerAdminId)));
    // A credential change ends every session of that admin: whoever held the old password
    // (the creator's placeholder included) is signed out.
    await executor
      .update(adminSessions)
      .set({ revokedAt: input.now, revokedReason: 'hosted_owner_activated' })
      .where(
        and(
          eq(adminSessions.tenantId, input.hostedTenantId),
          eq(adminSessions.adminId, input.ownerAdminId),
          isNull(adminSessions.revokedAt),
        ),
      );
    return 'UPDATED';
  }

  async markOwnerActivated(
    context: SystemContext,
    input: { readonly tenantId: string; readonly hostedTenantId: string; readonly now: Date },
    tx: unknown,
  ): Promise<void> {
    assertSystem(context);
    await acrossTenants(tx, 'hosting: mark the hosted owner activated', () =>
      executorOf(this.db, tx)
        .update(hostedBotActivations)
        .set({ ownerActivatedAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(hostedBotActivations.tenantId, input.tenantId),
            eq(hostedBotActivations.hostedTenantId, input.hostedTenantId),
          ),
        ),
    );
  }
}
