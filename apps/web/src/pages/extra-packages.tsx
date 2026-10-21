import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MAX_DURATION_DAYS,
  MAX_TRAFFIC_BYTES,
  PRODUCT_SORT_MAX,
  SALES_CURRENCY_CODES,
  TRAFFIC_GB_PATTERN,
  formatTrafficGb,
  parseTrafficGb,
  type CurrencyCode,
  type SalesCurrencyCode,
  type ServiceAddonSummaryResponse,
} from '@nexa/contracts';
import {
  createServiceAddon,
  fetchServiceAddons,
  setServiceAddonActive,
  updateServiceAddon,
} from '../api/client';
import { formatNumber, formatTimestampNumeric, formatTrafficGbText } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import type { Route } from '../router';
import { useSubmissionKey } from '../submission-key';
import { keepPageWhileTurning } from '../ui/paging';
import { Drawer } from '../ui/overlays';
import { useConfirmedClose } from '../ui/unsaved';
import { queryState } from '../view-state';
import {
  Badge,
  Banner,
  Button,
  Card,
  CursorPager,
  DataTable,
  Empty,
  Field,
  LIST_PAGE_SIZE,
  Money,
  Num,
  PageHead,
  RowActions,
  StateSwitch,
  ToggleRow,
  TabPanel,
  Tabs,
  useDiscardGuard,
  useQueryTab,
  useToast,
  useUnsavedChanges,
  type Column,
} from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';
import { ExtraDevicesPage } from './extra-devices';
import { SaveBar } from './editor-layout';
import { messageFor } from './settings';

/**
 * «حجم، زمان و کاربر اضافه» (Round 4 B6) — the three things a customer can add to a service
 * they already own, each a service ADD-ON sold at a price the owner types by hand:
 *
 * - **حجم** (`ADD_TRAFFIC`): a package of GB;
 * - **زمان** (`ADD_TIME`): a package of days;
 * - **کاربر** (`ADD_DEVICES`): the per-user rate and its cap, the page this one grew out of
 *   (`extra-devices.tsx`, embedded unchanged as the third tab).
 *
 * All three are the same `/service-addons` rows under the same `catalog.view` / `catalog.edit`
 * pair; the bot's `v:` / `h:` callbacks read these rows. No price is imported from the old bot.
 *
 * Panel / product SCOPE and a maximum quantity exist only on the user rate: the contract
 * refuses them on a package (`serviceAddonWriteSchema`), so a package is offered for every
 * panel and product and is bought one package at a time. The package tabs say so.
 */

export const EXTRA_PACKAGE_TABS = ['traffic', 'time', 'devices'] as const;
export type ExtraPackageTab = (typeof EXTRA_PACKAGE_TABS)[number];

type PackageKind = 'ADD_TRAFFIC' | 'ADD_TIME';

const CURRENCY_LABEL: Readonly<Record<SalesCurrencyCode, WebKey>> = {
  IRT: 'web.currency_irt',
  IRR: 'web.currency_irr',
};

const EMPTY_FORM = {
  title: '',
  amount: '',
  priceAmount: '',
  priceCurrency: 'IRT' as SalesCurrencyCode,
  sortOrder: '0',
  // Create only: a new package is offered to customers at once unless the operator says not.
  active: true,
};
type FormState = typeof EMPTY_FORM;

function formOf(row: ServiceAddonSummaryResponse): FormState {
  return {
    title: row.title,
    amount:
      row.trafficBytes !== null
        ? formatTrafficGb(BigInt(row.trafficBytes))
        : String(row.durationDays ?? ''),
    priceAmount: row.priceAmount ?? '',
    priceCurrency: (row.priceCurrency as SalesCurrencyCode | null) ?? 'IRT',
    sortOrder: String(row.sortOrder),
    active: row.status === 'ACTIVE',
  };
}

/**
 * The typed amount, validated the way the server does: GB with at most two decimals, above
 * zero and no larger than `MAX_TRAFFIC_BYTES` (`serviceAddonWriteSchema`'s ceiling).
 */
