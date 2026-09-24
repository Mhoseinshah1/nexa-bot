import { and, eq, sql } from 'drizzle-orm';
import type { TenantContext, TenantMediaMimeType, TenantMediaPurpose } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { tenantMediaAssets } from '../../../../infrastructure/persistence/schema.js';
import type {
  TenantMediaContent,
  TenantMediaRecord,
  TenantMediaRepository,
} from '../application/ports.js';

/** The columns every metadata read selects. `content` is deliberately absent. */
const METADATA = {
  purpose: tenantMediaAssets.purpose,
  mimeType: tenantMediaAssets.mimeType,
  byteLength: tenantMediaAssets.byteLength,
  sha256: tenantMediaAssets.sha256,
  version: tenantMediaAssets.version,
  createdAt: tenantMediaAssets.createdAt,
  updatedAt: tenantMediaAssets.updatedAt,
} as const;

type MetadataRow = {
  [K in keyof typeof METADATA]: (typeof METADATA)[K]['_']['data'];
};

function toRecord(row: MetadataRow): TenantMediaRecord {
  return {
    purpose: row.purpose as TenantMediaPurpose,
    mimeType: row.mimeType as TenantMediaMimeType,
    byteLength: row.byteLength,
    sha256: row.sha256,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * `tenant_media_assets` in PostgreSQL. The metadata projection never selects `content`,
 * so no response builder above it can acquire the bytes by accident — the same one-way
 * shape the panel credential projection has (ADR-0023), for a lesser secret.
 */
export class DrizzleTenantMediaRepository implements TenantMediaRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async find(
    scope: TenantContext,
    purpose: TenantMediaPurpose,
    tx?: unknown,
  ): Promise<TenantMediaRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select(METADATA)
      .from(tenantMediaAssets)
      .where(and(eq(tenantMediaAssets.tenantId, tenantId), eq(tenantMediaAssets.purpose, purpose)))
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async content(
    scope: TenantContext,
    purpose: TenantMediaPurpose,
    tx?: unknown,
  ): Promise<TenantMediaContent | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select({ content: tenantMediaAssets.content, mimeType: tenantMediaAssets.mimeType })
      .from(tenantMediaAssets)
      .where(and(eq(tenantMediaAssets.tenantId, tenantId), eq(tenantMediaAssets.purpose, purpose)))
      .limit(1);
    if (row === undefined) return null;
    const buffer = row.content;
    return {
      bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      mimeType: row.mimeType as TenantMediaMimeType,
    };
  }

  async upsert(
    scope: TenantContext,
    draft: {
      readonly purpose: TenantMediaPurpose;
      readonly mimeType: TenantMediaMimeType;
      readonly content: Uint8Array;
      readonly sha256: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<TenantMediaRecord> {
    const tenantId = requireTenantId(scope);
    const content = Buffer.from(
      draft.content.buffer,
      draft.content.byteOffset,
      draft.content.byteLength,
    );
    const [row] = await this.exec(tx)
      .insert(tenantMediaAssets)
      .values({
        tenantId,
        purpose: draft.purpose,
        mimeType: draft.mimeType,
        content,
        byteLength: content.byteLength,
        sha256: draft.sha256,
        version: 1,
        createdAt: draft.now,
        updatedAt: draft.now,
      })
      .onConflictDoUpdate({
        target: [tenantMediaAssets.tenantId, tenantMediaAssets.purpose],
        set: {
          mimeType: draft.mimeType,
          content,
          byteLength: content.byteLength,
          sha256: draft.sha256,
          // The version counts replacements, so a client that read version 3 can tell the
          // banner it sees is not the one it uploaded.
          version: sql`${tenantMediaAssets.version} + 1`,
          updatedAt: draft.now,
        },
      })
      .returning(METADATA);
    if (row === undefined) throw new Error(`tenant media ${draft.purpose} upsert returned no row`);
    return toRecord(row);
  }

  async remove(scope: TenantContext, purpose: TenantMediaPurpose, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .delete(tenantMediaAssets)
      .where(and(eq(tenantMediaAssets.tenantId, tenantId), eq(tenantMediaAssets.purpose, purpose)))
      .returning({ purpose: tenantMediaAssets.purpose });
    return rows.length === 1;
  }
}
