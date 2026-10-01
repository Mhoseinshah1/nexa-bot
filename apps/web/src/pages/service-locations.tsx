import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PROVIDER_DESCRIPTORS,
  SALES_CURRENCY_CODES,
  SERVICE_LOCATION_COOLDOWN_HOURS_MAX,
  SERVICE_LOCATION_KEY_MAX_LENGTH,
  SERVICE_LOCATION_LABEL_MAX_LENGTH,
  SERVICE_LOCATION_MAX_CHANGES_MAX,
  SERVICE_LOCATION_PERIOD_DAYS_MAX,
  type CurrencyCode,
  type SalesCurrencyCode,
  type ServiceLocationSummaryResponse,
} from '@nexa/contracts';
import {
  ApiError,
  createServiceLocation,
  deleteServiceLocation,
  fetchPanels,
  fetchProducts,
  fetchServiceLocations,
  updateServiceLocation,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { messageFor } from './settings';
// The same walker the extra-users page reads its scope lists with: every page, no cap.
import { everyPage } from './extra-devices';
import {
  Badge,
  Banner,
  Button,
  Card,
  CellMain,
  ConfirmDialog,
  DataTable,
  Empty,
  Field,
  IconButton,
  Money,
  PageHead,
  RowActions,
  StateSwitch,
  useToast,
  useDiscardGuard,
  useUnsavedChanges,
  type Column,
} from '../ui/kit';
import { CheckField, FormSection, SaveBar, revealField } from './editor-layout';

/**
 * Service location change (WP-A6) — a panel's locations, the one its new accounts start
 * in, and what a customer pays to move an existing service to each of them.
 *
 * One row is a place on ONE panel: a move never leaves the panel the service is on, so
 * there is no target panel to choose. The operator writes the adapter-defined key their
 * panel uses and the name the customer sees; marks the panel's initial location, without
 * which a never-moved service's current location is unknown and nothing is offered; and
 * makes a row a TARGET by enabling it with a price — zero is free, empty is not for sale.
 *
 * **The customer sees «🌍 تغییر لوکیشن» only where the panel can really move an account.**
 * Which provider types can is read from the adapters' declared capabilities, never
 * configured here, and the banner says so: in this release, none.
 */

const CURRENCY_LABEL: Readonly<Record<SalesCurrencyCode, WebKey>> = {
  IRT: 'web.currency_irt',
  IRR: 'web.currency_irr',
};

/** The provider types whose adapter declares the capability — none, in this release. */
const CAPABLE_PROVIDERS = PROVIDER_DESCRIPTORS.filter((descriptor) =>
  descriptor.capabilities.includes('LOCATION_CHANGE'),
);

/** Why a write was refused, in the operator's words, where the server says which. */
const INVALID_REASONS: Readonly<Record<string, WebKey>> = {
  IN_USE: 'web.service_locations_error_in_use',
  DUPLICATE_KEY: 'web.service_locations_error_duplicate',
  SECOND_INITIAL: 'web.service_locations_error_second_initial',
  CURRENCY: 'web.service_locations_error_currency',
  PRODUCT_PANEL: 'web.service_locations_error_product_panel',
  PANEL_FULL: 'web.service_locations_error_panel_full',
  COUNT: 'web.service_locations_error_count',
};

function failureText(error: unknown): string {
  if (error instanceof ApiError && error.code === 'commerce.service_location_invalid') {
    const reason = error.details?.['reason'];
    const key = typeof reason === 'string' ? INVALID_REASONS[reason] : undefined;
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

const EMPTY_FORM = {
  panelId: '',
  productId: '',
  locationKey: '',
  label: '',
  initial: false,
  enabled: false,
  priceAmount: '',
  priceCurrency: 'IRT' as SalesCurrencyCode,
  cooldownHours: '',
  maxChanges: '',
  periodDays: '',
  sortOrder: '0',
};

type FormState = typeof EMPTY_FORM;

function formOf(row: ServiceLocationSummaryResponse): FormState {
  return {
    panelId: row.panelId,
    productId: row.productId ?? '',
    locationKey: row.locationKey,
    label: row.label,
    initial: row.initial,
    enabled: row.enabled,
    priceAmount: row.priceAmount ?? '',
    priceCurrency: (row.priceCurrency as SalesCurrencyCode | null) ?? 'IRT',
    cooldownHours: row.cooldownHours === null ? '' : String(row.cooldownHours),
    maxChanges: row.maxChanges === null ? '' : String(row.maxChanges),
    periodDays: row.periodDays === null ? '' : String(row.periodDays),
    sortOrder: String(row.sortOrder),
  };
}

/** Empty is null; a whole number in `[1, max]` is itself; anything else is invalid. */
function boundedOrNull(raw: string, max: number): number | null | 'INVALID' {
  const value = raw.trim();
  if (value === '') return null;
  if (!/^\d{1,5}$/u.test(value)) return 'INVALID';
  const parsed = Number(value);
  return parsed >= 1 && parsed <= max ? parsed : 'INVALID';
}

export function ServiceLocationsPage({
  denied,
  mayEdit,
  mayReadPanels = true,
}: {
  denied: boolean;
  mayEdit: boolean;
  /** `panels.view`, which the panel list charges. Without it the form takes a panel id. */
  mayReadPanels?: boolean;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();

  const locations = useQuery({
    queryKey: ['service-locations'],
    queryFn: fetchServiceLocations,
    enabled: !denied,
  });
  /*
   * The two pickers, read for a viewer's table AND an editor's form (Codex review #2 on
   * PR #101: an edit-only role got an empty panel list). Each is asked only of a role its
   * list endpoint admits — panels charge `panels.view`, products `catalog.view` — and
   * where it cannot be read the form takes the id typed instead; the server checks the
   * id against this tenant either way.
   */
  const readPanels = mayReadPanels && (!denied || mayEdit);
  const readProducts = !denied;
  const panels = useQuery({
    queryKey: ['panels', 'service-locations'],
    queryFn: () =>
      everyPage(async (cursor) => {
        const page = await fetchPanels({ limit: 100, ...(cursor === null ? {} : { cursor }) });
        return { items: page.panels, nextCursor: page.nextCursor };
      }),
    enabled: readPanels,
    retry: false,
  });
  const products = useQuery({
    queryKey: ['products', 'service-locations'],
    queryFn: () =>
      everyPage(async (cursor) => {
        const page = await fetchProducts({ limit: 100, ...(cursor === null ? {} : { cursor }) });
        return { items: page.products, nextCursor: page.nextCursor };
      }),
    enabled: readProducts,
    retry: false,
  });

  // A list the form may choose from: permitted and read. Otherwise the id is typed.
  const panelList = readPanels && !panels.isError;
  const productList = readProducts && !products.isError;

  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  /** The location whose deletion is being asked about, or null (D3: it had no question). */
  const [deleting, setDeleting] = useState<ServiceLocationSummaryResponse | null>(null);
  const rows = locations.data?.locations ?? [];
  const editedRow = editing === null ? undefined : rows.find((row) => row.id === editing);
  const dirty =
    JSON.stringify(form) !==
    JSON.stringify(editedRow === undefined ? EMPTY_FORM : formOf(editedRow));
  useUnsavedChanges(dirty);
  /** Edit or Add replaces the form's contents: asked first while they are unsaved. */
  const discard = useDiscardGuard(dirty);

  const panelName = (id: string): string => panels.data?.find((one) => one.id === id)?.name ?? id;
  const productName = (id: string | null): string =>
    id === null
      ? t('web.service_locations_all_products')
      : (products.data?.find((one) => one.id === id)?.title ?? id);

  const reset = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
  };
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['service-locations'] });
  };

  const price = form.priceAmount.trim();
  const priceValid = price === '' || /^\d{1,19}$/u.test(price);
  const cooldown = boundedOrNull(form.cooldownHours, SERVICE_LOCATION_COOLDOWN_HOURS_MAX);
  const maxChanges = boundedOrNull(form.maxChanges, SERVICE_LOCATION_MAX_CHANGES_MAX);
  const periodDays = boundedOrNull(form.periodDays, SERVICE_LOCATION_PERIOD_DAYS_MAX);
  const limitsValid =
    cooldown !== 'INVALID' &&
    maxChanges !== 'INVALID' &&
    periodDays !== 'INVALID' &&
    (maxChanges === null) === (periodDays === null);
  const formValid =
    form.panelId !== '' &&
    form.locationKey.trim() !== '' &&
    form.label.trim() !== '' &&
    priceValid &&
    // An enabled target needs a price: unconfigured is never free.
    (!form.enabled || price !== '') &&
    // The initial location belongs to the whole panel.
    (!form.initial || form.productId === '') &&
    limitsValid;

  const save = useMutation({
    mutationFn: () => {
      const fields = {
        panelId: form.panelId,
        productId: form.productId === '' ? null : form.productId,
        locationKey: form.locationKey.trim(),
        label: form.label.trim(),
        initial: form.initial,
        enabled: form.enabled,
        priceAmount: price === '' ? null : price,
        priceCurrency: price === '' ? null : (form.priceCurrency as CurrencyCode),
        cooldownHours: cooldown === 'INVALID' ? null : cooldown,
        maxChanges: maxChanges === 'INVALID' ? null : maxChanges,
        periodDays: periodDays === 'INVALID' ? null : periodDays,
        sortOrder: Number(form.sortOrder) || 0,
      };
      const idempotencyKey = submission.current({ editing, ...fields });
      return editing === null
        ? createServiceLocation({ ...fields, idempotencyKey })
        : updateServiceLocation({ ...fields, idempotencyKey, id: editing });
    },
    onSuccess: (saved) => {
      submission.settle();
      notify({
        tone: 'ok',
        message: t(
          saved.changed ? 'web.service_locations_saved' : 'web.service_locations_unchanged',
        ),
      });
      reset();
      refresh();
    },
    onError: (error) => submission.settleOn(error),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      deleteServiceLocation({ id, idempotencyKey: submission.current({ delete: id }) }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.service_locations_deleted') });
      refresh();
    },
    onError: (error) => submission.settleOn(error),
  });

  const busy = save.isPending || remove.isPending;
  const failure = save.error ?? remove.error;

  const limitsText = (row: ServiceLocationSummaryResponse): string => {
    const parts: string[] = [];
    if (row.cooldownHours !== null) {
      parts.push(
        t('web.service_locations_cooldown_value').replace('{hours}', String(row.cooldownHours)),
      );
    }
    if (row.maxChanges !== null && row.periodDays !== null) {
      parts.push(
        t('web.service_locations_limit_value')
          .replace('{max}', String(row.maxChanges))
          .replace('{days}', String(row.periodDays)),
      );
    }
    return parts.length === 0 ? t('web.service_locations_no_limits') : parts.join(' · ');
  };

  const columns: readonly Column<ServiceLocationSummaryResponse>[] = [
    {
      key: 'label',
      header: t('web.service_locations_label'),
      render: (row) => (
        <CellMain
          primary={
            <span className="row">
              <span className="strong">{row.label}</span>
              {row.initial && <Badge tone="info">{t('web.service_locations_initial_badge')}</Badge>}
            </span>
          }
          secondary={
            <span dir="ltr" className="mono small">
              {row.locationKey}
            </span>
          }
        />
      ),
    },
    {
      key: 'panel',
      header: t('web.service_locations_panel'),
      render: (row) => panelName(row.panelId),
    },
    {
      key: 'product',
      header: t('web.service_locations_product'),
      render: (row) => <span className="muted">{productName(row.productId)}</span>,
    },
    {
      key: 'price',
      header: t('web.service_locations_price'),
      render: (row) =>
        row.priceAmount === null || row.priceCurrency === null ? (
          <span className="faint">{t('web.service_locations_unpriced')}</span>
        ) : row.priceAmount === '0' ? (
          <Badge tone="ok" outline>
            {t('web.service_locations_free')}
          </Badge>
        ) : (
          <Money value={{ amountMinor: row.priceAmount, currency: row.priceCurrency }} />
        ),
    },
    {
      key: 'limits',
      header: t('web.service_locations_limits'),
      wrap: true,
      render: (row) => <span className="muted small">{limitsText(row)}</span>,
    },
    {
      key: 'state',
      header: t('web.service_locations_state'),
      render: (row) => (
        <Badge tone={row.enabled ? 'ok' : 'neutral'} dot>
          {t(row.enabled ? 'web.service_locations_target_on' : 'web.service_locations_target_off')}
        </Badge>
      ),
    },
    {
      key: 'updated',
      header: t('web.service_locations_updated'),
      render: (row) => <span className="muted small">{formatTimestamp(row.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: t('web.service_locations_actions'),
      align: 'end',
      render: (row) =>
        !mayEdit ? null : (
          <RowActions>
            <Button
              size="sm"
              variant="ghost"
              icon="edit"
              disabled={busy}
              onClick={() =>
                discard.confirmDiscard(() => {
                  setEditing(row.id);
                  setForm(formOf(row));
                  revealField('sl-panel');
                })
              }
            >
              {t('web.service_locations_edit')}
            </Button>
            <IconButton
              size="sm"
              icon="trash"
              variant="danger"
              className="ghost"
              label={t('web.service_locations_delete')}
              disabled={busy}
              onClick={() => setDeleting(row)}
            />
          </RowActions>
        ),
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.service_locations_title')}
        subtitle={t('web.service_locations_subtitle')}
        {...(mayEdit
          ? {
              actions: (
                <Button
                  variant="primary"
                  icon="plus"
                  onClick={() =>
                    discard.confirmDiscard(() => {
                      reset();
                      revealField('sl-panel');
                    })
                  }
                >
                  {t('web.cb_add')}
                </Button>
              ),
            }
          : {})}
      />

      {CAPABLE_PROVIDERS.length === 0 ? (
        <Banner tone="warn">{t('web.service_locations_no_capable_panel')}</Banner>
      ) : (
        <Banner tone="info">
          {t('web.service_locations_capable_panels').replace(
            '{providers}',
            CAPABLE_PROVIDERS.map((one) => one.canonicalName).join(', '),
          )}
        </Banner>
      )}

      <div className="stack">
        <StateSwitch
          query={locations}
          denied={denied}
          isEmpty={queryState(locations) === 'ready' && rows.length === 0}
          empty={
            <Card>
              <Empty
                title={t('web.service_locations_empty')}
                hint={t('web.service_locations_empty_hint')}
                icon="globe"
              />
            </Card>
          }
        >
          <Card title={t('web.service_locations_list')}>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              caption={t('web.service_locations_list')}
              dense
            />
          </Card>
        </StateSwitch>

        {mayEdit && (
          <Card
            title={t(
              editing === null ? 'web.service_locations_new' : 'web.service_locations_editing',
            )}
            hint={t('web.service_locations_form_hint')}
            tight
            foot={
              <SaveBar dirty={dirty}>
                {editing !== null && (
                  <Button size="sm" disabled={busy} onClick={reset}>
                    {t('web.service_locations_cancel_edit')}
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  icon="check"
                  disabled={busy || !formValid}
                  onClick={() => save.mutate()}
                >
                  {t('web.service_locations_save')}
                </Button>
              </SaveBar>
            }
          >
            <FormSection id="sl-section-where" title={t('web.cb_section_where')}>
              <Field
                label={t('web.service_locations_panel')}
                htmlFor="sl-panel"
                {...(panelList ? {} : { hint: t('web.service_locations_panel_id_hint') })}
              >
                {!panelList ? (
                  <input
                    id="sl-panel"
                    dir="ltr"
                    value={form.panelId}
                    onChange={(event) => setForm({ ...form, panelId: event.target.value.trim() })}
                  />
                ) : (
                  <select
                    id="sl-panel"
                    value={form.panelId}
                    onChange={(event) =>
                      // A product scope names a product of THIS panel; another panel's is cleared.
                      setForm({
                        ...form,
                        panelId: event.target.value,
                        productId:
                          products.data?.find((one) => one.id === form.productId)?.panelId ===
                          event.target.value
                            ? form.productId
                            : '',
                      })
                    }
                  >
                    <option value="" disabled>
                      —
                    </option>
                    {(panels.data ?? []).map((one) => (
                      <option key={one.id} value={one.id}>
                        {one.capabilities.includes('LOCATION_CHANGE')
                          ? one.name
                          : `${one.name} — ${t('web.service_locations_panel_unsupported')}`}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field
                label={t('web.service_locations_label')}
                hint={t('web.service_locations_label_hint')}
                htmlFor="sl-label"
              >
                <input
                  id="sl-label"
                  value={form.label}
                  maxLength={SERVICE_LOCATION_LABEL_MAX_LENGTH}
                  onChange={(event) => setForm({ ...form, label: event.target.value })}
                />
              </Field>
              <Field
                label={t('web.service_locations_key')}
                hint={t('web.service_locations_key_hint')}
                htmlFor="sl-key"
              >
                <input
                  id="sl-key"
                  dir="ltr"
                  value={form.locationKey}
                  maxLength={SERVICE_LOCATION_KEY_MAX_LENGTH}
                  onChange={(event) => setForm({ ...form, locationKey: event.target.value })}
                />
              </Field>
              <Field
                label={t('web.service_locations_product')}
                hint={t(
                  productList
                    ? 'web.service_locations_product_hint'
                    : 'web.service_locations_product_id_hint',
                )}
                htmlFor="sl-product"
              >
                {!productList ? (
                  <input
                    id="sl-product"
                    dir="ltr"
                    placeholder={t('web.service_locations_all_products')}
                    value={form.productId}
                    onChange={(event) => setForm({ ...form, productId: event.target.value.trim() })}
                  />
                ) : (
                  <select
                    id="sl-product"
                    value={form.productId}
                    onChange={(event) => setForm({ ...form, productId: event.target.value })}
                  >
                    <option value="">{t('web.service_locations_all_products')}</option>
                    {/* Only this panel's products: a scope elsewhere could never apply here. */}
                    {(products.data ?? [])
                      .filter((one) => one.panelId === form.panelId)
                      .map((one) => (
                        <option key={one.id} value={one.id}>
                          {one.title}
                        </option>
                      ))}
                  </select>
                )}
              </Field>
            </FormSection>

            <FormSection id="sl-section-offer" title={t('web.cb_section_offer')}>
              <CheckField
                id="sl-initial"
                label={t('web.service_locations_initial')}
                hint={t('web.service_locations_initial_hint')}
                checked={form.initial}
                onChange={(next) => setForm({ ...form, initial: next })}
              />
              <CheckField
                id="sl-enabled"
                label={t('web.service_locations_enabled')}
                checked={form.enabled}
                onChange={(next) => setForm({ ...form, enabled: next })}
              />
              <Field
                label={t('web.service_locations_price')}
                hint={t('web.service_locations_price_hint')}
                htmlFor="sl-price"
              >
                <input
                  id="sl-price"
                  dir="ltr"
                  inputMode="numeric"
                  value={form.priceAmount}
                  onChange={(event) => setForm({ ...form, priceAmount: event.target.value.trim() })}
                />
              </Field>
              <Field label={t('web.service_locations_currency')} htmlFor="sl-currency">
                <select
                  id="sl-currency"
                  value={form.priceCurrency}
                  onChange={(event) =>
                    setForm({ ...form, priceCurrency: event.target.value as SalesCurrencyCode })
                  }
                >
                  {SALES_CURRENCY_CODES.map((code) => (
                    <option key={code} value={code}>
                      {t(CURRENCY_LABEL[code])}
                    </option>
                  ))}
                </select>
              </Field>
            </FormSection>

            <FormSection id="sl-section-limits" title={t('web.service_locations_limits')}>
              <Field
                label={t('web.service_locations_cooldown')}
                hint={t('web.service_locations_cooldown_hint')}
                htmlFor="sl-cooldown"
              >
                <input
                  id="sl-cooldown"
                  dir="ltr"
                  inputMode="numeric"
                  value={form.cooldownHours}
                  onChange={(event) =>
                    setForm({ ...form, cooldownHours: event.target.value.trim() })
                  }
                />
              </Field>
              <Field
                label={t('web.service_locations_max_changes')}
                hint={t('web.service_locations_limit_hint')}
                htmlFor="sl-max"
              >
                <input
                  id="sl-max"
                  dir="ltr"
                  inputMode="numeric"
                  value={form.maxChanges}
                  onChange={(event) => setForm({ ...form, maxChanges: event.target.value.trim() })}
                />
              </Field>
              <Field
                label={t('web.service_locations_period_days')}
                htmlFor="sl-period"
                {...(limitsValid ? {} : { error: t('web.service_locations_limit_pair') })}
              >
                <input
                  id="sl-period"
                  dir="ltr"
                  inputMode="numeric"
                  value={form.periodDays}
                  onChange={(event) => setForm({ ...form, periodDays: event.target.value.trim() })}
                />
              </Field>
              <Field label={t('web.service_locations_sort')} htmlFor="sl-sort">
                <input
                  id="sl-sort"
                  dir="ltr"
                  inputMode="numeric"
                  value={form.sortOrder}
                  onChange={(event) => setForm({ ...form, sortOrder: event.target.value.trim() })}
                />
              </Field>
            </FormSection>

            {(panels.isError || products.isError || failure != null) && (
              <div className="cb-form-error stack-sm">
                {(panels.isError || products.isError) && (
                  <Banner tone="danger">{t('web.extra_devices_scope_unavailable')}</Banner>
                )}
                {failure != null && <Banner tone="danger">{failureText(failure)}</Banner>}
              </div>
            )}
          </Card>
        )}
      </div>

      {deleting !== null && (
        <ConfirmDialog
          title={deleting.label}
          question={t('web.service_locations_delete_confirm')}
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
      {discard.dialog}
    </>
  );
}
