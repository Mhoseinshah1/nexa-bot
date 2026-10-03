import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TOTP_PARAMETERS,
  type AdminSessionSummary,
  type SecurityEvent,
  type SecurityEventAction,
  type TotpEnrolResponse,
} from '@nexa/contracts';
import {
  activateTotp,
  ApiError,
  changeOwnPassword,
  disableTotp,
  enrolTotp,
  fetchAccountSecurity,
  fetchOwnSessions,
  fetchSecurityEvents,
  regenerateBackupCodes,
  revokeOtherSessions,
  revokeOwnSession,
  type SecondFactorProofInput,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import {
  Badge,
  Banner,
  Card,
  CopyButton,
  KV,
  Ltr,
  PageHead,
  StateSwitch,
  useToast,
} from '../ui/kit';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { useUnsavedChanges } from '../ui/unsaved';
import { Icon } from '../ui/icons';

/**
 * The signed-in administrator's own account (Phase D2, program §17).
 *
 * One page, and on it one clearly bounded SECURITY section: two-step sign-in, backup
 * codes, the password, the sessions this account holds, and its sign-in history. D3
 * (RBAC) adds its own sections beside this one; nothing here is about other people.
 *
 * Every secret this page ever holds — the TOTP secret during enrolment, a fresh set of
 * backup codes, a password typed for re-authentication — lives in component state only,
 * for as long as it is being shown or submitted, and is cleared after. Nothing is put
 * in a URL, a query key or storage, and nothing can be fetched back: the server shows
 * the secret and the codes exactly once.
 *
 * Nothing is gated on a permission. Every call acts only on the caller's own account
 * and the server decides each one; what the page asks for instead is proof, as the
 * server does: the password to enrol, the password AND a code to turn it off.
 */
export function AccountPage() {
  return (
    <div className="stack account-page">
      <PageHead title={t('web.account_title')} subtitle={t('web.account_subtitle')} />
      <section className="stack" aria-labelledby="account-security-heading" id="security">
        <h2 id="account-security-heading" className="section-title">
          <Icon name="shield" /> {t('web.security_title')}
        </h2>
        <TwoStepCard />
        <PasswordCard />
        <SessionsCard />
        <HistoryCard />
      </section>
    </div>
  );
}

/** One message per failure the server can give these forms. Never the server's own text. */
function securityMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'auth.invalid_credentials':
        return t('web.security_bad_password');
      case 'auth.second_factor_invalid':
        return t('web.second_factor_invalid');
      case 'auth.rate_limited':
        return t('web.rate_limited');
      case 'admin.second_factor_not_pending':
        return t('web.totp_enrolment_expired');
      case 'admin.second_factor_already_active':
        return t('web.totp_already_active');
      case 'admin.second_factor_not_active':
        return t('web.totp_not_active');
      case 'admin.password_reused':
        return t('web.password_reused');
      default:
        break;
    }
  }
  return t('web.security_failed');
}

const SECURITY_QUERY = ['account-security'] as const;

function TwoStepCard() {
  const queries = useQueryClient();
  const overview = useQuery({ queryKey: SECURITY_QUERY, queryFn: fetchAccountSecurity });
  const [enrolment, setEnrolment] = useState<TotpEnrolResponse | null>(null);
  const [freshCodes, setFreshCodes] = useState<readonly string[] | null>(null);
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: SECURITY_QUERY });
    void queries.invalidateQueries({ queryKey: ['account-sessions'] });
    void queries.invalidateQueries({ queryKey: ['account-events'] });
  };

  // Leaving while a secret or unsaved codes are on screen loses them for good.
  useUnsavedChanges(enrolment !== null || freshCodes !== null, t('web.security_leave_question'));

  const state = overview.data?.totp.state ?? 'DISABLED';
  return (
    <Card
      title={t('web.totp_title')}
      hint={t('web.totp_hint')}
      actions={
        overview.data !== undefined ? (
          <Badge tone={state === 'ACTIVE' ? 'ok' : 'neutral'} dot>
            {state === 'ACTIVE' ? t('web.totp_state_on') : t('web.totp_state_off')}
          </Badge>
        ) : undefined
      }
    >
      <StateSwitch query={overview}>
        {freshCodes !== null ? (
          <BackupCodesReveal
            codes={freshCodes}
            onDone={() => {
              setFreshCodes(null);
              refresh();
            }}
          />
        ) : state === 'ACTIVE' ? (
          <ActiveFactor
            activatedAt={overview.data?.totp.activatedAt ?? null}
            remaining={overview.data?.backupCodes.remaining ?? 0}
            onCodes={setFreshCodes}
            onDisabled={refresh}
          />
        ) : enrolment !== null ? (
          <ActivateForm
            enrolment={enrolment}
            onCancel={() => setEnrolment(null)}
            onActivated={(codes) => {
              setEnrolment(null);
              setFreshCodes(codes);
              refresh();
            }}
          />
        ) : (
          <EnrolForm onEnrolled={setEnrolment} />
        )}
      </StateSwitch>
    </Card>
  );
}

