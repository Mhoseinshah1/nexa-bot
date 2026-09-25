import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { ScopeContext, SupportFaqInput, SupportFaqStatus } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { supportFaqSeeds, supportFaqs } from '../../../../infrastructure/persistence/schema.js';
import type { SupportFaqRecord, SupportFaqRepository } from '../application/ports.js';

/** The columns the record is built from. Selected explicitly, in one place. */
const COLUMNS = {
  id: supportFaqs.id,
  question: supportFaqs.question,
  answer: supportFaqs.answer,
  status: supportFaqs.status,
  sortOrder: supportFaqs.sortOrder,
  version: supportFaqs.version,
  createdAt: supportFaqs.createdAt,
  updatedAt: supportFaqs.updatedAt,
} as const;

interface Row {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly status: string;
  readonly sortOrder: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toRecord(row: Row): SupportFaqRecord {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    // Cast rather than re-validated: `support_faqs_status_check` is built from
    // `SUPPORT_FAQ_STATUSES`, and the database is the boundary that guarantees it.
    status: row.status as SupportFaqStatus,
    sortOrder: row.sortOrder,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The FAQ rows and the seed marker, in PostgreSQL.
 *
 * Every query carries `eq(supportFaqs.tenantId, …)`, the id lookups included: an id is
 * a UUID and would find another tenant's row without it, and the service answers that
 * case as "no such entry" only because this predicate makes it so.
 */
export class DrizzleSupportFaqRepository implements SupportFaqRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async list(
    scope: ScopeContext,
    options: { readonly status?: SupportFaqStatus } = {},
    tx?: unknown,
  ): Promise<readonly SupportFaqRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select(COLUMNS)
      .from(supportFaqs)
      .where(
        and(
          eq(supportFaqs.tenantId, tenantId),
          options.status === undefined ? undefined : eq(supportFaqs.status, options.status),
        ),
      )
      .orderBy(asc(supportFaqs.sortOrder), asc(supportFaqs.createdAt), asc(supportFaqs.id));
    return rows.map(toRecord);
  }

  async find(scope: ScopeContext, id: string, tx?: unknown): Promise<SupportFaqRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select(COLUMNS)
      .from(supportFaqs)
      .where(and(eq(supportFaqs.tenantId, tenantId), eq(supportFaqs.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async insert(
    scope: ScopeContext,
    input: SupportFaqInput & {
      readonly id: string;
      readonly status: SupportFaqStatus;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<SupportFaqRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(supportFaqs)
      .values({
        id: input.id,
        tenantId,
        question: input.question,
        answer: input.answer,
        status: input.status,
        sortOrder: input.sortOrder,
        version: 1,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning(COLUMNS);
    const row = rows[0];
    if (row === undefined) throw new Error('INSERT … RETURNING produced no row.');
    return toRecord(row);
  }

  /**
   * The version is in the WHERE, never checked and then written. A read-then-write
   * would let two editors both see version 3 and both write, and the second would
   * silently replace the first — the exact overwrite `expectedVersion` exists to refuse.
   */
  async update(
    scope: ScopeContext,
    id: string,
    input: SupportFaqInput & { readonly expectedVersion: number },
    now: Date,
    tx: unknown,
  ): Promise<SupportFaqRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(supportFaqs)
      .set({
        question: input.question,
        answer: input.answer,
        sortOrder: input.sortOrder,
        version: sql`${supportFaqs.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(supportFaqs.tenantId, tenantId),
          eq(supportFaqs.id, id),
          eq(supportFaqs.version, input.expectedVersion),
        ),
      )
      .returning(COLUMNS);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async setStatus(
    scope: ScopeContext,
    id: string,
    input: {
      readonly from: SupportFaqStatus;
      readonly to: SupportFaqStatus;
      readonly expectedVersion: number;
    },
    now: Date,
    tx: unknown,
  ): Promise<SupportFaqRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(supportFaqs)
      .set({ status: input.to, version: sql`${supportFaqs.version} + 1`, updatedAt: now })
      .where(
        and(
          eq(supportFaqs.tenantId, tenantId),
          eq(supportFaqs.id, id),
          eq(supportFaqs.status, input.from),
          eq(supportFaqs.version, input.expectedVersion),
        ),
      )
      .returning(COLUMNS);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async count(scope: ScopeContext, tx?: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ total: count() })
      .from(supportFaqs)
      .where(eq(supportFaqs.tenantId, tenantId));
    return Number(rows[0]?.total ?? 0);
  }

  async hasSeed(scope: ScopeContext, tx?: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ tenantId: supportFaqSeeds.tenantId })
      .from(supportFaqSeeds)
      .where(eq(supportFaqSeeds.tenantId, tenantId))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * `ON CONFLICT DO NOTHING` on the primary key, and the answer is the row count.
   *
   * The loser of a race WAITS here for the winner's transaction and then sees zero rows
   * — a unique violation handled as data rather than as an exception, which matters
   * because an exception would abort the loser's transaction and nothing could be read
   * inside it afterwards.
   */
  async markSeeded(scope: ScopeContext, now: Date, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const inserted = await this.exec(tx)
      .insert(supportFaqSeeds)
      .values({ tenantId, seededAt: now })
      .onConflictDoNothing()
      .returning({ tenantId: supportFaqSeeds.tenantId });
    return inserted.length > 0;
  }
}
