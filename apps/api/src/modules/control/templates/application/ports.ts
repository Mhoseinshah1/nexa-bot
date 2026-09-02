import type { ScopeContext, TemplateKey } from '@nexa/contracts';

/** A tenant's current override of one key. Absent means "uses the default". */
export interface StoredTemplateOverride {
  readonly key: TemplateKey;
  readonly locale: string;
  /** RAW source. Never a rendered message. */
  readonly body: string;
  readonly version: number;
  readonly revision: number;
  readonly updatedAt: Date;
  readonly updatedByAdminId: string | null;
}

export const TEMPLATE_REVISION_ACTIONS = ['SET', 'REVERT'] as const;
export type TemplateRevisionAction = (typeof TEMPLATE_REVISION_ACTIONS)[number];

export interface TemplateRevision {
  readonly key: TemplateKey;
  readonly locale: string;
  readonly revision: number;
  readonly action: TemplateRevisionAction;
  /** The raw body a SET stored. Null for a REVERT, which stores no body. */
  readonly body: string | null;
  readonly createdAt: Date;
  readonly createdByAdminId: string | null;
}

export interface TemplateRepository {
  findOverrides(
    scope: ScopeContext,
    locale: string,
    tx?: unknown,
  ): Promise<StoredTemplateOverride[]>;
  findOverride(
    scope: ScopeContext,
    key: TemplateKey,
    locale: string,
    tx?: unknown,
  ): Promise<StoredTemplateOverride | null>;

  /** The highest revision ever recorded for this key, including reverts. */
  latestRevision(
    scope: ScopeContext,
    key: TemplateKey,
    locale: string,
    tx?: unknown,
  ): Promise<number>;

  listRevisions(
    scope: ScopeContext,
    key: TemplateKey,
    locale: string,
    limit: number,
    tx?: unknown,
  ): Promise<TemplateRevision[]>;

  /** Optimistic upsert. Null means the expectation did not hold. */
  upsertOverride(
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
  ): Promise<StoredTemplateOverride | null>;

  /**
   * Removes the override. Null means the expectation did not hold.
   *
   * A revert REMOVES; it never copies today's default into tenant storage. A
   * tenant that reverts and is later shipped a better default gets the better
   * default, which is the only reason to have one.
   */
  deleteOverride(
    scope: ScopeContext,
    input: {
      readonly key: TemplateKey;
      readonly locale: string;
      readonly expectedVersion: number;
    },
    tx?: unknown,
  ): Promise<StoredTemplateOverride | null>;

  appendRevision(
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
  ): Promise<void>;
}
