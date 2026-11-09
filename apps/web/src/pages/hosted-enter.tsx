import { useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { HOSTED_ENTER_PAGE_PATH } from '@nexa/contracts';
import { redeemHostedEnter } from '../api/client';
import { errorText } from '../error-text';
import { t } from '../i18n/web.fa';
import { Banner } from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';

/**
 * Phase 6B «ورود به پنل» — the hosted domain's `/enter#token=…` page (ADR-0039 § 9).
 *
 * The token rides in the FRAGMENT, so no server, proxy or `Referer` ever sees it; the caller
 * reads it once and wipes it from the address bar before this renders. This page posts it once
 * to `POST /auth/enter`; the server decides everything (audience, single use, expiry, the
 * owner's section) and answers with the session cookie for THIS domain, after which the Web
 * Admin opens — with the banner «در حال مشاهده به‌عنوان میزبان».
 */
export function isEnterPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === HOSTED_ENTER_PAGE_PATH;
}

export function HostedEnterPage({
  initialToken,
  onEntered,
}: {
  initialToken: string | null;
  onEntered: () => void;
}) {
  const redeem = useMutation({
    retry: false,
    mutationFn: (token: string) => redeemHostedEnter(token),
    onSuccess: onEntered,
  });
  // Once: a single-use token is never posted twice by this page.
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current || initialToken === null) return;
    sent.current = true;
    redeem.mutate(initialToken);
  }, [initialToken, redeem]);

  return (
    <main className="shell signin screen">
      <div className="screen-card">
        <h1 className="strong">{t('web.enter_title')}</h1>
        {initialToken === null ? (
          <Banner tone="danger">{t('web.enter_no_token')}</Banner>
        ) : redeem.error !== null ? (
          <Banner tone="danger">
            {errorText(redeem.error)}
            <ErrorRef error={redeem.error} />
          </Banner>
        ) : (
          <p className="muted" role="status">
            {t('web.enter_pending')}
          </p>
        )}
      </div>
    </main>
  );
}
