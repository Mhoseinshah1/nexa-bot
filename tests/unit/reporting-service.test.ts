import { describe, expect, it } from 'vitest';
import type { ActorContext, OperationalEventInput, TenantContext } from '@nexa/contracts';
import { ReportAccess } from '../../apps/api/src/modules/commerce/reporting/application/report-access';
import {
  basisPoints,
  boundariesOf,
  exportFileStem,
  moneyPair,
  paymentFigures,
  ReportingService,
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
    const at = (cut: number) =>
      boundariesOf([b(0), b(1), b(2)], new Date(cut)).map((d) => d.getTime());
    expect(at(30)).toEqual([0, 10, 20, 30]);
    expect(at(99)).toEqual([0, 10, 20, 30]);
    expect(boundariesOf([], new Date(99))).toEqual([]);
  });

  it('stops the thresholds at the cut: inside a bucket, on a boundary, before the first', () => {
    const b = (i: number) => ({
      index: i,
      start: new Date(i * 10),
      end: new Date(i * 10 + 10),
      label: '',
    });
    const at = (cut: number) =>
      boundariesOf([b(0), b(1), b(2)], new Date(cut)).map((d) => d.getTime());
    expect(at(15)).toEqual([0, 10, 15]);
    expect(at(20)).toEqual([0, 10, 20]);
    expect(at(0)).toEqual([]);
  });

  it('cuts the previous trend like for like: no figure after its effective end, none read past it', async () => {
    // 10:30 in Tehran on 1405/07/03: TODAY is running, so yesterday is cut at 10:30 too.
    const now = new Date('2026-09-25T07:00:00Z');
    const asked: Date[][] = [];
    const service = new ReportingService({
      access: { authorize: async () => undefined } as unknown as ReportAccess,
      repository: {
        trend: async (_s: unknown, _m: unknown, _c: unknown, bounds: readonly Date[]) => {
          asked.push([...bounds]);
          // One sale in every bucket the query was allowed to read.
          return new Map(bounds.slice(1).map((_, i) => [i, 1n]));
        },
      } as never,
      periods: new IntlReportPeriodResolver(),
      presentation: {
        presentationFor: async () => ({ timezone: 'Asia/Tehran', calendar: 'jalali' as const }),
      } as never,
      salesCurrency: { salesCurrency: async () => 'IRT' } as never,
      writer: {} as never,
      clock: { now: () => now } as never,
    });
    const body = await service.trend(scope, actor, { range: 'TODAY' }, 'SALES');
    const cut = new Date(body.period.previous.effectiveEnd);
    expect(body.period.previous.effectiveEnd).toBe('2026-09-24T07:00:00.000Z');
    // The previous side's thresholds end at its cut, never at the end of yesterday.
    expect(asked[1]?.at(-1)?.toISOString()).toBe(cut.toISOString());
    const values = body.previous.map((bucket) => bucket.value);
    // 00:00 to 10:00 begin before the cut: read. 11:00 onwards begin after it: unknown.
    expect(values.slice(0, 11)).toEqual(Array(11).fill('1'));
    expect(values.slice(11)).toEqual(Array(13).fill(null));
    // And the current side stops at now exactly as before.
    expect(body.current.map((bucket) => bucket.value).slice(11)).toEqual(Array(13).fill(null));
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
