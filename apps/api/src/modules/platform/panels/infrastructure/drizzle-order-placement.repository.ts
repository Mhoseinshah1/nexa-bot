import { and, eq } from 'drizzle-orm';
import {
  PANEL_BALANCING_STRATEGIES,
  PANEL_PLACEMENT_DECIDERS,
  type PanelBalancingStrategy,
  type PanelPlacementDecider,
  type TenantContext,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { orderPanelPlacements } from '../../../../infrastructure/persistence/schema.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  OrderPlacementRepository,
  PlacementRecord,
  PlacementRow,
} from '../application/panel-placement.js';

/**
 * Phase C3: the placement explanation, one row per balanced order.
 *
 * Insert-only: a second write for the same order is refused by the primary key, and
 * `nexa_order_panel_placements_frozen` refuses an UPDATE — an explanation that could be
 * rewritten would explain something other than what was decided.
 */
export class DrizzleOrderPlacementRepository implements OrderPlacementRepository {
  constructor(private readonly db: Database) {}

  async record(
    scope: TenantContext,
    orderId: string,
    placement: PlacementRecord,
    tx: TransactionScope,
  ): Promise<void> {
    await tx.tx.insert(orderPanelPlacements).values({
      tenantId: scope.tenantId,
      orderId,
      homePanelId: placement.homePanelId,
      chosenPanelId: placement.chosenPanelId,
      balancingGroup: placement.group,
      strategy: placement.strategy,
      decidedBy: placement.decidedBy,
      candidates: placement.candidates,
      decidedAt: placement.decidedAt,
    });
  }

  async find(
    scope: TenantContext,
    orderId: string,
    tx?: TransactionScope,
  ): Promise<PlacementRecord | null> {
    const [row] = await (tx?.tx ?? this.db)
      .select()
      .from(orderPanelPlacements)
      .where(
        and(
          eq(orderPanelPlacements.tenantId, scope.tenantId),
          eq(orderPanelPlacements.orderId, orderId),
        ),
      )
      .limit(1);
    if (row === undefined) return null;
    // The CHECK constraints are what make these narrowings safe.
    if (
      !(PANEL_BALANCING_STRATEGIES as readonly string[]).includes(row.strategy) ||
      !(PANEL_PLACEMENT_DECIDERS as readonly string[]).includes(row.decidedBy)
    ) {
      throw new Error(`order_panel_placements row for ${orderId} is outside its vocabulary`);
    }
    return {
      homePanelId: row.homePanelId,
      chosenPanelId: row.chosenPanelId,
      group: row.balancingGroup,
      strategy: row.strategy as PanelBalancingStrategy,
      decidedBy: row.decidedBy as PanelPlacementDecider,
      candidates: row.candidates as PlacementRow[],
      decidedAt: row.decidedAt,
    };
  }
}
