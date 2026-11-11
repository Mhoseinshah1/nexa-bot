import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { resellerExchangeRequestSchema } from '@nexa/contracts';
import { ApiError } from '../api/client';
import { errorText } from '../error-text';
import { t } from '../i18n/web.fa';
import { Banner, Button, Field, Input } from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';
import { exchangeLink, fetchMe, submitSecondFactor } from './api';
import { SCREEN_PATHS, goTo } from './route';

/**
 * `/r/login`: the one-time link, then (when the reseller turned it on) the 2FA code.
 *
 * The token arrives in the address FRAGMENT, captured before the router ran and handed to this
 * page as `initialToken` (`takeToken` in `root.tsx`, the same capture the hosted pages use). It
 * is posted once and never stored. With no token the page cannot know whether the link was
 * already opened, so `linkAlreadyOpened` (the non-secret marker `takeToken` leaves) picks the
 * «این لینک قبلاً باز شده است» sentence; a session that is already open, or one waiting for its
 * code (a refresh in the middle of the 2FA step), is recognised first by asking `/me`.
 */
export function ResellerLoginPage({
  initialToken: offeredToken,
  linkAlreadyOpened: offeredOpened = false,
  onTokenSpent,
}: {
  initialToken: string | null;
  linkAlreadyOpened?: boolean;
  /** Called when the token has been posted, so a later visit to this page is not offered it again. */
  onTokenSpent?: () => void;
}) {
  // What the page was first shown with. A parent that stops offering the token (it is spent)
  // must not turn an error on screen into the instructions.
  const [initialToken] = useState(offeredToken);
  const [linkAlreadyOpened] = useState(offeredOpened);
  const [step, setStep] = useState<'link' | 'code'>('link');
  const wellFormed =
    initialToken !== null &&
    resellerExchangeRequestSchema.safeParse({ token: initialToken }).success;

  const exchange = useMutation({
    retry: false,
    mutationFn: (token: string) => exchangeLink(token),
    onSuccess: (answer) => {
      if (answer.state === 'ACTIVE') goTo(SCREEN_PATHS.dashboard, { replace: true });
      else setStep('code');
    },
  });
  // Once: a single-use token is never posted twice by this page (StrictMode runs effects twice).
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current || initialToken === null || !wellFormed) return;
    sent.current = true;
    onTokenSpent?.();
    exchange.mutate(initialToken);
  }, [initialToken, wellFormed, exchange, onTokenSpent]);

  // No token: is there already a session (or one waiting for its code)?
  const probe = useQuery({
    queryKey: ['reseller', 'login-probe'],
    queryFn: fetchMe,
    enabled: initialToken === null,
    retry: false,
    gcTime: 0,
  });
  const probeCode = probe.error instanceof ApiError ? probe.error.code : null;
  useEffect(() => {
    if (probe.isSuccess) goTo(SCREEN_PATHS.dashboard, { replace: true });
    else if (probeCode === 'reseller_web.second_factor_required') setStep('code');
  }, [probe.isSuccess, probeCode]);

  return (
    <main className="rp-login">
      <div className="rp-card rp-login-card">
        <div className="rp-brand rp-brand-plain">
          <span className="rp-logo" aria-hidden="true">
            N
          </span>
          <div>
            <strong>{t('web.rp_title')}</strong>
            <span>{t('web.rp_login_sub')}</span>
          </div>
        </div>
        {step === 'code' ? (
          <CodeStep />
        ) : initialToken !== null ? (
          !wellFormed ? (
            <Banner tone="danger">{t('web.rp_login_link_invalid')}</Banner>
          ) : exchange.error !== null ? (
            <Banner tone="danger">
              {errorText(exchange.error)}
              <ErrorRef error={exchange.error} />
            </Banner>
          ) : (
            <p className="muted" role="status">
              {t('web.rp_login_pending')}
            </p>
          )
        ) : probe.isPending ? (
          <p className="muted" role="status">
            {t('web.rp_login_pending')}
          </p>
        ) : linkAlreadyOpened ? (
          <Banner tone="danger">{t('web.rp_login_link_used')}</Banner>
        ) : (
          <Instructions />
        )}
      </div>
    </main>
  );
}

function Instructions() {
  return (
    <>
      <h1 className="rp-login-title">{t('web.rp_login_title')}</h1>
      <ol className="rp-steps">
        <li>{t('web.rp_login_step1')}</li>
        <li>{t('web.rp_login_step2')}</li>
        <li>{t('web.rp_login_step3')}</li>
      </ol>
      <Banner tone="info">{t('web.rp_login_note')}</Banner>
    </>
  );
}

function CodeStep() {
  const [code, setCode] = useState('');
  const verify = useMutation({
    retry: false,
    mutationFn: () => submitSecondFactor(code),
    onSuccess: () => goTo(SCREEN_PATHS.dashboard, { replace: true }),
  });
  return (
    <form
      className="rp-stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (code.length === 6 && !verify.isPending) verify.mutate();
      }}
    >
      <h1 className="rp-login-title">{t('web.rp_2fa_title')}</h1>
      <p className="muted">{t('web.rp_2fa_hint')}</p>
      <Field label={t('web.rp_2fa_label')} htmlFor="rp-login-code">
        <Input
          id="rp-login-code"
          dir="ltr"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/gu, '').slice(0, 6))}
        />
      </Field>
      {verify.error !== null && (
        <Banner tone="danger">
          {errorText(verify.error)}
          <ErrorRef error={verify.error} />
        </Banner>
      )}
      <Button type="submit" variant="primary" disabled={code.length !== 6 || verify.isPending}>
        {t('web.rp_2fa_submit')}
      </Button>
    </form>
  );
}
