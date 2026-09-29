import {
  AUDIENCE_ERROR_CODES,
  AUDIENCE_SAMPLE_SIZE,
  BULK_DURATION_MAX_DAYS,
  BULK_ERROR_CODES,
  BULK_LARGE_OPERATION,
  BULK_TRAFFIC_MAX_BYTES,
  COMMERCE_ERROR_CODES,
  errors,
  isValidLedgerAmount,
  parseTrafficGb,
  type ActorContext,
  type AuditWriter,
  type BulkCounts,
  type BulkGrant,
  type BulkItemState,
  type BulkOperationKind,
  type BulkPreview,
  type Clock,
  type CurrencyCode,
  type IdGenerator,
  type IdempotencyStore,
  type OperationType,
  type OperationalEventRecorder,
  type PanelId,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  freezeAudience,
  type AudienceService,
  type FrozenAudience,
} from '../../audience/application/audience.service.js';
import type { PanelOperabilityReader } from '../../provisioning/application/ports.js';
import type {
  BulkItemPageRow,
  BulkOperationRecord,
  BulkOperationRepository,
  GrantEligibility,
} from './ports.js';

export const BULK_VIEW: PermissionKey = 'bulk_operations.view';
/** The wallet half: declared since Phase 0, charged at last (`permissions.ts`). */
export const BULK_WALLET: PermissionKey = 'users.wallet.mass';
export const BULK_SERVICE: PermissionKey = 'services.mass.grant';

const NAMESPACE = 'WEB' as const;
const NOT_BEFORE_MAX_LEAD_MS = 60 * 86_400_000;

export function permissionFor(kind: BulkOperationKind): PermissionKey {
  return kind === 'WALLET_CREDIT' ? BULK_WALLET : BULK_SERVICE;
}

/** A grant, validated and in the units it is stored in. */
interface CheckedGrant {
  readonly kind: BulkOperationKind;
  readonly amountMinor: bigint | null;
  readonly currency: CurrencyCode | null;
  readonly trafficBytes: bigint | null;
  readonly durationDays: number | null;
}

export interface CreateBulkOperationInput {
  readonly idempotencyKey: string;
  readonly grant: BulkGrant;
  readonly definition: unknown;
  readonly notify: boolean;
  /** The reason ADR-0010 asks a destructive action for. */
  readonly note: string;
  readonly expectedDefinitionHash: string;
  readonly expectedCount: number;
  readonly expectedFingerprint: string;
  /** Wallet credit: amount × count as the operator saw it. */
  readonly expectedTotalMinor: string | null;
  readonly typedCount: number | null;
  /** The earliest an item may be processed; null means at once. */
  readonly notBefore: Date | null;
}

export interface BulkOperationServiceDeps {
  readonly repository: BulkOperationRepository;
  /** The shared audience's evaluator: a wallet credit's preview is its summary. */
  readonly audience: Pick<AudienceService, 'evaluate'>;
  readonly panels: PanelOperabilityReader;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly sellingCurrency: (scope: TenantContext, tx?: TransactionScope) => Promise<CurrencyCode>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

function adminIdOf(actor: ActorContext): string | null {
  return actor.type === 'WEB_ADMIN' || actor.type === 'TELEGRAM_ADMIN' ? actor.id : null;
}

/**
 * Safe mass actions — «عملیات گروهی» (round N, B2) — as an operator runs them: preview
 * (exact count, the set's fingerprint, the total liability for money, a sample), a
 * destructive confirmation bound to that preview, and cancel. The processor does the work.
 *
 * Mirza's `👥 شارژ همگانی` credits in one step with no count, no total and no confirmation
 * (UBR-020..023); this keeps its amount → tier → purchase history → notify dimensions and
 * adds every step ADR-0010 asks for.
 */
export class BulkOperationService {
  constructor(private readonly deps: BulkOperationServiceDeps) {}

  // --- reads ---------------------------------------------------------------------------

  async get(scope: TenantContext, actor: ActorContext, id: string): Promise<BulkOperationRecord> {
    await this.deps.guard.check(scope, actor, BULK_VIEW);
    return this.require(scope, id);
  }

  async list(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly limit: number;
      readonly cursor: { readonly createdAt: Date; readonly id: string } | null;
    },
  ): Promise<readonly BulkOperationRecord[]> {
    await this.deps.guard.check(scope, actor, BULK_VIEW);
    return this.deps.repository.list(scope, input.limit, input.cursor);
  }

