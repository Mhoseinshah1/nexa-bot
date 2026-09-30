import { sql, type SQL } from 'drizzle-orm';
import {
  canonicalAudienceDefinition,
  type FrozenAudienceKind,
  type TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { FrozenAudienceRecord, FrozenAudienceRepository } from '../application/ports.js';
import { audienceCustomersQuery, fingerprintOf, type AudienceEvaluation } from './audience-sql.js';

type Instant = Date | string;
const date = (value: Instant): Date => (value instanceof Date ? value : new Date(value));

interface HeaderRow {
  id: string;
  kind: FrozenAudienceKind;
  definition: unknown;
  definition_hash: string;
  as_of: Instant;
  member_count: number;
  fingerprint: string;
  created_at: Instant;
  released_at: Instant | null;
}

/**
 * Frozen audiences in PostgreSQL (round N close, `docs/round-n-close-audit.md` §A).
 *
 * The members are written by ONE `INSERT … SELECT` over the same audience query the preview
 * counted, in the confirming transaction, and the header's count and fingerprint are then
 * computed from the rows written — never from a second evaluation, which could differ from
 * the first by a registration in between. After the commit nothing updates a member row:
 * the only later write is the release sweep, which deletes the rows of audiences no live
 * record names and stamps `released_at`, and every reference to the header is `ON DELETE
 * RESTRICT`, so a header outlives everything that ever pointed at it.
 */
export class DrizzleFrozenAudienceRepository implements FrozenAudienceRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  private async rows<T>(query: SQL, tx?: unknown): Promise<T[]> {
    const result = await this.exec(tx).execute<T & Record<string, unknown>>(query);
    return result.rows as T[];
  }

  async freezeCustomers(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly evaluation: AudienceEvaluation;
      readonly definitionJson: string;
      readonly definitionHash: string;
      readonly createdByAdminId: string | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ) {
    const tenantId = requireTenantId(scope);
    await this.insertHeader(
      tenantId,
      {
        id: input.id,
        kind: 'CUSTOMERS',
        definitionJson: input.definitionJson,
        definitionHash: input.definitionHash,
        asOf: input.evaluation.asOf,
        createdByAdminId: input.createdByAdminId,
        now: input.now,
      },
      tx,
    );
    await this.exec(tx).execute(sql`
      INSERT INTO frozen_audience_members (tenant_id, frozen_audience_id, customer_id, service_id,
                                           bot_instance_id, chat_id)
      SELECT ${tenantId}::uuid, ${input.id}::uuid, a.customer_id, NULL, a.bot_instance_id, a.chat_id
        FROM (${audienceCustomersQuery(input.evaluation)}) a`);
    return this.stampMembers(scope, input.id, 'CUSTOMER', tx);
  }

  async insertServicesHeader(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly definitionJson: string;
      readonly definitionHash: string;
      readonly asOf: Date;
      readonly createdByAdminId: string | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<void> {
    await this.insertHeader(requireTenantId(scope), { ...input, kind: 'SERVICES' }, tx);
  }

  private async insertHeader(
    tenantId: string,
    input: {
      readonly id: string;
      readonly kind: FrozenAudienceKind;
      readonly definitionJson: string;
      readonly definitionHash: string;
      readonly asOf: Date;
      readonly createdByAdminId: string | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<void> {
    // The count and fingerprint are provisional until `stampMembers` seals them from the
    // rows written; an empty fingerprint is md5 of the empty string, as `fingerprintOf` gives.
    await this.exec(tx).execute(sql`
      INSERT INTO frozen_audiences (id, tenant_id, kind, definition, definition_hash, as_of,
                                    member_count, fingerprint, created_by_admin_id, created_at)
      VALUES (${input.id}::uuid, ${tenantId}::uuid, ${input.kind}, ${input.definitionJson}::jsonb,
              ${input.definitionHash}, ${input.asOf.toISOString()}::timestamptz, 0,
              md5(''), ${input.createdByAdminId}::uuid, ${input.now.toISOString()}::timestamptz)`);
  }

  async stampMembers(
    scope: TenantContext,
    id: string,
    subject: 'CUSTOMER' | 'SERVICE',
    tx: TransactionScope,
  ) {
    const tenantId = requireTenantId(scope);
    const column = subject === 'CUSTOMER' ? sql`m.customer_id` : sql`m.service_id`;
    const [row] = await this.rows<{ count: number; fingerprint: string }>(
      sql`SELECT count(*)::int AS count, ${fingerprintOf(column)} AS fingerprint
            FROM frozen_audience_members m
           WHERE m.tenant_id = ${tenantId}::uuid AND m.frozen_audience_id = ${id}::uuid`,
      tx,
    );
    const count = row?.count ?? 0;
    const fingerprint = row?.fingerprint ?? '';
    await this.exec(tx).execute(sql`
      UPDATE frozen_audiences SET member_count = ${count}, fingerprint = ${fingerprint}
       WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid`);
    return { count, fingerprint };
  }

  async find(scope: TenantContext, id: string, tx?: unknown): Promise<FrozenAudienceRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows<HeaderRow>(
      sql`SELECT id, kind, definition, definition_hash, as_of, member_count, fingerprint, created_at,
                 released_at
            FROM frozen_audiences WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid`,
      tx,
    );
    if (row === undefined) return null;
    return {
      id: row.id,
      kind: row.kind,
      definition: canonicalAudienceDefinition(row.definition),
      definitionHash: row.definition_hash,
      asOf: date(row.as_of),
      count: row.member_count,
      fingerprint: row.fingerprint,
      createdAt: date(row.created_at),
      releasedAt: row.released_at === null ? null : date(row.released_at),
    };
  }

  async releaseUnreferenced(
    scope: TenantContext,
    input: { readonly before: Date; readonly now: Date },
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    /*
     * "No live reference" is decided by the referencing records' OWN states, never by age
     * alone: a campaign confirmed fifty-nine days before its start keeps its members until
     * it has ended. A COMPLETED broadcast may still be re-opened to re-queue refusals, but
     * that re-uses its recipient rows and needs no member; a COMPLETED or CANCELLED mass
     * operation is terminal. The header row is kept whatever happens.
     */
    const released = await this.rows<{ id: string }>(
      sql`UPDATE frozen_audiences f
             SET released_at = ${input.now.toISOString()}::timestamptz
           WHERE f.tenant_id = ${tenantId}::uuid AND f.released_at IS NULL
             AND f.created_at < ${input.before.toISOString()}::timestamptz
             AND NOT EXISTS (
               SELECT 1 FROM campaign_actions a
                 JOIN campaigns c ON c.tenant_id = a.tenant_id AND c.id = a.campaign_id
                WHERE a.tenant_id = f.tenant_id AND a.frozen_audience_id = f.id
                  AND c.state NOT IN ('COMPLETED', 'CANCELLED'))
             AND NOT EXISTS (
               SELECT 1 FROM bulk_operations o
                WHERE o.tenant_id = f.tenant_id AND o.frozen_audience_id = f.id
                  AND o.state NOT IN ('COMPLETED', 'CANCELLED'))
             AND NOT EXISTS (
               SELECT 1 FROM broadcasts b
                WHERE b.tenant_id = f.tenant_id AND b.frozen_audience_id = f.id
                  AND b.state NOT IN ('COMPLETED', 'CANCELLED'))
       RETURNING f.id`,
      tx,
    );
    if (released.length === 0) return 0;
    await this.exec(tx).execute(sql`
      DELETE FROM frozen_audience_members
       WHERE tenant_id = ${tenantId}::uuid
         AND frozen_audience_id = ANY(${sql.param(released.map((row) => row.id))}::uuid[])`);
    return released.length;
  }
}
