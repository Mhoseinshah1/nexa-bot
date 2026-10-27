import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppMeResponseSchema,
  type MiniAppCardInstruction,
  type MiniAppMeResponse,
} from '@nexa/contracts';
import { ApiError, MiniAppApi, botIdFromLocation } from './api.js';
import { applyTheme, webApp } from './telegram.js';
import { t } from './i18n/t.js';
import { Gate } from './screens/gate.js';
import { Home } from './screens/home.js';
import { Store } from './screens/store.js';
import { Services } from './screens/services.js';
import { Checkout } from './screens/checkout.js';
import { CardPay } from './screens/card-pay.js';
import { PayStatus } from './screens/pay-status.js';
import { ServiceDetail } from './screens/service-detail.js';
import { Wallet } from './screens/wallet.js';
import { Profile } from './screens/profile.js';
import { Referral } from './screens/referral.js';
import { Trial } from './screens/trial.js';
import { Support } from './screens/support.js';
import { NewTicket, Ticket } from './screens/ticket.js';
import { Apps } from './screens/apps.js';
import { Message, TabBar } from './ui.js';

/**
 * The shell: the Telegram handshake, the session, the gate, and a screen stack driven by
 * Telegram's own back button. Screens are this PR's five (home, store, checkout with card
 * to card, payment status, service) and the services list behind the tab; the rest of the
 * design arrives with the screens that use the remaining endpoints.
 */
export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'store' }
  | { readonly name: 'services' }
  | { readonly name: 'checkout'; readonly orderId: string }
  | { readonly name: 'card'; readonly instruction: MiniAppCardInstruction }
  /** `openInvoice`: open the Stars invoice in place once, on arrival (R11 B5). */
  | { readonly name: 'pay'; readonly paymentId: string; readonly openInvoice?: boolean }
  | { readonly name: 'service'; readonly serviceId: string }
  | { readonly name: 'wallet' }
  | { readonly name: 'profile' }
  | { readonly name: 'referral' }
  | { readonly name: 'trial' }
  | { readonly name: 'support' }
  | { readonly name: 'ticket-new' }
  | { readonly name: 'ticket'; readonly ticketId: string }
  | { readonly name: 'apps' };

export type Tab = 'home' | 'store' | 'services' | 'wallet' | 'profile';

interface AppContextValue {
  readonly api: MiniAppApi;
  readonly me: MiniAppMeResponse;
  readonly refreshMe: () => Promise<void>;
  readonly navigate: (route: Route) => void;
  readonly replace: (route: Route) => void;
  readonly back: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === null) throw new Error('useApp outside the app');
  return value;
}

type Boot =
  | { readonly state: 'loading' }
  | { readonly state: 'outside' }
  | { readonly state: 'failed'; readonly message: Parameters<typeof t>[0] }
  | { readonly state: 'ready'; readonly api: MiniAppApi; readonly me: MiniAppMeResponse };

function bootFailure(error: unknown): Parameters<typeof t>[0] {
  if (error instanceof ApiError) {
    if (error.code === 'miniapp.unavailable') return 'miniapp.unavailable';
    if (error.code.startsWith('miniapp.init_data') || error.code === 'miniapp.session_invalid') {
      return 'miniapp.reopen';
    }
    if (error.code === 'miniapp.rate_limited') return 'miniapp.rate_limited';
  }
  return 'miniapp.error';
}

/**
 * One handshake per document. A launch mints ONE session, so the exchange must not run twice
 * — React's development double effect would otherwise spend the launch on its first run and
 * be refused as a replay on its second.
 */
let handshake: Promise<{ api: MiniAppApi; me: MiniAppMeResponse }> | null = null;

function bootOnce(botId: string, initData: string) {
  handshake ??= (async () => {
    const api = new MiniAppApi(botId);
    return { api, me: await signIn(api, initData) };
  })();
  return handshake;
}

