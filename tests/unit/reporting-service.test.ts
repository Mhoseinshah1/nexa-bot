import { describe, expect, it } from 'vitest';
import type { ActorContext, OperationalEventInput, TenantContext } from '@nexa/contracts';
import { ReportAccess } from '../../apps/api/src/modules/commerce/reporting/application/report-access';
import {
  basisPoints,
  boundariesOf,
  exportFileStem,
  moneyPair,
  paymentFigures,
} from '../../apps/api/src/modules/commerce/reporting/application/reporting.service';
import { IntlReportPeriodResolver } from '../../apps/api/src/infrastructure/time/report-calendar';
import type { PermissionGuard } from '../../apps/api/src/modules/platform/access/application/permission-guard';

/**
 * The reporting service's pure rules and the Super Admin gate
 * (`docs/wp12-business-analytics-audit.md` §2, §3, §5.4, §8).
 */
const scope = {
  tenantId: '01900000-0000-7000-8000-000000000001',
  botInstanceId: null,
} as TenantContext;
const actor = {
  type: 'WEB_ADMIN',
  id: '01900000-0000-7000-8000-0000000000aa',
  label: 'admin:test',
  surface: 'WEB',
} as unknown as ActorContext;

const counts = (overrides: Partial<Record<string, number>>) =>
  ({
    PENDING: 0,
    CONFIRMED: 0,
    FAILED: 0,
    CANCELLED: 0,
    EXPIRED: 0,
    UNKNOWN: 0,
    ...overrides,
  }) as never;

describe('reporting service rules', () => {
  it('rates success over decided attempts only: pending and unknown are in neither term', () => {
    const figures = paymentFigures(counts({ CONFIRMED: 3, FAILED: 1, PENDING: 5, UNKNOWN: 2 }), []);
    expect(figures.attempts).toBe(11);
    expect(figures.successRateBasisPoints).toBe(7500);
    // Cancelled and expired are failed terminal attempts too.
    expect(
      paymentFigures(counts({ CONFIRMED: 1, CANCELLED: 1, EXPIRED: 2 }), []).successRateBasisPoints,
    ).toBe(2500);
    // Nothing decided is no rate, never 0% and never infinity.
    expect(paymentFigures(counts({ PENDING: 4 }), []).successRateBasisPoints).toBeNull();
  });

  it('returns no ratio on a zero denominator', () => {
    expect(basisPoints(0, 0)).toBeNull();
    expect(basisPoints(1, 3)).toBe(3333);
  });

  it('compares money per currency over the union of both periods, never across them', () => {
    expect(
      moneyPair(
        [{ currency: 'IRT', amount: 100n }],
        [
          { currency: 'IRT', amount: 40n },
          { currency: 'USD', amount: 7n },
        ],
      ),
    ).toEqual([
      { currency: 'IRT', current: '100', previous: '40' },
      { currency: 'USD', current: '0', previous: '7' },
    ]);
  });

  it('builds width_bucket thresholds from bucket starts plus the last end', () => {
    const b = (i: number) => ({
      index: i,
      start: new Date(i * 10),
      end: new Date(i * 10 + 10),
      label: '',
    });
    expect(boundariesOf([b(0), b(1), b(2)]).map((d) => d.getTime())).toEqual([0, 10, 20, 30]);
    expect(boundariesOf([])).toEqual([]);
  });

  it('names export files by the tenant-calendar range, with no identifier', () => {
    const periods = new IntlReportPeriodResolver();
    const tehran = { timezone: 'Asia/Tehran', calendar: 'jalali' as const };
    const now = new Date('2026-10-05T08:00:00Z');
    const stem = (input: Parameters<IntlReportPeriodResolver['resolve']>[0]) =>
      exportFileStem('SALES', { period: periods.resolve(input, now, tehran) }, periods);
    expect(stem({ range: 'CUSTOM', from: '1405-07-01', to: '1405-07-30' })).toBe(
      'nexa-sales-1405-07-01-to-1405-07-30',
    );
    expect(stem({ range: 'YESTERDAY' })).toBe('nexa-sales-1405-07-12');
    expect(stem({ range: 'PREVIOUS_MONTH' })).toBe('nexa-sales-1405-06');
  });
});

describe('the Super Admin gate', () => {
  const recorded: OperationalEventInput[] = [];
  const opsLog = { record: async (_s: unknown, e: OperationalEventInput) => void recorded.push(e) };

  const guardHolding = (held: boolean) =>
    ({
      check: async () => {
        if (!held)
          throw Object.assign(new Error('Missing permission'), {
            code: 'platform.permission_denied',
          });
      },
      denialEvent: (_a: ActorContext, permission: string) => ({
        code: 'access.permission_denied',
        severity: 'WARN',
        message: `denied ${permission}.`,
        context: { permission },
      }),
    }) as unknown as PermissionGuard;

  it('admits an owner holding the permission', async () => {
    const access = new ReportAccess(
      guardHolding(true),
      { roleKeysFor: async () => ['owner'] },
      opsLog as never,
    );
    await expect(access.authorize(scope, actor, 'reports.view')).resolves.toBeUndefined();
  });

  it('refuses a non-owner who holds the permission, and records why', async () => {
    recorded.length = 0;
    const access = new ReportAccess(
      guardHolding(true),
      { roleKeysFor: async () => ['finance', 'operator'] },
      opsLog as never,
    );
    await expect(access.authorize(scope, actor, 'reports.export')).rejects.toMatchObject({
      code: 'platform.permission_denied',
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.context).toMatchObject({
      permission: 'reports.export',
      requiredRole: 'owner',
    });
  });

  it('refuses an owner the guard denies, before reading any role', async () => {
    let asked = false;
    const access = new ReportAccess(
      guardHolding(false),
      {
        roleKeysFor: async () => {
          asked = true;
          return ['owner'];
        },
      },
      opsLog as never,
    );
    await expect(access.authorize(scope, actor, 'reports.view')).rejects.toMatchObject({
      code: 'platform.permission_denied',
    });
    expect(asked).toBe(false);
  });
});
