import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { CustomMenuBotScope, CustomMenuButtonKind, ScopeContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  botInstances,
  customMenuButtonBots,
  customMenuButtonMedia,
  customMenuButtons,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CustomMenuButtonRepository,
  CustomMenuMediaBytes,
  NewCustomMenuMedia,
  StoredCustomMenuButton,
  StoredCustomMenuMedia,
} from '../application/custom-menu-button.ports.js';

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

/** The advisory lock class of a tenant's custom main-menu buttons ('CM'). */
const CUSTOM_MENU_LOCK_CLASS = 0x434d;

const BUTTON_COLUMNS = {
  id: customMenuButtons.id,
  label: customMenuButtons.label,
  kind: customMenuButtons.kind,
  url: customMenuButtons.url,
  body: customMenuButtons.body,
  botScope: customMenuButtons.botScope,
  mediaId: customMenuButtons.mediaId,
  version: customMenuButtons.version,
  archivedAt: customMenuButtons.archivedAt,
  createdAt: customMenuButtons.createdAt,
  updatedAt: customMenuButtons.updatedAt,
  mediaKind: customMenuButtonMedia.kind,
  mediaMimeType: customMenuButtonMedia.mimeType,
  mediaFileName: customMenuButtonMedia.fileName,
  mediaByteLength: customMenuButtonMedia.byteLength,
  mediaSha256: customMenuButtonMedia.sha256,
} as const;

interface ButtonRow {
  id: string;
  label: string;
  kind: string;
  url: string | null;
  body: string | null;
  botScope: string;
  mediaId: string | null;
  version: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  mediaKind: string | null;
  mediaMimeType: string | null;
  mediaFileName: string | null;
  mediaByteLength: number | null;
  mediaSha256: string | null;
}

function toMedia(row: ButtonRow): StoredCustomMenuMedia | null {
  if (
    row.mediaId === null ||
    row.mediaKind === null ||
    row.mediaMimeType === null ||
    row.mediaFileName === null ||
    row.mediaByteLength === null ||
    row.mediaSha256 === null
  ) {
    return null;
  }
  return {
    id: row.mediaId,
    kind: row.mediaKind as 'PHOTO' | 'DOCUMENT',
    mimeType: row.mediaMimeType,
    fileName: row.mediaFileName,
    byteLength: row.mediaByteLength,
    sha256: row.mediaSha256,
  };
}

