import type { PoolClient } from 'pg';
import type { DatabaseHandle } from '../../../../infrastructure/persistence/database.js';
import type {
  NexaCustomerWallet,
  NexaHeldUser,
  NexaResellerRow,
} from '../application/cutover-reconciliation.js';
import type {
  NexaServiceCandidate,
  NexaServiceRow,
} from '../application/cutover-service-reconciliation.js';

/**
 * The NEXA half of the cutover reconciliation: what the database holds now, for one tenant,
 * read inside ONE `REPEATABLE READ, READ ONLY` transaction that is always rolled back. A
 * READ ONLY transaction cannot write — PostgreSQL refuses any INSERT, UPDATE, DELETE or DDL in
 * it (25006) — so this reader is read-only by the server's rule, not by convention.
 *
 * The wallet is summed over EVERY ledger entry, whatever its reason: the point is to compare
 * the balance a customer has, not the openings the importer says it posted.
 */

export interface NexaCutoverState {
  readonly tenantId: string;
  readonly customers: readonly NexaCustomerWallet[];
  readonly heldUsers: ReadonlyMap<string, NexaHeldUser>;
  readonly resellers: readonly NexaResellerRow[];
  readonly legacyDebtRows: number;
}

export class CutoverTenantNotFound extends Error {
  override readonly name = 'CutoverTenantNotFound';
}

const OPENING_REASON = 'MIGRATION_OPENING_BALANCE';

async function tenantIdOf(client: PoolClient, slug: string | null): Promise<string> {
  const result =
    slug === null
      ? await client.query<{ id: string }>(`SELECT id FROM tenants WHERE kind = 'PRIMARY'`)
      : await client.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = $1`, [slug]);
  if (result.rows.length !== 1) {
    throw new CutoverTenantNotFound(
      slug === null ? 'the database has no single PRIMARY tenant' : `no tenant has slug ${slug}`,
    );
  }
  return (result.rows[0] as { id: string }).id;
}

export async function readNexaCutoverState(
  handle: DatabaseHandle,
  options: { readonly tenantSlug: string | null; readonly statementTimeoutMs: number },
): Promise<NexaCutoverState> {
  return handle.withClient(async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query(`SET LOCAL statement_timeout = ${String(options.statementTimeoutMs)}`);
      const tenantId = await tenantIdOf(client, options.tenantSlug);

      const customerRows = await client.query<{ id: string; telegram_user_id: string }>(
        `SELECT id, telegram_user_id FROM customers WHERE tenant_id = $1`,
        [tenantId],
      );
      const walletRows = await client.query<{
        customer_id: string;
        currency: string;
        signed: string;
        non_opening: number;
      }>(
        `SELECT customer_id, currency,
                sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)::text AS signed,
                count(*) FILTER (WHERE reason <> $2)::int AS non_opening
           FROM wallet_entries
          WHERE tenant_id = $1
          GROUP BY customer_id, currency`,
        [tenantId, OPENING_REASON],
      );
      const balances = new Map<string, Map<string, bigint>>();
      const nonOpening = new Map<string, number>();
      for (const w of walletRows.rows) {
        const perCurrency = balances.get(w.customer_id) ?? new Map<string, bigint>();
        perCurrency.set(w.currency, BigInt(w.signed));
        balances.set(w.customer_id, perCurrency);
        nonOpening.set(w.customer_id, (nonOpening.get(w.customer_id) ?? 0) + w.non_opening);
      }
      const customers: NexaCustomerWallet[] = customerRows.rows.map((c) => ({
        customerId: c.id,
        telegramUserId: c.telegram_user_id,
        balances: balances.get(c.id) ?? new Map<string, bigint>(),
        nonOpeningEntries: nonOpening.get(c.id) ?? 0,
      }));

      const heldRows = await client.query<{
        legacy_id: string;
        status: string;
        reason_code: string | null;
      }>(
        `SELECT legacy_id, status, reason_code
           FROM legacy_import_map
          WHERE tenant_id = $1 AND legacy_table = 'user' AND status <> 'IMPORTED'`,
        [tenantId],
      );
      const heldUsers = new Map<string, NexaHeldUser>(
        heldRows.rows.map((h) => [h.legacy_id, { status: h.status, reasonCode: h.reason_code }]),
      );

      const resellerRows = await client.query<{
        id: string;
        customer_id: string;
        source: string;
        status: string;
        credit_limit_amount: string | null;
        tier_credit_limit_amount: string | null;
        imported_purchase_cap_minor: string | null;
      }>(
        `SELECT r.id, r.customer_id, r.source, r.status,
                r.credit_limit_amount::text AS credit_limit_amount,
                t.credit_limit_amount::text AS tier_credit_limit_amount,
                r.imported_purchase_cap_minor::text AS imported_purchase_cap_minor
           FROM resellers r
           JOIN reseller_tiers t ON t.tenant_id = r.tenant_id AND t.id = r.tier_id
          WHERE r.tenant_id = $1`,
        [tenantId],
      );
      const big = (v: string | null): bigint | null => (v === null ? null : BigInt(v));
      const resellers: NexaResellerRow[] = resellerRows.rows.map((r) => ({
        resellerId: r.id,
        customerId: r.customer_id,
        source: r.source,
        status: r.status,
        creditLimitAmount: big(r.credit_limit_amount),
        tierCreditLimitAmount: big(r.tier_credit_limit_amount),
        importedPurchaseCapMinor: big(r.imported_purchase_cap_minor),
      }));

      const debts = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM legacy_wallet_debts WHERE tenant_id = $1`,
        [tenantId],
      );

      return {
        tenantId,
        customers,
        heldUsers,
        resellers,
        legacyDebtRows: debts.rows[0]?.n ?? 0,
      };
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

