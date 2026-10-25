import { useState } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppTrialClaimResponseSchema,
  miniAppTrialResponseSchema,
} from '@nexa/contracts';
import { ApiError } from '../api.js';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { trafficLimit } from '../format.js';
import { Button, Card, Loading, Row, errorText, useLoad } from '../ui.js';

/**
 * سرویس تست رایگان: the panels that offer a trial now, each with its traffic and hours, and
 * a claim that names the chosen panel. A refusal is ONE sentence, the bot's — the reason (a
 * limit reached, a blocked account, nothing configured) stays in the operators' audit row.
 *
 * Not drawn: the trial's device count (not in the offer), the upgrade discount after the
 * trial (no such promotion exists), and any claim of «once per account» or «instant»
 * activation (the allowance is configurable and the service is built by the panel lane).
 */
export function Trial() {
  const { api, navigate } = useApp();
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.trial, {}, miniAppTrialResponseSchema),
    [api],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState(false);

  const claim = async (panelId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(MINIAPP_ROUTES.trial, {}, miniAppTrialClaimResponseSchema, { panelId });
      setIssued(true);
    } catch (failure) {
      setError(trialErrorText(failure));
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <h1 className="title">{t('miniapp.trial_title')}</h1>
      {issued ? (
        <Card>
          <p className="lead">{t('miniapp.trial_issued')}</p>
          <Button primary onClick={() => navigate({ name: 'services' })}>
            {t('miniapp.trial_to_services')}
          </Button>
        </Card>
      ) : (
        <Loading loaded={loaded} reload={reload}>
          {(trial) => (
            <>
              {trial.offers.length === 0 ? (
                <Card>
                  <p>{t('miniapp.trial_unavailable')}</p>
                </Card>
              ) : (
                <>
                  <p className="lead">{t('miniapp.trial_lead')}</p>
                  {trial.offers.map((offer) => (
                    <Card key={offer.panelId}>
                      <h2>{offer.label}</h2>
                      <Row
                        label={t('miniapp.trial_traffic')}
                        value={trafficLimit(offer.trafficBytes)}
                      />
                      <Row
                        label={t('miniapp.trial_duration')}
                        value={t('miniapp.trial_hours', { hours: offer.durationHours })}
                      />
                      <p className="muted">{t('miniapp.trial_no_payment')}</p>
                      <Button primary disabled={busy} onClick={() => void claim(offer.panelId)}>
                        {trial.offers.length === 1
                          ? t('miniapp.trial_claim')
                          : t('miniapp.trial_claim_offer', { label: offer.label })}
                      </Button>
                    </Card>
                  ))}
                </>
              )}
              <Button onClick={() => navigate({ name: 'store' })}>
                {t('miniapp.trial_to_store')}
              </Button>
            </>
          )}
        </Loading>
      )}
      {error !== null && <p className="error">{error}</p>}
    </main>
  );
}

/**
 * The mini app answers a claim that did not issue with `miniapp.route_unavailable` and the
 * outcome: every refusal is the bot's one sentence, and «choose a server» is the only other.
 */
export function trialErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code === 'miniapp.route_unavailable') {
    return t(
      error.details['outcome'] === 'CHOOSE' ? 'miniapp.trial_choose' : 'miniapp.trial_unavailable',
    );
  }
  return errorText(error);
}
