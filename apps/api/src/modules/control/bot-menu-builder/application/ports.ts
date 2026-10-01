import type { ScopeContext } from '@nexa/contracts';

/**
 * Round T — what the button builder reads and writes (`docs/round-t-button-builder-audit.md`
 * §11). The stored layouts are RAW json: the application parses them, because a value a
 * later release wrote must be reported unreadable, not thrown at a repository boundary.
 */

/** A tenant's builder row: the draft and the published head. */
export interface StoredMainMenuLayout {
  readonly draft: unknown;
  readonly draftVersion: number;
  readonly draftUpdatedAt: Date;
  readonly draftUpdatedByAdminId: string | null;
  readonly draftRestoredFrom: { readonly id: string; readonly revision: number } | null;
  readonly published: unknown;
  readonly publishedRevision: number | null;
  readonly publishedAt: Date | null;
  readonly publishedByAdminId: string | null;
  readonly projectionSettingVersion: number | null;
}

export interface StoredMainMenuRevision {
  readonly id: string;
  readonly revision: number;
  readonly snapshot: unknown;
  readonly createdAt: Date;
  readonly createdByAdminId: string | null;
  readonly restoredFrom: { readonly id: string; readonly revision: number } | null;
}

/** What the runtime's source needs: the published head beside the setting's live version. */
export interface PublishedMainMenuHead {
  readonly published: unknown;
  readonly publishedRevision: number;
  readonly projectionSettingVersion: number;
  /** `setting_values.version` of `bot.main_menu` now; null when no row exists. */
  readonly settingVersion: number | null;
}

export interface MainMenuBuilderRepository {
  /** The tenant's row, `FOR UPDATE` when `forUpdate` (inside `tx`). */
  findLayout(
    scope: ScopeContext,
    tx?: unknown,
    forUpdate?: boolean,
  ): Promise<StoredMainMenuLayout | null>;
  /**
   * The first draft — and ONLY when no row exists: `ON CONFLICT DO NOTHING`. Null when a
   * row appeared first, which the caller reports as a version conflict.
   */
  insertDraft(
    scope: ScopeContext,
    input: {
      readonly draft: unknown;
      readonly now: Date;
      readonly adminId: string | null;
      readonly restoredFromRevisionId: string | null;
    },
    tx: unknown,
  ): Promise<StoredMainMenuLayout | null>;
  /** Replace the draft WHERE `draft_version` is still `expectedDraftVersion`, bumping it. */
  updateDraft(
    scope: ScopeContext,
    input: {
      readonly expectedDraftVersion: number;
      readonly draft: unknown;
      readonly now: Date;
      readonly adminId: string | null;
      readonly restoredFromRevisionId: string | null;
    },
    tx: unknown,
  ): Promise<StoredMainMenuLayout | null>;
  /**
   * Set the published head WHERE the draft and the published revision are still the ones
   * read (`IS NOT DISTINCT FROM` for a first publish). Clears the draft's restored-from:
   * that revision is now carried by the published revision.
   */
  publish(
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
  ): Promise<StoredMainMenuLayout | null>;
  insertRevision(
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
  ): Promise<void>;
  /** One revision of THIS tenant, or null — another tenant's id is not found. */
  findRevision(
    scope: ScopeContext,
    id: string,
    tx?: unknown,
  ): Promise<StoredMainMenuRevision | null>;
  /** Newest first, below `before` when given. */
  listRevisions(
    scope: ScopeContext,
    page: { readonly before: number | null; readonly limit: number },
  ): Promise<StoredMainMenuRevision[]>;
  /** The published head and the setting's live version, in one read; null when nothing is published. */
  publishedHead(scope: ScopeContext, tx?: unknown): Promise<PublishedMainMenuHead | null>;
}
