import {
  RESELLER_MINIMUM_PROGRESS_MAX,
  money,
  type ActorContext,
  type Clock,
  type CurrencyCode,
  type FeatureFlagKey,
  type IdGenerator,
  type Money,
  type ResellerMinimumFilter,
  type ResellerMinimumNoticeKind,
  type ResellerMinimumPeriod,
  type ResellerMinimumSource,
  type ResellerMinimumState,
  type ResellerStatus,
  type ScopeContext,
  type SettingKey,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { MonthlyPeriod } from '../../../../infrastructure/time/monthly-period.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TemplatePresentation } from '../../../control/templates/application/ports.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import { ORDER_VIEW_PERMISSION } from '../../orders/application/order.service.js';
import { effectiveMonthlyMinimum, minimumStanding } from '../domain/monthly-minimum.js';
import type { ResellerRepository } from './ports.js';
import { RESELLERS_VIEW_PERMISSION } from './reseller-admin.service.js';

/** The sweep's bound on resellers per pass: every one of a realistic tenant, and no more. */
const SWEEP_LIMIT = 2_000;

export interface ResellerMinimumServiceDeps {
  readonly resellers: Pick<ResellerRepository, 'listAll' | 'noticesIn' | 'raiseNotice'>;
  /** WP12's reseller sales, by the one shared statement (`resellerSalesStatement`). */
  readonly sales: {
    resellerSalesIn(
      scope: TenantContext,
      window: { readonly from: Date; readonly to: Date },
    ): Promise<ReadonlyMap<string, ReadonlyMap<CurrencyCode, bigint>>>;
  };
  /** The reports' own month boundaries, in the tenant's calendar (`TenantMonthlyPeriods`). */
  readonly periods: {
    month(
      which: ResellerMinimumPeriod,
      now: Date,
      presentation: TemplatePresentation,
    ): MonthlyPeriod;
    reminderStart(now: Date, days: number, presentation: TemplatePresentation): Date;
  };
  readonly presentation: {
    presentationFor(scope: ScopeContext, tx?: unknown): Promise<TemplatePresentation>;
  };
  /** Readers only: a background loop that can write a setting could turn itself on. */
  readonly settings: {
    valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T>;
  };
  readonly features: {
    isEnabled(scope: ScopeContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
  };
  readonly notifier: CustomerNotifier;
  readonly guard: PermissionGuard;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface ResellerMinimumRowRecord {
  readonly customerId: string;
  readonly telegramUserId: string;
  readonly displayName: string | null;
  readonly tier: { readonly id: string; readonly name: string };
  readonly status: ResellerStatus;
  readonly minimum: Money | null;
  readonly source: ResellerMinimumSource;
  readonly achieved: Money;
  readonly remaining: Money | null;
  readonly progressBasisPoints: number | null;
  readonly state: ResellerMinimumState;
}

export interface ResellerMinimumReportRecord {
  readonly period: MonthlyPeriod & { readonly timezone: string; readonly calendar: string };
  readonly rows: readonly ResellerMinimumRowRecord[];
  readonly counts: {
    readonly achieved: number;
    readonly below: number;
    readonly noMinimum: number;
    readonly notActive: number;
  };
  readonly truncated: boolean;
}

/**
 * The reseller monthly minimum (round N R2, `docs/round-n-reseller-audit.md` §3): the
 * operator's progress read, and the sweep that raises the two optional notices.
 *
 * TRACKING, REPORTING AND NOTIFICATION ONLY. Nothing here writes a ledger entry, a debt, a
 * fee, a settlement, a status or a tier: the sweep writes a `reseller_minimum_notices` row
 * and a notification row, and nothing else. Mirza's declared "loses reseller status" is
 * PARTIAL evidence and deliberately not built (§4).
 */
export class ResellerMinimumService {
  constructor(private readonly deps: ResellerMinimumServiceDeps) {}

  /**
   * Every reseller's standing against the minimum for this month or the previous one.
   * `resellers.view` AND `orders.view`: each figure is a sum of order amounts, which
   * `orders.view` already reads one order at a time (the WP14 D2 split).
   */
  async progress(
    scope: TenantContext,
    actor: ActorContext,
    query: { readonly period?: ResellerMinimumPeriod; readonly filter?: ResellerMinimumFilter },
  ): Promise<ResellerMinimumReportRecord> {
    await this.deps.guard.check(scope, actor, RESELLERS_VIEW_PERMISSION);
    await this.deps.guard.check(scope, actor, ORDER_VIEW_PERMISSION);
    const now = this.deps.clock.now();
    const presentation = await this.deps.presentation.presentationFor(scope);
    const period = this.deps.periods.month(query.period ?? 'THIS_MONTH', now, presentation);
    const selling = await this.deps.settings.valueOf<CurrencyCode>(scope, 'sales.currency');
    const listings = await this.deps.resellers.listAll(
      scope,
      { activeOnly: false },
      RESELLER_MINIMUM_PROGRESS_MAX + 1,
    );
    const sales = await this.deps.sales.resellerSalesIn(scope, {
      from: period.start,
      to: period.end,
    });

    const rows = listings.slice(0, RESELLER_MINIMUM_PROGRESS_MAX).map((listing) => {
      const { minimum, source } = effectiveMonthlyMinimum(
        listing.tier.monthlyMinimum,
        listing.monthlyMinimum,
      );
      // Only sales in the minimum's own currency count toward it (R8's rule, for credit).
      const currency = minimum?.currency ?? selling;
      const achieved = sales.get(listing.customerId)?.get(currency) ?? 0n;
      const standing = minimumStanding(listing.status, minimum, achieved);
      return {
        customerId: listing.customerId,
        telegramUserId: listing.telegramUserId,
        displayName: listing.displayName,
        tier: { id: listing.tier.id, name: listing.tier.name },
        status: listing.status,
        minimum,
        source,
        achieved: money(achieved, currency),
        remaining: standing.remaining === null ? null : money(standing.remaining, currency),
        progressBasisPoints: standing.progressBasisPoints,
        state: standing.state,
      } satisfies ResellerMinimumRowRecord;
    });

    const count = (state: ResellerMinimumState) => rows.filter((r) => r.state === state).length;
    const filter = query.filter ?? 'ALL';
    return {
      period: { ...period, timezone: presentation.timezone, calendar: presentation.calendar },
      rows: filter === 'ALL' ? rows : rows.filter((r) => r.state === filter),
      counts: {
        achieved: count('ACHIEVED'),
        below: count('BELOW'),
        noMinimum: count('NO_MINIMUM'),
        notActive: count('NOT_ACTIVE'),
      },
      truncated: listings.length > RESELLER_MINIMUM_PROGRESS_MAX,
    };
  }

  /**
   * One pass of the notice sweep for a tenant (the customer reminder loop's cadence).
   *
   * - The month is the tenant's current calendar month, `[start, end)`.
   * - A REMINDER is due from `reminders.reseller_minimum_days` local days before the month
   *   ends, to an ACTIVE reseller with a positive minimum whose sales are still below it,
   *   while `reseller_minimum_reminders` is on.
   * - An ACHIEVED notice is due, while `reseller_minimum_achieved_notices` is on, to one
   *   whose sales reached it.
   * - At most ONE of each per reseller per month: the notice row is unique on
   *   (reseller, kind, month) and written `ON CONFLICT DO NOTHING`, and the notification is
   *   queued only by the writer that won. Two replicas, a restart and every later pass of
   *   the same month write nothing more — the multi-worker rule for background work here.
   *
   * Returns how many notifications were queued.
   */
  async runOnce(scope: TenantContext): Promise<number> {
    const now = this.deps.clock.now();
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 0;
      const remind = await this.deps.features.isEnabled(scope, 'reseller_minimum_reminders', tx);
      const achieve = await this.deps.features.isEnabled(
        scope,
        'reseller_minimum_achieved_notices',
        tx,
      );
      if (!remind && !achieve) return 0;

      const presentation = await this.deps.presentation.presentationFor(scope, tx);
      const period = this.deps.periods.month('THIS_MONTH', now, presentation);
      const days = await this.deps.settings.valueOf<number>(
        scope,
        'reminders.reseller_minimum_days',
        tx,
      );
      const reminderDue =
        remind &&
        now.getTime() >= this.deps.periods.reminderStart(now, days, presentation).getTime();
      if (!reminderDue && !achieve) return 0;

      const candidates = (
        await this.deps.resellers.listAll(scope, { activeOnly: true }, SWEEP_LIMIT, tx)
      ).flatMap((listing) => {
        const { minimum } = effectiveMonthlyMinimum(
          listing.tier.monthlyMinimum,
          listing.monthlyMinimum,
        );
        return minimum === null ? [] : [{ customerId: listing.customerId, minimum }];
      });
      if (candidates.length === 0) return 0;

      const told = await this.deps.resellers.noticesIn(scope, period.start, tx);
      const sales = await this.deps.sales.resellerSalesIn(scope, {
        from: period.start,
        to: period.end,
      });

      let queued = 0;
      for (const { customerId, minimum } of candidates) {
        const achieved = sales.get(customerId)?.get(minimum.currency) ?? 0n;
        const kind: ResellerMinimumNoticeKind | null =
          achieved >= minimum.amountMinor
            ? achieve
              ? 'ACHIEVED'
              : null
            : reminderDue
              ? 'REMINDER'
              : null;
        if (kind === null || told.has(`${customerId}:${kind}`)) continue;
        const id = this.deps.ids.uuid();
        const written = await this.deps.resellers.raiseNotice(
          scope,
          {
            id,
            customerId,
            kind,
            periodStart: period.start,
            periodEnd: period.end,
            minimum,
            achieved,
          },
          now,
          tx,
        );
        if (!written) continue;
        const notification =
          kind === 'REMINDER' ? 'RESELLER_MINIMUM_REMINDER' : 'RESELLER_MINIMUM_ACHIEVED';
        // The notice is written whether or not the reseller can be reached, so a reseller
        // with no bot link is not re-derived every pass; `notify` answers false for them.
        if (
          await this.deps.notifier.notify(scope, customerId as UserId, notification, id, now, tx)
        ) {
          queued += 1;
        }
      }
      return queued;
    });
  }
}
