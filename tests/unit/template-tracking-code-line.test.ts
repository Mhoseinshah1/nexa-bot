import { describe, expect, it } from 'vitest';
import {
  money,
  TRACKING_CODE_LINE_KEYS,
  type ScopeContext,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';
import { TemplateResolver } from '../../apps/api/src/modules/control/templates/application/template-resolver';
import { I18nTemplateCatalogue } from '../../apps/api/src/modules/control/templates/infrastructure/i18n-template-catalogue';
import type { TemplateRepository } from '../../apps/api/src/modules/control/templates/application/ports';
import type { FeatureFlagResolver } from '../../apps/api/src/modules/control/features/application/feature-flags.service';

/**
 * FIX-02 (Codex review of #253): a tenant override of an invoice template saved BEFORE the
 * invoices required `{reference}` still shows the payment's tracking code — the resolver
 * appends `bot.payment.tracking_code_line` at render time, exactly once, and only there. The
 * stored override is never rewritten.
 */
const scope = { tenantId: 't-1', botInstanceId: null } as unknown as ScopeContext;
const CODE = '7d433a363380f69e';
const LINE = `کد پیگیری پرداخت: ${CODE}`;
const AT = new Date('2026-10-09T10:00:00Z');

function resolver(overrides: Partial<Record<TemplateKey, string>>, enabled = true) {
  const stored = new Map(Object.entries(overrides));
  const repository = {
    findOverride: async (_scope: unknown, key: TemplateKey) => {
      const body = stored.get(key);
      return body === undefined
        ? null
        : { key, locale: 'fa', body, version: 1, revision: 1, updatedAt: AT };
    },
  } as unknown as TemplateRepository;
  const features = { isEnabled: async () => enabled } as unknown as FeatureFlagResolver;
  return new TemplateResolver(repository, features, new I18nTemplateCatalogue(), {
    presentationFor: async () => ({ timezone: 'UTC', calendar: 'gregorian' }) as never,
  });
}

const VALUES: TemplateValues = {
  reference: CODE,
  total: money(250_000n, 'IRT'),
  principal: money(250_000n, 'IRT'),
  fee: money(5_000n, 'IRT'),
  payable: money(255_000n, 'IRT'),
  stars: 100,
  expiresAt: AT,
  cardNumber: '6037991100001001',
  cardName: 'علی رضایی',
};

const count = (text: string) => text.split(LINE).length - 1;

describe('the tracking-code line on an old invoice override', () => {
  it.each(TRACKING_CODE_LINE_KEYS)(
    '%s: an override without {reference} gets the line once, as its last paragraph',
    async (key) => {
      const text = await resolver({ [key]: 'فاکتور قدیمی مدیر' }).render(scope, key, VALUES);
      expect(text).toBe(`فاکتور قدیمی مدیر\n\n${LINE}`);
    },
  );

  it.each(TRACKING_CODE_LINE_KEYS)('%s: an override WITH {reference} is untouched', async (key) => {
    const text = await resolver({ [key]: 'فاکتور مدیر — کد: {reference}' }).render(
      scope,
      key,
      VALUES,
    );
    expect(text).toBe(`فاکتور مدیر — کد: ${CODE}`);
  });

  it.each(TRACKING_CODE_LINE_KEYS)(
    '%s: the default body carries the line once, never twice',
    async (key) => {
      const text = await resolver({}).render(scope, key, VALUES);
      expect(count(text)).toBe(1);
    },
  );

  it('an override that is suppressed by the feature flag renders the default, once', async () => {
    const key = 'bot.payment.gateway_invoice' as TemplateKey;
    const text = await resolver({ [key]: 'فاکتور قدیمی مدیر' }, false).render(scope, key, VALUES);
    expect(text).not.toContain('فاکتور قدیمی مدیر');
    expect(count(text)).toBe(1);
  });

  it('uses the tenant’s own override of the line itself', async () => {
    const key = 'bot.payment.gateway_invoice' as TemplateKey;
    const text = await resolver({
      [key]: 'فاکتور قدیمی مدیر',
      ['bot.payment.tracking_code_line' as TemplateKey]: '🔖 کد: {reference}',
    }).render(scope, key, VALUES);
    expect(text).toBe(`فاکتور قدیمی مدیر\n\n🔖 کد: ${CODE}`);
  });

  it('never touches a key outside the invoice set, override or not', async () => {
    for (const key of [
      'bot.payment.gateway_confirmed',
      'bot.payment.receipt_prompt',
      'bot.wallet.balance',
    ] as TemplateKey[]) {
      const text = await resolver({ [key]: 'متن مدیر' }).render(scope, key, {
        ...VALUES,
        minutes: 10,
        balance: money(1n, 'IRT'),
      });
      expect(text, key).toBe('متن مدیر');
    }
  });
});
