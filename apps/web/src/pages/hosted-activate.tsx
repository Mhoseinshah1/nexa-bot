import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  ADMIN_PASSWORD_MIN,
  adminDisplayNameSchema,
  adminPasswordSchema,
  adminUsernameSchema,
  HOSTED_ACTIVATION_PAGE_PATH,
} from '@nexa/contracts';
import { redeemHostedActivation } from '../api/client';
import { errorText } from '../error-text';
import { t } from '../i18n/web.fa';
import { Banner, Field } from '../ui/kit';

/**
 * Whether this address is the activation page, and the token its FRAGMENT carries.
 *
 * `/activate#token=…`: the token is in the fragment so it never reaches a server log, a proxy
 * or a `Referer` header — only the POST body this page sends. It is read once and removed from
 * the address bar at once (`history.replaceState`), so it is not left in the browser's history
 * or a screenshot of the page.
 */
export function isActivationPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === HOSTED_ACTIVATION_PAGE_PATH;
}

export function readActivationToken(hash: string): string | null {
  const match = /(?:^#|&)token=([^&]+)/.exec(hash);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1] as string);
  } catch {
    return null;
  }
}

/**
 * The hosted owner's activation page: a minimal Persian form, in the sign-in screen's own
 * shell, that sets their Web Admin username and password with the one-time link. Anonymous:
 * the link is the credential, and the server — not this page — decides whether it is good,
 * used or expired (and says so in a closed code this page shows in Persian).
 */
export function HostedActivatePage({
  initialToken,
  onSignIn,
}: {
  /** Injected for tests; the app passes the fragment's token. */
  initialToken: string | null;
  onSignIn: () => void;
}) {
  // Held in state: the fragment is wiped from the address bar by the caller before this renders.
  const [token] = useState(initialToken);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [touched, setTouched] = useState(false);

  const usernameOk = adminUsernameSchema.safeParse(username.trim()).success;
  const passwordOk = adminPasswordSchema.safeParse(password).success;
  const matches = password === again;
  const nameOk = displayName.trim() === '' || adminDisplayNameSchema.safeParse(displayName).success;
  const valid = token !== null && usernameOk && passwordOk && matches && nameOk;

  const redeem = useMutation({
    retry: false,
    mutationFn: () =>
      redeemHostedActivation({
        token: token as string,
        username: username.trim(),
        password,
        ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }),
      }),
    // The password does not outlive the answer, whichever it was.
    onSettled: () => {
      setPassword('');
      setAgain('');
      // The emptied fields are not a mistake to underline; the answer is what is shown.
      setTouched(false);
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (valid && !redeem.isPending) redeem.mutate();
  };

  if (redeem.isSuccess) {
    return (
      <main className="shell signin screen">
        <div className="screen-card">
          <h1 className="strong">{t('web.activate_done_title')}</h1>
          <p>{t('web.activate_done_body')}</p>
          <button type="button" className="btn primary" onClick={onSignIn}>
            {t('web.activate_go_sign_in')}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="shell signin screen">
      <div className="screen-card">
        <header>
          <h1 className="strong">{t('web.activate_title')}</h1>
          <p className="muted">{t('web.activate_intro')}</p>
        </header>
        {token === null ? (
          <Banner tone="danger">{t('web.activate_no_token')}</Banner>
        ) : (
          <form onSubmit={submit} autoComplete="off" noValidate>
            <Field
              label={t('web.activate_username')}
              htmlFor="activate-username"
              hint={t('web.activate_username_hint')}
              {...(touched && !usernameOk ? { error: t('web.activate_username_invalid') } : {})}
            >
              <input
                id="activate-username"
                name="username"
                className="input"
                dir="ltr"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.currentTarget.value)}
                required
              />
            </Field>
            <Field label={t('web.activate_display_name')} htmlFor="activate-display-name">
              <input
                id="activate-display-name"
                name="displayName"
                className="input"
                autoComplete="name"
                maxLength={120}
                value={displayName}
                onChange={(event) => setDisplayName(event.currentTarget.value)}
              />
            </Field>
            <Field
              label={t('web.activate_password')}
              htmlFor="activate-password"
              hint={t('web.activate_password_hint')}
              {...(touched && !passwordOk ? { error: t('web.activate_password_short') } : {})}
            >
              <input
                id="activate-password"
                name="password"
                type="password"
                className="input"
                dir="ltr"
                autoComplete="new-password"
                minLength={ADMIN_PASSWORD_MIN}
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                required
              />
            </Field>
            <Field
              label={t('web.activate_password_confirm')}
              htmlFor="activate-password-again"
              {...(touched && passwordOk && !matches ? { error: t('web.activate_mismatch') } : {})}
            >
              <input
                id="activate-password-again"
                name="passwordAgain"
                type="password"
                className="input"
                dir="ltr"
                autoComplete="new-password"
                value={again}
                onChange={(event) => setAgain(event.currentTarget.value)}
                required
              />
            </Field>
            <button type="submit" className="btn primary" disabled={redeem.isPending}>
              {redeem.isPending ? t('web.activate_submitting') : t('web.activate_submit')}
            </button>
            {redeem.isError && (
              <p className="error" role="alert">
                {errorText(redeem.error)}
              </p>
            )}
          </form>
        )}
      </div>
    </main>
  );
}
