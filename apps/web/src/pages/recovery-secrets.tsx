import { useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  PLATFORM_ERROR_CODES,
  type RecoveryRequestSummary,
  type RecoveryRestoreTest,
} from '@nexa/contracts';
import {
  ApiError,
  acknowledgeUnreadableSecrets,
  fetchSecretReentry,
  retestRecovery,
} from '../api/client';
import { formatNumber } from '../format';
import { t } from '../i18n/web.fa';
import { recoveryErrorText } from '../recovery-failure-labels';
import {
  SECRET_PURPOSE_LABELS,
  UNCLEARABLE_SECRET_PURPOSES,
  secretReentryHref,
} from '../secret-purpose-labels';
import { useLinkHandler } from '../router';
import { useSubmissionKey } from '../submission-key';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Banner, SecretInput } from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';

const UNREADABLE_CODE = 'recovery.candidate_secrets_unreadable';

/** The request is the refusal §2.3 describes, with the list the trial decryption recorded. */
export function unreadableSecretsOf(
  recovery: RecoveryRequestSummary,
): NonNullable<RecoveryRestoreTest['unreadableSecrets']> {
  if (recovery.state !== 'FAILED' || recovery.failureCode !== UNREADABLE_CODE) return [];
  return recovery.restoreTest?.unreadableSecrets ?? [];
}

