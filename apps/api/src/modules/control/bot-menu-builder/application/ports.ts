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
  /** The `bot.main_menu` version the draft was derived from (null: the setting had no row). */
  readonly draftLegacySettingVersion: number | null;
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
  /** The publisher's display name now; null when no administrator published it or the row is gone. */
  readonly createdByAdminName: string | null;
  readonly restoredFrom: { readonly id: string; readonly revision: number } | null;
}

/**
 * The builder row AND the `bot.main_menu` row, read in ONE statement — so the two can never
 * straddle another transaction's commit. What the runtime's source and the builder's read
 * both decide from.
 */
export interface MainMenuStateRead {
  readonly layout: StoredMainMenuLayout | null;
  readonly setting: {
    readonly value: unknown;
    readonly version: number;
    readonly updatedAt: Date;
    readonly updatedByAdminId: string | null;
  } | null;
}

/** The published head beside the setting's version, as `sourceAnswerOf` judges it. */
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
      readonly legacySettingVersion: number | null;
    },
    tx: unknown,
  ): Promise<StoredMainMenuLayout | null>;
  /**
   * Replace the draft WHERE `draft_version` is still `expectedDraftVersion`, bumping it. The
   * legacy baseline is replaced only when `legacySettingVersion` is given (a reset); an
   * ordinary save keeps it.
   */
  updateDraft(
    scope: ScopeContext,
    input: {
      readonly expectedDraftVersion: number;
      readonly draft: unknown;
      readonly now: Date;
      readonly adminId: string | null;
      readonly restoredFromRevisionId: string | null;
      readonly legacySettingVersion?: number | null;
    },
    tx: unknown,
  ): Promise<StoredMainMenuLayout | null>;
  /**
   * Set the published head WHERE the draft and the published revision are still the ones
   * read (`IS NOT DISTINCT FROM` for a first publish). Clears the draft's restored-from:
   * that revision is now carried by the published revision. Moves the draft's legacy
   * baseline to the projection's version: the draft and the setting agree again.
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
  /** The builder row and the `bot.main_menu` row in ONE statement (`MainMenuStateRead`). */
  readMenuState(scope: ScopeContext, tx?: unknown): Promise<MainMenuStateRead>;
}
