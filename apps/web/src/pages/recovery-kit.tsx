import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PLATFORM_ERROR_CODES,
  RECOVERY_KIT_PASSPHRASE_MIN_LENGTH,
  type ImportRecoveryKitResponse,
  type InstallationKeySummary,
  type PermissionKey,
} from '@nexa/contracts';
import {
  ApiError,
  exportRecoveryKit,
  fetchInstallationKeys,
  importRecoveryKit,
  removeInstallationKey,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import {
  Badge,
  Banner,
  Card,
  DataTable,
  Disclosure,
  Ltr,
  Num,
  StateSwitch,
  type Column,
} from '../ui/kit';
import { Icon } from '../ui/icons';

/**
 * The Recovery Kit section of the backup and recovery page (ADR-0032).
 *
 * Written for an operator who does not know what a key-encryption key is and
 * should not have to: the WARNING says what goes wrong (a backup alone will not
 * open on a new server), the EXPORT says what to keep and where, the IMPORT
 * says when it is needed. The crypto vocabulary is behind one «جزئیات فنی»
 * disclosure for whoever wants it.
 *
 * `permissions` decides what is DRAWN and never what is allowed — the server
 * checks every call. A section the actor may not use renders a refusal rather
 * than vanishing, the same rule the rest of this page follows.
 *
 * The passphrase and the account password live in component state for the
 * length of one submit and are cleared after it, success or failure. Neither is
 * ever put in a URL, a query key or storage.
 */
export function RecoveryKitSection({ permissions }: { permissions: readonly PermissionKey[] }) {
  const client = useQueryClient();
  const mayView = permissions.includes('backup.view');
  const mayExport = permissions.includes('recovery.kit.export');
  const mayImport = permissions.includes('recovery.kit.import');
  const mayRemove = permissions.includes('recovery.key.remove');

  const keys = useQuery({
    queryKey: ['installation-keys'],
    queryFn: fetchInstallationKeys,
    enabled: mayView,
  });
  const refresh = () => void client.invalidateQueries({ queryKey: ['installation-keys'] });

  return (
    <Card title={t('web.kit_title')} hint={t('web.kit_intro')} className="recovery-kit">
      <Banner tone="warn" title={t('web.kit_warning_title')}>
        {t('web.kit_warning_body')}
      </Banner>

      <div className="stack">
        <h3 className="card-subtitle">{t('web.kit_export_title')}</h3>
        {mayExport ? (
          <ExportForm />
        ) : (
          <Banner tone="neutral">{t('web.kit_no_permission_export')}</Banner>
        )}
      </div>

      <div className="stack">
        <h3 className="card-subtitle">{t('web.kit_import_title')}</h3>
        <p className="muted small">{t('web.kit_import_hint')}</p>
        {mayImport ? (
          <ImportForm onImported={refresh} />
        ) : (
          <Banner tone="neutral">{t('web.kit_no_permission_import')}</Banner>
        )}
      </div>

      <div className="stack">
        <h3 className="card-subtitle">{t('web.kit_keys_title')}</h3>
        <StateSwitch query={keys} denied={!mayView}>
          <KeyTable rows={keys.data?.keys ?? []} mayRemove={mayRemove} onRemoved={refresh} />
        </StateSwitch>
      </div>

      <Disclosure summary={t('web.kit_advanced')} size="sm">
        <p className="muted small">{t('web.kit_advanced_body')}</p>
      </Disclosure>
    </Card>
  );
}

/** Whether a passphrase meets the rule the server applies. The server still decides. */
function passphraseAcceptable(value: string): boolean {
  return (
    [...value.normalize('NFC')].length >= RECOVERY_KIT_PASSPHRASE_MIN_LENGTH &&
    value.trim().length === value.length
  );
}

function ExportForm() {
  const [accountPassword, setAccountPassword] = useState('');
  const [code, setCode] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState(false);

  const exporter = useMutation({
    mutationFn: exportRecoveryKit,
    onSuccess: ({ blob, filename }) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      // After a tick, not at once: some browsers start the download only once
      // the click has been handled, and a URL revoked before that downloads
      // nothing.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setDone(true);
    },
    onSettled: () => {
      // Cleared whatever happened: a secret in a form field outlives the reason
      // it was typed for.
      setAccountPassword('');
      setCode('');
      setPassphrase('');
      setAgain('');
    },
  });

  const short = passphrase !== '' && !passphraseAcceptable(passphrase);
  const mismatch = again !== '' && again !== passphrase;
  const ready = accountPassword !== '' && passphraseAcceptable(passphrase) && again === passphrase;

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready) return;
    setDone(false);
    exporter.mutate({
      accountPassword,
      ...(code.trim() === '' ? {} : { code: code.replace(/\s+/g, '') }),
      passphrase,
      passphraseConfirmation: again,
    });
  };

  return (
    <form onSubmit={onSubmit} className="stack" autoComplete="off">
      <p className="muted small">{t('web.kit_export_hint')}</p>
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
      <label className="field">
        <span className="field-label">{t('web.kit_passphrase')}</span>
        <input
          type="password"
          className="input"
          autoComplete="new-password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.currentTarget.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">{t('web.kit_passphrase_again')}</span>
        <input
          type="password"
          className="input"
          autoComplete="new-password"
          value={again}
          onChange={(event) => setAgain(event.currentTarget.value)}
        />
      </label>
      {short && <Banner tone="warn">{t('web.kit_passphrase_short')}</Banner>}
      {mismatch && <Banner tone="warn">{t('web.kit_passphrase_mismatch')}</Banner>}
      <p className="muted small">{t('web.kit_passphrase_warning')}</p>
      <div className="btn-group">
        <button type="submit" className="btn primary" disabled={!ready || exporter.isPending}>
          <Icon name="key" />
          {exporter.isPending ? t('web.kit_exporting') : t('web.kit_export_button')}
        </button>
      </div>
      {done && <Banner tone="ok">{t('web.kit_exported')}</Banner>}
      {exporter.error !== null && <Banner tone="danger">{kitMessage(exporter.error)}</Banner>}
    </form>
  );
}

