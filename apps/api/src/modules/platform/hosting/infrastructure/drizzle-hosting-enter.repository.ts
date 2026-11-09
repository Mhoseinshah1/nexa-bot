import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  errors,
  OWNER_ROLE_KEY,
  type ActorImpersonation,
  type SystemContext,
  type TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';
import {
  adminRoles,
  adminSessions,
  admins,
  hostingEnterTokens,
  hostingSessions,
  roles,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { EnteredSessionLiveness } from '../../identity/application/authentication.service.js';
import type { SessionImpersonationMark } from '../../identity/application/ports.js';
import type {
  HostingEnterRepository,
  SpentEnterToken,
} from '../application/hosting-enter.ports.js';
import { acrossTenants } from './hosting-system-path.js';

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

/**
 * Phase 6B «ورود به پنل» (ADR-0039 § 9) — the tokens, the host principal, and the liveness of
 * an entered session.
 *
 * The token rows are the INSTALLATION's (written in the owner's scope). Every statement that
 * reaches ANOTHER tenant's rows runs on the RLS system path under its own literal reason,
 * pinned in `tests/unit/system-path-allowlist.ts`, on the caller's transaction when it has one:
 * - `hosting: ensure the host principal of a hosted tenant` — the owner's transaction writes
 *   the hosted tenant's HOST admin;
 * - `hosting: open an entered session in a hosted tenant` — the hosted tenant's transaction
 *   spends the installation's token row;
 * - `hosting: entered session liveness` — every request of an entered session reads the
 *   owner's section session and Web Admin session;
 * - `hosting: revoke entered sessions with the section` — closing a section ends the hosted
 *   sessions entered from it.
 * Each statement names the one row (or the one owner) it is about.
 */
@ScopeBound()
export class DrizzleHostingEnterRepository
  implements HostingEnterRepository, EnteredSessionLiveness
{
  constructor(private readonly db: Database) {}

  async insertToken(
    installation: TenantContext,
    row: {
      readonly id: string;
      readonly hostedTenantId: string;
      readonly domain: string;
      readonly ownerAdminId: string;
      readonly hostingSessionId: string;
      readonly tokenHash: string;
      readonly createdAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<void> {
    await executorOf(this.db, tx)
      .insert(hostingEnterTokens)
      .values({ ...row, tenantId: requireTenantId(installation) });
  }

  /** The hosted tenant's ACTIVE HOST principal, read in ITS scope (the redemption's). */
  async hostOf(hosted: TenantContext, tx: unknown): Promise<string | null> {
    const [row] = await executorOf(this.db, tx)
      .select({ id: admins.id })
      .from(admins)
      .where(
        and(
          eq(admins.tenantId, requireTenantId(hosted)),
          eq(admins.kind, 'HOST'),
          eq(admins.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  async ensureHost(
    context: SystemContext,
    input: {
      readonly hostedTenantId: string;
      readonly id: string;
      readonly username: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<string> {
    assertSystem(context);
    return acrossTenants(tx, 'hosting: ensure the host principal of a hosted tenant', async () => {
      const executor = executorOf(this.db, tx);
      // One HOST per tenant (`admins_tenant_host_key`): a concurrent first enter loses the
      // insert and reads the winner's row.
      await executor
        .insert(admins)
        .values({
          id: input.id,
          tenantId: input.hostedTenantId,
          username: input.username,
          displayName: 'host',
          passwordHash: null,
          passwordUpdatedAt: input.now,
          status: 'ACTIVE',
          kind: 'HOST',
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing();
      const [row] = await executor
        .select({ id: admins.id, status: admins.status })
        .from(admins)
        .where(and(eq(admins.tenantId, input.hostedTenantId), eq(admins.kind, 'HOST')))
        .limit(1);
      if (row === undefined || row.status !== 'ACTIVE') {
        throw errors.internal(
          'hosting.enter_host_missing',
          'The host principal of the hosted tenant could not be ensured.',
        );
      }
      return row.id;
    });
  }

  async spend(
    context: SystemContext,
    input: {
      readonly tokenHash: string;
      readonly hostedTenantId: string;
      readonly domain: string;
      readonly adminSessionId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<SpentEnterToken | null> {
    assertSystem(context);
    // THE single-use guarantee: one conditional UPDATE, good only for its audience (the hosted
    // tenant AND the domain the request was addressed to), unused and unexpired at `now`.
    const [row] = await acrossTenants(
      tx,
      'hosting: open an entered session in a hosted tenant',
      () =>
        executorOf(this.db, tx)
          .update(hostingEnterTokens)
          .set({ usedAt: input.now, adminSessionId: input.adminSessionId })
          .where(
            and(
              eq(hostingEnterTokens.tokenHash, input.tokenHash),
              eq(hostingEnterTokens.hostedTenantId, input.hostedTenantId),
              eq(hostingEnterTokens.domain, input.domain),
              isNull(hostingEnterTokens.usedAt),
              gt(hostingEnterTokens.expiresAt, input.now),
            ),
          )
          .returning({
            id: hostingEnterTokens.id,
            installationTenantId: hostingEnterTokens.tenantId,
            ownerAdminId: hostingEnterTokens.ownerAdminId,
            hostingSessionId: hostingEnterTokens.hostingSessionId,
          }),
    );
    return row ?? null;
  }

  async ownerOf(
    mark: SessionImpersonationMark,
    now: Date,
    tx?: unknown,
  ): Promise<ActorImpersonation | null> {
    const facts = await this.sectionFacts(mark, now, tx);
    return facts === null
      ? null
      : {
          installationTenantId: facts.installationTenantId,
          ownerAdminId: facts.ownerAdminId,
          ownerLabel: facts.ownerLabel,
          hostingSessionId: mark.hostingSessionId,
        };
  }

  /**
   * The section session behind an entered one, when it still holds: unrevoked and unexpired,
   * its owner's own Web Admin session unrevoked and unexpired, the owner ACTIVE and still
   * holding the installation's `owner` role. Its expiry bounds the entered session's.
   */
  async sectionFacts(
    mark: SessionImpersonationMark,
    now: Date,
    tx?: unknown,
  ): Promise<{
    readonly installationTenantId: string;
    readonly ownerAdminId: string;
    readonly ownerLabel: string;
    readonly expiresAt: Date;
  } | null> {
    const [row] = await acrossTenants(tx, 'hosting: entered session liveness', () =>
      executorOf(this.db, tx)
        .select({
          installationTenantId: hostingSessions.tenantId,
          ownerAdminId: hostingSessions.adminId,
          ownerLabel: admins.username,
          expiresAt: hostingSessions.expiresAt,
        })
        .from(hostingSessions)
        .innerJoin(
          adminSessions,
          and(
            eq(adminSessions.id, hostingSessions.adminSessionId),
            eq(adminSessions.tenantId, hostingSessions.tenantId),
            eq(adminSessions.adminId, hostingSessions.adminId),
          ),
        )
        .innerJoin(
          admins,
          and(
            eq(admins.tenantId, hostingSessions.tenantId),
            eq(admins.id, hostingSessions.adminId),
          ),
        )
        .where(
          and(
            eq(hostingSessions.id, mark.hostingSessionId),
            eq(hostingSessions.adminId, mark.byAdminId),
            isNull(hostingSessions.revokedAt),
            gt(hostingSessions.expiresAt, now),
            isNull(adminSessions.revokedAt),
            gt(adminSessions.expiresAt, now),
            eq(admins.status, 'ACTIVE'),
            eq(admins.kind, 'OPERATOR'),
            sql`EXISTS (
              SELECT 1 FROM ${adminRoles}
                JOIN ${roles} ON ${roles.id} = ${adminRoles.roleId}
                             AND ${roles.tenantId} = ${adminRoles.tenantId}
               WHERE ${adminRoles.tenantId} = ${hostingSessions.tenantId}
                 AND ${adminRoles.adminId} = ${hostingSessions.adminId}
                 AND ${roles.key} = ${OWNER_ROLE_KEY})`,
          ),
        )
        .limit(1),
    );
    return row ?? null;
  }

  async revokeEndedSections(
    context: SystemContext,
    input: {
      readonly installationTenantId: string;
      readonly ownerAdminId: string;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<number> {
    assertSystem(context);
    return acrossTenants(tx, 'hosting: revoke entered sessions with the section', async () => {
      const executor = executorOf(this.db, tx);
      const ended = executor
        .select({ id: hostingSessions.id })
        .from(hostingSessions)
        .where(
          and(
            eq(hostingSessions.tenantId, input.installationTenantId),
            eq(hostingSessions.adminId, input.ownerAdminId),
            or(isNotNull(hostingSessions.revokedAt), lte(hostingSessions.expiresAt, input.now)),
          ),
        );
      const rows = await executor
        .update(adminSessions)
        .set({ revokedAt: input.now, revokedReason: 'entered_section_ended' })
        .where(
          and(
            eq(adminSessions.impersonatedByAdminId, input.ownerAdminId),
            isNull(adminSessions.revokedAt),
            inArray(adminSessions.impersonationHostingSessionId, ended),
          ),
        )
        .returning({ id: adminSessions.id });
      return rows.length;
    });
  }
}

function assertSystem(context: SystemContext): void {
  if (context.kind !== 'SYSTEM' || !context.reason.startsWith('hosting.')) {
    throw errors.internal(
      'platform.tenant_context_missing',
      'The hosting system path needs a SystemContext naming its hosting operation.',
    );
  }
}
