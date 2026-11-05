import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { HostedActivationStep, ScopeContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  hostedBotActivationLinks,
  hostedBotActivations,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  HostedActivationLinkRow,
  HostedActivationPatch,
  HostedActivationRepository,
  HostedActivationRow,
} from '../application/activation-ports.js';

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

type ActivationRecord = typeof hostedBotActivations.$inferSelect;
type LinkRecord = typeof hostedBotActivationLinks.$inferSelect;

function toRow(row: ActivationRecord): HostedActivationRow {
  return {
    tenantId: row.tenantId,
    hostedTenantId: row.hostedTenantId,
    botInstanceId: row.botInstanceId,
    domain: row.domain,
    tokenVerifiedAt: row.tokenVerifiedAt,
    dnsVerifiedAt: row.dnsVerifiedAt,
    tlsVerifiedAt: row.tlsVerifiedAt,
    webhookRegisteredAt: row.webhookRegisteredAt,
    lastErrorStep: row.lastErrorStep as HostedActivationStep | null,
    lastErrorCode: row.lastErrorCode,
    lastErrorAt: row.lastErrorAt,
    ownerActivatedAt: row.ownerActivatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toLink(row: LinkRecord): HostedActivationLinkRow {
  return {
    id: row.id,
    hostedTenantId: row.hostedTenantId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * Phase 6A PR-4 — the activation record and its links: the INSTALLATION tenant's own rows,
 * read and written in the owner's scope (`HostedActivationRepository`). Every method names
 * the tenant through `requireTenantId(scope)`.
 */
export class DrizzleHostedActivationRepository implements HostedActivationRepository {
  constructor(private readonly db: Database) {}

  async find(scope: ScopeContext, hostedTenantId: string, tx?: unknown, lock = false) {
    const query = executorOf(this.db, tx)
      .select()
      .from(hostedBotActivations)
      .where(
        and(
          eq(hostedBotActivations.tenantId, requireTenantId(scope)),
          eq(hostedBotActivations.hostedTenantId, hostedTenantId),
        ),
      )
      .limit(1);
    const [row] = await (lock && tx !== undefined ? query.for('update') : query);
    return row ? toRow(row) : null;
  }

  async ensure(scope: ScopeContext, hostedTenantId: string, now: Date, tx: unknown) {
    const tenantId = requireTenantId(scope);
    await executorOf(this.db, tx)
      .insert(hostedBotActivations)
      .values({ tenantId, hostedTenantId, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    const row = await this.find(scope, hostedTenantId, tx);
    if (row === null) throw new Error('hosted_bot_activations row missing after ensure');
    return row;
  }

  async patch(
    scope: ScopeContext,
    hostedTenantId: string,
    patch: HostedActivationPatch,
    now: Date,
    tx: unknown,
  ): Promise<void> {
    const set: Partial<typeof hostedBotActivations.$inferInsert> = { updatedAt: now };
    if (patch.botInstanceId !== undefined) set.botInstanceId = patch.botInstanceId;
    if (patch.domain !== undefined) set.domain = patch.domain;
    if (patch.tokenVerifiedAt !== undefined) set.tokenVerifiedAt = patch.tokenVerifiedAt;
    if (patch.dnsVerifiedAt !== undefined) set.dnsVerifiedAt = patch.dnsVerifiedAt;
    if (patch.tlsVerifiedAt !== undefined) set.tlsVerifiedAt = patch.tlsVerifiedAt;
    if (patch.webhookRegisteredAt !== undefined) {
      set.webhookRegisteredAt = patch.webhookRegisteredAt;
    }
    if (patch.error !== undefined) {
      set.lastErrorStep = patch.error === null ? null : patch.error.step;
      set.lastErrorCode = patch.error === null ? null : patch.error.code;
      set.lastErrorAt = patch.error === null ? null : now;
    }
    const updated = await executorOf(this.db, tx)
      .update(hostedBotActivations)
      .set(set)
      .where(
        and(
          eq(hostedBotActivations.tenantId, requireTenantId(scope)),
          eq(hostedBotActivations.hostedTenantId, hostedTenantId),
        ),
      )
      .returning({ id: hostedBotActivations.hostedTenantId });
    if (updated.length === 0) throw new Error('hosted_bot_activations row missing for patch');
  }

  async domainTaken(
    scope: ScopeContext,
    domain: string,
    exceptHostedTenantId: string,
    tx?: unknown,
  ): Promise<boolean> {
    const [row] = await executorOf(this.db, tx)
      .select({ id: hostedBotActivations.hostedTenantId })
      .from(hostedBotActivations)
      .where(
        and(
          eq(hostedBotActivations.tenantId, requireTenantId(scope)),
          eq(hostedBotActivations.domain, domain),
          ne(hostedBotActivations.hostedTenantId, exceptHostedTenantId),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async newestLink(scope: ScopeContext, hostedTenantId: string, tx?: unknown) {
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(hostedBotActivationLinks)
      .where(
        and(
          eq(hostedBotActivationLinks.tenantId, requireTenantId(scope)),
          eq(hostedBotActivationLinks.hostedTenantId, hostedTenantId),
        ),
      )
      .orderBy(desc(hostedBotActivationLinks.createdAt), desc(hostedBotActivationLinks.id))
      .limit(1);
    return row ? toLink(row) : null;
  }

  async revokeOpenLinks(
    scope: ScopeContext,
    hostedTenantId: string,
    now: Date,
    tx: unknown,
  ): Promise<number> {
    const revoked = await executorOf(this.db, tx)
      .update(hostedBotActivationLinks)
      .set({ revokedAt: now })
      .where(
        and(
          eq(hostedBotActivationLinks.tenantId, requireTenantId(scope)),
          eq(hostedBotActivationLinks.hostedTenantId, hostedTenantId),
          isNull(hostedBotActivationLinks.usedAt),
          isNull(hostedBotActivationLinks.revokedAt),
          gt(hostedBotActivationLinks.expiresAt, now),
        ),
      )
      .returning({ id: hostedBotActivationLinks.id });
    return revoked.length;
  }

  async insertLink(
    scope: ScopeContext,
    link: Parameters<HostedActivationRepository['insertLink']>[1],
    tx: unknown,
  ): Promise<void> {
    await executorOf(this.db, tx)
      .insert(hostedBotActivationLinks)
      .values({
        id: link.id,
        tenantId: requireTenantId(scope),
        hostedTenantId: link.hostedTenantId,
        tokenHash: link.tokenHash,
        createdByAdminId: link.createdByAdminId,
        createdAt: link.createdAt,
        expiresAt: link.expiresAt,
      });
  }
}
