import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ScopeContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  mainMenuLayouts,
  mainMenuRevisions,
  settingValues,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  MainMenuBuilderRepository,
  PublishedMainMenuHead,
  StoredMainMenuLayout,
  StoredMainMenuRevision,
} from '../application/ports.js';

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

/** The restored-from revision of a draft, joined for its number. */
const draftOrigin = alias(mainMenuRevisions, 'draft_origin');
/** The restored-from revision of a revision. */
const revisionOrigin = alias(mainMenuRevisions, 'revision_origin');

const LAYOUT_SELECTION = {
  draft: mainMenuLayouts.draft,
  draftVersion: mainMenuLayouts.draftVersion,
  draftUpdatedAt: mainMenuLayouts.draftUpdatedAt,
  draftUpdatedByAdminId: mainMenuLayouts.draftUpdatedByAdminId,
  originId: draftOrigin.id,
  originRevision: draftOrigin.revision,
  published: mainMenuLayouts.published,
  publishedRevision: mainMenuLayouts.publishedRevision,
  publishedAt: mainMenuLayouts.publishedAt,
  publishedByAdminId: mainMenuLayouts.publishedByAdminId,
  projectionSettingVersion: mainMenuLayouts.projectionSettingVersion,
} as const;

interface LayoutRow {
  draft: unknown;
  draftVersion: number;
  draftUpdatedAt: Date;
  draftUpdatedByAdminId: string | null;
  originId: string | null;
  originRevision: number | null;
  published: unknown;
  publishedRevision: number | null;
  publishedAt: Date | null;
  publishedByAdminId: string | null;
  projectionSettingVersion: number | null;
}

function toLayout(row: LayoutRow): StoredMainMenuLayout {
  return {
    draft: row.draft,
    draftVersion: row.draftVersion,
    draftUpdatedAt: row.draftUpdatedAt,
    draftUpdatedByAdminId: row.draftUpdatedByAdminId,
    draftRestoredFrom:
      row.originId === null || row.originRevision === null
        ? null
        : { id: row.originId, revision: row.originRevision },
    published: row.published,
    publishedRevision: row.publishedRevision,
    publishedAt: row.publishedAt,
    publishedByAdminId: row.publishedByAdminId,
    projectionSettingVersion: row.projectionSettingVersion,
  };
}

/** A jsonb object, encoded once. Layouts are always objects (CHECKed). */
function encode(value: unknown): SQL {
  return sql`${JSON.stringify(value)}::jsonb`;
}

/**
 * Round T — the builder's rows (`main_menu_layouts`, `main_menu_revisions`).
 *
 * Every write carries its own predicate: the first draft is an insert that does nothing on
 * conflict, every later one an UPDATE naming the version read, a publish names the draft
 * version AND the published revision. Zero rows is a conflict the caller reports; a lock the
 * caller holds is a courtesy, the predicate is the rule.
 */
export class DrizzleMainMenuBuilderRepository implements MainMenuBuilderRepository {
  constructor(private readonly db: Database) {}

