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
 * - `RECEIPT_UPLOAD` — a card-transfer receipt upload ENDED after the last inquiry without
 *   opening a review (accepted but not acknowledged, or its answer lost), and the row was due
 *   early: that upload's own brought-forward inquiry;
 * - `CUSTOMER_HINT` — due earlier than its schedule otherwise: the customer's «بررسی وضعیت»
 *   tap or a CentralPay browser return. The API logs each of those by payment id
 *   (`gateway status check brought an inquiry forward`,
 *   `gateway browser return brought a verify forward`), which tells the two apart;
 * - `SCHEDULED` — the schedule alone.
 *
 * Every hint path brings `next_inquiry_at` FORWARD only (`LEAST`), and a budget deferral of a
 * due row cannot move it later than it already is. So a row is hinted when it fell due at
 * none of the times its schedule could have put it, and before the latest of them. There can
 * be two such times: after a rate-limited answer the row waits the LATER of its normal step
 * and the rate-limit floor, and a hint between the two is still a hint (Codex #265).
 */
export type InquiryDiscoveryTrigger =
  | 'OPERATOR_RECHECK'
  | 'WEBHOOK_HINT'
  | 'RECEIPT_ACK'
  | 'RECEIPT_UPLOAD'
  | 'CUSTOMER_HINT'
  | 'SCHEDULED';

/** A due time this close to a scheduled one is the schedule, not a hint: clock noise. */
export const HINT_TOLERANCE_MS = 1_000;

export function inquiryDiscoveryTrigger(row: {
  /** `next_inquiry_at` as the pass claimed it: when the row fell due. */
  readonly dueAt: Date | null;
  /**
   * Every time the schedule ALONE could have put it — its normal step and, after a
   * rate-limited answer, the rate-limit floor. Empty when there is none to compare.
   */
  readonly scheduledAt: readonly Date[];
  readonly lastInquiryAt: Date | null;
  readonly lastWebhookAt: Date | null;
  readonly operatorRequestedAt: Date | null;
  /** The start of a card-transfer provider review, or null. */
  readonly reviewStartedAt: Date | null;
  /** When the latest card-transfer receipt upload ended (accepted or lost), or null. */
  readonly receiptEndedAt?: Date | null;
}): InquiryDiscoveryTrigger {
  if (row.operatorRequestedAt !== null) return 'OPERATOR_RECHECK';
  if (row.lastWebhookAt !== null && since(row.lastWebhookAt, row.lastInquiryAt)) {
    return 'WEBHOOK_HINT';
  }
  const due = row.dueAt?.getTime() ?? null;
  const scheduled = row.scheduledAt.map((at) => at.getTime());
  const onSchedule =
    due === null ||
    scheduled.length === 0 ||
    scheduled.some((at) => Math.abs(due - at) <= HINT_TOLERANCE_MS) ||
    due >= Math.max(...scheduled) - HINT_TOLERANCE_MS;
  if (onSchedule) return 'SCHEDULED';
  if (row.reviewStartedAt !== null && since(row.reviewStartedAt, row.lastInquiryAt)) {
    return 'RECEIPT_ACK';
  }
  const receipt = row.receiptEndedAt ?? null;
  if (receipt !== null && since(receipt, row.lastInquiryAt)) return 'RECEIPT_UPLOAD';
  return 'CUSTOMER_HINT';
}

/** Whether `at` happened after the last inquiry (or there was none). */
function since(at: Date, lastInquiryAt: Date | null): boolean {
  return lastInquiryAt === null || at.getTime() > lastInquiryAt.getTime();
}

/**
 * Every way an approval reaches the settlement path from the gateway lane: an inquiry for one
 * of the reasons above, Telegram's authenticated `successful_payment` settled on arrival
 * (`STARS_UPDATE`), or the worker settling a recorded Stars payment the update's own attempt
 * did not finish (`STARS_RECOVERY`). Neither Stars trigger involved an inquiry.
 */
export type GatewayDiscoveryTrigger = InquiryDiscoveryTrigger | 'STARS_UPDATE' | 'STARS_RECOVERY';