function ImportForm({ onImported }: { onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [code, setCode] = useState('');
  const [result, setResult] = useState<ImportRecoveryKitResponse | null>(null);

  /*
   * The key follows the chosen FILE OBJECT, never the secrets: the fingerprint
   * `useSubmissionKey` holds must not keep a passphrase in memory, and the same archive
   * pressed again after a lost answer is the same command. A newly chosen file is a new
   * command even with the same name, size and date — another kit with those would
   * otherwise reuse the key and be refused as a payload mismatch. Each File object gets
   * its own token; minting inside `mutationFn` gave the automatic 5xx retry a fresh key.
   */
  const importKey = useSubmissionKey();
  const fileTokens = useRef(new WeakMap<File, string>());
  const tokenOf = (chosen: File): string => {
    let token = fileTokens.current.get(chosen);
    if (token === undefined) {
      token = crypto.randomUUID();
      fileTokens.current.set(chosen, token);
    }
    return token;
  };
  const importer = useMutation({
    mutationFn: (input: {
      file: File;
      passphrase: string;
      accountPassword: string;
      code?: string;
    }) =>
      importRecoveryKit({
        ...input,
        idempotencyKey: importKey.current({ file: tokenOf(input.file) }),
      }),
    onSuccess: (response) => {
      importKey.settle();
      setResult(response);
      onImported();
    },
    onError: (error) => importKey.settleOn(error),
    onSettled: () => {
      setPassphrase('');
      setAccountPassword('');
      setCode('');
    },
  });

  const ready = file !== null && passphrase !== '' && accountPassword !== '';
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (file === null || !ready) return;
    setResult(null);
    importer.mutate({
      file,
      passphrase,
      accountPassword,
      ...(code.trim() === '' ? {} : { code: code.replace(/\s+/g, '') }),
    });
  };

  return (
    <form onSubmit={onSubmit} className="stack" autoComplete="off">
      <label className="field">
        <span className="field-label">{t('web.kit_import_choose')}</span>
        <input
          type="file"
          className="recovery-kit-file"
          onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
        />
      </label>
      <label className="field">
        <span className="field-label">{t('web.kit_import_passphrase')}</span>
        <input
          type="password"
          className="input"
          autoComplete="off"
          value={passphrase}
          onChange={(event) => setPassphrase(event.currentTarget.value)}
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
      <div className="btn-group">
        <button type="submit" className="btn primary" disabled={!ready || importer.isPending}>
          <Icon name="upload" />
          {importer.isPending ? t('web.kit_importing') : t('web.kit_import_button')}
        </button>
      </div>
      {result !== null && (
        <Banner tone="ok" title={t('web.kit_imported_next')}>
          {t('web.kit_imported')}:{' '}
          {result.imported.length === 0 ? (
            '—'
          ) : (
            <Ltr>{result.imported.map((k) => k.keyId).join(', ')}</Ltr>
          )}
          {result.alreadyHeld.length > 0 && (
            <>
              {' · '}
              {t('web.kit_already_held')}:{' '}
              <Ltr>{result.alreadyHeld.map((k) => k.keyId).join(', ')}</Ltr>
            </>
          )}
        </Banner>
      )}
      {importer.error !== null && <Banner tone="danger">{kitMessage(importer.error)}</Banner>}
    </form>
  );
}

