import { and, desc, eq, sql } from 'drizzle-orm';
import { CONTROL_ERROR_CODES, errors } from '@nexa/contracts';
import type { ScopeContext, TemplateKey, TemplateRevisionAction } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  templateOverrides,
  templateRevisions,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  StoredTemplateOverride,
  TemplateRepository,
  TemplateRevision,
} from '../application/ports.js';

type OverrideRow = typeof templateOverrides.$inferSelect;
type RevisionRow = typeof templateRevisions.$inferSelect;

function toOverride(row: OverrideRow): StoredTemplateOverride {
  return {
    key: row.templateKey as TemplateKey,
    locale: row.locale,
    body: row.body,
    version: row.version,
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedByAdminId: row.updatedByAdminId,
  };
}

function toRevision(row: RevisionRow): TemplateRevision {
  return {
    key: row.templateKey as TemplateKey,
    locale: row.locale,
    revision: row.revision,
    action: row.action as TemplateRevisionAction,
    body: row.body,
    createdAt: row.createdAt,
    createdByAdminId: row.createdByAdminId,
  };
}

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

export class DrizzleTemplateRepository implements TemplateRepository {
  constructor(private readonly db: Database) {}

  async findOverrides(
    scope: ScopeContext,
    locale: string,
    tx?: unknown,
  ): Promise<StoredTemplateOverride[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select()
      .from(templateOverrides)
      .where(and(eq(templateOverrides.tenantId, tenantId), eq(templateOverrides.locale, locale)));
    return rows.map(toOverride);
  }

  async findOverride(
    scope: ScopeContext,
    key: TemplateKey,
    locale: string,
    tx?: unknown,
  ): Promise<StoredTemplateOverride | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(templateOverrides)
      .where(
        and(
          eq(templateOverrides.tenantId, tenantId),
          eq(templateOverrides.templateKey, key),
          eq(templateOverrides.locale, locale),
        ),
      )
      .limit(1);
    return row ? toOverride(row) : null;
  }

  async latestRevision(
    scope: ScopeContext,
    key: TemplateKey,
    locale: string,
    tx?: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    // Read from the REVISIONS table, not from the override row: a revert deletes
    // the override, and numbering must not restart afterwards or two different
    // bodies would share a revision number in one key's history.
    const [row] = await executorOf(this.db, tx)
      .select({ latest: sql<number>`coalesce(max(${templateRevisions.revision}), 0)` })
      .from(templateRevisions)
      .where(
        and(
          eq(templateRevisions.tenantId, tenantId),
          eq(templateRevisions.templateKey, key),
          eq(templateRevisions.locale, locale),
        ),
      );
    return Number(row?.latest ?? 0);
  }

  async listRevisions(
    scope: ScopeContext,
    key: TemplateKey,
    locale: string,
    limit: number,
    tx?: unknown,
  ): Promise<TemplateRevision[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select()
      .from(templateRevisions)
      .where(
        and(
          eq(templateRevisions.tenantId, tenantId),
          eq(templateRevisions.templateKey, key),
          eq(templateRevisions.locale, locale),
        ),
      )
      .orderBy(desc(templateRevisions.revision))
      .limit(limit);
    return rows.map(toRevision);
  }

  async upsertOverride(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly key: TemplateKey;
      readonly locale: string;
      readonly body: string;
      readonly revision: number;
      readonly expectedVersion: number | null;
      readonly now: Date;
      readonly adminId: string | null;
    },
    tx?: unknown,
  ): Promise<StoredTemplateOverride | null> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);

    if (input.expectedVersion === null) {
      const inserted = await executor
        .insert(templateOverrides)
        .values({
          id: input.id,
          tenantId,
          templateKey: input.key,
          locale: input.locale,
          body: input.body,
          version: 1,
          revision: input.revision,
          updatedAt: input.now,
          updatedByAdminId: input.adminId,
        })
        .onConflictDoNothing()
        .returning();
      return inserted[0] ? toOverride(inserted[0]) : null;
    }

    const updated = await executor
      .update(templateOverrides)
      .set({
        body: input.body,
        revision: input.revision,
        version: sql`${templateOverrides.version} + 1`,
        updatedAt: input.now,
        updatedByAdminId: input.adminId,
      })
      .where(
        and(
          eq(templateOverrides.tenantId, tenantId),
          eq(templateOverrides.templateKey, input.key),
          eq(templateOverrides.locale, input.locale),
          eq(templateOverrides.version, input.expectedVersion),
        ),
      )
      .returning();
    return updated[0] ? toOverride(updated[0]) : null;
  }

  async deleteOverride(
    scope: ScopeContext,
    input: { readonly key: TemplateKey; readonly locale: string; readonly expectedVersion: number },
    tx?: unknown,
  ): Promise<StoredTemplateOverride | null> {
    const tenantId = requireTenantId(scope);
    const deleted = await executorOf(this.db, tx)
      .delete(templateOverrides)
      .where(
        and(
          eq(templateOverrides.tenantId, tenantId),
          eq(templateOverrides.templateKey, input.key),
          eq(templateOverrides.locale, input.locale),
          eq(templateOverrides.version, input.expectedVersion),
        ),
      )
      .returning();
    return deleted[0] ? toOverride(deleted[0]) : null;
  }

  /**
   * Appends a revision, turning a collision into a conflict.
   *
   * The override row is normally the serialisation point: its version predicate
   * refuses a concurrent edit before a revision number is claimed. A REVERT
   * DELETES that row, so between the delete and the commit there is no row to
   * predicate on — a concurrent `set` claiming `expectedVersion: null` can then
   * insert successfully and reach for the same revision number.
   *
   * Postgres refuses the second one on the unique index, which is correct and
   * unhelpful: the caller gets a driver error where the rest of this module
   * answers `control.version_conflict`. Translating it here means one answer for
   * one situation, whichever statement happens to detect it.
   */
  async appendRevision(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly key: TemplateKey;
      readonly locale: string;
      readonly revision: number;
      readonly action: TemplateRevisionAction;
      readonly body: string | null;
      readonly now: Date;
      readonly adminId: string | null;
    },
    tx?: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    try {
      await executorOf(this.db, tx).insert(templateRevisions).values({
        id: input.id,
        tenantId,
        templateKey: input.key,
        locale: input.locale,
        revision: input.revision,
        action: input.action,
        body: input.body,
        createdAt: input.now,
        createdByAdminId: input.adminId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw errors.conflict(
          CONTROL_ERROR_CODES.VERSION_CONFLICT,
          `${input.key} changed while you were editing it. Reload and reapply your change.`,
          { key: input.key, revision: input.revision },
        );
      }
      throw error;
    }
  }
}

/** Postgres `unique_violation`. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && findCode(error) === '23505';
}

/**
 * The SQLSTATE, wherever the driver put it.
 *
 * `node-postgres` sets `code` on its own error; Drizzle wraps that in a
 * `DrizzleQueryError` and puts the original on `cause`. Reading only the outer
 * object would make this check quietly never match.
 */
function findCode(error: object, depth = 0): string | undefined {
  // Bounded. An error whose `cause` chain loops back on itself would otherwise
  // hang the request rather than report a conflict, and a driver is not
  // obliged to keep that chain acyclic.
  if (depth > 5) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: unknown }).cause;
  return typeof cause === 'object' && cause !== null ? findCode(cause, depth + 1) : undefined;
}
