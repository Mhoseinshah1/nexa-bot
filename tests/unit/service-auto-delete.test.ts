import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_NOTIFICATION_PRECONDITIONS,
  CUSTOMER_NOTIFICATION_QUIET_HOURS,
  CUSTOMER_NOTIFICATION_TEMPLATES,
  featureFlagDefinition,
  settingDefinition,
} from '@nexa/contracts';
import {
  autoDeleteAfter,
  autoDeleteIdempotencyKey,
} from '../../apps/api/src/modules/commerce/provisioning/application/service-auto-delete.service';
import {
  nightlyReports,
  type NightlyReportData,
} from '../../apps/api/src/modules/commerce/ops-log/application/nightly-report';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';

/**
 * NEXA-OWNER-BATCH-1 PR-3: the automatic deletion's pure rules and registry entries. The
 * behaviour against a database is `tests/integration/service-auto-delete.test.ts`.
 */
describe('PR-3 — automatic deletion: the rules that need no database', () => {
  it('is off by default, with every cause off and a day of warning', () => {
    expect(featureFlagDefinition('service_auto_delete').defaultEnabled).toBe(false);
    for (const key of [
      'service.auto_delete.after_traffic_days',
      'service.auto_delete.after_time_days',
      'service.auto_delete.after_suspend_days',
    ] as const) {
      expect(settingDefinition(key).defaultValue).toBe(0);
      expect(settingDefinition(key).schema.safeParse(-1).success).toBe(false);
    }
    expect(settingDefinition('service.auto_delete.warn_hours').defaultValue).toBe(24);
    expect(settingDefinition('service.auto_delete.max_per_minute').defaultValue).toBe(30);
    // A rate of zero would be no deletion and a silent backlog: refused.
    expect(
      settingDefinition('service.auto_delete.max_per_minute').schema.safeParse(0).success,
    ).toBe(false);
  });

  it('never deletes sooner than the warning allows, nor before the due moment', () => {
    const now = new Date('2026-11-07T10:00:00Z');
    const longDue = new Date('2026-11-01T00:00:00Z');
    // Overdue and warned now: a full warning's lead from now.
    expect(autoDeleteAfter(longDue, now, 24).toISOString()).toBe('2026-11-08T10:00:00.000Z');
    // No warning: deletable at once (never earlier than the moment it was scheduled).
    expect(autoDeleteAfter(longDue, now, 0).toISOString()).toBe(now.toISOString());
    // Due later than the lead: the due moment.
    const later = new Date('2026-11-10T00:00:00Z');
    expect(autoDeleteAfter(later, now, 24).toISOString()).toBe(later.toISOString());
  });

  it('derives the TERMINATE key from the cycle, so a retry is the same deletion', () => {
    expect(autoDeleteIdempotencyKey('run-1')).toBe(autoDeleteIdempotencyKey('run-1'));
    expect(autoDeleteIdempotencyKey('run-1')).not.toBe(autoDeleteIdempotencyKey('run-2'));
  });

  it('re-checks the warning at send time and never holds it overnight', () => {
    expect(CUSTOMER_NOTIFICATION_PRECONDITIONS.SERVICE_AUTO_DELETE_WARNING).toBe(true);
    expect(CUSTOMER_NOTIFICATION_QUIET_HOURS.SERVICE_AUTO_DELETE_WARNING).toBe(false);
    expect(CUSTOMER_NOTIFICATION_TEMPLATES.SERVICE_AUTO_DELETE_WARNING).toBe(
      'bot.service.auto_delete_warning',
    );
  });

  it("puts the day's count on the nightly report's cleanup line, and nothing when none", () => {
    const data = {
      day: new Date('2026-10-20T20:30:00Z'),
      currency: 'IRT',
      newPurchases: { count: 0, sum: 0n },
      firstPurchases: 0,
      renewals: { count: 0, sum: 0n },
      traffic: { count: 0, sum: 0n },
      time: { count: 0, sum: 0n },
      other: { count: 0, sum: 0n },
      previousGross: 0n,
      bestHour: null,
      newCustomers: 0,
      activeCustomers: 0,
      customersWithService: 0,
      customersWithoutService: 0,
      trials: 0,
      activeServices: 0,
      errors: 0,
      failedPayments: 0,
      openTickets: 0,
      expiredPayments: 0,
      autoDeleted: 12,
      compaction: null,
      refunds: { count: 0, sum: 0n },
      commissions: { count: 0, sum: 0n },
      giftSum: 0n,
      methods: [],
      panels: [],
      resellers: { active: 0, salesSum: 0n, top: null, topList: [] },
    } satisfies NightlyReportData;
    const [summary] = nightlyReports(data, i18nOpsLogWords);
    expect(summary?.values['cleanup']).toBe('🗑 حذف خودکار: ۱۲ سرویس پایان‌یافته از پنل حذف شد');
    const [quiet] = nightlyReports({ ...data, autoDeleted: 0 }, i18nOpsLogWords);
    expect(quiet?.values['cleanup']).toBeUndefined();
  });
});
