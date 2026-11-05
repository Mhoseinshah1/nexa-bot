import { and, eq, isNotNull } from 'drizzle-orm';
import type { HostedBotState } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import {
  hostedBotActivationLinks,
  hostedBotActivations,
  hostedBots,
  tenants,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  HostedActivationLinkLookup,
  HostedDomainDirectory,
  HostedDomainResolution,
} from '../application/activation-ports.js';

/**
 * Phase 6A PR-4 — THE one place that reads ACROSS tenants before the tenant is known
 * (`HostedDomainDirectory`).
 *
 * Two questions only, both asked by a caller that has no tenant yet: "which hosted tenant owns
 * this request's Host?" and "which hosted tenant does this activation token's hash belong to?".
 * Both are unscoped by nature. What leaves here is a tenant id, a lifecycle word or a hash —
 * never a credential, a customer or a message. At the merge with RLS (ADR-0037) this class is
 * the one the lead routes through the system path (`SET ROLE nexa_system`,
 * `app.system_reason = 'hosting.resolve_host'`), and nothing else in this feature needs it.
 *
 * A domain is trusted only while `dns_verified_at` is set on its row; the hosted TENANT's own
 * status is what `certificateAllowed` adds, so a suspended bot is not issued a certificate.
 */
export class DrizzleHostedDomainDirectory implements HostedDomainDirectory {
  constructor(private readonly db: Database) {}

  async resolveHost(host: string): Promise<HostedDomainResolution | null> {
    const [row] = await this.db
      .select({
        installationTenantId: hostedBotActivations.tenantId,
        hostedTenantId: hostedBotActivations.hostedTenantId,
        ownerAdminId: hostedBots.ownerAdminId,
        state: hostedBots.state,
      })
      .from(hostedBotActivations)
      .innerJoin(
        hostedBots,
        and(
          eq(hostedBots.tenantId, hostedBotActivations.tenantId),
          eq(hostedBots.hostedTenantId, hostedBotActivations.hostedTenantId),
        ),
      )
      .where(
        and(eq(hostedBotActivations.domain, host), isNotNull(hostedBotActivations.dnsVerifiedAt)),
      )
      .limit(1);
    return row === undefined
      ? null
      : {
          installationTenantId: row.installationTenantId,
          hostedTenantId: row.hostedTenantId,
          ownerAdminId: row.ownerAdminId,
          botState: row.state as HostedBotState,
        };
  }

  async certificateAllowed(host: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: hostedBotActivations.hostedTenantId })
      .from(hostedBotActivations)
      .innerJoin(
        hostedBots,
        and(
          eq(hostedBots.tenantId, hostedBotActivations.tenantId),
          eq(hostedBots.hostedTenantId, hostedBotActivations.hostedTenantId),
        ),
      )
      .innerJoin(tenants, eq(tenants.id, hostedBotActivations.hostedTenantId))
      .where(
        and(
          eq(hostedBotActivations.domain, host),
          isNotNull(hostedBotActivations.dnsVerifiedAt),
          eq(hostedBots.state, 'ACTIVE'),
          eq(tenants.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async findLinkByHash(tokenHash: string): Promise<HostedActivationLinkLookup | null> {
    const [row] = await this.db
      .select({
        id: hostedBotActivationLinks.id,
        tenantId: hostedBotActivationLinks.tenantId,
        hostedTenantId: hostedBotActivationLinks.hostedTenantId,
        tokenHash: hostedBotActivationLinks.tokenHash,
        createdAt: hostedBotActivationLinks.createdAt,
        expiresAt: hostedBotActivationLinks.expiresAt,
        usedAt: hostedBotActivationLinks.usedAt,
        revokedAt: hostedBotActivationLinks.revokedAt,
        ownerAdminId: hostedBots.ownerAdminId,
        state: hostedBots.state,
      })
      .from(hostedBotActivationLinks)
      .innerJoin(
        hostedBots,
        and(
          eq(hostedBots.tenantId, hostedBotActivationLinks.tenantId),
          eq(hostedBots.hostedTenantId, hostedBotActivationLinks.hostedTenantId),
        ),
      )
      .where(eq(hostedBotActivationLinks.tokenHash, tokenHash))
      .limit(1);
    if (row === undefined) return null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      hostedTenantId: row.hostedTenantId,
      tokenHash: row.tokenHash,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      usedAt: row.usedAt,
      revokedAt: row.revokedAt,
      ownerAdminId: row.ownerAdminId,
      botState: row.state as HostedBotState,
    };
  }
}
