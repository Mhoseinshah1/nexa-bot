import { useQuery } from '@tanstack/react-query';
import {
  type CustomerWorkspaceOrder,
  type CustomerWorkspacePayment,
  type TicketSummary,
} from '@nexa/contracts';
import { fetchCustomerWorkspace, fetchTickets } from '../api/client';
import { customerAttentionItems, workspaceWithheld } from '../attention-view';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import {
  Badge,
  Banner,
  Card,
  DataTable,
  Empty,
  Ltr,
  Money,
  Num,
  StateSwitch,
  type Column,
} from '../ui/kit';
import { AttentionClear, AttentionList } from './attention-list';
import { STATE_LABELS as ORDER_STATE_LABELS, STATE_TONES as ORDER_STATE_TONES } from './orders';
import {
  METHOD_LABELS as PAYMENT_METHOD_LABELS,
  STATE_LABELS as PAYMENT_STATE_LABELS,
  STATE_TONES as PAYMENT_STATE_TONES,
} from './payments';
import { STATUS_TONES as TICKET_STATUS_TONES, TICKET_STATUS_LABELS } from './tickets';

/*
 * Customer 360 as an operator's workspace (roadmap B5).
 *
 * Three things the page did not have: what about THIS customer is waiting for a person, the
 * customer's newest orders and payments (the full lists page oldest-first, so "latest" had
 * no read), and their support tickets — plus the shortcuts that open each list filtered to
 * them. Every figure is the server's (`GET /users/:id/workspace`, `GET /tickets`); every
 * section is gated by the permission of the page it links to, on the server (a withheld
 * section is `null`) and here (a section the viewer may not open is not asked for).
 */

/** How many tickets the support card shows: a glance, with the full list one click away. */
export const CUSTOMER_TICKETS_SHOWN = 5;

/** The workspace, read once for the attention card and the latest card. */
export function useCustomerWorkspace(customerId: string) {
  return useQuery({
    queryKey: ['customer-workspace', customerId],
    queryFn: () => fetchCustomerWorkspace(customerId),
  });
}

