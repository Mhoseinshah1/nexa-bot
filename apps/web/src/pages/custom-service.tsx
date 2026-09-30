import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COMMERCE_ERROR_CODES,
  CUSTOM_SERVICE_LABEL_MAX_LENGTH,
  CUSTOM_SERVICE_MAX_DAYS,
  CUSTOM_SERVICE_MAX_VOLUME_UNITS,
  CUSTOM_SERVICE_RULE_DIMENSIONS,
  CUSTOM_SERVICE_RULE_LEVELS,
  PANEL_PAGE_MAX,
  TRAFFIC_GB_PATTERN,
  parseCustomServiceVolume,
  uuidV7Schema,
  type CustomServiceLocationSummaryResponse,
  type CustomServiceRuleDimension,
  type CustomServiceRuleLevel,
  type CustomServiceRuleSummaryResponse,
} from '@nexa/contracts';
import { groupTrafficFigure } from '@nexa/i18n';
import {
  ApiError,
  createCustomServiceRule,
  deleteCustomServiceLocation,
  deleteCustomServiceRule,
  fetchCustomServiceLocations,
  fetchCustomServiceRules,
  fetchPanels,
  fetchResellerTiers,
  saveCustomServiceLocation,
  updateCustomServiceRule,
  type CustomServiceRuleWriteInput,
} from '../api/client';
import { useSubmissionKey } from '../submission-key';
import { queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  Copyable,
  DataTable,
  Empty,
  Field,
  IconButton,
  Ltr,
  Money,
  PageHead,
  RowActions,
  StateSwitch,
  Switch,
  useToast,
  useUnsavedChanges,
  type Column,
  type Tone,
  Num,
} from '../ui/kit';
import { SaveBar, revealField } from './editor-layout';

/**
 * The custom service (سرویس دلخواه), Package D (`docs/package-d-custom-service-audit.md`).
 *
 * Two sections: the LOCATIONS a customer may choose from — a panel opted in under a
 * customer-facing label — and the PRICE RULES a volume and a number of days are priced by.
 * Read on `catalog.view`, written on `catalog.pricing.edit`, the keys
 * `CustomServiceAdminService` charges; a section the actor may not write says so rather
 * than drawing a disabled form, the rule `discounts.tsx` follows.
 *
 * What the page says because the server does it:
 *
 * - **Specificity is a fixed order**, customer + panel first, tier + all panels last, and a
 *   rule is selected per dimension at the first level whose range contains the request.
 * - **Two enabled rules may not overlap** at one specificity. The server decides that under
 *   a lock, because it depends on every other rule; the form checks only what one rule can
 *   say about itself — the bounds and the price — exactly as the contract's schema does.
 * - **Nothing here reprices an order.** A custom order froze its terms when it was drafted,
 *   and the order page reads them from that snapshot.
 * - **The feature flag decides whether any of this is offered**, and it is off by default.
 */
