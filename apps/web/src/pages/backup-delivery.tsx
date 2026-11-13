import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BACKUP_LOCAL_ONLY_REASONS,
  type BackupDeliveryReason,
  type BackupDeliveryState,
  type BackupRunSummary,
} from '@nexa/contracts';
import { redeliverBackup } from '../api/client';
import { t, type WebKey } from '../i18n/web.fa';
import { Badge, Banner } from '../ui/kit';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { errorText } from '../error-text';
import { ErrorRef } from '../ui/technical-details';
import { useSubmissionKey } from '../submission-key';

/**
 * A backup run's Telegram delivery, part by part (NEXA-BACKUP-DELIVERY).
 *
 * What the row says comes from the server and only from it: each part's state, the REASON
 * CODE of why it is where it is (never the transport's message, which stays off the wire),
 * how many times it was sent, and whether «ارسال دوبارهٔ بخش‌های نرسیده» applies — the
 * server's `redeliverable`, never a rule recomputed here. A run kept on the server by design
 * (a Mirza import's backup, a server-move member) reads as that, not as a failed delivery.
 */

export const BACKUP_REASON_LABEL: Readonly<Record<BackupDeliveryReason, WebKey>> = {
  LOCAL_ONLY_IMPORT: 'web.backup_reason_local_only_import',
  LOCAL_ONLY_SERVER_MOVE: 'web.backup_reason_local_only_server_move',
  LOCAL_ONLY_REQUESTED: 'web.backup_reason_local_only_requested',
  NO_DESTINATION: 'web.backup_reason_no_destination',
  DESTINATION_UNAVAILABLE: 'web.backup_reason_destination_unavailable',
  ARCHIVE_UNREADABLE: 'web.backup_reason_archive_unreadable',
  CONNECT_FAILED: 'web.backup_reason_connect_failed',
  TELEGRAM_REFUSED: 'web.backup_reason_telegram_refused',
  RATE_LIMITED: 'web.backup_reason_rate_limited',
  TELEGRAM_SERVER_ERROR: 'web.backup_reason_telegram_server_error',
  ANSWER_UNREADABLE: 'web.backup_reason_answer_unreadable',
  DEADLINE_EXCEEDED: 'web.backup_reason_deadline_exceeded',
  CONNECTION_RESET: 'web.backup_reason_connection_reset',
  TRANSPORT_ERROR: 'web.backup_reason_transport_error',
};

/** Whether a reason means "kept on this server on purpose". */
export function isLocalOnly(reason: BackupDeliveryReason | null): boolean {
  return reason !== null && (BACKUP_LOCAL_ONLY_REASONS as readonly string[]).includes(reason);
}

/**
 * The Telegram delivery outcome.
 *
 * The prop is `outcome`, not `state`: `state={` is a token the query-view
 * contract scan forbids across `apps/web/src`, because `<StateSwitch state={…}>`
 * was the shape where a view computed its own loading state and got it out of
 * step with the query it was rendering. This component has nothing to do with
 * that, and a name that trips a guard is a name that gets the guard relaxed.
 */
export function DeliveryBadge({ outcome }: { outcome: BackupDeliveryState }) {
  if (outcome === 'SUCCEEDED')
    return <Badge tone="ok">{t('web.recovery_delivery_succeeded')}</Badge>;
  if (outcome === 'FAILED_DEFINITIVE')
    return <Badge tone="danger">{t('web.recovery_delivery_failed')}</Badge>;
  // The third outcome, and the reason the enum has four members: we sent bytes
  // and never learned the verdict. Rendered as its own state, never folded into
  // a failure.
  if (outcome === 'OUTCOME_UNKNOWN')
    return <Badge tone="warn">{t('web.recovery_delivery_unknown')}</Badge>;
  return <Badge tone="neutral">{t('web.recovery_delivery_not_attempted')}</Badge>;
}

type PartView = {
  readonly partNumber: number;
  readonly deliveryState: BackupDeliveryState;
  readonly deliveryReason: BackupDeliveryReason | null;
  readonly attempts: number;
};

/**
 * Each part, in order: its state, why, and how many sends. A part never tried after an
 * earlier one stopped says so, rather than a bare «ارسال نشد».
 */
