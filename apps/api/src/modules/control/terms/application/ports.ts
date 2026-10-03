import type { ScopeContext, TermsAcceptanceSource, TermsVersionStatus } from '@nexa/contracts';

/** One version of a tenant's terms and rules, as stored. `title` and `body` are raw. */
export interface TermsVersionRecord {
  readonly id: string;
  readonly status: TermsVersionStatus;
  /** Null while a draft; given once, at publication. */
  readonly versionNumber: number | null;
  readonly title: string;
  readonly body: string;
  readonly revision: number;
  readonly createdAt: Date;
  readonly createdByAdminId: string | null;
  readonly createdByUsername: string | null;
  readonly updatedAt: Date;
  readonly publishedAt: Date | null;
  readonly publishedByAdminId: string | null;
  readonly publishedByUsername: string | null;
}

/** A published version: the three facts publication gave it, non-null. */
export type PublishedTermsVersion = TermsVersionRecord & {
  readonly status: 'PUBLISHED';
  readonly versionNumber: number;
  readonly publishedAt: Date;
};

export function isPublished(record: TermsVersionRecord): record is PublishedTermsVersion {
  return (
    record.status === 'PUBLISHED' && record.versionNumber !== null && record.publishedAt !== null
  );
}

export interface TermsAcceptanceRecord {
  readonly termsVersionId: string;
  readonly versionNumber: number;
  readonly acceptedAt: Date;
}

/**
 * The tenant's versions and acceptances.
 *
 * Every method is tenant-scoped through `requireTenantId(scope)`, the id lookups included,
 * so another tenant's id is simply not found. The two writes on a version are conditional
 * UPDATEs naming `status = 'DRAFT'` and the revision read, and answer `null` when nothing
 * matched — a stale editor and a racing publisher meet a refusal, never a silent overwrite.
 */
export interface TermsRepository {
  /** The draft (if any) first, then every published version, newest first. */
  list(scope: ScopeContext, tx?: unknown): Promise<readonly TermsVersionRecord[]>;
  find(scope: ScopeContext, id: string, tx?: unknown): Promise<TermsVersionRecord | null>;
  findDraft(scope: ScopeContext, tx?: unknown): Promise<TermsVersionRecord | null>;
  /** The published version with the greatest number, or null when none was ever published. */
  current(scope: ScopeContext, tx?: unknown): Promise<PublishedTermsVersion | null>;
  /**
   * Inserts the tenant's draft. Throws `TERMS_DRAFT_EXISTS` when the one-draft index refuses
   * it — the other half of a race the service's own check lost.
   */
  insertDraft(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly title: string;
      readonly body: string;
      readonly adminId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<TermsVersionRecord>;
  /** Conditional on DRAFT and `expectedRevision`; bumps the revision. */
  updateDraft(
    scope: ScopeContext,
    id: string,
    input: {
      readonly title: string;
      readonly body: string;
      readonly expectedRevision: number;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<TermsVersionRecord | null>;
  /**
   * Conditional on DRAFT and `expectedRevision`. Gives the row the tenant's next version
   * number, computed in the same statement; `terms_versions_tenant_number_key` is the
   * backstop for anything that would give two rows one number.
   */
  publish(
    scope: ScopeContext,
    id: string,
    input: {
      readonly expectedRevision: number;
      readonly adminId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<TermsVersionRecord | null>;
  /** Acceptances per version id. A version nobody accepted is absent. */
  acceptanceCounts(scope: ScopeContext, tx?: unknown): Promise<ReadonlyMap<string, number>>;
  customerCount(scope: ScopeContext, tx?: unknown): Promise<number>;
  hasAccepted(
    scope: ScopeContext,
    customerId: string,
    termsVersionId: string,
    tx?: unknown,
  ): Promise<boolean>;
  /** The customer's newest acceptance, by version number. */
  lastAcceptance(
    scope: ScopeContext,
    customerId: string,
    tx?: unknown,
  ): Promise<TermsAcceptanceRecord | null>;
  /**
   * Records an acceptance once. TRUE when this call wrote the row; FALSE when the customer
   * had already accepted that version (`ON CONFLICT DO NOTHING` on the once-key), which is
   * what makes a duplicate or concurrent tap write nothing the second time.
   */
  insertAcceptance(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly customerId: string;
      readonly termsVersionId: string;
      readonly acceptedAt: Date;
      readonly source: TermsAcceptanceSource;
      readonly botInstanceId: string | null;
      readonly correlationId: string;
    },
    tx: unknown,
  ): Promise<boolean>;
}
