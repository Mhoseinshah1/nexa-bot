import {
  CENTRALPAY_STATUSES,
  NOWPAYMENTS_STATUSES,
  TONPAYS_STATUSES,
  type CustomerNotificationKind,
  type GatewayCardChangeState,
  type GatewayProviderRequestState,
  type GatewayInvoiceCreationState,
  type GatewayInvoiceOutcome,
  type GatewayReceiptSubmissionState,
  type LedgerDirection,
  type PaymentEvidenceKind,
  type PaymentGatewayProvider,
  type PaymentMethod,
  type PaymentReceiptKind,
  type PaymentState,
} from '@nexa/contracts';
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

/** The route a payment was offered through, by name. */
export const PAYMENT_GATEWAY_LABELS: Readonly<Record<PaymentGatewayProvider, WebKey>> = {
  MANUAL_TRANSFER: 'web.payment_gateway_provider_manual_transfer',
  TONPAYS: 'web.payment_gateway_provider_tonpays',
  TONPAYS_TELEGRAM: 'web.payment_gateway_provider_tonpays_telegram',
  TELEGRAM_STARS: 'web.payment_gateway_provider_telegram_stars',
  NOWPAYMENTS: 'web.payment_gateway_provider_nowpayments',
  CENTRALPAY: 'web.payment_gateway_provider_centralpay',
  TETRAPAY: 'web.payment_gateway_provider_tetrapay',
  RIALIT: 'web.payment_gateway_provider_rialit',
};

/** The lane's machine reason for holding a gateway payment UNKNOWN (an open set). */
export const OUTCOME_UNKNOWN_REASON_LABELS: Readonly<Record<string, WebKey>> = {
  AMOUNT_MISMATCH: 'web.pay_mismatch_amount',
};

/*
 * W5: no machine key as the primary text of a payment's history or evidence. Each map names
 * a closed vocabulary in Persian; the page draws the raw key in a `title` beside it, and a
 * key no map knows is drawn raw rather than blank (`codeName`).
 */

/** What a confirmation rests on (`payments.evidence_kind`). */
export const PAYMENT_EVIDENCE_KIND_LABELS: Readonly<Record<PaymentEvidenceKind, WebKey>> = {
  OPERATOR_REVIEW: 'web.pay_evidence_operator_review',
  WALLET_DEBIT: 'web.pay_evidence_wallet_debit',
  GATEWAY_CALLBACK: 'web.pay_evidence_gateway_callback',
  RECONCILIATION: 'web.pay_evidence_reconciliation',
  GATEWAY_INQUIRY: 'web.pay_evidence_gateway_inquiry',
  LEGACY_IMPORT: 'web.pay_evidence_legacy_import',
};

export const PAYMENT_RECEIPT_KIND_LABELS: Readonly<Record<PaymentReceiptKind, WebKey>> = {
  PHOTO: 'web.pay_receipt_kind_photo',
  DOCUMENT: 'web.pay_receipt_kind_document',
};

export const LEDGER_DIRECTION_NAMES: Readonly<Record<LedgerDirection, WebKey>> = {
  CREDIT: 'web.pay_ledger_credit',
  DEBIT: 'web.pay_ledger_debit',
};

export const GATEWAY_CREATION_STATE_LABELS: Readonly<Record<GatewayInvoiceCreationState, WebKey>> =
  {
    CREATING: 'web.pay_creation_creating',
    CREATED: 'web.pay_creation_created',
    CREATE_FAILED: 'web.pay_creation_failed',
    CREATE_UNKNOWN: 'web.pay_creation_unknown',
  };

export const GATEWAY_OUTCOME_LABELS: Readonly<Record<GatewayInvoiceOutcome, WebKey>> = {
  SETTLED: 'web.pay_outcome_settled',
  ALREADY_SETTLED: 'web.pay_outcome_already_settled',
  UNSUCCESSFUL: 'web.pay_outcome_unsuccessful',
  LATE_COMPLETION: 'web.pay_outcome_late_completion',
  LATE_CREDITED: 'web.pay_outcome_late_credited',
};

