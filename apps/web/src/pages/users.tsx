import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CUSTOMER_BLOCK_REASON_MAX_LENGTH,
  WALLET_PAGE_DEFAULT,
  telegramUserIdSchema,
  type CustomerStatus,
  type CustomerSummaryResponse,
  type LedgerDirection,
  type WalletEntrySummaryResponse,
} from '@nexa/contracts';
import {
  adjustWallet,
  blockCustomer,
  fetchCustomer,
  fetchCustomers,
  fetchWallet,
  fetchWalletEntries,
  unblockCustomer,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { mayRequest, queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { setQueries, setQuery, useLinkHandler, type Route } from '../router';
import { messageFor } from './settings';
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
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';

/**
 * Customers — the first product surface this codebase genuinely operates.
 *
 * What this page does NOT draw is as deliberate as what it does. There is no
 * service list, no discount and no reseller column — because none of those
 * entities exists in this release. A `0` in any of those places would be a
 * measurement of something unbuilt, which is the legacy statistics screen
 * counting configured panels as connected. The scope card says so in words
 * instead, which is what `planned.tsx` argues for: an empty table claims "you
 * have none of these", and that is also false.
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
  denied,
}: {
  id: string;
  mayBlock: boolean;
  mayViewWallet: boolean;
  mayCredit: boolean;
  mayDebit: boolean;
  denied: boolean;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [reason, setReason] = useState('');

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
      const request = {
        id,
        idempotencyKey,
        ...(input.reason === '' ? {} : { reason: input.reason }),
      };
      return input.to === 'BLOCKED' ? blockCustomer(request) : unblockCustomer(request);
    },
    onSuccess: (response, variables) => {
      submission.settle();
      notify({
        tone: 'ok',
        message:
          variables.to === 'BLOCKED' ? t('web.user_blocked_done') : t('web.user_unblocked_done'),
      });
      setReason('');
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
                ]}
              />

              {mayBlock ? (
                <>
                  <Field
                    label={t('web.user_block_reason_label')}
                    hint={t('web.user_block_reason_hint')}
                    htmlFor="user-block-reason"
                  >
                    <input
                      id="user-block-reason"
                      value={reason}
                      maxLength={CUSTOMER_BLOCK_REASON_MAX_LENGTH}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </Field>
                  <div className="toolbar">
                    {row.status === 'ACTIVE' ? (
                      <button
                        type="button"
                        className="btn danger sm"
                        disabled={mutate.isPending}
                        onClick={() => mutate.mutate({ to: 'BLOCKED', reason })}
                      >
                        {t('web.user_block')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn primary sm"
                        disabled={mutate.isPending}
                        onClick={() => mutate.mutate({ to: 'ACTIVE', reason })}
                      >
                        {t('web.user_unblock')}
                      </button>
                    )}
                  </div>
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

            <WalletCard
              customerId={id}
              mayView={mayViewWallet}
              mayCredit={mayCredit}
              mayDebit={mayDebit}
            />

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

  return (
    <Card title={t('web.wallet_title')}>
      <StateSwitch query={wallet}>
        {balance === undefined ? null : (
          <KV
            items={[
              [
                t('web.wallet_balance'),
                <Money
                  key="b"
                  value={{ amountMinor: balance.balanceAmount, currency: balance.currency }}
                />,
              ],
              [t('web.wallet_entry_count'), String(balance.entryCount)],
            ]}
          />
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