/** The NEXA half of the SERVICE reconciliation (`cutover-service-reconciliation.ts`). */
export interface NexaServiceState {
  readonly tenantId: string;
  readonly candidates: readonly NexaServiceCandidate[];
  readonly services: readonly NexaServiceRow[];
}

/**
 * Every recorded service outcome and every service of one tenant, in the same kind of
 * `REPEATABLE READ, READ ONLY` transaction as `readNexaCutoverState`, always rolled back.
 */
export async function readNexaServiceState(
  handle: DatabaseHandle,
  options: { readonly tenantSlug: string | null; readonly statementTimeoutMs: number },
): Promise<NexaServiceState> {
  return handle.withClient(async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query(`SET LOCAL statement_timeout = ${String(options.statementTimeoutMs)}`);
      const tenantId = await tenantIdOf(client, options.tenantSlug);
      const candidates = await client.query<{
        invoice_key: string;
        outcome: string;
        service_id: string | null;
      }>(
        `SELECT invoice_key, outcome, service_id
           FROM legacy_service_candidates
          WHERE tenant_id = $1`,
        [tenantId],
      );
      const services = await client.query<{
        id: string;
        state: string;
        source: string | null;
        source_ref: string | null;
        telegram_user_id: string | null;
      }>(
        `SELECT s.id, s.state, s.source, s.source_ref, c.telegram_user_id
           FROM services s
           LEFT JOIN customers c ON c.tenant_id = s.tenant_id AND c.id = s.customer_id
          WHERE s.tenant_id = $1`,
        [tenantId],
      );
      return {
        tenantId,
        candidates: candidates.rows.map((c) => ({
          invoiceKey: c.invoice_key,
          outcome: c.outcome as NexaServiceCandidate['outcome'],
          serviceId: c.service_id,
        })),
        services: services.rows.map((s) => ({
          serviceId: s.id,
          state: s.state,
          source: s.source,
          sourceRef: s.source_ref,
          ownerTelegramId: s.telegram_user_id,
        })),
      };
    } finally {
      await client.query('ROLLBACK');
    }
  });
}
