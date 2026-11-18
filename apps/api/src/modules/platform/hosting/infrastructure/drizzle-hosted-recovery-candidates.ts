import { and, asc, count, eq, gt, lte, ne, sql } from 'drizzle-orm';
import type { TenantContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { ScopeBound } from '../../../../infrastructure/persistence/database-scope.js';
import { hostedBots } from '../../../../infrastructure/persistence/schema.js';
import type { HostedRecoveryCandidates } from '../application/hosted-webhook-recovery.service.js';
import type { HostedBotRow } from '../application/ports.js';

/** The installation's register only, including stopped rows so the operator sees skips. */
@ScopeBound()
export class DrizzleHostedRecoveryCandidates implements HostedRecoveryCandidates {
  constructor(private readonly db: Database) {}

  async preview(scope: TenantContext) {
    const [row] = await this.db
      .select({
        count: count(),
        through: sql<string | null>`max(${hostedBots.hostedTenantId}::text)`,
      })
      .from(hostedBots)
      .where(
        and(eq(hostedBots.tenantId, scope.tenantId), ne(hostedBots.hostedTenantId, scope.tenantId)),
      );
    return { count: row?.count ?? 0, through: row?.through ?? null };
  }

  async page(
    scope: TenantContext,
    after: string | null,
    through: string,
  ): Promise<readonly HostedBotRow[]> {
    const rows = await this.db
      .select()
      .from(hostedBots)
      .where(
        and(
          eq(hostedBots.tenantId, scope.tenantId),
          ne(hostedBots.hostedTenantId, scope.tenantId),
          lte(hostedBots.hostedTenantId, through),
          after === null ? undefined : gt(hostedBots.hostedTenantId, after),
        ),
      )
      .orderBy(asc(hostedBots.hostedTenantId))
      .limit(50);
    return rows.map((row) => ({ ...row, state: row.state as HostedBotRow['state'] }));
  }
}
