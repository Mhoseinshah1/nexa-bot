import { describe, expect, it } from 'vitest';
import {
  OPS_ERROR_EVENTS,
  opsErrorClassOf,
  opsLogTopicForCode,
  type OpsLogTopicCategory,
} from '@nexa/contracts';
import {
  DETAIL_KEYS,
  operationalEventDetails,
} from '../../apps/api/src/modules/control/notifications/application/event-details';

/**
 * FIX-03 (batch 2026-10-10): "a message reaches its own topic", pinned for EVERY code the
 * taxonomy classifies.
 *
 * The audit found two codes in the wrong topic that nothing caught: five `support.` codes
 * fell through to SYSTEM, and `payments.gateway_webhook_unverified` was presented as
 * SECURITY while routed to PAYMENTS — the class policy's comment said otherwise. A route
 * moved or deleted, or a code added to `OPS_ERROR_EVENTS` without a decision about its
 * topic, now fails here by name. A family code (`prefix: true`) is checked with a member.
 */
const EXPECTED: Readonly<Record<string, OpsLogTopicCategory>> = {
  'payments.gateway_link_create_failed': 'PAYMENTS',
  'payments.gateway_create_unknown': 'PAYMENTS',
  'payments.gateway_misconfigured': 'PAYMENTS',
  'payments.gateway_configured': 'PAYMENTS',
  'payments.gateway_late_completion': 'PAYMENTS',
  'payments.gateway_identity_mismatch': 'PAYMENTS',
  'payments.gateway_charge_unmatched': 'PAYMENTS',
  'payments.gateway_receipt_unknown': 'PAYMENTS',
  'payments.gateway_card_change_unknown': 'PAYMENTS',
  'payments.gateway_review_unresolved': 'PAYMENTS',
  'payments.gateway_review_reconciled': 'PAYMENTS',
  'payments.gateway_webhook_unverified': 'SECURITY',
  'payments.gateway_webhook_verified': 'SECURITY',
  'payments.receipt_push_failed': 'PAYMENTS',
  'payments.receipt_push_ok': 'PAYMENTS',
  'payments.refund_request_push_failed': 'PAYMENTS',
  'payments.refund_request_push_ok': 'PAYMENTS',
  'fx.quote_unavailable': 'PAYMENTS',
  'fx.quote_rejected': 'PAYMENTS',
  'fx.source_unavailable': 'PAYMENTS',
  'fx.fallback_in_use': 'PAYMENTS',
  'fx.stale_quote_used': 'PAYMENTS',
  'order.refunded_undeliverable': 'PAYMENTS',
  'provisioning.stalled': 'SERVICES',
  'provisioning.delivered': 'SERVICES',
  'panel.health.': 'PANELS',
  'panel.capacity.full': 'PANELS',
  'panel.capacity.warning': 'PANELS',
  'panel.capacity.recovered': 'PANELS',
  'panel.monitor.tenant_budget_exceeded': 'PANELS',
  'panel.monitor.tenant_budget_ok': 'PANELS',
  'panel.monitor.scheduler_capacity_exceeded': 'PANELS',
  'panel.monitor.scheduler_capacity_ok': 'PANELS',
  'panel.probe.limited': 'PANELS',
  'panel.probe.ok': 'PANELS',
  'telegram.customer_send_failed': 'BOT',
  'telegram.customer_send_ok': 'BOT',
  'telegram.appearance_decoration_failed': 'BOT',
  'telegram.appearance_decoration_ok': 'BOT',
  'telegram.turn_failed': 'BOT',
  'telegram.ops_group_update_failed': 'BOT',
  'telegram.message_retention_failing': 'BOT',
  'telegram.message_retention_recovered': 'BOT',
  'channels.membership_unavailable': 'BOT',
  'channels.membership_recovered': 'BOT',
  'support.business_update_failed': 'BOT',
  'support.business_connection.unusable': 'BOT',
  'support.business_connection.usable': 'BOT',
  'support.handoff_required': 'BOT',
  'support.handoff_resolved': 'BOT',
  'antispam.customer_blocked': 'SECURITY',
  'antispam.unavailable': 'SECURITY',
  'antispam.recovered': 'SECURITY',
  'bot.token_replacement_incomplete': 'BOT',
  'bot.token_replacement_completed': 'BOT',
  'bot.command_sync_failing': 'BOT',
  'bot.command_sync_recovered': 'BOT',
  'bot_menu.published_unreadable': 'BOT',
  'bot_menu.published_readable': 'BOT',
  'settings.stored_value_invalid': 'SYSTEM',
  'settings.stored_value_valid': 'SYSTEM',
  'access.permission_denied': 'SECURITY',
  'auth.login_locked_out': 'SECURITY',
  'admin.': 'SECURITY',
  'outbox.message_exhausted': 'SYSTEM',
  'notification.sweep_withdrawn': 'SYSTEM',
  'ops_group.topic_recreated': 'SYSTEM',
  'job.loop_stalled': 'SYSTEM',
  'job.loop_recovered': 'SYSTEM',
  'internal.unhandled': 'ERRORS',
  'backup.run_failed': 'BACKUPS',
  'backup.run_ok': 'BACKUPS',
  'backup.delivery_failed': 'BACKUPS',
  'backup.delivery_ok': 'BACKUPS',
  'backup.cleanup_failed': 'BACKUPS',
  'backup.cleanup_ok': 'BACKUPS',
  'backup.disk_threshold_exceeded': 'BACKUPS',
  'backup.disk_threshold_ok': 'BACKUPS',
  'backup.interval_exceeded': 'BACKUPS',
  'backup.interval_ok': 'BACKUPS',
  'recovery.run_failed': 'BACKUPS',
  'recovery.run_ok': 'BACKUPS',
  'incident.': 'SYSTEM',
  'maintenance.': 'SYSTEM',
  'system.ping': 'SYSTEM',
};

