import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CUSTOMER_BLOCK_REASON_MAX_LENGTH,
  TRIAL_ADMIN_REASON_MAX_LENGTH,
  WALLET_PAGE_DEFAULT,
  telegramUserIdSchema,
  type CustomerReferralResponse,
  type CustomerStatus,
  type CustomerSummaryResponse,
  type LedgerDirection,
  type OrderSummaryResponse,
  type ServiceSummaryResponse,
  type WalletEntrySummaryResponse,
} from '@nexa/contracts';
import {
  adjustWallet,
  blockCustomer,
  fetchCustomer,
  fetchCustomers,
  fetchOrders,
  fetchServices,
  fetchWallet,
  fetchWalletEntries,
  fetchCustomerTrial,
  fetchCustomerReferral,
  fetchCustomerReseller,
  removeTrialOverride,
  setTrialOverride,
  unblockCustomer,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { mayRequest, queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { setQueries, setQuery, useLinkHandler, type Route } from '../router';
import { messageFor } from './settings';
/*
 * The OTHER two screens' badge vocabularies, borrowed rather than copied.
 *
 * A second `REFUNDED: 'violet'` here would be a second answer to what an order
 * state looks like, and the two would drift the first time one of them gained a
 * state. `panels.tsx` borrows the product and service maps for the same reason.
 */
import { STATE_LABELS as ORDER_STATE_LABELS, STATE_TONES as ORDER_STATE_TONES } from './orders';
import {
  DELIVERY_LABELS as SERVICE_DELIVERY_LABELS,
  DELIVERY_TONES as SERVICE_DELIVERY_TONES,
  STATE_LABELS as SERVICE_STATE_LABELS,
  STATE_TONES as SERVICE_STATE_TONES,
} from './services';
import { PartyCell, TriggerBadge } from './referrals';
import { CreditLimitCell, OVERRIDE_LABELS, PricingText, ResellerStatusBadge } from './resellers';
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
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';

/**
 * Customers — the first product surface this codebase genuinely operates.
 *
 * What this page does NOT draw is as deliberate as what it does. There is no
 * discount and no reseller COLUMN on the list. Discounts are rules on their own
 * page, not a customer attribute; a reseller is a row of its own (WP9-B), drawn
 * as a card on the customer's detail page — a column on this list would be a
 * second read per row for a fact most customers do not have. A `0` for either
 * would be the legacy statistics screen counting configured panels as
 * connected.
 *
 * The clause above used to name SERVICES too, and had been false since 4D: the
 * detail page now draws this customer's orders and this customer's services,
 * each as a paged view of the very list `/orders` and `/services` page, filtered
 * by `customerId`. Neither is a count and neither is a "recent N" — see
 * `CustomerOrdersCard` for why that distinction is the whole design.
 *
 * The wallet IS drawn, as of 4C, and its balance is DERIVED — summed from the
 * ledger on every read. There is no stored balance for this page to disagree
 * with, which is the whole architecture rather than a rendering detail.
 *
 * Every column below renders a field the server actually sent, and
 * `customerSummarySchema` makes that structural rather than careful: a field
 * this page wanted and the server does not have would not typecheck.
 */

const STATUS_LABELS: Readonly<Record<CustomerStatus, WebKey>> = {
  ACTIVE: 'web.user_status_active',
  BLOCKED: 'web.user_status_blocked',
};

const STATUS_TONES: Readonly<Record<CustomerStatus, Tone>> = {
  ACTIVE: 'ok',
  BLOCKED: 'danger',
};

function StatusBadge({ status }: { status: CustomerStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{t(STATUS_LABELS[status])}</Badge>;
}

/** The display name, from the two parts Telegram gives, or nothing at all. */
function displayName(row: CustomerSummaryResponse): string | null {
  const joined = [row.firstName, row.lastName]
    .filter((part) => part !== null)
    .join(' ')
    .trim();
  return joined === '' ? null : joined;
}

function Dash() {
  return <span className="faint">—</span>;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function UsersPage({
  route,
  maySearch,
  denied,
}: {
  route: Route;
  /**
   * `users.search` — NOT `users.view`, which `denied` carries.
   *
   * The two are separate server permissions and the list is useful without the
   * second: an operator with `users.view` alone still gets every page.
   */
  maySearch: boolean;
  denied: boolean;
}) {
  const onLink = useLinkHandler();

  /*
   * The search lives in the URL; the draft lives in component state.
   *
   * In the URL because an operator answering a support message wants to reload
   * and link to the row they found, and because it is the only way this state
   * is reachable by anything driving the app by address — which includes the
   * visual harness. The draft is separate so typing does not issue a request
   * per keystroke against a permission the actor may not even hold.
   */
  const appliedTelegramId = route.query.get('telegramUserId') ?? '';
  const appliedUsername = route.query.get('username') ?? '';
  const appliedStatus = statusFromQuery(route.query.get('status'));

  /*
   * The draft FOLLOWS the applied values, derived rather than initialised.
   *
   * `useState(appliedTelegramId)` runs its initialiser once per mount, and the
   * sidebar's own «کاربران» link re-renders THIS component with an empty query
   * instead of remounting it. So after a search, clicking that link left the
   * inputs showing the old criteria over an unfiltered list, with the Clear
   * button disabled because nothing was applied any more — three things on the
   * screen disagreeing about what the operator had asked for.
   *
   * Compared rather than synchronised in an effect, the same shape the cursor
   * trail below uses: an effect would render one frame of the stale draft first,
   * and React's own guidance is to derive during render. The signature covers the
   * two URL values the form owns and NOT the status, so changing the status
   * dropdown does not wipe a half-typed username.
   */
  const appliedSignature = [appliedTelegramId, appliedUsername].join('|');
  const [draft, setDraft] = useState<{
    signature: string;
    telegramId: string;
    username: string;
  }>({ signature: appliedSignature, telegramId: appliedTelegramId, username: appliedUsername });
  const fresh = draft.signature === appliedSignature;
  const draftTelegramId = fresh ? draft.telegramId : appliedTelegramId;
  const draftUsername = fresh ? draft.username : appliedUsername;
  const setDraftTelegramId = (value: string) =>
    setDraft({ signature: appliedSignature, telegramId: value, username: draftUsername });
  const setDraftUsername = (value: string) =>
    setDraft({ signature: appliedSignature, telegramId: draftTelegramId, username: value });

  /*
   * The cursor stack, and the SEARCH it belongs to.
   *
   * Keyset paging goes forward on its own and can only go back to a cursor it
   * has already held, so each page's starting cursor is pushed and popped. The
   * search is stored WITH the trail for the reason `/panels` stores its mode:
   * the sidebar's own «کاربران» link navigates to `/users` and drops the query
   * while re-rendering this same component, so a trail cleared only inside the
   * form's submit handler would survive into a different list — and a cursor
   * minted under one filter strands every row before it under another, silently.
   */
  /*
   * Joined on `|`, which cannot appear in any of the three parts.
   *
   * A Telegram id is digits, a Telegram username is `[A-Za-z0-9_]`, and the status is
   * one of two literals, so no two different searches can produce the same signature.
   * An EMPTY separator could: a username of `1` with no id and an id of `1` with no
   * username would both be the string `1`, sharing a query key and a cursor trail, and
   * the page would serve one search's cached rows under the other's heading.
   *
   * This was a literal U+001F until the self-review. It WORKED — a unit separator cannot
   * appear in any part either — and it was invisible in every tool that reads the source,
   * which is the argument against it: a separator nobody can see in a grep, a diff or a
   * review is a separator nobody checks. `users.test.tsx` now asserts the behaviour the
   * string exists for, so neither spelling has to be trusted.
   */
  const searchSignature = [appliedTelegramId, appliedUsername, appliedStatus ?? ''].join('|');
  const [trail, setTrail] = useState<{ signature: string; cursors: readonly string[] }>({
    signature: searchSignature,
    cursors: [],
  });
  const cursors = trail.signature === searchSignature ? trail.cursors : [];
  const cursor = cursors.length > 0 ? cursors[cursors.length - 1] : undefined;
  const pushCursor = (next: string) =>
    setTrail({ signature: searchSignature, cursors: [...cursors, next] });
  const popCursor = () => setTrail({ signature: searchSignature, cursors: cursors.slice(0, -1) });

  /*
   * The Telegram id is checked against the CONTRACT's own schema before it is
   * applied, not after the server refuses it.
   *
   * `telegramUserIdSchema` is the same regex the service parses with, so there
   * is exactly one definition of what a Telegram id is. Checked here because
   * the server's refusal for a malformed one is a 400 that an operator would
   * read as "no such customer" — a different and false answer.
   */
  const telegramIdProblem =
    draftTelegramId !== '' && !telegramUserIdSchema.safeParse(draftTelegramId).success
      ? t('web.users_search_invalid_telegram')
      : undefined;

  /*
   * Two predicates, because they answer different questions.
   *
   * `searching` is about the ROWS — whether the empty state should read "nothing
   * matched your search" or "no customers yet" — so it is the applied URL and
   * nothing else. `clearable` is about the FORM: there is something to clear if
   * either the URL carries a filter or the inputs hold text. Folding them left
   * Clear disabled over inputs full of text nobody could empty by button.
   */
  const searching = appliedTelegramId !== '' || appliedUsername !== '';
  const clearable = searching || draftTelegramId !== '' || draftUsername !== '';

  const customers = useQuery({
    // The search is part of the key. Sharing one key across filters would serve
    // the previous result under the new heading for a frame, which is the sort
    // of thing an operator acts on before it corrects itself.
    queryKey: ['customers', searchSignature, cursor ?? null],
    queryFn: () =>
      fetchCustomers({
        ...(cursor === undefined ? {} : { cursor }),
        ...(appliedTelegramId === '' ? {} : { telegramUserId: appliedTelegramId }),
        ...(appliedUsername === '' ? {} : { username: appliedUsername }),
        ...(appliedStatus === null ? {} : { status: appliedStatus }),
      }),
    enabled: !denied,
  });

  const rows = customers.data?.customers ?? [];
  const nextCursor = customers.data?.nextCursor ?? null;

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (telegramIdProblem !== undefined) return;
    // ONE navigation for both fields. Two `setQuery` calls here dropped the first:
    // each builds from the `route.query` prop this render captured. See `setQueries`.
    setQueries(route, [
      ['telegramUserId', draftTelegramId === '' ? null : draftTelegramId],
      ['username', draftUsername === '' ? null : draftUsername],
    ]);
  };

  const clear = () => {
    // Both, because the two can differ: the URL may already be empty while the
    // inputs hold text the operator typed and never applied. Clearing the URL
    // alone would leave that text on screen, and clearing the draft alone would
    // leave the filter applied.
    setDraft({ signature: appliedSignature, telegramId: '', username: '' });
    setQueries(route, [
      ['telegramUserId', null],
      ['username', null],
    ]);
  };

  const columns: readonly Column<CustomerSummaryResponse>[] = [
    {
      key: 'telegram',
      header: t('web.user_telegram_id'),
      render: (row) => (
        <a href={`/users/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
          {/* LTR and monospaced: a numeric identifier inside a right-to-left
              page, whose digits a bidi-neutral rendering reorders against the
              surrounding text. */}
          <Ltr>{row.telegramUserId}</Ltr>
        </a>
      ),
    },
    {
      key: 'username',
      header: t('web.user_username'),
      render: (row) =>
        row.username === null ? <Dash /> : <Ltr mono={false}>{`@${row.username}`}</Ltr>,
    },
    {
      key: 'name',
      header: t('web.user_name'),
      render: (row) => {
        const name = displayName(row);
        return name === null ? <Dash /> : <span>{name}</span>;
      },
    },
    {
      key: 'status',
      header: t('web.status'),
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'firstSeen',
      header: t('web.user_first_seen'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.firstSeenAt)}</span>,
    },
    {
      key: 'lastSeen',
      header: t('web.user_last_seen'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.lastSeenAt)}</span>,
    },
  ];

  return (
    <>
      <PageHead title={t('web.users_title')} subtitle={t('web.users_intro')} maturity="now" />

      <Card>
        {/*
          The toolbar is hidden while the card below cannot answer — the rule the
          panels toolbar and the alerts toolbar follow: a control that mints a
          new query key is a fresh request against a question the server has
          just refused.
        */}
        <div hidden={!mayRequest(customers, denied)}>
          {maySearch ? (
            <form className="toolbar" onSubmit={apply}>
              <Field
                label={t('web.users_search_telegram')}
                hint={t('web.users_search_telegram_hint')}
                htmlFor="users-telegram-id"
                {...(telegramIdProblem === undefined ? {} : { error: telegramIdProblem })}
              >
                <input
                  id="users-telegram-id"
                  dir="ltr"
                  inputMode="numeric"
                  value={draftTelegramId}
                  onChange={(event) => setDraftTelegramId(event.target.value.trim())}
                />
              </Field>
              <Field
                label={t('web.users_search_username')}
                hint={t('web.users_search_username_hint')}
                htmlFor="users-username"
              >
                <input
                  id="users-username"
                  dir="ltr"
                  value={draftUsername}
                  onChange={(event) => setDraftUsername(event.target.value.trim())}
                />
              </Field>
              <button
                type="submit"
                className="btn primary sm"
                disabled={telegramIdProblem !== undefined}
              >
                {t('web.users_search_apply')}
              </button>
              <button type="button" className="btn sm" onClick={clear} disabled={!clearable}>
                {t('web.users_search_clear')}
              </button>
            </form>
          ) : (
            /*
              No search form for an actor without `users.search`, and a sentence
              rather than a disabled box.

              The server refuses the search and serves the list, so this is not
              the UI inventing a boundary: it states the one that exists, and
              names the permission. A disabled input would say "this exists and
              you lack permission" without saying which permission, which is the
              half an operator needs in order to ask for it.
            */
            <Banner tone="info">{t('web.users_search_denied')}</Banner>
          )}

          {/*
            The status filter is NOT gated on `users.search`.

            The server charges `users.search` for a Telegram-id or username
            lookup and not for a status filter — narrowing a tenant's own list to
            the blocked half is the same question the unfiltered list answers.
            Gating it here would hide a capability the server permits, which is
            the defect the navigation's own permission rule was written for.
          */}
          <div className="toolbar">
            <Pills
              value={appliedStatus ?? 'ALL'}
              onChange={(next) => setQuery(route, 'status', next === 'ALL' ? null : next)}
              items={[
                { id: 'ALL' as const, label: t('web.users_filter_all') },
                { id: 'ACTIVE' as const, label: t('web.user_status_active') },
                { id: 'BLOCKED' as const, label: t('web.user_status_blocked') },
              ]}
            />
          </div>
        </div>

        <StateSwitch
          query={customers}
          denied={denied}
          isEmpty={rows.length === 0}
          empty={
            searching ? (
              <Empty
                title={t('web.users_search_empty')}
                hint={t('web.users_search_empty_hint')}
                icon="inbox"
              />
            ) : (
              <Empty title={t('web.users_empty')} hint={t('web.users_empty_hint')} icon="users" />
            )
          }
        >
          <DataTable
            caption={t('web.users_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
          />
        </StateSwitch>

        {/* A sibling of `StateSwitch`, so it must not claim rows the error card
            replaced — see the panels pager for the defect this shape fixes. */}
        {!denied && queryState(customers) === 'ready' && (
          <CursorPager
            shown={rows.length}
            hasPrevious={cursors.length > 0}
            hasNext={nextCursor !== null}
            onPrevious={popCursor}
            onNext={() => nextCursor !== null && pushCursor(nextCursor)}
            // `GET /users` pages an ASCENDING keyset — the earliest customer
            // first, `nextCursor` toward newer ones — so "next" is NEWER here.
            // The default labels belong to the descending lists and read
            // backwards on this one.
            nextLabel="web.newer"
            previousLabel="web.older"
          />
        )}
      </Card>

      <Card title={t('web.users_scope_title')}>
        <p className="muted">{t('web.users_scope_body')}</p>
      </Card>
    </>
  );
}

function statusFromQuery(raw: string | null): CustomerStatus | null {
  return raw === 'ACTIVE' || raw === 'BLOCKED' ? raw : null;
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function UserDetailPage({
  id,
  mayBlock,
  mayViewWallet,
  mayCredit,
  mayDebit,
  mayViewOrders,
  mayViewServices,
  mayEditTrial,
  mayViewReferrals,
  mayViewReseller,
  mayEditReseller,
  denied,
}: {
  id: string;
  mayBlock: boolean;
  /** `users.trial.edit`: set or remove this customer's custom trial limit (WP6-B). */
  mayEditTrial: boolean;
  mayViewWallet: boolean;
  mayCredit: boolean;
  mayDebit: boolean;
  /*
   * `orders.view` and `services.view`, passed separately and never derived.
   *
   * They are not implied by `users.view`: a role that may read customers need
   * not be a role that may read what they bought or what runs on a panel for
   * them. Each card draws a denial sentence naming its own key, and the server
   * charges it regardless — the missing card is a courtesy, never the
   * enforcement.
   */
  mayViewOrders: boolean;
  mayViewServices: boolean;
  /** `referrals.view` (WP9-A): its own grant, never implied by `users.view`. */
  mayViewReferrals: boolean;
  /** `resellers.view` (WP9-B): whether this customer is a reseller, and on what terms. */
  mayViewReseller: boolean;
  /** `resellers.edit`: offer the link that registers this customer as a reseller. */
  mayEditReseller: boolean;
  denied: boolean;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [reason, setReason] = useState('');
  /*
   * Two steps, never one click (WP10G, closing OQ-WP10F-03). Step one chooses the direction;
   * step two is the confirmation panel — with the MANDATORY reason for a block, a plain
   * confirmation for an unblock — and only its confirm button sends anything. The server holds
   * the rule (a block without a reason is a 400); the disabled button is the courtesy.
   */
  const [pending, setPending] = useState<'BLOCK' | 'UNBLOCK' | null>(null);
  const trimmedReason = reason.trim();
  // Counted in code points, as the server counts it: a DOM `maxLength` counts UTF-16 units and
  // would stop an operator at 250 emoji of a 500-character reason (Codex review of PR #74).
  const reasonTooLong = Array.from(trimmedReason).length > CUSTOMER_BLOCK_REASON_MAX_LENGTH;

  const customer = useQuery({
    queryKey: ['customer', id],
    queryFn: () => fetchCustomer(id),
    enabled: !denied,
  });
  const row = customer.data?.customer;

  const mutate = useMutation({
    mutationFn: (input: { to: CustomerStatus; reason: string }) => {
      // The payload is the fingerprint the held key is bound to, so editing the
      // reason and pressing again is a NEW command rather than a replay the
      // store would refuse as a payload mismatch. See `useSubmissionKey`.
      const idempotencyKey = submission.current({ id, to: input.to, reason: input.reason });
      // A block carries its reason, always; an unblock carries none — the server clears the
      // stored one, and a note typed into an unblock would only reach the audit row.
      return input.to === 'BLOCKED'
        ? blockCustomer({ id, idempotencyKey, reason: input.reason })
        : unblockCustomer({ id, idempotencyKey });
    },
    onSuccess: (response, variables) => {
      submission.settle();
      notify({
        tone: 'ok',
        message:
          variables.to === 'BLOCKED' ? t('web.user_blocked_done') : t('web.user_unblocked_done'),
      });
      setReason('');
      setPending(null);
      // The server's own answer, written straight into the cache: the response
      // carries the row as it now is. The list is invalidated rather than
      // patched, because a status change moves a row between the two status
      // filters and this page does not know which one is open behind it.
      queries.setQueryData(['customer', id], response);
      void queries.invalidateQueries({ queryKey: ['customers'] });
    },
    /*
     * `settleOn`, not `settle`.
     *
     * A 4xx is an answer and the next press is a new question, so the key is
     * retired. A 5xx or a dropped connection is NOT: the write may have
     * committed, and a fresh key on the retry would be a second command. Here
     * that would be a second audit row and a second outbox event for one
     * operator decision.
     */
    onError: (error) => submission.settleOn(error),
  });

  return (
    <>
      <PageHead
        title={t('web.user_detail')}
        {...(row === undefined ? {} : { subtitle: row.telegramUserId })}
        maturity="now"
      />

      <StateSwitch query={customer} denied={denied}>
        {row === undefined ? null : (
          <>
            {row.status === 'BLOCKED' && (
              <Banner tone="danger" title={t('web.user_blocked_banner_title')}>
                {t('web.user_blocked_banner_body')}
              </Banner>
            )}

            <Card title={t('web.user_identity_title')}>
              <KV
                items={[
                  [t('web.user_telegram_id'), <Copyable key="tg" value={row.telegramUserId} />],
                  [
                    t('web.user_username'),
                    row.username === null ? (
                      <Dash key="u" />
                    ) : (
                      <Ltr key="u" mono={false}>{`@${row.username}`}</Ltr>
                    ),
                  ],
                  [t('web.user_name'), displayName(row) ?? <Dash key="n" />],
                  [
                    t('web.user_language'),
                    row.languageCode === null ? (
                      <Dash key="l" />
                    ) : (
                      <Ltr key="l" mono={false}>
                        {row.languageCode}
                      </Ltr>
                    ),
                  ],
                  [t('web.user_first_seen'), formatTimestamp(row.firstSeenAt)],
                  [t('web.user_last_seen'), formatTimestamp(row.lastSeenAt)],
                ]}
              />
            </Card>

            <Card title={t('web.user_access_title')}>
              <KV
                items={[
                  [t('web.status'), <StatusBadge key="s" status={row.status} />],
                  [
                    t('web.user_blocked_at'),
                    row.blockedAt === null ? <Dash key="b" /> : formatTimestamp(row.blockedAt),
                  ],
                  [
                    t('web.user_blocked_reason'),
                    row.blockedReason === null ? <Dash key="r" /> : row.blockedReason,
                  ],
                  ...(row.status === 'BLOCKED' && row.blockedReason !== null
                    ? ([
                        [
                          t('web.user_blocked_reason_shown'),
                          row.blockedReasonShown
                            ? t('web.user_blocked_reason_shown_yes')
                            : t('web.user_blocked_reason_shown_no'),
                        ],
                      ] as [ReactNode, ReactNode][])
                    : []),
                ]}
              />

              {mayBlock ? (
                <>
                  {pending === null && (
                    <div className="toolbar">
                      {row.status === 'ACTIVE' ? (
                        <button
                          type="button"
                          className="btn danger sm"
                          disabled={mutate.isPending}
                          onClick={() => setPending('BLOCK')}
                        >
                          {t('web.user_block')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn primary sm"
                          disabled={mutate.isPending}
                          onClick={() => setPending('UNBLOCK')}
                        >
                          {t('web.user_unblock')}
                        </button>
                      )}
                    </div>
                  )}
                  {pending === 'BLOCK' && (
                    <>
                      <Banner tone="warn" title={t('web.user_block_confirm_title')}>
                        {t('web.user_block_confirm_body')}
                      </Banner>
                      <Field
                        label={t('web.user_block_reason_label')}
                        hint={t('web.user_block_reason_hint')}
                        htmlFor="user-block-reason"
                        {...(reason !== '' && trimmedReason === ''
                          ? { error: t('web.user_block_reason_required') }
                          : reasonTooLong
                            ? { error: t('web.user_block_reason_too_long') }
                            : {})}
                      >
                        <input
                          id="user-block-reason"
                          value={reason}
                          onChange={(event) => setReason(event.target.value)}
                        />
                      </Field>
                      <div className="toolbar">
                        <button
                          type="button"
                          className="btn danger sm"
                          disabled={mutate.isPending || trimmedReason === '' || reasonTooLong}
                          onClick={() => mutate.mutate({ to: 'BLOCKED', reason: trimmedReason })}
                        >
                          {t('web.user_block_confirm')}
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={mutate.isPending}
                          onClick={() => {
                            setPending(null);
                            setReason('');
                          }}
                        >
                          {t('web.user_action_cancel')}
                        </button>
                      </div>
                    </>
                  )}
                  {pending === 'UNBLOCK' && (
                    <>
                      <Banner tone="warn" title={t('web.user_unblock_confirm_title')}>
                        {t('web.user_unblock_confirm_body')}
                      </Banner>
                      <div className="toolbar">
                        <button
                          type="button"
                          className="btn primary sm"
                          disabled={mutate.isPending}
                          onClick={() => mutate.mutate({ to: 'ACTIVE', reason: '' })}
                        >
                          {t('web.user_unblock_confirm')}
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={mutate.isPending}
                          onClick={() => setPending(null)}
                        >
                          {t('web.user_action_cancel')}
                        </button>
                      </div>
                    </>
                  )}
                  {mutate.error !== null && (
                    <Banner tone="danger">{messageFor(mutate.error)}</Banner>
                  )}
                </>
              ) : (
                // No disabled button. A disabled control and this sentence make
                // the same claim, and only one of them names the permission.
                <Banner tone="info">{t('web.user_block_denied')}</Banner>
              )}
            </Card>

            <TrialCard customerId={id} mayEdit={mayEditTrial} />

            <ResellerCard
              customerId={id}
              telegramUserId={row.telegramUserId}
              mayView={mayViewReseller}
              mayEdit={mayEditReseller}
            />

            <WalletCard
              customerId={id}
              mayView={mayViewWallet}
              mayCredit={mayCredit}
              mayDebit={mayDebit}
            />

            <CustomerOrdersCard customerId={id} mayView={mayViewOrders} />

            <CustomerServicesCard customerId={id} mayView={mayViewServices} />

            <CustomerReferralCard customerId={id} mayView={mayViewReferrals} />

            <Card title={t('web.users_scope_title')}>
              <p className="muted">{t('web.users_scope_body')}</p>
            </Card>
          </>
        )}
      </StateSwitch>
    </>
  );
}

// ---------------------------------------------------------------------------
// This customer's orders and services
// ---------------------------------------------------------------------------

/**
 * How many rows either embedded list shows at a time.
 *
 * Smaller than the top-level screens' 25, because this is one card among five on
 * a detail page rather than the whole screen. The pager makes the bound
 * honest — an operator can always reach the next page — which is what a bounded
 * list owes and a "recent N" with no pager does not.
 */
const EMBEDDED_PAGE = 10;

/**
 * The cursor trail both embedded cards page with.
 *
 * A single `cursor` was the first version, reset to null on Previous — which is what
 * `WalletCard` and `/services` do, and what a Codex round on this PR named: after two
 * advances, Previous jumped from page three straight to page one and page two could not
 * be reached at all. The button says "the adjacent page" in both vocabularies —
 * «تازه‌تر» on the ascending card and «قدیمی‌تر» on the descending one — so delivering
 * the FIRST page is a control that does something other than what it is labelled, which
 * is the class of thing this codebase refuses everywhere else.
 *
 * So it keeps the stack `OrdersPage` keeps, and Previous pops one. There is no filter
 * signature to key it on, unlike `OrdersPage`: an embedded card is pinned to one
 * customer for its whole life, and the page is keyed by that customer's id at the route,
 * so a different customer is a different component instance with an empty trail.
 */
function useCursorTrail(): {
  readonly cursor: string | undefined;
  readonly hasPrevious: boolean;
  readonly back: () => void;
  readonly forward: (next: string | null) => void;
} {
  const [trail, setTrail] = useState<readonly string[]>([]);
  return {
    cursor: trail.length > 0 ? trail[trail.length - 1] : undefined,
    hasPrevious: trail.length > 0,
    back: () => setTrail((current) => current.slice(0, -1)),
    /*
     * A null next cursor pushes NOTHING.
     *
     * `CursorPager` disables the button when there is no next page, so this is
     * unreachable through the UI — and it is guarded anyway, because pushing a
     * placeholder would make Previous pop a page that was never visited.
     */
    forward: (next) => {
      if (next !== null) setTrail((current) => [...current, next]);
    },
  };
}

/**
 * This customer's orders.
 *
 * ## Why this is a paged list and not a count or a "latest five"
 *
 * A count would be a number this page computes from a page of rows, and there is
 * no endpoint that returns one — inventing it from `items.length` is the legacy
 * statistics screen, which counted configured panels as connected. A "latest
 * five" would be worse: `/orders` pages ASCENDING, oldest first, and a card
 * labelled "latest" over the first page of an ascending traversal shows a
 * customer's FIRST five orders while claiming they are their last. The
 * divergence is deliberate (`drizzle-service.repository.ts` records the owner's
 * decision that `/users`, `/orders` and `/products` page one way and
 * `/services` the other), so the card states the direction in words and hands
 * the pager the same swapped labels `/orders` uses.
 *
 * ## It calls the same endpoint the screen calls
 *
 * `GET /orders?customerId=…` — the filter has existed since 4B and is charged
 * `orders.view` inside `OrderService.list`, so this card adds no read path and
 * no new authorization surface. The "all orders" link below opens the same
 * query on the full screen, which is where the state filter and the pager trail
 * live.
 */
function CustomerOrdersCard({ customerId, mayView }: { customerId: string; mayView: boolean }) {
  const onLink = useLinkHandler();
  const pages = useCursorTrail();

  const orders = useQuery({
    queryKey: ['customer-orders', customerId, pages.cursor ?? null],
    queryFn: () =>
      fetchOrders({
        customerId,
        limit: EMBEDDED_PAGE,
        ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }),
      }),
    enabled: mayView,
  });

  if (!mayView) {
    return (
      <Card title={t('web.user_orders_title')}>
        <Banner tone="info">{t('web.user_orders_denied')}</Banner>
      </Card>
    );
  }

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
    {
      key: 'state',
      header: t('web.status'),
      render: (row) => (
        <Badge tone={ORDER_STATE_TONES[row.state]}>{t(ORDER_STATE_LABELS[row.state])}</Badge>
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

  return (
    <Card title={t('web.user_orders_title')}>
      <StateSwitch query={orders}>
        {orders.data === undefined ? null : orders.data.orders.length === 0 ? (
          <Empty title={t('web.user_orders_empty')} />
        ) : (
          <>
            <DataTable
              caption={t('web.user_orders_title')}
              columns={columns}
              rows={orders.data.orders}
              rowKey={(row) => row.id}
            />
            {/*
              The labels are SWAPPED, exactly as on `/orders`.
              `nextCursor` walks towards newer rows here, so the button that
              fetches it says "newer". Leaving the defaults on an ascending
              traversal is the defect `services.tsx` warns about in reverse.
            */}
            <CursorPager
              shown={orders.data.orders.length}
              hasPrevious={pages.hasPrevious}
              hasNext={orders.data.nextCursor !== null}
              onPrevious={pages.back}
              onNext={() => pages.forward(orders.data?.nextCursor ?? null)}
              nextLabel="web.newer"
              previousLabel="web.older"
            />
          </>
        )}
      </StateSwitch>
      <p className="muted">{t('web.user_orders_hint')}</p>
      <a href={`/orders?customerId=${encodeURIComponent(customerId)}`} onClick={onLink}>
        {t('web.user_orders_all')}
      </a>
    </Card>
  );
}

/**
 * This customer's services.
 *
 * The same shape as the orders card and the same reasoning, with one difference
 * that matters: `/services` pages DESCENDING, so the pager keeps its default
 * labels and the hint says newest-first. The two cards sit one above the other
 * with pagers whose buttons mean opposite things, which is precisely why each
 * one says which way it goes rather than leaving it to be inferred.
 *
 * Two columns and not one, because `state` and `deliveryState` are two facts:
 * a provisioned account whose Telegram message bounced is `ACTIVE` and `FAILED`,
 * and a card that merged them would show it as unprovisioned — for which the
 * obvious remedy is to provision it again, on somebody's panel, a second time.
 * `services.tsx` states the rule; this card obeys it rather than restating it.
 *
 * No subscription link and no masked stand-in: `serviceSummarySchema` does not
 * carry `subscriptionUrl`, `subscriptionRef` or `providerClientId`, so there is
 * nothing here to leak and no edit to this file that could start leaking one.
 */
function CustomerServicesCard({ customerId, mayView }: { customerId: string; mayView: boolean }) {
  const onLink = useLinkHandler();
  const pages = useCursorTrail();

  const services = useQuery({
    queryKey: ['customer-services', customerId, pages.cursor ?? null],
    queryFn: () =>
      fetchServices({
        customerId,
        limit: EMBEDDED_PAGE,
        ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }),
      }),
    enabled: mayView,
  });

  if (!mayView) {
    return (
      <Card title={t('web.user_services_title')}>
        <Banner tone="info">{t('web.user_services_denied')}</Banner>
      </Card>
    );
  }

  const columns: readonly Column<ServiceSummaryResponse>[] = [
    {
      key: 'username',
      header: t('web.service_username'),
      render: (row) => (
        <a href={`/services/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
          <Ltr>{row.providerUsername}</Ltr>
        </a>
      ),
    },
    {
      key: 'state',
      header: t('web.service_state'),
      render: (row) => (
        <Badge tone={SERVICE_STATE_TONES[row.state]}>{t(SERVICE_STATE_LABELS[row.state])}</Badge>
      ),
    },
    {
      key: 'delivery',
      header: t('web.service_delivery'),
      render: (row) => (
        <Badge tone={SERVICE_DELIVERY_TONES[row.deliveryState]}>
          {t(SERVICE_DELIVERY_LABELS[row.deliveryState])}
        </Badge>
      ),
    },
    {
      key: 'expires',
      header: t('web.service_expires_at'),
      render: (row) =>
        row.expiresAt === null ? (
          <Dash />
        ) : (
          <span className="nowrap">{formatTimestamp(row.expiresAt)}</span>
        ),
    },
  ];

  return (
    <Card title={t('web.user_services_title')}>
      <StateSwitch query={services}>
        {services.data === undefined ? null : services.data.services.length === 0 ? (
          <Empty title={t('web.user_services_empty')} />
        ) : (
          <>
            <DataTable
              caption={t('web.user_services_title')}
              columns={columns}
              rows={services.data.services}
              rowKey={(row) => row.id}
            />
            {/* Default labels: this traversal runs newest to oldest. */}
            <CursorPager
              shown={services.data.services.length}
              hasPrevious={pages.hasPrevious}
              hasNext={services.data.nextCursor !== null}
              onPrevious={pages.back}
              onNext={() => pages.forward(services.data?.nextCursor ?? null)}
            />
          </>
        )}
      </StateSwitch>
      <p className="muted">{t('web.user_services_hint')}</p>
      <a href={`/services?customerId=${encodeURIComponent(customerId)}`} onClick={onLink}>
        {t('web.user_services_all')}
      </a>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

const DIRECTION_LABELS: Readonly<Record<LedgerDirection, WebKey>> = {
  CREDIT: 'web.wallet_direction_credit',
  DEBIT: 'web.wallet_direction_debit',
};

const DIRECTION_TONES: Readonly<Record<LedgerDirection, Tone>> = {
  CREDIT: 'ok',
  DEBIT: 'warn',
};

/**
 * A customer's wallet: the derived balance, the ledger, and one way to move it.
 *
 * Three things this card deliberately does NOT offer, each of which the legacy
 * system did:
 *
 * - **No balance field to type into.** The number shown is summed from the entries
 *   below it on every read. `صفر کردن موجودی` — "zero the balance" — is a
 *   set-balance in disguise, and there is no ledger reason that could honestly
 *   describe it.
 * - **No edit and no delete on a row.** The ledger is append-only, enforced by
 *   triggers, and the copy says so rather than leaving an operator to discover it
 *   from a failed request. Correcting a mistake is a NEW entry in the other
 *   direction, which is what leaves both facts in the history.
 * - **No reason picker.** The server derives the reason from the direction, so a
 *   request cannot file a debit as a `PURCHASE` — a movement that would then read,
 *   for ever, as a customer having bought something.
 *
 * CREDIT and DEBIT are separate permissions with different risk labels, and this
 * draws them separately: an operator who may credit and not debit sees one button.
 * The service charges both itself — the missing button is a courtesy, never the
 * enforcement.
 */
function WalletCard({
  customerId,
  mayView,
  mayCredit,
  mayDebit,
}: {
  customerId: string;
  mayView: boolean;
  mayCredit: boolean;
  mayDebit: boolean;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [cursor, setCursor] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  const wallet = useQuery({
    queryKey: ['wallet', customerId],
    queryFn: () => fetchWallet(customerId),
    enabled: mayView,
  });
  /*
   * Whether an adjustment can name a currency yet.
   *
   * The balance response carries the denomination every movement is made in, so an
   * operator may not submit one before it has arrived — the amount would travel under
   * a guess. The fieldset below reads this.
   */
  const walletReady = wallet.data !== undefined;
  const entries = useQuery({
    queryKey: ['wallet-entries', customerId, cursor],
    queryFn: () =>
      fetchWalletEntries(customerId, {
        limit: WALLET_PAGE_DEFAULT,
        ...(cursor === null ? {} : { cursor }),
      }),
    enabled: mayView,
  });

  const adjust = useMutation({
    mutationFn: (input: { direction: LedgerDirection }) => {
      /*
       * The key is bound to the PAYLOAD, so editing the amount and pressing again
       * is a new command rather than a replay the store would refuse as a mismatch.
       * Pressing the same button twice with the same figures is a replay, and the
       * server answers with the entry it already wrote. See `useSubmissionKey`.
       */
      /*
       * The currency comes from the LOADED balance and there is no fallback.
       *
       * There used to be `?? 'IRT'`, which is wrong twice over on an installation that
       * sells in IRR: the request carried a currency the operator never chose, and the
       * server refused a correctly entered credit with `wallet_currency_unsupported`.
       * The form is disabled until the balance resolves (see the fieldset below), so
       * this is unreachable — and it throws rather than guessing, because guessing a
       * denomination is how an amount travels without its currency.
       */
      const currency = wallet.data?.wallet.currency;
      if (currency === undefined) {
        throw new Error('The wallet balance has not loaded, so its currency is unknown.');
      }
      /*
       * The CURRENCY is part of the fingerprint too.
       *
       * The server hashes it into the request, so a key presented first with one
       * currency and then another is `platform.idempotency_payload_mismatch` — which
       * is what `useSubmissionKey` exists to avoid. Leaving it out made the two
       * fingerprints disagree about what the command was.
       */
      /*
       * The fingerprint is built from the NORMALISED body — the exact bytes sent.
       *
       * It used to hash the raw field state while the request below trimmed both
       * strings, so `«۱۰۰ »` and `«۱۰۰»` minted two different keys for one
       * server-visible command. After a 5xx or a dropped connection that had in fact
       * committed, a retry that differed only in whitespace arrived under a new key
       * and appended a SECOND credit or debit — which is the duplicate movement
       * `useSubmissionKey` exists to make impossible.
       *
       * So the trimming happens once, here, and both the key and the request read the
       * same values.
       */
      const body = {
        customerId,
        direction: input.direction,
        // A decimal STRING in minor units, straight through. Never parsed to a
        // `number` here: JSON has one numeric type and it rounds past 2^53.
        amount: amount.trim(),
        currency,
        note: note.trim(),
      } as const;
      return adjustWallet({ ...body, idempotencyKey: submission.current(body) });
    },
    onSuccess: (_response, variables) => {
      submission.settle();
      notify({
        tone: 'ok',
        message:
          variables.direction === 'CREDIT'
            ? t('web.wallet_credit_done')
            : t('web.wallet_debit_done'),
      });
      setAmount('');
      setNote('');
      // Both are re-read rather than patched: the balance is DERIVED, so a client
      // that adjusted its own copy would be inventing the one number this whole
      // design exists to keep computed.
      void queries.invalidateQueries({ queryKey: ['wallet', customerId] });
      void queries.invalidateQueries({ queryKey: ['wallet-entries', customerId] });
    },
    // `settleOn`: a 4xx is an answer and the next press is a new question; a 5xx or
    // a dropped connection may have committed, and a fresh key on the retry would
    // be a SECOND movement of somebody's money.
    onError: (error) => submission.settleOn(error),
  });

  if (!mayView) {
    return (
      <Card title={t('web.wallet_title')}>
        <Banner tone="info">{t('web.wallet_denied')}</Banner>
      </Card>
    );
  }

  const columns: Column<WalletEntrySummaryResponse>[] = [
    {
      key: 'direction',
      header: t('web.wallet_direction'),
      render: (row) => (
        <Badge tone={DIRECTION_TONES[row.direction]}>{t(DIRECTION_LABELS[row.direction])}</Badge>
      ),
    },
    {
      key: 'amount',
      header: t('web.wallet_balance'),
      // Positive, always, with the sign carried by the direction beside it — the
      // ledger's own shape, preserved to the screen.
      render: (row) => <Money value={{ amountMinor: row.amount, currency: row.currency }} />,
    },
    { key: 'reason', header: t('web.wallet_reason'), render: (row) => row.reason },
    {
      key: 'actor',
      header: t('web.wallet_actor'),
      render: (row) =>
        row.actorAdminId === null ? (
          <span className="faint">{t('web.wallet_actor_system')}</span>
        ) : (
          <Copyable value={row.actorAdminId} />
        ),
    },
    {
      key: 'note',
      header: t('web.wallet_note'),
      render: (row) => (row.note === null ? <Dash /> : row.note),
    },
    {
      key: 'createdAt',
      header: t('web.wallet_created_at'),
      render: (row) => formatTimestamp(row.createdAt),
    },
  ];

  const balance = wallet.data?.wallet;
  /*
   * BELOW ZERO is a real state now, and only for one reason: a reseller's purchase drawn
   * on their credit line (`docs/wp9-reseller-audit.md` R8). The figure is drawn exactly
   * as derived — `Money` carries the sign — and said in words beside it, because a
   * negative balance read as a rendering glitch is a debt nobody follows up.
   */
  const negative = balance?.balanceAmount.startsWith('-') ?? false;

  return (
    <Card title={t('web.wallet_title')}>
      <StateSwitch query={wallet}>
        {balance === undefined ? null : (
          <>
            <KV
              items={[
                [
                  t('web.wallet_balance'),
                  <span key="b">
                    <Money
                      value={{ amountMinor: balance.balanceAmount, currency: balance.currency }}
                    />
                    {negative && (
                      <>
                        {' '}
                        <Badge tone="warn">{t('web.wallet_balance_negative')}</Badge>
                      </>
                    )}
                  </span>,
                ],
                [t('web.wallet_entry_count'), String(balance.entryCount)],
              ]}
            />
            {negative && <Banner tone="warn">{t('web.wallet_balance_negative_hint')}</Banner>}
          </>
        )}
      </StateSwitch>
      <p className="muted">{t('web.wallet_balance_hint')}</p>

      <h3>{t('web.wallet_history_title')}</h3>
      <StateSwitch query={entries}>
        {entries.data === undefined ? null : entries.data.entries.length === 0 ? (
          <Empty title={t('web.wallet_history_empty')} />
        ) : (
          <>
            <DataTable
              caption={t('web.wallet_history_title')}
              columns={columns}
              rows={entries.data.entries}
              rowKey={(row) => row.id}
            />
            <CursorPager
              shown={entries.data.entries.length}
              hasPrevious={cursor !== null}
              hasNext={entries.data.nextCursor !== null}
              onPrevious={() => setCursor(null)}
              onNext={() => setCursor(entries.data?.nextCursor ?? null)}
            />
          </>
        )}
      </StateSwitch>
      <p className="muted">{t('web.wallet_immutable')}</p>

      {mayCredit || mayDebit ? (
        /*
         * DISABLED until the balance has loaded, because the balance carries the
         * currency this movement will be denominated in.
         *
         * This block is a sibling of the `StateSwitch` above rather than inside it —
         * an operator may adjust a wallet whose history failed to page — so without
         * the fieldset the buttons were live while `wallet.data` was undefined, and
         * the request went out under a hard-coded fallback currency.
         */
        <fieldset disabled={walletReady === false}>
          <h3>{t('web.wallet_adjust_title')}</h3>
          <p className="muted">{t('web.wallet_adjust_hint')}</p>
          <Field label={t('web.wallet_adjust_amount')} htmlFor="wallet-amount">
            <input
              id="wallet-amount"
              inputMode="numeric"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </Field>
          <Field label={t('web.wallet_adjust_note')} htmlFor="wallet-note">
            <input
              id="wallet-note"
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <div className="toolbar">
            {mayCredit && (
              <button
                type="button"
                className="btn primary sm"
                disabled={adjust.isPending}
                onClick={() => adjust.mutate({ direction: 'CREDIT' })}
              >
                {t('web.wallet_credit')}
              </button>
            )}
            {mayDebit && (
              <button
                type="button"
                className="btn danger sm"
                disabled={adjust.isPending}
                onClick={() => adjust.mutate({ direction: 'DEBIT' })}
              >
                {t('web.wallet_debit')}
              </button>
            )}
          </div>
          {adjust.error !== null && <Banner tone="danger">{messageFor(adjust.error)}</Banner>}
        </fieldset>
      ) : null}

      {/*
        Named separately, because the two permissions are separate decisions with
        different risk labels. An operator who may credit and not debit is told
        which one they are missing rather than shown a card with one button and no
        explanation.
      */}
      {!mayCredit && <Banner tone="info">{t('web.wallet_credit_denied')}</Banner>}
      {!mayDebit && <Banner tone="info">{t('web.wallet_debit_denied')}</Banner>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// This customer's trial allowance (WP6-B)
// ---------------------------------------------------------------------------

/**
 * ADR-0015's two numbers for one customer, and the override that sets the first.
 *
 * Every figure is the SERVER's, from the evaluator a claim decides with; nothing here
 * computes an allowance. The stored override is echoed as stored, or «none» — a screen
 * that could not say which is the legacy write-only setting ADR-0015 forbids.
 */
function TrialCard({ customerId, mayEdit }: { customerId: string; mayEdit: boolean }) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [limit, setLimit] = useState('');
  const [reason, setReason] = useState('');

  const trial = useQuery({
    queryKey: ['customer-trial', customerId],
    queryFn: () => fetchCustomerTrial(customerId),
  });

  const write = useMutation({
    mutationFn: (input: { remove: boolean }) => {
      // The fingerprint is the normalised body, as `WalletCard` explains in full.
      const note = reason.trim();
      if (input.remove) {
        const body = { customerId, remove: true, reason: note };
        return removeTrialOverride({
          customerId,
          idempotencyKey: submission.current(body),
          ...(note === '' ? {} : { reason: note }),
        });
      }
      const parsed = Number(limit.trim());
      const body = { customerId, limit: parsed, reason: note };
      return setTrialOverride({
        customerId,
        idempotencyKey: submission.current(body),
        limit: parsed,
        ...(note === '' ? {} : { reason: note }),
      });
    },
    onSuccess: (response, variables) => {
      submission.settle();
      notify({
        tone: 'ok',
        message: variables.remove ? t('web.trial_override_removed') : t('web.trial_override_done'),
      });
      setLimit('');
      setReason('');
      queries.setQueryData(['customer-trial', customerId], response);
      void queries.invalidateQueries({ queryKey: ['trial-overrides'] });
    },
    // A 5xx may have committed; a fresh key on the retry would be a second command.
    onError: (error) => submission.settleOn(error),
  });

  const row = trial.data?.trial;
  return (
    <Card title={t('web.trial_card_title')}>
      <StateSwitch query={trial}>
        {row === undefined ? null : (
          <>
            {!row.featureEnabled && <Banner tone="info">{t('web.trial_feature_off')}</Banner>}
            <KV
              items={[
                [t('web.trial_global_limit'), String(row.globalLimit)],
                [
                  t('web.trial_override'),
                  row.override === null ? t('web.trial_override_none') : String(row.override.limit),
                ],
                [t('web.trial_effective_limit'), String(row.effectiveLimit)],
                [t('web.trial_used'), String(row.used)],
                [t('web.trial_remaining'), String(row.remaining)],
              ]}
            />
            <p className="muted">{t('web.trial_zero_hint')}</p>
            {mayEdit ? (
              <>
                <Field label={t('web.trial_override_label')} htmlFor="trial-limit">
                  <input
                    id="trial-limit"
                    inputMode="numeric"
                    value={limit}
                    onChange={(event) => setLimit(event.target.value)}
                  />
                </Field>
                <Field label={t('web.trial_reason_label')} htmlFor="trial-reason">
                  <input
                    id="trial-reason"
                    value={reason}
                    maxLength={TRIAL_ADMIN_REASON_MAX_LENGTH}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </Field>
                <div className="toolbar">
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={write.isPending || limit.trim() === ''}
                    onClick={() => write.mutate({ remove: false })}
                  >
                    {t('web.trial_override_set')}
                  </button>
                  {row.override !== null && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={write.isPending}
                      onClick={() => write.mutate({ remove: true })}
                    >
                      {t('web.trial_override_remove')}
                    </button>
                  )}
                </div>
                {write.error !== null && <Banner tone="danger">{messageFor(write.error)}</Banner>}
              </>
            ) : (
              <Banner tone="info">{t('web.trial_override_denied')}</Banner>
            )}
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// This customer's place in the referral graph (WP9-A)
// ---------------------------------------------------------------------------

/**
 * Whether this customer is a reseller, and on what terms (WP9-B).
 *
 * `resellers.view` is decided at the route and never derived from `users.view`; without
 * it the card names the key and issues no request. "Not a reseller" is the server's own
 * `RESELLER_NOT_FOUND`, which `fetchCustomerReseller` turns into a null — a fact about the
 * customer, drawn as one, never as an error card. Every figure is the server's: the
 * effective credit limit is the reseller's own or the tier's, decided there.
 *
 * Registering and editing happen on `/resellers`, where the tiers are; this card links
 * there, carrying the customer so the form opens filled in.
 */
function ResellerCard({
  customerId,
  telegramUserId,
  mayView,
  mayEdit,
}: {
  customerId: string;
  telegramUserId: string;
  mayView: boolean;
  mayEdit: boolean;
}) {
  const onLink = useLinkHandler();
  const reseller = useQuery({
    queryKey: ['customer-reseller', customerId],
    queryFn: () => fetchCustomerReseller(customerId),
    enabled: mayView,
  });

  if (!mayView) {
    return (
      <Card title={t('web.user_reseller_title')}>
        <Banner tone="info">{t('web.user_reseller_denied')}</Banner>
      </Card>
    );
  }

  const found = reseller.data?.reseller;
  return (
    <Card title={t('web.user_reseller_title')}>
      <StateSwitch query={reseller}>
        {reseller.data === undefined ? null : found === undefined ? (
          <>
            <p className="muted">{t('web.user_reseller_none')}</p>
            {mayEdit && (
              <a href={`/resellers?register=${encodeURIComponent(customerId)}`} onClick={onLink}>
                {t('web.user_reseller_register')}
              </a>
            )}
          </>
        ) : (
          <>
            <KV
              items={[
                [t('web.reseller_tier'), found.tier.name],
                [t('web.status'), <ResellerStatusBadge key="s" value={found.status} />],
                [
                  t('web.reseller_pricing'),
                  <PricingText
                    key="p"
                    label={OVERRIDE_LABELS[found.pricingMode]}
                    percent={found.discountPercentage}
                  />,
                ],
                [
                  t('web.reseller_credit_limit_effective'),
                  <CreditLimitCell key="l" reseller={found} />,
                ],
              ]}
            />
            {found.status === 'SUSPENDED' && (
              <Banner tone="warn">{t('web.user_reseller_suspended')}</Banner>
            )}
            <a href={`/resellers?search=${encodeURIComponent(telegramUserId)}`} onClick={onLink}>
              {t('web.user_reseller_manage')}
            </a>
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

/**
 * Who referred this customer, how many they have referred, and what their commissions
 * came to — per currency, because two currencies never add up to one figure.
 *
 * READ-ONLY, as every referral surface is (`docs/wp9-referral-audit.md` F10): there is no
 * reassign and no adjust, because either would change who is owed money.
 *
 * `referrals.view` is decided at the route and never derived from `users.view`. Without
 * it the card names the key and issues no request — the server charges the same key in
 * `ReferralReadService.customer`, so the missing request is a courtesy, never the
 * enforcement. The referees themselves are not listed here: the response carries a
 * COUNT, and the link opens `/referrals` filtered to this referrer, which pages them.
 */
function CustomerReferralCard({ customerId, mayView }: { customerId: string; mayView: boolean }) {
  const onLink = useLinkHandler();
  const referral = useQuery({
    queryKey: ['customer-referral', customerId],
    queryFn: () => fetchCustomerReferral(customerId),
    enabled: mayView,
  });

  if (!mayView) {
    return (
      <Card title={t('web.user_referral_title')}>
        <Banner tone="info">{t('web.user_referral_denied')}</Banner>
      </Card>
    );
  }

  const row = referral.data;
  return (
    <Card title={t('web.user_referral_title')}>
      <StateSwitch query={referral}>
        {row === undefined ? null : (
          <>
            <KV
              items={[
                [
                  t('web.user_referral_referred_by'),
                  row.referredBy === null ? (
                    <span key="by" className="muted">
                      {t('web.user_referral_not_referred')}
                    </span>
                  ) : (
                    <div key="by">
                      <PartyCell party={row.referredBy.referrer} />
                      <TriggerBadge value={row.referredBy.trigger} />{' '}
                      <span className="muted small nowrap">
                        {formatTimestamp(row.referredBy.createdAt)}
                      </span>
                    </div>
                  ),
                ],
                [t('web.user_referral_referred_count'), <Num key="n" value={row.referredCount} />],
                [
                  t('web.user_referral_code'),
                  row.code === null ? (
                    <span key="code" className="muted">
                      {t('web.user_referral_no_code')}
                    </span>
                  ) : (
                    <Ltr key="code">{row.code}</Ltr>
                  ),
                ],
              ]}
            />
            {row.totals.length === 0 ? (
              <p className="muted">{t('web.user_referral_no_commissions')}</p>
            ) : (
              <DataTable
                caption={t('web.user_referral_totals')}
                columns={REFERRAL_TOTAL_COLUMNS}
                rows={row.totals}
                rowKey={(total) => total.currency}
              />
            )}
          </>
        )}
      </StateSwitch>
      <a href={`/referrals?referrerId=${encodeURIComponent(customerId)}`} onClick={onLink}>
        {t('web.user_referral_all')}
      </a>
    </Card>
  );
}

type ReferralTotal = CustomerReferralResponse['totals'][number];

const REFERRAL_TOTAL_COLUMNS: readonly Column<ReferralTotal>[] = [
  {
    key: 'pending',
    header: t('web.user_referral_pending'),
    render: (total) => (
      <Money value={{ amountMinor: total.pendingAmount, currency: total.currency }} />
    ),
  },
  {
    key: 'earned',
    header: t('web.user_referral_earned'),
    render: (total) => (
      <Money value={{ amountMinor: total.earnedAmount, currency: total.currency }} />
    ),
  },
  {
    key: 'reversed',
    header: t('web.user_referral_reversed'),
    render: (total) => (
      <Money value={{ amountMinor: total.reversedAmount, currency: total.currency }} />
    ),
  },
  {
    key: 'unrecovered',
    header: t('web.user_referral_unrecovered'),
    render: (total) => (
      <Money value={{ amountMinor: total.unrecoveredAmount, currency: total.currency }} />
    ),
  },
];
