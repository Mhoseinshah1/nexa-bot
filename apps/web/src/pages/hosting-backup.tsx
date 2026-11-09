import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BACKUP_ARCHIVE_PASSWORD_MIN_LENGTH,
  HOSTED_BACKUP_KEEP_MAX,
  HOSTED_BACKUP_KEEP_MIN,
  type HostedBackupArchiveView,
  type HostedBotView,
} from '@nexa/contracts';
import {
  downloadHostedArchive,
  fetchHostedBackup,
  requestHostedBackupRun,
  restoreHostedArchiveHere,
  setHostedBackupPassword,
  setHostedBackupSchedule,
} from '../api/client';
import { formatNumber, formatTimestamp, splitBytes } from '../format';
import { t } from '../i18n/web.fa';
import { TimeField24 } from '../ui/time-field24';
import {
  Badge,
  Banner,
  Button,
  Empty,
  Field,
  KV,
  SecretInput,
  StateSwitch,
  Switch,
  useToast,
} from '../ui/kit';
import { CodePromptDialog } from './hosting-parts';
import { RESTORES_KEY } from './hosting-restore';

/**
 * Phase 6B PR-2 (ADR-0039 § 7): one hosted bot's backups, inside its card in «میزبانی‌ها».
 * Every action opens `CodePromptDialog` (a fresh code); the server checks the owner, the
 * section session and the code again — nothing here is the security.
 */

const DASH = '—';

type Dialog =
  | { readonly kind: 'schedule' }
  | { readonly kind: 'password' }
  | { readonly kind: 'run' }
  | { readonly kind: 'download'; readonly archive: HostedBackupArchiveView }
  | { readonly kind: 'restore-here'; readonly archive: HostedBackupArchiveView };

export function hostedBackupKey(tenantId: string) {
  return ['hosting', 'bots', tenantId, 'backup'] as const;
}

