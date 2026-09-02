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

const SEVERITIES: readonly OperationalSeverity[] = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];

/**
 * The operational log.
 *
 * Filtered and paginated, because the legacy `/admin/logs` is 1,700 rows with
 * neither. A resolved condition is shown as resolved rather than removed: the
 * failure row keeps its message, its occurrence count and its first-seen time,
 * so "was this broken last night" stays answerable.
 */
export function OperationsPage() {
  const [severity, setSeverity] = useState<string>('');
  const [openOnly, setOpenOnly] = useState(false);
  /**
   * The cursor: `lastSeenAt` of the oldest row shown, or null for the newest
   * page. A CURSOR rather than an offset, because rows are ordered by that
   * column and new events arrive at the top — an offset would skip and repeat
   * rows while somebody paged through.
   */
  const [before, setBefore] = useState<{ at: string; id: string } | null>(null);

  const events = useQuery({
    queryKey: ['ops-log', severity, openOnly, before?.at, before?.id],
    queryFn: () =>
      fetchOpsLog({
        ...(severity ? { severity } : {}),
        ...(openOnly ? { open: true } : {}),
        ...(before ? { before: before.at, beforeId: before.id } : {}),
      }),
  });

  // A filter change starts again from the newest page: keeping the old cursor
  // would show the second page of a list the reader has never seen the first
  // page of.
  const filter = (change: () => void) => {
    setBefore(null);
    change();
  };

  const rows = events.data?.events ?? [];
  const oldest = rows.length > 0 ? rows[rows.length - 1] : undefined;

  return (
    <section>
      <h2>{t('web.ops_title')}</h2>
      <p className="notice">{t('web.ops_intro')}</p>

      <div className="filters">
        <label htmlFor="severity">{t('web.severity')}</label>
        <select
          id="severity"
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

        <label htmlFor="open-only">{t('web.unresolved')}</label>
        <input
          id="open-only"
          type="checkbox"
          checked={openOnly}
          onChange={(event) => filter(() => setOpenOnly(event.target.checked))}
        />

        <button type="button" onClick={() => void events.refetch()}>
          {t('web.refresh')}
        </button>
      </div>

      {events.isPending && <p>{t('web.loading')}</p>}
      {events.isError && <p className="error">{messageFor(events.error)}</p>}
      {events.data?.events.length === 0 && <p>{t('web.empty')}</p>}

      {events.data && events.data.events.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t('web.severity')}</th>
              <th>{t('web.code')}</th>
              <th>{t('web.message')}</th>
              <th>{t('web.occurrences')}</th>
              <th>{t('web.first_seen')}</th>
              <th>{t('web.last_seen')}</th>
              <th>{t('web.status')}</th>
            </tr>
          </thead>
          <tbody>
            {events.data.events.map((event) => (
              <tr key={event.id}>
                <td>{event.severity}</td>
                <td>
                  <code>{event.code}</code>
                </td>
                <td dir="auto">{event.message}</td>
                {/* One row per condition with a counter, not one row per
                    occurrence: the legacy log posted the same TLS error sixty
                    times in a day. */}
                <td>{event.occurrenceCount}</td>
                {/* First and last seen are both shown: a condition that has
                    been failing since Tuesday reads differently from one that
                    started ten minutes ago, and a single timestamp hides it. */}
                <td>{formatTimestamp(event.firstSeenAt)}</td>
                <td>{formatTimestamp(event.lastSeenAt)}</td>
                <td className={event.resolvedAt ? 'up' : 'down'}>
                  {event.resolvedAt ? t('web.resolved') : t('web.unresolved')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* A page is a page, not the whole log. The legacy `/admin/logs` renders
          1,700 rows with no paging and no filter of any kind. */}
      <div className="actions">
        {before !== null && (
          <button type="button" onClick={() => setBefore(null)}>
            {t('web.newest')}
          </button>
        )}
        {oldest && (
          <button type="button" onClick={() => setBefore({ at: oldest.lastSeenAt, id: oldest.id })}>
            {t('web.older')}
          </button>
        )}
      </div>
    </section>
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
export function NotificationsPage({ mayTest }: { mayTest: boolean }) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: fetchNotifications,
  });

  const detail = useQuery({
    queryKey: ['notification', selected],
    queryFn: () => fetchNotification(selected as string),
    enabled: selected !== null,
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

  return (
    <section>
      <h2>{t('web.notifications_title')}</h2>
      <p className="notice">{t('web.notifications_intro')}</p>

      {mayTest && (
        <div className="actions">
          <button
            type="button"
            onClick={() => test.mutate(submission.current({ command: 'notifications.test' }))}
            disabled={test.isPending}
          >
            {test.isPending ? t('web.saving') : t('web.send_test')}
          </button>
          {/* A replay says it replayed. Answering "queued" for a call that
              queued nothing is the legacy pattern this screen exists to end. */}
          {test.isSuccess && (
            <p className="notice">
              {test.data.created ? t('web.test_sent') : t('web.test_replayed')}
            </p>
          )}
          {test.isError && <p className="error">{messageFor(test.error)}</p>}
        </div>
      )}

      {notifications.isPending && <p>{t('web.loading')}</p>}
      {notifications.isError && <p className="error">{messageFor(notifications.error)}</p>}
      {notifications.data?.notifications.length === 0 && <p>{t('web.empty')}</p>}

      {notifications.data && notifications.data.notifications.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t('web.status')}</th>
              <th>{t('web.key')}</th>
              <th>{t('web.attempts')}</th>
              <th>{t('web.updated_at')}</th>
            </tr>
          </thead>
          <tbody>
            {notifications.data.notifications.map((notification) => (
              <tr key={notification.id}>
                <td>{t(STATUS_KEYS[notification.status] ?? 'web.status_pending')}</td>
                <td>
                  <button type="button" onClick={() => setSelected(notification.id)}>
                    <code>{notification.templateKey}</code>
                  </button>
                </td>
                <td>
                  {notification.attemptCount} / {notification.maxAttempts}
                </td>
                <td>{formatTimestamp(notification.lastAttemptAt ?? notification.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail.isError && <p className="error">{messageFor(detail.error)}</p>}
      {detail.data && (
        <div className="card">
          <h3>{t('web.attempts')}</h3>
          {detail.data.attempts.length === 0 && <p>{t('web.empty')}</p>}
          {detail.data.attempts.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>{t('web.attempt')}</th>
                  <th>{t('web.outcome')}</th>
                  <th>{t('web.error_code')}</th>
                  <th>{t('web.message')}</th>
                  <th>{t('web.updated_at')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.attempts.map((attempt) => (
                  <tr key={attempt.attemptNumber}>
                    <td>{attempt.attemptNumber}</td>
                    <td className={attempt.outcome === 'SUCCEEDED' ? 'up' : 'down'}>
                      {attempt.outcome}
                    </td>
                    <td>{attempt.errorCode ?? '—'}</td>
                    <td dir="auto">{attempt.errorMessage ?? '—'}</td>
                    <td>{formatTimestamp(attempt.finishedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