  /** Per-state item counts and, for a wallet credit, what the ledger actually holds. */
  async progress(
    scope: TenantContext,
    actor: ActorContext,
    ids: readonly string[],
  ): Promise<{
    readonly counts: ReadonlyMap<string, BulkCounts>;
    readonly credited: ReadonlyMap<string, bigint>;
  }> {
    await this.deps.guard.check(scope, actor, BULK_VIEW);
    const [counts, credited] = await Promise.all([
      this.deps.repository.counts(scope, ids),
      this.deps.repository.creditedTotals(scope, ids),
    ]);
    return { counts, credited };
  }

  async items(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: {
      readonly state: BulkItemState | null;
      readonly limit: number;
      readonly after: string | null;
    },
  ): Promise<readonly BulkItemPageRow[]> {
    await this.deps.guard.check(scope, actor, BULK_VIEW);
    await this.require(scope, id);
    return this.deps.repository.items(scope, id, input);
  }

  // --- preview -------------------------------------------------------------------------

  /** ADR-0010 steps 1 and 2: the dry run and the counted preview. Writes nothing. */
  async preview(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly grant: BulkGrant; readonly definition: unknown },
  ): Promise<BulkPreview> {
    await this.deps.guard.check(scope, actor, permissionFor(input.grant.kind));
    const grant = await this.checkedGrant(scope, input.grant);
    const audience = freezeAudience(input.definition);
    const asOf = this.deps.clock.now();
    const evaluation = {
      tenantId: scope.tenantId as string,
      definition: audience.definition,
      asOf,
    };
    if (grant.kind === 'WALLET_CREDIT') {
      // A wallet credit's items ARE the audience's customers: the audience's own summary.
      const result = await this.deps.audience.evaluate(scope, audience.definition, asOf);
      const sample = await this.deps.repository.sampleCustomers(
        scope,
        evaluation,
        AUDIENCE_SAMPLE_SIZE,
      );
      return this.toPreview(
        grant,
        audience,
        asOf,
        { count: result.customers, customers: result.customers, fingerprint: result.fingerprint },
        sample,
      );
    }
    const eligibility = await this.eligibility(scope, evaluation, grant.kind);
    const preview = await this.deps.repository.previewServices(
      scope,
      evaluation,
      eligibility,
      AUDIENCE_SAMPLE_SIZE,
    );
    return this.toPreview(grant, audience, asOf, preview, preview.sample);
  }

  // --- the confirmation ----------------------------------------------------------------

  /**
   * ADR-0010 steps 3 to 5. In ONE transaction: the operation row, the items materialised
   * from the frozen definition, and the comparison with what the operator confirmed — the
   * definition's hash, the count, the set's fingerprint and, for money, the total liability.
   * Any difference rolls everything back as `audience.changed`. The count must be typed back
   * for every wallet credit and for any grant from `BULK_LARGE_OPERATION` items, and a reason
   * is mandatory. Nothing is credited or granted here: the processor does that, item by item,
   * from `notBefore` on.
   */
  async create(
    scope: TenantContext,
    actor: ActorContext,
    input: CreateBulkOperationInput,
  ): Promise<BulkOperationRecord> {
    const permission = permissionFor(input.grant.kind);
    const denial = { action: 'bulk.create', entityType: 'BulkOperation', entityId: null };
    await this.authorize(scope, actor, permission, denial);
    const createdBy = adminIdOf(actor);
    if (createdBy === null) {
      throw errors.permissionDenied(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'A mass operation is a person’s decision.',
      );
    }
    const grant = await this.checkedGrant(scope, input.grant);
    const audience = freezeAudience(input.definition);
    const note = input.note.trim();
    if (note.length === 0) {
      throw errors.validation(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID, 'Give a reason.');
    }
    const typedRequired =
      grant.kind === 'WALLET_CREDIT' || input.expectedCount >= BULK_LARGE_OPERATION;
    if (typedRequired && input.typedCount !== input.expectedCount) {
      throw errors.validation(
        BULK_ERROR_CODES.CONFIRMATION_REQUIRED,
        `Type the number of items (${String(input.expectedCount)}) to confirm.`,
        { count: input.expectedCount },
      );
    }
    if (grant.kind === 'WALLET_CREDIT') {
      const total = (grant.amountMinor ?? 0n) * BigInt(input.expectedCount);
      if (input.expectedTotalMinor === null || BigInt(input.expectedTotalMinor) !== total) {
        throw errors.validation(
          BULK_ERROR_CODES.LIABILITY_MISMATCH,
          'The total confirmed is not the amount times the number of customers.',
          { total: total.toString() },
        );
      }
    }
    const now = this.deps.clock.now();
    if (
      input.notBefore !== null &&
      input.notBefore.getTime() > now.getTime() + NOT_BEFORE_MAX_LEAD_MS
    ) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'A mass operation is scheduled at most sixty days ahead.',
      );
    }
    const requestHash = hashRequest({
      grant: {
        kind: grant.kind,
        amountMinor: grant.amountMinor?.toString() ?? null,
        currency: grant.currency,
        trafficBytes: grant.trafficBytes?.toString() ?? null,
        durationDays: grant.durationDays,
      },
      audienceHash: audience.hash,
      notify: input.notify,
      note,
      expectedDefinitionHash: input.expectedDefinitionHash,
      expectedCount: input.expectedCount,
      expectedFingerprint: input.expectedFingerprint,
      expectedTotalMinor: input.expectedTotalMinor,
      notBefore: input.notBefore?.toISOString() ?? null,
    });
    const replay = await this.deps.idempotency.find<{ operationId: string }>(
      scope,
      NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return this.require(scope, replay.result.operationId);

    if (audience.hash !== input.expectedDefinitionHash) {
      throw errors.conflict(AUDIENCE_ERROR_CODES.CHANGED, 'The audience is not the one previewed.');
    }
    const id = this.deps.ids.uuid();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      permission,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        if (
          grant.kind === 'WALLET_CREDIT' &&
          (await this.deps.sellingCurrency(scope, tx)) !== grant.currency
        ) {
          throw errors.validation(
            BULK_ERROR_CODES.CURRENCY_UNSUPPORTED,
            'This installation does not sell in that currency.',
          );
        }
        const evaluation = {
          tenantId: scope.tenantId as string,
          definition: audience.definition,
          asOf: now,
        };
        await this.deps.repository.create(
          scope,
          {
            id,
            kind: grant.kind,
            amountMinor: grant.amountMinor,
            currency: grant.currency,
            trafficBytes: grant.trafficBytes,
            durationDays: grant.durationDays,
            notify: input.notify,
            note,
            audienceJson: audience.json,
            audienceHash: audience.hash,
            audienceAsOf: now,
            itemCount: input.expectedCount,
            fingerprint: input.expectedFingerprint,
            notBefore: input.notBefore,
            createdByAdminId: createdBy,
            now,
          },
          tx,
        );
        const frozen =
          grant.kind === 'WALLET_CREDIT'
            ? await this.deps.repository.materialiseCustomers(scope, id, evaluation, now, tx)
            : await this.deps.repository.materialiseServices(
                scope,
                id,
                evaluation,
                await this.eligibility(scope, evaluation, grant.kind, tx),
                now,
                tx,
              );
        if (frozen.count === 0) {
          throw errors.preconditionFailed(
            AUDIENCE_ERROR_CODES.EMPTY,
            'This audience selects nothing.',
          );
        }
        if (
          frozen.count !== input.expectedCount ||
          frozen.fingerprint !== input.expectedFingerprint
        ) {
          // Inside the transaction: the operation and its items roll back with it.
          throw errors.conflict(
            AUDIENCE_ERROR_CODES.CHANGED,
            `The preview showed ${String(input.expectedCount)} and there are ${String(
              frozen.count,
            )} now. Nothing was done; preview again.`,
            { expected: input.expectedCount, current: frozen.count },
          );
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'bulk.create',
            entityType: 'BulkOperation',
            entityId: id,
            before: null,
            after: {
              kind: grant.kind,
              items: frozen.count,
              customers: frozen.customers,
              amountMinor: grant.amountMinor?.toString() ?? null,
              currency: grant.currency,
              totalLiabilityMinor:
                grant.amountMinor === null
                  ? null
                  : (grant.amountMinor * BigInt(frozen.count)).toString(),
              trafficBytes: grant.trafficBytes?.toString() ?? null,
              durationDays: grant.durationDays,
              notify: input.notify,
              notBefore: input.notBefore?.toISOString() ?? null,
              audienceHash: audience.hash,
              fingerprint: frozen.fingerprint,
            },
            result: 'SUCCESS',
            reason: note,
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'BulkOperationStateChanged',
          aggregateType: 'BulkOperation',
          aggregateId: id,
          payload: {
            operationId: id,
            kind: grant.kind,
            from: null,
            to: 'RUNNING',
            items: frozen.count,
          },
        });
        await rememberOnce(
          this.deps.idempotency,
          scope,
          NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { operationId: id },
          tx,
        );
      },
    );
    return this.require(scope, id);
  }

  /**
   * Stops every item not yet processed. A credit already written is never reversed by a
   * cancel, and a grant already planned runs to its own authoritative end. Cancelling before
   * `notBefore` therefore cancels everything. A repeated cancel is answered, not refused.
   */
  async cancel(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<BulkOperationRecord> {
    const existing = await this.require(scope, id);
    const permission = permissionFor(existing.kind);
    const denial = { action: 'bulk.cancel', entityType: 'BulkOperation', entityId: id };
    await this.authorize(scope, actor, permission, denial);
    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      permission,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        const current = await this.deps.repository.lock(scope, id, tx);
        if (current === null) throw this.notFound();
        if (current.state === 'CANCELLED') return;
        if (!(await this.deps.repository.cancel(scope, id, now, tx))) {
          throw errors.conflict(BULK_ERROR_CODES.STATE_CONFLICT, 'This operation has finished.', {
            state: current.state,
          });
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'bulk.cancel',
            entityType: 'BulkOperation',
            entityId: id,
            before: { state: current.state },
            after: { state: 'CANCELLED' },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'BulkOperationStateChanged',
          aggregateType: 'BulkOperation',
          aggregateId: id,
          payload: {
            operationId: id,
            kind: current.kind,
            from: current.state,
            to: 'CANCELLED',
            items: current.itemCount,
          },
        });
      },
    );
    return this.require(scope, id);
  }

  // --- helpers -------------------------------------------------------------------------

  private async eligibility(
    scope: TenantContext,
    evaluation: {
      readonly tenantId: string;
      readonly definition: FrozenAudience['definition'];
      readonly asOf: Date;
    },
    kind: 'SERVICE_TRAFFIC' | 'SERVICE_TIME',
    tx?: TransactionScope,
  ): Promise<GrantEligibility> {
    const type: OperationType = kind === 'SERVICE_TRAFFIC' ? 'ADD_TRAFFIC' : 'ADD_TIME';
    const panels = await this.deps.repository.panelsFor(scope, evaluation, kind, tx);
    const operable: string[] = [];
    for (const panelId of panels) {
      const verdict = await this.deps.panels.operability(scope, panelId as PanelId, type, tx);
      if (verdict.ok) operable.push(panelId);
    }
    return { kind, operablePanelIds: operable };
  }

  private async checkedGrant(scope: TenantContext, grant: BulkGrant): Promise<CheckedGrant> {
    if (grant.kind === 'WALLET_CREDIT') {
      const amount = BigInt(grant.amountMinor);
      if (!isValidLedgerAmount(amount)) {
        throw errors.validation(BULK_ERROR_CODES.AMOUNT_INVALID, 'That amount cannot be credited.');
      }
      if ((await this.deps.sellingCurrency(scope)) !== grant.currency) {
        throw errors.validation(
          BULK_ERROR_CODES.CURRENCY_UNSUPPORTED,
          'This installation does not sell in that currency.',
        );
      }
      return {
        kind: grant.kind,
        amountMinor: amount,
        currency: grant.currency,
        trafficBytes: null,
        durationDays: null,
      };
    }
    if (grant.kind === 'SERVICE_TRAFFIC') {
      const bytes = parseTrafficGb(grant.trafficGb);
      if (bytes === null || bytes <= 0n || bytes > BULK_TRAFFIC_MAX_BYTES) {
        throw errors.validation(BULK_ERROR_CODES.AMOUNT_INVALID, 'That traffic cannot be granted.');
      }
      return {
        kind: grant.kind,
        amountMinor: null,
        currency: null,
        trafficBytes: bytes,
        durationDays: null,
      };
    }
    if (grant.durationDays < 1 || grant.durationDays > BULK_DURATION_MAX_DAYS) {
      throw errors.validation(BULK_ERROR_CODES.AMOUNT_INVALID, 'That duration cannot be granted.');
    }
    return {
      kind: grant.kind,
      amountMinor: null,
      currency: null,
      trafficBytes: null,
      durationDays: grant.durationDays,
    };
  }

  private toPreview(
    grant: CheckedGrant,
    audience: FrozenAudience,
    asOf: Date,
    summary: { readonly count: number; readonly customers: number; readonly fingerprint: string },
    sample: BulkPreview['sample'] | readonly BulkPreview['sample'][number][],
  ): BulkPreview {
    return {
      kind: grant.kind,
      asOf: asOf.toISOString(),
      definition: audience.definition,
      definitionHash: audience.hash,
      count: summary.count,
      customers: summary.customers,
      fingerprint: summary.fingerprint,
      totalLiability:
        grant.amountMinor === null || grant.currency === null
          ? null
          : {
              amountMinor: (grant.amountMinor * BigInt(summary.count)).toString(),
              currency: grant.currency,
            },
      trafficBytesPerItem: grant.trafficBytes?.toString() ?? null,
      durationDaysPerItem: grant.durationDays,
      sample: [...sample],
    };
  }

  private async require(scope: TenantContext, id: string): Promise<BulkOperationRecord> {
    const record = await this.deps.repository.find(scope, id);
    if (record === null) throw this.notFound();
    return record;
  }

  private notFound() {
    return errors.notFound(BULK_ERROR_CODES.NOT_FOUND, 'No such mass operation.');
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
      throw error;
    }
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}