export function HostedBackupSection({ bot }: { bot: HostedBotView }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const backup = useQuery({
    queryKey: hostedBackupKey(bot.tenantId),
    queryFn: () => fetchHostedBackup(bot.tenantId),
  });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const policy = backup.data?.policy;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [dailyTime, setDailyTime] = useState<string | null>(null);
  const [keep, setKeep] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [archivePassword, setArchivePassword] = useState('');
  const keepId = useId();
  const passwordId = useId();
  const repeatId = useId();
  const archivePasswordId = useId();

  const draft = {
    enabled: enabled ?? policy?.enabled ?? true,
    dailyTime: dailyTime ?? policy?.dailyTime ?? '04:30',
    keep: keep ?? String(policy?.keep ?? 7),
  };
  const keepNumber = Number(draft.keep);
  const keepValid =
    Number.isInteger(keepNumber) &&
    keepNumber >= HOSTED_BACKUP_KEEP_MIN &&
    keepNumber <= HOSTED_BACKUP_KEEP_MAX;
  const passwordValid =
    password.length >= BACKUP_ARCHIVE_PASSWORD_MIN_LENGTH && password === repeat;

  const done = (): void => {
    setDialog(null);
    setPassword('');
    setRepeat('');
    void queryClient.invalidateQueries({ queryKey: hostedBackupKey(bot.tenantId) });
    toast({ tone: 'ok', message: t('web.hosted_backup_saved') });
  };

  return (
    <div className="stack hosted-backup">
      <p className="muted small">{t('web.hosted_backup_hint')}</p>
      <StateSwitch query={backup}>
        {policy !== undefined && (
          <>
            <h4>{t('web.hosted_backup_password')}</h4>
            {policy.passwordSetAt === null ? (
              <Banner tone="warn">{t('web.hosted_backup_password_none')}</Banner>
            ) : (
              <KV
                items={[
                  [t('web.hosted_backup_password_set_at'), formatTimestamp(policy.passwordSetAt)],
                ]}
              />
            )}
            <div className="hosting-actions">
              <Button size="sm" icon="lock" onClick={() => setDialog({ kind: 'password' })}>
                {policy.passwordSetAt === null
                  ? t('web.hosted_backup_password_set')
                  : t('web.hosted_backup_password_change')}
              </Button>
              <Button
                size="sm"
                icon="play"
                disabled={policy.passwordSetAt === null || bot.state === 'PURGED'}
                onClick={() => setDialog({ kind: 'run' })}
              >
                {t('web.hosted_backup_run_now')}
              </Button>
            </div>
            {policy.runRequestedAt !== null && (
              <p className="muted small">
                {t('web.hosted_backup_run_requested')} {formatTimestamp(policy.runRequestedAt)}
              </p>
            )}

            <h4>{t('web.hosted_backup_schedule')}</h4>
            <Switch
              checked={draft.enabled}
              onChange={setEnabled}
              label={t('web.hosted_backup_enabled_switch')}
            />
            <span className="muted small">
              {draft.enabled
                ? t('web.hosted_backup_schedule_on')
                : t('web.hosted_backup_schedule_off')}
            </span>
            <Field label={t('web.hosted_backup_daily_time')}>
              <TimeField24
                value={draft.dailyTime}
                onChange={setDailyTime}
                label={t('web.hosted_backup_daily_time')}
              />
            </Field>
            <Field label={t('web.hosted_backup_keep')} htmlFor={keepId}>
              <input
                id={keepId}
                className="input"
                type="number"
                inputMode="numeric"
                dir="ltr"
                min={HOSTED_BACKUP_KEEP_MIN}
                max={HOSTED_BACKUP_KEEP_MAX}
                value={draft.keep}
                onChange={(event) => setKeep(event.target.value)}
              />
            </Field>
            <div className="hosting-actions">
              <Button
                size="sm"
                variant="primary"
                disabled={!keepValid}
                onClick={() => setDialog({ kind: 'schedule' })}
              >
                {t('web.hosted_backup_schedule_save')}
              </Button>
            </div>

            <h4>{t('web.hosted_backup_archives')}</h4>
            {backup.data?.archives.length === 0 ? (
              <Empty icon="archive" title={t('web.hosted_backup_archives_empty')} />
            ) : (
              <ul className="hosted-backup-archives">
                {backup.data?.archives.map((archive) => (
                  <ArchiveRow
                    key={archive.id}
                    archive={archive}
                    onDownload={() => setDialog({ kind: 'download', archive })}
                    {...(bot.state === 'PURGED'
                      ? {}
                      : { onRestoreHere: () => setDialog({ kind: 'restore-here', archive }) })}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </StateSwitch>

      {dialog?.kind === 'schedule' && (
        <CodePromptDialog
          title={t('web.hosted_backup_schedule_title')}
          hint={`${bot.displayName} — ${draft.dailyTime} · ${formatNumber(keepNumber)}`}
          confirmLabel={t('web.hosted_backup_schedule_save')}
          valid={keepValid}
          run={({ proof, idempotencyKey }) =>
            setHostedBackupSchedule(bot.tenantId, {
              idempotencyKey,
              proof,
              enabled: draft.enabled,
              dailyTime: draft.dailyTime,
              keep: keepNumber,
            })
          }
          onClose={() => setDialog(null)}
          onDone={done}
        />
      )}
      {dialog?.kind === 'password' && (
        <CodePromptDialog
          title={t('web.hosted_backup_password_title')}
          hint={t('web.hosted_backup_password_hint')}
          confirmLabel={t('web.hosted_backup_password_set')}
          valid={passwordValid}
          run={({ proof, idempotencyKey }) =>
            setHostedBackupPassword(bot.tenantId, { idempotencyKey, proof, password })
          }
          onClose={() => setDialog(null)}
          onDone={done}
        >
          <Field label={t('web.hosted_backup_password_field')} htmlFor={passwordId}>
            <SecretInput
              id={passwordId}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Field
            label={t('web.hosted_backup_password_repeat')}
            htmlFor={repeatId}
            {...(repeat !== '' && repeat !== password
              ? { error: t('web.hosted_backup_password_mismatch') }
              : {})}
          >
            <SecretInput
              id={repeatId}
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
            />
          </Field>
        </CodePromptDialog>
      )}
      {dialog?.kind === 'run' && (
        <CodePromptDialog
          title={t('web.hosted_backup_run_title')}
          hint={t('web.hosted_backup_run_hint')}
          confirmLabel={t('web.hosted_backup_run_now')}
          run={({ proof, idempotencyKey }) =>
            requestHostedBackupRun(bot.tenantId, { idempotencyKey, proof })
          }
          onClose={() => setDialog(null)}
          onDone={done}
        />
      )}
      {dialog?.kind === 'restore-here' && (
        <CodePromptDialog
          title={t('web.hosted_backup_restore_here_title')}
          hint={t('web.hosted_backup_restore_here_hint')}
          confirmLabel={t('web.hosted_restore_dry_run')}
          valid={archivePassword !== ''}
          danger
          run={({ proof }) =>
            restoreHostedArchiveHere(bot.tenantId, dialog.archive.id, {
              proof,
              password: archivePassword,
            })
          }
          onClose={() => {
            setArchivePassword('');
            setDialog(null);
          }}
          onDone={() => {
            setArchivePassword('');
            setDialog(null);
            void queryClient.invalidateQueries({ queryKey: RESTORES_KEY });
            toast({ tone: 'ok', message: t('web.hosted_backup_restore_here_done') });
          }}
        >
          <Field label={t('web.hosted_backup_restore_here_password')} htmlFor={archivePasswordId}>
            <SecretInput
              id={archivePasswordId}
              value={archivePassword}
              onChange={(event) => setArchivePassword(event.target.value)}
            />
          </Field>
        </CodePromptDialog>
      )}
      {dialog?.kind === 'download' && (
        <CodePromptDialog
          title={t('web.hosted_backup_download_title')}
          hint={t('web.hosted_backup_download_hint')}
          confirmLabel={t('web.hosted_backup_download')}
          run={({ proof }) => downloadHostedArchive(bot.tenantId, dialog.archive.id, proof)}
          onClose={() => setDialog(null)}
          onDone={(blob) => {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `nexa-hosted-${bot.tenantId}-${dialog.archive.id}.7z`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 0);
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function ArchiveRow({
  archive,
  onDownload,
  onRestoreHere,
}: {
  archive: HostedBackupArchiveView;
  onDownload: () => void;
  /** Restore this archive over the same bot; absent for a purged bot (closed for good). */
  onRestoreHere?: () => void;
}) {
  const size = archive.archiveBytes === null ? null : splitBytes(BigInt(archive.archiveBytes));
  const status =
    archive.state === 'RUNNING'
      ? { tone: 'info' as const, label: t('web.hosted_backup_status_running') }
      : archive.state === 'FAILED'
        ? { tone: 'danger' as const, label: t('web.hosted_backup_status_failed') }
        : archive.available
          ? { tone: 'ok' as const, label: t('web.hosted_backup_status_ok') }
          : { tone: 'neutral' as const, label: t('web.hosted_backup_status_gone') };
  return (
    <li className="hosted-backup-archive">
      <KV
        inline
        items={[
          [t('web.hosted_backup_archive_time'), formatTimestamp(archive.startedAt)],
          [
            t('web.hosted_backup_archive_size'),
            size === null ? DASH : `${size.value} ${t(size.unit)}`,
          ],
          [
            t('web.hosted_backup_archive_status'),
            <Badge key="status" tone={status.tone}>
              {status.label}
            </Badge>,
          ],
        ]}
      />
      {archive.deliveryState === 'SUCCEEDED' && (
        <span className="muted small">{t('web.hosted_backup_delivery_group')}</span>
      )}
      {archive.available && (
        <div className="hosting-actions">
          <Button size="sm" icon="download" onClick={onDownload}>
            {t('web.hosted_backup_download')}
          </Button>
          {onRestoreHere !== undefined && (
            <Button size="sm" icon="refresh" onClick={onRestoreHere}>
              {t('web.hosted_backup_restore_here')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
