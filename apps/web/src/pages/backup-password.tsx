import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BACKUP_ARCHIVE_PASSWORD_MAX_LENGTH,
  BACKUP_ARCHIVE_PASSWORD_MIN_LENGTH,
  type BackupStatusResponse,
} from '@nexa/contracts';
import { ApiError, setBackupArchivePassword } from '../api/client';
import { useSubmissionKey } from '../submission-key';
import { t } from '../i18n/web.fa';
import { Banner, KV } from '../ui/kit';
import { formatTimestamp } from '../format';
import { Icon } from '../ui/icons';
import { errorText } from '../error-text';
import { ErrorRef } from '../ui/technical-details';
import { StepUpCodeField } from './recovery-kit';

/**
 * «رمز فایل بکاپ» — Round 4 PR-E, E4.
 *
 * The owner sets the password every backup archive is sealed with from the next run on: a
 * 7-Zip archive (AES-256, encrypted headers) that opens in 7-Zip on Windows with this
 * password alone. Typed twice, behind the account password (and the two-step code when it
 * is on), and NEVER shown again — the card says only whether one is set and since when.
 *
 * Every secret field is cleared whatever the answer: a password in a form field outlives
 * the reason it was typed for.
 */
export function BackupPasswordCard({
  status,
  mayEdit,
}: {
  status: BackupStatusResponse;
  mayEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);
  const submissionKey = useSubmissionKey();

  const setter = useMutation({
    mutationFn: (input: {
      password: string;
      confirmation: string;
      accountPassword: string;
      code: string;
    }) =>
      setBackupArchivePassword({
        // The fingerprint names the command, never the secret it carries.
        idempotencyKey: submissionKey.current({ action: 'backup-archive-password' }),
        password: input.password,
        confirmation: input.confirmation,
        accountPassword: input.accountPassword,
        ...(input.code.trim() === '' ? {} : { code: input.code.replace(/\s+/g, '') }),
      }),
    onSuccess: () => {
      submissionKey.settle();
      setDone(true);
      void queryClient.invalidateQueries({ queryKey: ['backup-status'] });
    },
    onError: (error) => {
      if (error instanceof ApiError) submissionKey.settle();
    },
    onSettled: () => {
      setPassword('');
      setAgain('');
      setAccountPassword('');
      setCode('');
    },
  });

  const length = [...password].length;
  const short = password !== '' && length < BACKUP_ARCHIVE_PASSWORD_MIN_LENGTH;
  const mismatch = again !== '' && again !== password;
  const ready =
    accountPassword !== '' &&
    length >= BACKUP_ARCHIVE_PASSWORD_MIN_LENGTH &&
    length <= BACKUP_ARCHIVE_PASSWORD_MAX_LENGTH &&
    again === password;

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready) return;
    setDone(false);
    setter.mutate({ password, confirmation: again, accountPassword, code });
  };

  return (
    <div className="stack">
      <KV
        items={[
          [
            t('web.backup_password_state'),
            status.archivePassword.configured
              ? t('web.backup_password_set')
              : t('web.backup_password_unset'),
          ],
          ...(status.archivePassword.setAt === null
            ? []
            : ([
                [t('web.backup_password_set_at'), formatTimestamp(status.archivePassword.setAt)],
              ] as [string, string][])),
        ]}
      />
      <p className="muted small">
        {status.archivePassword.configured
          ? t('web.backup_password_hint_set')
          : t('web.backup_password_hint_unset')}
      </p>
      {!mayEdit ? (
        <Banner tone="neutral">{t('web.backup_password_owner_only')}</Banner>
      ) : (
        <form onSubmit={onSubmit} className="stack" autoComplete="off">
          <label className="field">
            <span className="field-label">{t('web.backup_password_new')}</span>
            <input
              type="password"
              className="input"
              autoComplete="new-password"
              maxLength={BACKUP_ARCHIVE_PASSWORD_MAX_LENGTH}
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('web.backup_password_again')}</span>
            <input
              type="password"
              className="input"
              autoComplete="new-password"
              maxLength={BACKUP_ARCHIVE_PASSWORD_MAX_LENGTH}
              value={again}
              onChange={(event) => setAgain(event.currentTarget.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('web.kit_account_password')}</span>
            <input
              type="password"
              className="input"
              autoComplete="current-password"
              value={accountPassword}
              onChange={(event) => setAccountPassword(event.currentTarget.value)}
            />
          </label>
          <StepUpCodeField value={code} onChange={setCode} />
          {short && <Banner tone="warn">{t('web.backup_password_short')}</Banner>}
          {mismatch && <Banner tone="warn">{t('web.backup_password_mismatch')}</Banner>}
          <Banner tone="warn">{t('web.backup_password_warning')}</Banner>
          <div className="btn-group">
            <button type="submit" className="btn primary" disabled={!ready || setter.isPending}>
              <Icon name="key" />
              {setter.isPending ? t('web.backup_password_saving') : t('web.backup_password_save')}
            </button>
          </div>
          {done && <Banner tone="ok">{t('web.backup_password_saved')}</Banner>}
          {setter.error !== null && (
            <Banner tone="danger">
              {setter.error instanceof ApiError &&
              setter.error.code === 'backup.archive_password_reauthentication_failed'
                ? t('web.backup_password_reauth_failed')
                : errorText(setter.error)}
              <ErrorRef error={setter.error} />
            </Banner>
          )}
        </form>
      )}
    </div>
  );
}
