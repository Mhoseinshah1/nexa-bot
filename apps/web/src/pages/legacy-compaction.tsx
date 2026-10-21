import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LEGACY_COMPACTION_CONFIRMATION_PHRASE,
  type LegacyCompactionRun,
  type LegacyCompactionState,
} from '@nexa/contracts';
import { ApiError, fetchLegacyCompaction, requestLegacyCompaction } from '../api/client';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { Banner, KV, StateSwitch } from '../ui/kit';
import { errorText } from '../error-text';
import { ErrorRef } from '../ui/technical-details';
import { formatTimestamp } from '../format';

/**
 * «فشرده‌سازی داده‌های ربات قبلی» — Round 4 PR-E, E1.
 *
 * An owner action, irreversible, offered only once an import has completed and none is
 * running. The press writes a request; the worker takes the «آرشیو ربات قبلی» backup first
 * and deletes nothing unless every part of it reached Telegram. While the history tables
 * are rewritten (VACUUM FULL) the card says the legacy pages are in maintenance.
 */

const STATE_LABEL: Readonly<Record<LegacyCompactionState, WebKey>> = {
  REQUESTED: 'web.lcp_state_requested',
  ARCHIVING: 'web.lcp_state_archiving',
  MEASURING: 'web.lcp_state_measuring',
  DROPPING: 'web.lcp_state_dropping',
  DEDUPING: 'web.lcp_state_deduping',
  STRIPPING: 'web.lcp_state_stripping',
  VACUUMING: 'web.lcp_state_vacuuming',
  COMPLETED: 'web.lcp_state_completed',
  FAILED: 'web.lcp_state_failed',
};

function mib(bytes: string | undefined): string {
  return bytes === undefined ? '—' : `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MiB`;
}

function Report({ run }: { run: LegacyCompactionRun }) {
  if (run.before === null) return null;
  const tables = Object.keys(run.before.tables);
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t('web.lcp_table')}</th>
          <th>{t('web.lcp_before')}</th>
          <th>{t('web.lcp_after')}</th>
        </tr>
      </thead>
      <tbody>
        {tables.map((name) => (
          <tr key={name}>
            <td>
              <bdi dir="ltr" className="ltr mono">
                {name}
              </bdi>
            </td>
            <td>{mib(run.before?.tables[name])}</td>
            <td>{mib(run.after?.tables[name])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LegacyCompactionCard({ mayApply }: { mayApply: boolean }) {
  const queryClient = useQueryClient();
  const [phrase, setPhrase] = useState('');
  const key = useSubmissionKey();
  const status = useQuery({
    queryKey: ['legacy-compaction'],
    queryFn: fetchLegacyCompaction,
    refetchInterval: (query) => {
      const state = query.state.data?.run?.state;
      return state !== undefined && state !== 'COMPLETED' && state !== 'FAILED' ? 5_000 : false;
    },
  });
  const request = useMutation({
    mutationFn: () => requestLegacyCompaction({ idempotencyKey: key.current({ phrase }), phrase }),
    onSuccess: () => {
      key.settle();
      setPhrase('');
      void queryClient.invalidateQueries({ queryKey: ['legacy-compaction'] });
    },
    onError: (error) => {
      if (error instanceof ApiError) key.settle();
    },
  });
  const run = status.data?.run ?? null;

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (phrase.trim() !== LEGACY_COMPACTION_CONFIRMATION_PHRASE) return;
    request.mutate();
  };

  return (
    <StateSwitch query={status}>
      <div className="stack">
        <p className="muted small">{t('web.lcp_hint')}</p>
        {run !== null && (
          <KV
            items={[
              [t('web.lcp_state'), t(STATE_LABEL[run.state])],
              [t('web.lcp_requested'), formatTimestamp(run.requestedAt)],
              [t('web.lcp_deleted'), String(run.deleted)],
              [t('web.lcp_deduplicated'), String(run.deduplicated)],
              [t('web.lcp_stripped'), String(run.stripped)],
            ]}
          />
        )}
        {run?.state === 'VACUUMING' && <Banner tone="warn">{t('web.lcp_maintenance')}</Banner>}
        {run?.state === 'FAILED' && (
          <Banner tone="danger">
            {t(
              run.failureCode === 'legacy_compaction.archive_out_of_memory'
                ? 'web.lcp_failed_memory'
                : 'web.lcp_failed',
            )}{' '}
            <bdi dir="ltr" className="ltr mono">
              {run.failureCode}
            </bdi>
          </Banner>
        )}
        {run !== null && <Report run={run} />}
        {status.data?.available === true && mayApply && (
          <form onSubmit={onSubmit} className="stack" autoComplete="off">
            <Banner tone="danger">{t('web.lcp_warning')}</Banner>
            <label className="field">
              <span className="field-label">
                {t('web.lcp_type_phrase').replace(
                  '{phrase}',
                  LEGACY_COMPACTION_CONFIRMATION_PHRASE,
                )}
              </span>
              <input
                className="input"
                dir="ltr"
                value={phrase}
                onChange={(event) => setPhrase(event.currentTarget.value)}
              />
            </label>
            <div className="btn-group">
              <button
                type="submit"
                className="btn danger"
                disabled={
                  phrase.trim() !== LEGACY_COMPACTION_CONFIRMATION_PHRASE || request.isPending
                }
              >
                {t('web.lcp_start')}
              </button>
            </div>
          </form>
        )}
        {status.data?.available === false && run === null && (
          <Banner tone="neutral">{t('web.lcp_unavailable')}</Banner>
        )}
        {request.error !== null && (
          <Banner tone="danger">
            {errorText(request.error)}
            <ErrorRef error={request.error} />
          </Banner>
        )}
      </div>
    </StateSwitch>
  );
}
