import type {
  APPEARANCE_ERROR_CODES,
  APPEARANCE_TEST_ERROR_CODES,
  AUDIENCE_ERROR_CODES,
  BOT_ERROR_CODES,
  BROADCAST_ERROR_CODES,
  BULK_ERROR_CODES,
  CAMPAIGN_ERROR_CODES,
  COMMERCE_ERROR_CODES,
  CONTROL_ERROR_CODES,
  CUSTOM_MENU_BUTTON_ERROR_CODES,
  DELIVERY_QR_ERROR_CODES,
  DIRECT_MESSAGE_ERROR_CODES,
  IDENTITY_ERROR_CODES,
  INCIDENT_ERROR_CODES,
  LEGACY_CUTOVER_ERROR_CODES,
  LEGACY_HISTORY_ERROR_CODES,
  LEGACY_IMPORT_ERROR_CODES,
  LEGACY_INVOICE_ARCHIVE_ERROR_CODES,
  LEGACY_MIGRATION_HTTP_ERROR_CODES,
  LEGACY_NXPKG_ERROR_CODES,
  LEGACY_PRODUCT_REVIEW_ERROR_CODES,
  LEGACY_SERVICE_REVIEW_ERROR_CODES,
  LEGACY_WALLET_DEBT_ERROR_CODES,
  MESSAGING_ERROR_CODES,
  MINIAPP_ERROR_CODES,
  NOTIFICATION_CENTER_ERROR_CODES,
  OPS_GROUP_ERROR_CODES,
  PANEL_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  SUPPORT_KNOWLEDGE_BUILD_ERROR_CODES,
  SUPPORT_KNOWLEDGE_ERROR_CODES,
  TERMS_ERROR_CODES,
  TICKET_ERROR_CODES,
  TONPAYS_ERROR_CODES,
  TONPAYS_TELEGRAM_ERROR_CODES,
} from '@nexa/contracts';
import { ApiError } from './api/client';
import { t, type WebKey } from './i18n/web.fa';
import { finalAnswer } from './polling';

/**
 * Every error the Web Admin shows, in Persian (W6).
 *
 * The server's `message` is an English sentence written for a log and an API consumer, and it
 * stays that way. What an operator reads is chosen here, by the error's CODE: a code is part
 * of the contract, so it can be mapped once, exhaustively, and checked by the compiler. The
 * server's sentence, the raw validation path and the code itself are kept for support — the
 * code and correlation id small and left-to-right under the Persian sentence, the rest inside
 * «جزئیات فنی» — and never become the sentence.
 */

type CodesOf<T> = T extends readonly (infer U)[] ? U : T[keyof T];

/** Every code a `*_ERROR_CODES` catalogue declares, plus the four the HTTP layer itself uses. */
export type ContractErrorCode =
  | CodesOf<typeof APPEARANCE_ERROR_CODES>
  | CodesOf<typeof APPEARANCE_TEST_ERROR_CODES>
  | CodesOf<typeof AUDIENCE_ERROR_CODES>
  | CodesOf<typeof BOT_ERROR_CODES>
  | CodesOf<typeof BROADCAST_ERROR_CODES>
  | CodesOf<typeof BULK_ERROR_CODES>
  | CodesOf<typeof CAMPAIGN_ERROR_CODES>
  | CodesOf<typeof COMMERCE_ERROR_CODES>
  | CodesOf<typeof CONTROL_ERROR_CODES>
  | CodesOf<typeof CUSTOM_MENU_BUTTON_ERROR_CODES>
  | CodesOf<typeof DELIVERY_QR_ERROR_CODES>
  | CodesOf<typeof DIRECT_MESSAGE_ERROR_CODES>
  | CodesOf<typeof IDENTITY_ERROR_CODES>
  | CodesOf<typeof INCIDENT_ERROR_CODES>
  | CodesOf<typeof LEGACY_CUTOVER_ERROR_CODES>
  | CodesOf<typeof LEGACY_HISTORY_ERROR_CODES>
  | CodesOf<typeof LEGACY_IMPORT_ERROR_CODES>
  | CodesOf<typeof LEGACY_INVOICE_ARCHIVE_ERROR_CODES>
  | CodesOf<typeof LEGACY_MIGRATION_HTTP_ERROR_CODES>
  | CodesOf<typeof LEGACY_NXPKG_ERROR_CODES>
  | CodesOf<typeof LEGACY_PRODUCT_REVIEW_ERROR_CODES>
  | CodesOf<typeof LEGACY_SERVICE_REVIEW_ERROR_CODES>
  | CodesOf<typeof LEGACY_WALLET_DEBT_ERROR_CODES>
  | CodesOf<typeof MESSAGING_ERROR_CODES>
  | CodesOf<typeof MINIAPP_ERROR_CODES>
  | CodesOf<typeof NOTIFICATION_CENTER_ERROR_CODES>
  | CodesOf<typeof OPS_GROUP_ERROR_CODES>
  | CodesOf<typeof PANEL_ERROR_CODES>
  | CodesOf<typeof PLATFORM_ERROR_CODES>
  | CodesOf<typeof SUPPORT_KNOWLEDGE_BUILD_ERROR_CODES>
  | CodesOf<typeof SUPPORT_KNOWLEDGE_ERROR_CODES>
  | CodesOf<typeof TERMS_ERROR_CODES>
  | CodesOf<typeof TICKET_ERROR_CODES>
  | CodesOf<typeof TONPAYS_ERROR_CODES>
  | CodesOf<typeof TONPAYS_TELEGRAM_ERROR_CODES>
  | 'request.invalid'
  | 'http.error'
  | 'internal.unhandled'
  | 'unknown';

/**
 * The Persian sentence for every contract error code.
 *
 * `satisfies Record<ContractErrorCode, WebKey>`: a catalogued code without a sentence fails
 * the type check, and so does a sentence for a code no catalogue declares. A test walks every
 * `*_ERROR_CODES` export at run time too, so a NEW catalogue nobody added to the union above
 * is caught as well.
 */
