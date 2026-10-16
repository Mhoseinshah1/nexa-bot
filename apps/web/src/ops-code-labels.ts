import type { DeliveryOutcome } from '@nexa/contracts';
import { ERROR_TEXT } from './error-text';
import { t, type WebKey } from './i18n/web.fa';

/**
 * Persian names for operational-event codes (W5/W6): the alerts list, the dashboard's
 * attention list, the notification centre. The code stays the identifier — shown small and
 * left-to-right beside the name — and the event's own `message`, English for a log, is kept
 * behind «جزئیات فنی». An unknown code falls back to the code itself, never to a blank.
 */
export const OPS_CODE_LABELS: Readonly<Record<string, WebKey>> = {
  'access.permission_denied': 'web.opscode_access_permission_denied',
  'admin.backup_codes_regenerated': 'web.opscode_admin_backup_codes_regenerated',
  'admin.created': 'web.opscode_admin_created',
  'admin.password_changed': 'web.opscode_admin_password_changed',
  'admin.password_reset': 'web.opscode_admin_password_reset',
  'admin.role_created': 'web.opscode_admin_role_created',
  'admin.role_deleted': 'web.opscode_admin_role_deleted',
  'admin.role_updated': 'web.opscode_admin_role_updated',
  'admin.roles_changed': 'web.opscode_admin_roles_changed',
  'admin.second_factor_disabled': 'web.opscode_admin_second_factor_disabled',
  'admin.second_factor_enabled': 'web.opscode_admin_second_factor_enabled',
  'admin.second_factor_reset': 'web.opscode_admin_second_factor_reset',
  'admin.sessions_revoked': 'web.opscode_admin_sessions_revoked',
  'admin.status_changed': 'web.opscode_admin_status_changed',
  'antispam.customer_blocked': 'web.opscode_antispam_customer_blocked',
  'antispam.recovered': 'web.opscode_antispam_recovered',
  'antispam.unavailable': 'web.opscode_antispam_unavailable',
  'auth.login_locked_out': 'web.opscode_auth_login_locked_out',
  'backup.cleanup_failed': 'web.opscode_backup_cleanup_failed',
  'backup.cleanup_ok': 'web.opscode_backup_cleanup_ok',
  'backup.delivery_failed': 'web.opscode_backup_delivery_failed',
  'backup.delivery_ok': 'web.opscode_backup_delivery_ok',
  'backup.disk_threshold_exceeded': 'web.opscode_backup_disk_threshold_exceeded',
  'backup.disk_threshold_ok': 'web.opscode_backup_disk_threshold_ok',
  'backup.interval_exceeded': 'web.opscode_backup_interval_exceeded',
  'backup.interval_ok': 'web.opscode_backup_interval_ok',
  'backup.run_failed': 'web.opscode_backup_run_failed',
  'backup.run_ok': 'web.opscode_backup_run_ok',
  'bot.command_sync_failing': 'web.opscode_bot_command_sync_failing',
  'bot.command_sync_recovered': 'web.opscode_bot_command_sync_recovered',
  'bot.token_replacement_completed': 'web.opscode_bot_token_replacement_completed',
  'bot.token_replacement_incomplete': 'web.opscode_bot_token_replacement_incomplete',
  'bot_menu.published_readable': 'web.opscode_bot_menu_published_readable',
  'bot_menu.published_unreadable': 'web.opscode_bot_menu_published_unreadable',
  'centralpay.not_success': 'web.opscode_centralpay_not_success',
  'channels.membership_recovered': 'web.opscode_channels_membership_recovered',
  'channels.membership_unavailable': 'web.opscode_channels_membership_unavailable',
  'fx.fallback_in_use': 'web.opscode_fx_fallback_in_use',
  'fx.quote_rejected': 'web.opscode_fx_quote_rejected',
  'fx.quote_unavailable': 'web.opscode_fx_quote_unavailable',
  'fx.source_unavailable': 'web.opscode_fx_source_unavailable',
  'fx.stale_quote_used': 'web.opscode_fx_stale_quote_used',
  'http.error': 'web.opscode_http_error',
  'internal.unhandled': 'web.opscode_internal_unhandled',
  'job.loop_recovered': 'web.opscode_job_loop_recovered',
  'job.loop_stalled': 'web.opscode_job_loop_stalled',
  'job.superseded': 'web.opscode_job_superseded',
  'nexa.invoice_id_unsafe': 'web.opscode_nexa_invoice_id_unsafe',
  'nexa.no_payment_card': 'web.opscode_nexa_no_payment_card',
  'nexa.no_payment_link': 'web.opscode_nexa_no_payment_link',
  'nexa.payment_link_rejected': 'web.opscode_nexa_payment_link_rejected',
  'nexa.receipt_too_large': 'web.opscode_nexa_receipt_too_large',
  'notification.attempts_exhausted': 'web.opscode_notification_attempts_exhausted',
  'notification.sweep_withdrawn': 'web.opscode_notification_sweep_withdrawn',
  'ops_group.topic_recreated': 'web.opscode_ops_group_topic_recreated',
  'order.refunded_undeliverable': 'web.opscode_order_refunded_undeliverable',
  'outbox.message_exhausted': 'web.opscode_outbox_message_exhausted',
  'panel.capacity.full': 'web.opscode_panel_capacity_full',
  'panel.capacity.recovered': 'web.opscode_panel_capacity_recovered',
  'panel.capacity.warning': 'web.opscode_panel_capacity_warning',
  'panel.health.auth_failed': 'web.opscode_panel_health_auth_failed',
  'panel.health.auth_interaction_required': 'web.opscode_panel_health_auth_interaction_required',
  'panel.health.degraded': 'web.opscode_panel_health_degraded',
  'panel.health.malformed_response': 'web.opscode_panel_health_malformed_response',
  'panel.health.provider_error': 'web.opscode_panel_health_provider_error',
  'panel.health.provider_refused': 'web.opscode_panel_health_provider_refused',
  'panel.health.rate_limited': 'web.opscode_panel_health_rate_limited',
  'panel.health.recovered': 'web.opscode_panel_health_recovered',
  'panel.health.restored': 'web.opscode_panel_health_restored',
  'panel.health.retired': 'web.opscode_panel_health_retired',
  'panel.health.target_blocked': 'web.opscode_panel_health_target_blocked',
  'panel.health.tls_failed': 'web.opscode_panel_health_tls_failed',
  'panel.health.unreachable': 'web.opscode_panel_health_unreachable',
  'panel.health.unsupported_capability': 'web.opscode_panel_health_unsupported_capability',
  'panel.monitor.tenant_budget_exceeded': 'web.opscode_panel_monitor_tenant_budget_exceeded',
  'panel.monitor.tenant_budget_ok': 'web.opscode_panel_monitor_tenant_budget_ok',
  'panel.probe.limited': 'web.opscode_panel_probe_limited',
  'panel.probe.ok': 'web.opscode_panel_probe_ok',
  'payments.gateway_card_change_unknown': 'web.opscode_payments_gateway_card_change_unknown',
  'payments.gateway_charge_unmatched': 'web.opscode_payments_gateway_charge_unmatched',
  'payments.gateway_configured': 'web.opscode_payments_gateway_configured',
  'payments.gateway_create_unknown': 'web.opscode_payments_gateway_create_unknown',
  'payments.gateway_identity_mismatch': 'web.opscode_payments_gateway_identity_mismatch',
  'payments.gateway_inquiry_failing': 'web.opscode_payments_gateway_inquiry_failing',
  'payments.gateway_inquiry_ok': 'web.opscode_payments_gateway_inquiry_ok',
  'payments.gateway_late_completion': 'web.opscode_payments_gateway_late_completion',
  'payments.gateway_link_create_failed': 'web.opscode_payments_gateway_link_create_failed',
  'payments.gateway_misconfigured': 'web.opscode_payments_gateway_misconfigured',
  'payments.gateway_receipt_unknown': 'web.opscode_payments_gateway_receipt_unknown',
  'payments.gateway_review_reconciled': 'web.opscode_payments_gateway_review_reconciled',
  'payments.gateway_review_unresolved': 'web.opscode_payments_gateway_review_unresolved',
  'payments.gateway_row_failing': 'web.opscode_payments_gateway_row_failing',
  'payments.gateway_row_recovered': 'web.opscode_payments_gateway_row_recovered',
  'payments.gateway_settlement_decided': 'web.opscode_payments_gateway_settlement_decided',
  'payments.gateway_settlement_failed': 'web.opscode_payments_gateway_settlement_failed',
  'payments.gateway_webhook_unverified': 'web.opscode_payments_gateway_webhook_unverified',
  'payments.gateway_webhook_verified': 'web.opscode_payments_gateway_webhook_verified',
  'payments.receipt_push_failed': 'web.opscode_payments_receipt_push_failed',
  'payments.receipt_push_ok': 'web.opscode_payments_receipt_push_ok',
  'payments.refund_request_push_failed': 'web.opscode_payments_refund_request_push_failed',
  'payments.refund_request_push_ok': 'web.opscode_payments_refund_request_push_ok',
  'provisioning.delivered': 'web.opscode_provisioning_delivered',
  'provisioning.stalled': 'web.opscode_provisioning_stalled',
  'recovery.run_failed': 'web.opscode_recovery_run_failed',
  'recovery.run_ok': 'web.opscode_recovery_run_ok',
  'request.invalid': 'web.opscode_request_invalid',
  'settings.stored_value_invalid': 'web.opscode_settings_stored_value_invalid',
  'settings.stored_value_valid': 'web.opscode_settings_stored_value_valid',
  'support.ai_provider.available': 'web.opscode_support_ai_provider_available',
  'support.ai_provider.credential_accepted': 'web.opscode_support_ai_provider_credential_accepted',
  'support.ai_provider.credential_rejected': 'web.opscode_support_ai_provider_credential_rejected',
  'support.ai_provider.unavailable': 'web.opscode_support_ai_provider_unavailable',
  'support.assistant.running': 'web.opscode_support_assistant_running',
  'support.assistant.stalled': 'web.opscode_support_assistant_stalled',
  'support.business_connection.unusable': 'web.opscode_support_business_connection_unusable',
  'support.business_connection.usable': 'web.opscode_support_business_connection_usable',
  'support.business_update_failed': 'web.opscode_support_business_update_failed',
  'support.handoff_required': 'web.opscode_support_handoff_required',
  'support.handoff_resolved': 'web.opscode_support_handoff_resolved',
  'system.ping': 'web.opscode_system_ping',
  'telegram.appearance_decoration_failed': 'web.opscode_telegram_appearance_decoration_failed',
  'telegram.appearance_decoration_ok': 'web.opscode_telegram_appearance_decoration_ok',
  'telegram.customer_send_failed': 'web.opscode_telegram_customer_send_failed',
  'telegram.customer_send_ok': 'web.opscode_telegram_customer_send_ok',
  'telegram.message_retention_failing': 'web.opscode_telegram_message_retention_failing',
  'telegram.message_retention_recovered': 'web.opscode_telegram_message_retention_recovered',
  'telegram.ops_group_update_failed': 'web.opscode_telegram_ops_group_update_failed',
  'telegram.turn_failed': 'web.opscode_telegram_turn_failed',
  'zai.vision_unsupported': 'web.opscode_zai_vision_unsupported',
};

