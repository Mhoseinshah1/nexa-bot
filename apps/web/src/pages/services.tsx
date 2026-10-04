import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { formatTimestamp, formatTrafficGbText } from '../format';
import { messageFor } from './settings';
import { useSubmissionKey } from '../submission-key';
import { mayRequest, queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { setQueries, setQuery, useLinkHandler, type Route } from '../router';
import { ListSearchBox, appliedListSearch } from '../ui/list-search';
import { CustomerIdentityLink } from '../ui/customer-identity';
import { ChipGroup } from './commerce-parts';
import {
  Badge,
  Banner,
  Button,
  ButtonGroup,
  Card,
  ChipDivider,
  CopyButton,
  Copyable,
  CursorPager,
  DataTable,
  Empty,
  KV,
  Ltr,
  Num,
  PageHead,
  Progress,
  StatCard,
  StateSwitch,
  TwoColumn,
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
  ServiceFilterSelects,
  ServiceGrantMoveCard,
  ServiceMassActionCard,
  serviceFiltersOf,
  useRefreshOnOperationChange,
} from './service-ops';

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
 * transfer, from the bot, and no operator transfer. `services_transfer_absent` says so in
 * words, and that each customer transfer is in the audit log, rather than as a disabled
 * button: a disabled control claims "this exists and you lack permission", which is a
 * different and false statement.
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

  const services = useQuery({
    queryKey: [
      'services',
      cursor,
      state,
      delivery,
      appliedSearch,
      filters.panelId,
      filters.productId,
      filters.locationKey,
      filters.expiringWithinHours,
    ],
    queryFn: () =>
      fetchServices({
        ...(cursor === null ? {} : { cursor }),
        ...(state === null ? {} : { state: state as ServiceState }),
        ...(delivery === null ? {} : { deliveryState: delivery as ServiceDeliveryState }),
        ...(appliedSearch === '' ? {} : { q: appliedSearch }),
        ...(filters.panelId === null ? {} : { panelId: filters.panelId }),
        ...(filters.productId === null ? {} : { productId: filters.productId }),
        ...(filters.locationKey === null ? {} : { locationKey: filters.locationKey }),
        ...(filters.expiringWithinHours === null
          ? {}
          : { expiringWithinHours: filters.expiringWithinHours }),
      }),
    enabled: !denied,
  });

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
      render: (row) => (
        <a href={`/panels/${encodeURIComponent(row.panelId)}`} onClick={onLink}>
          <Ltr>{row.panelId.slice(0, 8)}</Ltr>
        </a>
      ),
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
          <span className="nowrap">{formatTimestamp(row.expiresAt)}</span>
        ),
    },
    {
      key: 'created',
      header: t('web.service_created_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
  ];

  // Hidden while the list cannot answer: a control that mints a new query key is
  // a fresh request against a question the server has just refused.
  const toolbarHidden = !mayRequest(services, denied);

  return (
    <>
      <PageHead title={t('web.services_title')} subtitle={t('web.services_intro')} />
      {/* Its own permission, not the list's: `refunds.view` alone reaches the queue (WP19). */}
      {mayViewRefundRequests && <OpenServiceRefundRequestsCard />}

      <Card className="ca-list">
        <ListSearchBox
          route={route}
          id="services-search"
          hint={t('web.services_search_hint')}
          hidden={toolbarHidden}
          // A new search starts at the first page: this list keeps its cursor in the URL.
          resetKeys={['cursor']}
        />

        <div className="filter-row" hidden={toolbarHidden}>
          <ChipGroup
            label={t('web.service_state')}
            value={state ?? 'ALL'}
            onChange={(next) =>
              setQueries(route, [
                ['state', next === 'ALL' ? null : next],
                ['cursor', null],
              ])
            }
            items={[
              { id: 'ALL', label: t('web.services_filter_all') },
              ...SERVICE_STATES.map((one) => ({ id: one, label: t(STATE_LABELS[one]) })),
            ]}
          />
          <ChipDivider />
          <ChipGroup
            label={t('web.service_delivery')}
            value={delivery ?? 'ALL'}
            onChange={(next) =>
              setQueries(route, [
                ['deliveryState', next === 'ALL' ? null : next],
                ['cursor', null],
              ])
            }
            items={[
              { id: 'ALL', label: t('web.services_filter_all') },
              ...SERVICE_DELIVERY_STATES.map((one) => ({
                id: one,
                label: t(DELIVERY_LABELS[one]),
              })),
            ]}
          />
        </div>
        {!toolbarHidden && (
          <ServiceFilterSelects
            route={route}
            filters={filters}
            mayViewPanels={mayViewPanels}
            mayViewCatalog={mayViewCatalog}
          />
        )}

        <StateSwitch query={services} denied={denied}>
          {services.data === undefined ? null : services.data.services.length === 0 ? (
            <Empty title={t('web.services_empty')} hint={t('web.services_empty_hint')} />
          ) : (
            <>
              <DataTable
                caption={t('web.services_title')}
                columns={columns}
                rows={services.data.services}
                rowKey={(row) => row.id}
                dense
                sticky
              />
              {/*
                `CursorPager`'s DEFAULT labels, and that is the difference from
                `/users`, `/orders` and `/products`: `GET /services` pages a
                DESCENDING keyset, newest service first (owner revision 13), so
                "next" here really is the older page. The three ascending lists
                pass the opposite pair explicitly for the opposite reason.

                The cursor lives in the URL, so Previous returns to the first page.
              */}
              <CursorPager
                shown={services.data.services.length}
                hasPrevious={cursor !== null}
                hasNext={services.data.nextCursor !== null}
                onPrevious={() => setQuery(route, 'cursor', null)}
                onNext={() => setQuery(route, 'cursor', services.data?.nextCursor ?? null)}
              />
            </>
          )}
        </StateSwitch>
      </Card>

      {/* Program §13: one mass action over exactly what the filters above select. */}
      {!denied && (mayMassStatus || mayMassGrant) && (
        <ServiceMassActionCard
          filters={filters}
          mayStatus={mayMassStatus}
          mayGrant={mayMassGrant}
        />
      )}

      {/* Owner revisions 12, 13 and 14, moved off the placeholder this route replaced.
          Revision 13 is DELIVERED — the repository pages descending because of it — and
          the other two are still absences. A decision recorded only on a screen nobody
          can open is a decision nobody reads before breaking it. */}
      <Card tone="muted" title={t('web.services_rules_title')}>
        <ul className="ca-notes">
          <li>{t('web.services_rule_no_protocol')}</li>
          <li>{t('web.services_rule_ordering')}</li>
          <li>{t('web.services_rule_plan_filter')}</li>
          <li>{t('web.services_transfer_absent')}</li>
        </ul>
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
      toast({ tone: 'danger', message: messageFor(error) });
    },
  });
}

