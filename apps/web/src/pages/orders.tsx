import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ORDER_STATES,
  UNLIMITED_DURATION_DAYS,
  UNLIMITED_TRAFFIC_BYTES,
  uuidV7Schema,
  type CashbackState,
  type OrderPricingResponse,
  type OrderState,
  type OrderSummaryResponse,
  type PaymentState,
  type ServiceOperationResponse,
} from '@nexa/contracts';
import {
  fetchOrder,
  fetchOrderPricing,
  fetchOrders,
  fetchPayments,
  fetchServiceOperations,
  fetchServices,
} from '../api/client';
import { currencyLabel, formatNumber, formatTimestamp, splitBytes } from '../format';
import { mayRequest, queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { setQueries, setQuery, useLinkHandler, type Route } from '../router';
/*
 * The SERVICES page's vocabularies, borrowed rather than copied — the same rule
 * `users.tsx` follows when it borrows this page's order maps. A second
 * `FAILED: 'danger'` here would be a second answer to what a failed provisioning
 * attempt looks like, and the two would drift the first time one of them gained a
 * state.
 */
import {
  DELIVERY_LABELS as SERVICE_DELIVERY_LABELS,
  DELIVERY_TONES as SERVICE_DELIVERY_TONES,
  OPERATION_STATE_LABELS,
  OPERATION_STATE_TONES,
  OPERATION_TYPE_LABELS,
  STATE_LABELS as SERVICE_STATE_LABELS,
  STATE_TONES as SERVICE_STATE_TONES,
} from './services';
import { PRICE_LAYER_LABELS, PRICE_LAYER_STEPS } from './resellers';
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
  Money,
  Num,
  PageHead,
  Pills,
  StateSwitch,
  type Column,
  type Tone,
} from '../ui/kit';

/**
 * Orders — what a customer asked to buy, and what they were quoted for it.
 *
 * This page READS. There is no cancel, no mark-paid, no refund, no settle and no
 * fulfil, and the absence is deliberate: each is a real operator action whose meaning
 * depends on a payment record, and a button for one would be the legacy system's
 * silent-success pattern. `orders.controller.ts` has no route to call either, so this
 * is not the UI declining to offer something the server permits.
 *
 * A retry-or-reassign card lived here for one release, for an order that was paid and
 * undelivered. There is no such order any more: one that cannot be delivered is
 * refunded to the customer's wallet in the transaction that discovers it, and
 * `REFUNDED` is what this page shows for it. A control that retried one would be a
 * control for a state no row can hold.
 *
 * Every `line*` field is the SNAPSHOT taken when the order was made. That is the whole
 * reason this surface can be trusted: the legacy «محصول حذف‌شده» is what a screen that
 * joins on today's product row shows for anything since renamed or deleted, and a report
 * built on it rewrites its own history every time somebody edits a plan.
 *
 * All six states are reachable and the filter offers every one of them. `REFUNDED` is
 * now the ordinary end of an undeliverable purchase rather than a frozen label, so an
 * operator asking "what did we give back this week" is asking a question this page
 * answers.
 */

/*
 * Exported, because `/users/:id` draws this customer's orders and a second copy of
 * this map is a second answer to "what does REFUNDED look like". `panels.tsx` already
 * borrows the product and service maps the same way, for the same reason.
 */
export const STATE_LABELS: Readonly<Record<OrderState, WebKey>> = {
  DRAFT: 'web.order_state_draft',
  AWAITING_PAYMENT: 'web.order_state_awaiting_payment',
  PAID: 'web.order_state_paid',
  CANCELLED: 'web.order_state_cancelled',
  EXPIRED: 'web.order_state_expired',
  REFUNDED: 'web.order_state_refunded',
};

export const STATE_TONES: Readonly<Record<OrderState, Tone>> = {
  DRAFT: 'neutral',
  AWAITING_PAYMENT: 'warn',
  PAID: 'ok',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
  REFUNDED: 'violet',
};

/**
 * The prop is `value` and not `state`, deliberately.
 *
 * `state-switch-contract.test.tsx` forbids `state={` anywhere in this tree, because
 * `StateSwitch` once took a computed view state and a caller that computes one has
 * already lost the distinction between loading, denied and empty. The rule is textual,
 * which is what makes it enforceable — so this component spells its prop differently
 * rather than the guard growing an exception that would also let the real mistake back
 * in.
 */
function StateBadge({ value }: { value: OrderState }) {
  return <Badge tone={STATE_TONES[value]}>{t(STATE_LABELS[value])}</Badge>;
}

function Dash() {
  return <span className="faint">—</span>;
}

function Traffic({ bytes }: { bytes: string }) {
  const value = BigInt(bytes);
  if (value === UNLIMITED_TRAFFIC_BYTES) return <span>{t('web.product_unlimited')}</span>;
  const { value: amount, unit } = splitBytes(value);
  return (
    <span className="nowrap">
      <Ltr>{amount}</Ltr> {t(unit)}
    </span>
  );
}

