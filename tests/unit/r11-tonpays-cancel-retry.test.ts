import { describe, expect, it } from 'vitest';
import type { GatewayProviderRequestState } from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  CANCEL_RETRY_BACKOFF_SECONDS,
  cancelAvailable,
  cancelRetryNotBefore,
  cancelTapRefusal,
  decideCardChange,
} from '../../apps/api/src/modules/commerce/payments/domain/tonpays-telegram';

/**
 * Round 11 A8 (owner bug): a TonPays Telegram cancel whose answer was lost (a timeout, a 5xx, a
 * bare 429) left the invoice WITHOUT «❌ لغو فاکتور», so the customer could not ask again. The
 * owner's rule: a lost cancel answer does not count as cancelled; while the invoice is open as
 * far as Nexa knows the button stays and a NEW request is allowed, spaced from the lost one; a
 * tap once Nexa knows it WAS cancelled answers «فاکتور قبلاً لغو شده»; a paid invoice is never
 * cancelled. The pure rules, here; the lane, the bot and the database in
 * `tests/integration/tonpays-telegram-round6.test.ts` (R11 A8 cases).
 */

const AT = new Date('2026-10-27T10:00:00Z');
const created = {
  providerInvoiceId: 'TP-1',
  creationState: 'CREATED' as const,
  providerStatus: 'pending' as string | null,
};
const request = (state: GatewayProviderRequestState) => ({ state });

describe('R11 A8: a cancel whose answer was lost may be asked again', () => {
  it('UNKNOWN and RATE_LIMITED leave «❌ لغو فاکتور» available on a pending invoice', () => {
    expect(cancelAvailable(created, request('UNKNOWN'), [])).toBe(true);
    expect(cancelAvailable(created, request('RATE_LIMITED'), [])).toBe(true);
    expect(cancelAvailable({ ...created, providerStatus: null }, request('UNKNOWN'), [])).toBe(
      true,
    );
  });

  it('never while one is in flight, once one was applied, or on an invoice reported paid or no longer pending', () => {
    expect(cancelAvailable(created, request('REQUESTED'), [])).toBe(false);
    expect(cancelAvailable(created, request('SENT'), [])).toBe(false);
    expect(cancelAvailable(created, request('APPLIED'), [])).toBe(false);
    // Paid is never cancelled, whatever the status field says.
    expect(cancelAvailable({ ...created, providerPaid: true }, request('UNKNOWN'), [])).toBe(false);
    expect(cancelAvailable({ ...created, providerPaid: true }, null, [])).toBe(false);
    for (const status of ['canceled', 'completed', 'processing', 'action_required_less']) {
      expect(
        cancelAvailable({ ...created, providerStatus: status }, request('UNKNOWN'), []),
        status,
      ).toBe(false);
    }
    // A receipt on its way still wins over a retry.
    expect(
      cancelAvailable(created, request('UNKNOWN'), [{ state: 'SENDING', inquiryResolvedAt: null }]),
    ).toBe(false);
  });

  it('a retry is spaced from the lost or rate-limited cancel it follows, and only from those', () => {
    const decidedAt = new Date(AT.getTime() - 10_000);
    const lost = { state: 'UNKNOWN' as const, decidedAt, requestedAt: decidedAt };
    const due = new Date(decidedAt.getTime() + CANCEL_RETRY_BACKOFF_SECONDS * 1000);
    expect(cancelRetryNotBefore(lost, AT)).toEqual(due);
    expect(cancelRetryNotBefore({ ...lost, state: 'RATE_LIMITED' }, AT)).toEqual(due);
    // Once the spacing has passed, the worker may send it at once.
    expect(cancelRetryNotBefore(lost, due)).toBeNull();
    expect(cancelRetryNotBefore(lost, new Date(due.getTime() + 1))).toBeNull();
    // A first cancel, or one after a refusal, is not held back.
    expect(cancelRetryNotBefore(null, AT)).toBeNull();
    expect(cancelRetryNotBefore({ ...lost, state: 'REFUSED' }, AT)).toBeNull();
    // A row with no decision time is spaced from its request.
    expect(cancelRetryNotBefore({ ...lost, decidedAt: null }, AT)).toEqual(due);
  });

  it('a refused tap: PAID for a confirmed payment or a paid invoice, ALREADY_CANCELLED only for what Nexa KNOWS was cancelled', () => {
    const pending = { state: 'PENDING', resolutionNote: null };
    const open = { providerStatus: 'pending' as string | null };
    expect(cancelTapRefusal({ ...pending, state: 'CONFIRMED' }, open, null)).toBe('PAID');
    expect(cancelTapRefusal(pending, { ...open, providerPaid: true }, null)).toBe('PAID');
    // Paid wins over any cancel record.
    expect(cancelTapRefusal({ ...pending, state: 'CONFIRMED' }, open, request('APPLIED'))).toBe(
      'PAID',
    );

    expect(cancelTapRefusal(pending, open, request('APPLIED'))).toBe('ALREADY_CANCELLED');
    expect(cancelTapRefusal(pending, { providerStatus: 'canceled' }, null)).toBe(
      'ALREADY_CANCELLED',
    );
    for (const note of [
      'tonpays_telegram:canceled_by_customer',
      'tonpays_telegram:canceled_by_nexa',
      'tonpays_telegram:canceled',
    ]) {
      expect(
        cancelTapRefusal({ state: 'FAILED', resolutionNote: note }, open, request('REFUSED')),
        note,
      ).toBe('ALREADY_CANCELLED');
    }

    // A LOST answer is not knowledge: the invoice is not cancelled as far as Nexa knows.
    expect(cancelTapRefusal(pending, open, request('UNKNOWN'))).toBeNull();
    expect(cancelTapRefusal(pending, open, request('RATE_LIMITED'))).toBeNull();
    // Failed for another reason, or expired: not a cancellation.
    expect(
      cancelTapRefusal(
        { state: 'FAILED', resolutionNote: 'tonpays_telegram:rejected' },
        open,
        null,
      ),
    ).toBeNull();
    expect(cancelTapRefusal({ state: 'EXPIRED', resolutionNote: null }, open, null)).toBeNull();
  });

  it('a card change whose answer was lost stays offered (after its cooldown), independent of a lost cancel', () => {
    const invoice = {
      creationState: 'CREATED' as const,
      providerStatus: 'pending',
      cardChangeShown: true,
      cardChangeExhausted: false,
      cardChangeCooldownUntil: null,
      cardReceivedAt: new Date(AT.getTime() - 600_000),
    };
    const lost = {
      state: 'UNKNOWN' as const,
      requestedAt: new Date(AT.getTime() - 5_000),
      decidedAt: new Date(AT.getTime() - 5_000),
    };
    expect(decideCardChange(invoice, lost, AT).kind).toBe('COOLDOWN');
    expect(decideCardChange(invoice, lost, new Date(AT.getTime() + 60_000)).kind).toBe('AVAILABLE');
  });

  it('the new sentence is Persian, names the cancellation and keeps the tracking code', () => {
    const text = CATALOGUE_FA['bot.payment.gateway_cancel_already_cancelled'];
    expect(text).toContain('فاکتور قبلاً لغو شده');
    expect(text).toContain('{reference}');
  });
});
