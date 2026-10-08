import type { PaymentMethod, PaymentState } from '@nexa/contracts';
import type { WebKey } from './i18n/web.fa';
import type { Tone } from './ui/kit';

/*
 * How a payment's state and method are WORDED and COLOURED, wherever a payment is drawn
 * (review N8, PR #240): the payments pages and Customer 360's newest payments read this one
 * module, so neither can rename the other's vocabulary out from under it, and a second
 * `UNKNOWN: 'warn'` never has to be written.
 */

export const PAYMENT_STATE_LABELS: Readonly<Record<PaymentState, WebKey>> = {
  PENDING: 'web.payment_state_pending',
  CONFIRMED: 'web.payment_state_confirmed',
  FAILED: 'web.payment_state_failed',
  CANCELLED: 'web.payment_state_cancelled',
  EXPIRED: 'web.payment_state_expired',
  UNKNOWN: 'web.payment_state_unknown',
};

export const PAYMENT_STATE_TONES: Readonly<Record<PaymentState, Tone>> = {
  PENDING: 'warn',
  CONFIRMED: 'ok',
  FAILED: 'danger',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
  // Not danger and not ok: it is neither, and a tone that implied either would be
  // this page taking a position the system explicitly does not hold.
  UNKNOWN: 'warn',
};

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, WebKey>> = {
  WALLET: 'web.payment_method_wallet',
  MANUAL_TRANSFER: 'web.payment_method_manual',
  GATEWAY: 'web.payment_method_gateway',
};