function KeyTable({
  rows,
  mayRemove,
  onRemoved,
}: {
  rows: readonly InstallationKeySummary[];
  mayRemove: boolean;
  onRemoved: () => void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const columns: Column<InstallationKeySummary>[] = [
    { key: 'name', header: t('web.kit_key_name'), render: (row) => <Ltr>{row.keyId}</Ltr> },
    {
      key: 'role',
      header: t('web.kit_key_role'),
      render: (row) => (
        <>
          <Badge tone={row.encrypts ? 'ok' : row.origin === 'IMPORTED' ? 'info' : 'neutral'}>
            {t(ROLE_LABEL[row.origin])}
          </Badge>
          {!row.available && <Badge tone="danger">{t('web.kit_key_unavailable')}</Badge>}
          {row.arrivedByRestore && <Badge tone="warn">{t('web.kit_key_arrived_by_restore')}</Badge>}
        </>
      ),
    },
    {
      key: 'uses',
      header: t('web.kit_key_uses'),
      render: (row) => <Dependencies row={row} />,
    },
    {
      key: 'imported',
      header: t('web.kit_key_imported_at'),
      render: (row) => (row.importedAt === null ? '—' : formatTimestamp(row.importedAt)),
    },
    {
      key: 'fingerprint',
      header: t('web.kit_key_fingerprint'),
      render: (row) => (row.fingerprint === null ? '—' : <Ltr>{row.fingerprint.slice(0, 16)}</Ltr>),
    },
    {
      key: 'actions',
      header: '',
      render: (row) =>
        row.origin !== 'IMPORTED' || !mayRemove ? null : (
          <button
            type="button"
            className="btn danger"
            disabled={!row.removable}
            title={row.removable ? undefined : t('web.kit_remove_blocked')}
            onClick={() => setRemoving(row.keyId)}
          >
            {t('web.kit_remove')}
          </button>
        ),
    },
  ];
  const target = rows.find((row) => row.keyId === removing) ?? null;
  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.keyId}
        caption={t('web.kit_keys_title')}
        dense
      />
      <p className="muted small">{t('web.kit_configured_not_removable')}</p>
      {target !== null && (
        <RemoveKey
          keyId={target.keyId}
          onDone={() => {
            setRemoving(null);
            onRemoved();
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
    </>
  );
}

const ROLE_LABEL: Record<InstallationKeySummary['origin'], WebKey> = {
  CONFIGURED_ACTIVE: 'web.kit_role_active',
  CONFIGURED: 'web.kit_role_configured',
  IMPORTED: 'web.kit_role_imported',
};

function Dependencies({ row }: { row: InstallationKeySummary }) {
  const parts: [WebKey, number][] = [
    ['web.kit_dep_secrets', row.dependencies.secrets],
    ['web.kit_dep_wrapped', row.dependencies.wrappedKeys],
    ['web.kit_dep_archives', row.dependencies.retainedArchives],
    ['web.kit_dep_recoveries', row.dependencies.openRecoveries],
  ];
  const present = parts.filter(([, count]) => count > 0);
  if (present.length === 0) return <span className="muted">{t('web.kit_dep_none')}</span>;
  return (
    <span>
      {present.map(([label, count], index) => (
        <span key={label}>
          {index > 0 ? ' · ' : ''}
          <Num value={count} /> {t(label)}
        </span>
      ))}
    </span>
  );
}

function RemoveKey({
  keyId,
  onDone,
  onCancel,
}: {
  keyId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  const removeKey = useSubmissionKey();
  const remover = useMutation({
    mutationFn: () =>
      removeInstallationKey({
        keyId,
        confirmation: typed,
        idempotencyKey: removeKey.current({ keyId, typed }),
      }),
    onSuccess: () => {
      removeKey.settle();
      onDone();
    },
    onError: (error) => removeKey.settleOn(error),
  });
  return (
    <div className="stack inset danger-zone">
      <Banner tone="danger" title={t('web.kit_remove_title')}>
        {t('web.kit_remove_danger')}
      </Banner>
      <label className="field">
        <span className="field-label">{t('web.kit_remove_confirm_label')}</span>
        <Ltr>{keyId}</Ltr>
        <input
          type="text"
          className="input"
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
        />
      </label>
      <div className="btn-group">
        <button
          type="button"
          className="btn danger solid"
          disabled={typed.trim() !== keyId || remover.isPending}
          onClick={() => remover.mutate()}
        >
          {t('web.kit_remove_button')}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t('web.kit_remove_cancel')}
        </button>
      </div>
      {remover.error !== null && <Banner tone="danger">{kitMessage(remover.error)}</Banner>}
    </div>
  );
}

/**
 * A refusal from the kit endpoints, in Persian.
 *
 * Every code these endpoints raise has a sentence here, because the server's own
 * message is English and names things — a KDF, an AEAD tag — that an operator
 * restoring under pressure should not have to decode.
 */
const KIT_ERRORS: Record<string, WebKey> = {
  'auth.step_up_factor_required': 'web.step_up_factor_required',
  'auth.step_up_failed': 'web.step_up_failed',
  [PLATFORM_ERROR_CODES.RECOVERY_KIT_AUTH_FAILED]: 'web.kit_error_auth',
  [PLATFORM_ERROR_CODES.RECOVERY_KIT_MALFORMED]: 'web.kit_error_malformed',
  [PLATFORM_ERROR_CODES.RECOVERY_KIT_UNSUPPORTED_VERSION]: 'web.kit_error_version',
  [PLATFORM_ERROR_CODES.RECOVERY_KIT_KEY_COLLISION]: 'web.kit_error_collision',
  [PLATFORM_ERROR_CODES.RECOVERY_KIT_REAUTHENTICATION_FAILED]: 'web.kit_error_reauth',
  [PLATFORM_ERROR_CODES.RECOVERY_KIT_PASSPHRASE_REJECTED]: 'web.kit_error_passphrase',
  [PLATFORM_ERROR_CODES.RECOVERY_KIT_BUSY]: 'web.kit_error_busy',
  [PLATFORM_ERROR_CODES.RECOVERY_KIT_TOO_MANY_KEYS]: 'web.kit_error_too_many',
  [PLATFORM_ERROR_CODES.INSTALLATION_KEY_IN_USE]: 'web.kit_error_in_use',
};

/**
 * The code half of the step-up (D2 review): required by the server when the
 * administrator's own two-step sign-in is on, and ignored when it is off.
 */
function StepUpCodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="field-label">{t('web.admin_step_up_code')}</span>
      <input
        className="input"
        dir="ltr"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={8}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <span className="muted small">{t('web.admin_step_up_code_hint')}</span>
    </label>
  );
}

export function kitMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const key = KIT_ERRORS[error.code];
    return key === undefined ? error.message : t(key);
  }
  return t('web.error');
}
