import { and, asc, countDistinct, eq, or, sql } from 'drizzle-orm';
import type {
  DeliveryTutorialMode,
  DeliveryTutorialVideoOption,
  TenantContext,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import {
  clientApps,
  clientAppVideos,
  deliveryTutorials,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  DeliveryTutorialRecord,
  DeliveryTutorialRepository,
  DeliveryTutorialWrite,
} from '../application/delivery-tutorial.service.js';

type Row = typeof deliveryTutorials.$inferSelect;

function toRecord(row: Row): DeliveryTutorialRecord {
  return {
    panelId: row.panelId,
    // The CHECK built from DELIVERY_TUTORIAL_MODES admits nothing else.
    mode: row.mode as DeliveryTutorialMode,
    text: row.text,
    videoClientAppId: row.videoClientAppId,
    appliesToPurchase: row.appliesToPurchase,
    appliesToTrial: row.appliesToTrial,
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}

/**
 * `delivery_tutorials`, one row per configured panel (Phase 2 item 5).
 *
 * Every query names the tenant, and the composite foreign key makes a row naming another
 * tenant's panel unstorable. The write is conditional on the revision the operator was
 * shown — the panel trial repository's shape.
 */
export class DrizzleDeliveryTutorialRepository implements DeliveryTutorialRepository {
  constructor(private readonly db: Database) {}

  async find(
    scope: TenantContext,
    panelId: string,
    tx?: TransactionScope,
  ): Promise<DeliveryTutorialRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await (tx?.tx ?? this.db)
      .select()
      .from(deliveryTutorials)
      .where(and(eq(deliveryTutorials.tenantId, tenantId), eq(deliveryTutorials.panelId, panelId)))
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async save(
    scope: TenantContext,
    panelId: string,
    write: DeliveryTutorialWrite,
    expectedRevision: number,
    now: Date,
    tx: TransactionScope,
  ): Promise<DeliveryTutorialRecord | null> {
    const tenantId = requireTenantId(scope);
    if (expectedRevision === 0) {
      const [created] = await tx.tx
        .insert(deliveryTutorials)
        .values({
          tenantId,
          panelId,
          ...write,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      return created === undefined ? null : toRecord(created);
    }
    const [updated] = await tx.tx
      .update(deliveryTutorials)
      .set({
        ...write,
        revision: sql`${deliveryTutorials.revision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(deliveryTutorials.tenantId, tenantId),
          eq(deliveryTutorials.panelId, panelId),
          eq(deliveryTutorials.revision, expectedRevision),
        ),
      )
      .returning();
    return updated === undefined ? null : toRecord(updated);
  }

  async videoOptions(
    scope: TenantContext,
    include: string | null,
  ): Promise<readonly DeliveryTutorialVideoOption[]> {
    const tenantId = requireTenantId(scope);
    const bots = countDistinct(clientAppVideos.botInstanceId);
    const rows = await this.db
      .select({
        clientAppId: clientApps.id,
        name: clientApps.name,
        platform: clientApps.platform,
        status: clientApps.status,
        sortOrder: clientApps.sortOrder,
        botsWithVideo: bots,
      })
      .from(clientApps)
      .leftJoin(
        clientAppVideos,
        and(
          eq(clientAppVideos.tenantId, clientApps.tenantId),
          eq(clientAppVideos.clientAppId, clientApps.id),
        ),
      )
      .where(eq(clientApps.tenantId, tenantId))
      .groupBy(clientApps.id)
      .having(
        include === null ? sql`${bots} > 0` : or(sql`${bots} > 0`, eq(clientApps.id, include)),
      )
      .orderBy(asc(clientApps.platform), asc(clientApps.sortOrder), asc(clientApps.id));
    return rows.map((row) => ({
      clientAppId: row.clientAppId,
      name: row.name,
      platform: row.platform,
      enabled: row.status === 'ENABLED',
      botsWithVideo: Number(row.botsWithVideo),
    }));
  }
}
