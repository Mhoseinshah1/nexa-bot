/**
 * R8 A3 — what a `PaymentFailed` actually was, for the headline the operations log and the
 * Web Admin notifications page show.
 *
 * `PaymentFailed.cause` has two values, and `GATEWAY_FAILED` covered a customer pressing
 * «لغو فاکتور», a gateway rejecting a receipt, an invoice running out of time and a real
 * failure alike — all printed as «پرداخت ناموفق/رد شد · درگاه پرداخت را ناموفق اعلام کرد».
 * The event is not changed (its payload is a contract, and events already in the outbox must
 * render the same way): the outcome is DERIVED from the payment row the event names. Every
 * gateway failure is resolved with the machine note `<provider>:<status or code>`
 * (`PaymentService.failGatewayPayment`, `reconcileGatewayPayment`), and that note is what is
 * read here. Pure: no clock, no database.
 */

export type CancelledBy = 'CUSTOMER' | 'NEXA' | 'PROVIDER';

export type PaymentFailureOutcome =
  | { readonly kind: 'CANCELLED'; readonly by: CancelledBy }
  | { readonly kind: 'RECEIPT_REJECTED'; readonly by: 'OPERATOR' | 'PROVIDER' }
  | { readonly kind: 'EXPIRED' }
  /** `code` is the provider's status or Nexa's machine code; null when the note had none. */
  | { readonly kind: 'FAILED'; readonly code: string | null };

/** The note `failGatewayPayment` writes when the customer's own cancel request was applied. */
export const CANCELLED_BY_CUSTOMER_STATUS = 'canceled_by_customer';
/** The note it writes when Nexa cancelled the invoice itself (a new invoice replaced it). */
export const CANCELLED_BY_NEXA_STATUS = 'canceled_by_nexa';

/** The status part of `<provider>:<status>[:…]`, or null for a note that is not one. */
export function failureStatusOf(note: string | null): string | null {
  if (note === null) return null;
  const parts = note.split(':');
  if (parts.length < 2) return null;
  const status = parts[1]?.trim() ?? '';
  return status === '' ? null : status;
}

export function paymentFailureOutcome(input: {
  readonly cause: 'REJECTED' | 'GATEWAY_FAILED';
  /** The payment's `resolution_note`. */
  readonly resolutionNote: string | null;
  /**
   * For a bare `canceled` status (the inquiry saw the cancellation before the cancel request's
   * own answer was applied): the payment's latest cancel request, if one was sent.
   */
  readonly cancelRequest?: { readonly byNexa: boolean } | null;
}): PaymentFailureOutcome {
  // An operator's rejection of a card-to-card receipt: the note is the operator's reason.
  if (input.cause === 'REJECTED') return { kind: 'RECEIPT_REJECTED', by: 'OPERATOR' };
  const status = failureStatusOf(input.resolutionNote);
  switch (status) {
    case CANCELLED_BY_CUSTOMER_STATUS:
      return { kind: 'CANCELLED', by: 'CUSTOMER' };
    case CANCELLED_BY_NEXA_STATUS:
      return { kind: 'CANCELLED', by: 'NEXA' };
    case 'canceled':
    case 'cancelled': {
      const request = input.cancelRequest ?? null;
      if (request === null) return { kind: 'CANCELLED', by: 'PROVIDER' };
      return { kind: 'CANCELLED', by: request.byNexa ? 'NEXA' : 'CUSTOMER' };
    }
    case 'expired':
      return { kind: 'EXPIRED' };
    // TonPays (both routes): the provider rejected the receipt the customer sent.
    case 'rejected':
      return { kind: 'RECEIPT_REJECTED', by: 'PROVIDER' };
    default:
      return { kind: 'FAILED', code: status };
  }
}