export function trafficAmountOf(raw: string): string | null {
  const text = raw.trim();
  if (!TRAFFIC_GB_PATTERN.test(text)) return null;
  const bytes = parseTrafficGb(text);
  if (bytes === null || bytes <= 0n || bytes > MAX_TRAFFIC_BYTES) return null;
  return text;
}

/** Whole days in `[1, MAX_DURATION_DAYS]`, or null. */
export function daysAmountOf(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,5}$/u.test(text)) return null;
  const value = Number(text);
  return value >= 1 && value <= MAX_DURATION_DAYS ? value : null;
}

export function ExtraPackagesPage({
  route,
  denied,
  mayEdit,
  mayViewPanels = false,
}: {
  route: Route;
  denied: boolean;
  mayEdit: boolean;
  mayViewPanels?: boolean;
}) {
  const [tab, setTab] = useQueryTab<ExtraPackageTab>(route, EXTRA_PACKAGE_TABS, 'tab');
  return (
    <>
      {tab !== 'devices' && (
        <PageHead
          title={t('web.extra_packages_title')}
          subtitle={t('web.extra_packages_subtitle')}
        />
      )}
      {tab === 'devices' && (
        <PageHead
          title={t('web.extra_packages_title')}
          subtitle={t('web.extra_devices_subtitle')}
        />
      )}
      {(!denied || mayEdit) && (
        <Tabs
          value={tab}
          onChange={setTab}
          panelId="extra-packages"
          items={[
            { id: 'traffic', label: t('web.extra_packages_tab_traffic') },
            { id: 'time', label: t('web.extra_packages_tab_time') },
            { id: 'devices', label: t('web.extra_packages_tab_devices') },
          ]}
        />
      )}
      <TabPanel id="extra-packages" labelledBy={`extra-packages-tab-${tab}`}>
        {tab === 'traffic' && (
          <PackageSection kind="ADD_TRAFFIC" denied={denied} mayEdit={mayEdit} />
        )}
        {tab === 'time' && <PackageSection kind="ADD_TIME" denied={denied} mayEdit={mayEdit} />}
        {tab === 'devices' && (
          <ExtraDevicesPage
            embedded
            denied={denied}
            mayEdit={mayEdit}
            mayViewPanels={mayViewPanels}
          />
        )}
      </TabPanel>
    </>
  );
}

