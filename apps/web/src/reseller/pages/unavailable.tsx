import { t, type WebKey } from '../../i18n/web.fa';
import { Button, Empty } from '../../ui/kit';
import { SCREEN_PATHS, goTo, type PanelScreen } from '../route';
import { RpCard } from '../view';

const TEXT: Readonly<Record<'bot', { title: WebKey; hint: WebKey }>> = {
  bot: { title: 'web.rp_unavailable_bot_title', hint: 'web.rp_unavailable_bot_hint' },
};

/**
 * «ربات اختصاصی»: in the sidebar from the start, built in a later round. Until then the screen
 * says so plainly — no sample rows, no inert form.
 */
export function UnavailableScreen({ screen }: { screen: PanelScreen }) {
  const copy = screen === 'bot' ? TEXT[screen] : null;
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
