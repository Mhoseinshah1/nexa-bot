import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TRIAL_ADMIN_REASON_MAX_LENGTH,
  TRIAL_OVERRIDE_PAGE_DEFAULT,
  TRIAL_RESET_PAGE_DEFAULT,
  type TrialOverrideRowResponse,
  type TrialResetPreviewResponse,
  type TrialResetSummaryResponse,
} from '@nexa/contracts';
import {
  executeTrialReset,
  fetchTrialOverrides,
  fetchTrialResetPreview,
  fetchTrialResets,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { messageFor } from './settings';
import {
  Banner,
  Card,
  Copyable,
  CursorPager,
  DataTable,
  Empty,
  Field,
  KV,
  Ltr,
  PageHead,
  StateSwitch,
  useToast,
  type Column,
} from '../ui/kit';

/**
 * Trials, for an operator (WP6-B, `docs/wp6-audit.md` §7, ADR-0015).
 *
 * Three sections, each drawn on its OWN permission and refused by the server on the
 * same one: the customers with a custom limit (`users.view`), the global reset
 * (`settings.destructive`), and the reset history (`settings.view`). A section the actor
 * may not use says so by name rather than vanishing, so an operator can tell "this does
 * not exist" from "this is not yours".
 */
export function TrialsPage({
  mayViewOverrides,
  mayReset,
  mayViewHistory,
}: {
  mayViewOverrides: boolean;
  mayReset: boolean;
  mayViewHistory: boolean;
}) {
  return (
    <>
      <PageHead title={t('web.trials_title')} maturity="now" />
      <OverridesCard mayView={mayViewOverrides} />
      <ResetCard mayReset={mayReset} />
      <HistoryCard mayView={mayViewHistory} />
    </>
  );
}

function customerName(row: TrialOverrideRowResponse['customer']): string {
  if (row.username !== null) return `@${row.username}`;
  return row.firstName ?? row.telegramUserId;
}

function OverridesCard({ mayView }: { mayView: boolean }) {
  const onLink = useLinkHandler();
  const [trail, setTrail] = useState<string[]>([]);
  const cursor = trail[trail.length - 1] ?? null;
  const overrides = useQuery({
    queryKey: ['trial-overrides', cursor],
    queryFn: () =>
      fetchTrialOverrides({
        limit: TRIAL_OVERRIDE_PAGE_DEFAULT,
        ...(cursor === null ? {} : { cursor }),
      }),
    enabled: mayView,
  });

  if (!mayView) {
    return (
      <Card title={t('web.trials_overrides_title')}>
        <Banner tone="info">{t('web.trials_overrides_denied')}</Banner>
      </Card>
    );
  }

  const columns: Column<TrialOverrideRowResponse>[] = [
    {
      key: 'customer',
      header: t('web.trials_customer'),
      render: (row) => (
        <a
          href={`/users/${encodeURIComponent(row.customer.id)}`}
          onClick={onLink}
          className="strong"
        >
          <Ltr mono={false}>{customerName(row.customer)}</Ltr>
        </a>
      ),
    },
    { key: 'limit', header: t('web.trial_override'), render: (row) => String(row.limit) },
    { key: 'used', header: t('web.trial_used'), render: (row) => String(row.used) },
    { key: 'remaining', header: t('web.trial_remaining'), render: (row) => String(row.remaining) },
    { key: 'setAt', header: t('web.trials_set_at'), render: (row) => formatTimestamp(row.setAt) },
  ];

  return (
    <Card title={t('web.trials_overrides_title')}>
      <StateSwitch query={overrides}>
        {overrides.data === undefined ? null : overrides.data.overrides.length === 0 &&
          cursor === null ? (
          <Empty title={t('web.trials_overrides_empty')} />
        ) : (
          <>
            <DataTable
              caption={t('web.trials_overrides_title')}
              columns={columns}
              rows={overrides.data.overrides}
              rowKey={(row) => row.customer.id}
            />
            <CursorPager
              shown={overrides.data.overrides.length}
              hasPrevious={trail.length > 0}
              hasNext={overrides.data.nextCursor !== null}
              onPrevious={() => setTrail((previous) => previous.slice(0, -1))}
              onNext={() => {
                const next = overrides.data?.nextCursor;
                if (next !== null && next !== undefined)
                  setTrail((previous) => [...previous, next]);
              }}
            />
          </>
        )}
      </StateSwitch>
      <p className="muted">{t('web.trial_zero_hint')}</p>
    </Card>
  );
}

/**
 * ADR-0010 on one card: dry run, counted preview, typed confirmation plus a reason,
 * then the server's recorded result.
 *
 * The count the operator types is sent as `expectedGrants`, and the server refuses the
 * reset if it would stamp any other number — so the confirmation binds to what was
 * shown, not to the button.
 */
function ResetCard({ mayReset }: { mayReset: boolean }) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [preview, setPreview] = useState<TrialResetPreviewResponse['preview'] | null>(null);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');

  const load = useMutation({
    mutationFn: () => fetchTrialResetPreview(),
    onSuccess: (response) => {
      setPreview(response.preview);
      setTyped('');
    },
  });

  const execute = useMutation({
    mutationFn: () => {
      const body = { expectedGrants: Number(typed.trim()), reason: reason.trim() };
      return executeTrialReset({ ...body, idempotencyKey: submission.current(body) });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.trials_reset_done') });
      setPreview(null);
      setTyped('');
      setReason('');
      void queries.invalidateQueries({ queryKey: ['trial-resets'] });
      void queries.invalidateQueries({ queryKey: ['trial-overrides'] });
      void queries.invalidateQueries({ queryKey: ['customer-trial'] });
    },
    // A stale preview is a 4xx answer: the key is retired and the operator previews
    // again. A 5xx may have committed, and keeps its key.
    onError: (error) => submission.settleOn(error),
  });

  if (!mayReset) {
    return (
      <Card title={t('web.trials_reset_title')}>
        <Banner tone="info">{t('web.trials_reset_denied')}</Banner>
      </Card>
    );
  }

  const confirmed =
    preview !== null &&
    preview.affectedGrants > 0 &&
    typed.trim() === String(preview.affectedGrants) &&
    reason.trim() !== '';

  return (
    <Card title={t('web.trials_reset_title')}>
      <Banner tone="danger">{t('web.trials_reset_body')}</Banner>
      <div className="toolbar">
        <button
          type="button"
          className="btn sm"
          disabled={load.isPending}
          onClick={() => load.mutate()}
        >
          {t('web.trials_reset_preview')}
        </button>
      </div>
      {load.error !== null && <Banner tone="danger">{messageFor(load.error)}</Banner>}

      {preview !== null &&
        (preview.affectedGrants === 0 ? (
          <Banner tone="info">{t('web.trials_reset_nothing')}</Banner>
        ) : (
          <>
            <KV
              items={[
                [t('web.trials_reset_affected'), String(preview.affectedGrants)],
                [t('web.trials_reset_customers'), String(preview.affectedCustomers)],
              ]}
            />
            <h3>{t('web.trials_reset_sample')}</h3>
            <DataTable
              caption={t('web.trials_reset_sample')}
              columns={[
                {
                  key: 'customer',
                  header: t('web.trials_customer'),
                  render: (row) => <Ltr mono={false}>{customerName(row.customer)}</Ltr>,
                },
                {
                  key: 'grants',
                  header: t('web.trials_reset_grants'),
                  render: (row) => String(row.grants),
                },
              ]}
              rows={preview.sample}
              rowKey={(row) => row.customer.id}
            />
            <Field label={t('web.trials_reset_confirm_label')} htmlFor="trial-reset-count">
              <input
                id="trial-reset-count"
                inputMode="numeric"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </Field>
            <Field label={t('web.trials_reset_reason_label')} htmlFor="trial-reset-reason">
              <input
                id="trial-reset-reason"
                value={reason}
                maxLength={TRIAL_ADMIN_REASON_MAX_LENGTH}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <div className="toolbar">
              <button
                type="button"
                className="btn danger sm"
                disabled={!confirmed || execute.isPending}
                onClick={() => execute.mutate()}
              >
                {t('web.trials_reset_execute')}
              </button>
            </div>
            {execute.error !== null && <Banner tone="danger">{messageFor(execute.error)}</Banner>}
          </>
        ))}
    </Card>
  );
}

