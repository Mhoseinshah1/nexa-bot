import type {
  QrTemplate,
  QrTemplateFallbackReason,
  TenantContext,
  TenantMediaMimeType,
  TenantMediaPurpose,
} from '@nexa/contracts';

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

/**
 * What a slot needs of its bytes beyond the type and the size every slot checks (Phase 2
 * item 4): the QR background must DECODE, within its dimension and decompression bounds,
 * because the server draws on it. Answers why the file is refused, or null to accept it.
 *
 * A port because the decoder is infrastructure; the service asks it before storing, so a
 * background that could never be used is refused at upload rather than discovered at the
 * first delivery.
 */
export interface TenantMediaContentCheck {
  refusal(
    purpose: TenantMediaPurpose,
    mimeType: TenantMediaMimeType,
    bytes: Uint8Array,
  ): { readonly reason: string; readonly message: string } | null;
}

/** The QR as the delivery lane would draw it, for a DRAFT template (Phase 2 item 4). */
export interface QrTemplatePreviewer {
  renderText(
    scope: TenantContext,
    text: string,
    draft: QrTemplate | null,
  ): Promise<{
    readonly bytes: Uint8Array;
    readonly templated: boolean;
    readonly fallback: QrTemplateFallbackReason | null;
    readonly scale: number;
    readonly width: number;
    readonly height: number;
  }>;
}
