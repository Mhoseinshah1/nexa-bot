import { and, eq, inArray, sql } from 'drizzle-orm';
import type { IdGenerator, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { walletHistoryImports } from '../../../../infrastructure/persistence/schema.js';
import {
  walletHistoryFingerprint,
  type WalletHistoryWrite,
} from '../application/wallet-history.step.js';
import { MIRZA_SOURCE, type PlannedRepository } from '../application/materialize-support.js';
import type { MaterializeContext } from '../application/ports.js';

/** Rows per INSERT: 14 parameters a row, so 4 000 rows stay under PostgreSQL's 65 535. */
const CHUNK = 4000;

/** `wallet_history_imports`: Mirza's wallet log beside the ledger, never part of it. */
export class DrizzleWalletHistoryRepository implements PlannedRepository<WalletHistoryWrite> {
  constructor(
    private readonly db: Database,
    private readonly ids: IdGenerator,
  ) {}

  private exec(tx?: TransactionScope): Executor {
    return tx?.tx ?? this.db;
  }

  async insert(
    scope: TenantContext,
    rows: readonly WalletHistoryWrite[],
    ctx: MaterializeContext,
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>> {
    const tenantId = requireTenantId(scope);
    const inserted = new Set<string>();
    for (let i = 0; i < rows.length; i += CHUNK) {
      const done = await this.exec(tx)
        .insert(walletHistoryImports)
        .values(
          rows.slice(i, i + CHUNK).map((row) => ({
            id: this.ids.uuid(),
            tenantId,
            customerId: row.customerId,
            source: MIRZA_SOURCE,
            sourceRef: row.sourceRef,
            origin: row.origin,
            occurredAt: row.occurredAt,
            direction: row.direction,
            amountMinor:
              row.signedAmountMinor < 0n ? -row.signedAmountMinor : row.signedAmountMinor,
            signedAmountMinor: row.signedAmountMinor,
            currency: row.currency,
            rawKind: row.rawKind,
            note: row.note,
            createdAt: ctx.now,
          })),
        )
        .onConflictDoNothing()
        .returning({ sourceRef: walletHistoryImports.sourceRef });
      for (const r of done) inserted.add(r.sourceRef);
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
      .from(walletHistoryImports)
      .where(
        and(
          eq(walletHistoryImports.tenantId, requireTenantId(scope)),
          inArray(walletHistoryImports.sourceRef, [...sourceRefs]),
        ),
      );
    for (const row of rows) {
      out.set(
        row.sourceRef,
        walletHistoryFingerprint({
          customerId: row.customerId,
          origin: row.origin as WalletHistoryWrite['origin'],
          occurredAt: row.occurredAt,
          direction: row.direction as WalletHistoryWrite['direction'],
          signedAmountMinor: row.signedAmountMinor,
          currency: row.currency,
          rawKind: row.rawKind,
          note: row.note,
        }),
      );
    }
    return out;
  }

  async totals(scope: TenantContext, origin: string | null) {
    const [row] = await this.db
      .select({
        rows: sql<number>`count(*)::int`,
        sum: sql<string | null>`sum(${walletHistoryImports.amountMinor})::text`,
      })
      .from(walletHistoryImports)
      .where(
        and(
          eq(walletHistoryImports.tenantId, requireTenantId(scope)),
          origin === null ? undefined : eq(walletHistoryImports.origin, origin),
        ),
      );
    return { rows: row?.rows ?? 0, sumMinor: row?.sum == null ? null : BigInt(row.sum) };
  }
}
