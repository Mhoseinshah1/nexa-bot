import { sql } from 'drizzle-orm';
import { money, type CurrencyCode, type TenantContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { RecipientFacts, RecipientFactsReader } from '../application/ports.js';

/**
 * What a broadcast's placeholders are filled from, read at send time: the recipient's own
 * Telegram names and, only when the body asks for it, their balance derived from the ledger
 * in the tenant's selling currency. Nothing of any other customer.
 */
export class DrizzleRecipientFactsReader implements RecipientFactsReader {
  constructor(
    private readonly db: Database,
    private readonly sellingCurrency: (scope: TenantContext) => Promise<CurrencyCode>,
  ) {}

  async factsFor(
    scope: TenantContext,
    customerId: string,
    options: { readonly withBalance: boolean },
  ): Promise<RecipientFacts> {
    const tenantId = requireTenantId(scope);
    const currency = options.withBalance ? await this.sellingCurrency(scope) : null;
    const result = await this.db.execute<{
      first_name: string | null;
      username: string | null;
      balance: string | null;
    }>(sql`
      SELECT c.first_name, c.username,
             ${
               currency === null
                 ? sql`NULL::text`
                 : sql`(SELECT coalesce(sum(CASE WHEN w.direction = 'CREDIT' THEN w.amount
                                                 ELSE -w.amount END), 0)::text
                          FROM wallet_entries w
                         WHERE w.tenant_id = c.tenant_id AND w.customer_id = c.id
                           AND w.currency = ${currency})`
             } AS balance
        FROM customers c
       WHERE c.tenant_id = ${tenantId}::uuid AND c.id = ${customerId}::uuid`);
    const row = result.rows[0];
    return {
      firstName: row?.first_name ?? null,
      username: row?.username ?? null,
      walletBalance:
        currency === null || row?.balance === null || row?.balance === undefined
          ? null
          : money(BigInt(row.balance), currency),
    };
  }
}
