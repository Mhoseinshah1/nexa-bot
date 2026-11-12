import { useEffect, useRef, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResellerMeResponse } from '@nexa/contracts';
import { ApiError } from '../api/client';
import { formatMoneyText } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useTheme } from '../theme';
import { Button, Empty, Skeleton } from '../ui/kit';
import { Icon } from '../ui/icons';
import { useSelectedTabInStrip } from '../ui/tab-strip';
import { ME_KEY, fetchMe, signOutPanel } from './api';
import { usePanelPwa } from './pwa';
import {
  NAV_ITEMS,
  SCREEN_PATHS,
  goTo,
  screenForPath,
  useLocation,
  type PanelScreen,
} from './route';
import { AccountPage } from './pages/account';
import { DashboardPage } from './pages/dashboard';
import { OwnBotPage } from './pages/own-bot';
import { PricesPage } from './pages/prices';
import { ServicesPage } from './pages/services';
import { SupportPage } from './pages/support';
import { UnavailableScreen } from './pages/unavailable';
import { WalletPage } from './pages/wallet';

const SCREEN_TITLES: Readonly<Record<PanelScreen, { title: WebKey; sub: WebKey }>> = {
  dashboard: { title: 'web.rp_nav_dashboard', sub: 'web.rp_sub_dashboard' },
  buy: { title: 'web.rp_nav_buy', sub: 'web.rp_sub_buy' },
  services: { title: 'web.rp_nav_services', sub: 'web.rp_sub_services' },
  clients: { title: 'web.rp_nav_clients', sub: 'web.rp_sub_clients' },
  wallet: { title: 'web.rp_nav_wallet', sub: 'web.rp_sub_wallet' },
  prices: { title: 'web.rp_nav_prices', sub: 'web.rp_sub_prices' },
  support: { title: 'web.rp_nav_support', sub: 'web.rp_sub_support' },
  bot: { title: 'web.rp_nav_bot', sub: 'web.rp_sub_bot' },
  settings: { title: 'web.rp_nav_settings', sub: 'web.rp_sub_settings' },
};

/**
 * The signed-in panel: the session gate, the sidebar and the screen for the address.
 *
 * Everything below `/me` is the reseller's own data; the server decides who that is (the cookie)
 * and refuses anyone else. This component only chooses what to draw while the answer is
 * pending, refused or unavailable.
 */
export function PanelShell() {
  usePanelPwa();
  const location = useLocation();
  const me = useQuery({ queryKey: ME_KEY, queryFn: fetchMe, retry: false, staleTime: 30_000 });
  const code = me.error instanceof ApiError ? me.error.code : null;

  // A session still waiting for its 2FA code belongs on the login page's code step.
  useEffect(() => {
    if (code === 'reseller_web.second_factor_required') goTo('/r/login', { replace: true });
  }, [code]);

  if (me.isPending) {
    return (
      <main className="rp-gate" aria-busy="true">
        <Skeleton rows={4} cols={2} />
      </main>
    );
  }
  if (me.isError) {
    if (code === 'reseller_web.unavailable') {
      return (
        <GateCard
          title={t('web.rp_gate_unavailable_title')}
          hint={t('web.rp_gate_unavailable_hint')}
        />
      );
    }
    if (code === 'reseller_web.session_invalid' || code === 'reseller_web.second_factor_required') {
      return (
        <GateCard
          title={t('web.rp_gate_signed_out_title')}
          hint={t('web.rp_gate_signed_out_hint')}
          action={
            <Button variant="primary" onClick={() => goTo('/r/login')}>
              {t('web.rp_gate_signed_out_action')}
            </Button>
          }
        />
      );
    }
    return (
      <GateCard
        title={t('web.rp_gate_unavailable_title')}
        hint={t('web.rp_gate_unavailable_hint')}
        action={
          <Button onClick={() => void me.refetch()}>
            <Icon name="refresh" />
            {t('web.rp_retry')}
          </Button>
        }
      />
    );
  }

  const screen = screenForPath(location.pathname);
  const heading = SCREEN_TITLES[screen];
  return (
    <div className="rp">
      <Sidebar
        screen={screen}
        tierName={me.data.reseller.tierName}
        balance={formatMoneyText(me.data.balance)}
      />
      <main className="rp-main">
        <header className="rp-top">
          <div>
            <h1>{t(heading.title)}</h1>
            <p>{t(heading.sub)}</p>
          </div>
          <ThemeToggle />
        </header>
        <Screen screen={screen} search={location.search} me={me.data} />
      </main>
    </div>
  );
}

