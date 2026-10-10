/**
 * FIX-01 (batch 2026-10-10): what brought forward the inquiry that DISCOVERED an approval.
 *
 * Nothing here decides anything about money. The lane logs it beside the settlement so a
 * field report of "the credit took two minutes" can be split into the four stages
 * (`docs/payment-settlement-latency.md` §7) — when the provider's approval was seen, and why
 * then. FIX-06 reads it too, for scheduling only: a row that is not `SCHEDULED` is asked
 * before the pass's creations and may use the share of the budget kept for hinted rows.
 *
 * The provider's own approval instant is not knowable (no provider here reports one this
 * installation can trust), so the first stage is measured from the invoice's creation and
 * from the moment the row fell due, never from "when the customer paid".
 *
 * Derived from the row the pass claimed, because no column records why a row is due:
 *
 * - `OPERATOR_RECHECK` — an operator's "ask again" (`reconcile_inquiry_requested_at`);
 * - `WEBHOOK_HINT` — a provider webhook arrived after the last inquiry (or before the first);
 * - `RECEIPT_ACK` — a card-transfer review opened after the last inquiry, and the row was due
 *   earlier than its schedule: the receipt acknowledgement's immediate inquiry;
 * - `CUSTOMER_HINT` — due earlier than its schedule otherwise: the customer's «بررسی وضعیت»
 *   tap or a CentralPay browser return. The API logs each of those by payment id
 *   (`gateway status check brought an inquiry forward`,
 *   `gateway browser return brought a verify forward`), which tells the two apart;
 * - `SCHEDULED` — the backoff schedule alone.
 *
 * Every hint path brings `next_inquiry_at` FORWARD only (`LEAST`), and a budget deferral of a
 * due row cannot move it later than it already is, so "due before the schedule" is a hint.
 */
export type InquiryDiscoveryTrigger =
  'OPERATOR_RECHECK' | 'WEBHOOK_HINT' | 'RECEIPT_ACK' | 'CUSTOMER_HINT' | 'SCHEDULED';

/** A due time this much earlier than the schedule's is a hint, not clock noise. */
export const HINT_TOLERANCE_MS = 1_000;

export function inquiryDiscoveryTrigger(row: {
  /** `next_inquiry_at` as the pass claimed it: when the row fell due. */
  readonly dueAt: Date | null;
  /** When the schedule ALONE would have put it, or null when there is none to compare. */
  readonly scheduledAt: Date | null;
  readonly lastInquiryAt: Date | null;
  readonly lastWebhookAt: Date | null;
  readonly operatorRequestedAt: Date | null;
  /** The start of a card-transfer provider review, or null. */
  readonly reviewStartedAt: Date | null;
}): InquiryDiscoveryTrigger {
  if (row.operatorRequestedAt !== null) return 'OPERATOR_RECHECK';
  if (
    row.lastWebhookAt !== null &&
    (row.lastInquiryAt === null || row.lastWebhookAt.getTime() > row.lastInquiryAt.getTime())
  ) {
    return 'WEBHOOK_HINT';
  }
  const early =
    row.dueAt !== null &&
    row.scheduledAt !== null &&
    row.dueAt.getTime() < row.scheduledAt.getTime() - HINT_TOLERANCE_MS;
  if (!early) return 'SCHEDULED';
  const reviewOpenedSinceLastInquiry =
    row.reviewStartedAt !== null &&
    (row.lastInquiryAt === null || row.lastInquiryAt.getTime() < row.reviewStartedAt.getTime());
  return reviewOpenedSinceLastInquiry ? 'RECEIPT_ACK' : 'CUSTOMER_HINT';
}

/**
 * Every way an approval reaches the settlement path from the gateway lane: an inquiry for one
 * of the reasons above, or Telegram's authenticated `successful_payment` settled on arrival
 * (Stars). The worker's recovery of a recorded Stars payment is `SCHEDULED`.
 */
export type GatewayDiscoveryTrigger = InquiryDiscoveryTrigger | 'STARS_UPDATE';
