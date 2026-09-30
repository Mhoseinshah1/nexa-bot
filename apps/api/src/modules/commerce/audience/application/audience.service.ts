import { createHash } from 'node:crypto';
import {
  AUDIENCE_ERROR_CODES,
  AUDIENCE_SAMPLE_SIZE,
  FROZEN_AUDIENCE_RELEASE_AFTER_DAYS,
  canonicalAudienceDefinition,
  errors,
  type ActorContext,
  type AudienceDefinition,
  type AudiencePreview,
  type AudienceSampleCustomer,
  type Clock,
  type CurrencyCode,
  type FrozenAudienceGrantKind,
  type IdGenerator,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { AudienceEvaluation } from '../infrastructure/audience-sql.js';
import type {
  AudienceEvaluationOptions,
  AudienceOptions,
  AudienceReader,
  AudienceSummary,
  FrozenAudienceRecord,
  FrozenAudienceRepository,
} from './ports.js';

/**
 * Reading an audience is reading customers: a count, and a sample that names ten of them.
 * The consumers' own actions — launching a broadcast, running a mass credit — charge their
 * own keys and call `evaluate`, which checks nothing because its caller already did.
 */
export const AUDIENCE_PREVIEW_PERMISSION: PermissionKey = 'users.view';

/**
 * The builder's options are the names a definition is written in — reseller tiers, products
 * and panels by id and name, and the selling currency — and nothing about a customer. Every
 * consumer's composer needs them, so they are readable on `users.view` OR on any of the
 * actions an audience is built for. Least privilege: a role that may run a mass credit is not
 * thereby given the customer list (`users.view`), only the vocabulary its own form needs.
 * Codex R1 on PR #117 (a broadcast-only role was refused the options its composer fetches).
 */
export const AUDIENCE_OPTIONS_PERMISSIONS: readonly PermissionKey[] = [
  AUDIENCE_PREVIEW_PERMISSION,
  'broadcasts.send',
  'users.wallet.mass',
  'services.mass.grant',
  // Round N, C1: the campaign form edits its audience with the same builder.
  'campaigns.manage',
];

/** A definition in its one canonical form, with the hash a confirmation binds to. */
export interface FrozenAudience {
  readonly definition: AudienceDefinition;
  /** The canonical JSON, exactly as stored in a snapshot column. */
  readonly json: string;
  /** sha256 of `json`. */
  readonly hash: string;
}

/** One evaluation: the frozen definition, the instant it was asked at, and what it found. */
export interface AudienceEvaluationResult extends AudienceSummary {
  readonly audience: FrozenAudience;
  readonly asOf: Date;
}

export interface AudienceServiceDeps {
  readonly reader: AudienceReader;
  /** Round N close (§A): durable member sets a confirmation freezes. */
  readonly frozen: FrozenAudienceRepository;
  readonly guard: PermissionGuard;
  readonly clock: Clock;
  /** The currency a balance range is written in: the tenant's `sales.currency`. */
  readonly sellingCurrency: (scope: TenantContext) => Promise<CurrencyCode>;
  readonly ids: IdGenerator;
}

/**
 * The canonical form and its hash, or the contract's validation error.
 *
 * Exported so every consumer freezes a definition the same way — a broadcast draft, a mass
 * operation and a campaign store `json` and compare `hash`, and none of them can spell a
 * definition differently from the preview that was confirmed.
 */
export function freezeAudience(input: unknown): FrozenAudience {
  let definition: AudienceDefinition;
  try {
    definition = canonicalAudienceDefinition(input);
  } catch (error) {
    const issues =
      error !== null && typeof error === 'object' && 'issues' in error
        ? (error as { issues: readonly { path: readonly PropertyKey[]; message: string }[] }).issues
            .slice(0, 10)
            .map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }))
        : [];
    throw errors.validation(
      AUDIENCE_ERROR_CODES.DEFINITION_INVALID,
      'That audience definition is not valid.',
      { issues },
    );
  }
  const json = JSON.stringify(definition);
  return { definition, json, hash: createHash('sha256').update(json).digest('hex') };
}

/**
 * The shared audience (round N): preview for an operator, and evaluation for every consumer.
 */
export class AudienceService {
  constructor(private readonly deps: AudienceServiceDeps) {}

  /**
   * ADR-0010's counted preview for a definition: how many, how many reachable, which set
   * (fingerprint) and a sample. Writes nothing.
   */
  async preview(
    scope: TenantContext,
    actor: ActorContext,
    input: unknown,
    options: AudienceEvaluationOptions = {},
  ): Promise<AudiencePreview> {
    await this.deps.guard.check(scope, actor, AUDIENCE_PREVIEW_PERMISSION);
    const result = await this.evaluate(scope, input, undefined, undefined, options);
    const sample = await this.deps.reader.sample(
      scope,
      result.audience.definition,
      result.asOf,
      AUDIENCE_SAMPLE_SIZE,
      undefined,
      options,
    );
    return toPreview(result, sample);
  }

  /**
   * Evaluates a definition at `asOf` (the clock's now by default), optionally inside the
   * caller's transaction. No permission: the caller charged its own. `options` narrows
   * beyond the definition (round N close: a MARKETING send leaves out opted-out customers)
   * and is applied by the consumer's materialisation with the same flag.
   */
  async evaluate(
    scope: TenantContext,
    input: unknown,
    asOf: Date = this.deps.clock.now(),
    tx?: unknown,
    options: AudienceEvaluationOptions = {},
  ): Promise<AudienceEvaluationResult> {
    const audience = freezeAudience(input);
    const summary = await this.deps.reader.summarise(scope, audience.definition, asOf, tx, options);
    return { ...summary, audience, asOf };
  }