function Screen({
  screen,
  search,
  me,
}: {
  screen: PanelScreen;
  search: string;
  me: ResellerMeResponse;
}) {
  switch (screen) {
    case 'dashboard':
      return <DashboardPage />;
    case 'services':
      return <ServicesPage search={search} />;
    case 'wallet':
      return <WalletPage />;
    case 'prices':
      return <PricesPage tierName={me.reseller.tierName} />;
    case 'support':
      return <SupportPage />;
    case 'settings':
      return <AccountPage me={me} />;
    case 'bot':
      return <OwnBotPage />;
    case 'buy':
    case 'clients':
      return <UnavailableScreen screen={screen} />;
  }
}

function GateCard({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <main className="rp-gate">
      <div className="rp-card rp-gate-card">
        <Empty variant="error" title={title} hint={hint} icon="lock" action={action} />
      </div>
    </main>
  );
}

function Sidebar({
  screen,
  tierName,
  balance,
}: {
  screen: PanelScreen;
  tierName: string;
  balance: string;
}) {
  const client = useQueryClient();
  const nav = useRef<HTMLElement>(null);
  // On a phone the menu is a swipeable strip: keep the current screen's tab in view, by
  // scrolling the strip itself (the admin's tab-strip rule) and never the page.
  useSelectedTabInStrip(
    nav,
    () => nav.current?.querySelector<HTMLElement>('[aria-current="page"]'),
    screen,
  );
  const out = useMutation({
    retry: false,
    mutationFn: signOutPanel,
    onSettled: () => {
      client.clear();
      goTo('/r/login', { replace: true });
    },
  });
  return (
    <aside className="rp-side" aria-label={t('web.rp_nav_label')}>
      <div className="rp-brand">
        <span className="rp-logo" aria-hidden="true">
          N
        </span>
        <div>
          <strong>{t('web.rp_title')}</strong>
          <span>{t('web.rp_tier_line').replace('{tier}', tierName)}</span>
        </div>
      </div>
      <nav ref={nav} className="rp-nav" aria-label={t('web.rp_nav_label')}>
        {NAV_ITEMS.map((item) => (
          <a
            key={item.screen}
            href={SCREEN_PATHS[item.screen]}
            className={item.screen === screen ? 'on' : undefined}
            aria-current={item.screen === screen ? 'page' : undefined}
            onClick={(event) => {
              // A plain click is an in-panel move; a modified click keeps the browser's own tab behaviour.
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              goTo(SCREEN_PATHS[item.screen]);
            }}
          >
            <Icon name={item.icon} size={18} />
            <span>{t(item.label)}</span>
          </a>
        ))}
      </nav>
      <div className="rp-mini">
        <small>{t('web.rp_mini_balance')}</small>
        <strong>{balance}</strong>
        <Button size="sm" onClick={() => goTo(SCREEN_PATHS.wallet)}>
          {t('web.rp_mini_charge')}
        </Button>
      </div>
      <Button
        variant="ghost"
        size="sm"
        icon="logout"
        disabled={out.isPending}
        onClick={() => out.mutate()}
      >
        {t('web.rp_sign_out')}
      </Button>
    </aside>
  );
}

function ThemeToggle() {
  const { choice, setChoice } = useTheme();
  const dark =
    choice === 'dark' ||
    (choice === 'system' &&
      typeof window.matchMedia === 'function' &&
      !window.matchMedia('(prefers-color-scheme: light)').matches);
  return (
    <Button
      size="sm"
      aria-label={t('web.rp_theme_label')}
      title={dark ? t('web.theme_light') : t('web.theme_dark')}
      onClick={() => setChoice(dark ? 'light' : 'dark')}
    >
      <Icon name={dark ? 'sun' : 'moon'} />
      {dark ? t('web.theme_light') : t('web.theme_dark')}
    </Button>
  );
}