type ServiceAct = ReturnType<typeof useServiceAction>;

/** The ordinary actions, one button each, in `SERVICE_OPERATOR_ACTIONS` order. */
function ActionButtons({
  actions,
  mayEdit,
  act,
}: {
  actions: readonly ServiceActionAvailability[];
  mayEdit: boolean;
  act: ServiceAct;
}) {
  const byAction = new Map(actions.map((entry) => [entry.action, entry]));
  const ordinary = SERVICE_OPERATOR_ACTIONS.filter(
    (action): action is ServiceSimpleAction =>
      !ACTION_NEEDS_TERMINATE[action] && !INPUT_ACTIONS.has(action),
  );
  return (
    <ButtonGroup label={t('web.service_actions_title')}>
      {ordinary.map((action) => {
        const entry = byAction.get(action);
        if (entry === undefined) return null;
        const why = !entry.available && entry.blocker !== null;
        return (
          <Button
            key={action}
            size="sm"
            disabled={!mayEdit || !entry.available || act.isPending}
            {...(why ? { 'aria-describedby': `service-blocker-${action}` } : {})}
            onClick={() => act.mutate({ action })}
          >
            {t(ACTION_LABELS[action])}
          </Button>
        );
      })}
    </ButtonGroup>
  );
}

/**
 * Why each unavailable action is unavailable, in words, and whether this session
 * may press any of them. A greyed-out control with no reason is the legacy
 * panel's entire style of refusal; each blocker sentence sends an operator
 * somewhere different.
 */
