import { useState } from 'react';
import { t } from '../i18n/web.fa';
import { PAYMENT_METHODS_PATH, providerOfSlug } from '../payment-method-routes';
import { useLinkHandler, type Route } from '../router';
import { Empty, PageHead } from '../ui/kit';
import { Icon } from '../ui/icons';
import { GatewayHealthPanel, PROVIDER_LABELS } from './gateway-health';
import { CardAccountsSection } from './payment-accounts';
import { PaymentGatewaysPage } from './payment-gateways';

/**
 * One payment method's own view, at `/payment-gateways/<slug>` (UX Batch 01, items 7 and 8).
 *
 * The list used to be one long page — every route's settings, every form at its foot, and
 * every route's health on a second tab — so opening one provider meant scrolling past the
 * others. Each provider now has a URL of its own: a deep link, a refresh and Back all land
 * on the same provider, and a clear «بازگشت» returns to the list.
 *
 * What is on it, each gated by the key the server charges for it, passed separately:
 * - the route's settings, actions and the forms those open (`payments.gateways.view` reads,
 *   `payments.gateways.edit` writes);
 * - for card-to-card only, the cards customers are told to pay into
 *   (`payments.accounts.view` reads, `payments.accounts.edit` writes) — the screen that was
 *   «حساب‌های دریافت», moved here with its API, permissions and semantics unchanged;
 * - the route's recorded health (`payments.gateways.view`, the key the health report
 *   charges), from the same report the list's health tab reads.
 */
export function PaymentMethodPage({
  route,
  slug,
  mayViewGateways,
  mayEditGateways,
  mayViewCards,
  mayEditCards,
}: {
  route: Route;
  slug: string;
  mayViewGateways: boolean;
  mayEditGateways: boolean;
  mayViewCards: boolean;
  mayEditCards: boolean;
}) {
  const onLink = useLinkHandler();
  /*
   * A request counter, not an open/closed flag: each press asks the cards section to open
   * its new-card form through its own path, which also closes a card being edited.
   */
  const [addCardRequest, setAddCardRequest] = useState(0);
  const [cardsBusy, setCardsBusy] = useState(false);
  const provider = providerOfSlug(slug);

  const back = (
    <a className="btn" href={PAYMENT_METHODS_PATH} onClick={onLink}>
      <Icon name="chevronRight" />
      {t('web.payment_method_back')}
    </a>
  );

  if (provider === null) {
    return (
      <>
        <PageHead title={t('web.payment_method_unknown')} actions={back} />
        <Empty title={t('web.payment_method_missing')} />
      </>
    );
  }

  const cards = provider === 'MANUAL_TRANSFER' && (mayViewCards || mayEditCards);
  /*
   * The route's own section is drawn whenever the reader may see the route, and ALSO when
   * they may see nothing here at all — so a reader with neither key gets the ordinary
   * refusal rather than an empty page.
   */
  const routeSection = mayViewGateways || !cards;

  return (
    <>
      <PageHead title={t(PROVIDER_LABELS[provider])} actions={back} />
      {routeSection && (
        <PaymentGatewaysPage
          provider={provider}
          denied={!mayViewGateways}
          mayEdit={mayEditGateways}
          {...(cards && mayEditCards
            ? {
                extraActions: (
                  <button
                    type="button"
                    className="btn sm primary"
                    disabled={cardsBusy}
                    onClick={() => setAddCardRequest((count) => count + 1)}
                  >
                    <Icon name="plus" />
                    {t('web.payment_account_add')}
                  </button>
                ),
              }
            : {})}
        />
      )}
      {cards && (
        <CardAccountsSection
          denied={!mayViewCards}
          mayEdit={mayEditCards}
          addRequest={addCardRequest}
          onBusyChange={setCardsBusy}
        />
      )}
      {mayViewGateways && <GatewayHealthPanel route={route} denied={false} provider={provider} />}
    </>
  );
}
