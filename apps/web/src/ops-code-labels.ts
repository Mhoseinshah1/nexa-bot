import type { DeliveryOutcome } from '@nexa/contracts';
import { operationalEventLabelFa } from '@nexa/i18n';
import { API_LOCAL_ERROR_TEXT, ERROR_TEXT } from './error-text';
import { t, type WebKey } from './i18n/web.fa';

/**
 * Persian names for operational-event codes (W5/W6): the alerts list, the dashboard's
 * attention list, the notification centre. The code stays the identifier — shown small and
 * left-to-right beside the name — and the event's own `message`, English for a log, is kept
 * behind «جزئیات فنی». An unknown code falls back to the code itself, never to a blank.
 *
 * The map itself is `OPERATIONAL_EVENT_LABELS_FA` in `@nexa/i18n` (Round 4 B5), shared with
 * the operations-group renderer; this file only looks a code up.
 */

/** The Persian name of an operational-event code; the raw code when it has none. */
export function opsCodeLabel(code: string): string {
  return operationalEventLabelFa(code) ?? code;
}

/** Whether a code has a Persian name (a page draws the raw code beside it only then). */
export function hasOpsCodeLabel(code: string): boolean {
  return operationalEventLabelFa(code) !== null;
}

/**
 * Codes a notification delivery attempt or a released claim carries that are not contract
 * error codes: the dispatcher's and the Telegram transport's own. `telegram.rejected.*`
 * (`telegram.rejected.403`, `….getme_shape`) is named by its prefix.
 */
export const DELIVERY_CODE_LABELS: Readonly<Record<string, WebKey>> = {
  'notification.render_failed': 'web.dlvcode_notification_render_failed',
  'notification.transport_threw': 'web.dlvcode_notification_transport_threw',
  'ops_group.not_connected': 'web.dlvcode_ops_group_not_connected',
  'ops_group.resend_deferred': 'web.dlvcode_ops_group_resend_deferred',
  'ops_group.route_failed': 'web.dlvcode_ops_group_route_failed',
  'ops_group.topic_missing': 'web.dlvcode_ops_group_topic_missing',
  'rate.window_full': 'web.dlvcode_rate_window_full',
  'sweep.withdrawn': 'web.dlvcode_sweep_withdrawn',
  'telegram.no_bot_configured': 'web.dlvcode_telegram_no_bot_configured',
  'telegram.rate_limited': 'web.dlvcode_telegram_rate_limited',
  'telegram.token_unavailable': 'web.dlvcode_telegram_token_unavailable',
  'telegram.unreachable': 'web.dlvcode_telegram_unreachable',
  'telegram.unreadable_response': 'web.dlvcode_telegram_unreadable_response',
  'tenant.not_active': 'web.dlvcode_tenant_not_active',
  'transport.mismatch': 'web.dlvcode_transport_mismatch',
};

/** Codes an incident effect or a service refund carries that no catalogue declares. */
export const EXTRA_CODE_LABELS: Readonly<Record<string, WebKey>> = {
  'incident.effect_contended': 'web.err_incident_effect_contended',
  'incident.effect_failed': 'web.err_incident_effect_failed',
  RESERVATION_RELEASED: 'web.err_refund_reservation_released',
};

/**
 * The gateway, FX-source and reconciliation codes a payment route records (gateway health,
 * payment history, the FX section): NEXA's own `nexa.*` refusals, the price sources', the
 * invoice creation states and the reconciliation audit actions.
 */
