import type {
  CurrencyCode,
  CustomerNotificationKind,
  ResellerPreferences,
  ScopeContext,
  TenantContext,
  UnitOfWork,
  UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TemplatePresentation } from '../../../control/templates/application/ports.js';
import type { ServiceRecord } from '../../provisioning/application/ports.js';
import { isExpiring } from './reseller-web-services.service.js';
import type { ResellerSellingRepository } from './selling-ports.js';

/** One tenant-local day: its half-open window and its calendar date (Gregorian, `YYYY-MM-DD`). */
export interface TenantDay {
  readonly start: Date;
  readonly end: Date;
  readonly date: string;
}

/** `YYYY-MM-DD` of an instant in a time zone — the key of "once a day". */
export function localDate(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export interface ResellerWebDailyReportsDeps {
  /** The tenant's ACTIVE resellers, a page at a time (the minimum sweep's own read). */
  readonly resellers: {
    pageActive(
      scope: TenantContext,
      after: { readonly createdAt: string; readonly id: string } | null,
      limit: number,
      tx: unknown,
    ): Promise<{
      readonly items: readonly { readonly customerId: string }[];
      readonly next: { readonly createdAt: string; readonly id: string } | null;
    }>;
  };
  readonly preferences: (scope: TenantContext, customerId: string) => Promise<ResellerPreferences>;
  readonly services: {
    listedForCustomer(
      scope: TenantContext,
      customerId: UserId,
      cap: number,
    ): Promise<{ readonly items: readonly ServiceRecord[] }>;
  };
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
  /** The tenant's day windows: today and yesterday in its time zone and calendar. */
  readonly days: (
    now: Date,
    presentation: TemplatePresentation,
  ) => { readonly today: TenantDay; readonly yesterday: TenantDay };
  readonly presentation: { presentationFor(scope: ScopeContext): Promise<TemplatePresentation> };
  readonly sellingCurrency: (scope: TenantContext) => Promise<CurrencyCode>;
  readonly repository: Pick<ResellerSellingRepository, 'insertDailyReport'>;
  readonly notifier: {
    notify(
      scope: TenantContext,
      customerId: UserId,
      kind: CustomerNotificationKind,
      subjectId: string,
      now: Date,
      tx: TransactionScope,
    ): Promise<boolean>;
  };
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: { now(): Date };
  readonly ids: { uuid(): string };
}

/** At most this many services listed in one digest (the rest are counted). */
export const RESELLER_DIGEST_MAX_LINES = 30;
const PAGE = 100;

/**
 * PR-5 (carried from PR-4) — the reseller's two daily reports, consumed from their own
 * preferences: «سرویس رو به اتمام» (default on) lists their services with ≤ 7 days or ≤ 10 %
 * traffic left, and «گزارش روزانهٔ فروش» (default off) gives yesterday's sales count and sum
 * from the monthly reseller sales tracking. A `SYSTEM_JOB` pass of the customer reminder loop;
 * "once per reseller per tenant-local day" is the unique key of `reseller_web_daily_reports`,
 * and the notice is queued in the same transaction as its row. Moves no money.
 */
export class ResellerWebDailyReportsService {
  constructor(private readonly deps: ResellerWebDailyReportsDeps) {}

  async runOnce(scope: TenantContext): Promise<number> {
    const now = this.deps.clock.now();
    const presentation = await this.deps.presentation.presentationFor(scope);
    const { today, yesterday } = this.deps.days(now, presentation);
    let queued = 0;
    let cursor: { readonly createdAt: string; readonly id: string } | null = null;
    do {
      const page = await this.deps.uow.run(scope, async (tx) =>
        (await this.deps.scopeActivity.scopeIsActive(scope, tx))
          ? this.deps.resellers.pageActive(scope, cursor, PAGE, tx)
          : { items: [], next: null },
      );
      cursor = page.next;
      for (const reseller of page.items) {
        queued += await this.forReseller(
          scope,
          reseller.customerId as UserId,
          today,
          yesterday,
          now,
        );
      }
    } while (cursor !== null);
    return queued;
  }

  private async forReseller(
    scope: TenantContext,
    customerId: UserId,
    today: TenantDay,
    yesterday: TenantDay,
    now: Date,
  ): Promise<number> {
    const preferences = await this.deps.preferences(scope, customerId);
    let queued = 0;
    if (preferences.expiringDigest) {
      const { items } = await this.deps.services.listedForCustomer(scope, customerId, 5000);
      const expiring = items
        .filter((service) => isExpiring(service, now))
        .sort(
          (a, b) =>
            (a.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
            (b.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
        );
      if (expiring.length > 0) {
        const lines = expiring
          .slice(0, RESELLER_DIGEST_MAX_LINES)
          .map((service) => `• ${service.providerUsername}`);
        if (expiring.length > RESELLER_DIGEST_MAX_LINES) lines.push('…');
        queued += await this.report(
          scope,
          customerId,
          'EXPIRING_DIGEST',
          today.date,
          { count: expiring.length, lines },
          now,
        );
      }
    }
    if (preferences.dailySalesReport) {
      const rows = await this.deps.sales.resellerSalesOf(scope, customerId, {
        from: yesterday.start,
        to: yesterday.end,
      });
      const currency = await this.deps.sellingCurrency(scope);
      const row = rows.find((one) => one.currency === currency);
      queued += await this.report(
        scope,
        customerId,
        'DAILY_SALES',
        today.date,
        {
          day: yesterday.start.toISOString(),
          count: rows.reduce((sum, one) => sum + one.count, 0),
          amountMinor: (row?.amount ?? 0n).toString(),
          currency,
        },
        now,
      );
    }
    return queued;
  }

  /** The day's row and its notice, in ONE transaction; nothing when the day already has one. */
  private async report(
    scope: TenantContext,
    customerId: UserId,
    kind: 'EXPIRING_DIGEST' | 'DAILY_SALES',
    date: string,
    facts: Record<string, unknown>,
    now: Date,
  ): Promise<number> {
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 0;
      const id = await this.deps.repository.insertDailyReport(
        scope,
        { id: this.deps.ids.uuid(), customerId, kind, day: date, facts, now },
        tx,
      );
      if (id === null) return 0;
      const notice: CustomerNotificationKind =
        kind === 'EXPIRING_DIGEST' ? 'RESELLER_WEB_EXPIRING_DIGEST' : 'RESELLER_WEB_DAILY_SALES';
      return (await this.deps.notifier.notify(scope, customerId, notice, id, now, tx)) ? 1 : 0;
    });
  }
}