export const ERROR_TEXT = {
  'admin.last_owner_protected': 'web.err_admin_last_owner_protected',
  'admin.not_found': 'web.err_admin_not_found',
  'admin.password_reused': 'web.err_admin_password_reused',
  'admin.password_stale': 'web.err_admin_password_stale',
  'admin.privilege_escalation_denied': 'web.err_admin_privilege_escalation_denied',
  'admin.second_factor_already_active': 'web.err_admin_second_factor_already_active',
  'admin.second_factor_not_active': 'web.err_admin_second_factor_not_active',
  'admin.second_factor_not_pending': 'web.err_admin_second_factor_not_pending',
  'admin.self_modification_denied': 'web.err_admin_self_modification_denied',
  'admin.session_not_found': 'web.err_admin_session_not_found',
  'admin.telegram_id_taken': 'web.err_admin_telegram_id_taken',
  'admin.username_taken': 'web.err_admin_username_taken',
  'appearance.admin_not_bound': 'web.err_appearance_admin_not_bound',
  'appearance.bot_not_active': 'web.err_appearance_bot_not_active',
  'appearance.chat_unavailable': 'web.err_appearance_chat_unavailable',
  'appearance.custom_emoji_refused': 'web.err_appearance_custom_emoji_refused',
  'appearance.nothing_to_test': 'web.err_appearance_nothing_to_test',
  'appearance.rate_limited': 'web.err_appearance_rate_limited',
  'appearance.slot_unknown': 'web.err_appearance_slot_unknown',
  'appearance.telegram_rejected': 'web.err_appearance_telegram_rejected',
  'appearance.telegram_unreachable': 'web.err_appearance_telegram_unreachable',
  'appearance.test_in_flight': 'web.err_appearance_test_in_flight',
  'audience.changed': 'web.err_audience_changed',
  'audience.definition_invalid': 'web.err_audience_definition_invalid',
  'audience.empty': 'web.err_audience_empty',
  'audience.frozen_kind_mismatch': 'web.err_audience_frozen_kind_mismatch',
  'audience.frozen_not_found': 'web.err_audience_frozen_not_found',
  'audience.frozen_released': 'web.err_audience_frozen_released',
  'auth.challenge_invalid': 'web.err_auth_challenge_invalid',
  'auth.invalid_credentials': 'web.err_auth_invalid_credentials',
  'auth.origin_rejected': 'web.err_auth_origin_rejected',
  'auth.rate_limited': 'web.err_auth_rate_limited',
  'auth.required': 'web.err_auth_required',
  'auth.second_factor_invalid': 'web.err_auth_second_factor_invalid',
  'auth.second_factor_required': 'web.err_auth_second_factor_required',
  'auth.session_invalid': 'web.err_auth_session_invalid',
  'auth.step_up_factor_required': 'web.err_auth_step_up_factor_required',
  'auth.step_up_failed': 'web.err_auth_step_up_failed',
  'auth.tenant_suspended': 'web.err_auth_tenant_suspended',
  'backup.already_running': 'web.err_backup_already_running',
  'backup.archive_password_invalid': 'web.err_backup_archive_password_invalid',
  'legacy_compaction.unavailable': 'web.err_legacy_compaction_unavailable',
  'legacy_compaction.phrase_invalid': 'web.err_legacy_compaction_phrase_invalid',
  'legacy_compaction.active': 'web.err_legacy_compaction_active',
  'backup.archive_password_reauthentication_failed': 'web.backup_password_reauth_failed',
  'backup.archive_auth_failed': 'web.err_backup_archive_auth_failed',
  'backup.archive_malformed': 'web.err_backup_archive_malformed',
  'backup.checksum_mismatch': 'web.err_backup_checksum_mismatch',
  'backup.run_missing': 'web.err_backup_run_missing',
  'backup.tool_failed': 'web.err_backup_tool_failed',
  'backup.tool_oom_killed': 'web.err_backup_tool_oom_killed',
  'backup.memory_insufficient': 'web.err_backup_memory_insufficient',
  'backup.disk_insufficient': 'web.err_backup_disk_insufficient',
  'backup.unsafe_restore_target': 'web.err_backup_unsafe_restore_target',
  'backup.verification_failed': 'web.err_backup_verification_failed',
  'bootstrap.already_completed': 'web.err_bootstrap_already_completed',
  'bot.identity_unknown': 'web.err_bot_identity_unknown',
  'bot.not_active': 'web.err_bot_not_active',
  'bot.not_found': 'web.err_bot_not_found',
  'bot.status_not_managed': 'web.err_bot_status_not_managed',
  'bot.telegram_api_invalid': 'web.err_bot_telegram_api_invalid',
  'bot.telegram_unreachable': 'web.err_bot_telegram_unreachable',
  'bot.token_activation_failed': 'web.err_bot_token_activation_failed',
  'bot.token_different_bot': 'web.err_bot_token_different_bot',
  'bot.token_malformed': 'web.err_bot_token_malformed',
  'bot.token_rejected': 'web.err_bot_token_rejected',
  'bot.token_replacement_in_progress': 'web.err_bot_token_replacement_in_progress',
  'bot.webhook_origin_unknown': 'web.err_bot_webhook_origin_unknown',
  'bot.webhook_refused': 'web.err_bot_webhook_refused',
  'bot.webhook_route_unavailable': 'web.err_bot_webhook_route_unavailable',
  'bot.webhook_setup_failed': 'web.err_bot_webhook_setup_failed',
  'bot.webhook_verification_failed': 'web.err_bot_webhook_verification_failed',
  'broadcast.body_invalid': 'web.err_broadcast_body_invalid',
  'broadcast.confirmation_required': 'web.err_broadcast_confirmation_required',
  'broadcast.media_expired': 'web.err_broadcast_media_expired',
  'broadcast.media_refused': 'web.err_broadcast_media_refused',
  'broadcast.media_required': 'web.err_broadcast_media_required',
  'broadcast.media_storage_full': 'web.err_broadcast_media_storage_full',
  'broadcast.not_found': 'web.err_broadcast_not_found',
  'broadcast.schedule_invalid': 'web.err_broadcast_schedule_invalid',
  'broadcast.source_content_invalid': 'web.err_broadcast_source_content_invalid',
  'broadcast.source_required': 'web.err_broadcast_source_required',
  'broadcast.source_unverified': 'web.err_broadcast_source_unverified',
  'broadcast.state_conflict': 'web.err_broadcast_state_conflict',
  'broadcast.test_target_unavailable': 'web.err_broadcast_test_target_unavailable',
  'broadcast.version_conflict': 'web.err_broadcast_version_conflict',
  'bulk.amount_invalid': 'web.err_bulk_amount_invalid',
  'bulk.confirmation_required': 'web.err_bulk_confirmation_required',
  'bulk.currency_unsupported': 'web.err_bulk_currency_unsupported',
  'bulk.liability_mismatch': 'web.err_bulk_liability_mismatch',
  'bulk.not_found': 'web.err_bulk_not_found',
  'bulk.notify_unsupported': 'web.err_bulk_notify_unsupported',
  'bulk.retry_nothing': 'web.err_bulk_retry_nothing',
  'bulk.state_conflict': 'web.err_bulk_state_conflict',
  'campaign.announcement_purpose_invalid': 'web.err_campaign_announcement_purpose_invalid',
  'campaign.binding_invalid': 'web.err_campaign_binding_invalid',
  'campaign.confirmation_required': 'web.err_campaign_confirmation_required',
  'campaign.no_action': 'web.err_campaign_no_action',
  'campaign.not_editable': 'web.err_campaign_not_editable',
  'campaign.not_found': 'web.err_campaign_not_found',
  'campaign.request_invalid': 'web.err_campaign_request_invalid',
  'campaign.transition_invalid': 'web.err_campaign_transition_invalid',
  'campaign.window_invalid': 'web.err_campaign_window_invalid',
  'commerce.addon_not_found': 'web.err_commerce_addon_not_found',
  'commerce.addon_not_purchasable': 'web.err_commerce_addon_not_purchasable',
  'commerce.auto_renew_disabled': 'web.err_commerce_auto_renew_disabled',
  'commerce.auto_renew_not_available': 'web.err_commerce_auto_renew_not_available',
  'commerce.capture_input_invalid': 'web.err_commerce_capture_input_invalid',
  'commerce.capture_not_open': 'web.err_commerce_capture_not_open',
  'commerce.cashback_rule_not_found': 'web.err_commerce_cashback_rule_not_found',
  'commerce.category_not_empty': 'web.err_commerce_category_not_empty',
  'commerce.category_not_found': 'web.err_commerce_category_not_found',
  'commerce.category_not_purchasable': 'web.err_commerce_category_not_purchasable',
  'commerce.custom_service_disabled': 'web.err_commerce_custom_service_disabled',
  'commerce.custom_service_location_not_found':
    'web.err_commerce_custom_service_location_not_found',
  'commerce.custom_service_not_extendable': 'web.err_commerce_custom_service_not_extendable',
  'commerce.custom_service_rule_invalid': 'web.err_commerce_custom_service_rule_invalid',
  'commerce.custom_service_rule_not_found': 'web.err_commerce_custom_service_rule_not_found',
  'commerce.custom_service_rule_overlap': 'web.err_commerce_custom_service_rule_overlap',
  'commerce.custom_service_terms_changed': 'web.err_commerce_custom_service_terms_changed',
  'commerce.custom_service_unavailable': 'web.err_commerce_custom_service_unavailable',
  'commerce.customer_block_reason_required': 'web.err_commerce_customer_block_reason_required',
  'commerce.customer_blocked': 'web.err_commerce_customer_blocked',
  'commerce.customer_not_found': 'web.err_commerce_customer_not_found',
  'commerce.customer_phone_invalid': 'web.err_commerce_customer_phone_invalid',
  'commerce.customer_tag_archived': 'web.err_commerce_customer_tag_archived',
  'commerce.customer_tag_limit': 'web.err_commerce_customer_tag_limit',
  'commerce.customer_tag_name_taken': 'web.err_commerce_customer_tag_name_taken',
  'commerce.customer_tag_not_found': 'web.err_commerce_customer_tag_not_found',
  'commerce.customer_transfer_confirmation_mismatch':
    'web.err_commerce_customer_transfer_confirmation_mismatch',
  'commerce.customer_transfer_preview_stale': 'web.err_commerce_customer_transfer_preview_stale',
  'commerce.customer_transfer_refused': 'web.err_commerce_customer_transfer_refused',
  'commerce.discount_code_rejected': 'web.err_commerce_discount_code_rejected',
  'commerce.discount_code_taken': 'web.err_commerce_discount_code_taken',
  'commerce.gift_card_batch_invalid': 'web.err_commerce_gift_card_batch_invalid',
  'commerce.gift_card_batch_not_found': 'web.err_commerce_gift_card_batch_not_found',
  'commerce.gift_card_confirmation_mismatch': 'web.err_commerce_gift_card_confirmation_mismatch',
  'commerce.gift_card_export_gone': 'web.err_commerce_gift_card_export_gone',
  'commerce.gift_cards_disabled': 'web.err_commerce_gift_cards_disabled',
  'commerce.discount_no_longer_valid': 'web.err_commerce_discount_no_longer_valid',
  'commerce.discount_not_found': 'web.err_commerce_discount_not_found',
  'commerce.location_change_cooldown': 'web.err_commerce_location_change_cooldown',
  'commerce.location_change_limit_reached': 'web.err_commerce_location_change_limit_reached',
  'commerce.location_change_same_location': 'web.err_commerce_location_change_same_location',
  'commerce.media_invalid': 'web.err_commerce_media_invalid',
  'commerce.order_expired': 'web.err_commerce_order_expired',
  'commerce.order_not_found': 'web.err_commerce_order_not_found',
  'commerce.order_state_invalid': 'web.err_commerce_order_state_invalid',
  'commerce.order_transfer_under_review': 'web.err_commerce_order_transfer_under_review',
  'commerce.panel_not_eligible': 'web.err_commerce_panel_not_eligible',
  'commerce.panel_not_operable': 'web.err_commerce_panel_not_operable',
  'commerce.payment_account_default_conflict': 'web.err_commerce_payment_account_default_conflict',
  'commerce.payment_account_disabled': 'web.err_commerce_payment_account_disabled',
  'commerce.payment_account_duplicate': 'web.err_commerce_payment_account_duplicate',
  'commerce.payment_account_limit_reached': 'web.err_commerce_payment_account_limit_reached',
  'commerce.payment_account_not_found': 'web.err_commerce_payment_account_not_found',
  'commerce.payment_checkout_in_progress': 'web.err_commerce_payment_checkout_in_progress',
  'commerce.payment_destination_unconfigured': 'web.err_commerce_payment_destination_unconfigured',
  'commerce.payment_gateway_amount_rejected': 'web.err_commerce_payment_gateway_amount_rejected',
  'commerce.payment_gateway_not_found': 'web.err_commerce_payment_gateway_not_found',
  'commerce.payment_gateway_unavailable': 'web.err_commerce_payment_gateway_unavailable',
  'commerce.payment_method_unavailable': 'web.err_commerce_payment_method_unavailable',
  'commerce.payment_not_found': 'web.err_commerce_payment_not_found',
  'commerce.payment_state_invalid': 'web.err_commerce_payment_state_invalid',
  'commerce.payment_window_too_short': 'web.err_commerce_payment_window_too_short',
  'commerce.product_currency_unsupported': 'web.err_commerce_product_currency_unsupported',
  'commerce.product_not_categorised': 'web.err_commerce_product_not_categorised',
  'commerce.product_not_for_audience': 'web.err_commerce_product_not_for_audience',
  'commerce.product_not_found': 'web.err_commerce_product_not_found',
  'commerce.product_not_fulfillable': 'web.err_commerce_product_not_fulfillable',
  'commerce.product_not_priced': 'web.err_commerce_product_not_priced',
  'commerce.product_not_purchasable': 'web.err_commerce_product_not_purchasable',
  'commerce.receipt_limit_reached': 'web.err_commerce_receipt_limit_reached',
  'commerce.receipt_not_expected': 'web.err_commerce_receipt_not_expected',
  'commerce.receipt_not_found': 'web.err_commerce_receipt_not_found',
  'commerce.receipt_unavailable': 'web.err_commerce_receipt_unavailable',
  'commerce.receipt_window_expired': 'web.err_commerce_receipt_window_expired',
  'commerce.referral_gift_disabled': 'web.err_commerce_referral_gift_disabled',
  'commerce.referral_gift_terms_invalid': 'web.referral_gift_terms_invalid',
  'commerce.refund_exceeds_refundable': 'web.err_commerce_refund_exceeds_refundable',
  'commerce.refund_not_found': 'web.err_commerce_refund_not_found',
  'commerce.refund_not_permitted': 'web.err_commerce_refund_not_permitted',
  'commerce.refund_state_invalid': 'web.err_commerce_refund_state_invalid',
  'commerce.request_invalid': 'web.err_commerce_request_invalid',
  'commerce.reseller_already_registered': 'web.error_reseller_already_registered',
  'commerce.reseller_not_entitled': 'web.error_reseller_not_entitled',
  'commerce.reseller_not_found': 'web.error_reseller_not_found',
  'commerce.reseller_terms_changed': 'web.error_reseller_terms_changed',
  'commerce.reseller_tier_not_found': 'web.error_reseller_tier_not_found',
  'commerce.service_action_in_progress': 'web.err_commerce_service_action_in_progress',
  'commerce.service_action_not_allowed': 'web.err_commerce_service_action_not_allowed',
  'commerce.service_action_unavailable': 'web.err_commerce_service_action_unavailable',
  'commerce.service_location_invalid': 'web.err_commerce_service_location_invalid',
  'commerce.service_location_not_found': 'web.err_commerce_service_location_not_found',
  'commerce.service_not_deliverable': 'web.err_commerce_service_not_deliverable',
  'commerce.service_not_found': 'web.err_commerce_service_not_found',
  'commerce.service_not_transferable': 'web.err_commerce_service_not_transferable',
  'commerce.service_refund_not_eligible': 'web.err_commerce_service_refund_not_eligible',
  'commerce.service_refund_request_not_found': 'web.err_commerce_service_refund_request_not_found',
  'commerce.service_refund_request_state_invalid':
    'web.err_commerce_service_refund_request_state_invalid',
  'commerce.service_rotation_cooldown': 'web.err_commerce_service_rotation_cooldown',
  'commerce.service_sync_too_soon': 'web.err_commerce_service_sync_too_soon',
  'commerce.service_transfer_recipient_refused':
    'web.err_commerce_service_transfer_recipient_refused',
  'commerce.service_unreconciled': 'web.err_commerce_service_unreconciled',
  'commerce.service_username_exhausted': 'web.err_commerce_service_username_exhausted',
  'commerce.service_username_invalid': 'web.err_commerce_service_username_invalid',
  'commerce.service_username_mode_unavailable':
    'web.err_commerce_service_username_mode_unavailable',
  'commerce.service_username_required': 'web.err_commerce_service_username_required',
  'commerce.service_username_stale': 'web.err_commerce_service_username_stale',
  'commerce.service_username_taken': 'web.err_commerce_service_username_taken',
  'commerce.service_username_ungeneratable': 'web.err_commerce_service_username_ungeneratable',
  'commerce.settlement_not_funded': 'web.err_commerce_settlement_not_funded',
  'commerce.support_faq_limit': 'web.err_commerce_support_faq_limit',
  'commerce.support_faq_not_found': 'web.err_commerce_support_faq_not_found',
  'commerce.support_faq_version_conflict': 'web.err_commerce_support_faq_version_conflict',
  'commerce.topup_above_maximum': 'web.err_commerce_topup_above_maximum',
  'commerce.topup_below_minimum': 'web.err_commerce_topup_below_minimum',
  'commerce.topup_not_offered': 'web.err_commerce_topup_not_offered',
  'commerce.topup_unavailable': 'web.err_commerce_topup_unavailable',
  'commerce.trial_config_stale': 'web.err_commerce_trial_config_stale',
  'commerce.trial_reset_nothing': 'web.err_commerce_trial_reset_nothing',
  'commerce.trial_reset_stale': 'web.err_commerce_trial_reset_stale',
  'commerce.wallet_currency_unsupported': 'web.err_commerce_wallet_currency_unsupported',
  'commerce.wallet_negative_top_up_required': 'web.err_commerce_wallet_negative_top_up_required',
  'commerce.wallet_insufficient_funds': 'web.err_commerce_wallet_insufficient_funds',
  'control.client_app_limit': 'web.err_control_client_app_limit',
  'control.client_app_not_found': 'web.err_control_client_app_not_found',
  'control.client_app_version_conflict': 'web.err_control_client_app_version_conflict',
  'control.client_app_video_bot_unavailable': 'web.err_control_client_app_video_bot_unavailable',
  'control.client_app_video_session_not_found':
    'web.err_control_client_app_video_session_not_found',
  'control.client_app_video_telegram_unlinked':
    'web.err_control_client_app_video_telegram_unlinked',
  'control.destination_not_configured': 'web.destination_missing',
  'control.invalid_value': 'web.err_control_invalid_value',
  'control.main_menu_revision_not_found': 'web.err_control_main_menu_revision_not_found',
  'control.notification_not_found': 'web.err_control_notification_not_found',
  'control.notification_record_orphaned': 'web.err_control_notification_record_orphaned',
  'control.template_invalid': 'web.err_control_template_invalid',
  'control.template_not_overridden': 'web.err_control_template_not_overridden',
  'control.unknown_key': 'web.err_control_unknown_key',
  'control.version_conflict': 'web.conflict',
  'custom_menu_button.archived_in_layout': 'web.err_custom_menu_button_archived_in_layout',
  'custom_menu_button.bot_invalid': 'web.err_custom_menu_button_bot_invalid',
  'custom_menu_button.content_invalid': 'web.err_custom_menu_button_content_invalid',
  'custom_menu_button.file_refused': 'web.err_custom_menu_button_file_refused',
  'custom_menu_button.label_invalid': 'web.err_custom_menu_button_label_invalid',
  'custom_menu_button.label_taken': 'web.err_custom_menu_button_label_taken',
  'custom_menu_button.limit_reached': 'web.err_custom_menu_button_limit_reached',
  'custom_menu_button.storage_full': 'web.err_custom_menu_button_storage_full',
  'custom_menu_button.unknown_button': 'web.err_custom_menu_button_unknown_button',
  'custom_menu_button.url_invalid': 'web.err_custom_menu_button_url_invalid',
  'direct_message.body_invalid': 'web.err_direct_message_body_invalid',
  'direct_message.file_refused': 'web.err_direct_message_file_refused',
  'direct_message.file_storage_full': 'web.err_direct_message_file_storage_full',
  'direct_message.rate_limited': 'web.err_direct_message_rate_limited',
  'direct_message.target_unavailable': 'web.err_direct_message_target_unavailable',
  'http.error': 'web.err_http_error',
  'incident.not_found': 'web.err_incident_not_found',
  'incident.notice_refused': 'web.err_incident_notice_refused',
  'incident.schedule_invalid': 'web.err_incident_schedule_invalid',
  'incident.state_conflict': 'web.err_incident_state_conflict',
  'incident.target_invalid': 'web.err_incident_target_invalid',
  'incident.version_conflict': 'web.err_incident_version_conflict',
  'installation_key.in_use': 'web.err_installation_key_in_use',
  'installation_key.not_found': 'web.err_installation_key_not_found',
  'installation_key.not_removable': 'web.err_installation_key_not_removable',
  'internal.unhandled': 'web.err_internal_unhandled',
  'legacy_cutover.already_approved': 'web.err_legacy_cutover_already_approved',
  'legacy_cutover.already_revoked': 'web.err_legacy_cutover_already_revoked',
  'legacy_cutover.approval_missing': 'web.err_legacy_cutover_approval_missing',
  'legacy_cutover.approval_synthetic': 'web.err_legacy_cutover_approval_synthetic',
  'legacy_cutover.expectation_incomplete': 'web.err_legacy_cutover_expectation_incomplete',
  'legacy_cutover.no_prior_import': 'web.err_legacy_cutover_no_prior_import',
  'legacy_cutover.not_found': 'web.err_legacy_cutover_not_found',
  'legacy_cutover.read_set_evidence_mixed': 'web.err_legacy_cutover_read_set_evidence_mixed',
  'legacy_cutover.read_set_not_recorded': 'web.err_legacy_cutover_read_set_not_recorded',
  'legacy_cutover.request_invalid': 'web.err_legacy_cutover_request_invalid',
  'legacy_cutover.scope_stopped': 'web.err_legacy_cutover_scope_stopped',
  'legacy_cutover.source_superseded': 'web.err_legacy_cutover_source_superseded',
  'legacy_cutover.stop_sales_not_active': 'web.err_legacy_cutover_stop_sales_not_active',
  'legacy_cutover.tables_unclassified': 'web.err_legacy_cutover_tables_unclassified',
  'legacy_history.request_invalid': 'web.err_legacy_history_request_invalid',
  'legacy_history.scope_stopped': 'web.err_legacy_history_scope_stopped',
  'legacy_import.invalid': 'web.err_legacy_import_invalid',
  'legacy_import.review_conflict': 'web.err_legacy_import_review_conflict',
  'legacy_import.review_not_found': 'web.err_legacy_import_review_not_found',
  'legacy_import.review_not_in_review': 'web.err_legacy_import_review_not_in_review',
  'legacy_import.run_conflict': 'web.err_legacy_import_run_conflict',
  'legacy_import.run_not_found': 'web.err_legacy_import_run_not_found',
  'legacy_import.run_not_writable': 'web.err_legacy_import_run_not_writable',
  'legacy_invoice_archive.not_found': 'web.err_legacy_invoice_archive_not_found',
  'legacy_invoice_archive.request_invalid': 'web.err_legacy_invoice_archive_request_invalid',
  'legacy_invoice_archive.run_conflict': 'web.err_legacy_invoice_archive_run_conflict',
  'legacy_invoice_archive.scope_stopped': 'web.err_legacy_invoice_archive_scope_stopped',
  'legacy_migration.already_active': 'web.err_legacy_migration_already_active',
  'legacy_migration.confirmation_invalid': 'web.err_legacy_migration_confirmation_invalid',
  'legacy_migration.digest_mismatch': 'web.err_legacy_migration_digest_mismatch',
  'legacy_migration.disabled': 'web.err_legacy_migration_disabled',
  'legacy_migration.invalid_state': 'web.err_legacy_migration_invalid_state',
  'legacy_migration.no_completed_import': 'web.err_legacy_migration_no_completed_import',
  'legacy_migration.not_found': 'web.err_legacy_migration_not_found',
  'legacy_migration.recovery_active': 'web.err_legacy_migration_recovery_active',
  'legacy_migration.request_invalid': 'web.err_legacy_migration_request_invalid',
  'legacy_migration.scope_stopped': 'web.err_legacy_migration_scope_stopped',
  'legacy_migration.target_ack_mismatch': 'web.err_legacy_migration_target_ack_mismatch',
  'legacy_migration.upload_empty': 'web.err_legacy_migration_upload_empty',
  'legacy_migration.upload_too_large': 'web.err_legacy_migration_upload_too_large',
  'legacy_product_review.facts_changed': 'web.err_legacy_product_review_facts_changed',
  'legacy_product_review.not_found': 'web.err_legacy_product_review_not_found',
  'legacy_product_review.not_in_state': 'web.err_legacy_product_review_not_in_state',
  'legacy_product_review.product_not_found': 'web.err_legacy_product_review_product_not_found',
  'legacy_product_review.request_invalid': 'web.err_legacy_product_review_request_invalid',
  'legacy_product_review.scope_stopped': 'web.err_legacy_product_review_scope_stopped',
  'legacy_product_review.source_absent': 'web.err_legacy_product_review_source_absent',
  'legacy_product_review.source_conflict': 'web.err_legacy_product_review_source_conflict',
  'legacy_product_review.version_conflict': 'web.err_legacy_product_review_version_conflict',
  'legacy_service_candidate.not_adoptable': 'web.err_legacy_service_candidate_not_adoptable',
  'legacy_service_candidate.not_found': 'web.err_legacy_service_candidate_not_found',
  'legacy_service_candidate.not_in_state': 'web.err_legacy_service_candidate_not_in_state',
  'legacy_service_candidate.panel_refused': 'web.err_legacy_service_candidate_panel_refused',
  'legacy_service_candidate.request_invalid': 'web.err_legacy_service_candidate_request_invalid',
  'legacy_service_candidate.scope_stopped': 'web.err_legacy_service_candidate_scope_stopped',
  'legacy_service_candidate.version_conflict': 'web.err_legacy_service_candidate_version_conflict',
  'legacy_wallet_debt.not_found': 'web.err_legacy_wallet_debt_not_found',
  'legacy_wallet_debt.not_in_state': 'web.err_legacy_wallet_debt_not_in_state',
  'legacy_wallet_debt.request_invalid': 'web.err_legacy_wallet_debt_request_invalid',
  'legacy_wallet_debt.scope_stopped': 'web.err_legacy_wallet_debt_scope_stopped',
  'legacy_wallet_debt.version_conflict': 'web.err_legacy_wallet_debt_version_conflict',
  'messaging.button_url_invalid': 'web.err_messaging_button_url_invalid',
  'messaging.button_url_scheme': 'web.err_messaging_button_url_scheme',
  'messaging.split_bound_invalid': 'web.err_messaging_split_bound_invalid',
  'miniapp.gate_required': 'web.err_miniapp_gate_required',
  'miniapp.init_data_expired': 'web.err_miniapp_init_data_expired',
  'miniapp.init_data_invalid': 'web.err_miniapp_init_data_invalid',
  'miniapp.init_data_replayed': 'web.err_miniapp_init_data_replayed',
  'miniapp.not_found': 'web.err_miniapp_not_found',
  'miniapp.rate_limited': 'web.err_miniapp_rate_limited',
  'miniapp.receipt_refused': 'web.err_miniapp_receipt_refused',
  'miniapp.receipt_upload_failed': 'web.err_miniapp_receipt_upload_failed',
  'miniapp.request_invalid': 'web.err_miniapp_request_invalid',
  'miniapp.route_unavailable': 'web.err_miniapp_route_unavailable',
  'miniapp.session_invalid': 'web.err_miniapp_session_invalid',
  'miniapp.unavailable': 'web.err_miniapp_unavailable',
  'notification_center.not_found': 'web.err_notification_center_not_found',
  'ops_group.bot_not_available': 'web.err_ops_group_bot_not_available',
  'ops_group.not_connected': 'web.err_ops_group_not_connected',
  'panel.archived': 'web.err_panel_archived',
  'panel.capability_unsupported': 'web.err_panel_capability_unsupported',
  'panel.configuration_changed': 'web.err_panel_configuration_changed',
  'panel.credential_too_short': 'web.err_panel_credential_too_short',
  'panel.credential_unsupported': 'web.err_panel_credential_unsupported',
  'panel.files_only_unsupported': 'web.err_panel_files_only_unsupported',
  'panel.qr_kind_unsupported': 'web.err_panel_qr_kind_unsupported',
  'panel.credentials_missing': 'web.err_panel_credentials_missing',
  'panel.delivery_tutorial_stale': 'web.err_panel_delivery_tutorial_stale',
  'panel.name_taken': 'web.err_panel_name_taken',
  'panel.namespace_conflict': 'web.err_panel_namespace_conflict',
  'panel.not_found': 'web.err_panel_not_found',
  'panel.not_validated': 'web.err_panel_not_validated',
  'panel.policy_capability_unsupported': 'web.err_panel_policy_capability_unsupported',
  'panel.policy_stale': 'web.err_panel_policy_stale',
  'panel.probe_limited': 'web.err_panel_probe_limited',
  'panel.provider_feature_disabled': 'web.err_panel_provider_feature_disabled',
  'panel.provider_type_unsupported': 'web.err_panel_provider_type_unsupported',
  'panel.request_invalid': 'web.err_panel_request_invalid',
  'panel.target_blocked': 'web.err_panel_target_blocked',
  'panel.url_invalid': 'web.err_panel_url_invalid',
  'panel.username_policy_empty': 'web.err_panel_username_policy_empty',
  'panel.username_prefix_invalid': 'web.err_panel_username_prefix_invalid',
  'panel.username_strategy_invalid': 'web.err_panel_username_strategy_invalid',
  'panel.username_template_invalid': 'web.err_panel_username_template_invalid',
  'platform.config_invalid': 'web.err_platform_config_invalid',
  'platform.idempotency_in_flight': 'web.err_platform_idempotency_in_flight',
  'platform.idempotency_payload_mismatch': 'web.err_platform_idempotency_payload_mismatch',
  'platform.permission_denied': 'web.no_permission',
  'platform.request_rate_limited': 'web.err_platform_request_rate_limited',
  'platform.secret_auth_failed': 'web.err_platform_secret_auth_failed',
  'platform.secret_key_id_mismatch': 'web.err_platform_secret_key_id_mismatch',
  'platform.secret_key_unknown': 'web.err_platform_secret_key_unknown',
  'platform.secret_version_unsupported': 'web.err_platform_secret_version_unsupported',
  'platform.tenant_context_missing': 'web.err_platform_tenant_context_missing',
  'platform.tenant_not_found': 'web.err_platform_tenant_not_found',
  'platform.unknown_event_type': 'web.err_platform_unknown_event_type',
  'qr.margin_invalid': 'web.err_qr_margin_invalid',
  'qr.scale_invalid': 'web.err_qr_scale_invalid',
  'qr.text_empty': 'web.err_qr_text_empty',
  'qr.text_too_long': 'web.err_qr_text_too_long',
  'recovery.already_active': 'web.err_recovery_already_active',
  'recovery.confirmation_invalid': 'web.err_recovery_confirmation_invalid',
  'recovery.legacy_migration_active': 'web.err_recovery_legacy_migration_active',
  'recovery.quiesced': 'web.err_recovery_quiesced',
  'recovery.refused': 'web.err_recovery_refused',
  'recovery_kit.auth_failed': 'web.err_recovery_kit_auth_failed',
  'recovery_kit.busy': 'web.err_recovery_kit_busy',
  'recovery_kit.key_collision': 'web.err_recovery_kit_key_collision',
  'recovery_kit.malformed': 'web.err_recovery_kit_malformed',
  'recovery_kit.passphrase_rejected': 'web.err_recovery_kit_passphrase_rejected',
  'recovery_kit.reauthentication_failed': 'web.err_recovery_kit_reauthentication_failed',
  'recovery_kit.too_many_keys': 'web.err_recovery_kit_too_many_keys',
  'recovery_kit.unsupported_version': 'web.err_recovery_kit_unsupported_version',
  'request.invalid': 'web.err_request_invalid',
  'role.confirmation_required': 'web.err_role_confirmation_required',
  'role.immutable': 'web.err_role_immutable',
  'role.in_use': 'web.err_role_in_use',
  'role.key_taken': 'web.err_role_key_taken',
  'role.not_found': 'web.err_role_not_found',
  'role.permissions_incoherent': 'web.err_role_permissions_incoherent',
  'role.unknown_permission': 'web.err_role_unknown_permission',
  'role.version_conflict': 'web.err_role_version_conflict',
  'support_knowledge.ai_off': 'web.err_support_knowledge_ai_off',
  'support_knowledge.base_moved': 'web.err_support_knowledge_base_moved',
  'support_knowledge.build_not_found': 'web.err_support_knowledge_build_not_found',
  'support_knowledge.build_running': 'web.err_support_knowledge_build_running',
  'support_knowledge.build_superseded': 'web.err_support_knowledge_build_superseded',
  'support_knowledge.candidate_not_found': 'web.err_support_knowledge_candidate_not_found',
  'support_knowledge.learning_rate_limited': 'web.err_support_knowledge_learning_rate_limited',
  'support_knowledge.limit': 'web.err_support_knowledge_limit',
  'support_knowledge.not_a_conflict': 'web.err_support_knowledge_not_a_conflict',
  'support_knowledge.not_found': 'web.err_support_knowledge_not_found',
  'support_knowledge.not_in_state': 'web.err_support_knowledge_not_in_state',
  'support_knowledge.proposal_not_found': 'web.err_support_knowledge_proposal_not_found',
  'support_knowledge.scope_stopped': 'web.err_support_knowledge_scope_stopped',
  'support_knowledge.sensitive_content': 'web.err_support_knowledge_sensitive_content',
  'support_knowledge.source_not_eligible': 'web.err_support_knowledge_source_not_eligible',
  'support_knowledge.version_conflict': 'web.err_support_knowledge_version_conflict',
  'telegram.bad_secret_token': 'web.err_telegram_bad_secret_token',
  'telegram.bootstrap_api_base_invalid': 'web.err_telegram_bootstrap_api_base_invalid',
  'telegram.bootstrap_bot_already_bound': 'web.err_telegram_bootstrap_bot_already_bound',
  'telegram.bootstrap_different_bot': 'web.err_telegram_bootstrap_different_bot',
  'telegram.bootstrap_token_rejected': 'web.err_telegram_bootstrap_token_rejected',
  'telegram.bootstrap_unreachable': 'web.err_telegram_bootstrap_unreachable',
  'telegram.bootstrap_username_taken': 'web.err_telegram_bootstrap_username_taken',
  'telegram.bootstrap_webhook_failed': 'web.err_telegram_bootstrap_webhook_failed',
  'telegram.bootstrap_webhook_refused': 'web.err_telegram_bootstrap_webhook_refused',
  'terms.draft_conflict': 'web.err_terms_draft_conflict',
  'terms.draft_exists': 'web.err_terms_draft_exists',
  'terms.version_not_found': 'web.err_terms_version_not_found',
  'terms.version_published': 'web.err_terms_version_published',
  'ticket.assignee_invalid': 'web.err_ticket_assignee_invalid',
  'ticket.attachment_refused': 'web.err_ticket_attachment_refused',
  'ticket.attachment_storage_full': 'web.err_ticket_attachment_storage_full',
  'ticket.attachment_unavailable': 'web.err_ticket_attachment_unavailable',
  'ticket.category_invalid': 'web.err_ticket_category_invalid',
  'ticket.category_limit': 'web.err_ticket_category_limit',
  'ticket.category_not_found': 'web.err_ticket_category_not_found',
  'ticket.closed': 'web.err_ticket_closed',
  'ticket.link_invalid': 'web.err_ticket_link_invalid',
  'ticket.message_invalid': 'web.err_ticket_message_invalid',
  'ticket.message_limit': 'web.err_ticket_message_limit',
  'ticket.not_found': 'web.err_ticket_not_found',
  'ticket.open_limit': 'web.err_ticket_open_limit',
  'ticket.transition_invalid': 'web.err_ticket_transition_invalid',
  unknown: 'web.err_unknown',
  ACCESS_DENIED: 'web.err_tonpays_access_denied',
  ACCOUNT_NOT_VERIFIED: 'web.err_tonpays_account_not_verified',
  ACCOUNT_SUSPENDED: 'web.err_tonpays_account_suspended',
  ADOPT_REFUSED: 'web.err_nxpkg_adopt_refused',
  AMOUNT_TOO_HIGH: 'web.err_tonpays_amount_too_high',
  AMOUNT_TOO_LOW: 'web.err_tonpays_amount_too_low',
  APPROVAL_EXPIRED: 'web.err_nxpkg_approval_expired',
  BUYER_IS_MERCHANT: 'web.err_tonpays_buyer_is_merchant',
  BUYER_SUSPENDED: 'web.err_tonpays_buyer_suspended',
  CANCELLED: 'web.err_nxpkg_cancelled',
  DECISIONS_INVALID: 'web.err_nxpkg_decisions_invalid',
  DRY_RUN_MISMATCH: 'web.err_nxpkg_dry_run_mismatch',
  DUPLICATE_ORDER_ID: 'web.err_tonpays_duplicate_order_id',
  FRESH_TARGET_NOT_EMPTY: 'web.err_nxpkg_fresh_target_not_empty',
  GATEWAY_NOT_APPROVED: 'web.err_tonpays_gateway_not_approved',
  IMPORT_FAILED: 'web.err_nxpkg_import_failed',
  INACTIVE_API_KEY: 'web.err_tonpays_inactive_api_key',
  INVALID_API_KEY: 'web.err_tonpays_invalid_api_key',
  INVALID_BUYER_CHAT_ID: 'web.err_tonpays_invalid_buyer_chat_id',
  INVALID_CALLBACK_URL: 'web.err_tonpays_invalid_callback_url',
  INVALID_RECEIPT_TYPE: 'web.err_tonpays_invalid_receipt_type',
  INVOICE_NOT_FOUND: 'web.err_tonpays_invoice_not_found',
  MISSING_API_KEY: 'web.err_tonpays_missing_api_key',
  NXPKG_CONTAINER_INVALID: 'web.err_nxpkg_nxpkg_container_invalid',
  NXPKG_LIVE_FLAG: 'web.err_nxpkg_nxpkg_live_flag',
  NXPKG_MONEY_UNIT: 'web.err_nxpkg_nxpkg_money_unit',
  NXPKG_NOT_READY: 'web.err_nxpkg_nxpkg_not_ready',
  NXPKG_SOURCE_SNAPSHOT_MISSING: 'web.err_nxpkg_nxpkg_source_snapshot_missing',
  NXPKG_TAMPERED: 'web.err_nxpkg_nxpkg_tampered',
  NXPKG_UNSUPPORTED_VERSION: 'web.err_nxpkg_nxpkg_unsupported_version',
  NXPKG_WRONG_KEY: 'web.err_nxpkg_nxpkg_wrong_key',
  PACKAGE_CHANGED: 'web.err_nxpkg_package_changed',
  PANEL_TARGET_MISMATCH: 'web.err_nxpkg_panel_target_mismatch',
  PAYER_RESERVE_FAILED: 'web.err_tonpays_payer_reserve_failed',
  PRE_IMPORT_BACKUP_FAILED: 'web.err_nxpkg_pre_import_backup_failed',
  RATE_LIMIT_EXCEEDED: 'web.err_tonpays_rate_limit_exceeded',
  RECEIPT_TOO_LARGE: 'web.err_tonpays_receipt_too_large',
  STORE_INACTIVE: 'web.err_tonpays_store_inactive',
  SUPERSEDED_BY_RESTORE: 'web.err_nxpkg_superseded_by_restore',
  WEB_PAY_URL_FAILED: 'web.err_tonpays_web_pay_url_failed',
  INVOICE_ID_MISMATCH: 'web.err_tonpays_invoice_id_mismatch',
  NOT_PENDING: 'web.err_tonpays_not_pending',
  REMAINDER_INVOICE_MISSING: 'web.err_tonpays_remainder_invoice_missing',
  EMPTY_RECEIPT: 'web.err_tonpays_empty_receipt',
  CANCEL_NOT_ALLOWED_PROCESSING: 'web.err_tonpays_cancel_not_allowed_processing',
  CANCEL_NOT_ALLOWED_NEED_ACTION_LESS: 'web.err_tonpays_cancel_not_allowed_less',
  CANCEL_NOT_ALLOWED_NEED_ACTION_MORE: 'web.err_tonpays_cancel_not_allowed_more',
  BUYER_HAS_PENDING_INVOICE: 'web.err_tonpays_buyer_has_pending',
  BUYER_HAS_PROCESSING_INVOICE: 'web.err_tonpays_buyer_has_processing',
  BUYER_HAS_NEED_ACTION_LESS: 'web.err_tonpays_buyer_has_less',
  BUYER_HAS_NEED_ACTION_MORE: 'web.err_tonpays_buyer_has_more',
  REFUND_NOT_ALLOWED: 'web.err_tonpays_refund_not_allowed',
  INVALID_REFUND_CARD: 'web.err_tonpays_invalid_refund_card',
  INVALID_REFUND_HOLDER: 'web.err_tonpays_invalid_refund_holder',
  REFUND_ALREADY_OPEN: 'web.err_tonpays_refund_already_open',
  WRONG_API_KEY_KIND: 'web.err_tonpays_wrong_api_key_kind',
} as const satisfies Record<ContractErrorCode, WebKey>;

