import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SERVICE_DELIVERY_STATES,
  SERVICE_OPERATOR_ACTIONS,
  SERVICE_STATES,
  SERVICE_TERMINATE_CONFIRMATION,
  UNLIMITED_TRAFFIC_BYTES,
  uuidV7Schema,
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
import { actOnService, fetchService, fetchServiceOperations, fetchServices } from '../api/client';
import { formatNumber, formatTimestamp, splitBytes } from '../format';
import { messageFor } from './settings';
import { useSubmissionKey } from '../submission-key';
import { mayRequest, queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { setQueries, setQuery, useLinkHandler, type Route } from '../router';
import {
  Badge,
  Banner,
  Card,
  Copyable,
  CursorPager,
  DataTable,
  Empty,
  Field,
  KV,
  Ltr,
  PageHead,
  Pills,
  StateSwitch,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';

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
 * `services.transfer` is still declared with no endpoint, and
 * `services_transfer_absent` says so in words rather than as a disabled button: a
 * disabled control claims "this exists and you lack permission", which is a different
 * and false statement.
 */

const STATE_LABELS: Readonly<Record<ServiceState, WebKey>> = {
  PENDING_PROVISION: 'web.service_state_pending_provision',
  ACTIVE: 'web.service_state_active',
  SUSPENDED: 'web.service_state_suspended',
  EXPIRED: 'web.service_state_expired',
  TERMINATED: 'web.service_state_terminated',
  UNRECONCILED: 'web.service_state_unreconciled',
};

const STATE_TONES: Readonly<Record<ServiceState, Tone>> = {
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

const DELIVERY_LABELS: Readonly<Record<ServiceDeliveryState, WebKey>> = {
  PENDING: 'web.service_delivery_pending',
  DELIVERED: 'web.service_delivery_delivered',
  UNCONFIRMED: 'web.service_delivery_unconfirmed',
  FAILED: 'web.service_delivery_failed',
};

const DELIVERY_TONES: Readonly<Record<ServiceDeliveryState, Tone>> = {
  PENDING: 'neutral',
  DELIVERED: 'ok',
  UNCONFIRMED: 'warn',
  FAILED: 'danger',
};

const OPERATION_TYPE_LABELS: Readonly<Record<OperationType, WebKey>> = {
  PROVISION: 'web.operation_type_provision',
  RENEW: 'web.operation_type_renew',
  ADD_TRAFFIC: 'web.operation_type_add_traffic',
  ADD_TIME: 'web.operation_type_add_time',
  SUSPEND: 'web.operation_type_suspend',
  RESUME: 'web.operation_type_resume',
  TERMINATE: 'web.operation_type_terminate',
  SYNC_USAGE: 'web.operation_type_sync_usage',
  ROTATE_SUBSCRIPTION: 'web.operation_type_rotate_subscription',
  RECONCILE: 'web.operation_type_reconcile',
};

const OPERATION_STATE_LABELS: Readonly<Record<OperationState, WebKey>> = {
  PLANNED: 'web.operation_state_planned',
  IN_FLIGHT: 'web.operation_state_in_flight',
  SUCCEEDED: 'web.operation_state_succeeded',
  FAILED: 'web.operation_state_failed',
  UNKNOWN: 'web.operation_state_unknown',
  ABANDONED: 'web.operation_state_abandoned',
};

const OPERATION_STATE_TONES: Readonly<Record<OperationState, Tone>> = {
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
  return <Badge tone={STATE_TONES[value]}>{t(STATE_LABELS[value])}</Badge>;
}

function DeliveryBadge({ value }: { value: ServiceDeliveryState }) {
  return <Badge tone={DELIVERY_TONES[value]}>{t(DELIVERY_LABELS[value])}</Badge>;
}

function Dash() {
  return <span className="faint">—</span>;
}

/**
 * A byte figure, or the word for "no limit".
 *
 * `splitBytes` deliberately does not handle zero: `UNLIMITED_TRAFFIC_BYTES` is zero and
 * a formatter that rendered it as "0 MiB" would state the opposite of what it means.
 * The USED counter goes through the plain formatter, because zero used is zero used.
 */
function TrafficLimit({ bytes }: { bytes: string }) {
  const value = BigInt(bytes);
  if (value === UNLIMITED_TRAFFIC_BYTES) return <span>{t('web.product_unlimited')}</span>;
  return <Bytes bytes={value} />;
}

function Bytes({ bytes }: { bytes: bigint }) {
  const { value, unit } = splitBytes(bytes);
  return (
    <span className="nowrap">
      <Ltr>{value}</Ltr> {t(unit)}
    </span>
  );
}

/** A full id, or the field's own error. The guard `/payments` and `/orders` both use. */
function idProblem(value: string): string | undefined {
  if (value === '') return undefined;
  return uuidV7Schema.safeParse(value).success ? undefined : t('web.services_filter_invalid_id');
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function ServicesPage({ route, denied }: { route: Route; denied: boolean }) {
  const onLink = useLinkHandler();
  const cursor = route.query.get('cursor');
  const state = route.query.get('state');
  const delivery = route.query.get('deliveryState');
  const appliedCustomer = route.query.get('customerId') ?? '';
  const appliedPanel = route.query.get('panelId') ?? '';

  /*
   * The drafts are keyed to the APPLIED values, so navigation that drops the query
   * clears the boxes. `users.tsx` records the defect: the sidebar link re-renders this
   * component with an empty query rather than remounting it, and a `useState`
   * initialiser runs once per mount — leaving criteria on screen that no longer apply.
   */
  const appliedSignature = `${appliedCustomer}|${appliedPanel}`;
  const [draft, setDraft] = useState({
    signature: appliedSignature,
    customerId: appliedCustomer,
    panelId: appliedPanel,
  });
  if (draft.signature !== appliedSignature) {
    setDraft({
      signature: appliedSignature,
      customerId: appliedCustomer,
      panelId: appliedPanel,
    });
  }

  const services = useQuery({
    queryKey: ['services', cursor, state, delivery, appliedCustomer, appliedPanel],
    queryFn: () =>
      fetchServices({
        ...(cursor === null ? {} : { cursor }),
        ...(state === null ? {} : { state: state as ServiceState }),
        ...(delivery === null ? {} : { deliveryState: delivery as ServiceDeliveryState }),
        ...(appliedCustomer === '' ? {} : { customerId: appliedCustomer }),
        ...(appliedPanel === '' ? {} : { panelId: appliedPanel }),
      }),
    enabled: !denied,
  });

  const customerProblem = idProblem(draft.customerId);
  const panelProblem = idProblem(draft.panelId);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (customerProblem !== undefined || panelProblem !== undefined) return;
    // ONE navigation for both. Separate `setQuery` calls each build from the
    // `route.query` this render captured, so the earlier ones are dropped.
    setQueries(route, [
      ['customerId', draft.customerId === '' ? null : draft.customerId],
      ['panelId', draft.panelId === '' ? null : draft.panelId],
      // A new filter starts at the first page. Carrying a cursor from one filter to
      // another pages through a list that no longer exists.
      ['cursor', null],
    ]);
  };

  const columns: readonly Column<ServiceSummaryResponse>[] = [
    {
      key: 'username',
      header: t('web.service_username'),
      render: (row) => (
        <a href={`/services/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
          <Ltr>{row.providerUsername}</Ltr>
        </a>
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
      render: (row) => (
        <a href={`/users/${encodeURIComponent(row.customerId)}`} onClick={onLink}>
          <Ltr>{row.customerId.slice(0, 8)}</Ltr>
        </a>
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

  return (
    <>
      <PageHead title={t('web.services_title')} subtitle={t('web.services_intro')} maturity="now" />

      <Card>
        <div hidden={!mayRequest(services, denied)}>
          <Pills
            value={state ?? 'ALL'}
            onChange={(next) =>
              setQueries(route, [
                ['state', next === 'ALL' ? null : next],
                ['cursor', null],
              ])
            }
            items={[
              { id: 'ALL', label: t('web.services_filter_all') },
              // Over the FROZEN vocabulary, so a state added to the contract without a
              // filter here is a compile error rather than an option nobody notices is
              // missing. The shape `/orders` and `/payments` both use.
              ...SERVICE_STATES.map((one) => ({ id: one, label: t(STATE_LABELS[one]) })),
            ]}
          />
          <Pills
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
          <form className="toolbar" onSubmit={apply}>
            <Field
              label={t('web.service_customer')}
              hint={t('web.services_filter_customer_hint')}
              htmlFor="services-customer"
              {...(customerProblem === undefined ? {} : { error: customerProblem })}
            >
              <input
                id="services-customer"
                dir="ltr"
                value={draft.customerId}
                onChange={(event) => setDraft({ ...draft, customerId: event.target.value.trim() })}
              />
            </Field>
            <Field
              label={t('web.service_panel')}
              hint={t('web.services_filter_panel_hint')}
              htmlFor="services-panel"
              {...(panelProblem === undefined ? {} : { error: panelProblem })}
            >
              <input
                id="services-panel"
                dir="ltr"
                value={draft.panelId}
                onChange={(event) => setDraft({ ...draft, panelId: event.target.value.trim() })}
              />
            </Field>
            <button type="submit" className="btn sm">
              {t('web.services_search_apply')}
            </button>
          </form>
        </div>

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
              />
              {/*
                `CursorPager`'s DEFAULT labels, and that is the difference from
                `/users`, `/orders` and `/products`.

                Its defaults are `next = web.older` and `previous = web.newer`, which is
                the descending orientation — and `GET /services` pages a descending
                keyset, newest service first, owner revision 13. So "next" here really
                is the older page. The three ascending lists pass the opposite pair
                explicitly for the opposite reason; copying their `nextLabel="web.newer"`
                would have told an operator that paging forward went forwards in time
                while it went backwards.
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

      {/* Owner revisions 12, 13 and 14, moved off the placeholder this route replaced.
          Revision 13 is DELIVERED — the repository pages descending because of it — and
          the other two are still absences. A decision recorded only on a screen nobody
          can open is a decision nobody reads before breaking it. */}
      <Card title={t('web.services_rules_title')}>
        <p className="muted">{t('web.services_rule_no_protocol')}</p>
        <p className="muted">{t('web.services_rule_ordering')}</p>
        <p className="muted">{t('web.services_rule_plan_filter')}</p>
        <p className="muted">{t('web.services_transfer_absent')}</p>
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
};

/**
 * The seven actions, drawn from the server's own verdicts.
 *
 * Terminate is separated out below the other six because it is the only one that
 * deletes an account on somebody's panel and the only one that costs a typed phrase.
 * The other six are one press each: the request is idempotent under a key held by
 * `useSubmissionKey`, so pressing twice asks the same question rather than planning a
 * second operation.
 *
 * Nothing here decides availability. `entry.available` and `entry.blocker` come from
 * the response, and a permission the session lacks is reported as a sentence instead of
 * removing the section — an absent control says nothing about why.
 */
function ServiceActions({
  id,
  actions,
  mayEdit,
  mayTerminate,
  onActed,
}: {
  id: string;
  actions: readonly ServiceActionAvailability[];
  mayEdit: boolean;
  mayTerminate: boolean;
  onActed: () => void;
}) {
  const toast = useToast();
  const submission = useSubmissionKey();
  const [phrase, setPhrase] = useState('');

  const act = useMutation({
    mutationFn: (input: { action: ServiceOperatorAction; confirm?: string }) =>
      actOnService({
        id,
        action: input.action,
        idempotencyKey: submission.current({ command: 'services.act', id, action: input.action }),
        ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
      }),
    onSuccess: (result, input) => {
      submission.settle();
      if (input.action === 'TERMINATE') setPhrase('');
      /*
       * "Recorded", never "done" — for the six that plan an operation.
       *
       * The response carries the operation in `PLANNED`: no provider has been called
       * yet. Reporting success would be the legacy "✅ updated" for a write whose
       * effect has not happened, and the difference matters most for the action that
       * deletes an account.
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

  const byAction = new Map(actions.map((entry) => [entry.action, entry]));
  const ordinary = SERVICE_OPERATOR_ACTIONS.filter((action) => !ACTION_NEEDS_TERMINATE[action]);
  const phraseMatches = phrase.trim() === SERVICE_TERMINATE_CONFIRMATION;
  const terminate = byAction.get('TERMINATE');

  return (
    <Card title={t('web.service_actions_title')} hint={t('web.service_actions_hint')}>
      {!mayEdit && <Banner tone="neutral">{t('web.service_action_denied_edit')}</Banner>}

      <div className="stack">
        {ordinary.map((action) => {
          const entry = byAction.get(action);
          if (entry === undefined) return null;
          return (
            <div key={action} className="stack tight">
              <div className="btn-group">
                <button
                  type="button"
                  className="btn sm"
                  disabled={!mayEdit || !entry.available || act.isPending}
                  onClick={() => act.mutate({ action })}
                >
                  {t(ACTION_LABELS[action])}
                </button>
              </div>
              {!entry.available && entry.blocker !== null && (
                <p className="muted small">{t(BLOCKER_LABELS[entry.blocker])}</p>
              )}
            </div>
          );
        })}
      </div>

      {terminate !== undefined && (
        <div className="stack">
          <Banner tone="danger" title={t('web.service_terminate_title')}>
            {t('web.service_terminate_danger')}
          </Banner>
          {!mayTerminate ? (
            <Banner tone="neutral">{t('web.service_action_denied_terminate')}</Banner>
          ) : !terminate.available && terminate.blocker !== null ? (
            <p className="muted small">{t(BLOCKER_LABELS[terminate.blocker])}</p>
          ) : (
            <>
              <label className="field">
                <span className="field-label">{t('web.service_terminate_confirm_label')}</span>
                <Ltr>{SERVICE_TERMINATE_CONFIRMATION}</Ltr>
                <input
                  type="text"
                  value={phrase}
                  dir="ltr"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setPhrase(event.currentTarget.value)}
                />
              </label>
              {phrase !== '' && !phraseMatches && (
                <Banner tone="warn">{t('web.service_terminate_confirm_wrong')}</Banner>
              )}
              <div className="btn-group">
                <button
                  type="button"
                  className="btn danger"
                  disabled={!phraseMatches || act.isPending}
                  onClick={() => act.mutate({ action: 'TERMINATE', confirm: phrase })}
                >
                  {t('web.service_terminate_button')}
                </button>
              </div>
            </>
          )}
        </div>
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
}: {
  id: string;
  denied: boolean;
  mayEdit: boolean;
  mayTerminate: boolean;
}) {
  const onLink = useLinkHandler();
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
  });

  const operationColumns: readonly Column<ServiceOperationResponse>[] = [
    {
      key: 'type',
      header: t('web.operation_type'),
      render: (op) => t(OPERATION_TYPE_LABELS[op.type]),
    },
    {
      key: 'state',
      header: t('web.operation_state'),
      render: (op) => (
        <Badge tone={OPERATION_STATE_TONES[op.state]}>{t(OPERATION_STATE_LABELS[op.state])}</Badge>
      ),
    },
    {
      key: 'attempts',
      header: t('web.operation_attempts'),
      render: (op) => <Ltr>{formatNumber(op.attempts)}</Ltr>,
    },
    {
      key: 'created',
      header: t('web.operation_created_at'),
      render: (op) => <span className="nowrap">{formatTimestamp(op.createdAt)}</span>,
    },
    {
      /*
       * WHEN the next attempt is due, which is the question a stuck operation raises.
       *
       * `holdOff` writes it on a retryable failure, so a `FAILED` row with a future
       * `scheduledAt` is waiting rather than abandoned — and those two look identical
       * without this column.
       */
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
      // The adapter's own words. It is what tells a panel refusing a duplicate apart
      // from a panel that was unreachable, and the adapters put no response body in it.
      render: (op) => (op.failureMessage === null ? <Dash /> : <span>{op.failureMessage}</span>),
    },
  ];

  return (
    <>
      <PageHead title={t('web.service_detail')} subtitle={t('web.services_intro')} maturity="now" />

      <StateSwitch query={service} denied={denied}>
        {row === undefined ? null : (
          <>
            {row.state === 'UNRECONCILED' && (
              <Banner tone="warn">{t('web.service_unreconciled_banner')}</Banner>
            )}
            {row.deliveryState === 'UNCONFIRMED' && (
              <Banner tone="warn">{t('web.service_delivery_unconfirmed_banner')}</Banner>
            )}
            {row.deliveryState === 'FAILED' && (
              <Banner tone="danger">{t('web.service_delivery_failed_banner')}</Banner>
            )}

            <Card title={t('web.service_detail')}>
              <KV
                items={[
                  [t('web.service_state'), <StateBadge key="s" value={row.state} />],
                  [t('web.service_username'), <Copyable key="u" value={row.providerUsername} />],
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
                    <a
                      key="c"
                      href={`/users/${encodeURIComponent(row.customerId)}`}
                      onClick={onLink}
                    >
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
                    <a
                      key="pr"
                      href={`/products/${encodeURIComponent(row.productId)}`}
                      onClick={onLink}
                    >
                      <Ltr>{row.productId}</Ltr>
                    </a>,
                  ],
                  [
                    t('web.service_expires_at'),
                    row.expiresAt === null ? <Dash key="e" /> : formatTimestamp(row.expiresAt),
                  ],
                  [t('web.service_created_at'), formatTimestamp(row.createdAt)],
                  [t('web.service_updated_at'), formatTimestamp(row.updatedAt)],
                ]}
              />
              <p className="muted small">{t('web.service_username_hint')}</p>
            </Card>

            {/*
              Traffic, and WHEN it was last read back from the panel.

              The counter without its freshness is the legacy statistics screen: a
              number that looks live and was written days ago. `usageSyncedAt` null is
              rendered as a SENTENCE rather than a dash, because "never read" is the
              answer rather than a missing value.
            */}
            <Card title={t('web.service_traffic_used')}>
              <KV
                items={[
                  [
                    t('web.service_traffic_limit'),
                    <TrafficLimit key="l" bytes={row.trafficLimitBytes} />,
                  ],
                  [
                    t('web.service_traffic_used'),
                    <Bytes key="u" bytes={BigInt(row.trafficUsedBytes)} />,
                  ],
                  [
                    t('web.service_usage_synced_at'),
                    row.usageSyncedAt === null ? (
                      <span key="n" className="muted small">
                        {t('web.service_usage_never')}
                      </span>
                    ) : (
                      formatTimestamp(row.usageSyncedAt)
                    ),
                  ],
                ]}
              />
            </Card>

            {/*
              Delivery, on its own, with the subscription reduced to a yes or a no.

              `hasSubscription` is a boolean in the CONTRACT for the reason
              `archiveAvailable` is one on a backup run: the surface needs to know
              whether the thing exists, and nothing about the operator's job needs its
              value. The sentence below says it is withheld rather than absent.
            */}
            <Card title={t('web.service_delivery')}>
              <KV
                items={[
                  [t('web.service_delivery'), <DeliveryBadge key="d" value={row.deliveryState} />],
                  [
                    t('web.service_subscription'),
                    row.hasSubscription
                      ? t('web.service_subscription_present')
                      : t('web.service_subscription_absent'),
                  ],
                  [
                    t('web.service_delivery_attempts'),
                    <Ltr key="a">{formatNumber(row.deliveryAttempts)}</Ltr>,
                  ],
                  [
                    t('web.service_delivery_next_attempt'),
                    row.deliveryNextAttemptAt === null ? (
                      <Dash key="na" />
                    ) : (
                      formatTimestamp(row.deliveryNextAttemptAt)
                    ),
                  ],
                  [
                    t('web.service_delivered_at'),
                    row.deliveredAt === null ? <Dash key="da" /> : formatTimestamp(row.deliveredAt),
                  ],
                  [
                    t('web.service_provisioned_at'),
                    row.provisionedAt === null ? (
                      <Dash key="pa" />
                    ) : (
                      formatTimestamp(row.provisionedAt)
                    ),
                  ],
                  [
                    t('web.service_terminated_at'),
                    row.terminatedAt === null ? (
                      <Dash key="ta" />
                    ) : (
                      formatTimestamp(row.terminatedAt)
                    ),
                  ],
                ]}
              />
              <p className="muted small">{t('web.service_subscription_withheld')}</p>
            </Card>

            <ServiceActions
              id={id}
              actions={row.actions}
              mayEdit={mayEdit}
              mayTerminate={mayTerminate}
              onActed={refresh}
            />

            <Card title={t('web.service_operations_title')} hint={t('web.service_operations_hint')}>
              <StateSwitch query={operations} denied={denied}>
                {operations.data === undefined ? null : operations.data.operations.length === 0 ? (
                  <Empty title={t('web.service_operations_empty')} />
                ) : (
                  <DataTable
                    caption={t('web.service_operations_title')}
                    columns={operationColumns}
                    rows={operations.data.operations}
                    rowKey={(op) => op.id}
                  />
                )}
              </StateSwitch>
            </Card>

            <Card>
              <p className="muted">{t('web.services_transfer_absent')}</p>
            </Card>
          </>
        )}
      </StateSwitch>
    </>
  );
}

/** Re-exported so the shell can read a query's state without importing the page's guts. */
export { queryState };
