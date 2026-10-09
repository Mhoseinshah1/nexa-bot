import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  NOTIFICATION_SUMMARY_REFRESH_MS,
  visibleNotificationCategories,
  type InboxLink,
  type InboxNotification,
  type NotificationCategory,
  type OperationalSeverity,
  type PermissionKey,
} from '@nexa/contracts';
import { fetchInbox, fetchInboxSummary, markAllInbox, markInbox } from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { messageFor } from './settings';
import { Icon } from '../ui/icons';
import {
  Badge,
  Banner,
  Button,
  Card,
  CursorPager,
  Disclosure,
  Empty,
  KV,
  Ltr,
  PageHead,
  Pills,
  Select,
  StateSwitch,
  Num,
  useToast,
  type Tone,
} from '../ui/kit';

/*
 * Phase B3 — the Web Admin Notification Center (`docs/notification-center.md`).
 *
 * The inbox is a projection of the operations log through `NOTIFICATION_RULES`: the server
 * decides which events are notifications, which of them this administrator may see and
 * whether each is read. The page draws what arrives — including the deep link, which the
 * server derives from the event's typed subject and this page only turns into a path.
 */

export const CATEGORY_LABELS: Readonly<Record<NotificationCategory, WebKey>> = {
  PAYMENTS: 'web.nc_cat_payments',
  GATEWAYS: 'web.nc_cat_gateways',
  PANELS: 'web.nc_cat_panels',
  PROVISIONING: 'web.nc_cat_provisioning',
  BACKUPS: 'web.nc_cat_backups',
  RECOVERY: 'web.nc_cat_recovery',
  SECURITY: 'web.nc_cat_security',
  INCIDENTS: 'web.nc_cat_incidents',
  SUPPORT: 'web.nc_cat_support',
  SUPPORT_AI: 'web.nc_cat_support_ai',
};

const SEVERITY_LABELS: Readonly<Record<OperationalSeverity, WebKey>> = {
  DEBUG: 'web.nc_sev_debug',
  INFO: 'web.nc_sev_info',
  WARN: 'web.nc_sev_warn',
  ERROR: 'web.nc_sev_error',
  CRITICAL: 'web.nc_sev_critical',
};

export const SEVERITY_TONES: Readonly<Record<OperationalSeverity, Tone>> = {
  DEBUG: 'neutral',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'danger',
  CRITICAL: 'danger',
};

/** A Persian title per notifiable code; a prefix rule's codes share their family's. */
const TITLES: Readonly<Record<string, WebKey>> = {
  'payments.gateway_review_unresolved': 'web.nc_t_review_unresolved',
  'payments.gateway_create_unknown': 'web.nc_t_create_unknown',
  'payments.gateway_receipt_unknown': 'web.nc_t_receipt_unknown',
  'payments.gateway_card_change_unknown': 'web.nc_t_card_change_unknown',
  'payments.gateway_late_completion': 'web.nc_t_late_completion',
  'payments.gateway_identity_mismatch': 'web.nc_t_identity_mismatch',
  'payments.gateway_charge_unmatched': 'web.nc_t_charge_unmatched',
  'payments.receipt_push_failed': 'web.nc_t_receipt_push_failed',
  'payments.refund_request_push_failed': 'web.nc_t_refund_push_failed',
  'payments.gateway_misconfigured': 'web.nc_t_gateway_misconfigured',
  'payments.gateway_link_create_failed': 'web.nc_t_gateway_link_create_failed',
  'payments.gateway_webhook_unverified': 'web.nc_t_webhook_unverified',
  'panel.monitor.tenant_budget_exceeded': 'web.nc_t_panel_budget',
  'provisioning.stalled': 'web.nc_t_provisioning_stalled',
  'order.refunded_undeliverable': 'web.nc_t_refunded_undeliverable',
  'backup.run_failed': 'web.nc_t_backup_failed',
  'backup.delivery_failed': 'web.nc_t_backup_delivery_failed',
  'backup.cleanup_failed': 'web.nc_t_backup_cleanup_failed',
  'backup.disk_threshold_exceeded': 'web.nc_t_backup_disk_low',
  'backup.interval_exceeded': 'web.nc_t_backup_overdue',
  'recovery.run_failed': 'web.nc_t_recovery_failed',
  'auth.login_locked_out': 'web.nc_t_login_locked_out',
  'admin.created': 'web.nc_t_admin_created',
  'admin.roles_changed': 'web.nc_t_admin_roles',
  'admin.status_changed': 'web.nc_t_admin_status',
  'admin.password_reset': 'web.nc_t_admin_password_reset',
  'admin.sessions_revoked': 'web.nc_t_admin_sessions',
  // TB10: the support agent.
  'support.handoff_required': 'web.nc_t_support_handoff',
  'support.business_connection.unusable': 'web.nc_t_support_connection',
  'support.ai_provider.credential_rejected': 'web.nc_t_support_key_rejected',
  'support.ai_provider.unavailable': 'web.nc_t_support_ai_unavailable',
  // D5: the assistant role is not claiming due AI work.
  'support.assistant.stalled': 'web.nc_t_support_assistant_stalled',
};