/**
 * The codes the API raises from catalogues that live in `apps/api` rather than in
 * `@nexa/contracts` — the business-chat conversation (`BUSINESS_CHAT_ERROR_CODES`), the
 * support assistant (`SUPPORT_ASSIST_ERROR_CODES`) and its configuration
 * (`SUPPORT_AI_ERROR_CODES`), and the cutover link of imported customers to the production
 * bot (`customers.bot_link_invalid`, raised by the operator CLI). The Web Admin cannot import them, so they are keyed by their
 * strings here; `tests/web/error-text.test.tsx` walks the API's own raise sites, so a code
 * raised there and missing from both tables fails the suite.
 */
export const API_LOCAL_ERROR_TEXT = {
  'business_chats.connection_unusable': 'web.bchat_fault_connection',
  'business_chats.idempotency_payload_mismatch': 'web.bchat_fault_retry',
  'business_chats.not_found': 'web.bchat_fault_not_found',
  'business_chats.not_in_state': 'web.bchat_fault_not_in_state',
  'customers.bot_link_invalid': 'web.err_customers_bot_link_invalid',
  'support_ai.credential_missing': 'web.sai_fault_credential_missing',
  'support_ai.draft_not_found': 'web.assist_fault_not_found',
  'support_ai.draft_not_ready': 'web.assist_fault_not_ready',
  'support_ai.off': 'web.assist_fault_off',
  'support_ai.region_not_applicable': 'web.sai_fault_region',
  'support_ai.test_too_soon': 'web.sai_fault_test_too_soon',
  'support_ai.auto_topics_required': 'web.sai_fault_auto_topics_required',
  'support_ai.unknown_provider': 'web.sai_fault_unknown_provider',
  'support_ai.version_conflict': 'web.sai_fault_conflict',
} as const satisfies Readonly<Record<string, WebKey>>;

