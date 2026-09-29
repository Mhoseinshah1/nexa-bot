import type {
  ClientAppDeliveryKind,
  ClientAppImageMimeType,
  ClientAppInput,
  ClientAppPlatform,
  ClientAppProtocol,
  ClientAppStatus,
  ProviderType,
  ScopeContext,
  TenantContext,
  UserId,
} from '@nexa/contracts';

/** One client app entry as the operator maintains it. `version` is what an edit states it read. */
export interface ClientAppRecord {
  readonly id: string;
  readonly platform: ClientAppPlatform;
  readonly name: string;
  readonly icon: string | null;
  readonly description: string;
  readonly officialUrl: string;
  readonly alternativeUrl: string | null;
  readonly helpUrl: string | null;
  /** RAW, as the operator wrote it. Rendered by `renderClientAppGuide` where it is sent. */
  readonly guide: string;
  readonly deliveryKinds: readonly ClientAppDeliveryKind[];
  readonly protocols: readonly ClientAppProtocol[];
  readonly providerTypes: readonly ProviderType[];
  readonly status: ClientAppStatus;
  readonly sortOrder: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** HF-A10. The picture's metadata, never its bytes; null when there is none. */
  readonly image: ClientAppImageMeta | null;
}

/** What is known about a stored image without reading it. */
export interface ClientAppImageMeta {
  readonly mimeType: ClientAppImageMimeType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly updatedAt: Date;
}

/** The bytes, and the type they were verified to be when they were stored. */
export interface ClientAppImageContent {
  readonly bytes: Uint8Array;
  readonly mimeType: ClientAppImageMimeType;
}

/** An image as the service writes it: bytes already inspected. */
export interface ClientAppImageDraft {
  readonly content: Uint8Array;
  readonly mimeType: ClientAppImageMimeType;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

/**
 * The tenant's client app rows.
 *
 * Every method is tenant-scoped through `requireTenantId(scope)`, the id lookups included:
 * an id is a UUID and would find another tenant's row without the predicate. The three
 * conditional writes name the version (and a status change its `from` status) in their
 * WHERE and answer `null` when nothing matched, so a stale editor and a racing colleague
 * both meet a refusal rather than a silent overwrite.
 */
export interface ClientAppRepository {
  /** `(platform order, sort_order, created_at, id)` — the one ordering, matching the index. */
  list(
    scope: ScopeContext,
    options?: { readonly platform?: ClientAppPlatform; readonly status?: ClientAppStatus },
    tx?: unknown,
  ): Promise<readonly ClientAppRecord[]>;
  find(scope: ScopeContext, id: string, tx?: unknown): Promise<ClientAppRecord | null>;
  insert(
    scope: ScopeContext,
    input: ClientAppInput & {
      readonly id: string;
      readonly status: ClientAppStatus;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<ClientAppRecord>;
  /** Conditional on `expectedVersion`; bumps the version. Null when the row moved or is absent. */
  update(
    scope: ScopeContext,
    id: string,
    input: ClientAppInput & { readonly expectedVersion: number },
    now: Date,
    tx: unknown,
  ): Promise<ClientAppRecord | null>;
  /** Conditional on `from` AND `expectedVersion`; bumps the version. Null when either failed. */
  setStatus(
    scope: ScopeContext,
    id: string,
    input: {
      readonly from: ClientAppStatus;
      readonly to: ClientAppStatus;
      readonly expectedVersion: number;
    },
    now: Date,
    tx: unknown,
  ): Promise<ClientAppRecord | null>;
  /** Conditional on `expectedVersion`. False when the row moved or is absent. */
  remove(scope: ScopeContext, id: string, expectedVersion: number, tx: unknown): Promise<boolean>;
  /** Every row of the tenant, whatever its status: the bound `CLIENT_APP_MAX_ENTRIES` is on. */
  count(scope: ScopeContext, tx?: unknown): Promise<number>;
  /**
   * HF-A10. Sets (`image` non-null) or clears (`null`) the entry's picture. Conditional on
   * `expectedVersion`; bumps the version. Null when the row moved or is absent.
   */
  setImage(
    scope: ScopeContext,
    id: string,
    input: { readonly image: ClientAppImageDraft | null; readonly expectedVersion: number },
    now: Date,
    tx: unknown,
  ): Promise<ClientAppRecord | null>;
  /**
   * HF-A10. The ONE read of the bytes. Tenant-scoped like every other method, and with no
   * status filter: the caller decides whether a disabled entry's picture may be served.
   */
  imageContent(
    scope: ScopeContext,
    id: string,
    tx?: unknown,
  ): Promise<ClientAppImageContent | null>;
}

/**
 * What this installation can say about ONE of a customer's live services, for choosing
 * which apps to show. Every field is derived from state the installation already holds;
 * nothing is asked of a panel.
 *
 * `null` is "not known", which is not the same as "none": an unknown fact never hides an
 * app, while a known empty one does.
 */
export interface CustomerServiceFact {
  readonly serviceId: string;
  readonly providerType: ProviderType | null;
  readonly deliveryKinds: readonly ClientAppDeliveryKind[];
  readonly protocols: readonly ClientAppProtocol[] | null;
  /** The existing redelivery action («🔗 لینک اشتراک») may be offered for it. */
  readonly linkDeliverable: boolean;
  /** The existing connection-files action («📁 دریافت فایل‌های اتصال») may be offered for it. */
  readonly filesOffered: boolean;
}

export interface CustomerServiceFactsSource {
  /** The customer's own live services, newest first, bounded. Empty when there are none. */
  factsFor(scope: TenantContext, customerId: UserId): Promise<readonly CustomerServiceFact[]>;
}