function HistoryCard({ mayView }: { mayView: boolean }) {
  const [trail, setTrail] = useState<string[]>([]);
  const cursor = trail[trail.length - 1] ?? null;
  const resets = useQuery({
    queryKey: ['trial-resets', cursor],
    queryFn: () =>
      fetchTrialResets({ limit: TRIAL_RESET_PAGE_DEFAULT, ...(cursor === null ? {} : { cursor }) }),
    enabled: mayView,
  });

  if (!mayView) {
    return (
      <Card title={t('web.trials_history_title')}>
        <Banner tone="info">{t('web.trials_history_denied')}</Banner>
      </Card>
    );
  }

  const columns: Column<TrialResetSummaryResponse>[] = [
    {
      key: 'createdAt',
      header: t('web.trials_history_time'),
      render: (row) => formatTimestamp(row.createdAt),
    },
    {
      key: 'grants',
      header: t('web.trials_reset_affected'),
      render: (row) => String(row.affectedGrants),
    },
    {
      key: 'customers',
      header: t('web.trials_reset_customers'),
      render: (row) => String(row.affectedCustomers),
    },
    { key: 'reason', header: t('web.trials_history_reason'), render: (row) => row.reason },
    {
      key: 'actor',
      header: t('web.trials_history_actor'),
      render: (row) => <Copyable value={row.actorAdminId} />,
    },
  ];

  return (
    <Card title={t('web.trials_history_title')}>
      <StateSwitch query={resets}>
        {resets.data === undefined ? null : resets.data.resets.length === 0 && cursor === null ? (
          <Empty title={t('web.trials_history_empty')} />
        ) : (
          <>
            <DataTable
              caption={t('web.trials_history_title')}
              columns={columns}
              rows={resets.data.resets}
              rowKey={(row) => row.id}
            />
            <CursorPager
              shown={resets.data.resets.length}
              hasPrevious={trail.length > 0}
              hasNext={resets.data.nextCursor !== null}
              onPrevious={() => setTrail((previous) => previous.slice(0, -1))}
              onNext={() => {
                const next = resets.data?.nextCursor;
                if (next !== null && next !== undefined)
                  setTrail((previous) => [...previous, next]);
              }}
            />
          </>
        )}
      </StateSwitch>
    </Card>
  );
}