const ERROR_TEXT_LOOKUP: Readonly<Record<string, WebKey>> = {
  ...ERROR_TEXT,
  ...API_LOCAL_ERROR_TEXT,
};

/**
 * Codes that say nothing about WHAT was refused. The HTTP status says more, so it is asked
 * first; the code's own sentence is the fallback.
 */
const STATUS_FIRST: ReadonlySet<string> = new Set(['http.error', 'unknown']);

/** The sentence for a refusal whose code this module has no sentence for, by its status. */
function statusText(status: number): WebKey | null {
  if (status === 403) return 'web.no_permission';
  if (status === 400 || status === 422) return 'web.err_status_400';
  if (status === 401) return 'web.err_status_401';
  if (status === 404) return 'web.err_status_404';
  if (status === 409) return 'web.err_status_409';
  if (status === 412) return 'web.err_status_412';
  if (status === 413) return 'web.err_status_413';
  if (status === 429) return 'web.err_status_429';
  if (status >= 500) return 'web.err_status_5xx';
  return null;
}

/** A page's own sentences, for the codes where it has something more specific to say. */
export type ErrorOverrides =
  Readonly<Partial<Record<string, WebKey>>> | ((error: ApiError) => string | undefined);

export interface ErrorTextOptions {
  /** Checked first: a page that reads `details`, or says a code in its own words. */
  readonly overrides?: ErrorOverrides;
}

