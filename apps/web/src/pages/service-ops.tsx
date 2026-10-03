import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BULK_LARGE_OPERATION,
  BULK_NOTE_MAX_LENGTH,
  SERVICE_GRANT_DURATION_MAX_DAYS,
  SERVICE_OPERATOR_REASON_MAX_LENGTH,
  TRAFFIC_GB_PATTERN,
  type BulkGrant,
  type BulkPreview,
  type ServiceActionAvailability,
  type ServiceActionBlocker,
  type ServiceOperatorAction,
  type ServiceState,
} from '@nexa/contracts';
import {
  changeServiceLocation,
  createBulkOperation,
  fetchPanels,
  fetchProducts,
  fetchServiceLocations,
  fetchServiceLocationTargets,
  grantService,
  previewBulkOperation,
} from '../api/client';
import { formatNumber } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { navigate, setQueries, type Route } from '../router';
import { useSubmissionKey } from '../submission-key';
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Field,
  Input,
  Select,
  StatCard,
  useToast,
} from '../ui/kit';
import { bulkMessage } from './bulk-operations';
import { messageFor } from './settings';
import { ChipGroup } from './commerce-parts';

/**
 * The Service Operations Center (program §13): what the services list and a service's page
 * gained — the workspace's further filters, the mass action over what those filters
 * select, and an operator's grant and move on one service.
 *
 * Nothing here decides anything. Availability is the server's verdict (`actions`), the
 * eligible set is the server's preview, and every write goes through the same command the
 * server charges and audits; a control this file does not draw is a courtesy, never the
 * permission.
 */

// ---------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------

/** The "expiring within" choices, in hours. */
export const EXPIRING_CHOICES = [
  { id: 'ALL', hours: null, label: 'web.soc_expiring_all' },
  { id: '24', hours: 24, label: 'web.soc_expiring_24h' },
  { id: '72', hours: 72, label: 'web.soc_expiring_3d' },
  { id: '168', hours: 168, label: 'web.soc_expiring_7d' },
] as const satisfies readonly { id: string; hours: number | null; label: WebKey }[];

/** The workspace's filters, as the URL holds them. */
export interface ServiceFilters {
  readonly state: string | null;
  readonly deliveryState: string | null;
  readonly panelId: string | null;
  readonly productId: string | null;
  readonly locationKey: string | null;
  readonly expiringWithinHours: number | null;
  readonly q: string;
}

export function serviceFiltersOf(route: Route, search: string): ServiceFilters {
  const hours = Number(route.query.get('expiring'));
  return {
    state: route.query.get('state'),
    deliveryState: route.query.get('deliveryState'),
    panelId: route.query.get('panelId'),
    productId: route.query.get('productId'),
    locationKey: route.query.get('locationKey'),
    expiringWithinHours: Number.isInteger(hours) && hours > 0 ? hours : null,
    q: search,
  };
}

/**
 * The panel, product, location and expiry filters. Each list is read only when the session
 * may read it (`panels.view`, `catalog.view`); without it, that filter is simply not drawn.
 */
