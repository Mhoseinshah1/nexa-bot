import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TICKET_CATEGORY_TITLE_MAX_LENGTH,
  TICKET_MESSAGE_MAX_LENGTH,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  isTicketTextWithinBound,
  normalizeTicketCategoryTitle,
  normalizeTicketText,
  ticketManualEvent,
  type CustomerNotificationState,
  type SessionResponse,
  type TicketCategoryView,
  type TicketDetailResponse,
  type TicketMessageView,
  type TicketPriority,
  type TicketStatus,
  type TicketSummary,
  type TicketSystemEvent,
} from '@nexa/contracts';
import {
  ApiError,
  assignTicket,
  createTicketCategory,
  fetchTicket,
  fetchTicketAssignees,
  fetchTicketAttachment,
  fetchTicketCategories,
  fetchTickets,
  replyToTicket,
  setTicketLinks,
  setTicketPriority,
  setTicketStatus,
  updateTicketCategory,
  type TicketFilters,
} from '../api/client';
import { formatTimestamp, splitBytes } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { setQueries, setQuery, useLinkHandler, type Route } from '../router';
import { useSubmissionKey } from '../submission-key';
import { mayRequest } from '../view-state';
import { messageFor } from './settings';
// The FAQ's sort-order reader: the same bounds (0..100 000) and the same digit rules.
import { sortOrderOf } from './support';
import {
  Badge,
  Banner,
  Card,
  CursorPager,
  DataTable,
  Empty,
  Field,
  KV,
  Ltr,
  PageHead,
  Pills,
  StateSwitch,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';

/**
 * Support tickets (WP-A7) — the inbox, one conversation, and the categories customers
 * choose from.
 *
 * Nothing here decides anything. The server charges `tickets.view` to read, `tickets.reply`
 * to answer, `tickets.assign` for the assignee, priority and linked context, `tickets.close`
 * for every status change, and `tickets.categories.edit` for the categories — inside its own
 * transactions. The `may*` props only decide what is DRAWN. No write here asks for a reason:
 * a reply or a status change is ordinary support work, and the server audits each one.
 *
 * A reply is a row the moment it is sent. Whether Telegram delivered it is shown beside it,
 * read from the customer notification lane, and a failed delivery never takes the reply
 * away: the customer reads it in the bot's ticket view either way.
 */

export const TICKET_STATUS_LABELS: Readonly<Record<TicketStatus, WebKey>> = {
  OPEN: 'web.ticket_status_open',
  WAITING_FOR_CUSTOMER: 'web.ticket_status_waiting_for_customer',
  WAITING_FOR_SUPPORT: 'web.ticket_status_waiting_for_support',
  CLOSED: 'web.ticket_status_closed',
};

const STATUS_TONES: Readonly<Record<TicketStatus, Tone>> = {
  OPEN: 'warn',
  WAITING_FOR_CUSTOMER: 'info',
  WAITING_FOR_SUPPORT: 'danger',
  CLOSED: 'neutral',
};

const PRIORITY_LABELS: Readonly<Record<TicketPriority, WebKey>> = {
  LOW: 'web.ticket_priority_low',
  NORMAL: 'web.ticket_priority_normal',
  HIGH: 'web.ticket_priority_high',
  URGENT: 'web.ticket_priority_urgent',
};

const PRIORITY_TONES: Readonly<Record<TicketPriority, Tone>> = {
  LOW: 'neutral',
  NORMAL: 'info',
  HIGH: 'warn',
  URGENT: 'danger',
};

const DELIVERY_LABELS: Readonly<Record<CustomerNotificationState, WebKey>> = {
  PENDING: 'web.ticket_delivery_pending',
  DELIVERED: 'web.ticket_delivery_delivered',
  UNCONFIRMED: 'web.ticket_delivery_unconfirmed',
  FAILED: 'web.ticket_delivery_failed',
  SUPERSEDED: 'web.ticket_delivery_superseded',
};

const DELIVERY_TONES: Readonly<Record<CustomerNotificationState, Tone>> = {
  PENDING: 'warn',
  DELIVERED: 'ok',
  UNCONFIRMED: 'warn',
  FAILED: 'danger',
  SUPERSEDED: 'neutral',
};

const SYSTEM_LABELS: Readonly<Record<TicketSystemEvent, WebKey>> = {
  CLOSED_BY_CUSTOMER: 'web.ticket_system_closed_by_customer',
  CLOSED_BY_SUPPORT: 'web.ticket_system_closed_by_support',
  REOPENED_BY_SUPPORT: 'web.ticket_system_reopened',
};

/** The button each operator status change is drawn as. */
const STATUS_ACTIONS: Readonly<Record<TicketStatus, WebKey>> = {
  OPEN: 'web.ticket_status_open',
  WAITING_FOR_CUSTOMER: 'web.ticket_action_wait_customer',
  WAITING_FOR_SUPPORT: 'web.ticket_action_wait_support',
  CLOSED: 'web.ticket_action_close',
};

/** The refusals this page can name better than the server's English sentence. */
const FAULTS: Readonly<Record<string, WebKey>> = {
  'ticket.closed': 'web.ticket_fault_closed',
  'ticket.transition_invalid': 'web.ticket_fault_transition',
  'ticket.message_invalid': 'web.ticket_fault_message',
  'ticket.message_limit': 'web.ticket_fault_message_limit',
  'ticket.assignee_invalid': 'web.ticket_fault_assignee',
  'ticket.link_invalid': 'web.ticket_fault_link',
  'ticket.category_invalid': 'web.ticket_fault_category',
  'ticket.category_limit': 'web.ticket_fault_category_limit',
  'ticket.category_not_found': 'web.ticket_fault_category_missing',
  'ticket.not_found': 'web.ticket_fault_not_found',
  'ticket.attachment_unavailable': 'web.ticket_fault_attachment',
  'platform.idempotency_payload_mismatch': 'web.ticket_fault_retry',
};

export function ticketFault(error: unknown): string {
  if (error instanceof ApiError) {
    const key = FAULTS[error.code];
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

/** A `YYYY-MM-DD` from a date input, as the operator's own midnight, or null. */
export function dayStart(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return null;
  const at = new Date(`${day}T00:00:00`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** The midnight AFTER a day, so `[from, to)` includes the whole of the last day chosen. */
export function dayEnd(day: string): string | null {
  const start = dayStart(day);
  if (start === null) return null;
  const at = new Date(`${day}T00:00:00`);
  at.setDate(at.getDate() + 1);
  return at.toISOString();
}

function statusOf(raw: string | null): TicketStatus | null {
  return raw !== null && (TICKET_STATUSES as readonly string[]).includes(raw)
    ? (raw as TicketStatus)
    : null;
}

function StatusBadge({ status }: { status: TicketStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{t(TICKET_STATUS_LABELS[status])}</Badge>;
}

function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return <Badge tone={PRIORITY_TONES[priority]}>{t(PRIORITY_LABELS[priority])}</Badge>;
}

function Dash() {
  return <span className="faint">—</span>;
}

function customerLabel(row: TicketSummary): string {
  return [
    row.customerDisplayName,
    row.customerUsername === null ? null : `@${row.customerUsername}`,
    row.customerTelegramUserId,
  ]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
}

/** The id of the administrator signed in, from the session the shell already holds. */
function useViewerId(): string | null {
  const queries = useQueryClient();
  return queries.getQueryData<SessionResponse | null>(['session'])?.admin.id ?? null;
}

// ---------------------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------------------

export function TicketsPage({
  route,
  denied,
  mayAssign,
  mayEditCategories,
}: {
  route: Route;
  denied: boolean;
  mayAssign: boolean;
  mayEditCategories: boolean;
}) {
  const onLink = useLinkHandler();
  const status = statusOf(route.query.get('status'));
  const categoryId = route.query.get('categoryId') ?? '';
  const customer = route.query.get('customer') ?? '';
  const assigned = route.query.get('assigned') ?? '';
  const fromDay = route.query.get('from') ?? '';
  const toDay = route.query.get('to') ?? '';

  // The typed fields FOLLOW the applied values; see `/orders` for why this is derived.
  const appliedSignature = [customer, fromDay, toDay].join('|');
  const [draft, setDraft] = useState({ signature: appliedSignature, customer, fromDay, toDay });
  const fresh = draft.signature === appliedSignature;
  const draftCustomer = fresh ? draft.customer : customer;
  const draftFrom = fresh ? draft.fromDay : fromDay;
  const draftTo = fresh ? draft.toDay : toDay;
  const edit = (patch: Partial<{ customer: string; fromDay: string; toDay: string }>) =>
    setDraft({
      signature: appliedSignature,
      customer: draftCustomer,
      fromDay: draftFrom,
      toDay: draftTo,
      ...patch,
    });

  const filters: TicketFilters = {
    ...(status === null ? {} : { status }),
    ...(categoryId === '' ? {} : { categoryId }),
    ...(customer === '' ? {} : { customer }),
    ...(assigned === '' ? {} : { assigned }),
    ...(dayStart(fromDay) === null ? {} : { from: dayStart(fromDay) as string }),
    ...(dayEnd(toDay) === null ? {} : { to: dayEnd(toDay) as string }),
  };
  // A cursor minted under one filter strands rows under another: the trail is keyed by it.
  const searchSignature = JSON.stringify(filters);
  const [trail, setTrail] = useState<{
    signature: string;
    cursors: readonly { at: string; id: string }[];
  }>({ signature: searchSignature, cursors: [] });
  const cursors = trail.signature === searchSignature ? trail.cursors : [];
  const cursor = cursors[cursors.length - 1];

  const tickets = useQuery({
    queryKey: ['tickets', searchSignature, cursor ?? null],
    queryFn: () => fetchTickets(cursor === undefined ? filters : { ...filters, cursor }),
    enabled: !denied,
  });
  const categories = useQuery({
    queryKey: ['ticket-categories'],
    queryFn: fetchTicketCategories,
    enabled: !denied,
  });
  const assignees = useQuery({
    queryKey: ['ticket-assignees'],
    queryFn: fetchTicketAssignees,
    enabled: !denied && mayAssign,
  });

  const rows = tickets.data?.tickets ?? [];
  const nextCursor = tickets.data?.nextCursor ?? null;
  const filtering = searchSignature !== '{}';
  const dateProblem =
    (draftFrom !== '' && dayStart(draftFrom) === null) ||
    (draftTo !== '' && dayEnd(draftTo) === null) ||
    (draftFrom !== '' && draftTo !== '' && draftFrom > draftTo);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (dateProblem) return;
    setQueries(route, [
      ['customer', draftCustomer.trim() === '' ? null : draftCustomer.trim()],
      ['from', draftFrom === '' ? null : draftFrom],
      ['to', draftTo === '' ? null : draftTo],
    ]);
  };

  const columns: readonly Column<TicketSummary>[] = [
    {
      key: 'number',
      header: t('web.ticket_number'),
      render: (row) => (
        <a href={`/tickets/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
          <Ltr>#{row.number}</Ltr>
        </a>
      ),
    },
    {
      key: 'subject',
      header: t('web.ticket_subject'),
      render: (row) => row.subject ?? <Dash />,
    },
    { key: 'category', header: t('web.ticket_category'), render: (row) => row.categoryTitle },
    {
      key: 'status',
      header: t('web.status'),
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'priority',
      header: t('web.ticket_priority'),
      render: (row) => <PriorityBadge priority={row.priority} />,
    },
    {
      key: 'customer',
      header: t('web.ticket_customer'),
      render: (row) => (
        <a href={`/users/${encodeURIComponent(row.customerId)}`} onClick={onLink}>
          {customerLabel(row) || <Ltr>{row.customerId.slice(0, 8)}</Ltr>}
        </a>
      ),
    },
    {
      key: 'assignee',
      header: t('web.ticket_assignee'),
      render: (row) =>
        row.assignedAdminUsername ?? <span className="muted">{t('web.ticket_unassigned')}</span>,
    },
    {
      key: 'last',
      header: t('web.ticket_last_message'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.lastMessageAt)}</span>,
    },
    {
      key: 'created',
      header: t('web.ticket_created_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
  ];

  return (
    <>
      <PageHead title={t('web.tickets_title')} subtitle={t('web.tickets_intro')} maturity="now" />

      <Card>
        <div hidden={!mayRequest(tickets, denied)}>
          <div className="toolbar">
            <Pills
              value={status ?? 'ALL'}
              onChange={(next) => setQuery(route, 'status', next === 'ALL' ? null : next)}
              items={[
                { id: 'ALL' as const, label: t('web.ticket_filter_all') },
                ...TICKET_STATUSES.map((value) => ({
                  id: value,
                  label: t(TICKET_STATUS_LABELS[value]),
                })),
              ]}
            />
          </div>
          <form className="toolbar" onSubmit={apply}>
            <Field label={t('web.ticket_category')} htmlFor="tickets-category">
              <select
                id="tickets-category"
                value={categoryId}
                onChange={(event) => setQuery(route, 'categoryId', event.target.value || null)}
              >
                <option value="">{t('web.ticket_filter_all')}</option>
                {(categories.data?.categories ?? []).map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('web.ticket_assignee')} htmlFor="tickets-assigned">
              <select
                id="tickets-assigned"
                value={assigned}
                onChange={(event) => setQuery(route, 'assigned', event.target.value || null)}
              >
                <option value="">{t('web.ticket_filter_all')}</option>
                <option value="me">{t('web.ticket_filter_mine')}</option>
                <option value="none">{t('web.ticket_unassigned')}</option>
                {(assignees.data?.admins ?? []).map((admin) => (
                  <option key={admin.id} value={admin.id}>
                    {admin.displayName} (@{admin.username})
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={t('web.ticket_customer')}
              hint={t('web.ticket_filter_customer_hint')}
              htmlFor="tickets-customer"
            >
              <input
                id="tickets-customer"
                dir="ltr"
                value={draftCustomer}
                onChange={(event) => edit({ customer: event.target.value })}
              />
            </Field>
            <Field label={t('web.ticket_filter_from')} htmlFor="tickets-from">
              <input
                id="tickets-from"
                type="date"
                value={draftFrom}
                onChange={(event) => edit({ fromDay: event.target.value })}
              />
            </Field>
            <Field
              label={t('web.ticket_filter_to')}
              htmlFor="tickets-to"
              {...(dateProblem ? { error: t('web.ticket_filter_dates_invalid') } : {})}
            >
              <input
                id="tickets-to"
                type="date"
                value={draftTo}
                onChange={(event) => edit({ toDay: event.target.value })}
              />
            </Field>
            <button type="submit" className="btn primary sm" disabled={dateProblem}>
              {t('web.users_search_apply')}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={!filtering}
              onClick={() => {
                setDraft({ signature: '||', customer: '', fromDay: '', toDay: '' });
                setQueries(route, [
                  ['status', null],
                  ['categoryId', null],
                  ['customer', null],
                  ['assigned', null],
                  ['from', null],
                  ['to', null],
                ]);
              }}
            >
              {t('web.users_search_clear')}
            </button>
          </form>
        </div>

        <StateSwitch
          query={tickets}
          denied={denied}
          isEmpty={rows.length === 0 && cursors.length === 0}
          empty={
            <Empty
              title={t(filtering ? 'web.tickets_filter_empty' : 'web.tickets_empty')}
              hint={t('web.tickets_empty_hint')}
              icon="inbox"
            />
          }
        >
          <DataTable
            caption={t('web.tickets_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
          />
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
          />
        </StateSwitch>
      </Card>

      {!denied && (
        <TicketCategoriesCard
          categories={categories.data?.categories ?? []}
          query={categories}
          mayEdit={mayEditCategories}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------

function TicketCategoriesCard({
  categories,
  query,
  mayEdit,
}: {
  categories: readonly TicketCategoryView[];
  query: Parameters<typeof StateSwitch>[0]['query'];
  mayEdit: boolean;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const creation = useSubmissionKey();
  const [title, setTitle] = useState('');
  const [order, setOrder] = useState('');
  const refresh = () => void queries.invalidateQueries({ queryKey: ['ticket-categories'] });

  const create = useMutation({
    mutationFn: (input: { title: string; sortOrder: number }) =>
      createTicketCategory({ ...input, idempotencyKey: creation.current(input) }),
    onSuccess: () => {
      creation.settle();
      setTitle('');
      setOrder('');
      notify({ tone: 'ok', message: t('web.ticket_category_created') });
      refresh();
    },
    onError: (error) => creation.settleOn(error),
  });

  const update = useMutation({
    mutationFn: updateTicketCategory,
    onSuccess: ({ changed }) => {
      notify({
        tone: changed ? 'ok' : 'info',
        message: t(changed ? 'web.ticket_category_saved' : 'web.ticket_no_change'),
      });
      refresh();
    },
    onError: (error) => notify({ tone: 'danger', message: ticketFault(error) }),
  });

  const normalized = normalizeTicketCategoryTitle(title);
  const sortOrder = sortOrderOf(order === '' ? '0' : order);

  const columns: readonly Column<TicketCategoryView>[] = [
    {
      key: 'title',
      header: t('web.ticket_category_title'),
      render: (row) =>
        mayEdit ? <CategoryTitleEditor category={row} onSave={update.mutate} /> : row.title,
    },
    {
      key: 'order',
      header: t('web.ticket_category_order'),
      render: (row) =>
        mayEdit ? <CategoryOrderEditor category={row} onSave={update.mutate} /> : row.sortOrder,
    },
    {
      key: 'active',
      header: t('web.status'),
      render: (row) => (
        <Badge tone={row.isActive ? 'ok' : 'neutral'}>
          {t(row.isActive ? 'web.ticket_category_active' : 'web.ticket_category_hidden')}
        </Badge>
      ),
    },
    ...(mayEdit
      ? [
          {
            key: 'toggle',
            header: '',
            render: (row: TicketCategoryView) => (
              <button
                type="button"
                className="btn sm"
                disabled={update.isPending}
                onClick={() => update.mutate({ id: row.id, isActive: !row.isActive })}
              >
                {t(row.isActive ? 'web.ticket_category_hide' : 'web.ticket_category_show')}
              </button>
            ),
          },
        ]
      : []),
  ];

  return (
    <Card title={t('web.ticket_categories_title')} hint={t('web.ticket_categories_hint')}>
      <StateSwitch query={query} isEmpty={categories.length === 0}>
        <DataTable
          caption={t('web.ticket_categories_title')}
          columns={columns}
          rows={categories}
          rowKey={(row) => row.id}
        />
      </StateSwitch>
      {mayEdit && (
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            if (normalized === null || sortOrder === null) return;
            create.mutate({ title: normalized, sortOrder });
          }}
        >
          <Field
            label={t('web.ticket_category_title')}
            hint={t('web.ticket_category_title_hint')}
            htmlFor="ticket-category-title"
          >
            <input
              id="ticket-category-title"
              value={title}
              maxLength={TICKET_CATEGORY_TITLE_MAX_LENGTH * 2}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label={t('web.ticket_category_order')} htmlFor="ticket-category-order">
            <input
              id="ticket-category-order"
              inputMode="numeric"
              value={order}
              onChange={(event) => setOrder(event.target.value)}
            />
          </Field>
          <button
            type="submit"
            className="btn primary sm"
            disabled={create.isPending || normalized === null || sortOrder === null}
          >
            {t('web.ticket_category_add')}
          </button>
        </form>
      )}
      {create.error !== null && <Banner tone="danger">{ticketFault(create.error)}</Banner>}
    </Card>
  );
}

function CategoryTitleEditor({
  category,
  onSave,
}: {
  category: TicketCategoryView;
  onSave: (input: { id: string; title: string }) => void;
}) {
  const [value, setValue] = useState(category.title);
  useEffect(() => setValue(category.title), [category.title]);
  const normalized = normalizeTicketCategoryTitle(value);
  return (
    <span className="btn-group">
      <input
        aria-label={t('web.ticket_category_title')}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button
        type="button"
        className="btn sm"
        disabled={normalized === null || normalized === category.title}
        onClick={() => normalized !== null && onSave({ id: category.id, title: normalized })}
      >
        {t('web.ticket_category_rename')}
      </button>
    </span>
  );
}

/**
 * The display order of an existing category, through the same update the title uses.
 * Persian and Arabic digits are read as the create form reads them; anything else keeps
 * the button disabled rather than being reinterpreted.
 */
function CategoryOrderEditor({
  category,
  onSave,
}: {
  category: TicketCategoryView;
  onSave: (input: { id: string; sortOrder: number }) => void;
}) {
  const [value, setValue] = useState(String(category.sortOrder));
  useEffect(() => setValue(String(category.sortOrder)), [category.sortOrder]);
  const sortOrder = sortOrderOf(value);
  return (
    <span className="btn-group">
      <input
        aria-label={t('web.ticket_category_order')}
        inputMode="numeric"
        size={6}
        value={value}
        aria-invalid={sortOrder === null}
        onChange={(event) => setValue(event.target.value)}
      />
      <button
        type="button"
        className="btn sm"
        disabled={sortOrder === null || sortOrder === category.sortOrder}
        onClick={() => sortOrder !== null && onSave({ id: category.id, sortOrder })}
      >
        {t('web.ticket_category_reorder')}
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------------------
// One ticket
// ---------------------------------------------------------------------------------------

export function TicketDetailPage({
  id,
  denied,
  mayReply,
  mayAssign,
  mayClose,
}: {
  id: string;
  denied: boolean;
  mayReply: boolean;
  mayAssign: boolean;
  mayClose: boolean;
}) {
  const ticket = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => fetchTicket(id),
    enabled: !denied,
  });
  const data = ticket.data;
  return (
    <>
      <PageHead
        title={
          data === undefined
            ? t('web.ticket_detail')
            : `${t('web.ticket_detail')} #${data.ticket.number}`
        }
        subtitle={data?.ticket.subject ?? t('web.ticket_detail_intro')}
      />
      <StateSwitch query={ticket} denied={denied}>
        {data !== undefined && (
          <>
            <TicketSummaryCard detail={data} />
            <div className="grid c2">
              <TicketContextCard detail={data} mayAssign={mayAssign} />
              {(mayAssign || mayClose) && (
                <TicketActionsCard ticket={data.ticket} mayAssign={mayAssign} mayClose={mayClose} />
              )}
            </div>
            <TicketConversationCard messages={data.messages} />
            {mayReply && <TicketReplyCard ticket={data.ticket} />}
          </>
        )}
      </StateSwitch>
    </>
  );
}

function TicketSummaryCard({ detail }: { detail: TicketDetailResponse }) {
  const { ticket } = detail;
  return (
    <Card title={t('web.ticket_summary')}>
      <KV
        items={[
          [t('web.status'), <StatusBadge key="s" status={ticket.status} />],
          [t('web.ticket_priority'), <PriorityBadge key="p" priority={ticket.priority} />],
          [t('web.ticket_category'), ticket.categoryTitle],
          [
            t('web.ticket_assignee'),
            ticket.assignedAdminUsername ?? (
              <span key="a" className="muted">
                {t('web.ticket_unassigned')}
              </span>
            ),
          ],
          [t('web.ticket_created_at'), formatTimestamp(ticket.createdAt)],
          [t('web.ticket_last_message'), formatTimestamp(ticket.lastMessageAt)],
          [
            t('web.ticket_closed_at'),
            ticket.closedAt === null ? <Dash key="c" /> : formatTimestamp(ticket.closedAt),
          ],
        ]}
      />
    </Card>
  );
}

function TicketContextCard({
  detail,
  mayAssign,
}: {
  detail: TicketDetailResponse;
  mayAssign: boolean;
}) {
  const onLink = useLinkHandler();
  const { ticket, customer } = detail;
  const link = (path: string, value: string | null) =>
    value === null ? (
      <Dash />
    ) : (
      <a href={`/${path}/${encodeURIComponent(value)}`} onClick={onLink}>
        <Ltr>{value.slice(0, 8)}</Ltr>
      </a>
    );
  return (
    <Card title={t('web.ticket_context')} hint={t('web.ticket_context_hint')}>
      <KV
        items={[
          [
            t('web.ticket_customer'),
            <a key="c" href={`/users/${encodeURIComponent(customer.id)}`} onClick={onLink}>
              {customer.displayName ?? <Ltr>{customer.telegramUserId}</Ltr>}
            </a>,
          ],
          [t('web.ticket_customer_telegram'), <Ltr key="t">{customer.telegramUserId}</Ltr>],
          [
            t('web.ticket_customer_username'),
            customer.username === null ? <Dash key="u" /> : <Ltr key="u">@{customer.username}</Ltr>,
          ],
          [
            t('web.ticket_customer_status'),
            <Badge key="s" tone={customer.status === 'ACTIVE' ? 'ok' : 'danger'}>
              {t(
                customer.status === 'ACTIVE'
                  ? 'web.ticket_customer_active'
                  : 'web.ticket_customer_blocked',
              )}
            </Badge>,
          ],
          [t('web.ticket_link_service'), link('services', ticket.serviceId)],
          [t('web.ticket_link_order'), link('orders', ticket.orderId)],
          [t('web.ticket_link_payment'), link('payments', ticket.paymentId)],
        ]}
      />
      {mayAssign && <TicketLinksForm ticket={ticket} />}
    </Card>
  );
}

function TicketLinksForm({ ticket }: { ticket: TicketSummary }) {
  const notify = useToast();
  const queries = useQueryClient();
  const [service, setService] = useState(ticket.serviceId ?? '');
  const [order, setOrder] = useState(ticket.orderId ?? '');
  const [payment, setPayment] = useState(ticket.paymentId ?? '');
  const orNull = (value: string) => (value.trim() === '' ? null : value.trim());
  const save = useMutation({
    mutationFn: () =>
      setTicketLinks({
        ticketId: ticket.id,
        serviceId: orNull(service),
        orderId: orNull(order),
        paymentId: orNull(payment),
      }),
    onSuccess: ({ changed }) => {
      notify({
        tone: changed ? 'ok' : 'info',
        message: t(changed ? 'web.ticket_links_saved' : 'web.ticket_no_change'),
      });
      void queries.invalidateQueries({ queryKey: ['ticket', ticket.id] });
    },
  });
  return (
    <form
      className="toolbar"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <Field label={t('web.ticket_link_service')} htmlFor="ticket-link-service">
        <input
          id="ticket-link-service"
          dir="ltr"
          value={service}
          onChange={(e) => setService(e.target.value)}
        />
      </Field>
      <Field label={t('web.ticket_link_order')} htmlFor="ticket-link-order">
        <input
          id="ticket-link-order"
          dir="ltr"
          value={order}
          onChange={(e) => setOrder(e.target.value)}
        />
      </Field>
      <Field label={t('web.ticket_link_payment')} htmlFor="ticket-link-payment">
        <input
          id="ticket-link-payment"
          dir="ltr"
          value={payment}
          onChange={(e) => setPayment(e.target.value)}
        />
      </Field>
      <button type="submit" className="btn sm" disabled={save.isPending}>
        {t('web.ticket_links_save')}
      </button>
      {save.error !== null && <Banner tone="danger">{ticketFault(save.error)}</Banner>}
    </form>
  );
}

function TicketActionsCard({
  ticket,
  mayAssign,
  mayClose,
}: {
  ticket: TicketSummary;
  mayAssign: boolean;
  mayClose: boolean;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const viewer = useViewerId();
  const assignees = useQuery({
    queryKey: ['ticket-assignees'],
    queryFn: fetchTicketAssignees,
    enabled: mayAssign,
  });
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['ticket', ticket.id] });
    void queries.invalidateQueries({ queryKey: ['tickets'] });
  };
  const done = ({ changed }: { changed: boolean }) => {
    notify({
      tone: changed ? 'ok' : 'info',
      message: t(changed ? 'web.ticket_saved' : 'web.ticket_no_change'),
    });
    refresh();
  };
  const failed = (error: unknown) => {
    notify({ tone: 'danger', message: ticketFault(error) });
    refresh();
  };
  const status = useMutation({
    mutationFn: (to: TicketStatus) => setTicketStatus({ ticketId: ticket.id, status: to }),
    onSuccess: done,
    onError: failed,
  });
  const assign = useMutation({
    mutationFn: (adminId: string | null) => assignTicket({ ticketId: ticket.id, adminId }),
    onSuccess: done,
    onError: failed,
  });
  const priority = useMutation({
    mutationFn: (to: TicketPriority) => setTicketPriority({ ticketId: ticket.id, priority: to }),
    onSuccess: done,
    onError: failed,
  });

  // The edges the machine declares from where the ticket stands — the server decides again.
  const targets = TICKET_STATUSES.filter(
    (to) => to !== ticket.status && ticketManualEvent(ticket.status, to) !== null,
  );

  return (
    <Card title={t('web.ticket_actions')} hint={t('web.ticket_actions_hint')}>
      {mayClose && (
        <div className="btn-group">
          {targets.map((to) => (
            <button
              key={to}
              type="button"
              className={to === 'CLOSED' ? 'btn danger sm' : 'btn sm'}
              disabled={status.isPending}
              onClick={() => status.mutate(to)}
            >
              {ticket.status === 'CLOSED' ? t('web.ticket_action_reopen') : t(STATUS_ACTIONS[to])}
            </button>
          ))}
        </div>
      )}
      {mayAssign && (
        <>
          <Field label={t('web.ticket_assignee')} htmlFor="ticket-assignee">
            <select
              id="ticket-assignee"
              value={ticket.assignedAdminId ?? ''}
              disabled={assign.isPending}
              onChange={(event) =>
                assign.mutate(event.target.value === '' ? null : event.target.value)
              }
            >
              <option value="">{t('web.ticket_unassigned')}</option>
              {(assignees.data?.admins ?? []).map((admin) => (
                <option key={admin.id} value={admin.id}>
                  {admin.displayName} (@{admin.username})
                </option>
              ))}
            </select>
          </Field>
          {viewer !== null && viewer !== ticket.assignedAdminId && (
            <div className="btn-group">
              <button
                type="button"
                className="btn sm"
                disabled={assign.isPending}
                onClick={() => assign.mutate(viewer)}
              >
                {t('web.ticket_assign_me')}
              </button>
            </div>
          )}
          <Field label={t('web.ticket_priority')} htmlFor="ticket-priority">
            <select
              id="ticket-priority"
              value={ticket.priority}
              disabled={priority.isPending}
              onChange={(event) => priority.mutate(event.target.value as TicketPriority)}
            >
              {TICKET_PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {t(PRIORITY_LABELS[value])}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
    </Card>
  );
}

function TicketConversationCard({ messages }: { messages: readonly TicketMessageView[] }) {
  return (
    <Card title={t('web.ticket_conversation')} hint={t('web.ticket_conversation_hint')}>
      <ol className="ticket-thread">
        {messages.map((message) => (
          <TicketMessageItem key={message.id} message={message} />
        ))}
      </ol>
    </Card>
  );
}

function TicketMessageItem({ message }: { message: TicketMessageView }) {
  if (message.senderType === 'SYSTEM') {
    return (
      <li className="ticket-message system">
        <span className="muted small">
          {message.systemEvent === null ? '' : t(SYSTEM_LABELS[message.systemEvent])} ·{' '}
          {formatTimestamp(message.createdAt)}
        </span>
      </li>
    );
  }
  const support = message.senderType === 'ADMIN';
  return (
    <li className={`ticket-message ${support ? 'support' : 'customer'}`}>
      <div className="ticket-message-head">
        <strong>
          {support
            ? `${t('web.ticket_sender_support')}${message.authorAdminUsername === null ? '' : ` (@${message.authorAdminUsername})`}`
            : t('web.ticket_sender_customer')}
        </strong>
        <span className="muted small">{formatTimestamp(message.createdAt)}</span>
        {support &&
          (message.delivery === null ? (
            <Badge tone="neutral">{t('web.ticket_delivery_none')}</Badge>
          ) : (
            <Badge tone={DELIVERY_TONES[message.delivery]}>
              {t(DELIVERY_LABELS[message.delivery])}
            </Badge>
          ))}
      </div>
      {message.body !== null && <p className="ticket-body">{message.body}</p>}
      {message.attachment !== null && <TicketAttachment message={message} />}
    </li>
  );
}

/**
 * One attachment: what it is, and the control that fetches its bytes. The receipts' rule —
 * a PHOTO is shown as an image (the element decides; a script in an SVG does not run in an
 * `<img>`), and a DOCUMENT is a download whatever it claims to be.
 */
function TicketAttachment({ message }: { message: TicketMessageView }) {
  const attachment = message.attachment;
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(
    () => () => {
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    },
    [objectUrl],
  );
  const load = useMutation({
    mutationFn: () => fetchTicketAttachment(message.id),
    onSuccess: (blob) => {
      setFailed(false);
      setObjectUrl(
        URL.createObjectURL(
          new Blob([blob], {
            type: attachment?.kind === 'PHOTO' ? '' : 'application/octet-stream',
          }),
        ),
      );
    },
    onError: () => setFailed(true),
  });
  if (attachment === null) return null;
  const photo = attachment.kind === 'PHOTO';
  const size = attachment.fileSize === null ? null : splitBytes(BigInt(attachment.fileSize));
  return (
    <div className="receipt">
      <KV
        items={[
          [
            t('web.ticket_attachment'),
            t(photo ? 'web.ticket_attachment_photo' : 'web.ticket_attachment_document'),
          ],
          [t('web.ticket_attachment_name'), attachment.fileName ?? <Dash key="n" />],
          [
            t('web.ticket_attachment_size'),
            size === null ? <Dash key="s" /> : `${size.value} ${t(size.unit)}`,
          ],
        ]}
      />
      <div className="btn-group">
        <button
          type="button"
          className="btn sm"
          disabled={load.isPending}
          onClick={() => load.mutate()}
        >
          {t(photo ? 'web.ticket_attachment_view' : 'web.ticket_attachment_download')}
        </button>
      </div>
      {failed && <Banner tone="warn">{t('web.ticket_attachment_failed')}</Banner>}
      {objectUrl !== null &&
        (photo ? (
          <img className="receipt-image" src={objectUrl} alt={t('web.ticket_attachment_alt')} />
        ) : (
          <div className="btn-group">
            <a className="btn sm" href={objectUrl} download={attachment.fileName ?? message.id}>
              {t('web.ticket_attachment_save')}
            </a>
          </div>
        ))}
    </div>
  );
}

function TicketReplyCard({ ticket }: { ticket: TicketSummary }) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [text, setText] = useState('');
  const body = normalizeTicketText(text);
  const valid = body !== null && isTicketTextWithinBound(body);
  const reply = useMutation({
    mutationFn: (value: string) =>
      replyToTicket({
        ticketId: ticket.id,
        idempotencyKey: submission.current({ ticket: ticket.id, text: value }),
        text: value,
      }),
    onSuccess: () => {
      submission.settle();
      setText('');
      notify({ tone: 'ok', message: t('web.ticket_reply_sent') });
      void queries.invalidateQueries({ queryKey: ['ticket', ticket.id] });
      void queries.invalidateQueries({ queryKey: ['tickets'] });
    },
    // A 5xx may have committed: the retry keeps its key rather than replying twice.
    onError: (error) => submission.settleOn(error),
  });
  if (ticket.status === 'CLOSED') {
    return (
      <Card title={t('web.ticket_reply')}>
        <Banner tone="info">{t('web.ticket_reply_closed')}</Banner>
      </Card>
    );
  }
  return (
    <Card title={t('web.ticket_reply')} hint={t('web.ticket_reply_hint')}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (body !== null && valid) reply.mutate(body);
        }}
      >
        <Field
          label={t('web.ticket_reply_text')}
          hint={t('web.ticket_reply_limit')}
          htmlFor="ticket-reply-text"
        >
          <textarea
            id="ticket-reply-text"
            rows={5}
            value={text}
            maxLength={TICKET_MESSAGE_MAX_LENGTH * 2}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        <div className="btn-group">
          <button type="submit" className="btn primary sm" disabled={!valid || reply.isPending}>
            {t('web.ticket_reply_send')}
          </button>
        </div>
      </form>
      {reply.error !== null && <Banner tone="danger">{ticketFault(reply.error)}</Banner>}
    </Card>
  );
}
