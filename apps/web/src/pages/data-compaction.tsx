import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DATA_COMPACTION_CLASS_TABLES,
  type DataCompactionClass,
  type DataCompactionMode,
  type DataCompactionPreview,
  type DataCompactionRunState,
  type DataCompactionStopReason,
} from '@nexa/contracts';
import { fetchDataCompactionPreview } from '../api/client';
import { t, type WebKey } from '../i18n/web.fa';
import { Banner, Button, KV, Ltr, StateSwitch } from '../ui/kit';
import { formatTimestamp } from '../format';

/**
 * «فشرده‌سازی داده‌های قدیمی» — Round 9 C3: the data compaction's DRY RUN, for the owner.
 *
 * Read-only. The button asks the server what a pass WOULD remove at today's cutoffs, per class
 * and table, and shows the last recorded pass. Nothing here removes a row: the worker does,
 * daily, only once `retention.compaction_mode` is APPLY on the settings page, and the owner's
 * CLI does with a confirmed count. The count is fetched on request, not on load, because it
 * reads the tables it counts.
 */

const CLASS_LABEL: Readonly<Record<DataCompactionClass, WebKey>> = {
  OPS_NOTIFICATIONS: 'web.dcp_class_ops_notifications',
  CUSTOMER_NOTIFICATIONS: 'web.dcp_class_customer_notifications',
  RECEIPT_WINDOWS: 'web.dcp_class_receipt_windows',
};

const MODE_LABEL: Readonly<Record<DataCompactionMode, WebKey>> = {
  DRY_RUN: 'web.dcp_mode_dry_run',
  APPLY: 'web.dcp_mode_apply',
};

const STATE_LABEL: Readonly<Record<DataCompactionRunState, WebKey>> = {
  RUNNING: 'web.dcp_state_running',
  COMPLETED: 'web.dcp_state_completed',
  STOPPED: 'web.dcp_state_stopped',
  FAILED: 'web.dcp_state_failed',
};

const REASON_LABEL: Readonly<Record<DataCompactionStopReason, WebKey>> = {
  RECOVERY_IN_FLIGHT: 'web.dcp_reason_recovery',
  BACKUP_IN_FLIGHT: 'web.dcp_reason_backup',
  SCOPE_INACTIVE: 'web.dcp_reason_scope',
  BATCH_CEILING: 'web.dcp_reason_ceiling',
  ABANDONED: 'web.dcp_reason_abandoned',
  ERROR: 'web.dcp_reason_error',
};

function total(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

function Counts({ preview }: { preview: DataCompactionPreview }) {
  return (
    <table className="table">
      <caption>{t('web.dcp_counts_caption')}</caption>
      <thead>
        <tr>
          <th>{t('web.dcp_class')}</th>
          <th>{t('web.dcp_retention')}</th>
          <th>{t('web.dcp_cutoff')}</th>
          <th>{t('web.dcp_table')}</th>
          <th>{t('web.dcp_rows')}</th>
        </tr>
      </thead>
      <tbody>
        {preview.classes.flatMap((entry) =>
          DATA_COMPACTION_CLASS_TABLES[entry.class].map((table) => (
            <tr key={`${entry.class}:${table}`}>
              <td>{t(CLASS_LABEL[entry.class])}</td>
              <td>{t('web.dcp_days').replace('{n}', String(entry.retentionDays))}</td>
              <td>{formatTimestamp(entry.cutoff)}</td>
              <td>
                <Ltr>{table}</Ltr>
              </td>
              <td>{String(entry.counts[table] ?? 0)}</td>
            </tr>
          )),
        )}
      </tbody>
    </table>
  );
}

function Preview({ preview }: { preview: DataCompactionPreview }) {
  const last = preview.lastRun;
  return (
    <div className="stack">
      <KV items={[[t('web.dcp_mode'), t(MODE_LABEL[preview.mode])]]} />
      {preview.blockedBy !== null && (
        <Banner tone="warn">{t(REASON_LABEL[preview.blockedBy])}</Banner>
      )}
      <Counts preview={preview} />
      {last !== null && (
        <KV
          items={[
            [t('web.dcp_last_run'), formatTimestamp(last.startedAt)],
            [t('web.dcp_last_mode'), t(MODE_LABEL[last.mode])],
            [t('web.dcp_last_state'), t(STATE_LABEL[last.state])],
            ...(last.stopReason === null
              ? []
              : [[t('web.dcp_last_reason'), t(REASON_LABEL[last.stopReason])] as [string, string]]),
            [t('web.dcp_last_total'), String(total(last.counts))],
          ]}
        />
      )}
    </div>
  );
}

export function DataCompactionCard() {
  const [requested, setRequested] = useState(false);
  const preview = useQuery({
    queryKey: ['data-compaction-preview'],
    queryFn: fetchDataCompactionPreview,
    enabled: requested,
  });
  return (
    <div className="stack">
      <p className="muted small">{t('web.dcp_hint')}</p>
      <div className="btn-group">
        <Button
          onClick={() => {
            if (requested) void preview.refetch();
            else setRequested(true);
          }}
          disabled={preview.isFetching}
        >
          {t('web.dcp_preview')}
        </Button>
      </div>
      {requested && (
        <StateSwitch query={preview}>
          {preview.data !== undefined && <Preview preview={preview.data} />}
        </StateSwitch>
      )}
    </div>
  );
}