function Duration({ days }: { days: number }) {
  if (days === UNLIMITED_DURATION_DAYS) return <span>{t('web.product_unlimited')}</span>;
  return (
    <span className="nowrap">
      <Ltr>{formatNumber(days)}</Ltr> {t('web.product_days_unit')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function OrdersPage({ route, denied }: { route: Route; denied: boolean }) {
  const onLink = useLinkHandler();

  const appliedState = stateFromQuery(route.query.get('state'));
  const appliedCustomer = route.query.get('customerId') ?? '';
  const appliedProduct = route.query.get('productId') ?? '';

  /*
   * The draft FOLLOWS the applied values — derived, not initialised. The sidebar link
   * re-renders this component with an empty query rather than remounting it, so an
   * initialiser would leave the boxes showing a filter that is no longer applied.
   */
  const appliedSignature = [appliedCustomer, appliedProduct].join('|');
  const [draft, setDraft] = useState<{ signature: string; customerId: string; productId: string }>({
    signature: appliedSignature,
    customerId: appliedCustomer,
    productId: appliedProduct,
  });
  const fresh = draft.signature === appliedSignature;
  const draftCustomer = fresh ? draft.customerId : appliedCustomer;
  const draftProduct = fresh ? draft.productId : appliedProduct;

  /*
   * The cursor trail, keyed by the filter it was minted under. A cursor minted under
   * one filter strands every row before it under another. Joined on `|`, which cannot
   * appear in a uuid or in an order state.
   */
  const searchSignature = [appliedState ?? '', appliedCustomer, appliedProduct].join('|');
  const [trail, setTrail] = useState<{ signature: string; cursors: readonly string[] }>({
    signature: searchSignature,
    cursors: [],
  });
  const cursors = trail.signature === searchSignature ? trail.cursors : [];
  const cursor = cursors.length > 0 ? cursors[cursors.length - 1] : undefined;

  const orders = useQuery({
    queryKey: ['orders', searchSignature, cursor ?? null],
    queryFn: () =>
      fetchOrders({
        ...(cursor === undefined ? {} : { cursor }),
        ...(appliedState === null ? {} : { state: appliedState }),
        ...(appliedCustomer === '' ? {} : { customerId: appliedCustomer }),
        ...(appliedProduct === '' ? {} : { productId: appliedProduct }),
      }),
    enabled: !denied,
  });

  const rows = orders.data?.orders ?? [];
  const nextCursor = orders.data?.nextCursor ?? null;
  const filtering = appliedCustomer !== '' || appliedProduct !== '';
  const clearable = filtering || draftCustomer !== '' || draftProduct !== '';

  /*
   * Checked against the CONTRACT's own id schema before it is applied.
   *
   * The server refuses a non-id with a 400, which an operator reads as "something is
   * wrong" without saying which of the two boxes. The commonest mistake here is pasting
   * a TELEGRAM id — which is what the customer list shows — into a field that wants the
   * internal one, so naming it is the whole difference between a dead end and a fix.
   * Same schema as the server parses with, so there is one definition of what an id is.
   */
  const idProblem = (value: string): string | undefined =>
    value !== '' && !uuidV7Schema.safeParse(value).success
      ? t('web.orders_filter_invalid_id')
      : undefined;
  const customerProblem = idProblem(draftCustomer);
  const productProblem = idProblem(draftProduct);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (customerProblem !== undefined || productProblem !== undefined) return;
    // ONE navigation for both fields. Two `setQuery` calls here dropped the first:
    // each builds from the `route.query` prop this render captured. See `setQueries`.
    setQueries(route, [
      ['customerId', draftCustomer === '' ? null : draftCustomer],
      ['productId', draftProduct === '' ? null : draftProduct],
    ]);
  };

  const columns: readonly Column<OrderSummaryResponse>[] = [
    {
      key: 'title',
      header: t('web.order_line'),
      render: (row) => (
        <a href={`/orders/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
          {/* The SNAPSHOT title, not a lookup. What the customer bought. */}
          {row.lineTitle}
        </a>
      ),
    },
    { key: 'state', header: t('web.status'), render: (row) => <StateBadge value={row.state} /> },
    {
      key: 'total',
      header: t('web.order_total'),
      render: (row) => <Money value={{ amountMinor: row.totalAmount, currency: row.currency }} />,
    },
    {
      key: 'customer',
      header: t('web.order_customer'),
      render: (row) => (
        <a href={`/users/${encodeURIComponent(row.customerId)}`} onClick={onLink}>
          <Ltr>{row.customerId.slice(0, 8)}</Ltr>
        </a>
      ),
    },
    {
      key: 'created',
      header: t('web.order_created_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
    {
      key: 'expires',
      header: t('web.order_expires_at'),
      render: (row) =>
        row.expiresAt === null ? (
          <Dash />
        ) : (
          <span className="nowrap">{formatTimestamp(row.expiresAt)}</span>
        ),
    },
  ];

  return (
    <>
      <PageHead title={t('web.orders_title')} subtitle={t('web.orders_intro')} maturity="now" />

      <Card>
        <div hidden={!mayRequest(orders, denied)}>
          <form className="toolbar" onSubmit={apply}>
            <Field
              label={t('web.order_customer')}
              hint={t('web.orders_filter_customer_hint')}
              htmlFor="orders-customer"
              {...(customerProblem === undefined ? {} : { error: customerProblem })}
            >
              <input
                id="orders-customer"
                dir="ltr"
                value={draftCustomer}
                onChange={(event) =>
                  setDraft({
                    signature: appliedSignature,
                    customerId: event.target.value.trim(),
                    productId: draftProduct,
                  })
                }
              />
            </Field>
            <Field
              label={t('web.order_product')}
              hint={t('web.orders_filter_product_hint')}
              htmlFor="orders-product"
              {...(productProblem === undefined ? {} : { error: productProblem })}
            >
              <input
                id="orders-product"
                dir="ltr"
                value={draftProduct}
                onChange={(event) =>
                  setDraft({
                    signature: appliedSignature,
                    customerId: draftCustomer,
                    productId: event.target.value.trim(),
                  })
                }
              />
            </Field>
            <button
              type="submit"
              className="btn primary sm"
              disabled={customerProblem !== undefined || productProblem !== undefined}
            >
              {t('web.users_search_apply')}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={!clearable}
              onClick={() => {
                setDraft({ signature: appliedSignature, customerId: '', productId: '' });
                setQueries(route, [
                  ['customerId', null],
                  ['productId', null],
                ]);
              }}
            >
              {t('web.users_search_clear')}
            </button>
          </form>

          <div className="toolbar">
            <Pills
              value={appliedState ?? 'ALL'}
              onChange={(next) => setQuery(route, 'state', next === 'ALL' ? null : next)}
              items={[
                { id: 'ALL' as const, label: t('web.users_filter_all') },
                // Over the FROZEN vocabulary, so a state added to the contract without a
                // filter here is a compile error rather than an option nobody notices is
                // missing.
                ...ORDER_STATES.map((state) => ({ id: state, label: t(STATE_LABELS[state]) })),
              ]}
            />
          </div>
        </div>

        <StateSwitch
          query={orders}
          denied={denied}
          isEmpty={rows.length === 0}
          empty={
            filtering ? (
              <Empty
                title={t('web.orders_filter_empty')}
                hint={t('web.orders_filter_empty_hint')}
                icon="inbox"
              />
            ) : (
              <Empty
                title={t('web.orders_empty')}
                hint={t('web.orders_empty_hint')}
                icon="orders"
              />
            )
          }
        >
          <DataTable
            caption={t('web.orders_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
          />
        </StateSwitch>

        {!denied && queryState(orders) === 'ready' && (
          <CursorPager
            shown={rows.length}
            hasPrevious={cursors.length > 0}
            hasNext={nextCursor !== null}
            onPrevious={() =>
              setTrail({ signature: searchSignature, cursors: cursors.slice(0, -1) })
            }
            onNext={() =>
              nextCursor !== null &&
              setTrail({ signature: searchSignature, cursors: [...cursors, nextCursor] })
            }
            // `GET /orders` pages an ASCENDING keyset — the earliest order first — so
            // "next" is NEWER here, as on `/users` and `/products`.
            nextLabel="web.newer"
            previousLabel="web.older"
          />
        )}
      </Card>

      <Card title={t('web.orders_scope_title')}>
        <p className="muted">{t('web.orders_scope_body')}</p>
      </Card>

      {/* Owner revisions 3, 6 and 11. They used to live on the planned page this route
          replaced; revision 6 is DELIVERED here — every `line*` field is a snapshot —
          and the other two describe the payment surface, which is still future. A
          decision recorded only on a screen nobody can open is a decision nobody reads
          before breaking it. */}
      <Card title={t('web.orders_future_rules_title')}>
        <p className="muted">{t('web.orders_rule_history')}</p>
        <p className="muted">{t('web.orders_rule_attention')}</p>
        <p className="muted">{t('web.orders_rule_shared_projection')}</p>
      </Card>
    </>
  );
}

function stateFromQuery(raw: string | null): OrderState | null {
  return ORDER_STATES.includes(raw as OrderState) ? (raw as OrderState) : null;
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function OrderDetailPage({
  id,
  denied,
  mayViewPayments,
  mayViewServices,
}: {
  id: string;
  denied: boolean;
  mayViewPayments: boolean;
  mayViewServices: boolean;
}) {
  const onLink = useLinkHandler();
  const order = useQuery({
    queryKey: ['order', id],
    queryFn: () => fetchOrder(id),
    enabled: !denied,
  });
  const row = order.data?.order;

  return (
    <>
      <PageHead
        title={t('web.order_detail')}
        {...(row === undefined ? {} : { subtitle: row.lineTitle })}
        maturity="now"
      />

      <StateSwitch query={order} denied={denied}>
        {row === undefined ? null : (
          <>
            {row.state === 'AWAITING_PAYMENT' && (
              /*
               * The boundary, said to the operator who is looking at it.
               *
               * This order is waiting for money and nothing in this release can take
               * any. Saying so is the alternative to a button that would pretend.
               */
              <Banner tone="info" title={t('web.order_awaiting_banner_title')}>
                {t('web.order_awaiting_banner_body')}
              </Banner>
            )}

            {row.state === 'REFUNDED' && (
              /*
               * The other terminal outcome, said out loud.
               *
               * A `REFUNDED` badge in the lifecycle card is a state; this says what
               * it MEANS — the money went back to the wallet automatically, in the
               * transaction that found the order undeliverable — and points at the
               * two places the exact figure is recorded. The card below shows what
               * was attempted and why it failed.
               */
              <Banner tone="info" title={t('web.order_refunded_banner_title')}>
                {t('web.order_refunded_banner_body')}
              </Banner>
            )}

            <Card title={t('web.order_line_title')} hint={t('web.order_snapshot_hint')}>
              <KV
                items={[
                  [t('web.product_title'), row.lineTitle],
                  [
                    t('web.order_category'),
                    /*
                     * The SNAPSHOT, and null is rendered as "not recorded".
                     *
                     * Never filled from the product's category as it reads now. Two
                     * orders carry null here — one placed before the columns existed,
                     * and a renewal, which is not bought from a category at all — and
                     * in both cases the honest answer is that there is no record. A
                     * join to the live product would report today's arrangement as
                     * though it were the customer's, which is the legacy
                     * «محصول حذف‌شده» performed on a different column.
                     */
                    row.lineCategoryName === null ? (
                      <span key="cat" className="muted">
                        {t('web.order_category_unknown')}
                      </span>
                    ) : (
                      <span key="cat">
                        {row.lineCategoryEmoji === null
                          ? row.lineCategoryName
                          : `${row.lineCategoryEmoji} ${row.lineCategoryName}`}
                      </span>
                    ),
                  ],
                  [t('web.product_duration'), <Duration key="d" days={row.lineDurationDays} />],
                  [t('web.product_traffic'), <Traffic key="tr" bytes={row.lineTrafficBytes} />],
                  [
                    t('web.product_device_limit'),
                    row.lineDeviceLimit === null ? (
                      <span key="dl">{t('web.product_devices_provider_default')}</span>
                    ) : (
                      <Ltr key="dl">{formatNumber(row.lineDeviceLimit)}</Ltr>
                    ),
                  ],
                  [
                    t('web.order_unit_price'),
                    <Money
                      key="up"
                      value={{ amountMinor: row.lineUnitPriceAmount, currency: row.currency }}
                    />,
                  ],
                  [t('web.order_quantity'), <Ltr key="q">{formatNumber(row.lineQuantity)}</Ltr>],
                ]}
              />
            </Card>

            <Card title={t('web.order_totals_title')}>
              <KV
                items={[
                  [
                    t('web.order_subtotal'),
                    <Money
                      key="st"
                      value={{ amountMinor: row.subtotalAmount, currency: row.currency }}
                    />,
                  ],
                  [
                    t('web.order_discount'),
                    <Money
                      key="di"
                      value={{ amountMinor: row.discountAmount, currency: row.currency }}
                    />,
                  ],
                  [
                    t('web.order_total'),
                    <Money
                      key="to"
                      value={{ amountMinor: row.totalAmount, currency: row.currency }}
                    />,
                  ],
                ]}
              />
            </Card>

            <OrderPricing orderId={row.id} />

            <Card title={t('web.order_lifecycle_title')}>
              <KV
                items={[
                  [t('web.status'), <StateBadge key="s" value={row.state} />],
                  [t('web.order_created_at'), formatTimestamp(row.createdAt)],
                  [
                    t('web.order_expires_at'),
                    row.expiresAt === null ? <Dash key="e" /> : formatTimestamp(row.expiresAt),
                  ],
                  [
                    t('web.order_confirmed_at'),
                    row.confirmedAt === null ? <Dash key="c" /> : formatTimestamp(row.confirmedAt),
                  ],
                  /*
                   * When the money arrived, and nothing else.
                   * `orders_settled_at_check` binds this to PAID, so a value here is
                   * the database saying the order is financially settled. It is not a
                   * delivery date: nothing in this release delivers anything.
                   */
                  [
                    t('web.order_settled_at'),
                    row.settledAt === null ? <Dash key="st" /> : formatTimestamp(row.settledAt),
                  ],
                  [t('web.updated_at'), formatTimestamp(row.updatedAt)],
                ]}
              />
            </Card>

            <Card title={t('web.order_references_title')} hint={t('web.order_references_hint')}>
              <KV
                items={[
                  [
                    t('web.order_customer'),
                    <a
                      key="cu"
                      href={`/users/${encodeURIComponent(row.customerId)}`}
                      onClick={onLink}
                    >
                      <Ltr>{row.customerId}</Ltr>
                    </a>,
                  ],
                  [
                    t('web.order_product'),
                    <a
                      key="pr"
                      href={`/products/${encodeURIComponent(row.productId)}`}
                      onClick={onLink}
                    >
                      <Ltr>{row.productId}</Ltr>
                    </a>,
                  ],
                  [t('web.product_panel'), <Copyable key="pa" value={row.panelId} />],
                ]}
              />
            </Card>

            <OrderPayments orderId={row.id} mayView={mayViewPayments} />

            <OrderService orderId={row.id} mayView={mayViewServices} />

            <Card title={t('web.orders_scope_title')}>
              <p className="muted">{t('web.orders_scope_body')}</p>
            </Card>
          </>
        )}
      </StateSwitch>
    </>
  );
}

/**
 * What this order actually PRODUCED, and what happened when we tried to produce it.
 *
 * The order page had no route to this at all. An operator reading order
 * `01a0c54b` in production saw ten thousand toman taken, a `REFUNDED` badge and
 * nothing else: not the service row, not the five PROVISION attempts against it,
 * not the reason every one of them failed. The answer existed the whole time — one
 * `services` row and its operations — and this surface simply never asked.
 *
 * `orderId` is a filter on the services list rather than a new aggregate endpoint,
 * because `services_tenant_order_key` already makes this a one-row question and the
 * read goes through the same tenant-scoped, permission-checked service the services
 * page uses.
 *
 * `services.view` is its own permission and is decided by the caller, for the reason
 * `mayViewPayments` gives: an operator holding `orders.view` and not this one would
 * otherwise log a 403 on every order they open.
 */
function OrderService({ orderId, mayView }: { orderId: string; mayView: boolean }) {
  const onLink = useLinkHandler();
  const services = useQuery({
    queryKey: ['services', 'order', orderId],
    queryFn: () => fetchServices({ orderId, limit: 1 }),
    enabled: mayView,
  });

  if (!mayView) {
    return (
      <Card title={t('web.order_service_title')}>
        <Banner tone="info">{t('web.order_service_denied')}</Banner>
      </Card>
    );
  }

  const service = services.data?.services[0];

  return (
    <>
      <Card title={t('web.order_service_title')} hint={t('web.order_service_hint')}>
        <StateSwitch query={services}>
          {services.data === undefined ? null : service === undefined ? (
            <Empty title={t('web.order_service_empty')} hint={t('web.order_service_empty_hint')} />
          ) : (
            <KV
              items={[
                [
                  t('web.service_username'),
                  <a
                    key="u"
                    href={`/services/${encodeURIComponent(service.id)}`}
                    onClick={onLink}
                    className="strong"
                  >
                    <Ltr>{service.providerUsername}</Ltr>
                  </a>,
                ],
                [
                  t('web.service_state'),
                  <Badge key="s" tone={SERVICE_STATE_TONES[service.state]}>
                    {t(SERVICE_STATE_LABELS[service.state])}
                  </Badge>,
                ],
                [
                  t('web.service_delivery'),
                  <Badge key="d" tone={SERVICE_DELIVERY_TONES[service.deliveryState]}>
                    {t(SERVICE_DELIVERY_LABELS[service.deliveryState])}
                  </Badge>,
                ],
                /*
                 * The panel's own id for the account, and the most telling field on
                 * this card. NULL beside an assigned username is exactly the
                 * production shape: a name was reserved, the create never landed, and
                 * no screen said so.
                 */
                [
                  t('web.service_provider_user_id'),
                  service.providerUserId === null ? (
                    <Dash key="pu" />
                  ) : (
                    <Copyable key="pu" value={service.providerUserId} />
                  ),
                ],
                [
                  t('web.service_provisioned_at'),
                  service.provisionedAt === null ? (
                    <Dash key="pa" />
                  ) : (
                    formatTimestamp(service.provisionedAt)
                  ),
                ],
                [
                  t('web.service_delivered_at'),
                  service.deliveredAt === null ? (
                    <Dash key="da" />
                  ) : (
                    formatTimestamp(service.deliveredAt)
                  ),
                ],
                [
                  t('web.service_terminated_at'),
                  service.terminatedAt === null ? (
                    <Dash key="ta" />
                  ) : (
                    formatTimestamp(service.terminatedAt)
                  ),
                ],
              ]}
            />
          )}
        </StateSwitch>
      </Card>

      {service === undefined ? null : <OrderServiceOperations serviceId={service.id} />}
    </>
  );
}

/**
 * Every attempt against that service, newest first, with the reason it failed.
 *
 * `failureMessage` is the INTERNAL reason and belongs here: `ACTIVATION_INCOMPLETE`
 * names a panel an operator can go and finish configuring, and saying so is this
 * surface's whole job. The customer is told something else entirely — the committed
 * refund and their new balance — and the two must not converge. A customer shown a
 * refusal code learns nothing they can act on; an operator shown only «خطایی رخ داد»
 * has no way to find the panel that caused it.
 *
 * The bound travels with the rows, so the truncation notice states what the server
 * actually applied rather than a constant this page imported.
 */
function OrderServiceOperations({ serviceId }: { serviceId: string }) {
  const operations = useQuery({
    queryKey: ['service-operations', serviceId],
    queryFn: () => fetchServiceOperations(serviceId),
  });

  return (
    <Card title={t('web.service_operations_title')} hint={t('web.service_operations_hint')}>
      <StateSwitch query={operations}>
        {operations.data === undefined ? null : operations.data.operations.length === 0 ? (
          <Empty title={t('web.service_operations_empty')} />
        ) : (
          <>
            <DataTable
              caption={t('web.service_operations_title')}
              columns={OPERATION_COLUMNS}
              rows={operations.data.operations}
              rowKey={(op) => op.id}
            />
            {operations.data.hasMore && (
              <p className="muted small">
                {t('web.service_operations_truncated')} <Num value={operations.data.limit} />
              </p>
            )}
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

/*
 * Five columns, not the services page's seven. `scheduledAt` and `createdAt` answer
 * "when is the next attempt due", which is a question about a live operation; an
 * order page is read after the fact, and the four facts that matter there are what
 * was attempted, how it ended, how many times, and why.
 */
const OPERATION_COLUMNS: readonly Column<ServiceOperationResponse>[] = [
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
    // The adapter's own words, or the refusal the provisioner classified. It is what
    // tells a panel refusing a duplicate apart from a panel nobody finished setting up.
    render: (op) => (op.failureMessage === null ? <Dash /> : <span>{op.failureMessage}</span>),
  },
];

/**
 * The payments against one order.
 *
 * A separate query rather than a field on the order, because a payment is a
 * FIRST-CLASS record and not a property of an order — the one structural thing the
 * research settles outright, with 124,196 legacy payments against 74,860 orders. An
 * order can have a refused attempt and a confirmed one, and both are facts.
 *
 * It shows the state, the method and the amount, and NOTHING about a service. An
 * operator reading a PAID order here learns that the money arrived; what happens next
 * is a later phase's to announce, through its own surface.
 */
function OrderPayments({ orderId, mayView }: { orderId: string; mayView: boolean }) {
  const onLink = useLinkHandler();
  const payments = useQuery({
    queryKey: ['payments', 'order', orderId],
    queryFn: () => fetchPayments({ orderId }),
    // Not merely hidden: an operator without `payments.view` makes no request at all,
    // so reading an order does not log a 403 against them on every open.
    enabled: mayView,
  });

  if (!mayView) {
    return (
      <Card title={t('web.order_payments_title')}>
        <Banner tone="info">{t('web.order_payments_denied')}</Banner>
      </Card>
    );
  }

  return (
    <Card title={t('web.order_payments_title')}>
      <StateSwitch query={payments}>
        {payments.data === undefined ? null : payments.data.payments.length === 0 ? (
          <Empty title={t('web.order_payments_empty')} />
        ) : (
          <ul className="plain">
            {payments.data.payments.map((one) => (
              <li key={one.id}>
                <a href={`/payments/${encodeURIComponent(one.id)}`} onClick={onLink}>
                  <Ltr>{one.reference}</Ltr>
                </a>{' '}
                — {t(PAYMENT_STATE_LABELS[one.state])} —{' '}
                <Money value={{ amountMinor: one.amount, currency: one.currency }} />
              </li>
            ))}
          </ul>
        )}
        {/*
          A financial list that silently stopped at a page boundary is the legacy
          reporting defect in miniature: the operator reads it as the whole history.
          One open transfer per order and one confirmed payment make more than a page
          unlikely, but "unlikely" is not "shown", so the truncation is NAMED and the
          full list is one link away rather than paged again here.
        */}
        {payments.data?.nextCursor == null ? null : (
          <Banner tone="info">{t('web.order_payments_truncated')}</Banner>
        )}
      </StateSwitch>
    </Card>
  );
}

/**
 * The payment states, labelled HERE as well as on the payments page.
 *
 * A second map rather than an import, because importing a page into a page is how two
 * surfaces come to share a rendering decision neither owns. Both read the same FROZEN
 * `PAYMENT_STATES`, so a state added to the contract is a compile error in both.
 */
const PAYMENT_STATE_LABELS: Readonly<Record<PaymentState, WebKey>> = {
  PENDING: 'web.payment_state_pending',
  CONFIRMED: 'web.payment_state_confirmed',
  FAILED: 'web.payment_state_failed',
  CANCELLED: 'web.payment_state_cancelled',
  EXPIRED: 'web.payment_state_expired',
  UNKNOWN: 'web.payment_state_unknown',
};

// ---------------------------------------------------------------------------
// Pricing (WP8)
// ---------------------------------------------------------------------------

/**
 * The cashback state, and the fourth answer the wire can give: `null`.
 *
 * Null is not "none" — a quote with no cashback has no block at all. It is a DRAFT's
 * promise, which is only recorded when the order is confirmed, so the label says that
 * rather than borrowing `PENDING`'s "waiting for delivery" for an order nobody has
 * confirmed.
 */
const CASHBACK_STATE_LABELS: Readonly<Record<CashbackState, WebKey>> = {
  PENDING: 'web.cashback_state_pending',
  EARNED: 'web.cashback_state_earned',
  VOID: 'web.cashback_state_void',
};

const CASHBACK_STATE_TONES: Readonly<Record<CashbackState, Tone>> = {
  PENDING: 'warn',
  EARNED: 'ok',
  VOID: 'neutral',
};

/**
 * How this order's price was reached: the code entered, each promotional adjustment in
 * the order the engine applied it, the redemptions confirmation recorded, and the
 * cashback the quote promised with what has become of it.
 *
 * Its own read (`GET /orders/:id/pricing`) rather than fields on the order, for the
 * reason the contract gives: a list of fifty orders has no business joining three more
 * tables. The adjustments come from the STORED quote, so they are what the customer was
 * charged even if a rule has since been retuned — the snapshot rule every `line*` field
 * on this page follows.
 *
 * `orders.view` is what the page itself requires, and it is what the server charges for
 * this read, so there is no separate permission to decide here.
 */
function OrderPricing({ orderId }: { orderId: string }) {
  const pricing = useQuery({
    queryKey: ['order-pricing', orderId],
    queryFn: () => fetchOrderPricing(orderId),
  });

  return (
    <Card title={t('web.order_pricing_title')} hint={t('web.order_pricing_hint')}>
      <StateSwitch query={pricing}>
        {pricing.data === undefined ? null : <OrderPricingBody pricing={pricing.data} />}
      </StateSwitch>
    </Card>
  );
}

function OrderPricingBody({ pricing }: { pricing: OrderPricingResponse }) {
  const money = (amountMinor: string) => (
    <Money value={{ amountMinor, currency: pricing.currency }} />
  );
  const adjustmentColumns: readonly Column<OrderPricingResponse['adjustments'][number]>[] = [
    { key: 'label', header: t('web.order_pricing_rule'), render: (row) => row.label },
    {
      key: 'before',
      header: t('web.order_pricing_before'),
      render: (row) => money(row.amountBefore),
    },
    {
      key: 'after',
      header: t('web.order_pricing_after'),
      render: (row) => money(row.amountAfter),
    },
  ];
  const redemptionColumns: readonly Column<OrderPricingResponse['redemptions'][number]>[] = [
    {
      key: 'rule',
      header: t('web.order_pricing_rule'),
      render: (row) => <Copyable value={row.discountId} />,
    },
    { key: 'amount', header: t('web.order_pricing_amount'), render: (row) => money(row.amount) },
    {
      key: 'at',
      header: t('web.order_pricing_redeemed_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
  ];
  const cashback = pricing.cashback;

  return (
    <>
      {pricing.reseller !== null && (
        <ResellerTerms terms={pricing.reseller} currency={pricing.currency} />
      )}

      <KV
        items={[
          [
            t('web.order_pricing_code'),
            pricing.discountCode === null ? (
              <span key="c" className="muted">
                {t('web.order_pricing_no_code')}
              </span>
            ) : (
              <Ltr key="c">{pricing.discountCode}</Ltr>
            ),
          ],
        ]}
      />

      <h3>{t('web.order_pricing_adjustments')}</h3>
      {pricing.adjustments.length === 0 ? (
        <p className="muted">{t('web.order_pricing_no_adjustments')}</p>
      ) : (
        <DataTable
          caption={t('web.order_pricing_adjustments')}
          columns={adjustmentColumns}
          rows={pricing.adjustments}
          // Position, not rule id: a quote may carry a step with no rule, and the steps
          // are an ordered list whose order IS the information.
          rowKey={(row) => String(pricing.adjustments.indexOf(row))}
        />
      )}

      <h3>{t('web.order_pricing_redemptions')}</h3>
      {pricing.redemptions.length === 0 ? (
        <p className="muted">{t('web.order_pricing_no_redemptions')}</p>
      ) : (
        <DataTable
          caption={t('web.order_pricing_redemptions')}
          columns={redemptionColumns}
          rows={pricing.redemptions}
          rowKey={(row) => `${row.discountId}:${row.createdAt}`}
        />
      )}

      <h3>{t('web.order_cashback_title')}</h3>
      {cashback === null ? (
        <p className="muted">{t('web.order_cashback_none')}</p>
      ) : (
        <>
          <KV
            items={[
              [t('web.order_pricing_rule'), cashback.label],
              [
                t('web.order_cashback_percent'),
                <span key="p" className="nowrap">
                  <Ltr>{String(cashback.percent)}</Ltr> {t('web.discount_percent_unit')}
                </span>,
              ],
              [t('web.order_cashback_promised'), money(cashback.promisedAmount)],
              [
                t('web.order_cashback_state'),
                cashback.state === null ? (
                  <Badge key="s" tone="neutral">
                    {t('web.cashback_state_draft')}
                  </Badge>
                ) : (
                  <Badge key="s" tone={CASHBACK_STATE_TONES[cashback.state]}>
                    {t(CASHBACK_STATE_LABELS[cashback.state])}
                  </Badge>
                ),
              ],
              [t('web.order_cashback_earned'), money(cashback.earnedAmount)],
              [t('web.order_cashback_reversed'), money(cashback.reversedAmount)],
              [t('web.order_cashback_unrecovered'), money(cashback.unrecoveredAmount)],
            ]}
          />
          {cashback.unrecoveredAmount !== '0' && (
            /*
             * Said, because the figure alone invites the wrong action. A reversal the
             * wallet could not cover is RECORDED and never collected — there is no debt
             * to chase, and an operator reading a bare number might go looking for one.
             */
            <Banner tone="warn">{t('web.order_cashback_unrecovered_note')}</Banner>
          )}
        </>
      )}
    </>
  );
}

/**
 * What a reseller's purchase was, as confirmation froze it (`docs/wp9-reseller-audit.md`
 * R4, R9): the tier by the name it had then, which layer set the price and by how much,
 * and the four figures that follow — list, the reseller's cost, the promotion taken off
 * that cost, and the sale.
 *
 * The MARGIN is list less cost and is never a discount: it is drawn here, apart from the
 * adjustments table below, because folding it into the discounts is the one confusion
 * the plan's governing line forbids. The order's subtotal above is already the reseller's
 * cost; the line keeps the catalogue's list price.
 *
 * Every figure is the snapshot's. Nothing here is re-derived from the tier as it is now,
 * which may have changed since.
 *
 * The snapshot carries no currency of its own on the wire, so the amounts are drawn in
 * the ORDER's currency — the one they were computed in, since the reseller layer prices
 * the order's own subtotal.
 */
function ResellerTerms({
  terms,
  currency,
}: {
  terms: NonNullable<OrderPricingResponse['reseller']>;
  currency: OrderPricingResponse['currency'];
}) {
  const onLink = useLinkHandler();
  const money = (amountMinor: string) => <Money value={{ amountMinor, currency }} />;
  const step = PRICE_LAYER_STEPS[terms.layer];
  return (
    <>
      <h3>{t('web.order_reseller_title')}</h3>
      <KV
        items={[
          [
            t('web.order_reseller_customer'),
            <a
              key="r"
              href={`/users/${encodeURIComponent(terms.resellerCustomerId)}`}
              onClick={onLink}
            >
              <Ltr>{terms.resellerCustomerId.slice(0, 8)}</Ltr>
            </a>,
          ],
          [t('web.reseller_tier'), terms.tierName],
          [
            t('web.order_reseller_layer'),
            <span key="l">
              {t(PRICE_LAYER_LABELS[terms.layer])}
              {step !== null && (
                <>
                  {' '}
                  <Ltr>{step}</Ltr>
                </>
              )}
            </span>,
          ],
          [
            t('web.reseller_percent'),
            terms.percent === null ? (
              <Dash key="p" />
            ) : (
              <span key="p" className="nowrap">
                <Ltr>{String(terms.percent)}</Ltr> {t('web.discount_percent_unit')}
              </span>
            ),
          ],
          [t('web.order_reseller_list'), money(terms.listAmount)],
          [t('web.order_reseller_cost'), money(terms.costAmount)],
          [t('web.order_reseller_promotion'), money(terms.promotionAmount)],
          [t('web.order_reseller_sale'), money(terms.saleAmount)],
          [t('web.order_reseller_margin'), money(terms.marginAmount)],
          [t('web.order_reseller_currency'), currencyLabel(currency)],
          [
            t('web.order_reseller_bot'),
            terms.botInstanceId === null ? (
              <Dash key="b" />
            ) : (
              <Copyable key="b" value={terms.botInstanceId} />
            ),
          ],
          [t('web.order_reseller_recorded_at'), formatTimestamp(terms.createdAt)],
        ]}
      />
      <p className="muted small">{t('web.order_reseller_margin_note')}</p>
    </>
  );
}
