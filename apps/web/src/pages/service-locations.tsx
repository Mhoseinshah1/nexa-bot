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
  Card,
  DataTable,
  Empty,
  Field,
  Money,
  PageHead,
  StateSwitch,
  useToast,
  type Column,
} from '../ui/kit';

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

export function ServiceLocationsPage({ denied, mayEdit }: { denied: boolean; mayEdit: boolean }) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();

  const locations = useQuery({
    queryKey: ['service-locations'],
    queryFn: fetchServiceLocations,
    enabled: !denied,
  });
  /*
   * The two pickers. Each is a courtesy: a role without `panels.view` sees ids rather than
   * names, and the server checks the chosen id against this tenant either way.
   */
  const panels = useQuery({
    queryKey: ['panels', 'service-locations'],
    queryFn: () =>
      everyPage(async (cursor) => {
        const page = await fetchPanels({ limit: 100, ...(cursor === null ? {} : { cursor }) });
        return { items: page.panels, nextCursor: page.nextCursor };
      }),
    enabled: !denied,
    retry: false,
  });
  const products = useQuery({
    queryKey: ['products', 'service-locations'],
    queryFn: () =>
      everyPage(async (cursor) => {
        const page = await fetchProducts({ limit: 100, ...(cursor === null ? {} : { cursor }) });
        return { items: page.products, nextCursor: page.nextCursor };
      }),
    enabled: !denied,
    retry: false,
  });

  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const rows = locations.data?.locations ?? [];

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
      key: 'panel',
      header: t('web.service_locations_panel'),
      render: (row) => panelName(row.panelId),
    },
    {
      key: 'label',
      header: t('web.service_locations_label'),
      render: (row) => (
        <>
          {row.label}{' '}
          {row.initial && <Badge tone="info">{t('web.service_locations_initial_badge')}</Badge>}
        </>
      ),
    },
    {
      key: 'key',
      header: t('web.service_locations_key'),
      render: (row) => (
        <span dir="ltr" className="mono small">
          {row.locationKey}
        </span>
      ),
    },
    {
      key: 'product',
      header: t('web.service_locations_product'),
      render: (row) => productName(row.productId),
    },
    {
      key: 'price',
      header: t('web.service_locations_price'),
      render: (row) =>
        row.priceAmount === null || row.priceCurrency === null ? (
          t('web.service_locations_unpriced')
        ) : row.priceAmount === '0' ? (
          t('web.service_locations_free')
        ) : (
          <Money value={{ amountMinor: row.priceAmount, currency: row.priceCurrency }} />
        ),
    },
    { key: 'limits', header: t('web.service_locations_limits'), render: limitsText },
    {
      key: 'state',
      header: t('web.service_locations_state'),
      render: (row) => (
        <Badge tone={row.enabled ? 'ok' : 'neutral'}>
          {t(row.enabled ? 'web.service_locations_target_on' : 'web.service_locations_target_off')}
        </Badge>
      ),
    },
    {
      key: 'updated',
      header: t('web.service_locations_updated'),
      render: (row) => formatTimestamp(row.updatedAt),
    },
    {
      key: 'actions',
      header: t('web.service_locations_actions'),
      align: 'end',
      render: (row) =>
        !mayEdit ? null : (
          <div className="toolbar">
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => {
                setEditing(row.id);
                setForm(formOf(row));
              }}
            >
              {t('web.service_locations_edit')}
            </button>
            <button
              type="button"
              className="btn sm danger"
              disabled={busy}
              onClick={() => remove.mutate(row.id)}
            >
              {t('web.service_locations_delete')}
            </button>
          </div>
        ),
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.service_locations_title')}
        subtitle={t('web.service_locations_subtitle')}
        maturity="now"
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

      <StateSwitch
        query={locations}
        denied={denied}
        isEmpty={queryState(locations) === 'ready' && rows.length === 0}
        empty={
          <Empty
            title={t('web.service_locations_empty')}
            hint={t('web.service_locations_empty_hint')}
          />
        }
      >
        <Card title={t('web.service_locations_list')}>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={t('web.service_locations_list')}
          />
        </Card>
      </StateSwitch>

      {mayEdit && (
        <Card
          title={t(
            editing === null ? 'web.service_locations_new' : 'web.service_locations_editing',
          )}
          hint={t('web.service_locations_form_hint')}
        >
          <Field label={t('web.service_locations_panel')} htmlFor="sl-panel">
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
            hint={t('web.service_locations_product_hint')}
            htmlFor="sl-product"
          >
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
          </Field>
          <Field
            label={t('web.service_locations_initial')}
            hint={t('web.service_locations_initial_hint')}
            htmlFor="sl-initial"
          >
            <input
              id="sl-initial"
              type="checkbox"
              checked={form.initial}
              onChange={(event) => setForm({ ...form, initial: event.target.checked })}
            />
          </Field>
          <Field label={t('web.service_locations_enabled')} htmlFor="sl-enabled">
            <input
              id="sl-enabled"
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
          </Field>
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
              onChange={(event) => setForm({ ...form, cooldownHours: event.target.value.trim() })}
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
          <Field label={t('web.service_locations_period_days')} htmlFor="sl-period">
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

          {(panels.isError || products.isError) && (
            <Banner tone="danger">{t('web.extra_devices_scope_unavailable')}</Banner>
          )}
          {!limitsValid && <Banner tone="warn">{t('web.service_locations_limit_pair')}</Banner>}

          <div className="toolbar">
            <button
              type="button"
              className="btn primary sm"
              disabled={busy || !formValid}
              onClick={() => save.mutate()}
            >
              {t('web.service_locations_save')}
            </button>
            {editing !== null && (
              <button type="button" className="btn sm" disabled={busy} onClick={reset}>
                {t('web.service_locations_cancel_edit')}
              </button>
            )}
          </div>
          {failure != null && <Banner tone="danger">{failureText(failure)}</Banner>}
        </Card>
      )}
    </>
  );
}