async function signIn(api: MiniAppApi, initData: string): Promise<MiniAppMeResponse> {
  const me = () => api.get(MINIAPP_ROUTES.me, {}, miniAppMeResponseSchema);
  if (api.hasSession()) {
    try {
      return await me();
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'miniapp.session_invalid') throw error;
    }
  }
  await api.signIn(initData);
  return me();
}

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' });
  const [stack, setStack] = useState<readonly Route[]>([{ name: 'home' }]);

  useEffect(() => {
    const app = webApp();
    applyTheme(app);
    const botId = botIdFromLocation(window.location.pathname);
    if (app === null || app.initData === '' || botId === null) {
      setBoot({ state: 'outside' });
      return;
    }
    app.ready();
    app.expand();
    app.onEvent('themeChanged', () => applyTheme(app));
    bootOnce(botId, app.initData).then(
      ({ api, me }) => setBoot({ state: 'ready', api, me }),
      (error: unknown) => setBoot({ state: 'failed', message: bootFailure(error) }),
    );
  }, []);

  const navigate = useCallback((route: Route) => setStack((current) => [...current, route]), []);
  const replace = useCallback(
    (route: Route) => setStack((current) => [...current.slice(0, -1), route]),
    [],
  );
  const back = useCallback(
    () => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current)),
    [],
  );

  useEffect(() => {
    const app = webApp();
    if (app === null) return;
    if (stack.length > 1) app.BackButton.show();
    else app.BackButton.hide();
    app.BackButton.onClick(back);
    return () => app.BackButton.offClick(back);
  }, [stack.length, back]);

  // Stable for the session (it depends on the client, not on `me`), so a screen can refresh
  // on mount without the refreshed `me` re-running its effect.
  const api = boot.state === 'ready' ? boot.api : null;
  const refreshMe = useCallback(async () => {
    if (api === null) return;
    const me = await api.get(MINIAPP_ROUTES.me, {}, miniAppMeResponseSchema);
    setBoot((current) => (current.state === 'ready' ? { ...current, me } : current));
  }, [api]);

  const context = useMemo<AppContextValue | null>(
    () =>
      boot.state === 'ready'
        ? { api: boot.api, me: boot.me, refreshMe, navigate, replace, back }
        : null,
    [boot, refreshMe, navigate, replace, back],
  );

  if (boot.state === 'loading') return <Message text={t('miniapp.loading')} />;
  if (boot.state === 'outside') return <Message text={t('miniapp.open_from_telegram')} />;
  if (boot.state === 'failed') return <Message text={t(boot.message)} />;
  if (context === null) return null;

  const route = stack[stack.length - 1] ?? { name: 'home' };
  const tab: Tab | null =
    route.name === 'home' ||
    route.name === 'store' ||
    route.name === 'services' ||
    route.name === 'wallet' ||
    route.name === 'profile'
      ? route.name
      : null;

  return (
    <AppContext.Provider value={context}>
      {context.me.gate !== null ? (
        <Gate gate={context.me.gate} />
      ) : (
        <div className="screen">
          {route.name === 'home' && <Home />}
          {route.name === 'store' && <Store />}
          {route.name === 'services' && <Services />}
          {route.name === 'checkout' && <Checkout orderId={route.orderId} />}
          {route.name === 'card' && <CardPay instruction={route.instruction} />}
          {route.name === 'pay' && (
            <PayStatus paymentId={route.paymentId} openInvoice={route.openInvoice === true} />
          )}
          {route.name === 'service' && <ServiceDetail serviceId={route.serviceId} />}
          {route.name === 'wallet' && <Wallet />}
          {route.name === 'profile' && <Profile />}
          {route.name === 'referral' && <Referral />}
          {route.name === 'trial' && <Trial />}
          {route.name === 'support' && <Support />}
          {route.name === 'ticket-new' && <NewTicket />}
          {route.name === 'ticket' && <Ticket ticketId={route.ticketId} />}
          {route.name === 'apps' && <Apps />}
          {tab !== null && <TabBar current={tab} onSelect={(next) => setStack([{ name: next }])} />}
        </div>
      )}
    </AppContext.Provider>
  );
}
