import type { SecretPurpose, SecretReentryItem } from '@nexa/contracts';
import { paymentMethodSlugOf } from '@nexa/contracts';
import type { WebKey } from './i18n/web.fa';

/** Each kind of stored secret in words. Total over the contract's list: a new purpose does not compile without one. */
export const SECRET_PURPOSE_LABELS: Readonly<Record<SecretPurpose, WebKey>> = {
  'bot_instance.token': 'web.secret_purpose_bot_instance_token',
  'panel.username': 'web.secret_purpose_panel_username',
  'panel.password': 'web.secret_purpose_panel_password',
  'panel.api_token': 'web.secret_purpose_panel_api_token',
  'payment_gateway.api_key': 'web.secret_purpose_gateway_api_key',
  'payment_gateway.webhook_secret': 'web.secret_purpose_gateway_webhook_secret',
  'payment_gateway.verify_key': 'web.secret_purpose_gateway_verify_key',
  'payment_gateway.refund_card': 'web.secret_purpose_gateway_refund_card',
  'admin.totp_secret': 'web.secret_purpose_admin_totp',
  'support_ai_provider.api_key': 'web.secret_purpose_support_ai_key',
  'legacy_migration.package_key': 'web.secret_purpose_legacy_package_key',
  'backup.archive_password': 'web.secret_purpose_backup_password',
  'gift_card.batch_export': 'web.secret_purpose_gift_card_export',
  'hosting.totp_secret': 'web.secret_purpose_hosting_totp',
  'hosting.archive_password': 'web.secret_purpose_hosted_archive_password',
  'hosting.reseller_bot_token': 'web.secret_purpose_reseller_bot_token',
  'hosting.reseller_activation_link': 'web.secret_purpose_reseller_activation_link',
};

/** The one purpose a restore can never clear (the API refuses it): a refund's sealed card. */
export const UNCLEARABLE_SECRET_PURPOSES: readonly SecretPurpose[] = [
  'payment_gateway.refund_card',
];

/**
 * Where an item is entered again. The API names a route KEY; the paths are this app's.
 * A gateway row without a known provider opens the list of payment methods.
 */
export function secretReentryHref(item: SecretReentryItem): string {
  switch (item.reenterAt) {
    case 'bots':
      return '/bots';
    case 'panels':
      return `/panels/${encodeURIComponent(item.entityId)}`;
    case 'payment-gateways': {
      const slug = item.provider === null ? null : paymentMethodSlugOf(item.provider);
      return slug === null ? '/payment-gateways' : `/payment-gateways/${slug}`;
    }
    case 'recovery':
      return '/recovery';
    case 'support-ai':
      return '/support-ai';
    case 'account':
      return '/account';
    case 'hosting':
      return '/hosting';
  }
}
