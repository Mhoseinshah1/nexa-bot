import type { TenantContext, TenantMediaMimeType, TenantMediaPurpose } from '@nexa/contracts';

/**
 * A media slot as the Web Admin sees it: metadata and never the bytes. The bytes leave
 * the database only through `content`, for the Telegram composer that uploads them.
 */
export interface TenantMediaRecord {
  readonly purpose: TenantMediaPurpose;
  readonly mimeType: TenantMediaMimeType;
  readonly byteLength: number;
  readonly sha256: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TenantMediaContent {
  readonly bytes: Uint8Array;
  readonly mimeType: TenantMediaMimeType;
}

export interface TenantMediaRepository {
  find(
    scope: TenantContext,
    purpose: TenantMediaPurpose,
    tx?: unknown,
  ): Promise<TenantMediaRecord | null>;

  content(
    scope: TenantContext,
    purpose: TenantMediaPurpose,
    tx?: unknown,
  ): Promise<TenantMediaContent | null>;

  /** Inserts, or replaces the slot's bytes with `version + 1`. Returns the row as written. */
  upsert(
    scope: TenantContext,
    draft: {
      readonly purpose: TenantMediaPurpose;
      readonly mimeType: TenantMediaMimeType;
      readonly content: Uint8Array;
      readonly sha256: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<TenantMediaRecord>;

  /** True when a row was deleted. */
  remove(scope: TenantContext, purpose: TenantMediaPurpose, tx: unknown): Promise<boolean>;
}