function ActionNotes({
  actions,
  mayEdit,
}: {
  actions: readonly ServiceActionAvailability[];
  mayEdit: boolean;
}) {
  const byAction = new Map(actions.map((entry) => [entry.action, entry]));
  const blocked = SERVICE_OPERATOR_ACTIONS.filter((action) => {
    const entry = byAction.get(action);
    return (
      !ACTION_NEEDS_TERMINATE[action] &&
      entry !== undefined &&
      !entry.available &&
      entry.blocker !== null
    );
  });
  return (
    <Card title={t('web.service_actions_title')} hint={t('web.service_actions_hint')}>
      {!mayEdit && <Banner tone="neutral">{t('web.service_action_denied_edit')}</Banner>}
      {blocked.length > 0 && (
        <dl className="kv ca-blockers">
          {blocked.map((action) => {
            const blocker = byAction.get(action)?.blocker;
            return (
              <div key={action}>
                <dt>{t(ACTION_LABELS[action])}</dt>
                <dd id={`service-blocker-${action}`}>
                  {blocker === null || blocker === undefined ? null : t(BLOCKER_LABELS[blocker])}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </Card>
  );
}

/**
 * Terminate, isolated: its own permission, its own blocker — and, since item 11, a modal
 * that offers «فقط حذف سرویس» (the typed phrase, as before) or «حذف سرویس و بازگشت وجه».
 */
function TerminateCard({
  entry,
  serviceId,
  serviceUsername,
  mayTerminate,
  mayRefund,
  act,
  open,
  setOpen,
}: {
  entry: ServiceActionAvailability;
  serviceId: string;
  serviceUsername: string;
  mayTerminate: boolean;
  mayRefund: boolean;
  act: ServiceAct;
  open: boolean;
  setOpen: (next: boolean) => void;
}) {
  return (
    <Card tone="danger" title={t('web.service_terminate_title')}>
      <p className="muted small">{t('web.service_terminate_danger')}</p>
      {!mayTerminate ? (
        <Banner tone="neutral">{t('web.service_action_denied_terminate')}</Banner>
      ) : !entry.available && entry.blocker !== null ? (
        <p className="muted small">{t(BLOCKER_LABELS[entry.blocker])}</p>
      ) : (
        <>
          <div className="form-actions">
            <Button variant="danger" icon="trash" onClick={() => setOpen(true)}>
              {t('web.service_delete_open')}
            </Button>
          </div>
          <ServiceDeleteModal
            open={open}
            onClose={() => setOpen(false)}
            serviceId={serviceId}
            serviceUsername={serviceUsername}
            mayRefund={mayRefund}
            deleteOnly={{
              pending: act.isPending,
              run: (phrase) => act.mutate({ action: 'TERMINATE', confirm: phrase }),
            }}
          />
        </>
      )}
    </Card>
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
              actions={<ActionButtons actions={row.actions} mayEdit={mayEdit} act={act} />}
            />

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

            <ServiceGrantMoveCard
              serviceId={row.id}
              actions={row.actions}
              mayGrant={mayGrant}
              mayEdit={mayEdit}
              blockerLabel={(blocker) => t(BLOCKER_LABELS[blocker])}
              onActed={refresh}
            />

            <TwoColumn
              main={<ServiceIdentity row={row} />}
              side={
                <>
                  <ActionNotes actions={row.actions} mayEdit={mayEdit} />
                  <ServiceDelivery row={row} />
                </>
              }
            />

            <Card title={t('web.service_operations_title')} hint={t('web.service_operations_hint')}>
              <StateSwitch query={operations} denied={denied}>
                {operations.data === undefined ? null : operations.data.operations.length === 0 ? (
                  <Empty variant="compact" title={t('web.service_operations_empty')} />
                ) : (
                  <>
                    <DataTable
                      caption={t('web.service_operations_title')}
                      columns={OPERATION_COLUMNS}
                      rows={operations.data.operations}
                      rowKey={(op) => op.id}
                      dense
                    />
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

            <Card tone="muted">
              <p className="muted small">{t('web.services_transfer_absent')}</p>
            </Card>

            {(() => {
              const terminate = row.actions.find((entry) => entry.action === 'TERMINATE');
              return terminate === undefined ? null : (
                <TerminateCard
                  entry={terminate}
                  serviceId={row.id}
                  serviceUsername={row.providerUsername}
                  mayTerminate={mayTerminate}
                  mayRefund={mayDecideRefundRequests}
                  act={act}
                  open={deleting}
                  setOpen={setDeleting}
                />
              );
            })()}
          </>
        )}
      </StateSwitch>
    </>
  );
}

type ServiceDetail = NonNullable<Awaited<ReturnType<typeof fetchService>>['service']>;

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
        {!unlimited && <Progress value={used} max={limit} label={t('web.service_traffic_used')} />}
        <span className="ca-stat-line faint">
          <span>{t('web.service_usage_synced_at')}</span>
          {row.usageSyncedAt === null ? (
            <span>{t('web.service_usage_never')}</span>
          ) : (
            <span>{formatTimestamp(row.usageSyncedAt)}</span>
          )}
        </span>
      </StatCard>
      <StatCard
        icon="calendar"
        label={t('web.service_expires_at')}
        value={row.expiresAt === null ? <Dash /> : formatTimestamp(row.expiresAt)}
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
              <span>{formatTimestamp(row.deliveryNextAttemptAt)}</span>
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

/** Who and what this service belongs to, as full-id links. */
function ServiceIdentity({ row }: { row: ServiceDetail }) {
  const onLink = useLinkHandler();
  return (
    <Card title={t('web.service_identity_title')}>
      <KV
        items={[
          [
            t('web.service_provider_user_id'),
            row.providerUserId === null ? (
              <Dash key="pu" />
            ) : (
              <Copyable key="pu" value={row.providerUserId} />
            ),
          ],
          [
            t('web.service_customer'),
            <a key="c" href={`/users/${encodeURIComponent(row.customerId)}`} onClick={onLink}>
              <Ltr>{row.customerId}</Ltr>
            </a>,
          ],
          [
            t('web.service_order'),
            <a key="o" href={`/orders/${encodeURIComponent(row.orderId)}`} onClick={onLink}>
              <Ltr>{row.orderId}</Ltr>
            </a>,
          ],
          [
            t('web.service_panel'),
            <a key="p" href={`/panels/${encodeURIComponent(row.panelId)}`} onClick={onLink}>
              <Ltr>{row.panelId}</Ltr>
            </a>,
          ],
          [
            t('web.service_product'),
            // Package D: a custom service has no product, and says so rather than
            // linking to one that does not exist.
            row.productId === null ? (
              <span key="pr" className="muted">
                {t('web.purpose_custom_service')}
              </span>
            ) : (
              <a key="pr" href={`/products/${encodeURIComponent(row.productId)}`} onClick={onLink}>
                <Ltr>{row.productId}</Ltr>
              </a>
            ),
          ],
          [t('web.service_created_at'), formatTimestamp(row.createdAt)],
          [t('web.service_updated_at'), formatTimestamp(row.updatedAt)],
        ]}
      />
      <p className="muted small">{t('web.service_username_hint')}</p>
    </Card>
  );
}

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
            row.deliveredAt === null ? <Dash key="da" /> : formatTimestamp(row.deliveredAt),
          ],
          [
            t('web.service_provisioned_at'),
            row.provisionedAt === null ? <Dash key="pa" /> : formatTimestamp(row.provisionedAt),
          ],
          [
            t('web.service_terminated_at'),
            row.terminatedAt === null ? <Dash key="ta" /> : formatTimestamp(row.terminatedAt),
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
    render: (op) => <span className="nowrap">{formatTimestamp(op.createdAt)}</span>,
  },
  {
    key: 'scheduled',
    header: t('web.operation_scheduled_at'),
    render: (op) =>
      op.scheduledAt === null ? (
        <Dash />
      ) : (
        <span className="nowrap">{formatTimestamp(op.scheduledAt)}</span>
      ),
  },
  {
    key: 'completed',
    header: t('web.operation_completed_at'),
    render: (op) =>
      op.completedAt === null ? (
        <Dash />
      ) : (
        <span className="nowrap">{formatTimestamp(op.completedAt)}</span>
      ),
  },
  {
    key: 'failure',
    header: t('web.operation_failure'),
    wrap: true,
    // The adapter's own words, verbatim: the one place an operator learns what the
    // panel actually said.
    render: (op) =>
      op.failureMessage === null ? <Dash /> : <Ltr mono={false}>{op.failureMessage}</Ltr>,
  },
];

/** Re-exported so the shell can read a query's state without importing the page's guts. */
export { queryState };
