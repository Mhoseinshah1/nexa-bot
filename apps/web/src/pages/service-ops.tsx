import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BULK_LARGE_OPERATION,
  BULK_NOTE_MAX_LENGTH,
  SERVICE_GRANT_DURATION_MAX_DAYS,
  SERVICE_LIST_LIFECYCLES,
  SERVICE_OPERATOR_REASON_MAX_LENGTH,
  SERVICE_STATES,
  SERVICE_TERMINAL_STATES,
  TRAFFIC_GB_PATTERN,
  type BulkGrant,
  type BulkPreview,
  type RecordSource,
  type ServiceActionAvailability,
  type ServiceActionBlocker,
  type ServiceListLifecycle,
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
import { useSubmissionKey, type SubmissionKey } from '../submission-key';
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
import { Drawer } from '../ui/overlays';
import { useConfirmedClose, useReportDirty } from '../ui/unsaved';
import { bulkMessage } from './bulk-operations';
import { messageFor } from './settings';
import { sourceFromQuery } from './record-source';
import { ChipGroup } from './commerce-parts';
import type { ListFilter } from '../ui/filter-bar';
import { ErrorRef } from '../ui/technical-details';

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

/**
 * Track 3 §3: the states each lifecycle tab shows, derived from the machine's terminal list
 * exactly as the server derives them — LIVE every non-terminal state, ENDED the terminal ones,
 * ALL every state.
 */
export const LIFECYCLE_STATES: Readonly<Record<ServiceListLifecycle, readonly ServiceState[]>> = {
  LIVE: SERVICE_STATES.filter(
    (state) => !(SERVICE_TERMINAL_STATES as readonly ServiceState[]).includes(state),
  ),
  ENDED: SERVICE_TERMINAL_STATES,
  ALL: SERVICE_STATES,
};

/** The tab the URL names (`?lifecycle=`); none, or one the contract does not know, is LIVE. */
export function lifecycleOf(route: Route): ServiceListLifecycle {
  const raw = route.query.get('lifecycle');
  return SERVICE_LIST_LIFECYCLES.find((one) => one === raw) ?? 'LIVE';
}

/** The workspace's filters, as the URL holds them. */
export interface ServiceFilters {
  /**
   * The lifecycle tab (Track 3 §3). The list and a mass action select by it; absent is ALL,
   * which is what a caller that predates the tabs meant.
   */
  readonly lifecycle?: ServiceListLifecycle;
  readonly state: string | null;
  readonly deliveryState: string | null;
  readonly panelId: string | null;
  readonly productId: string | null;
  readonly locationKey: string | null;
  readonly expiringWithinHours: number | null;
  /** The source filter: the list narrows by it, a mass action cannot (see `massDefinitionOf`). */
  readonly source?: RecordSource | null;
  readonly q: string;
}

export function serviceFiltersOf(route: Route, search: string): ServiceFilters {
  const hours = Number(route.query.get('expiring'));
  return {
    lifecycle: lifecycleOf(route),
    state: route.query.get('state'),
    deliveryState: route.query.get('deliveryState'),
    panelId: route.query.get('panelId'),
    productId: route.query.get('productId'),
    locationKey: route.query.get('locationKey'),
    expiringWithinHours: Number.isInteger(hours) && hours > 0 ? hours : null,
    source: sourceFromQuery(route.query.get('source')),
    q: search,
  };
}

/**
 * The panel, product, location and expiry filters, as `ListFilterBar` rows (W1.3). Each list
 * is read only when the session may read it (`panels.view`, `catalog.view`); without it,
 * that filter is simply not offered. A chip names the chosen panel, product or location by
 * the name its list gives it, and falls back to the raw value while the list has not
 * answered — never blank.
 */
