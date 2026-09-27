import type {
  StarsPreCheckoutUpdate,
  StarsSuccessfulPaymentUpdate,
} from '../../modules/commerce/payments/application/telegram-stars-payment.service.js';

/**
 * Telegram's two payment updates, read at the boundary (Package A, audit §2.5–§2.6).
 *
 * Each returns null for an update that is not one, or not a WELL-FORMED one: every field
 * the service compares is read by type here, so nothing Telegram-shaped goes further in.
 * A charge id is bounded as the column is (1–255), and a payload as Telegram bounds it.
 */

const PAYLOAD_MAX = 128;

/**
 * Telegram's `total_amount`, as a whole number of Stars, or null when it is not one, so a
 * fractional, negative or unsafe figure never reaches a comparison with the snapshot.
 */
export function starsAmountOf(value: unknown): bigint | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return null;
  return BigInt(value);
}
const CHARGE_ID_MAX = 255;

function payerOf(from: unknown): string | null {
  const shaped = from as { id?: unknown; is_bot?: unknown } | null | undefined;
  if (shaped === undefined || shaped === null || shaped.is_bot === true) return null;
  const id = shaped.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  return String(id);
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length >= 1 && value.length <= max ? value : null;
}

export function starsPreCheckoutOf(update: unknown): StarsPreCheckoutUpdate | null {
  const query = (update as { pre_checkout_query?: unknown } | null)?.pre_checkout_query as
    | {
        id?: unknown;
        from?: unknown;
        currency?: unknown;
        total_amount?: unknown;
        invoice_payload?: unknown;
      }
    | undefined;
  if (query === undefined || query === null || typeof query !== 'object') return null;
  const queryId = boundedString(query.id, 256);
  const payer = payerOf(query.from);
  const currency = boundedString(query.currency, 16);
  const totalAmount = starsAmountOf(query.total_amount);
  const payload = boundedString(query.invoice_payload, PAYLOAD_MAX);
  if (queryId === null || payer === null || currency === null) return null;
  // A malformed amount or payload is still a query Telegram waits on: answered as a
  // refusal by the service, which finds no attempt for an empty payload or a zero amount.
  return {
    queryId,
    payerTelegramUserId: payer,
    currency,
    totalAmount: totalAmount ?? 0n,
    payload: payload ?? '',
  };
}

/** Whether the update carries a `successful_payment` at all, well-formed or not. */
export function hasSuccessfulPayment(update: unknown): boolean {
  const message = (update as { message?: { successful_payment?: unknown } } | null)?.message;
  return (
    message?.successful_payment !== undefined &&
    message.successful_payment !== null &&
    typeof message.successful_payment === 'object'
  );
}

export function starsSuccessfulPaymentOf(update: unknown): StarsSuccessfulPaymentUpdate | null {
  const message = (update as { message?: { from?: unknown; successful_payment?: unknown } } | null)
    ?.message;
  if (!hasSuccessfulPayment(update) || message === undefined) return null;
  const payment = message.successful_payment as {
    currency?: unknown;
    total_amount?: unknown;
    invoice_payload?: unknown;
    telegram_payment_charge_id?: unknown;
  };
  const payer = payerOf(message.from);
  const currency = boundedString(payment.currency, 16);
  const totalAmount = starsAmountOf(payment.total_amount);
  const payload = boundedString(payment.invoice_payload, PAYLOAD_MAX);
  const chargeId = boundedString(payment.telegram_payment_charge_id, CHARGE_ID_MAX);
  if (
    payer === null ||
    currency === null ||
    totalAmount === null ||
    payload === null ||
    chargeId === null
  ) {
    return null;
  }
  return { payerTelegramUserId: payer, currency, totalAmount, payload, chargeId };
}