function override(error: ApiError, overrides: ErrorOverrides | undefined): string | undefined {
  if (overrides === undefined) return undefined;
  if (typeof overrides === 'function') return overrides(error);
  const key = overrides[error.code];
  return key === undefined ? undefined : t(key);
}

/**
 * The Persian sentence for an error. NEVER the server's `message`.
 *
 * Resolves, in order: the page's overrides; `ERROR_TEXT[code]`; a 403; a sentence per HTTP
 * status; and finally the shared «rejected» / «connection» sentences. Anything that is not an
 * `ApiError` — a dropped connection, a response that failed its schema — gets the same two
 * sentences the query views use.
 */
export function errorText(error: unknown, options: ErrorTextOptions = {}): string {
  if (error instanceof ApiError) {
    const own = override(error, options.overrides);
    if (own !== undefined) return own;
    const byStatus = statusText(error.status);
    if (STATUS_FIRST.has(error.code) && byStatus !== null) return t(byStatus);
    const mapped = ERROR_TEXT_LOOKUP[error.code];
    if (mapped !== undefined) return t(mapped);
    if (byStatus !== null) return t(byStatus);
    return error.status >= 400 && error.status < 500 ? t('web.rejected') : t('web.error');
  }
  return finalAnswer(error) ? t('web.rejected') : t('web.error');
}