export const CUSTOMER_NOTIFICATION_KIND_NAMES: Readonly<Record<CustomerNotificationKind, WebKey>> =
  {
    PAYMENT_REJECTED: 'web.pay_notice_payment_rejected',
    PAYMENT_EXPIRED: 'web.pay_notice_payment_expired',
    ORDER_EXPIRED: 'web.pay_notice_order_expired',
    SERVICE_ACTION_SUCCEEDED: 'web.pay_notice_service_action_succeeded',
    SERVICE_ACTION_FAILED: 'web.pay_notice_service_action_failed',
    SERVICE_PROVISION_DELAYED: 'web.pay_notice_service_provision_delayed',
    PAYMENT_TRANSFER_RECORDED: 'web.pay_notice_payment_transfer_recorded',
    ORDER_CANCELLED: 'web.pay_notice_order_cancelled',
    WALLET_TOPUP_CREDITED: 'web.pay_notice_wallet_topup_credited',
    ORDER_REFUNDED_TO_WALLET: 'web.pay_notice_order_refunded_to_wallet',
    SERVICE_EXPIRY_FIRST: 'web.pay_notice_service_expiry_first',
    SERVICE_EXPIRY_SECOND: 'web.pay_notice_service_expiry_second',
    SERVICE_EXPIRED: 'web.pay_notice_service_expired',
    SERVICE_USAGE_FIRST: 'web.pay_notice_service_usage_first',
    SERVICE_USAGE_SECOND: 'web.pay_notice_service_usage_second',
    SERVICE_USAGE_FINAL: 'web.pay_notice_service_usage_final',
    TRIAL_NOT_DELIVERED: 'web.pay_notice_trial_not_delivered',
    RECEIPT_CREDITED_TO_WALLET: 'web.pay_notice_receipt_credited_to_wallet',
    WALLET_TOPUP_GIFT_CREDITED: 'web.pay_notice_wallet_topup_gift_credited',
    GATEWAY_LATE_PAYMENT_CREDITED: 'web.pay_notice_gateway_late_payment_credited',
    REFUND_COMPLETED: 'web.pay_notice_refund_completed',
    GATEWAY_PAYMENT_FAILED: 'web.pay_notice_gateway_payment_failed',
    SERVICE_REFUND_REQUEST_REGISTERED: 'web.pay_notice_service_refund_request_registered',
    SERVICE_REFUND_REQUEST_APPROVED: 'web.pay_notice_service_refund_request_approved',
    SERVICE_REFUND_REQUEST_REJECTED: 'web.pay_notice_service_refund_request_rejected',
    SERVICE_TRANSFER_RECEIVED: 'web.pay_notice_service_transfer_received',
    TICKET_REPLY: 'web.pay_notice_ticket_reply',
    SERVICE_EXPIRY_EARLY: 'web.pay_notice_service_expiry_early',
    SERVICE_EXPIRY_DAY: 'web.pay_notice_service_expiry_day',
    WALLET_LOW_BALANCE: 'web.pay_notice_wallet_low_balance',
    PAYMENT_PENDING_REMINDER: 'web.pay_notice_payment_pending_reminder',
    ORDER_PENDING_REMINDER: 'web.pay_notice_order_pending_reminder',
    TICKET_REPLY_ATTACHMENT: 'web.pay_notice_ticket_reply_attachment',
    SERVICE_RENEWED: 'web.pay_notice_service_renewed',
    RESELLER_MINIMUM_REMINDER: 'web.pay_notice_reseller_minimum_reminder',
    RESELLER_MINIMUM_ACHIEVED: 'web.pay_notice_reseller_minimum_achieved',
    WALLET_MASS_CREDITED: 'web.pay_notice_wallet_mass_credited',
    SERVICE_GIFT_APPLIED: 'web.pay_notice_service_gift_applied',
    DIRECT_MESSAGE: 'web.pay_notice_direct_message',
    DIRECT_MESSAGE_MEDIA: 'web.pay_notice_direct_message_media',
    INCIDENT_NOTICE: 'web.pay_notice_incident_notice',
    WALLET_ADMIN_CREDITED: 'web.pay_notice_wallet_admin_credited',
    WALLET_ADMIN_DEBITED: 'web.pay_notice_wallet_admin_debited',
    ACCOUNT_UNBLOCKED: 'web.pay_notice_account_unblocked',
    SERVICE_TRAFFIC_ADDED: 'web.pay_notice_service_traffic_added',
    SERVICE_TIME_ADDED: 'web.pay_notice_service_time_added',
    SERVICE_AUTO_RENEW_FUNDS_SHORT: 'web.pay_notice_service_auto_renew_funds_short',
    SERVICE_AUTO_RENEW_PRICE_CHANGED: 'web.pay_notice_service_auto_renew_price_changed',
  };

