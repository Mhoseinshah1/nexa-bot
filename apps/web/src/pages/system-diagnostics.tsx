import { useQuery } from '@tanstack/react-query';
import type { StuckOperationReason, SystemDiagnosticsResponse } from '@nexa/contracts';
import { EVENT_TYPES, STUCK_OPERATION_REASONS, type EventType } from '@nexa/contracts';
import { fetchSystemDiagnostics } from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { RecordLink, recordHref } from '../ui/record-ref';
import {
  Badge,
  Banner,
  Card,
  DataTable,
  Empty,
  StatCard,
  Ltr,
  Num,
  StateSwitch,
  type Column,
} from '../ui/kit';
import { pollUnlessFinal } from '../polling';
import { OPERATION_STATE_LABELS, OPERATION_TYPE_LABELS } from './services';
import { ProviderText } from '../ui/technical-details';

/**
 * What is stuck, and where (WP16 D3, `docs/wp16-admin-ops-audit.md`).
 *
 * Read-only by design. Every row names the thing it is about and links to where an
 * operator can act on it through that thing's own guarded action — a stuck operation
 * links to its service, whose reconcile and retry-provision keep their state machines.
 * There is no button here that changes anything, so there is nothing here that could
 * force an outcome. This is a queue view, not the general log page the owner removed.
 */

const REASON_LABELS: Readonly<Record<StuckOperationReason, WebKey>> = {
  UNKNOWN_OUTCOME: 'web.diagnostics_reason_unknown',
  LEASE_EXPIRED: 'web.diagnostics_reason_lease',
  RETRYING: 'web.diagnostics_reason_retrying',
  UNANNOUNCED: 'web.diagnostics_reason_unannounced',
};

const REASON_HINTS: Readonly<Record<StuckOperationReason, WebKey>> = {
  UNKNOWN_OUTCOME: 'web.diagnostics_reason_unknown_hint',
  LEASE_EXPIRED: 'web.diagnostics_reason_lease_hint',
  RETRYING: 'web.diagnostics_reason_retrying_hint',
  UNANNOUNCED: 'web.diagnostics_reason_unannounced_hint',
};

type StuckRow = SystemDiagnosticsResponse['provisioning']['sample'][number];
type FailingRow = SystemDiagnosticsResponse['outbox']['failingSample'][number];

/**
 * W5: an outbox row's event and aggregate types as Persian names. The event map is total
 * over `EVENT_TYPES`; an unknown aggregate or event falls back to the raw value.
 */
