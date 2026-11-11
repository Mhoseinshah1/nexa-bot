import { useState } from 'react';
import { OPS_LOG_WORDS_FA } from '@nexa/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pollUnlessFinal } from '../polling';
import { keepPageWhileTurning } from '../ui/paging';
import {
  NOTIFICATION_SUMMARY_REFRESH_MS,
  visibleNotificationCategories,
  type InboxLink,
  type InboxNotification,
  type NotificationCategory,
  type OperationalSeverity,
  type PermissionKey,
} from '@nexa/contracts';
import { fetchInbox, fetchInboxSummary, fetchOpsLog, markAllInbox, markInbox } from '../api/client';
import { AlertStatusBadge, AlertsPage, alertMessage, type AlertEvent } from './alerts';
import { AttentionStrip } from '../ui/redesign';
import { PageMoreMenu } from '../ui/page-more-menu';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler, useRoute } from '../router';
import { messageFor } from './settings';
import { operationalEventMessageFa } from '@nexa/i18n';
import { Icon } from '../ui/icons';
import {
  Badge,
  Banner,
  Button,
  Card,
  CursorPager,
  Disclosure,
  Drawer,
  Empty,
  FilterChip,
  FilterChips,
  KV,
  PageHead,
  Select,
  StateSwitch,
  Num,
  useToast,
  type Tone,
  LIST_PAGE_SIZE,
} from '../ui/kit';
import { hasOpsCodeLabel, opsCodeLabel } from '../ops-code-labels';
import { CodeLabel, ErrorRef, TechnicalDetails } from '../ui/technical-details';
import { ListFilterBar } from '../ui/filter-bar';

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
  'payments.gateway_request_unknown': 'web.nc_t_request_unknown',
  'payments.gateway_row_failing': 'web.nc_t_gateway_row_failing',
  'payments.gateway_late_completion': 'web.nc_t_late_completion',
  'payments.gateway_identity_mismatch': 'web.nc_t_identity_mismatch',
  'payments.gateway_charge_unmatched': 'web.nc_t_charge_unmatched',
  'payments.gateway_charge_refunded': 'web.nc_t_charge_refunded',
  'payments.receipt_push_failed': 'web.nc_t_receipt_push_failed',
  'payments.refund_request_push_failed': 'web.nc_t_refund_push_failed',
  'payments.gateway_misconfigured': 'web.nc_t_gateway_misconfigured',
  'payments.gateway_link_create_failed': 'web.nc_t_gateway_link_create_failed',
  'payments.gateway_webhook_unverified': 'web.nc_t_webhook_unverified',
  'payments.gateway_inquiry_failing': 'web.nc_t_gateway_inquiry_failing',
  'panel.monitor.tenant_budget_exceeded': 'web.nc_t_panel_budget',
  'provisioning.stalled': 'web.nc_t_provisioning_stalled',
  'service.panel_account_missing': 'web.nc_t_service_panel_account_missing',
  'order.refunded_undeliverable': 'web.nc_t_refunded_undeliverable',
  'backup.run_failed': 'web.nc_t_backup_failed',
  'backup.delivery_failed': 'web.nc_t_backup_delivery_failed',
  'backup.delivery_partial': 'web.nc_t_backup_delivery_partial',
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

