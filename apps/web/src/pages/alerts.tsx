import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isConditionRecoveryCode,
  isOneShotManagementCode,
  type NotificationDetailResponse,
  type NotificationListResponse,
  type OperationalSeverity,
} from '@nexa/contracts';
import {
  fetchNotification,
  fetchNotifications,
  fetchOpsLog,
  sendTestNotification,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { messageFor } from './settings';
import { severityTone } from './dashboard';
import { errorCopy, mayRequest, queryState, retryOf, staleAfterError } from '../view-state';
import {
  Badge,
  Banner,
  Card,
  CursorPager,
  Skeleton,
  DataTable,
  Empty,
  Ltr,
  Num,
  PageHead,
  Pills,
  StateSwitch,
  type Column,
} from '../ui/kit';
import { pollUnlessFinalWhile } from '../polling';

const SEVERITIES: readonly OperationalSeverity[] = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];

/**
 * Management alerts.
 *
 * Owner revision 21: this page is NOT an operational history. It shows the
 * codes that want a person's attention — an administrator was added, a role
 * changed, a tenant ran out of monitoring budget, a stored setting stopped
 * parsing, somebody was locked out, somebody was refused.
 *
 * NOT the notification channel giving up. `notification.attempts_exhausted` is
 * a delivery-attempt `errorCode`, never an `operational_events.code`, and the
 * one real notification code — `notification.sweep_withdrawn` — is deliberately
 * excluded and pinned out by a test. This sentence said otherwise for one
 * commit longer than the contract did, and so did the Persian copy the operator
 * actually reads.
 * The routine stream — every probe, every health transition, every delivery
 * attempt — belongs in the Telegram report group, and revision 25 removes the
 * general log browser from the Web Admin entirely. Neither exists here.
 *
 * The narrowing is a SERVER-side scope (`scope=MANAGEMENT`), not a filter over
 * the answer. Filtering fifty fetched rows down to two in the browser would
 * leave the cursor having already walked past the other forty-eight, so paging
 * would drop rows — in a subsystem whose stated rule is that silence is the one
 * outcome it may not produce.
 */
/**
 * The page size, and the reason it is a constant here rather than the server's
 * default.
 *
 * Sent explicitly so the page size is the caller's decision rather than the
 * server default. Whether ANOTHER page exists is a separate question and only
 * the server can answer it, which is why the response carries `nextCursor`.
 */
const ALERTS_PAGE_SIZE = 25;

