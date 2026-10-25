import { describe, expect, it } from 'vitest';
import {
  money,
  templateDefinition,
  type ScopeContext,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';
import { TemplateResolver } from '../../apps/api/src/modules/control/templates/application/template-resolver';
import { I18nTemplateCatalogue } from '../../apps/api/src/modules/control/templates/infrastructure/i18n-template-catalogue';
import type { TemplateRepository } from '../../apps/api/src/modules/control/templates/application/ports';
import type { FeatureFlagResolver } from '../../apps/api/src/modules/control/features/application/feature-flags.service';
import { serialiseValues } from '../../apps/api/src/modules/control/notifications/application/notification.service';
import { deserialiseValues } from '../../apps/api/src/modules/control/notifications/application/notification-dispatcher';
import { formatMoneyText } from '../../apps/api/src/modules/commerce/ops-log/application/presenters';
import {
  nightlyReports,
  type NightlyReportData,
} from '../../apps/api/src/modules/commerce/ops-log/application/nightly-report';
import { i18nOpsLogWords as words } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';

/**
 * Round 4 PR-D — the rules the Codex and money review of #301 asked for, each one small and
 * each with the mutation that kills it:
 *
 *  - `deserialiseValues` turning a whole-number string back into a bigint, removed -> the
 *    round-trip test (the render's type check refuses the string);
 *  - `formatMoneyText` ignoring `CURRENCY_EXPONENT` -> the dollar test;
 *  - the top reseller's sum printed without its unit -> the reseller test;
 *  - `TemplateResolver.compatible` removed -> the override test prints a literal `{paymentId}`.
 */

describe('a bigint placeholder survives the notification queue', () => {
  it('comes back from the stored payload as a bigint, so the dispatcher renders it', () => {
    const key = 'ops.log.service_created' as TemplateKey;
    const values: TemplateValues = { traffic: 53_687_091_200n, duration: 30, telegramId: '1' };
    const stored = JSON.parse(JSON.stringify(serialiseValues(values))) as Record<string, unknown>;
    expect(stored['traffic']).toBe('53687091200');
    const back = deserialiseValues({ templateKey: key, payload: stored });
    expect(back['traffic']).toBe(53_687_091_200n);
    expect(back['duration']).toBe(30);
    // A string that is not a whole number is left for the type check to name.
    const odd = deserialiseValues({ templateKey: key, payload: { traffic: '12 GB' } });
    expect(odd['traffic']).toBe('12 GB');
    expect(templateDefinition(key).placeholders.some((p) => p.token === 'traffic')).toBe(true);
  });
});

describe('formatMoneyText respects the currency exponent', () => {
  it('prints dollars in major units with their cents, and toman whole', () => {
    expect(formatMoneyText(money(123_456n, 'USD'))).toBe('۱٬۲۳۴٫۵۶ دلار');
    expect(formatMoneyText(money(5n, 'USD'))).toBe('۰٫۰۵ دلار');
    expect(formatMoneyText(money(250_000n, 'IRT'))).toBe('۲۵۰٬۰۰۰ تومان');
    expect(formatMoneyText(money(-1_000n, 'IRT'))).toBe('-۱٬۰۰۰ تومان');
  });
});

describe('the nightly panels report names the top reseller’s sum with its unit', () => {
  it('prints the top reseller’s sum as money, never a bare figure', () => {
    const none = { count: 0, sum: 0n };
    const data: NightlyReportData = {
      day: new Date('2026-10-11T20:30:00Z'),
      currency: 'IRT',
      newPurchases: none,
      firstPurchases: 0,
      renewals: none,
      traffic: none,
      time: none,
      other: none,
      previousGross: 0n,
      bestHour: null,
      newCustomers: 0,
      activeCustomers: 0,
      trials: 0,
      activeServices: 0,
      customersWithService: 0,
      customersWithoutService: 0,
      errors: 0,
      failedPayments: 0,
      openTickets: 0,
      expiredPayments: 0,
      refunds: none,
      commissions: none,
      giftSum: 0n,
      methods: [],
      panels: [],
      resellers: {
        active: 2,
        salesSum: 900_000n,
        top: { username: 'shop1', name: 'فروشگاه', sum: 600_000n },
        topList: [],
      },
    };
    const panels = nightlyReports(data, words).find((one) => one.logType === 'REPORT_PANELS')!;
    expect(String(panels.values['resellersBlock'])).toContain('@shop1 — ۶۰۰٬۰۰۰ تومان');
  });
});

describe('a tenant override that names a token its key no longer declares', () => {
  const scope = { tenantId: 't-1', botInstanceId: null } as unknown as ScopeContext;
  function resolver(body: string) {
    const repository = {
      findOverride: async (_scope: unknown, key: TemplateKey) => ({
        key,
        locale: 'fa',
        body,
        version: 1,
        revision: 1,
        updatedAt: new Date(0),
      }),
    } as unknown as TemplateRepository;
    const features = { isEnabled: async () => true } as unknown as FeatureFlagResolver;
    return new TemplateResolver(repository, features, new I18nTemplateCatalogue(), {
      presentationFor: async () => ({ timezone: 'UTC', calendar: 'gregorian' }) as never,
    });
  }
  const KEY = 'ops.financial.refund_failed' as TemplateKey;
  const VALUES: TemplateValues = {
    channel: 'کیف پول',
    cause: 'لغو شد',
    reference: 'RT4W8N2B',
    amount: money(1_000n, 'IRT'),
    telegramId: '700100200',
    at: new Date('2026-10-12T09:30:00Z'),
  };

  it('is set aside for the default body, never sent with a literal {token}', async () => {
    // `{paymentId}` and `{refundId}` were tokens of this key before Round 4.
    const text = await resolver('بازگشت {refundId} برای {paymentId} ناموفق: {cause}').render(
      scope,
      KEY,
      VALUES,
    );
    expect(text).not.toMatch(/\{[A-Za-z_]+\}/);
    expect(text).toContain('RT4W8N2B');
  });

  it('leaves an override that uses only declared tokens exactly as the operator wrote it', async () => {
    const text = await resolver('بازگشت ناموفق: {cause} · {reference}').render(scope, KEY, VALUES);
    expect(text).toBe('بازگشت ناموفق: لغو شد · RT4W8N2B');
  });
});