export const PROVIDER_CODE_LABELS: Readonly<Record<string, WebKey>> = {
  CREATED: 'web.provcode_created',
  CREATE_FAILED: 'web.provcode_create_failed',
  CREATE_UNKNOWN: 'web.provcode_create_unknown',
  CREATING: 'web.provcode_creating',
  'gateway_invoice.reconcile_inquiry_requested':
    'web.provcode_gateway_invoice_reconcile_inquiry_requested',
  'nexa.amount_out_of_range': 'web.provcode_nexa_amount_out_of_range',
  'nexa.attempt_closed': 'web.provcode_nexa_attempt_closed',
  'nexa.bot_token_unavailable': 'web.provcode_nexa_bot_token_unavailable',
  'nexa.budget': 'web.provcode_nexa_budget',
  'nexa.buyer_chat_id_missing': 'web.provcode_nexa_buyer_chat_id_missing',
  'nexa.chat_unknown': 'web.provcode_nexa_chat_unknown',
  'nexa.credential_missing': 'web.provcode_nexa_credential_missing',
  'nexa.deadline_passed': 'web.provcode_nexa_deadline_passed',
  'nexa.file_unavailable': 'web.provcode_nexa_file_unavailable',
  'nexa.fx.unreadable': 'web.provcode_nexa_fx_unreadable',
  'nexa.identity_mismatch': 'web.provcode_nexa_identity_mismatch',
  'nexa.identity_unavailable': 'web.provcode_nexa_identity_unavailable',
  'nexa.invoice_id_unsafe': 'web.provcode_nexa_invoice_id_unsafe',
  'nexa.migration.mirza': 'web.provcode_nexa_migration_mirza',
  'nexa.no_adapter': 'web.provcode_nexa_no_adapter',
  'nexa.no_inquiry_context': 'web.provcode_nexa_no_inquiry_context',
  'nexa.no_payment_card': 'web.provcode_nexa_no_payment_card',
  'nexa.no_payment_link': 'web.provcode_nexa_no_payment_link',
  'nexa.no_return_url': 'web.provcode_nexa_no_return_url',
  'nexa.no_source': 'web.provcode_nexa_no_source',
  'nexa.not_an_image': 'web.provcode_nexa_not_an_image',
  'nexa.not_an_order_id': 'web.provcode_nexa_not_an_order_id',
  'nexa.not_inquirable': 'web.provcode_nexa_not_inquirable',
  'nexa.nothing_recorded': 'web.provcode_nexa_nothing_recorded',
  'nexa.nothing_to_ask': 'web.provcode_nexa_nothing_to_ask',
  'nexa.order_id_mismatch': 'web.provcode_nexa_order_id_mismatch',
  'nexa.payment_link_rejected': 'web.provcode_nexa_payment_link_rejected',
  'nexa.presentation_missing': 'web.provcode_nexa_presentation_missing',
  'nexa.reader_threw': 'web.provcode_nexa_reader_threw',
  'nexa.receipt_too_large': 'web.provcode_nexa_receipt_too_large',
  'nexa.scope_inactive': 'web.provcode_nexa_scope_inactive',
  'nexa.send_interrupted': 'web.provcode_nexa_send_interrupted',
  'nobitex.no_bids': 'web.provcode_nobitex_no_bids',
  'nobitex.not_json': 'web.provcode_nobitex_not_json',
  'nobitex.unreadable': 'web.provcode_nobitex_unreadable',
  ok: 'web.provcode_ok',
  'payment.reconcile_confirmed': 'web.provcode_payment_reconcile_confirmed',
  'payment.reconcile_failed': 'web.provcode_payment_reconcile_failed',
  'tetrapay.UNAUTHORIZED': 'web.provcode_tetrapay_unauthorized',
  'tetrapay.GATEWAY_SUSPENDED': 'web.provcode_tetrapay_gateway_suspended',
  'tetrapay.NO_METHOD_AVAILABLE': 'web.provcode_tetrapay_no_method_available',
  'tetrapay.NOT_FOUND': 'web.provcode_tetrapay_not_found',
  'tetrapay.ORDER_CONFLICT': 'web.provcode_tetrapay_order_conflict',
  'tetrapay.AMOUNT_OUT_OF_RANGE': 'web.provcode_tetrapay_amount_out_of_range',
  'tetrapay.INVALID_CALLBACK': 'web.provcode_tetrapay_invalid_callback',
  'tetrapay.INVALID_WEBHOOK': 'web.provcode_tetrapay_invalid_webhook',
  'tetrapay.WEBHOOK_NOT_CONFIGURED': 'web.provcode_tetrapay_webhook_not_configured',
  'tetrapay.RATE_LIMITED': 'web.provcode_tetrapay_rate_limited',
  'tetrapay.DAILY_LIMIT_REACHED': 'web.provcode_tetrapay_daily_limit_reached',
  'tetrapay.VALIDATION': 'web.provcode_tetrapay_validation',
  'tetrapay.UNSUPPORTED_MEDIA_TYPE': 'web.provcode_tetrapay_unsupported_media_type',
  'tetrapay.BAD_JSON': 'web.provcode_tetrapay_bad_json',
  'tetrapay.INTERNAL': 'web.provcode_tetrapay_internal',
  'rialit.UNAUTHORIZED': 'web.provcode_rialit_unauthorized',
  'rialit.IP_NOT_ALLOWED': 'web.provcode_rialit_ip_not_allowed',
  'rialit.MERCHANT_INACTIVE': 'web.provcode_rialit_merchant_inactive',
  'rialit.FORBIDDEN': 'web.provcode_rialit_forbidden',
  'rialit.BAD_REQUEST': 'web.provcode_rialit_bad_request',
  'rialit.AMOUNT_OUT_OF_RANGE': 'web.provcode_rialit_amount_out_of_range',
  'rialit.INVALID_ORDER_ID': 'web.provcode_rialit_invalid_order_id',
  'rialit.INVALID_PAYER_ID': 'web.provcode_rialit_invalid_payer_id',
  'rialit.NOT_FOUND': 'web.provcode_rialit_not_found',
  'rialit.ORDER_CONFLICT': 'web.provcode_rialit_order_conflict',
  'rialit.RATE_LIMITED': 'web.provcode_rialit_rate_limited',
  'rialit.DOUBLE_FEE': 'web.provcode_rialit_double_fee',
  'rialit.PAYER_AMOUNT_MISMATCH': 'web.provcode_rialit_payer_amount_mismatch',
  'rialit.PAYER_AMOUNT_UNREADABLE': 'web.provcode_rialit_payer_amount_unreadable',
  'wallex.no_bids': 'web.provcode_wallex_no_bids',
  'wallex.no_result': 'web.provcode_wallex_no_result',
  'wallex.not_json': 'web.provcode_wallex_not_json',
  'wallex.not_success': 'web.provcode_wallex_not_success',
  'wallex.unreadable': 'web.provcode_wallex_unreadable',
};

