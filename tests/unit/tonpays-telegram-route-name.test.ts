import { describe, expect, it } from 'vitest';
import { CATALOGUE_FA } from '@nexa/i18n';
import type { ScopeContext, TemplateKey } from '@nexa/contracts';
import { CustomerScreenComposer } from '../../apps/api/src/modules/commerce/messaging/application/customer-screens';

/**
 * TPTG-23 (`docs/tonpays-telegram-gateway-audit.md` §4): the website route's DEFAULT name is
 * «درگاه پرداخت تون پی وبسایت» and the new route's «درگاه پرداخت تون پی تلگرام» — the
 * catalogue VALUES; the keys, the provider identity `TONPAYS` and every tenant's own name are
 * untouched. A tenant's `display_name` wins over the template, and a tenant's override of
 * the template (the resolver's job) wins over the catalogue.
 */
const scope = { tenantId: 't', botInstanceId: null } as unknown as ScopeContext;

describe('the TonPays route names', () => {
  /** A resolver that renders the catalogue, or a tenant's override when one is set. */
  const composer = (overrides: Partial<Record<TemplateKey, string>> = {}) =>
    new CustomerScreenComposer({
      render: (_scope, key) =>
        Promise.resolve(overrides[key] ?? (CATALOGUE_FA as Record<string, string>)[key] ?? key),
    });

  it('defaults the website route to «درگاه پرداخت تون پی وبسایت» and the Telegram route to «درگاه پرداخت تون پی تلگرام»', async () => {
    expect(await composer().routeName(scope, { provider: 'TONPAYS', displayName: null })).toBe(
      'درگاه پرداخت تون پی وبسایت',
    );
    expect(
      await composer().routeName(scope, { provider: 'TONPAYS_TELEGRAM', displayName: null }),
    ).toBe('درگاه پرداخت تون پی تلگرام');
  });

  it('keeps a tenant’s own display name and a tenant’s template override', async () => {
    expect(
      await composer().routeName(scope, { provider: 'TONPAYS', displayName: 'درگاه من' }),
    ).toBe('درگاه من');
    expect(
      await composer({ 'bot.payment.route_name_tonpays': 'تون‌پیز قدیمی' }).routeName(scope, {
        provider: 'TONPAYS',
        displayName: null,
      }),
    ).toBe('تون‌پیز قدیمی');
  });
});