/**
 * Round 9 C4: why a payment route refused to be switched ON, by the `details.reason` the
 * server's `PAYMENT_GATEWAY_UNAVAILABLE` carries — so the operator is told in Persian exactly
 * what is missing (the API key, the webhook secret, ...) instead of the generic «درگاه پرداخت
 * اکنون در دسترس نیست». Undefined for any other error, which then reads as before.
 */
const GATEWAY_ENABLE_REFUSAL_TEXT: Readonly<Record<string, WebKey>> = {
  CREDENTIAL_MISSING: 'web.payment_gateway_enable_refused_credential_missing',
  WEBHOOK_SECRET_MISSING: 'web.payment_gateway_enable_refused_webhook_secret_missing',
  VERIFY_KEY_MISSING: 'web.payment_gateway_enable_refused_verify_key_missing',
  RATE_MISSING: 'web.payment_gateway_enable_refused_rate_missing',
  FX_UNAVAILABLE: 'web.payment_gateway_enable_refused_fx_unavailable',
  // Round 10 C1: the custom gateway's bridge address.
  ENDPOINT_MISSING: 'web.payment_gateway_enable_refused_endpoint_missing',
  ENDPOINT_CHANGE_WHILE_ACTIVE: 'web.payment_gateway_endpoint_refused_active',
  // Codex on #336: attempts opened against the current bridge are still open.
  ENDPOINT_CHANGE_WITH_OPEN_ATTEMPTS: 'web.payment_gateway_endpoint_refused_open_attempts',
};

