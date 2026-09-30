import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEVICE_ADDON_MAX_QUANTITY,
  PROVIDER_DESCRIPTORS,
  SALES_CURRENCY_CODES,
  type CurrencyCode,
  type SalesCurrencyCode,
  type ServiceAddonSummaryResponse,
} from '@nexa/contracts';
import {
  createServiceAddon,
  fetchPanels,
  fetchProducts,
  fetchServiceAddons,
  setServiceAddonActive,
  updateServiceAddon,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Button,
  Card,
  CursorPager,
  DataTable,
  Empty,
  Field,
  Money,
  PageHead,
  RowActions,
  StateSwitch,
  useToast,
  useUnsavedChanges,
  type Column,
} from '../ui/kit';
import { SaveBar, revealField } from './editor-layout';

/**
 * Extra users / devices (WP-A5) — the per-user rate a customer is charged for more
 * users on a service they already own.
 *
 * It is an `ADD_DEVICES` service add-on and nothing else: the same table, the same four
 * writes and the same `catalog.view` / `catalog.edit` pair as every other add-on. No
 * parallel price list. What this screen adds is the three things that kind has and the
 * packages do not — a price PER user, a maximum a service may be sold in total, and an
 * optional panel / product scope — in words an operator reads rather than column names.
 *
 * **The customer sees the button only where the panel can really do it.** Which provider
 * types can raise a live account's limit is read from the adapters' own declared
 * capabilities (`PROVIDER_DESCRIPTORS`), never configured here, and the banner says so:
 * a rate saved for a panel that cannot apply it is sold to nobody, which is correct.
 */

const CURRENCY_LABEL: Readonly<Record<SalesCurrencyCode, WebKey>> = {
  IRT: 'web.currency_irt',
  IRR: 'web.currency_irr',
};

/** The provider types whose adapter declares the capability — none, in this release. */
const CAPABLE_PROVIDERS = PROVIDER_DESCRIPTORS.filter((descriptor) =>
  descriptor.capabilities.includes('DEVICE_LIMIT_ADJUSTMENT'),
);

/**
 * Every page of a keyset list, for the two scope pickers: a panel or product past the
 * first page must still be choosable, so this reads until the server says there is no
 * next page — never a page count, which silently truncated the choices (Codex review #2
 * on PR #97). A cursor the server has already handed back would loop for ever, so it is
 * an error the picker shows, never a partial list presented as whole.
 */
export async function everyPage<T>(
  page: (cursor: string | null) => Promise<{ items: readonly T[]; nextCursor: string | null }>,
): Promise<readonly T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const next = await page(cursor);
    items.push(...next.items);
    if (next.nextCursor === null) return items;
    if (seen.has(next.nextCursor)) {
      throw new Error('the list returned a page cursor it had already returned');
    }
    seen.add(next.nextCursor);
    cursor = next.nextCursor;
  }
}

/** One page of rates. The list pages by the server's keyset cursor, never by a cap. */
const RATE_PAGE_SIZE = 50;

const EMPTY_FORM = {
  title: '',
  priceAmount: '',
  priceCurrency: 'IRT' as SalesCurrencyCode,
  maxQuantity: '1',
  panelId: '',
  productId: '',
  sortOrder: '0',
};

type FormState = typeof EMPTY_FORM;

function formOf(row: ServiceAddonSummaryResponse): FormState {
  return {
    title: row.title,
    priceAmount: row.priceAmount ?? '',
    priceCurrency: (row.priceCurrency as SalesCurrencyCode | null) ?? 'IRT',
    maxQuantity: String(row.maxQuantity ?? 1),
    panelId: row.panelId ?? '',
    productId: row.productId ?? '',
    sortOrder: String(row.sortOrder),
  };
}