/** A family code is routed by its members; the family prefix itself is not a code. */
const member = (code: string, prefix: boolean | undefined): string =>
  prefix === true ? `${code}example` : code;

describe('every classified code reaches its own topic (FIX-03)', () => {
  it('lists exactly the codes the taxonomy classifies', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(OPS_ERROR_EVENTS.map((e) => e.code).sort());
  });

  it.each(OPS_ERROR_EVENTS.map((entry) => [entry.code, entry.prefix] as const))(
    '%s',
    (code, prefix) => {
      expect(opsLogTopicForCode(member(code, prefix))).toBe(EXPECTED[code]);
    },
  );

  it('sends every code PRESENTED as SECURITY to the SECURITY topic', () => {
    for (const entry of OPS_ERROR_EVENTS) {
      if (entry.eventClass !== 'SECURITY') continue;
      expect(opsLogTopicForCode(member(entry.code, entry.prefix)), entry.code).toBe('SECURITY');
    }
    expect(opsErrorClassOf('payments.gateway_webhook_unverified', 'WARN')).toBe('SECURITY');
  });

  it('keeps a recovery in the same topic as the failure it closes', () => {
    for (const entry of OPS_ERROR_EVENTS) {
      if (entry.recovers === undefined) continue;
      expect(opsLogTopicForCode(entry.code), entry.code).toBe(opsLogTopicForCode(entry.recovers));
    }
  });

  it('keeps the support assistant role’s stall in SYSTEM, beside the other roles’ stalls', () => {
    expect(opsLogTopicForCode('support.assistant.stalled')).toBe('SYSTEM');
  });

  it('keeps the support AI provider’s health in SYSTEM, not with customer conversations', () => {
    // Recorded by credential-alert.ts and support-ai-chain.ts, outside OPS_ERROR_EVENTS, so the
    // exhaustive list above cannot see them (Codex review of the routing PR).
    for (const code of [
      'support.ai_provider.credential_rejected',
      'support.ai_provider.credential_accepted',
      'support.ai_provider.unavailable',
      'support.ai_provider.available',
    ]) {
      expect(opsLogTopicForCode(code), code).toBe('SYSTEM');
    }
    expect(opsLogTopicForCode('support.business_update_failed')).toBe('BOT');
  });
});

describe('operationType is an allow-listed detail (FIX-03)', () => {
  it('prints the operation type an event names, after its id', () => {
    expect(DETAIL_KEYS.indexOf('operationType')).toBe(DETAIL_KEYS.indexOf('operationId') + 1);
    expect(
      operationalEventDetails({ serviceId: 'svc-1', operationType: 'RENEW', secret: 'x' }),
    ).toBe('serviceId: svc-1\noperationType: RENEW');
  });
});
