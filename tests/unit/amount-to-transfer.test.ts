import { describe, expect, it } from 'vitest';
import { PAYMENT_GATEWAY_PROVIDERS, money, routeTakesCustomerFee } from '@nexa/contracts';
import { amountToTransfer } from '../../apps/api/src/modules/commerce/payments/domain/amount-to-transfer';

/** R6 item 4: what a customer had to transfer, and which routes may charge a fee. */
describe('amountToTransfer', () => {
  it('is the payable when a fee snapshot exists, the principal otherwise', () => {
    const amount = money(200_000n, 'IRT');
    expect(amountToTransfer({ amount, customerFee: null })).toEqual(amount);
    expect(amountToTransfer({ amount, customerFee: { payable: money(220_000n, 'IRT') } })).toEqual(
      money(220_000n, 'IRT'),
    );
  });
});

describe('routeTakesCustomerFee', () => {
  it('is true for card-to-card and every external gateway', () => {
    expect(routeTakesCustomerFee('MANUAL_TRANSFER')).toBe(true);
    for (const provider of PAYMENT_GATEWAY_PROVIDERS) {
      expect(routeTakesCustomerFee(provider), provider).toBe(true);
    }
  });
});
