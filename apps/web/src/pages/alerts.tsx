import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OperationalSeverity } from '@nexa/contracts';
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
import { queryState, severityTone } from './dashboard';
import {
  Badge,
  Banner,
  Card,
  CursorPager,
  DataTable,
  Empty,
  Ltr,
  Num,
  PageHead,
  Pills,
  StateSwitch,
  type Column,
} from '../ui/kit';

const SEVERITIES: readonly OperationalSeverity[] = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];

/**
 * Management alerts.
 *
 * Owner revision 21: this page is NOT an operational history. It shows the
 * codes that want a person's attention — an administrator was added, a role
 * changed, the installation ran out of monitoring capacity, the notification
 * channel gave up, a stored setting stopped parsing, somebody was locked out.
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
export function AlertsPage({ denied }: { denied: boolean }) {
  const [severity, setSeverity] = useState<string>('');
  const [openOnly, setOpenOnly] = useState(true);
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
        scope: 'MANAGEMENT',
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
  const oldest = rows.length > 0 ? rows[rows.length - 1] : undefined;

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
      render: (row) => (
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
          <button type="button" className="btn sm" onClick={() => void events.refetch()}>
            {t('web.refresh')}
          </button>
        }
      />

      <Banner tone="info" title={t('web.alerts_scope_title')}>
        {t('web.alerts_scope_body')}
      </Banner>

      <Card>
        <div className="toolbar">
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
          state={denied ? 'denied' : queryState(events, rows.length === 0)}
          onRetry={() => void events.refetch()}
          empty={
            <Empty title={t('web.alerts_empty')} hint={t('web.alerts_empty_hint')} icon="check" />
          }
        >
          <DataTable
            caption={t('web.alerts_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
          />
        </StateSwitch>

        <CursorPager
          shown={rows.length}
          hasPrevious={trail.length > 0}
          hasNext={oldest !== undefined && rows.length > 0}
          onPrevious={() => setTrail((current) => current.slice(0, -1))}
          onNext={() =>
            oldest !== undefined &&
            setTrail((current) => [...current, { at: oldest.lastSeenAt, id: oldest.id }])
          }
        />
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
export function NotificationsPage({ mayTest, denied }: { mayTest: boolean; denied: boolean }) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: fetchNotifications,
    enabled: !denied,
    // Delivery is ASYNCHRONOUS: the worker claims and sends on its own poll,
    // so the list a test send refreshes almost always still says PENDING.
    // Without this the page never learned the outcome — no interval, no
    // refetch on focus — and an operator testing a destination sat looking at
    // "pending" until they reloaded, which is indistinguishable from a
    // destination that does not work.
    //
    // Only while something IS pending, so a settled list costs nothing.
    refetchInterval: (query) =>
      query.state.data?.notifications.some((entry) => entry.status === 'PENDING') ? 3_000 : false,
  });

  const detail = useQuery({
    queryKey: ['notification', selected],
    queryFn: () => fetchNotification(selected as string),
    enabled: selected !== null,
    // The open panel follows the same rule as the list above.
    refetchInterval: (query) =>
      query.state.data?.notification.status === 'PENDING' ? 3_000 : false,
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
        <StateSwitch
          state={denied ? 'denied' : queryState(notifications, rows.length === 0)}
          onRetry={() => void notifications.refetch()}
        >
          <DataTable
            caption={t('web.notifications_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
          />
        </StateSwitch>
      </Card>

      {detail.isError && <Banner tone="danger">{messageFor(detail.error)}</Banner>}
      {detail.data && (
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
