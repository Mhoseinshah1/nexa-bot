import { describe, expect, it } from 'vitest';
import {
  CompactionArgsError,
  parseCompactionArgs,
  reportText,
} from '../../apps/api/src/data-compaction.cli';
import {
  compactionLine,
  nightlyReports,
  summarizeCompactionDay,
  type NightlyReportData,
} from '../../apps/api/src/modules/commerce/ops-log/application/nightly-report';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';

/**
 * Round 9 C3: the owner's CLI refuses to delete without an explicit, counted confirmation, and
 * the nightly summary carries ONE compaction line — what was removed, or, when nothing was,
 * what a dry run would remove.
 */

describe('data-compaction CLI arguments', () => {
  it('is a dry run by default', () => {
    expect(parseCompactionArgs([])).toEqual({ apply: false, confirmRows: null, tenantSlug: null });
    expect(parseCompactionArgs(['--dry-run']).apply).toBe(false);
  });

  it('refuses --apply without --confirm-rows, and --confirm-rows without --apply', () => {
    expect(() => parseCompactionArgs(['--apply'])).toThrow(CompactionArgsError);
    expect(() => parseCompactionArgs(['--confirm-rows', '5'])).toThrow(CompactionArgsError);
    expect(() => parseCompactionArgs(['--apply', '--dry-run', '--confirm-rows', '1'])).toThrow(
      CompactionArgsError,
    );
    expect(() => parseCompactionArgs(['--apply', '--confirm-rows', '-1'])).toThrow(
      CompactionArgsError,
    );
    expect(parseCompactionArgs(['--apply', '--confirm-rows', '42', '--tenant', 'main'])).toEqual({
      apply: true,
      confirmRows: 42,
      tenantSlug: 'main',
    });
  });

  it('exits non-zero for every outcome that removed nothing it was asked to', () => {
    expect(reportText({ kind: 'BLOCKED', reason: 'BACKUP_IN_FLIGHT' }).exitCode).toBe(4);
    expect(reportText({ kind: 'BUSY' }).exitCode).toBe(2);
    const mismatch = reportText({ kind: 'COUNT_MISMATCH', eligibleRows: 7, counts: {} });
    expect(mismatch.exitCode).toBe(3);
    expect(mismatch.text).toContain('--confirm-rows 7');
  });
});

describe('the nightly compaction line', () => {
  it('sums APPLY passes; falls back to the last dry run; says nothing for nothing', () => {
    expect(summarizeCompactionDay([])).toBeNull();
    expect(
      summarizeCompactionDay([
        { mode: 'APPLY', counts: { notifications: 2, notification_delivery_attempts: 3 } },
        { mode: 'APPLY', counts: { customer_notifications: 4, receipt_captures: 1 } },
        { mode: 'DRY_RUN', counts: { notifications: 99 } },
      ]),
    ).toEqual({
      applied: true,
      classes: { OPS_NOTIFICATIONS: 5, CUSTOMER_NOTIFICATIONS: 4, RECEIPT_WINDOWS: 1 },
    });
    expect(
      summarizeCompactionDay([
        { mode: 'DRY_RUN', counts: { notifications: 1 } },
        { mode: 'DRY_RUN', counts: { gateway_receipt_captures: 3 } },
        { mode: 'APPLY', counts: {} },
      ]),
    ).toEqual({
      applied: false,
      classes: { OPS_NOTIFICATIONS: 0, CUSTOMER_NOTIFICATIONS: 0, RECEIPT_WINDOWS: 3 },
    });
    expect(summarizeCompactionDay([{ mode: 'DRY_RUN', counts: {} }])).toBeNull();
  });

  it('words a dry run as one that removed nothing, and omits empty classes', () => {
    expect(
      compactionLine(
        {
          applied: false,
          classes: { OPS_NOTIFICATIONS: 0, CUSTOMER_NOTIFICATIONS: 12, RECEIPT_WINDOWS: 0 },
        },
        i18nOpsLogWords,
      ),
    ).toBe('🗜 فشرده‌سازی داده — فقط شمارش، چیزی حذف نشد: اعلان‌های کاربران ۱۲');
    expect(compactionLine(null, i18nOpsLogWords)).toBeNull();
  });

  it('shares the one cleanup value with the expired payments, one row each', () => {
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
      expiredPayments: 3,
      compaction: {
        applied: true,
        classes: { OPS_NOTIFICATIONS: 7, CUSTOMER_NOTIFICATIONS: 0, RECEIPT_WINDOWS: 0 },
      },
      refunds: { count: 0, sum: 0n },
      commissions: { count: 0, sum: 0n },
      giftSum: 0n,
      methods: [],
      panels: [],
      resellers: { active: 0, salesSum: 0n, top: null, topList: [] },
    } satisfies NightlyReportData;
    const [summary] = nightlyReports(data, i18nOpsLogWords);
    expect(summary?.values['cleanup']).toBe(
      '🧹 پاکسازی: ۳ پرداخت ناتمام منقضی شد\n🗜 فشرده‌سازی داده — حذف شد: اعلان‌های عملیات ۷',
    );
    const [quiet] = nightlyReports(
      { ...data, expiredPayments: 0, compaction: null },
      i18nOpsLogWords,
    );
    expect(quiet?.values['cleanup']).toBeUndefined();
  });
});