export const OUTBOX_EVENT_LABELS: Readonly<Record<EventType, WebKey>> = {
  SystemPinged: 'web.outbox_event_system_pinged',
  TenantCreated: 'web.outbox_event_tenant_created',
  TenantStatusChanged: 'web.outbox_event_tenant_status_changed',
  BotInstanceRegistered: 'web.outbox_event_bot_instance_registered',
  BotInstanceStatusChanged: 'web.outbox_event_bot_instance_status_changed',
  SettingChanged: 'web.outbox_event_setting_changed',
  PermissionDenied: 'web.outbox_event_permission_denied',
  AdminCreated: 'web.outbox_event_admin_created',
  AdminStatusChanged: 'web.outbox_event_admin_status_changed',
  AdminRolesChanged: 'web.outbox_event_admin_roles_changed',
  AdminPasswordChanged: 'web.outbox_event_admin_password_changed',
  TemplateOverrideChanged: 'web.outbox_event_template_override_changed',
  TemplateOverrideReverted: 'web.outbox_event_template_override_reverted',
  FeatureFlagChanged: 'web.outbox_event_feature_flag_changed',
  OpsLogGroupChanged: 'web.outbox_event_ops_log_group_changed',
  CustomerRegistered: 'web.outbox_event_customer_registered',
  CustomerBlocked: 'web.outbox_event_customer_blocked',
  CustomerUnblocked: 'web.outbox_event_customer_unblocked',
  CustomerMarketingOptOutChanged: 'web.outbox_event_customer_marketing_opt_out_changed',
  CustomerReminderOptOutChanged: 'web.outbox_event_customer_reminder_opt_out_changed',
  CustomerChannelMembershipExemptionChanged:
    'web.outbox_event_customer_channel_membership_exemption_changed',
  CustomerPhoneVerificationChanged: 'web.outbox_event_customer_phone_verification_changed',
  CustomerLocationChangeOverrideChanged:
    'web.outbox_event_customer_location_change_override_changed',
  CustomerPersonalDiscountChanged: 'web.outbox_event_customer_personal_discount_changed',
  CustomerImported: 'web.outbox_event_customer_imported',
  CustomerAccountTransferred: 'web.outbox_event_customer_account_transferred',
  TermsVersionPublished: 'web.outbox_event_terms_version_published',
  CustomerTermsAccepted: 'web.outbox_event_customer_terms_accepted',
  CustomerTagChanged: 'web.outbox_event_customer_tag_changed',
  CustomerTagAssigned: 'web.outbox_event_customer_tag_assigned',
  CustomerTagRemoved: 'web.outbox_event_customer_tag_removed',
  CustomerNoteAdded: 'web.outbox_event_customer_note_added',
  OrderConfirmed: 'web.outbox_event_order_confirmed',
  OrderSettled: 'web.outbox_event_order_settled',
  OrderCancelled: 'web.outbox_event_order_cancelled',
  OrderRefunded: 'web.outbox_event_order_refunded',
  PaymentConfirmed: 'web.outbox_event_payment_confirmed',
  PaymentOutcomeUnknown: 'web.outbox_event_payment_outcome_unknown',
  PaymentReceiptSubmitted: 'web.outbox_event_payment_receipt_submitted',
  PaymentFailed: 'web.outbox_event_payment_failed',
  PaymentLateCompletionObserved: 'web.outbox_event_payment_late_completion_observed',
  PaymentLateCredited: 'web.outbox_event_payment_late_credited',
  GatewayPaymentAttentionRaised: 'web.outbox_event_gateway_payment_attention_raised',
  RefundCompleted: 'web.outbox_event_refund_completed',
  RefundFailed: 'web.outbox_event_refund_failed',
  ServiceRefundRequested: 'web.outbox_event_service_refund_requested',
  ServiceRefundRequestResolved: 'web.outbox_event_service_refund_request_resolved',
  WalletEntryRecorded: 'web.outbox_event_wallet_entry_recorded',
  ServiceProvisioned: 'web.outbox_event_service_provisioned',
  ServiceStateChanged: 'web.outbox_event_service_state_changed',
  ServiceSubscriptionRotated: 'web.outbox_event_service_subscription_rotated',
  ServiceOwnershipTransferred: 'web.outbox_event_service_ownership_transferred',
  ServiceLocationChanged: 'web.outbox_event_service_location_changed',
  ProvisioningOutcomeUnknown: 'web.outbox_event_provisioning_outcome_unknown',
  DiscountRedeemed: 'web.outbox_event_discount_redeemed',
  CashbackEarned: 'web.outbox_event_cashback_earned',
  CashbackReversed: 'web.outbox_event_cashback_reversed',
  ReferralAttributed: 'web.outbox_event_referral_attributed',
  ReferralRewarded: 'web.outbox_event_referral_rewarded',
  ReferralCommissionReversed: 'web.outbox_event_referral_commission_reversed',
  TrialIssued: 'web.outbox_event_trial_issued',
  TicketOpened: 'web.outbox_event_ticket_opened',
  TicketMessagePosted: 'web.outbox_event_ticket_message_posted',
  TicketStatusChanged: 'web.outbox_event_ticket_status_changed',
  TicketAssigned: 'web.outbox_event_ticket_assigned',
  BroadcastStateChanged: 'web.outbox_event_broadcast_state_changed',
  BulkOperationStateChanged: 'web.outbox_event_bulk_operation_state_changed',
  CustomerDirectMessageQueued: 'web.outbox_event_customer_direct_message_queued',
  IncidentStateChanged: 'web.outbox_event_incident_state_changed',
  LegacyImportReviewStateChanged: 'web.outbox_event_legacy_import_review_state_changed',
  ServiceAdopted: 'web.outbox_event_service_adopted',
  ResellerStandingChanged: 'web.outbox_event_reseller_standing_changed',
  GiftCardBatchCreated: 'web.outbox_event_gift_card_batch_created',
  GiftCardRedeemed: 'web.outbox_event_gift_card_redeemed',
  GiftCardBatchDisabled: 'web.outbox_event_gift_card_batch_disabled',
  ServiceAutoRenewChanged: 'web.outbox_event_service_auto_renew_changed',
  ServiceAutoRenewRunSettled: 'web.outbox_event_service_auto_renew_run_settled',
};