function toButton(row: ButtonRow, botInstanceIds: readonly string[]): StoredCustomMenuButton {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind as CustomMenuButtonKind,
    url: row.url,
    body: row.body,
    botScope: row.botScope as CustomMenuBotScope,
    botInstanceIds,
    media: toMedia(row),
    version: row.version,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * R10 D2 — the owner-defined main-menu buttons (`custom_menu_buttons`,
 * `custom_menu_button_bots`, `custom_menu_button_media`).
 *
 * Every row is tenant-scoped through `requireTenantId`. Every change is a conditional UPDATE
 * naming the version it read; a button is ARCHIVED (and its file deleted), never deleted.
 */
export class DrizzleCustomMenuButtonRepository implements CustomMenuButtonRepository {
  constructor(private readonly db: Database) {}

  async lockTenant(scope: ScopeContext, tx: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    await executorOf(this.db, tx).execute(
      sql`SELECT pg_advisory_xact_lock(${CUSTOM_MENU_LOCK_CLASS}, hashtext(${tenantId}))`,
    );
  }

  async list(scope: ScopeContext, tx?: unknown): Promise<StoredCustomMenuButton[]> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    const rows = await executor
      .select(BUTTON_COLUMNS)
      .from(customMenuButtons)
      .leftJoin(
        customMenuButtonMedia,
        and(
          eq(customMenuButtonMedia.tenantId, customMenuButtons.tenantId),
          eq(customMenuButtonMedia.id, customMenuButtons.mediaId),
        ),
      )
      .where(eq(customMenuButtons.tenantId, tenantId))
      .orderBy(
        // Active first, in creation order; archived after, newest first.
        sql`(${customMenuButtons.archivedAt} IS NOT NULL)`,
        asc(
          sql`CASE WHEN ${customMenuButtons.archivedAt} IS NULL THEN ${customMenuButtons.createdAt} END`,
        ),
        desc(customMenuButtons.archivedAt),
        asc(customMenuButtons.id),
      );
    return this.withBots(executor, tenantId, rows);
  }

  async find(
    scope: ScopeContext,
    id: string,
    tx?: unknown,
    forUpdate = false,
  ): Promise<StoredCustomMenuButton | null> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    if (forUpdate) {
      const locked = await executor
        .select({ id: customMenuButtons.id })
        .from(customMenuButtons)
        .where(and(eq(customMenuButtons.tenantId, tenantId), eq(customMenuButtons.id, id)))
        .for('update');
      if (locked.length === 0) return null;
    }
    const [found] = await this.findMany(scope, [id], tx);
    return found ?? null;
  }

  async findMany(
    scope: ScopeContext,
    ids: readonly string[],
    tx?: unknown,
  ): Promise<StoredCustomMenuButton[]> {
    if (ids.length === 0) return [];
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    const rows = await executor
      .select(BUTTON_COLUMNS)
      .from(customMenuButtons)
      .leftJoin(
        customMenuButtonMedia,
        and(
          eq(customMenuButtonMedia.tenantId, customMenuButtons.tenantId),
          eq(customMenuButtonMedia.id, customMenuButtons.mediaId),
        ),
      )
      .where(and(eq(customMenuButtons.tenantId, tenantId), inArray(customMenuButtons.id, [...ids])))
      .orderBy(asc(customMenuButtons.createdAt), asc(customMenuButtons.id));
    return this.withBots(executor, tenantId, rows);
  }

  private async withBots(
    executor: Executor,
    tenantId: string,
    rows: readonly ButtonRow[],
  ): Promise<StoredCustomMenuButton[]> {
    if (rows.length === 0) return [];
    const bots = await executor
      .select({
        buttonId: customMenuButtonBots.buttonId,
        botInstanceId: customMenuButtonBots.botInstanceId,
      })
      .from(customMenuButtonBots)
      .where(
        and(
          eq(customMenuButtonBots.tenantId, tenantId),
          inArray(
            customMenuButtonBots.buttonId,
            rows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(asc(customMenuButtonBots.botInstanceId));
    const byButton = new Map<string, string[]>();
    for (const bot of bots) {
      byButton.set(bot.buttonId, [...(byButton.get(bot.buttonId) ?? []), bot.botInstanceId]);
    }
    return rows.map((row) => toButton(row, byButton.get(row.id) ?? []));
  }

  async activeCount(scope: ScopeContext, tx: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select({ count: sql<string>`count(*)::text` })
      .from(customMenuButtons)
      .where(and(eq(customMenuButtons.tenantId, tenantId), isNull(customMenuButtons.archivedAt)));
    return Number(row?.count ?? '0');
  }

  async storageBytes(scope: ScopeContext, tx?: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select({ total: sql<string>`coalesce(sum(${customMenuButtonMedia.byteLength}), 0)::text` })
      .from(customMenuButtonMedia)
      .where(eq(customMenuButtonMedia.tenantId, tenantId));
    return Number(row?.total ?? '0');
  }

  async findActiveByLabel(scope: ScopeContext, label: string, tx: unknown): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select({ id: customMenuButtons.id })
      .from(customMenuButtons)
      .where(
        and(
          eq(customMenuButtons.tenantId, tenantId),
          eq(customMenuButtons.label, label),
          isNull(customMenuButtons.archivedAt),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  async existingBotIds(
    scope: ScopeContext,
    ids: readonly string[],
    tx: unknown,
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select({ id: botInstances.id })
      .from(botInstances)
      .where(and(eq(botInstances.tenantId, tenantId), inArray(botInstances.id, [...ids])));
    return rows.map((row) => row.id);
  }

  async readMedia(
    scope: ScopeContext,
    mediaId: string,
    tx?: unknown,
  ): Promise<CustomMenuMediaBytes | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select({
        kind: customMenuButtonMedia.kind,
        mimeType: customMenuButtonMedia.mimeType,
        fileName: customMenuButtonMedia.fileName,
        content: customMenuButtonMedia.content,
      })
      .from(customMenuButtonMedia)
      .where(
        and(eq(customMenuButtonMedia.tenantId, tenantId), eq(customMenuButtonMedia.id, mediaId)),
      )
      .limit(1);
    if (row === undefined) return null;
    return {
      kind: row.kind as 'PHOTO' | 'DOCUMENT',
      mimeType: row.mimeType,
      fileName: row.fileName,
      bytes: new Uint8Array(row.content),
    };
  }

  private async insertMedia(
    executor: Executor,
    tenantId: string,
    media: NewCustomMenuMedia,
    now: Date,
  ): Promise<void> {
    await executor.insert(customMenuButtonMedia).values({
      id: media.id,
      tenantId,
      kind: media.kind,
      mimeType: media.mimeType,
      fileName: media.fileName,
      byteLength: media.byteLength,
      sha256: media.sha256,
      content: Buffer.from(media.content),
      createdAt: now,
    });
  }

  private async replaceBots(
    executor: Executor,
    tenantId: string,
    buttonId: string,
    botInstanceIds: readonly string[],
  ): Promise<void> {
    await executor
      .delete(customMenuButtonBots)
      .where(
        and(
          eq(customMenuButtonBots.tenantId, tenantId),
          eq(customMenuButtonBots.buttonId, buttonId),
        ),
      );
    if (botInstanceIds.length === 0) return;
    await executor
      .insert(customMenuButtonBots)
      .values(botInstanceIds.map((botInstanceId) => ({ tenantId, buttonId, botInstanceId })));
  }

  async insert(
    scope: ScopeContext,
    input: Parameters<CustomMenuButtonRepository['insert']>[1],
    tx: unknown,
  ): Promise<StoredCustomMenuButton> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    if (input.media !== null) await this.insertMedia(executor, tenantId, input.media, input.now);
    await executor.insert(customMenuButtons).values({
      id: input.id,
      tenantId,
      label: input.label,
      kind: input.kind,
      url: input.url,
      body: input.body,
      mediaId: input.media?.id ?? null,
      botScope: input.botScope,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
      createdByAdminId: input.adminId,
      updatedByAdminId: input.adminId,
    });
    await this.replaceBots(executor, tenantId, input.id, input.botInstanceIds);
    const stored = await this.find(scope, input.id, tx);
    if (stored === null) throw new Error('custom_menu_buttons: the inserted row was not found.');
    return stored;
  }

  async update(
    scope: ScopeContext,
    input: Parameters<CustomMenuButtonRepository['update']>[1],
    tx: unknown,
  ): Promise<StoredCustomMenuButton | null> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    const [current] = await executor
      .select({ mediaId: customMenuButtons.mediaId })
      .from(customMenuButtons)
      .where(and(eq(customMenuButtons.tenantId, tenantId), eq(customMenuButtons.id, input.id)));
    if (input.media !== undefined)
      await this.insertMedia(executor, tenantId, input.media, input.now);
    const updated = await executor
      .update(customMenuButtons)
      .set({
        ...input.patch,
        ...(input.media === undefined ? {} : { mediaId: input.media.id }),
        version: sql`${customMenuButtons.version} + 1`,
        updatedAt: input.now,
        updatedByAdminId: input.adminId,
      })
      .where(
        and(
          eq(customMenuButtons.tenantId, tenantId),
          eq(customMenuButtons.id, input.id),
          eq(customMenuButtons.version, input.expectedVersion),
          isNull(customMenuButtons.archivedAt),
        ),
      )
      .returning({ id: customMenuButtons.id });
    if (updated.length === 0) return null;
    if (input.botInstanceIds !== undefined) {
      await this.replaceBots(executor, tenantId, input.id, input.botInstanceIds);
    }
    if (input.media !== undefined && current?.mediaId != null) {
      await executor
        .delete(customMenuButtonMedia)
        .where(
          and(
            eq(customMenuButtonMedia.tenantId, tenantId),
            eq(customMenuButtonMedia.id, current.mediaId),
          ),
        );
    }
    return this.find(scope, input.id, tx);
  }

  async archive(
    scope: ScopeContext,
    input: Parameters<CustomMenuButtonRepository['archive']>[1],
    tx: unknown,
  ): Promise<StoredCustomMenuButton | null> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);
    const [current] = await executor
      .select({ mediaId: customMenuButtons.mediaId })
      .from(customMenuButtons)
      .where(and(eq(customMenuButtons.tenantId, tenantId), eq(customMenuButtons.id, input.id)));
    const archived = await executor
      .update(customMenuButtons)
      .set({
        archivedAt: input.now,
        mediaId: null,
        version: sql`${customMenuButtons.version} + 1`,
        updatedAt: input.now,
        updatedByAdminId: input.adminId,
      })
      .where(
        and(
          eq(customMenuButtons.tenantId, tenantId),
          eq(customMenuButtons.id, input.id),
          eq(customMenuButtons.version, input.expectedVersion),
          isNull(customMenuButtons.archivedAt),
        ),
      )
      .returning({ id: customMenuButtons.id });
    if (archived.length === 0) return null;
    if (current?.mediaId != null) {
      // The file is dead weight once the button is archived: free the tenant's storage bound.
      await executor
        .delete(customMenuButtonMedia)
        .where(
          and(
            eq(customMenuButtonMedia.tenantId, tenantId),
            eq(customMenuButtonMedia.id, current.mediaId),
          ),
        );
    }
    return this.find(scope, input.id, tx);
  }
}