export function AlertsPage({ denied }: { denied: boolean }) {
  const [severity, setSeverity] = useState<string>('');
  /**
   * Off by default.
   *
   * The management scope is already narrow, and most of what it carries — a
   * denial, a lockout, an administrator added — is a one-shot RECORD that
   * opens and is never resolved. Defaulting to "open only" showed those
   * forever and framed them as outstanding work; the conditions that really
   * are outstanding have their own card on the dashboard, which asks for
   * `MANAGEMENT_CONDITIONS`. Here the default is history, newest first.
   */
  const [openOnly, setOpenOnly] = useState(false);
  /**
   * The cursor stack.
   *
   * A stack rather than a single value, because keyset paging can go forward
   * on its own but can only go BACK to a cursor it has already seen. Pushing
   * each page's starting cursor is what makes "newer" work without inventing a
   * reverse query.
   */
  const [trail, setTrail] = useState<readonly { at: string; id: string }[]>([]);
  const cursor = trail.length > 0 ? trail[trail.length - 1] : undefined;

  const events = useQuery({
    queryKey: ['ops-log', 'management', severity, openOnly, cursor?.at, cursor?.id],
    queryFn: () =>
      fetchOpsLog({
        limit: ALERTS_PAGE_SIZE,
        // The scope FOLLOWS the filter. "Open" narrows to the conditions —
        // the codes something can actually close — because a one-shot record
        // has a permanently null `resolvedAt` by design, so asking the wide
        // scope for `open=true` returned every denial and every administrator
        // change ever recorded, framed as outstanding work. The badge already
        // said "recorded" on those rows, which made the page contradict itself
        // in that one state: half of the rule stated in `ports.ts` was
        // implemented and half was not.
        scope: openOnly ? 'MANAGEMENT_CONDITIONS' : 'MANAGEMENT',
        ...(severity ? { severity } : {}),
        ...(openOnly ? { open: true } : {}),
        ...(cursor ? { before: cursor.at, beforeId: cursor.id } : {}),
      }),
    enabled: !denied,
  });

  // A filter change starts again from the newest page: keeping the old cursor
  // would show the second page of a list the reader has never seen the first
  // page of.
  const filter = (change: () => void) => {
    setTrail([]);
    change();
  };

  const rows = events.data?.events ?? [];

  const columns: readonly Column<(typeof rows)[number]>[] = [
    {
      key: 'severity',
      header: t('web.severity'),
      render: (row) => <Badge tone={severityTone(row.severity)}>{row.severity}</Badge>,
    },
    {
      key: 'code',
      header: t('web.code'),
      render: (row) => <Ltr>{row.code}</Ltr>,
    },
    {
      key: 'message',
      header: t('web.message'),
      render: (row) => <span className="plain">{row.message}</span>,
    },
    // One row per condition with a counter, not one row per occurrence: the
    // legacy log posted the same TLS error sixty times in a day.
    {
      key: 'count',
      header: t('web.occurrences'),
      align: 'end',
      render: (row) => <Num value={row.occurrenceCount} />,
    },
    // First and last seen are both shown: a condition that has been failing
    // since Tuesday reads differently from one that started ten minutes ago,
    // and a single timestamp hides it.
    {
      key: 'first',
      header: t('web.first_seen'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.firstSeenAt)}</span>,
    },
    {
      key: 'last',
      header: t('web.last_seen'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.lastSeenAt)}</span>,
    },
    {
      key: 'state',
      header: t('web.status'),
      /**
       * A one-shot record is HISTORY, not outstanding work.
       *
       * `resolvedAt` is permanently null for a denial, a lockout or an
       * administrator change, by design — there is no recovery and
       * deliberately no acknowledgement. Rendering the same
       * resolved/unresolved badge for those framed immutable facts as a
       * backlog, which is the reading this page exists to prevent.
       */
      render: (row) =>
        // THREE kinds, not two. A recovery row is inserted with its own
        // `resolvedAt` null — it closes the failure above it and nothing ever
        // closes a recovery — so treating every non-one-shot null as an open
        // failure put a warning "unresolved" badge on the row whose message
        // announces the problem ended. That is the same defect as the one-shot
        // case, one classification along, and it is why the contract now names
        // the recoveries as their own list rather than leaving them inside the
        // lifecycle.
        isOneShotManagementCode(row.code) || isConditionRecoveryCode(row.code) ? (
          <Badge tone={isConditionRecoveryCode(row.code) ? 'ok' : 'neutral'}>
            {isConditionRecoveryCode(row.code) ? t('web.event_recovered') : t('web.event_recorded')}
          </Badge>
        ) : (
          <Badge tone={row.resolvedAt ? 'ok' : 'warn'}>
            {row.resolvedAt ? t('web.resolved') : t('web.unresolved')}
          </Badge>
        ),
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.alerts_title')}
        subtitle={t('web.alerts_intro')}
        maturity="now"
        actions={
          /*
           * Gone once the answer is final, for the same reason the error card's
           * retry is.
           *
           * `PageHead` renders ABOVE `StateSwitch`, so the state never reached
           * this button: after a revoked permission the card below correctly
           * offered nothing while the most obvious control on the page went on
           * firing the refused request — one `access.permission_denied` event
           * and one DENIED audit row per press, two in production because
           * `main.tsx` retries once. Exactly the shape the round before this
           * one fixed on the panel detail, left standing here.
           */
          !mayRequest(events, denied) ? undefined : (
            <button type="button" className="btn sm" onClick={retryOf(events)}>
              {t('web.refresh')}
            </button>
          )
        }
      />

      <Banner tone="info" title={t('web.alerts_scope_title')}>
        {t('web.alerts_scope_body')}
      </Banner>

      <Card>
        {/*
          The filters mint a NEW query key, which is a fresh request against a
          question the card below has just said cannot be answered — the same
          harm as the refresh button and the pager, in the controls nobody
          gated. Each change was one more refused request and one more
          `access.permission_denied` event, two in production.
        */}
        <div className="toolbar" hidden={!mayRequest(events, denied)}>
          <Pills
            value={openOnly ? 'open' : 'all'}
            onChange={(next) => filter(() => setOpenOnly(next === 'open'))}
            items={[
              { id: 'open', label: t('web.unresolved') },
              { id: 'all', label: t('web.all') },
            ]}
          />
          <span className="spacer" />
          <label className="visually-hidden" htmlFor="alert-severity">
            {t('web.severity')}
          </label>
          <select
            id="alert-severity"
            className="input sm"
            value={severity}
            onChange={(event) => filter(() => setSeverity(event.target.value))}
          >
            <option value="">{t('web.all')}</option>
            {SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <StateSwitch
          query={events}
          denied={denied}
          isEmpty={rows.length === 0}
          empty={
            /*
              Which emptiness this is. The page defaults to HISTORY and carries
              a severity select, so a zero-row result usually means "nothing
              matched these filters" — and printing "there is no open alert"
              over it is a false statement the operator has no way to check.
              Concretely: an open `settings.stored_value_invalid` is a WARN, so
              choosing ERROR emptied the table and the page then declared no
              open condition existed. Silence is the one outcome this subsystem
              may not produce, and that was silence with a reassurance on top.

              Only the unfiltered open-only view can claim the strong thing,
              because only it actually asked the question — and only on its
              FIRST page. An empty page three says nothing about pages one and
              two, which had rows; the pager only offers "older" when the
              server sent a cursor, but a condition resolved between the two
              requests makes an empty older page reachable, and "there is no
              open alert" would then be printed by a view that had just shown
              several.
            */
            openOnly && severity === '' && cursor === undefined ? (
              <Empty title={t('web.alerts_empty')} hint={t('web.alerts_empty_hint')} icon="check" />
            ) : (
              <Empty
                title={t('web.alerts_empty_filtered')}
                hint={t('web.alerts_empty_filtered_hint')}
                icon="inbox"
              />
            )
          }
        >
          <DataTable
            caption={t('web.alerts_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
          />
        </StateSwitch>

        {/*
          The pager describes rows that are ON SCREEN.
          
          It is a sibling of `StateSwitch`, so the error card replaced the table
          while this went on reporting "showing N" for rows nobody could see and
          offering an enabled "older" that pushed a cursor — changing the query
          key and issuing a fresh request the server had just refused.
        */}
        {!denied && queryState(events) === 'ready' && (
          <CursorPager
            shown={rows.length}
            hasPrevious={trail.length > 0}
            // The SERVER's cursor. A full page is not the same question as
            // "is there another page": with exactly `ALERTS_PAGE_SIZE` matching
            // rows the page is full and there is nothing behind it, so comparing
            // lengths offered an "older" page that did not exist and landed the
            // operator on "there are no open alerts" over alerts one page back.
            // The reader over-fetches one row to answer this properly.
            hasNext={events.data?.nextCursor != null}
            onPrevious={() => setTrail((current) => current.slice(0, -1))}
            onNext={() => {
              const next = events.data?.nextCursor;
              if (next) setTrail((current) => [...current, next]);
            }}
          />
        )}
      </Card>
    </>
  );
}

const STATUS_KEYS: Record<string, WebKey> = {
  PENDING: 'web.status_pending',
  SENT: 'web.status_sent',
  FAILED: 'web.status_failed',
};

/**
 * Notifications, and what happened to each of them.
 *
 * The intent and its delivery attempts are shown as the two different things
 * they are. In the legacy system there is no delivery-status field anywhere, so
 * whether its notification report means "sent" or merely "matched" is unknown
 * (UNK-LGR-015) — here you can read the answer off the row.
 */
/**
 * One page of notification intents.
 *
 * Smaller than the server's default of fifty because this page shows one row
 * per intent with no grouping, and because a pager the operator never reaches
 * is a pager that might as well not exist.
 */
const NOTIFICATION_PAGE_SIZE = 25;
/** The discovery lane for a settled first page of notifications. See `pollUnlessFinalWhile`. */
const NOTIFICATION_DISCOVERY_MS = 30_000;

export function NotificationsPage({ mayTest, denied }: { mayTest: boolean; denied: boolean }) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * The cursor stack — the same shape the alerts page uses, and for the same
   * reason: keyset paging goes forward on its own but can only go BACK to a
   * cursor it has already seen.
   *
   * Before this, the page asked for the newest page and offered nothing else.
   * Past fifty intents the older ones were unreachable from the Web Admin
   * altogether, even though the repository had accepted a `before` all along
   * and the controller simply never parsed it.
   */
  const [trail, setTrail] = useState<readonly { at: string; id: string }[]>([]);
  const cursor = trail.length > 0 ? trail[trail.length - 1] : undefined;

  const notifications = useQuery({
    queryKey: ['notifications', cursor?.at, cursor?.id],
    queryFn: () =>
      fetchNotifications({
        limit: NOTIFICATION_PAGE_SIZE,
        ...(cursor ? { before: cursor.at, beforeId: cursor.id } : {}),
      }),
    enabled: !denied,
    // Delivery is ASYNCHRONOUS: the worker claims and sends on its own poll,
    // so the list a test send refreshes almost always still says PENDING.
    // Without this the page never learned the outcome — no interval, no
    // refetch on focus — and an operator testing a destination sat looking at
    // "pending" until they reloaded, which is indistinguishable from a
    // destination that does not work.
    //
    // Fast only while something IS pending. A settled FIRST page still polls,
    // slowly: an operational event queues a new intent with no operator
    // action, `refetchOnWindowFocus` is off globally, and a tab opened on a
    // settled list never saw a later delivery until navigation. The cursor
    // pages behind it are history and do not poll once settled — a new row
    // appears on the first page, never on an older one.
    refetchInterval: pollUnlessFinalWhile<NotificationListResponse>(
      3_000,
      (data) => data.notifications.some((entry) => entry.status === 'PENDING'),
      cursor === undefined ? NOTIFICATION_DISCOVERY_MS : undefined,
    ),
  });

  const detail = useQuery({
    queryKey: ['notification', selected],
    queryFn: () => fetchNotification(selected as string),
    // And the list's DENIED state. The list switched to "no permission" when
    // the session refresh took `opslog.view` away; this card sat beside it
    // showing the attempts and released claims it had already fetched,
    // indefinitely — a settled notification no longer polls, so no 403 ever
    // arrived to replace the cached answer. Gated here and at every render
    // below, for the same reason the pager is.
    enabled: selected !== null && !denied,
    // The open panel follows the same rule as the list above.
    refetchInterval: pollUnlessFinalWhile<NotificationDetailResponse>(
      3_000,
      (data) => data.notification.status === 'PENDING',
    ),
  });

  const submission = useSubmissionKey();

  const test = useMutation({
    // The key is HELD across a failure. A dropped response leaves the person
    // pressing the button again to ask whether it worked, and minting a fresh
    // key there would answer by queueing a second message. It is retired only
    // once a response has actually been seen.
    mutationFn: (idempotencyKey: string) => sendTestNotification(idempotencyKey),
    onSuccess: async () => {
      submission.settle();
      await client.invalidateQueries({ queryKey: ['notifications'] });
      // The open detail panel too: a test send against an intent already on
      // screen adds an attempt, and a panel that does not refresh reports the
      // attempt list as it was before the button was pressed.
      await client.invalidateQueries({ queryKey: ['notification'] });
    },
    // A rejection the server SENT retires the key: the outcome is known and the
    // next press is a new question. A transport failure keeps it, because
    // nothing came back and the next press is the same question asked again.
    onError: (error: unknown) => submission.settleOn(error),
  });

  const rows = notifications.data?.notifications ?? [];

  const columns: readonly Column<(typeof rows)[number]>[] = [
    {
      key: 'status',
      header: t('web.status'),
      render: (row) => (
        <Badge tone={row.status === 'SENT' ? 'ok' : row.status === 'FAILED' ? 'danger' : 'warn'}>
          {t(STATUS_KEYS[row.status] ?? 'web.status_pending')}
        </Badge>
      ),
    },
    {
      key: 'template',
      header: t('web.key'),
      render: (row) => (
        <button type="button" className="btn ghost sm" onClick={() => setSelected(row.id)}>
          <Ltr>{row.templateKey}</Ltr>
        </button>
      ),
    },
    {
      key: 'attempts',
      header: t('web.attempts'),
      align: 'end',
      render: (row) => (
        <Ltr mono={false}>
          <Num value={row.attemptCount} /> / <Num value={row.maxAttempts} />
        </Ltr>
      ),
    },
    {
      key: 'at',
      header: t('web.updated_at'),
      render: (row) => (
        <span className="nowrap">{formatTimestamp(row.lastAttemptAt ?? row.createdAt)}</span>
      ),
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.notifications_title')}
        subtitle={t('web.notifications_intro')}
        maturity="now"
        actions={
          mayTest ? (
            <button
              type="button"
              className="btn primary sm"
              onClick={() => test.mutate(submission.current({ command: 'notifications.test' }))}
              disabled={test.isPending}
            >
              {test.isPending ? t('web.saving') : t('web.send_test')}
            </button>
          ) : undefined
        }
      />

      {/* A replay says it replayed. Answering "queued" for a call that queued
          nothing is the legacy pattern this screen exists to end. */}
      {test.isSuccess && (
        <Banner tone={test.data.created ? 'ok' : 'info'}>
          {test.data.created ? t('web.test_sent') : t('web.test_replayed')}
        </Banner>
      )}
      {test.isError && <Banner tone="danger">{messageFor(test.error)}</Banner>}

      <Card title={t('web.notifications_title')}>
        <StateSwitch query={notifications} denied={denied} isEmpty={rows.length === 0}>
          <DataTable
            caption={t('web.notifications_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
          />
        </StateSwitch>

        {/*
          The pager describes rows that are ON SCREEN.
          
          It is a sibling of `StateSwitch`, so the error card replaced the table
          while this went on reporting "showing N" for rows nobody could see and
          offering an enabled "older" that pushed a cursor — changing the query
          key and issuing a fresh request the server had just refused.
        */}
        {!denied && queryState(notifications) === 'ready' && (
          <CursorPager
            shown={rows.length}
            hasPrevious={trail.length > 0}
            // The SERVER's cursor, not a guess from the page length. `null`
            // means the last page, so "older" is never offered where there is
            // nothing older.
            hasNext={notifications.data?.nextCursor != null}
            onPrevious={() => setTrail((current) => current.slice(0, -1))}
            onNext={() => {
              const next = notifications.data?.nextCursor;
              if (next) setTrail((current) => [...current, next]);
            }}
          />
        )}
      </Card>

      {/*
        A message AND a way out. This was the one polled query on the branch
        with no retry control: the interval stops on a refusal, the stale
        attempts card below goes on showing the pre-failure list, and clicking
        the same row again sets `selected` to the value it already holds, so
        React bails out and nothing refetches. The only escapes were a full
        reload or a detour through another notification.
      */}
      {/*
        The SAME rule as every other query-driven view, not a hand-rolled
        ladder beside it.
        
        This version kept the pre-failure attempts list on screen through a
        FINAL refusal and offered a retry that could only be refused again —
        the two halves of the defect the rest of the branch spent five rounds
        removing, in the one view that computed its own states. `detail.isError`
        does not distinguish a blip from an answer, and `detail.data` does not
        know what `detail.isError` decided.
      */}
      {/*
        The LOADING state, which the three blocks below jointly did not cover.
        
        `isPending` matched none of them, so selecting a notification left the
        DOM byte-identical until the request answered — a click that appears to
        do nothing. Every `StateSwitch` view on the branch draws a skeleton
        here; the comment claiming this site "follows the SAME rule as every
        other query-driven view" was two thirds true.
      */}
      {!denied && selected !== null && detail.isPending && <Skeleton />}
      {!denied && detail.isError && staleAfterError(detail) && (
        <Banner tone="danger">
          {messageFor(detail.error)}{' '}
          {retryOf(detail) !== undefined && (
            <button type="button" className="btn ghost sm" onClick={retryOf(detail)}>
              {t('web.retry')}
            </button>
          )}
        </Banner>
      )}
      {!denied && queryState(detail) === 'error' && (
        <Empty
          // The SAME copy rule as `StateSwitch`, and now literally the same
          // function rather than a second copy of its ternaries.
          //
          // This card hard-coded the connection copy, so one screen gave two
          // contradictory diagnoses of one 403. Fixing that by writing the
          // same three ternaries here left both sites wrong in the same NEW
          // way one round later, for every final answer that is not a 403.
          title={t(errorCopy(detail).title)}
          hint={t(errorCopy(detail).hint)}
          icon={errorCopy(detail).icon}
          {...(retryOf(detail) === undefined
            ? {}
            : {
                action: (
                  <button type="button" className="btn" onClick={retryOf(detail)}>
                    {t('web.retry')}
                  </button>
                ),
              })}
        />
      )}
      {!denied && queryState(detail) !== 'error' && detail.data && (
        <Card title={t('web.attempts')}>
          {detail.data.attempts.length === 0 && <Empty title={t('web.empty')} />}
          {detail.data.attempts.length > 0 && (
            <DataTable
              caption={t('web.attempts')}
              rows={detail.data.attempts}
              rowKey={(row) => String(row.attemptNumber)}
              columns={[
                {
                  key: 'n',
                  header: t('web.attempt'),
                  render: (row) => <Num value={row.attemptNumber} />,
                },
                {
                  key: 'outcome',
                  header: t('web.outcome'),
                  render: (row) => (
                    <Badge tone={row.outcome === 'SUCCEEDED' ? 'ok' : 'danger'}>
                      {row.outcome}
                    </Badge>
                  ),
                },
                {
                  key: 'code',
                  header: t('web.error_code'),
                  render: (row) => (row.errorCode === null ? '—' : <Ltr>{row.errorCode}</Ltr>),
                },
                {
                  key: 'message',
                  header: t('web.message'),
                  render: (row) => <span className="plain">{row.errorMessage ?? '—'}</span>,
                },
                {
                  key: 'at',
                  header: t('web.updated_at'),
                  render: (row) => (
                    <span className="nowrap">{formatTimestamp(row.finishedAt)}</span>
                  ),
                },
              ]}
            />
          )}

          {/* The claims that were given back.

              Rendered alongside the attempts rather than merged into them,
              because they are the opposite kind of fact: an attempt row says
              what happened on the wire and one of these says that on this
              number nothing did. Merged, the two would need a shared "outcome"
              column and a released claim has no outcome to put in it. */}
          {detail.data.releasedClaims.length > 0 && (
            <>
              <h3>{t('web.returned_claims')}</h3>
              <p className="muted small">{t('web.returned_claims_intro')}</p>
              <DataTable
                caption={t('web.returned_claims')}
                rows={detail.data.releasedClaims}
                rowKey={(row) => String(row.attemptNumber)}
                columns={[
                  {
                    key: 'n',
                    header: t('web.attempt'),
                    render: (row) => <Num value={row.attemptNumber} />,
                  },
                  {
                    key: 'reason',
                    header: t('web.returned_reason'),
                    render: (row) => <Ltr>{row.reason}</Ltr>,
                  },
                  {
                    key: 'at',
                    header: t('web.returned_at'),
                    render: (row) => (
                      <span className="nowrap">{formatTimestamp(row.releasedAt)}</span>
                    ),
                  },
                ]}
              />
            </>
          )}
        </Card>
      )}
    </>
  );
}