export const OUTBOX_AGGREGATE_LABELS: Readonly<Record<string, WebKey>> = {
  Admin: 'web.outbox_aggregate_admin',
  BotInstance: 'web.outbox_aggregate_bot_instance',
  Broadcast: 'web.outbox_aggregate_broadcast',
  BulkOperation: 'web.outbox_aggregate_bulk_operation',
  Customer: 'web.outbox_aggregate_customer',
  CustomerTag: 'web.outbox_aggregate_customer_tag',
  Discount: 'web.outbox_aggregate_discount',
  FeatureFlag: 'web.outbox_aggregate_feature_flag',
  GiftCardBatch: 'web.outbox_aggregate_gift_card_batch',
  Incident: 'web.outbox_aggregate_incident',
  LegacyImportMapRow: 'web.outbox_aggregate_legacy_import_map_row',
  OpsLogGroup: 'web.outbox_aggregate_ops_log_group',
  Order: 'web.outbox_aggregate_order',
  Payment: 'web.outbox_aggregate_payment',
  Referral: 'web.outbox_aggregate_referral',
  Service: 'web.outbox_aggregate_service',
  Setting: 'web.outbox_aggregate_setting',
  System: 'web.outbox_aggregate_system',
  Template: 'web.outbox_aggregate_template',
  TermsVersion: 'web.outbox_aggregate_terms_version',
  Ticket: 'web.outbox_aggregate_ticket',
  Trial: 'web.outbox_aggregate_trial',
  Wallet: 'web.outbox_aggregate_wallet',
};

function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

/** A Persian name with the raw type in its tooltip; an unknown type is drawn as itself. */
function TypeName({ value, known }: { value: string; known: WebKey | undefined }) {
  return known === undefined ? <Ltr>{value}</Ltr> : <span title={value}>{t(known)}</span>;
}

