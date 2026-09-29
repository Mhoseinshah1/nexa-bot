import { and, asc, eq, sql } from 'drizzle-orm';
import type { PanelId, TenantContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { panelTrialConfigs } from '../../../../infrastructure/persistence/schema.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  PanelTrialConfigRecord,
  PanelTrialConfigRepository,
  PanelTrialConfigWrite,
} from '../application/ports.js';

type Row = typeof panelTrialConfigs.$inferSelect;

function toRecord(row: Row): PanelTrialConfigRecord {
  return {
    panelId: row.panelId as PanelId,
    enabled: row.enabled,
    trafficBytes: row.trafficBytes,
    durationHours: row.durationHours,
    label: row.label,
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}

/**
 * `panel_trial_configs`, one row per configured panel (R1).
 *
 * Every query names the tenant, and the composite foreign key makes a row naming another
 * tenant's panel unstorable. The write is conditional on the revision the operator was
 * shown — the panel policy repository's shape (WP-A8), for the same reason.
 */
export class DrizzlePanelTrialConfigRepository implements PanelTrialConfigRepository {
  constructor(private readonly db: Database) {}

  async find(
    scope: TenantContext,
    panelId: string,
    tx?: TransactionScope,
  ): Promise<PanelTrialConfigRecord | null> {
    const [row] = await (tx?.tx ?? this.db)
      .select()
      .from(panelTrialConfigs)
      .where(
        and(eq(panelTrialConfigs.tenantId, scope.tenantId), eq(panelTrialConfigs.panelId, panelId)),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async list(
    scope: TenantContext,
    tx?: TransactionScope,
  ): Promise<readonly PanelTrialConfigRecord[]> {
    const rows = await (tx?.tx ?? this.db)
      .select()
      .from(panelTrialConfigs)
      .where(eq(panelTrialConfigs.tenantId, scope.tenantId))
      .orderBy(asc(panelTrialConfigs.panelId));
    return rows.map(toRecord);
  }

  /**
   * Revision zero is "no row": the INSERT does nothing on a conflict, so a row another
   * writer created first is reported as stale rather than overwritten. Any other revision
   * is an UPDATE naming it.
   */
  async save(
    scope: TenantContext,
    panelId: string,
    write: PanelTrialConfigWrite,
    expectedRevision: number,
    now: Date,
    tx: TransactionScope,
  ): Promise<PanelTrialConfigRecord | null> {
    if (expectedRevision === 0) {
      const [created] = await tx.tx
        .insert(panelTrialConfigs)
        .values({
          tenantId: scope.tenantId,
          panelId,
          enabled: write.enabled,
          trafficBytes: write.trafficBytes,
          durationHours: write.durationHours,
          label: write.label,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      return created === undefined ? null : toRecord(created);
    }
    const [updated] = await tx.tx
      .update(panelTrialConfigs)
      .set({
        enabled: write.enabled,
        trafficBytes: write.trafficBytes,
        durationHours: write.durationHours,
        label: write.label,
        revision: sql`${panelTrialConfigs.revision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(panelTrialConfigs.tenantId, scope.tenantId),
          eq(panelTrialConfigs.panelId, panelId),
          eq(panelTrialConfigs.revision, expectedRevision),
        ),
      )
      .returning();
    return updated === undefined ? null : toRecord(updated);
  }
}
