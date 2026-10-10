import { describe, expect, it } from 'vitest';
import {
  HINT_TOLERANCE_MS,
  inquiryDiscoveryTrigger,
} from '../../apps/api/src/modules/commerce/payments/domain/inquiry-discovery';

/**
 * FIX-01 evidence: the label the settlement latency line carries. It decides nothing about
 * money, but a wrong label sends whoever reads a field report after the wrong stage — a
 * "scheduled" discovery that was really a webhook hides a lost-callback problem.
 */

const t = (seconds: number) => new Date(Date.UTC(2026, 9, 10, 9, 0, 0) + seconds * 1_000);

const row = (overrides: Partial<Parameters<typeof inquiryDiscoveryTrigger>[0]> = {}) => ({
  dueAt: t(20),
  scheduledAt: t(20),
  lastInquiryAt: null,
  lastWebhookAt: null,
  operatorRequestedAt: null,
  reviewStartedAt: null,
  ...overrides,
});

describe('what brought the discovering inquiry forward', () => {
  it('is the schedule when the row fell due exactly when the schedule put it', () => {
    expect(inquiryDiscoveryTrigger(row())).toBe('SCHEDULED');
  });

  it('is the schedule when the row fell due LATER (a rate limit pushed it out)', () => {
    expect(inquiryDiscoveryTrigger(row({ dueAt: t(90) }))).toBe('SCHEDULED');
  });

  it('treats clock noise inside the tolerance as the schedule', () => {
    expect(
      inquiryDiscoveryTrigger(row({ dueAt: new Date(t(20).getTime() - HINT_TOLERANCE_MS + 1) })),
    ).toBe('SCHEDULED');
  });

  it('is a webhook when one arrived before the first inquiry', () => {
    expect(inquiryDiscoveryTrigger(row({ dueAt: t(6), lastWebhookAt: t(6) }))).toBe('WEBHOOK_HINT');
  });

  it('is a webhook when one arrived after the last inquiry, even on schedule', () => {
    expect(
      inquiryDiscoveryTrigger(
        row({ lastInquiryAt: t(20), lastWebhookAt: t(30), dueAt: t(60), scheduledAt: t(60) }),
      ),
    ).toBe('WEBHOOK_HINT');
  });

  it('is NOT a webhook when the only webhook was already answered by an inquiry', () => {
    expect(
      inquiryDiscoveryTrigger(
        row({ lastInquiryAt: t(20), lastWebhookAt: t(10), dueAt: t(60), scheduledAt: t(60) }),
      ),
    ).toBe('SCHEDULED');
  });

  it('is the customer when the row was brought forward and no review opened since', () => {
    expect(
      inquiryDiscoveryTrigger(row({ lastInquiryAt: t(20), dueAt: t(33), scheduledAt: t(60) })),
    ).toBe('CUSTOMER_HINT');
  });

  it('is the receipt acknowledgement when a review opened after the last inquiry', () => {
    expect(
      inquiryDiscoveryTrigger(
        row({ lastInquiryAt: t(20), reviewStartedAt: t(40), dueAt: t(40), scheduledAt: t(60) }),
      ),
    ).toBe('RECEIPT_ACK');
    expect(
      inquiryDiscoveryTrigger(row({ reviewStartedAt: t(5), dueAt: t(5), scheduledAt: t(20) })),
    ).toBe('RECEIPT_ACK');
  });

  it('is the customer when brought forward inside a review already asked about', () => {
    expect(
      inquiryDiscoveryTrigger(
        row({
          reviewStartedAt: t(40),
          lastInquiryAt: t(41),
          dueAt: t(101),
          scheduledAt: t(161),
        }),
      ),
    ).toBe('CUSTOMER_HINT');
  });

  it('is the operator first, whatever else is true', () => {
    expect(
      inquiryDiscoveryTrigger(row({ operatorRequestedAt: t(1), lastWebhookAt: t(2), dueAt: t(2) })),
    ).toBe('OPERATOR_RECHECK');
  });

  it('cannot call anything a hint without a schedule to compare with', () => {
    expect(inquiryDiscoveryTrigger(row({ scheduledAt: null, dueAt: t(1) }))).toBe('SCHEDULED');
    expect(inquiryDiscoveryTrigger(row({ dueAt: null }))).toBe('SCHEDULED');
  });
});
