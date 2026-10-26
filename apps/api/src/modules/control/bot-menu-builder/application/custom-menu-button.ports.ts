import type { CustomMenuBotScope, CustomMenuButtonKind, ScopeContext } from '@nexa/contracts';

/**
 * R10 D2 — what the owner-defined main-menu buttons read and write
 * (`packages/contracts/src/custom-menu-buttons.ts`). Rows are ARCHIVED, never deleted.
 */

/** A file's metadata. The bytes are read separately, only by the one send that needs them. */
export interface StoredCustomMenuMedia {
  readonly id: string;
  readonly kind: 'PHOTO' | 'DOCUMENT';
  readonly mimeType: string;
  readonly fileName: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface StoredCustomMenuButton {
  readonly id: string;
  readonly label: string;
  readonly kind: CustomMenuButtonKind;
  readonly url: string | null;
  readonly body: string | null;
  readonly botScope: CustomMenuBotScope;
  /** The bots a `SELECTED` button is shown on; empty for `ALL`. */
  readonly botInstanceIds: readonly string[];
  readonly media: StoredCustomMenuMedia | null;
  readonly version: number;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A file ready to store: judged by the service, never trusted from the browser. */
export interface NewCustomMenuMedia {
  readonly id: string;
  readonly kind: 'PHOTO' | 'DOCUMENT';
  readonly mimeType: string;
  readonly fileName: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly content: Uint8Array;
}

export interface CustomMenuMediaBytes {
  readonly kind: 'PHOTO' | 'DOCUMENT';
  readonly mimeType: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export interface CustomMenuButtonRepository {
  /**
   * The tenant's custom-button lock, transaction-scoped: taken FIRST by every write, so the
   * button count, the storage sum and the label check are decided by one writer at a time.
   */
  lockTenant(scope: ScopeContext, tx: unknown): Promise<void>;
  /** Active buttons in creation order, then archived ones newest first. */
  list(scope: ScopeContext, tx?: unknown): Promise<StoredCustomMenuButton[]>;
  find(
    scope: ScopeContext,
    id: string,
    tx?: unknown,
    forUpdate?: boolean,
  ): Promise<StoredCustomMenuButton | null>;
  /** The buttons of THIS tenant among `ids` (a foreign or unknown id is simply absent). */
  findMany(
    scope: ScopeContext,
    ids: readonly string[],
    tx?: unknown,
  ): Promise<StoredCustomMenuButton[]>;
  activeCount(scope: ScopeContext, tx: unknown): Promise<number>;
  /** Bytes of live media the tenant holds (a replaced file is already gone). */
  storageBytes(scope: ScopeContext, tx?: unknown): Promise<number>;
  /** The id of the ACTIVE button with this label, if any. */
  findActiveByLabel(scope: ScopeContext, label: string, tx: unknown): Promise<string | null>;
  /** Which of `ids` are bot instances of THIS tenant. */
  existingBotIds(scope: ScopeContext, ids: readonly string[], tx: unknown): Promise<string[]>;
  /** The file's bytes, tenant-scoped. */
  readMedia(
    scope: ScopeContext,
    mediaId: string,
    tx?: unknown,
  ): Promise<CustomMenuMediaBytes | null>;
  /** The media (when any), the button at version 1 and its bot rows — one writer, in order. */
  insert(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly label: string;
      readonly kind: CustomMenuButtonKind;
      readonly url: string | null;
      readonly body: string | null;
      readonly botScope: CustomMenuBotScope;
      readonly botInstanceIds: readonly string[];
      readonly media: NewCustomMenuMedia | null;
      readonly now: Date;
      readonly adminId: string | null;
    },
    tx: unknown,
  ): Promise<StoredCustomMenuButton>;
  /**
   * UPDATE WHERE the version is still `expectedVersion` and the button is not archived,
   * bumping it. Null when that matched nothing — the caller reports a version conflict.
   * `media`, when given, is inserted first, the button repointed at it and the old file
   * deleted; `botInstanceIds`, when given, replaces the bot rows.
   */
  update(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly expectedVersion: number;
      readonly patch: {
        readonly label?: string;
        readonly url?: string | null;
        readonly body?: string | null;
        readonly botScope?: CustomMenuBotScope;
      };
      readonly botInstanceIds?: readonly string[];
      readonly media?: NewCustomMenuMedia;
      readonly now: Date;
      readonly adminId: string | null;
    },
    tx: unknown,
  ): Promise<StoredCustomMenuButton | null>;
  /** Stamp `archived_at` WHERE the version matches and the button is active; null otherwise. */
  archive(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly expectedVersion: number;
      readonly now: Date;
      readonly adminId: string | null;
    },
    tx: unknown,
  ): Promise<StoredCustomMenuButton | null>;
}
