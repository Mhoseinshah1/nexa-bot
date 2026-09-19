import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ORDER_STATES,
  UNLIMITED_DURATION_DAYS,
  UNLIMITED_TRAFFIC_BYTES,
  uuidV7Schema,
  type OrderState,
  type OrderSummaryResponse,
  type PaymentState,
} from '@nexa/contracts';
import { fetchOrder, fetchOrders, fetchPayments } from '../api/client';
import { formatNumber, formatTimestamp, splitBytes } from '../format';
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
  Money,
  PageHead,
  Pills,
  StateSwitch,
  type Column,
  type Tone,
} from '../ui/kit';

/**
 * Orders — what a customer asked to buy, and what they were quoted for it.
 *
 * This page READS. There is no cancel, no mark-paid, no refund and no settle, and the
 * absence is deliberate: each is a real operator action whose meaning depends on a
 * payment record this release does not have, and a button for one would be the legacy
 * system's silent-success pattern. `orders.controller.ts` has no route to call either,
 * so this is not the UI declining to offer something the server permits.
 *
 * Every `line*` field is the SNAPSHOT taken when the order was made. That is the whole
 * reason this surface can be trusted: the legacy «محصول حذف‌شده» is what a screen that
 * joins on today's product row shows for anything since renamed or deleted, and a report
 * built on it rewrites its own history every time somebody edits a plan.
 *
 * Two of the six states are unreachable in this release and the page still renders them.
 * `PAID` and `REFUNDED` need a payment; the filter offers them because an operator
 * filtering for "paid" and getting nothing has been told something true, while a filter
 * that hid the option would leave them wondering whether the product has the concept.
 */

const STATE_LABELS: Readonly<Record<OrderState, WebKey>> = {
  DRAFT: 'web.order_state_draft',
  AWAITING_PAYMENT: 'web.order_state_awaiting_payment',
  PAID: 'web.order_state_paid',
  PAID_UNFULFILLED: 'web.order_state_paid_unfulfilled',
  CANCELLED: 'web.order_state_cancelled',
  EXPIRED: 'web.order_state_expired',
  REFUNDED: 'web.order_state_refunded',
};

const STATE_TONES: Readonly<Record<OrderState, Tone>> = {
  DRAFT: 'neutral',
  AWAITING_PAYMENT: 'warn',
  PAID: 'ok',
  /*
   * DANGER, and the only state on this page that carries it. The money arrived and
   * the customer has nothing: an operator scanning the list has to be able to see
   * that without reading the label.
   */
  PAID_UNFULFILLED: 'danger',
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
}: {
  id: string;
  denied: boolean;
  mayViewPayments: boolean;
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

            <Card title={t('web.order_line_title')} hint={t('web.order_snapshot_hint')}>
              <KV
                items={[
                  [t('web.product_title'), row.lineTitle],
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