function PasswordInput({
  id,
  label,
  value,
  onChange,
  autoComplete = 'current-password',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="password"
        className="input"
        dir="ltr"
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function EnrolForm({ onEnrolled }: { onEnrolled: (enrolment: TotpEnrolResponse) => void }) {
  const [password, setPassword] = useState('');
  const enrol = useMutation({
    retry: false,
    mutationFn: () => enrolTotp(password),
    onSuccess: onEnrolled,
    onSettled: () => setPassword(''),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    enrol.mutate();
  };
  return (
    <form className="stack" onSubmit={submit} autoComplete="off">
      <p className="muted small">{t('web.totp_enrol_intro')}</p>
      <PasswordInput
        id="totp-enrol-password"
        label={t('web.security_password_confirm')}
        value={password}
        onChange={setPassword}
      />
      <div className="btn-group">
        <button type="submit" className="btn primary" disabled={password === '' || enrol.isPending}>
          <Icon name="shield" />
          {t('web.totp_enrol_start')}
        </button>
      </div>
      {enrol.isError && <Banner tone="danger">{securityMessage(enrol.error)}</Banner>}
    </form>
  );
}

function ActivateForm({
  enrolment,
  onCancel,
  onActivated,
}: {
  enrolment: TotpEnrolResponse;
  onCancel: () => void;
  onActivated: (codes: readonly string[]) => void;
}) {
  const [code, setCode] = useState('');
  const activate = useMutation({
    retry: false,
    mutationFn: () => activateTotp(code.replace(/\s+/g, '')),
    onSuccess: (result) => onActivated(result.backupCodes),
    onSettled: () => setCode(''),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    activate.mutate();
  };
  // The secret, grouped in fours as authenticator apps print it.
  const grouped = enrolment.secret.match(/.{1,4}/g)?.join(' ') ?? enrolment.secret;
  return (
    <form className="stack" onSubmit={submit} autoComplete="off">
      <Banner tone="warn" title={t('web.totp_secret_once_title')}>
        {t('web.totp_secret_once_body')}
      </Banner>
      <ol className="stack small">
        <li>{t('web.totp_step_scan')}</li>
        <li>{t('web.totp_step_code')}</li>
      </ol>
      {enrolment.qrPngDataUrl !== null && (
        <img
          className="totp-qr"
          src={enrolment.qrPngDataUrl}
          alt={t('web.totp_qr_alt')}
          width={220}
          height={220}
        />
      )}
      <KV
        items={[
          [
            t('web.totp_manual_secret'),
            <span key="secret" className="row-inline">
              <Ltr>{grouped}</Ltr>
              <CopyButton value={enrolment.secret} />
            </span>,
          ],
          [
            t('web.totp_parameters'),
            <Ltr key="params">
              {`${TOTP_PARAMETERS.algorithm} · ${String(TOTP_PARAMETERS.digits)} · ${String(TOTP_PARAMETERS.periodSeconds)}s`}
            </Ltr>,
          ],
          [t('web.totp_expires'), formatTimestamp(enrolment.expiresAt)],
        ]}
      />
      <div className="field">
        <label htmlFor="totp-activate-code">{t('web.second_factor_code_label')}</label>
        <input
          id="totp-activate-code"
          className="input"
          dir="ltr"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={8}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </div>
      <div className="btn-group">
        <button
          type="submit"
          className="btn primary"
          disabled={
            code.replace(/\s+/g, '').length !== TOTP_PARAMETERS.digits || activate.isPending
          }
        >
          {t('web.totp_activate')}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t('web.account_cancel')}
        </button>
      </div>
      {activate.isError && <Banner tone="danger">{securityMessage(activate.error)}</Banner>}
    </form>
  );
}

/** Shown once, after activation or regeneration. The page never has them again. */
function BackupCodesReveal({ codes, onDone }: { codes: readonly string[]; onDone: () => void }) {
  const download = () => {
    const text = `${t('web.backup_codes_file_heading')}\n\n${codes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'nexa-backup-codes.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <div className="stack">
      <Banner tone="warn" title={t('web.backup_codes_once_title')}>
        {t('web.backup_codes_once_body')}
      </Banner>
      <ul className="backup-codes" dir="ltr" aria-label={t('web.backup_codes_title')}>
        {codes.map((value) => (
          <li key={value}>
            <code>{value}</code>
          </li>
        ))}
      </ul>
      <div className="btn-group">
        <CopyButton value={codes.join('\n')} label={t('web.backup_codes_copy')} />
        <button type="button" className="btn" onClick={download}>
          <Icon name="download" />
          {t('web.backup_codes_download')}
        </button>
        <button type="button" className="btn primary" onClick={onDone}>
          <Icon name="check" />
          {t('web.backup_codes_saved')}
        </button>
      </div>
    </div>
  );
}

/** Password plus ONE second-factor proof: the device code, or a backup code. */
function ProofFields({
  idPrefix,
  password,
  onPassword,
  proof,
  onProof,
  useBackup,
  onToggle,
}: {
  idPrefix: string;
  password: string;
  onPassword: (value: string) => void;
  proof: string;
  onProof: (value: string) => void;
  useBackup: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <PasswordInput
        id={`${idPrefix}-password`}
        label={t('web.security_password_confirm')}
        value={password}
        onChange={onPassword}
      />
      <div className="field">
        <label htmlFor={`${idPrefix}-proof`}>
          {useBackup ? t('web.second_factor_backup_label') : t('web.second_factor_code_label')}
        </label>
        <input
          id={`${idPrefix}-proof`}
          className="input"
          dir="ltr"
          inputMode={useBackup ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          maxLength={useBackup ? 64 : 8}
          value={proof}
          onChange={(event) => onProof(event.target.value)}
        />
      </div>
      <div>
        <button type="button" className="btn ghost sm" onClick={onToggle}>
          {useBackup ? t('web.second_factor_use_app') : t('web.second_factor_use_backup')}
        </button>
      </div>
    </>
  );
}

function useProofForm() {
  const [password, setPassword] = useState('');
  const [proof, setProof] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const input = (): { password: string } & SecondFactorProofInput =>
    useBackup
      ? { password, backupCode: proof.trim() }
      : { password, code: proof.replace(/\s+/g, '') };
  const clear = () => {
    setPassword('');
    setProof('');
  };
  return {
    password,
    setPassword,
    proof,
    setProof,
    useBackup,
    toggle: () => {
      setUseBackup(!useBackup);
      setProof('');
    },
    input,
    clear,
    ready: password !== '' && proof.trim() !== '',
  };
}

function ActiveFactor({
  activatedAt,
  remaining,
  onCodes,
  onDisabled,
}: {
  activatedAt: string | null;
  remaining: number;
  onCodes: (codes: readonly string[]) => void;
  onDisabled: () => void;
}) {
  const notify = useToast();
  const regenerateForm = useProofForm();
  const disableForm = useProofForm();
  const [confirming, setConfirming] = useState(false);

  const regenerate = useMutation({
    retry: false,
    mutationFn: () => regenerateBackupCodes(regenerateForm.input()),
    onSuccess: (result) => onCodes(result.backupCodes),
    onSettled: () => regenerateForm.clear(),
  });
  const disable = useMutation({
    retry: false,
    mutationFn: () => disableTotp(disableForm.input()),
    onSuccess: () => {
      notify({ tone: 'ok', message: t('web.totp_disabled_done') });
      onDisabled();
    },
    onSettled: () => disableForm.clear(),
  });

  return (
    <div className="stack">
      <KV
        items={[
          [t('web.totp_activated_at'), activatedAt === null ? '—' : formatTimestamp(activatedAt)],
          [t('web.backup_codes_remaining'), String(remaining)],
        ]}
      />
      {remaining <= 3 && <Banner tone="warn">{t('web.backup_codes_low')}</Banner>}

      <form
        className="stack"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          regenerate.mutate();
        }}
      >
        <h3 className="card-subtitle">{t('web.backup_codes_regenerate_title')}</h3>
        <p className="muted small">{t('web.backup_codes_regenerate_hint')}</p>
        <ProofFields
          idPrefix="regenerate"
          password={regenerateForm.password}
          onPassword={regenerateForm.setPassword}
          proof={regenerateForm.proof}
          onProof={regenerateForm.setProof}
          useBackup={regenerateForm.useBackup}
          onToggle={regenerateForm.toggle}
        />
        <div className="btn-group">
          <button
            type="submit"
            className="btn"
            disabled={!regenerateForm.ready || regenerate.isPending}
          >
            <Icon name="refresh" />
            {t('web.backup_codes_regenerate')}
          </button>
        </div>
        {regenerate.isError && <Banner tone="danger">{securityMessage(regenerate.error)}</Banner>}
      </form>

      <div className="inset danger-zone stack">
        <h3 className="card-subtitle">{t('web.totp_disable_title')}</h3>
        <p className="muted small">{t('web.totp_disable_hint')}</p>
        <form
          className="stack"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            setConfirming(true);
          }}
        >
          <ProofFields
            idPrefix="disable"
            password={disableForm.password}
            onPassword={disableForm.setPassword}
            proof={disableForm.proof}
            onProof={disableForm.setProof}
            useBackup={disableForm.useBackup}
            onToggle={disableForm.toggle}
          />
          <div className="btn-group">
            <button
              type="submit"
              className="btn danger"
              disabled={!disableForm.ready || disable.isPending}
            >
              {t('web.totp_disable')}
            </button>
          </div>
          {disable.isError && <Banner tone="danger">{securityMessage(disable.error)}</Banner>}
        </form>
      </div>
      {confirming && (
        <ConfirmDialog
          title={t('web.totp_disable_title')}
          question={t('web.totp_disable_question')}
          confirmLabel={t('web.totp_disable')}
          cancelLabel={t('web.account_cancel')}
          onConfirm={() => {
            setConfirming(false);
            disable.mutate();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function PasswordCard() {
  const queries = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const change = useMutation({
    retry: false,
    mutationFn: () => changeOwnPassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      // Every session ended, this one included: the shell's own session read now
      // answers "signed out" and draws the sign-in form.
      queries.setQueryData(['session'], null);
    },
    onSettled: () => {
      setCurrent('');
      setNext('');
      setAgain('');
    },
  });
  const mismatch = again !== '' && again !== next;
  const ready = current !== '' && next.length >= 12 && again === next;
  return (
    <Card title={t('web.password_change_title')} hint={t('web.password_change_hint')}>
      <form
        className="stack"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) change.mutate();
        }}
      >
        <PasswordInput
          id="password-current"
          label={t('web.password_current')}
          value={current}
          onChange={setCurrent}
        />
        <PasswordInput
          id="password-new"
          label={t('web.password_new')}
          value={next}
          onChange={setNext}
          autoComplete="new-password"
        />
        <PasswordInput
          id="password-again"
          label={t('web.password_again')}
          value={again}
          onChange={setAgain}
          autoComplete="new-password"
        />
        {next !== '' && next.length < 12 && (
          <Banner tone="warn">{t('web.password_too_short')}</Banner>
        )}
        {mismatch && <Banner tone="warn">{t('web.password_mismatch')}</Banner>}
        <div className="btn-group">
          <button type="submit" className="btn primary" disabled={!ready || change.isPending}>
            <Icon name="key" />
            {t('web.password_change')}
          </button>
        </div>
        {change.isError && <Banner tone="danger">{securityMessage(change.error)}</Banner>}
      </form>
    </Card>
  );
}

function SessionsCard() {
  const queries = useQueryClient();
  const notify = useToast();
  const sessions = useQuery({
    queryKey: ['account-sessions'],
    queryFn: fetchOwnSessions,
    refetchInterval: 30_000,
  });
  const [confirmOthers, setConfirmOthers] = useState(false);
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['account-sessions'] });
    void queries.invalidateQueries({ queryKey: ['account-events'] });
  };

  const revokeOne = useMutation({
    retry: false,
    mutationFn: (id: string) => revokeOwnSession(id),
    onSuccess: (result) => {
      if (result.current) {
        queries.setQueryData(['session'], null);
        return;
      }
      notify({ tone: 'ok', message: t('web.sessions_revoked_one') });
      refresh();
    },
  });
  const revokeOthers = useMutation({
    retry: false,
    mutationFn: revokeOtherSessions,
    onSuccess: (result) => {
      notify({
        tone: 'ok',
        message: t('web.sessions_revoked_others').replace('{count}', String(result.revoked)),
      });
      refresh();
    },
  });

  const rows = sessions.data?.sessions ?? [];
  const others = rows.filter((row) => !row.current).length;
  return (
    <Card
      title={t('web.sessions_title')}
      hint={t('web.sessions_hint')}
      actions={
        <button
          type="button"
          className="btn danger sm"
          disabled={revokeOthers.isPending || others === 0}
          onClick={() => setConfirmOthers(true)}
        >
          {t('web.sessions_revoke_others')}
        </button>
      }
    >
      <StateSwitch
        query={sessions}
        isEmpty={rows.length === 0}
        empty={<span className="faint">{t('web.admin_sessions_empty')}</span>}
      >
        <ul className="stack session-list">
          {rows.map((session) => (
            <li key={session.id} className="system-session">
              <div className="row-inline">
                {session.current ? (
                  <Badge tone="ok" dot>
                    {t('web.admin_sessions_current')}
                  </Badge>
                ) : (
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={revokeOne.isPending}
                    onClick={() => revokeOne.mutate(session.id)}
                  >
                    {t('web.sessions_revoke')}
                  </button>
                )}
              </div>
              <KV items={sessionItems(session)} />
            </li>
          ))}
        </ul>
      </StateSwitch>
      {(revokeOne.isError || revokeOthers.isError) && (
        <Banner tone="danger">{securityMessage(revokeOne.error ?? revokeOthers.error)}</Banner>
      )}
      {confirmOthers && (
        <ConfirmDialog
          title={t('web.sessions_revoke_others')}
          question={t('web.sessions_revoke_others_question').replace('{count}', String(others))}
          confirmLabel={t('web.sessions_revoke_others')}
          cancelLabel={t('web.account_cancel')}
          onConfirm={() => {
            setConfirmOthers(false);
            revokeOthers.mutate();
          }}
          onCancel={() => setConfirmOthers(false)}
        />
      )}
    </Card>
  );
}

/** Only what the session row holds: no device or place inferred from a header. */
function sessionItems(session: AdminSessionSummary): [ReactNode, ReactNode][] {
  const items: [ReactNode, ReactNode][] = [
    [t('web.admin_session_last_seen'), formatTimestamp(session.lastSeenAt)],
    [t('web.admin_session_issued'), formatTimestamp(session.issuedAt)],
    [t('web.admin_session_expires'), formatTimestamp(session.expiresAt)],
  ];
  if (session.ip !== null)
    items.push([t('web.admin_session_ip'), <Ltr key="ip">{session.ip}</Ltr>]);
  if (session.userAgent !== null) {
    items.push([t('web.admin_session_agent'), <Ltr key="ua">{session.userAgent}</Ltr>]);
  }
  return items;
}

const EVENT_LABELS: Record<SecurityEventAction, WebKey> = {
  'auth.login': 'web.security_event_login',
  'auth.login_challenge': 'web.security_event_login_challenge',
  'auth.second_factor': 'web.security_event_second_factor',
  'auth.logout': 'web.security_event_logout',
  'auth.session_revoke': 'web.security_event_session_revoke',
  'auth.sessions_revoke_others': 'web.security_event_sessions_revoke_others',
  'admin.password_change': 'web.security_event_password_change',
  'admin.password_reset': 'web.security_event_password_reset',
  'admin.sessions_revoked': 'web.security_event_sessions_revoked',
  'admin.totp_enrol': 'web.security_event_totp_enrol',
  'admin.totp_enable': 'web.security_event_totp_enable',
  'admin.totp_disable': 'web.security_event_totp_disable',
  'admin.totp_reset': 'web.security_event_totp_reset',
  'admin.backup_codes_regenerate': 'web.security_event_backup_codes',
};

function HistoryCard() {
  const events = useQuery({ queryKey: ['account-events'], queryFn: fetchSecurityEvents });
  const rows = events.data?.events ?? [];
  return (
    <Card title={t('web.security_history_title')} hint={t('web.security_history_hint')}>
      <StateSwitch
        query={events}
        isEmpty={rows.length === 0}
        empty={<span className="faint">{t('web.security_history_empty')}</span>}
      >
        <ul className="stack security-history">
          {rows.map((event) => (
            <HistoryRow key={event.id} event={event} />
          ))}
        </ul>
      </StateSwitch>
    </Card>
  );
}

function HistoryRow({ event }: { event: SecurityEvent }) {
  const denied = event.result !== 'SUCCESS';
  return (
    <li className="security-event">
      <div className="row-inline">
        <Badge tone={denied ? 'danger' : 'ok'} dot>
          {denied ? t('web.security_event_denied') : t('web.security_event_ok')}
        </Badge>
        <strong>{t(EVENT_LABELS[event.action])}</strong>
        {event.method !== null && (
          <span className="faint small">
            {event.method === 'TOTP'
              ? t('web.security_method_totp')
              : t('web.security_method_backup')}
          </span>
        )}
      </div>
      <div className="muted small">
        {formatTimestamp(event.occurredAt)}
        {event.ip !== null && (
          <>
            {' · '}
            <Ltr>{event.ip}</Ltr>
          </>
        )}
        {event.userAgent !== null && (
          <>
            {' · '}
            <Ltr>{event.userAgent}</Ltr>
          </>
        )}
        {event.actorLabel !== null && (
          <>
            {' · '}
            {t('web.security_event_by')} <Ltr>{event.actorLabel}</Ltr>
          </>
        )}
      </div>
    </li>
  );
}