  /** A sample of an already-frozen definition, for a consumer's own preview. */
  async sampleOf(
    scope: TenantContext,
    definition: AudienceDefinition,
    asOf: Date,
    options: AudienceEvaluationOptions = {},
  ): Promise<readonly AudienceSampleCustomer[]> {
    return this.deps.reader.sample(
      scope,
      definition,
      asOf,
      AUDIENCE_SAMPLE_SIZE,
      undefined,
      options,
    );
  }

  // --- Frozen audiences (round N close, §A) --------------------------------------------

  /**
   * Freezes the CUSTOMERS a definition selects at `asOf`, in the caller's transaction:
   * the exact member identities, durably, named by an id the confirming record stores.
   * No permission: the caller charged the action it is confirming. Returns the header,
   * whose count and fingerprint are computed from the rows written — so a caller that
   * compares them with a preview compares what is actually frozen.
   */
  async freeze(
    scope: TenantContext,
    input: unknown,
    asOf: Date,
    createdByAdminId: string | null,
    tx: TransactionScope,
  ): Promise<FrozenAudienceRecord> {
    const audience = freezeAudience(input);
    const id = this.deps.ids.uuid();
    const now = this.deps.clock.now();
    const frozen = await this.deps.frozen.freezeCustomers(
      scope,
      {
        id,
        evaluation: { tenantId: scope.tenantId as string, definition: audience.definition, asOf },
        definitionJson: audience.json,
        definitionHash: audience.hash,
        createdByAdminId,
        now,
      },
      tx,
    );
    return {
      id,
      kind: 'CUSTOMERS',
      grantKind: null,
      definition: audience.definition,
      definitionHash: audience.hash,
      asOf,
      count: frozen.count,
      reachable: frozen.reachable,
      fingerprint: frozen.fingerprint,
      createdAt: now,
      releasedAt: null,
    };
  }

  /**
   * Freezes a SERVICES audience: the header here, the member rows by `writeMembers` — the
   * engine that owns the eligibility rule (a traffic or time grant's) writes them from its
   * own query, in the same transaction — and the count and fingerprint from what it wrote.
   */
  async freezeServices(
    scope: TenantContext,
    input: {
      readonly definition: unknown;
      readonly asOf: Date;
      readonly createdByAdminId: string | null;
      /** The grant whose eligibility rule `writeMembers` selects by: the set is bound to it. */
      readonly grantKind: FrozenAudienceGrantKind;
    },
    tx: TransactionScope,
    writeMembers: (frozenAudienceId: string, evaluation: AudienceEvaluation) => Promise<void>,
  ): Promise<FrozenAudienceRecord> {
    const audience = freezeAudience(input.definition);
    const { asOf, createdByAdminId, grantKind } = input;
    const id = this.deps.ids.uuid();
    const now = this.deps.clock.now();
    await this.deps.frozen.insertServicesHeader(
      scope,
      {
        id,
        grantKind,
        definitionJson: audience.json,
        definitionHash: audience.hash,
        asOf,
        createdByAdminId,
        now,
      },
      tx,
    );
    await writeMembers(id, {
      tenantId: scope.tenantId as string,
      definition: audience.definition,
      asOf,
    });
    const frozen = await this.deps.frozen.stampMembers(scope, id, 'SERVICE', tx);
    return {
      id,
      kind: 'SERVICES',
      grantKind,
      definition: audience.definition,
      definitionHash: audience.hash,
      asOf,
      count: frozen.count,
      reachable: frozen.reachable,
      fingerprint: frozen.fingerprint,
      createdAt: now,
      releasedAt: null,
    };
  }

  /** A frozen audience's header, or null. No permission: the caller charged its own. */
  async frozen(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<FrozenAudienceRecord | null> {
    return this.deps.frozen.find(scope, id, tx);
  }

  /**
   * The release sweep: member rows of audiences nothing live names any more, frozen at
   * least `FROZEN_AUDIENCE_RELEASE_AFTER_DAYS` ago. The header stays for ever.
   */
  async releaseFrozen(scope: TenantContext, now: Date, tx: TransactionScope): Promise<number> {
    return this.deps.frozen.releaseUnreferenced(
      scope,
      { before: new Date(now.getTime() - FROZEN_AUDIENCE_RELEASE_AFTER_DAYS * 86_400_000), now },
      tx,
    );
  }

  /** The names a builder offers, and the currency a balance range is written in. */
  async options(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<AudienceOptions & { readonly currency: CurrencyCode }> {
    const held = await this.deps.guard.permissionsOf(scope, actor);
    if (!AUDIENCE_OPTIONS_PERMISSIONS.some((permission) => held.has(permission))) {
      // The guard's own denial: the same 403 and the same operational event as any refusal.
      await this.deps.guard.check(scope, actor, AUDIENCE_PREVIEW_PERMISSION);
    }
    const [options, currency] = await Promise.all([
      this.deps.reader.options(scope),
      this.deps.sellingCurrency(scope),
    ]);
    return { ...options, currency };
  }
}

/** The HTTP shape of an evaluation. */
export function toPreview(
  result: AudienceEvaluationResult,
  sample: readonly AudienceSampleCustomer[],
): AudiencePreview {
  return {
    asOf: result.asOf.toISOString(),
    definition: result.audience.definition,
    definitionHash: result.audience.hash,
    customers: result.customers,
    reachable: result.reachable,
    fingerprint: result.fingerprint,
    sample: [...sample],
  };
}
