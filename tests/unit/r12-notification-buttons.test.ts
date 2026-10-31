import { describe, expect, it } from 'vitest';
import { CUSTOMER_NOTIFICATION_KINDS, type CustomerNotificationKind } from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  PAY_METHODS_CALLBACK_PREFIX,
  SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX,
  SERVICE_CALLBACK_PREFIX,
  SERVICE_RENEW_CALLBACK_PREFIX,
  TOPUP_MENU_CALLBACK_PREFIX,
} from '../../apps/api/src/surfaces/telegram/runtime/callbacks';
import { notificationButtons } from '../../apps/api/src/surfaces/telegram/runtime/keyboards';

/**
 * R12 F3 item 1: a notification that asks the customer to do something carries the button
 * that does it. The labels are the registry's (so the owner's names hold); the routes are
 * existing callbacks that open a screen and pay nothing.
 */
const SERVICE = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';

const dataOf = (button: object): string | undefined =>
  'data' in button ? (button.data as string) : undefined;

const labelOf = (button: { readonly label: { readonly kind: string; readonly key?: string } }) =>
  button.label.key === undefined ? '' : CATALOGUE_FA[button.label.key as keyof typeof CATALOGUE_FA];

const EXPIRY: readonly CustomerNotificationKind[] = [
  'SERVICE_EXPIRY_EARLY',
  'SERVICE_EXPIRY_FIRST',
  'SERVICE_EXPIRY_SECOND',
  'SERVICE_EXPIRY_DAY',
  'SERVICE_EXPIRED',
];

describe('R12 F3 item 1: the buttons a notification carries', () => {
  it.each(EXPIRY)('%s: «💊 تمدید سرویس» and «📊 مشخصات سرویس»', (kind) => {
    const buttons = notificationButtons(kind, { serviceId: SERVICE });
    expect(buttons.map(labelOf)).toEqual(['💊 تمدید سرویس', '📊 مشخصات سرویس']);
    expect(buttons.map(dataOf)).toEqual([
      `${SERVICE_RENEW_CALLBACK_PREFIX}${SERVICE}`,
      `${SERVICE_CALLBACK_PREFIX}${SERVICE}`,
    ]);
    // Side by side, like the owner's other two-button notifications.
    expect(buttons.map((button) => button.row)).toEqual([0, 0]);
  });

  it.each(['SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL'] as const)(
    '%s: «➕ خرید حجم اضافه»',
    (kind) => {
      const buttons = notificationButtons(kind, { serviceId: SERVICE });
      expect(buttons.map(labelOf)).toEqual(['➕ خرید حجم اضافه']);
      expect(dataOf(buttons[0]!)).toBe(`${SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX}${SERVICE}`);
    },
  );

  it('a pending order and a pending payment open the order’s payment methods', () => {
    const order = notificationButtons('ORDER_PENDING_REMINDER', { orderId: ORDER });
    expect(order.map(dataOf)).toEqual([`${PAY_METHODS_CALLBACK_PREFIX}${ORDER}`]);
    const payment = notificationButtons('PAYMENT_PENDING_REMINDER', {
      payment: { orderId: ORDER },
    });
    expect(payment.map(dataOf)).toEqual([`${PAY_METHODS_CALLBACK_PREFIX}${ORDER}`]);
    // A top-up has no order: its way on is the top-up menu.
    const topup = notificationButtons('PAYMENT_PENDING_REMINDER', { payment: { orderId: null } });
    expect(topup.map(dataOf)).toEqual([TOPUP_MENU_CALLBACK_PREFIX]);
  });

  it.each(['PAYMENT_REJECTED', 'PAYMENT_EXPIRED'] as const)('%s: «🧾 پرداخت دوباره»', (kind) => {
    const order = notificationButtons(kind, { payment: { orderId: ORDER } });
    expect(order.map(labelOf)).toEqual(['🧾 پرداخت دوباره']);
    expect(dataOf(order[0]!)).toBe(`${PAY_METHODS_CALLBACK_PREFIX}${ORDER}`);
    const topup = notificationButtons(kind, { payment: { orderId: null } });
    expect(topup.map(labelOf)).toEqual(['🧾 پرداخت دوباره']);
    expect(dataOf(topup[0]!)).toBe(TOPUP_MENU_CALLBACK_PREFIX);
  });

  it.each(['SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED'] as const)(
    '%s: support',
    (kind) => {
      const buttons = notificationButtons(kind, {});
      expect(buttons).toHaveLength(1);
      expect(buttons[0]?.inline).toBe('service.support');
      expect(labelOf(buttons[0]!)).toContain('پشتیبانی');
    },
  );

  it('a subject that could not be read yields no button, never a guessed one', () => {
    for (const kind of [...EXPIRY, 'SERVICE_USAGE_FINAL' as const]) {
      expect(notificationButtons(kind, {})).toEqual([]);
    }
    expect(notificationButtons('ORDER_PENDING_REMINDER', {})).toEqual([]);
    expect(notificationButtons('PAYMENT_PENDING_REMINDER', {})).toEqual([]);
    expect(notificationButtons('PAYMENT_REJECTED', {})).toEqual([]);
    expect(notificationButtons('PAYMENT_EXPIRED', {})).toEqual([]);
  });

  it('every kind still resolves to a list (nothing throws for an unlisted kind)', () => {
    for (const kind of CUSTOMER_NOTIFICATION_KINDS) {
      expect(Array.isArray(notificationButtons(kind, {}))).toBe(true);
    }
  });
});