/** A whole number in `[1, DEVICE_ADDON_MAX_QUANTITY]`, or null. The server decides again. */
function quantityOf(raw: string): number | null {
  if (!/^\d{1,2}$/u.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= 1 && value <= DEVICE_ADDON_MAX_QUANTITY ? value : null;
}

export function ExtraDevicesPage({
  denied,
  mayEdit,
  mayViewPanels = false,
}: {
  denied: boolean;
  mayEdit: boolean;
  /** `panels.view`: what the panel list the scope labels come from requires. */
  mayViewPanels?: boolean;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();

  /*
   * A keyset page at a time, walked with the server's own cursor — never "the first
   * hundred", which left the hundred-and-first rate creatable and then unreachable
   * (Codex review #1 on PR #97, C2). `trail` is the cursors of the pages behind this one,
   * so the way back is exact; the list is `created_at, id` ascending, so the next page is
   * NEWER, and the pager says so.
   */
  const [trail, setTrail] = useState<readonly (string | null)[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const rates = useQuery({
    queryKey: ['service-addons', 'ADD_DEVICES', cursor],
    queryFn: () =>
      fetchServiceAddons({
        kind: 'ADD_DEVICES',
        limit: RATE_PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
      }),
    enabled: !denied,
  });
  /*
   * The two scope pickers, and the NAMES a scoped rate is listed with. Each list is read
   * under the permission its own endpoint charges — `panels.view`, and the `catalog.view`
   * this page already needs — never under edit access: gating them on `catalog.edit` left
   * a view-only role reading raw ids in the scope column (Codex #2 on PR #102). The server
   * checks a chosen id against this tenant either way.
   */
  const panels = useQuery({
    queryKey: ['panels', 'extra-devices-scope'],
    queryFn: () =>
      everyPage(async (cursor) => {
        const page = await fetchPanels({ limit: 100, ...(cursor === null ? {} : { cursor }) });
        return { items: page.panels, nextCursor: page.nextCursor };
      }),
    enabled: !denied && mayViewPanels,
    retry: false,
  });
  const products = useQuery({
    queryKey: ['products', 'extra-devices-scope'],
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
  const rows = rates.data?.addons ?? [];
  const editedRow = editing === null ? undefined : rows.find((row) => row.id === editing);
  const dirty =
    JSON.stringify(form) !==
    JSON.stringify(editedRow === undefined ? EMPTY_FORM : formOf(editedRow));
  useUnsavedChanges(dirty);

  const panelName = (id: string | null): string =>
    id === null
      ? t('web.extra_devices_scope_all_panels')
      : (panels.data?.find((one) => one.id === id)?.name ?? id);
  const productName = (id: string | null): string =>
    id === null
      ? t('web.extra_devices_scope_all_products')
      : (products.data?.find((one) => one.id === id)?.title ?? id);

  const reset = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
  };
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['service-addons'] });
  };

  const maxQuantity = quantityOf(form.maxQuantity);
  const price = form.priceAmount.trim();
  const priceValid = /^\d{1,19}$/u.test(price) && BigInt(price) > 0n;

  const save = useMutation({
    mutationFn: () => {
      const fields = {
        kind: 'ADD_DEVICES' as const,
        title: form.title.trim(),
        sortOrder: Number(form.sortOrder) || 0,
        trafficGb: null,
        durationDays: null,
        maxQuantity,
        panelId: form.panelId === '' ? null : form.panelId,
        productId: form.productId === '' ? null : form.productId,
        priceAmount: price,
        priceCurrency: form.priceCurrency as CurrencyCode,
      };
      const idempotencyKey = submission.current({ editing, ...fields });
      return editing === null
        ? createServiceAddon({ ...fields, idempotencyKey })
        : updateServiceAddon({ ...fields, idempotencyKey, id: editing });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.extra_devices_saved') });
      reset();
      refresh();
    },
    onError: (error) => submission.settleOn(error),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; active: boolean }) =>
      setServiceAddonActive({
        ...input,
        idempotencyKey: submission.current({ toggle: input.id, active: input.active }),
      }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.extra_devices_saved') });
      refresh();
    },
    onError: (error) => submission.settleOn(error),
  });

  const busy = save.isPending || toggle.isPending;
  const failure = save.error ?? toggle.error;

  const columns: readonly Column<ServiceAddonSummaryResponse>[] = [
    {
      key: 'title',
      header: t('web.extra_devices_rate_title'),
      render: (row) => <span className="strong">{row.title}</span>,
    },
    {
      key: 'price',
      header: t('web.extra_devices_unit_price'),
      render: (row) =>
        row.priceAmount === null || row.priceCurrency === null ? (
          <span className="faint">{t('web.extra_devices_unpriced')}</span>
        ) : (
          <Money value={{ amountMinor: row.priceAmount, currency: row.priceCurrency }} />
        ),
    },
    {
      key: 'max',
      header: t('web.extra_devices_max_quantity'),
      align: 'end',
      render: (row) => <span className="num">{String(row.maxQuantity ?? '—')}</span>,
    },
    {
      key: 'scope',
      header: t('web.extra_devices_scope'),
      render: (row) => (
        <span className="muted">{`${panelName(row.panelId)} / ${productName(row.productId)}`}</span>
      ),
    },
    {
      key: 'state',
      header: t('web.extra_devices_state'),
      render: (row) => (
        <Badge tone={row.status === 'ACTIVE' ? 'ok' : 'neutral'} dot>
          {t(row.status === 'ACTIVE' ? 'web.extra_devices_active' : 'web.extra_devices_inactive')}
        </Badge>
      ),
    },
    {
      key: 'updated',
      header: t('web.extra_devices_updated'),
      render: (row) => <span className="muted small">{formatTimestamp(row.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: t('web.extra_devices_actions'),
      align: 'end',
      render: (row) =>
        !mayEdit ? null : (
          <RowActions>
            <Button
              size="sm"
              variant="ghost"
              icon="edit"
              disabled={busy}
              onClick={() => {
                setEditing(row.id);
                setForm(formOf(row));
                revealField('xd-title');
              }}
            >
              {t('web.extra_devices_edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => toggle.mutate({ id: row.id, active: row.status !== 'ACTIVE' })}
            >
              {t(
                row.status === 'ACTIVE' ? 'web.extra_devices_disable' : 'web.extra_devices_enable',
              )}
            </Button>
          </RowActions>
        ),
    },
  ];

  const quantityHint = t('web.extra_devices_max_quantity_hint').replace(
    '{max}',
    String(DEVICE_ADDON_MAX_QUANTITY),
  );

  return (
    <>
      <PageHead
        title={t('web.extra_devices_title')}
        subtitle={t('web.extra_devices_subtitle')}
        maturity="now"
        {...(mayEdit
          ? {
              actions: (
                <Button
                  variant="primary"
                  icon="plus"
                  onClick={() => {
                    reset();
                    revealField('xd-title');
                  }}
                >
                  {t('web.cb_add')}
                </Button>
              ),
            }
          : {})}
      />

      {CAPABLE_PROVIDERS.length === 0 ? (
        <Banner tone="warn">{t('web.extra_devices_no_capable_panel')}</Banner>
      ) : (
        <Banner tone="info">
          {t('web.extra_devices_capable_panels').replace(
            '{providers}',
            CAPABLE_PROVIDERS.map((one) => one.canonicalName).join(', '),
          )}
        </Banner>
      )}

      <div className="stack">
        <StateSwitch
          query={rates}
          denied={denied}
          isEmpty={queryState(rates) === 'ready' && rows.length === 0}
          empty={
            <Card>
              <Empty
                title={t('web.extra_devices_empty')}
                hint={t('web.extra_devices_empty_hint')}
                icon="userPlus"
              />
            </Card>
          }
        >
          <Card title={t('web.extra_devices_rates')}>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              caption={t('web.extra_devices_rates')}
              dense
            />
            <CursorPager
              shown={rows.length}
              hasPrevious={trail.length > 0}
              hasNext={(rates.data?.nextCursor ?? null) !== null}
              onPrevious={() => {
                setCursor(trail[trail.length - 1] ?? null);
                setTrail(trail.slice(0, -1));
              }}
              onNext={() => {
                const next = rates.data?.nextCursor ?? null;
                if (next === null) return;
                setTrail([...trail, cursor]);
                setCursor(next);
              }}
              nextLabel="web.newer"
              previousLabel="web.older"
            />
          </Card>
        </StateSwitch>

        {mayEdit && (
          <Card
            title={t(editing === null ? 'web.extra_devices_new' : 'web.extra_devices_editing')}
            hint={t('web.extra_devices_form_hint')}
            foot={
              <SaveBar dirty={dirty}>
                {editing !== null && (
                  <Button size="sm" disabled={busy} onClick={reset}>
                    {t('web.extra_devices_cancel_edit')}
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  icon="check"
                  disabled={busy || form.title.trim() === '' || !priceValid || maxQuantity === null}
                  onClick={() => save.mutate()}
                >
                  {t('web.extra_devices_save')}
                </Button>
              </SaveBar>
            }
          >
            <div className="form-grid c3">
              <Field label={t('web.extra_devices_rate_title')} htmlFor="xd-title">
                <input
                  id="xd-title"
                  value={form.title}
                  maxLength={120}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                />
              </Field>
              <Field
                label={t('web.extra_devices_unit_price')}
                hint={t('web.extra_devices_unit_price_hint')}
                htmlFor="xd-price"
              >
                <input
                  id="xd-price"
                  dir="ltr"
                  inputMode="numeric"
                  value={form.priceAmount}
                  onChange={(event) => setForm({ ...form, priceAmount: event.target.value.trim() })}
                />
              </Field>
              <Field label={t('web.extra_devices_currency')} htmlFor="xd-currency">
                <select
                  id="xd-currency"
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
                label={t('web.extra_devices_max_quantity')}
                {...(maxQuantity === null ? { error: quantityHint } : { hint: quantityHint })}
                htmlFor="xd-max"
              >
                <input
                  id="xd-max"
                  dir="ltr"
                  inputMode="numeric"
                  value={form.maxQuantity}
                  onChange={(event) => setForm({ ...form, maxQuantity: event.target.value.trim() })}
                />
              </Field>
              <Field
                label={t('web.extra_devices_scope_panel')}
                hint={t('web.extra_devices_scope_hint')}
                htmlFor="xd-panel"
              >
                <select
                  id="xd-panel"
                  value={form.panelId}
                  onChange={(event) => setForm({ ...form, panelId: event.target.value })}
                >
                  <option value="">{t('web.extra_devices_scope_all_panels')}</option>
                  {(panels.data ?? []).map((one) => (
                    <option key={one.id} value={one.id}>
                      {one.capabilities.includes('DEVICE_LIMIT_ADJUSTMENT')
                        ? one.name
                        : `${one.name} — ${t('web.extra_devices_panel_unsupported')}`}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('web.extra_devices_scope_product')} htmlFor="xd-product">
                <select
                  id="xd-product"
                  value={form.productId}
                  onChange={(event) => setForm({ ...form, productId: event.target.value })}
                >
                  <option value="">{t('web.extra_devices_scope_all_products')}</option>
                  {(products.data ?? []).map((one) => (
                    <option key={one.id} value={one.id}>
                      {one.title}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('web.extra_devices_sort')} htmlFor="xd-sort">
                <input
                  id="xd-sort"
                  dir="ltr"
                  inputMode="numeric"
                  value={form.sortOrder}
                  onChange={(event) => setForm({ ...form, sortOrder: event.target.value.trim() })}
                />
              </Field>
            </div>

            {(panels.isError || products.isError) && (
              <Banner tone="danger">{t('web.extra_devices_scope_unavailable')}</Banner>
            )}
            {failure != null && <Banner tone="danger">{messageFor(failure)}</Banner>}
          </Card>
        )}
      </div>
    </>
  );
}
