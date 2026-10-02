import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  telegramUserIdSchema,
  type CustomerStatus,
  type CustomerSummaryResponse,
} from '@nexa/contracts';
import { fetchCustomers } from '../api/client';
import { formatTimestamp } from '../format';
import { mayRequest, queryState } from '../view-state';
import { t } from '../i18n/web.fa';
import { setQueries, setQuery, useLinkHandler, type Route } from '../router';
import { ChipGroup } from './commerce-parts';
import { Dash, StatusBadge, displayName, initialOf } from './customer-parts';
import {
  Banner,
  Button,
  Card,
  CursorPager,
  DataTable,
  Empty,
  Field,
  Input,
  Ltr,
  PageHead,
  StateSwitch,
  type Column,
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
        return name === null ? (
          <Dash />
        ) : (
          <span className="who">
            <span className="avatar" aria-hidden="true">
              {initialOf(name)}
            </span>
            <span>{name}</span>
          </span>
        );
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

  /*
   * The toolbar is hidden while the list cannot answer — the rule the panels
   * toolbar and the alerts toolbar follow: a control that mints a new query key
   * is a fresh request against a question the server has just refused. Each
   * row carries the attribute itself, rather than one wrapper around both, so
   * the card can draw them flush with its edges as the reference's lists are.
   */
  const toolbarHidden = !mayRequest(customers, denied);

  return (
    <>
      <PageHead title={t('web.users_title')} subtitle={t('web.users_intro')} />

      <Card className="ca-list">
        {maySearch ? (
          <form className="toolbar ca-search" onSubmit={apply} hidden={toolbarHidden}>
            <Field
              compact
              label={t('web.users_search_telegram')}
              hint={t('web.users_search_telegram_hint')}
              htmlFor="users-telegram-id"
              {...(telegramIdProblem === undefined ? {} : { error: telegramIdProblem })}
            >
              <Input
                id="users-telegram-id"
                size="sm"
                dir="ltr"
                inputMode="numeric"
                aria-invalid={telegramIdProblem !== undefined}
                value={draftTelegramId}
                onChange={(event) => setDraftTelegramId(event.target.value.trim())}
              />
            </Field>
            <Field
              compact
              label={t('web.users_search_username')}
              hint={t('web.users_search_username_hint')}
              htmlFor="users-username"
            >
              <Input
                id="users-username"
                size="sm"
                dir="ltr"
                value={draftUsername}
                onChange={(event) => setDraftUsername(event.target.value.trim())}
              />
            </Field>
            <div className="ca-search-actions">
              <Button
                type="submit"
                variant="primary"
                size="sm"
                icon="search"
                disabled={telegramIdProblem !== undefined}
              >
                {t('web.users_search_apply')}
              </Button>
              <Button variant="ghost" size="sm" onClick={clear} disabled={!clearable}>
                {t('web.users_search_clear')}
              </Button>
            </div>
          </form>
        ) : (
          /*
            No search form for an actor without `users.search`, and a sentence
            rather than a disabled box. The server refuses the search and serves
            the list, so this states the boundary that exists and names the
            permission — the half an operator needs in order to ask for it.
          */
          <div className="toolbar" hidden={toolbarHidden}>
            <Banner tone="info">{t('web.users_search_denied')}</Banner>
          </div>
        )}

        {/*
          The status filter is NOT gated on `users.search`: the server charges
          that permission for an id or username lookup, not for narrowing the
          tenant's own list to its blocked half.
        */}
        <div className="filter-row" hidden={toolbarHidden}>
          <ChipGroup
            label={t('web.status')}
            value={appliedStatus ?? 'ALL'}
            onChange={(next) => setQuery(route, 'status', next === 'ALL' ? null : next)}
            items={[
              { id: 'ALL' as const, label: t('web.users_filter_all') },
              { id: 'ACTIVE' as const, label: t('web.user_status_active') },
              { id: 'BLOCKED' as const, label: t('web.user_status_blocked') },
            ]}
          />
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
            dense
            sticky
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

      <Card tone="muted" title={t('web.users_scope_title')}>
        <p className="muted small">{t('web.users_scope_body')}</p>
      </Card>
    </>
  );
}

function statusFromQuery(raw: string | null): CustomerStatus | null {
  return raw === 'ACTIVE' || raw === 'BLOCKED' ? raw : null;
}

/*
 * The customer's own page is Customer 360 (`customer-360.tsx`, spec §11). Re-exported here
 * so the route and every test that reaches it through `pages/users` keep one entry point.
 */
export { UserDetailPage } from './customer-360';
