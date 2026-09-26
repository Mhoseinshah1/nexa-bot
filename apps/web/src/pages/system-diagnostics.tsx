import { useQuery } from '@tanstack/react-query';
import type { StuckOperationReason, SystemDiagnosticsResponse } from '@nexa/contracts';
import { STUCK_OPERATION_REASONS } from '@nexa/contracts';
import { fetchSystemDiagnostics } from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import {
  Badge,
  Banner,
  Card,
  DataTable,
  Empty,
  KV,
  Ltr,
  Num,
  StateSwitch,
  type Column,
} from '../ui/kit';
import { pollUnlessFinal } from '../polling';
import { OPERATION_STATE_LABELS, OPERATION_TYPE_LABELS } from './services';

/**
 * What is stuck, and where (WP16 D3, `docs/wp16-admin-ops-audit.md`).
 *
 * Read-only by design. Every row names the thing it is about and links to where an
 * operator can act on it through that thing's own guarded action — a stuck operation
 * links to its service, whose reconcile and retry-provision keep their state machines.
 * There is no button here that changes anything, so there is nothing here that could
 * force an outcome. This is a queue view, not the general log page the owner removed.
 */

const REASON_LABELS: Readonly<Record<StuckOperationReason, WebKey>> = {
  UNKNOWN_OUTCOME: 'web.diagnostics_reason_unknown',
  LEASE_EXPIRED: 'web.diagnostics_reason_lease',
  RETRYING: 'web.diagnostics_reason_retrying',
  UNANNOUNCED: 'web.diagnostics_reason_unannounced',
};

const REASON_HINTS: Readonly<Record<StuckOperationReason, WebKey>> = {
  UNKNOWN_OUTCOME: 'web.diagnostics_reason_unknown_hint',
  LEASE_EXPIRED: 'web.diagnostics_reason_lease_hint',
  RETRYING: 'web.diagnostics_reason_retrying_hint',
  UNANNOUNCED: 'web.diagnostics_reason_unannounced_hint',
};

type StuckRow = SystemDiagnosticsResponse['provisioning']['sample'][number];
type FailingRow = SystemDiagnosticsResponse['outbox']['failingSample'][number];

export function DiagnosticsSection({ denied }: { denied: boolean }) {
  const onLink = useLinkHandler();
  const diagnostics = useQuery({
    queryKey: ['system-diagnostics'],
    queryFn: fetchSystemDiagnostics,
    enabled: !denied,
    refetchInterval: pollUnlessFinal(30_000),
  });
  const data = diagnostics.data;

  const stuckColumns: readonly Column<StuckRow>[] = [
    {
      key: 'reason',
      header: t('web.diagnostics_reason'),
      render: (row) => (
        <Badge tone={row.reason === 'RETRYING' ? 'warn' : 'danger'}>
          {t(REASON_LABELS[row.reason])}
        </Badge>
      ),
    },
    {
      key: 'operation',
      header: t('web.diagnostics_operation'),
      render: (row) => (
        <span>
          {t(OPERATION_TYPE_LABELS[row.type])} · {t(OPERATION_STATE_LABELS[row.state])}
        </span>
      ),
    },
    {
      key: 'attempts',
      header: t('web.diagnostics_attempts'),
      align: 'end',
      render: (row) => <Num value={row.attempts} />,
    },
    {
      key: 'updated',
      header: t('web.diagnostics_since'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.updatedAt)}</span>,
    },
    {
      key: 'service',
      header: t('web.diagnostics_service'),
      render: (row) => (
        <a href={`/services/${row.serviceId}`} onClick={onLink}>
          <Ltr>{row.serviceId.slice(0, 8)}</Ltr>
        </a>
      ),
    },
  ];

  const failingColumns: readonly Column<FailingRow>[] = [
    {
      key: 'event',
      header: t('web.diagnostics_event'),
      render: (row) => <Ltr>{row.eventType}</Ltr>,
    },
    {
      key: 'aggregate',
      header: t('web.diagnostics_aggregate'),
      render: (row) => <Ltr>{row.aggregateType}</Ltr>,
    },
    {
      key: 'attempts',
      header: t('web.diagnostics_attempts'),
      align: 'end',
      render: (row) => <Num value={row.attempts} />,
    },
    {
      key: 'occurred',
      header: t('web.diagnostics_occurred'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.occurredAt)}</span>,
    },
    {
      key: 'error',
      header: t('web.diagnostics_error'),
      render: (row) =>
        row.lastError === null ? (
          <span className="faint">—</span>
        ) : (
          <Ltr mono={false}>{row.lastError}</Ltr>
        ),
    },
  ];

  return (
    <>
      <Card
        title={t('web.diagnostics_provisioning_title')}
        hint={t('web.diagnostics_provisioning_hint')}
      >
        <StateSwitch
          query={diagnostics}
          denied={denied}
          isEmpty={data !== undefined && data.provisioning.sample.length === 0}
          empty={<Empty title={t('web.diagnostics_provisioning_empty')} icon="inbox" />}
        >
          {data !== undefined && (
            <>
              <KV
                items={STUCK_OPERATION_REASONS.map((reason) => [
                  <span key={`l-${reason}`} title={t(REASON_HINTS[reason])}>
                    {t(REASON_LABELS[reason])}
                  </span>,
                  <Num key={`n-${reason}`} value={data.provisioning.counts[reason]} />,
                ])}
              />
              <DataTable
                caption={t('web.diagnostics_provisioning_title')}
                columns={stuckColumns}
                rows={data.provisioning.sample}
                rowKey={(row) => row.operationId}
              />
            </>
          )}
        </StateSwitch>
        <p className="muted small">{t('web.diagnostics_provisioning_rule')}</p>
      </Card>

      <Card title={t('web.diagnostics_outbox_title')} hint={t('web.diagnostics_outbox_hint')}>
        <StateSwitch query={diagnostics} denied={denied}>
          {data !== undefined && (
            <>
              <KV
                items={[
                  [
                    t('web.diagnostics_outbox_pending'),
                    <Num key="p" value={data.outbox.pending} />,
                  ],
                  [
                    t('web.diagnostics_outbox_oldest'),
                    data.outbox.oldestPendingAt === null ? (
                      <span key="o" className="faint">
                        —
                      </span>
                    ) : (
                      <span key="o">{formatTimestamp(data.outbox.oldestPendingAt)}</span>
                    ),
                  ],
                  [
                    t('web.diagnostics_outbox_failing'),
                    <Num key="f" value={data.outbox.failing} />,
                  ],
                ]}
              />
              {data.outbox.failing > 0 && (
                <Banner tone="warn">{t('web.diagnostics_outbox_failing_banner')}</Banner>
              )}
              {data.outbox.failingSample.length > 0 && (
                <DataTable
                  caption={t('web.diagnostics_outbox_title')}
                  columns={failingColumns}
                  rows={data.outbox.failingSample}
                  rowKey={(row) => row.id}
                />
              )}
            </>
          )}
        </StateSwitch>
      </Card>
    </>
  );
}
