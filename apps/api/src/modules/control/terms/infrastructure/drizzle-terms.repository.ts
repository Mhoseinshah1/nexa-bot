import { and, count, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  TERMS_ERROR_CODES,
  errors,
  type ScopeContext,
  type TermsAcceptanceSource,
  type TermsVersionStatus,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  admins,
  customers,
  termsAcceptances,
  termsVersions,
} from '../../../../infrastructure/persistence/schema.js';
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
import {
  isPublished,
  type PublishedTermsVersion,
  type TermsAcceptanceRecord,
  type TermsRepository,
  type TermsVersionRecord,
} from '../application/ports.js';

const creator = alias(admins, 'terms_creator');
const publisher = alias(admins, 'terms_publisher');

/** The columns a record is built from. Selected explicitly, in one place. */
const COLUMNS = {
  id: termsVersions.id,
  status: termsVersions.status,
  versionNumber: termsVersions.versionNumber,
  title: termsVersions.title,
  body: termsVersions.body,
  revision: termsVersions.revision,
  createdAt: termsVersions.createdAt,
  createdByAdminId: termsVersions.createdByAdminId,
  createdByUsername: creator.username,
  updatedAt: termsVersions.updatedAt,
  publishedAt: termsVersions.publishedAt,
  publishedByAdminId: termsVersions.publishedByAdminId,
  publishedByUsername: publisher.username,
} as const;

interface Row {
  readonly id: string;
  readonly status: string;
  readonly versionNumber: number | null;
  readonly title: string;
  readonly body: string;
  readonly revision: number;
  readonly createdAt: Date;
  readonly createdByAdminId: string | null;
  readonly createdByUsername: string | null;
  readonly updatedAt: Date;
  readonly publishedAt: Date | null;
  readonly publishedByAdminId: string | null;
  readonly publishedByUsername: string | null;
}

function toRecord(row: Row): TermsVersionRecord {
  return {
    ...row,
    // Cast rather than re-validated: `terms_versions_status_check` is built from
    // `TERMS_VERSION_STATUSES`, and the database is the boundary that guarantees it.
    status: row.status as TermsVersionStatus,
  };
}

const ONE_DRAFT = 'terms_versions_one_draft_key';

/**
 * The terms versions and acceptances, in PostgreSQL.
 *
 * Every query carries the tenant predicate, the id lookups included: an id is a UUID and
 * would find another tenant's row without it.
 */
