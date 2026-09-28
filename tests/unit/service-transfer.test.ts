import { describe, expect, it } from 'vitest';
import type { OrderPurpose, ServiceState, TenantContext, UserId } from '@nexa/contracts';
import {
  ServiceTransferService,
  parseRecipientTelegramId,
  recipientNameOf,
  type ServiceTransferDeps,
} from '../../apps/api/src/modules/commerce/provisioning/application/service-transfer.service';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import type { CustomerRecord } from '../../apps/api/src/modules/commerce/customers/application/ports';

/**
 * Package F — the pure pieces of a customer's service transfer
 * (`docs/package-f-service-transfer-audit.md`): the typed id, the recipient's name, and the
 * one evaluator that decides whether a service may change hands. The transaction itself,
 * its locks and the database's own rules are `tests/integration/service-transfer.test.ts`.
 */

const scope = { tenantId: '0191f4a0-0000-7000-8000-000000000001' } as unknown as TenantContext;

describe('the recipient id a customer types (F1)', () => {
  it.each([
    ['plain digits', '123456789', '123456789'],
    ['surrounding space', '  42  ', '42'],
    ['Persian digits', '۱۲۳۴۵', '12345'],
    ['Arabic-Indic digits', '٩٨٧', '987'],
    ['the longest id Telegram has', '9'.repeat(19), '9'.repeat(19)],
  ])('reads %s', (_label, text, expected) => {
    expect(parseRecipientTelegramId(text)).toBe(expected);
  });

  it.each([
    ['nothing', ''],
    ['a leading zero', '0123'],
    ['zero', '0'],
    ['a sign', '-12'],
    ['a username', '@someone'],
    ['a space inside', '12 34'],
    ['twenty digits', '1'.repeat(20)],
    ['a decimal', '12.5'],
  ])('refuses %s', (_label, text) => {
    expect(parseRecipientTelegramId(text)).toBeNull();
  });
});

describe("how the confirmation names the recipient (F1's 'when safely available')", () => {
  const person = (parts: Partial<CustomerRecord>): CustomerRecord =>
    ({ firstName: null, lastName: null, username: null, ...parts }) as CustomerRecord;

  it('shows the name and the @username Telegram gave', () => {
    expect(
      recipientNameOf(person({ firstName: 'سارا', lastName: 'احمدی', username: 'sara' })),
    ).toBe('سارا احمدی @sara');
    expect(recipientNameOf(person({ firstName: ' سارا ' }))).toBe('سارا');
    expect(recipientNameOf(person({ username: 'sara' }))).toBe('@sara');
  });

  it('shows nothing when Telegram gave neither — the numeric id is always beside it', () => {
    expect(recipientNameOf(person({}))).toBeNull();
    expect(recipientNameOf(person({ firstName: '  ', username: ' ' }))).toBeNull();
  });
});

describe('which services may change hands (F3), in one evaluator', () => {
  const service = (parts: Partial<ServiceRecord>): ServiceRecord =>
    ({
      id: '0191f4a0-2d3c-7c2b-9a41-6f2b0c7e51aa',
      orderId: '0191f4a0-2d3c-7c2b-9a41-6f2b0c7e51ab',
      customerId: '0191f4a0-2d3c-7c2b-9a41-6f2b0c7e51ac' as UserId,
      state: 'ACTIVE',
      deliveryState: 'DELIVERED',
      ...parts,
    }) as ServiceRecord;

  const evaluator = (facts: {
    purpose?: OrderPurpose;
    operation?: boolean;
    refund?: boolean;
    payment?: boolean;
  }) =>
    new ServiceTransferService({
      orders: { findById: async () => ({ purpose: facts.purpose ?? 'NEW_SERVICE' }) },
      repository: {
        operationUndecided: async () => facts.operation ?? false,
        commercialPaymentPending: async () => facts.payment ?? false,
      },
      services: { hasActiveRefundRequest: async () => facts.refund ?? false },
    } as unknown as ServiceTransferDeps);

  it('allows an ACTIVE or SUSPENDED, delivered, paid-for service with nothing pending', async () => {
    for (const state of ['ACTIVE', 'SUSPENDED'] as const) {
      expect(await evaluator({}).ineligibilityOf(scope, service({ state }))).toBeNull();
    }
    // A custom service (Package D) is a paid purchase like any other.
    expect(
      await evaluator({ purpose: 'CUSTOM_SERVICE' }).ineligibilityOf(scope, service({})),
    ).toBeNull();
    expect(await evaluator({}).offered(scope, service({}))).toBe(true);
  });

  it.each(['PENDING_PROVISION', 'EXPIRED', 'TERMINATED', 'UNRECONCILED'] as ServiceState[])(
    'refuses a service that is %s',
    async (state) => {
      expect(await evaluator({}).ineligibilityOf(scope, service({ state }))).toBe('SERVICE_STATE');
    },
  );

  it.each(['PENDING', 'UNCONFIRMED', 'FAILED'] as const)(
    'refuses a service whose link is %s rather than DELIVERED',
    async (deliveryState) => {
      expect(await evaluator({}).ineligibilityOf(scope, service({ deliveryState }))).toBe(
        'NOT_DELIVERED',
      );
    },
  );

  it('refuses a trial, an undecided operation, a refund request and a pending payment', async () => {
    expect(await evaluator({ purpose: 'TRIAL' }).ineligibilityOf(scope, service({}))).toBe('TRIAL');
    expect(await evaluator({ operation: true }).ineligibilityOf(scope, service({}))).toBe(
      'OPERATION_PENDING',
    );
    expect(await evaluator({ refund: true }).ineligibilityOf(scope, service({}))).toBe(
      'REFUND_REQUESTED',
    );
    expect(await evaluator({ payment: true }).ineligibilityOf(scope, service({}))).toBe(
      'PAYMENT_PENDING',
    );
    expect(await evaluator({ payment: true }).offered(scope, service({}))).toBe(false);
  });
});
