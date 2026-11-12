import {
  RESELLER_SELLING_AUDIT_ACTIONS,
  RESELLER_WEB_ERROR_CODES,
  errors,
  type ActorContext,
  type AuditWriter,
  type ResellerAdminTrials,
  type ResellerTrialIssued,
  type ResellerTrialStatus,
  type ScopeContext,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { TrialService } from '../../trials/application/trial.service.js';
import type { ResellerWebContext } from './reseller-web-access.service.js';

/** `reseller.trial_daily_quota` and `reseller.trial_product`. */
export const RESELLER_TRIAL_QUOTA_SETTING = 'reseller.trial_daily_quota';
export const RESELLER_TRIAL_PRODUCT_SETTING = 'reseller.trial_product';

export interface ResellerWebTrialsDeps {
  readonly trials: Pick<TrialService, 'claim'>;
  readonly settings: { valueOf<T>(scope: ScopeContext, key: string): Promise<T> };
  /** Whether that panel's trial configuration is switched on (a trial is a panel's since R1). */
  readonly trialEnabled: (scope: TenantContext, panelId: string) => Promise<boolean>;
  /** The reseller's panel trials that still count, in a window or ever (null). */
  readonly count: (
    scope: TenantContext,
    customerId: UserId,
    window: { readonly from: Date; readonly to: Date } | null,
  ) => Promise<number>;
  /** Today in the tenant's time zone and calendar, half-open. */
  readonly today: (scope: TenantContext) => Promise<{ readonly from: Date; readonly to: Date }>;
  readonly guard: Pick<PermissionGuard, 'check'>;
  readonly audit: AuditWriter;
}

/**
 * PR-5 §5.7 — «سرویس تست — امروز: x از N».
 *
 * Each trial is the trial service's own claim (`TrialService.claim`) of the tenant's chosen
 * trial (`reseller.trial_product`, a panel's trial configuration), owned by the reseller and
 * marked a reseller trial: a zero-total TRIAL order, so no money, no reseller sales credit, no
 * referral and no cashback. The daily quota (`reseller.trial_daily_quota`, 0 = off) is counted
 * per tenant-local day UNDER the customer's row lock inside the claim. The link reaches the
 * reseller's chat by the ordinary delivery once the panel has made the service.
 */
export class ResellerWebTrialsService {
  constructor(private readonly deps: ResellerWebTrialsDeps) {}

  async status(context: ResellerWebContext): Promise<ResellerTrialStatus> {
    const { quota, panelId } = await this.settings(context.scope);
    const day = await this.deps.today(context.scope);
    const usedToday = await this.deps.count(context.scope, context.customer.id as UserId, day);
    const enabled =
      quota > 0 && panelId !== null && (await this.deps.trialEnabled(context.scope, panelId));
    return { enabled, quota, usedToday };
  }

  async issue(context: ResellerWebContext, idempotencyKey: string): Promise<ResellerTrialIssued> {
    const { quota, panelId } = await this.settings(context.scope);
    if (quota <= 0 || panelId === null) throw unavailable('OFF');
    const customerId = context.customer.id as UserId;
    const day = await this.deps.today(context.scope);
    const claimed = await this.deps.trials.claim(context.scope, context.actor, customerId, {
      idempotencyKey,
      panelId,
      reseller: { quota, day },
    });
    if (claimed.outcome !== 'ISSUED') {
      throw unavailable(claimed.outcome === 'REFUSED' ? claimed.reason : 'UNAVAILABLE');
    }
    const usedToday = await this.deps.count(context.scope, customerId, day);
    if (!claimed.replayed) {
      await this.deps.audit.record(context.scope, context.actor, {
        action: RESELLER_SELLING_AUDIT_ACTIONS.TRIAL_ISSUED,
        entityType: 'Customer',
        entityId: customerId,
        before: null,
        after: { orderId: claimed.orderId, serviceId: claimed.serviceId, usedToday, quota },
        result: 'SUCCESS',
      });
    }
    return { serviceId: claimed.serviceId, orderId: claimed.orderId, usedToday, quota };
  }

  /** The reseller drawer: today's trials, the quota, and all of them — `resellers.view`. */
  async adminTrials(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
  ): Promise<ResellerAdminTrials> {
    await this.deps.guard.check(scope, actor, 'resellers.view');
    const tenant: TenantContext = { tenantId: scope.tenantId, botInstanceId: null };
    const { quota } = await this.settings(tenant);
    return {
      today: await this.deps.count(tenant, customerId as UserId, await this.deps.today(tenant)),
      quota,
      total: await this.deps.count(tenant, customerId as UserId, null),
    };
  }

  private async settings(
    scope: TenantContext,
  ): Promise<{ readonly quota: number; readonly panelId: string | null }> {
    return {
      quota: await this.deps.settings.valueOf<number>(scope, RESELLER_TRIAL_QUOTA_SETTING),
      panelId: await this.deps.settings.valueOf<string | null>(
        scope,
        RESELLER_TRIAL_PRODUCT_SETTING,
      ),
    };
  }
}

function unavailable(reason: string) {
  return errors.conflict(
    RESELLER_WEB_ERROR_CODES.TRIAL_UNAVAILABLE,
    'The reseller test service is not available now.',
    { reason },
  );
}
