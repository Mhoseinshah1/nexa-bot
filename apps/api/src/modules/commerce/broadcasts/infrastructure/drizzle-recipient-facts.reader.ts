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
/**
 * R4 A6: how many services the recipient sees in «سرویس‌های من», and how many of them serve
 * now — from the provisioning module's OWN list predicate (`listedCountsForCustomer`), so the
 * broadcast and the bot's counter «کل: N سرویس» cannot disagree.
 */
export interface RecipientServiceCounts {
  listedCountsForCustomer(
    scope: TenantContext,
    customerId: string,
    now: Date,
  ): Promise<{ readonly listed: number; readonly serving: number }>;
}

export class DrizzleRecipientFactsReader implements RecipientFactsReader {
  constructor(
    private readonly db: Database,
    private readonly sellingCurrency: (scope: TenantContext) => Promise<CurrencyCode>,
    private readonly services?: RecipientServiceCounts,
  ) {}

  async factsFor(
    scope: TenantContext,
    customerId: string,
    options: {
      readonly withBalance: boolean;
      readonly withServices?: boolean;
      readonly now?: Date;
    },
  ): Promise<RecipientFacts> {
    const tenantId = requireTenantId(scope);
    const currency = options.withBalance ? await this.sellingCurrency(scope) : null;
    const result = await this.db.execute<{
      first_name: string | null;
      username: string | null;
      telegram_user_id: string | null;
      phone_number: string | null;
      balance: string | null;
    }>(sql`
      SELECT c.first_name, c.username, c.telegram_user_id, c.phone_number,
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
    const counts =
      options.withServices === true && options.now !== undefined && this.services !== undefined
        ? await this.services.listedCountsForCustomer(scope, customerId, options.now)
        : null;
    return {
      firstName: row?.first_name ?? null,
      username: row?.username ?? null,
      walletBalance:
        currency === null || row?.balance === null || row?.balance === undefined
          ? null
          : money(BigInt(row.balance), currency),
      telegramId: row?.telegram_user_id ?? null,
      phone: row?.phone_number ?? null,
      ...(counts === null ? {} : { servicesTotal: counts.listed, servicesActive: counts.serving }),
      ...(options.now === undefined ? {} : { today: options.now }),
    };
  }
}