export function CustomServicePage({
  denied,
  mayEdit,
  mayViewPanels,
  mayViewTiers,
}: {
  /** No `catalog.view`: neither list. */
  denied: boolean;
  /** `catalog.pricing.edit` — its own server permission, never derived from `denied`. */
  mayEdit: boolean;
  /** `panels.view`: the panel pickers are a select; without it a panel id is typed. */
  mayViewPanels: boolean;
  /** `resellers.view`: the tier picker is a select; without it a tier id is typed. */
  mayViewTiers: boolean;
}) {
  const options = usePickerOptions({
    panels: !denied && mayViewPanels,
    tiers: !denied && mayViewTiers,
  });
  return (
    <>
      <PageHead
        title={t('web.custom_service_title')}
        subtitle={t('web.custom_service_intro')}
        maturity="now"
      />
      <Banner tone="info" title={t('web.custom_service_flag_title')}>
        {t('web.custom_service_flag_note')}
      </Banner>
      <Locations denied={denied} mayEdit={mayEdit} options={options} />
      <Rules denied={denied} mayEdit={mayEdit} options={options} />
      <Card title={t('web.custom_service_specificity_title')} tone="muted">
        <p className="muted">{t('web.custom_service_specificity_intro')}</p>
        <ol className="custom-levels">
          {CUSTOM_SERVICE_RULE_LEVELS.map((level) => (
            <li key={level}>{t(CUSTOM_SERVICE_LEVEL_LABELS[level])}</li>
          ))}
        </ol>
        <p className="muted small">{t('web.custom_service_note_tier')}</p>
        <p className="muted small">{t('web.custom_service_note_both')}</p>
        <p className="muted small">{t('web.custom_service_note_overlap')}</p>
        <p className="muted small">{t('web.custom_service_note_snapshot')}</p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

const DIMENSION_LABELS: Readonly<Record<CustomServiceRuleDimension, WebKey>> = {
  VOLUME: 'web.custom_service_dimension_volume',
  TIME: 'web.custom_service_dimension_time',
};

/**
 * The four specificity levels, most specific first. Exported, because the order page
 * names the level each of a custom order's two rules was selected at, and a second copy
 * of this map would be a second answer to what a level is called.
 */
export const CUSTOM_SERVICE_LEVEL_LABELS: Readonly<Record<CustomServiceRuleLevel, WebKey>> = {
  CUSTOMER_PANEL: 'web.custom_service_level_customer_panel',
  CUSTOMER_ALL_PANELS: 'web.custom_service_level_customer_all_panels',
  TIER_PANEL: 'web.custom_service_level_tier_panel',
  TIER_ALL_PANELS: 'web.custom_service_level_tier_all_panels',
};

/**
 * The server's refusals, in words an operator can act on. The overlap is the one an
 * operator meets in ordinary use, so it is named rather than passed through; anything
 * else falls back to the shared `messageFor`.
 */
const INVALID_FIELD_MESSAGES: Readonly<Record<string, WebKey>> = {
  panelId: 'web.custom_service_error_invalid_panel',
  customerId: 'web.custom_service_error_invalid_customer',
  resellerTierId: 'web.custom_service_error_invalid_tier',
  count: 'web.custom_service_error_invalid_count',
};

export function customServiceMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === COMMERCE_ERROR_CODES.CUSTOM_SERVICE_RULE_OVERLAP) {
      return t('web.custom_service_error_overlap');
    }
    if (error.code === COMMERCE_ERROR_CODES.CUSTOM_SERVICE_RULE_NOT_FOUND) {
      return t('web.custom_service_error_rule_not_found');
    }
    if (error.code === COMMERCE_ERROR_CODES.CUSTOM_SERVICE_LOCATION_NOT_FOUND) {
      return t('web.custom_service_error_location_not_found');
    }
    if (error.code === COMMERCE_ERROR_CODES.CUSTOM_SERVICE_RULE_INVALID) {
      const field = error.details?.['field'];
      const key = typeof field === 'string' ? INVALID_FIELD_MESSAGES[field] : undefined;
      return t(key ?? 'web.custom_service_error_invalid');
    }
  }
  return messageFor(error);
}

function Dash() {
  return <span className="faint">—</span>;
}

function isUuid(value: string): boolean {
  return uuidV7Schema.safeParse(value).success;
}

// ---------------------------------------------------------------------------
// The pickers' options
// ---------------------------------------------------------------------------

interface Option {
  readonly id: string;
  readonly label: string;
}

interface PickerOptions {
  /** The COMPLETE panel list, or null when a panel must be typed. */
  readonly panels: readonly Option[] | null;
  /** Every reseller tier, or null when a tier must be typed. */
  readonly tiers: readonly Option[] | null;
  readonly panelNames: ReadonlyMap<string, string>;
  readonly tierNames: ReadonlyMap<string, string>;
}

/**
 * The fleet and the reseller tiers, read on their own keys. A select ONLY when the list
 * is complete — a picker that silently omits the hundred-and-first panel is worse than a
 * box asking for an id — so a `nextCursor`, a refusal or a failure fall back to typing.
 */
function usePickerOptions(enabled: { panels: boolean; tiers: boolean }): PickerOptions {
  const panels = useQuery({
    queryKey: ['panels', 'for-custom-service'],
    queryFn: () => fetchPanels({ limit: PANEL_PAGE_MAX }),
    enabled: enabled.panels,
  });
  const tiers = useQuery({
    queryKey: ['reseller-tiers'],
    queryFn: () => fetchResellerTiers(),
    enabled: enabled.tiers,
  });
  const panelRows = panels.data?.panels ?? [];
  const tierRows = tiers.data?.tiers ?? [];
  return {
    panels:
      enabled.panels && queryState(panels) === 'ready' && (panels.data?.nextCursor ?? null) === null
        ? panelRows.map((row) => ({ id: row.id, label: row.name }))
        : null,
    tiers:
      enabled.tiers && queryState(tiers) === 'ready'
        ? tierRows.map((row) => ({ id: row.id, label: row.name }))
        : null,
    panelNames: new Map(panelRows.map((row) => [row.id, row.name])),
    tierNames: new Map(tierRows.map((row) => [row.id, row.name])),
  };
}

