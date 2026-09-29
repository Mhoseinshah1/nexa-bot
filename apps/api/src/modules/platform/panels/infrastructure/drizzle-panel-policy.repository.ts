import { and, eq, sql } from 'drizzle-orm';
import type { PanelPolicy, TenantContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { panelPolicies } from '../../../../infrastructure/persistence/schema.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PanelPolicyRepository, StoredPanelPolicy } from '../application/panel-policy.js';

/**
 * `panel_policies`, one row per configured panel (WP-A8).
 *
 * Every query names the tenant, and the composite foreign key makes a row naming
 * another tenant's panel unstorable, so a policy can only ever apply to the panel it
 * was written for.
 */
export class DrizzlePanelPolicyRepository implements PanelPolicyRepository {
  constructor(private readonly db: Database) {}

  async find(
    scope: TenantContext,
    panelId: string,
    tx?: TransactionScope,
  ): Promise<StoredPanelPolicy | null> {
    const [row] = await (tx?.tx ?? this.db)
      .select({
        policy: panelPolicies.policy,
        revision: panelPolicies.revision,
        updatedAt: panelPolicies.updatedAt,
      })
      .from(panelPolicies)
      .where(and(eq(panelPolicies.tenantId, scope.tenantId), eq(panelPolicies.panelId, panelId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * A conditional write, never a blind upsert.
   *
   * Revision zero is "no row": the INSERT does nothing on a conflict, so a row another
   * writer created first is reported as stale rather than overwritten. Any other
   * revision is an UPDATE naming it, which moves the row only from the state the
   * operator was shown.
   */
  async save(
    scope: TenantContext,
    panelId: string,
    policy: PanelPolicy,
    expectedRevision: number,
    now: Date,
    tx: TransactionScope,
  ): Promise<StoredPanelPolicy | null> {
    const returning = {
      policy: panelPolicies.policy,
      revision: panelPolicies.revision,
      updatedAt: panelPolicies.updatedAt,
    };
    if (expectedRevision === 0) {
      const [created] = await tx.tx
        .insert(panelPolicies)
        .values({
          tenantId: scope.tenantId,
          panelId,
          policy,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning(returning);
      return created ?? null;
    }
    const [updated] = await tx.tx
      .update(panelPolicies)
      .set({ policy, revision: sql`${panelPolicies.revision} + 1`, updatedAt: now })
      .where(
        and(
          eq(panelPolicies.tenantId, scope.tenantId),
          eq(panelPolicies.panelId, panelId),
          eq(panelPolicies.revision, expectedRevision),
        ),
      )
      .returning(returning);
    return updated ?? null;
  }
}
