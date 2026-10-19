import { and, eq, inArray } from 'drizzle-orm';
import { productCode, type TenantContext } from '@nexa/contracts';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import {
  orders,
  panels,
  payments,
  products,
  services,
  tickets,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  ProductLabel,
  PublicLabelReader,
  PublicLabelRequest,
  PublicLabels,
} from '../application/public-labels.js';

/** The ids asked for, without nulls or repeats. Every query is bounded by the page. */
function idsOf(ids: readonly (string | null)[] | undefined): string[] {
  return [...new Set((ids ?? []).filter((id): id is string => id !== null))];
}

/**
 * One query per table that was asked about, each over the primary key and inside the
 * tenant. A page asks for at most a page of ids, so each is a handful of index lookups.
 */
export class DrizzlePublicLabelReader implements PublicLabelReader {
  constructor(private readonly db: Database) {}

  async read(scope: TenantContext, request: PublicLabelRequest): Promise<PublicLabels> {
    const tenantId = requireTenantId(scope);
    const coded = async (
      table: typeof orders | typeof services | typeof payments | typeof tickets,
      requested: readonly (string | null)[] | undefined,
    ): Promise<ReadonlyMap<string, string | null>> => {
      const ids = idsOf(requested);
      const map = new Map<string, string | null>();
      if (ids.length === 0) return map;
      const rows = await this.db
        .select({ id: table.id, code: table.code })
        .from(table)
        .where(and(eq(table.tenantId, tenantId), inArray(table.id, ids)));
      for (const row of rows) map.set(row.id, row.code);
      return map;
    };

    const panelMap = new Map<string, string>();
    const panelIds = idsOf(request.panelIds);
    if (panelIds.length > 0) {
      const rows = await this.db
        .select({ id: panels.id, name: panels.name })
        .from(panels)
        .where(and(eq(panels.tenantId, tenantId), inArray(panels.id, panelIds)));
      for (const row of rows) panelMap.set(row.id, row.name);
    }

    const productMap = new Map<string, ProductLabel>();
    const productIds = idsOf(request.productIds);
    if (productIds.length > 0) {
      const rows = await this.db
        .select({ id: products.id, codeNumber: products.codeNumber, title: products.title })
        .from(products)
        .where(and(eq(products.tenantId, tenantId), inArray(products.id, productIds)));
      for (const row of rows) {
        productMap.set(row.id, {
          code: row.codeNumber === null ? null : productCode(row.codeNumber),
          title: row.title,
        });
      }
    }

    return {
      orders: await coded(orders, request.orderIds),
      services: await coded(services, request.serviceIds),
      payments: await coded(payments, request.paymentIds),
      tickets: await coded(tickets, request.ticketIds),
      panels: panelMap,
      products: productMap,
    };
  }
}