/** The Persian name of an operational-event code; the raw code when it has none. */
export function opsCodeLabel(code: string): string {
  const key = OPS_CODE_LABELS[code];
  return key === undefined ? code : t(key);
}

/** Whether a code has a Persian name (a page draws the raw code beside it only then). */
export function hasOpsCodeLabel(code: string): boolean {
  return OPS_CODE_LABELS[code] !== undefined;
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

/**
 * A provider's (TonPays, TonPays-Telegram), a delivery's or any contract error code, by name:
 * a contract code reads with the same sentence `errorText` uses, so a code says the same on a
 * refusal and in a history row. Unknown codes fall back to the raw code.
 */
export function errorCodeLabel(code: string): string {
  const key =
    (ERROR_TEXT as Readonly<Record<string, WebKey>>)[code] ??
    DELIVERY_CODE_LABELS[code] ??
    OPS_CODE_LABELS[code];
  if (key !== undefined) return t(key);
  if (code.startsWith('telegram.rejected.')) return t('web.dlvcode_telegram_rejected');
  return code;
}

/** A delivery attempt's outcome, by name. */
export const DELIVERY_OUTCOME_LABELS: Readonly<Record<DeliveryOutcome, WebKey>> = {
  SUCCEEDED: 'web.dlv_outcome_succeeded',
  FAILED_RETRYABLE: 'web.dlv_outcome_failed_retryable',
  FAILED_PERMANENT: 'web.dlv_outcome_failed_permanent',
};
