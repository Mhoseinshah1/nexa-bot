import { describe, expect, it } from 'vitest';
import { money, type ScopeContext, type TemplateKey, type TemplateValues } from '@nexa/contracts';
import { TemplateResolver } from '../../apps/api/src/modules/control/templates/application/template-resolver';
import { I18nTemplateCatalogue } from '../../apps/api/src/modules/control/templates/infrastructure/i18n-template-catalogue';
import type { TemplateRepository } from '../../apps/api/src/modules/control/templates/application/ports';
import type { FeatureFlagResolver } from '../../apps/api/src/modules/control/features/application/feature-flags.service';

/**
 * PR-C (Codex review of #299): a tenant override of the pre-invoice saved BEFORE it carried
 * `{orderCode}` still shows the order's public code — the resolver prepends
 * `bot.order.order_code_line` at render time, exactly once, and only there. The stored
 * override is never rewritten.
 */
const scope = { tenantId: 't-1', botInstanceId: null } as unknown as ScopeContext;
const CODE = 'K7M2P9QA';
const LINE = `🔖 کد سفارش: ${CODE}`;
const AT = new Date('2026-10-09T10:00:00Z');

function resolver(
  overrides: Partial<Record<TemplateKey, string>>,
  enabled = true,
  catalogue: I18nTemplateCatalogue = new I18nTemplateCatalogue(),
) {
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
  return new TemplateResolver(repository, features, catalogue, {
    presentationFor: async () => ({ timezone: 'UTC', calendar: 'gregorian' }) as never,
  });
}

const KEY = 'bot.order.preinvoice' as TemplateKey;
const VALUES: TemplateValues = {
  orderCode: CODE,
  productName: 'پلن',
  total: money(250_000n, 'IRT'),
  walletBalance: money(0n, 'IRT'),
};

const count = (text: string) => text.split(LINE).length - 1;

describe('the order-code line on an old pre-invoice override', () => {
  it('an override without {orderCode} gets the line once, as its first paragraph', async () => {
    const text = await resolver({ [KEY]: 'پیش‌فاکتور قدیمی مدیر' }).render(scope, KEY, VALUES);
    expect(text).toBe(`${LINE}\n\nپیش‌فاکتور قدیمی مدیر`);
  });

  it('an override WITH {orderCode} is untouched', async () => {
    const text = await resolver({ [KEY]: 'سفارش {orderCode}' }).render(scope, KEY, VALUES);
    expect(text).toBe(`سفارش ${CODE}`);
  });

  it('the default body carries the code once, never twice', async () => {
    const text = await resolver({}).render(scope, KEY, VALUES);
    expect(count(text)).toBe(1);
  });

  it('no code in hand, no line', async () => {
    const { orderCode: _omit, ...rest } = VALUES;
    const text = await resolver({ [KEY]: 'پیش‌فاکتور قدیمی مدیر' }).render(scope, KEY, rest);
    expect(text).toBe('پیش‌فاکتور قدیمی مدیر');
  });

  it('uses the tenant’s own override of the line, and touches no other key', async () => {
    const text = await resolver({
      [KEY]: 'پیش‌فاکتور قدیمی مدیر',
      ['bot.order.order_code_line' as TemplateKey]: 'کد: {orderCode}',
    }).render(scope, KEY, VALUES);
    expect(text).toBe(`کد: ${CODE}\n\nپیش‌فاکتور قدیمی مدیر`);
    const other = await resolver({ ['bot.wallet.balance' as TemplateKey]: 'متن مدیر' }).render(
      scope,
      'bot.wallet.balance' as TemplateKey,
      { ...VALUES, balance: money(1n, 'IRT') },
    );
    expect(other).toBe('متن مدیر');
  });
});
