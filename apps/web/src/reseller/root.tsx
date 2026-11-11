import { useCallback, useEffect, useState } from 'react';
import { t } from '../i18n/web.fa';
import { ResellerLoginPage } from './login';
import { PanelShell } from './shell';
import { isLoginPath, useLocation } from './route';

interface TakenToken {
  readonly token: string | null;
  readonly alreadyOpened: boolean;
}

/**
 * What `Root` mounts for every `/r/…` address: the login page on `/r/login`, the panel on the
 * rest. The token capture (`takeToken`, the shared fragment reader in `root.tsx`) is handed in so
 * this tree never imports the Web Admin's router.
 *
 * The token belongs to the page LOAD. Once the login page has posted it, a later visit to
 * `/r/login` in the same tab (after «خروج از پنل») is offered nothing — the cached capture would
 * otherwise be a spent link.
 */
export function ResellerRoot({ takeToken }: { takeToken: () => TakenToken }) {
  const { pathname } = useLocation();
  const [spent, setSpent] = useState(false);
  const onSpent = useCallback(() => setSpent(true), []);

  useEffect(() => {
    document.title = t('web.rp_title');
  }, []);

  if (isLoginPath(pathname)) {
    const offered = spent ? { token: null, alreadyOpened: false } : takeToken();
    return (
      <ResellerLoginPage
        initialToken={offered.token}
        linkAlreadyOpened={offered.alreadyOpened}
        onTokenSpent={onSpent}
      />
    );
  }
  return <PanelShell />;
}
