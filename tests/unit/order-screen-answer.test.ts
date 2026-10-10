import { describe, expect, it } from 'vitest';
import type { BotInstanceId, TelegramWizardStep } from '@nexa/contracts';
import {
  ORDER_SCREEN_ANSWER_STEPS,
  ORDER_SCREEN_SETTLE_MARGIN_MS,
  orderScreenReadiness,
  orderScreenSettleMs,
} from '../../apps/api/src/modules/commerce/messaging/application/order-screen-answer';
import type { TelegramWizardRecord } from '../../apps/api/src/modules/commerce/messaging/application/telegram-message-state';
import {
  CARD_ANSWERED_OPERATIONS,
  CARD_FAILURE_ANSWERED_OPERATIONS,
} from '../../apps/api/src/modules/commerce/provisioning/application/operation-card';
import {
  CARD_ANSWERED_FAILURE_TYPES,
  successAnsweredElsewhere,
} from '../../apps/api/src/modules/commerce/messaging/application/operation-outcome-announcer';

/**
 * FIX-08: WHEN the notification lane may put an order's outcome on the order's payment
 * message (`order-screen-answer.ts`). The integration suite proves the edit, the fallbacks
 * and the exactly-once record; this proves the decision on every edge, one rule per case.
 */
const BOT = '01900000-0000-7000-8000-0000000000b1' as BotInstanceId;
const OTHER_BOT = '01900000-0000-7000-8000-0000000000b2' as BotInstanceId;
const NOW = new Date('2026-10-10T12:00:00.000Z');
const SETTLE = 12_000;
const destination = { chatId: '910910', botInstanceId: BOT };

const wizard = (over: Partial<TelegramWizardRecord> = {}): TelegramWizardRecord => ({
  id: 'w1',
  botInstanceId: BOT,
  chatId: '910910',
  messageId: 42,
  kind: 'ORDER',
  step: 'CLOSED',
  version: 3,
  subjectId: 'order-1',
  paymentId: null,
  busyUntil: null,
  lastUpdateKey: null,
  updatedAt: new Date(NOW.getTime() - 60_000),
  ...over,
});

describe('when an order outcome may be edited onto its payment message (FIX-08)', () => {
  it('answers on a settled screen of the order, in the customer’s own chat', () => {
    const latest = wizard();
    expect(orderScreenReadiness(latest, destination, NOW, SETTLE)).toEqual({
      kind: 'READY',
      wizard: latest,
    });
  });

  it('waits while another writer may still be editing it — and says until when', () => {
    const touched = new Date(NOW.getTime() - 1_000);
    expect(orderScreenReadiness(wizard({ updatedAt: touched }), destination, NOW, SETTLE)).toEqual({
      kind: 'WAIT',
      until: new Date(touched.getTime() + SETTLE),
    });
    // Exactly at the edge it is settled: the window is half-open.
    const edge = new Date(NOW.getTime() - SETTLE);
    expect(orderScreenReadiness(wizard({ updatedAt: edge }), destination, NOW, SETTLE).kind).toBe(
      'READY',
    );
  });

  it('waits for a turn that holds the screen, even when it was touched long ago', () => {
    const busyUntil = new Date(NOW.getTime() + 20_000);
    expect(orderScreenReadiness(wizard({ busyUntil }), destination, NOW, SETTLE)).toEqual({
      kind: 'WAIT',
      until: busyUntil,
    });
    // An expired hold is no hold.
    const lapsed = new Date(NOW.getTime() - 1);
    expect(orderScreenReadiness(wizard({ busyUntil: lapsed }), destination, NOW, SETTLE).kind).toBe(
      'READY',
    );
  });

  it('sends as before when there is no screen, or not an order’s', () => {
    expect(orderScreenReadiness(null, destination, NOW, SETTLE)).toEqual({ kind: 'NONE' });
    expect(orderScreenReadiness(wizard({ kind: 'TOPUP' }), destination, NOW, SETTLE)).toEqual({
      kind: 'NONE',
    });
  });

  it('never answers in another chat, or through another bot', () => {
    expect(orderScreenReadiness(wizard({ chatId: '1' }), destination, NOW, SETTLE).kind).toBe(
      'NONE',
    );
    expect(
      orderScreenReadiness(wizard({ botInstanceId: OTHER_BOT }), destination, NOW, SETTLE).kind,
    ).toBe('NONE');
  });

  it('leaves the gateway worker’s screens and the receipt flow’s two messages alone', () => {
    for (const step of [
      'INVOICE_LOADING',
      'INVOICE_PENDING',
      'RECEIPT_WAIT',
      'RECEIPT_REVIEW',
    ] as const satisfies readonly TelegramWizardStep[]) {
      expect(orderScreenReadiness(wizard({ step }), destination, NOW, SETTLE).kind, step).toBe(
        'NONE',
      );
      expect(ORDER_SCREEN_ANSWER_STEPS).not.toContain(step);
    }
    for (const step of ORDER_SCREEN_ANSWER_STEPS) {
      expect(orderScreenReadiness(wizard({ step }), destination, NOW, SETTLE).kind, step).toBe(
        'READY',
      );
    }
  });

  it('settles for the messenger’s own request timeout plus a margin', () => {
    expect(orderScreenSettleMs(10_000)).toBe(10_000 + ORDER_SCREEN_SETTLE_MARGIN_MS);
    expect(orderScreenSettleMs(-5)).toBe(ORDER_SCREEN_SETTLE_MARGIN_MS);
  });
});

describe('a free location change asked from the card is answered on the card (FIX-08)', () => {
  it('is a card-answered success and failure, and only with a card', () => {
    expect(CARD_ANSWERED_OPERATIONS).toContain('CHANGE_LOCATION');
    expect(CARD_FAILURE_ANSWERED_OPERATIONS).toContain('CHANGE_LOCATION');
    expect(CARD_ANSWERED_FAILURE_TYPES).toEqual(CARD_FAILURE_ANSWERED_OPERATIONS);
    expect(successAnsweredElsewhere({ type: 'CHANGE_LOCATION', answeredOnCard: true })).toBe(true);
    // A paid move (no card recorded) is still told by the lane.
    expect(successAnsweredElsewhere({ type: 'CHANGE_LOCATION', answeredOnCard: false })).toBe(
      false,
    );
    expect(successAnsweredElsewhere({ type: 'CHANGE_LOCATION' })).toBe(false);
  });
});