/** A panel or tier reference: its name when known, and its id either way. */
/** An on/off line in a form: the label, and its switch at the end. */
function ToggleLine({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="cb-toggle-line">
      <span>{label}</span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function Reference({ id, name }: { id: string; name: string | undefined }) {
  return name === undefined ? <Copyable value={id} /> : <Copyable value={id} display={name} />;
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

interface LocationRow {
  readonly panelId: string;
  readonly panelName: string | undefined;
  readonly location: CustomServiceLocationSummaryResponse | null;
}

/**
 * Every panel of the fleet, and whether it is offered. A panel the list did not return —
 * an archived one, or every one when the fleet cannot be read — still appears when it has
 * a location row, so an opt-in can always be seen and withdrawn.
 */
function locationRows(
  panels: readonly Option[] | null,
  locations: readonly CustomServiceLocationSummaryResponse[],
): readonly LocationRow[] {
  const byPanel = new Map(locations.map((row) => [row.panelId, row]));
  const listed = (panels ?? []).map((panel): LocationRow => ({
    panelId: panel.id,
    panelName: panel.label,
    location: byPanel.get(panel.id) ?? null,
  }));
  const seen = new Set(listed.map((row) => row.panelId));
  const unlisted = locations
    .filter((row) => !seen.has(row.panelId))
    .map((row): LocationRow => ({ panelId: row.panelId, panelName: row.panelName, location: row }));
  return [...listed, ...unlisted];
}

function OfferedBadge({ location }: { location: CustomServiceLocationSummaryResponse | null }) {
  const [tone, key]: [Tone, WebKey] =
    location === null
      ? ['neutral', 'web.custom_service_location_not_offered']
      : location.enabled
        ? ['ok', 'web.custom_service_location_offered']
        : ['warn', 'web.custom_service_location_disabled'];
  return <Badge tone={tone}>{t(key)}</Badge>;
}

function Locations({
  denied,
  mayEdit,
  options,
}: {
  denied: boolean;
  mayEdit: boolean;
  options: PickerOptions;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();

  const locations = useQuery({
    queryKey: ['custom-service-locations'],
    queryFn: () => fetchCustomServiceLocations(),
    enabled: !denied,
  });
  const rows = locationRows(options.panels, locations.data?.locations ?? []);

  /** The row being edited, or null for the blank form. */
  const [editing, setEditing] = useState<LocationRow | null>(null);
  /** The row whose offer is being withdrawn, while the question is open. */
  const [deleting, setDeleting] = useState<LocationRow | null>(null);

  const remove = useMutation({
    mutationFn: (panelId: string) =>
      deleteCustomServiceLocation({
        panelId,
        idempotencyKey: submission.current({ removeLocation: panelId }),
      }),
    onSuccess: (_response, panelId) => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.custom_service_location_deleted') });
      if (editing?.panelId === panelId) setEditing(null);
      void queries.invalidateQueries({ queryKey: ['custom-service-locations'] });
    },
    onError: (error) => submission.settleOn(error),
  });

  const columns: readonly Column<LocationRow>[] = [
    {
      key: 'panel',
      header: t('web.custom_service_panel'),
      render: (row) => <Reference id={row.panelId} name={row.panelName} />,
    },
    {
      key: 'label',
      header: t('web.custom_service_location_label'),
      render: (row) =>
        row.location === null ? <Dash /> : <span className="strong">{row.location.label}</span>,
    },
    {
      key: 'offered',
      header: t('web.status'),
      render: (row) => <OfferedBadge location={row.location} />,
    },
    {
      key: 'actions',
      header: t('web.rule_actions'),
      align: 'end',
      render: (row) =>
        !mayEdit ? null : (
          <RowActions>
            <Button
              size="sm"
              variant="ghost"
              icon={row.location === null ? 'plus' : 'edit'}
              disabled={remove.isPending}
              onClick={() => {
                setEditing(row);
                revealField('custom-location-label');
              }}
            >
              {row.location === null ? t('web.custom_service_location_offer') : t('web.rule_edit')}
            </Button>
            {row.location !== null && (
              <IconButton
                size="sm"
                icon="trash"
                variant="danger"
                className="ghost"
                label={t('web.custom_service_delete')}
                disabled={remove.isPending}
                onClick={() => setDeleting(row)}
              />
            )}
          </RowActions>
        ),
    },
  ];

  return (
    <div className="cb-split">
      <Card
        title={t('web.custom_service_locations_title')}
        hint={t('web.custom_service_locations_hint')}
      >
        <StateSwitch
          query={locations}
          denied={denied}
          isEmpty={rows.length === 0}
          empty={
            <Empty
              title={t('web.custom_service_locations_empty')}
              hint={t('web.custom_service_locations_empty_hint')}
              icon="panels"
            />
          }
        >
          <DataTable
            caption={t('web.custom_service_locations_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.panelId}
            dense
          />
        </StateSwitch>
        {remove.error !== null && (
          <Banner tone="danger">{customServiceMessage(remove.error)}</Banner>
        )}
      </Card>

      {!mayEdit ? (
        <Card title={t('web.custom_service_location_form_title')}>
          <Banner tone="info">{t('web.custom_service_edit_denied')}</Banner>
        </Card>
      ) : (
        <LocationForm
          key={editing?.panelId ?? 'new'}
          row={editing}
          options={options}
          onDone={() => setEditing(null)}
        />
      )}

      {deleting !== null && (
        <ConfirmDialog
          title={deleting.location?.label ?? deleting.panelName ?? deleting.panelId}
          question={t('web.custom_service_location_delete_confirm')}
          confirmLabel={t('web.cb_delete_yes')}
          cancelLabel={t('web.cb_cancel')}
          onConfirm={() => {
            const panelId = deleting.panelId;
            setDeleting(null);
            remove.mutate(panelId);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

interface LocationFormState {
  panelId: string;
  label: string;
  enabled: boolean;
}

export function locationBodyFrom(
  state: LocationFormState,
): { panelId: string; label: string; enabled: boolean } | { problem: WebKey } {
  const panelId = state.panelId.trim();
  if (!isUuid(panelId)) return { problem: 'web.custom_service_problem_panel' };
  const label = state.label.trim();
  if (label === '' || label.length > CUSTOM_SERVICE_LABEL_MAX_LENGTH) {
    return { problem: 'web.custom_service_problem_location_label' };
  }
  return { panelId, label, enabled: state.enabled };
}

function LocationForm({
  row,
  options,
  onDone,
}: {
  row: LocationRow | null;
  options: PickerOptions;
  onDone: () => void;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const blank: LocationFormState = { panelId: row?.panelId ?? '', label: '', enabled: true };
  const loaded: LocationFormState =
    row === null || row.location === null
      ? blank
      : { panelId: row.panelId, label: row.location.label, enabled: row.location.enabled };
  const [state, setState] = useState<LocationFormState>(loaded);
  const dirty = JSON.stringify(state) !== JSON.stringify(loaded);
  useUnsavedChanges(dirty);

  const checked = locationBodyFrom(state);
  const problem = 'problem' in checked ? checked.problem : null;

  const save = useMutation({
    mutationFn: () => {
      if ('problem' in checked) throw new Error('unreachable: guarded by the submit button');
      return saveCustomServiceLocation({
        ...checked,
        idempotencyKey: submission.current({ location: checked }),
      });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.custom_service_location_saved') });
      setState({ panelId: '', label: '', enabled: true });
      void queries.invalidateQueries({ queryKey: ['custom-service-locations'] });
      onDone();
    },
    onError: (error) => submission.settleOn(error),
  });

  return (
    <Card
      className="cb-side-form"
      title={t('web.custom_service_location_form_title')}
      hint={t('web.custom_service_location_form_hint')}
      foot={
        <SaveBar dirty={dirty}>
          {row !== null && (
            <Button size="sm" disabled={save.isPending} onClick={onDone}>
              {t('web.rule_cancel_edit')}
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            icon="check"
            disabled={problem !== null || save.isPending}
            onClick={() => save.mutate()}
          >
            {t('web.rule_save')}
          </Button>
        </SaveBar>
      }
    >
      <Field
        label={t('web.custom_service_panel')}
        htmlFor="custom-location-panel"
        {...(options.panels === null ? { hint: t('web.custom_service_panel_typed_hint') } : {})}
      >
        {row !== null ? (
          <span id="custom-location-panel">
            <Reference id={row.panelId} name={row.panelName} />
          </span>
        ) : options.panels === null ? (
          <input
            id="custom-location-panel"
            dir="ltr"
            value={state.panelId}
            onChange={(event) => setState({ ...state, panelId: event.target.value.trim() })}
          />
        ) : (
          <select
            id="custom-location-panel"
            value={state.panelId}
            onChange={(event) => setState({ ...state, panelId: event.target.value })}
          >
            <option value="" />
            {options.panels.map((panel) => (
              <option key={panel.id} value={panel.id}>
                {panel.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        label={t('web.custom_service_location_label')}
        hint={t('web.custom_service_location_label_hint')}
        htmlFor="custom-location-label"
      >
        <input
          id="custom-location-label"
          value={state.label}
          maxLength={CUSTOM_SERVICE_LABEL_MAX_LENGTH}
          onChange={(event) => setState({ ...state, label: event.target.value })}
        />
      </Field>
      <ToggleLine
        label={t('web.custom_service_enabled')}
        checked={state.enabled}
        onChange={(enabled) => setState({ ...state, enabled })}
      />

      {problem !== null && <Banner tone="warn">{t(problem)}</Banner>}
      {save.error !== null && <Banner tone="danger">{customServiceMessage(save.error)}</Banner>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Price rules
// ---------------------------------------------------------------------------

/** A bound as the operator typed it, with its unit: GB for VOLUME, days for TIME. */
function RuleRange({ row }: { row: CustomServiceRuleSummaryResponse }) {
  const figure = (text: string) => (row.dimension === 'VOLUME' ? groupTrafficFigure(text) : text);
  return (
    <span className="nowrap">
      <Num value={figure(row.minimum)} /> {t('web.custom_service_range_to')}{' '}
      <Num value={figure(row.maximum)} />{' '}
      {row.dimension === 'VOLUME' ? t('web.unit_gib') : t('web.product_days_unit')}
    </span>
  );
}

function Audience({
  row,
  options,
}: {
  row: CustomServiceRuleSummaryResponse;
  options: PickerOptions;
}) {
  const onLink = useLinkHandler();
  if (row.customerId !== null) {
    return (
      <span>
        {t('web.custom_service_audience_customer')}{' '}
        <a href={`/users/${encodeURIComponent(row.customerId)}`} onClick={onLink}>
          <Ltr>{row.customerId.slice(0, 8)}</Ltr>
        </a>
      </span>
    );
  }
  if (row.resellerTierId !== null) {
    return (
      <span>
        {t('web.custom_service_audience_tier')}{' '}
        <Reference id={row.resellerTierId} name={options.tierNames.get(row.resellerTierId)} />
      </span>
    );
  }
  return <span>{t('web.custom_service_audience_ordinary')}</span>;
}

function Rules({
  denied,
  mayEdit,
  options,
}: {
  denied: boolean;
  mayEdit: boolean;
  options: PickerOptions;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();

  const rules = useQuery({
    queryKey: ['custom-service-rules'],
    queryFn: () => fetchCustomServiceRules(),
    enabled: !denied,
  });
  const rows = rules.data?.rules ?? [];

  const [editing, setEditing] = useState<CustomServiceRuleSummaryResponse | null>(null);
  /** The rule whose deletion is being asked about. */
  const [deleting, setDeleting] = useState<CustomServiceRuleSummaryResponse | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) =>
      deleteCustomServiceRule({ id, idempotencyKey: submission.current({ removeRule: id }) }),
    onSuccess: (_response, id) => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.custom_service_rule_deleted') });
      if (editing?.id === id) setEditing(null);
      void queries.invalidateQueries({ queryKey: ['custom-service-rules'] });
    },
    onError: (error) => submission.settleOn(error),
  });

  const columns: readonly Column<CustomServiceRuleSummaryResponse>[] = [
    {
      key: 'dimension',
      header: t('web.custom_service_dimension'),
      render: (row) => (
        <Badge tone={row.dimension === 'VOLUME' ? 'info' : 'violet'} outline>
          {t(DIMENSION_LABELS[row.dimension])}
        </Badge>
      ),
    },
    {
      key: 'label',
      header: t('web.rule_label'),
      render: (row) => (row.label === null ? <Dash /> : row.label),
    },
    {
      key: 'range',
      header: t('web.custom_service_range'),
      render: (row) => <RuleRange row={row} />,
    },
    {
      key: 'price',
      header: t('web.custom_service_unit_price'),
      render: (row) => (
        <span className="nowrap">
          <Money value={{ amountMinor: row.unitPriceAmount, currency: row.currency }} />{' '}
          {row.dimension === 'VOLUME'
            ? t('web.custom_service_per_gb')
            : t('web.custom_service_per_day')}
        </span>
      ),
    },
    {
      key: 'audience',
      header: t('web.custom_service_audience'),
      render: (row) => <Audience row={row} options={options} />,
    },
    {
      key: 'panel',
      header: t('web.custom_service_panel'),
      render: (row) =>
        row.panelId === null ? (
          <span>{t('web.custom_service_all_panels')}</span>
        ) : (
          <Reference id={row.panelId} name={options.panelNames.get(row.panelId)} />
        ),
    },
    {
      key: 'enabled',
      header: t('web.status'),
      render: (row) =>
        row.enabled ? (
          <Badge tone="ok" dot>
            {t('web.enabled')}
          </Badge>
        ) : (
          <Badge tone="neutral" dot>
            {t('web.disabled')}
          </Badge>
        ),
    },
    {
      key: 'actions',
      header: t('web.rule_actions'),
      align: 'end',
      render: (row) =>
        !mayEdit ? null : (
          <RowActions>
            <Button
              size="sm"
              variant="ghost"
              icon="edit"
              disabled={remove.isPending}
              onClick={() => {
                setEditing(row);
                revealField('custom-rule-edit-dimension');
              }}
            >
              {t('web.rule_edit')}
            </Button>
            <IconButton
              size="sm"
              icon="trash"
              variant="danger"
              className="ghost"
              label={t('web.custom_service_delete')}
              disabled={remove.isPending}
              onClick={() => setDeleting(row)}
            />
          </RowActions>
        ),
    },
  ];

  return (
    <div className="stack">
      <Card title={t('web.custom_service_rules_title')} hint={t('web.custom_service_rules_hint')}>
        <StateSwitch
          query={rules}
          denied={denied}
          isEmpty={rows.length === 0}
          empty={<Empty title={t('web.custom_service_rules_empty')} icon="discounts" />}
        >
          <DataTable
            caption={t('web.custom_service_rules_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            dense
          />
        </StateSwitch>
        {remove.error !== null && (
          <Banner tone="danger">{customServiceMessage(remove.error)}</Banner>
        )}
      </Card>

      {!mayEdit ? (
        <Card title={t('web.custom_service_rule_new_title')}>
          <Banner tone="info">{t('web.custom_service_edit_denied')}</Banner>
        </Card>
      ) : editing !== null ? (
        <RuleForm
          key={editing.id}
          rule={editing}
          options={options}
          onDone={() => setEditing(null)}
        />
      ) : (
        <RuleForm options={options} onDone={() => undefined} />
      )}

      {deleting !== null && (
        <ConfirmDialog
          title={deleting.label ?? t(DIMENSION_LABELS[deleting.dimension])}
          question={t('web.custom_service_rule_delete_confirm')}
          confirmLabel={t('web.cb_delete_yes')}
          cancelLabel={t('web.cb_cancel')}
          onConfirm={() => {
            const id = deleting.id;
            setDeleting(null);
            remove.mutate(id);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

type AudienceKind = 'ORDINARY' | 'TIER' | 'CUSTOMER';

export interface RuleFormState {
  dimension: CustomServiceRuleDimension;
  label: string;
  minimum: string;
  maximum: string;
  price: string;
  audience: AudienceKind;
  tierId: string;
  customerId: string;
  /** Empty means every panel. */
  panelId: string;
  enabled: boolean;
}

const BLANK_RULE: RuleFormState = {
  dimension: 'VOLUME',
  label: '',
  minimum: '',
  maximum: '',
  price: '',
  audience: 'ORDINARY',
  tierId: '',
  customerId: '',
  panelId: '',
  enabled: true,
};

function ruleStateOf(rule: CustomServiceRuleSummaryResponse): RuleFormState {
  return {
    dimension: rule.dimension,
    label: rule.label ?? '',
    minimum: rule.minimum,
    maximum: rule.maximum,
    price: rule.unitPriceAmount,
    audience:
      rule.customerId !== null ? 'CUSTOMER' : rule.resellerTierId !== null ? 'TIER' : 'ORDINARY',
    tierId: rule.resellerTierId ?? '',
    customerId: rule.customerId ?? '',
    panelId: rule.panelId ?? '',
    enabled: rule.enabled,
  };
}

/** A whole day count, `1` to `CUSTOM_SERVICE_MAX_DAYS`: the contract's own pattern. */
const DAYS_PATTERN = /^[1-9][0-9]{0,3}$/u;

/**
 * A bound in the dimension's unit — hundredths of a GB for VOLUME, days for TIME — or
 * null. The same test `customServiceRuleWriteSchema` applies: ASCII digits, at most two
 * decimals and above zero for a volume, up to the product ceiling; a whole day count up to
 * `CUSTOM_SERVICE_MAX_DAYS` for a time.
 */
export function customServiceBound(
  dimension: CustomServiceRuleDimension,
  text: string,
): bigint | null {
  if (dimension === 'TIME') {
    if (!DAYS_PATTERN.test(text)) return null;
    const days = BigInt(text);
    return days <= BigInt(CUSTOM_SERVICE_MAX_DAYS) ? days : null;
  }
  if (!TRAFFIC_GB_PATTERN.test(text)) return null;
  const units = parseCustomServiceVolume(text);
  if (units === null) return null;
  return units >= 1n && units <= CUSTOM_SERVICE_MAX_VOLUME_UNITS ? units : null;
}

export function customServiceRuleBodyFrom(
  state: RuleFormState,
): { body: Omit<CustomServiceRuleWriteInput, 'idempotencyKey'> } | { problem: WebKey } {
  const label = state.label.trim();
  if (label.length > CUSTOM_SERVICE_LABEL_MAX_LENGTH) {
    return { problem: 'web.custom_service_problem_label' };
  }
  const boundProblem: WebKey =
    state.dimension === 'VOLUME'
      ? 'web.custom_service_problem_volume_bound'
      : 'web.custom_service_problem_days_bound';
  const minimumText = state.minimum.trim();
  const maximumText = state.maximum.trim();
  const minimum = customServiceBound(state.dimension, minimumText);
  const maximum = customServiceBound(state.dimension, maximumText);
  if (minimum === null || maximum === null) return { problem: boundProblem };
  if (maximum < minimum) return { problem: 'web.custom_service_problem_range' };

  const price = state.price.trim();
  if (!/^[1-9]\d{0,18}$/u.test(price)) return { problem: 'web.custom_service_problem_price' };

  const tierId = state.tierId.trim();
  const customerId = state.customerId.trim();
  if (state.audience === 'TIER' && !isUuid(tierId)) {
    return { problem: 'web.custom_service_problem_tier' };
  }
  if (state.audience === 'CUSTOMER' && !isUuid(customerId)) {
    return { problem: 'web.custom_service_problem_customer' };
  }
  const panelId = state.panelId.trim();
  if (panelId !== '' && !isUuid(panelId)) return { problem: 'web.custom_service_problem_panel' };

  return {
    body: {
      dimension: state.dimension,
      label: label === '' ? null : label,
      minimum: minimumText,
      maximum: maximumText,
      unitPriceAmount: price,
      customerId: state.audience === 'CUSTOMER' ? customerId : null,
      resellerTierId: state.audience === 'TIER' ? tierId : null,
      panelId: panelId === '' ? null : panelId,
      enabled: state.enabled,
    },
  };
}

function RuleForm({
  rule,
  options,
  onDone,
}: {
  rule?: CustomServiceRuleSummaryResponse;
  options: PickerOptions;
  onDone: () => void;
}) {
  const mode = rule === undefined ? 'create' : 'edit';
  const prefix = `custom-rule-${mode}`;
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [state, setState] = useState<RuleFormState>(
    rule === undefined ? BLANK_RULE : ruleStateOf(rule),
  );
  const dirty =
    JSON.stringify(state) !== JSON.stringify(rule === undefined ? BLANK_RULE : ruleStateOf(rule));
  useUnsavedChanges(dirty);
  const set = <K extends keyof RuleFormState>(key: K, value: RuleFormState[K]) =>
    setState({ ...state, [key]: value });

  const checked = customServiceRuleBodyFrom(state);
  const problem = 'problem' in checked ? checked.problem : null;

  const save = useMutation({
    mutationFn: () => {
      if ('problem' in checked) throw new Error('unreachable: guarded by the submit button');
      const idempotencyKey = submission.current({ id: rule?.id ?? null, ...checked.body });
      return rule === undefined
        ? createCustomServiceRule({ ...checked.body, idempotencyKey })
        : updateCustomServiceRule({ ...checked.body, id: rule.id, idempotencyKey });
    },
    onSuccess: () => {
      submission.settle();
      notify({
        tone: 'ok',
        message:
          mode === 'create'
            ? t('web.custom_service_rule_created')
            : t('web.custom_service_rule_saved'),
      });
      if (mode === 'create') setState(BLANK_RULE);
      void queries.invalidateQueries({ queryKey: ['custom-service-rules'] });
      onDone();
    },
    onError: (error) => submission.settleOn(error),
  });

  const volume = state.dimension === 'VOLUME';

  return (
    <Card
      title={
        mode === 'create'
          ? t('web.custom_service_rule_new_title')
          : t('web.custom_service_rule_edit_title')
      }
      foot={
        <SaveBar dirty={dirty}>
          {mode === 'edit' && (
            <Button size="sm" disabled={save.isPending} onClick={onDone}>
              {t('web.rule_cancel_edit')}
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            icon="check"
            disabled={problem !== null || save.isPending}
            onClick={() => save.mutate()}
          >
            {mode === 'create' ? t('web.custom_service_rule_create') : t('web.rule_save')}
          </Button>
        </SaveBar>
      }
    >
      <div className="form-grid c3">
        <Field label={t('web.custom_service_dimension')} htmlFor={`${prefix}-dimension`}>
          <select
            id={`${prefix}-dimension`}
            value={state.dimension}
            onChange={(event) => set('dimension', event.target.value as CustomServiceRuleDimension)}
          >
            {CUSTOM_SERVICE_RULE_DIMENSIONS.map((dimension) => (
              <option key={dimension} value={dimension}>
                {t(DIMENSION_LABELS[dimension])}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={t('web.rule_label')}
          hint={t('web.custom_service_rule_label_hint')}
          htmlFor={`${prefix}-label`}
        >
          <input
            id={`${prefix}-label`}
            value={state.label}
            maxLength={CUSTOM_SERVICE_LABEL_MAX_LENGTH}
            onChange={(event) => set('label', event.target.value)}
          />
        </Field>
        <Field
          label={volume ? t('web.custom_service_minimum_gb') : t('web.custom_service_minimum_days')}
          hint={
            volume ? t('web.custom_service_bound_gb_hint') : t('web.custom_service_bound_days_hint')
          }
          htmlFor={`${prefix}-minimum`}
        >
          <input
            id={`${prefix}-minimum`}
            dir="ltr"
            inputMode={volume ? 'decimal' : 'numeric'}
            value={state.minimum}
            onChange={(event) => set('minimum', event.target.value.trim())}
          />
        </Field>
        <Field
          label={volume ? t('web.custom_service_maximum_gb') : t('web.custom_service_maximum_days')}
          htmlFor={`${prefix}-maximum`}
        >
          <input
            id={`${prefix}-maximum`}
            dir="ltr"
            inputMode={volume ? 'decimal' : 'numeric'}
            value={state.maximum}
            onChange={(event) => set('maximum', event.target.value.trim())}
          />
        </Field>
        <Field
          label={
            volume ? t('web.custom_service_price_per_gb') : t('web.custom_service_price_per_day')
          }
          hint={t('web.custom_service_price_hint')}
          htmlFor={`${prefix}-price`}
        >
          <input
            id={`${prefix}-price`}
            dir="ltr"
            inputMode="numeric"
            value={state.price}
            onChange={(event) => set('price', event.target.value.trim())}
          />
        </Field>

        <Field
          label={t('web.custom_service_audience')}
          hint={t('web.custom_service_audience_hint')}
          htmlFor={`${prefix}-audience`}
        >
          <select
            id={`${prefix}-audience`}
            value={state.audience}
            onChange={(event) => set('audience', event.target.value as AudienceKind)}
          >
            <option value="ORDINARY">{t('web.custom_service_audience_ordinary')}</option>
            <option value="TIER">{t('web.custom_service_audience_tier')}</option>
            <option value="CUSTOMER">{t('web.custom_service_audience_customer')}</option>
          </select>
        </Field>
        {state.audience === 'TIER' && (
          <Field
            label={t('web.custom_service_audience_tier')}
            htmlFor={`${prefix}-tier`}
            {...(options.tiers === null ? { hint: t('web.custom_service_tier_typed_hint') } : {})}
          >
            {options.tiers === null ? (
              <input
                id={`${prefix}-tier`}
                dir="ltr"
                value={state.tierId}
                onChange={(event) => set('tierId', event.target.value.trim())}
              />
            ) : (
              <select
                id={`${prefix}-tier`}
                value={state.tierId}
                onChange={(event) => set('tierId', event.target.value)}
              >
                <option value="" />
                {options.tiers.map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {tier.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {state.audience === 'CUSTOMER' && (
          <Field
            label={t('web.custom_service_customer_id')}
            hint={t('web.custom_service_customer_id_hint')}
            htmlFor={`${prefix}-customer`}
          >
            <input
              id={`${prefix}-customer`}
              dir="ltr"
              value={state.customerId}
              onChange={(event) => set('customerId', event.target.value.trim())}
            />
          </Field>
        )}

        <Field
          label={t('web.custom_service_panel')}
          htmlFor={`${prefix}-panel`}
          hint={
            options.panels === null
              ? t('web.custom_service_rule_panel_typed_hint')
              : t('web.custom_service_rule_panel_hint')
          }
        >
          {options.panels === null ? (
            <input
              id={`${prefix}-panel`}
              dir="ltr"
              value={state.panelId}
              onChange={(event) => set('panelId', event.target.value.trim())}
            />
          ) : (
            <select
              id={`${prefix}-panel`}
              value={state.panelId}
              onChange={(event) => set('panelId', event.target.value)}
            >
              <option value="">{t('web.custom_service_all_panels')}</option>
              {options.panels.map((panel) => (
                <option key={panel.id} value={panel.id}>
                  {panel.label}
                </option>
              ))}
              {/* A rule may name a panel the list no longer returns; keep it choosable. */}
              {state.panelId !== '' &&
                !options.panels.some((panel) => panel.id === state.panelId) && (
                  <option value={state.panelId}>{state.panelId}</option>
                )}
            </select>
          )}
        </Field>
      </div>
      <ToggleLine
        label={t('web.custom_service_enabled')}
        checked={state.enabled}
        onChange={(enabled) => set('enabled', enabled)}
      />

      {problem !== null && <Banner tone="warn">{t(problem)}</Banner>}
      {save.error !== null && <Banner tone="danger">{customServiceMessage(save.error)}</Banner>}
    </Card>
  );
}
