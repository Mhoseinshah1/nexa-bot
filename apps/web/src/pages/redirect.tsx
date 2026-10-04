import { useEffect } from 'react';
import { t } from '../i18n/web.fa';
import { navigate } from '../router';

/**
 * A path that has moved: it REPLACES its own history entry with the new location, so a
 * bookmark or a pasted link to the old screen lands on the new one, and Back does not
 * bounce the operator into the redirect again.
 *
 * A component rather than a branch of `resolve`, because `resolve` is pure — it runs in the
 * route test with no document — and a navigation is an effect.
 */
export function RedirectPage({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to]);
  return <p className="muted small">{t('web.redirect_moved')}</p>;
}