/**
 * Round 10 C1: why the server refused a custom gateway's bridge address, allow-list or secret
 * (`commerce.request_invalid` with `details.reason`), in Persian. Undefined for any other error.
 */
const GATEWAY_REQUEST_REFUSAL_TEXT: Readonly<Record<string, WebKey>> = {
  ENDPOINT_URL_INVALID: 'web.payment_gateway_endpoint_refused_url',
  ENDPOINT_ADDRESS_REFUSED: 'web.payment_gateway_endpoint_refused_address',
  ALLOWLIST_INVALID: 'web.payment_gateway_endpoint_refused_allowlist',
  SECRET_TOO_SHORT: 'web.payment_gateway_custom_secret_too_short',
};

export function gatewayRequestRefusalText(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code === 'commerce.payment_gateway_unavailable') return gatewayEnableRefusalText(error);
  if (error.code !== 'commerce.request_invalid') return undefined;
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  if (typeof reason !== 'string' || !Object.hasOwn(GATEWAY_REQUEST_REFUSAL_TEXT, reason)) {
    return undefined;
  }
  const key = GATEWAY_REQUEST_REFUSAL_TEXT[reason];
  return key === undefined ? undefined : t(key);
}

export function gatewayEnableRefusalText(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.code !== 'commerce.payment_gateway_unavailable') {
    return undefined;
  }
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  if (typeof reason !== 'string' || !Object.hasOwn(GATEWAY_ENABLE_REFUSAL_TEXT, reason)) {
    return undefined;
  }
  const key = GATEWAY_ENABLE_REFUSAL_TEXT[reason];
  return key === undefined ? undefined : t(key);
}

