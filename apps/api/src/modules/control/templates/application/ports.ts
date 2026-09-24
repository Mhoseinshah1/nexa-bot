import type {
  Calendar,
  ScopeContext,
  TemplateDefinition,
  TemplateKey,
  TemplateRevisionAction,
  TemplateValues,
} from '@nexa/contracts';
import type { Locale } from './template-resolver.js';

/**
 * The built-in default bodies, and the renderer.
 *
 * A port rather than a direct import of `@nexa/i18n`, for the reason ADR-0002
 * gives: the application layer declares what it needs and infrastructure
 * supplies it. The concrete catalogue was reached for directly at first, and the
 * cost showed immediately — `defaultBody` read a module constant and threw for
 * any locale but `fa`, so the second-locale story ADR-0016 tells (overrides are
 * keyed by locale from the first migration) could not be exercised by a test.
 *
 * There is one implementation, and it is bound in `container.ts` like every
 * other adapter.
 */
export interface TemplateCatalogue {
  /** The built-in body for a key. Raw, with placeholders intact. */
  defaultBody(key: TemplateKey, locale: Locale): string;
  /**
   * Substitutes declared tokens. Escapes values for an HTML-format key, and shows a
   * `DATETIME` value in the tenant's zone and calendar.
   */
  render(
    definition: TemplateDefinition,
    body: string,
    values: TemplateValues,
    locale: Locale,
    presentation: TemplatePresentation,
  ): string;
}

/**
 * How a tenant wants an instant shown — the display timezone and calendar the Time
 * rule in `docs/conventions.md` puts on the tenant row.
 *
 * Declared here as well as in `@nexa/i18n`, structurally identical, because the
 * application layer names what it needs and may not import the renderer package.
 */
export interface TemplatePresentation {
  readonly timezone: string;
  readonly calendar: Calendar;
}

/**
 * Resolves the presentation a render in a scope should use.
 *
 * Read once per render, not once per value: the resolver asks, the catalogue is handed
 * the answer. A `SystemContext` has no tenant and receives the product default. The
 * implementation caches per tenant for a bounded time, so a tenant that changes its
 * calendar sees the change within that bound, and a message is never wrong for longer.
 */
export interface TenantPresentationReader {
  presentationFor(scope: ScopeContext, tx?: unknown): Promise<TemplatePresentation>;
}

/** A tenant's current override of one key. Absent means "uses the default". */
export interface StoredTemplateOverride {
  readonly key: TemplateKey;
  readonly locale: Locale;
  /** RAW source. Never a rendered message. */
  readonly body: string;
  readonly version: number;
  readonly revision: number;
  readonly updatedAt: Date;
  readonly updatedByAdminId: string | null;
}

export interface TemplateRevision {
  readonly key: TemplateKey;
  readonly locale: Locale;
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
    locale: Locale,
    tx?: unknown,
  ): Promise<StoredTemplateOverride[]>;
  findOverride(
    scope: ScopeContext,
    key: TemplateKey,
    locale: Locale,
    tx?: unknown,
  ): Promise<StoredTemplateOverride | null>;

  /** The highest revision ever recorded for this key, including reverts. */
  latestRevision(
    scope: ScopeContext,
    key: TemplateKey,
    locale: Locale,
    tx?: unknown,
  ): Promise<number>;

  listRevisions(
    scope: ScopeContext,
    key: TemplateKey,
    locale: Locale,
    limit: number,
    tx?: unknown,
  ): Promise<TemplateRevision[]>;

  /** Optimistic upsert. Null means the expectation did not hold. */
  upsertOverride(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly key: TemplateKey;
      readonly locale: Locale;
      readonly body: string;
      readonly revision: number;
      readonly expectedVersion: number | null;
      /**
       * The revision the caller read. Checked ALONGSIDE the version because a
       * revert deletes the row and the next save starts a new one at version 1,
       * so a version alone cannot tell a stale expectation from a current one.
       */
      readonly expectedRevision: number | null;
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
      readonly locale: Locale;
      readonly expectedVersion: number;
      /** See `upsertOverride`: a version alone cannot survive a revert. */
      readonly expectedRevision: number;
    },
    tx?: unknown,
  ): Promise<StoredTemplateOverride | null>;

  appendRevision(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly key: TemplateKey;
      readonly locale: Locale;
      readonly revision: number;
      readonly action: TemplateRevisionAction;
      readonly body: string | null;
      readonly now: Date;
      readonly adminId: string | null;
    },
    tx?: unknown,
  ): Promise<void>;
}
