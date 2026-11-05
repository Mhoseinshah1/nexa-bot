import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { HostingEnrolResponse, HostingStatusResponse } from '@nexa/contracts';
import { activateHostingFactor, enrolHostingFactor, openHostingSession } from '../api/client';
import { errorText } from '../error-text';
import { formatTimestamp } from '../format';
import { t } from '../i18n/web.fa';
import { Banner, Card, CopyButton, KV, Ltr } from '../ui/kit';
import { Icon } from '../ui/icons';
import { ErrorRef } from '../ui/technical-details';
import {
  EMPTY_PROOF,
  HOSTING_STATUS_KEY,
  ProofField,
  noteSectionError,
  proofOf,
  type ProofDraft,
} from './hosting-parts';

/**
 * The gate in front of «میزبانی‌ها»: the section has its own second factor, separate from the
 * sign-in one. Which screen is drawn is the status's `factor` and `session`:
 *
 *   NONE                 enrol: password, then QR and secret, then the first code
 *   PENDING              the secret was shown once and is gone: enter its code, or start over
 *   ACTIVE, no session   the code (or a recovery code) opens the section for this sign-in
 *
 * Activating answers with the ten recovery codes; the page shows them once (`onActivated`)
 * before the section opens.
 */
export function HostingGate({
  status,
  onActivated,
}: {
  status: HostingStatusResponse;
  onActivated: (codes: readonly string[]) => void;
}) {
  if (status.factor === 'ACTIVE') return <UnlockCard lockedUntil={status.lockedUntil} />;
  return <EnrolCard pending={status.factor === 'PENDING'} onActivated={onActivated} />;
}

