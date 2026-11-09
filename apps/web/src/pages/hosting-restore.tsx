import { useId, useState, type ReactNode } from 'react';
import { FilePicker } from '../ui/file-picker';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  hostedBotSlugSchema,
  type TenantRestoreState,
  type TenantRestoreView,
} from '@nexa/contracts';
import {
  cancelTenantRestore,
  confirmTenantRestore,
  dryRunTenantRestore,
  fetchTenantRestores,
  uploadTenantRestore,
} from '../api/client';
import { ERROR_TEXT, errorText } from '../error-text';
import { formatNumber, formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import {
  Badge,
  Button,
  Empty,
  Field,
  KV,
  Ltr,
  SecretInput,
  StateSwitch,
  Switch,
  useToast,
} from '../ui/kit';
import { CodePromptDialog, HOSTING_BOTS_KEY } from './hosting-parts';

/**
 * Phase 6B PR-2 (ADR-0039 § 4): «بازیابی ربات از فایل» — upload a hosted archive from any Nexa
 * install, run the dry run with its password (a fresh code), then confirm (a fresh code) or
 * «لغو». The restore itself runs in the recovery role, never in this request; the list polls
 * the row's state while one is in progress.
 */

export const RESTORES_KEY = ['hosting', 'restores'] as const;

/** A failure code stored on the row, in words (an unknown one reads as the generic error). */
function failureText(code: string): string {
  const key = (ERROR_TEXT as Readonly<Record<string, WebKey | undefined>>)[code];
  return key === undefined ? t('web.error') : t(key);
}

type Dialog =
  | { readonly kind: 'dry-run'; readonly restoreId: string }
  | { readonly kind: 'confirm'; readonly restore: TenantRestoreView }
  | { readonly kind: 'cancel'; readonly restore: TenantRestoreView };

const STATE_LABEL: Record<
  TenantRestoreState,
  { readonly tone: 'ok' | 'info' | 'warn' | 'danger' | 'neutral'; readonly label: WebKey }
> = {
  REQUESTED: { tone: 'info', label: 'web.hosted_restore_state_verifying' },
  VERIFYING: { tone: 'info', label: 'web.hosted_restore_state_verifying' },
  VERIFIED: { tone: 'warn', label: 'web.hosted_restore_state_verified' },
  APPLYING: { tone: 'info', label: 'web.hosted_restore_state_applying' },
  SUCCEEDED: { tone: 'ok', label: 'web.hosted_restore_state_succeeded' },
  FAILED: { tone: 'danger', label: 'web.hosted_restore_state_failed' },
};

export function HostedRestoreSection() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const fileId = useId();
  const passwordId = useId();
  const slugId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [slug, setSlug] = useState('');
  const [replace, setReplace] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const restores = useQuery({
    queryKey: RESTORES_KEY,
    queryFn: fetchTenantRestores,
    // While one is in progress, its row moves on its own (the recovery role).
    refetchInterval: (query) =>
      query.state.data?.restores.some(
        (row) =>
          row.state === 'VERIFYING' ||
          row.state === 'APPLYING' ||
          (row.state === 'VERIFIED' && row.confirmRequestedAt !== null),
      ) === true
        ? 5_000
        : false,
  });
  const upload = useMutation({
    retry: false,
    mutationFn: (chosen: File) => uploadTenantRestore(chosen),
    onSuccess: (result) => {
      setDialog({ kind: 'dry-run', restoreId: result.restoreId });
      toast({ tone: 'ok', message: t('web.hosted_restore_uploaded') });
    },
  });
  const refresh = (): void => {
    setDialog(null);
    setPassword('');
    setReplace(false);
    void queryClient.invalidateQueries({ queryKey: RESTORES_KEY });
    void queryClient.invalidateQueries({ queryKey: HOSTING_BOTS_KEY });
  };
  const slugValid = slug.trim() === '' || hostedBotSlugSchema.safeParse(slug).success;

  return (
    <section className="hosting-section" aria-labelledby="hosted-restore-heading">
      <header className="hosting-section-head">
        <h2 id="hosted-restore-heading">{t('web.hosted_restore_title')}</h2>
      </header>
      <p className="muted small">{t('web.hosted_restore_hint')}</p>
      <div className="hosting-inline">
        <Field label={t('web.hosted_restore_file')} htmlFor={fileId}>
          <FilePicker
            id={fileId}
            accept=".7z,application/x-7z-compressed"
            kind="any"
            extensions={['.7z']}
            selected={file}
            onClear={() => setFile(null)}
            onFiles={(files) => setFile(files[0] ?? null)}
          />
        </Field>
        <Button
          icon="upload"
          disabled={file === null || upload.isPending}
          onClick={() => file !== null && upload.mutate(file)}
        >
          {upload.isPending ? t('web.hosted_restore_uploading') : t('web.hosted_restore_upload')}
        </Button>
      </div>
      {upload.isError && <p className="field-error">{errorText(upload.error)}</p>}

      <h3>{t('web.hosted_restore_list')}</h3>
      <StateSwitch
        query={restores}
        isEmpty={restores.data?.restores.length === 0}
        empty={<Empty icon="archive" title={t('web.hosted_restore_empty')} />}
      >
        <ul className="hosted-restores">
          {restores.data?.restores.map((row) => {
            const state =
              row.state === 'VERIFIED' && row.confirmRequestedAt !== null
                ? { tone: 'info' as const, label: 'web.hosted_restore_state_confirmed' as WebKey }
                : STATE_LABEL[row.state];
            const rows = Object.values(row.counts).reduce((sum, n) => sum + n, 0);
            return (
              <li key={row.id} className="hosted-restore card">
                <KV
                  items={[
                    [t('web.hosted_backup_archive_time'), formatTimestamp(row.createdAt)],
                    [
                      t('web.hosted_backup_archive_status'),
                      <Badge key="state" tone={state.tone}>
                        {t(state.label)}
                      </Badge>,
                    ],
                    [
                      t('web.hosted_restore_mode'),
                      t(
                        row.mode === 'REPLACE'
                          ? 'web.hosted_restore_mode_replace'
                          : 'web.hosted_restore_mode_new',
                      ),
                    ],
                    ...(row.preReplaceRunId === null
                      ? []
                      : ([
                          [
                            t('web.hosted_restore_pre_replace'),
                            <Ltr key="pre">{row.preReplaceRunId.slice(0, 8)}</Ltr>,
                          ],
                        ] as [string, ReactNode][])),
                    ...(row.slug === null
                      ? []
                      : ([[t('web.hosting_field_slug'), <Ltr key="slug">{row.slug}</Ltr>]] as [
                          string,
                          ReactNode,
                        ][])),
                    ...(row.head === null
                      ? []
                      : ([
                          [
                            t('web.hosted_restore_rows'),
                            `${formatNumber(rows)} — ${t(
                              row.head === 'EQUAL'
                                ? 'web.hosted_restore_head_equal'
                                : 'web.hosted_restore_head_older',
                            )}`,
                          ],
                        ] as [string, string][])),
                    ...(row.failureCode === null
                      ? []
                      : ([[t('web.hosted_backup_status_failed'), failureText(row.failureCode)]] as [
                          string,
                          string,
                        ][])),
                  ]}
                />
                {row.state === 'VERIFIED' && row.confirmRequestedAt === null && (
                  <div className="hosting-actions">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => setDialog({ kind: 'confirm', restore: row })}
                    >
                      {t(
                        row.mode === 'REPLACE'
                          ? 'web.hosted_restore_replace_confirm'
                          : 'web.hosted_restore_confirm',
                      )}
                    </Button>
                    <Button size="sm" onClick={() => setDialog({ kind: 'cancel', restore: row })}>
                      {t('web.hosted_restore_cancel')}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </StateSwitch>

      {dialog?.kind === 'dry-run' && (
        <CodePromptDialog
          title={t('web.hosted_restore_dry_run_title')}
          hint={t('web.hosted_restore_dry_run_hint')}
          confirmLabel={t('web.hosted_restore_dry_run')}
          valid={password !== '' && (replace || slugValid)}
          run={({ proof }) =>
            dryRunTenantRestore(dialog.restoreId, {
              proof,
              password,
              mode: replace ? 'REPLACE' : 'NEW',
              ...(replace || slug.trim() === '' ? {} : { slug: slug.trim() }),
            })
          }
          onClose={() => setDialog(null)}
          onDone={refresh}
        >
          <Field label={t('web.hosted_restore_password')} htmlFor={passwordId}>
            <SecretInput
              id={passwordId}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Switch
            checked={replace}
            onChange={setReplace}
            label={t('web.hosted_restore_replace_switch')}
          />
          {replace ? (
            <p className="muted small">{t('web.hosted_restore_replace_hint')}</p>
          ) : (
            <Field label={t('web.hosted_restore_slug')} htmlFor={slugId}>
              <input
                id={slugId}
                className="input"
                dir="ltr"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
              />
            </Field>
          )}
        </CodePromptDialog>
      )}
      {dialog?.kind === 'confirm' && (
        <CodePromptDialog
          title={t(
            dialog.restore.mode === 'REPLACE'
              ? 'web.hosted_restore_replace_confirm_title'
              : 'web.hosted_restore_confirm_title',
          )}
          hint={t(
            dialog.restore.mode === 'REPLACE'
              ? 'web.hosted_restore_replace_confirm_hint'
              : 'web.hosted_restore_confirm_hint',
          )}
          confirmLabel={t(
            dialog.restore.mode === 'REPLACE'
              ? 'web.hosted_restore_replace_confirm'
              : 'web.hosted_restore_confirm',
          )}
          {...(dialog.restore.mode === 'REPLACE' ? { danger: true } : {})}
          run={({ proof, idempotencyKey }) =>
            confirmTenantRestore(dialog.restore.id, { idempotencyKey, proof })
          }
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}
      {dialog?.kind === 'cancel' && (
        <CodePromptDialog
          title={t('web.hosted_restore_cancel_title')}
          hint={t('web.hosted_restore_cancel_hint')}
          confirmLabel={t('web.hosted_restore_cancel')}
          danger
          run={({ proof }) => cancelTenantRestore(dialog.restore.id, { proof })}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}
    </section>
  );
}
