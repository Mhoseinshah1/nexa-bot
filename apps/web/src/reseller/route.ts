import { useEffect, useState } from 'react';
import { RESELLER_WEB_LOGIN_PAGE_PATH } from '@nexa/contracts';
import type { WebKey } from '../i18n/web.fa';
import type { IconName } from '../ui/icons';

/**
 * The reseller panel's own route tree (`/r/…`).
 *
 * Deliberately NOT the Web Admin's router: that one stamps history entries, keeps a permission
 * model and knows nothing of this surface. The panel has nine screens and a login, so a path
 * table and `pushState` are all it needs. Nothing here reads the address fragment — that is
 * captured before any module runs (`initial-fragment.ts`).
 */
export const PANEL_SCREENS = [
  'dashboard',
  'buy',
  'services',
  'clients',
  'wallet',
  'prices',
  'support',
  'bot',
  'settings',
] as const;
export type PanelScreen = (typeof PANEL_SCREENS)[number];

export const SCREEN_PATHS: Readonly<Record<PanelScreen, string>> = {
  dashboard: '/r/dashboard',
  buy: '/r/buy',
  services: '/r/services',
  clients: '/r/clients',
  wallet: '/r/wallet',
  prices: '/r/prices',
  support: '/r/support',
  bot: '/r/bot',
  settings: '/r/settings',
};

/** The sidebar, in the owner's order. */
export const NAV_ITEMS: readonly { screen: PanelScreen; label: WebKey; icon: IconName }[] = [
  { screen: 'dashboard', label: 'web.rp_nav_dashboard', icon: 'dashboard' },
  { screen: 'buy', label: 'web.rp_nav_buy', icon: 'orders' },
  { screen: 'services', label: 'web.rp_nav_services', icon: 'services' },
  { screen: 'clients', label: 'web.rp_nav_clients', icon: 'users' },
  { screen: 'wallet', label: 'web.rp_nav_wallet', icon: 'wallet' },
  { screen: 'prices', label: 'web.rp_nav_prices', icon: 'discounts' },
  { screen: 'support', label: 'web.rp_nav_support', icon: 'message' },
  { screen: 'bot', label: 'web.rp_nav_bot', icon: 'bots' },
  { screen: 'settings', label: 'web.rp_nav_settings', icon: 'settings' },
];

export function isResellerPath(pathname: string): boolean {
  return pathname === '/r' || pathname.startsWith('/r/');
}

export function isLoginPath(pathname: string): boolean {
  return pathname.replace(/\/+$/u, '') === RESELLER_WEB_LOGIN_PAGE_PATH;
}

export function screenForPath(pathname: string): PanelScreen {
  const clean = pathname.replace(/\/+$/u, '') || '/';
  for (const screen of PANEL_SCREENS) {
    if (SCREEN_PATHS[screen] === clean) return screen;
  }
  return 'dashboard';
}

const NAV_EVENT = 'nexa-reseller-navigate';

export function goTo(path: string, options: { replace?: boolean } = {}): void {
  if (options.replace === true) window.history.replaceState(window.history.state, '', path);
  else window.history.pushState(window.history.state, '', path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** The current location, re-read on every in-panel navigation and on back/forward. */
export function useLocation(): { pathname: string; search: string } {
  const read = () => ({ pathname: window.location.pathname, search: window.location.search });
  const [location, setLocation] = useState(read);
  useEffect(() => {
    const onChange = () => setLocation(read());
    window.addEventListener(NAV_EVENT, onChange);
    window.addEventListener('popstate', onChange);
    return () => {
      window.removeEventListener(NAV_EVENT, onChange);
      window.removeEventListener('popstate', onChange);
    };
  }, []);
  return location;
}