export function BackupPartList({ parts }: { parts: readonly PartView[] }) {
  if (parts.length === 0) return null;
  let stoppedBefore = false;
  return (
    <ul className="backup-parts" aria-label={t('web.backup_parts_title')}>
      {parts.map((part) => {
        const waiting = part.deliveryState === 'NOT_ATTEMPTED' && stoppedBefore;
        if (part.deliveryState !== 'SUCCEEDED') stoppedBefore = true;
        return (
          <li key={part.partNumber} className="backup-part">
            <span className="nowrap">
              {t('web.backup_part_label').replace('{n}', String(part.partNumber))}
            </span>{' '}
            <DeliveryBadge outcome={part.deliveryState} />
            {part.deliveryReason !== null && (
              <span className="muted small"> {t(BACKUP_REASON_LABEL[part.deliveryReason])}</span>
            )}
            {waiting && <span className="muted small"> {t('web.backup_part_waiting')}</span>}
            {part.attempts > 1 && (
              <span className="muted small">
                {' '}
                ({t('web.backup_part_attempts').replace('{n}', String(part.attempts))})
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The history table's delivery cell. */
export function BackupDeliveryCell({ run, mayRun }: { run: BackupRunSummary; mayRun: boolean }) {
  const byDesign = isLocalOnly(run.deliveryReason);
  const showParts =
    !byDesign &&
    (run.parts.length > 1 || run.parts.some((part) => part.deliveryState !== 'SUCCEEDED'));
  return (
    <div className="stack small">
      {byDesign ? (
        <Badge tone="info">{t('web.backup_delivery_by_design')}</Badge>
      ) : (
        <DeliveryBadge outcome={run.deliveryState} />
      )}
      {run.deliveryReason !== null && (
        <span className="muted small">{t(BACKUP_REASON_LABEL[run.deliveryReason])}</span>
      )}
      {showParts && <BackupPartList parts={run.parts} />}
      {run.redeliverable && mayRun && <RedeliverButton runId={run.id} />}
    </div>
  );
}

/**
 * «ارسال دوبارهٔ بخش‌های نرسیده». Asks first: a part whose earlier answer was lost may then
 * be in the group twice. One key per press, kept across a lost answer (`useSubmissionKey`);
 * the server's re-delivery lease is what makes a double press safe.
 */
function RedeliverButton({ runId }: { runId: string }) {
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const key = useSubmissionKey();
  const redeliver = useMutation({
    mutationFn: () => redeliverBackup(runId, { idempotencyKey: key.current(`redeliver:${runId}`) }),
    onSuccess: () => key.settle(),
    onError: (error) => key.settleOn(error),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['backup-history'] }),
        client.invalidateQueries({ queryKey: ['backup-status'] }),
      ]);
    },
  });
  const outcome = redeliver.data?.outcome;
  return (
    <div className="stack small">
      <button
        type="button"
        className="btn sm"
        disabled={redeliver.isPending}
        onClick={() => setAsking(true)}
      >
        {redeliver.isPending ? t('web.backup_redeliver_sending') : t('web.backup_redeliver')}
      </button>
      {outcome === 'DELIVERED' && <Banner tone="ok">{t('web.backup_redeliver_delivered')}</Banner>}
      {outcome === 'NOT_DELIVERED' && (
        <Banner tone="warn">{t('web.backup_redeliver_not_delivered')}</Banner>
      )}
      {outcome === 'BUSY' && <Banner tone="info">{t('web.backup_redeliver_busy')}</Banner>}
      {redeliver.error !== null && (
        <Banner tone="danger">
          {errorText(redeliver.error)}
          <ErrorRef error={redeliver.error} />
        </Banner>
      )}
      {asking && (
        <ConfirmDialog
          title={t('web.backup_redeliver')}
          question={t('web.backup_redeliver_confirm')}
          confirmLabel={t('web.backup_redeliver_confirm_yes')}
          cancelLabel={t('web.backup_redeliver_cancel')}
          onConfirm={() => {
            setAsking(false);
            redeliver.mutate();
          }}
          onCancel={() => setAsking(false)}
        />
      )}
    </div>
  );
}