function SecretList({ list }: { list: NonNullable<RecoveryRestoreTest['unreadableSecrets']> }) {
  return (
    <ul className="secret-list">
      {list.map((entry) => (
        <li key={entry.purpose}>
          <span>{t(SECRET_PURPOSE_LABELS[entry.purpose])}</span>{' '}
          <span className="muted small">
            {t('web.secret_unreadable_count')}: {formatNumber(entry.count)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * After `recovery.candidate_secrets_unreadable`: which secrets could not be read, and the
 * two ways on — import the old server's Recovery Kit and test again, or accept re-entering
 * them. Neither is the security: the server re-checks the list and the permission.
 */
export function UnreadableSecretsPanel({
  recovery,
  mayRestore,
  sevenZip,
  onUpdated,
}: {
  recovery: RecoveryRequestSummary;
  mayRestore: boolean;
  /** Whether the upload was a 7-Zip archive, whose test needs its password again. */
  sevenZip: boolean;
  onUpdated: (next: RecoveryRequestSummary) => void;
}) {
  const list = unreadableSecretsOf(recovery);
  const [password, setPassword] = useState('');
  const [asking, setAsking] = useState(false);
  const retestKey = useSubmissionKey();
  const acknowledgeKey = useSubmissionKey();
  const hasRefundCard = list.some((entry) => UNCLEARABLE_SECRET_PURPOSES.includes(entry.purpose));

  const retest = useMutation({
    mutationFn: () => {
      const body = { id: recovery.id, archivePassword: password };
      return retestRecovery({ ...body, idempotencyKey: retestKey.current(body) });
    },
    onSuccess: (result) => {
      retestKey.settle();
      onUpdated(result.recovery);
    },
    onError: (error) => retestKey.settleOn(error),
    // The password is for this one test: cleared whatever the answer.
    onSettled: () => setPassword(''),
  });
  const acknowledge = useMutation({
    mutationFn: () => {
      const body = { id: recovery.id, unreadable: list };
      return acknowledgeUnreadableSecrets({
        ...body,
        idempotencyKey: acknowledgeKey.current(body),
      });
    },
    onSuccess: (result) => {
      acknowledgeKey.settle();
      setAsking(false);
      onUpdated(result.recovery);
    },
    onError: (error) => {
      acknowledgeKey.settleOn(error);
      setAsking(false);
    },
  });

  if (list.length === 0) return null;
  const canUploadKit = recovery.restoreTest?.canUploadKit === true;
  const refused =
    acknowledge.error instanceof ApiError &&
    acknowledge.error.code === PLATFORM_ERROR_CODES.RECOVERY_REFUSED &&
    hasRefundCard;

  return (
    <div className="stack inset" data-testid="unreadable-secrets">
      <Banner tone="warn" title={t('web.secret_unreadable_title')}>
        {t('web.secret_unreadable_intro')}
      </Banner>
      <SecretList list={list} />
      {hasRefundCard && <Banner tone="danger">{t('web.secret_unreadable_refund_card')}</Banner>}
      {!mayRestore ? (
        <Banner tone="neutral">{t('web.secret_unreadable_no_permission')}</Banner>
      ) : (
        <>
          {canUploadKit && (
            <section className="stack" aria-label={t('web.secret_unreadable_kit_choice')}>
              <h4>{t('web.secret_unreadable_kit_choice')}</h4>
              <p className="muted small">{t('web.secret_unreadable_kit_hint')}</p>
              {sevenZip && (
                <label className="field">
                  <span className="field-label">{t('web.secret_unreadable_password_label')}</span>
                  <SecretInput
                    value={password}
                    onChange={(event) => setPassword(event.currentTarget.value)}
                  />
                </label>
              )}
              <div className="btn-group">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => retest.mutate()}
                  disabled={retest.isPending}
                >
                  {retest.isPending
                    ? t('web.secret_unreadable_retesting')
                    : t('web.secret_unreadable_retest')}
                </button>
              </div>
              {retest.error !== null && (
                <Banner tone="danger">
                  {recoveryErrorText(retest.error)}
                  <ErrorRef error={retest.error} />
                </Banner>
              )}
            </section>
          )}
          <section className="stack">
            <p className="muted small">{t('web.secret_unreadable_continue_hint')}</p>
            <div className="btn-group">
              <button
                type="button"
                className="btn"
                onClick={() => setAsking(true)}
                disabled={acknowledge.isPending || hasRefundCard}
              >
                {t('web.secret_unreadable_continue')}
              </button>
            </div>
            {acknowledge.error !== null && (
              <Banner tone="danger">
                {refused
                  ? t('web.secret_unreadable_refund_card')
                  : recoveryErrorText(acknowledge.error)}
                <ErrorRef error={acknowledge.error} />
              </Banner>
            )}
          </section>
        </>
      )}
      {asking && (
        <ConfirmDialog
          title={t('web.secret_unreadable_dialog_title')}
          question={t('web.secret_unreadable_dialog_question')}
          detail={t('web.secret_unreadable_dialog_bots')}
          extra={<SecretList list={list} />}
          confirmLabel={t('web.secret_unreadable_dialog_confirm')}
          cancelLabel={t('web.secret_unreadable_dialog_cancel')}
          confirmDisabled={acknowledge.isPending}
          onConfirm={() => acknowledge.mutate()}
          onCancel={() => setAsking(false)}
        />
      )}
    </div>
  );
}

/** The restore's effect on stored secrets as one line, or null when it touched none. */
export function secretsOutcomeText(recovery: RecoveryRequestSummary): string | null {
  const rewrapped = recovery.restoreTest?.secretsRewrapped ?? 0;
  const cleared = recovery.restoreTest?.secretsCleared ?? 0;
  const parts: string[] = [];
  if (rewrapped > 0) parts.push(`${formatNumber(rewrapped)} ${t('web.secret_summary_rewrapped')}`);
  if (cleared > 0) parts.push(`${formatNumber(cleared)} ${t('web.secret_summary_cleared')}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** What the restore did to stored secrets, and the acknowledgment still waiting for the typed phrase. */
export function RestoreSecretsSummary({ recovery }: { recovery: RecoveryRequestSummary }) {
  const test = recovery.restoreTest;
  if (test === null) return null;
  const rewrapped = test.secretsRewrapped ?? 0;
  const cleared = test.secretsCleared ?? 0;
  const waiting = recovery.state === 'RESTORE_TEST_PASSED' && test.clearUnreadable === true;
  if (rewrapped === 0 && cleared === 0 && !waiting) return null;
  const lines: ReactNode[] = [];
  if (waiting) lines.push(<p key="w">{t('web.secret_unreadable_acknowledged')}</p>);
  if (rewrapped > 0) {
    lines.push(
      <p key="r">
        {formatNumber(rewrapped)} {t('web.secret_summary_rewrapped')}
      </p>,
    );
  }
  if (cleared > 0) {
    lines.push(
      <p key="c">
        {formatNumber(cleared)} {t('web.secret_summary_cleared')}
      </p>,
    );
  }
  return <Banner tone={cleared > 0 ? 'warn' : 'info'}>{lines}</Banner>;
}

/**
 * Drawn above every page of the shell while a restore's cleared secrets are still not
 * re-entered. The list is the server's, recomputed on each read: re-entering a value through
 * its page removes its row. Nothing is drawn without `backup.view`, while empty, or when the
 * read failed (a missing strip is not a claim that nothing is owed).
 */
export function SecretReentryStrip({ mayView }: { mayView: boolean }) {
  const onLink = useLinkHandler();
  const reentry = useQuery({
    queryKey: ['secret-reentry'],
    queryFn: fetchSecretReentry,
    enabled: mayView,
    refetchInterval: 60_000,
  });
  const items = mayView ? (reentry.data?.items ?? []) : [];
  if (items.length === 0) return null;
  return (
    <div className="incident-banners" aria-label={t('web.secret_reentry_label')}>
      <div className="incident-banner is-warn" role="status">
        <div className="incident-banner-text">
          <strong>{t('web.secret_reentry_title')}</strong>
          <ul className="secret-list">
            {items.map((item) => (
              <li key={`${item.purpose}:${item.entityId}`}>
                <span>{t(SECRET_PURPOSE_LABELS[item.purpose])}</span>
                {item.label !== null && <span className="faint"> · {item.label}</span>}{' '}
                <a className="btn sm" href={secretReentryHref(item)} onClick={onLink}>
                  {t('web.secret_reentry_open')}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
