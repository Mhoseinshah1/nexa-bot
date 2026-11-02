import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_NOTIFICATION_TEMPLATES,
  money,
  type BotInstanceId,
  type OrderPurpose,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  orderEndScreen,
  ORDER_END_STATES,
} from '../../apps/api/src/modules/commerce/messaging/application/order-end-screen';
import {
  ORDER_END_ANSWER_STEPS,
  ORDER_SCREEN_ANSWER_STEPS,
  orderScreenReadiness,
} from '../../apps/api/src/modules/commerce/messaging/application/order-screen-answer';
import type { TelegramWizardRecord } from '../../apps/api/src/modules/commerce/messaging/application/telegram-message-state';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import {
  notificationButtons,
  orderEndButtons,
} from '../../apps/api/src/surfaces/telegram/runtime/keyboards';
import { intentOf } from '../../apps/api/src/surfaces/telegram/runtime/intent-of';

/**
 * R11 A11: the pure halves of "an ended order is answered on its own message" — what the
 * ended screen says, where re-ordering leads, which screens it may be edited onto, and the
 * `ro:` route. The integration suite (`r11-order-end-edit-in-place`) proves the edit, the one
 * fallback send and the once-per-order record.
 */
const CATEGORY = '01900000-0000-7000-8000-0000000000c1';

function order(
  purpose: OrderPurpose,
  over: { code?: string | null; category?: boolean } = {},
): Pick<OrderRecord, 'code' | 'purpose' | 'line' | 'totals'> {
  return {
    code: over.code === undefined ? 'AB12CD34' : over.code,
    purpose,
    line: {
      productId: purpose === 'CUSTOM_SERVICE' ? null : ('p1' as never),
      panelId: 'panel' as never,
      title: 'پلن طلایی',
      category:
        over.category === false
          ? null
          : { categoryId: CATEGORY as never, name: 'عمومی', emoji: null },
      specification: { durationDays: 30, trafficBytes: 1n, deviceLimit: null },
      unitPrice: money(250_000n, 'IRT'),
      quantity: 1,
    },
    totals: {
      subtotal: money(250_000n, 'IRT'),
      discount: money(0n, 'IRT'),
      total: money(250_000n, 'IRT'),
      currency: 'IRT',
    } as never,
  };
}