function PackageSection({
  kind,
  denied,
  mayEdit,
}: {
  kind: PackageKind;
  denied: boolean;
  mayEdit: boolean;
}) {
  const traffic = kind === 'ADD_TRAFFIC';
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();

  // A keyset page at a time, walked with the server's own cursor (oldest first).
  const [trail, setTrail] = useState<readonly (string | null)[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const list = useQuery(
    keepPageWhileTurning({
      queryKey: ['service-addons', kind, cursor],
      queryFn: () =>
        fetchServiceAddons({
          kind,
          limit: LIST_PAGE_SIZE,
          ...(cursor === null ? {} : { cursor }),
        }),
      enabled: !denied,
    }),
  );

  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [open, setOpen] = useState(false);
  const rows = list.data?.addons ?? [];
  const editedRow = editing === null ? undefined : rows.find((row) => row.id === editing);
  const dirty =
    JSON.stringify(form) !==
    JSON.stringify(editedRow === undefined ? EMPTY_FORM : formOf(editedRow));
  useUnsavedChanges(dirty);
  const discard = useDiscardGuard(dirty);

  const reset = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
  };
  const close = () => {
    reset();
    setOpen(false);
    save.reset();
  };
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['service-addons'] });
  };

  const trafficGb = traffic ? trafficAmountOf(form.amount) : null;
  const days = traffic ? null : daysAmountOf(form.amount);
  const amountValid = traffic ? trafficGb !== null : days !== null;
  const price = form.priceAmount.trim();
  const priceValid = /^\d{1,19}$/u.test(price) && BigInt(price) > 0n;
  const sortOrder =
    /^\d{1,6}$/u.test(form.sortOrder.trim()) && Number(form.sortOrder.trim()) <= PRODUCT_SORT_MAX
      ? Number(form.sortOrder.trim())
      : null;

  const save = useMutation({
    mutationFn: () => {
      const fields = {
        kind,
        title: form.title.trim(),
        sortOrder: sortOrder ?? 0,
        trafficGb,
        durationDays: days,
        maxQuantity: null,
        panelId: null,
        productId: null,
        priceAmount: price,
        priceCurrency: form.priceCurrency as CurrencyCode,
      };
      // `active` is part of the create command, so it is part of the key's fingerprint: a retry
      // after flipping it is a different command and must not reuse the earlier key.
      const idempotencyKey = submission.current(
        editing === null ? { editing, ...fields, active: form.active } : { editing, ...fields },
      );
      return editing === null
        ? createServiceAddon({ ...fields, active: form.active, idempotencyKey })
        : updateServiceAddon({ ...fields, idempotencyKey, id: editing });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.extra_packages_saved') });
      reset();
      setOpen(false);
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
      notify({ tone: 'ok', message: t('web.extra_packages_saved') });
      refresh();
    },
    onError: (error) => submission.settleOn(error),
  });

  const busy = save.isPending || toggle.isPending;
  const { requestClose, dialog: closeDialog } = useConfirmedClose(dirty, close);

  const columns: readonly Column<ServiceAddonSummaryResponse>[] = [
    {
      key: 'title',
      header: t('web.extra_devices_rate_title'),
      render: (row) => <span className="strong">{row.title}</span>,
    },
    {
      key: 'amount',
      header: t(traffic ? 'web.extra_packages_amount_gb' : 'web.extra_packages_amount_days'),
      render: (row) =>
        traffic && row.trafficBytes !== null ? (
          <span className="nowrap">
            <Num value={formatTrafficGbText(BigInt(row.trafficBytes))} /> {t('web.unit_gib')}
          </span>
        ) : (
          <span className="nowrap">
            {formatNumber(row.durationDays ?? 0)} {t('web.unit_days')}
          </span>
        ),
    },
    {
      key: 'price',
      header: t('web.extra_packages_price'),
      render: (row) =>
        row.priceAmount === null || row.priceCurrency === null ? (
          <span className="faint">{t('web.extra_devices_unpriced')}</span>
        ) : (
          <Money value={{ amountMinor: row.priceAmount, currency: row.priceCurrency }} />
        ),
    },
    {
      key: 'sort',
      header: t('web.extra_devices_sort'),
      render: (row) => <span className="num">{formatNumber(row.sortOrder)}</span>,
    },
    {
      key: 'state',
      header: t('web.extra_devices_state'),
      render: (row) => (
        <>
          <Badge tone={row.status === 'ACTIVE' ? 'ok' : 'neutral'} dot>
            {t(row.status === 'ACTIVE' ? 'web.extra_devices_active' : 'web.extra_devices_inactive')}
          </Badge>
          {row.status !== 'ACTIVE' && (
            <p className="small">
              <Badge tone="warn">{t('web.extra_packages_inactive_warning')}</Badge>
            </p>
          )}
        </>
      ),
    },
    {
      key: 'updated',
      header: t('web.extra_devices_updated'),
      wrap: 'tight',
      render: (row) => <span className="nowrap">{formatTimestampNumeric(row.updatedAt)}</span>,
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
              onClick={() =>
                discard.confirmDiscard(() => {
                  setEditing(row.id);
                  setForm(formOf(row));
                  setOpen(true);
                })
              }
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

  const prefix = traffic ? 'pkgt' : 'pkgd';
  return (
    <>
      <div className="toolbar">
        <p className="muted small">{t('web.extra_packages_scope_note')}</p>
        {mayEdit && (
          <Button
            variant="primary"
            icon="plus"
            onClick={() =>
              discard.confirmDiscard(() => {
                reset();
                setOpen(true);
              })
            }
          >
            {t('web.cb_add')}
          </Button>
        )}
      </div>
      <div className="stack">
        <StateSwitch
          query={list}
          denied={denied}
          isEmpty={queryState(list) === 'ready' && rows.length === 0}
          empty={
            <Card>
              <Empty
                title={t(
                  traffic ? 'web.extra_packages_empty_traffic' : 'web.extra_packages_empty_time',
                )}
                hint={t('web.extra_packages_empty_hint')}
                icon="plus"
              />
            </Card>
          }
        >
          <Card
            title={t(traffic ? 'web.extra_packages_list_traffic' : 'web.extra_packages_list_time')}
          >
            <DataTable
              stack="labelled"
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              caption={t(
                traffic ? 'web.extra_packages_list_traffic' : 'web.extra_packages_list_time',
              )}
            />
            {toggle.error !== null && (
              <Banner tone="danger">
                {messageFor(toggle.error)}
                <ErrorRef error={toggle.error} />
              </Banner>
            )}
            <CursorPager
              order="oldest-first"
              shown={rows.length}
              hasPrevious={trail.length > 0}
              hasNext={(list.data?.nextCursor ?? null) !== null}
              onPrevious={() => {
                setCursor(trail[trail.length - 1] ?? null);
                setTrail(trail.slice(0, -1));
              }}
              onNext={() => {
                const next = list.data?.nextCursor ?? null;
                if (next === null) return;
                setTrail([...trail, cursor]);
                setCursor(next);
              }}
            />
          </Card>
        </StateSwitch>

        {mayEdit && (
          <Drawer
            open={open}
            onClose={requestClose}
            wide
            title={t(editing === null ? 'web.extra_packages_new' : 'web.extra_packages_editing')}
            foot={
              <SaveBar dirty={dirty}>
                {editing !== null && (
                  <Button size="sm" disabled={busy} onClick={requestClose}>
                    {t('web.extra_devices_cancel_edit')}
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  icon="check"
                  disabled={
                    busy ||
                    form.title.trim() === '' ||
                    !amountValid ||
                    !priceValid ||
                    sortOrder === null
                  }
                  onClick={() => save.mutate()}
                >
                  {t('web.extra_devices_save')}
                </Button>
              </SaveBar>
            }
          >
            <p className="muted small">{t('web.extra_packages_form_hint')}</p>
            <div className="form-grid">
              <Field label={t('web.extra_devices_rate_title')} htmlFor={`${prefix}-title`}>
                <input
                  id={`${prefix}-title`}
                  value={form.title}
                  maxLength={120}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                />
              </Field>
              <Field
                label={t(
                  traffic ? 'web.extra_packages_amount_gb' : 'web.extra_packages_amount_days',
                )}
                {...(form.amount !== '' && !amountValid
                  ? {
                      error: t(
                        traffic
                          ? 'web.extra_packages_amount_gb_hint'
                          : 'web.extra_packages_amount_days_hint',
                      ),
                    }
                  : {
                      hint: t(
                        traffic
                          ? 'web.extra_packages_amount_gb_hint'
                          : 'web.extra_packages_amount_days_hint',
                      ),
                    })}
                htmlFor={`${prefix}-amount`}
              >
                <input
                  id={`${prefix}-amount`}
                  dir="ltr"
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(event) => setForm({ ...form, amount: event.target.value.trim() })}
                />
              </Field>
              <Field
                label={t('web.extra_packages_price')}
                hint={t('web.extra_packages_price_hint')}
                htmlFor={`${prefix}-price`}
              >
                <input
                  id={`${prefix}-price`}
                  dir="ltr"
                  inputMode="numeric"
                  value={form.priceAmount}
                  onChange={(event) => setForm({ ...form, priceAmount: event.target.value.trim() })}
                />
              </Field>
              <Field label={t('web.extra_devices_currency')} htmlFor={`${prefix}-currency`}>
                <select
                  id={`${prefix}-currency`}
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
              <Field label={t('web.extra_devices_sort')} htmlFor={`${prefix}-sort`}>
                <input
                  id={`${prefix}-sort`}
                  dir="ltr"
                  inputMode="numeric"
                  value={form.sortOrder}
                  onChange={(event) => setForm({ ...form, sortOrder: event.target.value.trim() })}
                />
              </Field>
            </div>
            {editing === null && (
              <ToggleRow
                title={t('web.extra_packages_active')}
                description={t('web.extra_packages_active_hint')}
                checked={form.active}
                onChange={(next) => setForm({ ...form, active: next })}
              />
            )}
            {save.error !== null && (
              <Banner tone="danger">
                {messageFor(save.error)}
                <ErrorRef error={save.error} />
              </Banner>
            )}
          </Drawer>
        )}
      </div>
      {discard.dialog}
      {closeDialog}
    </>
  );
}