/** What about this customer waits for a person, each row a link to where it is handled. */
export function CustomerAttentionCard({ customerId }: { customerId: string }) {
  const workspace = useCustomerWorkspace(customerId);
  const data = workspace.data?.workspace;
  return (
    <Card
      id="c360-attention"
      title={t('web.c360ws_attention_title')}
      hint={t('web.c360ws_attention_hint')}
      tight
    >
      <StateSwitch query={workspace}>
        {data === undefined ? null : (
          <>
            <AttentionList
              items={customerAttentionItems(customerId, data)}
              label={t('web.c360ws_attention_title')}
              empty={<AttentionClear title={t('web.c360ws_nothing')} />}
            />
            {workspaceWithheld(data) && <p className="muted small">{t('web.c360ws_withheld')}</p>}
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

/**
 * The customer's newest orders and payments, newest first — a glance, never a history: the
 * keyset-paged lists stay on `/orders` and `/payments`, one link away. A half the viewer may
 * not open says which permission it needs, as the cards beside it do.
 */
export function CustomerLatestCard({ customerId }: { customerId: string }) {
  const onLink = useLinkHandler();
  const workspace = useCustomerWorkspace(customerId);
  const data = workspace.data?.workspace;
  const q = encodeURIComponent(customerId);

  const orderColumns: readonly Column<CustomerWorkspaceOrder>[] = [
    {
      key: 'title',
      header: t('web.order_line'),
      render: (row) => (
        <a href={`/orders/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
          {row.lineTitle}
        </a>
      ),
    },
    {
      key: 'state',
      header: t('web.status'),
      render: (row) => (
        <Badge tone={ORDER_STATE_TONES[row.state]} dot>
          {t(ORDER_STATE_LABELS[row.state])}
        </Badge>
      ),
    },
    {
      key: 'total',
      header: t('web.order_total'),
      render: (row) => <Money value={{ amountMinor: row.totalAmount, currency: row.currency }} />,
    },
    {
      key: 'created',
      header: t('web.order_created_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
  ];

  const paymentColumns: readonly Column<CustomerWorkspacePayment>[] = [
    {
      key: 'reference',
      header: t('web.payment_reference'),
      render: (row) => (
        <a href={`/payments/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
          <Ltr>{row.reference}</Ltr>
        </a>
      ),
    },
    {
      key: 'state',
      header: t('web.payment_state'),
      render: (row) => (
        <Badge tone={PAYMENT_STATE_TONES[row.state]} dot>
          {t(PAYMENT_STATE_LABELS[row.state])}
        </Badge>
      ),
    },
    {
      key: 'method',
      header: t('web.payment_method'),
      render: (row) => t(PAYMENT_METHOD_LABELS[row.method]),
    },
    {
      key: 'amount',
      header: t('web.payment_amount'),
      render: (row) => <Money value={{ amountMinor: row.amount, currency: row.currency }} />,
    },
    {
      key: 'created',
      header: t('web.payment_created_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
  ];

  return (
    <Card id="c360-latest" title={t('web.c360ws_latest_title')} hint={t('web.c360ws_latest_hint')}>
      <StateSwitch query={workspace}>
        {data === undefined ? null : (
          <div className="stack">
            <section aria-label={t('web.c360ws_latest_orders')} className="c360ws-half">
              <div className="c360ws-half-head">
                <h3>{t('web.c360ws_latest_orders')}</h3>
                {data.orders !== null && (
                  <a href={`/orders?q=${q}`} onClick={onLink} className="small">
                    {t('web.user_orders_all')}
                  </a>
                )}
              </div>
              {data.orders === null ? (
                <Banner tone="info">{t('web.c360_denied_orders')}</Banner>
              ) : data.orders.latest.length === 0 ? (
                <Empty variant="compact" title={t('web.c360ws_latest_orders_empty')} />
              ) : (
                <DataTable
                  caption={t('web.c360ws_latest_orders')}
                  columns={orderColumns}
                  rows={data.orders.latest}
                  rowKey={(row) => row.id}
                  dense
                />
              )}
            </section>
            <section aria-label={t('web.c360ws_latest_payments')} className="c360ws-half">
              <div className="c360ws-half-head">
                <h3>{t('web.c360ws_latest_payments')}</h3>
                {data.payments !== null && (
                  <a href={`/payments?q=${q}`} onClick={onLink} className="small">
                    {t('web.c360ws_payments_all')}
                  </a>
                )}
              </div>
              {data.payments === null ? (
                <Banner tone="info">{t('web.c360_denied_payments')}</Banner>
              ) : data.payments.latest.length === 0 ? (
                <Empty variant="compact" title={t('web.c360ws_latest_payments_empty')} />
              ) : (
                <DataTable
                  caption={t('web.c360ws_latest_payments')}
                  columns={paymentColumns}
                  rows={data.payments.latest}
                  rowKey={(row) => row.id}
                  dense
                />
              )}
            </section>
          </div>
        )}
      </StateSwitch>
    </Card>
  );
}

/**
 * The customer's support tickets, newest first: the inbox's own endpoint
 * (`GET /tickets?customer=…`, `tickets.view` charged there), its first page cut to a
 * glance by the server's own `limit`. Without `tickets.view` nothing is asked.
 */
export function CustomerTicketsCard({
  customerId,
  mayView,
}: {
  customerId: string;
  mayView: boolean;
}) {
  const onLink = useLinkHandler();
  const tickets = useQuery({
    queryKey: ['customer-tickets', customerId],
    queryFn: () => fetchTickets({ customer: customerId, limit: CUSTOMER_TICKETS_SHOWN }),
    enabled: mayView,
  });
  const workspace = useCustomerWorkspace(customerId);
  const open = workspace.data?.workspace.tickets?.open;

  if (!mayView) {
    return (
      <Card id="c360-support" title={t('web.c360ws_tickets_title')}>
        <Banner tone="info">{t('web.c360ws_tickets_denied')}</Banner>
      </Card>
    );
  }

  const columns: readonly Column<TicketSummary>[] = [
    {
      key: 'number',
      header: t('web.ticket_number'),
      render: (row) => (
        <a href={`/tickets/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
          <Num value={`#${String(row.number)}`} />
        </a>
      ),
    },
    {
      key: 'subject',
      header: t('web.ticket_subject'),
      render: (row) => <span dir="auto">{row.subject ?? row.categoryTitle}</span>,
      wrap: true,
    },
    {
      key: 'status',
      header: t('web.status'),
      render: (row) => (
        <Badge tone={TICKET_STATUS_TONES[row.status]} dot>
          {t(TICKET_STATUS_LABELS[row.status])}
        </Badge>
      ),
    },
    {
      key: 'last',
      header: t('web.ticket_last_message'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.lastMessageAt)}</span>,
    },
  ];

  return (
    <Card
      id="c360-support"
      title={t('web.c360ws_tickets_title')}
      hint={t('web.c360ws_tickets_hint')}
      actions={
        <a href={`/tickets?customer=${encodeURIComponent(customerId)}`} onClick={onLink}>
          {t('web.c360ws_tickets_all')}
        </a>
      }
    >
      {open !== undefined && open > 0 && (
        <p className="c360-chips">
          <Badge tone="warn">
            {t('web.c360ws_tickets_open')}: <Num value={open} />
          </Badge>
        </p>
      )}
      <StateSwitch query={tickets}>
        {tickets.data === undefined ? null : tickets.data.tickets.length === 0 ? (
          <Empty variant="compact" title={t('web.c360ws_tickets_empty')} />
        ) : (
          <DataTable
            caption={t('web.c360ws_tickets_title')}
            columns={columns}
            rows={tickets.data.tickets}
            rowKey={(row) => row.id}
            dense
          />
        )}
      </StateSwitch>
    </Card>
  );
}

interface Shortcut {
  readonly key: string;
  readonly label: WebKey;
  readonly href: string;
}

/**
 * The operator's shortcuts: each opens a list this viewer may open, filtered to this
 * customer by the filter that list already has. A shortcut the viewer could only be
 * refused at is not drawn.
 */
export function customerShortcuts(
  customerId: string,
  may: {
    readonly orders: boolean;
    readonly services: boolean;
    readonly payments: boolean;
    readonly tickets: boolean;
    readonly wallet: boolean;
    readonly businessChats: boolean;
  },
): Shortcut[] {
  const q = encodeURIComponent(customerId);
  const all: (Shortcut & { readonly allowed: boolean })[] = [
    {
      key: 'orders',
      label: 'web.c360ws_shortcut_orders',
      href: `/orders?q=${q}`,
      allowed: may.orders,
    },
    {
      key: 'services',
      label: 'web.c360ws_shortcut_services',
      href: `/services?q=${q}`,
      allowed: may.services,
    },
    {
      key: 'payments',
      label: 'web.c360ws_shortcut_payments',
      href: `/payments?q=${q}`,
      allowed: may.payments,
    },
    {
      key: 'tickets',
      label: 'web.c360ws_shortcut_tickets',
      href: `/tickets?customer=${q}`,
      allowed: may.tickets,
    },
    {
      key: 'wallet',
      label: 'web.c360ws_shortcut_wallet',
      href: '#c360-wallet',
      allowed: may.wallet,
    },
    {
      key: 'handoffs',
      label: 'web.c360ws_shortcut_handoffs',
      href: '/business-chats?state=HANDOFF_REQUIRED',
      allowed: may.businessChats,
    },
  ];
  return all.filter((one) => one.allowed).map(({ key, label, href }) => ({ key, label, href }));
}

export function OperatorShortcutsCard({ shortcuts }: { shortcuts: readonly Shortcut[] }) {
  const onLink = useLinkHandler();
  return (
    <Card title={t('web.c360ws_shortcuts_title')} hint={t('web.c360ws_shortcuts_hint')}>
      {shortcuts.length === 0 ? (
        <p className="muted small">{t('web.c360ws_shortcuts_none')}</p>
      ) : (
        <ul className="c360ws-shortcuts">
          {shortcuts.map((shortcut) => (
            <li key={shortcut.key}>
              <a
                href={shortcut.href}
                className="btn sm ghost"
                {...(shortcut.href.startsWith('#') ? {} : { onClick: onLink })}
              >
                {t(shortcut.label)}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