describe('the ended order screen (R11 A11)', () => {
  it('keeps the order summary — code, product, amount — and nothing else', () => {
    expect(orderEndScreen(order('NEW_SERVICE')).values).toEqual({
      orderCode: 'AB12CD34',
      productName: 'پلن طلایی',
      total: money(250_000n, 'IRT'),
    });
    // A row the code backfill has not reached drops the line rather than drawing it empty.
    expect(orderEndScreen(order('NEW_SERVICE', { code: null })).values).not.toHaveProperty(
      'orderCode',
    );
  });

  it('re-orders a new service from its own category, read-only, and anything else from a menu', () => {
    expect(orderEndScreen(order('NEW_SERVICE')).reorder).toEqual({
      kind: 'CATEGORY',
      categoryId: CATEGORY,
    });
    expect(orderEndScreen(order('NEW_SERVICE', { category: false })).reorder).toEqual({
      kind: 'CATALOGUE',
    });
    expect(orderEndScreen(order('CUSTOM_SERVICE')).reorder).toEqual({ kind: 'CUSTOM_SERVICE' });
    for (const purpose of ['RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES'] as const) {
      expect(orderEndScreen(order(purpose)).reorder).toEqual({ kind: 'CATALOGUE' });
    }
  });

  it('draws exactly «🔁 سفارش دوباره» and «🏠 منوی اصلی», side by side, and nothing that pays', () => {
    const buttons = orderEndButtons({ kind: 'CATEGORY', categoryId: CATEGORY });
    expect(buttons.map((button) => ('data' in button ? button.data : null))).toEqual([
      `ro:${CATEGORY}`,
      'mm:',
    ]);
    expect(buttons.map((button) => button.label)).toEqual([
      { kind: 'TEMPLATE', key: 'bot.order.reorder_button' },
      { kind: 'TEMPLATE', key: 'bot.order.main_menu_button' },
    ]);
    expect(buttons.every((button) => button.row === 0)).toBe(true);
    expect(orderEndButtons({ kind: 'CUSTOM_SERVICE' })[0]).toMatchObject({ data: 'cu:' });
    expect(orderEndButtons({ kind: 'CATALOGUE' })[0]).toMatchObject({ data: 'co:' });
    // The lane's two ended kinds carry them; nothing else does.
    const reorder = { kind: 'CATALOGUE' } as const;
    expect(notificationButtons('ORDER_EXPIRED', { reorder })).toHaveLength(2);
    expect(notificationButtons('ORDER_CANCELLED', { reorder })).toHaveLength(2);
    expect(notificationButtons('PAYMENT_EXPIRED', { reorder })).toEqual([]);
  });

  it('renders the owner’s labels and no "no money was taken" line', () => {
    expect(CATALOGUE_FA['bot.order.reorder_button']).toBe('🔁 سفارش دوباره');
    expect(CATALOGUE_FA['bot.order.main_menu_button']).toBe('🏠 منوی اصلی');
    for (const key of ['bot.order.expired_screen', 'bot.order.cancelled_screen'] as const) {
      const copy = CATALOGUE_FA[key];
      for (const token of ['{orderCode}', '{productName}', '{total}']) {
        expect(copy).toContain(token);
      }
      expect(copy).not.toMatch(/مبلغی (ثبت|کسر)|کسر نشد|ثبت نشد/u);
    }
    expect(CUSTOMER_NOTIFICATION_TEMPLATES.ORDER_EXPIRED).toBe('bot.order.expired_screen');
    expect(CUSTOMER_NOTIFICATION_TEMPLATES.ORDER_CANCELLED).toBe('bot.order.cancelled_screen');
    expect(ORDER_END_STATES).toEqual({ ORDER_EXPIRED: 'EXPIRED', ORDER_CANCELLED: 'CANCELLED' });
  });

  it('may be edited onto the card receipt prompt, which an order outcome may not', () => {
    const BOT = '01900000-0000-7000-8000-0000000000b1' as BotInstanceId;
    const now = new Date('2026-10-27T10:00:00.000Z');
    const prompt: TelegramWizardRecord = {
      id: 'w1',
      botInstanceId: BOT,
      chatId: '920920',
      messageId: 7,
      kind: 'ORDER',
      step: 'RECEIPT_WAIT',
      version: 1,
      subjectId: 'order-1',
      paymentId: 'payment-1',
      busyUntil: null,
      lastUpdateKey: null,
      updatedAt: new Date(now.getTime() - 60_000),
    };
    const destination = { chatId: '920920', botInstanceId: BOT };
    expect(orderScreenReadiness(prompt, destination, now, 0).kind).toBe('NONE');
    expect(orderScreenReadiness(prompt, destination, now, 0, ORDER_END_ANSWER_STEPS).kind).toBe(
      'READY',
    );
    // A receipt under review is never answered by an ending.
    expect(ORDER_END_ANSWER_STEPS).not.toContain('RECEIPT_REVIEW');
    expect(ORDER_END_ANSWER_STEPS).toEqual([...ORDER_SCREEN_ANSWER_STEPS, 'RECEIPT_WAIT']);
  });

  it('parses «🔁 سفارش دوباره» as a category id and nothing else', () => {
    const tap = (data: string) =>
      intentOf({
        callback_query: {
          id: 'q',
          data,
          message: { message_id: 1, chat: { id: 1, type: 'private' } },
        },
      });
    expect(tap(`ro:${CATEGORY}`)).toMatchObject({ intent: 'REORDER_CATEGORY', targetId: CATEGORY });
    expect(tap('ro:not-a-uuid').intent).toBe('UNSUPPORTED');
    expect(tap(`ro:${CATEGORY}.0`).intent).toBe('UNSUPPORTED');
  });
});