const PREFIX_TITLES: readonly (readonly [string, WebKey])[] = [
  ['panel.capacity.', 'web.nc_t_panel_capacity'],
  ['panel.', 'web.nc_t_panel'],
  ['incident.', 'web.nc_t_incident'],
  ['maintenance.', 'web.nc_t_incident'],
];

export function titleOf(code: string, category: NotificationCategory): string {
  const exact = TITLES[code];
  if (exact !== undefined) return t(exact);
  const prefixed = PREFIX_TITLES.find(([prefix]) => code.startsWith(prefix));
  return prefixed === undefined ? t(CATEGORY_LABELS[category]) : t(prefixed[1]);
}

/** The path a deep link opens. The id is a UUID by the contract's own schema. */
export function pathOf(link: InboxLink): string {
  const id = link.id === null ? '' : encodeURIComponent(link.id);
  switch (link.target) {
    case 'PAYMENT':
      return id === '' ? '/payments' : `/payments/${id}`;
    case 'PANEL':
      return id === '' ? '/panels' : `/panels/${id}`;
    case 'SERVICE':
      return id === '' ? '/services' : `/services/${id}`;
    case 'ORDER':
      return id === '' ? '/orders' : `/orders/${id}`;
    case 'PAYMENTS':
      return '/payments';
    case 'PAYMENT_GATEWAYS':
      return '/payment-gateways';
    case 'PANELS':
      return '/panels';
    case 'SERVICES':
      return '/services';
    case 'ORDERS':
      return '/orders';
    case 'RECOVERY':
      return '/recovery';
    case 'ADMINS':
      return '/system?section=admins';
    case 'ALERTS':
      return '/alerts';
    case 'INCIDENT':
      return id === '' ? '/incidents' : `/incidents/${id}`;
    case 'INCIDENTS':
      return '/incidents';
    case 'COMPENSATIONS':
      return '/compensations';
    case 'BUSINESS_CHAT':
      return id === '' ? '/business-chats' : `/business-chats/${id}`;
    case 'BUSINESS_CHATS':
      return '/business-chats';
    case 'SUPPORT_AI':
      return '/support-ai';
  }
}

// ---------------------------------------------------------------------------------------
// The bell
// ---------------------------------------------------------------------------------------

/** The top-bar bell: the unread count, polled, toned by the worst unread severity. */
export function NotificationBell() {
  const onLink = useLinkHandler();
  const summary = useQuery({
    queryKey: ['inbox-summary'],
    queryFn: fetchInboxSummary,
    refetchInterval: NOTIFICATION_SUMMARY_REFRESH_MS,
  });
  const unread = summary.data?.unread ?? 0;
  const label =
    unread > 0
      ? `${t('web.nc_bell')}: ${String(unread)}${summary.data?.atLeast === true ? '+' : ''} ${t('web.nc_bell_unread')}`
      : t('web.nc_bell');
  const tone =
    summary.data?.highestUnread === 'ERROR' || summary.data?.highestUnread === 'CRITICAL'
      ? 'danger'
      : 'warn';
  return (
    <a
      href="/notification-center"
      className="btn ghost icon nc-bell"
      aria-label={label}
      title={label}
      onClick={onLink}
    >
      <Icon name="bell" />
      {unread > 0 && (
        <span className={`nc-bell-count ${tone}`} aria-hidden="true">
          {unread > 99 ? '99+' : String(unread)}
          {summary.data?.atLeast === true && unread <= 99 ? '+' : ''}
        </span>
      )}
    </a>
  );
}

// ---------------------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------------------

type Show = 'ALL' | 'UNREAD';

