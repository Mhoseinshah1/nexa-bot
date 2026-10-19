import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPageWhileTurning } from '../ui/paging';
import {
  SERVICE_DELIVERY_STATES,
  SERVICE_OPERATOR_ACTIONS,
  SERVICE_STATES,
  UNLIMITED_TRAFFIC_BYTES,
  type OperationState,
  type OperationType,
  type ServiceActionAvailability,
  type ServiceActionBlocker,
  type ServiceDeliveryState,
  type ServiceListLifecycle,
  type ServiceOperationResponse,
  type ServiceOperatorAction,
  type ServiceState,
  type ServiceSummaryResponse,
} from '@nexa/contracts';
import {
  actOnService,
  fetchService,
  fetchServiceOperations,
  fetchServices,
  type ServiceSimpleAction,
} from '../api/client';
import { formatDate, formatNumber, formatTimestampNumeric, formatTrafficGbText } from '../format';
import { messageFor } from './settings';
import { useSubmissionKey } from '../submission-key';
import { mayRequest, queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { setQueries, setQuery, useLinkHandler, type Route } from '../router';
import { ListFreshness, ListSearchBox, appliedListSearch } from '../ui/list-search';
import { ListFilterBar, type ListFilter } from '../ui/filter-bar';
import { SavedViewsMenu } from '../ui/saved-views-menu';
import { sourceRouteFilter } from './record-source';
import { routeViewRegistration, type ViewPreset } from '../ui/saved-views';
import { CustomerIdentityLink } from '../ui/customer-identity';
import {
  CodeText,
  CopyIdButton,
  PanelLink,
  ProductLink,
  RecordLink,
  recordHref,
} from '../ui/record-ref';
import { BalancedColumns, ChipGroup, useListClearAll } from './commerce-parts';
import { ActionPanel } from '../ui/action-panel';
import {
  Badge,
  Banner,
  Button,
  Card,
  CopyButton,
  Copyable,
  CursorPager,
  DataTable,
  Empty,
  KV,
  LIST_PAGE_SIZE,
  Ltr,
  Money,
  Num,
  PageHead,
  Progress,
  StatCard,
  progressRatio,
  StateSwitch,
  TabPanel,
  Tabs,
  usePagedRows,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';
import { ServiceDeleteModal } from './service-delete-modal';
import {
  OpenServiceRefundRequestsCard,
  ServiceRefundRequestsCard,
} from './service-refund-requests';
import {
  INPUT_ACTIONS,
  LIFECYCLE_STATES,
  lifecycleOf,
  ServiceGrantButton,
  ServiceMassActionButton,
  ServiceMoveButton,
  grantMoveReasons,
  serviceFiltersOf,
  useServiceFilterRows,
  useRefreshOnOperationChange,
} from './service-ops';
import { ProviderText } from '../ui/technical-details';

/**
 * Services — what the customer bought, and what was done to produce it.
 *
 * `docs/phase4h-audit.md` §7 is what this closes. `services.view`, `services.edit`,
 * `services.terminate` and `services.transfer` have been declared permissions since
 * Phase 2; three seeded roles carry the first two; services have been real rows since
 * 4D — and until 4H there was no endpoint and no screen. An operator whose role said
 * they could view services could not view one.
 *
 * ## It hands over no capability, and that is why it has no link column
 *
 * `subscriptionUrl`, `subscriptionRef` and `providerClientId` are absent from this page
 * because they are absent from the RESPONSE: `serviceSummarySchema` and
 * `serviceDetailSchema` do not carry them, so there is nothing here to leak and no
 * refactor of this file that could start leaking one. All three are bearer
 * capabilities — anybody holding the URL has the service — and a list an operator can
 * page through is the worst possible place to put one in bulk.
 *
 * There is no masked stand-in either. ADR-0023 gives the reason about panel passwords
 * and it is the same reason here: `********` is a value somebody can try to resubmit.
 * What the page shows is WHETHER a subscription exists, and one sentence saying the
 * link is withheld rather than missing.
 *
 * ## Two axes, never collapsed
 *
 * `state` is the service's lifecycle and `deliveryState` is what is known about telling
 * the customer. They are two columns because they are two facts: 4D's `recordDelivery`
 * exists precisely so a failed Telegram send cannot move a service out of `ACTIVE`, and
 * a screen that merged them would show a provisioned account whose message bounced as
 * unprovisioned — for which the obvious remedy is to provision it again, on somebody's
 * panel, a second time.
 *
 * ## The actions are the SERVER's list, and the page adds none
 *
 * Phase 6A. The detail response carries a verdict for each of the seven operator
 * actions with a blocker code when it is not available, computed by the one evaluator
 * the write paths agree with. This page renders that list and nothing else: it does not
 * decide availability, does not infer a reason, and cannot offer an action the request
 * would refuse.
 *
 * Permission is separate and is checked twice — here, so a viewer is told in a sentence
 * rather than shown a control that records a denial when pressed, and again by the
 * server, which is the one that counts. `services.terminate` is its own key.
 *
 * `services.transfer` is still declared with no endpoint: Package F built the CUSTOMER's
 * transfer, from the bot, and no operator transfer. The page draws no transfer control at
 * all — not even a disabled one: a disabled control claims "this exists and you lack
 * permission", which is a different and false statement. (The sentence that narrated the
 * absence went in the demo's polish pass; meta notes about what is not built are not shown.)
 */

export const STATE_LABELS: Readonly<Record<ServiceState, WebKey>> = {
  PENDING_PROVISION: 'web.service_state_pending_provision',
  ACTIVE: 'web.service_state_active',
  SUSPENDED: 'web.service_state_suspended',
  EXPIRED: 'web.service_state_expired',
  TERMINATED: 'web.service_state_terminated',
  UNRECONCILED: 'web.service_state_unreconciled',
};

export const STATE_TONES: Readonly<Record<ServiceState, Tone>> = {
  PENDING_PROVISION: 'info',
  ACTIVE: 'ok',
  SUSPENDED: 'warn',
  EXPIRED: 'neutral',
  TERMINATED: 'neutral',
  // Not danger. `UNRECONCILED` is an ABSENCE of knowledge, exactly as a payment's
  // `UNKNOWN` is, and a red badge would assert a failure this installation cannot
  // establish — the provider may well hold a perfectly good account.
  UNRECONCILED: 'warn',
};

/* Exported alongside `STATE_LABELS`: `/users/:id` draws both axes, never one. */
export const DELIVERY_LABELS: Readonly<Record<ServiceDeliveryState, WebKey>> = {
  PENDING: 'web.service_delivery_pending',
  DELIVERED: 'web.service_delivery_delivered',
  UNCONFIRMED: 'web.service_delivery_unconfirmed',
  FAILED: 'web.service_delivery_failed',
};

export const DELIVERY_TONES: Readonly<Record<ServiceDeliveryState, Tone>> = {
  PENDING: 'neutral',
  DELIVERED: 'ok',
  UNCONFIRMED: 'warn',
  FAILED: 'danger',
};

/*
 * Exported for the same reason the two state maps above are: the ORDER page draws the
 * provisioning attempt its order produced, and a second copy of this vocabulary there
 * would be a second answer to what a failed PROVISION looks like.
 */
export const OPERATION_TYPE_LABELS: Readonly<Record<OperationType, WebKey>> = {
  PROVISION: 'web.operation_type_provision',
  RENEW: 'web.operation_type_renew',
  ADD_TRAFFIC: 'web.operation_type_add_traffic',
  ADD_TIME: 'web.operation_type_add_time',
  ADD_DEVICES: 'web.operation_type_add_devices',
  CHANGE_LOCATION: 'web.operation_type_change_location',
  SUSPEND: 'web.operation_type_suspend',
  RESUME: 'web.operation_type_resume',
  TERMINATE: 'web.operation_type_terminate',
  SYNC_USAGE: 'web.operation_type_sync_usage',
  ROTATE_SUBSCRIPTION: 'web.operation_type_rotate_subscription',
  RECONCILE: 'web.operation_type_reconcile',
};

export const OPERATION_STATE_LABELS: Readonly<Record<OperationState, WebKey>> = {
  PLANNED: 'web.operation_state_planned',
  IN_FLIGHT: 'web.operation_state_in_flight',
  SUCCEEDED: 'web.operation_state_succeeded',
  FAILED: 'web.operation_state_failed',
  UNKNOWN: 'web.operation_state_unknown',
  ABANDONED: 'web.operation_state_abandoned',
};

export const OPERATION_STATE_TONES: Readonly<Record<OperationState, Tone>> = {
  PLANNED: 'neutral',
  IN_FLIGHT: 'info',
  SUCCEEDED: 'ok',
  FAILED: 'danger',
  // The call MAY have taken effect. Neither tone would be true, and the next step is a
  // read rather than a retry — `OPERATION_STATES` says so where the value is declared.
  UNKNOWN: 'warn',
  ABANDONED: 'neutral',
};

function StateBadge({ value }: { value: ServiceState }) {
  return (
    <Badge tone={STATE_TONES[value]} dot>
      {t(STATE_LABELS[value])}
    </Badge>
  );
}

function DeliveryBadge({ value }: { value: ServiceDeliveryState }) {
  return (
    <Badge tone={DELIVERY_TONES[value]} outline>
      {t(DELIVERY_LABELS[value])}
    </Badge>
  );
}

function Dash() {
  return <span className="faint">—</span>;
}

/**
 * A byte figure, or the word for "no limit".
 *
 * `formatTrafficGbText` does not handle zero: `UNLIMITED_TRAFFIC_BYTES` is zero and
 * a formatter that rendered it as "0 GB" would state the opposite of what it means.
 * The USED counter goes through the plain formatter, because zero used is zero used.
 */
function TrafficLimit({ bytes }: { bytes: string }) {
  const value = BigInt(bytes);
  if (value === UNLIMITED_TRAFFIC_BYTES) return <span>{t('web.product_unlimited')}</span>;
  return <Bytes bytes={value} />;
}

function Bytes({ bytes }: { bytes: bigint }) {
  return (
    <span className="nowrap">
      <Num value={formatTrafficGbText(bytes)} /> {t('web.unit_gib')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** Every URL key the service list filters on, its search included (clear-all, saved views). */
const SERVICE_FILTER_KEYS = [
  'lifecycle',
  'q',
  'state',
  'deliveryState',
  'panelId',
  'productId',
  'locationKey',
  'expiring',
  'source',
] as const;

/** The saved-filters menu's suggestions (W1.4), exactly the demo's for this list. */
/**
 * The lifecycle tabs (Track 3 §3), in the order drawn. LIVE is the default and is the URL with
 * no `lifecycle`; the other two put their id there.
 */
const LIFECYCLE_TABS = [
  { id: 'LIVE', label: 'web.services_tab_live', empty: 'web.services_empty_live' },
  { id: 'ENDED', label: 'web.services_tab_ended', empty: 'web.services_empty_ended' },
  { id: 'ALL', label: 'web.services_tab_all', empty: 'web.services_empty' },
] as const satisfies readonly { id: ServiceListLifecycle; label: WebKey; empty: WebKey }[];

export const SERVICE_PRESETS: readonly ViewPreset[] = [
  {
    id: 'expiring-3d',
    name: 'web.services_view_expiring_3d',
    state: { state: 'ACTIVE', expiring: '72' },
  },
  {
    id: 'expiring-24h',
    name: 'web.services_view_expiring_24h',
    state: { state: 'ACTIVE', expiring: '24' },
  },
  { id: 'unreconciled', name: 'web.services_view_unreconciled', state: { state: 'UNRECONCILED' } },
  {
    id: 'delivery-failed',
    name: 'web.services_view_delivery_failed',
    state: { deliveryState: 'FAILED' },
  },
  { id: 'suspended', name: 'web.services_view_suspended', state: { state: 'SUSPENDED' } },
];

export function ServicesPage({
  route,
  denied,
  mayViewRefundRequests = false,
  mayViewPanels = false,
  mayViewCatalog = false,
  mayMassStatus = false,
  mayMassGrant = false,
}: {
  route: Route;
  denied: boolean;
  /** `refunds.view`: the customers' refund requests that still want an operator (WP19). */
  mayViewRefundRequests?: boolean;
  /** Program §13: the panel filter's list (`panels.view`). */
  mayViewPanels?: boolean;
  /** Program §13: the product and location filters' lists (`catalog.view`). */
  mayViewCatalog?: boolean;
  /** Program §13: `services.mass.status` AND `services.edit`. */
  mayMassStatus?: boolean;
  /** Program §13: `services.mass.grant`. */
  mayMassGrant?: boolean;
}) {
  const onLink = useLinkHandler();
  const cursor = route.query.get('cursor');
  // Track 3 §3: which part of a service's life is shown; the default is the live services.
  const lifecycle = lifecycleOf(route);
  const state = route.query.get('state');
  const delivery = route.query.get('deliveryState');
  /*
   * ONE search box (spec §10), in the URL as `q`: a provider username (exact), a Telegram
   * id, an `@username`, or a service / order / customer / panel id. It replaced three
   * single-purpose boxes, two of which wanted an internal uuid.
   */
  const appliedSearch = appliedListSearch(route);
  // Program §13: the workspace's further filters, also in the URL.
  const filters = serviceFiltersOf(route, appliedSearch);

  const services = useQuery(
    keepPageWhileTurning(
      {
        queryKey: [
          'services',
          lifecycle,
          cursor,
          state,
          delivery,
          appliedSearch,
          filters.panelId,
          filters.productId,
          filters.locationKey,
          filters.expiringWithinHours,
          filters.source ?? null,
        ],
        queryFn: () =>
          fetchServices({
            limit: LIST_PAGE_SIZE,
            ...(cursor === null ? {} : { cursor }),
            // Sent explicitly, ALL included: the server's default is ALL, the page's is LIVE.
            lifecycle,
            ...(state === null ? {} : { state: state as ServiceState }),
            ...(delivery === null ? {} : { deliveryState: delivery as ServiceDeliveryState }),
            ...(appliedSearch === '' ? {} : { q: appliedSearch }),
            ...(filters.source == null ? {} : { source: filters.source }),
            ...(filters.panelId === null ? {} : { panelId: filters.panelId }),
            ...(filters.productId === null ? {} : { productId: filters.productId }),
            ...(filters.locationKey === null ? {} : { locationKey: filters.locationKey }),
            ...(filters.expiringWithinHours === null
              ? {}
              : { expiringWithinHours: filters.expiringWithinHours }),
          }),
        enabled: !denied,
      },
      [1],
    ),
  );

  const columns: readonly Column<ServiceSummaryResponse>[] = [
    {
      key: 'username',
      header: t('web.service_username'),
      render: (row) => (
        <>
          <a href={`/services/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
            <Ltr>{row.providerUsername}</Ltr>
          </a>
          {/* R1: a free trial, as the database marks it (`services.is_trial`). */}
          {row.isTrial && (
            <>
              {' '}
              <Badge tone="info">{t('web.service_trial_badge')}</Badge>
            </>
          )}
        </>
      ),
    },
    {
      // PR-C: the service's short public code, never its uuid.
      key: 'code',
      header: t('web.record_code'),
      render: (row) => <RecordLink href={recordHref.service(row.id)} id={row.id} code={row.code} />,
    },
    {
      key: 'state',
      header: t('web.service_state'),
      render: (row) => <StateBadge value={row.state} />,
    },
    {
      key: 'delivery',
      header: t('web.service_delivery'),
      render: (row) => <DeliveryBadge value={row.deliveryState} />,
    },
    {
      key: 'customer',
      header: t('web.service_customer'),
      // The Telegram numeric id, never the internal uuid (spec §10).
      render: (row) => (
        <CustomerIdentityLink
          customerId={row.customerId}
          telegramUserId={row.customerTelegramUserId}
          username={row.customerUsername}
          onLink={onLink}
        />
      ),
    },
    {
      key: 'panel',
      header: t('web.service_panel'),
      // PR-C: the panel by its name.
      render: (row) => <PanelLink id={row.panelId} name={row.panelName} />,
    },
    {
      // Program §13: where it is, as the panel's location configuration names it.
      key: 'location',
      header: t('web.soc_location'),
      render: (row) => (row.locationLabel === null ? <Dash /> : row.locationLabel),
    },
    {
      key: 'expires',
      header: t('web.service_expires_at'),
      render: (row) =>
        row.expiresAt === null ? (
          <Dash />
        ) : (
          <span className="nowrap">{formatTimestampNumeric(row.expiresAt)}</span>
        ),
    },
    {
      /*
       * The ORIGINAL purchase (Track 3 §3), which is what the list is ordered by: for an
       * imported service the previous bot's date, never the import. A response from the
       * release before carries none, and then the creation is the honest fallback — it is
       * the same instant for every service this installation made.
       */
      key: 'started',
      header: t('web.service_started_at'),
      render: (row) => (
        <span className="nowrap">
          {formatTimestampNumeric(row.originalStartedAt ?? row.createdAt)}
        </span>
      ),
    },
  ];

  // Hidden while the list cannot answer: a control that mints a new query key is
  // a fresh request against a question the server has just refused.
  const { searchKey, clearAll } = useListClearAll(route, SERVICE_FILTER_KEYS);
  const toolbarHidden = !mayRequest(services, denied);

  const setFilter = (key: string, value: string | null) =>
    setQueries(route, [
      [key, value],
      ['cursor', null],
    ]);
  const knownState = SERVICE_STATES.find((one) => one === state);
  /*
   * A tab change starts at the first page, and drops a state filter the new tab cannot show —
   * a SUSPENDED filter carried into «پایان‌یافته» would answer an empty list for a reason the
   * operator can no longer see.
   */
  const selectLifecycle = (next: ServiceListLifecycle) =>
    setQueries(route, [
      ['lifecycle', next === 'LIVE' ? null : next],
      ['cursor', null],
      [
        'state',
        knownState !== undefined && LIFECYCLE_STATES[next].includes(knownState) ? state : null,
      ],
    ]);
  const tabStates = LIFECYCLE_STATES[lifecycle];
  const emptyKey =
    LIFECYCLE_TABS.find((tab) => tab.id === lifecycle)?.empty ?? 'web.services_empty';
  const knownDelivery = SERVICE_DELIVERY_STATES.find((one) => one === delivery);
  const extraRows = useServiceFilterRows({
    route,
    filters,
    mayViewPanels,
    mayViewCatalog,
    enabled: !toolbarHidden,
  });
  const serviceFilters: ListFilter[] = [
    {
      key: 'state',
      label: t('web.service_state'),
      active:
        state === null ? null : knownState === undefined ? state : t(STATE_LABELS[knownState]),
      onClear: () => setFilter('state', null),
      control: (
        <ChipGroup
          label={t('web.service_state')}
          value={state ?? 'ALL'}
          onChange={(next) => setFilter('state', next === 'ALL' ? null : next)}
          items={[
            { id: 'ALL', label: t('web.services_filter_all') },
            // Only the states the open tab can show.
            ...tabStates.map((one) => ({ id: one, label: t(STATE_LABELS[one]) })),
          ]}
        />
      ),
    },
    {
      key: 'deliveryState',
      label: t('web.service_delivery'),
      active:
        delivery === null
          ? null
          : knownDelivery === undefined
            ? delivery
            : t(DELIVERY_LABELS[knownDelivery]),
      onClear: () => setFilter('deliveryState', null),
      control: (
        <ChipGroup
          label={t('web.service_delivery')}
          value={delivery ?? 'ALL'}
          onChange={(next) => setFilter('deliveryState', next === 'ALL' ? null : next)}
          items={[
            { id: 'ALL', label: t('web.services_filter_all') },
            ...SERVICE_DELIVERY_STATES.map((one) => ({
              id: one,
              label: t(DELIVERY_LABELS[one]),
            })),
          ]}
        />
      ),
    },
    sourceRouteFilter(route, filters.source ?? null),
    ...extraRows,
  ];

  return (
    <>
      <PageHead
        title={t('web.services_title')}
        subtitle={t('web.services_intro')}
        actions={
          <>
            <ListFreshness query={services} hidden={toolbarHidden} />
            {/* Program §13 / W3: one mass action over exactly what the filters select. */}
            {!denied && (
              <ServiceMassActionButton
                filters={filters}
                mayStatus={mayMassStatus}
                mayGrant={mayMassGrant}
              />
            )}
          </>
        }
      />
      {/* Its own permission, not the list's: `refunds.view` alone reaches the queue (WP19). */}
      {mayViewRefundRequests && <OpenServiceRefundRequestsCard />}

      <Card className="ca-list">
        {/* Track 3 §3: the tab is in the URL, and the server filters and orders by it. */}
        {!denied && (
          <Tabs
            value={lifecycle}
            onChange={selectLifecycle}
            panelId="services-lifecycle"
            items={LIFECYCLE_TABS.map((tab) => ({ id: tab.id, label: t(tab.label) }))}
          />
        )}
        <div hidden={toolbarHidden}>
          <ListFilterBar
            first="search"
            label={t('web.services_title')}
            search={
              <ListSearchBox
                key={searchKey}
                slim
                route={route}
                id="services-search"
                // Typing or pasting searches by itself, debounced, as on /users (roadmap B4).
                autoApply
                hint={t('web.services_search_hint')}
                hidden={toolbarHidden}
                // A new search starts at the first page: this list keeps its cursor in the URL.
                resetKeys={['cursor']}
              />
            }
            filters={serviceFilters}
            onClearAll={clearAll}
            savedViews={
              <SavedViewsMenu
                registration={routeViewRegistration(
                  route,
                  'services',
                  SERVICE_FILTER_KEYS,
                  SERVICE_PRESETS,
                )}
              />
            }
          />
        </div>

        <TabPanel id="services-lifecycle" labelledBy={`services-lifecycle-tab-${lifecycle}`}>
          <StateSwitch query={services} denied={denied}>
            {services.data === undefined ? null : services.data.services.length === 0 ? (
              <Empty
                title={t(emptyKey)}
                hint={t(
                  lifecycle === 'LIVE' ? 'web.services_empty_live_hint' : 'web.services_empty_hint',
                )}
              />
            ) : (
              <>
                <DataTable
                  stack="labelled"
                  caption={t('web.services_title')}
                  columns={columns}
                  rows={services.data.services}
                  rowKey={(row) => row.id}
                  dense
                  sticky
                />
                {/*
                `newest-first`, and that is the difference from `/users`, `/orders` and
                `/products`: `GET /services` pages a DESCENDING keyset, newest ORIGINAL
                purchase first (owner revision 13, Track 3 §3), so "next" here really is the
                older page. The three ascending lists say `oldest-first` for the opposite reason.

                The cursor lives in the URL, so Previous returns to the first page.
              */}
                <CursorPager
                  order="newest-first"
                  shown={services.data.services.length}
                  hasPrevious={cursor !== null}
                  hasNext={services.data.nextCursor !== null}
                  onPrevious={() => setQuery(route, 'cursor', null)}
                  onNext={() => setQuery(route, 'cursor', services.data?.nextCursor ?? null)}
                />
              </>
            )}
          </StateSwitch>
        </TabPanel>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const ACTION_LABELS: Readonly<Record<ServiceOperatorAction, WebKey>> = {
  SYNC_USAGE: 'web.service_action_sync_usage',
  RESEND_CONFIG: 'web.service_action_resend_config',
  RETRY_PROVISION: 'web.service_action_retry_provision',
  RECONCILE: 'web.service_action_reconcile',
  SUSPEND: 'web.service_action_suspend',
  RESUME: 'web.service_action_resume',
  TERMINATE: 'web.service_action_terminate',
  ROTATE_LINK: 'web.service_action_rotate_link',
  ADD_TRAFFIC: 'web.service_action_add_traffic',
  ADD_TIME: 'web.service_action_add_time',
  CHANGE_LOCATION: 'web.service_action_change_location',
};

/**
 * Why an action is not offered, in a sentence an operator can act on.
 *
 * One per blocker code the contract declares, and the mapping is exhaustive by type —
 * a new blocker cannot ship without its sentence, which is the failure this table
 * exists to prevent: a greyed-out button with no explanation is the legacy panel's
 * entire style of refusal.
 */
const BLOCKER_LABELS: Readonly<Record<ServiceActionBlocker, WebKey>> = {
  STATE: 'web.service_blocker_state',
  CAPABILITY: 'web.service_blocker_capability',
  PANEL_NOT_OPERABLE: 'web.service_blocker_panel_not_operable',
  IN_PROGRESS: 'web.service_blocker_in_progress',
  NO_CONFIGURATION: 'web.service_blocker_no_configuration',
  NO_CONTACT: 'web.service_blocker_no_contact',
  UNLIMITED: 'web.service_blocker_unlimited',
  NO_TARGET: 'web.service_blocker_no_target',
};

/**
 * Which actions charge `services.terminate` rather than `services.edit`.
 *
 * A table over every action rather than a `!== 'TERMINATE'` filter, and for the reason
 * the server's own `OPERATOR_OPERATION_PERMISSION` gives: a second HIGH-risk action
 * added later would be silently drawn in the ordinary group under the cheaper
 * permission. Here it has to be classified.
 */
const ACTION_NEEDS_TERMINATE: Readonly<Record<ServiceOperatorAction, boolean>> = {
  SYNC_USAGE: false,
  RESEND_CONFIG: false,
  RETRY_PROVISION: false,
  RECONCILE: false,
  SUSPEND: false,
  RESUME: false,
  TERMINATE: true,
  ROTATE_LINK: false,
  // Program §13: drawn by `ServiceGrantMoveCard`, each under its own key.
  ADD_TRAFFIC: false,
  ADD_TIME: false,
  CHANGE_LOCATION: false,
};

/**
 * The eight actions, drawn from the server's own verdicts, and the one mutation
 * every one of them goes through.
 *
 * The ordinary actions are the page head's button group; terminate is isolated in
 * its own danger card at the foot of the page, because it is the only one that
 * deletes an account on somebody's panel and the only one that costs a typed
 * phrase. Every press is idempotent under a key held by `useSubmissionKey`, so
 * pressing twice asks the same question rather than planning a second operation.
 *
 * Nothing here decides availability. `entry.available` and `entry.blocker` come from
 * the response, and a permission the session lacks is reported as a sentence instead
 * of removing the section — an absent control says nothing about why.
 */
function useServiceAction(id: string, onActed: () => void, onTerminated: () => void) {
  const toast = useToast();
  const submission = useSubmissionKey();
  return useMutation({
    mutationFn: (input: { action: ServiceSimpleAction; confirm?: string }) =>
      actOnService({
        id,
        action: input.action,
        // One command per (service, action): pressing the same button twice — or
        // retrying after a lost response — replays rather than planning twice.
        idempotencyKey: submission.current({ command: 'services.act', id, action: input.action }),
        ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
      }),
    onSuccess: (result, input) => {
      submission.settle();
      if (input.action === 'TERMINATE') onTerminated();
      /*
       * "Planned", never "done". The operation is recorded and the provisioner runs
       * it; the history card is where its outcome appears. A resend plans no
       * operation at all, and says so.
       */
      toast({
        tone: 'ok',
        message:
          result.operation === null
            ? t('web.service_action_resent')
            : t('web.service_action_planned'),
      });
      onActed();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      toast({ tone: 'danger', message: messageFor(error), error });
    },
  });
}

type ServiceAct = ReturnType<typeof useServiceAction>;

/**
 * W1.5: the ordinary actions sorted into the service page's groups, in
 * `SERVICE_OPERATOR_ACTIONS` order within each. Every ordinary action is classified here —
 * an action the table forgets is drawn in no group, which the unit test over this table
 * catches before an operator loses a button.
 */
export const SERVICE_ACTION_GROUPS = [
  {
    key: 'panel',
    title: 'web.service_group_panel',
    actions: ['SYNC_USAGE', 'RETRY_PROVISION', 'RECONCILE'],
  },
  { key: 'link', title: 'web.service_group_link', actions: ['RESEND_CONFIG', 'ROTATE_LINK'] },
  { key: 'state', title: 'web.service_group_state', actions: ['SUSPEND', 'RESUME'] },
] as const satisfies readonly {
  key: string;
  title: WebKey;
  actions: readonly ServiceSimpleAction[];
}[];

/** One ordinary action's button, from the server's verdict. */
function ActionButton({
  entry,
  mayEdit,
  act,
}: {
  entry: ServiceActionAvailability | undefined;
  mayEdit: boolean;
  act: ServiceAct;
}) {
  if (entry === undefined) return null;
  const action = entry.action as ServiceSimpleAction;
  const why = !entry.available && entry.blocker !== null;
  return (
    <Button
      disabled={!mayEdit || !entry.available || act.isPending}
      {...(why ? { 'aria-describedby': `service-blocker-${action}` } : {})}
      onClick={() => act.mutate({ action })}
    >
      {t(ACTION_LABELS[action])}
    </Button>
  );
}

/**
 * Why each unavailable ordinary action is unavailable, in words, and whether this session
 * may press any of them — folded at the foot of the action panel (W1.5). A greyed-out
 * control with no reason is the legacy panel's entire style of refusal; each blocker
 * sentence sends an operator somewhere different. The sentence carries the id the button's
 * `aria-describedby` names, and nothing else.
 */
function actionReasons(
  actions: readonly ServiceActionAvailability[],
  mayEdit: boolean,
): ReactNode[] {
  const reasons: ReactNode[] = [];
  if (!mayEdit) {
    reasons.push(<span key="edit-denied">{t('web.service_action_denied_edit')}</span>);
  }
  for (const action of SERVICE_OPERATOR_ACTIONS) {
    const entry = actions.find((one) => one.action === action);
    if (
      ACTION_NEEDS_TERMINATE[action] ||
      INPUT_ACTIONS.has(action) ||
      entry === undefined ||
      entry.available ||
      entry.blocker === null
    ) {
      continue;
    }
    reasons.push(
      <span key={action}>
        <b>{t(ACTION_LABELS[action])}</b>{' '}
        <span id={`service-blocker-${action}`}>{t(BLOCKER_LABELS[entry.blocker])}</span>
      </span>,
    );
  }
  return reasons;
}

/**
 * The page's ONE action panel (W1.5, W3): the ordinary actions in their groups, the grant
 * and move as buttons opening drawers, terminate isolated in the «عملیات حساس» strip — its
 * own permission, its own blocker, and the modal that offers «فقط حذف سرویس» (the typed
 * phrase) or «حذف سرویس و بازگشت وجه» — and every reason a button is disabled folded at
 * the foot.
 */
function ServiceActionPanel({
  row,
  mayEdit,
  mayTerminate,
  mayGrant,
  mayRefund,
  act,
  deleting,
  setDeleting,
  onActed,
}: {
  row: ServiceDetail;
  mayEdit: boolean;
  mayTerminate: boolean;
  mayGrant: boolean;
  mayRefund: boolean;
  act: ServiceAct;
  deleting: boolean;
  setDeleting: (next: boolean) => void;
  onActed: () => void;
}) {
  const byAction = new Map(row.actions.map((entry) => [entry.action, entry]));
  const terminate = byAction.get('TERMINATE');
  const terminateBlocked =
    terminate !== undefined && !terminate.available && terminate.blocker !== null;
  const reasons = [
    ...actionReasons(row.actions, mayEdit),
    ...grantMoveReasons({
      actions: row.actions,
      mayGrant,
      mayEdit,
      blockerLabel: (blocker) => t(BLOCKER_LABELS[blocker]),
    }),
  ];
  if (terminate !== undefined) {
    if (!mayTerminate) {
      reasons.push(<span key="terminate-denied">{t('web.service_action_denied_terminate')}</span>);
    } else if (terminateBlocked && terminate.blocker !== null) {
      reasons.push(
        <span key="terminate">
          <b>{t('web.service_delete_open')}</b>{' '}
          <span id="service-blocker-TERMINATE">{t(BLOCKER_LABELS[terminate.blocker])}</span>
        </span>,
      );
    }
  }
  return (
    <>
      <ActionPanel
        title={t('web.service_action_panel_title')}
        groups={[
          ...SERVICE_ACTION_GROUPS.map((group) => ({
            key: group.key,
            title: t(group.title),
            actions: group.actions.map((action) => (
              <ActionButton key={action} entry={byAction.get(action)} mayEdit={mayEdit} act={act} />
            )),
          })),
          {
            key: 'gift',
            title: t('web.service_group_gift'),
            actions: [
              <ServiceGrantButton
                key="traffic"
                serviceId={row.id}
                kind="ADD_TRAFFIC"
                entry={byAction.get('ADD_TRAFFIC')}
                mayGrant={mayGrant}
                onActed={onActed}
              />,
              <ServiceGrantButton
                key="time"
                serviceId={row.id}
                kind="ADD_TIME"
                entry={byAction.get('ADD_TIME')}
                mayGrant={mayGrant}
                onActed={onActed}
              />,
              <ServiceMoveButton
                key="move"
                serviceId={row.id}
                entry={byAction.get('CHANGE_LOCATION')}
                mayEdit={mayEdit}
                onActed={onActed}
              />,
            ],
          },
        ]}
        sensitive={[
          terminate !== undefined && mayTerminate ? (
            <Button
              key="terminate"
              variant="danger"
              icon="trash"
              disabled={terminateBlocked}
              {...(terminateBlocked ? { 'aria-describedby': 'service-blocker-TERMINATE' } : {})}
              onClick={() => setDeleting(true)}
            >
              {t('web.service_delete_open')}
            </Button>
          ) : null,
        ]}
        disabledReasons={reasons}
      />
      {terminate !== undefined && mayTerminate && !terminateBlocked && (
        <ServiceDeleteModal
          open={deleting}
          onClose={() => setDeleting(false)}
          serviceId={row.id}
          serviceUsername={row.providerUsername}
          mayRefund={mayRefund}
          deleteOnly={{
            pending: act.isPending,
            run: (phrase) => act.mutate({ action: 'TERMINATE', confirm: phrase }),
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function ServiceDetailPage({
  id,
  denied,
  mayEdit,
  mayTerminate,
  mayViewRefundRequests = false,
  mayDecideRefundRequests = false,
  mayGrant = false,
}: {
  id: string;
  denied: boolean;
  mayEdit: boolean;
  mayTerminate: boolean;
  /** Program §13: `services.grant`, an operator's free traffic or time. */
  mayGrant?: boolean;
  /** `refunds.view`: this service's customer refund requests (WP19). */
  mayViewRefundRequests?: boolean;
  /** `refunds.issue` AND `services.terminate`: deciding one. A courtesy; the server decides. */
  mayDecideRefundRequests?: boolean;
}) {
  const client = useQueryClient();

  /*
   * Both queries again after a write, and not just the detail.
   *
   * An action plans an operation, so the HISTORY changed too, and the operations card
   * sits on the same screen. Refreshing only the row would leave a suspend that was
   * just requested absent from the list of what has been attempted — which is the one
   * place an operator looks to find out whether their press did anything.
   */
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['service', id] });
    void client.invalidateQueries({ queryKey: ['service-operations', id] });
    void client.invalidateQueries({ queryKey: ['services'] });
  };

  const service = useQuery({
    queryKey: ['service', id],
    queryFn: () => fetchService(id),
    enabled: !denied,
  });
  const row = service.data?.service;

  /*
   * The operations are a SECOND query, and it is not gated on the first.
   *
   * Both charge `services.view` and both answer `SERVICE_NOT_FOUND` for an id that is
   * not this tenant's — `ServiceAdminService.operations` reads the service first for
   * exactly that reason — so the pair cannot disagree about whether the service exists.
   * Running them together means the history is on screen with the detail rather than
   * one round trip later.
   */
  const operations = useQuery({
    queryKey: ['service-operations', id],
    queryFn: () => fetchServiceOperations(id),
    enabled: !denied,
    /*
     * Program §13: an action's progress. While any operation has not reached its own end,
     * the history (and with it the row) is read again, so PLANNED → IN_FLIGHT → its outcome
     * appears without a reload. UNKNOWN is an end for this purpose: it waits on a read, not
     * on this page.
     */
    refetchInterval: (query) =>
      (query.state.data?.operations ?? []).some(
        (op) => op.state === 'PLANNED' || op.state === 'IN_FLIGHT',
      )
        ? 5_000
        : false,
  });

  // Program §13 (Codex review of #157): an operation's end re-reads the service it changed.
  useRefreshOnOperationChange(id, operations.data?.operations);

  const [deleting, setDeleting] = useState(false);
  const act = useServiceAction(id, refresh, () => setDeleting(false));

  /*
   * The refund requests are drawn whatever the service query says: a finance
   * reviewer holding `refunds.view` reaches this service's requests even where the
   * service itself is refused (WP19).
   */
  const refundRequests = mayViewRefundRequests ? (
    <ServiceRefundRequestsCard serviceId={id} mayDecide={mayDecideRefundRequests} />
  ) : null;

  return (
    <>
      {row === undefined && (
        <>
          <PageHead title={t('web.service_detail')} subtitle={t('web.services_intro')} />
          {refundRequests}
        </>
      )}

      <StateSwitch query={service} denied={denied}>
        {row === undefined ? null : (
          <>
            <PageHead
              // The demo's title keeps its copy control, drawn only on hover or focus at
              // desktop and always on a phone (`.ca-title-id`, commerce-a.css).
              title={
                <span className="ca-title-id">
                  <Ltr>{row.providerUsername}</Ltr>
                  <CopyButton value={row.providerUsername} />
                </span>
              }
              badge={
                <span className="ca-badges">
                  <StateBadge value={row.state} />
                  <DeliveryBadge value={row.deliveryState} />
                  {row.isTrial && <Badge tone="info">{t('web.service_trial_badge')}</Badge>}
                </span>
              }
              subtitle={t('web.service_detail')}
            />
            {/*
              Track 3 §3: one quiet line for a service the one-time import carried over, with
              the purchase date the previous bot recorded — the date the list orders it by.
              Provenance only; the service is otherwise an ordinary one.
            */}
            {row.source === 'MIRZA' && (
              <p className="muted small">
                {t('web.service_imported_line').replace(
                  '{date}',
                  formatDate(row.originalStartedAt ?? row.createdAt),
                )}
              </p>
            )}

            <ServiceActionPanel
              row={row}
              mayEdit={mayEdit}
              mayTerminate={mayTerminate}
              mayGrant={mayGrant}
              mayRefund={mayDecideRefundRequests}
              act={act}
              deleting={deleting}
              setDeleting={setDeleting}
              onActed={refresh}
            />

            {row.original != null && <OriginalPurchase original={row.original} />}

            {row.state === 'UNRECONCILED' && (
              <Banner tone="warn">{t('web.service_unreconciled_banner')}</Banner>
            )}
            {row.deliveryState === 'UNCONFIRMED' && (
              <Banner tone="warn">{t('web.service_delivery_unconfirmed_banner')}</Banner>
            )}
            {row.deliveryState === 'FAILED' && (
              <Banner tone="danger">{t('web.service_delivery_failed_banner')}</Banner>
            )}

            <ServiceStats row={row} />

            {refundRequests}

            {/* W4: the identity card and the delivery card share one height. */}
            <BalancedColumns
              main={<ServiceIdentity row={row} />}
              side={<ServiceDelivery row={row} />}
            />

            <Card
              id={SERVICE_PROVISIONING_ANCHOR}
              title={t('web.service_operations_title')}
              hint={t('web.service_operations_hint')}
            >
              <StateSwitch query={operations} denied={denied}>
                {operations.data === undefined ? null : operations.data.operations.length === 0 ? (
                  <Empty variant="compact" title={t('web.service_operations_empty')} />
                ) : (
                  <>
                    <OperationsTable operations={operations.data.operations} />
                    {/*
                      Printed only when the server says the history was CUT, and with the
                      server's own bound. `operations.length === limit` is the wrong test
                      and is why the response carries `hasMore`: a service with exactly
                      fifty operations has a full page and nothing behind it.
                    */}
                    {operations.data.hasMore && (
                      <p className="muted small">
                        {t('web.service_operations_truncated')}{' '}
                        <Num value={operations.data.limit} />
                      </p>
                    )}
                  </>
                )}
              </StateSwitch>
            </Card>
          </>
        )}
      </StateSwitch>
    </>
  );
}

/** The history, ten operations at a time (W1.8); the server sends it whole, newest first. */
function OperationsTable({ operations }: { operations: readonly ServiceOperationResponse[] }) {
  const page = usePagedRows(operations);
  return (
    <>
      <DataTable
        stack="labelled"
        caption={t('web.service_operations_title')}
        columns={OPERATION_COLUMNS}
        rows={page.rows}
        rowKey={(op) => op.id}
        dense
      />
      {page.pager}
    </>
  );
}

type ServiceDetail = NonNullable<Awaited<ReturnType<typeof fetchService>>['service']>;

/**
 * An imported service's original purchase — the product name and price the customer first
 * bought it as (owner rule 2026-10-18), from the archived invoice: one muted line, display
 * only. Each part shows only when the server sent it.
 */
function OriginalPurchase({ original }: { original: NonNullable<ServiceDetail['original']> }) {
  return (
    <p className="ca-stat-line faint" data-testid="service-original-purchase">
      {original.productName !== null && (
        <span>
          {t('web.service_original_product')}: {original.productName}
        </span>
      )}
      {original.productName !== null && original.price !== null && <span> · </span>}
      {original.price !== null && (
        <span>
          {t('web.service_original_price')}:{' '}
          <Money
            value={{ amountMinor: original.price.amount, currency: original.price.currency }}
          />
        </span>
      )}
    </p>
  );
}

/**
 * The summary strip: traffic, expiry, delivery attempts and devices — each a field
 * the server sent, each drawn once. The counter carries its freshness beside it:
 * a number that looks live and was written days ago is the legacy statistics
 * screen, so `usageSyncedAt` null is a SENTENCE ("never read"), not a dash.
 */
function ServiceStats({ row }: { row: ServiceDetail }) {
  const limit = BigInt(row.trafficLimitBytes);
  const used = BigInt(row.trafficUsedBytes);
  const unlimited = limit === UNLIMITED_TRAFFIC_BYTES;
  return (
    <div className="ca-stats">
      <StatCard
        icon="activity"
        label={t('web.service_traffic_used')}
        value={<Num value={formatTrafficGbText(used)} />}
        unit={t('web.unit_gib')}
        hint={
          <span className="ca-stat-line">
            <span>{t('web.service_traffic_limit')}</span>
            <TrafficLimit bytes={row.trafficLimitBytes} />
          </span>
        }
      >
        {!unlimited && <UsageMeter used={used} limit={limit} />}
        <span className="ca-stat-line faint">
          <span>{t('web.service_usage_synced_at')}</span>
          {row.usageSyncedAt === null ? (
            <span>{t('web.service_usage_never')}</span>
          ) : (
            <span>{formatTimestampNumeric(row.usageSyncedAt)}</span>
          )}
        </span>
      </StatCard>
      <StatCard
        icon="calendar"
        label={t('web.service_expires_at')}
        value={
          row.expiresAt === null ? (
            <Dash />
          ) : (
            <span className="ca-stat-when">{formatTimestampNumeric(row.expiresAt)}</span>
          )
        }
      />
      <StatCard
        icon="send"
        label={t('web.service_delivery_attempts')}
        value={<Num value={row.deliveryAttempts} />}
        hint={
          <span className="ca-stat-line">
            <span>{t('web.service_delivery_next_attempt')}</span>
            {row.deliveryNextAttemptAt === null ? (
              <Dash />
            ) : (
              <span>{formatTimestampNumeric(row.deliveryNextAttemptAt)}</span>
            )}
          </span>
        }
      />
      <StatCard
        icon="devices"
        label={t('web.service_device_limit')}
        value={
          row.deviceLimit === null ? (
            <span className="ca-stat-sentence">{t('web.service_device_limit_none')}</span>
          ) : (
            <Num value={row.deviceLimit} />
          )
        }
      />
    </div>
  );
}

/**
 * The traffic bar with its percentage beside it («۷۱٪»), as the demo's usage tile draws it:
 * neutral below 75%, warn above it, danger above 90%. The figure is the exact ratio of the
 * two byte counts the server sent, rounded once.
 */
function UsageMeter({ used, limit }: { used: bigint; limit: bigint }) {
  const percent = Math.round(progressRatio(used, limit) * 100);
  const tone: Tone = percent > 90 ? 'danger' : percent > 75 ? 'warn' : 'neutral';
  return (
    <span className="svc-usage-meter">
      <Progress value={used} max={limit} label={t('web.service_traffic_used')} tone={tone} />
      <span className="num">{`${formatNumber(percent)}${t('web.percent_sign')}`}</span>
    </span>
  );
}

/**
 * Who and what this service belongs to (PR-C): the customer by Telegram id and name, the
 * order by its code, the panel by its name and the product by «P-102 · name» — each a link to
 * its page, and never a uuid, which only «کپی شناسه» reaches.
 */
function ServiceIdentity({ row }: { row: ServiceDetail }) {
  const onLink = useLinkHandler();
  return (
    <Card title={t('web.service_identity_title')}>
      <KV
        items={[
          [t('web.record_code'), <CodeWithCopy key="code" code={row.code} id={row.id} />],
          [t('web.service_provider_user_id'), <PanelUsername key="pu" row={row} />],
          [
            // The panel's own id for the account, beside the name an operator searches for.
            t('web.service_panel_account_id'),
            row.providerUserId === null ? (
              <Dash key="pa" />
            ) : (
              <Copyable key="pa" value={row.providerUserId} />
            ),
          ],
          [
            t('web.service_customer'),
            <span key="c" className="nowrap record-ref">
              <CustomerIdentityLink
                customerId={row.customerId}
                telegramUserId={row.customerTelegramUserId}
                username={row.customerUsername}
                onLink={onLink}
              />
              {row.customerDisplayName !== null && (
                <span className="muted">{row.customerDisplayName}</span>
              )}
              <CopyIdButton id={row.customerId} />
            </span>,
          ],
          [
            t('web.service_order'),
            <RecordLink
              key="o"
              href={recordHref.order(row.orderId)}
              id={row.orderId}
              code={row.orderCode}
            />,
          ],
          [t('web.service_panel'), <PanelLink key="p" id={row.panelId} name={row.panelName} />],
          [
            t('web.service_product'),
            // Package D: a custom service has no product, and says so rather than
            // linking to one that does not exist.
            row.productId === null ? (
              <span key="pr" className="muted">
                {t('web.purpose_custom_service')}
              </span>
            ) : (
              <ProductLink
                key="pr"
                id={row.productId}
                code={row.productCode}
                title={row.productTitle}
              />
            ),
          ],
          [t('web.service_created_at'), formatTimestampNumeric(row.createdAt)],
          [t('web.service_updated_at'), formatTimestampNumeric(row.updatedAt)],
        ]}
      />
      <p className="muted small">{t('web.service_username_hint')}</p>
    </Card>
  );
}

/** A record's own code with the copy-id action beside it — on its own page, so not a link. */
function CodeWithCopy({ code, id }: { code: string | null; id: string }) {
  return (
    <span className="nowrap record-ref">
      <CodeText code={code} />
      <CopyIdButton id={id} />
    </span>
  );
}

/**
 * «شناسهٔ کاربری در پنل» (PR-C): the username the panel holds for this service, once the
 * panel has the account. Until then the reserved name is NOT the panel's — saying it is would
 * send an operator to search a panel for an account that is not there — so the cell says why
 * it is empty, from the service's own state, and links to the provisioning history below.
 */
export function panelUsernameAbsence(
  row: Pick<ServiceDetail, 'providerUserId' | 'provisionedAt' | 'state'>,
): WebKey | null {
  if (row.providerUserId !== null || row.provisionedAt !== null) return null;
  if (row.state === 'UNRECONCILED') return 'web.service_panel_username_unknown';
  if (row.state === 'PENDING_PROVISION') return 'web.service_panel_username_pending';
  return 'web.service_panel_username_never';
}

function PanelUsername({ row }: { row: ServiceDetail }) {
  const absence = panelUsernameAbsence(row);
  if (absence === null) return <Copyable value={row.providerUsername} />;
  return (
    <span className="muted">
      {t(absence)}{' '}
      <a className="lk" href={`#${SERVICE_PROVISIONING_ANCHOR}`}>
        {t('web.service_panel_username_history')}
      </a>
    </span>
  );
}

/** The provisioning history card's anchor, which the panel-username cell links to. */
const SERVICE_PROVISIONING_ANCHOR = 'service-provisioning';

/**
 * Delivery, on its own, with the subscription reduced to a yes or a no.
 *
 * `hasSubscription` is a boolean in the CONTRACT: the surface needs to know whether
 * the thing exists, and nothing about the operator's job needs its value. The
 * sentence below says it is withheld rather than absent.
 */
function ServiceDelivery({ row }: { row: ServiceDetail }) {
  return (
    <Card title={t('web.service_delivery')}>
      <KV
        items={[
          [
            t('web.service_subscription'),
            row.hasSubscription
              ? t('web.service_subscription_present')
              : t('web.service_subscription_absent'),
          ],
          [
            t('web.service_delivered_at'),
            row.deliveredAt === null ? <Dash key="da" /> : formatTimestampNumeric(row.deliveredAt),
          ],
          [
            t('web.service_provisioned_at'),
            row.provisionedAt === null ? (
              <Dash key="pa" />
            ) : (
              formatTimestampNumeric(row.provisionedAt)
            ),
          ],
          [
            t('web.service_terminated_at'),
            row.terminatedAt === null ? (
              <Dash key="ta" />
            ) : (
              formatTimestampNumeric(row.terminatedAt)
            ),
          ],
        ]}
      />
      <p className="muted small">{t('web.service_subscription_withheld')}</p>
    </Card>
  );
}

const OPERATION_COLUMNS: readonly Column<ServiceOperationResponse>[] = [
  {
    key: 'type',
    header: t('web.operation_type'),
    render: (op) => <span className="strong">{t(OPERATION_TYPE_LABELS[op.type])}</span>,
  },
  {
    key: 'state',
    header: t('web.operation_state'),
    render: (op) => (
      <Badge tone={OPERATION_STATE_TONES[op.state]} dot>
        {t(OPERATION_STATE_LABELS[op.state])}
      </Badge>
    ),
  },
  {
    key: 'attempts',
    header: t('web.operation_attempts'),
    align: 'end',
    render: (op) => <Num value={op.attempts} />,
  },
  {
    key: 'created',
    header: t('web.operation_created_at'),
    render: (op) => <span className="nowrap">{formatTimestampNumeric(op.createdAt)}</span>,
  },
  {
    key: 'scheduled',
    header: t('web.operation_scheduled_at'),
    render: (op) =>
      op.scheduledAt === null ? (
        <Dash />
      ) : (
        <span className="nowrap">{formatTimestampNumeric(op.scheduledAt)}</span>
      ),
  },
  {
    key: 'completed',
    header: t('web.operation_completed_at'),
    render: (op) =>
      op.completedAt === null ? (
        <Dash />
      ) : (
        <span className="nowrap">{formatTimestampNumeric(op.completedAt)}</span>
      ),
  },
  {
    key: 'failure',
    header: t('web.operation_failure'),
    wrap: true,
    // The adapter's own words, verbatim: the one place an operator learns what the
    // panel actually said.
    render: (op) =>
      op.failureMessage === null ? (
        <Dash />
      ) : (
        <ProviderText summary={'web.err_provider_operation'} text={op.failureMessage} />
      ),
  },
];

/** Re-exported so the shell can read a query's state without importing the page's guts. */
export { queryState };