/**
 * A provider's own status word, as its inquiry recorded it (TonPays, NOWPayments,
 * CentralPay). An open set on the wire — a provider may add a word — so it is a lookup with a
 * raw fallback, and the test pins every word the contracts name.
 */
export const PROVIDER_STATUS_LABELS: Readonly<Record<string, WebKey>> = {
  pending: 'web.pay_provider_pending',
  processing: 'web.pay_provider_processing',
  completed: 'web.pay_provider_completed',
  need_action: 'web.pay_provider_need_action',
  action_required_less: 'web.pay_provider_action_required_less',
  action_required_more: 'web.pay_provider_action_required_more',
  rejected: 'web.pay_provider_rejected',
  expired: 'web.pay_provider_expired',
  canceled: 'web.pay_provider_canceled',
  waiting: 'web.pay_provider_waiting',
  confirming: 'web.pay_provider_confirming',
  confirmed: 'web.pay_provider_confirmed',
  sending: 'web.pay_provider_sending',
  partially_paid: 'web.pay_provider_partially_paid',
  finished: 'web.pay_provider_finished',
  failed: 'web.pay_provider_failed',
  refunded: 'web.pay_provider_refunded',
  verified: 'web.pay_provider_verified',
  unverified: 'web.pay_provider_unverified',
};

/** A card-transfer route's card-change request, by state (TonPays Telegram §7.3). */
export const GATEWAY_CARD_CHANGE_STATE_LABELS: Readonly<Record<GatewayCardChangeState, WebKey>> = {
  REQUESTED: 'web.gw_card_change_requested',
  SENT: 'web.gw_card_change_sent',
  APPLIED: 'web.gw_card_change_applied',
  REFUSED: 'web.gw_card_change_refused',
  RATE_LIMITED: 'web.gw_card_change_rate_limited',
  UNKNOWN: 'web.gw_card_change_unknown',
};

/** R9 C1: a cancel or refund-card request sent to the provider, by state (audit §19). */
export const GATEWAY_PROVIDER_REQUEST_STATE_LABELS: Readonly<
  Record<GatewayProviderRequestState, WebKey>
> = {
  REQUESTED: 'web.gw_request_requested',
  SENT: 'web.gw_request_sent',
  APPLIED: 'web.gw_request_applied',
  REFUSED: 'web.gw_request_refused',
  RATE_LIMITED: 'web.gw_request_rate_limited',
  UNKNOWN: 'web.gw_request_unknown',
};

/** A receipt the customer sent the provider, by state (TonPays Telegram §7.5). */
export const GATEWAY_RECEIPT_SUBMISSION_STATE_LABELS: Readonly<
  Record<GatewayReceiptSubmissionState, WebKey>
> = {
  QUEUED: 'web.gw_receipt_queued',
  SENDING: 'web.gw_receipt_sending',
  ACCEPTED: 'web.gw_receipt_accepted',
  REFUSED: 'web.gw_receipt_refused',
  UNKNOWN: 'web.gw_receipt_unknown',
  ABANDONED: 'web.gw_receipt_abandoned',
};

/** Every provider status word the contracts define (the test checks each has a name). */
export const KNOWN_PROVIDER_STATUSES: readonly string[] = [
  ...TONPAYS_STATUSES,
  ...NOWPAYMENTS_STATUSES,
  ...CENTRALPAY_STATUSES,
];

/** "money arrived / not arrived": the provider's `paid` flag, in words. */
export function providerPaidKey(paid: boolean): WebKey {
  return paid ? 'web.pay_provider_paid_yes' : 'web.pay_provider_paid_no';
}

/**
 * The Persian name of a machine key from one of the maps above, or `null` when no map
 * knows it — the caller then draws the raw key, never nothing.
 */
export function codeNameKey(
  labels: Readonly<Record<string, WebKey>>,
  value: string,
): WebKey | null {
  return Object.prototype.hasOwnProperty.call(labels, value) ? (labels[value] ?? null) : null;
}
