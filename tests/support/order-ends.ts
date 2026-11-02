import { sql } from 'drizzle-orm';
import { money, type CurrencyCode, type OrderPurpose, type TenantContext } from '@nexa/contracts';
import { orderEndScreen } from '../../apps/api/src/modules/commerce/messaging/application/order-end-screen';

/**
 * R11 A11: a stand-in for the reader production wires as `CustomerNotificationDeps.orderEnds`
 * (the order repository + `orderEndScreen`), for a suite that builds its own dispatcher and
 * inserts its orders as bare rows — whose `'{"trace":[]}'` quote the repository would refuse
 * to map. It reads only the columns the ended screen draws, from the REAL row, and renders
 * them through the same `orderEndScreen`. Without a reader the dispatcher sends nothing for
 * `ORDER_EXPIRED` / `ORDER_CANCELLED`.
 */
export function orderEndsReader(db: {
  execute(query: ReturnType<typeof sql>): Promise<{ rows: unknown[] }>;
}) {
  return {
    screenFor: async (scope: TenantContext, orderId: string) => {
      const found = (
        await db.execute(sql`
          SELECT state, code, purpose, line_title, total_amount, currency
            FROM orders WHERE tenant_id = ${scope.tenantId} AND id = ${orderId}`)
      ).rows[0] as
        | {
            state: string;
            code: string | null;
            purpose: OrderPurpose;
            line_title: string;
            total_amount: string | bigint;
            currency: CurrencyCode;
          }
        | undefined;
      if (found === undefined) return null;
      const total = money(BigInt(found.total_amount), found.currency);
      return {
        state: found.state,
        screen: orderEndScreen({
          code: found.code,
          purpose: found.purpose,
          line: { title: found.line_title, category: null } as never,
          totals: { total } as never,
        }),
      };
    },
  };
}
