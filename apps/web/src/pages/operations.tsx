import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OperationalSeverity } from '@nexa/contracts';
import {
  fetchNotification,
  fetchNotifications,
  fetchOpsLog,
  sendTestNotification,
} from '../api/client';
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

  const events = useQuery({
    queryKey: ['ops-log', severity, openOnly],
    queryFn: () =>
      fetchOpsLog({
        ...(severity ? { severity } : {}),
        ...(openOnly ? { open: true } : {}),
      }),
  });

  return (
    <section>
      <h2>{t('web.ops_title')}</h2>
      <p className="notice">{t('web.ops_intro')}</p>

      <div className="filters">
        <label htmlFor="severity">{t('web.severity')}</label>
        <select
          id="severity"
          value={severity}
          onChange={(event) => setSeverity(event.target.value)}
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
          onChange={(event) => setOpenOnly(event.target.checked)}
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
                <td>{event.firstSeenAt}</td>
                <td>{event.lastSeenAt}</td>
                <td className={event.resolvedAt ? 'up' : 'down'}>
                  {event.resolvedAt ? t('web.resolved') : t('web.unresolved')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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

  const test = useMutation({
    mutationFn: sendTestNotification,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  return (
    <section>
      <h2>{t('web.notifications_title')}</h2>
      <p className="notice">{t('web.notifications_intro')}</p>

      {mayTest && (
        <div className="actions">
          <button type="button" onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? t('web.saving') : t('web.send_test')}
          </button>
          {test.isSuccess && <p className="notice">{t('web.test_sent')}</p>}
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
                <td>{notification.lastAttemptAt ?? notification.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

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
                    <td>{attempt.finishedAt}</td>
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
