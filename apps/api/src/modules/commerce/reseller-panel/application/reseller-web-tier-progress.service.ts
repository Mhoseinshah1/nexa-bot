import {
  RESELLER_SELLING_AUDIT_ACTIONS,
  RESELLER_WEB_ERROR_CODES,
  errors,
  fromWire,
  money,
  resellerTierTargetWriteSchema,
  toWire,
  type ActorContext,
  type AuditWriter,
  type CurrencyCode,
  type FeatureFlagKey,
  type ResellerTierProgress,
  type ResellerTierTarget,
  type ScopeContext,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TemplatePresentation } from '../../../control/templates/application/ports.js';
import type { ResellerWebContext } from './reseller-web-access.service.js';
import type { ResellerSellingRepository, ResellerTierTargetRecord } from './selling-ports.js';

export const RESELLER_TIER_PROGRESS_FEATURE: FeatureFlagKey = 'reseller_tier_progress';

export interface ResellerWebTierProgressDeps {
  readonly repository: Pick<ResellerSellingRepository, 'findTierTarget' | 'saveTierTarget'>;
  readonly tiers: { findTier(scope: TenantContext, id: string, tx?: unknown): Promise<unknown> };
  readonly features: {
    isEnabled(scope: ScopeContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
  };
  /** The existing monthly reseller sales tracking (O-2), for ONE reseller. */
  readonly sales: {
    resellerSalesOf(
      scope: ScopeContext & { readonly tenantId: string },
      customerId: string,
      window: { readonly from: Date; readonly to: Date },
    ): Promise<
      readonly {
        readonly currency: CurrencyCode;
        readonly count: number;
        readonly amount: bigint;
      }[]
    >;
  };
  readonly periods: {
    month(
      which: 'THIS_MONTH',
      now: Date,
      presentation: TemplatePresentation,
    ): { readonly start: Date; readonly end: Date };
  };
  readonly presentation: { presentationFor(scope: ScopeContext): Promise<TemplatePresentation> };
  readonly guard: Pick<PermissionGuard, 'check'>;
  readonly audit: AuditWriter;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: { now(): Date };
}

function targetWire(record: ResellerTierTargetRecord | null): ResellerTierTarget | null {
  if (record === null) return null;
  if (record.kind === 'COUNT' && record.count !== null)
    return { kind: 'COUNT', count: record.count };
  if (record.kind === 'AMOUNT' && record.amountMinor !== null && record.currency !== null) {
    return {
      kind: 'AMOUNT',
      amount: toWire(money(record.amountMinor, record.currency as CurrencyCode)),
    };
  }
  return null;
}

/**
 * PR-5 §5.8 — «پیشرفت تا سطح بعد». DISPLAY ONLY: it reads the tier's optional target and this
 * month's sales from the existing monthly reseller sales tracking, and changes no tier —
 * `docs/round-n-reseller-audit.md` §3 stays true. The card shows only while the owner's
 * `reseller_tier_progress` flag is on and the reseller's tier has a target.
 */
export class ResellerWebTierProgressService {
  constructor(private readonly deps: ResellerWebTierProgressDeps) {}

  async progress(context: ResellerWebContext): Promise<ResellerTierProgress> {
    const now = this.deps.clock.now();
    const presentation = await this.deps.presentation.presentationFor(context.scope);
    const month = this.deps.periods.month('THIS_MONTH', now, presentation);
    const tier = context.standing.tier;
    const hidden: ResellerTierProgress = {
      shown: false,
      tierName: tier.name,
      target: null,
      count: 0,
      amount: null,
      remainingCount: null,
      remainingAmount: null,
      monthEnd: month.end.toISOString(),
    };
    if (!(await this.deps.features.isEnabled(context.scope, RESELLER_TIER_PROGRESS_FEATURE))) {
      return hidden;
    }
    const target = targetWire(await this.deps.repository.findTierTarget(context.scope, tier.id));
    if (target === null) return hidden;
    const sales = await this.deps.sales.resellerSalesOf(context.scope, context.customer.id, {
      from: month.start,
      to: month.end,
    });
    const count = sales.reduce((sum, row) => sum + row.count, 0);
    if (target.kind === 'COUNT') {
      return {
        ...hidden,
        shown: true,
        target,
        count,
        remainingCount: Math.max(0, target.count - count),
      };
    }
    const goal = fromWire(target.amount);
    const sold = sales.find((row) => row.currency === goal.currency)?.amount ?? 0n;
    return {
      ...hidden,
      shown: true,
      target,
      count,
      amount: toWire(money(sold, goal.currency)),
      remainingAmount: toWire(
        money(goal.amountMinor > sold ? goal.amountMinor - sold : 0n, goal.currency),
      ),
    };
  }

  /** Web Admin: a tier's target — `resellers.view`. */
  async adminTarget(
    scope: TenantContext,
    actor: ActorContext,
    tierId: string,
  ): Promise<{ readonly target: ResellerTierTarget | null }> {
    await this.deps.guard.check(scope, actor, 'resellers.view');
    const tenant: TenantContext = { tenantId: scope.tenantId, botInstanceId: null };
    if ((await this.deps.tiers.findTier(tenant, tierId)) === null) throw notFound();
    return { target: targetWire(await this.deps.repository.findTierTarget(tenant, tierId)) };
  }

  /** Web Admin: set or clear a tier's target — `resellers.edit`, audited. Changes no tier. */
  async adminSetTarget(
    scope: TenantContext,
    actor: ActorContext,
    tierId: string,
    input: unknown,
  ): Promise<{ readonly target: ResellerTierTarget | null }> {
    await this.deps.guard.check(scope, actor, 'resellers.edit');
    const command = resellerTierTargetWriteSchema.parse(input);
    const tenant: TenantContext = { tenantId: scope.tenantId, botInstanceId: null };
    const target = command.target;
    if (target !== null && target.kind === 'AMOUNT' && fromWire(target.amount).amountMinor <= 0n) {
      throw errors.validation(RESELLER_WEB_ERROR_CODES.REQUEST_INVALID, 'A target is above zero.');
    }
    await this.deps.uow.run(tenant, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(tenant, tx))) {
        throw errors.conflict(
          RESELLER_WEB_ERROR_CODES.UNAVAILABLE,
          'This tenant has stopped accepting work.',
        );
      }
      if ((await this.deps.tiers.findTier(tenant, tierId, tx)) === null) throw notFound();
      const before = targetWire(await this.deps.repository.findTierTarget(tenant, tierId));
      await this.deps.repository.saveTierTarget(
        tenant,
        {
          tierId,
          target:
            target === null
              ? null
              : target.kind === 'COUNT'
                ? { kind: 'COUNT', count: target.count, amountMinor: null, currency: null }
                : {
                    kind: 'AMOUNT',
                    count: null,
                    amountMinor: fromWire(target.amount).amountMinor,
                    currency: target.amount.currency,
                  },
          now: this.deps.clock.now(),
        },
        tx,
      );
      await this.deps.audit.record(
        tenant,
        actor,
        {
          action: RESELLER_SELLING_AUDIT_ACTIONS.TIER_TARGET,
          entityType: 'ResellerTier',
          entityId: tierId,
          before: { target: before },
          after: { target, key: command.idempotencyKey },
          result: 'SUCCESS',
        },
        tx,
      );
    });
    return { target };
  }
}

function notFound() {
  return errors.notFound(RESELLER_WEB_ERROR_CODES.NOT_FOUND, 'No such tier.');
}
