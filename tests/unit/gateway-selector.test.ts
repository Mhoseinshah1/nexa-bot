import { describe, expect, it } from 'vitest';
import {
  PAYMENT_GATEWAY_DESCRIPTORS,
  PAYMENT_GATEWAY_PROVIDERS,
  money,
  type PaymentGatewayDescriptor,
} from '@nexa/contracts';
import {
  allowsPurpose,
  boundsOf,
  decideAmount,
  externalRoutes,
  filterRoutesByPurpose,
} from '../../apps/api/src/modules/commerce/payments/domain/gateway-selection.js';

/**
 * The selector's pure half (customer UX completion §D), against FAKE descriptors.
 *
 * `externalRoutes` decides whether the pre-invoice draws a gateway button, and with every
 * provider in this release settling by transfer it must answer nothing — so a descriptor
 * that says `GATEWAY` has to be built HERE, in the test, and never becomes a row:
 * `PAYMENT_GATEWAY_PROVIDERS` is frozen and the CHECK constraint on `provider` keeps the
 * database honest. The point is to prove the branch before a provider exists to take it.
 */

/** A descriptor for a provider that does not exist. Cast, because the type is closed. */
const fakeExternal = (name: string): PaymentGatewayDescriptor =>
  ({ provider: name, settlesVia: 'GATEWAY', requiresCredentials: true }) as never;

const route = (
  provider: string,
  descriptor: PaymentGatewayDescriptor,
  flags: { allowServicePurchase?: boolean; allowWalletTopup?: boolean } = {},
) => ({
  provider,
  displayName: null,
  topupCashbackPercent: 0,
  descriptor,
  allowServicePurchase: flags.allowServicePurchase ?? true,
  allowWalletTopup: flags.allowWalletTopup ?? true,
});

const MANUAL = PAYMENT_GATEWAY_DESCRIPTORS.MANUAL_TRANSFER;

describe('externalRoutes', () => {
  it('answers the empty list for zero routes', () => {
    expect(externalRoutes([])).toEqual([]);
  });

  it('answers the empty list for every provider this release actually has', () => {
    const real = PAYMENT_GATEWAY_PROVIDERS.map((provider) =>
      route(provider, PAYMENT_GATEWAY_DESCRIPTORS[provider]),
    );
    // The reason the pre-invoice never draws the gateway button today.
    expect(externalRoutes(real)).toEqual([]);
  });

  it('keeps the external routes, in order, and drops the manual one between them', () => {
    const first = route('FAKE_A', fakeExternal('FAKE_A'));
    const second = route('FAKE_B', fakeExternal('FAKE_B'));
    const picked = externalRoutes([first, route('MANUAL_TRANSFER', MANUAL), second]);
    expect(picked.map((one) => one.provider)).toEqual(['FAKE_A', 'FAKE_B']);
  });

  it('decides from the descriptor, never from the name', () => {
    // A provider CALLED something gateway-like that settles by transfer is not external.
    const misnamed = route('ZARINPAL_GATEWAY', { ...MANUAL, provider: 'MANUAL_TRANSFER' });
    expect(externalRoutes([misnamed])).toEqual([]);
  });
});