export function ServiceFilterSelects({
  route,
  filters,
  mayViewPanels,
  mayViewCatalog,
}: {
  route: Route;
  filters: ServiceFilters;
  mayViewPanels: boolean;
  mayViewCatalog: boolean;
}) {
  const panels = useQuery({
    queryKey: ['soc-panels'],
    queryFn: () => fetchPanels({ limit: 100 }),
    enabled: mayViewPanels,
  });
  const products = useQuery({
    queryKey: ['soc-products'],
    queryFn: () => fetchProducts({ limit: 100 }),
    enabled: mayViewCatalog,
  });
  const locations = useQuery({
    queryKey: ['soc-locations'],
    queryFn: () => fetchServiceLocations(),
    enabled: mayViewCatalog,
  });
  // One option per location KEY: two panels may both call a location `de`.
  const locationKeys = new Map<string, string>();
  for (const row of locations.data?.locations ?? []) {
    if (!locationKeys.has(row.locationKey)) locationKeys.set(row.locationKey, row.label);
  }
  const set = (key: string, value: string | null) =>
    setQueries(route, [
      [key, value === '' ? null : value],
      ['cursor', null],
    ]);
  return (
    <div className="soc-filters">
      {mayViewPanels && (
        <Field label={t('web.soc_filter_panel')} htmlFor="soc-panel" compact>
          <Select
            id="soc-panel"
            size="sm"
            value={filters.panelId ?? ''}
            onChange={(event) => set('panelId', event.currentTarget.value)}
          >
            <option value="">{t('web.services_filter_all')}</option>
            {(panels.data?.panels ?? []).map((panel) => (
              <option key={panel.id} value={panel.id}>
                {panel.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {mayViewCatalog && (
        <Field label={t('web.soc_filter_product')} htmlFor="soc-product" compact>
          <Select
            id="soc-product"
            size="sm"
            value={filters.productId ?? ''}
            onChange={(event) => set('productId', event.currentTarget.value)}
          >
            <option value="">{t('web.services_filter_all')}</option>
            {(products.data?.products ?? []).map((product) => (
              <option key={product.id} value={product.id}>
                {product.title}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {mayViewCatalog && locationKeys.size > 0 && (
        <Field label={t('web.soc_filter_location')} htmlFor="soc-location" compact>
          <Select
            id="soc-location"
            size="sm"
            value={filters.locationKey ?? ''}
            onChange={(event) => set('locationKey', event.currentTarget.value)}
          >
            <option value="">{t('web.services_filter_all')}</option>
            {[...locationKeys].map(([keyName, label]) => (
              <option key={keyName} value={keyName}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <ChipGroup
        label={t('web.soc_filter_expiring')}
        value={
          EXPIRING_CHOICES.find((choice) => choice.hours === filters.expiringWithinHours)?.id ??
          'ALL'
        }
        onChange={(next) => set('expiring', next === 'ALL' ? null : next)}
        items={EXPIRING_CHOICES.map((choice) => ({ id: choice.id, label: t(choice.label) }))}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// The mass action over the filtered set
// ---------------------------------------------------------------------------------------

type MassKind = 'SERVICE_SUSPEND' | 'SERVICE_RESUME' | 'SERVICE_TRAFFIC' | 'SERVICE_TIME';

const MASS_LABELS: Readonly<Record<MassKind, WebKey>> = {
  SERVICE_SUSPEND: 'web.bulk_kind_suspend',
  SERVICE_RESUME: 'web.bulk_kind_resume',
  SERVICE_TRAFFIC: 'web.bulk_kind_traffic',
  SERVICE_TIME: 'web.bulk_kind_time',
};

const INELIGIBLE_LABELS: Readonly<Record<'NOT_IN_STATE' | 'PANEL_NOT_OPERABLE' | 'OTHER', WebKey>> =
  {
    NOT_IN_STATE: 'web.soc_ineligible_state',
    PANEL_NOT_OPERABLE: 'web.soc_ineligible_panel',
    OTHER: 'web.soc_ineligible_other',
  };

/**
 * The audience definition the filters stand for, or null when a filter the shared audience
 * cannot express is set (the free-text search, delivery state, location). A mass action
 * over a set the operator cannot see on screen would be the "apply to all" this page
 * refuses to offer.
 */
export function massDefinitionOf(filters: ServiceFilters): unknown {
  if (filters.q !== '' || filters.deliveryState !== null || filters.locationKey !== null) {
    return null;
  }
  return {
    version: 1,
    // Every customer: a status change or a grant is about the SERVICE, whatever its owner.
    customerStatus: 'ANY',
    service: {
      productIds: filters.productId === null ? [] : [filters.productId],
      panelIds: filters.panelId === null ? [] : [filters.panelId],
      states: filters.state === null ? [] : [filters.state as ServiceState],
      expiringWithinHours: filters.expiringWithinHours,
      expired: false,
    },
  };
}

/**
 * Selection → preview (the eligible count, the ineligible and why, a sample) → a reason and,
 * from `BULK_LARGE_OPERATION` items, the count typed back → a confirmation → a mass
 * operation, whose progress and per-item outcomes are its own page. One request per step,
 * never "apply to all".
 */
export function ServiceMassActionCard({
  filters,
  mayStatus,
  mayGrant,
}: {
  filters: ServiceFilters;
  /** `services.mass.status` AND `services.edit`. */
  mayStatus: boolean;
  /** `services.mass.grant`. */
  mayGrant: boolean;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const submission = useSubmissionKey();
  const kinds: MassKind[] = [
    ...(mayStatus ? (['SERVICE_SUSPEND', 'SERVICE_RESUME'] as const) : []),
    ...(mayGrant ? (['SERVICE_TRAFFIC', 'SERVICE_TIME'] as const) : []),
  ];
  const [kind, setKind] = useState<MassKind>(kinds[0] ?? 'SERVICE_SUSPEND');
  const [traffic, setTraffic] = useState('');
  const [days, setDays] = useState('');
  const [note, setNote] = useState('');
  const [typed, setTyped] = useState('');
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [asking, setAsking] = useState(false);
  const definition = massDefinitionOf(filters);
  const definitionKey = JSON.stringify(definition);
  const [previewedFor, setPreviewedFor] = useState<string | null>(null);

  const grant = (): BulkGrant | null => {
    if (kind === 'SERVICE_SUSPEND' || kind === 'SERVICE_RESUME') return { kind };
    if (kind === 'SERVICE_TRAFFIC') {
      return TRAFFIC_GB_PATTERN.test(traffic) ? { kind, trafficGb: traffic } : null;
    }
    const value = Number(days);
    return Number.isInteger(value) && value > 0 ? { kind, durationDays: value } : null;
  };
  const reset = () => {
    setPreview(null);
    setTyped('');
    setPreviewedFor(null);
  };

  const load = useMutation({
    mutationFn: () => {
      const g = grant();
      if (g === null || definition === null) throw new Error('nothing to preview');
      return previewBulkOperation({ grant: g, definition });
    },
    onSuccess: (response) => {
      setPreview(response.preview);
      setPreviewedFor(definitionKey);
      setTyped('');
    },
  });
  const execute = useMutation({
    mutationFn: () => {
      const g = grant();
      if (g === null || preview === null || definition === null) throw new Error('preview');
      const input = {
        grant: g,
        definition,
        // A status change notifies nobody; a grant is announced only once it SUCCEEDED.
        notify: g.kind === 'SERVICE_TRAFFIC' || g.kind === 'SERVICE_TIME',
        note: note.trim(),
        expectedDefinitionHash: preview.definitionHash,
        expectedCount: preview.count,
        expectedFingerprint: preview.fingerprint,
        expectedTotalMinor: null,
        typedCount: preview.count >= BULK_LARGE_OPERATION ? Number(typed) : preview.count,
        notBefore: null,
      };
      return createBulkOperation({ ...input, idempotencyKey: submission.current(input) });
    },
    onSuccess: (response) => {
      submission.settle();
      toast({ tone: 'ok', message: t('web.bulk_started') });
      void client.invalidateQueries({ queryKey: ['bulk-operations'] });
      navigate(`/bulk-operations/${encodeURIComponent(response.operation.id)}`);
    },
    onError: (error) => {
      submission.settleOn(error);
      reset();
    },
  });

  if (kinds.length === 0) return null;
  // The filters moved since the preview: the preview no longer describes this set.
  const stale = preview !== null && previewedFor !== definitionKey;
  const typedOk =
    preview === null ||
    preview.count < BULK_LARGE_OPERATION ||
    typed.trim() === String(preview.count);
  const ready = preview !== null && !stale && preview.count > 0 && note.trim() !== '' && typedOk;

  return (
    <Card title={t('web.soc_mass_title')} hint={t('web.soc_mass_hint')}>
      {definition === null ? (
        <Banner tone="info">{t('web.soc_mass_unrepresentable')}</Banner>
      ) : (
        <div className="stack-sm">
          <div className="form-grid">
            <Field label={t('web.bulk_kind')} htmlFor="soc-mass-kind">
              <Select
                id="soc-mass-kind"
                value={kind}
                onChange={(event) => {
                  setKind(event.currentTarget.value as MassKind);
                  reset();
                }}
              >
                {kinds.map((one) => (
                  <option key={one} value={one}>
                    {t(MASS_LABELS[one])}
                  </option>
                ))}
              </Select>
            </Field>
            {kind === 'SERVICE_TRAFFIC' && (
              <Field label={t('web.bulk_traffic')} htmlFor="soc-mass-traffic">
                <Input
                  id="soc-mass-traffic"
                  inputMode="decimal"
                  value={traffic}
                  onChange={(event) => {
                    setTraffic(event.currentTarget.value.trim());
                    reset();
                  }}
                />
              </Field>
            )}
            {kind === 'SERVICE_TIME' && (
              <Field label={t('web.bulk_days_label')} htmlFor="soc-mass-days">
                <Input
                  id="soc-mass-days"
                  inputMode="numeric"
                  value={days}
                  onChange={(event) => {
                    setDays(event.currentTarget.value.trim());
                    reset();
                  }}
                />
              </Field>
            )}
          </div>
          <div className="form-actions">
            <Button
              icon="eye"
              disabled={grant() === null || load.isPending}
              onClick={() => load.mutate()}
            >
              {t('web.bulk_preview_button')}
            </Button>
          </div>
          {load.error !== null && <Banner tone="danger">{bulkMessage(load.error)}</Banner>}
          {stale && <Banner tone="warn">{t('web.soc_mass_stale')}</Banner>}
          {preview !== null && !stale && (
            <>
              <div className="stat-grid">
                <StatCard label={t('web.soc_mass_eligible')} value={formatNumber(preview.count)} />
                {preview.ineligible !== null && (
                  <>
                    <StatCard
                      label={t('web.soc_mass_selected')}
                      value={formatNumber(preview.ineligible.selected)}
                    />
                    <StatCard
                      label={t('web.soc_ineligible_state')}
                      value={formatNumber(preview.ineligible.notInState)}
                    />
                    <StatCard
                      label={t('web.soc_ineligible_panel')}
                      value={formatNumber(preview.ineligible.panelNotOperable)}
                      {...(preview.ineligible.panelNotOperable > 0
                        ? { tone: 'warn' as const }
                        : {})}
                    />
                  </>
                )}
              </div>
              {preview.ineligible !== null && preview.ineligible.sample.length > 0 && (
                <DataTable
                  caption={t('web.soc_mass_ineligible_sample')}
                  columns={[
                    {
                      key: 'service',
                      header: t('web.bulk_service'),
                      render: (row) => row.serviceLabel,
                    },
                    {
                      key: 'reason',
                      header: t('web.soc_mass_reason'),
                      render: (row) => t(INELIGIBLE_LABELS[row.reason]),
                    },
                  ]}
                  rows={preview.ineligible.sample}
                  rowKey={(row) => row.serviceId}
                  dense
                />
              )}
              {preview.count === 0 ? (
                <Banner tone="info">{t('web.aud_error_empty')}</Banner>
              ) : (
                <div className="inset danger-zone stack-sm">
                  <Banner tone="danger">{t('web.soc_mass_danger')}</Banner>
                  <div className="form-grid">
                    <Field label={t('web.bulk_reason')} htmlFor="soc-mass-note">
                      <Input
                        id="soc-mass-note"
                        value={note}
                        maxLength={BULK_NOTE_MAX_LENGTH}
                        onChange={(event) => setNote(event.currentTarget.value)}
                      />
                    </Field>
                    {preview.count >= BULK_LARGE_OPERATION && (
                      <Field label={t('web.bulk_typed')} htmlFor="soc-mass-typed">
                        <Input
                          id="soc-mass-typed"
                          inputMode="numeric"
                          value={typed}
                          onChange={(event) => setTyped(event.currentTarget.value)}
                        />
                      </Field>
                    )}
                  </div>
                  <div className="form-actions">
                    <Button
                      variant="danger-solid"
                      icon="zap"
                      disabled={!ready || execute.isPending}
                      onClick={() => setAsking(true)}
                    >
                      {t('web.bulk_execute')}
                    </Button>
                  </div>
                </div>
              )}
              {asking && (
                <ConfirmDialog
                  title={t(MASS_LABELS[kind])}
                  question={t('web.cb_bulk_run_question').replace(
                    '{count}',
                    formatNumber(preview.count),
                  )}
                  detail={t('web.soc_mass_danger')}
                  confirmLabel={t('web.cb_bulk_run_yes')}
                  cancelLabel={t('web.cb_cancel')}
                  onConfirm={() => {
                    setAsking(false);
                    execute.mutate();
                  }}
                  onCancel={() => setAsking(false)}
                />
              )}
            </>
          )}
          {execute.error !== null && <Banner tone="danger">{bulkMessage(execute.error)}</Banner>}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------
// One service: the operator's grant and move
// ---------------------------------------------------------------------------------------

/** The actions that take input of their own, drawn in this card rather than as buttons. */
export const INPUT_ACTIONS: ReadonlySet<ServiceOperatorAction> = new Set<ServiceOperatorAction>([
  'ADD_TRAFFIC',
  'ADD_TIME',
  'CHANGE_LOCATION',
]);

/**
 * Free traffic or time (`services.grant`) and a move (`services.edit`), each drawn only when
 * the server says the action is available, each with a mandatory reason and an idempotency
 * key bound to its payload. The answer is the operation PLANNED, never "done": its outcome
 * appears in the history card, which the page refreshes.
 */
export function ServiceGrantMoveCard({
  serviceId,
  actions,
  mayGrant,
  mayEdit,
  blockerLabel,
  onActed,
}: {
  serviceId: string;
  actions: readonly ServiceActionAvailability[];
  mayGrant: boolean;
  mayEdit: boolean;
  blockerLabel: (blocker: ServiceActionBlocker) => string;
  onActed: () => void;
}) {
  const toast = useToast();
  const grantKey = useSubmissionKey();
  const moveKey = useSubmissionKey();
  const byAction = new Map(actions.map((entry) => [entry.action, entry]));
  const traffic = byAction.get('ADD_TRAFFIC');
  const time = byAction.get('ADD_TIME');
  const move = byAction.get('CHANGE_LOCATION');
  const [gb, setGb] = useState('');
  const [days, setDays] = useState('');
  const [grantReason, setGrantReason] = useState('');
  const [target, setTarget] = useState('');
  const [moveReason, setMoveReason] = useState('');

  const targets = useQuery({
    queryKey: ['service-location-targets', serviceId],
    queryFn: () => fetchServiceLocationTargets(serviceId),
    enabled: mayEdit && move?.available === true,
  });

  const grant = useMutation({
    mutationFn: (
      body:
        | { kind: 'ADD_TRAFFIC'; trafficGb: string; reason: string }
        | { kind: 'ADD_TIME'; durationDays: number; reason: string },
    ) => grantService(serviceId, { ...body, idempotencyKey: grantKey.current(body) }),
    onSuccess: () => {
      grantKey.settle();
      setGb('');
      setDays('');
      setGrantReason('');
      toast({ tone: 'ok', message: t('web.service_action_planned') });
      onActed();
    },
    onError: (error) => {
      grantKey.settleOn(error);
      toast({ tone: 'danger', message: messageFor(error) });
    },
  });
  const relocate = useMutation({
    mutationFn: (body: { locationId: string; reason: string }) =>
      changeServiceLocation(serviceId, { ...body, idempotencyKey: moveKey.current(body) }),
    onSuccess: () => {
      moveKey.settle();
      setTarget('');
      setMoveReason('');
      toast({ tone: 'ok', message: t('web.service_action_planned') });
      onActed();
    },
    onError: (error) => {
      moveKey.settleOn(error);
      toast({ tone: 'danger', message: messageFor(error) });
    },
  });

  const unavailable = (entry: ServiceActionAvailability | undefined) =>
    entry === undefined || !entry.available ? (
      <p className="muted small">
        {entry?.blocker === null || entry?.blocker === undefined
          ? t('web.soc_unavailable')
          : blockerLabel(entry.blocker)}
      </p>
    ) : null;
  const daysValue = Number(days);
  const daysOk =
    Number.isInteger(daysValue) && daysValue >= 1 && daysValue <= SERVICE_GRANT_DURATION_MAX_DAYS;

  return (
    <Card title={t('web.soc_grant_move_title')} hint={t('web.soc_grant_move_hint')}>
      <div className="soc-grant-move">
        <section className="stack-sm">
          <h4>{t('web.service_action_add_traffic')}</h4>
          {!mayGrant ? (
            <p className="muted small">{t('web.soc_grant_denied')}</p>
          ) : (
            (unavailable(traffic) ?? (
              <div className="form-grid">
                <Field label={t('web.soc_grant_gb')} htmlFor="soc-grant-gb">
                  <Input
                    id="soc-grant-gb"
                    inputMode="decimal"
                    value={gb}
                    onChange={(event) => setGb(event.currentTarget.value.trim())}
                  />
                </Field>
              </div>
            ))
          )}
        </section>
        <section className="stack-sm">
          <h4>{t('web.service_action_add_time')}</h4>
          {!mayGrant ? (
            <p className="muted small">{t('web.soc_grant_denied')}</p>
          ) : (
            (unavailable(time) ?? (
              <div className="form-grid">
                <Field label={t('web.soc_grant_days')} htmlFor="soc-grant-days">
                  <Input
                    id="soc-grant-days"
                    inputMode="numeric"
                    value={days}
                    onChange={(event) => setDays(event.currentTarget.value.trim())}
                  />
                </Field>
              </div>
            ))
          )}
        </section>
        {mayGrant && (traffic?.available === true || time?.available === true) && (
          <div className="stack-sm">
            <Field label={t('web.soc_reason')} htmlFor="soc-grant-reason">
              <Input
                id="soc-grant-reason"
                value={grantReason}
                maxLength={SERVICE_OPERATOR_REASON_MAX_LENGTH}
                onChange={(event) => setGrantReason(event.currentTarget.value)}
              />
            </Field>
            <div className="form-actions">
              {traffic?.available === true && (
                <Button
                  disabled={
                    !TRAFFIC_GB_PATTERN.test(gb) || grantReason.trim() === '' || grant.isPending
                  }
                  onClick={() =>
                    grant.mutate({
                      kind: 'ADD_TRAFFIC',
                      trafficGb: gb,
                      reason: grantReason.trim(),
                    })
                  }
                >
                  {t('web.soc_grant_traffic_button')}
                </Button>
              )}
              {time?.available === true && (
                <Button
                  disabled={!daysOk || grantReason.trim() === '' || grant.isPending}
                  onClick={() =>
                    grant.mutate({
                      kind: 'ADD_TIME',
                      durationDays: daysValue,
                      reason: grantReason.trim(),
                    })
                  }
                >
                  {t('web.soc_grant_time_button')}
                </Button>
              )}
            </div>
          </div>
        )}
        <section className="stack-sm">
          <h4>{t('web.service_action_change_location')}</h4>
          {!mayEdit ? (
            <p className="muted small">{t('web.soc_move_denied')}</p>
          ) : (
            (unavailable(move) ?? (
              <>
                {targets.data?.current !== null && targets.data?.current !== undefined && (
                  <p className="muted small">
                    {t('web.soc_move_current')} {targets.data.current.label}
                  </p>
                )}
                <div className="form-grid">
                  <Field label={t('web.soc_move_target')} htmlFor="soc-move-target">
                    <Select
                      id="soc-move-target"
                      value={target}
                      onChange={(event) => setTarget(event.currentTarget.value)}
                    >
                      <option value="">{t('web.soc_move_choose')}</option>
                      {(targets.data?.targets ?? []).map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('web.soc_reason')} htmlFor="soc-move-reason">
                    <Input
                      id="soc-move-reason"
                      value={moveReason}
                      maxLength={SERVICE_OPERATOR_REASON_MAX_LENGTH}
                      onChange={(event) => setMoveReason(event.currentTarget.value)}
                    />
                  </Field>
                </div>
                <p className="muted small">{t('web.soc_move_hint')}</p>
                <div className="form-actions">
                  <Button
                    disabled={target === '' || moveReason.trim() === '' || relocate.isPending}
                    onClick={() =>
                      relocate.mutate({ locationId: target, reason: moveReason.trim() })
                    }
                  >
                    {t('web.soc_move_button')}
                  </Button>
                </div>
              </>
            ))
          )}
        </section>
      </div>
    </Card>
  );
}
