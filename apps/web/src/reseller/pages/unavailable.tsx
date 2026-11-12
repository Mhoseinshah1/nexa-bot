import { t, type WebKey } from '../../i18n/web.fa';
import { Button, Empty } from '../../ui/kit';
import { SCREEN_PATHS, goTo, type PanelScreen } from '../route';
import { RpCard } from '../view';

const TEXT: Readonly<Record<'buy' | 'clients', { title: WebKey; hint: WebKey }>> = {
  buy: { title: 'web.rp_unavailable_buy_title', hint: 'web.rp_unavailable_buy_hint' },
  clients: { title: 'web.rp_unavailable_clients_title', hint: 'web.rp_unavailable_clients_hint' },
};

/**
 * «خرید سرویس» and «مشتری‌ها»: in the sidebar from the start, built in later
 * rounds. Until then the screen says so plainly — no sample rows, no inert form.
 */
export function UnavailableScreen({ screen }: { screen: PanelScreen }) {
  const copy = screen === 'buy' || screen === 'clients' ? TEXT[screen] : null;
  if (copy === null) return null;
  return (
    <RpCard>
      <Empty
        icon="lock"
        title={t(copy.title)}
        hint={t(copy.hint)}
        action={
          <Button size="sm" onClick={() => goTo(SCREEN_PATHS.dashboard)}>
            {t('web.rp_nav_dashboard')}
          </Button>
        }
      />
    </RpCard>
  );
}