export class DrizzleTermsRepository implements TermsRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /** The SELECT with both admin names joined; the caller adds the tenant predicate. */
  private joined(tx: unknown) {
    return this.exec(tx)
      .select(COLUMNS)
      .from(termsVersions)
      .leftJoin(
        creator,
        and(
          eq(creator.tenantId, termsVersions.tenantId),
          eq(creator.id, termsVersions.createdByAdminId),
        ),
      )
      .leftJoin(
        publisher,
        and(
          eq(publisher.tenantId, termsVersions.tenantId),
          eq(publisher.id, termsVersions.publishedByAdminId),
        ),
      )
      .$dynamic();
  }

  async list(scope: ScopeContext, tx?: unknown): Promise<readonly TermsVersionRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.joined(tx)
      .where(eq(termsVersions.tenantId, tenantId))
      .orderBy(sql`${termsVersions.versionNumber} DESC NULLS FIRST`, desc(termsVersions.id));
    return rows.map(toRecord);
  }

  async find(scope: ScopeContext, id: string, tx?: unknown): Promise<TermsVersionRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.joined(tx)
      .where(and(eq(termsVersions.tenantId, tenantId), eq(termsVersions.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findDraft(scope: ScopeContext, tx?: unknown): Promise<TermsVersionRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: termsVersions.id })
      .from(termsVersions)
      .where(and(eq(termsVersions.tenantId, tenantId), eq(termsVersions.status, 'DRAFT')))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : this.find(scope, row.id, tx);
  }

  async current(scope: ScopeContext, tx?: unknown): Promise<PublishedTermsVersion | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: termsVersions.id })
      .from(termsVersions)
      .where(and(eq(termsVersions.tenantId, tenantId), eq(termsVersions.status, 'PUBLISHED')))
      .orderBy(desc(termsVersions.versionNumber))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const found = await this.find(scope, row.id, tx);
    return found !== null && isPublished(found) ? found : null;
  }

  async insertDraft(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly title: string;
      readonly body: string;
      readonly adminId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<TermsVersionRecord> {
    const tenantId = requireTenantId(scope);
    try {
      await this.exec(tx).insert(termsVersions).values({
        id: input.id,
        tenantId,
        status: 'DRAFT',
        versionNumber: null,
        title: input.title,
        body: input.body,
        revision: 1,
        createdByAdminId: input.adminId,
        createdAt: input.now,
        updatedAt: input.now,
      });
    } catch (error) {
      if (isUniqueViolation(error, ONE_DRAFT)) {
        throw errors.conflict(
          TERMS_ERROR_CODES.TERMS_DRAFT_EXISTS,
          'A draft of the terms already exists; edit it.',
        );
      }
      throw error;
    }
    return this.required(scope, input.id, tx);
  }

  async updateDraft(
    scope: ScopeContext,
    id: string,
    input: {
      readonly title: string;
      readonly body: string;
      readonly expectedRevision: number;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<TermsVersionRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(termsVersions)
      .set({
        title: input.title,
        body: input.body,
        revision: sql`${termsVersions.revision} + 1`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(termsVersions.tenantId, tenantId),
          eq(termsVersions.id, id),
          eq(termsVersions.status, 'DRAFT'),
          eq(termsVersions.revision, input.expectedRevision),
        ),
      )
      .returning({ id: termsVersions.id });
    return rows[0] === undefined ? null : this.required(scope, id, tx);
  }

  async publish(
    scope: ScopeContext,
    id: string,
    input: {
      readonly expectedRevision: number;
      readonly adminId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<TermsVersionRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(termsVersions)
      .set({
        status: 'PUBLISHED',
        versionNumber: sql`(SELECT COALESCE(MAX(published.version_number), 0) + 1
          FROM terms_versions AS published
          WHERE published.tenant_id = ${tenantId} AND published.status = 'PUBLISHED')`,
        publishedAt: input.now,
        publishedByAdminId: input.adminId,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(termsVersions.tenantId, tenantId),
          eq(termsVersions.id, id),
          eq(termsVersions.status, 'DRAFT'),
          eq(termsVersions.revision, input.expectedRevision),
        ),
      )
      .returning({ id: termsVersions.id });
    return rows[0] === undefined ? null : this.required(scope, id, tx);
  }

  async acceptanceCounts(scope: ScopeContext, tx?: unknown): Promise<ReadonlyMap<string, number>> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ versionId: termsAcceptances.termsVersionId, n: count() })
      .from(termsAcceptances)
      .where(eq(termsAcceptances.tenantId, tenantId))
      .groupBy(termsAcceptances.termsVersionId);
    return new Map(rows.map((row) => [row.versionId, Number(row.n)]));
  }

  async customerCount(scope: ScopeContext, tx?: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ n: count() })
      .from(customers)
      .where(eq(customers.tenantId, tenantId));
    return Number(rows[0]?.n ?? 0);
  }

  async hasAccepted(
    scope: ScopeContext,
    customerId: string,
    termsVersionId: string,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: termsAcceptances.id })
      .from(termsAcceptances)
      .where(
        and(
          eq(termsAcceptances.tenantId, tenantId),
          eq(termsAcceptances.customerId, customerId),
          eq(termsAcceptances.termsVersionId, termsVersionId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async lastAcceptance(
    scope: ScopeContext,
    customerId: string,
    tx?: unknown,
  ): Promise<TermsAcceptanceRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({
        termsVersionId: termsAcceptances.termsVersionId,
        versionNumber: termsVersions.versionNumber,
        acceptedAt: termsAcceptances.acceptedAt,
      })
      .from(termsAcceptances)
      .innerJoin(
        termsVersions,
        and(
          eq(termsVersions.tenantId, termsAcceptances.tenantId),
          eq(termsVersions.id, termsAcceptances.termsVersionId),
        ),
      )
      .where(
        and(eq(termsAcceptances.tenantId, tenantId), eq(termsAcceptances.customerId, customerId)),
      )
      .orderBy(desc(termsVersions.versionNumber), desc(termsAcceptances.acceptedAt))
      .limit(1);
    const row = rows[0];
    // Only a published version can be accepted, so the number is never null here.
    if (row === undefined || row.versionNumber === null) return null;
    return {
      termsVersionId: row.termsVersionId,
      versionNumber: row.versionNumber,
      acceptedAt: row.acceptedAt,
    };
  }

  async insertAcceptance(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly customerId: string;
      readonly termsVersionId: string;
      readonly acceptedAt: Date;
      readonly source: TermsAcceptanceSource;
      readonly botInstanceId: string | null;
      readonly correlationId: string;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(termsAcceptances)
      .values({
        id: input.id,
        tenantId,
        customerId: input.customerId,
        termsVersionId: input.termsVersionId,
        acceptedAt: input.acceptedAt,
        source: input.source,
        botInstanceId: input.botInstanceId,
        correlationId: input.correlationId,
      })
      .onConflictDoNothing({
        target: [
          termsAcceptances.tenantId,
          termsAcceptances.customerId,
          termsAcceptances.termsVersionId,
        ],
      })
      .returning({ id: termsAcceptances.id });
    return rows.length > 0;
  }

  private async required(
    scope: ScopeContext,
    id: string,
    tx: unknown,
  ): Promise<TermsVersionRecord> {
    const found = await this.find(scope, id, tx);
    if (found === null) throw new Error('A terms version written in this transaction is missing.');
    return found;
  }
}