/** A legacy import's warning or error on a map row, and a review's reason. */
export const LEGACY_REASON_LABELS: Readonly<Record<string, WebKey>> = {
  AMBIGUOUS_PANEL: 'web.legacy_reason_ambiguous_panel',
  CONFLICTING_EXISTING_ENTITY: 'web.legacy_reason_conflicting_existing_entity',
  CUSTOMER_MISSING: 'web.legacy_reason_customer_missing',
  EXISTING_CUSTOMER: 'web.legacy_reason_existing_customer',
  HISTORY_NOT_IMPORTED: 'web.legacy_reason_history_not_imported',
  INTERNAL_ERROR: 'web.legacy_reason_internal_error',
  INVALID_PHONE: 'web.legacy_reason_invalid_phone',
  INVALID_SOURCE_ROW: 'web.legacy_reason_invalid_source_row',
  INVENTORY_INCOMPLETE: 'web.legacy_reason_inventory_incomplete',
  NEGATIVE_BALANCE: 'web.legacy_reason_negative_balance',
  PANEL_UNMAPPED: 'web.legacy_reason_panel_unmapped',
  PRODUCT_MAPPING_UNRESOLVED: 'web.legacy_reason_product_mapping_unresolved',
  PROVIDER_MISSING: 'web.legacy_reason_provider_missing',
  PROVIDER_READ_FAILED: 'web.legacy_reason_provider_read_failed',
  RETRY_AFTER_FIX: 'web.legacy_reason_retry_after_fix',
  SUBSCRIPTION_REF_BLOCKED: 'web.legacy_reason_subscription_ref_blocked',
  TEST_PANEL: 'web.legacy_reason_test_panel',
  UNSUPPORTED_SHAPE: 'web.legacy_reason_unsupported_shape',
  USERNAME_CASE_COLLISION: 'web.legacy_reason_username_case_collision',
};

/**
 * A provider's (TonPays, TonPays-Telegram), a delivery's or any contract error code, by name:
 * a contract code reads with the same sentence `errorText` uses, so a code says the same on a
 * refusal and in a history row. Unknown codes fall back to the raw code.
 */
export function errorCodeLabel(code: string): string {
  const key =
    (ERROR_TEXT as Readonly<Record<string, WebKey>>)[code] ??
    (API_LOCAL_ERROR_TEXT as Readonly<Record<string, WebKey>>)[code] ??
    DELIVERY_CODE_LABELS[code] ??
    EXTRA_CODE_LABELS[code] ??
    PROVIDER_CODE_LABELS[code] ??
    LEGACY_REASON_LABELS[code];
  if (key !== undefined) return t(key);
  // TetraPay's AMOUNT_OUT_OF_RANGE carries the provider's bounds in Toman after the code.
  if (code.startsWith('tetrapay.AMOUNT_OUT_OF_RANGE:')) {
    return t('web.provcode_tetrapay_amount_out_of_range');
  }
  // Rialit's the same way: `rialit.AMOUNT_OUT_OF_RANGE:<min>:<max>`.
  if (code.startsWith('rialit.AMOUNT_OUT_OF_RANGE:')) {
    return t('web.provcode_rialit_amount_out_of_range');
  }
  const operational = operationalEventLabelFa(code);
  if (operational !== null) return operational;
  if (code.startsWith('telegram.rejected.')) return t('web.dlvcode_telegram_rejected');
  return code;
}

/** A delivery attempt's outcome, by name. */
export const DELIVERY_OUTCOME_LABELS: Readonly<Record<DeliveryOutcome, WebKey>> = {
  SUCCEEDED: 'web.dlv_outcome_succeeded',
  FAILED_RETRYABLE: 'web.dlv_outcome_failed_retryable',
  FAILED_PERMANENT: 'web.dlv_outcome_failed_permanent',
};
