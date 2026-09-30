import type {
  AudienceDefinition,
  AudienceSampleCustomer,
  FrozenAudienceKind,
  TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { AudienceEvaluation } from '../infrastructure/audience-sql.js';

/** What an evaluation may leave out beyond the definition itself (`AudienceEvaluation`). */
export interface AudienceEvaluationOptions {
  readonly excludeMarketingOptOuts?: boolean;
}

/** What one evaluation of a definition found. */
export interface AudienceSummary {
  /** Every selected customer. */
  readonly customers: number;
  /** Of those, the ones with a bot to be messaged through. */
  readonly reachable: number;
  /** md5 of the sorted customer ids — the set, not only its size. */
  readonly fingerprint: string;
}

/** The names an audience builder offers. */
export interface AudienceOptions {
  readonly resellerTiers: readonly { readonly id: string; readonly name: string }[];
  readonly products: readonly { readonly id: string; readonly title: string }[];
  readonly panels: readonly { readonly id: string; readonly name: string }[];
}

/**
 * Reads an audience. Tenant-scoped by the `scope` every method takes; the SQL is the one
 * builder in `audience-sql.ts`.
 */
export interface AudienceReader {
  summarise(
    scope: TenantContext,
    definition: AudienceDefinition,
    asOf: Date,
    tx?: unknown,
    options?: AudienceEvaluationOptions,
  ): Promise<AudienceSummary>;
  sample(
    scope: TenantContext,
    definition: AudienceDefinition,
    asOf: Date,
    limit: number,
    tx?: unknown,
    options?: AudienceEvaluationOptions,
  ): Promise<readonly AudienceSampleCustomer[]>;
  options(scope: TenantContext): Promise<AudienceOptions>;
}

// --- Frozen audiences (round N close, `docs/round-n-close-audit.md` §A) -----------------

/** A frozen audience's header, as the application reads it. Members are never loaded. */
export interface FrozenAudienceRecord {
  readonly id: string;
  readonly kind: FrozenAudienceKind;
  readonly definition: AudienceDefinition;
  readonly definitionHash: string;
  readonly asOf: Date;
  readonly count: number;
  readonly fingerprint: string;
  readonly createdAt: Date;
  readonly releasedAt: Date | null;
}

/**
 * Durable, immutable-after-commit member sets. Every write takes the caller's transaction:
 * a frozen audience is confirmed WITH the record that names it, or not at all.
 */
export interface FrozenAudienceRepository {
  /**
   * Freezes the CUSTOMERS `evaluation` selects, in the caller's transaction: the header and
   * one member row per customer (with the bot and chat a message would go through), then
   * the count and fingerprint computed from the ROWS WRITTEN, stamped on the header.
   */
  freezeCustomers(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly evaluation: AudienceEvaluation;
      readonly definitionJson: string;
      readonly definitionHash: string;
      readonly createdByAdminId: string | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<{ readonly count: number; readonly fingerprint: string }>;
  /**
   * A SERVICES header with no members yet. The member rows are written by the engine that
   * owns the eligibility rule (the mass-action repository), and `stampMembers` then seals
   * the header from what was written.
   */
  insertServicesHeader(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly definitionJson: string;
      readonly definitionHash: string;
      readonly asOf: Date;
      readonly createdByAdminId: string | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<void>;
  /** Count and fingerprint from the member rows, written onto the header. */
  stampMembers(
    scope: TenantContext,
    id: string,
    subject: 'CUSTOMER' | 'SERVICE',
    tx: TransactionScope,
  ): Promise<{ readonly count: number; readonly fingerprint: string }>;
  find(scope: TenantContext, id: string, tx?: unknown): Promise<FrozenAudienceRecord | null>;
  /**
   * Releases the member rows of audiences frozen before `before` that no live record needs
   * any more: every campaign action's campaign, every mass operation and every broadcast
   * naming the audience has ended. Stamps `released_at`. Returns how many were released.
   */
  releaseUnreferenced(
    scope: TenantContext,
    input: { readonly before: Date; readonly now: Date },
    tx: TransactionScope,
  ): Promise<number>;
}
