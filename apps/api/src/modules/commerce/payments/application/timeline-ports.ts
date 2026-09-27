import type { PaymentId, TenantContext } from '@nexa/contracts';
import type { PaymentTimelineFacts } from '../domain/payment-timeline.js';

/** Which permission-gated sections the reader should fetch. Unfetched is empty. */
export interface TimelineSectionsIncluded {
  readonly receipts: boolean;
  readonly refunds: boolean;
  readonly wallet: boolean;
}

/**
 * The facts of one payment's history, read-only (WP17).
 *
 * The reader fetches a section only when asked. The service decides what to ask for from
 * the viewer's permissions, so a section the viewer may not see is never read, never
 * mind returned. Null when the payment is not this tenant's.
 *
 * Each source is read oldest first and bounded by `limit`. That is enough for the
 * assembler to decide truncation: any source that hit the bound already makes the total
 * exceed it.
 */
export interface PaymentTimelineReader {
  facts(
    scope: TenantContext,
    paymentId: PaymentId,
    include: TimelineSectionsIncluded,
    limit: number,
  ): Promise<PaymentTimelineFacts | null>;
}
