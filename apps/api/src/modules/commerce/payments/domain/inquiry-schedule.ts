import type { PaymentGatewayProvider } from '@nexa/contracts';
import { FIRST_INQUIRY_DELAY_MS, inquiryBackoffMs } from './tonpays.js';

/**
 * FIX-06 (batch 2026-10-10): WHEN the lane asks each provider about an open attempt, per
 * provider, instead of one TonPays schedule for every provider.
 *
 * This decides when a question is asked and nothing else. Only the inquiry's answer decides
 * money (`completed` AND `paid === true`, read from the provider's own check), a hint only
 * brings a question forward, the deadline is judged under the payment's lock, and the tenant's
 * per-minute budget — unchanged here — bounds how many questions leave in any minute, whatever
 * this schedule asks for. A faster schedule therefore spends the SAME budget on fresher rows; it
 * cannot raise the outbound rate.
 *
 * Two shapes:
 *
 * - `BANDS` — by the INVOICE'S AGE: frequent while a customer who has just paid is most likely
 *   waiting, then decaying to a cap. Used where the provider's limit is documented.
 * - `BACKOFF` — the original `inquiryBackoffMs` by attempt count (20 s, then 40, 80, 160, 300 s).
 *   Kept, only jittered, wherever no documented limit justifies asking more often.
 *
 * Every scheduled step carries a deterministic ±10 % jitter (`jitteredMs`) so invoices created
 * in the same second do not ask in the same pass for ever. Deterministic — a hash of the
 * payment and the step — so the step can be recomputed from the row (the FIX-01 evidence line
 * does) and a test can name it.
 */
export type InquirySchedule =
  | { readonly kind: 'BACKOFF'; readonly firstDelayMs: number }
  | {
      readonly kind: 'BANDS';
      readonly firstDelayMs: number;
      /** By age since the invoice was created; the first band whose `untilMs` exceeds it. */
      readonly bands: readonly { readonly untilMs: number; readonly intervalMs: number }[];
      readonly capMs: number;
    };

/** The original schedule: the one every provider used before FIX-06. */
export const BACKOFF_SCHEDULE: InquirySchedule = {
  kind: 'BACKOFF',
  firstDelayMs: FIRST_INQUIRY_DELAY_MS,
};

/**
 * TonPays (website). Its documentation states 60 create/inquiry requests a minute
 * (`TONPAYS_DOCUMENTED_REQUESTS_PER_MINUTE`); Nexa's budget is 50 calls, 40 of them inquiries,
 * per tenant across replicas, and FIX-06 reserves a quarter of those for hinted rows
 * (`hintReservePerMinute`), so scheduled inquiries take at most 30 a minute.
 *
 * Every 10 s for the first two minutes (12 asks), 30 s to five minutes (6), 60 s to fifteen
 * (10), 120 s to thirty (7.5), then the old 300 s cap: about 44 asks over a 70-minute attempt,
 * about 6 a minute (7 at the jitter's edge) for one fresh invoice — so five invoices created
 * in the same minute are asked at about the full rate inside the scheduled share, and the
 * rest wait a budget deferral
 * (5 s), never a burst. The worst case without a webhook falls from 20/40/80/160/300 s to
 * 10/30/60/120/300 s (plus a 3 s pass and the jitter).
 */
export const TONPAYS_INQUIRY_SCHEDULE: InquirySchedule = {
  kind: 'BANDS',
  firstDelayMs: 10_000,
  bands: [
    { untilMs: 120_000, intervalMs: 10_000 },
    { untilMs: 300_000, intervalMs: 30_000 },
    { untilMs: 900_000, intervalMs: 60_000 },
    { untilMs: 1_800_000, intervalMs: 120_000 },
  ],
  capMs: 300_000,
};

/**
 * Per provider. TONPAYS_TELEGRAM before a receipt keeps the original schedule (its limit is
 * undocumented, OQ-TPTG-10; its review cadence — where an approval actually happens — is the
 * contract's `TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE`). NOWPAYMENTS keeps it (unpublished
 * limit OQ-NP-04; chain confirmations take minutes and its verified IPN is the fast path).
 * CENTRALPAY keeps it (undocumented limit OQ-CP-05; the browser return, routed since batch
 * 2026-10-10, is the fast path). TELEGRAM_STARS is never asked; a recorded charge is retried on
 * this schedule only if its settlement did not commit.
 */
export function inquiryScheduleFor(provider: PaymentGatewayProvider): InquirySchedule {
  return provider === 'TONPAYS' ? TONPAYS_INQUIRY_SCHEDULE : BACKOFF_SCHEDULE;
}

/** ±10 %: wide enough to spread a burst, narrow enough that every bound above still holds. */
export const INQUIRY_JITTER_RATIO = 0.1;

/**
 * `ms` moved by a deterministic fraction in [-10 %, +10 %) of itself, from a 32-bit FNV-1a hash
 * of the payment id and the step. Same inputs, same answer, on every replica.
 */
export function jitteredMs(ms: number, paymentId: string, step: number): number {
  let hash = 0x811c9dc5;
  const text = `${paymentId}:${String(step)}`;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const unit = hash / 0x1_0000_0000; // [0, 1)
  return Math.round(ms * (1 + INQUIRY_JITTER_RATIO * (2 * unit - 1)));
}

/** The first inquiry after the invoice was created, jittered. */
export function firstInquiryAt(
  schedule: InquirySchedule,
  createdAt: Date,
  paymentId: string,
): Date {
  return new Date(createdAt.getTime() + jitteredMs(schedule.firstDelayMs, paymentId, 0));
}

/**
 * The next scheduled inquiry after one answered at `at`, the `attempt`-th (1-based), before any
 * deadline clamp — the caller keeps the "one last question fifteen seconds before the deadline"
 * rule. `invoiceCreatedAt` is the age origin for a `BANDS` schedule; without one, its first band.
 */
export function nextScheduledInquiryAt(
  schedule: InquirySchedule,
  input: {
    readonly at: Date;
    readonly attempt: number;
    readonly invoiceCreatedAt: Date | null;
    readonly paymentId: string;
  },
): Date {
  const step =
    schedule.kind === 'BACKOFF'
      ? inquiryBackoffMs(input.attempt)
      : bandInterval(
          schedule,
          input.invoiceCreatedAt === null
            ? 0
            : input.at.getTime() - input.invoiceCreatedAt.getTime(),
        );
  return new Date(input.at.getTime() + jitteredMs(step, input.paymentId, input.attempt));
}

function bandInterval(
  schedule: Extract<InquirySchedule, { kind: 'BANDS' }>,
  ageMs: number,
): number {
  return schedule.bands.find((band) => ageMs < band.untilMs)?.intervalMs ?? schedule.capMs;
}

/**
 * The share of a provider's per-minute INQUIRY budget that scheduled inquiries may not take:
 * kept for a row a webhook, a customer's tap, a browser return, a receipt acknowledgement or an
 * operator brought forward — the rows a waiting customer is behind. A quarter, at least one.
 * The total is the provider's own budget, unchanged; this only decides who may use its top.
 */
export function hintReservePerMinute(inquiryBudgetPerMinute: number): number {
  return Math.max(1, Math.floor(inquiryBudgetPerMinute / 4));
}