export function useServiceFilterRows({
  route,
  filters,
  mayViewPanels,
  mayViewCatalog,
  enabled = true,
}: {
  route: Route;
  filters: ServiceFilters;
  mayViewPanels: boolean;
  mayViewCatalog: boolean;
  /** False while the list itself cannot answer: no filter list is asked for then. */
  enabled?: boolean;
}): ListFilter[] {
  const panels = useQuery({
    queryKey: ['soc-panels'],
    queryFn: () => fetchPanels({ limit: 100 }),
    enabled: mayViewPanels && enabled,
  });
  const products = useQuery({
    queryKey: ['soc-products'],
    queryFn: () => fetchProducts({ limit: 100 }),
    enabled: mayViewCatalog && enabled,
  });
  const locations = useQuery({
    queryKey: ['soc-locations'],
    queryFn: () => fetchServiceLocations(),
    enabled: mayViewCatalog && enabled,
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
  const rows: ListFilter[] = [];
  // A value already in the URL keeps its chip even without the list, so it can be removed.
  if (mayViewPanels || filters.panelId !== null) {
    const chosen = (panels.data?.panels ?? []).find((panel) => panel.id === filters.panelId);
    rows.push({
      key: 'panelId',
      label: t('web.soc_filter_panel'),
      active: filters.panelId === null ? null : (chosen?.name ?? filters.panelId),
      onClear: () => set('panelId', null),
      control: (
        <Select
          id="soc-panel"
          size="sm"
          aria-label={t('web.soc_filter_panel')}
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
      ),
    });
  }
  if (mayViewCatalog || filters.productId !== null) {
    const chosen = (products.data?.products ?? []).find(
      (product) => product.id === filters.productId,
    );
    rows.push({
      key: 'productId',
      label: t('web.soc_filter_product'),
      active: filters.productId === null ? null : (chosen?.title ?? filters.productId),
      onClear: () => set('productId', null),
      control: (
        <Select
          id="soc-product"
          size="sm"
          aria-label={t('web.soc_filter_product')}
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
      ),
    });
  }
  if ((mayViewCatalog && locationKeys.size > 0) || filters.locationKey !== null) {
    rows.push({
      key: 'locationKey',
      label: t('web.soc_filter_location'),
      active:
        filters.locationKey === null
          ? null
          : (locationKeys.get(filters.locationKey) ?? filters.locationKey),
      onClear: () => set('locationKey', null),
      control: (
        <Select
          id="soc-location"
          size="sm"
          aria-label={t('web.soc_filter_location')}
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
      ),
    });
  }
  const expiring = EXPIRING_CHOICES.find((choice) => choice.hours === filters.expiringWithinHours);
  rows.push({
    key: 'expiring',
    label: t('web.soc_filter_expiring'),
    active:
      filters.expiringWithinHours === null
        ? null
        : expiring === undefined
          ? formatNumber(filters.expiringWithinHours)
          : t(expiring.label),
    onClear: () => set('expiring', null),
    control: (
      <ChipGroup
        label={t('web.soc_filter_expiring')}
        value={expiring?.id ?? 'ALL'}
        onChange={(next) => set('expiring', next === 'ALL' ? null : next)}
        items={EXPIRING_CHOICES.map((choice) => ({ id: choice.id, label: t(choice.label) }))}
      />
    ),
  });
  return rows;
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
 * cannot express is set (the free-text search, delivery state, location, source). A mass action
 * over a set the operator cannot see on screen would be the "apply to all" this page
 * refuses to offer.
 */
export function massDefinitionOf(filters: ServiceFilters): unknown {
  if (
    filters.q !== '' ||
    filters.deliveryState !== null ||
    filters.locationKey !== null ||
    (filters.source ?? null) !== null
  ) {
    return null;
  }
  /*
   * Codex review of #157: the audience's "expiring within" selects ACTIVE services only,
   * while the list's filter selects any state. The two agree only when the list is ALSO
   * filtered to ACTIVE; otherwise the preview would describe a different set from the one
   * on screen (a SUSPENDED-and-expiring list would preview an empty resume).
   */
  if (filters.expiringWithinHours !== null && filters.state !== 'ACTIVE') return null;
  /*
   * Track 3 §3: the tab is part of what the list selects, so it is part of what a mass action
   * selects. A state filter narrows the tab; a state outside the tab selects nothing on
   * screen, and nothing is acted on in bulk. ALL (or a caller with no tab) is every state.
   */
  const tab = LIFECYCLE_STATES[filters.lifecycle ?? 'ALL'];
  let states: readonly ServiceState[];
  if (filters.state !== null) {
    if (!(tab as readonly string[]).includes(filters.state)) return null;
    states = [filters.state as ServiceState];
  } else {
    states = filters.lifecycle === undefined || filters.lifecycle === 'ALL' ? [] : tab;
  }
  return {
    version: 1,
    // Every customer: a status change or a grant is about the SERVICE, whatever its owner.
    customerStatus: 'ANY',
    service: {
      productIds: filters.productId === null ? [] : [filters.productId],
      panelIds: filters.panelId === null ? [] : [filters.panelId],
      states: [...states],
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
  bare = false,
  onDirtyChange,
  submission: heldSubmission,
}: {
  filters: ServiceFilters;
  /** `services.mass.status` AND `services.edit`. */
  mayStatus: boolean;
  /** `services.mass.grant`. */
  mayGrant: boolean;
  /** Drawn inside the list's drawer (W3): no card frame, the hint as a line. */
  bare?: boolean;
  /** Whether a typed value would be lost by closing the drawer. */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * The submission key, held by a parent that outlives this card. Inside a drawer the card
   * unmounts on close, and a key kept after an unanswered failure (a 5xx that may have
   * committed) must survive a close and reopen — a fresh key there is a SECOND bulk
   * operation over the same services.
   */
  submission?: SubmissionKey;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const ownSubmission = useSubmissionKey();
  const submission = heldSubmission ?? ownSubmission;
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
  useReportDirty(traffic !== '' || days !== '' || note !== '' || typed !== '', onDirtyChange);

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

  const body = (
    <>
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
          {load.error !== null && (
            <Banner tone="danger">
              {bulkMessage(load.error)}
              <ErrorRef error={load.error} />
            </Banner>
          )}
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
                    {/* Codex review of #157: the third reason, so the three add up. */}
                    <StatCard
                      label={t('web.soc_ineligible_other')}
                      value={formatNumber(preview.ineligible.other)}
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
          {execute.error !== null && (
            <Banner tone="danger">
              {bulkMessage(execute.error)}
              <ErrorRef error={execute.error} />
            </Banner>
          )}
        </div>
      )}
    </>
  );
  if (bare) {
    return (
      <div className="stack-sm">
        <p className="muted small">{t('web.soc_mass_hint')}</p>
        {body}
      </div>
    );
  }
  return (
    <Card title={t('web.soc_mass_title')} hint={t('web.soc_mass_hint')}>
      {body}
    </Card>
  );
}

/**
 * W3: the mass action is a button in the list's head that opens a wide drawer over the
 * SAME steps; closing it with a typed reason, amount or count asks first.
 */
export function ServiceMassActionButton({
  filters,
  mayStatus,
  mayGrant,
}: {
  filters: ServiceFilters;
  mayStatus: boolean;
  mayGrant: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Held here, not in the card: the drawer unmounts the card on close (see its prop).
  const submission = useSubmissionKey();
  const close = () => {
    setOpen(false);
    setDirty(false);
  };
  const { requestClose, dialog } = useConfirmedClose(dirty, close);
  if (!mayStatus && !mayGrant) return null;
  return (
    <>
      <Button size="sm" icon="zap" onClick={() => setOpen(true)}>
        {t('web.soc_mass_title')}
      </Button>
      <Drawer open={open} onClose={requestClose} title={t('web.soc_mass_title')} wide>
        <ServiceMassActionCard
          filters={filters}
          mayStatus={mayStatus}
          mayGrant={mayGrant}
          bare
          onDirtyChange={setDirty}
          submission={submission}
        />
      </Drawer>
      {dialog}
    </>
  );
}

// ---------------------------------------------------------------------------------------
// One service: the operator's grant and move
// ---------------------------------------------------------------------------------------

/** What changed in a service's operation history, as one comparable string. */
export function operationsSignature(
  operations: readonly { readonly id: string; readonly state: string }[] | undefined,
): string | null {
  return operations === undefined
    ? null
    : operations.map((operation) => `${operation.id}:${operation.state}`).join(',');
}

/**
 * Codex review of #157: the history is polled while an operation is in flight, and when it
 * CHANGES — an operation reaches its end, or a new one appears — the service itself (its
 * allowance, expiry, location, state and action verdicts), the move targets and the list
 * are read again. Without it the page kept showing the pre-grant figures and an
 * IN_PROGRESS blocker for an action that had already finished.
 */
export function useRefreshOnOperationChange(
  serviceId: string,
  operations: readonly { readonly id: string; readonly state: string }[] | undefined,
): void {
  const client = useQueryClient();
  const seen = useRef<string | null>(null);
  const signature = operationsSignature(operations);
  useEffect(() => {
    if (signature === null) return;
    if (seen.current !== null && seen.current !== signature) {
      void client.invalidateQueries({ queryKey: ['service', serviceId] });
      void client.invalidateQueries({ queryKey: ['service-location-targets', serviceId] });
      void client.invalidateQueries({ queryKey: ['services'] });
    }
    seen.current = signature;
  }, [signature, client, serviceId]);
}

/** The actions that take input of their own, drawn in this card rather than as buttons. */
export const INPUT_ACTIONS: ReadonlySet<ServiceOperatorAction> = new Set<ServiceOperatorAction>([
  'ADD_TRAFFIC',
  'ADD_TIME',
  'CHANGE_LOCATION',
]);

/**
 * Why the grant and move buttons are unavailable, one sentence each, for the action panel's
 * folded «چرا … غیرفعال است؟» (W1.5). A missing permission is said once per permission; a
 * server verdict carries the id the button's `aria-describedby` names.
 */
export function grantMoveReasons({
  actions,
  mayGrant,
  mayEdit,
  blockerLabel,
}: {
  actions: readonly ServiceActionAvailability[];
  mayGrant: boolean;
  mayEdit: boolean;
  blockerLabel: (blocker: ServiceActionBlocker) => string;
}): ReactNode[] {
  const byAction = new Map(actions.map((entry) => [entry.action, entry]));
  const reasons: ReactNode[] = [];
  const verdict = (action: 'ADD_TRAFFIC' | 'ADD_TIME' | 'CHANGE_LOCATION', label: WebKey) => {
    const entry = byAction.get(action);
    if (entry?.available === true) return;
    reasons.push(
      <span key={action}>
        <b>{t(label)}</b>{' '}
        <span id={`service-blocker-${action}`}>
          {entry?.blocker === null || entry?.blocker === undefined
            ? t('web.soc_unavailable')
            : blockerLabel(entry.blocker)}
        </span>
      </span>,
    );
  };
  if (!mayGrant) {
    reasons.push(
      <span key="grant-denied" id="service-denied-grant">
        {t('web.soc_grant_denied')}
      </span>,
    );
  } else {
    verdict('ADD_TRAFFIC', 'web.service_action_add_traffic');
    verdict('ADD_TIME', 'web.service_action_add_time');
  }
  if (!mayEdit) {
    reasons.push(
      <span key="move-denied" id="service-denied-move">
        {t('web.soc_move_denied')}
      </span>,
    );
  } else {
    verdict('CHANGE_LOCATION', 'web.service_action_change_location');
  }
  return reasons;
}

/** The id a disabled grant/move button is described by, or nothing when it is enabled. */
function describedBy(
  action: 'ADD_TRAFFIC' | 'ADD_TIME' | 'CHANGE_LOCATION',
  may: boolean,
  entry: ServiceActionAvailability | undefined,
): { 'aria-describedby'?: string } {
  if (!may) {
    return {
      'aria-describedby':
        action === 'CHANGE_LOCATION' ? 'service-denied-move' : 'service-denied-grant',
    };
  }
  return entry?.available === true ? {} : { 'aria-describedby': `service-blocker-${action}` };
}

/**
 * Free traffic or time (`services.grant`), W3: a button in the action panel that opens a
 * drawer with the amount and a mandatory reason, under an idempotency key bound to the
 * payload. Enabled only when the server says the action is available. The answer is the
 * operation PLANNED, never "done": its outcome appears in the history card, which the
 * page refreshes. Closing the drawer over a typed value asks first.
 */
export function ServiceGrantButton({
  serviceId,
  kind,
  entry,
  mayGrant,
  onActed,
}: {
  serviceId: string;
  kind: 'ADD_TRAFFIC' | 'ADD_TIME';
  entry: ServiceActionAvailability | undefined;
  mayGrant: boolean;
  onActed: () => void;
}) {
  const toast = useToast();
  const grantKey = useSubmissionKey();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const reset = () => {
    setOpen(false);
    setAmount('');
    setReason('');
  };
  const { requestClose, dialog } = useConfirmedClose(amount !== '' || reason !== '', reset);
  const grant = useMutation({
    mutationFn: (
      body:
        | { kind: 'ADD_TRAFFIC'; trafficGb: string; reason: string }
        | { kind: 'ADD_TIME'; durationDays: number; reason: string },
    ) => grantService(serviceId, { ...body, idempotencyKey: grantKey.current(body) }),
    onSuccess: () => {
      grantKey.settle();
      reset();
      toast({ tone: 'ok', message: t('web.service_action_planned') });
      onActed();
    },
    onError: (error) => {
      grantKey.settleOn(error);
      toast({ tone: 'danger', message: messageFor(error), error });
    },
  });
  const daysValue = Number(amount);
  const amountOk =
    kind === 'ADD_TRAFFIC'
      ? TRAFFIC_GB_PATTERN.test(amount)
      : Number.isInteger(daysValue) &&
        daysValue >= 1 &&
        daysValue <= SERVICE_GRANT_DURATION_MAX_DAYS;
  const title = t(
    kind === 'ADD_TRAFFIC' ? 'web.service_action_add_traffic' : 'web.service_action_add_time',
  );
  const fieldId = kind === 'ADD_TRAFFIC' ? 'soc-grant-gb' : 'soc-grant-days';
  return (
    <>
      <Button
        disabled={!mayGrant || entry?.available !== true}
        {...describedBy(kind, mayGrant, entry)}
        onClick={() => setOpen(true)}
      >
        {title}
      </Button>
      <Drawer open={open} onClose={requestClose} title={title}>
        <div className="stack-sm">
          <Field
            label={t(kind === 'ADD_TRAFFIC' ? 'web.soc_grant_gb' : 'web.soc_grant_days')}
            htmlFor={fieldId}
          >
            <Input
              id={fieldId}
              inputMode={kind === 'ADD_TRAFFIC' ? 'decimal' : 'numeric'}
              value={amount}
              onChange={(event) => setAmount(event.currentTarget.value.trim())}
            />
          </Field>
          <Field label={t('web.soc_reason')} htmlFor="soc-grant-reason">
            <Input
              id="soc-grant-reason"
              value={reason}
              maxLength={SERVICE_OPERATOR_REASON_MAX_LENGTH}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
          </Field>
          <div className="form-actions">
            <Button
              variant="primary"
              disabled={!amountOk || reason.trim() === '' || grant.isPending}
              onClick={() =>
                grant.mutate(
                  kind === 'ADD_TRAFFIC'
                    ? { kind, trafficGb: amount, reason: reason.trim() }
                    : { kind, durationDays: daysValue, reason: reason.trim() },
                )
              }
            >
              {t(
                kind === 'ADD_TRAFFIC'
                  ? 'web.soc_grant_traffic_button'
                  : 'web.soc_grant_time_button',
              )}
            </Button>
          </div>
        </div>
      </Drawer>
      {dialog}
    </>
  );
}

/**
 * A move (`services.edit`), W3: a button opening a drawer with the current location, the
 * targets the server offers, a mandatory reason and the hint. The targets are read while the
 * move is available, so an operation's end re-reads them (`useRefreshOnOperationChange`).
 */
export function ServiceMoveButton({
  serviceId,
  entry,
  mayEdit,
  onActed,
}: {
  serviceId: string;
  entry: ServiceActionAvailability | undefined;
  mayEdit: boolean;
  onActed: () => void;
}) {
  const toast = useToast();
  const moveKey = useSubmissionKey();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [moveReason, setMoveReason] = useState('');
  const targets = useQuery({
    queryKey: ['service-location-targets', serviceId],
    queryFn: () => fetchServiceLocationTargets(serviceId),
    enabled: mayEdit && entry?.available === true,
  });
  const reset = () => {
    setOpen(false);
    setTarget('');
    setMoveReason('');
  };
  const { requestClose, dialog } = useConfirmedClose(target !== '' || moveReason !== '', reset);
  const relocate = useMutation({
    mutationFn: (body: { locationId: string; reason: string }) =>
      changeServiceLocation(serviceId, { ...body, idempotencyKey: moveKey.current(body) }),
    onSuccess: () => {
      moveKey.settle();
      reset();
      toast({ tone: 'ok', message: t('web.service_action_planned') });
      onActed();
    },
    onError: (error) => {
      moveKey.settleOn(error);
      toast({ tone: 'danger', message: messageFor(error), error });
    },
  });
  return (
    <>
      <Button
        disabled={!mayEdit || entry?.available !== true}
        {...describedBy('CHANGE_LOCATION', mayEdit, entry)}
        onClick={() => setOpen(true)}
      >
        {t('web.service_action_change_location')}
      </Button>
      <Drawer open={open} onClose={requestClose} title={t('web.service_action_change_location')}>
        <div className="stack-sm">
          {targets.data?.current !== null && targets.data?.current !== undefined && (
            <p className="muted small">
              {t('web.soc_move_current')} {targets.data.current.label}
            </p>
          )}
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
          <p className="muted small">{t('web.soc_move_hint')}</p>
          <div className="form-actions">
            <Button
              variant="primary"
              disabled={target === '' || moveReason.trim() === '' || relocate.isPending}
              onClick={() => relocate.mutate({ locationId: target, reason: moveReason.trim() })}
            >
              {t('web.soc_move_button')}
            </Button>
          </div>
        </div>
      </Drawer>
      {dialog}
    </>
  );
}