export function titleOf(
  code: string,
  category: NotificationCategory,
  operationType?: string | null,
): string {
  /*
   * R5C-2 C1: `provisioning.stalled` is recorded for every provisioning operation. Only a
   * service BUILD reads «ساخت سرویس متوقف مانده است»; any other operation is named by the
   * same Persian words the operations log uses (the shared catalogue), never a build.
   */
  if (code === 'provisioning.stalled' && operationType !== undefined && operationType !== null) {
    const named = (OPS_LOG_WORDS_FA.stalledOperation as Record<string, string | undefined>)[
      operationType
    ];
    if (named !== undefined) return named;
  }
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
      return '/notification-center?filter=open';
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

/** How many of the latest unread items the bell's drawer lists. */
const BELL_DRAWER_ITEMS = 8;

/**
 * The top-bar bell, on every page: the unread count (polled, toned by the worst unread
 * severity), which opens a drawer with the latest unread items. It was a link to the inbox;
 * the inbox is one press further, in the drawer's foot.
 *
 * Every administrator has an inbox, so nothing here is permission-gated: the server filters
 * it by the categories each administrator's permissions admit. The drawer's list is read only
 * while it is open.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
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
    <>
      <button
        type="button"
        className="btn ghost icon nc-bell"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span className={`nc-bell-count ${tone}`} aria-hidden="true">
            {unread > 99 ? '99+' : String(unread)}
            {summary.data?.atLeast === true && unread <= 99 ? '+' : ''}
          </span>
        )}
      </button>
      <BellDrawer open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function BellDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const onLink = useLinkHandler();
  const queries = useQueryClient();
  // Under the `inbox` key, so every mark (here or on the page) refreshes it.
  const latest = useQuery({
    queryKey: ['inbox', 'bell'],
    queryFn: () => fetchInbox({ limit: BELL_DRAWER_ITEMS, unread: true }),
    enabled: open,
  });
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['inbox'] });
    void queries.invalidateQueries({ queryKey: ['inbox-summary'] });
  };
  const mark = useMutation({ mutationFn: markInbox, onSuccess: refresh });
  const markAll = useMutation({ mutationFn: () => markAllInbox({}), onSuccess: refresh });
  const rows = latest.data?.notifications ?? [];
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t('web.nc_bell_drawer_title')}
      foot={
        <>
          <a
            className="btn sm"
            href="/notification-center"
            onClick={(event) => {
              onClose();
              onLink(event);
            }}
          >
            {t('web.nc_bell_drawer_all')}
          </a>
          {rows.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon="check"
              disabled={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              {t('web.nc_mark_all')}
            </Button>
          )}
        </>
      }
    >
      {(mark.error !== null || markAll.error !== null) && (
        <Banner tone="danger">
          {messageFor(mark.error ?? markAll.error)}
          <ErrorRef error={mark.error ?? markAll.error} />
        </Banner>
      )}
      <StateSwitch query={latest}>
        {rows.length === 0 ? (
          <Empty variant="compact" title={t('web.nc_bell_drawer_empty')} />
        ) : (
          <ul className="nc-list nc-bell-list">
            {rows.map((row) => (
              <li key={row.id} className="nc-item unread">
                <div className="nc-head">
                  <Badge tone={SEVERITY_TONES[row.severity]}>
                    {t(SEVERITY_LABELS[row.severity])}
                  </Badge>
                  <Badge tone="neutral">{t(CATEGORY_LABELS[row.category])}</Badge>
                </div>
                <a
                  className="nc-title strong"
                  href={pathOf(row.link)}
                  onClick={(event) => {
                    mark.mutate({ id: row.id, read: true });
                    onClose();
                    onLink(event);
                  }}
                >
                  {titleOf(row.code, row.category, row.operationType)}
                </a>
                <p className="muted small">{formatTimestamp(row.lastSeenAt)}</p>
              </li>
            ))}
          </ul>
        )}
      </StateSwitch>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------------------
// The unified list: inbox entries and management alerts
// ---------------------------------------------------------------------------------------

type Filter = 'UNREAD' | 'ALL' | 'OPEN' | 'RECORDED';

/** The `?filter=` values: a link such as `/alerts`'s redirect names the chip it lands on. */
const FILTER_PARAM: Readonly<Record<string, Filter>> = {
  unread: 'UNREAD',
  all: 'ALL',
  open: 'OPEN',
  recorded: 'RECORDED',
};

export function filterFromQuery(raw: string | null): Filter {
  return (raw !== null ? FILTER_PARAM[raw] : undefined) ?? 'UNREAD';
}

type Cursor = { at: string; id: string };

/** One row of the merged list: an inbox entry, a management alert, or both (one operational event). */
export interface FeedEntry {
  readonly id: string;
  readonly firstSeenAt: string;
  readonly inbox: InboxNotification | undefined;
  readonly alert: AlertEvent | undefined;
}

/** Newest first on the immutable `(firstSeenAt, id)` — the key BOTH feeds page on. */
function newerFirst(
  a: { firstSeenAt: string; id: string },
  b: { firstSeenAt: string; id: string },
): number {
  const byTime = Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The inbox is a projection of the operations log, and so is the alerts feed, so one
 * operational event can be in both. This lays the two newest-first pages into one list and
 * draws such an event ONCE (same id → one entry carrying both halves).
 *
 * Paging stays keyset on each feed: a row is shown only down to the newer of the two pages'
 * last rows (below it the other feed could still hold a row this page has not read), and each
 * feed's next cursor is its own last SHOWN row — so no row is skipped or drawn twice across
 * pages.
 */
export function mergeFeeds(
  inbox: readonly InboxNotification[],
  inboxMore: boolean,
  alerts: readonly AlertEvent[],
  alertsMore: boolean,
): {
  readonly entries: readonly FeedEntry[];
  readonly nextInbox: Cursor | null;
  readonly nextAlerts: Cursor | null;
  readonly hasNext: boolean;
} {
  const byId = new Map<string, { inbox?: InboxNotification; alert?: AlertEvent }>();
  for (const row of inbox) byId.set(row.id, { ...byId.get(row.id), inbox: row });
  for (const row of alerts) byId.set(row.id, { ...byId.get(row.id), alert: row });
  const all: FeedEntry[] = [...byId.entries()]
    .map(([id, halves]) => ({
      id,
      firstSeenAt: (halves.inbox?.firstSeenAt ?? halves.alert?.firstSeenAt) as string,
      inbox: halves.inbox,
      alert: halves.alert,
    }))
    .sort(newerFirst);
  // A feed that has more is only known down to its last row; the newer of those is the floor.
  const floors = [
    ...(inboxMore && inbox.length > 0 ? [inbox[inbox.length - 1]] : []),
    ...(alertsMore && alerts.length > 0 ? [alerts[alerts.length - 1]] : []),
  ] as { firstSeenAt: string; id: string }[];
  const floor = floors.sort(newerFirst)[0];
  const entries = floor === undefined ? all : all.filter((entry) => newerFirst(entry, floor) <= 0);
  const lastOf = (pick: (entry: FeedEntry) => boolean): Cursor | null => {
    const shown = entries.filter(pick);
    const last = shown[shown.length - 1];
    return last === undefined ? null : { at: last.firstSeenAt, id: last.id };
  };
  return {
    entries,
    nextInbox: lastOf((entry) => entry.inbox !== undefined),
    nextAlerts: lastOf((entry) => entry.alert !== undefined),
    hasNext: inboxMore || alertsMore || entries.length < all.length,
  };
}

export function NotificationCenterPage({ permissions }: { permissions: readonly PermissionKey[] }) {
  const notify = useToast();
  const queries = useQueryClient();
  const onLink = useLinkHandler();
  const route = useRoute();
  const categories = visibleNotificationCategories(permissions);
  // The alerts half is `GET /ops-log`, which `opslog.view` guards; without it nothing asks.
  const mayAlerts = permissions.includes('opslog.view');
  const queryFilter = route.query.get('filter');
  const [filter, setFilter] = useState<Filter>(() => filterFromQuery(queryFilter));
  // A link that names a chip (the `/alerts` redirect, the strip) moves the page that is open.
  const [seen, setSeen] = useState(queryFilter);
  if (seen !== queryFilter) {
    setSeen(queryFilter);
    if (queryFilter !== null) setFilter(filterFromQuery(queryFilter));
  }
  const [category, setCategory] = useState<NotificationCategory | ''>('');
  const inboxFeed = filter === 'UNREAD' || filter === 'ALL';
  const signature = `${filter}|${category}`;
  const [trail, setTrail] = useState<{
    signature: string;
    pages: readonly { inbox?: Cursor; alerts?: Cursor }[];
  }>({ signature, pages: [] });
  const pages = trail.signature === signature ? trail.pages : [];
  const here = pages.at(-1);
  // An alert has no inbox category, so choosing one narrows «همه» to the inbox alone.
  const withAlerts = filter === 'ALL' && mayAlerts && category === '';

  const inbox = useQuery(
    keepPageWhileTurning({
      queryKey: ['inbox', filter, category, here?.inbox ?? null],
      queryFn: () =>
        fetchInbox({
          limit: LIST_PAGE_SIZE,
          unread: filter === 'UNREAD',
          ...(category === '' ? {} : { category }),
          ...(here?.inbox === undefined ? {} : { cursor: here.inbox }),
        }),
      enabled: inboxFeed,
      refetchInterval: NOTIFICATION_SUMMARY_REFRESH_MS,
    }),
  );
  const alerts = useQuery(
    keepPageWhileTurning({
      queryKey: ['ops-log', 'management', 'inbox-merge', here?.alerts ?? null],
      queryFn: () =>
        fetchOpsLog({
          limit: LIST_PAGE_SIZE,
          scope: 'MANAGEMENT',
          ...(here?.alerts === undefined
            ? {}
            : { before: here.alerts.at, beforeId: here.alerts.id }),
        }),
      enabled: withAlerts,
      refetchInterval: pollUnlessFinal(NOTIFICATION_SUMMARY_REFRESH_MS),
    }),
  );
  // Whether any alert is open, for the red strip: one row is enough to know.
  const openProbe = useQuery({
    queryKey: ['ops-log', 'management', 'open-probe'],
    queryFn: () => fetchOpsLog({ limit: 1, scope: 'MANAGEMENT_CONDITIONS', open: true }),
    enabled: mayAlerts,
    refetchInterval: pollUnlessFinal(NOTIFICATION_SUMMARY_REFRESH_MS),
  });
  const summary = useQuery({
    queryKey: ['inbox-summary'],
    queryFn: fetchInboxSummary,
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

  const merged = withAlerts
    ? mergeFeeds(
        inbox.data?.notifications ?? [],
        inbox.data?.nextCursor != null,
        alerts.data?.events ?? [],
        alerts.data?.nextCursor != null,
      )
    : null;
  const entries: readonly FeedEntry[] =
    merged !== null
      ? merged.entries
      : (inbox.data?.notifications ?? []).map((row) => ({
          id: row.id,
          firstSeenAt: row.firstSeenAt,
          inbox: row,
          alert: undefined,
        }));
  // «بعدی» on the unified list needs BOTH feeds' current pages: advancing while one is still loading
  // (or failed) would record a cursor for a page that was never read, and skip its rows.
  const feedsReady =
    merged === null ||
    (inbox.data !== undefined &&
      alerts.data !== undefined &&
      !inbox.isPlaceholderData &&
      !alerts.isPlaceholderData);
  const next = merged !== null ? merged.hasNext && feedsReady : inbox.data?.nextCursor != null;
  const goNext = () => {
    if (merged !== null) {
      const page: { inbox?: Cursor; alerts?: Cursor } = {};
      const inboxAt = merged.nextInbox ?? here?.inbox;
      const alertsAt = merged.nextAlerts ?? here?.alerts;
      if (inboxAt !== undefined) page.inbox = inboxAt;
      if (alertsAt !== undefined) page.alerts = alertsAt;
      setTrail({ signature, pages: [...pages, page] });
    } else if (inbox.data?.nextCursor != null) {
      setTrail({ signature, pages: [...pages, { inbox: inbox.data.nextCursor }] });
    }
  };
  // The unified list reads from both feeds; it is ready when each feed it asked is.
  const feedQuery = withAlerts && alerts.isError && !inbox.isError ? alerts : inbox;

  const unread = summary.data;
  /*
   * Demo parity: what the page shows (unread / all / open alerts / recorded alerts) is the
   * first filter of the «فیلترها» panel, not a chip row above the list. «خوانده‌نشده» is the
   * default, so the filter draws no chip while it is in force. The unread count is the
   * server's, as before.
   */
  const feedItems: readonly { key: Filter; label: string; count?: number }[] = [
    {
      key: 'UNREAD',
      label: t('web.nc_filter_unread'),
      ...(unread !== undefined && !unread.atLeast ? { count: unread.unread } : {}),
    },
    { key: 'ALL', label: t('web.nc_filter_all') },
    { key: 'OPEN', label: t('web.nc_filter_open_alerts') },
    { key: 'RECORDED', label: t('web.nc_filter_recorded_alerts') },
  ];
  const hasOpen = (openProbe.data?.events.length ?? 0) > 0;

  return (
    <>
      <PageHead
        title={t('web.nc_title')}
        actions={
          <PageMoreMenu
            items={[
              // The mark-all that was a page-head button, behind the same condition and the
              // same mutation.
              ...(categories.length > 0 && inboxFeed
                ? [
                    {
                      key: 'mark-all',
                      label: t('web.nc_mark_all'),
                      icon: 'check' as const,
                      disabled: markAll.isPending,
                      onSelect: () => markAll.mutate(),
                    },
                  ]
                : []),
              {
                key: 'reread',
                label: t('web.nc_reread'),
                icon: 'refresh' as const,
                onSelect: () => {
                  refresh();
                  void queries.invalidateQueries({ queryKey: ['ops-log'] });
                },
              },
            ]}
          />
        }
      />
      <Disclosure size="sm" summary={t('web.nc_about_fold')}>
        <p className="muted small">{t('web.nc_intro')}</p>
      </Disclosure>
      {/* Red while an alert is open; nothing at all otherwise. */}
      {mayAlerts && hasOpen && (
        <AttentionStrip
          tone="danger"
          title={t('web.nc_alerts_strip_title')}
          items={[
            {
              key: 'open-alerts',
              label: t('web.nc_alerts_strip_link'),
              onClick: () => setFilter('OPEN'),
            },
          ]}
        />
      )}
      <div className="nc-toolbar">
        <ListFilterBar
          label={t('web.nc_title')}
          filters={[
            {
              key: 'feed',
              label: t('web.nc_filters_label'),
              active:
                filter === 'UNREAD'
                  ? null
                  : (feedItems.find((one) => one.key === filter)?.label ?? null),
              onClear: () => setFilter('UNREAD'),
              control: (
                <FilterChips label={t('web.nc_filters_label')}>
                  {feedItems.map((one) => (
                    <FilterChip
                      key={one.key}
                      pressed={filter === one.key}
                      onClick={() => setFilter(one.key)}
                    >
                      {one.label}
                      {one.count === undefined ? null : <Num value={one.count} />}
                    </FilterChip>
                  ))}
                </FilterChips>
              ),
            },
            ...(inboxFeed && categories.length > 1
              ? [
                  {
                    key: 'category',
                    label: t('web.nc_filter_category'),
                    active: category === '' ? null : t(CATEGORY_LABELS[category]),
                    onClear: () => setCategory(''),
                    control: (
                      <Select
                        size="sm"
                        aria-label={t('web.nc_filter_category')}
                        value={category}
                        onChange={(event) =>
                          setCategory(event.target.value as NotificationCategory | '')
                        }
                      >
                        <option value="">{t('web.nc_category_all')}</option>
                        {categories.map((one) => (
                          <option key={one} value={one}>
                            {t(CATEGORY_LABELS[one])}
                          </option>
                        ))}
                      </Select>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </div>
      {(mark.error !== null || markAll.error !== null) && (
        <Banner tone="danger">
          {messageFor(mark.error ?? markAll.error)}
          <ErrorRef error={mark.error ?? markAll.error} />
        </Banner>
      )}
      {!inboxFeed ? (
        <AlertsPage denied={!mayAlerts} openOnly={filter === 'OPEN'} />
      ) : (
        <Card tight>
          <StateSwitch query={feedQuery}>
            {entries.length === 0 && pages.length === 0 ? (
              <Empty
                variant="compact"
                title={filter === 'UNREAD' ? t('web.nc_empty_unread') : t('web.nc_empty')}
              />
            ) : (
              <>
                <ul className="nc-list">
                  {entries.map((entry) =>
                    entry.inbox !== undefined ? (
                      <InboxItem
                        key={entry.id}
                        row={entry.inbox}
                        alert={entry.alert}
                        pending={mark.isPending}
                        onToggle={() =>
                          mark.mutate({
                            id: entry.id,
                            read: !(entry.inbox as InboxNotification).read,
                          })
                        }
                        onOpen={(event) => {
                          if (!(entry.inbox as InboxNotification).read)
                            mark.mutate({ id: entry.id, read: true });
                          onLink(event);
                        }}
                      />
                    ) : (
                      <AlertItem key={entry.id} row={entry.alert as AlertEvent} />
                    ),
                  )}
                </ul>
                {(next || pages.length > 0) && (
                  <CursorPager
                    order="newest-first"
                    hasPrevious={pages.length > 0}
                    hasNext={next}
                    onPrevious={() => setTrail({ signature, pages: pages.slice(0, -1) })}
                    onNext={goNext}
                    shown={entries.length}
                  />
                )}
              </>
            )}
          </StateSwitch>
        </Card>
      )}
    </>
  );
}

/** An alert that is not an inbox entry (the inbox has no rule for its code), drawn as a card. */
function AlertItem({ row }: { row: AlertEvent }) {
  return (
    <li className="nc-item" aria-label={opsCodeLabel(row.code)}>
      <div className="nc-head">
        <Badge tone={SEVERITY_TONES[row.severity]}>{t(SEVERITY_LABELS[row.severity])}</Badge>
        <Badge tone="neutral">{t('web.nc_source_alert')}</Badge>
        <AlertStatusBadge row={row} />
      </div>
      <p className="nc-title strong" title={row.code}>
        {hasOpsCodeLabel(row.code) ? opsCodeLabel(row.code) : row.code}
      </p>
      <p className="alerts-message">{alertMessage(row.code, row.context)}</p>
      <TechnicalDetails lines={[row.message]} />
      <p className="muted small">
        {t('web.nc_last_seen')}: {formatTimestamp(row.lastSeenAt)}
        {row.occurrenceCount > 1 && (
          <>
            {' · '}
            {t('web.nc_occurrences')}: <Num value={row.occurrenceCount} />
          </>
        )}
      </p>
    </li>
  );
}

function InboxItem({
  row,
  alert,
  pending,
  onToggle,
  onOpen,
}: {
  row: InboxNotification;
  /** The same operational event as a management alert: one item, with the alert's state too. */
  alert?: AlertEvent | undefined;
  pending: boolean;
  onToggle: () => void;
  onOpen: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const title = titleOf(row.code, row.category, row.operationType);
  return (
    <li className={row.read ? 'nc-item' : 'nc-item unread'} aria-label={title}>
      <div className="nc-head">
        {!row.read && <Badge tone="info">{t('web.nc_unread_badge')}</Badge>}
        <Badge tone={SEVERITY_TONES[row.severity]}>{t(SEVERITY_LABELS[row.severity])}</Badge>
        <Badge tone="neutral">{t(CATEGORY_LABELS[row.category])}</Badge>
        {row.resolvedAt !== null && <Badge tone="ok">{t('web.nc_resolved')}</Badge>}
        {alert !== undefined && (
          <>
            <Badge tone="neutral">{t('web.nc_source_alert')}</Badge>
            <AlertStatusBadge row={alert} />
          </>
        )}
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
            [
              t('web.nc_code'),
              <CodeLabel key="c" label={opsCodeLabel(row.code)} code={row.code} />,
            ],
            [
              t('web.nc_message'),
              <TechnicalDetails key="m" lines={notificationMessageLines(row.code, row.message)} />,
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

/**
 * The Persian sentence for the code, and beneath it the server's own message, which carries
 * the identifying detail (a loop's name, a setting's key) a code-keyed sentence cannot.
 */
export function notificationMessageLines(code: string, message: string): readonly string[] {
  const persian = operationalEventMessageFa(code);
  return persian === null || persian === message ? [message] : [persian, message];
}