export function DiagnosticsSection({ denied }: { denied: boolean }) {
  const diagnostics = useQuery({
    queryKey: ['system-diagnostics'],
    queryFn: fetchSystemDiagnostics,
    enabled: !denied,
    refetchInterval: pollUnlessFinal(30_000),
  });
  const data = diagnostics.data;

  const stuckColumns: readonly Column<StuckRow>[] = [
    {
      key: 'reason',
      header: t('web.diagnostics_reason'),
      render: (row) => (
        <Badge tone={row.reason === 'RETRYING' ? 'warn' : 'danger'} dot>
          {t(REASON_LABELS[row.reason])}
        </Badge>
      ),
    },
    {
      key: 'operation',
      header: t('web.diagnostics_operation'),
      render: (row) => (
        <span>
          {t(OPERATION_TYPE_LABELS[row.type])} · {t(OPERATION_STATE_LABELS[row.state])}
        </span>
      ),
    },
    {
      key: 'attempts',
      header: t('web.diagnostics_attempts'),
      align: 'end',
      render: (row) => <Num value={row.attempts} />,
    },
    {
      key: 'updated',
      header: t('web.diagnostics_since'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.updatedAt)}</span>,
    },
    {
      key: 'service',
      header: t('web.diagnostics_service'),
      render: (row) => (
        <RecordLink href={recordHref.service(row.serviceId)} id={row.serviceId} code={null} />
      ),
    },
  ];

  const failingColumns: readonly Column<FailingRow>[] = [
    {
      key: 'event',
      header: t('web.diagnostics_event'),
      render: (row) => (
        <TypeName
          value={row.eventType}
          known={isEventType(row.eventType) ? OUTBOX_EVENT_LABELS[row.eventType] : undefined}
        />
      ),
    },
    {
      key: 'aggregate',
      header: t('web.diagnostics_aggregate'),
      render: (row) => (
        <TypeName value={row.aggregateType} known={OUTBOX_AGGREGATE_LABELS[row.aggregateType]} />
      ),
    },
    {
      key: 'attempts',
      header: t('web.diagnostics_attempts'),
      align: 'end',
      render: (row) => <Num value={row.attempts} />,
    },
    {
      key: 'occurred',
      header: t('web.diagnostics_occurred'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.occurredAt)}</span>,
    },
    {
      // WP20: when the relay tries it next, or that it no longer will.
      key: 'next',
      header: t('web.diagnostics_next_attempt'),
      render: (row) =>
        row.exhausted ? (
          <Badge tone="danger">{t('web.diagnostics_no_more_attempts')}</Badge>
        ) : row.nextAttemptAt === null ? (
          <span className="faint">—</span>
        ) : (
          <span className="nowrap">{formatTimestamp(row.nextAttemptAt)}</span>
        ),
    },
    {
      key: 'error',
      header: t('web.diagnostics_error'),
      render: (row) =>
        row.lastError === null ? (
          <span className="faint">—</span>
        ) : (
          <ProviderText summary={'web.err_provider_outbox'} text={row.lastError} />
        ),
    },
  ];

  return (
    <>
      <Card
        title={t('web.diagnostics_provisioning_title')}
        hint={t('web.diagnostics_provisioning_hint')}
      >
        <StateSwitch
          query={diagnostics}
          denied={denied}
          isEmpty={data !== undefined && data.provisioning.sample.length === 0}
          empty={<Empty title={t('web.diagnostics_provisioning_empty')} icon="inbox" />}
        >
          {data !== undefined && (
            <>
              <div className="stat-grid diagnostics-stats">
                {STUCK_OPERATION_REASONS.map((reason) => (
                  <StatCard
                    key={reason}
                    label={t(REASON_LABELS[reason])}
                    value={<Num value={data.provisioning.counts[reason]} />}
                    hint={t(REASON_HINTS[reason])}
                    {...(data.provisioning.counts[reason] > 0
                      ? { tone: reason === 'RETRYING' ? ('warn' as const) : ('alert' as const) }
                      : {})}
                  />
                ))}
              </div>
              <DataTable
                caption={t('web.diagnostics_provisioning_title')}
                columns={stuckColumns}
                rows={data.provisioning.sample}
                rowKey={(row) => row.operationId}
                dense
              />
            </>
          )}
        </StateSwitch>
        <p className="muted small">{t('web.diagnostics_provisioning_rule')}</p>
      </Card>

      <Card title={t('web.diagnostics_outbox_title')} hint={t('web.diagnostics_outbox_hint')}>
        <StateSwitch query={diagnostics} denied={denied}>
          {data !== undefined && (
            <>
              <div className="stat-grid diagnostics-stats">
                <StatCard
                  label={t('web.diagnostics_outbox_pending')}
                  value={<Num value={data.outbox.pending} />}
                  hint={
                    data.outbox.oldestPendingAt === null
                      ? undefined
                      : `${t('web.diagnostics_outbox_oldest')}: ${formatTimestamp(data.outbox.oldestPendingAt)}`
                  }
                />
                <StatCard
                  label={t('web.diagnostics_outbox_failing')}
                  value={<Num value={data.outbox.failing} />}
                  {...(data.outbox.failing > 0 ? { tone: 'warn' as const } : {})}
                />
                <StatCard
                  label={t('web.diagnostics_outbox_exhausted')}
                  value={<Num value={data.outbox.exhausted} />}
                  {...(data.outbox.exhausted > 0 ? { tone: 'alert' as const } : {})}
                />
              </div>
              {data.outbox.failing > 0 && (
                <Banner tone="warn">{t('web.diagnostics_outbox_failing_banner')}</Banner>
              )}
              {data.outbox.exhausted > 0 && (
                <Banner tone="danger">{t('web.diagnostics_outbox_exhausted_banner')}</Banner>
              )}
              {data.outbox.failingSample.length > 0 && (
                <DataTable
                  caption={t('web.diagnostics_outbox_title')}
                  columns={failingColumns}
                  rows={data.outbox.failingSample}
                  rowKey={(row) => row.id}
                  dense
                />
              )}
            </>
          )}
        </StateSwitch>
      </Card>
    </>
  );
}