export function NotificationCenterPage({ permissions }: { permissions: readonly PermissionKey[] }) {
  const notify = useToast();
  const queries = useQueryClient();
  const onLink = useLinkHandler();
  const categories = visibleNotificationCategories(permissions);
  const [show, setShow] = useState<Show>('UNREAD');
  const [category, setCategory] = useState<NotificationCategory | ''>('');
  const signature = `${show}|${category}`;
  const [trail, setTrail] = useState<{
    signature: string;
    cursors: readonly { at: string; id: string }[];
  }>({ signature, cursors: [] });
  const cursors = trail.signature === signature ? trail.cursors : [];
  const cursor = cursors.at(-1);

  const inbox = useQuery({
    queryKey: ['inbox', show, category, cursor ?? null],
    queryFn: () =>
      fetchInbox({
        unread: show === 'UNREAD',
        ...(category === '' ? {} : { category }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    refetchInterval: NOTIFICATION_SUMMARY_REFRESH_MS,
  });

  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['inbox'] });
    void queries.invalidateQueries({ queryKey: ['inbox-summary'] });
  };
  const mark = useMutation({
    mutationFn: markInbox,
    onSuccess: refresh,
  });
  const markAll = useMutation({
    mutationFn: () => markAllInbox(category === '' ? {} : { category }),
    onSuccess: () => {
      notify({ tone: 'ok', message: t('web.nc_mark_all_done') });
      refresh();
    },
  });

  const rows = inbox.data?.notifications ?? [];
  const next = inbox.data?.nextCursor ?? null;

  return (
    <>
      <PageHead
        title={t('web.nc_title')}
        subtitle={t('web.nc_intro')}
        actions={
          categories.length > 0 ? (
            <Button
              size="sm"
              icon="check"
              disabled={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              {t('web.nc_mark_all')}
            </Button>
          ) : undefined
        }
      />
      <div className="nc-filters">
        <Pills<Show>
          value={show}
          onChange={setShow}
          items={[
            { id: 'UNREAD', label: t('web.nc_filter_unread') },
            { id: 'ALL', label: t('web.nc_filter_all') },
          ]}
        />
        {categories.length > 1 && (
          <Select
            size="sm"
            aria-label={t('web.nc_filter_category')}
            value={category}
            onChange={(event) => setCategory(event.target.value as NotificationCategory | '')}
          >
            <option value="">{t('web.nc_category_all')}</option>
            {categories.map((one) => (
              <option key={one} value={one}>
                {t(CATEGORY_LABELS[one])}
              </option>
            ))}
          </Select>
        )}
      </div>
      {(mark.error !== null || markAll.error !== null) && (
        <Banner tone="danger">{messageFor(mark.error ?? markAll.error)}</Banner>
      )}
      <Card tight>
        <StateSwitch query={inbox}>
          {rows.length === 0 && cursors.length === 0 ? (
            <Empty
              variant="compact"
              title={show === 'UNREAD' ? t('web.nc_empty_unread') : t('web.nc_empty')}
            />
          ) : (
            <>
              <ul className="nc-list">
                {rows.map((row) => (
                  <InboxItem
                    key={row.id}
                    row={row}
                    pending={mark.isPending}
                    onToggle={() => mark.mutate({ id: row.id, read: !row.read })}
                    onOpen={(event) => {
                      if (!row.read) mark.mutate({ id: row.id, read: true });
                      onLink(event);
                    }}
                  />
                ))}
              </ul>
              {(next !== null || cursors.length > 0) && (
                <CursorPager
                  hasPrevious={cursors.length > 0}
                  hasNext={next !== null}
                  onPrevious={() => setTrail({ signature, cursors: cursors.slice(0, -1) })}
                  onNext={() => {
                    if (next !== null) setTrail({ signature, cursors: [...cursors, next] });
                  }}
                  shown={rows.length}
                />
              )}
            </>
          )}
        </StateSwitch>
      </Card>
    </>
  );
}

function InboxItem({
  row,
  pending,
  onToggle,
  onOpen,
}: {
  row: InboxNotification;
  pending: boolean;
  onToggle: () => void;
  onOpen: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const title = titleOf(row.code, row.category);
  return (
    <li className={row.read ? 'nc-item' : 'nc-item unread'} aria-label={title}>
      <div className="nc-head">
        {!row.read && <Badge tone="info">{t('web.nc_unread_badge')}</Badge>}
        <Badge tone={SEVERITY_TONES[row.severity]}>{t(SEVERITY_LABELS[row.severity])}</Badge>
        <Badge tone="neutral">{t(CATEGORY_LABELS[row.category])}</Badge>
        {row.resolvedAt !== null && <Badge tone="ok">{t('web.nc_resolved')}</Badge>}
      </div>
      <p className="nc-title strong">{title}</p>
      <p className="muted small">
        {t('web.nc_last_seen')}: {formatTimestamp(row.lastSeenAt)}
        {row.occurrenceCount > 1 && (
          <>
            {' · '}
            {t('web.nc_occurrences')}: <Num value={row.occurrenceCount} />
          </>
        )}
      </p>
      <Disclosure size="sm" summary={t('web.nc_details')}>
        <KV
          items={[
            [t('web.nc_first_seen'), formatTimestamp(row.firstSeenAt)],
            [t('web.nc_last_seen'), formatTimestamp(row.lastSeenAt)],
            [t('web.nc_occurrences'), <Num key="n" value={row.occurrenceCount} />],
            [
              t('web.nc_resolved'),
              row.resolvedAt === null
                ? t('web.nc_open_condition')
                : formatTimestamp(row.resolvedAt),
            ],
            [t('web.nc_code'), <Ltr key="c">{row.code}</Ltr>],
            [
              t('web.nc_message'),
              <Ltr key="m" mono={false}>
                {row.message}
              </Ltr>,
            ],
          ]}
        />
      </Disclosure>
      <div className="nc-actions">
        <a className="btn sm" href={pathOf(row.link)} onClick={onOpen}>
          {t('web.nc_open')}
        </a>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onToggle}>
          {row.read ? t('web.nc_mark_unread') : t('web.nc_mark_read')}
        </Button>
      </div>
    </li>
  );
}
