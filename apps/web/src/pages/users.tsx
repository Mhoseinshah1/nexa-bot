import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { uuidV7Schema, type CustomerStatus, type CustomerSummaryResponse } from '@nexa/contracts';
import { fetchCustomers } from '../api/client';
import { formatTimestamp } from '../format';
import { mayRequest, queryState } from '../view-state';
import { t } from '../i18n/web.fa';
import { setQuery, useLinkHandler, type Route } from '../router';
import { ListSearchBox, appliedListSearch } from '../ui/list-search';
import { ChipGroup } from './commerce-parts';
import { Dash, StatusBadge, displayName, initialOf } from './customer-parts';
import { TagCatalogueModal, useTagCatalogue } from './customer-360-crm';
import {
  Banner,
  Button,
  Card,
  CursorPager,
  DataTable,
  Empty,
  Ltr,
  PageHead,
  Select,
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
  mayManageTags = false,
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
  /** `users.tags.manage`: offer the tenant's tag catalogue editor (program §8). */
  mayManageTags?: boolean;
  denied: boolean;
}) {
  const onLink = useLinkHandler();
  const [managingTags, setManagingTags] = useState(false);

  /*
   * ONE search box (spec §10), in the URL as `q`. The server reads a Telegram id, an
   * internal id, an `@username` or a name prefix from it by shape; see `ListSearchBox`.
   */
  const appliedSearch = appliedListSearch(route);
  const appliedStatus = statusFromQuery(route.query.get('status'));
  /*
   * Program §8: the tag FILTER, by the tag's id — a label is editable text and a filter on it
   * would change meaning on a rename. Like the status filter it is not a search: the server
   * charges `users.view` for it, and `q` stays the list's one search box. A value that is not
   * an id is dropped here rather than sent to be refused.
   */
  const appliedTag = tagFromQuery(route.query.get('tag'));
  const catalogue = useTagCatalogue(!denied);

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
   *
   * Joined on `|`, which a status literal cannot contain; the search text is LAST, so
   * whatever it contains, no two (status, search) pairs produce the same signature.
   */
  const searchSignature = [appliedStatus ?? '', appliedTag ?? '', appliedSearch].join('|');
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
   * `searching` is about the ROWS — whether the empty state should read "nothing
   * matched your search" or "no customers yet" — so it is the applied URL and
   * nothing else — and only a search this actor may actually send.
   */
  const searching = appliedSearch !== '' && maySearch;

  const customers = useQuery({
    // The search is part of the key. Sharing one key across filters would serve
    // the previous result under the new heading for a frame, which is the sort
    // of thing an operator acts on before it corrects itself.
    queryKey: ['customers', searchSignature, cursor ?? null],
    queryFn: () =>
      fetchCustomers({
        ...(cursor === undefined ? {} : { cursor }),
        // Only for an actor holding `users.search`: the server charges it for `q`, and a
        // search left in the URL by somebody else must not turn the list into a 403.
        ...(searching ? { q: appliedSearch } : {}),
        ...(appliedStatus === null ? {} : { status: appliedStatus }),
        ...(appliedTag === null ? {} : { tag: appliedTag }),
      }),
    enabled: !denied,
  });

  const rows = customers.data?.customers ?? [];
  const nextCursor = customers.data?.nextCursor ?? null;

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
      <PageHead
        title={t('web.users_title')}
        subtitle={t('web.users_intro')}
        {...(mayManageTags
          ? {
              actions: (
                <Button size="sm" icon="tag" onClick={() => setManagingTags(true)}>
                  {t('web.crm_tags_manage')}
                </Button>
              ),
            }
          : {})}
      />
      <TagCatalogueModal
        open={mayManageTags && managingTags}
        onClose={() => setManagingTags(false)}
      />

      <Card className="ca-list">
        {maySearch ? (
          <ListSearchBox
            route={route}
            id="users-search"
            hint={t('web.users_search_hint')}
            hidden={toolbarHidden}
            // Issue 13: typing or pasting searches by itself, debounced; the button stays.
            autoApply
          />
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
          that permission for the search box, not for narrowing the tenant's own
          list to its blocked half. A non-text filter, so it stays its own control.
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
          {/* Drawn once the catalogue has answered, and only when there is a tag to pick. */}
          {(catalogue.data?.tags.length ?? 0) > 0 && (
            <label className="filter-select">
              <span>{t('web.users_filter_tag')}</span>
              <Select
                size="sm"
                value={appliedTag ?? ''}
                onChange={(event) =>
                  setQuery(route, 'tag', event.target.value === '' ? null : event.target.value)
                }
              >
                <option value="">{t('web.users_filter_tag_all')}</option>
                {(catalogue.data?.tags ?? []).map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.archivedAt === null
                      ? tag.label
                      : t('web.users_filter_tag_archived').replace('{label}', tag.label)}
                  </option>
                ))}
              </Select>
            </label>
          )}
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

        {/*
          What the two activity columns ARE (issue 12). `first_seen_at` / `last_seen_at` are
          written by `CustomerService.resolveFromUpdate` on every message and button press a
          customer sends a customer bot — not only `/start`, and never by an operator's action —
          and otherwise only by the legacy importer, which stamps BOTH columns of an imported
          row with the import's time (the last one moves at their first bot activity). "Contact" read as a phone call or a support request; this says which
          events count.
        */}
        <p className="muted small ca-list-note" hidden={toolbarHidden}>
          {t('web.users_activity_note')}
        </p>

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

function tagFromQuery(raw: string | null): string | null {
  return raw !== null && uuidV7Schema.safeParse(raw).success ? raw.toLowerCase() : null;
}

function statusFromQuery(raw: string | null): CustomerStatus | null {
  return raw === 'ACTIVE' || raw === 'BLOCKED' ? raw : null;
}

/*
 * The customer's own page is Customer 360 (`customer-360.tsx`, spec §11). Re-exported here
 * so the route and every test that reaches it through `pages/users` keep one entry point.
 */
export { UserDetailPage } from './customer-360';
