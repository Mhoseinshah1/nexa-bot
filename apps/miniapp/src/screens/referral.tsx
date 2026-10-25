import { useState } from 'react';
import { MINIAPP_ROUTES, miniAppReferralResponseSchema } from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { money } from '../format.js';
import { openTelegram } from '../telegram.js';
import { Button, Card, Loading, Ltr, useLoad } from '../ui.js';

/**
 * دعوت دوستان: the program's commission, the customer's own invite link (the bot's
 * `t.me/<bot>?start=ref-…` link, minted once) with share and copy, and their three figures.
 * The program being off is said in the bot's own sentence.
 *
 * Not drawn: the «دوستان اخیر» list. The only read of referred customers is the
 * operators', so the mini app has no per-friend names or commissions to show.
 */
export function Referral() {
  const { api } = useApp();
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.referral, {}, miniAppReferralResponseSchema),
    [api],
  );
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle');
  return (
    <main className="page">
      <h1 className="title">{t('miniapp.referral_title')}</h1>
      <Loading loaded={loaded} reload={reload}>
        {(referral) =>
          !referral.active ? (
            <p className="muted">{t('miniapp.referral_inactive')}</p>
          ) : (
            <>
              <Card>
                <p className="lead">
                  {t('miniapp.referral_headline', { percent: referral.commissionPercent })}
                </p>
                <p className="muted">{t('miniapp.referral_note')}</p>
                <div className="link-box">
                  <Ltr>{referral.inviteLink}</Ltr>
                </div>
                <div className="actions">
                  <Button
                    primary
                    onClick={() =>
                      openTelegram(
                        `https://t.me/share/url?url=${encodeURIComponent(referral.inviteLink)}`,
                      )
                    }
                  >
                    {t('miniapp.referral_share')}
                  </Button>
                  <Button
                    onClick={() => {
                      navigator.clipboard.writeText(referral.inviteLink).then(
                        () => setCopy('done'),
                        () => setCopy('failed'),
                      );
                    }}
                  >
                    {copy === 'done' ? t('miniapp.copied') : t('miniapp.referral_copy')}
                  </Button>
                </div>
                {copy === 'failed' && <p className="error">{t('miniapp.referral_copy_failed')}</p>}
              </Card>
              {referral.stats !== null && (
                <Card>
                  <div className="stats">
                    <span className="stat">
                      <b>{referral.stats.referralCount}</b>
                      <span className="muted">{t('miniapp.referral_stat_invited')}</span>
                    </span>
                    <span className="stat">
                      <b>{referral.stats.referredPurchaseCount}</b>
                      <span className="muted">{t('miniapp.referral_stat_purchased')}</span>
                    </span>
                    <span className="stat">
                      <b>{money(referral.stats.commissionReceivedTotal)}</b>
                      <span className="muted">{t('miniapp.referral_stat_earned')}</span>
                    </span>
                  </div>
                </Card>
              )}
              <Card>
                <ol className="list">
                  <li>{t('miniapp.referral_step_1')}</li>
                  <li>{t('miniapp.referral_step_2')}</li>
                  <li>{t('miniapp.referral_step_3')}</li>
                </ol>
              </Card>
            </>
          )
        }
      </Loading>
    </main>
  );
}
