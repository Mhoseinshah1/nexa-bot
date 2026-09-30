import type {
  AudienceDefinition,
  AudienceSampleCustomer,
  FrozenAudienceGrantKind,
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
/** What the member rows written say: how many, how many with a bot to reach, and their fingerprint. */
export interface FrozenMembersSummary {
  readonly count: number;
  readonly reachable: number;
  readonly fingerprint: string;
}

export interface FrozenAudienceRecord {
  readonly id: string;
  readonly kind: FrozenAudienceKind;
  /** The grant a SERVICES set was selected for; null for CUSTOMERS. */
  readonly grantKind: FrozenAudienceGrantKind | null;
  readonly definition: AudienceDefinition;
  readonly definitionHash: string;
  readonly asOf: Date;
  readonly count: number;
  /** Members with a bot to reach them through (`bot_instance_id` set), from the rows held. */
  readonly reachable: number;
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
  ): Promise<FrozenMembersSummary>;
  /**
   * A SERVICES header with no members yet, naming the grant whose rule selects them. The
   * member rows are written by the engine that owns the eligibility rule (the mass-action
   * repository), and `stampMembers` then seals the header from what was written.
   */
  insertServicesHeader(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly grantKind: FrozenAudienceGrantKind;
      readonly definitionJson: string;
      readonly definitionHash: string;
      readonly asOf: Date;
      readonly createdByAdminId: string | null;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<void>;
  /** Count, reachable and fingerprint from the member rows; count and fingerprint written onto the header. */
  stampMembers(
    scope: TenantContext,
    id: string,
    subject: 'CUSTOMER' | 'SERVICE',
    tx: TransactionScope,
  ): Promise<FrozenMembersSummary>;
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