/** Whether a code has a sentence of its own (for tests and for pages that branch on it). */
export function hasErrorText(code: string): boolean {
  return ERROR_TEXT_LOOKUP[code] !== undefined;
}

// ---------------------------------------------------------------------------
// Validation issues
// ---------------------------------------------------------------------------

/**
 * Field names, by the LAST non-numeric segment of a validation path (`items.2.amountMinor`
 * → `amountMinor`). A page passes its own for the fields only it has.
 */
export const FIELD_LABELS: Readonly<Record<string, WebKey>> = {
  amount: 'web.err_field_amount',
  reason: 'web.err_field_reason',
  note: 'web.err_field_note',
  body: 'web.err_field_body',
  value: 'web.err_field_value',
  chatId: 'web.err_field_chat_id',
  handle: 'web.err_field_handle',
  joinUrl: 'web.err_field_join_url',
  quietHours: 'web.err_field_quiet_hours',
  quietHoursStart: 'web.err_field_quiet_hours',
  quietHoursEnd: 'web.err_field_quiet_hours',
  start: 'web.err_field_start',
  end: 'web.err_field_end',
  name: 'web.err_field_name',
  title: 'web.err_field_title',
  text: 'web.err_field_body',
  message: 'web.err_field_body',
  url: 'web.err_field_url',
  username: 'web.err_field_username',
  password: 'web.err_field_password',
  code: 'web.err_field_code',
  currency: 'web.err_field_currency',
  description: 'web.err_field_description',
  phone: 'web.err_field_phone',
  telegramId: 'web.err_field_telegram_id',
  telegramUserId: 'web.err_field_telegram_id',
  limit: 'web.err_field_limit',
  count: 'web.err_field_count',
  days: 'web.err_field_days',
  durationDays: 'web.err_field_duration',
  startsAt: 'web.err_field_starts_at',
  endsAt: 'web.err_field_ends_at',
  expiresAt: 'web.err_field_expires_at',
  priceMinor: 'web.err_field_price',
  price: 'web.err_field_price',
  percent: 'web.err_field_percent',
  label: 'web.err_field_label',
  caption: 'web.err_field_caption',
  token: 'web.err_field_token',
  key: 'web.err_field_key',
  email: 'web.err_field_email',
  tags: 'web.err_field_tags',
  tagIds: 'web.err_field_tags',
  confirmation: 'web.err_field_confirmation',
  trafficBytes: 'web.err_field_traffic',
  trafficGb: 'web.err_field_traffic',
};

/**
 * Fields whose rule is known well enough to say it outright rather than «… is not valid».
 * Keyed like `FIELD_LABELS`.
 */
const FIELD_RULES: Readonly<Record<string, WebKey>> = {
  amountMinor: 'web.err_rule_amount_positive',
  amount: 'web.err_rule_amount_positive',
};

/** One refused field, said in Persian, with what the server actually wrote kept beside it. */
export interface ErrorIssue {
  /** The Persian sentence. */
  readonly text: string;
  /** A `{token}` the issue is about, shown as typed (Latin, left-to-right). */
  readonly token?: string;
  /** The server's own words (`path: message`), for the technical-details disclosure only. */
  readonly raw: string | null;
}

const TEMPLATE_ISSUE_TEXT: Readonly<Record<string, WebKey>> = {
  EMPTY: 'web.template_issue_empty',
  TOO_LONG: 'web.template_issue_too_long',
  UNKNOWN_PLACEHOLDER: 'web.template_issue_unknown',
  MISSING_REQUIRED_PLACEHOLDER: 'web.template_issue_missing',
  REPEATED_PLACEHOLDER: 'web.template_issue_repeated',
  UNKNOWN_ICON: 'web.template_issue_unknown_icon',
};

/** The named segments of a path, innermost first (`items.2.amountMinor` → amountMinor, items). */
function segmentsOf(path: string): string[] {
  return path
    .split('.')
    .filter((segment) => segment !== '' && !/^\d+$/u.test(segment))
    .reverse();
}

/**
 * The Persian sentence for a refused field, by its validation path.
 *
 * The innermost named segment that has a name wins (`inboundTags.vless` is the inbound tags
 * field): first the page's labels (the full path, then each segment), then a rule the shared
 * table can say outright, then the shared labels. A path nothing names gets a generic sentence.
 */
export function fieldText(
  path: string | undefined,
  fieldLabels: Readonly<Record<string, WebKey>> = {},
): string {
  if (path === undefined || path === '') return t('web.err_field_unknown');
  const named = (label: WebKey) => t('web.err_field_invalid').replace('{field}', t(label));
  const segments = segmentsOf(path);
  const own = fieldLabels[path] ?? segments.map((segment) => fieldLabels[segment]).find(Boolean);
  if (own !== undefined) return named(own);
  for (const segment of segments) {
    const rule = FIELD_RULES[segment];
    if (rule !== undefined) return t(rule);
    const shared = FIELD_LABELS[segment];
    if (shared !== undefined) return named(shared);
  }
  return t('web.err_field_unknown');
}

/**
 * The structured issues behind a refusal, each as a Persian sentence.
 *
 * Three shapes arrive in `details.issues`: the request schema's `{ path, message }`, a
 * template body's `{ kind, token, detail }`, and a setting schema's plain strings. Zod's and
 * the server's English is never the sentence; it is kept in `raw` for «جزئیات فنی».
 */
export function errorIssues(
  error: unknown,
  fieldLabels: Readonly<Record<string, WebKey>> = {},
): ErrorIssue[] {
  if (!(error instanceof ApiError)) return [];
  const issues = error.details?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((issue): ErrorIssue => {
    if (typeof issue === 'string') return { text: t('web.err_issue_generic'), raw: issue };
    const shaped = (typeof issue === 'object' && issue !== null ? issue : {}) as {
      kind?: unknown;
      token?: unknown;
      detail?: unknown;
      path?: unknown;
      message?: unknown;
    };
    if (typeof shaped.kind === 'string' && TEMPLATE_ISSUE_TEXT[shaped.kind] !== undefined) {
      const key = TEMPLATE_ISSUE_TEXT[shaped.kind] as WebKey;
      const raw = typeof shaped.detail === 'string' ? shaped.detail : null;
      return typeof shaped.token === 'string'
        ? { text: t(key), token: shaped.token, raw }
        : { text: t(key), raw };
    }
    const path = typeof shaped.path === 'string' ? shaped.path : undefined;
    const message =
      typeof shaped.message === 'string'
        ? shaped.message
        : typeof shaped.detail === 'string'
          ? shaped.detail
          : null;
    const raw =
      message === null
        ? JSON.stringify(issue)
        : path === undefined || path === ''
          ? message
          : `${path}: ${message}`;
    return {
      text: path === undefined ? t('web.err_issue_generic') : fieldText(path, fieldLabels),
      raw,
    };
  });
}

/** The code and correlation id, for the small left-to-right line under a sentence. */
export function errorReference(
  error: unknown,
): { readonly code: string; readonly correlationId: string | null } | null {
  if (!(error instanceof ApiError)) return null;
  return { code: error.code, correlationId: error.correlationId ?? null };
}