function EnrolCard({
  pending,
  onActivated,
}: {
  pending: boolean;
  onActivated: (codes: readonly string[]) => void;
}) {
  const queryClient = useQueryClient();
  const id = useId();
  const [restart, setRestart] = useState(false);
  const [password, setPassword] = useState('');
  const [enrolment, setEnrolment] = useState<HostingEnrolResponse | null>(null);
  const [code, setCode] = useState('');

  const enrol = useMutation({
    retry: false,
    mutationFn: (accountPassword: string) => enrolHostingFactor(accountPassword),
    onSuccess: (result) => {
      setEnrolment(result);
      setRestart(false);
      void queryClient.invalidateQueries({ queryKey: HOSTING_STATUS_KEY });
    },
    onSettled: () => setPassword(''),
  });
  const activate = useMutation({
    retry: false,
    mutationFn: (typed: string) => activateHostingFactor(typed.replace(/\s+/g, '')),
    onSuccess: (result) => {
      setEnrolment(null);
      onActivated(result.recoveryCodes);
      void queryClient.invalidateQueries({ queryKey: HOSTING_STATUS_KEY });
    },
    onError: (error) => noteSectionError(error, queryClient),
    onSettled: () => setCode(''),
  });

  // The password step: a fresh start (nothing enrolled) or an explicit restart of a pending one.
  const askPassword = enrolment === null && (!pending || restart);
  if (askPassword) {
    const submitPassword = (event: FormEvent): void => {
      event.preventDefault();
      if (password !== '' && !enrol.isPending) enrol.mutate(password);
    };
    return (
      <Card title={t('web.hosting_gate_none_title')} hint={t('web.hosting_gate_none_hint')}>
        <form className="stack hosting-narrow" onSubmit={submitPassword} autoComplete="off">
          <div className="field">
            <label htmlFor={`${id}-password`}>{t('web.hosting_enrol_password')}</label>
            <input
              id={`${id}-password`}
              type="password"
              className="input"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
          </div>
          {enrol.error !== null && (
            <Banner tone="danger">
              {errorText(enrol.error)}
              <ErrorRef error={enrol.error} />
            </Banner>
          )}
          <div className="btn-group">
            <button
              type="submit"
              className="btn primary"
              disabled={password === '' || enrol.isPending}
            >
              <Icon name="key" />
              {enrol.isPending ? t('web.hosting_enrol_starting') : t('web.hosting_enrol_start')}
            </button>
            {restart && (
              <button type="button" className="btn ghost" onClick={() => setRestart(false)}>
                {t('web.hosting_cancel')}
              </button>
            )}
          </div>
        </form>
      </Card>
    );
  }

  const digits = code.replace(/\s+/g, '');
  const submitCode = (event: FormEvent): void => {
    event.preventDefault();
    if (/^[0-9]{6}$/.test(digits) && !activate.isPending) activate.mutate(code);
  };
  // The secret, grouped in fours as authenticator apps print it.
  const grouped = enrolment?.secret.match(/.{1,4}/g)?.join(' ') ?? enrolment?.secret ?? '';
  return (
    <Card
      title={
        pending && enrolment === null
          ? t('web.hosting_pending_title')
          : t('web.hosting_gate_none_title')
      }
      hint={
        pending && enrolment === null ? t('web.hosting_pending_hint') : t('web.hosting_enrol_scan')
      }
    >
      <form className="stack hosting-narrow" onSubmit={submitCode} autoComplete="off">
        {enrolment !== null && (
          <>
            {enrolment.qrPngDataUrl !== null && (
              <img
                className="hosting-qr"
                src={enrolment.qrPngDataUrl}
                alt={t('web.hosting_enrol_qr_alt')}
                width={220}
                height={220}
              />
            )}
            <KV
              items={[
                [
                  t('web.hosting_enrol_secret'),
                  <span key="secret" className="hosting-inline">
                    <Ltr>{grouped}</Ltr>
                    <CopyButton value={enrolment.secret} />
                  </span>,
                ],
                [t('web.hosting_enrol_expires'), formatTimestamp(enrolment.expiresAt)],
              ]}
            />
          </>
        )}
        <div className="field">
          <label htmlFor={`${id}-code`}>{t('web.hosting_code_label')}</label>
          <input
            id={`${id}-code`}
            className="input"
            dir="ltr"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            value={code}
            onChange={(event) => setCode(event.currentTarget.value)}
          />
        </div>
        {activate.error !== null && (
          <Banner tone="danger">
            {errorText(activate.error)}
            <ErrorRef error={activate.error} />
          </Banner>
        )}
        <div className="btn-group">
          <button
            type="submit"
            className="btn primary"
            disabled={!/^[0-9]{6}$/.test(digits) || activate.isPending}
          >
            {activate.isPending
              ? t('web.hosting_enrol_activating')
              : t('web.hosting_enrol_activate')}
          </button>
          {pending && enrolment === null && (
            <button type="button" className="btn ghost" onClick={() => setRestart(true)}>
              {t('web.hosting_pending_restart')}
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}

function UnlockCard({ lockedUntil }: { lockedUntil: string | null }) {
  const queryClient = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState<ProofDraft>(EMPTY_PROOF);
  const locked = lockedUntil !== null && Date.parse(lockedUntil) > Date.now();
  const proof = proofOf(draft);
  const open = useMutation({
    retry: false,
    mutationFn: () => {
      if (proof === null) throw new Error('no proof');
      return openHostingSession(proof);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hosting'] });
    },
    onError: (error) => noteSectionError(error, queryClient),
    onSettled: () => setDraft((current) => ({ ...current, value: '' })),
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (proof !== null && !locked && !open.isPending) open.mutate();
  };
  return (
    <Card title={t('web.hosting_unlock_title')} hint={t('web.hosting_unlock_hint')}>
      <form className="stack hosting-narrow" onSubmit={submit} autoComplete="off">
        {locked && (
          <Banner tone="warn" role="status">
            {t('web.hosting_locked_until')} <span>{formatTimestamp(lockedUntil)}</span>
          </Banner>
        )}
        <ProofField draft={draft} onChange={setDraft} idPrefix={id} />
        {open.error !== null && (
          <Banner tone="danger">
            {errorText(open.error)}
            <ErrorRef error={open.error} />
          </Banner>
        )}
        <div className="btn-group">
          <button
            type="submit"
            className="btn primary"
            disabled={proof === null || locked || open.isPending}
          >
            <Icon name="lock" />
            {open.isPending ? t('web.hosting_unlock_opening') : t('web.hosting_unlock_button')}
          </button>
        </div>
      </form>
    </Card>
  );
}
