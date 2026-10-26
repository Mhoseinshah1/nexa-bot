import { describe, expect, it } from 'vitest';
import { miniAppCardInstructionSchema, money, type PaymentId, type UserId } from '@nexa/contracts';
import { instructionWire } from '../../apps/api/src/surfaces/miniapp/projections';
import type { PaymentRecord } from '../../apps/api/src/modules/commerce/payments/application/ports';

/**
 * R10 B6: the Mini App's card instruction is the bot's R8 A2 card invoice on another surface —
 * ONE amount, the one to transfer (the payable, fee included), in rial with Toman beside it,
 * and no principal and fee apart. The wire carries nothing a screen could break it down with.
 */

const AT = new Date('2026-10-26T08:00:00Z');

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: '01a0fa00-0000-7000-8000-0000000000e6' as PaymentId,
    source: 'NEXA',
    customerId: '01a0fa00-0000-7000-8000-0000000000c6' as UserId,
    orderId: null,
    state: 'PENDING',
    method: 'MANUAL_TRANSFER',
    amount: money(470_000n, 'IRT'),
    reference: 'ref',
    code: 'AB12CD34',
    evidenceKind: null,
    evidenceNote: null,
    externalReference: null,
    confirmedAt: null,
    confirmedByAdminId: null,
    resolvedAt: null,
    resolvedByAdminId: null,
    resolutionNote: null,
    customerSignalledAt: null,
    checkoutHeldUntil: null,
    expiresAt: new Date(AT.getTime() + 70 * 60_000),
    gatewayProvider: null,
    topupCashbackPercent: null,
    customerFee: {
      basisPoints: 1000,
      fee: money(47_000n, 'IRT'),
      payable: money(517_000n, 'IRT'),
    },
    providerReviewStartedAt: null,
    providerReviewUntil: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

describe('R10 B6: the Mini App card instruction on the wire', () => {
  it('with a customer fee: the payable as the one amount, in rial and Toman, and no principal or fee', () => {
    const wire = instructionWire({ payment: payment(), destination: null });
    expect(wire).toMatchObject({
      amount: { amountMinor: '517000', currency: 'IRT' },
      amountRial: '۵٬۱۷۰٬۰۰۰',
      amountToman: '۵۱۷٬۰۰۰',
      copyAmount: '5170000',
    });
    expect(wire).not.toHaveProperty('principal');
    expect(wire).not.toHaveProperty('fee');
    expect(JSON.stringify(wire)).not.toContain('47000');
    expect(JSON.stringify(wire)).not.toContain('470000');
    // The schema the Mini App parses with has no field for either.
    expect(Object.keys(miniAppCardInstructionSchema.shape)).not.toContain('principal');
    expect(Object.keys(miniAppCardInstructionSchema.shape)).not.toContain('fee');
    expect(miniAppCardInstructionSchema.parse(wire)).toEqual(wire);
  });
});
