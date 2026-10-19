import { and, eq, inArray, sql } from 'drizzle-orm';
import type { IdGenerator, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { payments } from '../../../../infrastructure/persistence/schema.js';
import { paymentFingerprint, type PaymentWrite } from '../application/payment-history.step.js';
import { MIRZA_SOURCE, type PlannedRepository } from '../application/materialize-support.js';
import type { MaterializeContext } from '../application/ports.js';

/** Payments per INSERT: 18 parameters a row, so 3 000 rows stay under PostgreSQL's 65 535. */
const CHUNK = 3000;

/**
 * `payments` rows of source MIRZA. Direct inserts: this is the one place the import writes a
 * payment, and it writes a RECORD — terminal state, no order, no ledger entry, no event.
 */
export class DrizzlePaymentHistoryRepository implements PlannedRepository<PaymentWrite> {
  constructor(
    private readonly db: Database,
    private readonly ids: IdGenerator,
  ) {}

  private exec(tx?: TransactionScope): Executor {
    return tx?.tx ?? this.db;
  }

  async insert(
    scope: TenantContext,
    rows: readonly PaymentWrite[],
    _ctx: MaterializeContext,
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>> {
    const tenantId = requireTenantId(scope);
    const inserted = new Set<string>();
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const done = await this.exec(tx)
        .insert(payments)
        .values(
          chunk.map((row) => {
            const confirmed = row.state === 'CONFIRMED';
            return {
              id: this.ids.uuid(),
              tenantId,
              customerId: row.customerId,
              orderId: null,
              state: row.state,
              method: row.method,
              amount: row.amountMinor,
              currency: row.currency,
              reference: `mirza:${row.sourceRef}`,
              evidenceKind: confirmed ? 'LEGACY_IMPORT' : null,
              evidenceNote: confirmed ? row.note : null,
              confirmedAt: confirmed ? row.settledAt : null,
              resolvedAt: confirmed ? null : row.settledAt,
              resolutionNote: confirmed ? null : row.note,
              createdAt: row.createdAt,
              updatedAt: row.settledAt,
              source: MIRZA_SOURCE,
              sourceRef: row.sourceRef,
            };
          }),
        )
        .onConflictDoNothing()
        .returning({ sourceRef: payments.sourceRef });
      for (const r of done) if (r.sourceRef !== null) inserted.add(r.sourceRef);
    }
    return inserted;
  }

  async fingerprints(
    scope: TenantContext,
    wanted: readonly { readonly sourceRef: string }[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    if (wanted.length === 0) return out;
    const sourceRefs = wanted.map((w) => w.sourceRef);
    const rows = await this.exec(tx)
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, requireTenantId(scope)),
          inArray(payments.sourceRef, [...sourceRefs]),
        ),
      );
    for (const row of rows) {
      if (row.sourceRef === null) continue;
      out.set(
        row.sourceRef,
        paymentFingerprint({
          customerId: row.customerId,
          state: row.state as PaymentWrite['state'],
          method: row.method as PaymentWrite['method'],
          amountMinor: row.amount,
          currency: row.currency,
          createdAt: row.createdAt,
          settledAt: (row.confirmedAt ?? row.resolvedAt) as Date,
          note: '',
        }),
      );
    }
    return out;
  }

  async totals(scope: TenantContext) {
    const [row] = await this.db
      .select({
        rows: sql<number>`count(*)::int`,
        sum: sql<string | null>`sum(${payments.amount})::text`,
      })
      .from(payments)
      .where(and(eq(payments.tenantId, requireTenantId(scope)), eq(payments.source, MIRZA_SOURCE)));
    return { rows: row?.rows ?? 0, sumMinor: row?.sum == null ? null : BigInt(row.sum) };
  }
}