  async findLayout(
    scope: ScopeContext,
    tx?: unknown,
    forUpdate = false,
  ): Promise<StoredMainMenuLayout | null> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    if (forUpdate) {
      // Lock the row alone — `FOR UPDATE` over an outer join locks nothing on the null side
      // and is refused by PostgreSQL — then read it whole.
      const locked = await executor
        .select({ tenantId: mainMenuLayouts.tenantId })
        .from(mainMenuLayouts)
        .where(eq(mainMenuLayouts.tenantId, tenantId))
        .for('update');
      if (locked.length === 0) return null;
    }
    const [row] = await executor
      .select(LAYOUT_SELECTION)
      .from(mainMenuLayouts)
      .leftJoin(
        draftOrigin,
        and(
          eq(draftOrigin.tenantId, mainMenuLayouts.tenantId),
          eq(draftOrigin.id, mainMenuLayouts.draftRestoredFromRevisionId),
        ),
      )
      .where(eq(mainMenuLayouts.tenantId, tenantId))
      .limit(1);
    return row === undefined ? null : toLayout(row);
  }

  async insertDraft(
    scope: ScopeContext,
    input: {
      readonly draft: unknown;
      readonly now: Date;
      readonly adminId: string | null;
      readonly restoredFromRevisionId: string | null;
    },
    tx: unknown,
  ): Promise<StoredMainMenuLayout | null> {
    const tenantId = requireTenantId(scope);
    const inserted = await executorOf(this.db, tx)
      .insert(mainMenuLayouts)
      .values({
        tenantId,
        draft: encode(input.draft),
        draftVersion: 1,
        draftUpdatedAt: input.now,
        draftUpdatedByAdminId: input.adminId,
        draftRestoredFromRevisionId: input.restoredFromRevisionId,
      })
      .onConflictDoNothing()
      .returning({ tenantId: mainMenuLayouts.tenantId });
    if (inserted.length === 0) return null;
    return this.findLayout(scope, tx);
  }

  async updateDraft(
    scope: ScopeContext,
    input: {
      readonly expectedDraftVersion: number;
      readonly draft: unknown;
      readonly now: Date;
      readonly adminId: string | null;
      readonly restoredFromRevisionId: string | null;
    },
    tx: unknown,
  ): Promise<StoredMainMenuLayout | null> {
    const tenantId = requireTenantId(scope);
    const updated = await executorOf(this.db, tx)
      .update(mainMenuLayouts)
      .set({
        draft: encode(input.draft),
        draftVersion: sql`${mainMenuLayouts.draftVersion} + 1`,
        draftUpdatedAt: input.now,
        draftUpdatedByAdminId: input.adminId,
        draftRestoredFromRevisionId: input.restoredFromRevisionId,
      })
      .where(
        and(
          eq(mainMenuLayouts.tenantId, tenantId),
          eq(mainMenuLayouts.draftVersion, input.expectedDraftVersion),
        ),
      )
      .returning({ tenantId: mainMenuLayouts.tenantId });
    if (updated.length === 0) return null;
    return this.findLayout(scope, tx);
  }

  async publish(
    scope: ScopeContext,
    input: {
      readonly expectedDraftVersion: number;
      readonly expectedPublishedRevision: number | null;
      readonly published: unknown;
      readonly revision: number;
      readonly now: Date;
      readonly adminId: string | null;
      readonly projectionSettingVersion: number;
    },
    tx: unknown,
  ): Promise<StoredMainMenuLayout | null> {
    const tenantId = requireTenantId(scope);
    const updated = await executorOf(this.db, tx)
      .update(mainMenuLayouts)
      .set({
        published: encode(input.published),
        publishedRevision: input.revision,
        publishedAt: input.now,
        publishedByAdminId: input.adminId,
        projectionSettingVersion: input.projectionSettingVersion,
        draftRestoredFromRevisionId: null,
      })
      .where(
        and(
          eq(mainMenuLayouts.tenantId, tenantId),
          eq(mainMenuLayouts.draftVersion, input.expectedDraftVersion),
          sql`${mainMenuLayouts.publishedRevision} IS NOT DISTINCT FROM ${input.expectedPublishedRevision}::integer`,
        ),
      )
      .returning({ tenantId: mainMenuLayouts.tenantId });
    if (updated.length === 0) return null;
    return this.findLayout(scope, tx);
  }

  async insertRevision(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly revision: number;
      readonly snapshot: unknown;
      readonly restoredFromRevisionId: string | null;
      readonly now: Date;
      readonly adminId: string | null;
    },
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await executorOf(this.db, tx)
      .insert(mainMenuRevisions)
      .values({
        id: input.id,
        tenantId,
        revision: input.revision,
        snapshot: encode(input.snapshot),
        restoredFromRevisionId: input.restoredFromRevisionId,
        createdAt: input.now,
        createdByAdminId: input.adminId,
      });
  }

  async findRevision(
    scope: ScopeContext,
    id: string,
    tx?: unknown,
  ): Promise<StoredMainMenuRevision | null> {
    const tenantId = requireTenantId(scope);
    // Not a uuid is not a revision: answered as not found rather than as a cast error.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    const [row] = await this.revisionQuery(executorOf(this.db, tx))
      .where(and(eq(mainMenuRevisions.tenantId, tenantId), eq(mainMenuRevisions.id, id)))
      .limit(1);
    return row === undefined ? null : toRevision(row);
  }

  async listRevisions(
    scope: ScopeContext,
    page: { readonly before: number | null; readonly limit: number },
  ): Promise<StoredMainMenuRevision[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.revisionQuery(this.db)
      .where(
        and(
          eq(mainMenuRevisions.tenantId, tenantId),
          page.before === null ? undefined : lt(mainMenuRevisions.revision, page.before),
        ),
      )
      .orderBy(desc(mainMenuRevisions.revision))
      .limit(page.limit);
    return rows.map(toRevision);
  }

  async publishedHead(scope: ScopeContext, tx?: unknown): Promise<PublishedMainMenuHead | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select({
        published: mainMenuLayouts.published,
        publishedRevision: mainMenuLayouts.publishedRevision,
        projectionSettingVersion: mainMenuLayouts.projectionSettingVersion,
        settingVersion: settingValues.version,
      })
      .from(mainMenuLayouts)
      .leftJoin(
        settingValues,
        and(
          eq(settingValues.tenantId, mainMenuLayouts.tenantId),
          eq(settingValues.settingKey, 'bot.main_menu'),
        ),
      )
      .where(eq(mainMenuLayouts.tenantId, tenantId))
      .limit(1);
    if (
      row === undefined ||
      row.published === null ||
      row.publishedRevision === null ||
      row.projectionSettingVersion === null
    ) {
      return null;
    }
    return {
      published: row.published,
      publishedRevision: row.publishedRevision,
      projectionSettingVersion: row.projectionSettingVersion,
      settingVersion: row.settingVersion,
    };
  }

  private revisionQuery(executor: Executor) {
    return executor
      .select({
        id: mainMenuRevisions.id,
        revision: mainMenuRevisions.revision,
        snapshot: mainMenuRevisions.snapshot,
        createdAt: mainMenuRevisions.createdAt,
        createdByAdminId: mainMenuRevisions.createdByAdminId,
        originId: revisionOrigin.id,
        originRevision: revisionOrigin.revision,
      })
      .from(mainMenuRevisions)
      .leftJoin(
        revisionOrigin,
        and(
          eq(revisionOrigin.tenantId, mainMenuRevisions.tenantId),
          eq(revisionOrigin.id, mainMenuRevisions.restoredFromRevisionId),
        ),
      )
      .$dynamic();
  }
}

function toRevision(row: {
  id: string;
  revision: number;
  snapshot: unknown;
  createdAt: Date;
  createdByAdminId: string | null;
  originId: string | null;
  originRevision: number | null;
}): StoredMainMenuRevision {
  return {
    id: row.id,
    revision: row.revision,
    snapshot: row.snapshot,
    createdAt: row.createdAt,
    createdByAdminId: row.createdByAdminId,
    restoredFrom:
      row.originId === null || row.originRevision === null
        ? null
        : { id: row.originId, revision: row.originRevision },
  };
}