describe('filterRoutesByPurpose', () => {
  it('drops an external route switched off for purchase, and keeps it for top-up', () => {
    const external = route('FAKE_A', fakeExternal('FAKE_A'), { allowServicePurchase: false });
    const manual = route('MANUAL_TRANSFER', MANUAL);
    expect(filterRoutesByPurpose([external, manual], 'SERVICE_PURCHASE')).toEqual([manual]);
    expect(filterRoutesByPurpose([external, manual], 'WALLET_TOPUP')).toEqual([external, manual]);
    // And composed with the settlement filter: no gateway button for a purchase.
    expect(externalRoutes(filterRoutesByPurpose([external, manual], 'SERVICE_PURCHASE'))).toEqual(
      [],
    );
  });

  it('drops a route switched off for top-up, and keeps it for purchase', () => {
    const manual = route('MANUAL_TRANSFER', MANUAL, { allowWalletTopup: false });
    expect(filterRoutesByPurpose([manual], 'WALLET_TOPUP')).toEqual([]);
    expect(filterRoutesByPurpose([manual], 'SERVICE_PURCHASE')).toEqual([manual]);
  });

  it('preserves the order it was given', () => {
    const rows = [route('B', MANUAL), route('A', MANUAL), route('C', MANUAL)];
    expect(filterRoutesByPurpose(rows, 'WALLET_TOPUP').map((one) => one.provider)).toEqual([
      'B',
      'A',
      'C',
    ]);
  });

  it('answers each purpose from its own switch and nothing else', () => {
    expect(
      allowsPurpose({ allowServicePurchase: true, allowWalletTopup: false }, 'SERVICE_PURCHASE'),
    ).toBe(true);
    expect(
      allowsPurpose({ allowServicePurchase: true, allowWalletTopup: false }, 'WALLET_TOPUP'),
    ).toBe(false);
    expect(
      allowsPurpose({ allowServicePurchase: false, allowWalletTopup: true }, 'SERVICE_PURCHASE'),
    ).toBe(false);
    expect(
      allowsPurpose({ allowServicePurchase: false, allowWalletTopup: true }, 'WALLET_TOPUP'),
    ).toBe(true);
  });
});

describe('the amount window', () => {
  it('reads the bounds in the row’s own currency, and falls back only for a row without one', () => {
    expect(
      boundsOf({ minAmountMinor: 10n, maxAmountMinor: 0n, boundsCurrency: 'IRT' }, 'IRR'),
    ).toEqual({ minAmount: money(10n, 'IRT'), maxAmount: null });
    expect(
      boundsOf({ minAmountMinor: 10n, maxAmountMinor: 20n, boundsCurrency: null }, 'IRR'),
    ).toEqual({ minAmount: money(10n, 'IRR'), maxAmount: money(20n, 'IRR') });
  });

  it('admits an amount inside the window, at either edge', () => {
    const window = boundsOf(
      { minAmountMinor: 100n, maxAmountMinor: 200n, boundsCurrency: 'IRT' },
      'IRT',
    );
    expect(decideAmount(window, money(100n, 'IRT'))).toEqual({ admitted: true });
    expect(decideAmount(window, money(150n, 'IRT'))).toEqual({ admitted: true });
    expect(decideAmount(window, money(200n, 'IRT'))).toEqual({ admitted: true });
  });

  it('names the side an amount fell on', () => {
    const window = boundsOf(
      { minAmountMinor: 100n, maxAmountMinor: 200n, boundsCurrency: 'IRT' },
      'IRT',
    );
    expect(decideAmount(window, money(99n, 'IRT'))).toEqual({
      admitted: false,
      reason: 'BELOW_MINIMUM',
      bound: money(100n, 'IRT'),
    });
    expect(decideAmount(window, money(201n, 'IRT'))).toEqual({
      admitted: false,
      reason: 'ABOVE_MAXIMUM',
      bound: money(200n, 'IRT'),
    });
  });

  it('treats zero bounds as no bound on that side', () => {
    const open = boundsOf({ minAmountMinor: 0n, maxAmountMinor: 0n, boundsCurrency: 'IRT' }, 'IRT');
    expect(decideAmount(open, money(1n, 'IRT'))).toEqual({ admitted: true });
    expect(decideAmount(open, money(10n ** 18n, 'IRT'))).toEqual({ admitted: true });
  });

  it('admits nothing through a window in another currency', () => {
    const window = boundsOf(
      { minAmountMinor: 0n, maxAmountMinor: 0n, boundsCurrency: 'IRT' },
      'IRT',
    );
    expect(decideAmount(window, money(1n, 'IRR'))).toEqual({
      admitted: false,
      reason: 'BOUND_CURRENCY_MISMATCH',
    });
  });
});
